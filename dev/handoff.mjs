import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHostClient, parseHostTarget } from "@getpaseo/client/node";

try {
  const { values, positionals } = parseArgs({
    options: { cwd: { type: "string" }, model: { type: "string" }, mode: { type: "string" } },
    allowPositionals: true,
  });
  const [prompt] = positionals;
  if (positionals.length !== 1 || !prompt.trim())
    throw new Error("Usage: node dev/handoff.mjs [--cwd <path>] [--model <id>] [--mode <id>] <prompt>");

  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const read = (file) => readFileSync(join(home, file), "utf8").trim();
  const { listen } = JSON.parse(read("paseo.pid"));
  const target = parseHostTarget(listen);
  if (target.kind !== "socket" || target.offer ||
      (!target.socketPath && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(target.url).hostname)))
    throw new Error("Expected a local Paseo daemon endpoint");

  const client = createHostClient(listen, {
    clientId: `remote-hand-dev-${randomUUID()}`, clientType: "cli",
    localCredential: () => read("local-credential"),
    connectTimeoutMs: 10000, reconnect: { enabled: false },
  });
  try {
    await client.connect();
    if (client.getLastServerInfoMessage()?.serverId !== read("server-id"))
      throw new Error("Unexpected local Paseo daemon");
    const ref = await client.invokePluginRpc("remote-hand", "submit", {
      prompt, handCwd: resolve(values.cwd ?? "."),
      ...(values.model && { model: values.model }),
      ...(values.mode && { modeId: values.mode }),
    });
    console.log(JSON.stringify(ref));
  } finally {
    await client.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
