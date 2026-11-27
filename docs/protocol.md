# Remote Hand 应用协议

Relay v2 为 brain 建立一条控制 WebSocket，为每个 hand 连接建立一条数据 WebSocket。应用帧只走强制 protected 的 Noise 通道，均为 UTF-8 JSON，单帧上限 128 KiB。

- 双方首帧为 `hello { protocolVersion: 1, pluginVersion, port?: true }`。协议版本必须相同；两端均支持 `port` 且设备认证成功后才开放应用端口和流帧。
- 请求为 `request { id, method, payload }`，成功返回 `response { id, payload }`，失败返回 `error { id, code, message? }`。`message` 只在 handler 抛出插件自己构造的 `ProtocolError` 时附上，例如 brain 的并发上限提示；其他异常一律只回 `failure`，不带文字，以免把本机细节发给对端。旧版收到 `message` 会忽略，仍显示该 code 的默认文字。各方向独立分配递增 ID，响应可乱序，最多 32 个请求在途。取消或超时会向支持端口的对端发送 `request.cancel { id }`，并取消 handler 的 signal。连接关闭后不重放请求。
- `describe` 可在认证前读取 `brainName`、`os`、`relay`、`risks`，预览不发送邀请秘密。`auth.challenge` 返回连接专用的 32 字节随机数，有效期 15 秒，每连接只允许一次认证尝试。
- `auth.pair` 发送 Ed25519 公钥、签名、邀请秘密、设备名和已确认风险码；`auth.resume` 只发送公钥和签名。签名覆盖 `["remote-hand/v1", purpose, fingerprint, challenge, ...]` 的 UTF-8 JSON，其中配对的 `purpose` 为 `pair`，并附邀请秘密的 SHA-256；重连使用 `reconnect`。
- 认证后可用 `ping` 或 `self.revoke`。brain 移除授权后发 `{type:"revoked"}` 并关闭设备连接；若通知丢失，下次认证返回 `revoked`。
- 切换 relay 时，brain 通过旧连接发 `relay.move { relay }`，最多等两秒。hand 校验并写入新地址后应答；旧连接写出应答后，hand 用原设备密钥和固定的 brain 公钥重连。未能收到通知的设备可以手动更新。

## 双向端口与流

`BrainService.port(deviceId)` 和 `HandService.port(brainId)` 返回当前认证连接上的 `ConnectionPort`，不可用时返回 `undefined`。两端都可调用 `request(method, params, signal?)`、`open(method, params, signal?)`，并用 `handle(method, handler)` 注册接收端。方法名及数据由应用层约定；普通 handler 返回 `Promise<Json>`，流 handler 返回 `AsyncIterable<Json>`。端口的 `signal` 在断线或撤销时取消，取消单个操作只影响对应 handler。

- `stream.open { streamId, requestId, method, payload }` 是流式请求，由读取方在第一次 `next()` 时发出。ID 以 `h:` / `b:` 区分发起方向。
- `stream.credit { streamId, bytes: 524288 }` 允许发送方拉取一个 JSON 事件；初始额度为零。每次 `next()` 只给一份额度，未用完的额度不结转。
- `stream.data { streamId, chunk, final }` 发送标准 base64 数据；每块解码后最多 32 KiB，`final` 标记当前 JSON 事件的最后一块。单事件解码后的 JSON 最多 512 KiB。
- `stream.credit { streamId, bytes: 0 }` 确认当前事件已交给下游的 `next()`，只释放发送方的连接窗口；下一次 `next()` 才补流额度。
- 每个方向最多 16 条流，共享 2 MiB 连接字节窗口。发送端在写第一块前为整个事件占用窗口，等待回执或 reset 才释放；接收端也校验实际缓冲总量。
- `stream.end { streamId }` 正常结束；`stream.reset { streamId, code }` 只取消对应流并释放窗口。迭代器 `return()` 会发送 reset，连接关闭则令所有未完成的流失败。
- 普通请求和 `stream.open` 的参数仍受 128 KiB 单帧限制；更大的业务参数需要在应用层分段。断线后由调用方决定是否用新端口重新发起操作。
