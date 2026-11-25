import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHostClient } from "@getpaseo/client/node";
import { localDaemonAddress, resolvePaseoHome } from "../server/daemon-location.mjs";

export const pluginId = "remote-hand";

export async function withLocalDaemon(run) {
  const home = resolvePaseoHome();
  const read = (file) => readFileSync(join(home, file), "utf8").trim();
  const address = localDaemonAddress(JSON.parse(read("paseo.pid")).listen);
  const serverId = read("server-id");
  const client = createHostClient(address, {
    clientId: `remote-hand-dev-${randomUUID()}`, clientType: "cli",
    localCredential: () => read("local-credential"),
    connectTimeoutMs: 10_000, reconnect: { enabled: false },
  });
  try {
    await client.connect();
    if (client.getLastServerInfoMessage()?.serverId !== serverId)
      throw new Error("Unexpected local Paseo daemon.");
    await run(client);
  } finally {
    await client.close();
  }
}

export function reportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/rh1\.[a-zA-Z0-9_-]+/g, "rh1.[REDACTED]"));
  process.exitCode = 1;
}
