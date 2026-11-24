import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Peer } from "./protocol.ts";
import { CONNECTION_WINDOW_BYTES, STREAM_CHUNK_BYTES, STREAM_WINDOW_BYTES } from "./streams.ts";

type Packet = { type: string; streamId?: string; bytes?: number; chunk?: string };

async function pair(t: TestContext, route?: (from: "brain" | "hand", frame: Packet, deliver: () => void) => void) {
  const frames: Packet[] = [];
  function send(from: "brain" | "hand", receive: () => Peer) {
    return async (text: string) => {
      const frame = JSON.parse(text) as Packet;
      frames.push(frame);
      const deliver = () => queueMicrotask(() => receive().receive(text));
      if (route) route(from, frame, deliver);
      else deliver();
    };
  }
  const left: Peer = new Peer(send("hand", () => right), () => queueMicrotask(() => right.close()));
  const right: Peer = new Peer(send("brain", () => left), () => queueMicrotask(() => left.close()));
  t.after(() => { left.close(); right.close(); });
  left.start();
  right.start();
  await Promise.all([left.ready, right.ready]);
  assert.deepEqual([left.port, right.port], [undefined, undefined]);
  left.activate("hand");
  right.activate("brain");
  assert.ok(left.port && right.port);
  return { hand: left.port, brain: right.port, left, right, frames };
}

test("流在下游拉取前不生产，信用用完后停在当前事件", { timeout: 2000 }, async (t) => {
  const { hand, brain, frames } = await pair(t);
  let produced = 0;
  const large = "👋".repeat(18_000);
  brain.handle("events", async function* () {
    produced++;
    yield large;
    produced++;
    yield "second";
  });
  const stream = hand.open("events", null)[Symbol.asyncIterator]();
  await settle();
  assert.equal(produced, 0);
  assert.deepEqual(await stream.next(), { done: false, value: large });
  await settle();
  assert.equal(produced, 1);
  const firstChunks = frames.filter(({ type }) => type === "stream.data");
  assert.equal(firstChunks.length, Math.ceil(Buffer.byteLength(JSON.stringify(large)) / STREAM_CHUNK_BYTES));
  assert.deepEqual(await stream.next(), { done: false, value: "second" });
  assert.equal(produced, 2);
  assert.equal((await stream.next()).done, true);
});

test("多个流可双向交错，暂停一条流不阻塞其他流或普通请求", { timeout: 2000 }, async (t) => {
  const { hand, brain, frames } = await pair(t);
  const event = "a".repeat(3 * STREAM_CHUNK_BYTES);
  let arrived = 0;
  let release!: () => void;
  const together = new Promise<void>((resolve) => { release = resolve; });
  brain.handle("events", async function* (value) {
    if (++arrived === 2) release();
    await together;
    yield [value, event];
    yield "later";
  });
  hand.handle("other", async function* (value) { yield value; });
  hand.handle("echo", async (value) => value);
  const slow = hand.open("events", "slow")[Symbol.asyncIterator]();
  const fast = hand.open("events", "fast")[Symbol.asyncIterator]();
  const opposite = brain.open("other", event.replace(/^a/, "b"))[Symbol.asyncIterator]();
  const values = await Promise.all([slow.next(), fast.next(), opposite.next(), brain.request("echo", { ok: true })]);
  assert.deepEqual(values.map((entry) => entry && typeof entry === "object" && "done" in entry ? entry.value : entry),
    [["slow", event], ["fast", event], "b" + event.slice(1), { ok: true }]);
  const streamIds = frames.filter(({ type }) => type === "stream.data").map(({ streamId }) => streamId);
  assert.ok(new Set(streamIds).size === 3);
  const handStreams = streamIds.filter((id) => id?.startsWith("h:"));
  assert.notEqual(handStreams[0], handStreams[1]);
  assert.deepEqual(await fast.next(), { done: false, value: "later" });
});

test("连接窗口满时多余写入等待，收到回执才继续", { timeout: 3000 }, async (t) => {
  const delayed: Array<() => void> = [];
  let withhold = true;
  const { brain, hand } = await pair(t, (from, frame, deliver) => {
    if (withhold && from === "hand" && frame.type === "stream.credit" && frame.bytes === 0) delayed.push(deliver);
    else deliver();
  });
  const event = "x".repeat(STREAM_WINDOW_BYTES - 2);
  let produced = 0;
  brain.handle("large", async function* () { produced++; yield event; });
  const streams = Array.from({ length: 6 }, () => hand.open("large", null)[Symbol.asyncIterator]());
  let received = 0;
  const pulls = streams.map(async (stream) => {
    const item = await stream.next();
    assert.equal(item.value, event);
    received++;
  });
  await settle();
  assert.equal(produced, 6);
  assert.equal(received, CONNECTION_WINDOW_BYTES / STREAM_WINDOW_BYTES);
  assert.equal(delayed.length, received);
  withhold = false;
  delayed.splice(0).forEach((deliver) => deliver());
  await Promise.all(pulls);
  assert.equal(received, 6);
});

test("释放等待中的迭代器会取消远端处理，其他流继续", { timeout: 2000 }, async (t) => {
  const { brain, hand } = await pair(t);
  let canceled!: () => void;
  const cancellation = new Promise<void>((resolve) => { canceled = resolve; });
  brain.handle("wait", async function* (_, signal) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { canceled(); resolve(); }, { once: true }));
    signal.throwIfAborted();
  });
  brain.handle("forward", async function* (value) { yield value; yield "still open"; });
  const stalled = hand.open("wait", null)[Symbol.asyncIterator]();
  const other = hand.open("forward", "ready")[Symbol.asyncIterator]();
  const pending = stalled.next();
  assert.deepEqual(await other.next(), { done: false, value: "ready" });
  await stalled.return?.();
  assert.ok((await pending).done);
  await cancellation;
  assert.deepEqual(await other.next(), { done: false, value: "still open" });
});

test("断线以错误结束每条流并取消双向处理函数", { timeout: 2000 }, async (t) => {
  const { hand, brain, left } = await pair(t);
  const aborted: AbortSignal[] = [];
  for (const port of [hand, brain]) {
    port.handle("wait", async function* (_, signal) {
      aborted.push(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted();
    });
  }
  const streams = [hand, hand, brain].map((port) => port.open("wait", null)[Symbol.asyncIterator]());
  const outcomes = Promise.all(streams.map((stream) => assert.rejects(stream.next(), { code: "disconnected" })));
  await settle();
  assert.equal(aborted.length, 3);
  left.close();
  await outcomes;
  assert.ok(hand.signal.aborted && brain.signal.aborted);
  assert.ok(aborted.every((signal) => signal.aborted));
});

test("普通请求取消会传给对端 handler，端口仍可继续调用", { timeout: 2000 }, async (t) => {
  const { hand, brain } = await pair(t);
  let running!: () => void;
  const started = new Promise<void>((resolve) => { running = resolve; });
  let canceled!: () => void;
  const stopped = new Promise<void>((resolve) => { canceled = resolve; });
  brain.handle("wait", async (_, signal) => {
    running();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { canceled(); resolve(); }, { once: true }));
    return null;
  });
  brain.handle("echo", async (value) => value);
  const stop = new AbortController();
  const failed = assert.rejects(hand.request("wait", null, stop.signal), { code: "canceled" });
  await started;
  stop.abort();
  await Promise.all([failed, stopped]);
  assert.deepEqual(await hand.request("echo", [1, "two"]), [1, "two"]);
});
