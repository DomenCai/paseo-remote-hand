import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { z } from "zod";
import { ensureEasyTier } from "./easytier-binary.ts";

const loopback = "127.0.0.1";
export const directIp = { brain: "198.18.0.1", hand: "198.18.0.2" } as const;
export const DirectNetworkSchema = z.strictObject({
  name: z.string().regex(/^rh-[A-Za-z0-9_-]{22}$/),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type DirectNetwork = z.infer<typeof DirectNetworkSchema>;
export function newDirectNetwork(): DirectNetwork {
  return { name: `rh-${randomBytes(16).toString("base64url")}`, secret: randomBytes(32).toString("base64url") };
}

type Forward = { bindPort: number; destinationPort: number; protocol: "tcp" | "udp" };
type Config = {
  network: DirectNetwork;
  role: "hand" | "brain";
  brainPort: number;
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
  const { name, secret } = DirectNetworkSchema.parse(input.network);
  const entry = port(input.brainPort);
  const other = directIp[input.role === "brain" ? "hand" : "brain"];
  const ready = [
    'instance_name = "remote-hand"',
    `ipv4 = "${directIp[input.role]}/24"`,
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
    ready.push(
      "", "[[acl.acl_v1.chains.rules]]",
      'name = "remote-hand-entry"',
      "enabled = true",
      "priority = 1000",
      "action = 1",
      "protocol = 1",
      `ports = ["${entry}"]`,
      `source_ips = ["${other}/32"]`,
      `destination_ips = ["${directIp.brain}/32"]`,
    );
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

// 低层进程入口也从已校验的缓存启动；测试用同一路径加载两端的隔离配置。
export async function runEasyTier(install: Install, config: string, forwards: readonly number[]) {
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
        const remaining = new Set(forwards);
        const channels = [child.stdout, child.stderr];
        const pending = ["", ""];
        function onData(chunk: string, index: number) {
          const lines = (pending[index] + chunk).split("\n");
          pending[index] = lines.pop()!.slice(-4096);
          for (const text of lines) {
            // v2.6.4：ACL 和入站 proxy 已加载，才注册打洞 RPC；forward 另等对应的成功日志。
            if (text.includes("tcp hole punch server register rpc")) initialized = true;
            if (text.includes("port forward added")) {
              const matched = /local=127\.0\.0\.1:(\d+)/.exec(text);
              if (matched) remaining.delete(Number(matched[1]));
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
  const forwardPort = options.role === "hand" ? await localTcpPort() : undefined;
  const config = easyTierConfig(options, forwardPort ? [
    { bindPort: forwardPort, destinationPort: options.brainPort, protocol: "tcp" },
  ] : []);
  const instance = await runEasyTier(options, config, forwardPort ? [forwardPort] : []);
  return { ...instance, forwardPort };
}
