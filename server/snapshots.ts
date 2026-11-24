import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";

export class Snapshots<T> {
  #watchers = new Set<() => void>();
  readonly #read: () => T;

  constructor(read: () => T) {
    this.#read = read;
  }

  watch({ push, signal }: PluginSubscriptionContext<T>): void {
    if (signal.aborted) return;
    const remove = () => {
      this.#watchers.delete(publish);
      signal.removeEventListener("abort", remove);
    };
    const publish = () => { void push(this.#read()).catch(remove); };
    this.#watchers.add(publish);
    signal.addEventListener("abort", remove, { once: true });
    publish();
  }

  changed(): void {
    for (const publish of this.#watchers) publish();
  }
}
