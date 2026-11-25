# Paseo 0.17.3 的 provider 指令与 MCP 传输

通用 ACP 会传工具配置，但 `acp-agent.ts` 的 `session/new` 不传 system prompt。Brain 从配置 RPC 的 `providers[id].extends` 识别 `acp`；内置 Cursor 和 Copilot 由 `provider-registry.ts` 注册为 ACP，需按 ID 识别。Grok、Kimi 和自定义 ACP 配置使用首条用户消息。Antigravity 走专用插件，仅当 agy 在 ACP 初始化声明 `antigravity.systemPrompt.append` 时送达系统指令。

Brain 用宿主保存的 `lastUserMessageAt` 判断是否已有用户消息，避免依赖插件进程内标记。Paseo 也会记录被拒的用户提交；如果首条提交被宿主拒绝，后续消息不会重新追加前缀。

多 provider 探针验证的是 stdio MCP。只有 Claude 的 HTTP header 环境变量展开已验证，见 [Claude 启动说明](2026-11-24-claude-mcp-launch.md)。其他 provider 通过 stdio 子进程接同一认证 HTTP 服务，令牌经 MCP 子进程环境传入。Brain 继续按会话和设备验证令牌。Paseo 编译插件为单个 CommonJS bundle，所以子进程通过内联脚本启动。

Paseo 0.17.3 的 App 会为代理 provider 预选目录默认 mode，目录接口没有所选模型参数。`Use brain default` 让这一默认选择在发送前回到省略 mode 的语义。Grok 和 Pi 实测能完成工具调用，但没有可选 mode；此时 brain 也省略 mode，让目标 provider 自己处理。

依据：Paseo `8d287e5f5` 的 `provider-registry.ts`、`acp-agent.ts`、`resolve-agent-form.ts` 和 Antigravity 的 `server/provider.ts`；本插件的 [回环测试](../../server/provider/remote-agent.test.ts) 覆盖自定义 ACP 的首条指令和 stdio 工具读取。各 provider 启动 Remote Hand 子进程的行为待跨机验收。
