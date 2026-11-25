import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PaseoAgentHandle, PaseoAgentTimelineEvent, PaseoApi, PaseoWorkspaceAgentCreateOptions } from "@getpaseo/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PluginHookPayload, PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { ProviderEventSchema, type ProviderEvent, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { RemoteAgentPort, RemoteAgentStream } from "../../shared/remote-agent.ts";
import { createBrainAgentService } from "../brain/index.ts";
import { toRemoteJson } from "../remote-agent-stream.ts";
import { createHandProvider, type HandBrain, type HandBrainDirectory } from "./index.ts";

type Handler = Parameters<RemoteAgentPort["handle"]>[1];

function loopback() {
  const link = new AbortController();
  const left = new Map<string, Handler>();
  const right = new Map<string, Handler>();
  const opened: RemoteAgentStream[] = [];
  function endpoint(own: Map<string, Handler>, peer: Map<string, Handler>): RemoteAgentPort {
    return {
      signal: link.signal,
      handle(method, handler) {
        assert.ok(!own.has(method), `duplicate handler: ${method}`);
        own.set(method, handler);
        return () => { own.delete(method); };
      },
      async request(method, params, caller) {
        const signal = caller ? AbortSignal.any([caller, link.signal]) : link.signal;
        signal.throwIfAborted();
        const reply = await peer.get(method)!(toRemoteJson(params), signal);
        signal.throwIfAborted();
        return toRemoteJson(reply);
      },
      async *open(method, params, caller) {
        opened.push(method);
        const released = new AbortController();
        const signal = AbortSignal.any(caller ? [caller, link.signal, released.signal] : [link.signal, released.signal]);
        try {
          signal.throwIfAborted();
          const stream = peer.get(method)!(toRemoteJson(params), signal);
          assert.ok(Symbol.asyncIterator in stream);
          for await (const event of stream) {
            signal.throwIfAborted();
            yield toRemoteJson(event);
          }
        } finally {
          released.abort();
        }
      },
    };
  }
  return { brain: endpoint(left, right), hand: endpoint(right, left), opened, disconnect: () => link.abort() };
}

type State = NonNullable<Awaited<ReturnType<PaseoAgentHandle["refresh"]>>>["agent"];
type Item = Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>["entries"][number]["item"];
type OpenHook = (payload: PluginHookPayload<"agent.open.before">) => Promise<PluginSessionOpenRequest | undefined>;
type CloseHook = (payload: PluginHookPayload<"agent.close.after">) => Promise<void>;

type CatalogEntry = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>["entries"][number];

function fakePaseo(extraProviders: CatalogEntry[] = [], providerBases: Record<string, string> = {}) {
  let openHook: OpenHook | undefined;
  let closeHook: CloseHook | undefined;
  const records = new Map<string, ReturnType<typeof record>>();
  const titles = new Map<string, string>();
  const responses: unknown[] = [];

  function record(cwd: string, opts: PaseoWorkspaceAgentCreateOptions, launch?: PluginSessionOpenRequest) {
    const id = opts.agentId!;
    const provider = opts.config.provider.split("/")[0];
    const listeners = new Set<(event: PaseoAgentTimelineEvent) => void>();
    const epoch = "timeline-epoch";
    const rows: Array<{ item: Item; turnId?: string; seqStart: number; seqEnd: number; timestamp: string }> = [];
    let sequence = 0;
    let turns = 0;
    let active: string | null = null;
    let pending: State["pendingPermissions"] = [];
    const pendingTool = new AbortController();

    function emit(event: PaseoAgentTimelineEvent["event"]) {
      for (const listener of listeners) listener({ agentId: id, event, timestamp: new Date().toISOString() } as PaseoAgentTimelineEvent);
    }
    function row(item: Item, start?: number) {
      const latest = ++sequence;
      const entry = { item, turnId: active ?? undefined, seqStart: start ?? latest, seqEnd: latest, timestamp: new Date().toISOString() };
      const existing = rows.findIndex((row) => row.seqStart === entry.seqStart);
      if (existing < 0) rows.push(entry);
      else rows[existing] = entry;
      emit({ type: "timeline", provider, item });
      return entry.seqStart;
    }
    function finish(state: "completed" | "canceled") {
      if (!active) return;
      const turnId = active;
      active = null;
      emit(state === "completed" ? { type: "turn_completed", provider, turnId } :
        { type: "turn_canceled", provider, turnId, reason: "Cancelled" });
    }
    function snapshot(): State {
      return {
        id, cwd, provider, metadata: opts.metadata, pendingPermissions: pending, status: active ? "running" : "idle",
        lastUserMessageAt: rows.findLast(({ item }) => item.type === "user_message")?.timestamp ?? null,
        activeTurn: active ? { turnId: active, startedAt: null } : null,
      } as State;
    }
    const handle = {
      id,
      refresh: async () => ({ agent: snapshot(), project: null }),
      current: snapshot,
      async send(text: string, options: { messageId: string }) {
        active = `turn-${++turns}`;
        emit({ type: "turn_started", provider, turnId: active });
        row({ type: "user_message", text, messageId: options.messageId, clientMessageId: options.messageId });
      },
      async respondToPermission(input: Parameters<PaseoAgentHandle["respondToPermission"]>[0]) {
        responses.push(input);
        pending = pending.filter(({ id }) => id !== input.requestId);
        emit({ type: "permission_resolved", provider, requestId: input.requestId, resolution: input.response });
      },
      timeline: {
        subscribe(handler: (event: PaseoAgentTimelineEvent) => void) {
          listeners.add(handler);
          return Object.assign(() => { listeners.delete(handler); }, { ready: Promise.resolve() });
        },
        async refetch(options: Parameters<PaseoAgentHandle["timeline"]["refetch"]>[0]) {
          const min = options?.cursor?.seq ?? 0;
          const remaining = rows.filter(({ seqEnd }) => seqEnd > min);
          const limit = options?.limit ?? remaining.length;
          const tail = options?.direction === "tail";
          const entries = tail ? remaining.slice(-limit) : remaining.slice(0, limit);
          return {
            entries, epoch, error: null, reset: false, window: { maxSeq: sequence },
            endCursor: entries.length ? { epoch, seq: tail ? sequence : Math.max(...entries.map(({ seqEnd }) => seqEnd)) } : null,
            hasNewer: !tail && remaining.length > entries.length,
          };
        },
      },
    } as unknown as PaseoAgentHandle;

    return {
      opts, handle, launch, row, finish, pendingTool, listeners,
      requestPermission() {
        const request = {
          id: "permission-1", provider, name: "AskUserQuestion", kind: "question" as const,
          input: { question: "Continue?" },
        };
        pending = [request];
        emit({ type: "permission_requested", provider, request });
      },
    };
  }

  const api = {
    config: { async get() {
      const providers = Object.fromEntries(Object.entries({ "claude-sub": "claude", ...providerBases })
        .map(([id, base]) => [id, { extends: base }]));
      return { config: { providers } };
    } },
    providers: {
      async snapshot() {
        return { entries: [
          { provider: "claude-sub", label: "Claude", status: "loading", enabled: true, defaultModeId: "default" },
          { provider: "private", label: "Private", status: "loading" },
          { provider: "remote-hand", label: "Remote Hand", status: "loading" },
          ...extraProviders,
        ] };
      },
      async listModels(provider: string) {
        if (provider === "claude-sub") return { models: [{ id: "claude/sonnet", label: "Sonnet 5.5", isDefault: true }] };
        assert.equal(provider, "private", `unexpected provider: ${provider}`);
        return { models: [] };
      },
      async listModes(provider: string) {
        if (provider === "claude-sub") return { modes: [{ id: "default", label: "Default" }] };
        assert.equal(provider, "private", `unexpected provider: ${provider}`);
        return { modes: [] };
      },
    },
    workspaces: {
      async open(cwd: string) {
        return {
          name: titles.get(cwd) ?? null,
          async setTitle(title: string) { titles.set(cwd, title); },
          agents: { async create(opts: PaseoWorkspaceAgentCreateOptions) {
            const result = await openHook?.({ request: {
              agentId: opts.agentId!, workspaceId: "workspace", cwd, provider: opts.config.provider.split("/")[0],
              reason: "create", purpose: "interactive", tools: [], labels: {}, metadata: opts.metadata ?? {},
              env: {}, mcpServers: {}, title: opts.title ?? null, background: false,
            } });
            const agent = record(cwd, opts, result);
            records.set(agent.handle.id, agent);
            return agent.handle;
          } },
        };
      },
    },
    agents: { ref(id: string) { return records.get(id)?.handle ?? { refresh: async () => null }; } },
  } as unknown as PaseoApi;

  return {
    api, records, titles, responses,
    closeAgent: (agent: PluginHookPayload<"agent.close.after">["agent"]) => closeHook?.({ agent }),
    hook: { addHook(name: string, hook: OpenHook | CloseHook) {
      if (name === "agent.close.after") {
        closeHook = hook as CloseHook;
        return () => { closeHook = undefined; };
      }
      assert.equal(name, "agent.open.before");
      openHook = hook as OpenHook;
      return () => { openHook = undefined; };
    } } as unknown as Pick<PluginServerContext, "addHook">,
  };
}

async function awaitFile(file: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = await readFile(file, "utf8").catch(() => "");
    if (value) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for shell output at ${file}`);
}

async function eventually<T>(value: () => T | undefined | false, context: string): Promise<T> {
  const deadline = Date.now() + 3_000;
  do {
    const result = value();
    if (result) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Timed out: ${context}`);
}

test("brain ↔ hand loopback: prompts, hand tools, permissions, stop, reconnect and device isolation", { timeout: 15_000 }, async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "remote-agent-test-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "hand project");
  const paseoHome = path.join(dir, "brain");
  await mkdir(cwd);
  const file = path.join(cwd, "local.txt");
  await writeFile(file, "hand only");
  const fake = fakePaseo();
  const cancelled: string[] = [];
  let releaseCancel!: () => void;
  const allowCancel = new Promise<void>((resolve) => { releaseCancel = resolve; });
  t.after(releaseCancel);
  const service = createBrainAgentService({ paseoHome, async cancelAgent(id) {
    cancelled.push(id);
    await allowCancel;
    const agent = fake.records.get(id)!;
    agent.pendingTool.abort();
    agent.finish("canceled");
  } });
  t.after(service.registerHook(fake.hook));
  t.after(service.close);

  const access = { providers: ["claude-sub", "remote-hand"] };
  let pair = loopback();
  const attach = () => service.attach({ deviceId: "device-1", paseo: fake.api, access, port: pair.brain });
  attach();
  let current: HandBrain = { id: "mini", name: "Mac mini", port: pair.hand };
  const changes = new Set<() => void>();
  const projects = new Set<string>();
  let full = false;
  let grants = 0;
  const directory: HandBrainDirectory = {
    listBrains: () => [current],
    subscribe(listener) { changes.add(listener); return () => { changes.delete(listener); }; },
    async readPolicy() { return full ? { mode: "full" } : { mode: "restricted", projects: [...projects] }; },
    async authorizeProject(brainId, cwd) { assert.equal(brainId, "mini"); grants++; projects.add(cwd); },
  };
  const hand = createHandProvider(directory);
  t.after(async () => { pair.disconnect(); await hand.dispose(); });
  const connection = await hand.registration.connect({ versions: [1], capabilities: ["prompt.message", "permission", "session.persistence"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));
  const get = <K extends ProviderEvent["type"]>(type: K, predicate: (event: Extract<ProviderEvent, { type: K }>) => boolean) =>
    events.find((event): event is Extract<ProviderEvent, { type: K }> =>
      event.type === type && predicate(event as Extract<ProviderEvent, { type: K }>));
  const seesNotice = (title: string) => get("session.notice", (event) => event.notice.title === title && !event.notice.dismissed);

  await connection.send({ type: "catalog", requestId: "catalog" });
  const model = get("catalog", (event) => event.requestId === "catalog")!.catalog.models;
  assert.deepEqual(model.map(({ id, label }) => ({ id, label })), [{ id: "mini/claude-sub/claude/sonnet", label: "Mac mini · Claude · Sonnet 5.5" }]);
  const config: ProviderSessionConfig = {
    cwd, model: model[0].id, mode: "default", env: { HAND_SECRET: "never forward this" },
    mcpServers: { local: { type: "stdio", command: "never forward this" } }, settings: {}, persist: true,
  };
  await connection.send({ type: "session.open", requestId: "open", sessionId: "local-session", config, history: "skip" });
  const opened = get("session.opened", (event) => event.requestId === "open")!;
  await eventually(() => get("session.ready", (event) => event.requestId === "open"), JSON.stringify(events));
  const agentId = (opened.persistence!.data as { agentId: string }).agentId;
  const agent = fake.records.get(agentId)!;
  const [workspace] = fake.titles.keys();
  assert.equal(fake.titles.get(workspace), "hand project");
  assert.match(workspace, /plugin-data[/\\]remote-hand[/\\]workspaces[/\\]device-1[/\\]hand-project-[a-f0-9]+$/);
  assert.equal(agent.opts.config.provider, "claude-sub/claude/sonnet");
  assert.equal(agent.opts.config.modeId, "default");
  assert.ok(agent.opts.config.systemPrompt?.includes(JSON.stringify(cwd)));
  assert.ok(agent.opts.config.systemPrompt?.includes(process.platform));
  assert.equal(agent.opts.env, undefined);
  assert.equal(agent.opts.config.mcpServers, undefined);
  assert.equal(grants, 1);
  assert.deepEqual([...projects], [cwd]);

  await connection.send({ type: "session.prompt", sessionId: "local-session", prompt: {
    clientMessageId: "message-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hello from hand" }] },
  } });
  assert.deepEqual(get("session.prompt_result", (event) => event.clientMessageId === "message-1")?.result, { type: "turn", turnId: "turn-1" });
  const prefix = agent.row({ type: "assistant_message", text: "before", messageId: "assistant" });
  const before = await eventually(() => get("timeline.item", ({ item }) => item.type === "assistant_message" && item.text === "before"), "first assistant timeline item");
  await eventually(() => get("session.turn", ({ state }) => state === "started"), "turn started");

  function mcpConfig(launch: PluginSessionOpenRequest) {
    assert.deepEqual(launch.tools, []);
    const config = launch.mcpServers["remote-hand"];
    assert.ok(config.type === "http");
    const authorization = config.headers?.Authorization?.replace(/\$\{([^}]+)\}/g, (_, key: string) => launch.env[key]);
    assert.ok(authorization?.startsWith("Bearer "));
    return { url: new URL(config.url), headers: { Authorization: authorization } };
  }
  const mcp = mcpConfig(agent.launch!);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcp.url, { requestInit: { headers: mcp.headers } }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), ["hand_bash", "hand_edit", "hand_glob", "hand_grep", "hand_read", "hand_write"]);
  assert.match(agent.launch?.appendSystemPrompt?.join(" ") ?? "", /\bhand_read\b/);
  assert.doesNotMatch(agent.launch?.appendSystemPrompt?.join(" ") ?? "", /mcp__/);
  async function tool(name: string, input: object, signal?: AbortSignal) {
    const result = await client.callTool({ name, arguments: input }, undefined, { signal });
    const [content] = result.content as { type: string; text: string }[];
    assert.equal(content.type, "text");
    return { text: content.text, isError: result.isError };
  }
  assert.match((await tool("hand_read", { path: file })).text!, /hand only/);
  const command = process.platform === "win32" ? "Write-Output 'full mode'" : "printf 'full mode'";
  assert.match((await tool("hand_bash", { command })).text!, /Shell execution is disabled/);
  full = true;
  assert.match((await tool("hand_bash", { command })).text!, /full mode/);

  const toolCancel = new AbortController();
  const cancelCommand = process.platform === "win32"
    ? "Add-Content -LiteralPath cancel.txt -Value run; Start-Sleep -Seconds 30"
    : "printf 'run\n' > cancel.txt; /bin/sleep 30";
  const cancelledTool = assert.rejects(tool("hand_bash", { command: cancelCommand, timeout_ms: 5_000 }, toolCancel.signal));
  await awaitFile(path.join(cwd, "cancel.txt"));
  toolCancel.abort();
  await cancelledTool;

  agent.requestPermission();
  await eventually(() => get("session.permission", ({ request }) => request.id === "permission-1"), "permission appears on hand");
  await connection.send({ type: "session.permission", sessionId: "local-session", permissionId: "permission-1",
    response: { behavior: "allow", updatedInput: { answer: "yes" } },
  });
  assert.deepEqual(fake.responses, [{ requestId: "permission-1", response: { behavior: "allow", updatedInput: { answer: "yes" } } }]);
  await eventually(() => get("session.permission_resolved", ({ permissionId }) => permissionId === "permission-1"), "permission resolved");

  const foreign = loopback();
  service.attach({ deviceId: "device-2", paseo: fake.api, access, port: foreign.brain });
  t.after(foreign.disconnect);
  await assert.rejects(foreign.hand.request("agent.prompt", { agentId, text: "undesired", clientMessageId: "foreign" }), /not owned/);
  await assert.rejects(foreign.hand.request("agent.cancel", { agentId }), /not owned/);
  await assert.rejects(foreign.hand.request("agent.permission", { agentId, permissionId: "permission-1", response: { behavior: "deny" } }), /not owned/);
  await assert.rejects(foreign.hand.open("agent.events", { agentId, history: "replay" })[Symbol.asyncIterator]().next(), /not owned/);
  const other = await foreign.hand.request("agent.create", {
    handCwd: cwd, handPlatform: process.platform, provider: "claude-sub", model: "claude/sonnet",
  }) as { agentId: string };
  const otherMcp = mcpConfig(fake.records.get(other.agentId)!.launch!);
  async function post(url: URL, headers?: Record<string, string>) {
    const response = await fetch(url, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await response.body?.cancel();
    return response.status;
  }
  assert.equal(await post(mcp.url), 401);
  assert.equal(await post(otherMcp.url, mcp.headers), 401);
  assert.equal(await post(otherMcp.url, otherMcp.headers), 200);
  await fake.closeAgent({ id: other.agentId } as PluginHookPayload<"agent.close.after">["agent"]);
  assert.equal(await post(otherMcp.url, otherMcp.headers), 401);


  const started = path.join(cwd, "started.txt");
  const writeAndWait = process.platform === "win32"
    ? "Add-Content -LiteralPath started.txt -Value run; Start-Sleep -Seconds 30"
    : "printf 'run\\n' >> started.txt; /bin/sleep 30";
  const inFlight = tool("hand_bash", { command: writeAndWait, timeout_ms: 5_000 });
  const startedText = await awaitFile(started);
  assert.match(startedText, /run/);
  const previous = pair;
  previous.disconnect();
  assert.match((await inFlight).text!, /result is unknown/);
  assert.ok(seesNotice("等待本机"));
  assert.ok(seesNotice("执行结果未知"));

  await connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "local-session" });
  assert.ok(seesNotice("已请求停止"));
  assert.equal(seesNotice("已停止"), undefined);
  assert.deepEqual(cancelled, []);
  agent.row({ type: "assistant_message", text: "before and after", messageId: "assistant" }, prefix);
  for (let i = 0; i < 105; i++) agent.row({ type: "notification", level: "info", message: `offline ${i}` });

  pair = loopback();
  attach();
  current = { ...current, port: pair.hand };
  for (const change of changes) change();
  const merged = await eventually(() => get("timeline.item", ({ item }) => item.type === "assistant_message" && item.text === "before and after"), "catch-up using stable message identity");
  assert.equal(merged.item.id, before.item.id);
  await eventually(() => get("timeline.item", ({ item }) => item.type === "notification" && item.message === "offline 104"), "next history page");
  assert.ok(seesNotice("本机已重新连接"));
  await eventually(() => cancelled.length === 1 && true, "queued stop reaches brain");
  assert.equal(seesNotice("已停止"), undefined);
  releaseCancel();
  await eventually(() => get("request.completed", (event) => event.requestId === "stop"), "stop acknowledged by brain");
  await eventually(() => get("session.turn", ({ state }) => state === "canceled"), "turn canceled");
  assert.ok(seesNotice("已停止"));
  assert.equal(await readFile(started, "utf8"), startedText);
  assert.deepEqual(pair.opened, ["agent.events"]);
  assert.equal(grants, 1);

  const stopMarker = path.join(cwd, "stop-in-flight.txt");
  const stopCommand = process.platform === "win32"
    ? "Add-Content -LiteralPath stop-in-flight.txt -Value run; Start-Sleep -Seconds 30"
    : "printf 'run' > stop-in-flight.txt; /bin/sleep 30";
  // 不用 mock 的 provider signal：真实 Claude 停止时可以留下未取消的 MCP 请求。
  const runningTool = tool("hand_bash", { command: stopCommand, timeout_ms: 5_000 });
  await awaitFile(stopMarker);
  await pair.hand.request("agent.cancel", { agentId });
  assert.match((await runningTool).text!, /Tool execution cancelled/);

  projects.clear();
  full = false;
  await connection.send({ type: "session.close", requestId: "close", sessionId: "local-session" });
  await connection.send({
    type: "session.open", requestId: "restore", sessionId: "restored-session", config,
    persistence: opened.persistence, history: "skip",
  });
  await eventually(() => get("session.ready", (event) => event.requestId === "restore"), "restore from persistence");
  assert.equal(grants, 1, "restoring a session must not reauthorize a revoked project");
  assert.match((await tool("hand_read", { path: file })).text!, /outside the authorized roots/);
  await connection.close();
  await eventually(() => agent.listeners.size === 0 && true, "SDK timeline listeners released");
});

test("brain ↔ hand loopback: ACP prefixes only the first prompt and uses authenticated stdio MCP", { timeout: 10_000 }, async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "remote-agent-acp-test-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "hand");
  await mkdir(cwd);
  const file = path.join(cwd, "local.txt");
  await writeFile(file, "read from the hand over stdio MCP");
  const fake = fakePaseo([
    {
      provider: "acp-future", label: "Custom ACP", status: "ready", enabled: true,
      models: [{ provider: "acp-future", id: "test", label: "Test ACP" }], modes: [],
    },
    {
      provider: "codex-sub", label: "Codex", status: "ready", enabled: true,
      models: [{ provider: "codex-sub", id: "gpt-6.2", label: "GPT-6.2" }],
      modes: [{ id: "auto", label: "Auto" }, { id: "full-access", label: "Full Access" }], defaultModeId: "auto",
    },
    {
      provider: "disabled", status: "ready", enabled: false,
      models: [{ provider: "disabled", id: "disabled", label: "Disabled" }],
    },
  ], { "acp-future": "acp", "codex-sub": "codex" });
  const service = createBrainAgentService({ paseoHome: path.join(dir, "brain"), async cancelAgent() {} });
  t.after(service.registerHook(fake.hook));
  t.after(service.close);
  const access = { providers: [] as string[] };
  const pair = loopback();
  service.attach({ deviceId: "device-1", paseo: fake.api, access, port: pair.brain });
  const hand = createHandProvider({
    listBrains: () => [{ id: "mini", name: "Mac mini", port: pair.hand }],
    subscribe: () => () => {},
    async readPolicy() { return { mode: "restricted", projects: [cwd] }; },
    async authorizeProject() {},
  });
  t.after(async () => { pair.disconnect(); await hand.dispose(); });
  const connection = await hand.registration.connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));

  await connection.send({ type: "catalog", requestId: "catalog" });
  const catalog = events.find((event) => event.type === "catalog" && event.requestId === "catalog")!;
  assert.deepEqual(catalog.catalog.models.map(({ label }) => label), [
    "Mac mini · Claude · Sonnet 5.5", "Mac mini · Custom ACP · Test ACP", "Mac mini · Codex · GPT-6.2",
  ]);
  assert.equal(catalog.catalog.defaultMode, "remote-hand:brain-default");
  assert.deepEqual(catalog.catalog.modes.map(({ id }) => id), ["remote-hand:brain-default", "default", "auto", "full-access"]);

  const create = { provider: "codex-sub", model: "gpt-6.2", handCwd: cwd, handPlatform: process.platform };
  for (const requested of [undefined, "auto"]) {
    const reply = await pair.hand.request("agent.create", toRemoteJson({ ...create, modeId: requested })) as { agentId: string; modeId: string };
    const agent = fake.records.get(reply.agentId)!;
    assert.equal(agent.opts.config.modeId, requested ?? "full-access");
    assert.equal(reply.modeId, agent.opts.config.modeId);
    assert.match(agent.launch?.appendSystemPrompt?.join(" ") ?? "", /\bhand_read\b/);
  }
  access.providers = ["acp-future"];
  await assert.rejects(pair.hand.request("agent.create", create), /not available/);

  const sessionId = "local-acp";
  await connection.send({ type: "session.open", requestId: "open", sessionId, history: "skip", config: {
    cwd, model: "mini/acp-future/test", mode: catalog.catalog.defaultMode, env: {}, mcpServers: {}, settings: {}, persist: true,
  } });
  await eventually(() => events.some((event) => event.type === "session.ready" && event.sessionId === sessionId), JSON.stringify(events));
  const opened = events.find((event) => event.type === "session.opened" && event.sessionId === sessionId)!;
  const { agentId, modeId } = opened.persistence!.data as { agentId: string; modeId?: string };
  const agent = fake.records.get(agentId)!;
  assert.equal(modeId, undefined);
  assert.equal(agent.opts.config.modeId, undefined);
  assert.equal(agent.opts.config.systemPrompt, undefined);
  assert.equal(agent.launch?.appendSystemPrompt, undefined);

  const mcp = agent.launch?.mcpServers["remote-hand"];
  assert.ok(mcp?.type === "stdio");
  const client = new Client({ name: "test", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport(mcp));

  await connection.send({ type: "session.prompt", sessionId, prompt: {
    clientMessageId: "first", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "read the file" }] },
  } });
  const first = (await agent.handle.timeline.refetch({ direction: "tail", limit: 1 })).entries[0].item;
  assert.ok(first.type === "user_message");
  assert.ok(first.text.includes(JSON.stringify(cwd)));
  assert.match(first.text, /\bhand_read\b/);
  assert.doesNotMatch(first.text, /mcp__/);
  assert.match(first.text, /User request:\nread the file$/);
  const result = await client.callTool({ name: "hand_read", arguments: { path: file } });
  assert.notEqual(result.isError, true);
  const [content] = result.content as { type: string; text: string }[];
  assert.equal(content.type, "text");
  assert.match(content.text, /read from the hand over stdio MCP$/);
  agent.finish("completed");

  await connection.send({ type: "session.prompt", sessionId, prompt: {
    clientMessageId: "next", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "follow up" }] },
  } });
  const next = (await agent.handle.timeline.refetch({ direction: "tail", limit: 1 })).entries[0].item;
  assert.ok(next.type === "user_message");
  assert.equal(next.text, "follow up");
});
