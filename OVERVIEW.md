Remote hand runs an agent on another machine while it works on a project on this machine. The machine that holds the project is the **hand**. The machine that runs the agent is the **brain**. Any machine can take either role, or both.

On the hand, start a session with the `remote-hand` provider and pick a model from a brain. The session runs on the brain with that brain's provider, such as Claude or Codex. File reads, writes, searches and shell commands for the project run on the hand, so the project never has to be copied to the brain.

## Setup

- Install Paseo 0.16.1 or later on both machines, turn plugins on and install Remote hand on both. The brain must be able to run the chosen provider in Paseo.
- On the brain, open the plugin's **Connected devices** tab and create a pairing code. The code is valid for five minutes and works once. Send it to the hand through a private channel.
- On the hand, open the **Remote machines** tab, paste the code, review the risk notices and add the brain. Its models then appear under the `remote-hand` provider.
- The two machines talk over an end-to-end encrypted channel through a relay. The default relay is `relay.paseo.sh:443`. You can use your own relay that speaks the same protocol and has a valid TLS certificate. You do not need the Paseo daemon relay or daemon pairing.

The [README](https://github.com/DomenCai/paseo-remote-hand#readme) and the [illustrated install guide](https://github.com/DomenCai/paseo-remote-hand/blob/main/docs/install-guide.en.md) cover setup step by step, including command-line pairing.

## Controls on the brain

- **Connected devices** lists paired devices, whether they are online and how many sessions each is running. You can revoke a device at any time.
- **Allowed providers** limits which providers paired devices can use. By default all providers are allowed.
- **Let devices choose permission modes** is off by default. While it is off, a device can only use the brain's default mode for each provider. When it is on, a device can pick any mode the provider offers, including full access.
- **Max running sessions per device** limits how many sessions from one device can start or work at the same time. Idle sessions do not count.

## Controls on the hand

- Each brain starts at the **Restricted** level. File tools can only reach projects you started sessions in, and shell commands are refused. You can revoke a project from the brain's page.
- The **Full** level lets the brain's agent read and write any file and run shell commands with the hand user's permissions. Use it only for brains you trust.
- If the brain moves to another relay, you can update the address without pairing again.

## Data and access

- Prompts, agent output, and the file contents and command output the agent requests travel between the two machines over the encrypted channel. The brain sends prompts and tool results to its own agent provider, as any session on that machine would.
- The agent on the brain keeps the brain's native tools. It can read and change files on the brain as the brain's Paseo user, within the selected permission mode. A paired device can answer that agent's permission requests. Invite only devices you trust.
- On a shared brain, sessions from different devices are visible to each other in that brain's Paseo.
- The plugin connects to the local Paseo daemon with the daemon's local credential to create and manage agents. It stores its keys and paired devices in its Paseo plugin data directory.

## Optional direct connections

Experimental EasyTier direct connections can carry traffic after pairing instead of the relay. You turn them on in both machines and run your own rendezvous node. The setting notes that turning it on downloads the EasyTier program, which then comes from its GitHub releases or a mirror. You can also import the official ZIP yourself. The plugin checks a pinned hash before it extracts and starts the program.

## Limitations

- The model can still use the brain's native tools instead of the hand tools, so some actions can happen on the brain.
- Requests and tool output have a 128 KiB frame limit. If the connection drops while a write or command is running, its result may be unknown.
- Claude has passed cross-machine testing. Codex, Antigravity, Grok, Kimi and Pi have passed cross-machine file-read checks.
- Windows hands have not been tested on real hardware.
