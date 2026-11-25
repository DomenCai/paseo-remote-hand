# Remote hand install manual (for coding agents)

> This document is written for coding agents. The user only needs to tell an agent "read this document and install this plugin for me", and the agent follows it from the top. For the illustrated guide for people, see the [installation guide](install-guide.en.md). 中文版：[install-agent.md](install-agent.md)。

## Your goal

Install the Paseo plugin `remote-hand` on the user's machine, confirm that it runs, and, when the user wants, help pair two machines.

First understand the two roles:

- **brain**: the machine that runs agents and provides providers such as Claude and Codex.
- **hand**: the machine that holds the projects. The user creates a session on the hand and picks a remote model. The session runs on the brain, while project reads, writes, and commands run on the hand.
- One machine can be both a brain and a hand. The plugin must be installed on **both** machines.

## Rules

- Check the output after every step. If something fails, look it up in Troubleshooting first. Don't skip steps.
- **The pairing code is a secret**: it's valid for 5 minutes and works only once. Don't write it to files, commits, or command-line arguments. Prefer having the user pair in the app; only when the user asks you to do it, pass the code through standard input within this conversation.
- Don't switch the permission level to **Full** or turn on direct acceleration unless the user explicitly asks.
- Don't modify or delete `~/.paseo/plugin-data/remote-hand/`. It holds the device private keys.
- When the user needs to do something in the Paseo app, tell them exactly where to click, then wait for them to confirm.

The Paseo UI may be in English or Chinese. UI labels below are given in English, with the Chinese label in parentheses where it helps.

## Step 0: Ask about the role

If the user hasn't said, ask:

> Is this machine the **hand** (your projects are here and you want to use another machine's models), the **brain** (it offers its models to other machines), or both? Is the plugin already installed on the other machine?

## Step 1: Check prerequisites

Run:

```sh
paseo --version
git --version
node --version
npm --version
```

Requirements:

| Item | Requirement | If not met |
|---|---|---|
| `paseo` | 0.16.1 or later | Ask the user to install or update the Paseo desktop app from <https://paseo.sh> |
| `git` | Runs | On macOS, run `xcode-select --install` |
| `node` | 20.19.0 or later | Install with Homebrew (`brew install node`) or the official installer from nodejs.org |
| `npm` | Runs | Same as above; it comes with Node |

Notes:

- When Paseo installs a plugin, it runs `npm ci` in the background using **the Paseo process's own PATH**, not the PATH of your current terminal.
- If you **just installed Node or git** in this step, the user must **fully quit the Paseo app (Cmd+Q on macOS) and reopen it**. Otherwise you'll hit `spawn npm ENOENT` or `spawn git ENOENT` later.
- If Node was installed with a version manager such as nvm, mise, or fnm, Paseo sometimes can't find npm. On `ENOENT`, install Node with Homebrew or the official installer instead, then have the user restart Paseo once more.

Then confirm that the Paseo daemon is running:

```sh
paseo daemon status
```

If it isn't running, ask the user to open the Paseo app.

## Step 2: Turn plugins on

A fresh Paseo install has plugins turned off. Run:

```sh
paseo daemon config set pluginsEnabled true
```

`"action": "saved"` in the output means it worked. If the command doesn't exist or fails, ask the user to do it in the Paseo app: **Settings** → this machine under the hosts in the sidebar → **Plugins** (插件), then click **Turn on** (开启) in the "Plugins are off on …" notice at the top.

## Step 3: Install the plugin

First check whether it's already installed:

```sh
paseo plugin ls remote-hand --json
```

- **Not installed** (not found, or an empty list):

  ```sh
  paseo plugin install git:DomenCai/paseo-remote-hand
  ```

  Paseo clones the GitHub repository, then runs `npm ci --omit=dev --ignore-scripts`. This usually takes a few dozen seconds.

- **Already installed**: to update to the latest version, run `paseo plugin update remote-hand --yes`.

## Step 4: Confirm the plugin is running

```sh
paseo plugin ls remote-hand --json
```

You must see `"enabled": true` and `"status": "running"`.

- `"enabled": false`: run `paseo plugin enable remote-hand`, then check again.
- Enabled but not `running`: run `paseo plugin logs remote-hand` to see why, then check Troubleshooting.

Note the `path` in the output. Below it's called the **plugin directory**. Run the `node dev/*.mjs` commands below with the plugin directory as the working directory. If your terminal tool doesn't keep `cd` between calls, prefix each command with `cd "<plugin directory>" &&`.

The install is now complete. Tell the user: in **Settings** → this machine → **Plugins**, click Remote hand; its details page has two tabs, **Remote machines** (远端机器) and **Connected devices** (已连接设备). All app steps below happen there.

## Step 5 (brain): Generate a pairing code

Only if this machine will be a brain.

1. Make sure the providers the user wants to offer work in this machine's Paseo, for example by creating a regular agent with Codex or Claude and checking that it replies. A brain can only offer providers that already work in Paseo.
2. In the plugin directory, confirm that the local endpoint is connected to the relay:

   ```sh
   node dev/rpc.mjs endpoint.get
   ```

   `status` must be `connected`. If it's `connecting`, wait a few seconds and check again.

3. Generate a pairing code. Set `label` to a note about the other machine. If no label is needed, run `node dev/rpc.mjs devices.invite` with no argument; don't pass an empty string:

   ```sh
   node dev/rpc.mjs devices.invite '{"label":"Work laptop"}'
   ```

   `pairingCode` in the output starts with `rh1.`, and `expiresAt` is the expiry time.

4. Give the pairing code to the user and remind them: **it's valid for 5 minutes, works only once, and should be sent to the other machine only through a private channel.**

The user can also generate it in the app without you: Plugins page → Remote hand → **Connected devices** tab → **Invite device** → **Generate pairing code**.

## Step 6 (hand): Add the remote machine

Only if this machine will be a hand.

**Prefer having the user do this in the app**, so the pairing code never passes through you: Plugins page → Remote hand → **Remote machines** tab → **Add machine** → paste the pairing code → click **Continue** → check **Machine details** → (if risk notices appear, confirm and check every one) → edit **Display name** if needed → click **Add remote machine**.

If the user asks you to do it, have them send you the pairing code, then run the following in the plugin directory. Pass the code through standard input with a heredoc so it doesn't appear in the process's command-line arguments, and don't save it to a file:

```sh
node dev/rpc.mjs brains.preview - <<'EOF'
{"pairingCode":"rh1.<code from the user>"}
EOF
```

1. Tell the user the `brainName`, `os`, and `relay` from the preview and have them confirm it's their machine.
2. If `risks` is not empty, **tell the user each `message`**, and continue only after they confirm.
3. Add it. `name` is a required display name; if the user didn't specify one, use `brainName` from the preview. Set `acknowledgedRiskCodes` to every `risks[].code` the user confirmed, or an empty array when there are no risks:

   ```sh
   node dev/rpc.mjs brains.add - <<'EOF'
   {"pairingCode":"rh1.<code from the user>","name":"Mac mini","acknowledgedRiskCodes":[]}
   EOF
   ```

Previewing doesn't consume the pairing code. Once `brains.add` succeeds, the code is used up.

## Step 7 (hand): Verify

Run in the plugin directory. Right after adding a brain, `status` may still be `connecting` and the model list may be empty; wait a few seconds and check again:

```sh
node dev/watch.mjs brains.watch --once
paseo provider models remote-hand
```

- In `brains.watch`, the brain's `status` should be `connected` and `transport` should be `relay` or `direct`.
- `provider models` should list models with IDs like `<brainId>/<provider>/<model>`, displayed as "<brain name> · <provider> · <model>".

Finally, tell the user how to use it:

1. In the Paseo app, open a project workspace and create a new agent.
2. Click the model button below the input box, expand **Remote Hand** in the list, and pick "<brain name> · <provider> · <model>". Leave the mode at **Use brain default**.
3. The default permission level is **Restricted**: it can read and write only authorized projects and can't run commands. To allow commands, the user goes to Plugins page → Remote hand → **Remote machines** → clicks the machine → **Permissions** and switches to **Full**.
4. Suggested check: ask a new session "What's in this project?" and confirm that it reads files on the hand.

## Optional: Direct acceleration

Only when the user asks. Direct connections need a rendezvous node, and the plugin **doesn't provide** a public one: the user has to deploy one on their own Linux server with a public IP. The simplest way is for the user to run the [one-click deploy script](../deploy/rendezvous.sh) as root on the server: `curl -fsSL https://raw.githubusercontent.com/DomenCai/paseo-remote-hand/main/deploy/rendezvous.sh | sudo bash`, and allow port `11010` for both TCP and UDP in the cloud provider's security group. See [Self-hosting a rendezvous node](direct.md#自建会合节点) (in Chinese) for details. If there's no rendezvous node, tell the user and stop here; the relay keeps working.

Once the user gives you the rendezvous address, run this in the plugin directory on both machines (keep the address only in the local plugin settings; never write it into any document or commit):

```sh
node dev/rpc.mjs direct.set '{"enabled":true,"peers":["udp://<host>:<port>","tcp://<host>:<port>"]}'
```

After both sides are enabled with rendezvous peers, the first direct negotiation automatically downloads an EasyTier component of about 30 MB. After about a minute, `transport` in `brains.watch` on the hand changes to `direct`. If a direct connection can't be made, it falls back to the relay automatically. See [EasyTier direct connection](direct.md) (in Chinese) for details.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `spawn npm ENOENT` / `spawn git ENOENT` | The Paseo process can't find npm or git | After installing Node / git, have the user fully quit and reopen the Paseo app, then install again. If Node came from nvm or similar, use Homebrew or the official installer instead |
| `Plugins are globally disabled` | Plugins are turned off | Go back to Step 2 |
| `requirements` / version not satisfied | Paseo is older than 0.16.1 | Ask the user to update Paseo |
| `npm ci` network timeout | The npm registry is slow or blocked | Ask the user to set up a proxy or an npm mirror, then retry |
| `git clone` fails | GitHub is unreachable | Ask the user to check the network or proxy, then retry |
| Pairing code invalid or expired | More than 5 minutes passed, or it was already used | Have the brain generate a new pairing code |
| `endpoint.get` stays `connecting` | Can't reach the relay | Ask the user to check the network; `lastError` has the specific reason |
| The brain stays `disconnected` | The brain is off, Paseo isn't running, or the network is down | Ask the user to check the brain; `lastError` in `brains.watch` on the hand has the specific reason |
| Empty model list | The brain has no working provider, or it restricts which providers are offered | Ask the user to check **Connected devices** → **Access control** on the brain |

To view the plugin logs:

```sh
paseo plugin logs remote-hand
```

## Uninstall

1. On the hand: Plugins page → Remote hand → **Remote machines** → click the machine → **Remove machine** at the bottom → click **Remove**.
2. On each machine, run:

   ```sh
   paseo plugin remove remote-hand
   ```

The plugin data directory is kept, so a reinstall reuses the existing device identity.
