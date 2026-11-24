import { z } from "zod";
import { ErrorCodeSchema, JsonSchema, MethodSchema, ProtocolError, RequestIdSchema, type Json, validate } from "./frames.ts";
import { streamFrame, Streams } from "./streams.ts";

export const PROTOCOL_VERSION = 1;
// Paseo 0.17.3 不允许插件模块导入根目录的 package.json；发布时同步 package.json。
const PLUGIN_VERSION = "0.0.1";
export const MAX_FRAME_BYTES = 128 * 1024;
const MAX_PENDING = 32;
const MAX_WRITES = 128;
const DEADLINE_MS = 10_000;

const frameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.int().positive(),
    pluginVersion: z.string().regex(/^[a-zA-Z0-9.+-]{1,64}$/),
    port: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("request"), id: RequestIdSchema, method: MethodSchema, payload: z.unknown() }),
  z.object({ type: z.literal("request.cancel"), id: RequestIdSchema }),
  z.object({ type: z.literal("response"), id: RequestIdSchema, payload: z.unknown() }),
  z.object({ type: z.literal("error"), id: RequestIdSchema, code: ErrorCodeSchema }),
  z.object({ type: z.literal("revoked") }),
  ...streamFrame,
]);
type Frame = z.infer<typeof frameSchema>;
type Request = Extract<Frame, { type: "request" }>;
type ControlHandler = (method: string, payload: unknown, afterReply: (run: () => void) => void) => unknown | Promise<unknown>;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: ProtocolError) => void;
  cleanup: () => void;
};
type Handler = (payload: Json, signal: AbortSignal) => Promise<Json> | AsyncIterable<Json>;

export interface ConnectionPort {
  readonly signal: AbortSignal;
  request(method: string, params: Json, signal?: AbortSignal): Promise<Json>;
  open(method: string, params: Json, signal?: AbortSignal): AsyncIterable<Json>;
  handle(method: string, handler: Handler): () => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: ProtocolError) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const reserved = (method: string) =>
  method === "describe" || method === "ping" || method === "self.revoke" ||
  method === "relay.move" || method.startsWith("auth.");
const isStream = (value: Promise<Json> | AsyncIterable<Json>): value is AsyncIterable<Json> =>
  value !== null && typeof value === "object" && Symbol.asyncIterator in value;

export class Peer {
  #pending = new Map<number, Pending>();
  #incoming = new Map<number, AbortController>();
  #writing = 0;
  #tail = Promise.resolve();
  #nextId = 1;
  #sentHello = false;
  #receivedHello = false;
  #supportsPort = false;
  #failure?: ProtocolError;
  #handler?: ControlHandler;
  #port?: ConnectionPort;
  #handlers = new Map<string, Handler>();
  #streams?: Streams;
  #lifetime = new AbortController();
  #ready = deferred<void>();
  #closed = deferred<ProtocolError>();
  #readyTimer = setTimeout(() => this.close(new ProtocolError("timeout")), DEADLINE_MS);
  readonly ready = this.#ready.promise;
  readonly closed = this.#closed.promise;

  readonly #sendText: (text: string) => Promise<void>;
  readonly #closeTransport: () => void;
  readonly #version: number;

  constructor(sendText: (text: string) => Promise<void>, closeTransport: () => void, version = PROTOCOL_VERSION) {
    this.#sendText = sendText;
    this.#closeTransport = closeTransport;
    this.#version = version;
    void this.ready.catch(() => {});
  }

  get failure() { return this.#failure; }
  get port() { return this.#lifetime.signal.aborted ? undefined : this.#port; }

  serve(handler: ControlHandler): void {
    this.#handler = handler;
  }

  // 仅在设备认证已确认时调用。旧版仍可配对和重连，但不会收到自己不认识的端口帧。
  activate(role: "brain" | "hand"): void {
    if (!this.#supportsPort || this.#lifetime.signal.aborted || this.#port) return;
    const streams = this.#streams = new Streams({
      role, send: (frame) => this.#send(frame), fail: () => this.close(),
      handle: (method, payload, signal) => {
        const handler = this.#handlers.get(method);
        if (!handler) throw new ProtocolError("invalid");
        const result = handler(payload, signal);
        if (isStream(result)) return result;
        void result.catch(() => {});
        throw new ProtocolError("invalid");
      },
    });
    this.#port = {
      signal: this.#lifetime.signal,
      request: async (method, params, signal) => {
        this.#checkMethod(method);
        return validate(JsonSchema, await this.request(method, params, DEADLINE_MS, signal));
      },
      open: (method, params, signal) => {
        this.#checkMethod(method);
        return streams.open(this.#nextId++, method, validate(JsonSchema, params), signal);
      },
      handle: (method, handler) => {
        if (this.#failure) throw this.#failure;
        this.#checkMethod(method);
        if (this.#handlers.has(method)) throw new Error(`Remote hand handler already registered: ${method}`);
        this.#handlers.set(method, handler);
        return () => {
          if (this.#handlers.get(method) === handler) this.#handlers.delete(method);
        };
      },
    };
  }

  start(): void {
    if (this.#failure) return;
    void this.#send({ type: "hello", protocolVersion: this.#version, pluginVersion: PLUGIN_VERSION, port: true })
      .then(() => { this.#sentHello = true; this.#checkReady(); })
      .catch(() => this.close());
  }

  receive(text: string): void {
    if (this.#failure) return;
    try {
      if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new ProtocolError("invalid");
      const frame = validate(frameSchema, JSON.parse(text));
      switch (frame.type) {
        case "hello":
          if (this.#receivedHello) throw new ProtocolError("invalid");
          if (frame.protocolVersion !== this.#version) {
            throw new ProtocolError("version",
              `Incompatible Remote hand protocol: brain v${frame.protocolVersion} (plugin ${frame.pluginVersion}), local v${this.#version}.`);
          }
          this.#receivedHello = true;
          this.#supportsPort = frame.port === true;
          this.#checkReady();
          return;
        case "revoked":
          if (!this.#receivedHello) throw new ProtocolError("invalid");
          this.close(new ProtocolError("revoked"));
          return;
        case "request":
          if (!this.#receivedHello) throw new ProtocolError("invalid");
          void this.#respond(frame).catch(() => this.close());
          return;
        case "request.cancel":
          if (!this.#receivedHello || !this.#supportsPort) throw new ProtocolError("invalid");
          this.#incoming.get(frame.id)?.abort(new ProtocolError("canceled"));
          return;
        case "response":
        case "error": {
          if (!this.#receivedHello) throw new ProtocolError("invalid");
          const pending = this.#pending.get(frame.id);
          if (!pending) return;
          pending.cleanup();
          if (frame.type === "error") pending.reject(new ProtocolError(frame.code));
          else pending.resolve(frame.payload);
          return;
        }
        default:
          if (!this.#streams) throw new ProtocolError("invalid");
          this.#streams.receive(frame);
      }
    } catch (error) {
      this.close(error instanceof ProtocolError ? error : new ProtocolError("invalid"));
    }
  }

  async request(method: string, payload: unknown = null, timeout = DEADLINE_MS, signal?: AbortSignal): Promise<unknown> {
    await this.ready;
    if (this.#failure) throw this.#failure;
    if (signal?.aborted) throw new ProtocolError("canceled");
    if (this.#pending.size >= MAX_PENDING) throw new ProtocolError("busy");
    const id = this.#nextId++;
    const pending = deferred<unknown>();
    const cleanup = () => {
      this.#pending.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const cancel = (error: ProtocolError) => {
      cleanup();
      pending.reject(error);
      if (this.#supportsPort)
        void this.#send({ type: "request.cancel", id }).catch(() => this.close());
    };
    const abort = () => cancel(new ProtocolError("canceled"));
    const timer = setTimeout(() => cancel(new ProtocolError("timeout")), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    this.#pending.set(id, { ...pending, cleanup });
    void this.#send({ type: "request", id, method, payload }).catch((error) => {
      if (!this.#pending.has(id)) return;
      cleanup();
      pending.reject(error instanceof ProtocolError ? error : new ProtocolError("disconnected"));
    });
    return pending.promise;
  }

  async notifyRevoked(): Promise<void> {
    // 先释放应用层权限，再等待撤销通知发出。
    this.#lifetime.abort(new ProtocolError("revoked"));
    this.#streams?.close(new ProtocolError("revoked"));
    this.#handlers.clear();
    for (const stop of this.#incoming.values()) stop.abort(new ProtocolError("revoked"));
    const deadline = setTimeout(() => this.close(new ProtocolError("revoked")), 500);
    try {
      await this.#send({ type: "revoked" });
    } catch {
      // 通知失败时，下次认证仍会收到 revoked。
    } finally {
      clearTimeout(deadline);
      this.close(new ProtocolError("revoked"));
    }
  }

  close(error = new ProtocolError("disconnected")): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#lifetime.abort(error);
    this.#streams?.close(error);
    this.#handlers.clear();
    clearTimeout(this.#readyTimer);
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    for (const stop of this.#incoming.values()) stop.abort(error);
    this.#closed.resolve(error);
    this.#closeTransport();
  }

  #checkMethod(method: string): void {
    validate(MethodSchema, method);
    if (reserved(method)) throw new ProtocolError("invalid");
    if (this.#lifetime.signal.aborted) throw this.#lifetime.signal.reason;
  }

  #checkReady() {
    if (this.#sentHello && this.#receivedHello) {
      clearTimeout(this.#readyTimer);
      this.#ready.resolve();
    }
  }

  async #send(frame: Frame): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (this.#writing >= MAX_WRITES) throw new ProtocolError("busy");
    let text: string;
    try { text = JSON.stringify(frame); } catch { throw new ProtocolError("invalid"); }
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new ProtocolError("limit");
    this.#writing++;
    const pending = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      try {
        await this.#sendText(text);
      } catch {
        const error = new ProtocolError("disconnected");
        this.close(error);
        throw error;
      }
    });
    // 在同一有界队列按顺序交付帧，单条流每次只放入一个数据块。
    this.#tail = pending.catch(() => {});
    try {
      await pending;
    } finally {
      this.#writing--;
    }
  }

  async #respond(frame: Request): Promise<void> {
    if (this.#incoming.has(frame.id)) throw new ProtocolError("invalid");
    if (this.#incoming.size >= MAX_PENDING) {
      await this.#send({ type: "error", id: frame.id, code: "busy" });
      return;
    }
    const stop = new AbortController();
    this.#incoming.set(frame.id, stop);
    let afterReply: (() => void) | undefined;
    try {
      let response: Frame;
      try {
        const app = this.#handlers.get(frame.method);
        let payload: unknown;
        if (app) {
          const result = app(validate(JsonSchema, frame.payload), stop.signal);
          if (isStream(result)) throw new ProtocolError("invalid");
          payload = validate(JsonSchema, await result);
        } else {
          if (!this.#handler) throw new ProtocolError("invalid");
          payload = await this.#handler(frame.method, frame.payload, (run) => { afterReply = run; });
        }
        response = { type: "response", id: frame.id, payload };
      } catch (error) {
        response = { type: "error", id: frame.id, code: error instanceof ProtocolError ? error.code : "failure" };
      }
      if (!this.#failure && !stop.signal.aborted) {
        try {
          await this.#send(response);
        } catch (error) {
          if (error instanceof ProtocolError && error.code === "limit")
            await this.#send({ type: "error", id: frame.id, code: "limit" });
          else throw error;
        }
      }
    } finally {
      this.#incoming.delete(frame.id);
      afterReply?.();
    }
  }
}
