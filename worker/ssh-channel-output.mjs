import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('ssh2/package.json');
if (version !== '1.17.0')
  throw new Error('SSH channel output adapter requires review for ssh2 upgrades.');

// ssh2 1.17.0 的 stdout/stderr 共用发送窗口；清除已完成的回调并唤醒另一端，避免 stderr 饿死。
// 源码：https://github.com/mscdex/ssh2/blob/v1.17.0/lib/Channel.js
export function repairChannelOutput(channel) {
  const pending = new Set();
  const wrapped = new WeakSet();
  let closed = false;
  const outputs = [
    { stream: channel, chunk: '_chunk', callback: '_chunkcb' },
    { stream: channel.stderr, chunk: '_chunkErr', callback: '_chunkcbErr' },
  ];

  for (const [index, output] of outputs.entries()) {
    const write = output.stream._write;
    const other = outputs[1 - index];
    output.stream._write = function (data, encoding, callback) {
      // 窗口更新会用同一个回调重试 _write；只包装一次。
      if (wrapped.has(callback)) return write.call(this, data, encoding, callback);
      let completed = false;
      const done = (error) => {
        if (completed) return;
        completed = true;
        pending.delete(done);
        channel[output.chunk] = undefined;
        channel[output.callback] = undefined;
        callback(error);
        if (closed || channel.outgoing.state !== 'open' || !channel[other.chunk]) return;
        // 恢复写入后若窗口仍有余额，立即交给另一条阻塞的流。
        if (channel.outgoing.window > 0)
          other.stream._write(channel[other.chunk], null, channel[other.callback]);
        else channel._waitWindow = true;
      };
      wrapped.add(done);
      pending.add(done);
      if (closed) return done(new Error('SSH output channel closed'));
      return write.call(this, data, encoding, done);
    };
  }

  channel.once('close', () => {
    closed = true;
    // SSH channel 关闭时主动结束待写回调，释放缓冲并通知错误处理。
    for (const done of pending) done(new Error('SSH output channel closed'));
    channel._waitWindow = false;
  });
}
