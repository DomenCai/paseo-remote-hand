import { createRequire } from 'node:module';

// CVE-2025-70034：服务端在认证前直接丢弃 hostkeys 请求，且不协商压缩。
const require = createRequire(import.meta.url);
const { version } = require('ssh2/package.json');
if (version !== '1.17.0') throw new Error('ssh2 hardening requires review for ssh2 upgrades.');
// 源码： https://github.com/mscdex/ssh2/blob/v1.17.0/lib/protocol/handlers.js
const handlers = require('ssh2/lib/protocol/handlers.js');
const GLOBAL_REQUEST = 80;
const original = handlers[GLOBAL_REQUEST];
const HOSTKEYS = 'hostkeys-00@openssh.com';
if (typeof original !== 'function') throw new Error('ssh2 hardening: unexpected ssh2 internals.');
if (!original.hardened) {
  const handler = (self, payload) => {
    // 帧头依次是消息类型和请求名长度；其他请求交回 ssh2。
    if (payload.length >= 5) {
      const length = payload.readUInt32BE(1);
      if (length === HOSTKEYS.length && payload.toString('latin1', 5, 5 + length) === HOSTKEYS)
        return;
    }
    return original(self, payload);
  };
  handler.hardened = true;
  handlers[GLOBAL_REQUEST] = handler;
}

// Server 与补丁使用同一个 require 实例。
export const ssh2 = require('ssh2');
export const serverAlgorithms = { compress: ['none'] };
