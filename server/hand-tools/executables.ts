import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { absolutePath, hasCode } from "./paths.ts";

export async function findPathExecutable(name: string): Promise<string | undefined> {
  const directories = process.env.PATH ?? (process.platform === "win32" ? "" : "/usr/bin:/bin");
  for (const entry of directories.split(path.delimiter)) {
    let directory: string;
    try {
      // 文件工具不能因为工作区带有 rg 或 PATH 有相对项而执行工作区里的程序。
      directory = absolutePath(process.platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry);
    } catch {
      continue;
    }
    const candidate = path.join(directory, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!hasCode(error, "ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP")) throw error;
    }
  }
}

export function windowsSystemExecutable(relative: string) {
  return path.join(absolutePath(process.env.SystemRoot || "C:\\Windows"), "System32", relative);
}
