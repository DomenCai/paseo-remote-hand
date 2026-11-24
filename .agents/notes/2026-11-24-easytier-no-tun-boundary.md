# EasyTier no-tun 直连入口使用固定转发

状态：已采用。范围：EasyTier v2.6.4，Remote hand 的独立直连网络。

no-tun 会把到本机虚拟 IP 的 TCP 和 UDP 改投 `127.0.0.1:原端口`，见上游 [tcp_proxy.rs](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/gateway/tcp_proxy.rs#L754-L771) 和 [udp_proxy.rs](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/gateway/udp_proxy.rs#L308-L315)。因此，应用监听在回环地址不足以避免暴露；两端都需要显式的入站默认拒绝 ACL。允许本机发起的连接收到回包，由 EasyTier 的 [acl_filter.rs](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/peers/acl_filter.rs#L354-L388) 处理。

hand 只需一个固定 TCP 目标，所以使用 no-tun 的 `[[port_forward]]`。SOCKS5 能接受可变目的地，但 v2.6.4 的 `--socks5` 默认监听 `0.0.0.0`；即使配置成回环，仍然提供通用目标选择。固定转发没有这个需求。[对应的连接器](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/gateway/socks5.rs#L278-L291) 在虚拟路由尚不可用时会尝试直接连接固定目的地址。因此，转发 socket 连上不代表直连就绪，必须等 Noise 密钥校验和 M0 设备认证成功。

升级 EasyTier 时，重新跑[双向 ACL 正负对照](../../server/direct/direct.test.ts)，尤其保留“允许 TCP 的同一数字端口必须拒绝 UDP”这一项。配置和操作方式见[直连文档](../../docs/direct.md)。
