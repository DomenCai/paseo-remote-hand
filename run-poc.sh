#!/bin/sh
set -eu
umask 077

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'Usage: sh run-poc.sh <brain-ssh-host|--pair-stdin> [hand-plugin-dir]' >&2
  exit 2
fi

run_dir="/tmp/paseo-remote-hand-$(id -u)"
plugin_dir=$(CDPATH= cd -- "${2:-$(dirname -- "$0")}" && pwd -P)
worker_path="$plugin_dir/worker/posix-ssh-worker.mjs"
if [ ! -f "$worker_path" ]; then
  echo 'SSH worker not found in the hand plugin directory' >&2
  exit 1
fi
mkdir -m 700 "$run_dir" 2>/dev/null || :

store_pairing() {
  # 链接只通过标准输入传入，写到 PoC 专用的私有配置文件。
  node -e '
  const fs = require("node:fs");
  try {
    const pair = JSON.parse(fs.readFileSync(0, "utf8"));
    const uri = new URL(pair.connectionUri);
    if (!pair.relayEnabled || uri.protocol !== "relay:" || !uri.hostname ||
        uri.searchParams.get("ssl") !== "true" || !uri.searchParams.get("key")) throw new Error();
    const [dir, workerPath] = process.argv.slice(1);
    const st = fs.lstatSync(dir);
    const id = fs.readFileSync(process.env.HOME + "/.paseo/server-id", "utf8").trim();
    if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700 ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error();
    const tmp = dir + "/." + require("node:crypto").randomUUID();
    fs.writeFileSync(tmp, JSON.stringify({ pairing: uri.href, handServerId: id, workerPath }),
      { mode: 0o600, flag: "wx" });
    try { fs.renameSync(tmp, dir + "/hand.json"); }
    finally { fs.rmSync(tmp, { force: true }); }
    console.log("pairing-configured");
  } catch {
    process.exitCode = 1;
  }' "$run_dir" "$worker_path"
}

fetch_pairing() {
  # 只在 brain 的 daemon 正在线且已有有效标识和密钥时获取当前配对。
  ssh -T -o BatchMode=yes -- "$1" 'sh -s' <<'REMOTE'
set -eu
paseo status --json 2>/dev/null | node -e '
  const fs = require("node:fs");
  try {
    const x = JSON.parse(fs.readFileSync(0, "utf8"));
    const home = process.env.HOME + "/.paseo";
    if (x.home !== home || x.localDaemon !== "running" || !x.relay?.enabled) throw new Error();
    for (const f of ["server-id", "daemon-keypair.json"]) {
      const s = fs.lstatSync(home + "/" + f);
      if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) throw new Error();
    }
    const id = fs.readFileSync(home + "/server-id", "utf8").trim();
    const key = JSON.parse(fs.readFileSync(home + "/daemon-keypair.json", "utf8"));
    const valid = (s) => typeof s === "string" && Buffer.from(s, "base64").length === 32 &&
      Buffer.from(s, "base64").toString("base64") === s;
    if (id !== x.serverId || key.v !== 2 || !valid(key.publicKeyB64) || !valid(key.secretKeyB64))
      throw new Error();
  } catch {
    console.error("Pairing guard failed: expected a running relay daemon with its existing identity");
    process.exitCode = 1;
  }'
paseo pair --json 2>/dev/null
REMOTE
}

case "$1" in
  --pair-stdin) store_pairing ;;
  *) fetch_pairing "$1" | store_pairing ;;
esac || {
  echo 'Could not store the current TLS relay pairing; check the brain relay and hand configuration' >&2
  exit 1
}

paseo plugin reload remote-hand
