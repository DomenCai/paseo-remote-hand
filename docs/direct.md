# EasyTier 直连底层

这组模块可独立运行，插件入口仍使用 M0 relay。没有配置会合 peers 时，默认不尝试下载或启动 EasyTier。

`server/direct/easytier-release.ts` 记录 [EasyTier v2.6.4 官方附件](https://github.com/EasyTier/EasyTier/releases/tag/v2.6.4)的完整 URL、ZIP 和所需成员的 SHA-256。安装缓存位于插件状态目录的 `easytier/v2.6.4/<平台>-<架构>`，支持 macOS arm64/x64、Linux x64/arm64 和 Windows x64。只解压固定成员，每次启动前复核缓存。EasyTier 按 LGPL v3 作为独立子进程运行，插件不打包它的二进制。上游[源码](https://github.com/EasyTier/EasyTier/tree/v2.6.4)和[许可证](https://github.com/EasyTier/EasyTier/blob/v2.6.4/LICENSE)对应同一标签。

## 复跑

使用 Node 22.18+，从插件根目录运行：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:direct
```

`npm run test:direct` 会获取本平台的官方 ZIP。已有 ZIP 时可用 `EASYTIER_TEST_ZIP=/absolute/path/to/release.zip npm run test:direct`，两种方式都校验摘要。测试不使用公网 peers 或 STUN。它启动本机双实例，先验证四个仿真服务在正对照中均能收到并回包，然后开启 ACL 验证两方向的 TCP、UDP 探针均到不了目标服务。同一测试覆盖允许入口的 M0 认证、96 KiB payload、错误密钥、未知和撤销设备、进程退出清理。

## 生命周期和接入

1. 在已认证的 relay 连接上发起协商。brain 用 `newDirectNetwork()` 为本代创建网络名和密钥，只经此 relay 通道传给 hand；双方各自读取已配置的会合 URL。不要记录网络名和密钥。
2. Brain 用 `listenDirect(keys, accept, signal)` 获得回环入口端口；`accept` 复用实际 M0 handler，并在正式接入时要求直连认证的设备 ID 与发起协商的 relay 连接相同。
3. 两端调用 `startEasyTier({ role, network, brainPort, peers, stateDir, signal })`。默认不配置物理入站 listener；测试才显式监听 loopback peers。进程启动检查只代表本地 ACL、代理和所需转发已初始化。Hand 使用返回的 `forwardPort` 调用 `connectDirect`，等 Noise NK 和设备认证成功后才标记直连可用。
4. 只为新请求和新流选择已经认证的直连 `Peer`。已有请求和流留在原通道，直连断开后只把新流量发往 relay。撤销由同一设备授权表处理，同时取消该代协商、监听器、连接和 EasyTier 实例。用实例的 `signal` 或 `closed` 观察意外退出。
5. 配置文件只在子进程启动期限内存在。POSIX 上实例目录为 `0700`，配置文件为 `0600`；网络秘密不在命令行、插件日志或持久设置中。正常关闭及启动失败会回收进程和文件；宿主被强杀时，操作系统不保证运行清理回调。

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
