import type { PaseoAgentHandle, PaseoAgentTimelineEvent } from "@getpaseo/client";
import { z } from "zod";
import { remoteAgentObject, type RemoteAgentCursor, type RemoteAgentEvent } from "../../shared/remote-agent.ts";
import { RemoteEventQueue, toRemoteJson } from "../remote-agent-stream.ts";

type Page = Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>;
export const promptPrefixKey = "remote-hand.prompt-prefix";
const promptPrefixSchema = z.object({ clientMessageId: z.string().min(1), length: z.int().positive() });

export async function fetchPage(agent: PaseoAgentHandle, options: Parameters<PaseoAgentHandle["timeline"]["refetch"]>[0]) {
  const page = await agent.timeline.refetch(options);
  if (page.error) throw new Error(page.error);
  return page;
}

function project(page: Page, prefix: z.infer<typeof promptPrefixSchema> | undefined): RemoteAgentEvent[] {
  return page.entries.map(({ item, timestamp, seqStart, seqEnd }) => ({
    type: "timeline", timestamp, revision: seqEnd,
    // 锚定提交 ID，只从这一行移除已记录的前缀。保留内容及稳定 ID 供 hand 合并增量。
    item: remoteAgentObject.parse(toRemoteJson({
      ...item, id: `${page.epoch}:${seqStart}`,
      ...(prefix && item.type === "user_message" && item.clientMessageId === prefix.clientMessageId && {
        text: item.text.slice(prefix.length),
      }),
    })),
  }));
}

type Change = "timeline" | "permissions" | "restored" | RemoteAgentEvent;

export async function* agentEvents(
  agent: PaseoAgentHandle,
  input: { cursor?: RemoteAgentCursor; history: "replay" | "skip" },
  signal: AbortSignal,
  prefixesPrompts: boolean,
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
      let prefix = promptPrefixSchema.safeParse(page.agent?.metadata?.[promptPrefixKey]).data;
      if (prefixesPrompts && (!prefix || !page.agent?.lastUserMessageAt) && page.entries.some(({ item }) => item.type === "user_message")) {
        // 0.17.3 先取 agent 快照再取行；并发的首条消息可能刚好落在两次读取之间。
        const result = await agent.refresh();
        signal.throwIfAborted();
        if (!result) throw new Error("Remote agent is no longer available.");
        prefix = promptPrefixSchema.safeParse(result.agent.metadata?.[promptPrefixKey]).data;
      }
      for (const event of project(page, prefix)) yield event;
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
