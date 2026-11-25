import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { DirectSettings } from "../../shared/settings.ts";
import { ProtocolError, type Json, validate } from "../frames.ts";
import type { Peer } from "../protocol.ts";
import type { StoredBrain } from "../state.ts";
import {
  DirectNetworkSchema, SubnetSchema, listenProbe, localSubnets, newDirectNetwork, probeBrain, startEasyTier,
} from "./easytier.ts";
import type { SelectedPort } from "./selected-port.ts";
import { connectDirect, listenDirect } from "./transport.ts";

const offerMethod = "direct.offer";
const stopMethod = "direct.stop";
const changedMethod = "direct.changed";
export const directReadyMethod = "direct.ready";
const attemptSchema = z.object({ id: z.uuid() });
// hand 带上本机网卡网段，brain 选两端都不重叠的虚拟网段。
const offerRequestSchema = attemptSchema.extend({ localSubnets: z.array(SubnetSchema).max(256) });
const portSchema = z.int().min(1).max(65535);
const offerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("off") }),
  z.object({ kind: z.literal("error"), message: z.string().max(240) }),
  z.object({ kind: z.literal("ready"), network: DirectNetworkSchema, brainPort: portSchema, probePort: portSchema }),
]);
const enabled = (config: DirectSettings) => config.enabled && config.peers.length > 0;
const unavailable = "EasyTier direct connection could not be established.";
const stopped = "EasyTier direct connection closed; using relay.";
const installMs = 120_000;
const offerMs = installMs + 10_000;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^EasyTier (official download (failed|timed out)|SHA-256 verification failed|archive |did not become ready|exited before becoming ready|v?2\.6\.4 is unsupported)/.test(message))
    return message.slice(0, 240);
  if (error instanceof Error && error.name === "TimeoutError") return "EasyTier setup timed out.";
  if (message === "Invalid EasyTier cache file." || message === "Invalid EasyTier cache directory.") return message;
  return unavailable;
}

export function brainDirect({
  relay, route, settings, stateDir, keys, accept, status,
}: {
  relay: Peer;
  route: SelectedPort;
  settings: () => DirectSettings;
  stateDir: string;
  keys: Parameters<typeof listenDirect>[0];
  accept: (peer: Peer, signal: AbortSignal, ready: (peer: Peer) => () => void) => void;
  status: (error?: string) => void;
}) {
  let current: { id: string; stop: AbortController } | undefined;
  const port = relay.port!;
  const end = () => {
    const attempt = current;
    current = undefined;
    attempt?.stop.abort();
  };
  port.signal.addEventListener("abort", end, { once: true });
  port.handle(stopMethod, async (payload) => {
    if (current?.id === validate(attemptSchema, payload).id) end();
    return null;
  });
  // 协商可能包含首次下载。用控制请求的长超时，但仍通过应用 handler 接收取消。
  port.handle(offerMethod, async (payload, incoming): Promise<Json> => {
    const { id, localSubnets: handSubnets } = validate(offerRequestSchema, payload);
    end();
    const config = settings();
    if (!enabled(config)) return { kind: "off" };
    const attempt = current = { id, stop: new AbortController() };
    const signal = AbortSignal.any([port.signal, incoming, attempt.stop.signal]);
    const timer = setTimeout(() => {
      if (current !== attempt) return;
      end();
      status(unavailable);
    }, 2 * installMs + 35_000).unref();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      if (current === attempt) current = undefined;
    }, { once: true });
    let chosen: Peer | undefined;
    status();
    try {
      const network = newDirectNetwork([...handSubnets, ...localSubnets()]);
      const listener = await listenDirect(keys, (peer) => {
        accept(peer, signal, (authenticated) => {
          if (chosen || signal.aborted) throw new ProtocolError("busy");
          const direct = authenticated.port;
          if (!direct) throw new ProtocolError("invalid");
          chosen = authenticated;
          route.setDirect(direct);
          // ready 的 ACK 完成写入后才从 brain 主动发直连请求。
          return () => {
            clearTimeout(timer);
            route.preferDirect(direct);
          };
        });
        void peer.closed.then(() => {
          if (chosen !== peer || current !== attempt) return;
          end();
          status(stopped);
        });
      }, signal);
      const probePort = await listenProbe(network, signal);
      const instance = await startEasyTier({
        role: "brain", network, brainPort: listener.port, probePort, peers: config.peers, stateDir, signal,
        setupSignal: AbortSignal.any([signal, AbortSignal.timeout(installMs)]),
      });
      if (!instance) throw new Error(unavailable);
      const instanceEnded = () => {
        if (current !== attempt) return;
        end();
        status(stopped);
      };
      void instance.closed.then(instanceEnded, instanceEnded);
      signal.throwIfAborted();
      return { kind: "ready", network, brainPort: listener.port, probePort };
    } catch (error) {
      const message = safeError(error);
      if (current === attempt) {
        end();
        status(message);
      }
      return { kind: "error", message };
    }
  });
  return () => {
    end();
    status();
    void relay.request(changedMethod).catch(() => {});
  };
}

export function handDirect({
  relay, route, brain, settings, stateDir, status,
}: {
  relay: Peer;
  route: SelectedPort;
  brain: StoredBrain;
  settings: () => DirectSettings;
  stateDir: string;
  status: (transport: "direct" | "relay", error?: string) => void;
}) {
  const port = relay.port!;
  let stop: AbortController | undefined;
  function refresh() {
    stop?.abort();
    stop = undefined;
    status("relay");
    const config = settings();
    if (!enabled(config) || port.signal.aborted) return;
    const own = stop = new AbortController();
    const signal = AbortSignal.any([own.signal, port.signal]);
    const id = randomUUID();
    void run().catch(() => {});
    async function run() {
      let peer: Peer | undefined;
      try {
        let raw: unknown;
        try {
          raw = await relay.request(offerMethod, { id, localSubnets: localSubnets() }, offerMs, signal);
        } catch (error) {
          // 未实现直连的旧版 brain 仍可走 relay。
          if (error instanceof ProtocolError && error.code === "invalid") return;
          throw error;
        }
        signal.throwIfAborted();
        const offer = validate(offerSchema, raw);
        if (offer.kind === "off") return;
        if (offer.kind === "error") { status("relay", offer.message); return; }
        const instance = await startEasyTier({
          role: "hand", network: offer.network, brainPort: offer.brainPort, probePort: offer.probePort,
          peers: config.peers, stateDir, signal, setupSignal: AbortSignal.any([signal, AbortSignal.timeout(installMs)]),
        });
        if (!instance?.forwardPort || !instance.probeForwardPort) throw new Error(unavailable);
        const linkSignal = AbortSignal.any([signal, instance.signal]);
        const negotiate = AbortSignal.any([linkSignal, AbortSignal.timeout(25_000)]);
        // 对端路由就绪前连 TCP 转发，EasyTier 会改用系统网络直连虚拟 IP。
        await probeBrain(instance.probeForwardPort, offer.network, negotiate);
        while (!peer) {
          negotiate.throwIfAborted();
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(), 2_000);
          try {
            // 只重试建链和认证，不重试业务操作。
            peer = await connectDirect(instance.forwardPort, brain, AbortSignal.any([linkSignal, timeout.signal]));
          } catch (error) {
            if (error instanceof ProtocolError && error.code === "revoked") throw error;
            await delay(250, undefined, { signal: negotiate });
          } finally {
            clearTimeout(timer);
          }
        }
        const port = peer.port;
        if (!port) throw new Error(unavailable);
        route.setDirect(port);
        await peer.request(directReadyMethod, null, 3_000, linkSignal);
        if (peer.failure) throw peer.failure;
        linkSignal.throwIfAborted();
        route.preferDirect(port);
        status("direct");
        const closed = port.signal;
        const wait = AbortSignal.any([linkSignal, closed]);
        try {
          while (!wait.aborted) {
            await delay(5_000, undefined, { signal: wait });
            await peer.request("ping", null, 3_000, wait);
          }
        } catch { /* 回落和清理在 finally 做。 */ }
        peer.close();
        if (!signal.aborted && stop === own) status("relay", stopped);
      } catch (error) {
        peer?.close();
        if (!signal.aborted && stop === own) status("relay", safeError(error));
      } finally {
        peer?.close();
        own.abort();
        if (!port.signal.aborted) void relay.request(stopMethod, { id }, 2_000).catch(() => {});
      }
    }
  }
  port.handle(changedMethod, async () => { refresh(); return null; });
  refresh();
  return refresh;
}
