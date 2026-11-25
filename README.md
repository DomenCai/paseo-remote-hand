# Remote hand

Remote hand 是 Paseo 插件。**hand** 是保存项目的本机，**brain** 是运行 agent 的机器；每台机器可以同时承担两种角色。在 hand 上选择 `remote-hand` 和远端模型，所选 provider 的会话在 brain 运行，项目读写和命令由 hand 的工具执行。

两端通过插件自己的 relay 端点建立 protected Noise 通道。默认使用 `relay.paseo.sh:443`，自建 relay 需提供同样的 v2 协议和有效 TLS。无需启用 Paseo daemon 的 relay，也无需交换 daemon 配对链接。配对码五分钟内有效，只能使用一次；通过私密渠道交给预期设备。 可在两端启用 [EasyTier 直连](docs/direct.md)；配对仍走已配置的 relay。

## 安装

两端都安装 Paseo 0.17.3 并启用插件。brain 需要能在 Paseo 内运行所选 provider。插件会为自己的会话注入 MCP；无需开启 daemon 的 MCP 注入或 Claude 的 Paseo Tools。在插件目录执行：

```sh
npm ci --omit=dev --ignore-scripts
paseo plugin install "$PWD"
```

也可用 `paseo plugin install 'git:<owner>/<repo>'`，再用 `paseo plugin ls remote-hand --json` 找到安装目录的 `path`。开发时改动服务端后执行 `paseo plugin reload remote-hand`。

## 配对与撤销

以下命令在各自的插件目录中执行。开发工具只连接本机 daemon；如果使用自定义 Paseo home，先将 `PASEO_HOME` 设为该实例的目录。

1. 在 **brain** 查看端点，等 `status` 为 `connected` 后发出邀请。

   ```sh
   node dev/rpc.mjs endpoint.get
   node dev/rpc.mjs devices.invite '{"label":"My hand"}'
   ```

2. 在 **hand** 将配对码读入 shell 临时变量，从标准输入传给预览。以下读入命令适用于 zsh 和 bash。不要将配对码写进命令历史。

   ```sh
   read -rs pairing_code
   printf '%s' "$pairing_code" | node -e 'console.log(JSON.stringify({pairingCode:require("node:fs").readFileSync(0,"utf8")}))' | node dev/rpc.mjs brains.preview -
   ```

3. 核对预览结果后添加 brain。若预览有风险，阅读文案并将确认的 code 放入 `acknowledgedRiskCodes`；下例适用于无风险提示的预览。

   ```sh
   printf '%s' "$pairing_code" | node -e 'console.log(JSON.stringify({pairingCode:require("node:fs").readFileSync(0,"utf8"),name:"My brain",acknowledgedRiskCodes:[]}))' | node dev/rpc.mjs brains.add -
   unset pairing_code
   node dev/watch.mjs brains.watch
   ```

4. 在 **brain** 查看并撤销设备，使用快照里对应的 `deviceId`。在 hand 的订阅中可以看到该 brain 随后变为 `revoked`。

   ```sh
   node dev/watch.mjs devices.watch --once
   node dev/rpc.mjs devices.revoke '{"deviceId":"<deviceId>"}'
   ```

`brains.remove` 删除本地设备密钥和 brain 记录，并尝试撤销远端身份。返回 `remoteRevoked: false` 时，本地已移除，但远端撤销仍未获得确认，可在 brain 的设备列表上再撤销。

brain 可用 `node dev/rpc.mjs endpoint.set-relay '{"relay":"relay.example.com:443"}'` 切换 relay。切换前会通知在线的 hand 保存新地址并自动重连；已有端点密钥和设备身份保留，未使用的旧邀请失效。运行 `node dev/watch.mjs endpoint.watch` 查看注册状态；注册失败时，可从快照的 `lastError` 查看原因。

切换时离线的 hand 可以从 brain 复制新 `host:port`，保留现有身份手动重连：

```sh
node dev/rpc.mjs brains.set-relay '{"brainId":"<brainId>","relay":"relay.example.com:443"}'
```

## 使用

1. 在 hand 上运行 `paseo provider models remote-hand`，复制一个形如 `<brainId>/<provider>/<model>` 的模型 ID。也可在 `node dev/watch.mjs brains.watch --once` 的 `models` 中查看。brain 的「已连接设备」可限制开放的 provider；开启「允许全部 provider」时，目录列出 brain 上可用的模型。
2. 从 hand 的项目目录发起会话。例如：

   ```sh
   paseo run --no-wait --new-workspace local --provider remote-hand \
     --model '<brainId>/claude/<model>' --cwd "$PWD" \
     '读取 README 第一行，然后运行 ls，报告结果'
   ```

   加 `--new-workspace local` 会按指定目录新建 workspace。省略这个选项时，Paseo 可能沿用当前 agent 或终端的 workspace。

   省略 `--mode`，或在 App 里选择 **Use brain default**，由 brain 根据所选 provider 决定 mode。新建会话时，App 的 mode 列表合并各个 brain 提供的选项；手动选择时，请使用目标 provider 支持的 mode。Cursor 的 hand 工具仍会请求审批。
3. 用命令返回的 **hand agent ID** 查看时间线、等待或停止；如果出现权限请求，用对应请求 ID 应答。

   ```sh
   paseo wait <agentId>
   paseo logs <agentId>
   paseo stop <agentId>
   paseo permit ls
   paseo permit allow <agentId> <requestId>
   ```

受限档是默认值。新会话会授权该项目的真实路径，文件工具只可访问已授权项目，`hand_bash` 被拒绝。需要在 hand 运行命令时，可以把该 brain 切为完全档：

```sh
node dev/rpc.mjs brains.set-policy '{"brainId":"<brainId>","policy":"full"}'
```

完全档允许该 brain 通过 hand 工具访问运行 daemon 的用户能访问的文件和 shell。只对信任的 brain 启用。要恢复受限档，把 `policy` 改回 `restricted`。

## 卸载

1. 在 hand 使用 `brains.remove` 移除各 brain。若远端撤销未确认，在对应 brain 用 `devices.revoke` 撤销。
2. 在各机器执行 `paseo plugin remove remote-hand`。插件状态目录会保留，以便重新安装时复用身份。

## 已知问题

- Brain 的原生工具仍可用。插件通过系统提示或首条用户消息说明项目位置和 `hand_*` 工具；模型可能仍调用 brain 的原生工具。时间线里的工具前缀由所选 provider 决定。受限档约束的是 hand 的工具。
- 目录和工具输出走 relay；普通请求和开流参数有 128 KiB 帧上限。断线时正在执行的写入或命令可能结果未知，先核对项目和时间线再重试。
- 最大设备并发数目前可保存，在这一阶段尚不限制任务。Claude 已通过跨机验收；其他 provider 的跨机验收待完成。

## 状态与开发

端点和设备状态保存在 `$PASEO_HOME/plugin-data/remote-hand/state.json`。在 POSIX 上目录权限为 `0700`，状态文件为 `0600`。移除插件后目录保留，以便重新安装时复用身份。不要复制或分享该目录。

运行本地类型检查和设备认证测试（测试需 Node 22.18+）：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

M1a 接入可参考[应用协议](docs/protocol.md)。可选直连的底层测试与接入说明见 [EasyTier 直连](docs/direct.md)。

## 许可证

[Apache-2.0](LICENSE)。原项目署名见 [NOTICE](NOTICE)。依赖沿用各自的许可证。
