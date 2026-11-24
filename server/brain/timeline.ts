import type { PaseoAgentHandle, PaseoAgentTimelineEvent } from "@getpaseo/client";
import { remoteAgentObject, type RemoteAgentCursor, type RemoteAgentEvent } from "../../shared/remote-agent.ts";
import { RemoteEventQueue, toRemoteJson } from "../remote-agent-stream.ts";

type Page = Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>;

export async function fetchPage(agent: PaseoAgentHandle, options: Parameters<PaseoAgentHandle["timeline"]["refetch"]>[0]) {
  const page = await agent.timeline.refetch(options);
  if (page.error) throw new Error(page.error);
  return page;
}

function project(page: Page): RemoteAgentEvent[] {
  return page.entries.map((row) => ({
    type: "timeline", timestamp: row.timestamp, revision: row.seqEnd,
    // after 页可以包含跨游标合并的文本或工具生命周期。稳定 ID 让 hand 应用增量。
    item: remoteAgentObject.parse(toRemoteJson({ ...row.item, id: `${page.epoch}:${row.seqStart}` })),
  }));
}

type Change = "timeline" | "permissions" | "restored" | RemoteAgentEvent;

export async function* agentEvents(
  agent: PaseoAgentHandle,
  input: { cursor?: RemoteAgentCursor; history: "replay" | "skip" },
  signal: AbortSignal,
): AsyncGenerator<RemoteAgentEvent> {
  const queue = new RemoteEventQueue<Change>(1024);
  let cursor = input.cursor;
  let dirty = false;
  let permissionDirty = false;
  let restored = false;
  const subscription = agent.timeline.subscribe(({ event }: PaseoAgentTimelineEvent) => {
    switch (event.type) {
      case "error":
        queue.end(new Error(event.error));
        break;
      case "replacement":
      case "subscription_restored":
        if (!restored) queue.push("restored");
        restored = true;
        break;
      case "timeline":
        if (!dirty) queue.push("timeline");
        dirty = true;
        break;
      case "permission_requested":
      case "permission_resolved":
        if (!permissionDirty) queue.push("permissions");
        permissionDirty = true;
        break;
      case "turn_started":
      case "turn_completed":
      case "turn_failed":
      case "turn_canceled":
        if (!event.turnId) break;
        queue.push({
          type: "turn", turnId: event.turnId,
          state: event.type === "turn_started" ? "started" : event.type === "turn_completed" ? "completed" :
            event.type === "turn_failed" ? "failed" : "canceled",
          ...(event.type === "turn_failed" && { error: { message: event.error, code: event.code, diagnostic: event.diagnostic } }),
          ...(event.type === "turn_completed" && { usage: event.usage, metrics: event.metrics }),
        });
        break;
    }
  });

  async function* syncTimeline(): AsyncGenerator<RemoteAgentEvent> {
    let through: number | undefined;
    for (;;) {
      signal.throwIfAborted();
      const page = await fetchPage(agent, { direction: "after", cursor, limit: 100 });
      signal.throwIfAborted();
      if (page.reset && cursor) {
        yield { type: "history_gap" };
        cursor = undefined;
        through = undefined;
        continue;
      }
      through ??= page.window.maxSeq;
      for (const event of project(page)) yield event;
      const seq = page.hasNewer ? page.endCursor?.seq : page.window.maxSeq;
      if (seq === undefined || (page.hasNewer && cursor && seq <= cursor.seq)) {
        throw new Error("Brain returned a timeline page without progress.");
      }
      const next = { epoch: page.epoch, seq };
      if (cursor?.epoch !== next.epoch || cursor.seq !== next.seq) {
        cursor = next;
        yield { type: "checkpoint", cursor };
      }
      if (!page.hasNewer || seq >= through) return;
    }
  }

  async function* snapshot(ready: boolean): AsyncGenerator<RemoteAgentEvent> {
    signal.throwIfAborted();
    const result = await agent.refresh();
    if (!result) throw new Error("Remote agent is no longer available.");
    signal.throwIfAborted();
    const { agent: state } = result;
    yield { type: "permissions", requests: state.pendingPermissions.map((request) => {
      const { provider: _provider, ...rest } = request;
      return remoteAgentObject.parse(toRemoteJson(rest));
    }) };
    if (ready) {
      yield {
        type: "ready", activeTurnId: state.activeTurn?.turnId ?? null,
        ...(state.status === "error" && state.lastError && { error: { message: state.lastError } }),
        ...(state.lastUsage && { usage: state.lastUsage }),
      };
    }
  }

  signal.addEventListener("abort", subscription, { once: true });
  try {
    signal.throwIfAborted();
    await subscription.ready;
    signal.throwIfAborted();
    if (!cursor && input.history === "skip") {
      const page = await fetchPage(agent, { direction: "tail", limit: 1 });
      cursor = { epoch: page.epoch, seq: page.window.maxSeq };
      yield { type: "checkpoint", cursor };
    } else {
      yield* syncTimeline();
    }
    yield* snapshot(true);
    for await (const change of queue.read(signal)) {
      if (change === "timeline") {
        dirty = false;
        yield* syncTimeline();
      } else if (change === "permissions") {
        permissionDirty = false;
        yield* snapshot(false);
      } else if (change === "restored") {
        restored = false;
        yield* syncTimeline();
        yield* snapshot(true);
      } else {
        // 先补齐本轮输出，再宣布本轮结束；turn_started 保持在本轮输出之前。
        if (change.type === "turn" && change.state !== "started") yield* syncTimeline();
        yield change;
      }
    }
  } finally {
    signal.removeEventListener("abort", subscription);
    subscription();
    queue.end();
  }
}
