import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { HandToolInput, HandToolResult } from "../../shared/hand-tools.ts";
import { hasCode, type HandPaths } from "./paths.ts";

export const MAX_RESULT_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_READ_LINES = 2_000;
const changed = "File changed since last read; call hand_read again.";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

export function utf8Prefix(value: string, bytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.length <= bytes) return value;
  let end = bytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}

export class NonTextFile extends Error {}

export function decodeText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new NonTextFile("Binary file; hand tools only return UTF-8 text.");
  try {
    // 保留 BOM；编辑时不会改变未选中的文件内容。
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new NonTextFile("Binary or non-UTF-8 file; hand tools only return UTF-8 text.");
  }
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

export class FileTooLarge extends Error {}

export async function readRegular(paths: HandPaths, target: string, signal: AbortSignal, maxBytes = MAX_FILE_BYTES) {
  signal.throwIfAborted();
  if (await paths.authorize(target) !== target) throw new Error(changed);
  const entry = await lstat(target);
  if (!entry.isFile()) throw new Error(`Expected a regular file: ${target}`);
  // 防止路径末尾被换成符号链接，或被换成 FIFO 后阻塞 open。
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await open(target, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(entry, before) || await paths.authorize(target) !== target) {
      throw new Error(changed);
    }
    if (before.size > maxBytes) throw new FileTooLarge(`File exceeds the ${maxBytes}-byte limit: ${target}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) throw new FileTooLarge(`File exceeds the ${maxBytes}-byte limit: ${target}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (size !== after.size || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(changed);
    }
    return { bytes: Buffer.concat(chunks, size), metadata: after };
  } finally {
    await handle.close();
  }
}

export async function readFile(input: HandToolInput<"hand_read">, paths: HandPaths, signal: AbortSignal): Promise<HandToolResult<"hand_read">> {
  const { bytes } = await readRegular(paths, await paths.authorize(input.path), signal);
  const hash = sha256(bytes);
  const offset = input.offset ?? 1;
  let lines: string[];
  try {
    lines = splitLines(decodeText(bytes));
  } catch (error) {
    if (!(error instanceof NonTextFile)) throw error;
    return {
      text: `${error.message}\nSHA-256: ${hash}`, isError: true,
      structured: { sha256: hash, totalLines: 0, offset, binary: true },
    };
  }
  const end = Math.min(lines.length, offset - 1 + Math.min(input.limit ?? MAX_READ_LINES, MAX_READ_LINES));
  const result: string[] = [];
  let left = MAX_RESULT_BYTES - 200;
  let i = offset - 1;
  while (i < end) {
    const prefix = `${i + 1}\t`;
    const line = prefix + lines[i];
    const length = Buffer.byteLength(line);
    if (length > left) {
      if (i === offset - 1) {
        result.push(utf8Prefix(line, left - 24) + " [line truncated]");
        i++;
      }
      break;
    }
    result.push(line);
    left -= length + 1;
    i++;
  }
  const nextOffset = i < lines.length ? i + 1 : undefined;
  const header = `SHA-256: ${hash}`;
  if (!result.length) result.push(lines.length ? "No lines at this offset." : "File is empty.");
  if (nextOffset !== undefined) result.push(`[More lines available; call hand_read with offset ${nextOffset}.]`);
  return {
    text: [header, ...result].join("\n"), isError: false,
    structured: { sha256: hash, totalLines: lines.length, offset, ...(nextOffset !== undefined && { nextOffset }) },
  };
}

// 按目标串行化本进程的 write/edit；进程外修改由暂存后的二次读取检测。
const mutations = new Map<string, Promise<void>>();

export async function mutateFile<N extends "hand_write" | "hand_edit">(
  name: N, input: HandToolInput<N>, paths: HandPaths, signal: AbortSignal,
): Promise<HandToolResult> {
  const writing = name === "hand_write";
  const target = await paths.authorize(input.path, writing);
  const key = target.toLowerCase(); // 同时覆盖大小写不敏感文件系统上的新文件别名。
  const previous = mutations.get(key);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  mutations.set(key, turn);
  try {
    await previous;
    signal.throwIfAborted();
    if (await paths.authorize(input.path, writing) !== target) throw new Error(changed);
    const parent = path.dirname(target);
    const parentBefore = await stat(parent);
    if (!parentBefore.isDirectory()) throw new Error(`Expected a directory: ${parent}`);
    const before = await readRegular(paths, target, signal).catch((error: unknown) => {
      if (!writing || !hasCode(error, "ENOENT")) throw error;
    });

    let content: string;
    let replacements = 0;
    if (writing) {
      const { content: written, expectedSha256 } = input as HandToolInput<"hand_write">;
      if (before && !expectedSha256) {
        throw new Error("File already exists; call hand_read and pass its sha256 as expectedSha256.");
      }
      if (expectedSha256 && (!before || sha256(before.bytes) !== expectedSha256.toLowerCase())) {
        throw new Error(changed);
      }
      content = written;
    } else {
      const { old_string, new_string, replace_all } = input as HandToolInput<"hand_edit">;
      const source = decodeText(before!.bytes);
      const first = source.indexOf(old_string);
      if (first < 0) throw new Error("old_string was not found; call hand_read again and copy the exact text.");
      if (!replace_all && source.indexOf(old_string, first + 1) !== -1) {
        throw new Error("old_string is not unique; add surrounding text or set replace_all to true.");
      }
      if (replace_all) {
        // 按字面量替换；new_string 中的 $ 没有特殊含义，先检查扩张后的字节数。
        let index = first;
        while (index !== -1) {
          replacements++;
          index = source.indexOf(old_string, index + old_string.length);
        }
        if (before!.bytes.length + replacements * (Buffer.byteLength(new_string) - Buffer.byteLength(old_string)) > MAX_FILE_BYTES) {
          throw new Error(`File content exceeds the ${MAX_FILE_BYTES}-byte limit.`);
        }
        content = source.replaceAll(old_string, () => new_string);
      } else {
        replacements = 1;
        content = source.slice(0, first) + new_string + source.slice(first + old_string.length);
      }
    }

    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`File content exceeds the ${MAX_FILE_BYTES}-byte limit.`);
    const bytes = Buffer.from(content);
    const temporary = path.join(parent, `.hand-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    let renamed = false;
    try {
      let staged: Stats;
      try {
        staged = await handle.stat();
        if (await paths.authorize(temporary) !== temporary ||
            !sameFile(parentBefore, await stat(parent))) throw new Error(changed);
        await handle.writeFile(bytes, { signal });
        if (process.platform !== "win32") await handle.chmod(before ? before.metadata.mode & 0o777 : 0o666 & ~process.umask());
        await handle.sync();
      } finally {
        await handle.close();
      }
      // 再检查原路径、目标、父目录和当前内容，然后提交暂存文件。
      if (await paths.authorize(input.path, writing) !== target ||
          await paths.authorize(parent) !== parent ||
          !sameFile(parentBefore, await stat(parent))) throw new Error(changed);
      if (before) {
        const current = await readRegular(paths, target, signal).catch((error: unknown) => {
          if (hasCode(error, "ENOENT", "ELOOP") || error instanceof FileTooLarge) throw new Error(changed);
          throw error;
        });
        if (!sameFile(before.metadata, current.metadata) || !before.bytes.equals(current.bytes)) throw new Error(changed);
      }
      if (!sameFile(staged, await lstat(temporary))) throw new Error(changed);
      signal.throwIfAborted();
      if (before) {
        await rename(temporary, target);
        renamed = true;
      } else {
        // rename 会覆盖并发新建的文件；用硬链接原子发布新文件，目标存在时必定失败。
        try {
          await link(temporary, target);
        } catch (error) {
          if (hasCode(error, "EEXIST")) throw new Error(changed);
          if (hasCode(error, "ENOTSUP", "EOPNOTSUPP", "ENOSYS")) {
            throw new Error("Cannot create the file atomically on this filesystem; use a directory that supports hard links.");
          }
          throw error;
        }
      }
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }

    const hash = sha256(bytes);
    return {
      text: `${writing ? "Wrote" : `Edited (${replacements} replacement(s))`} ${target}\nSHA-256: ${hash}`,
      isError: false,
      structured: writing ? { path: target, sha256: hash } : { path: target, sha256: hash, replacements },
    };
  } finally {
    release();
    if (mutations.get(key) === turn) mutations.delete(key);
  }
}
