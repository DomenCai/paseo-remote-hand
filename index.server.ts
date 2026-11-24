import { execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { createHostClient, parseHostTarget } from "@getpaseo/client/node";
import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { bridge, decode, encode, OPEN, RST, WINDOW, type Send } from "./server/pipe";

const id = "remote-hand";
const base = "/tmp/remote-hand-poc2";
const bytes = z.instanceof(Uint8Array);
const serverId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const publicKey = z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/);
const round = z.object({ session: z.uuid(), generation: z.uuid() });
type Round = z.infer<typeof round>;
const begin = defineRpc({
  name: "begin", input: z.object({ session: z.uuid(), handServerId: serverId }),
  output: round.extend({ clientPublicKey: publicKey }),
});
const stream = defineSubscription({ name: "stream", input: round, event: bytes });
const activate = defineRpc({
  name: "activate", input: round.extend({ hostPublicKey: publicKey }), output: z.boolean(),
});
const heartbeat = defineRpc({ name: "heartbeat", input: round, output: z.boolean() });
const frameRpc = defineRpc({ name: "frame", input: bytes, output: z.boolean() });
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const log = (event: string, fields: object = {}) => console.log(JSON.stringify({ event, ...fields }));
type Pipe = ReturnType<typeof bridge>;

const handConfig = z.object({
  pairing: z.string(), handServerId: serverId, workerPath: z.string().refine(isAbsolute),
});

function readHandConfig() {
  let fd: number;
  try {
    fd = openSync(`/tmp/paseo-remote-hand-${process.getuid!()}/hand.json`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600)
      throw new Error("Invalid hand config permissions");
    const parsed = handConfig.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    if (!parsed.success) throw new Error("Invalid hand config");
    return parsed.data;
  } finally {
    closeSync(fd);
  }
}

function privateDir(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700)
    throw new Error("Invalid private directory permissions");
  return path;
}

function atomicWrite(path: string, contents: string) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, contents, { flag: "wx", mode: 0o600 });
  try {
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const wireToken = (generation: string) => Buffer.from(generation.replaceAll("-", ""), "hex");

function brain(server: PluginServerContext) {
  const root = privateDir(join(privateDir(base), "ssh"));
  type Session = Round & {
    token: Buffer;
    sockets: Map<number, Pipe>;
    dir: string;
    keys: string;
    timer: ReturnType<typeof setTimeout>;
    push?: Send;
    listener?: ReturnType<typeof createServer>;
    config?: string;
  };
  let current: Session | undefined;

  function stop(s: Session, reason: string) {
    if (current !== s) return;
    current = undefined;
    clearTimeout(s.timer);
    s.listener?.close();
    for (const pipe of s.sockets.values()) pipe.stop(reason);
    if (s.config) rmSync(s.config, { force: true });
    rmSync(s.keys, { recursive: true, force: true });
    log("brain-session-closed", { reason });
  }

  function expect(input: Round) {
    if (!current || current.session !== input.session || current.generation !== input.generation)
      throw new Error("Inactive relay generation");
    return current;
  }

  server.handle(begin, ({ session, handServerId }) => {
    if (current) stop(current, "generation-replaced");
    const generation = randomUUID();
    const dir = privateDir(join(root, handServerId));
    const staging = mkdtempSync(join(dir, ".keys-"));
    const keys = join(dir, generation);
    try {
      execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f",
        join(staging, "identity")], { stdio: "ignore" });
      // 密钥写完才发布整组文件；配置稍后以原子 rename 切到这组密钥。
      const clientPublicKey = publicKey.parse(readFileSync(join(staging, "identity.pub"), "utf8").trim());
      renameSync(staging, keys);
      const timer = setTimeout(() => stop(s, "handshake-timeout"), 25000);
      const s = current = { session, generation, token: wireToken(generation), dir, keys,
        sockets: new Map(), timer };
      return { session, generation, clientPublicKey };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  server.handle(stream, (input, { push, signal }) => {
    const s = expect(input);
    if (s.push) throw new Error("Relay subscription already exists");
    s.push = push;
    signal.addEventListener("abort", () => stop(s, "subscription-ended"), { once: true });
    if (signal.aborted) stop(s, "subscription-ended");
  });

  function renew(s: Session) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => stop(s, "heartbeat-timeout"), 15000);
  }

  server.handle(heartbeat, (input) => {
    const s = expect(input);
    if (!s.listener) throw new Error("Relay listener not active");
    renew(s);
    return true;
  });

  server.handle(activate, async (input) => {
    const s = expect(input);
    const send = s.push;
    if (!send || s.listener) throw new Error("Expected one ready relay subscription");
    let nextId = 0;
    const failed = () => stop(s, "subscription-send-error");
    const listener = s.listener = createServer({ allowHalfOpen: true }, (socket) => {
      if (current !== s || s.sockets.size >= 128 || nextId === 0xffffffff) return socket.destroy();
      socket.setNoDelay(true);
      const streamId = ++nextId;
      const pipe = bridge(socket, streamId, s.token, send,
        () => s.sockets.delete(streamId), failed, log);
      s.sockets.set(streamId, pipe);
      // OPEN 必须先于这条流的 DATA。
      void send(encode(s.token, streamId, 0, OPEN)).then(pipe.start, failed);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
      if (current !== s) throw new Error("Relay generation ended during listen");
      const port = (listener.address() as { port: number }).port;
      atomicWrite(join(s.keys, "known_hosts"), `mac-local ${input.hostPublicKey}\n`);
      const config = join(s.dir, "ssh_config");
      atomicWrite(config, `Host mac-local
  HostName 127.0.0.1
  Port ${port}
  User device
  IdentityFile ${join(s.keys, "identity")}
  IdentitiesOnly yes
  IdentityAgent none
  HostKeyAlias mac-local
  UserKnownHostsFile ${join(s.keys, "known_hosts")}
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
  BatchMode yes
  RequestTTY no
  ForwardAgent no
  ServerAliveInterval 10
  ServerAliveCountMax 2
`);
      s.config = config;
      renew(s);
      log("brain-listening", { address: "127.0.0.1", port, config, window: WINDOW });
      return true;
    } catch (error) {
      stop(s, "activation-failed");
      throw error;
    }
  });

  server.handle(frameRpc, (input) => {
    const s = current;
    if (!s?.config) throw new Error("Inactive relay generation");
    const frame = decode(s.token, input);
    if (frame.flag === OPEN) throw new Error("Only brain can open a stream");
    s.sockets.get(frame.id)?.receive(frame);
    return true;
  });
  return () => { if (current) stop(current, "brain-stopped"); };
}

function hand({ pairing, handServerId, workerPath }: z.infer<typeof handConfig>) {
  const target = parseHostTarget(pairing);
  if (target.kind !== "socket" || !target.offer || !target.url.startsWith("wss:") ||
      !pairing.startsWith("relay://"))
    throw new Error("Expected a TLS relay pairing URI");
  const uri = new URL(pairing);
  uri.searchParams.set("security", "protected");
  const relay = new URL(target.url).origin;
  const client = createHostClient(uri.href, {
    clientId: `remote-hand-${randomUUID()}`, clientType: "cli", logger: quiet,
    connectTimeoutMs: 10000, reconnect: { enabled: false },
    webSocketAgent(url) {
      if (new URL(url).origin !== relay) throw new Error("Unexpected relay origin");
      return undefined;
    },
  });
  const stopped = new AbortController();
  const sockets = new Map<number, Pipe>();
  let worker: ReturnType<typeof fork> | undefined;
  let dir: string | undefined;
  let lease: ReturnType<typeof setTimeout> | undefined;
  let stage = "connect";
  const release = client.subscribeConnectionStatus(({ status }) => {
    if (status === "disconnected" || status === "disposed") stop("relay-disconnected");
  });

  function stop(reason: string) {
    if (stopped.signal.aborted) return;
    stopped.abort();
    clearTimeout(lease);
    release();
    for (const pipe of sockets.values()) pipe.stop(reason);
    if (worker?.connected) worker.disconnect();
    if (dir) rmSync(dir, { recursive: true, force: true });
    void client.close().catch(() => {});
    log("hand-session-closed", { reason, stage });
  }

  const invoke = (method: string, input: unknown) => client.invokePluginRpc(id, method, input);
  const send: Send = async (frame) => {
    if (stopped.signal.aborted || !client.isConnected) throw new Error("Relay disconnected");
    return invoke(frameRpc.name, frame);
  };

  async function start() {
    await client.connect();
    stopped.signal.throwIfAborted();
    const info = client.getLastServerInfoMessage();
    if (!info || info.serverId !== target.offer!.serverId || !info.permissions?.includes("daemon.manage"))
      throw new Error("Unexpected relay peer or permission");
    log("relay-connected", { relay, security: "protected", daemonVersion: info.version });
    stage = "begin";
    const session = randomUUID();
    const reply = begin.output.parse(await invoke(begin.name, { session, handServerId }));
    if (reply.session !== session) throw new Error("Unexpected relay session");
    stopped.signal.throwIfAborted();
    const binding = { session, generation: reply.generation };
    const token = wireToken(binding.generation);

    stage = "worker";
    dir = mkdtempSync(join(privateDir(base), "w-"));
    const socketPath = join(dir, "ssh.sock");
    const child = worker = fork(workerPath, [], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const hostPublicKey = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSH worker startup timeout")), 15000);
      const failed = () => {
        clearTimeout(timer);
        reject(new Error("SSH worker stopped"));
        stop("worker-stopped");
      };
      child.on("error", failed);
      child.once("exit", failed);
      child.once("disconnect", failed);
      child.on("message", (msg: { type?: string; hostPublicKey?: string; message?: string }) => {
        if (msg.type !== "ready" && msg.type !== "failed") return;
        clearTimeout(timer);
        if (msg.type === "failed") {
          log("worker-failed", { message: msg.message?.replace(/\b(?:https?|wss?|relay):\/\/[^\s]+/g, "<url>") });
          return failed();
        }
        const parsed = publicKey.safeParse(msg.hostPublicKey);
        if (parsed.success) resolve(parsed.data);
        else failed();
      });
      child.send({ type: "start", socketPath, clientPublicKey: reply.clientPublicKey }, (error) => {
        if (error) failed();
      });
    });
    stopped.signal.throwIfAborted();

    stage = "subscribe";
    let lastId = 0;
    const sub = client.observePluginRpc(id, stream.name, binding, { signal: stopped.signal });
    sub.subscribe({
      snapshot() {},
      update() { stop("unexpected-subscription-event"); },
      error() { stop("subscription-error"); },
      binary(input) {
        if (stopped.signal.aborted) return;
        try {
          const frame = decode(token, input);
          if (frame.flag === OPEN) {
            if (frame.id <= lastId) return stop("invalid-stream-id");
            lastId = frame.id;
            if (sockets.size >= 128) {
              void send(encode(token, frame.id, 0, RST)).catch(() => stop("frame-send-error"));
              return;
            }
            const socket = createConnection({ path: socketPath, allowHalfOpen: true });
            const pipe = bridge(socket, frame.id, token, send,
              () => sockets.delete(frame.id), () => stop("frame-send-error"), log);
            sockets.set(frame.id, pipe);
            socket.once("connect", pipe.start);
          } else {
            sockets.get(frame.id)?.receive(frame);
          }
        } catch {
          stop("invalid-subscription-frame");
        }
      },
    });
    await sub.ready;
    stopped.signal.throwIfAborted();
    stage = "activate";
    if (await invoke(activate.name, { ...binding, hostPublicKey }) !== true)
      throw new Error("Relay activation rejected");
    stopped.signal.throwIfAborted();
    stage = "ready";
    log("hand-ready", { pid: process.pid, worker: child.pid, window: WINDOW });

    function beat() {
      if (stopped.signal.aborted) return;
      lease = setTimeout(() => {
        void invoke(heartbeat.name, binding).then(beat, () => stop("heartbeat-error"));
      }, 5000);
    }
    beat();
  }

  void start().catch((error) => {
    if (!stopped.signal.aborted) {
      const message = error instanceof Error ? error.message : "";
      // 只输出已知的本地错误；配对 URI 和 RPC 数据不得进日志。
      log("hand-start-failed", { stage, detail: message.startsWith("Unexpected") ? message : undefined });
      stop("startup-error");
    }
  });
  return () => stop("hand-stopped");
}

export default function contribute(server: PluginServerContext) {
  const config = readHandConfig();
  log("plugin-loaded", { pid: process.pid, role: config ? "hand" : "brain" });
  return config ? hand(config) : brain(server);
}
