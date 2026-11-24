// POSIX 登录 shell 与进程组处理参考 CC Desk Tunnel（Apache-2.0），署名见 NOTICE。
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { HandToolInput, HandToolOutputs, HandToolResult } from "../../shared/hand-tools.ts";
import { MAX_RESULT_BYTES } from "./files.ts";
import { findPathExecutable, windowsSystemExecutable } from "./executables.ts";
import { absolutePath, hasCode } from "./paths.ts";

export type HandShell = { kind: "posix" | "git-bash"; path: string };
const TRUNCATED = "\n[Output truncated at 65536 bytes.]";
const DEFAULT_TIMEOUT_MS = 120_000;

export function shellCommands(command: string, shell?: HandShell, platform = process.platform) {
  if (command.includes("\0")) throw new Error("Shell command cannot contain a NUL character.");
  if (platform === "win32" && !shell) {
    // EncodedCommand 让两种 PowerShell 都按原样接收脚本；保留最后一个原生命令的非零退出码。
    const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n$global:LASTEXITCODE = 0\n${command}\nif ($?) { exit 0 } elseif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 }`;
    const args = ["-NoLogo", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    return [{ executable: "pwsh.exe", args }, { executable: "powershell.exe", args }];
  }
  if (shell && shell.kind !== (platform === "win32" ? "git-bash" : "posix")) {
    throw new Error(platform === "win32" ? "Select a Git Bash executable on Windows." : "Select a POSIX shell on this hand.");
  }
  let accountShell: string | undefined;
  if (!shell) {
    try {
      accountShell = userInfo().shell ?? undefined;
    } catch {
      // 服务账户可能没有可读取的用户资料。
    }
  }
  const executable = absolutePath(shell?.path || process.env.SHELL || accountShell || "/bin/sh", platform);
  return [{ executable, args: ["-l", "-c", command] }];
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    throw error;
  }
}

async function killPosixGroup(pid: number, grace: boolean) {
  if (!signalGroup(pid, "SIGTERM")) return;
  if (grace) {
    // 先给普通子进程退出机会；即使 shell 先退出，也继续回收组内剩余进程。
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (!signalGroup(pid, 0)) return;
    }
  }
  signalGroup(pid, "SIGKILL");
}

function killWindowsTree(pid: number) {
  return new Promise<void>((resolve, reject) => {
    const taskkill = spawn(windowsSystemExecutable("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      taskkill.kill();
      reject(new Error(`taskkill timed out stopping process tree ${pid}.`));
    }, 10_000);
    taskkill.once("error", reject);
    taskkill.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`taskkill could not stop process tree ${pid} (exit ${code}).`));
    });
  });
}

export async function runShell(
  input: HandToolInput<"hand_bash">,
  cwd: string,
  { shell, signal, onOutput }: { shell?: HandShell; signal: AbortSignal; onOutput?: (chunk: string) => void },
): Promise<HandToolResult<"hand_bash">> {
  type Output = HandToolOutputs["hand_bash"];
  const windows = process.platform === "win32";
  const deadline = Date.now() + (input.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  const commands = shellCommands(input.command, shell);

  for (const { executable: candidate, args } of commands) {
    const executable = windows && !shell
      ? candidate === "pwsh.exe"
        ? await findPathExecutable(candidate)
        : windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe")
      : candidate;
    if (!executable) continue;
    signal.throwIfAborted();
    const result = await new Promise<Output | undefined>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
      const collected: string[] = [];
      let bytes = 0;
      let truncated = false;
      let cancelled = false;
      let timedOut = false;
      let processError: unknown;
      let callbackError: Error | undefined;
      let cleanup: Promise<void> | undefined;
      let terminationError: string | undefined;

      function emit(chunk: string) {
        if (!chunk) return;
        collected.push(chunk);
        if (callbackError) return;
        try {
          onOutput?.(chunk);
        } catch (error) {
          callbackError = error instanceof Error ? error : new Error(String(error));
          stop(true);
        }
      }

      [child.stdout, child.stderr].forEach((stream, i) => {
        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const length = Math.min(chunk.length, MAX_RESULT_BYTES - bytes);
          bytes += length;
          emit(decoders[i].write(chunk.subarray(0, length)));
          if (length < chunk.length) {
            truncated = true;
            // 不输出截断处不完整的 UTF-8 字符。
            emit(TRUNCATED);
          }
        });
      });

      function stop(cancelling: boolean) {
        if (!child.pid) return;
        cleanup ??= (windows ? killWindowsTree(child.pid) : killPosixGroup(child.pid, cancelling))
          .catch((error: unknown) => {
            terminationError = error instanceof Error ? error.message : String(error);
            child.kill();
          });
        if (cancelling) void cleanup.then(() => {
          // 避免主动脱离组的进程继续占用管道。
          child.stdout.destroy();
          child.stderr.destroy();
        });
      }

      function onAbort() {
        cancelled = true;
        stop(true);
      }

      const timer = setTimeout(() => {
        timedOut = true;
        stop(true);
      }, Math.max(0, deadline - Date.now()));
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => { processError = error; });
      child.once("exit", () => {
        // 普通命令结束时也回收仍持有 stdout/stderr 的 POSIX 后台进程。
        if (!windows) stop(false);
      });
      child.once("close", async (exitCode, exitSignal) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        await cleanup;
        if (processError) {
          if (!cancelled && !timedOut && hasCode(processError, "ENOENT") && commands.length > 1) return resolve(undefined);
          return reject(processError);
        }
        if (callbackError) return reject(callbackError);
        if (!truncated) for (const decoder of decoders) emit(decoder.end());
        if (callbackError) return reject(callbackError);
        resolve({
          output: collected.join(""), exitCode, signal: exitSignal, cancelled, timedOut, truncated,
          ...(terminationError !== undefined && { terminationError }),
        });
      });
      if (signal.aborted) onAbort();
    });

    if (!result) continue;
    const status = result.cancelled ? "Command cancelled." :
      result.timedOut ? `Command timed out after ${input.timeout_ms ?? DEFAULT_TIMEOUT_MS} ms.` :
        result.exitCode !== null ? `Exit code: ${result.exitCode}` : `Command terminated by ${result.signal ?? "an unknown signal"}.`;
    return {
      text: [result.output, status, result.terminationError].filter(Boolean).join("\n"),
      isError: result.cancelled || result.timedOut || result.exitCode !== 0 || result.terminationError !== undefined,
      structured: result,
    };
  }
  throw new Error("PowerShell was not found; install pwsh or configure a Git Bash executable.");
}
