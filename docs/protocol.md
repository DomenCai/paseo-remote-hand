# Remote Hand 应用协议

1. relay v2 为 brain 建立一条控制 WebSocket，并为每个 hand 连接建立一条数据 WebSocket。应用帧只走强制 protected 的 Noise 通道。
2. M0 应用帧均为 UTF-8 JSON 文本对象，单帧上限 128 KiB，超限或非法帧关闭连接。
3. 每端第一帧是 `{type:"hello", protocolVersion:1, pluginVersion:"0.0.1"}`。协议版本必须相同；插件版本用于诊断。
4. 请求 `{type:"request", id, method, payload}`；成功响应 `{type:"response", id, payload}`；错误响应 `{type:"error", id, code}`。各方向独立分配递增 ID，响应可乱序。
5. 两个方向各最多 32 个在途请求；发送队列和底层 WebSocket 缓冲也有限额。超时移除等待者，迟到响应丢弃，请求不自动重放。
6. `describe` 是唯一无需身份即可读取的数据：`brainName`、`os`、`relay` 和 `risks`；预览连接不发送邀请秘密。
7. `auth.challenge` 返回当前连接专用的 32 字节随机数，以无填充 base64url 表示，有效期 15 秒，每连接最多一次认证尝试。
8. `auth.pair` 发送 Ed25519 公钥、签名、邀请秘密、设备名和已确认风险码；`auth.resume` 只发送公钥和签名。两者成功均返回 `{deviceId}`。
9. 签名数据是 UTF-8 JSON 数组 `["remote-hand/v1", purpose, fingerprint, challenge, ...]`。配对的 purpose 是 `pair`，末项另附邀请秘密的 SHA-256；重连使用 `reconnect`。
10. 认证后可用 `ping` 检测失活，或 `self.revoke` 自撤销。brain 在移除授权后发送 `{type:"revoked"}` 并关闭该设备所有连接；丢失通知时下次认证返回 `revoked`。
11. **M1a 预留，M0 不收发：** `stream.open {streamId,requestId}` 绑定请求；流 ID 在发送方向内唯一，多个流可交错。
12. `stream.data {streamId,chunk}` 携带 base64 编码数据，单块解码后最多 32 KiB；`stream.end {streamId}` 正常结束，`stream.reset {streamId,code}` 取消或报错。
13. `stream.credit {streamId,bytes}` 按解码后的字节数给额度。初始额度为零，接收端开流后发额度，只在下游消费后补发。发送端按额度扣减，超额视为协议错误。
14. M1a 的接收窗口按流和整条连接两级限制；流阻塞不得拦住其他流、请求响应、credit 或 reset。断线释放窗口和流状态，未确认的写操作不得自动重放。
