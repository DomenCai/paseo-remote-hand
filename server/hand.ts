import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  BrainPreviewSchema, RISKS_NOT_ACKNOWLEDGED, type Brain, type BrainPolicy, type BrainPreview,
} from "../shared/settings.ts";
import { brainFingerprint, newDeviceKey, parsePairCode, signDevice } from "./identity.ts";
import { type Peer, ProtocolError, validate } from "./protocol.ts";
import { connectBrain, reconnectDelay } from "./relay.ts";
import { Snapshots } from "./snapshots.ts";
import type { StateStore, StoredBrain } from "./state.ts";

const challengeSchema = z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const deviceIdSchema = z.object({ deviceId: z.string().regex(/^[0-9a-f]{64}$/) });
type View = Pick<Brain, "status" | "transport" | "lastError">;
type Slot = { stop: AbortController; view: View; peer?: Peer };

async function challenge(peer: Peer): Promise<string> {
  return validate(challengeSchema, await peer.request("auth.challenge")).challenge;
}

async function resume(peer: Peer, brain: StoredBrain): Promise<void> {
  const proof = signDevice(brain.key, brainFingerprint(brain.publicKeyB64), await challenge(peer));
  validate(deviceIdSchema, await peer.request("auth.resume", proof));
}

async function maintain(peer: Peer): Promise<ProtocolError> {
  const stop = new AbortController();
  void peer.closed.then(() => stop.abort());
  try {
    while (!stop.signal.aborted) {
      await delay(15_000, undefined, { signal: stop.signal });
      await peer.request("ping", null, 5_000);
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
      const proof = signDevice(key, brainId, await challenge(peer), inviteSecret);
      validate(deviceIdSchema, await peer.request("auth.pair", {
        ...proof, secret: inviteSecret, name: (hostname() || "Remote hand").slice(0, 255), acknowledgedRiskCodes,
      }));
      this.#store.update((state) => {
        state.brains[brainId] = { ...target, name, os: description.os, policy: "restricted", projects: [], key, revoked: false };
      });
      this.#startBrain(brainId, peer);
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

  #startBrain(brainId: string, paired?: Peer): void {
    const brain = this.#brain(brainId);
    if (brain.revoked) return;
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
        if (paired) {
          peer = paired;
          paired = undefined;
        } else {
          peer = connectBrain(brain, signal);
          await resume(peer, brain);
        }
        if (!active()) return;
        if (peer.failure) throw peer.failure;
        slot.peer = peer;
        slot.view = { status: "connected", transport: "relay" };
        this.snapshots.changed();
        retries = 0;
        failure = await maintain(peer);
      } catch (error) {
        failure = error instanceof ProtocolError ? error : new ProtocolError("disconnected");
      } finally {
        peer?.close();
        slot.peer = undefined;
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
