import { z } from "zod";

export const PROTOCOL_VERSION = 1;
// Paseo 0.17.3 不允许插件模块导入根目录的 package.json；发布时同步 package.json。
const PLUGIN_VERSION = "0.0.1";
export const MAX_FRAME_BYTES = 128 * 1024;
const MAX_PENDING = 32;
const DEADLINE_MS = 10_000;

const errorMessages = {
  invalid: "Invalid Remote hand protocol message.",
  version: "Incompatible Remote hand protocol version.",
  busy: "Too many Remote hand requests in flight.",
  timeout: "The Remote hand connection timed out.",
  disconnected: "The Remote hand connection closed.",
  identity: "Remote hand could not verify the device signature.",
  invite: "The invitation has expired, has already been used, or is invalid.",
  risks: "Confirm all current risks before adding this brain.",
  revoked: "This device is no longer authorized by the brain.",
  failure: "The brain could not complete the Remote hand request.",
} as const;
type ErrorCode = keyof typeof errorMessages;

export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string = errorMessages[code]) {
    super(message);
    this.code = code;
  }
}

const requestId = z.int().positive();
const frameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.int().positive(),
    pluginVersion: z.string().regex(/^[a-zA-Z0-9.+-]{1,64}$/),
  }),
  z.object({ type: z.literal("request"), id: requestId, method: z.string().max(64), payload: z.unknown() }),
  z.object({ type: z.literal("response"), id: requestId, payload: z.unknown() }),
  z.object({ type: z.literal("error"), id: requestId, code: z.enum(Object.keys(errorMessages) as ErrorCode[]) }),
  z.object({ type: z.literal("revoked") }),
]);
type Frame = z.infer<typeof frameSchema>;
type Request = Extract<Frame, { type: "request" }>;
type Handler = (method: string, payload: unknown) => unknown | Promise<unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: ProtocolError) => void; timer: NodeJS.Timeout };

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProtocolError("invalid");
  return result.data;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: ProtocolError) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

export class Peer {
  #pending = new Map<number, Pending>();
  #incoming = new Set<number>();
  #writing = 0;
  #nextId = 1;
  #sentHello = false;
  #receivedHello = false;
  #failure?: ProtocolError;
  #handler?: Handler;
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
    // 不要求连接接受方一定 await ready；关闭路径仍会拒绝这份 promise。
    void this.ready.catch(() => {});
  }

  get failure() { return this.#failure; }

  serve(handler: Handler): void {
    this.#handler = handler;
  }

  start(): void {
    if (this.#failure) return;
    // 即便先收到了对方的 hello，也要等本方的 hello 交给传输后再开放请求。
    void this.#send({ type: "hello", protocolVersion: this.#version, pluginVersion: PLUGIN_VERSION })
      .then(() => { this.#sentHello = true; this.#checkReady(); })
      .catch(() => this.close());
  }

  receive(text: string): void {
    if (this.#failure) return;
    try {
      if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new ProtocolError("invalid");
      const frame = validate(frameSchema, JSON.parse(text));
      if (frame.type === "hello") {
        if (this.#receivedHello) throw new ProtocolError("invalid");
        if (frame.protocolVersion !== this.#version) {
          throw new ProtocolError("version",
            `Incompatible Remote hand protocol: brain v${frame.protocolVersion} (plugin ${frame.pluginVersion}), local v${this.#version}.`);
        }
        this.#receivedHello = true;
        this.#checkReady();
        return;
      }
      if (!this.#receivedHello) throw new ProtocolError("invalid");
      if (frame.type === "revoked") {
        this.close(new ProtocolError("revoked"));
      } else if (frame.type === "request") {
        void this.#respond(frame).catch(() => this.close());
      } else {
        const pending = this.#pending.get(frame.id);
        if (!pending) return; // 超时后的迟到响应没有对应请求。
        this.#pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.type === "error") pending.reject(new ProtocolError(frame.code));
        else pending.resolve(frame.payload);
      }
    } catch (error) {
      this.close(error instanceof ProtocolError ? error : new ProtocolError("invalid"));
    }
  }

  async request(method: string, payload: unknown = null, timeout = DEADLINE_MS): Promise<unknown> {
    await this.ready;
    if (this.#failure) throw this.#failure;
    if (this.#pending.size >= MAX_PENDING) throw new ProtocolError("busy");
    const id = this.#nextId++;
    const pending = deferred<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      pending.reject(new ProtocolError("timeout"));
    }, timeout);
    this.#pending.set(id, { ...pending, timer });
    void this.#send({ type: "request", id, method, payload }).catch(() => this.close());
    return pending.promise;
  }

  async notifyRevoked(): Promise<void> {
    const deadline = setTimeout(() => this.close(new ProtocolError("revoked")), 500);
    try {
      await this.#send({ type: "revoked" });
    } catch {
      // 在线通知失败时，设备也会在下次认证收到 revoked。
    } finally {
      clearTimeout(deadline);
      this.close(new ProtocolError("revoked"));
    }
  }

  close(error = new ProtocolError("disconnected")): void {
    if (this.#failure) return;
    this.#failure = error;
    clearTimeout(this.#readyTimer);
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#closed.resolve(error);
    this.#closeTransport();
  }

  #checkReady() {
    if (this.#sentHello && this.#receivedHello) {
      clearTimeout(this.#readyTimer);
      this.#ready.resolve();
    }
  }

  async #send(frame: Frame): Promise<void> {
    if (this.#failure) throw this.#failure;
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new ProtocolError("invalid");
    if (this.#writing >= MAX_PENDING) throw new ProtocolError("busy");
    this.#writing++;
    try {
      await this.#sendText(text);
    } finally {
      this.#writing--;
    }
  }

  async #respond(frame: Request): Promise<void> {
    if (this.#incoming.has(frame.id)) throw new ProtocolError("invalid");
    if (this.#incoming.size >= MAX_PENDING) throw new ProtocolError("busy");
    this.#incoming.add(frame.id);
    try {
      let response: Frame;
      try {
        if (!this.#handler) throw new ProtocolError("invalid");
        const payload = await this.#handler(frame.method, frame.payload);
        response = { type: "response", id: frame.id, payload };
      } catch (error) {
        response = { type: "error", id: frame.id, code: error instanceof ProtocolError ? error.code : "failure" };
      }
      if (!this.#failure) await this.#send(response);
    } finally {
      this.#incoming.delete(frame.id);
    }
  }
}
