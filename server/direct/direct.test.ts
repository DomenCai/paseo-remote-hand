import assert from "node:assert/strict";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { generateKeyPair, exportPublicKey, importPublicKey, importSecretKey } from "@getpaseo/relay/e2ee";
import { BrainService } from "../brain.ts";
import { digest, newDeviceKey } from "../identity.ts";
import { StateStore } from "../state.ts";
import { ensureEasyTier } from "./easytier-binary.ts";
import { easyTierConfig, localTcpPort, newDirectNetwork, runEasyTier, startEasyTier } from "./easytier.ts";
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

test("EasyTier rejects an altered archive and stays disabled with no peers", async (t) => {
  const directory = await fixture(t);
  const invalid = path.join(directory, "not-the-release.zip");
  await writeFile(invalid, "not the release");
  const signal = new AbortController().signal;
  assert.equal(await startEasyTier({ role: "hand", network: newDirectNetwork(), brainPort: 1, stateDir: directory, signal }), undefined);
  await assert.rejects(ensureEasyTier(directory, { signal, archivePath: invalid }), /archive SHA-256 verification failed/);
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
  const blockBrainTcp = await localTcpPort();
  const blockHandTcp = await localTcpPort();
  const blockBrainUdp = await udpPort();
  const blockHandUdp = await udpPort();

  async function startPair(inboundAllowAll: boolean) {
    const network = newDirectNetwork();
    const signal = new AbortController();
    const instanceInstall = { ...install, signal: AbortSignal.any([install.signal, signal.signal]) };
    const render = (role: "hand" | "brain", forwards: Parameters<typeof easyTierConfig>[1]) => {
      const [self, other] = role === "hand" ? [handPeer, brainPeer] : [brainPeer, handPeer];
      const config = easyTierConfig({
        network, role, brainPort: direct.port, stunServers: [],
        listeners: [`tcp://127.0.0.1:${self}`], peers: [`tcp://127.0.0.1:${other}`],
      }, forwards);
      // 仅测试用的正对照：同一拓扑、同一目标和探针，解除两端的入站默认拒绝。
      return inboundAllowAll ? config.replace("default_action = 2", "default_action = 1") : config;
    };
    const results = await Promise.allSettled([
      runEasyTier(instanceInstall, render("brain", [
        { protocol: "tcp", bindPort: blockHandTcp, destinationPort: handTcp.port },
        { protocol: "udp", bindPort: blockHandUdp, destinationPort: handUdp.port },
      ]), [blockHandTcp, blockHandUdp]),
      runEasyTier(instanceInstall, render("hand", [
        { protocol: "tcp", bindPort: toBrain, destinationPort: direct.port },
        { protocol: "tcp", bindPort: blockBrainTcp, destinationPort: brainTcp.port },
        { protocol: "udp", bindPort: blockBrainUdp, destinationPort: brainUdp.port },
      ]), [toBrain, blockBrainTcp, blockBrainUdp]),
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
    return { close };
  }

  const probes = [
    { title: "hand → brain TCP（非白名单端口）", send: () => probeTcp(blockBrainTcp), server: brainTcp },
    { title: "hand → brain UDP（与允许 TCP 同端口）", send: () => probeUdp(blockBrainUdp), server: brainUdp },
    { title: "brain → hand TCP", send: () => probeTcp(blockHandTcp), server: handTcp },
    { title: "brain → hand UDP", send: () => probeUdp(blockHandUdp), server: handUdp },
  ];
  const control = await startPair(true);
  try {
    await Promise.all(probes.map(async ({ title, send, server }) => {
      await eventually(send, `positive control ${title}`);
      assert.ok(server.hits() > 0, title);
    }));
    t.diagnostic("正对照：关闭入站 ACL 后，两方向 TCP 和 UDP 的假服务均收到并应答。");
  } finally {
    await control.close();
  }
  const protectedPair = await startPair(false);
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
