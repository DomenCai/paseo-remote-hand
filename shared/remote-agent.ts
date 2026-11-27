import { z } from "zod";
import { handTools } from "./hand-tools.ts";

export const remoteAgentJson = z.json();
export type RemoteAgentJson = z.infer<typeof remoteAgentJson>;
export const remoteAgentObject = z.record(z.string(), remoteAgentJson);
const id = z.string().min(1);
const providerId = id.regex(/^[^/]+$/);
const platform = z.enum(["darwin", "win32", "linux"]);
const empty = z.strictObject({});
const agent = z.strictObject({ agentId: id });
export const remoteAgentCursor = z.strictObject({ epoch: id, seq: z.number().int().nonnegative() });
export type RemoteAgentCursor = z.infer<typeof remoteAgentCursor>;

const model = z.strictObject({
  id, label: id, description: z.string().optional(), isDefault: z.boolean().optional(),
  contextWindowMaxTokens: z.number().optional(),
});
const mode = z.strictObject({
  id, label: id, description: z.string().optional(), isUnattended: z.boolean().optional(),
  icon: z.string().optional(), colorTier: z.string().optional(),
});
const catalog = z.strictObject({
  providers: z.array(z.strictObject({
    id: providerId, label: id, models: z.array(model), modes: z.array(mode), defaultMode: id.optional(),
  })),
});
// 思考档位不放进 agent.catalog：旧版 hand 按 strictObject 校验目录，多一个字段整个目录都会失败。
// 旧版 brain 没有 agent.thinking，会回 invalid，hand 据此当作没有档位。
const thinking = z.strictObject({
  providers: z.array(z.strictObject({
    id: providerId,
    models: z.array(z.strictObject({
      id,
      options: z.array(z.strictObject({ id, label: id, description: z.string().optional() })),
      defaultOptionId: id.optional(),
    })),
  })),
});
export const remoteAgentPermissionResponse = z.discriminatedUnion("behavior", [
  z.strictObject({
    behavior: z.literal("allow"), selectedActionId: id.optional(), updatedInput: remoteAgentObject.optional(),
    updatedPermissions: z.array(remoteAgentObject).optional(),
  }),
  z.strictObject({
    behavior: z.literal("deny"), selectedActionId: id.optional(), message: z.string().optional(),
    interrupt: z.boolean().optional(),
  }),
]);
const usage = z.strictObject({
  inputTokens: z.number().optional(), cachedInputTokens: z.number().optional(), outputTokens: z.number().optional(),
  totalCostUsd: z.number().optional(), contextWindowMaxTokens: z.number().optional(), contextWindowUsedTokens: z.number().optional(),
});
const error = z.strictObject({ message: z.string(), code: z.string().optional(), diagnostic: z.string().optional() });

export const remoteAgentEvents = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("timeline"), revision: z.number().int().nonnegative(), item: remoteAgentObject, timestamp: id }),
  z.strictObject({ type: z.literal("checkpoint"), cursor: remoteAgentCursor }),
  z.strictObject({
    type: z.literal("turn"), turnId: id, state: z.enum(["started", "completed", "failed", "canceled"]),
    error: error.optional(), usage: usage.optional(),
    metrics: z.array(z.strictObject({ label: z.string(), value: z.string(), tone: z.enum(["default", "ok", "warning", "danger"]).optional() })).optional(),
  }),
  z.strictObject({ type: z.literal("permissions"), requests: z.array(remoteAgentObject) }),
  z.strictObject({
    type: z.literal("ready"), activeTurnId: id.nullable(), error: error.optional(), usage: usage.optional(),
  }),
  z.strictObject({ type: z.literal("history_gap") }),
]);
export type RemoteAgentEvent = z.infer<typeof remoteAgentEvents>;
export const remoteToolEvents = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("output"), chunk: z.string() }),
  z.strictObject({
    type: z.literal("result"), text: z.string(), isError: z.boolean(), structured: remoteAgentJson.optional(),
  }),
]);

export const remoteAgentRequests = {
  "agent.catalog": { input: empty, output: catalog },
  "agent.thinking": { input: empty, output: thinking },
  "agent.create": {
    input: z.strictObject({
      // 只有用户选了档位才发送；档位只来自新版 brain 的 agent.thinking，所以不会发给旧版 brain。
      provider: providerId, model: id, modeId: id.optional(), thinkingOptionId: id.optional(), handCwd: id.max(32767),
      handPlatform: platform, title: z.string().optional(),
    }),
    output: agent.extend({ modeId: id.optional() }),
  },
  "agent.prompt": {
    input: agent.extend({
      clientMessageId: id, text: z.string(), images: z.array(z.strictObject({ data: id, mimeType: id })).optional(),
    }),
    output: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("turn"), turnId: id }),
      z.strictObject({ type: z.literal("completed") }),
    ]),
  },
  "agent.cancel": { input: agent, output: empty },
  "agent.permission": { input: agent.extend({ permissionId: id, response: remoteAgentPermissionResponse }), output: empty },
} as const;
export const remoteAgentStreams = {
  "agent.events": {
    input: agent.extend({ cursor: remoteAgentCursor.optional(), history: z.enum(["replay", "skip"]) }),
    event: remoteAgentEvents,
  },
  "tool.call": { input: agent.extend({ name: z.enum(Object.keys(handTools) as (keyof typeof handTools)[]), input: remoteAgentObject }), event: remoteToolEvents },
} as const;
export type RemoteAgentRequest = keyof typeof remoteAgentRequests;
export type RemoteAgentStream = keyof typeof remoteAgentStreams;
export type RemoteAgentPlatform = z.infer<typeof platform>;
export type RemoteBrainCatalog = z.infer<typeof catalog>;
export type RemoteBrainThinking = z.infer<typeof thinking>;

// 一个端口只代表一次已认证连接。关闭端口或调用方取消时，request/open 须及时拒绝，
// 并取消对端 handler 的 signal；提前释放迭代器也取消远端流。
// 断线后不得重试请求或流，由应用决定是否重新发起。
export interface RemoteAgentPort {
  readonly signal: AbortSignal;
  request(method: RemoteAgentRequest, params: RemoteAgentJson, signal?: AbortSignal): Promise<RemoteAgentJson>;
  open(method: RemoteAgentStream, params: RemoteAgentJson, signal?: AbortSignal): AsyncIterable<RemoteAgentJson>;
  handle(
    method: RemoteAgentRequest | RemoteAgentStream,
    handler: (params: RemoteAgentJson, signal: AbortSignal) => Promise<RemoteAgentJson> | AsyncIterable<RemoteAgentJson>,
  ): () => void;
}
