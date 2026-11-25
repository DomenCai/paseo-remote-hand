import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  BrainPreviewSchema, RelayAddressSchema, RISKS_NOT_ACKNOWLEDGED, type Brain, type BrainPolicy, type BrainPreview,
} from "../shared/settings.ts";
import { brainFingerprint, DeviceIdSchema, newDeviceKey, parsePairCode, requestChallenge, resume, signDevice } from "./identity.ts";
import { handDirect } from "./direct/session.ts";
import { SelectedPort } from "./direct/selected-port.ts";
import { ProtocolError, validate } from "./frames.ts";
import type { ConnectionPort, Peer } from "./protocol.ts";
import { remoteRequest } from "./remote-agent-stream.ts";
import { connectBrain, reconnectDelay } from "./relay.ts";
import { Snapshots } from "./snapshots.ts";
import type { StateStore, StoredBrain } from "./state.ts";

const relayMoveSchema = z.object({ relay: RelayAddressSchema });
type View = Pick<Brain, "status" | "transport" | "lastError" | "models">;
type Slot = { stop: AbortController; view: View; peer?: Peer; route?: SelectedPort; refreshDirect?: () => void };

async function maintain(peer: Peer, afterPing: () => void): Promise<ProtocolError> {
  const stop = new AbortController();
  void peer.closed.then(() => stop.abort());
  try {
    while (!stop.signal.aborted) {
      await delay(15_000, undefined, { signal: stop.signal });
      await peer.request("ping", null, 5_000);
      afterPing();
    }
  } catch (error) {
    if (!stop.signal.aborted) peer.close(error instanceof ProtocolError ? error : undefined);
  }
  return peer.closed;
}

export class HandService {
  #slots = new Map<string, Slot>();
  #adding = new Set<string>();
  #stop = new AbortController();
  readonly snapshots = new Snapshots(() => this.brains());

  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  start(): void {
    for (const brainId of Object.keys(this.#store.current.brains)) this.#startBrain(brainId);
  }

  stop(): void {
    this.#stop.abort();
    for (const slot of this.#slots.values()) slot.stop.abort();
  }

  brains(): Brain[] {
    return Object.entries(this.#store.current.brains).map(([brainId, { name, os, relay, policy, projects, revoked }]) => ({
      brainId, name, os, relay, policy, projects,
      ...(this.#slots.get(brainId)?.view ?? {
        status: revoked ? "revoked" : "connecting", transport: null,
        ...(revoked && { lastError: new ProtocolError("revoked").message }),
      }),
    }));
  }

  async preview(code: string): Promise<BrainPreview> {
    const target = parsePairCode(code);
    const peer = connectBrain(target, this.#stop.signal);
    try {
      const description = validate(BrainPreviewSchema, await peer.request("describe"));
      return { ...description, relay: target.relay };
    } finally {
      peer.close();
    }
  }

  async add(code: string, name: string, acknowledgedRiskCodes: string[]): Promise<{ brainId: string }> {
    const { inviteSecret, expiresAt: _, v: __, ...target } = parsePairCode(code);
    const brainId = brainFingerprint(target.publicKeyB64);
    if (Object.hasOwn(this.#store.current.brains, brainId) || this.#adding.has(brainId))
      throw new Error("This brain is already listed or is being added.");
    this.#adding.add(brainId);
    let peer: Peer | undefined;
    try {
      peer = connectBrain(target, this.#stop.signal);
      const description = validate(BrainPreviewSchema, await peer.request("describe"));
      if (description.risks.some(({ code }) => !acknowledgedRiskCodes.includes(code)))
        throw new Error(RISKS_NOT_ACKNOWLEDGED);
      const key = newDeviceKey();
      const proof = signDevice(key, brainId, await requestChallenge(peer), inviteSecret);
      const paired = peer;
      const admitted = peer.request("auth.pair", {
        ...proof, secret: inviteSecret, name: (hostname() || "Remote hand").slice(0, 255), acknowledgedRiskCodes,
      }).then((result) => {
        validate(DeviceIdSchema, result);
        this.#store.update((state) => {
          state.brains[brainId] = { ...target, name, os: description.os, policy: "restricted", projects: [], key, revoked: false };
        });
        this.#startBrain(brainId, paired);
      });
      this.#watchMoves(peer, brainId, admitted);
      await admitted;
      peer = undefined; // 已配对连接交给连接管理器，避免再做一次握手。
      return { brainId };
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "risks") throw new Error(RISKS_NOT_ACKNOWLEDGED);
      throw error;
    } finally {
      this.#adding.delete(brainId);
      peer?.close();
    }
  }

  rename(brainId: string, name: string): void {
    this.#update(brainId, (brain) => { brain.name = name; });
  }

  setPolicy(brainId: string, policy: BrainPolicy): void {
    this.#update(brainId, (brain) => { brain.policy = policy; });
  }

  setRelay(brainId: string, relay: string): void {
    if (this.#brain(brainId).relay === relay) return;
    this.#store.update((state) => { state.brains[brainId].relay = relay; });
    this.#startBrain(brainId);
  }

  port(brainId: string): ConnectionPort | undefined {
    return this.#slots.get(brainId)?.route;
  }

  directSettingsChanged(): void {
    for (const slot of this.#slots.values()) slot.refreshDirect?.();
  }

  readPolicy(brainId: string): { mode: "full" } | { mode: "restricted"; projects: string[] } {
    const brain = this.#brain(brainId);
    if (brain.revoked) throw new ProtocolError("revoked");
    return brain.policy === "full" ? { mode: "full" } :
      { mode: "restricted", projects: brain.projects.map(({ root }) => root) };
  }

  authorizeProject(brainId: string, root: string): void {
    const brain = this.#brain(brainId);
    if (brain.revoked) throw new ProtocolError("revoked");
    if (brain.projects.some((project) => project.root === root)) return;
    this.#update(brainId, (record) => { record.projects.push({ root, grantedAt: new Date().toISOString() }); });
  }

  async #loadModels(brainId: string, slot: Slot, port: ConnectionPort): Promise<void> {
    try {
      const catalog = await remoteRequest(port, "agent.catalog", {}, port.signal);
      if (this.#slots.get(brainId) !== slot || slot.route !== port || port.signal.aborted) return;
      const models = catalog.providers.flatMap((provider) => provider.models.map((model) => ({
        id: `${brainId}/${provider.id}/${model.id}`, label: `${provider.label} · ${model.label}`,
      })));
      if (JSON.stringify(slot.view.models) === JSON.stringify(models)) return;
      slot.view = { ...slot.view, models };
      this.snapshots.changed();
    } catch {
      // 目录暂不可用时保留连接，下一次心跳后再尝试。
    }
  }

  revokeProject(brainId: string, root: string): void {
    this.#update(brainId, (brain) => { brain.projects = brain.projects.filter((project) => project.root !== root); });
  }

  async remove(brainId: string): Promise<{ remoteRevoked: boolean }> {
    const brain = this.#brain(brainId);
    const slot = this.#slots.get(brainId);
    this.#store.update((state) => { delete state.brains[brainId]; });
    this.#slots.delete(brainId);
    this.snapshots.changed();
    let peer = slot?.peer;
    try {
      if (brain.revoked) return { remoteRevoked: true };
      if (!peer || peer.failure) {
        const signal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(4_000)]);
        peer = connectBrain(brain, signal);
        await resume(peer, brain);
      }
      await peer.request("self.revoke", null, 4_000);
      return { remoteRevoked: true };
    } catch (error) {
      return { remoteRevoked: error instanceof ProtocolError && error.code === "revoked" };
    } finally {
      slot?.stop.abort();
      peer?.close();
    }
  }

  #brain(brainId: string): StoredBrain {
    if (!Object.hasOwn(this.#store.current.brains, brainId)) throw new Error("Unknown Remote hand brain.");
    return this.#store.current.brains[brainId];
  }

  #update(brainId: string, change: (brain: StoredBrain) => void): void {
    this.#brain(brainId);
    this.#store.update((state) => change(state.brains[brainId]));
    this.snapshots.changed();
  }

  #watchMoves(peer: Peer, brainId: string, admitted: Promise<void>): void {
    peer.serve(async (method, payload, afterReply) => {
      if (method !== "relay.move") throw new ProtocolError("invalid");
      const { relay } = validate(relayMoveSchema, payload);
      await admitted;
      const slot = this.#slots.get(brainId);
      if (!slot || slot.peer !== peer || peer.failure) throw new ProtocolError("disconnected");
      if (this.#brain(brainId).relay !== relay) {
        this.#store.update((state) => { state.brains[brainId].relay = relay; });
        // ACK 只有在落盘后才发送，新连接只能在旧连接写完 ACK 后开始。
        afterReply(() => {
          if (this.#slots.get(brainId) === slot) this.#startBrain(brainId);
        });
      }
      return null;
    });
  }

  #startBrain(brainId: string, paired?: Peer): void {
    const old = this.#slots.get(brainId);
    this.#slots.delete(brainId);
    old?.stop.abort();
    old?.peer?.close();
    const brain = this.#brain(brainId);
    if (brain.revoked || this.#stop.signal.aborted) {
      paired?.close();
      this.snapshots.changed();
      return;
    }
    const slot: Slot = {
      stop: new AbortController(), view: { status: "connecting", transport: null },
    };
    this.#slots.set(brainId, slot);
    this.snapshots.changed();
    void this.#run(brainId, brain, slot, paired).catch(() => {
      console.error("Remote hand connection manager stopped unexpectedly.");
    });
  }

  async #run(brainId: string, brain: StoredBrain, slot: Slot, paired?: Peer): Promise<void> {
    const signal = slot.stop.signal;
    const active = () => !signal.aborted && this.#slots.get(brainId) === slot;
    let retries = 0;
    while (active()) {
      let peer: Peer | undefined;
      let failure: ProtocolError;
      try {
        const connected = (link: Peer) => {
          if (!active()) throw new ProtocolError("disconnected");
          if (link.failure) throw link.failure;
          slot.peer = link;
          link.activate("hand");
          slot.view = { status: "connected", transport: "relay" };
          if (link.port) {
            const route = slot.route = new SelectedPort(link.port);
            // 发布稳定端口，让 provider 先安装 tool.call handler。
            this.snapshots.changed();
            slot.refreshDirect = handDirect({
              relay: link, route, brain, stateDir: this.#store.dir, settings: () => this.#store.current.direct,
              status: (transport, lastError) => {
                if (!active() || slot.peer !== link || link.failure) return;
                if (slot.view.transport === transport && slot.view.lastError === lastError) return;
                slot.view = { ...slot.view, transport, lastError };
                this.snapshots.changed();
              },
            });
            void this.#loadModels(brainId, slot, route);
          } else {
            this.snapshots.changed();
          }
        };
        if (paired) {
          peer = paired;
          paired = undefined;
          connected(peer);
        } else {
          const link = peer = connectBrain(brain, signal);
          const admitted = resume(link, brain).then(() => connected(link));
          this.#watchMoves(link, brainId, admitted);
          await admitted;
        }
        retries = 0;
        const port = slot.route;
        failure = await maintain(peer, () => { if (port) void this.#loadModels(brainId, slot, port); });
      } catch (error) {
        failure = error instanceof ProtocolError ? error : new ProtocolError("disconnected");
      } finally {
        peer?.close();
        slot.peer = undefined;
        slot.route = undefined;
        slot.refreshDirect = undefined;
      }
      if (!active()) return;
      const revoked = failure.code === "revoked";
      const unverified = failure.code === "version" || failure.code === "identity";
      if (revoked) {
        try {
          this.#store.update((state) => { state.brains[brainId].revoked = true; });
        } catch {
          console.error("Could not persist Remote hand revocation.");
        }
      }
      slot.view = {
        status: revoked ? "revoked" : unverified ? "unverified" : "disconnected",
        transport: null, lastError: failure.message,
      };
      this.snapshots.changed();
      if (revoked) return;
      try {
        await delay(reconnectDelay(retries++), undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }
}
