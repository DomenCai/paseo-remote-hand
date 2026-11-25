import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { directReadyMethod } from "./direct/session.ts";
import { BrainService } from "./brain.ts";
import { brainFingerprint, INVITE_TTL_MS, newDeviceKey, parsePairCode, signDevice } from "./identity.ts";
import { Peer, PROTOCOL_VERSION } from "./protocol.ts";
import { StateStore } from "./state.ts";

function loopback(brain: BrainService, peers: Peer[], version = PROTOCOL_VERSION, direct?: Parameters<BrainService["accept"]>[1]): Peer {
  const transfer = (receiver: () => Peer) => async (text: string) => {
    queueMicrotask(() => receiver().receive(text));
  };
  const hand: Peer = new Peer(transfer(() => remote), () => queueMicrotask(() => remote.close()), version);
  const remote: Peer = new Peer(transfer(() => hand), () => queueMicrotask(() => hand.close()));
  brain.accept(remote, direct);
  remote.start();
  hand.start();
  peers.push(hand, remote);
  return hand;
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "remote-hand-test-"));
  const peers: Peer[] = [];
  t.after(async () => {
    for (const peer of peers) peer.close();
    await Promise.all(peers.map((peer) => peer.closed));
    rmSync(dir, { recursive: true });
  });
  const store = new StateStore(dir);
  let now = Date.now();
  const brain = new BrainService(store, () => now);
  const connect = (version?: number, direct?: Parameters<BrainService["accept"]>[1]) => loopback(brain, peers, version, direct);
  const nonce = async (peer: Peer) => (await peer.request("auth.challenge") as { challenge: string }).challenge;
  const fingerprint = brainFingerprint(store.current.endpoint.publicKeyB64);
  const invite = () => parsePairCode(brain.invite("loopback").pairingCode).inviteSecret;
  const pair = async (peer: Peer, secret: string, key = newDeviceKey()) => {
    const description = await peer.request("describe") as { risks: { code: string }[] };
    const proof = signDevice(key, fingerprint, await nonce(peer), secret);
    const result = await peer.request("auth.pair", {
      ...proof, secret, name: "test", acknowledgedRiskCodes: description.risks.map(({ code }) => code),
    });
    return { key, deviceId: (result as { deviceId: string }).deviceId };
  };
  return { brain, connect, nonce, fingerprint, invite, pair, advance: (ms: number) => { now += ms; } };
}

test("预览不消费邀请；两个连接并发配对时只有一个能消费", async (t) => {
  const { brain, connect, invite, pair } = setup(t);
  const secret = invite();
  const preview = connect();
  await preview.request("describe");
  preview.close();
  const results = await Promise.allSettled([pair(connect(), secret), pair(connect(), secret)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const refused = results.find((result) => result.status === "rejected");
  assert.equal(refused?.reason.code, "invite");
  assert.equal(brain.devices().length, 1);
});

test("brain 拒绝已过期但签名有效的邀请", async (t) => {
  const { connect, invite, pair, advance, brain } = setup(t);
  const secret = invite();
  advance(INVITE_TTL_MS);
  await assert.rejects(pair(connect(), secret), { code: "invite" });
  assert.deepEqual(brain.devices(), []);
});

test("brain 拒绝错误签名，并销毁该连接的 challenge", async (t) => {
  const { connect, nonce, fingerprint, invite, pair } = setup(t);
  const key = newDeviceKey();
  const secret = invite();
  await pair(connect(), secret, key);
  const peer = connect();
  const challenge = await nonce(peer);
  const proof = signDevice(key, fingerprint, challenge);
  const invalid = { ...proof, signature: (proof.signature[0] === "A" ? "B" : "A") + proof.signature.slice(1) };
  await assert.rejects(peer.request("auth.resume", invalid), { code: "identity" });
  await assert.rejects(peer.request("auth.resume", proof), { code: "invalid" });
});

test("撤销立即断开该设备的所有连接，拒绝重新认证，不影响其他设备", async (t) => {
  const { brain, connect, nonce, fingerprint, invite, pair } = setup(t);
  const first = connect();
  const { key, deviceId } = await pair(first, invite());
  const second = connect();
  await second.request("auth.resume", signDevice(key, fingerprint, await nonce(second)));
  const other = connect();
  await pair(other, invite());
  brain.revoke(deviceId);
  assert.equal(brain.devices().length, 1);
  assert.equal(brain.devices()[0].online, true);
  assert.equal((await first.closed).code, "revoked");
  assert.equal((await second.closed).code, "revoked");
  assert.equal(await other.request("ping"), null);
  const reconnect = connect();
  await assert.rejects(reconnect.request("auth.resume", signDevice(key, fingerprint, await nonce(reconnect))),
    { code: "revoked" });
});

test("有效的旧 challenge 签名不能跨连接重放", async (t) => {
  const { connect, nonce, fingerprint, invite, pair } = setup(t);
  const { key } = await pair(connect(), invite());
  const first = connect();
  const proof = signDevice(key, fingerprint, await nonce(first));
  await first.request("auth.resume", proof);
  const second = connect();
  await nonce(second);
  await assert.rejects(second.request("auth.resume", proof), { code: "identity" });
});

test("版本不兼容时不开放 RPC，并报告协议版本", async (t) => {
  const { connect } = setup(t);
  const peer = connect(PROTOCOL_VERSION + 1);
  await assert.rejects(peer.request("describe"), { code: "version", message: /protocol: brain v1/ });
});

test("直连只接受协商 relay 的设备身份，不消费邀请", { timeout: 5_000 }, async (t) => {
  const { connect, nonce, fingerprint, invite, pair } = setup(t);
  const owner = await pair(connect(), invite());
  const other = await pair(connect(), invite());
  const lifetime = new AbortController();
  let promoted = 0;
  let markPromoted!: () => void;
  const promotion = new Promise<void>((resolve) => { markPromoted = resolve; });
  const connectDirect = () => connect(undefined, {
    deviceId: owner.deviceId, signal: lifetime.signal, ready: () => () => { promoted++; markPromoted(); },
  });
  const attempt = async (peer: Peer, key: typeof owner.key) =>
    peer.request("auth.resume", signDevice(key, fingerprint, await nonce(peer)));
  await assert.rejects(attempt(connectDirect(), other.key), { code: "identity" });

  const unused = invite();
  const joining = connectDirect();
  const proof = signDevice(owner.key, fingerprint, await nonce(joining), unused);
  await assert.rejects(joining.request("auth.pair", {
    ...proof, secret: unused, name: "no enrollment on direct", acknowledgedRiskCodes: [],
  }), { code: "invalid" });
  await pair(connect(), unused);

  const trusted = connectDirect();
  await assert.rejects(trusted.request(directReadyMethod), { code: "invalid" });
  assert.deepEqual(await attempt(trusted, owner.key), { deviceId: owner.deviceId });
  assert.equal(await trusted.request(directReadyMethod), null);
  await promotion;
  await assert.rejects(trusted.request(directReadyMethod), { code: "invalid" });
  assert.equal(promoted, 1);
});
