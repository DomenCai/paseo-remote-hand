import { z } from "zod";
import { ErrorCodeSchema, JsonSchema, MethodSchema, ProtocolError, RequestIdSchema, type Json, validate } from "./frames.ts";

export const STREAM_CHUNK_BYTES = 32 * 1024;
export const STREAM_WINDOW_BYTES = 512 * 1024;
export const CONNECTION_WINDOW_BYTES = 2 * 1024 * 1024;
const MAX_STREAMS = 16;

type Role = "brain" | "hand";
const id = z.string().regex(/^[bh]:[1-9]\d{0,15}$/);
export const streamFrame = [
  z.object({
    type: z.literal("stream.open"), streamId: id, requestId: RequestIdSchema,
    method: MethodSchema, payload: JsonSchema,
  }),
  z.object({
    type: z.literal("stream.data"), streamId: id, final: z.boolean(),
    chunk: z.string().min(1).max(Math.ceil(STREAM_CHUNK_BYTES / 3) * 4),
  }),
  z.object({ type: z.literal("stream.end"), streamId: id }),
  z.object({ type: z.literal("stream.reset"), streamId: id, code: ErrorCodeSchema }),
  z.object({
    type: z.literal("stream.credit"), streamId: id,
    bytes: z.union([z.literal(0), z.literal(STREAM_WINDOW_BYTES)]),
  }),
] as const;

type Frame = z.infer<(typeof streamFrame)[number]>;
type Handler = (method: string, payload: Json, signal: AbortSignal) => AsyncIterable<Json>;
type Environment = {
  role: Role;
  send: (frame: Frame) => Promise<void>;
  handle: Handler;
  fail: () => void;
};

type Pull = {
  resolve: (result: IteratorResult<Json>) => void;
  reject: (error: ProtocolError) => void;
};

type Reader = {
  id: string;
  pending?: Pull;
  parts: Buffer[];
  bytes: number;
  failure?: ProtocolError;
  ended: boolean;
  release?: () => void;
};

type Writer = {
  id: string;
  stop: AbortController;
  granted: boolean;
  inEvent: boolean;
  reserved: number;
  finalSent: boolean;
  wake?: () => void;
};

const ended: IteratorResult<Json> = { done: true, value: undefined };
const prefix = (role: Role) => role === "brain" ? "b:" : "h:";

export class Streams {
  #readers = new Map<string, Reader>();
  #writers = new Map<string, Writer>();
  #receiving = 0;
  #sending = 0;
  #failure?: ProtocolError;
  readonly #env: Environment;

  constructor(env: Environment) {
    this.#env = env;
  }

  open(requestId: number, method: string, payload: Json, signal?: AbortSignal): AsyncIterable<Json> {
    const streamId = prefix(this.#env.role) + requestId;
    const reader: Reader = { id: streamId, parts: [], bytes: 0, ended: false };
    let opened = false;
    const iterator: AsyncIterableIterator<Json> = {
      [Symbol.asyncIterator]() { return this; },
      next: async () => {
        if (reader.failure) throw reader.failure;
        if (reader.ended) return ended;
        if (this.#failure) throw this.#failure;
        if (signal?.aborted) throw new ProtocolError("canceled");
        if (reader.pending) throw new ProtocolError("busy", "Read each Remote hand stream sequentially.");
        const first = !opened;
        if (first) {
          if (this.#readers.size >= MAX_STREAMS) throw new ProtocolError("busy");
          this.#readers.set(streamId, reader);
          opened = true;
          if (signal) {
            const abort = () => this.#resetReader(reader, new ProtocolError("canceled"));
            signal.addEventListener("abort", abort, { once: true });
            reader.release = () => signal.removeEventListener("abort", abort);
          }
        }
        const pending = new Promise<IteratorResult<Json>>((resolve, reject) => {
          reader.pending = { resolve, reject };
        });
        // 一次 next 对应一次额度，消费完当前事件之前不预读下一项。
        const grant = () => {
          if (!reader.ended) this.#emit({ type: "stream.credit", streamId, bytes: STREAM_WINDOW_BYTES });
        };
        if (first) {
          void this.#env.send({ type: "stream.open", streamId, requestId, method, payload }).then(grant, (error) => {
            if (!reader.ended) this.#finishReader(reader, error instanceof ProtocolError ? error : new ProtocolError("disconnected"));
          });
        } else {
          grant();
        }
        return pending;
      },
      return: async () => {
        if (!reader.ended && !reader.failure) this.#resetReader(reader);
        return ended;
      },
    };
    return iterator;
  }

  receive(frame: Frame): void {
    if (this.#failure) return;
    if (frame.type === "stream.open") {
      const remote = this.#env.role === "brain" ? "h:" : "b:";
      if (frame.streamId !== remote + frame.requestId || this.#writers.has(frame.streamId))
        throw new ProtocolError("invalid");
      if (this.#writers.size >= MAX_STREAMS) {
        this.#emit({ type: "stream.reset", streamId: frame.streamId, code: "busy" });
        return;
      }
      const writer: Writer = {
        id: frame.streamId, stop: new AbortController(), granted: false, inEvent: false, reserved: 0, finalSent: false,
      };
      this.#writers.set(frame.streamId, writer);
      void this.#produce(writer, frame).catch(this.#env.fail);
      return;
    }
    const reader = this.#readers.get(frame.streamId);
    const writer = this.#writers.get(frame.streamId);
    if (frame.type === "stream.reset") {
      const failure = new ProtocolError(frame.code);
      if (reader) this.#finishReader(reader, failure);
      if (writer) this.#stopWriter(writer, failure);
    } else if (frame.type === "stream.credit" && writer && !writer.stop.signal.aborted) {
      if (frame.bytes === 0) {
        if (!writer.reserved || !writer.finalSent) throw new ProtocolError("invalid");
        this.#releaseBytes(writer);
      } else {
        if (writer.granted || writer.inEvent) throw new ProtocolError("invalid");
        writer.granted = true;
        writer.wake?.();
      }
    } else if (frame.type === "stream.end" && reader) {
      if (!reader.pending || reader.bytes) throw new ProtocolError("invalid");
      this.#finishReader(reader);
    } else if (frame.type === "stream.data" && reader) {
      this.#receiveData(reader, frame);
    }
    // reset/断线时已在传输中的帧可以迟到；已释放的流不会再接收它们。
  }

  close(failure: ProtocolError): void {
    this.#failure = failure;
    for (const reader of this.#readers.values()) this.#finishReader(reader, failure);
    for (const writer of this.#writers.values()) this.#stopWriter(writer, failure);
  }

  #emit(frame: Frame): void {
    void this.#env.send(frame).catch(this.#env.fail);
  }

  #resetReader(reader: Reader, failure?: ProtocolError): void {
    if (this.#readers.has(reader.id)) {
      this.#emit({ type: "stream.reset", streamId: reader.id, code: failure?.code ?? "canceled" });
    }
    this.#finishReader(reader, failure);
  }

  #finishReader(reader: Reader, failure?: ProtocolError): void {
    this.#readers.delete(reader.id);
    reader.ended = true;
    reader.failure = failure;
    reader.release?.();
    this.#receiving -= reader.bytes;
    reader.bytes = 0;
    reader.parts = [];
    if (failure) reader.pending?.reject(failure);
    else reader.pending?.resolve(ended);
    reader.pending = undefined;
  }

  #receiveData(reader: Reader, frame: Extract<Frame, { type: "stream.data" }>): void {
    const chunk = Buffer.from(frame.chunk, "base64");
    if (!reader.pending || chunk.length === 0 || chunk.length > STREAM_CHUNK_BYTES ||
        (!frame.final && chunk.length !== STREAM_CHUNK_BYTES) ||
        chunk.toString("base64") !== frame.chunk ||
        reader.bytes + chunk.length > STREAM_WINDOW_BYTES ||
        this.#receiving + chunk.length > CONNECTION_WINDOW_BYTES)
      throw new ProtocolError("invalid");

    reader.parts.push(chunk);
    reader.bytes += chunk.length;
    this.#receiving += chunk.length;
    if (!frame.final) return;

    let value: Json;
    try {
      value = validate(JsonSchema, JSON.parse(Buffer.concat(reader.parts, reader.bytes).toString("utf8")));
    } catch {
      this.#resetReader(reader, new ProtocolError("invalid"));
      return;
    }
    this.#receiving -= reader.bytes;
    reader.parts = [];
    reader.bytes = 0;
    const pending = reader.pending;
    reader.pending = undefined;
    // 零字节回执只释放发送方的连接窗口，不补这条流的额度。
    this.#emit({ type: "stream.credit", streamId: reader.id, bytes: 0 });
    pending.resolve({ done: false, value });
  }

  #releaseBytes(writer: Writer): void {
    this.#sending -= writer.reserved;
    writer.reserved = 0;
    writer.finalSent = false;
    writer.inEvent = false;
    for (const active of this.#writers.values()) active.wake?.();
  }

  #stopWriter(writer: Writer, failure: ProtocolError): void {
    writer.stop.abort(failure);
    this.#releaseBytes(writer);
    writer.wake?.();
  }

  async #wait(writer: Writer, ready: () => boolean): Promise<void> {
    while (!ready()) {
      writer.stop.signal.throwIfAborted();
      await new Promise<void>((resolve) => { writer.wake = resolve; });
      writer.wake = undefined;
    }
    writer.stop.signal.throwIfAborted();
  }

  async #produce(writer: Writer, frame: Extract<Frame, { type: "stream.open" }>): Promise<void> {
    const streamId = frame.streamId;
    const { signal } = writer.stop;
    let iterator: AsyncIterator<Json> | undefined;
    try {
      for (;;) {
        await this.#wait(writer, () => writer.granted);
        writer.granted = false;
        writer.inEvent = true;
        iterator ??= this.#env.handle(frame.method, frame.payload, signal)[Symbol.asyncIterator]();
        const item = await iterator.next();
        signal.throwIfAborted();
        if (item.done) {
          iterator = undefined;
          await this.#env.send({ type: "stream.end", streamId });
          return;
        }
        const text = JSON.stringify(item.value);
        if (text === undefined) throw new ProtocolError("invalid");
        const size = Buffer.byteLength(text);
        if (size > STREAM_WINDOW_BYTES) throw new ProtocolError("limit");
        await this.#wait(writer, () => {
          if (this.#sending + size > CONNECTION_WINDOW_BYTES) return false;
          // 检查和预留在同一个同步步骤完成，避免多个苏醒的写入方抢到同一份额度。
          writer.reserved = size;
          this.#sending += size;
          return true;
        });
        const bytes = Buffer.from(text);
        for (let offset = 0; offset < size; offset += STREAM_CHUNK_BYTES) {
          signal.throwIfAborted();
          const end = Math.min(offset + STREAM_CHUNK_BYTES, size);
          writer.finalSent = end === size;
          await this.#env.send({
            type: "stream.data", streamId, final: writer.finalSent,
            chunk: bytes.subarray(offset, end).toString("base64"),
          });
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        const failure = error instanceof ProtocolError ? error : new ProtocolError("failure");
        this.#stopWriter(writer, failure);
        this.#emit({ type: "stream.reset", streamId, code: failure.code });
      }
    } finally {
      this.#releaseBytes(writer);
      try {
        await iterator?.return?.();
      } catch {
        // 流退出后不覆盖已向对端交付的错误。
      } finally {
        this.#writers.delete(streamId);
      }
    }
  }
}
