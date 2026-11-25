import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { once } from "node:events";
import { constants, createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import http, { type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions } from "node:http";
import https from "node:https";
import type { LookupFunction, Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { connect as tlsConnect } from "node:tls";
import * as yauzl from "yauzl";
import type { EasyTierStatus } from "../../shared/settings.ts";
import { hasCode } from "../hand-tools/paths.ts";
import { Snapshots } from "../snapshots.ts";
import { EASYTIER_VERSION, easyTierArtifacts, easyTierSources } from "./easytier-release.ts";

const MAX_ZIP_BYTES = 40 * 1024 * 1024;
// 一段时间没有新数据才换下一个源；单源总时长只拦截极慢的涓流，不限制正常的慢速下载。
const STALL_MS = 20_000;
const SOURCE_MS = 10 * 60_000;
const PROGRESS_MS = 500;
const MAX_REDIRECTS = 5;
// 手动导入读取本机 ZIP 的上限，防止网络挂载等路径让 RPC 一直等待。
const IMPORT_MS = 2 * 60_000;
// Promise API 是 yauzl 3.4 新增的；当前 DefinitelyTyped 尚未包含这些签名。
type AsyncZip = yauzl.ZipFile & {
  eachEntry(): AsyncIterable<yauzl.Entry>;
  openReadStreamPromise(entry: yauzl.Entry): Promise<Readable>;
};
const { openPromise } = yauzl as typeof yauzl & {
  openPromise(file: string, options: { strictFileNames: boolean }): Promise<AsyncZip>;
};
type Artifact = (typeof easyTierArtifacts)[keyof typeof easyTierArtifacts];
type Activity = Pick<EasyTierStatus, "state" | "progress" | "error">;
type Report = (activity?: Activity) => void;
/** archivePath 从本地 ZIP 安装；sources 和 stallMs 仅供测试替换下载源与停滞时限。 */
type Options = { archivePath?: string; sources?: readonly string[]; stallMs?: number };
/** next 是取代本任务的导入；等待者跟随它，而不是去猜可能已被清空的槽位。 */
type Job = { promise: Promise<string>; stop: AbortController; next?: Job };
type Slot = { job?: Job; activity?: Activity; snapshots: Snapshots<EasyTierStatus> };

const target = `${process.platform}-${process.arch}`;
const asset: Artifact | undefined = Object.hasOwn(easyTierArtifacts, target)
  ? easyTierArtifacts[target as keyof typeof easyTierArtifacts] : undefined;
const unsupported = `EasyTier ${EASYTIER_VERSION} is unsupported on ${target}.`;
const cacheDirectory = (stateDir: string) => path.join(stateDir, "easytier", `v${EASYTIER_VERSION}`, target);
const slots = new Map<string, Slot>();

async function sha256(file: string, signal: AbortSignal) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) digest.update(chunk);
  return digest.digest("hex");
}

async function checkedFile(file: string, expected: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const entry = await lstat(file);
  if (!entry.isFile() || entry.size > MAX_ZIP_BYTES) throw new Error("Invalid EasyTier cache file.");
  if (await sha256(file, signal) !== expected) throw new Error("EasyTier SHA-256 verification failed.");
}

async function saveZip(source: Readable, target: string, expected: string, signal: AbortSignal,
  onChunk?: (bytes: number) => void) {
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    if (size > MAX_ZIP_BYTES) return callback(new Error("EasyTier archive is too large."));
    hash.update(chunk);
    onChunk?.(size);
    callback(null, chunk);
  } });
  await pipeline(source, meter, createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
  if (hash.digest("hex") !== expected) throw new Error("EasyTier archive SHA-256 verification failed.");
}

/**
 * 本机 ZIP 只按路径打开一次：对同一句柄确认是普通文件，再边复制到私有位置边计数、验摘要，
 * 之后只读这份副本。O_NONBLOCK 让 FIFO 不会卡在 open 上。
 */
async function copyArchive(file: string, target: string, expected: string, signal: AbortSignal) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) throw new Error("EasyTier ZIP not found.");
    throw error;
  });
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) throw new Error("EasyTier archive is not a regular file.");
    if (entry.size > MAX_ZIP_BYTES) throw new Error("EasyTier archive is too large.");
    await saveZip(handle.createReadStream({ autoClose: false }), target, expected, signal);
  } finally {
    await handle.close();
  }
}

/** 缓存目录不存在时返回 false；存在则逐个复核固定成员，损坏时抛错。 */
async function cacheReady(directory: string, artifact: Artifact, signal: AbortSignal) {
  const entry = await lstat(directory).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT")) throw error;
  });
  if (!entry) return false;
  if (!entry.isDirectory()) throw new Error("Invalid EasyTier cache directory.");
  for (const [name, hash] of Object.entries(artifact.members)) await checkedFile(path.join(directory, name), hash, signal);
  return true;
}

// 只影响本次下载：IPv4 地址排在前面，happy eyeballs 仍可在 IPv4 不通时改用 IPv6。
const ipv4First: LookupFunction = (hostname, options, callback) =>
  dnsLookup(hostname, { ...options, order: "ipv4first" }, callback as (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family: number) => void);

function proxyFor(url: URL): URL | undefined {
  const env = (name: string) => process.env[name] ?? process.env[name.toLowerCase()];
  const raw = url.protocol === "https:" ? env("HTTPS_PROXY") ?? env("HTTP_PROXY") : env("HTTP_PROXY");
  if (!raw) return undefined;
  const host = url.hostname.toLowerCase();
  const bypass = (env("NO_PROXY") ?? "").split(",").some((entry) => {
    const rule = entry.trim().toLowerCase().replace(/^\*?\./, "");
    return rule === "*" || (rule !== "" && (host === rule || host.endsWith(`.${rule}`)));
  });
  if (bypass) return undefined;
  const proxy = new URL(raw.includes("://") ? raw : `http://${raw}`);
  if (proxy.protocol !== "http:") throw new Error(`unsupported proxy ${proxy.protocol}`);
  return proxy;
}

function send(start: (callback: (response: IncomingMessage) => void) => ClientRequest) {
  return new Promise<IncomingMessage>((resolve, reject) => { start(resolve).once("error", reject).end(); });
}

async function request(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const headers: OutgoingHttpHeaders = { "user-agent": "remote-hand" };
  const proxy = proxyFor(url);
  if (!proxy) {
    const options: RequestOptions = { signal, headers, lookup: ipv4First };
    return send((callback) => (url.protocol === "https:" ? https : http).request(url, options, callback));
  }
  const authorization = proxy.username ? {
    "proxy-authorization": `Basic ${Buffer.from(
      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
  } : {};
  const via: RequestOptions = {
    host: proxy.hostname, port: proxy.port || 80, signal, lookup: ipv4First,
  };
  if (url.protocol !== "https:")
    return send((callback) => http.request({ ...via, path: url.href, headers: { ...headers, ...authorization } }, callback));
  const authority = `${url.hostname}:${url.port || 443}`;
  const tunnel = http.request({ ...via, method: "CONNECT", path: authority, headers: { host: authority, ...authorization } });
  tunnel.end();
  const [response, socket] = await once(tunnel, "connect", { signal }) as [IncomingMessage, Socket];
  if (response.statusCode !== 200) {
    socket.destroy();
    throw new Error(`proxy HTTP ${response.statusCode}`);
  }
  // 没有 agent 时 Node 按 80 判断默认端口；不指定会发出 Host: github.com:443，GitHub 回 301 到原 URL。
  return send((callback) => https.request(url, {
    signal, headers, defaultPort: 443, createConnection: () => tlsConnect({ socket, servername: url.hostname }),
  }, callback));
}

async function get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await request(url, signal);
    const status = response.statusCode ?? 0;
    if (status === 200) return response;
    // 不读正文：直接结束响应，换源或跳转时不留下仍占着连接的旧响应。
    response.destroy();
    if (status < 300 || status >= 400 || !response.headers.location) throw new Error(`HTTP ${status}`);
    const next = new URL(response.headers.location, url);
    // 只跟随 HTTP(S)，且不允许 HTTPS 降级为明文。
    if (next.protocol !== "https:" && (next.protocol !== "http:" || url.protocol === "https:"))
      throw new Error(`redirect to ${next.protocol} refused`);
    url = next;
  }
  throw new Error("too many redirects");
}

function downloading(received: number, total: number | null): Activity {
  return { state: "downloading", progress: { received, total }, error: null };
}

/**
 * 依次尝试各个源；连接失败、停滞、非 200、过大或摘要不符都换下一个。
 * 每个源都拿到了内容却没通过校验时，报 `EasyTier archive ...`，自动重试不会改变结果；
 * 只要有一个源是网络、HTTP 或停滞类失败，就报 `EasyTier download failed: ...`，留给重试。
 */
async function download(artifact: Artifact, target: string, options: Options, signal: AbortSignal, report: Report) {
  const failures: string[] = [];
  let integrity = true;
  for (const base of options.sources ?? easyTierSources) {
    const url = new URL(`${base}/v${EASYTIER_VERSION}/${artifact.file}`);
    const stall = new AbortController();
    const timer = setTimeout(() => stall.abort(), options.stallMs ?? STALL_MS);
    const slow = AbortSignal.timeout(SOURCE_MS);
    const attempt = AbortSignal.any([signal, stall.signal, slow]);
    report(downloading(0, null));
    try {
      const response = await get(url, attempt);
      timer.refresh();
      const total = Number(response.headers["content-length"]) || null;
      if (total && total > MAX_ZIP_BYTES) {
        response.destroy();
        throw new Error("EasyTier archive is too large.");
      }
      let reported = 0;
      await saveZip(response, target, artifact.sha256, attempt, (received) => {
        timer.refresh();
        if (Date.now() - reported < PROGRESS_MS) return;
        reported = Date.now();
        report(downloading(received, total));
      });
      return;
    } catch (error) {
      signal.throwIfAborted();
      const { code, message } = error as NodeJS.ErrnoException;
      const timedOut = stall.signal.aborted || slow.aborted;
      if (timedOut || !message.startsWith("EasyTier archive ")) integrity = false;
      const reason = stall.signal.aborted ? "stalled" : slow.aborted ? "too slow"
        : code ?? message.replace(/^EasyTier /, "").replace(/\.$/, "");
      failures.push(`${url.host} ${reason}`);
      await rm(target, { force: true });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${integrity ? "EasyTier archive failed verification from every source" : "EasyTier download failed"}: ${failures.join("; ")}.`);
}

async function extractMembers(archive: string, destination: string, artifact: Artifact, signal: AbortSignal) {
  const zip = await openPromise(archive, { strictFileNames: true });
  const remaining = new Map(Object.keys(artifact.members).map((name) => [`${artifact.directory}/${name}`, name]));
  try {
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      const name = remaining.get(entry.fileName);
      if (!name) continue; // 只解压清单内的固定成员；ZIP 里的路径和文件权限不参与写入。
      const file = path.join(destination, name);
      await pipeline(await zip.openReadStreamPromise(entry),
        createWriteStream(file, { flags: "wx", mode: name.startsWith("easytier-core") ? 0o700 : 0o600 }), { signal });
      await checkedFile(file, artifact.members[name], signal);
      remaining.delete(entry.fileName);
    }
  } finally {
    zip.close();
  }
  if (remaining.size) throw new Error("EasyTier archive does not contain all pinned files.");
}

async function install(stateDir: string, options: Options, signal: AbortSignal, report: Report): Promise<string> {
  if (!asset) throw new Error(unsupported);
  if (!path.isAbsolute(stateDir)) throw new Error("EasyTier requires an absolute plugin state directory.");
  const directory = cacheDirectory(stateDir);
  const parent = path.dirname(directory);
  const binary = path.join(directory, process.platform === "win32" ? "easytier-core.exe" : "easytier-core");
  let corrupt = false;
  try {
    if (await cacheReady(directory, asset, signal)) return binary;
  } catch (error) {
    // 只有显式提供的 ZIP 可以替换损坏的缓存；自动下载仍报错，由用户在设置页导入修复。
    if (!options.archivePath || signal.aborted) throw error;
    corrupt = true;
  }

  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, ".install-"));
  try {
    const zip = path.join(staging, "release.zip");
    const content = path.join(staging, "bin");
    await mkdir(content, { mode: 0o700 });
    if (options.archivePath) await copyArchive(options.archivePath, zip, asset.sha256, signal);
    else await download(asset, zip, options, signal, report);
    await extractMembers(zip, content, asset, signal);
    signal.throwIfAborted();
    // 损坏的旧缓存移进暂存目录，随 finally 一起删除。
    if (corrupt) await rename(directory, path.join(staging, "corrupt"));
    try {
      await rename(content, directory);
    } catch (error) {
      // 并发安装同一版本时只接受通过校验的获胜目录。
      if (!hasCode(error, "EEXIST", "ENOTEMPTY", "EPERM")) throw error;
      await cacheReady(directory, asset, signal);
    }
    return binary;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

function slotOf(stateDir: string): Slot {
  let slot = slots.get(stateDir);
  if (!slot) {
    const created: Slot = { snapshots: new Snapshots((): EasyTierStatus => {
      if (!asset) return { state: "failed", progress: null, error: unsupported, official: null };
      const official = { file: asset.file, url: asset.officialUrl };
      if (created.activity) return { ...created.activity, official };
      return { state: existsSync(cacheDirectory(stateDir)) ? "ready" : "missing", progress: null, error: null, official };
    }) };
    slots.set(stateDir, slot = created);
  }
  return slot;
}

/** 同一状态目录同时只有一个安装任务。它不随某个等待者取消，由停滞超时和单源上限收尾。 */
function start(stateDir: string, slot: Slot, options: Options): Job {
  const job = { stop: new AbortController() } as Job;
  const report: Report = (activity) => {
    if (slot.job !== job) return;
    slot.activity = activity;
    slot.snapshots.changed();
  };
  const settle = (activity?: Activity) => {
    report(activity);
    if (slot.job === job) slot.job = undefined;
  };
  job.promise = install(stateDir, options, job.stop.signal, report).then((binary) => {
    settle();
    return binary;
  }, (error: unknown) => {
    settle({ state: "failed", progress: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    throw error;
  });
  // 失败已写入状态；所有等待者都已取消时，它不能成为未处理的 rejection。
  job.promise.catch(() => {});
  slot.job = job;
  return job;
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

/** 缓存可用时复核摘要后返回；否则下载或从 archivePath 安装。signal 只结束本次等待。 */
export async function ensureEasyTier(stateDir: string, options: Options & { signal: AbortSignal }): Promise<string> {
  const slot = slotOf(stateDir);
  let job = slot.job ?? start(stateDir, slot, options);
  for (;;) {
    try {
      return await waitFor(job.promise, options.signal);
    } catch (error) {
      // 手动导入会取代进行中的任务；原等待者改等导入结果。
      if (!job.next) throw error;
      job = job.next;
    }
  }
}

/**
 * 用户提供的本地 ZIP。缓存健康时不读取文件、直接成功；否则先复制到私有暂存位置并完整校验，
 * 避免错误文件打断进行中的下载，再用这份副本取代下载或修复损坏的缓存。
 */
export async function importEasyTier(stateDir: string, file: string): Promise<void> {
  if (!asset) throw new Error(unsupported);
  const archive = file.replace(/^~(?=$|[\\/])/, homedir());
  if (!path.isAbsolute(archive)) throw new Error("Enter the absolute path of the EasyTier ZIP.");
  // Windows 的 UNC 路径会访问网络共享；只接受本机 ZIP。
  if (process.platform === "win32" && /^[\\/]{2}/.test(archive)) throw new Error("Enter a local path for the EasyTier ZIP.");
  const signal = AbortSignal.timeout(IMPORT_MS);
  const directory = cacheDirectory(stateDir);
  // 损坏或不可读的缓存都交给下面的安装处理：它会用导入的 ZIP 替换旧缓存。
  if (await cacheReady(directory, asset, signal).catch(() => false)) return;
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, ".import-"));
  try {
    const zip = path.join(staging, "release.zip");
    await copyArchive(archive, zip, asset.sha256, signal);
    const slot = slotOf(stateDir);
    const previous = slot.job;
    const job = start(stateDir, slot, { archivePath: zip });
    if (previous) {
      previous.next = job;
      previous.stop.abort();
    }
    await job.promise;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

export function easyTierSnapshots(stateDir: string): Snapshots<EasyTierStatus> {
  return slotOf(stateDir).snapshots;
}
