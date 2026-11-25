// @ts-check
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { parseHostTarget } from "@getpaseo/client/node";

/** @param {string} [raw] @param {{ platform?: string, userHome?: string, cwd?: string }} [options] */
export function resolvePaseoHome(raw = process.env.PASEO_HOME ?? "~/.paseo", {
  platform = process.platform, userHome = homedir(), cwd = process.cwd(),
} = {}) {
  // 与 Paseo 0.17.3 一致：仅展开 ~ 和 ~/，Windows 默认在当前账户的用户目录。
  const paths = platform === "win32" ? win32 : posix;
  const home = raw === "~" ? userHome : raw.startsWith("~/") ? paths.join(userHome, raw.slice(2)) : raw;
  return paths.resolve(cwd, home);
}

/** @param {unknown} listen @param {string} [platform] */
export function localDaemonAddress(listen, platform = process.platform) {
  const error = () => new Error("Expected a local Paseo daemon endpoint.");
  if (typeof listen !== "string") throw error();
  // SDK 识别小写的 Windows pipe 入口；管道名的实际字符仍原样传给 Node。
  const address = listen.trim().replace(/^(?:pipe:\/\/)?\\\\\.\\pipe\\/i, () => "pipe://\\\\.\\pipe\\");
  const target = parseHostTarget(address);
  if (target.kind !== "socket" || target.offer) throw error();
  if (target.socketPath) {
    if (platform === "win32"
      ? !/^\\\\\.\\pipe\\[^\\/]+(?:\\[^\\/]+)*$/i.test(target.socketPath)
      : !target.socketPath.startsWith("/") && !target.socketPath.startsWith("~/")) throw error();
    return address;
  }
  const url = new URL(target.url);
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (url.hostname === "[::]") url.hostname = "[::1]";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw error();
  return url.href;
}
