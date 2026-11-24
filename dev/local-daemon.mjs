import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHostClient, parseHostTarget } from "@getpaseo/client/node";

export const pluginId = "remote-hand";

export async function withLocalDaemon(run) {
  const raw = process.env.PASEO_HOME ?? "~/.paseo";
  const home = resolve(raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
  const read = (file) => readFileSync(join(home, file), "utf8").trim();
  const { listen } = JSON.parse(read("paseo.pid"));
  const target = parseHostTarget(listen);
  if (target.kind !== "socket" || target.offer ||
      (!target.socketPath && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(target.url).hostname)))
    throw new Error("Expected a local Paseo daemon endpoint.");

  const client = createHostClient(listen, {
    clientId: `remote-hand-dev-${randomUUID()}`, clientType: "cli",
    localCredential: () => read("local-credential"),
    connectTimeoutMs: 10_000, reconnect: { enabled: false },
  });
  try {
    await client.connect();
    if (client.getLastServerInfoMessage()?.serverId !== read("server-id"))
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
