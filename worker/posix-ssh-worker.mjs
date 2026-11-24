// 移植自 CC Desk Tunnel；Apache-2.0，见上级 NOTICE 和 LICENSE。
import { timingSafeEqual } from 'node:crypto';
import { access, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { ProcessSupervisor } from './process-supervisor.mjs';
import { ssh2, serverAlgorithms } from './ssh2-hardening.mjs';
import { captureShellEnvironment, resolvePosixShell } from './shell-environment.mjs';
import { repairChannelOutput } from './ssh-channel-output.mjs';

const { Server, utils } = ssh2;

const supervisor = new ProcessSupervisor();
const controller = new AbortController();
const sockets = new Set();
let listener;
let closing;
let started = false;
let active = 0;

async function close() {
  if (closing) return closing;
  closing = (async () => {
    controller.abort();
    for (const socket of sockets) socket.destroy();
    const stopped = listener
      ? new Promise((resolve) => listener.close(resolve))
      : Promise.resolve();
    await supervisor.close();
    await stopped;
  })();
  return closing;
}

async function shutdown() {
  await close();
  if (process.connected) process.disconnect();
}
process.once('disconnect', shutdown);
for (const name of ['SIGTERM', 'SIGINT']) process.once(name, shutdown);
process.on('message', (message) => {
  if (message.type === 'close') void shutdown();
  if (message.type === 'start' && !started && !closing) {
    started = true;
    void start(message).catch(async (error) => {
      if (process.connected) process.send({ type: 'failed', message: error.message });
      await shutdown();
    });
  }
});

// 复用系统 OpenSSH 的 SFTP 服务端。
const SFTP_SERVERS = [
  '/usr/libexec/sftp-server',
  '/usr/lib/openssh/sftp-server',
  '/usr/libexec/openssh/sftp-server',
  '/usr/lib/ssh/sftp-server',
];
async function systemSftp() {
  for (const path of SFTP_SERVERS)
    if (
      await access(path, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return path;
  throw new Error('System sftp-server not found');
}

async function start({ socketPath, clientPublicKey }) {
  const shell = await resolvePosixShell({ signal: controller.signal });
  const directory = homedir();
  const sftpPath = await systemSftp();
  const allowed = utils.parseKey(clientPublicKey);
  if (allowed instanceof Error || Array.isArray(allowed) || allowed.type !== 'ssh-ed25519')
    throw new Error('Expected one Ed25519 client public key');
  const publicBytes = allowed.getPublicSSH();
  const environment = await captureShellEnvironment(shell, supervisor, {
    signal: controller.signal,
    cwd: directory,
  });
  if (controller.signal.aborted) throw new Error('Tunnel cancelled');
  const keys = utils.generateKeyPairSync('ed25519');
  const username = 'device';
  const server = new Server({
    hostKeys: [keys.private],
    algorithms: serverAlgorithms,
    keepaliveInterval: 10000,
    keepaliveCountMax: 2,
  });
  // ssh2 只接收私有 Unix socket；绝不调用 ssh2 Server.listen()。
  listener = createServer({ allowHalfOpen: true }, (socket) => {
    if (closing || sockets.size >= 128) return socket.destroy();
    sockets.add(socket);
    socket.setTimeout(10000, () => socket.destroy());
    socket.once('end', () => socket.end());
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    server.injectSocket(socket);
  });
  server.on('connection', (client) => {
    // ssh2 1.17.0 的 Unix socket 没有 IP/port，用同版本固定的底层 socket 找到连接。
    const socket = client._sock;
    if (!sockets.has(socket)) return client.end();
    socket.setTimeout(0);
    if (closing) return socket.destroy();
    const children = new Set();
    let attempts = 0;
    const authTimer = setTimeout(() => socket.destroy(), 10000);
    const cleanup = () => {
      clearTimeout(authTimer);
      for (const child of children) void child.stopGroup();
    };
    client.on('error', () => {
      cleanup();
      socket.destroy();
    });
    client.once('close', cleanup);
    client.on('authentication', (context) => {
      if (++attempts > 8) return socket.destroy();
      if (
        context.username !== username ||
        context.method !== 'publickey' ||
        context.key.algo !== allowed.type ||
        context.key.data.length !== publicBytes.length ||
        !timingSafeEqual(context.key.data, publicBytes) ||
        (context.signature &&
          allowed.verify(context.blob, context.signature, context.hashAlgo) !== true)
      )
        return context.reject(['publickey']);
      // 无签名探测仅回复 PK_OK；登录还需要用对应私钥签名。
      context.accept();
    });
    client.once('ready', () => clearTimeout(authTimer));
    client.on('request', (_accept, reject) => reject?.());
    client.on('tcpip', (_accept, reject) => reject());
    client.on('openssh.streamlocal', (_accept, reject) => reject());
    // 在接受请求前检查命令数量上限。
    const full = () => closing || active >= 128 || children.size >= 32;
    client.on('session', (accept, reject) => {
      if (full()) return reject();
      const session = accept();
      session.on('exec', (acceptCommand, rejectCommand, { command }) => {
        if (full()) return rejectCommand?.();
        const args =
          basename(shell) === 'bash'
            ? ['--noprofile', '--norc', '-c', command]
            : ['-f', '-c', command];
        attach(acceptCommand(), shell, args);
      });
      // 用原始 SSH channel 把 SFTP 字节交给系统的 sftp-server。
      session.on('subsystem', (acceptSubsystem, rejectSubsystem, { name }) => {
        if (name !== 'sftp' || full()) return rejectSubsystem?.();
        attach(acceptSubsystem(), sftpPath, []);
      });
      // 不注册 shell、PTY、env、X11 或 agent 请求，交给 ssh2 拒绝。
      function attach(channel, file, args) {
        if (!channel) return;
        repairChannelOutput(channel);
        const child = supervisor.spawn(file, args, {
          cwd: directory,
          env: environment,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.add(child);
        active++;
        // 命令退出后释放计数；输出描述符关闭时再结束 SSH channel。
        let counted = true;
        const release = () => {
          if (!counted) return;
          counted = false;
          children.delete(child);
          active--;
        };
        child.once('exit', release);
        channel.on('error', () => void child.stopGroup());
        channel.stderr.on('error', () => void child.stopGroup());
        channel.once('close', () => void child.stopGroup());
        child.stdin.on('error', () => {});
        channel.pipe(child.stdin);
        child.stdout.pipe(channel, { end: false });
        child.stderr.pipe(channel.stderr, { end: false });
        child.once('error', () => {
          release();
          channel.exit(127);
          channel.end();
        });
        child.once('close', (code, signal) => {
          release();
          // 等 stderr 写完，再发退出码并结束 stdout。
          channel.stderr.end(() => {
            if (signal) channel.exit(signal.replace(/^SIG/, ''), false, '');
            else channel.exit(code ?? 127);
            channel.end();
          });
        });
      }
    });
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(socketPath, resolve);
  });
  listener.on('error', () => {
    if (process.connected) process.send({ type: 'failed', message: 'SSH worker listener failed' });
    void shutdown();
  });
  await chmod(socketPath, 0o600);
  if (controller.signal.aborted) throw new Error('Tunnel cancelled');
  process.send({ type: 'ready', hostPublicKey: keys.public.trim().split(' ').slice(0, 2).join(' ') });
}
