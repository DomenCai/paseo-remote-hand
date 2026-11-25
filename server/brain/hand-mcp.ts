import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handTools, type HandToolName, type HandToolResult } from "../../shared/hand-tools.ts";

export const handMcpName = "remote-hand";
const tokenEnv = "PASEO_REMOTE_HAND_MCP_TOKEN";

export function createHandMcp(
  call: (identity: { agentId: string; deviceId: string }, name: HandToolName, input: unknown, signal: AbortSignal) => Promise<HandToolResult>,
) {
  const leases = new Map<string, { token: string; deviceId: string; lifetime: AbortController }>();
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
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
    async issue(agentId: string, deviceId: string) {
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
      leases.set(agentId, { token, deviceId, lifetime: new AbortController() });
      return {
        env: { [tokenEnv]: token },
        server: {
          type: "http" as const,
          url: `http://127.0.0.1:${port}/${encodeURIComponent(agentId)}`,
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
