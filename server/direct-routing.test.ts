import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DirectLinkLost, SelectedPort } from "./direct/selected-port.ts";
import { Peer } from "./protocol.ts";
import type { Json } from "./frames.ts";

function pair() {
  const transfer = (other: () => Peer) => async (text: string) => {
    queueMicrotask(() => other().receive(text));
  };
  const hand: Peer = new Peer(transfer(() => brain), () => queueMicrotask(() => brain.close()));
  const brain: Peer = new Peer(transfer(() => hand), () => queueMicrotask(() => hand.close()));
  hand.start();
  brain.start();
  return { hand, brain };
}

test("直连切换保留在途 relay 请求和流；断线不重放，新操作回到 relay", async (t) => {
  const relay = pair();
  const direct = pair();
  t.after(() => { direct.hand.close(); relay.hand.close(); });
  await Promise.all([relay.hand.ready, relay.brain.ready, direct.hand.ready, direct.brain.ready]);
  for (const link of [relay, direct]) {
    link.hand.activate("hand");
    link.brain.activate("brain");
  }
  const hand = new SelectedPort(relay.hand.port!);
  const brain = new SelectedPort(relay.brain.port!);
  const calls: Json[] = [];
  let markDirectStarted!: () => void;
  const directStarted = new Promise<void>((resolve) => { markDirectStarted = resolve; });
  relay.brain.port!.handle("route", async () => "relay");
  direct.brain.port!.handle("route", async () => "direct");
  let releaseRelay!: () => void;
  const finishRelay = new Promise<void>((resolve) => { releaseRelay = resolve; });
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  brain.handle("check", async (input) => {
    calls.push(input);
    if (input === "original") {
      requestStarted();
      await finishRelay;
    } else if (input === "direct-in-flight") {
      markDirectStarted();
      await direct.brain.closed;
    }
    return input;
  });
  hand.handle("events", async function* (payload, signal) {
    yield payload;
    if (payload === "relay stream") {
      await finishRelay;
      signal.throwIfAborted();
      yield "original stream continues";
    } else {
      await delay(10_000, undefined, { signal });
    }
  });

  const pending = hand.request("check", "original");
  const old = brain.open("events", "relay stream")[Symbol.asyncIterator]();
  assert.deepEqual(await old.next(), { value: "relay stream", done: false });
  await started;
  hand.setDirect(direct.hand.port!);
  brain.setDirect(direct.brain.port!);
  // 等确认前不主动发新直连请求。
  assert.equal(await hand.request("route", null), "relay");
  hand.preferDirect(direct.hand.port!);
  brain.preferDirect(direct.brain.port!);
  assert.equal(await hand.request("check", "direct"), "direct");
  assert.equal(await hand.request("route", null), "direct");
  releaseRelay();
  assert.equal(await pending, "original");
  assert.deepEqual(await old.next(), { value: "original stream continues", done: false });
  await old.return?.();

  const canceled = brain.open("events", "direct stream to cancel")[Symbol.asyncIterator]();
  assert.equal((await canceled.next()).value, "direct stream to cancel");
  const nextCanceled = canceled.next();
  await canceled.return?.();
  assert.equal((await nextCanceled).done, true);

  const current = brain.open("events", "direct stream")[Symbol.asyncIterator]();
  assert.equal((await current.next()).value, "direct stream");
  const brokenStream = assert.rejects(current.next(), DirectLinkLost);
  const brokenRequest = assert.rejects(hand.request("check", "direct-in-flight"), { code: "disconnected" });
  await directStarted;
  direct.hand.close();
  await Promise.all([brokenRequest, brokenStream]);
  assert.equal(await hand.request("route", null), "relay");
  assert.equal(await hand.request("check", "after fallback"), "after fallback");
  assert.equal(calls.filter((value) => value === "direct-in-flight").length, 1);
  assert.ok(!hand.signal.aborted && !brain.signal.aborted);
});
