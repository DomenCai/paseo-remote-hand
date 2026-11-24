import { spawn } from 'node:child_process';

// 每条命令在独立进程组中运行；关闭时等待整个组退出，避免命令留在后台。
export class ProcessSupervisor {
  #groups = new Set();
  #closed = false;
  #closePromise;

  constructor({ graceMs = 1000 } = {}) {
    this.graceMs = graceMs;
  }

  spawn(file, args, options = {}) {
    if (this.#closed) throw new Error('Executor closed');
    const child = spawn(file, args, { ...options, detached: true });
    const group = { child, stopPromise: undefined };
    this.#groups.add(group);
    const stop = () => {
      if (group.stopPromise) return group.stopPromise;
      group.stopPromise = new Promise((resolve) => {
        const finish = () => {
          this.#groups.delete(group);
          resolve();
        };
        if (!child.pid || !this.#signal(child.pid, 'SIGTERM')) return finish();
        // 所有关闭路径共用 TERM 宽限期；超时给整个进程组发 KILL。
        const timer = setTimeout(() => {
          this.#signal(child.pid, 'SIGKILL');
          // 退出 supervisor 前回收直接子进程。
          if (child.exitCode !== null || child.signalCode !== null) finish();
          else child.once('exit', finish);
        }, this.graceMs);
        child.once('close', () => {
          if (!this.#signal(child.pid, 0)) {
            clearTimeout(timer);
            finish();
          }
        });
      });
      return group.stopPromise;
    };
    // shell 退出时回收同组后台进程，否则它们可能仍持有输出描述符。
    child.once('exit', stop);
    child.once('error', stop);
    child.stopGroup = stop;
    return child;
  }

  #signal(pid, signal) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      // 信号 0 仅探测进程组；EPERM 也说明组仍存在。
      if (signal === 0 && error.code === 'EPERM') return true;
      // ESRCH 表示组已退出；TERM/KILL 的 EPERM 表示无法终止其他用户的剩余进程。
      return false;
    }
  }

  close() {
    this.#closed = true;
    this.#closePromise ??= Promise.all([...this.#groups].map(({ child }) => child.stopGroup()));
    return this.#closePromise;
  }
}
