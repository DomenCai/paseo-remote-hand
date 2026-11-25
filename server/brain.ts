import { BlockList } from "node:net";
import { hostname, networkInterfaces, platform } from "node:os";
import { importPublicKey, importSecretKey } from "@getpaseo/relay/e2ee";
import { z } from "zod";
import { BrainOsSchema, type Access, type BrainPreview, type Device, type Endpoint } from "../shared/settings.ts";
import {
  brainFingerprint, DeviceProofSchema, digest, encodePairCode, INVITE_TTL_MS, randomToken, verifyDevice,
} from "./identity.ts";
import { brainDirect, directReadyMethod } from "./direct/session.ts";
import { SelectedPort } from "./direct/selected-port.ts";
import { ProtocolError, validate } from "./frames.ts";
import type { ConnectionPort, Peer } from "./protocol.ts";
import { startRelay } from "./relay.ts";
import { Snapshots } from "./snapshots.ts";
import type { StateStore } from "./state.ts";

const AUTH_TTL_MS = 15_000;
const ENROLLMENT_SESSION_MS = 30_000;
const PairSchema = DeviceProofSchema.extend({
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  name: z.string().trim().min(1).max(255),
  acknowledgedRiskCodes: z.array(z.string()),
});

const nonPublicV4 = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonPublicV4.addSubnet(address, bits, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const documentationV6 = new BlockList();
documentationV6.addSubnet("2001:db8::", 32, "ipv6");
documentationV6.addSubnet("3fff::", 20, "ipv6");

function description(relay: string): BrainPreview {
  const os = BrainOsSchema.safeParse(platform()).data ?? "unknown";
  const publicNetwork = os === "linux" && Object.values(networkInterfaces()).flat().some((item) => {
    if (!item || item.internal) return false;
    return item.family === "IPv4"
      ? !nonPublicV4.check(item.address, "ipv4")
      : globalV6.check(item.address, "ipv6") && !documentationV6.check(item.address, "ipv6");
  });
  return {
    brainName: hostname() || "Remote hand",
    os,
    relay,
    risks: publicNetwork ? [{
      code: "public-network",
      message: "这台机器可能有公网暴露。这台机器能以你在本机的用户身份读写文件、运行命令（受限档下仅限已授权项目的文件）。这台机器一旦被入侵，你的电脑也会被入侵。云主机的管理员和厂商可以接触这台机器上的 provider 登录信息，以及经过它的源码。",
    }] : [],
  };
}

export class BrainService {
  #stopRelay?: () => void;
  #status: Endpoint["status"] = "disconnected";
  #lastError?: string;
  #changingRelay = false;
  #direct = new Map<Peer, { route: SelectedPort; refresh: () => void; error?: string }>();
  #peers = new Map<string, Set<Peer>>();
  readonly snapshots = new Snapshots(() => this.devices());
  readonly endpointSnapshots = new Snapshots(() => this.endpoint());

  readonly #store: StateStore;
  readonly #now: () => number;
  readonly #attach?: (deviceId: string, port: ConnectionPort) => void;

  constructor(store: StateStore, now = Date.now, attach?: (deviceId: string, port: ConnectionPort) => void) {
    this.#store = store;
    this.#now = now;
    this.#attach = attach;
  }

  start(): void {
    this.#stopRelay?.();
    const target = this.#store.current.endpoint;
    this.#stopRelay = startRelay(target, {
      publicKey: importPublicKey(target.publicKeyB64),
      secretKey: importSecretKey(target.secretKeyB64),
    }, (peer) => this.accept(peer), (status, lastError) => {
      this.#status = status;
      this.#lastError = lastError;
      this.endpointSnapshots.changed();
    });
  }

  stop(): void {
    this.#stopRelay?.();
  }

  endpoint(): Endpoint {
    const { relay, serverId, publicKeyB64 } = this.#store.current.endpoint;
    const lastError = this.#lastError ?? [...this.#direct.values()].find((link) => link.error)?.error;
    return {
      relay, serverId, fingerprint: brainFingerprint(publicKeyB64), status: this.#status,
      ...(lastError === undefined ? {} : { lastError }),
      risks: description(relay).risks,
    };
  }

  async setRelay(relay: string): Promise<void> {
    if (this.#changingRelay) throw new Error("A relay switch is already in progress.");
    if (relay === this.#store.current.endpoint.relay) return;
    this.#changingRelay = true;
    try {
      const online = [...this.#peers.values()].flatMap((peers) => [...peers]);
      // 保留旧连接，直到在线设备确认写入新地址，或通知超时。
      await Promise.allSettled(online.map((peer) => peer.request("relay.move", { relay }, 2_000)));
      this.#store.update((state) => {
        state.endpoint.relay = relay;
        state.invites = {};
      });
      this.start();
    } finally {
      this.#changingRelay = false;
    }
  }

  directSettingsChanged(): void {
    for (const link of this.#direct.values()) link.refresh();
  }

  port(deviceId: string): ConnectionPort | undefined {
    const peers = [...this.#peers.get(deviceId) ?? []].reverse();
    for (const peer of peers) {
      if (peer.port) return this.#direct.get(peer)?.route ?? peer.port;
    }
  }

  invite(label?: string): { pairingCode: string; expiresAt: string } {
    const now = this.#now();
    const inviteSecret = randomToken();
    const expiresAt = new Date(now + INVITE_TTL_MS).toISOString();
    this.#store.update((state) => {
      for (const [id, invite] of Object.entries(state.invites))
        if (Date.parse(invite.expiresAt) <= now) delete state.invites[id];
      state.invites[digest(inviteSecret)] = { label, expiresAt };
    });
    const { relay, serverId, publicKeyB64 } = this.#store.current.endpoint;
    return { pairingCode: encodePairCode({ v: 1, relay, serverId, publicKeyB64, inviteSecret, expiresAt }), expiresAt };
  }

  devices(): Device[] {
    return Object.entries(this.#store.current.devices).map(([deviceId, device]) => ({
      deviceId, ...device, online: !!this.#peers.get(deviceId)?.size, activeSessions: 0,
    }));
  }

  revoke(deviceId: string): void {
    if (!Object.hasOwn(this.#store.current.devices, deviceId)) return;
    this.#store.update((state) => { delete state.devices[deviceId]; });
    const peers = this.#peers.get(deviceId);
    this.#peers.delete(deviceId);
    for (const peer of peers ?? []) void peer.notifyRevoked();
    this.snapshots.changed();
  }

  access(): Access {
    return this.#store.current.access;
  }

  setAccess(access: Access): void {
    this.#store.update((state) => { state.access = access; });
  }

  accept(peer: Peer, direct?: {
    deviceId: string;
    signal: AbortSignal;
    ready: (peer: Peer) => () => void;
  }): void {
    let deviceId: string | undefined;
    let challenge: { nonce: string; expires: number } | undefined;
    let attempted = false;
    let directReady = false;
    const expiry = setTimeout(() => peer.close(new ProtocolError("timeout")), ENROLLMENT_SESSION_MS);
    const fingerprint = brainFingerprint(this.#store.current.endpoint.publicKeyB64);

    peer.serve((method, payload, afterReply) => {
      if (direct?.signal.aborted) throw new ProtocolError("disconnected");
      if (deviceId && (!Object.hasOwn(this.#store.current.devices, deviceId) ||
          (!direct && !this.#peers.get(deviceId)?.has(peer)))) throw new ProtocolError("revoked");
      if (method === "describe" && !direct) return description(this.#store.current.endpoint.relay);
      if (method === "ping" && deviceId) return null;
      if (method === directReadyMethod && direct && deviceId && !directReady) {
        const promote = direct.ready(peer);
        directReady = true;
        afterReply(promote);
        return null;
      }
      if (method === "self.revoke" && deviceId && !direct) {
        this.revoke(deviceId); // revoked 通知也是对自撤销的确认。
        return null;
      }
      if (method === "auth.challenge" && !attempted && !challenge) {
        challenge = { nonce: randomToken(), expires: this.#now() + AUTH_TTL_MS };
        return { challenge: challenge.nonce };
      }
      if (!deviceId && !attempted && (method === "auth.pair" || method === "auth.resume")) {
        if (this.#changingRelay) throw new ProtocolError("busy");
        if (direct && method !== "auth.resume") throw new ProtocolError("invalid");
        attempted = true;
        if (!challenge || this.#now() >= challenge.expires) throw new ProtocolError("identity");
        const pair = method === "auth.pair" ? validate(PairSchema, payload) : undefined;
        const proof = pair ?? validate(DeviceProofSchema, payload);
        const id = verifyDevice(proof, fingerprint, challenge.nonce, pair?.secret);
        if (!id || (direct && id !== direct.deviceId)) throw new ProtocolError("identity");
        if (direct) {
          if (!Object.hasOwn(this.#store.current.devices, id)) throw new ProtocolError("revoked");
          clearTimeout(expiry);
          deviceId = id;
          peer.activate("brain");
          return { deviceId: id };
        }

        const lastSeenAt = new Date(this.#now()).toISOString();
        if (pair) {
          const inviteId = digest(pair.secret);
          const invite = this.#store.current.invites[inviteId];
          if (!invite || Date.parse(invite.expiresAt) <= this.#now()) throw new ProtocolError("invite");
          const currentRisks = description(this.#store.current.endpoint.relay).risks;
          if (currentRisks.some(({ code }) => !pair.acknowledgedRiskCodes.includes(code)))
            throw new ProtocolError("risks");
          this.#store.update((state) => {
            delete state.invites[inviteId];
            state.devices[id] = { name: invite.label ?? pair.name, lastSeenAt };
          });
        } else {
          if (!Object.hasOwn(this.#store.current.devices, id)) throw new ProtocolError("revoked");
          this.#store.update((state) => { state.devices[id].lastSeenAt = lastSeenAt; });
        }
        clearTimeout(expiry);
        deviceId = id;
        let peers = this.#peers.get(id);
        if (!peers) this.#peers.set(id, peers = new Set());
        peers.add(peer);
        peer.activate("brain");
        if (peer.port) {
          const route = new SelectedPort(peer.port);
          const target = this.#store.current.endpoint;
          const link: { route: SelectedPort; refresh: () => void; error?: string } = {
            route, refresh: brainDirect({
              relay: peer, route, settings: () => this.#store.current.direct, stateDir: this.#store.dir,
              keys: { publicKey: importPublicKey(target.publicKeyB64), secretKey: importSecretKey(target.secretKeyB64) },
              accept: (candidate, signal, ready) => this.accept(candidate, { deviceId: id, signal, ready }),
              status: (error) => {
                link.error = error;
                this.endpointSnapshots.changed();
              },
            }),
          };
          this.#direct.set(peer, link);
          this.#attach?.(id, route);
        }
        this.snapshots.changed();
        return { deviceId: id };
      }
      throw new ProtocolError("invalid");
    });

    void peer.closed.then(() => {
      clearTimeout(expiry);
      if (direct || !deviceId) return;
      if (this.#direct.delete(peer)) this.endpointSnapshots.changed();
      const peers = this.#peers.get(deviceId);
      if (!peers?.delete(peer) || peers.size > 0) return;
      this.#peers.delete(deviceId);
      const id = deviceId;
      try {
        this.#store.update((state) => { state.devices[id].lastSeenAt = new Date(this.#now()).toISOString(); });
      } catch {
        console.error("Could not persist Remote hand device last seen time.");
      }
      this.snapshots.changed();
    });
  }
}
