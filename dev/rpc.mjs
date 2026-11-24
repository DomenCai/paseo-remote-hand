import { readFileSync } from "node:fs";
import { pluginId, reportError, withLocalDaemon } from "./local-daemon.mjs";

try {
  const [method, input = "{}", ...extra] = process.argv.slice(2);
  if (!method || extra.length) throw new Error("Usage: node dev/rpc.mjs <method> [json|-]");
  let payload;
  try {
    payload = JSON.parse(input === "-" ? readFileSync(0, "utf8") : input);
  } catch {
    throw new Error("RPC input must be valid JSON.");
  }
  await withLocalDaemon(async (client) => {
    const result = await client.invokePluginRpc(pluginId, method, payload);
    console.log(JSON.stringify(result));
  });
} catch (error) {
  reportError(error);
}
