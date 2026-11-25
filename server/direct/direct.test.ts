import assert from "node:assert/strict";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { generateKeyPair, exportPublicKey, importPublicKey, importSecretKey } from "@getpaseo/relay/e2ee";
import type { EasyTierStatus } from "../../shared/settings.ts";
import { BrainService } from "../brain.ts";
import { digest, newDeviceKey } from "../identity.ts";
import { Peer } from "../protocol.ts";
import { StateStore } from "../state.ts";
import { easyTierSnapshots, ensureEasyTier, importEasyTier } from "./easytier-binary.ts";
import { EASYTIER_VERSION, easyTierArtifacts } from "./easytier-release.ts";
import {
  easyTierConfig, listenProbe, localTcpPort, newDirectNetwork, probeBrain, runEasyTier, startEasyTier,
} from "./easytier.ts";
import { SelectedPort } from "./selected-port.ts";
import { brainDirect, handDirect } from "./session.ts";
import { connectDirect, listenDirect } from "./transport.ts";

const localhost = "127.0.0.1";
const archivePath = process.env.EASYTIER_TEST_ZIP;
const packet = Buffer.from("remote-hand local probe");

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "remote-hand-direct-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function tcpEcho(t: TestContext) {
  let hits = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    hits++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("data", (data) => socket.write(data));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, localhost, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

async function bindUdp(socket: UdpSocket, port: number) {
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, localhost, () => {
      socket.removeListener("error", reject);
      resolve();
    });
  });
}

async function udpEcho(t: TestContext, port = 0) {
  let hits = 0;
  const socket = createSocket("udp4");
  await bindUdp(socket, port);
  socket.on("message", (message, remote) => {
    hits++;
    socket.send(message, remote.port, remote.address);
  });
  t.after(() => socket.close());
  return { port: socket.address().port, hits: () => hits };
}

async function udpPort() {
  const socket = createSocket("udp4");
  await bindUdp(socket, 0);
  const port = socket.address().port;
  await new Promise<void>((resolve) => socket.close(resolve));
  return port;
}

function probeTcp(port: number, timeout = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, localhost);
    const finish = (result: boolean) => { clearTimeout(timer); socket.destroy(); resolve(result); };
    const timer = setTimeout(() => finish(false), timeout);
    socket.on("error", () => finish(false));
    socket.once("connect", () => socket.write(packet));
    let received = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      received = Buffer.concat([received, data]);
      if (received.length >= packet.length) finish(received.equals(packet));
    });
    socket.once("end", () => finish(false));
  });
}

function probeUdp(port: number, timeout = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const finish = (result: boolean) => { clearTimeout(timer); socket.close(); resolve(result); };
    const timer = setTimeout(() => finish(false), timeout);
    socket.once("error", () => finish(false));
    socket.once("message", (data) => finish(data.equals(packet)));
    socket.send(packet, port, localhost);
  });
}

async function eventually<T>(action: () => Promise<T | false>, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do {
    const outcome = await action();
    if (outcome) return outcome;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(`Timed out: ${label}`);
}

test("direct subnet avoids both ends' interface ranges", () => {
  const hand = ["198.51.100.7/32", "10.0.0.5/8", "192.168.1.20/24"];
  const brain = ["198.51.100.0/25", "203.0.113.2/30"];
  const { subnet } = newDirectNetwork([...hand, ...brain]);
  assert.equal(subnet, "198.51.100.128/30");
  assert.equal(newDirectNetwork(["198.51.100.0/24"]).subnet, "203.0.113.0/30");
  assert.throws(() => newDirectNetwork(["198.51.100.0/24", "203.0.113.9/24"]), /No free EasyTier direct subnet/);
});

test("EasyTier rejects an altered archive and stays disabled with no peers", async (t) => {
  const directory = await fixture(t);
  const invalid = path.join(directory, "not-the-release.zip");
  await writeFile(invalid, "not the release");
  const signal = new AbortController().signal;
  assert.equal(await startEasyTier({ role: "hand", network: newDirectNetwork([]), brainPort: 1, probePort: 1, stateDir: directory, signal }), undefined);
  await assert.rejects(ensureEasyTier(directory, { signal, archivePath: invalid }), /archive SHA-256 verification failed/);
  await assert.rejects(importEasyTier(directory, invalid), /archive SHA-256 verification failed/);
});

function easyTierStatus(stateDir: string) {
  let latest: EasyTierStatus | undefined;
  const watching = new AbortController();
  type Context = Parameters<ReturnType<typeof easyTierSnapshots>["watch"]>[0];
  easyTierSnapshots(stateDir).watch({ signal: watching.signal, push: async (value: EasyTierStatus) => { latest = value; } } as Context);
  watching.abort();
  return latest!;
}

test("EasyTier download falls back across sources and manual import replaces a pending download", { timeout: 60_000 }, async (t) => {
  const directory = await fixture(t);
  const file = easyTierArtifacts[`${process.platform}-${process.arch}` as keyof typeof easyTierArtifacts].file;
  const server = createHttpServer((request, response) => {
    const [, kind, version, name] = request.url!.split("/");
    assert.equal(`${version}/${name}`, `v${EASYTIER_VERSION}/${file}`);
    if (kind === "stall") { response.writeHead(200, { "content-length": "1000" }); response.write("x"); return; }
    if (kind === "bad") { response.end("not the release"); return; }
    if (kind === "redirect") { response.writeHead(302, { location: `/good/${version}/${name}` }).end(); return; }
    if (kind === "good" && archivePath) { createReadStream(archivePath).pipe(response); return; }
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, localhost, resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://${localhost}:${(server.address() as AddressInfo).port}`;
  const signal = AbortSignal.timeout(50_000);

  const failed = path.join(directory, "failed");
  await assert.rejects(ensureEasyTier(failed, { signal, stallMs: 300, sources: [`${base}/stall`, `${base}/bad`, `${base}/error`] }),
    /^Error: EasyTier download failed: 127\.0\.0\.1:\d+ stalled; 127\.0\.0\.1:\d+ archive SHA-256 verification failed; 127\.0\.0\.1:\d+ HTTP 500\.$/);
  assert.equal(easyTierStatus(failed).state, "failed");
  t.diagnostic("三个源依次因停滞、摘要不符、HTTP 500 失败，错误列出每个源的原因。");
  await assert.rejects(ensureEasyTier(path.join(directory, "rejected"), { signal, sources: [`${base}/bad`, `${base}/bad`] }),
    /^Error: EasyTier archive failed verification from every source: 127\.0\.0\.1:\d+ archive SHA-256 verification failed; 127\.0\.0\.1:\d+ archive SHA-256 verification failed\.$/);
  t.diagnostic("所有源都摘要不符时报 EasyTier archive 开头的错误，自动重试判为永久失败。");
  if (!archivePath) return t.diagnostic("未设置 EASYTIER_TEST_ZIP，跳过成功回落与手动导入。");

  const fallback = path.join(directory, "fallback");
  assert.ok(await stat(await ensureEasyTier(fallback, { signal, sources: [`${base}/error`, `${base}/redirect`] })));
  assert.equal(easyTierStatus(fallback).state, "ready");
  t.diagnostic("第一个源 HTTP 500 后回落到第二个源（经 302 跳转），安装成功。");

  const imported = path.join(directory, "imported");
  const waiting = ensureEasyTier(imported, { signal, stallMs: 30_000, sources: [`${base}/stall`] });
  await eventually(async () => easyTierStatus(imported).state === "downloading", "download started");
  await importEasyTier(imported, archivePath);
  assert.ok(await stat(await waiting));
  assert.equal(easyTierStatus(imported).state, "ready");
  t.diagnostic("下载停滞时手动导入正确 ZIP，取代下载，原等待者拿到导入结果。");

  await importEasyTier(imported, path.join(directory, "moved-away.zip"));
  t.diagnostic("缓存健康时导入直接成功，不读取已不存在的 ZIP。");
  const core = path.join(imported, "easytier", `v${EASYTIER_VERSION}`, `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "easytier-core.exe" : "easytier-core");
  await writeFile(core, "corrupted");
  await assert.rejects(ensureEasyTier(imported, { signal }), /^Error: EasyTier SHA-256 verification failed\.$/);
  await importEasyTier(imported, archivePath);
  assert.ok(await stat(await ensureEasyTier(imported, { signal })));
  assert.equal(easyTierStatus(imported).state, "ready");
  t.diagnostic("缓存成员被改坏后自动安装报错；导入正确 ZIP 替换损坏缓存，之后可正常使用。");
});

test("EasyTier loopback: Noise NK, M0 device auth, bidirectional ACL block and cleanup", { timeout: 150_000 }, async (t) => {
  const directory = await fixture(t);
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const stateDir = path.join(directory, "easy");
  const install = { stateDir, archivePath, signal: lifetime.signal };
  await ensureEasyTier(stateDir, { ...install, signal: AbortSignal.timeout(120_000) });

  const store = new StateStore(path.join(directory, "brain"));
  const brain = new BrainService(store);
  const { publicKeyB64, secretKeyB64 } = store.current.endpoint;
  const key = newDeviceKey();
  const deviceId = digest(Buffer.from(key.publicKey, "base64url"));
  store.update((state) => { state.devices[deviceId] = { name: "loopback hand", lastSeenAt: new Date().toISOString() }; });
  const direct = await listenDirect(
    { publicKey: importPublicKey(publicKeyB64), secretKey: importSecretKey(secretKeyB64) },
    (peer) => brain.accept(peer), lifetime.signal,
  );
  t.after(direct.close);
  const brainTcp = await tcpEcho(t);
  const handTcp = await tcpEcho(t);
  const brainUdp = await udpEcho(t, direct.port);
  const handUdp = await udpEcho(t);

  const brainPeer = await localTcpPort();
  const handPeer = await localTcpPort();
  const toBrain = await localTcpPort();
  const toProbe = await udpPort();
  const blockBrainTcp = await localTcpPort();
  const blockHandTcp = await localTcpPort();
  const blockBrainUdp = await udpPort();
  const blockHandUdp = await udpPort();

  async function startPair(inboundAllowAll: boolean) {
    const network = newDirectNetwork([]);
    const signal = new AbortController();
    const instanceInstall = { ...install, signal: AbortSignal.any([install.signal, signal.signal]) };
    const probePort = await listenProbe(network, instanceInstall.signal);
    const run = (role: "hand" | "brain", forwards: Parameters<typeof runEasyTier>[2]) => {
      const [self, other] = role === "hand" ? [handPeer, brainPeer] : [brainPeer, handPeer];
      const config = easyTierConfig({
        network, role, brainPort: direct.port, probePort, stunServers: [],
        listeners: [`tcp://127.0.0.1:${self}`], peers: [`tcp://127.0.0.1:${other}`],
      }, forwards);
      // 仅测试用的正对照：同一拓扑、同一目标和探针，解除两端的入站默认拒绝。
      return runEasyTier(instanceInstall, inboundAllowAll ? config.replace("default_action = 2", "default_action = 1") : config, forwards);
    };
    const results = await Promise.allSettled([
      run("brain", [
        { protocol: "tcp", bindPort: blockHandTcp, destinationPort: handTcp.port },
        { protocol: "udp", bindPort: blockHandUdp, destinationPort: handUdp.port },
      ]),
      run("hand", [
        { protocol: "tcp", bindPort: toBrain, destinationPort: direct.port },
        { protocol: "udp", bindPort: toProbe, destinationPort: probePort },
        { protocol: "tcp", bindPort: blockBrainTcp, destinationPort: brainTcp.port },
        { protocol: "udp", bindPort: blockBrainUdp, destinationPort: brainUdp.port },
      ]),
    ]);
    const close = async () => {
      signal.abort();
      await Promise.all(results.flatMap((result) => result.status === "fulfilled" ? [result.value.close()] : []));
    };
    t.after(close);
    for (const result of results) if (result.status === "rejected") {
      await close();
      throw result.reason;
    }
    return { close, network };
  }

  const probes = [
    { title: "hand → brain TCP（非白名单端口）", send: () => probeTcp(blockBrainTcp), server: brainTcp },
    { title: "hand → brain UDP（与允许 TCP 同端口）", send: () => probeUdp(blockBrainUdp), server: brainUdp },
    { title: "brain → hand TCP", send: () => probeTcp(blockHandTcp), server: handTcp },
    { title: "brain → hand UDP", send: () => probeUdp(blockHandUdp), server: handUdp },
  ];
  const control = await startPair(true);
  try {
    await probeBrain(toProbe, control.network, AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]));
    await Promise.all(probes.map(async ({ title, send, server }) => {
      await eventually(send, `positive control ${title}`);
      assert.ok(server.hits() > 0, title);
    }));
    t.diagnostic("正对照：关闭入站 ACL 后，两方向 TCP 和 UDP 的假服务均收到并应答。");
  } finally {
    await control.close();
  }
  const protectedPair = await startPair(false);
  // 与 hand 会话相同：先等 UDP 探测应答，再连 TCP 转发，避免 EasyTier 回落到系统网络。
  await probeBrain(toProbe, protectedPair.network, AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]));
  const activePeer = await eventually(async () => {
    const attempt = new AbortController();
    const timer = setTimeout(() => attempt.abort(), 1500);
    try {
      return await connectDirect(toBrain, { publicKeyB64, key }, AbortSignal.any([attempt.signal, lifetime.signal]));
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }, "protected EasyTier transport and device authentication");
  t.after(() => activePeer.close());
  assert.ok(activePeer.port, "auth.resume activates hand application frames on direct");
  const preview = await activePeer.request("describe") as { brainName?: string };
  assert.ok(preview.brainName);
  assert.equal(await activePeer.request("ping", "x".repeat(96 * 1024)), null);
  t.diagnostic("允许路径：hand → brain 指定 TCP 入口完成 Noise NK + M0 auth.resume；describe 双向往返，96 KiB ping 成功。");

  const hits = probes.map(({ server }) => server.hits());
  const replies = await Promise.all(probes.map(({ send }) => send()));
  for (const [index, { title, server }] of probes.entries()) {
    assert.equal(replies[index], false, title);
    assert.equal(server.hits(), hits[index], title);
    t.diagnostic(`ACL 拒绝：${title}；目标服务新增命中 0。`);
  }

  await assert.rejects(connectDirect(direct.port, { publicKeyB64, key: newDeviceKey() }, AbortSignal.timeout(3_000)), { code: "revoked" });
  await assert.rejects(connectDirect(toBrain, {
    publicKeyB64: exportPublicKey(generateKeyPair().publicKey), key,
  }, AbortSignal.timeout(3_000)));
  brain.revoke(deviceId);
  assert.equal((await activePeer.closed).code, "revoked");
  await assert.rejects(connectDirect(toBrain, { publicKeyB64, key }, AbortSignal.timeout(3_000)), { code: "revoked" });
  t.diagnostic("认证拒绝：本机直接连 loopback 的未登记设备、错误 Noise 公钥、撤销后重连均失败；在线连接收到 revoked。");
  await protectedPair.close();
  assert.ok((await readdir(path.join(stateDir, "easytier"))).every((name) => !name.startsWith("instance-")));
  t.diagnostic("清理：两个子进程已退出，实例目录已删除。");
});

test("直连掉线后按退避自动恢复；对端关闭直连不重试；立即重试跳过等待；撤销清掉重试计时器", { timeout: 240_000 }, async (t) => {
  const directory = await fixture(t);
  const stateDir = path.join(directory, "easy");
  await ensureEasyTier(stateDir, { archivePath, signal: AbortSignal.timeout(120_000) });
  const store = new StateStore(path.join(directory, "brain"));
  const brain = new BrainService(store);
  const { publicKeyB64, secretKeyB64 } = store.current.endpoint;
  const key = newDeviceKey();
  const deviceId = digest(Buffer.from(key.publicKey, "base64url"));
  store.update((state) => { state.devices[deviceId] = { name: "retry hand", lastSeenAt: new Date().toISOString() }; });

  // relay 用内存中的一对 Peer 代替；EasyTier 两端直接互连，不经会合节点和 STUN。
  const transfer = (other: () => Peer) => async (text: string) => { queueMicrotask(() => other().receive(text)); };
  const relayHand: Peer = new Peer(transfer(() => relayBrain), () => queueMicrotask(() => relayBrain.close()));
  const relayBrain: Peer = new Peer(transfer(() => relayHand), () => queueMicrotask(() => relayHand.close()));
  relayHand.start();
  relayBrain.start();
  t.after(() => relayHand.close());
  await Promise.all([relayHand.ready, relayBrain.ready]);
  relayHand.activate("hand");
  relayBrain.activate("brain");
  const [brainListen, handListen] = [await localTcpPort(), await localTcpPort()];
  let brainSettings = { enabled: true, peers: [`tcp://127.0.0.1:${handListen}`] };
  let link: Peer | undefined;
  const brainChanged = brainDirect({
    relay: relayBrain, route: new SelectedPort(relayBrain.port!), settings: () => brainSettings, stateDir,
    keys: { publicKey: importPublicKey(publicKeyB64), secretKey: importSecretKey(secretKeyB64) },
    accept: (candidate, signal, ready) => brain.accept(candidate, {
      deviceId, signal, ready: (peer) => { link = peer; return ready(peer); },
    }),
    status: () => {},
    topology: { listeners: [`tcp://127.0.0.1:${brainListen}`], stunServers: [] },
  });

  type State = { transport: "direct" | "relay"; error?: string; retryAt?: number; at: number };
  let latest: State = { transport: "relay", at: Date.now() };
  const longest = 60_000;
  const hand = handDirect({
    relay: relayHand, route: new SelectedPort(relayHand.port!), brain: { publicKeyB64, key }, stateDir,
    settings: () => ({ enabled: true, peers: [`tcp://127.0.0.1:${brainListen}`] }),
    status: (transport, error, retryAt) => { latest = { transport, error, retryAt, at: Date.now() }; },
    delays: [300, longest],
    topology: { listeners: [`tcp://127.0.0.1:${handListen}`], stunServers: [] },
  });
  const reach = (label: string, check: (state: State) => boolean, timeout = 45_000) =>
    eventually(async () => check(latest) && latest, label, timeout);
  const drop = async (label: string) => {
    link!.close();
    const state = await reach(`${label} 回落 relay 并排定重试`, ({ transport, retryAt }) => transport === "relay" && !!retryAt);
    return state.retryAt! - state.at;
  };

  await reach("首次建立直连", ({ transport }) => transport === "direct");
  for (const label of ["第 1 次掉线", "第 2 次掉线"]) {
    const wait = await drop(label);
    assert.ok(wait >= 240 && wait <= 360, `${label}从退避起点开始：${wait}ms`);
    await reach(`${label}后自动恢复`, ({ transport }) => transport === "direct");
  }
  t.diagnostic("掉线：回落 relay，约 300ms（含抖动）后自动重新协商并恢复直连。");

  const flapping = await drop("10 分钟内第 3 次掉线");
  assert.ok(flapping >= longest * 0.8, `频繁掉线直接用最长间隔：${flapping}ms`);
  const asked = Date.now();
  hand.retryNow();
  await reach("立即重试后恢复", ({ transport }) => transport === "direct");
  assert.ok(Date.now() - asked < flapping, "立即重试不等原定的重试时间");
  t.diagnostic(`频繁掉线：下次重试排在 ${flapping}ms 后；立即重试 ${Date.now() - asked}ms 内恢复直连。`);

  brainSettings = { ...brainSettings, enabled: false };
  brainChanged();
  const stopped = await reach("对端关闭直连后停在原因上",
    ({ transport, error, retryAt }) => transport === "relay" && /off on the remote machine/.test(error ?? "") && retryAt === undefined);
  hand.retryNow();
  await delay(1_500);
  assert.equal(latest, stopped, "永久性失败不自动重试，立即重试也不发起协商");
  t.diagnostic(`永久性失败：${stopped.error}`);

  brainSettings = { ...brainSettings, enabled: true };
  brainChanged();
  await reach("对端重新启用后恢复直连", ({ transport }) => transport === "direct");
  await drop("再次掉线");
  // 等 direct.stop 等一次性请求的计时器结束，只剩重试等待的计时器。
  await delay(3_000);
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const waiting = timers();
  await relayBrain.notifyRevoked();
  assert.equal((await relayHand.closed).code, "revoked");
  await delay(100);
  assert.ok(timers() < waiting, `撤销后重试计时器已清除：${waiting} → ${timers()}`);
  const revoked = latest;
  hand.retryNow();
  await delay(500);
  assert.equal(latest, revoked, "撤销后不再协商");
  t.diagnostic("撤销：relay 关闭后重试等待结束，没有遗留计时器和新的协商。");
});
