import type { ConnectionPort } from "../protocol.ts";
import { ProtocolError, type Json } from "../frames.ts";

type Handler = Parameters<ConnectionPort["handle"]>[1];

export class DirectLinkLost extends ProtocolError {
  constructor() { super("disconnected", "EasyTier disconnected; new operations use relay."); }
}

/** 生命周期受认证 relay 控制；每项操作创建时绑定一条物理链路。 */
export class SelectedPort implements ConnectionPort {
  #direct?: ConnectionPort;
  #handlers = new Map<string, { handler: Handler; relay: () => void; direct?: () => void }>();
  readonly signal: AbortSignal;
  readonly #relay: ConnectionPort;

  constructor(relay: ConnectionPort) {
    this.#relay = relay;
    this.signal = relay.signal;
  }

  setDirect(port: ConnectionPort) {
    this.signal.throwIfAborted();
    port.signal.throwIfAborted();
    if (this.#direct) throw new Error("A direct port is already installed.");
    this.#direct = port;
    const unbind = () => {
      if (this.#direct !== port) return;
      this.#direct = undefined;
      this.#preferred = undefined;
      for (const binding of this.#handlers.values()) {
        binding.direct?.();
        binding.direct = undefined;
      }
    };
    port.signal.addEventListener("abort", unbind, { once: true });
    for (const [method, binding] of this.#handlers) binding.direct = port.handle(method, binding.handler);
  }

  // 安装 handler 和启用出站分开。等对端确认 handler 已安装，再向直连发起新操作。
  #preferred?: ConnectionPort;
  preferDirect(port: ConnectionPort) {
    if (this.#direct !== port || port.signal.aborted) return;
    this.#preferred = port;
  }

  #select() {
    this.signal.throwIfAborted();
    return this.#preferred && !this.#preferred.signal.aborted ? this.#preferred : this.#relay;
  }

  async request(...args: Parameters<ConnectionPort["request"]>) {
    return this.#select().request(...args);
  }

  open(...args: Parameters<ConnectionPort["open"]>) {
    const port = this.#select();
    const source = port.open(...args);
    if (args[0] === "tool.call") console.info(`Remote hand tool.call transport=${port === this.#relay ? "relay" : "direct"}`);
    if (port === this.#relay) return source;
    return {
      [Symbol.asyncIterator](): AsyncIterator<Json> {
        const reader = source[Symbol.asyncIterator]();
        return {
          async next() {
            try { return await reader.next(); } catch (error) {
              if (port.signal.aborted && !args[2]?.aborted) throw new DirectLinkLost();
              throw error;
            }
          },
          return: (value) => reader.return?.(value) ?? Promise.resolve({ value, done: true }),
        };
      },
    };
  }

  handle(method: string, handler: Handler) {
    const binding = {
      handler, relay: this.#relay.handle(method, handler),
      direct: this.#direct?.handle(method, handler),
    };
    this.#handlers.set(method, binding);
    return () => {
      binding.relay();
      binding.direct?.();
      if (this.#handlers.get(method) === binding) this.#handlers.delete(method);
    };
  }
}
