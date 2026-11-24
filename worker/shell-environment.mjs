import { basename, isAbsolute, join } from 'node:path';
import { access, chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';

export const quotePosix = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function resolvePosixShell(options = {}) {
  if (options.signal?.aborted) throw new Error('Tunnel cancelled');
  let accountShell;
  try {
    accountShell = userInfo().shell;
  } catch {
    /* 账户没有可用 shell 时使用系统默认值。 */
  }
  const supported = (value) =>
    typeof value === 'string' &&
    isAbsolute(value) &&
    !/[\0\r\n]/.test(value) &&
    /^(?:zsh|bash)$/.test(basename(value));
  // 命令使用 POSIX 语法；账户默认 shell 不受支持时改用系统的 zsh 或 bash。
  const path =
    options.shellPath ??
    [process.env.SHELL, accountShell].find(supported) ??
    (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  if (!supported(path))
    throw new Error('Expected an absolute path to zsh or bash');
  const resolved = await realpath(path).catch(() => {
    throw new Error('Login shell was not found');
  });
  await access(resolved, constants.X_OK).catch(() => {
    throw new Error('Login shell is not executable');
  });
  if (options.signal?.aborted) throw new Error('Tunnel cancelled');
  // 保留已验证的调用名；解析符号链接后的文件名可能带有版本后缀。
  return path;
}

// 登录 shell 初始化后用私有 Unix socket 返回环境 JSON；启动脚本输出走各自的 stdout/stderr。
export async function captureShellEnvironment(
  shell,
  supervisor,
  { signal, timeoutMs = 10000, maxBytes = 1024 * 1024, env = process.env, cwd } = {},
) {
  if (signal?.aborted) throw new Error('Tunnel cancelled');
  // macOS 的 Unix socket 路径限制为 104 字节；TMPDIR 过长时用 /tmp。
  const root =
    Buffer.byteLength(join(tmpdir(), 'cc-env-123456', 'env.sock')) < 100 ? tmpdir() : '/tmp';
  const directory = await mkdtemp(join(root, 'cc-env-'));
  const socketPath = join(directory, 'env.sock');
  const nonce = randomBytes(24).toString('hex');
  const sockets = new Set();
  let receive;
  const server = createServer((socket) => {
    if (sockets.size) return socket.destroy();
    sockets.add(socket);
    socket.on('error', () => {});
    receive?.(socket);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    if (signal?.aborted) throw new Error('Tunnel cancelled');
    return await new Promise((resolve, reject) => {
      const baseEnvironment = { ...env };
      delete baseEnvironment.ELECTRON_RUN_AS_NODE;
      // 路径和随机数作为参数传给固定脚本。
      const script = `const [p,n]=process.argv.slice(-2);const s=require('node:net').createConnection(p);s.on('error',()=>process.exit(1));s.once('connect',()=>s.end(JSON.stringify({nonce:n,environment:process.env})));`;
      const command = `exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quotePosix(process.execPath)} -e ${quotePosix(script)} ${quotePosix(socketPath)} ${quotePosix(nonce)}`;
      const child = supervisor.spawn(shell, ['-lic', command], {
        env: baseEnvironment,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      let childClosed = false;
      let received = false;
      let bytes = 0;
      let noise = 0;
      const output = [];
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) void child.stopGroup();
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(new Error('Tunnel cancelled'));
      const timer = setTimeout(
        () => finish(new Error('Login shell initialization timed out')),
        timeoutMs,
      );
      signal?.addEventListener('abort', cancel, { once: true });
      receive = (socket) => {
        socket.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) return finish(new Error('Login shell environment exceeded the size limit'));
          output.push(chunk);
        });
        socket.once('end', () => {
          received = true;
          complete();
        });
      };
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          noise += chunk.length;
          if (noise > maxBytes) finish(new Error('Login shell startup output exceeded the size limit'));
        });
      child.once('error', (error) =>
        finish(
          new Error(
            `Could not start the login shell (${error.code ?? 'unknown error'})`,
          ),
        ),
      );
      child.once('close', (code, signal) => {
        childClosed = true;
        if (code !== 0)
          return finish(
            new Error(
              `Login shell did not return its environment (${signal ?? `exit ${code}`})`,
            ),
          );
        complete();
      });
      function complete() {
        if (settled || !received || !childClosed) return;
        try {
          const captured = JSON.parse(Buffer.concat(output).toString('utf8'));
          if (captured.nonce !== nonce) throw new Error();
          const environment = captured.environment;
          if (!environment || Array.isArray(environment) || typeof environment !== 'object')
            throw new Error();
          for (const [key, value] of Object.entries(environment))
            if (typeof value !== 'string' || /[\0=]/.test(key) || value.includes('\0'))
              throw new Error();
          delete environment.ELECTRON_RUN_AS_NODE;
          // 禁用非交互 shell 的启动钩子，避免每条命令都重复加载配置。
          delete environment.BASH_ENV;
          delete environment.ENV;
          finish(undefined, environment);
        } catch {
          finish(new Error('Login shell returned an invalid environment'));
        }
      }
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
