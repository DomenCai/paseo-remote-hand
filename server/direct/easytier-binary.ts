import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { hasCode } from "../hand-tools/paths.ts";
import { EASYTIER_VERSION, easyTierArtifacts } from "./easytier-release.ts";

const MAX_ZIP_BYTES = 40 * 1024 * 1024;
// Promise API 是 yauzl 3.4 新增的；当前 DefinitelyTyped 尚未包含这些签名。
type AsyncZip = yauzl.ZipFile & {
  eachEntry(): AsyncIterable<yauzl.Entry>;
  openReadStreamPromise(entry: yauzl.Entry): Promise<Readable>;
};
const { openPromise } = yauzl as typeof yauzl & {
  openPromise(file: string, options: { strictFileNames: boolean }): Promise<AsyncZip>;
};
type Artifact = (typeof easyTierArtifacts)[keyof typeof easyTierArtifacts];

async function checkedFile(file: string, expected: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const entry = await lstat(file);
  if (!entry.isFile() || entry.size > MAX_ZIP_BYTES) throw new Error("Invalid EasyTier cache file.");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) digest.update(chunk);
  if (digest.digest("hex") !== expected) throw new Error("EasyTier SHA-256 verification failed.");
}

async function streamZip(target: string, asset: Artifact, source: string | undefined, signal: AbortSignal) {
  let stream: Readable;
  if (source) {
    stream = createReadStream(source, { signal });
  } else {
    const response = await fetch(asset.url, { signal }).catch((error: unknown) => {
      if ((signal.reason as Error | undefined)?.name === "TimeoutError") throw new Error("EasyTier official download timed out.");
      signal.throwIfAborted();
      throw new Error("EasyTier official download failed.", { cause: error });
    });
    if (!response.ok || !response.body) throw new Error(`EasyTier official download failed (HTTP ${response.status}).`);
    stream = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
  }

  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    if (size > MAX_ZIP_BYTES) return callback(new Error("EasyTier archive is too large."));
    hash.update(chunk);
    callback(null, chunk);
  } });
  try {
    await pipeline(stream, meter, createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
  } catch (error) {
    if (!source && (signal.reason as Error | undefined)?.name === "TimeoutError")
      throw new Error("EasyTier official download timed out.");
    throw error;
  }
  if (hash.digest("hex") !== asset.sha256) throw new Error("EasyTier archive SHA-256 verification failed.");
}

async function extractMembers(archive: string, destination: string, asset: Artifact, signal: AbortSignal) {
  const zip = await openPromise(archive, { strictFileNames: true });
  const remaining = new Map(Object.keys(asset.members).map((name) => [`${asset.directory}/${name}`, name]));
  try {
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      const name = remaining.get(entry.fileName);
      if (!name) continue; // 只解压清单内的固定成员；ZIP 里的路径和文件权限不参与写入。
      const file = path.join(destination, name);
      await pipeline(await zip.openReadStreamPromise(entry),
        createWriteStream(file, { flags: "wx", mode: name.startsWith("easytier-core") ? 0o700 : 0o600 }), { signal });
      await checkedFile(file, asset.members[name], signal);
      remaining.delete(entry.fileName);
    }
  } finally {
    zip.close();
  }
  if (remaining.size) throw new Error("EasyTier archive does not contain all pinned files.");
}

/** 本地归档可用于离线安装，仍走和官方 URL 完全相同的验证。 */
export async function ensureEasyTier(
  stateDir: string,
  options: { signal: AbortSignal; archivePath?: string },
): Promise<string> {
  const { signal, archivePath } = options;
  const target = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(easyTierArtifacts, target)) throw new Error(`EasyTier ${EASYTIER_VERSION} is unsupported on ${target}.`);
  if (!path.isAbsolute(stateDir)) throw new Error("EasyTier requires an absolute plugin state directory.");
  const asset = easyTierArtifacts[target as keyof typeof easyTierArtifacts];
  const parent = path.join(stateDir, "easytier", `v${EASYTIER_VERSION}`);
  const directory = path.join(parent, target);
  const binary = path.join(directory, process.platform === "win32" ? "easytier-core.exe" : "easytier-core");
  const verifyDirectory = async () => {
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid EasyTier cache directory.");
    for (const [name, hash] of Object.entries(asset.members)) await checkedFile(path.join(directory, name), hash, signal);
  };

  const present = await lstat(directory).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT")) throw error;
  });
  if (present) {
    await verifyDirectory();
    return binary;
  }

  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, ".install-"));
  try {
    const zip = path.join(staging, "release.zip");
    const content = path.join(staging, "bin");
    await mkdir(content, { mode: 0o700 });
    await streamZip(zip, asset, archivePath, signal);
    await extractMembers(zip, content, asset, signal);
    signal.throwIfAborted();
    try {
      await rename(content, directory);
    } catch (error) {
      // 两个连接可同时准备同一版本；只接受通过校验的获胜目录。
      if (!hasCode(error, "EEXIST", "ENOTEMPTY", "EPERM")) throw error;
      await verifyDirectory();
    }
    return binary;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}
