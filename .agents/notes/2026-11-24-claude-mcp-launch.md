# Claude 的 hand 工具如何获得 MCP 凭据

Paseo 0.17.3 的 `agent.open.before` 可为单个会话注入 MCP。这个入口不经过 daemon 的 Paseo MCP 注入开关，也不受 Claude 的 Paseo Tools 开关控制。用 `defineAgentTool` 注册的工具依赖宿主的注入通道，在默认配置下不会送到 Claude。

Claude Agent SDK 0.3.326 默认把 `mcpServers` 序列化到 `--mcp-config` 启动参数里，stdio 的 `env` 和 HTTP 的 `headers` 都包含在其中。不要直接把令牌写入这些字段。在 [MCP 入口](../../server/brain/hand-mcp.ts) 中，header 保存环境变量引用；插件通过 open hook 的会话环境注入令牌，Claude 启动后才展开 header。认证绑定会话和设备，令牌不保存到 agent 配置中。这个边界不隔离能读取 Claude 进程环境的本机用户。

修改注入或凭据传递方式时，用临时 `PASEO_HOME` 和真实 Claude 验证。MCP SDK 的回环测试可以覆盖授权和设备隔离，但无法验证 Claude 对 header 的展开；本机常用实例也可能打开了全局 MCP，从而掩盖工具没有送达的问题。
