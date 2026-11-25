# Brain 端权限模式与并发上限

起因是 Paseo 插件注册表的审核意见（getpaseo/plugins#3288）：配对设备可以直接指定 mode，不指定时 Codex 会被选成 `full-access`；并发上限只保存、不执行。

## 权限模式

设备不能替 brain 主人选权限。brain 使用 Paseo 目录给出的 `defaultModeId`，也就是本机 provider 的默认模式（例如 Codex 是 `auto`，开了 auto-review 时是 `auto-review`；Claude 是 `auto`）。原来硬编码的 `preferredModes` 已删除。

`allowDeviceModes` 默认关闭。关闭时，目录只把默认 mode 发给设备，`agent.create` 拒绝其他 mode，不会悄悄改成默认值，以免设备误以为拿到了所选权限。开启后，设备可以选目录里的任意 mode。这里限制的是 brain 自身：agent 在 brain 上仍能调用原生工具，hand 的受限档管不到。

## 并发上限的含义

上限只计 `initializing` 和 `running` 状态的会话，不计空闲会话。理由：

- hand 关闭会话时不会通知 brain，brain 上的 agent 会一直留着。如果把空闲会话也算进去，默认值 1 会让每台设备只能建一个会话，而且名额永远不释放。
- 计数以 Paseo 的 agent 状态为准，按 metadata 里的设备 ID 过滤。插件重启后计数依然准确。

同一设备的 `agent.create` 和 `agent.prompt` 按设备排队执行。上一个请求的会话进入运行状态后，下一个请求才开始计数，所以同时到达的请求不会一起越过上限。给已在运行的会话追加消息时，计数会排除这个会话本身。

依据：Paseo `provider-snapshot-manager.ts`、`codex-app-server-agent.ts`、`claude/agent.ts` 中 `defaultModeId` 的来源；`fetch_agents_request` 的 `filter.statuses`。回归测试见 `server/provider/remote-agent.test.ts` 的 "brain limits running sessions per device"；去掉排队后这条测试会失败。
