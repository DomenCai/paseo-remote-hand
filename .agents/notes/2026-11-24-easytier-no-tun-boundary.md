# EasyTier no-tun 直连入口使用固定转发

状态：已采用。范围：EasyTier v2.6.4，Remote hand 的独立直连网络。

no-tun 会把到本机虚拟 IP 的 TCP 和 UDP 改投 `127.0.0.1:原端口`，见上游 [tcp_proxy.rs](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/gateway/tcp_proxy.rs#L754-L771) 和 [udp_proxy.rs](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/gateway/udp_proxy.rs#L308-L315)。因此，应用监听在回环地址不足以避免暴露；两端都需要显式的入站默认拒绝 ACL。允许本机发起的连接收到回包，由 EasyTier 的 [acl_filter.rs](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/peers/acl_filter.rs#L354-L388) 处理。

hand 只需一个固定 TCP 目标，所以使用 no-tun 的 `[[port_forward]]`。SOCKS5 能接受可变目的地，但 v2.6.4 的 `--socks5` 默认监听 `0.0.0.0`；即使配置成回环，仍然提供通用目标选择。固定转发没有这个需求。[对应的连接器](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/gateway/socks5.rs#L278-L291) 在本机路由表查不到目的虚拟 IP 时，会用系统网络直接连固定目的地址；v2.6.4 没有关闭它的配置项。路由主要在启动后、经会合节点或直连同步到对端信息之前缺失。实测本机 hand 在这段时间连转发端口，easytier-core 出现内核连接 `192.168.16.248 → <brain 虚拟 IP>:<入口端口>`，开着 fake-ip 的代理会接走它。

因此 hand 不在启动后立即连 TCP 转发。[UDP 转发](https://github.com/EasyTier/EasyTier/blob/v2.6.4/easytier/src/gateway/socks5.rs#L972-L984) 对非本机目的地址总是经虚拟网络的 smoltcp 发送，没有系统网络回落；brain 用回环 UDP 只应答本代网络名，ACL 只放行 hand 虚拟 IP 到该端口。hand 收到应答说明本机已有对端路由且 p2p 数据通路可用，再连 TCP 转发。管理 RPC 仍不对回环开放；info 日志没有"路由已同步"的稳定标志，"new peer added" 也会因会合节点触发，所以没有用日志判断。本机三实例（会合节点、brain、hand）复测：不等探测时 hand 出现 1 条发往虚拟网段的 `SYN_SENT`，等探测后多次运行均为 0。

转发 socket 连上仍不代表直连就绪，必须等 Noise 密钥校验和 M0 设备认证成功。虚拟网段改为 TEST-NET-2/3 的 /30，并按两端网卡避让，见[直连文档](../../docs/direct.md)。

升级 EasyTier 时，重新跑[双向 ACL 正负对照](../../server/direct/direct.test.ts)，尤其保留“允许 TCP 的同一数字端口必须拒绝 UDP”这一项。配置和操作方式见[直连文档](../../docs/direct.md)。
