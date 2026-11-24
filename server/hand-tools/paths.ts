import path, { win32 } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";

export function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? "");
}

export function absolutePath(value: string, platform = process.platform): string {
  const windows = platform === "win32";
  const p = windows ? win32 : path.posix;
  if (value.includes("\0") || !p.isAbsolute(value)) {
    throw new Error(`Use an absolute path on the hand machine: ${value}`);
  }
  if (!windows) return value;

  // win32.isAbsolute 也接受盘符未知的根相对路径；设备路径和 NTFS 数据流不属于文件工具路径。
  const input = value.replaceAll("/", "\\");
  const drive = /^[a-z]:\\/i.exec(input);
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(input);
  const components = (drive ? input.slice(3) : input).split("\\").filter(Boolean);
  if ((!drive && !unc) || components.some((part) => part !== "." && part !== ".." && (
    /[:*?"<>|\x00-\x1f]|[ .]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
  ))) {
    throw new Error(`Use a fully qualified drive or UNC file path on the hand machine: ${value}`);
  }
  return input;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export class HandPaths {
  private readonly roots: string[] | null;
  private canonicalRoots?: Promise<string[]>;

  constructor(roots: string[] | null) {
    this.roots = roots?.map((root) => absolutePath(root)) ?? null;
  }

  async authorize(value: string, allowMissing = false): Promise<string> {
    const input = absolutePath(value);
    const missing: string[] = [];
    let existing = input;
    let target: string;
    for (;;) {
      try {
        target = await realpath(existing);
        break;
      } catch (error) {
        if (!allowMissing || !hasCode(error, "ENOENT")) throw error;
        // 失效链接不能当成新文件，否则实际会覆盖链接本身。
        const entry = await lstat(existing).catch((failure: unknown) => {
          if (!hasCode(failure, "ENOENT")) throw failure;
        });
        if (entry) throw new Error(`Path no longer resolves: ${input}`);
        const parent = path.dirname(existing);
        const part = path.basename(existing);
        if (parent === existing || part === ".." || part === ".") throw error;
        missing.unshift(part);
        existing = parent;
      }
    }

    if (this.roots !== null) {
      this.canonicalRoots ??= Promise.all(this.roots.map(async (root) => {
        try {
          const canonical = await realpath(root);
          return (await stat(canonical)).isDirectory() ? canonical : undefined;
        } catch (error) {
          if (!hasCode(error, "ENOENT", "ENOTDIR")) throw error;
        }
      })).then((roots) => roots.filter((root): root is string => root !== undefined));
      const roots = await this.canonicalRoots;
      for (const root of roots) {
        // 只比较已存在的祖先；未解析的后缀不能用来跨入授权范围。
        if (!isInside(root, target)) continue;
        if (process.platform === "win32") {
          // win32.relative 忽略大小写，但 Windows 可以对单个目录开启大小写区分。
          let ancestor = target;
          for (const _ of path.relative(root, target).split(path.sep).filter(Boolean)) {
            ancestor = path.dirname(ancestor);
          }
          if (ancestor !== root) {
            const [left, right] = await Promise.all([stat(ancestor, { bigint: true }), stat(root, { bigint: true })]);
            if (left.ino === 0n || left.ino !== right.ino || left.dev !== right.dev) continue;
          }
        }
        return path.join(target, ...missing);
      }
      throw new Error(`Path is outside the authorized roots: ${input}`);
    }
    return path.join(target, ...missing);
  }
}
