# Remote hand

Remote hand 是一个实验性的 Paseo 插件（PoC）。两台 Mac 即使都没有公网 IP，远端 Mac 上的 agent 也可以经 Paseo relay，在你的本机运行命令和传输文件。本文称本机为 **hand**，运行 agent 的远端 Mac 为 **brain**。

> [!WARNING]
> **brain 一侧获得 hand 当前用户的完整 shell 权限。** brain 上能读取生成的 SSH 配置和私钥的用户或进程，可以在 hand 上执行任意命令，并读写该用户有权访问的文件。只和你完全信任、由你控制的 brain 配对。配对链接也是秘密：不要提交到仓库、发到公开频道或写进日志。

hand 主动通过 Paseo relay 连接 brain，SSH 流量经这条连接传输。brain 提供一个仅监听 `127.0.0.1` 的 SSH 入口，hand 只接受本次配对生成的客户端公钥。agent 运行命令后，命令输出会回到 brain；若 agent 将结果作为上下文使用，结果也可能发给它的模型服务。

## 前提条件

- 两台都运行 macOS，并已运行 Paseo daemon。插件声明支持 Paseo `>=0.17.3 <0.18.0`，实测版本为 `0.17.3`。
- 两端都在 Paseo 的 **Settings → Plugins** 打开 **Enable plugins**，并启用 relay。brain 对外提供的 relay 配对链接必须使用 TLS。
- 两端可用 Node.js `>=20.19.0` 和 npm。GitHub 安装时，daemon 也需要能从自己的 `PATH` 找到 npm。配对使用默认的 Paseo home（`~/.paseo`），并以运行各自 daemon 的用户执行命令。
- 本文配对流程适用于 brain 的链接可直接建立具备 `daemon.manage` 权限的会话。如果 brain 要求输入 daemon 密码，脚本没有交互式密码输入；不要为了配对而关闭密码。

## 安装

在 hand 和 brain 上各安装一次，任选一种来源。以下命令都在对应 Mac 上执行。

**从 GitHub 安装：** 把 `<owner>/<repo>` 换成发布本插件的仓库。安装时 Paseo 会根据 `package-lock.json` 装生产依赖，并跳过 npm 生命周期脚本。

```sh
paseo plugin install 'git:<owner>/<repo>'
```

**从本地目录安装：** 把仓库内容放到两台机器各自的目录，进入实际目录后执行：

```sh
cd /absolute/path/to/remote-hand
npm ci --omit=dev --ignore-scripts
paseo plugin install "$PWD"
```

在两端运行 `paseo plugin ls remote-hand`，确认状态为 `running`。插件没有单独的界面；首次安装时两端都以 brain 模式启动，配对后才会把本机切换为 hand。

## 配对

1. 在 **hand** 上找到已安装的插件目录。`paseo plugin ls remote-hand --json` 的 `path` 字段是实际目录；GitHub 安装也用这里显示的路径。

   ```sh
   plugin_dir=$(paseo plugin ls remote-hand --json | node -p \
     'JSON.parse(require("node:fs").readFileSync(0, "utf8"))[0].path')
   ```

2. 在 **hand** 上运行配对脚本。如果 hand 能用普通 SSH 登录 brain，把示例中的 `brain-mac` 换成你的 SSH 主机名或别名。脚本在 brain 上调用 `paseo pair --json` 获取当前链接，经 SSH 标准输出直接交给 hand，不在终端回显链接。这个方式需要 brain 的 SSH 登录已可非交互完成，且 SSH 会话能找到 `paseo` 和 `node`。

   ```sh
   sh "$plugin_dir/run-poc.sh" brain-mac
   ```

   如果两台 Mac 无法直接 SSH，先在 **brain** 确认 `paseo status` 显示本机 daemon 正在运行且 relay 已启用，再把当前配对信息复制到剪贴板：

   ```sh
   paseo pair --json | pbcopy
   ```

   通过你信任的私密渠道将完整 JSON 复制到 **hand** 的剪贴板。在 **hand** 上执行：

   ```sh
   pbpaste | sh "$plugin_dir/run-poc.sh" --pair-stdin
   pbcopy </dev/null
   ```

   传完也清空 brain 的剪贴板；不要把 JSON 保存到额外的文件里。两种方式都会将 JSON 中的 `connectionUri`、hand 的 Paseo 标识和 worker 路径写入 hand 上的 `/tmp/paseo-remote-hand-<UID>/hand.json`。目录权限为 `0700`，文件为 `0600`。写入成功后，脚本会执行 `paseo plugin reload remote-hand`。

3. 在 **hand** 上运行 `paseo plugin logs remote-hand`，等待本轮 `plugin-loaded`（`role` 为 `hand`）之后出现 `hand-ready`。如果出现 `hand-start-failed`，从 `stage` 字段判断失败阶段，并确认两端插件正在运行、brain 提供的是 TLS relay 链接。

## 使用

在 **brain** 上运行 `paseo plugin logs remote-hand`，找到本轮的 `brain-listening`，复制 `config` 字段作为 SSH 配置路径。它通常是 `/tmp/remote-hand-poc2/ssh/<hand-server-id>/ssh_config`。将路径交给 agent，让它用 `ssh -F` 执行命令，或用 `scp -F` 传文件：

```sh
cfg='/path/from/brain-listening/ssh_config'
ssh -F "$cfg" mac-local 'whoami; pwd'
scp -F "$cfg" ./example.txt mac-local:example.txt
```

SSH 会返回 hand 上命令的退出码。连接中断时，现有 SSH 会话会结束，命令的最终结果可能未知。需要恢复时，先确认 brain 插件正常，再在 hand 上执行 `paseo plugin reload remote-hand` 并等待新的 `hand-ready`；重新配对不会重放命令。同一个 hand 的 SSH 配置路径固定，握手时会轮换密钥并更新配置。

## 把任务交给远端 Claude

配对并出现 `hand-ready` 后，在 **hand** 上运行：

```sh
node "$plugin_dir/dev/handoff.mjs" --cwd "$plugin_dir" '读取 README.md 的第一行并报告。不要修改项目文件。'
```

`--cwd` 默认为当前目录。可以用 `--model <id>` 或 `--mode <id>` 指定 brain 上的 Claude 模型或权限模式；省略时由 brain 选择可用模型，模式优先用 `auto`，其次用 `default`（可能需要用户批准工具调用）。在 brain 上用 `paseo provider ls` 和 `paseo provider models claude` 查看当前选项。

脚本返回 `workspaceId` 和 `agentId`。agent 在 brain 的 Claude provider 上运行，工作区是 brain 上按 hand 标识隔离的占位目录；项目操作通过 relay 上的 SSH 在 hand 执行。继续追问时，在 Paseo App 中切到 brain 并打开该会话，或在 brain 上执行 `paseo send <agentId> '下一条任务'`。如果 SSH 中断，先确认命令的实际结果，再决定是否重试；同一台 hand 重连后，可在原会话里发新任务。

## 卸载

1. 先在 **hand** 上移除插件，然后删除保存配对链接的临时文件：

   ```sh
   paseo plugin remove remote-hand
   rm -f "/tmp/paseo-remote-hand-$(id -u)/hand.json"
   ```

2. 再在 **brain** 上执行 `paseo plugin remove remote-hand`。正常停止时，插件关闭监听并移除本轮生成的 SSH 配置和密钥。本地目录安装的源码由你自行保管，卸载不会删除它。

## 已知问题

- 插件使用的 `ssh2` 1.17.0 不支持后量子密钥交换。生成的配置只为 `mac-local` 关闭 OpenSSH 的相关提示，不改变实际协商的算法。
- brain 的 SSH 配置和密钥目前放在 `/tmp` 的私有目录中；重启或系统清理临时目录后，可能需要重新配对。hand 的配对文件也在 `/tmp`。
- PoC 一次只为一个 hand 提供连接；新的握手会替换 brain 上的旧会话。

## 开发与验证

`run-poc.sh` 和 `verify-poc.py` 位于仓库根目录，都从 hand 运行。`run-poc.sh` 可额外传入本机插件目录；默认使用脚本所在目录。`verify-poc.py` 需要两端都有 Python 3.8 或以上版本，并且 hand 能用普通 SSH 非交互登录 brain。它默认在 hand 上读取脚本所在目录的 `README.md`，也可以用 `--project-dir` 指定另一处包含 `README.md` 的目录。

```sh
python3 "$plugin_dir/verify-poc.py" brain-mac --project-dir "$plugin_dir"
```

完整验证会检查退出码、文件传输、背压和重连等行为。它会 reload hand 并主动中断测试连接，不要在 agent 正使用通道时运行。测试文件保留在两端各自的 `/tmp/remote-hand-poc2/test-*` 目录下。

## 许可证

[Apache-2.0](LICENSE)。部分 SSH worker 代码移植自 CC Desk Tunnel，原项目署名见 [NOTICE](NOTICE)。依赖沿用各自的许可证。
