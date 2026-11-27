import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import type { PluginHookPayload, PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { z } from "zod";
import { handTools, type HandToolResult } from "../../shared/hand-tools.ts";
import {
  remoteAgentRequests, remoteAgentStreams, remoteToolEvents,
  type RemoteAgentJson, type RemoteAgentPlatform, type RemoteAgentPort,
  type RemoteAgentRequest, type RemoteBrainCatalog,
} from "../../shared/remote-agent.ts";
import { ProtocolError } from "../frames.ts";
import { absolutePath } from "../hand-tools/paths.ts";
import { errorMessage, toRemoteJson } from "../remote-agent-stream.ts";
import { createHandMcp, handMcpName } from "./hand-mcp.ts";
import { agentEvents, fetchPage, promptPrefixKey } from "./timeline.ts";

export interface BrainAccess {
  readonly providers: readonly string[];
  readonly allowDeviceModes: boolean;
  readonly maxConcurrentPerDevice: number;
}

const ownerKey = "remote-hand.session";
const ownerSchema = z.strictObject({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  handCwd: z.string(),
  handPlatform: z.enum(["darwin", "linux", "win32"]),
  delivery: z.enum(["stdio-system", "stdio-prompt"]).optional(),
});
type Owner = z.infer<typeof ownerSchema>;
type BrainApi = Pick<PaseoApi, "agents" | "config" | "providers" | "workspaces">;

function allowsProvider(access: BrainAccess, id: string) {
  return id !== "remote-hand" && (access.providers.length === 0 || access.providers.includes(id));
}

function placement(home: string, owner: Owner) {
  const userPath = absolutePath(owner.handCwd, owner.handPlatform);
  const project = (owner.handPlatform === "win32" ? path.win32 : path.posix).basename(userPath) || "workspace";
  const slug = project.replace(/[^\p{L}\p{N}._-]/gu, "-").slice(0, 80) || "workspace";
  const hash = createHash("sha256").update(userPath).digest("hex").slice(0, 24);
  return { project, cwd: path.join(home, "plugin-data", "remote-hand", "workspaces", owner.deviceId, `${slug}-${hash}`) };
}

function projectContext(handCwd: string, platform: RemoteAgentPlatform) {
  return [
    `The project is on the user's hand computer (${platform}). The absolute project path is ${JSON.stringify(handCwd)}.`,
    "Your current working directory on the brain is an empty placeholder. It does not contain the project.",
  ].join("\n");
}

const toolInstructions = `Use only these tools from the ${handMcpName} MCP server for project file and command operations: ${Object.keys(handTools).join(", ")}. ` +
  "Match these tool names even if your provider adds a server prefix or exposes them through a tool runner. Use the hand computer's absolute paths and shell syntax. If the hand disconnects or a tool result is unknown, do not retry a write, edit or command automatically.";

async function catalog(paseo: BrainApi, access: BrainAccess): Promise<RemoteBrainCatalog> {
  const snapshot = await paseo.providers.snapshot();
  const allowed = snapshot.entries.filter((entry) =>
    allowsProvider(access, entry.provider) && entry.enabled !== false &&
    (entry.status === "ready" || entry.status === "loading"));
  const results = await Promise.allSettled(allowed.map(async (entry) => {
    // 只等白名单内的 provider。brain 与 hand 同时运行时，不能等待 remote-hand 自己完成发现。
    const [modelList, modeList] = entry.status === "ready"
      ? [entry.models, entry.modes]
      : await Promise.all([
        paseo.providers.listModels(entry.provider).then((reply) => reply.models),
        paseo.providers.listModes(entry.provider).then((reply) => reply.modes),
      ]);
    const models = (modelList ?? []).filter((model) => model.isSelectable !== false).map((m) => ({
      id: m.id, label: m.label, description: m.description, isDefault: m.isDefault,
      contextWindowMaxTokens: m.contextWindowMaxTokens,
    }));
    const modes = (modeList ?? []).map(({ id, label, description, icon, colorTier }) => ({
      id, label, description, icon, colorTier,
    }));
    // brain 配置的默认 mode。未开放 mode 选择时，设备只能看到并使用这一个。
    const defaultMode = modes.find(({ id }) => id === entry.defaultModeId)?.id;
    return {
      id: entry.provider, label: entry.label ?? entry.provider, models, defaultMode,
      modes: access.allowDeviceModes ? modes : modes.filter(({ id }) => id === defaultMode),
    };
  }));
  return { providers: results.flatMap((result) =>
    result.status === "fulfilled" && result.value.models.length ? [result.value] : []) };
}

async function promptTurn(agent: PaseoAgentHandle, input: z.infer<typeof remoteAgentRequests["agent.prompt"]["input"]>, signal: AbortSignal) {
  const head = await fetchPage(agent, { direction: "tail", limit: 1 });
  let cursor = { epoch: head.epoch, seq: head.window.maxSeq };
  signal.throwIfAborted();
  await agent.send(input.text, { messageId: input.clientMessageId, images: input.images });
  for (;;) {
    signal.throwIfAborted();
    const page = await fetchPage(agent, { direction: "after", cursor, limit: 100 });
    const row = page.entries.find(({ item }) =>
      item.type === "user_message" && item.clientMessageId === input.clientMessageId);
    if (row) return row.turnId ? { type: "turn" as const, turnId: row.turnId } : { type: "completed" as const };
    if (!page.hasNewer || !page.endCursor || page.endCursor.seq <= cursor.seq || page.reset) break;
    cursor = page.endCursor;
  }
  throw new Error("Brain accepted the prompt but could not identify its turn; do not resend automatically.");
}

function deviceOf(metadata: Record<string, unknown> | undefined) {
  return ownerSchema.safeParse(metadata?.[ownerKey]).data?.deviceId;
}

// 以宿主的 agent 状态为准，返回启动或运行中的会话：agentId → deviceId。插件重启后也不会漏算。
async function runningSessions(paseo: BrainApi) {
  const running = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await paseo.agents.list({
      filter: { statuses: ["initializing", "running"] }, page: { limit: 200, cursor },
    });
    for (const { agent } of entries) {
      const deviceId = deviceOf(agent.metadata);
      if (deviceId) running.set(agent.id, deviceId);
    }
    cursor = pageInfo.hasMore ? pageInfo.nextCursor ?? undefined : undefined;
  } while (cursor);
  return running;
}

export function createBrainAgentService({ paseoHome, cancelAgent }: {
  paseoHome: string;
  cancelAgent: (agentId: string) => Promise<void>;
}) {
  if (!path.isAbsolute(paseoHome)) throw new Error("paseoHome must be an absolute brain path.");
  const links = new Map<string, { port: RemoteAgentPort; signal: AbortSignal; close: () => void }>();
  const acceptingPrompts = new Set<string>();
  const activeTools = new Map<string, Set<AbortController>>();
  const stopping = new Set<string>();
  // 同一设备的建会话和发消息排队执行：上一个请求让会话进入运行后，下一个才计数，
  // 所以同时到达的请求不会一起越过并发上限。
  const deviceQueues = new Map<string, Promise<void>>();
  // 设备列表显示的运行中会话。由 turn 钩子增量维护：钩子是异步通知，回头查列表可能读到旧状态。
  // 设备连上时用列表整体校正一次，补上插件重启前已在运行或漏掉的事件。
  const shown = new Map<string, string>();
  const shownListeners = new Set<() => void>();

  function setShown(agentId: string, deviceId: string | undefined) {
    if (shown.get(agentId) === deviceId) return;
    if (deviceId) shown.set(agentId, deviceId);
    else shown.delete(agentId);
    for (const listener of shownListeners) listener();
  }

  async function resyncShown(api: BrainApi) {
    const running = await runningSessions(api);
    for (const agentId of shown.keys()) if (!running.has(agentId)) setShown(agentId, undefined);
    for (const [agentId, deviceId] of running) setShown(agentId, deviceId);
  }

  function queued<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    const run = (deviceQueues.get(deviceId) ?? Promise.resolve()).then(task);
    const tail = run.then(() => {}, () => {});
    deviceQueues.set(deviceId, tail);
    void tail.then(() => { if (deviceQueues.get(deviceId) === tail) deviceQueues.delete(deviceId); });
    return run;
  }

  const mcp = createHandMcp(async ({ agentId, deviceId }, name, input, signal): Promise<HandToolResult> => {
    const link = links.get(deviceId);
    if (!link || link.signal.aborted) return { text: "The hand is disconnected. Wait for it to reconnect.", isError: true };
    const cancelled = { text: "Tool execution cancelled.", isError: true };
    if (signal.aborted || stopping.has(agentId)) return cancelled;
    const stop = new AbortController();
    const calls = activeTools.get(agentId) ?? new Set<AbortController>();
    calls.add(stop);
    activeTools.set(agentId, calls);
    const callSignal = AbortSignal.any([signal, link.signal, stop.signal]);
    try {
      for await (const message of link.port.open(
        "tool.call", toRemoteJson({ agentId, name, input }), callSignal,
      )) {
        callSignal.throwIfAborted();
        const event = remoteToolEvents.parse(message);
        // 继续逐帧消费 hand 的输出；工具结果保留完整的有界正文。
        if (event.type === "result") return { text: event.text, isError: event.isError };
      }
      throw new Error("The hand ended the tool stream without returning a result.");
    } catch (error) {
      return signal.aborted || stop.signal.aborted ? cancelled : {
        text: `Tool result is unknown; do not automatically retry a write, edit or command. ${errorMessage(error)}`,
        isError: true,
      };
    } finally {
      calls.delete(stop);
      if (!calls.size) activeTools.delete(agentId);
    }
  });

  async function openHook({ request }: PluginHookPayload<"agent.open.before">): Promise<PluginSessionOpenRequest | undefined> {
    const owner = ownerSchema.safeParse(request.metadata[ownerKey]);
    if (!owner.success || request.purpose !== "interactive" || request.provider === "remote-hand") return;
    if (await realpath(placement(paseoHome, owner.data).cwd) !== await realpath(request.cwd)) return;
    const lease = await mcp.issue(request.agentId, owner.data.deviceId, owner.data.delivery ? "stdio" : "http");
    return {
      ...request,
      env: { ...request.env, ...lease.env },
      mcpServers: { ...request.mcpServers, [handMcpName]: lease.server },
    };
  }

  function attach({ deviceId, paseo, access, port }: {
    deviceId: string; paseo: BrainApi | (() => Promise<BrainApi>); access: BrainAccess; port: RemoteAgentPort;
  }) {
    ownerSchema.shape.deviceId.parse(deviceId);
    port.signal.throwIfAborted();
    links.get(deviceId)?.close();
    const lifetime = new AbortController();
    const signal = AbortSignal.any([port.signal, lifetime.signal]);
    const removers: (() => void)[] = [];
    const link = { port, signal, close };
    function close() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      port.signal.removeEventListener("abort", close);
      for (const remove of removers) remove();
      if (links.get(deviceId) === link) links.delete(deviceId);
    }
    links.set(deviceId, link);
    port.signal.addEventListener("abort", close, { once: true });

    const getPaseo = () => typeof paseo === "function" ? paseo() : paseo;
    void (async () => resyncShown(await getPaseo()))()
      .catch((error) => console.error(`Remote hand could not count running sessions: ${errorMessage(error)}`));

    async function checkConcurrency(api: BrainApi, except?: string) {
      const max = access.maxConcurrentPerDevice;
      const running = await runningSessions(api);
      if ([...running].filter(([agentId, owner]) => owner === deviceId && agentId !== except).length >= max)
        throw new ProtocolError("failure", `This device already has ${max} running session(s) on this brain, the most it allows. Wait for one to finish.`);
    }

    async function owned(agentId: string, callSignal: AbortSignal) {
      callSignal.throwIfAborted();
      const agent = (await getPaseo()).agents.ref(agentId);
      const result = await agent.refresh();
      callSignal.throwIfAborted();
      const state = result?.agent;
      const owner = ownerSchema.safeParse(state?.metadata?.[ownerKey]);
      if (!state || !owner.success || owner.data.deviceId !== deviceId) throw new Error("Remote agent is not owned by this device.");
      return { agent, state, owner: owner.data };
    }

    function handle<M extends RemoteAgentRequest>(method: M, handler: (
      input: z.output<(typeof remoteAgentRequests)[M]["input"]>, signal: AbortSignal,
    ) => Promise<z.input<(typeof remoteAgentRequests)[M]["output"]>>) {
      removers.push(port.handle(method, async (params, incoming) => {
        const callSignal = AbortSignal.any([signal, incoming]);
        callSignal.throwIfAborted();
        const schema = remoteAgentRequests[method];
        const parsed = schema.input.parse(params) as z.output<(typeof remoteAgentRequests)[M]["input"]>;
        return toRemoteJson(schema.output.parse(await handler(parsed, callSignal)));
      }));
    }

    try {
      handle("agent.catalog", async () => catalog(await getPaseo(), access));
      handle("agent.create", (input, callSignal) => queued(deviceId, async () => {
        callSignal.throwIfAborted();
        const paseo = await getPaseo();
        const provider = (await catalog(paseo, access)).providers.find(({ id }) => id === input.provider);
        if (!provider || !provider.models.some(({ id }) => id === input.model)) throw new Error("The requested provider and model are not available to this device.");
        // 目录已按 allowDeviceModes 过滤；不在其中的 mode 一律拒绝，不替设备改选。
        if (input.modeId !== undefined && !provider.modes.some(({ id }) => id === input.modeId)) {
          throw new Error(access.allowDeviceModes
            ? "The requested mode is not available on this brain."
            : "This brain only lets paired devices use its default mode.");
        }
        await checkConcurrency(paseo);
        const { config } = await paseo.config.get();
        const base = config.providers[input.provider]?.extends;
        const family = typeof base === "string" ? base : input.provider;
        // 0.17.3 的通用 ACP 不发送 system prompt；内置 Cursor 和 Copilot 也走该实现。
        // Antigravity 的专用插件不属于这一路径，它通过 ACP 扩展发送追加指令。
        const promptPrefix = family === "acp" || family === "cursor" || family === "copilot";
        // 没有默认 mode 时省略，让 provider 自己决定，例如 Grok 和 Pi。
        const modeId = input.modeId ?? provider.defaultMode;
        const owner = ownerSchema.parse({
          deviceId, handCwd: input.handCwd, handPlatform: input.handPlatform,
          ...(family !== "claude" && { delivery: promptPrefix ? "stdio-prompt" : "stdio-system" }),
        });
        const { cwd, project } = placement(paseoHome, owner);
        callSignal.throwIfAborted();
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        const workspace = await paseo.workspaces.open(cwd);
        if (workspace.name !== project) await workspace.setTitle(project);
        callSignal.throwIfAborted();
        if (!allowsProvider(access, input.provider)) throw new Error("This brain provider is no longer allowed.");
        const agent = await workspace.agents.create({
          agentId: randomUUID(), title: input.title, metadata: { [ownerKey]: owner },
          config: {
            provider: `${input.provider}/${input.model}`, modeId,
            ...(!promptPrefix && { systemPrompt: `${projectContext(input.handCwd, input.handPlatform)}\n${toolInstructions}` }),
          },
        });
        return { agentId: agent.id, modeId };
      }));
      handle("agent.prompt", async (input, callSignal) => {
        const { agentId } = input;
        const promptKey = JSON.stringify([deviceId, agentId]);
        if (acceptingPrompts.has(promptKey)) throw new Error("A prompt is already being accepted for this session.");
        acceptingPrompts.add(promptKey);
        try {
          const { agent, state, owner } = await owned(agentId, callSignal);
          if (!allowsProvider(access, state.provider)) throw new Error("This brain provider is no longer allowed.");
          return await queued(deviceId, async () => {
            // 已在运行的会话追加消息不占新名额，所以计数时排除它自己。
            await checkConcurrency(await getPaseo(), agentId);
            if (owner.delivery === "stdio-prompt" && !state.lastUserMessageAt) {
              const prefix = `${projectContext(owner.handCwd, owner.handPlatform)}\n${toolInstructions}\n\nUser request:\n`;
              // 先持久化边界，再让带前缀的消息进入时间线。只保存标识和长度，不复制用户正文。
              await agent.setMetadata({ [promptPrefixKey]: { clientMessageId: input.clientMessageId, length: prefix.length } });
              input = { ...input, text: prefix + input.text };
            }
            return promptTurn(agent, input, callSignal);
          });
        } finally {
          acceptingPrompts.delete(promptKey);
        }
      });
      handle("agent.cancel", async ({ agentId }, callSignal) => {
        await owned(agentId, callSignal);
        // 0.17.3 停止 Claude 时未必取消已经发出的 MCP 工具请求。
        stopping.add(agentId);
        try {
          for (const tool of activeTools.get(agentId) ?? []) tool.abort();
          await cancelAgent(agentId);
          return {};
        } finally {
          stopping.delete(agentId);
        }
      });
      handle("agent.permission", async ({ agentId, permissionId, response }, callSignal) => {
        const { agent } = await owned(agentId, callSignal);
        await agent.respondToPermission({ requestId: permissionId, response });
        return {};
      });
      removers.push(port.handle("agent.events", async function* (params, incoming): AsyncGenerator<RemoteAgentJson> {
        const input = remoteAgentStreams["agent.events"].input.parse(params);
        const callSignal = AbortSignal.any([signal, incoming]);
        const { agent, owner } = await owned(input.agentId, callSignal);
        for await (const event of agentEvents(agent, input, callSignal, owner.delivery === "stdio-prompt")) {
          yield toRemoteJson(remoteAgentStreams["agent.events"].event.parse(toRemoteJson(event)));
        }
      }));
      return close;
    } catch (error) {
      close();
      throw error;
    }
  }

  return {
    attach,
    close: mcp.close,
    activeSessions(deviceId: string) {
      return [...shown.values()].filter((owner) => owner === deviceId).length;
    },
    onActiveSessionsChange(listener: () => void) {
      shownListeners.add(listener);
      return () => { shownListeners.delete(listener); };
    },
    registerHook(server: Pick<PluginServerContext, "addHook">) {
      const removers = [
        server.addHook("agent.open.before", openHook),
        server.addHook("agent.close.after", async ({ agent }) => { mcp.revoke(agent.id); setShown(agent.id, undefined); }),
        server.addHook("agent.turn.before", async ({ agent }) => { setShown(agent.id, deviceOf(agent.metadata)); }),
        server.addHook("agent.turn.after", async ({ agent }) => { setShown(agent.id, undefined); }),
        server.addHook("agent.archive.after", async ({ agent }) => { setShown(agent.id, undefined); }),
      ];
      return () => { for (const remove of removers) remove(); };
    },
  };
}
