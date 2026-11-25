import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handTools, type HandToolName, type HandToolResult } from "../../shared/hand-tools.ts";

export const handMcpName = "remote-hand";
const tokenEnv = "PASEO_REMOTE_HAND_MCP_TOKEN";

// 由 provider 启动。Paseo 把插件打成单个 bundle，所以脚本随配置传入，不依赖安装路径。
// 每行对应一个无状态 HTTP POST；取消时断开原请求，让 brain 取消在途工具调用。
const stdioBridge = String.raw`
const url = process.argv[1];
const headers = {
  'Authorization': 'Bearer ' + process.env[${JSON.stringify(tokenEnv)}],
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};
const pending = new Map();
require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.method === 'notifications/cancelled') {
      pending.get(message.params?.requestId)?.abort();
      return;
    }
    const { id } = message;
    const controller = new AbortController();
    if (id !== undefined) pending.set(id, controller);
    try {
      const reply = await fetch(url, { method: 'POST', headers, body: line, signal: controller.signal, redirect: 'error' });
      if (!reply.ok) { await reply.body?.cancel(); throw new Error('MCP HTTP ' + reply.status); }
      if (id !== undefined) process.stdout.write(JSON.stringify(await reply.json()) + '\n');
      else await reply.body?.cancel();
    } catch (error) {
      if (id !== undefined && !controller.signal.aborted) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } }) + '\n');
      }
    } finally {
      pending.delete(id);
    }
  })
  .on('close', () => { for (const controller of pending.values()) controller.abort(); });
`;

export function createHandMcp(
  call: (identity: { agentId: string; deviceId: string }, name: HandToolName, input: unknown, signal: AbortSignal) => Promise<HandToolResult>,
) {
  const leases = new Map<string, { token: string; deviceId: string; lifetime: AbortController; transport: "http" | "stdio" }>();
  let listening: Promise<number> | undefined;
  let closed = false;

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      // SDK 错误可能包含请求详情，不能把它们写入插件日志。
      if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const address = server.address();
    if (!address || typeof address === "string" || req.headers.host !== `127.0.0.1:${address.port}` || req.headers.origin !== undefined) {
      res.writeHead(403).end();
      return;
    }
    const agentId = req.url?.slice(1) ?? "";
    const lease = leases.get(agentId);
    const authorization = req.headers.authorization ?? "";
    const expected = lease && `Bearer ${lease.token}`;
    if (!expected || Buffer.byteLength(authorization) !== expected.length ||
        !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) {
      res.writeHead(401).end();
      return;
    }
    // 无状态 MCP 在每次 POST 上建立独立传输；不打开额外的 GET 事件流。
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const disconnect = new AbortController();
    res.once("close", () => disconnect.abort());
    const mcp = new McpServer({ name: handMcpName, version: "1.0.0" });
    for (const { name, description, input } of Object.values(handTools)) {
      mcp.registerTool<z.ZodType, z.ZodType>(name, { description, inputSchema: input }, async (args, { signal }) => {
        const result = await call({ agentId, deviceId: lease.deviceId }, name, args,
          AbortSignal.any([signal, disconnect.signal, lease.lifetime.signal]));
        return { content: [{ type: "text", text: result.text }], isError: result.isError };
      });
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: lease.transport === "stdio",
    });
    res.once("close", () => { void mcp.close().catch(() => {}); });
    await mcp.connect(transport);
    if (res.destroyed) { await mcp.close(); return; }
    await transport.handleRequest(req, res);
  }

  function revoke(agentId: string) {
    const lease = leases.get(agentId);
    leases.delete(agentId);
    lease?.lifetime.abort();
  }

  return {
    async issue(agentId: string, deviceId: string, transport: "http" | "stdio") {
      if (closed) throw new Error("Remote Hand MCP is closed.");
      listening ??= new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve((server.address() as { port: number }).port);
        });
      });
      const port = await listening;
      if (closed) throw new Error("Remote Hand MCP is closed.");
      revoke(agentId);
      const token = randomBytes(32).toString("base64url");
      leases.set(agentId, { token, deviceId, lifetime: new AbortController(), transport });
      const url = `http://127.0.0.1:${port}/${encodeURIComponent(agentId)}`;
      const env: Record<string, string> = {};
      if (transport === "stdio") return {
        env,
        server: {
          type: "stdio" as const,
          command: process.execPath,
          args: ["-e", stdioBridge, url],
          env: { [tokenEnv]: token, ...(process.versions.electron && { ELECTRON_RUN_AS_NODE: "1" }) },
        },
      };
      env[tokenEnv] = token;
      return {
        env,
        server: {
          type: "http" as const,
          url,
          // 0.17.3 的 Claude SDK 会将 MCP 配置放入 argv；Claude 启动后再展开 header。
          headers: { Authorization: `Bearer \${${tokenEnv}}` },
        },
      };
    },
    revoke,
    async close() {
      closed = true;
      for (const id of leases.keys()) revoke(id);
      if (await listening?.catch(() => undefined)) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    },
  };
}
