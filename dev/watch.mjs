import { pluginId, reportError, withLocalDaemon } from "./local-daemon.mjs";

try {
  const [method, option, ...extra] = process.argv.slice(2);
  if (!method || (option !== undefined && option !== "--once") || extra.length)
    throw new Error("Usage: node dev/watch.mjs <subscription> [--once]");
  await withLocalDaemon(async (client) => {
    const watch = client.observePluginRpc(pluginId, method, {});
    let unsubscribe;
    let finish;
    const done = new Promise((resolve, reject) => {
      finish = () => resolve();
      unsubscribe = watch.subscribe({
        snapshot() {},
        update(message) {
          if (message.type === "plugin.rpc.event") {
            console.log(JSON.stringify(message.payload.event));
            if (option === "--once") finish();
          } else if (message.type === "plugin.rpc.closed") {
            const { error } = message.payload;
            if (error) reject(new Error(error));
            else finish();
          }
        },
        error: reject,
      });
    });
    const signal = client.subscribeConnectionStatus((status) => {
      if (status.status === "disconnected") finish();
    });
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
    try {
      await Promise.all([watch.ready, done]);
    } finally {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      signal();
      unsubscribe();
      await watch.release();
    }
  });
} catch (error) {
  reportError(error);
}
