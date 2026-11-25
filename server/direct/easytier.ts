import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { once, on } from "node:events";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, isIPv4, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ensureEasyTier } from "./easytier-binary.ts";

const loopback = "127.0.0.1";
// RFC 5737 的 TEST-NET-2/3 只用于文档，不会是公网主机、常见 LAN、CGNAT 或 fake-ip 地址。
// 每代只需两个地址，切成 /30 以尽量少占地址；EasyTier 会拒绝远端地址落在本机虚拟网段里的隧道。
const directSubnets = ["198.51.100", "203.0.113"].flatMap((prefix) =>
  Array.from({ length: 64 }, (_, index) => `${prefix}.${index * 4}/30`));
export const SubnetSchema = z.string().max(18).refine((value) => {
  const [address, bits, ...rest] = value.split("/");
  return !rest.length && isIPv4(address) && /^\d{1,2}$/.test(bits ?? "") && Number(bits) <= 32;
});
export const DirectNetworkSchema = z.strictObject({
  name: z.string().regex(/^rh-[A-Za-z0-9_-]{22}$/),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  subnet: z.string().refine((value) => directSubnets.includes(value)),
});
export type DirectNetwork = z.infer<typeof DirectNetworkSchema>;

function ipv4Range(cidr: string): [number, number] {
  const [address, bits] = cidr.split("/");
  const value = address.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0);
  const size = 2 ** (32 - Number(bits));
  const start = value - (value % size);
  return [start, start + size - 1];
}

/** 本机 IPv4 网卡所在网段，协商时双方都要避开。 */
export function localSubnets(): string[] {
  return Object.values(networkInterfaces()).flat().flatMap((item) =>
    item?.family === "IPv4" && !item.internal && item.cidr ? [item.cidr] : []);
}

/** avoid 是两端网卡网段；取第一个与它们都不重叠的候选网段。 */
export function newDirectNetwork(avoid: readonly string[]): DirectNetwork {
  const used = avoid.map(ipv4Range);
  const subnet = directSubnets.find((candidate) => {
    const [start, end] = ipv4Range(candidate);
    return used.every(([from, to]) => to < start || end < from);
  });
  if (!subnet) throw new Error("No free EasyTier direct subnet.");
  return { name: `rh-${randomBytes(16).toString("base64url")}`, secret: randomBytes(32).toString("base64url"), subnet };
}

function directIp(subnet: string) {
  const [address] = subnet.split("/");
  const prefix = address.slice(0, address.lastIndexOf(".") + 1);
  const base = Number(address.slice(prefix.length));
  return { brain: `${prefix}${base + 1}`, hand: `${prefix}${base + 2}` };
}

type Forward = { bindPort: number; destinationPort: number; protocol: "tcp" | "udp" };
type Config = {
  network: DirectNetwork;
  role: "hand" | "brain";
  brainPort: number;
  // brain 本机的 UDP 路由探测应答端口，见 listenProbe。
  probePort: number;
  peers?: readonly string[];
  listeners?: readonly string[];
  // 空数组关闭 STUN，供纯 loopback 验证或显式部署设置使用。
  stunServers?: readonly string[];
};
type Install = { stateDir: string; signal: AbortSignal; setupSignal?: AbortSignal; archivePath?: string };

function port(value: number) {
  return z.number().int().min(1).max(65535).parse(value);
}

function address(value: string) {
  const parsed = new URL(value);
  if (!["tcp:", "udp:"].includes(parsed.protocol) || !parsed.hostname || !parsed.port ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname && parsed.pathname !== "/")) throw new Error("EasyTier addresses must be tcp://host:port or udp://host:port.");
  port(Number(parsed.port));
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
}

/** 配置里的 inbound 只限制新流量，EasyTier 的 ACL 会放行本机发起的连接的回包。 */
export function easyTierConfig(input: Config, forwards: readonly Forward[] = []): string {
  const { name, secret, subnet } = DirectNetworkSchema.parse(input.network);
  const entry = port(input.brainPort);
  const probe = port(input.probePort);
  const ip = directIp(subnet);
  const other = ip[input.role === "brain" ? "hand" : "brain"];
  const ready = [
    'instance_name = "remote-hand"',
    `ipv4 = "${ip[input.role]}/30"`,
    "dhcp = false",
    `listeners = ${JSON.stringify((input.listeners ?? []).map(address))}`,
    ...(input.stunServers ? [`stun_servers = ${JSON.stringify(input.stunServers)}`, "stun_servers_v6 = []"] : []),
    "",
    "[network_identity]",
    `network_name = "${name}"`,
    `network_secret = "${secret}"`,
    ...[...new Set((input.peers ?? []).map(address))].flatMap((uri) => ["", "[[peer]]", `uri = ${JSON.stringify(uri)}`]),
    ...forwards.flatMap((rule) => [
      "", "[[port_forward]]",
      `bind_addr = "${loopback}:${port(rule.bindPort)}"`,
      `dst_addr = "${other}:${port(rule.destinationPort)}"`,
      `proto = "${z.enum(["tcp", "udp"]).parse(rule.protocol)}"`,
    ]),
    "",
    "[flags]",
    "no_tun = true",
    "enable_ipv6 = false",
    "disable_upnp = true",
    "private_mode = true",
    "p2p_only = true",
    'relay_network_whitelist = ""',
    "disable_relay_data = true",
    "disable_kcp_input = true",
    "disable_quic_input = true",
    "",
    "[[acl.acl_v1.chains]]",
    'name = "remote-hand-inbound"',
    "chain_type = 1",
    "enabled = true",
    "default_action = 2",
  ];
  if (input.role === "brain") {
    for (const [rule, protocol, allowed] of [["remote-hand-entry", 1, entry], ["remote-hand-probe", 2, probe]] as const) {
      ready.push(
        "", "[[acl.acl_v1.chains.rules]]",
        `name = "${rule}"`,
        "enabled = true",
        "priority = 1000",
        "action = 1",
        `protocol = ${protocol}`,
        `ports = ["${allowed}"]`,
        `source_ips = ["${other}/32"]`,
        `destination_ips = ["${ip.brain}/32"]`,
      );
    }
  }
  ready.push("", "[[acl.acl_v1.chains]]", 'name = "remote-hand-forward"', "chain_type = 3",
    "enabled = true", "default_action = 2", "");
  return ready.join("\n");
}

export async function localTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, loopback, resolve);
  });
  const assigned = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return assigned;
}

async function localUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  socket.bind(0, loopback);
  await once(socket, "listening");
  const assigned = socket.address().port;
  socket.close();
  return assigned;
}

/**
 * brain 侧：只对本代网络名作应答。ACL 只放行对端虚拟 IP 到这个 UDP 端口。
 * 应答器出错时关闭并调用 failed，由调用方结束本代 EasyTier，避免 ACL 放行的端口被别的 socket 复用。
 */
export async function listenProbe(network: DirectNetwork, signal: AbortSignal, failed: () => void): Promise<number> {
  const token = Buffer.from(network.name);
  const socket = createSocket("udp4");
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    signal.removeEventListener("abort", close);
    socket.close();
  };
  socket.on("message", (message, remote) => {
    if (token.equals(message)) socket.send(token, remote.port, remote.address);
  });
  signal.addEventListener("abort", close, { once: true });
  try {
    socket.bind(0, loopback);
    await once(socket, "listening", { signal });
    socket.on("error", () => {
      close();
      failed();
    });
    return socket.address().port;
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * hand 侧：经 UDP 转发等到 brain 应答后才可连 TCP 转发。
 * v2.6.4 的 TCP 转发在本机路由表还没有目的虚拟 IP 时，会用系统网络直接连这个地址
 * （gateway/socks5.rs 的 Socks5AutoConnector）；UDP 转发只经虚拟网络发送，没有这条回落。
 * 收到应答说明对端路由已就绪且直连数据通路可用。
 */
export async function probeBrain(forwardPort: number, network: DirectNetwork, signal: AbortSignal): Promise<void> {
  const token = Buffer.from(network.name);
  const socket = createSocket("udp4");
  let timer: NodeJS.Timeout | undefined;
  try {
    socket.bind(0, loopback);
    await once(socket, "listening", { signal });
    const messages = on(socket, "message", { signal });
    const send = () => socket.send(token, forwardPort, loopback);
    timer = setInterval(send, 500);
    send();
    for await (const [message] of messages) if (token.equals(message)) return;
  } finally {
    clearInterval(timer);
    socket.close();
  }
}

// 低层进程入口也从已校验的缓存启动；测试用同一路径加载两端的隔离配置。
export async function runEasyTier(install: Install, config: string, forwards: readonly Forward[]) {
  const { stateDir, signal } = install;
  const setup = install.setupSignal ?? signal;
  const binary = await ensureEasyTier(stateDir, { ...install, signal: setup });
  const parent = path.join(stateDir, "easytier");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const instanceDir = await mkdtemp(path.join(parent, "instance-"));
  const file = path.join(instanceDir, "config.toml");
  const startup = AbortSignal.any([setup, signal, AbortSignal.timeout(8_000)]);
  try {
    await writeFile(file, config, { mode: 0o600, flag: "wx", signal: startup });
    const rpcPort = await localTcpPort();
    startup.throwIfAborted();
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^ET_|^RUST_LOG$/i.test(key)));
    const child = spawn(binary, [
      "--config-file", file, "--disable-env-parsing", "--no-tun", "--relay-network-whitelist",
      "--rpc-portal", `${loopback}:${rpcPort}`,
      // 2.6.4 必定创建管理端口；只绑定 IPv4 回环，并给它一个无法从回环匹配的白名单。
      "--rpc-portal-whitelist", "192.0.2.1/32",
      "--console-log-level", "info", "--file-log-level", "off",
    ], { cwd: instanceDir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    const stopped = new AbortController();
    let resolveClosed!: (status: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      resolveClosed = resolve;
    });
    let force: NodeJS.Timeout | undefined;
    let closing = false;
    const cleanOnExit = () => {
      child.kill("SIGKILL");
      rmSync(instanceDir, { recursive: true, force: true });
    };
    process.on("exit", cleanOnExit);
    const stop = () => {
      if (closing || stopped.signal.aborted) return;
      closing = true;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    const closedWithCleanup = closed.finally(async () => {
      clearTimeout(force);
      process.removeListener("exit", cleanOnExit);
      signal.removeEventListener("abort", stop);
      await rm(instanceDir, { recursive: true, force: true });
    });
    // 未等待 close 的调用方也可以单独观察 signal/closed。
    void closedWithCleanup.catch(() => {});
    child.once("close", (code, exitSignal) => {
      stopped.abort();
      resolveClosed({ code, signal: exitSignal });
    });
    child.on("error", () => { /* 由 close 归并成不含命令行或配置的错误。 */ });

    try {
      await new Promise<void>((resolve, reject) => {
        let initialized = false;
        const remaining = new Set(forwards.map((rule) => `${rule.protocol}:${rule.bindPort}`));
        const channels = [child.stdout, child.stderr];
        const pending = ["", ""];
        function onData(chunk: string, index: number) {
          const lines = (pending[index] + chunk).split("\n");
          pending[index] = lines.pop()!.slice(-4096);
          for (const text of lines) {
            // v2.6.4：ACL 和入站 proxy 已加载，才注册打洞 RPC；forward 另等对应的成功日志。
            if (text.includes("tcp hole punch server register rpc")) initialized = true;
            if (text.includes("port forward added")) {
              const matched = /local=127\.0\.0\.1:(\d+) .*proto=(TCP|UDP)/.exec(text);
              if (matched) remaining.delete(`${matched[2].toLowerCase()}:${matched[1]}`);
            }
          }
          if (initialized && !remaining.size) finish();
        }
        const handlers = channels.map((_, index) => (chunk: string) => onData(chunk, index));
        function onTimeout() { finish(new Error("EasyTier did not become ready.")); }
        function onClose() { finish(new Error("EasyTier exited before becoming ready.")); }
        function finish(error?: Error) {
          startup.removeEventListener("abort", onTimeout);
          child.removeListener("close", onClose);
          channels.forEach((stream, index) => {
            stream.removeListener("data", handlers[index]);
            stream.resume(); // 仅内部识别就绪标志。日志中可能包含 EasyTier 配置，不对外转发。
          });
          if (error) reject(error);
          else resolve();
        }
        channels.forEach((stream, index) => stream.setEncoding("utf8").on("data", handlers[index]));
        child.once("close", onClose);
        startup.addEventListener("abort", onTimeout, { once: true });
        if (startup.aborted) onTimeout();
      });
      signal.throwIfAborted();
      stopped.signal.throwIfAborted();
      await rm(file, { force: true });
      return { signal: stopped.signal, closed: closedWithCleanup, close: () => { stop(); return closedWithCleanup; } };
    } catch (error) {
      stop();
      await closedWithCleanup;
      throw error;
    }
  } catch (error) {
    await rm(instanceDir, { recursive: true, force: true });
    throw error;
  }
}

export async function startEasyTier(options: Config & Install) {
  if (!options.peers?.length && !options.listeners?.length) return undefined;
  const forwards: Forward[] = options.role === "hand" ? [
    { bindPort: await localTcpPort(), destinationPort: options.brainPort, protocol: "tcp" },
    { bindPort: await localUdpPort(), destinationPort: options.probePort, protocol: "udp" },
  ] : [];
  const instance = await runEasyTier(options, easyTierConfig(options, forwards), forwards);
  return { ...instance, forwardPort: forwards[0]?.bindPort, probeForwardPort: forwards[1]?.bindPort };
}
