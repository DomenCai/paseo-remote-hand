# Paseo 0.17.3 的 provider 指令与 MCP 传输

通用 ACP 会传工具配置，但 `acp-agent.ts` 的 `session/new` 不传 system prompt。Brain 从配置 RPC 的 `providers[id].extends` 识别 `acp`；内置 Cursor 和 Copilot 由 `provider-registry.ts` 注册为 ACP，需按 ID 识别。Grok、Kimi 和自定义 ACP 配置使用首条用户消息。Antigravity 走专用插件，仅当 agy 在 ACP 初始化声明 `antigravity.systemPrompt.append` 时送达系统指令。

Brain 用宿主保存的 `lastUserMessageAt` 判断是否已有用户消息，避免依赖插件进程内标记。Paseo 也会记录被拒的用户提交；如果首条提交被宿主拒绝，后续消息不会重新追加前缀。

Brain 先在 agent 元数据持久化首条提交的 `clientMessageId` 和前缀的 UTF-16 长度，再发送消息。实时和历史投影都用该边界去掉前缀，不保存第二份用户正文。Paseo 0.17.3 的时间线 RPC 先取快照再取行，实时同步可能遇到未包含边界的快照；有用户消息的 ACP 页会再读取一次 agent 元数据。此前已发送的消息没有这份边界，不做推断或回写。

多 provider 探针验证的是 stdio MCP。只有 Claude 的 HTTP header 环境变量展开已验证，见 [Claude 启动说明](2026-11-24-claude-mcp-launch.md)。其他 provider 通过 stdio 子进程接同一认证 HTTP 服务，令牌经 MCP 子进程环境传入。Brain 继续按会话和设备验证令牌。Paseo 编译插件为单个 CommonJS bundle，所以子进程通过内联脚本启动。

Paseo 0.17.3 的 App 会为代理 provider 预选目录默认 mode，目录接口没有所选模型参数。`Use brain default` 让这一默认选择在发送前回到省略 mode 的语义。Grok 和 Pi 实测能完成工具调用，但没有可选 mode；此时 brain 也省略 mode，让目标 provider 自己处理。

依据：Paseo `8d287e5f5` 的 `provider-registry.ts`、`acp-agent.ts`、`resolve-agent-form.ts` 和 Antigravity 的 `server/provider.ts`；本插件的 [回环测试](../../server/provider/remote-agent.test.ts) 覆盖自定义 ACP 首条指令、时间线实时与历史投影和 stdio 工具读取。mm-xxt 已验收 Codex、Antigravity、Grok、Kimi、Pi 通过 `hand_*` 跨机读取随机文件。

## 兼容 Paseo 0.16.1（2026-11-25）

`agent.open.before` 的 `appendSystemPrompt` 直到 npm 发布的 0.17.0 才有；0.16.1、0.16.2 的钩子输出是严格 schema，多出这个字段会让创建 agent 失败（`Unrecognized key: "appendSystemPrompt"`）。仓库主干上"同步 0.16.1"的提交比实际发布版新，按源码判断会误以为 0.16.1 已支持，以 npm 包为准。工具说明因此与项目说明一起放进创建 agent 时的 `config.systemPrompt`，钩子只注入 MCP 和环境变量。在 mm-xxt 上用两个 0.16.1 临时 daemon 实测：Codex 受限档读文件、`hand_bash` 被拒，完全档执行命令，停止结束 hand 进程，Grok 首条消息前缀与时间线还原均通过；本机 0.17.4 临时 daemon 上 Claude 按说明调用了 `hand_read`。
