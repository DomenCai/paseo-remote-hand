# Remote hand

Remote hand 是 Paseo 插件。**hand** 是保存项目的本机，**brain** 是运行 agent 的机器；每台机器可以同时承担两种角色。当前 M0 提供独立 relay 端点、一次性配对、设备重连和撤销。远端 agent 与本机工具执行由后续阶段接入。

两端通过插件自己的 relay 端点建立 protected Noise 通道。默认使用 `relay.paseo.sh:443`，自建 relay 需提供同样的 v2 协议和有效 TLS。无需启用 Paseo daemon 的 relay，也无需交换 daemon 配对链接。配对码五分钟内有效，只能使用一次；通过私密渠道交给预期设备。

## 安装

两端都安装 Paseo 0.17.3 并启用插件。在插件目录执行：

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

brain 可用 `node dev/rpc.mjs endpoint.set-relay '{"relay":"relay.example.com:443"}'` 切换 relay。已有端点密钥和设备身份保留，未使用的旧邀请失效。hand 持有旧地址时，先在 brain 撤销旧的设备登记，再在 hand 移除旧条目，用新邀请重新配对。

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
