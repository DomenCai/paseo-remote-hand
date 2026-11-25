import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { DirectSettings } from "../../shared/settings.ts";
import { ProtocolError, type Json, validate } from "../frames.ts";
import type { Peer } from "../protocol.ts";
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
const noLocalPeers = "No rendezvous peers are configured on this machine.";
const remoteOff = "Direct connection is off on the remote machine, or it has no rendezvous peers.";
const remoteUnsupported = "The remote machine does not support direct connections.";
// 平台不支持和文件校验失败重试也不会成功；其余失败（打洞、协商、下载、进程退出）都按临时性处理。
const permanentError = /^EasyTier (SHA-256 verification failed|archive |v?2\.6\.4 is unsupported)|^Invalid EasyTier cache/;
const retryDelays = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const flapWindowMs = 10 * 60_000;
const heartbeatMs = 10_000;
const pingMs = 5_000;
// 包含 UDP 探测等待；跨机实测直连约 25 秒建立，留出余量。
const negotiateMs = 45_000;
const heartbeatMisses = 3;
const pollMs = 10_000;
// 定时器在睡眠期间不走，墙钟会；醒来后的差值远大于等待时间。
const driftMs = 15_000;
type Topology = Pick<Parameters<typeof startEasyTier>[0], "listeners" | "stunServers">;

// 只比较外部地址集合，网卡顺序和回环地址变化不算网络变化。
function addresses(): string {
  return Object.values(networkInterfaces()).flat()
    .flatMap((entry) => entry && !entry.internal ? [entry.address] : []).sort().join();
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^EasyTier (official download (failed|timed out)|SHA-256 verification failed|archive |did not become ready|exited before becoming ready|v?2\.6\.4 is unsupported)/.test(message))
    return message.slice(0, 240);
  if (error instanceof Error && error.name === "TimeoutError") return "EasyTier setup timed out.";
  if (message === "Invalid EasyTier cache file." || message === "Invalid EasyTier cache directory.") return message;
  return unavailable;
}

export function brainDirect({
  relay, route, settings, stateDir, keys, accept, status, topology,
}: {
  relay: Peer;
  route: SelectedPort;
  settings: () => DirectSettings;
  stateDir: string;
  keys: Parameters<typeof listenDirect>[0];
  accept: (peer: Peer, signal: AbortSignal, ready: (peer: Peer) => () => void) => void;
  status: (error?: string) => void;
  // 仅回环测试使用：直接监听本机地址并关闭 STUN，代替会合节点。
  topology?: Topology;
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
        role: "brain", network, brainPort: listener.port, probePort, peers: config.peers, ...topology, stateDir, signal,
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

/** 直连握手、心跳和自动重试的回调。 */
export type HandDirectStatus = (transport: "direct" | "relay", error?: string, retryAt?: number) => void;

export function handDirect({
  relay, route, brain, settings, stateDir, status, delays = retryDelays, topology,
}: {
  relay: Peer;
  route: SelectedPort;
  brain: Parameters<typeof connectDirect>[1];
  settings: () => DirectSettings;
  stateDir: string;
  status: HandDirectStatus;
  // 测试可缩短退避；最后一项同时是抖动后的上限和频繁掉线时的间隔。
  delays?: readonly number[];
  // 仅回环测试使用，同 brainDirect。
  topology?: Topology;
}) {
  const port = relay.port!;
  const longest = delays.at(-1)!;
  let session: AbortController | undefined;
  let wake: (() => void) | undefined;
  // 跨设置变化保留，频繁掉线的判断不因重新协商而清零。
  let drops: number[] = [];

  function refresh() {
    session?.abort();
    session = undefined;
    status("relay");
    const config = settings();
    if (!config.enabled || port.signal.aborted) return;
    if (!config.peers.length) { status("relay", noLocalPeers); return; }
    const own = session = new AbortController();
    void retry(config, AbortSignal.any([own.signal, port.signal]));
  }

  // 永久性失败停在原因上，等本机 direct.set 或对端 direct.changed；临时性失败按退避重试。
  async function retry(config: DirectSettings, signal: AbortSignal) {
    let failures = 0;
    for (;;) {
      const result = await attempt(config, signal);
      if (signal.aborted) return;
      if (result.permanent) { status("relay", result.error); return; }
      const now = Date.now();
      if (result.dropped) {
        failures = 0;
        drops = [...drops.filter((at) => now - at < flapWindowMs), now];
      }
      const flapping = drops.filter((at) => now - at < flapWindowMs).length >= 3;
      const base = flapping ? longest : delays[Math.min(failures++, delays.length - 1)];
      const wait = Math.min(Math.round(base * (0.8 + Math.random() * 0.4)), longest);
      status("relay", result.error, now + wait);
      const early = await pause(wait, signal);
      if (signal.aborted) return;
      if (early) {
        failures = 0;
        status("relay", result.error, Date.now());
      }
    }
  }

  // 等待期间低频检查网卡地址和定时器漂移；网络变化、睡眠唤醒或用户要求时提前返回 true。
  async function pause(ms: number, signal: AbortSignal): Promise<boolean> {
    const early = new AbortController();
    const scope = AbortSignal.any([signal, early.signal]);
    const stop = wake = () => early.abort();
    const network = addresses();
    const deadline = Date.now() + ms;
    try {
      for (let left = ms; left > 0; left = deadline - Date.now()) {
        const step = Math.min(left, pollMs);
        const before = Date.now();
        await delay(step, undefined, { signal: scope }).catch(() => {});
        if (scope.aborted || Date.now() - before > step + driftMs || addresses() !== network) return true;
      }
      return false;
    } finally {
      if (wake === stop) wake = undefined;
    }
  }

  async function attempt(config: DirectSettings, signal: AbortSignal): Promise<{ error: string; permanent?: boolean; dropped?: boolean }> {
    const own = new AbortController();
    const scope = AbortSignal.any([own.signal, signal]);
    const id = randomUUID();
    let peer: Peer | undefined;
    let connected = false;
    try {
      let raw: unknown;
      try {
        raw = await relay.request(offerMethod, { id, localSubnets: localSubnets() }, offerMs, scope);
      } catch (error) {
        // 未实现直连的旧版 brain 仍可走 relay。
        if (error instanceof ProtocolError && error.code === "invalid") return { error: remoteUnsupported, permanent: true };
        throw error;
      }
      scope.throwIfAborted();
      const offer = validate(offerSchema, raw);
      if (offer.kind === "off") return { error: remoteOff, permanent: true };
      if (offer.kind === "error") return { error: offer.message, permanent: permanentError.test(offer.message) };
      const instance = await startEasyTier({
        role: "hand", network: offer.network, brainPort: offer.brainPort, probePort: offer.probePort, peers: config.peers, ...topology,
        stateDir, signal: scope, setupSignal: AbortSignal.any([scope, AbortSignal.timeout(installMs)]),
      });
      if (!instance?.forwardPort || !instance.probeForwardPort) throw new Error(unavailable);
      const linkSignal = AbortSignal.any([scope, instance.signal]);
      const negotiate = AbortSignal.any([linkSignal, AbortSignal.timeout(negotiateMs)]);
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
      const direct = peer.port;
      if (!direct) throw new Error(unavailable);
      route.setDirect(direct);
      await peer.request(directReadyMethod, null, 3_000, linkSignal);
      if (peer.failure) throw peer.failure;
      linkSignal.throwIfAborted();
      route.preferDirect(direct);
      connected = true;
      status("direct");
      // 心跳连续无响应就回落，不等 TCP 超时；直连或 EasyTier 关闭时立即结束。
      const wait = AbortSignal.any([linkSignal, direct.signal]);
      for (let misses = 0; misses < heartbeatMisses;) {
        await delay(heartbeatMs, undefined, { signal: wait });
        misses = await peer.request("ping", null, pingMs, wait).then(() => 0, () => misses + 1);
      }
      return { error: stopped, dropped: true };
    } catch (error) {
      if (connected) return { error: stopped, dropped: true };
      const message = safeError(error);
      return { error: message, permanent: permanentError.test(message) };
    } finally {
      peer?.close();
      own.abort();
      if (!port.signal.aborted) void relay.request(stopMethod, { id }, 2_000).catch(() => {});
    }
  }

  port.handle(changedMethod, async () => { refresh(); return null; });
  refresh();
  return {
    // 本机设置变化：结束当前尝试，从退避起点重新协商。
    refresh,
    // 用户要求立即重试：只唤醒正在等待的自动重试，不打断协商中或已建立的直连。
    retryNow: () => wake?.(),
  };
}
