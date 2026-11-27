import { realpath, stat } from "node:fs/promises";
import type { ProviderConnection, ProviderEvent, ProviderInput, ProviderModel, ProviderMode, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import {
  remoteAgentStreams, remoteToolEvents,
  type RemoteAgentCursor, type RemoteAgentEvent, type RemoteAgentJson, type RemoteAgentPlatform, type RemoteAgentPort,
} from "../../shared/remote-agent.ts";
import { DirectLinkLost } from "../direct/selected-port.ts";
import { ProtocolError } from "../frames.ts";
import { executeHandTool } from "../hand-tools/index.ts";
import { absolutePath, sameCanonicalPath } from "../hand-tools/paths.ts";
import { errorMessage, RemoteEventQueue, remoteRequest, toRemoteJson } from "../remote-agent-stream.ts";

export interface HandBrain {
  id: string;
  name: string;
  /** 已完成认证、可以收发请求的本代端口。离线时省略。 */
  port?: RemoteAgentPort;
}

export interface HandBrainDirectory {
  listBrains(): readonly HandBrain[];
  /** 列表、设备撤销和可用连接变化时同步通知。 */
  subscribe(listener: () => void): () => void;
  readPolicy(brainId: string): Promise<{ mode: "full" } | { mode: "restricted"; projects: string[] }>;
  /** 原子、幂等地加入新会话的真实项目路径。设备已删除时拒绝。 */
  authorizeProject(brainId: string, cwd: string): Promise<void>;
}

const persistenceSchema = z.strictObject({
  brainId: z.string().min(1), agentId: z.string().min(1), cwd: z.string().min(1), model: z.string().min(1), modeId: z.string().min(1).optional(),
  thinkingOptionId: z.string().min(1).optional(),
});
type Session = z.infer<typeof persistenceSchema> & {
  id: string;
  lifetime: AbortController;
  emit: (event: ProviderEvent) => void;
  opened?: string;
  history: "replay" | "skip";
  cursor?: RemoteAgentCursor;
  source?: { port: RemoteAgentPort; lifetime: AbortController; ready: boolean };
  activeTurn?: string;
  waiting: boolean;
  endedTurns: Set<string>;
  itemRevisions: Map<string, number>;
  pendingPermissions: Set<string>;
  promptGate?: Promise<void>;
  stopRequests: Set<string>;
  stopping: boolean;
  inFlightMutations: Set<object>;
};

const brainDefaultMode = "remote-hand:brain-default";

const notices = {
  waiting: { id: "remote-hand.waiting", title: "等待本机", severity: "warning" as const },
  unknown: { id: "remote-hand.unknown", title: "执行结果未知", severity: "warning" as const, description: "连接中断时有命令或文件修改正在执行。请先核对再决定是否重试。" },
  reconnected: { id: "remote-hand.reconnected", title: "本机已重新连接", severity: "info" as const },
  stopped: { id: "remote-hand.stopped", title: "已停止", severity: "info" as const },
  stop: { id: "remote-hand.stop", title: "已请求停止", severity: "info" as const },
  history: { id: "remote-hand.history", title: "部分历史无法接续", severity: "warning" as const },
};

function parseModel(model: string | undefined) {
  const parts = model?.match(/^([^/]+)\/([^/]+)\/(.+)$/s);
  if (!parts) throw new Error("Select a remote model in <brainId>/<provider>/<model> format.");
  return { brainId: parts[1], provider: parts[2], model: parts[3] };
}

function notice(session: Session, key: keyof typeof notices, description?: string) {
  session.emit({ type: "session.notice", sessionId: session.id, notice: { ...notices[key], ...(description && { description }) } });
}

function waitForHand(session: Session, reason?: string) {
  if (!session.waiting) notice(session, "waiting", reason);
  session.waiting = true;
}

function turn(session: Session, event: Extract<RemoteAgentEvent, { type: "turn" }>) {
  if (session.endedTurns.has(event.turnId)) return;
  if (event.state === "started") {
    if (session.activeTurn === event.turnId) return;
    session.activeTurn = event.turnId;
  } else {
    if (session.activeTurn === event.turnId) session.activeTurn = undefined;
    session.endedTurns.add(event.turnId);
  }
  if (event.usage) session.emit({ type: "session.usage", sessionId: session.id, turnId: event.turnId, usage: event.usage });
  session.emit({
    type: "session.turn", sessionId: session.id, turnId: event.turnId,
    state: event.state, error: event.error, metrics: event.metrics,
  });
}

export function createHandProvider(directory: HandBrainDirectory) {
  const sessions = new Set<Session>();
  const connections = new Set<ProviderConnection>();
  const bindings = new Map<string, { port: RemoteAgentPort; remove: () => void }>();
  const lifetime = new AbortController();

  function ready(session: Session) {
    if (!session.opened) return;
    session.emit({ type: "session.ready", requestId: session.opened, sessionId: session.id });
    session.opened = undefined;
  }

  function closeSession(session: Session) {
    sessions.delete(session);
    session.lifetime.abort();
    session.source?.lifetime.abort();
    for (const requestId of session.stopRequests) {
      session.emit({ type: "request.failed", requestId, error: { message: "The hand session closed before the brain confirmed stop." } });
    }
    session.stopRequests.clear();
  }

  async function flushStops(session: Session) {
    const current = session.source;
    if (session.stopping || session.stopRequests.size === 0 || !current?.ready) return;
    session.stopping = true;
    try {
      await remoteRequest(current.port, "agent.cancel", { agentId: session.agentId }, current.lifetime.signal);
      if (current.lifetime.signal.aborted) return;
      notice(session, "stopped");
      for (const requestId of session.stopRequests) session.emit({ type: "request.completed", requestId });
      session.stopRequests.clear();
    } catch (error) {
      // 停止可在新连接上再次请求；prompt、权限应答和工具调用不会自动重放。
      if (!current.lifetime.signal.aborted && !current.port.signal.aborted) {
          for (const requestId of session.stopRequests) session.emit({ type: "request.failed", requestId, error: { message: errorMessage(error) } });
        session.stopRequests.clear();
      }
    } finally {
      session.stopping = false;
      if (session.source !== current) void flushStops(session);
    }
  }

  function receive(session: Session, event: RemoteAgentEvent) {
    const sessionId = session.id;
    switch (event.type) {
      case "timeline": {
        const { id } = event.item;
        if (typeof id !== "string") throw new Error("Remote timeline item has no identity.");
        if ((session.itemRevisions.get(id) ?? -1) >= event.revision) break;
        const mapped = ProviderEventSchema.parse({ type: "timeline.item", sessionId, item: event.item, timestamp: event.timestamp });
        session.itemRevisions.set(id, event.revision);
        session.emit(mapped);
        break;
      }
      case "checkpoint":
        session.cursor = event.cursor;
        break;
      case "history_gap":
        notice(session, "history");
        break;
      case "turn":
        turn(session, event);
        break;
      case "permissions": {
        const seen = new Set<string>();
        for (const request of event.requests) {
          const mapped = ProviderEventSchema.parse({ type: "session.permission", sessionId, request });
          if (mapped.type !== "session.permission") continue;
          const id = mapped.request.id;
          seen.add(id);
          if (!session.pendingPermissions.has(id)) session.emit(mapped);
        }
        for (const id of session.pendingPermissions) {
          if (!seen.has(id)) session.emit({ type: "session.permission_resolved", sessionId, permissionId: id });
        }
        session.pendingPermissions = seen;
        break;
      }
      case "ready": {
        if (session.activeTurn && session.activeTurn !== event.activeTurnId) {
          turn(session, { type: "turn", turnId: session.activeTurn, state: event.error ? "failed" : "completed", error: event.error, usage: event.usage });
        }
        if (event.activeTurnId) turn(session, { type: "turn", turnId: event.activeTurnId, state: "started" });
        if (session.source) session.source.ready = true;
        if (session.waiting) notice(session, "reconnected");
        session.waiting = false;
        ready(session);
        void flushStops(session);
        break;
      }
    }
  }

  function drive(session: Session) {
    const port = bindings.get(session.brainId)?.port;
    const previous = session.source;
    if (session.lifetime.signal.aborted || (port && previous?.port === port)) return;
    if (previous) {
      if (session.inFlightMutations.size) notice(session, "unknown");
      previous.lifetime.abort();
    }
    session.source = undefined;
    if (!port) {
      ready(session);
      waitForHand(session);
      return;
    }
    const source = { port, lifetime: new AbortController(), ready: false };
    session.source = source;
    const signal = AbortSignal.any([source.lifetime.signal, session.lifetime.signal, port.signal]);
    void (async () => {
      try {
        for await (const message of port.open("agent.events", toRemoteJson({
          agentId: session.agentId, cursor: session.cursor, history: session.history,
        }), signal)) {
          if (session.promptGate) await session.promptGate;
          signal.throwIfAborted();
          if (session.source !== source) return;
          receive(session, remoteAgentStreams["agent.events"].event.parse(message));
        }
        if (!signal.aborted) throw new Error("The brain closed the agent event stream.");
      } catch (error) {
        if (signal.aborted || session.source !== source) return;
        source.ready = false;
        if (error instanceof DirectLinkLost) {
          // 断开的事件流无法保留，从最后的游标新订阅；不重发 prompt 或工具。
          session.source = undefined;
          source.lifetime.abort();
          drive(session);
          return;
        }
        if (session.opened) {
          session.emit({ type: "request.failed", requestId: session.opened, error: { message: errorMessage(error) } });
          closeSession(session);
        } else {
          waitForHand(session, errorMessage(error));
        }
      }
    })();
  }

  async function* callTool(brainId: string, port: RemoteAgentPort, bound: AbortSignal, params: RemoteAgentJson, incoming: AbortSignal) {
    const { agentId, name, input } = remoteAgentStreams["tool.call"].input.parse(params);
    const session = [...sessions].find((candidate) => candidate.brainId === brainId && candidate.agentId === agentId);
    if (!session || bindings.get(brainId)?.port !== port) throw new Error("This tool call does not belong to an open hand session.");
    const released = new AbortController();
    const signal = AbortSignal.any([incoming, port.signal, bound, session.lifetime.signal, released.signal]);
    const policy = await directory.readPolicy(brainId);
    signal.throwIfAborted();
    const queue = new RemoteEventQueue<RemoteAgentJson>(65_538);
    const operation = {};
    if (name === "hand_write" || name === "hand_edit" || name === "hand_bash") session.inFlightMutations.add(operation);
    const finished = executeHandTool(name, input, {
      cwd: session.cwd, roots: policy.mode === "full" ? null : policy.projects,
      allowShell: policy.mode === "full", signal,
      onOutput(chunk) { queue.push({ type: "output", chunk }); },
    }).then((result) => {
      queue.push(toRemoteJson(remoteToolEvents.parse({ type: "result", ...result })));
      queue.end();
    }).catch((error: unknown) => queue.end(new Error(errorMessage(error))));
    try {
      yield* queue.read(signal);
    } finally {
      released.abort();
      await finished;
      session.inFlightMutations.delete(operation);
    }
  }

  function reconcileDirectory() {
    const available = new Map(directory.listBrains().flatMap(({ id, port }) =>
      port && !port.signal.aborted ? [[id, port] as const] : []));
    for (const [id, binding] of bindings) {
      if (available.get(id) === binding.port) continue;
      binding.remove();
      bindings.delete(id);
    }
    for (const [id, port] of available) {
      if (bindings.has(id)) continue;
      const binding = new AbortController();
      const remove = port.handle("tool.call", (params, signal) => callTool(id, port, binding.signal, params, signal));
      port.signal.addEventListener("abort", reconcileDirectory, { once: true });
      bindings.set(id, { port, remove: () => {
        binding.abort();
        remove();
        port.signal.removeEventListener("abort", reconcileDirectory);
      } });
    }
    for (const session of sessions) drive(session);
  }

  // 最近一次目录里各模型提供的档位。新建时只发送所选模型确实提供的档位，旧版 brain 的模型因此永远不带档位。
  let thinkingByModel = new Map<string, Set<string>>();

  async function getCatalog() {
    const results = await Promise.allSettled(directory.listBrains().map(async ({ id, name, port }) => {
      if (!port || port.signal.aborted) return [];
      const [result, levels] = await Promise.all([
        remoteRequest(port, "agent.catalog", {}, lifetime.signal),
        // 旧版 brain 没有 agent.thinking，回 invalid；这时该 brain 的模型不显示档位。
        remoteRequest(port, "agent.thinking", {}, lifetime.signal).catch((error: unknown) => {
          if (error instanceof ProtocolError && error.code === "invalid") return { providers: [] };
          throw error;
        }),
      ]);
      return result.providers.map((provider) => {
        const thinking = new Map(levels.providers.find(({ id }) => id === provider.id)?.models.map((model) => [model.id, model]));
        return {
          brainId: id, brainName: name, ...provider,
          models: provider.models.map((model) => {
            const level = thinking.get(model.id);
            return level ? { ...model, thinkingOptions: level.options, defaultThinkingOptionId: level.defaultOptionId } : model;
          }),
        };
      });
    }));
    const models: ProviderModel[] = [];
    const modes = new Map<string, ProviderMode>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const provider of result.value) {
        for (const model of provider.models) models.push({
          ...model, id: `${provider.brainId}/${provider.id}/${model.id}`,
          label: `${provider.brainName} · ${provider.label} · ${model.label}`,
        });
        for (const mode of provider.modes) if (!modes.has(mode.id)) modes.set(mode.id, mode);
      }
    }
    thinkingByModel = new Map(models.map(({ id, thinkingOptions }) => [id, new Set(thinkingOptions?.map((option) => option.id))]));
    const defaultModel = models.find(({ isDefault }) => isDefault)?.id ?? models[0]?.id;
    // Paseo 0.17.3 会为整个 provider 自动选一个 mode；代理的默认项把决定留给选中模型所在的 brain。
    const automatic = { id: brainDefaultMode, label: "Use brain default" };
    return {
      models: models.map((model) => ({ ...model, isDefault: model.id === defaultModel })),
      modes: defaultModel ? [automatic, ...modes.values()] : [],
      defaultMode: defaultModel ? brainDefaultMode : undefined,
      defaultModel,
    };
  }

  const registration: ProviderRegistration = {
    id: "remote-hand", label: "Remote Hand",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Remote Hand requires provider protocol version 1.");
      lifetime.signal.throwIfAborted();
      const capabilities = request.capabilities.filter((id) =>
        ["prompt.message", "prompt.image", "permission", "session.persistence", "timeline.plugin"].includes(id));
      const listeners = new Set<(event: ProviderEvent) => void>();
      const owned = new Map<string, Session>();
      const opening = new Set<string>();
      const connection = new AbortController();
      const signal = AbortSignal.any([connection.signal, lifetime.signal]);
      function emit(event: ProviderEvent) {
        for (const listener of listeners) listener(event);
      }

      const providerConnection: ProviderConnection = {
        version: 1, capabilities,
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async close() {
          if (connection.signal.aborted) return;
          connection.abort();
          for (const session of owned.values()) closeSession(session);
          owned.clear();
          listeners.clear();
          connections.delete(providerConnection);
        },
        async send(input) {
          signal.throwIfAborted();
          if (input.type === "catalog") {
            emit({ type: "catalog", requestId: input.requestId, catalog: await getCatalog() });
            return;
          }
          if (input.type === "session.open") {
            if ((owned.has(input.sessionId) && !owned.get(input.sessionId)!.lifetime.signal.aborted) || opening.has(input.sessionId)) {
              emit({ type: "request.failed", requestId: input.requestId, error: { message: "Session is already open." } });
              return;
            }
            opening.add(input.sessionId);
            try {
              const cwd = await realpath(absolutePath(input.config.cwd));
              if (!(await stat(cwd)).isDirectory()) throw new Error("Hand workspace must be a directory.");
              let data: z.infer<typeof persistenceSchema>;
              if (input.persistence) {
                if (input.persistence.version !== 1) throw new Error("Unrecognized Remote Hand persistence version.");
                data = persistenceSchema.parse(input.persistence.data);
                if (!await sameCanonicalPath(data.cwd, cwd)) throw new Error("This remote session belongs to a different hand workspace.");
                data.cwd = cwd;
                if (!directory.listBrains().some(({ id }) => id === data.brainId)) throw new Error("This brain is no longer paired.");
              } else {
                const target = parseModel(input.config.model ?? (await getCatalog()).defaultModel);
                const thinkingOptionId = input.config.thinkingOption !== undefined &&
                  thinkingByModel.get(`${target.brainId}/${target.provider}/${target.model}`)?.has(input.config.thinkingOption)
                  ? input.config.thinkingOption : undefined;
                const port = bindings.get(target.brainId)?.port;
                if (!port) throw new Error("Wait for the selected brain to reconnect before creating a session.");
                const handPlatform = z.enum(["darwin", "linux", "win32"]).parse(process.platform) satisfies RemoteAgentPlatform;
                signal.throwIfAborted();
                const created = await remoteRequest(port, "agent.create", {
                  provider: target.provider, model: target.model, handPlatform, handCwd: cwd,
                  modeId: input.config.mode === brainDefaultMode ? undefined : input.config.mode,
                  thinkingOptionId, title: input.config.title,
                }, signal);
                signal.throwIfAborted();
                await directory.authorizeProject(target.brainId, cwd);
                data = {
                  brainId: target.brainId, agentId: created.agentId, cwd,
                  model: `${target.brainId}/${target.provider}/${target.model}`,
                  ...(created.modeId !== undefined && { modeId: created.modeId }),
                  ...(thinkingOptionId !== undefined && { thinkingOptionId }),
                };
              }
              signal.throwIfAborted();
              const session: Session = {
                ...data, id: input.sessionId, emit, lifetime: new AbortController(), opened: input.requestId,
                history: input.history, endedTurns: new Set(), itemRevisions: new Map(), pendingPermissions: new Set(),
                stopRequests: new Set(), stopping: false, waiting: false, inFlightMutations: new Set(),
              };
              owned.set(session.id, session);
              sessions.add(session);
              emit({
                type: "session.opened", requestId: input.requestId, sessionId: session.id, cwd,
                capabilities, restoration: "core", title: input.config.title,
                ...(capabilities.includes("session.persistence") && { persistence: { version: 1, data } }),
              });
              emit({ type: "session.config", sessionId: session.id, config: {
                model: data.model, mode: data.modeId, thinkingOption: data.thinkingOptionId, models: [], modes: [], thinkingOptions: [],
              } });
              drive(session);
            } catch (error) {
              emit({ type: "request.failed", requestId: input.requestId, error: { message: errorMessage(error) } });
            } finally {
              opening.delete(input.sessionId);
            }
            return;
          }
          if (!("sessionId" in input)) throw new Error(`Unsupported Remote Hand request: ${input.type}`);
          const session = owned.get(input.sessionId);
          if (!session || session.lifetime.signal.aborted) throw new Error("Unknown Remote Hand session.");
          switch (input.type) {
            case "session.prompt":
              return sendPrompt(session, input.prompt);
            case "session.permission": {
              const source = session.source;
              if (!source?.ready) throw new Error("Wait for the brain to reconnect before answering this permission request.");
              await remoteRequest(source.port, "agent.permission", {
                agentId: session.agentId, permissionId: input.permissionId, response: input.response,
              }, source.lifetime.signal);
              break;
            }
            case "session.interrupt":
              session.stopRequests.add(input.requestId);
              notice(session, "stop");
              void flushStops(session);
              break;
            case "session.close":
              owned.delete(session.id);
              closeSession(session);
              emit({ type: "session.closed", sessionId: session.id });
              emit({ type: "request.completed", requestId: input.requestId });
              break;
            default:
              throw new Error(`Unsupported Remote Hand request: ${input.type}`);
          }
        },
      };
      connections.add(providerConnection);
      return providerConnection;
    },
  };

  async function sendPrompt(session: Session, prompt: Extract<ProviderInput, { type: "session.prompt" }>["prompt"]) {
    const emit = (result: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"]) => {
      session.emit({ type: "session.prompt_result", sessionId: session.id, clientMessageId: prompt.clientMessageId, result });
    };
    const source = session.source;
    let release: (() => void) | undefined;
    try {
      if (!source?.ready) throw new Error("等待本机：请在连接恢复后再发送提示。");
      if (prompt.input.type !== "message" || prompt.delivery !== "auto" || prompt.outputSchema !== undefined ||
          prompt.input.content.some(({ type }) => type !== "text" && type !== "image")) {
        throw new Error("Remote Hand currently supports text and image messages.");
      }
      if (session.promptGate) throw new Error("A prompt is already being accepted for this session.");
      // 等 prompt_result 后再交付同一轮的事件，避免很短的 turn 先结束再被宿主标记为运行。
      session.promptGate = new Promise<void>((resolve) => { release = resolve; });
      const content = prompt.input.content;
      const result = await remoteRequest(source.port, "agent.prompt", {
        agentId: session.agentId, clientMessageId: prompt.clientMessageId,
        text: content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
        images: content.flatMap((part) => part.type === "image" ? [{ data: part.data, mimeType: part.mimeType }] : []),
      }, source.lifetime.signal);
      emit(result);
    } catch (error) {
      emit({ type: "failed", error: { message: source?.port.signal.aborted ?
        "提示发送结果未知。重连后请先核对时间线。" : errorMessage(error) } });
    } finally {
      if (release) {
        session.promptGate = undefined;
        release();
      }
    }
  }

  const unsubscribe = directory.subscribe(reconcileDirectory);
  reconcileDirectory();
  return {
    registration,
    async dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      unsubscribe();
      for (const binding of bindings.values()) binding.remove();
      bindings.clear();
      await Promise.all([...connections].map((connection) => connection.close()));
    },
  };
}
