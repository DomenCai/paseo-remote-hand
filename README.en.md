# Remote hand

[中文](README.md) | English

Remote hand is a Paseo plugin. The **hand** is the local machine that holds your projects; the **brain** is the machine that runs the agent. Any machine can take both roles. On the hand, pick `remote-hand` and a remote model: the session for the chosen provider runs on the brain, while project reads, writes, and commands are carried out by the hand's tools.

The two sides set up a protected Noise channel through the plugin's own relay endpoint. The default is `relay.paseo.sh:443`; a self-hosted relay must speak the same v2 protocol and have a valid TLS certificate. You don't need to enable the Paseo daemon relay or exchange daemon pairing links. A pairing code is valid for five minutes and works only once; hand it to the intended device through a private channel. You can enable [EasyTier direct connections](docs/direct.md) on both sides, which requires a self-hosted rendezvous node ([one-click deploy script](deploy/rendezvous.sh); [setup notes](docs/direct.md#自建会合节点) in Chinese); pairing still goes through the configured relay.

## Installation

- **Illustrated guide**: the [installation guide](docs/install-guide.en.md) covers everything from prerequisites to pairing and first use, with a screenshot for each step.
- **Let a coding agent install it**: send the link to the [install manual for coding agents](docs/install-agent.en.md) to any coding agent and say "read this document and install this plugin for me":

  ```text
  Read https://github.com/DomenCai/paseo-remote-hand/blob/main/docs/install-agent.en.md and install this plugin for me
  ```

Below is a short summary of installing from the command line. Install Paseo 0.16.1 or later on both sides and turn plugins on. The brain must be able to run the chosen provider inside Paseo. The plugin injects MCP into its own sessions, so you don't need the daemon's MCP injection or Claude's Paseo Tools. On each of the two machines, run:

```sh
paseo plugin install git:DomenCai/paseo-remote-hand
```

Paseo clones the repository and runs `npm ci --omit=dev --ignore-scripts`. After installing, open Paseo's Plugins page and click Remote hand; its details page has a **Remote machines** tab (hand) and a **Connected devices** tab (brain). `paseo plugin ls remote-hand --json` shows the install directory as `path`; run the `dev/*.mjs` scripts from that directory.

For development you can also install from a local directory: run `npm ci --omit=dev --ignore-scripts` in the plugin directory, then `paseo plugin install "$PWD"`. After changing server code, run `paseo plugin reload remote-hand`.

## Pairing and revocation

Run the following commands in each machine's plugin directory. The dev tools only connect to the local daemon; if you use a custom Paseo home, set `PASEO_HOME` to that instance's directory first.

1. On the **brain**, check the endpoint and send an invite once `status` is `connected`.

   ```sh
   node dev/rpc.mjs endpoint.get
   node dev/rpc.mjs devices.invite '{"label":"My hand"}'
   ```

2. On the **hand**, read the pairing code into a temporary shell variable and pass it to the preview through standard input. The read command below works in zsh and bash. Don't put the pairing code in your command history.

   ```sh
   read -rs pairing_code
   printf '%s' "$pairing_code" | node -e 'console.log(JSON.stringify({pairingCode:require("node:fs").readFileSync(0,"utf8")}))' | node dev/rpc.mjs brains.preview -
   ```

3. Check the preview, then add the brain. If the preview lists risks, read them and put the confirmed codes in `acknowledgedRiskCodes`; the example below is for a preview with no risks.

   ```sh
   printf '%s' "$pairing_code" | node -e 'console.log(JSON.stringify({pairingCode:require("node:fs").readFileSync(0,"utf8"),name:"My brain",acknowledgedRiskCodes:[]}))' | node dev/rpc.mjs brains.add -
   unset pairing_code
   node dev/watch.mjs brains.watch
   ```

4. On the **brain**, list and revoke devices using the matching `deviceId` from the snapshot. The hand's subscription then shows the brain as `revoked`.

   ```sh
   node dev/watch.mjs devices.watch --once
   node dev/rpc.mjs devices.revoke '{"deviceId":"<deviceId>"}'
   ```

`brains.remove` deletes the local device key and brain record and tries to revoke the remote identity. If it returns `remoteRevoked: false`, the local side is removed but the remote revocation wasn't confirmed; you can revoke it again from the brain's device list.

The brain can switch relays with `node dev/rpc.mjs endpoint.set-relay '{"relay":"relay.example.com:443"}'`. Before switching, it tells online hands to save the new address and reconnect automatically. The existing endpoint key and device identities are kept, and unused invites become invalid. Run `node dev/watch.mjs endpoint.watch` to see the registration status; if registration fails, `lastError` in the snapshot has the reason.

A hand that was offline during the switch can copy the new `host:port` from the brain and reconnect manually, keeping its existing identity:

```sh
node dev/rpc.mjs brains.set-relay '{"brainId":"<brainId>","relay":"relay.example.com:443"}'
```

## Usage

1. On the hand, run `paseo provider models remote-hand` and copy a model ID of the form `<brainId>/<provider>/<model>`. You can also find it in `models` from `node dev/watch.mjs brains.watch --once`. The brain's **Connected devices** tab can limit which providers are offered; with **Allow all providers** on, the catalog lists every model available on the brain.
2. Start a session from a project directory on the hand. For example:

   ```sh
   paseo run --no-wait --new-workspace local --provider remote-hand \
     --model '<brainId>/claude/<model>' --cwd "$PWD" \
     'Read the first line of README, then run ls and report the results'
   ```

   `--new-workspace local` creates a new workspace for the given directory. Without it, Paseo may reuse the current agent's or terminal's workspace.

   Omit `--mode`, or pick **Use brain default** in the app, to use the default mode the brain has for the selected provider. On the brain, **Connected devices** → **Access control** → **Let devices choose permission modes** is off by default: each provider then offers only its default mode, and requests for any other mode are rejected. Turned on, devices can pick any mode the provider offers, including full access. Agents on the brain can also use the brain's own tools, so turn it on only for devices you trust. When creating a session, the app's mode list merges the options offered by each brain. Cursor's hand tools still ask for approval.
3. Use the **hand agent ID** returned by the command to view the timeline, wait, or stop. If a permission request appears, answer it with its request ID.

   ```sh
   paseo wait <agentId>
   paseo logs <agentId>
   paseo stop <agentId>
   paseo permit ls
   paseo permit allow <agentId> <requestId>
   ```

For generic ACP providers, the first user message the brain receives includes the project instructions. The hand's live and history timelines show the user's original text.

The restricted level is the default. A new session authorizes the project's real path; file tools can only access authorized projects, and `hand_bash` is refused. To run commands on the hand, switch that brain to the full level:

```sh
node dev/rpc.mjs brains.set-policy '{"brainId":"<brainId>","policy":"full"}'
```

The full level lets the brain use the hand tools to access any file and shell that the daemon's user can access. Enable it only for brains you trust. To go back to the restricted level, set `policy` to `restricted`.

## Windows hand

- Use Paseo 0.16.1 or later and Node 20.19+, and make sure the local daemon and `dev/*.mjs` read the same `PASEO_HOME`. The default is `%USERPROFILE%\.paseo` for the current account; prefer an absolute path when customizing it. Paseo expands `~/` but not `~\`. The dev scripts read `paseo.pid`, `server-id`, and `local-credential` from that directory and only connect to a local named pipe or loopback TCP. You can also pair directly in the app.
- Keep the Paseo home in a private NTFS user directory. `state.json` and its temporary write files contain device private keys, and Windows `0600` / `0700` modes don't stop other accounts from reading them. The plugin relies on ACLs inherited from the directory and doesn't set Windows ACLs itself. Restrict other accounts' access to a custom directory first; you can check the plugin state directory's permissions with `icacls (Join-Path $env:PASEO_HOME 'plugin-data\remote-hand')` (set `$env:PASEO_HOME` to the directory the daemon actually uses first). Don't put it in a shared folder, on a network drive, or on a volume that can't provide per-account ACLs.
- Projects use absolute paths with a drive letter (such as `C:\Work Space\repo`) or plain UNC paths. The restricted level authorizes by real directory; drive-relative paths, device paths, NTFS data streams, and named pipes are rejected. Creating files requires a file system that supports hard links. Overwrites replace the file with a temporary file, and on Windows the target file's own ACLs aren't copied, so don't let the tools overwrite such files until you've verified the behavior. Behavior with network shares, long paths, and files locked by other processes depends on the file system and Windows settings.
- At the full level, `hand_bash` prefers PowerShell 7 (`pwsh.exe`) from PATH, then the system Windows PowerShell, and skips profiles at startup. Cancellation uses `taskkill /T /F`; child processes that left the process tree, or whose parent exited first, may not be reclaimed. The plugin UI currently has no Git Bash option.
- Not yet verified on real Windows hardware. Still to test: installation and outbound relay pairing, reusing the device identity after restart, named-pipe connections, paths with spaces and different casing, rejecting junctions that escape the project, ACLs and locked files, and PowerShell and process-tree cancellation.

## Uninstall

1. On the hand, remove each brain with `brains.remove`. If the remote revocation isn't confirmed, revoke it with `devices.revoke` on that brain.
2. On each machine, run `paseo plugin remove remote-hand`. The plugin state directory is kept so a reinstall can reuse the identity.

## Known issues

- The brain's native tools remain available. The plugin describes the project location and the `hand_*` tools through the system prompt or the first user message, but the model may still call the brain's native tools. The tool prefix shown in the timeline depends on the selected provider. The restricted level only constrains the hand's tools.
- Catalogs and tool output go through the relay; regular requests and stream-open parameters have a 128 KiB frame limit. If the connection drops while a write or command is running, its result may be unknown; check the project and timeline before retrying.
- **Max running sessions per device** counts sessions that are starting or working on a turn; a Linux brain allows at most 2. At the limit, the device can't create a session or prompt an idle one; prompts to a session that is already running still go through. Claude has passed cross-machine acceptance testing; Codex, Antigravity, Grok, Kimi, and Pi have passed cross-machine hand file-read checks.

## State and development

Endpoint and device state is stored in `$PASEO_HOME/plugin-data/remote-hand/state.json`. On POSIX the directory mode is `0700` and the state file is `0600`; Windows relies on directory ACLs, see [Windows hand](#windows-hand). The directory is kept after the plugin is removed, so a reinstall can reuse the identity. Don't copy or share this directory.

Run the local type check and device authentication tests (tests need Node 22.18+):

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

For M1a integration, see the [application protocol](docs/protocol.md). For the low-level tests and integration notes of the optional direct connection, see [EasyTier direct connection](docs/direct.md) (both docs in Chinese).

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution to the original project. Dependencies keep their own licenses.
