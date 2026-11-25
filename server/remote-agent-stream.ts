import { remoteAgentJson, remoteAgentRequests, type RemoteAgentPort, type RemoteAgentRequest } from "../shared/remote-agent.ts";
import type { z } from "zod";

export function toRemoteJson(value: unknown) {
  // SDK 类型中的可选字段可能显式是 undefined；线上只能携带 JSON。
  return remoteAgentJson.parse(JSON.parse(JSON.stringify(value)));
}

export async function remoteRequest<M extends RemoteAgentRequest>(
  port: RemoteAgentPort, method: M, params: z.input<(typeof remoteAgentRequests)[M]["input"]>, signal?: AbortSignal,
): Promise<z.output<(typeof remoteAgentRequests)[M]["output"]>> {
  const schema = remoteAgentRequests[method];
  const result = await port.request(method, toRemoteJson(schema.input.parse(params)), signal);
  return schema.output.parse(result) as z.output<(typeof remoteAgentRequests)[M]["output"]>;
}

// SDK 和工具执行器用 push 回调。下游背压持续时，失败并让下一条流从游标补历史；不丢事件。
export class RemoteEventQueue<T> {
  private items: T[] = [];
  private waiter?: () => void;
  private ended = false;
  private failure?: Error;
  private readonly capacity: number;
  constructor(capacity: number) { this.capacity = capacity; }

  push(item: T) {
    if (this.ended) return;
    if (this.items.length === this.capacity) {
      this.end(new Error("Remote agent stream buffer exceeded; reconnect to catch up."));
      return;
    }
    this.items.push(item);
    this.waiter?.();
  }

  end(error?: Error) {
    this.ended = true;
    this.failure ??= error;
    this.waiter?.();
  }

  async *read(signal: AbortSignal): AsyncGenerator<T> {
    const abort = () => this.waiter?.();
    signal.addEventListener("abort", abort);
    try {
      for (;;) {
        signal.throwIfAborted();
        if (this.failure) throw this.failure;
        if (this.items.length) yield this.items.shift()!;
        else if (this.ended) return;
        else {
          await new Promise<void>((resolve) => { this.waiter = resolve; });
          this.waiter = undefined;
        }
      }
    } finally {
      signal.removeEventListener("abort", abort);
      this.waiter = undefined;
    }
  }
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
