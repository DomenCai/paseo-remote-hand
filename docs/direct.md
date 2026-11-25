# EasyTier 直连

配对、设备认证和链路协商都从 Paseo relay 开始。两端都启用直连并配置至少一个会合 peer 时，插件才下载和启动 EasyTier。直连再次验证 brain 公钥和 hand 设备身份。验证完成后，新请求和流优先使用直连；已有操作留在原链路。直连断开后新操作回落到 relay。关闭直连、设备撤销或认证 relay 断开时，结束本代的直连和 EasyTier 实例。

在两台机器各自的插件目录运行：

```sh
node dev/rpc.mjs direct.get
node dev/rpc.mjs direct.set '{"enabled":true,"peers":["udp://meet.example.com:11010","tcp://meet.example.com:11010"]}'
node dev/watch.mjs direct.watch
node dev/watch.mjs brains.watch
```

`direct` 是机器级设置，同时用于本机的 hand 和 brain。默认是 `{"enabled":false,"peers":[]}`。可将 `enabled` 设为 `false` 暂时回到 relay，保留 peers 供下次使用。hand 的 `brains.watch` 显示当前首选链路；brain 的 `endpoint.watch` 可看到本地 EasyTier 启动错误。下载、校验或建链失败时 relay 仍可用，hand 的 `lastError` 显示失败原因。更新任一端直连设置，或重新认证 relay，即可再发起协商。

## 安装 EasyTier

`server/direct/easytier-release.ts` 记录 [EasyTier v2.6.4 官方附件](https://github.com/EasyTier/EasyTier/releases/tag/v2.6.4)的文件名、ZIP 和所需成员的 SHA-256。摘要固定，因此 ZIP 从哪里来都一样安全：摘要相符才安装，不符就拒绝。安装缓存位于插件状态目录的 `easytier/v2.6.4/<平台>-<架构>`，支持 macOS arm64/x64、Linux x64/arm64 和 Windows x64。只解压固定成员，每次启动前复核缓存。EasyTier 按 LGPL v3 作为独立子进程运行，插件不打包它的二进制。上游[源码](https://github.com/EasyTier/EasyTier/tree/v2.6.4)和[许可证](https://github.com/EasyTier/EasyTier/blob/v2.6.4/LICENSE)对应同一标签。

缓存缺失时，协商直连会触发下载：

- 下载源按 `easyTierSources` 的顺序尝试：先 GitHub 官方，再镜像 `https://dl.fullai.top/easytier`，新镜像追加在后面。每个源提供 `<base>/v2.6.4/<官方 ZIP 文件名>`，加一行 base 即可生效。连接失败、20 秒没有新数据、单源超过 10 分钟、HTTP 非 200、超过 40 MiB 或摘要不符，都换下一个源；全部失败时，错误按顺序列出每个源的主机和原因，例如 `EasyTier download failed: github.com stalled; mirror.example.com HTTP 404.`。
- DNS 结果 IPv4 优先，IPv4 不通时仍可回到 IPv6。只影响这次下载，不改进程全局的 DNS 顺序。
- 有 `HTTPS_PROXY`/`HTTP_PROXY`（或小写形式）时经 HTTP 代理下载：HTTPS 源用 `CONNECT` 隧道，明文源用绝对 URL 转发，支持 `user:pass@` 基本认证；`NO_PROXY` 按主机名后缀跳过代理。只支持 `http://` 代理，其他协议的代理会让该源失败并写明原因。变量取自 Paseo daemon 进程的环境。
- 同一状态目录同时只有一个安装任务，多个连接共用它。任务不随某次协商取消，由上述停滞和单源时限收尾，因此协商放弃后下载仍会完成，下次协商直接使用缓存。协商侧的安装等待上限是 15 分钟，只防止协商永远挂起。

设置页的直连区块订阅 `easytier.watch`，显示组件为未安装、下载中（含进度）、已就绪或失败（含原因）。失败或下载中时，区块给出官方 ZIP 链接和路径输入框，调用 `easytier.import` 手动导入。Paseo 插件客户端 SDK 0.17.3 没有文件选择器，所以粘贴本机绝对路径，可用 `~/` 开头。导入先完整校验摘要，不符时直接拒绝，进行中的下载不受影响；校验通过后取代进行中的下载并安装，原来等待下载的协商改用导入结果。缓存已就绪时导入直接成功，不读取文件。

```sh
node dev/watch.mjs easytier.watch
node dev/rpc.mjs easytier.import '{"path":"~/Downloads/easytier-macos-aarch64-v2.6.4.zip"}'
```

## 复跑

使用 Node 22.18+，从插件根目录运行：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:direct
```

`npm run test:direct` 会获取本平台的官方 ZIP。已有 ZIP 时可用 `EASYTIER_TEST_ZIP=/absolute/path/to/release.zip npm run test:direct`，两种方式都校验摘要。下载测试用本机 HTTP 服务模拟停滞、摘要不符和 HTTP 500，确认依次换源且错误列出每个源的原因；提供 `EASYTIER_TEST_ZIP` 时还验证经 302 回落到可用源，以及停滞的下载被手动导入取代。测试不使用公网 peers 或 STUN。它启动本机双实例，先验证四个仿真服务在正对照中均能收到并回包，然后开启 ACL 验证两方向的 TCP、UDP 探针均到不了目标服务。同一测试覆盖允许入口的 M0 认证、96 KiB payload、错误密钥、未知和撤销设备、进程退出清理。

## 生命周期

1. hand 从已认证的 relay 发送 `direct.offer`。brain 为该代生成临时网络名和密钥，通过该加密连接返回。两端各自采用本机配置的会合 URL。
2. brain 的回环入口只接收和 relay 相同的设备身份。hand 在 EasyTier 转发上完成 Noise NK 和设备认证，安装入站 handler 后发送 `direct.ready`。brain 安装 handler 并发出确认，两端才启用直连出站。
3. 应用端口和授权仍跟随原 relay 的生命周期。链路切换不会替换端口或移动在途操作。断掉的时间线流可以从已接收的游标续订；业务请求和工具不自动重发。工具的新建流在插件日志记录 `Remote hand tool.call transport=direct` 或 `transport=relay`，日志不包含调用参数。
4. POSIX 上实例目录为 `0700`，启动配置文件为 `0600`。网络秘密不在命令行、插件日志或持久设置中。正常关闭及启动失败会回收进程和文件；宿主被强杀时，操作系统不保证运行清理回调。

实例只启用 no-tun 和指定端口的固定转发。Hand 拒绝所有新入站；brain 只接收对端虚拟 IP 发往直连入口的 TCP。两端都拒绝转发其他入站流量。管理 RPC 服务在 v2.6.4 总会创建，因此显式绑定回环，并使用不匹配回环客户端地址的白名单。见 [no-tun 入口取舍与源码](../.agents/notes/2026-11-24-easytier-no-tun-boundary.md)。

## 建议的会合节点配置

会合节点使用独立的网络名和密钥，不与插件的临时网络共享。配置只添加明确要监听的 TCP/UDP 端口，不配置虚拟出口、子网代理或端口转发。将公开地址填为两端的 peer URL，可填多个，例如 `udp://meet.example.com:11010`、`tcp://meet.example.com:11010`。管理 RPC 保持回环，并限制客户端。用主机防火墙和服务资源限制约束公开的会合流量。

例如，运维人员可为单个会合节点准备以下私有文件，把网络名和密钥替换成节点自己的随机值：

```toml
instance_name = "remote-hand-rendezvous"
listeners = ["udp://0.0.0.0:11010", "tcp://0.0.0.0:11010"]

[network_identity]
network_name = "<operator-network-name>"
network_secret = "<operator-network-secret>"

[flags]
no_tun = true
private_mode = false
disable_upnp = true
relay_network_whitelist = ""
relay_all_peer_rpc = true
disable_relay_data = true
```

用已校验的二进制启动：

```sh
/path/to/easytier-core --config-file /path/to/rendezvous.toml \
  --disable-env-parsing --no-tun --relay-network-whitelist --relay-all-peer-rpc \
  --rpc-portal 127.0.0.1:15888 --rpc-portal-whitelist 192.0.2.1/32 \
  --console-log-level warn --file-log-level off
```

空白名单不同于省略，省略默认为 `"*"`；`disable_relay_data` 在 v2.6.4 通过 TOML 设置。保持客户端 `p2p_only = true`，因此没有直连时业务走已有的 Paseo relay。

上游 [foreign_network_manager.rs:949](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/peers/foreign_network_manager.rs#L949-L985) 在开启 `relay_all_peer_rpc` 时允许空白名单以外的网络建立会合连接，但按白名单结果保存 data relay 权限。[转发路径](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/peers/foreign_network_manager.rs#L535-L552) 在 data 未获准或禁用时直接丢弃。[客户端代理发送路径](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/peers/peer_manager.rs#L1451-L1464) 还会检查目的 peer 是否直接相连。这是 v2.6.4 的源码依据，尚未在公网部署或测流量计数。

## macOS 实测

macOS 27.0.1，Apple Silicon。用 `curl` 下载 ZIP 并解出 core 后，两种架构的文件都没有 `com.apple.quarantine`。arm64 为 ad-hoc 签名，`codesign --verify --strict` 成功；x86_64 无签名。两者均被 `spctl --assess --type execute` 拒绝（退出 3），但未加隔离属性的文件从本机终端执行 `--version` 都成功，x86_64 通过 Rosetta 运行。把隔离属性加到测试副本后，arm64 在 3.5 秒内未返回版本（测试终止），x86_64 被 SIGKILL；两份副本的 `spctl` 结果仍为拒绝。插件不会移除隔离属性，也不会重新签名。正式启用前需在实际 Paseo 宿主和目标操作系统上复测。
