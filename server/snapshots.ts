import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";

export class Snapshots<T> {
  #watchers = new Set<() => void>();
  readonly #read: () => T;

  constructor(read: () => T) {
    this.#read = read;
  }

  subscribe(listener: () => void): () => void {
    this.#watchers.add(listener);
    return () => { this.#watchers.delete(listener); };
  }

  watch({ push, signal }: PluginSubscriptionContext<T>): void {
    if (signal.aborted) return;
    const remove = () => {
      unsubscribe();
      signal.removeEventListener("abort", remove);
    };
    const publish = () => { void push(this.#read()).catch(remove); };
    const unsubscribe = this.subscribe(publish);
    signal.addEventListener("abort", remove, { once: true });
    publish();
  }

  changed(): void {
    for (const publish of this.#watchers) publish();
  }
}
