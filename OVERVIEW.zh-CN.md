Remote hand 让 agent 在另一台机器上运行，同时操作本机上的项目。保存项目的机器叫 **hand**，运行 agent 的机器叫 **brain**。每台机器都可以担任其中一种角色，也可以两种都担任。

在 hand 上新建会话时选择 `remote-hand` provider，再选一个 brain 上的模型。会话在 brain 上用它自己的 provider（例如 Claude 或 Codex）运行；项目的文件读写、搜索和命令都在 hand 上执行，项目不需要复制到 brain。

## 设置

- 两台机器都安装 Paseo 0.16.1 或更新版本，启用插件，并都装上 Remote hand。brain 需要能在 Paseo 里运行所选 provider。
- 在 brain 上打开插件的「已连接设备」标签页，生成配对码。配对码五分钟内有效，只能用一次；请通过私密渠道发给 hand。
- 在 hand 上打开「远端机器」标签页，粘贴配对码，阅读风险提示后添加 brain。之后它的模型会出现在 `remote-hand` provider 下。
- 两台机器经 relay 建立端到端加密通道通信。默认 relay 是 `relay.paseo.sh:443`；也可以用自建 relay，需支持相同协议并有有效的 TLS 证书。不需要开启 Paseo daemon 的 relay，也不需要 daemon 配对。

[README](https://github.com/DomenCai/paseo-remote-hand#readme) 和[图文安装教程](https://github.com/DomenCai/paseo-remote-hand/blob/main/docs/install-guide.md)有逐步说明，也包括命令行配对。

## brain 端的控制

- 「已连接设备」列出已配对的设备、是否在线，以及每台设备正在运行的会话数。可以随时撤销设备。
- 「允许的 provider」限制配对设备能用哪些 provider，默认全部允许。
- 「允许设备选择权限模式」默认关闭。关闭时，设备只能使用 brain 为各 provider 设定的默认模式；开启后，设备可以选择 provider 提供的任意模式，包括完全访问。
- 「每台设备同时运行的会话上限」限制同一台设备同时启动或运行中的会话数，空闲会话不计入。

## hand 端的控制

- 每个 brain 默认处于「受限」级别：文件工具只能访问你在其中开过会话的项目，命令执行会被拒绝。可以在该 brain 的页面撤销项目授权。
- 「完全」级别允许 brain 上的 agent 以 hand 当前用户的权限读写任意文件、运行命令。只对你信任的 brain 开启。
- brain 换了 relay 地址时，可以直接更新地址，不必重新配对。

## 数据与访问

- 提示词、agent 输出，以及 agent 请求的文件内容和命令输出，都经加密通道在两台机器之间传输。brain 会把提示词和工具结果发给它自己的 agent provider，和那台机器上的普通会话一样。
- brain 上的 agent 仍保留 brain 的原生工具，可以在所选权限模式内，以 brain 上 Paseo 用户的身份读取和修改 brain 上的文件。配对设备可以回应这个 agent 的权限请求，所以只邀请你信任的设备。
- 多台设备共用一个 brain 时，各设备的会话在那台 brain 的 Paseo 里彼此可见。
- 插件用 daemon 的本地凭据连接本机 Paseo daemon，来创建和管理 agent；密钥和已配对设备保存在 Paseo 的插件数据目录里。

## 可选的直连

实验性的 EasyTier 直连可以在配对后代替 relay 传输流量，需要两台机器都开启，并自建会合节点。设置项会提示开启后将下载 EasyTier 程序，来源是它的 GitHub releases 或镜像；也可以自己导入官方 ZIP。插件会先核对固定的哈希值，再解压和启动程序。

## 限制

- 模型仍可能调用 brain 的原生工具而不是 hand 的工具，因此部分操作可能发生在 brain 上。
- 请求和工具输出单帧上限 128 KiB。写入或命令执行中途断线时，结果可能未知。
- Claude 已通过跨机器测试；Codex、Antigravity、Grok、Kimi 和 Pi 已通过跨机器读文件检查。
- 尚未在真实的 Windows 机器上测试 hand。
