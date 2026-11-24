import { spawn } from "node:child_process";
import { opendir, lstat, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { RE2JS } from "re2js";
import type { HandGrepMatch, HandToolInput, HandToolResult } from "../../shared/hand-tools.ts";
import { decodeText, FileTooLarge, NonTextFile, MAX_RESULT_BYTES, readRegular, splitLines } from "./files.ts";
import { findPathExecutable } from "./executables.ts";
import { hasCode, type HandPaths } from "./paths.ts";

const MAX_RESULTS = 250;
const MAX_ENTRIES = 25_000;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_GREP_BYTES = 64 * 1024 * 1024;
const TRUNCATED = "[Search limit reached; narrow the path, glob, or pattern.]";
const IGNORED = new Set([".git", "node_modules"]);
const ignored = (name: string) => IGNORED.has(process.platform === "win32" ? name.toLowerCase() : name);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const skippable = (error: unknown) => hasCode(error, "ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP");

function globMatcher(pattern: string) {
  if (pattern.includes("\\") || pattern.includes("\0") || pattern.startsWith("/") || /^[a-z]:/i.test(pattern) || pattern.split("/").includes("..")) {
    throw new Error("Use a relative glob with forward slashes, such as **/*.ts.");
  }
  return picomatch(pattern, { dot: true, nocase: process.platform === "win32", nonegate: true });
}

async function nodeFiles(directory: string, paths: HandPaths, signal: AbortSignal) {
  const pending = [directory];
  const files: string[] = [];
  let entries = 0;
  let truncated = false;
  while (pending.length && !truncated) {
    signal.throwIfAborted();
    const folder = pending.pop()!;
    try {
      if (await paths.authorize(folder) !== folder) continue;
      const dir = await opendir(folder);
      for await (const entry of dir) {
        signal.throwIfAborted();
        if (ignored(entry.name)) continue;
        if (++entries > MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const child = path.join(folder, entry.name);
        if (entry.isDirectory()) pending.push(child);
        else if (entry.isFile()) files.push(child);
      }
    } catch (error) {
      if (!skippable(error)) throw error;
    }
  }
  return { files: files.sort(order), truncated };
}

// rg 只接收独立参数；禁用用户配置，避免额外参数改变文件集合或结果格式。
function ripgrep(executable: string, args: string[], cwd: string, signal: AbortSignal, maxBytes: number, input?: string) {
  return new Promise<{ output: string; truncated: boolean } | undefined>((resolve, reject) => {
    const child = spawn(executable, ["--no-config", "--color", "never", ...args], {
      cwd, signal, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"], windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxBytes - size;
      chunks.push(chunk.subarray(0, remaining));
      size += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        truncated = true;
        child.kill();
      }
    });
    // rg 退出或被取消后，stdin 可能在尚未写完时关闭。
    child.stdin?.on("error", (error: unknown) => {
      if (!hasCode(error, "EPIPE", "ERR_STREAM_DESTROYED")) reject(error);
    });
    child.stdin?.end(input);
    child.once("error", (error) => {
      if (!hasCode(error, "ENOENT")) reject(error);
    });
    child.once("close", (code) => {
      if (signal.aborted) return reject(signal.reason);
      if (!truncated && code !== 0 && code !== 1) return resolve(undefined);
      resolve({ output: Buffer.concat(chunks, size).toString("utf8"), truncated });
    });
  });
}

async function grepFiles(directory: string, paths: HandPaths, signal: AbortSignal, rg?: string) {
  if (!rg) return nodeFiles(directory, paths, signal);
  const result = await ripgrep(rg, [
    "--files", "--null", "--hidden", "--no-ignore", "--sort", "path",
    process.platform === "win32" ? "--iglob" : "--glob", "!**/.git",
    process.platform === "win32" ? "--iglob" : "--glob", "!**/node_modules", "--", ".",
  ], directory, signal, 4 * 1024 * 1024);
  if (!result) return nodeFiles(directory, paths, signal);
  const files = result.output.split("\0").slice(0, -1)
    .map((file) => path.resolve(directory, file))
    .filter((file) => !path.relative(directory, file).split(path.sep).some(ignored))
    .sort(order);
  return { files: files.slice(0, MAX_ENTRIES), truncated: result.truncated || files.length > MAX_ENTRIES };
}

export async function globFiles(input: HandToolInput<"hand_glob">, target: string, paths: HandPaths, signal: AbortSignal): Promise<HandToolResult<"hand_glob">> {
  const matches = globMatcher(input.pattern);
  const { files, truncated: scanTruncated } = await nodeFiles(target, paths, signal);
  const found: { path: string; mtime: number }[] = [];
  for (const file of files) {
    signal.throwIfAborted();
    if (!matches(path.relative(target, file).split(path.sep).join("/"))) continue;
    try {
      if (await paths.authorize(file) !== file) continue;
      const metadata = await lstat(file);
      if (metadata.isFile()) found.push({ path: file, mtime: metadata.mtimeMs });
    } catch (error) {
      if (!skippable(error)) throw error;
    }
  }
  found.sort((a, b) => b.mtime - a.mtime || order(a.path, b.path));
  const output: string[] = [];
  let budget = MAX_RESULT_BYTES - 200;
  for (const file of found) {
    const size = Buffer.byteLength(file.path) + 1;
    if (output.length === MAX_RESULTS || size > budget) break;
    output.push(file.path);
    budget -= size;
  }
  const truncated = scanTruncated || output.length < found.length;
  const text = [...(output.length ? output : ["No files matched."]), ...(truncated ? [TRUNCATED] : [])].join("\n");
  return { text, isError: false, structured: { paths: output, truncated } };
}

type SearchFile = { file: string; lines: string[] };

async function rgLiteralLines(rg: string, batch: SearchFile[], directory: string, literal: string, signal: AbortSignal) {
  const count = batch.reduce((total, file) => total + file.lines.length, 0);
  if (!count) return new Set<number>();
  // 只在两种引擎等价的字面量模式下交给 rg 匹配；输入是已经授权并读取的文本，不让 rg 再打开路径。
  const result = await ripgrep(
    rg, ["--text", "--line-number", "--no-filename", "--fixed-strings", "-e", literal, "--", "-"],
    directory, signal, 2 * 1024 * 1024 + 12 * count,
    batch.map(({ lines }) => lines.length ? lines.join("\n") + "\n" : "").join(""),
  );
  if (!result || result.truncated) return undefined;
  return new Set(result.output.split("\n").filter(Boolean).map((line) => Number.parseInt(line, 10)));
}

export async function grepFilesOnHand(input: HandToolInput<"hand_grep">, target: string, paths: HandPaths, signal: AbortSignal): Promise<HandToolResult<"hand_grep">> {
  const ignoreCase = input.case_insensitive ?? false;
  const regex = RE2JS.compile(input.pattern, ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
  const filter = input.glob ? globMatcher(input.glob) : undefined;
  const mode = input.output_mode ?? "files_with_matches";
  const context = input.context ?? 0;
  const directory = (await stat(target)).isDirectory();
  const base = directory ? target : path.dirname(target);
  const rg = await findPathExecutable(process.platform === "win32" ? "rg.exe" : "rg");
  const scan = directory ? await grepFiles(target, paths, signal, rg) : { files: [target], truncated: false };
  const canUseLiteral = !ignoreCase && /^[a-z0-9_ /=:-]+$/i.test(input.pattern);
  const matches: HandGrepMatch[] = [];
  const output: string[] = [];
  let budget = MAX_RESULT_BYTES - 200;
  let truncated = scan.truncated;
  let totalBytes = 0;
  let batch: SearchFile[] = [];
  let batchBytes = 0;

  function add(match: HandGrepMatch, text: string) {
    const size = Buffer.byteLength(text) + 1;
    if (matches.length === MAX_RESULTS || size > budget) {
      truncated = true;
      return false;
    }
    matches.push(match);
    output.push(text);
    budget -= size;
    return true;
  }

  async function flush() {
    if (!batch.length) return true;
    const rgLines = rg && canUseLiteral ? await rgLiteralLines(rg, batch, base, input.pattern, signal) : undefined;
    let start = 1;
    for (const { file, lines } of batch) {
      signal.throwIfAborted();
      const isMatch = (i: number) => rgLines ? rgLines.has(start + i) : regex.test(lines[i]);
      if (mode === "files_with_matches") {
        if (lines.some((_, i) => isMatch(i)) && !add({ path: file }, file)) return false;
      } else if (mode === "count") {
        const count = lines.reduce((value, _, i) => value + Number(isMatch(i)), 0);
        if (count && !add({ path: file, count }, `${file}:${count}`)) return false;
      } else {
        const hits: number[] = [];
        let next = 0;
        for (let i = 0; i < lines.length; i++) {
          if (!isMatch(i)) continue;
          hits.push(i);
          // 等右侧上下文完成后再输出，以便区分上下文和匹配行。
          if (hits.length > MAX_RESULTS + context) break;
        }
        const hitSet = new Set(hits);
        for (const hit of hits) {
          for (let i = Math.max(next, hit - context, 0); i <= Math.min(hit + context, lines.length - 1); i++) {
            const match = hitSet.has(i);
            const separator = match ? ":" : "-";
            if (!add({ path: file, line: i + 1, text: lines[i], match }, `${file}${separator}${i + 1}${separator}${lines[i]}`)) return false;
          }
          next = Math.max(next, hit + context + 1);
        }
      }
      start += lines.length;
    }
    batch = [];
    batchBytes = 0;
    return true;
  }

  for (const file of scan.files) {
    signal.throwIfAborted();
    if (filter && !filter(path.relative(base, file).split(path.sep).join("/"))) continue;
    try {
      if (directory && await paths.authorize(file) !== file) continue;
      const { bytes } = await readRegular(paths, file, signal, MAX_GREP_FILE_BYTES);
      totalBytes += bytes.length;
      if (totalBytes > MAX_GREP_BYTES) {
        truncated = true;
        break;
      }
      let text: string;
      try {
        text = decodeText(bytes);
      } catch (error) {
        if (!directory || !(error instanceof NonTextFile)) throw error;
        continue;
      }
      batch.push({ file, lines: splitLines(text) });
      batchBytes += bytes.length + 1;
      if (batchBytes >= 1024 * 1024 || batch.length >= 128) {
        if (!await flush()) {
          batch = [];
          break;
        }
      }
    } catch (error) {
      if (!directory || !(skippable(error) || error instanceof FileTooLarge)) throw error;
      if (error instanceof FileTooLarge) truncated = true;
    }
  }
  await flush();
  const text = [...(output.length ? output : ["No matches found."]), ...(truncated ? [TRUNCATED] : [])].join("\n");
  return { text, isError: false, structured: { matches, truncated } };
}
