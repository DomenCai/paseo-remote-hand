import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { executeHandTool, type HandToolOptions } from "./index.ts";
import { absolutePath, hasCode } from "./paths.ts";
import { shellCommands } from "./shell.ts";

async function fixture(t: TestContext) {
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "hand-tools-test-")));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, "project");
  const sibling = path.join(sandbox, "project-other");
  await Promise.all([mkdir(root), mkdir(sibling)]);
  const options: HandToolOptions = { roots: [root], cwd: root, allowShell: false, signal: new AbortController().signal };
  return { sandbox, root, sibling, options };
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("rejects root-prefix, parent, dangling link and symlink/junction escapes", async (t) => {
  const { root, sibling, options } = await fixture(t);
  const outside = path.join(sibling, "secret.txt");
  const link = path.join(root, "escape");
  await writeFile(outside, "outside secret");
  await symlink(sibling, link, process.platform === "win32" ? "junction" : "dir");
  for (const target of [outside, path.join(root, "..", "project-other", "secret.txt"), path.join(link, "secret.txt")]) {
    const result = await executeHandTool("hand_read", { path: target }, options);
    assert.equal(result.isError, true);
    assert.match(result.text, /outside the authorized roots/);
  }
  // 不先按词法折叠 ".."；在 POSIX 上，它从链接实际指向的目录开始解析。
  if (process.platform !== "win32") {
    const inner = path.join(sibling, "inner");
    await mkdir(inner);
    await symlink(inner, path.join(root, "nested-link"));
    const traversed = await executeHandTool("hand_read", { path: `${root}/nested-link/../secret.txt` }, options);
    assert.match(traversed.text, /outside the authorized roots/);
  }
  const escapedNew = path.join(link, "new.txt");
  assert.match((await executeHandTool("hand_write", { path: escapedNew, content: "no" }, options)).text, /outside the authorized roots/);
  assert.deepEqual(await readdir(sibling), process.platform === "win32" ? ["secret.txt"] : ["inner", "secret.txt"]);
  const broken = path.join(root, "dangling");
  await symlink(path.join(sibling, "nonexistent-dir"), broken, process.platform === "win32" ? "junction" : "dir");
  assert.match((await executeHandTool("hand_write", { path: broken, content: "no" }, options)).text, /no longer resolves/);
  const glob = await executeHandTool("hand_glob", { pattern: "**/*" }, options);
  assert.deepEqual(glob.structured?.paths, []);
  const grep = await executeHandTool("hand_grep", { pattern: "secret" }, options);
  assert.deepEqual(grep.structured?.matches, []);
  assert.match((await executeHandTool("hand_read", { path: "secret.txt" }, options)).text, /absolute path/);
  assert.equal((await executeHandTool("hand_read", { path: outside }, { ...options, roots: null })).isError, false);
});

test("reads line slices and file hashes; binary content stays out of the text", async (t) => {
  const { root, options } = await fixture(t);
  const target = path.join(root, "lines.txt");
  const source = "first\r\nsecond\r\nthird\r\n";
  await writeFile(target, source);
  const read = await executeHandTool("hand_read", { path: target, offset: 2, limit: 1 }, options);
  assert.match(read.text, /2\tsecond\n\[More lines/);
  assert.deepEqual(read.structured, { sha256: hash(source), totalLines: 3, offset: 2, nextOffset: 3 });
  const bytes = Buffer.from([0xff, 0x00, 0x41]);
  await writeFile(target, bytes);
  const binary = await executeHandTool("hand_read", { path: target }, options);
  assert.equal(binary.isError, true);
  assert.match(binary.text, /Binary file/);
  assert.equal(binary.structured?.sha256, hash(bytes));
  assert.doesNotMatch(binary.text, /\uFFFD/);
});

test("concurrent writes and edits guard against stale contents and never clobber a new file", async (t) => {
  const { root, options } = await fixture(t);
  const target = path.join(root, "a.txt");
  const write = (content: string, expectedSha256?: string) =>
    executeHandTool("hand_write", { path: target, content, expectedSha256 }, options);
  const create = await Promise.all([write("first"), write("second")]);
  assert.equal(create.filter((result) => !result.isError).length, 1);
  assert.match(create.find((result) => result.isError)!.text, /hand_read/);

  const initial = await executeHandTool("hand_read", { path: target }, options);
  const wanted = initial.structured?.sha256;
  assert.ok(wanted);
  const overwrites = await Promise.all([write("winner 1", wanted), write("winner 2", wanted)]);
  assert.equal(overwrites.filter((result) => !result.isError).length, 1);
  assert.match(overwrites.find((result) => result.isError)!.text, /File changed since last read; call hand_read again/);
  assert.equal(hash(await readFile(target)), overwrites.find((result) => !result.isError)!.structured?.sha256);

  await writeFile(target, "replace me\r\nrepeat repeat");
  const edit = (old_string: string, new_string: string, replace_all?: boolean) =>
    executeHandTool("hand_edit", { path: target, old_string, new_string, replace_all }, options);
  const edits = await Promise.all([edit("replace me", "one"), edit("replace me", "two")]);
  assert.equal(edits.filter((result) => !result.isError).length, 1);
  assert.match(edits.find((result) => result.isError)!.text, /old_string was not found/);
  assert.match((await edit("repeat", "x")).text, /old_string is not unique/);
  const all = await edit("repeat", "$&", true);
  assert.equal(all.structured?.replacements, 2);
  assert.match(await readFile(target, "utf8"), /^(one|two)\r\n\$& \$&$/);
  assert.deepEqual(await readdir(root), ["a.txt"]);
});

test("changes from another writer after staging are preserved for both edit and create", async (t) => {
  const { root, options } = await fixture(t);
  const target = path.join(root, "current.txt");
  const extra = path.join(root, "new.txt");
  await writeFile(target, "change here; original suffix");
  const handle = await open(target, "r");
  const sync = handle.sync;
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();

  // 在暂存完成、提交前插入进程外写入；不依赖文件监听事件的时序。
  let external = target;
  t.mock.method(prototype, "sync", async function (this: typeof handle) {
    await writeFile(external, "outside writer");
    await sync.call(this);
  });
  const edit = await executeHandTool("hand_edit", { path: target, old_string: "change here", new_string: "updated" }, options);
  assert.match(edit.text, /File changed since last read; call hand_read again/);
  assert.equal(await readFile(target, "utf8"), "outside writer");

  external = extra;
  const create = await executeHandTool("hand_write", { path: extra, content: "created by hand" }, options);
  assert.match(create.text, /File changed since last read; call hand_read again/);
  assert.equal(await readFile(extra, "utf8"), "outside writer");
  assert.deepEqual((await readdir(root)).sort(), ["current.txt", "new.txt"]);
});

test("glob orders by mtime and grep agrees with and without rg", async (t) => {
  const { root, options } = await fixture(t);
  const old = path.join(root, "older.txt");
  const recent = path.join(root, "newer.txt");
  const hidden = path.join(root, ".hidden.txt");
  await writeFile(old, "before\r\nNeedle\r\nneedle twice needle\r\nafter\r\n");
  await writeFile(recent, "needle\n");
  await writeFile(hidden, "needle\n");
  await writeFile(path.join(root, "binary.txt"), Buffer.from("needle\0"));
  await utimes(old, 100, 100);
  await utimes(recent, 200, 200);
  for (const name of [".git", "node_modules"]) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "ignored.txt"), "needle\n");
  }
  const glob = await executeHandTool("hand_glob", { pattern: "**/*er.txt" }, options);
  assert.deepEqual(glob.structured?.paths, [recent, old]);

  const queries = [
    { pattern: "needle", glob: "**/*.txt", output_mode: "files_with_matches" },
    { pattern: "needle", glob: "**/*.txt", output_mode: "count" },
    { pattern: "^needle", glob: "**/*er.txt", case_insensitive: true, output_mode: "content", context: 1 },
  ];
  const native = await Promise.all(queries.map((query) => executeHandTool("hand_grep", query, options)));
  assert.deepEqual(native[0].structured?.matches, [hidden, recent, old].map((file) => ({ path: file })));
  assert.deepEqual(native[1].structured?.matches, [hidden, recent, old].map((file) => ({ path: file, count: 1 })));
  assert.deepEqual(native[2].structured?.matches, [
    { path: recent, line: 1, text: "needle", match: true },
    { path: old, line: 1, text: "before", match: false },
    { path: old, line: 2, text: "Needle", match: true },
    { path: old, line: 3, text: "needle twice needle", match: true },
    { path: old, line: 4, text: "after", match: false },
  ]);
  const previous = process.env.PATH;
  try {
    // 空目录和相对 PATH 项不会被当成 rg 的可执行文件来源。
    process.env.PATH = `.${path.delimiter}${root}`;
    const fallback = await Promise.all(queries.map((query) => executeHandTool("hand_grep", query, options)));
    assert.deepEqual(fallback, native);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test("validates Windows drive and UNC paths and picks Windows shell arguments without a Windows host", () => {
  assert.equal(absolutePath("C:/Work Space/a.txt", "win32"), "C:\\Work Space\\a.txt");
  assert.equal(absolutePath("\\\\server\\share\\dir", "win32"), "\\\\server\\share\\dir");
  for (const invalid of ["C:relative", "\\current-drive", "\\\\?\\C:\\device", "C:\\repo\\file.txt:stream", "C:\\repo\\NUL.txt"]) {
    assert.throws(() => absolutePath(invalid, "win32"), /absolute|fully qualified/);
  }
  const fallback = shellCommands('Write-Output "Hello world"', undefined, "win32");
  assert.deepEqual(fallback.map((item) => item.executable), ["pwsh.exe", "powershell.exe"]);
  assert.match(Buffer.from(fallback[0].args.at(-1)!, "base64").toString("utf16le"), /Write-Output "Hello world"/);
  const git = shellCommands("echo hi", { kind: "git-bash", path: "C:/Program Files/Git/bin/bash.exe" }, "win32");
  assert.deepEqual(git, [{ executable: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["-l", "-c", "echo hi"] }]);
});

test("bash checks permission, merges output, returns exit code and caps both streamed and final output", { skip: process.platform === "win32" }, async (t) => {
  const { root, options } = await fixture(t);
  const marker = path.join(root, "marker");
  const denied = await executeHandTool("hand_bash", { command: "touch marker" }, options);
  assert.match(denied.text, /Shell execution is disabled/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const shell = { kind: "posix" as const, path: "/bin/sh" };
  const run = { ...options, shell, allowShell: true };
  const summary = await executeHandTool("hand_bash", { command: "printf out; printf err >&2; exit 7" }, run);
  assert.equal(summary.isError, true);
  assert.equal(summary.structured?.exitCode, 7);
  assert.match(summary.structured!.output, /out/);
  assert.match(summary.structured!.output, /err/);
  const chunks: string[] = [];
  const output = await executeHandTool("hand_bash", { command: "/usr/bin/yes | /usr/bin/head -c 200000" }, {
    ...run, onOutput: (chunk) => chunks.push(chunk),
  });
  assert.equal(output.structured?.truncated, true);
  assert.equal(output.structured.exitCode, 0);
  assert.equal(chunks.join(""), output.structured.output);
  assert.match(output.text, /\[Output truncated at 65536 bytes\.\]/);
  assert.equal(Buffer.byteLength(output.structured.output.split("\n[Output truncated")[0]), 65_536);
  const timeout = await executeHandTool("hand_bash", { command: "sleep 10", timeout_ms: 50 }, run);
  assert.equal(timeout.structured?.timedOut, true, timeout.text);
  assert.match(timeout.text, /Command timed out after 50 ms/);
});

test("bash cancellation kills shell descendants even when they ignore SIGTERM", { skip: process.platform === "win32" }, async (t) => {
  const { options } = await fixture(t);
  const controller = new AbortController();
  const pids = new Map<string, number>();
  t.after(() => {
    for (const pid of pids.values()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!hasCode(error, "ESRCH")) throw error;
      }
    }
  });
  let output = "";
  const result = await executeHandTool("hand_bash", {
    command: "/bin/sh -c 'trap \"\" TERM; sleep 60 & printf \"grandchild:%s\\n\" \"$!\"; wait' & printf 'child:%s\\n' \"$!\"; wait",
    timeout_ms: 4_000,
  }, {
    ...options, signal: controller.signal, allowShell: true, shell: { kind: "posix", path: "/bin/sh" },
    onOutput(chunk) {
      output += chunk;
      for (const match of output.matchAll(/^(child|grandchild):(\d+)$/gm)) pids.set(match[1], Number(match[2]));
      if (pids.size === 2) controller.abort();
    },
  });
  assert.equal(result.structured?.cancelled, true, result.text);
  assert.equal(result.structured?.timedOut, false);
  assert.equal(pids.size, 2);
  for (const pid of pids.values()) {
    let state = "";
    for (let i = 0; i < 20; i++) {
      state = spawnSync("/bin/ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      if (!state || /^[ZX]/.test(state)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.match(state, /^(?:[ZX].*|)$/, `Descendant ${pid} remains live`);
  }
});
