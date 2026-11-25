import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { createHostClient, parseHostTarget } from "@getpaseo/client/node";

export function createLocalDaemon(home: string) {
  let client: ReturnType<typeof createHostClient> | undefined;
  let pending: Promise<{ client: ReturnType<typeof createHostClient>; paseo: ReturnType<typeof createPaseoApi> }> | undefined;
  let stopped = false;

  async function connect() {
    if (stopped) throw new Error("Remote hand plugin has stopped.");
    const read = (name: string) => readFileSync(join(home, name), "utf8").trim();
    const { listen } = JSON.parse(read("paseo.pid")) as { listen: string };
    const target = parseHostTarget(listen);
    if (target.kind !== "socket" || target.offer) throw new Error("Expected the local Paseo daemon.");
    let address = listen;
    if (!target.socketPath) {
      const url = new URL(target.url);
      if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
      if (url.hostname === "[::]") url.hostname = "[::1]";
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("Remote hand needs a loopback or local socket to contact the daemon.");
      address = url.href;
    }
    const serverId = read("server-id");
    const connection = client = createHostClient(address, {
      clientId: `remote-hand-brain-${randomUUID()}`, clientType: "cli",
      localCredential: () => read("local-credential"),
      connectTimeoutMs: 5_000, reconnect: { enabled: false },
    });
    try {
      await connection.connect();
      if (connection.getLastServerInfoMessage()?.serverId !== serverId)
        throw new Error("Unexpected local Paseo daemon.");
      if (stopped) throw new Error("Remote hand plugin has stopped.");
      return { client: connection, paseo: createPaseoApi(connection) };
    } catch (error) {
      await connection.close();
      if (client === connection) client = undefined;
      throw error;
    }
  }

  function get() {
    if (client?.getConnectionState().status === "disconnected") {
      void client.close();
      client = undefined;
      pending = undefined;
    }
    if (!pending) {
      const attempt = connect();
      pending = attempt;
      void attempt.catch(() => {
        if (pending === attempt) pending = undefined;
        if (!stopped) console.error("Remote hand could not open its local daemon connection.");
      });
    }
    return pending;
  }

  return {
    async api() { return (await get()).paseo; },
    async cancelAgent(agentId: string) { await (await get()).client.cancelAgent(agentId); },
    async close() {
      stopped = true;
      await client?.close();
    },
  };
}
