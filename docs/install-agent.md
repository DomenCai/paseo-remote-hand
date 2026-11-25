# Remote hand 安装手册（给 coding agent 读）

> 本文写给 coding agent。用户只要对 agent 说"看一下这个文档，帮我安装这个插件"，agent 按本文从头执行即可。给人看的图文版见 [安装教程](install-guide.md)。English: [install-agent.en.md](install-agent.en.md).

## 你要完成的事

在用户的这台机器上安装 Paseo 插件 `remote-hand`，确认插件正常运行，并在用户需要时帮忙完成两台机器的配对。

先弄清两个角色：

- **brain**：运行 agent 的机器，提供 Claude、Codex 等 provider。
- **hand**：保存项目的机器。用户在 hand 上新建会话、选择远端模型，会话跑在 brain 上，项目读写和命令在 hand 上执行。
- 同一台机器可以同时是 brain 和 hand。两台机器**都要**安装本插件。

## 执行规则

- 每一步执行后检查输出，失败时先查本文的「排错」，不要跳步。
- **配对码是秘密**：5 分钟内有效，只能用一次。不要写进文件、提交记录或命令行参数。配对优先让用户在 App 里操作；只有用户要求你代办时，才在本次对话中经标准输入传递。
- 不要擅自把权限切成「完全」，也不要擅自开启直连加速，除非用户明确要求。
- 不要修改或删除 `~/.paseo/plugin-data/remote-hand/`，里面是设备私钥。
- 需要用户在 Paseo App 里操作时，告诉用户具体点哪里，然后等用户确认。

## 第 0 步：问清角色

如果用户没说，先问一句：

> 这台机器是 **hand**（项目在这台机器上，想用别的机器的模型）、**brain**（把这台机器的模型提供给别的机器），还是两者都是？另一台机器是否已经装好本插件？

## 第 1 步：检查前置条件

依次运行：

```sh
paseo --version
git --version
node --version
npm --version
```

要求：

| 项目 | 要求 | 不满足时 |
|---|---|---|
| `paseo` | 0.16.1 或更新 | 让用户从 <https://paseo.sh> 安装或升级 Paseo 桌面 App |
| `git` | 能运行 | macOS 运行 `xcode-select --install` |
| `node` | 20.19.0 或更新 | 用 Homebrew（`brew install node`）或 nodejs.org 官方安装包安装 |
| `npm` | 能运行 | 同上，随 Node 一起安装 |

注意：

- Paseo 安装插件时会在后台执行 `npm ci`，用的是 **Paseo 进程自己的 PATH**，不是你当前终端的 PATH。
- 如果这一步**刚刚安装了 Node 或 git**，必须让用户**彻底退出 Paseo App（macOS 按 Cmd+Q）再重新打开**，否则后面会报 `spawn npm ENOENT` 或 `spawn git ENOENT`。
- 如果 Node 是用 nvm、mise、fnm 之类的版本管理器装的，Paseo 有时找不到 npm。遇到 `ENOENT` 时，改用 Homebrew 或官方安装包装一份 Node，再让用户重启一次 Paseo。

再确认 Paseo daemon 在运行：

```sh
paseo daemon status
```

没在运行时，让用户打开 Paseo App。

## 第 2 步：开启插件功能

新装的 Paseo 默认关闭插件。运行：

```sh
paseo daemon config set pluginsEnabled true
```

输出里看到 `"action": "saved"` 即可。如果命令不存在或报错，让用户在 Paseo App 里操作：「设置」→ 左侧「主机」下的本机 →「插件」，点页面顶部「xxx 上的插件已关闭」提示里的「开启」。

## 第 3 步：安装插件

先看是否已经安装：

```sh
paseo plugin ls remote-hand --json
```

- **未安装**（报找不到或列表为空）：

  ```sh
  paseo plugin install git:DomenCai/paseo-remote-hand
  ```

  Paseo 会克隆 GitHub 仓库，再执行 `npm ci --omit=dev --ignore-scripts`，通常需要几十秒。

- **已安装**：要升级到最新版时运行 `paseo plugin update remote-hand --yes`。

## 第 4 步：确认插件在运行

```sh
paseo plugin ls remote-hand --json
```

必须看到 `"enabled": true` 和 `"status": "running"`。

- `"enabled": false`：先运行 `paseo plugin enable remote-hand`，再重新检查。
- 已启用但状态不是 `running`：运行 `paseo plugin logs remote-hand` 查看原因，再对照「排错」处理。

记下输出里的 `path`，后面称它为 **插件目录**。后面的 `node dev/*.mjs` 命令都要以插件目录为工作目录运行。如果你的终端工具每次调用不保留 `cd`，就在每条命令前加上 `cd "<插件目录>" &&`。

到这里安装已经完成。告诉用户：在「设置」→ 本机 →「插件」里点 Remote hand，详情页有「远端机器」和「已连接设备」两个标签页，下文的 App 操作都在这里。

## 第 5 步（brain）：生成配对码

只在这台机器要当 brain 时做。

1. 确认用户想开放的 provider 在这台机器的 Paseo 里能正常使用，例如先用 Codex 或 Claude 新建一个普通 agent，确认能对话。brain 只能提供 Paseo 里已经能用的 provider。
2. 在插件目录确认本机端点已连上 relay：

   ```sh
   node dev/rpc.mjs endpoint.get
   ```

   `status` 必须是 `connected`。如果是 `connecting`，等几秒再查。

3. 生成配对码。`label` 填对方机器的备注；不需要备注时直接运行 `node dev/rpc.mjs devices.invite`，不要传空字符串：

   ```sh
   node dev/rpc.mjs devices.invite '{"label":"工作电脑"}'
   ```

   输出里的 `pairingCode` 以 `rh1.` 开头，`expiresAt` 是过期时间。

4. 把配对码交给用户，并提醒：**5 分钟内有效，只能用一次，只通过私密渠道发给另一台机器。**

用户也可以不经过你，自己在 App 里生成：插件页 → Remote hand →「已连接设备」标签 →「邀请设备」→「生成配对码」。

## 第 6 步（hand）：添加远端机器

只在这台机器要当 hand 时做。

**推荐让用户在 App 里操作**，配对码不经过你：插件页 → Remote hand →「远端机器」标签 →「添加远端机器」→ 粘贴配对码 → 点「下一步」→ 核对「远端机器信息」→（出现风险提示时，逐条确认并全部勾选）→ 按需修改「显示名称」→ 点「添加远端机器」。

如果用户要你代办，让用户把配对码发给你，然后在插件目录运行。配对码用 heredoc 从标准输入传入，避免出现在进程的命令行参数里，也不要存进文件：

```sh
node dev/rpc.mjs brains.preview - <<'EOF'
{"pairingCode":"rh1.用户给的配对码"}
EOF
```

1. 把预览结果里的 `brainName`、`os`、`relay` 告诉用户，让用户确认是不是自己的机器。
2. 如果 `risks` 非空，**逐条把 `message` 告诉用户**，得到用户确认后才能继续。
3. 添加。`name` 是必填的显示名称，用户没指定时填预览返回的 `brainName`；`acknowledgedRiskCodes` 填用户确认过的全部 `risks[].code`，没有风险时为空数组：

   ```sh
   node dev/rpc.mjs brains.add - <<'EOF'
   {"pairingCode":"rh1.用户给的配对码","name":"Mac mini","acknowledgedRiskCodes":[]}
   EOF
   ```

预览不会消耗配对码，`brains.add` 成功后配对码即作废。

## 第 7 步（hand）：验证

在插件目录运行。刚添加完 brain 时，`status` 可能还是 `connecting`，模型列表也可能为空，等几秒再查一次：

```sh
node dev/watch.mjs brains.watch --once
paseo provider models remote-hand
```

- `brains.watch` 里对应 brain 的 `status` 应为 `connected`，`transport` 为 `relay` 或 `direct`。
- `provider models` 应列出形如 `<brainId>/<provider>/<model>` 的模型，显示名是「<brain 名> · <provider> · <模型>」。

最后告诉用户怎么用：

1. 在 Paseo App 打开一个项目 workspace，新建 agent。
2. 点输入框下方的模型按钮，在列表里展开 **Remote Hand**，选「<brain 名> · <provider> · <模型>」；模式保持「Use brain default」。
3. 默认是「受限」权限：只能读写已授权的项目，不能执行命令。需要执行命令时，用户自己到 插件页 → Remote hand →「远端机器」→ 点进该机器 →「权限设置」切到「完全」。
4. 建议验证：让新会话"看一下这个项目里面有什么东西"，确认读到的是 hand 上的文件。

## 可选：直连加速

只在用户要求时做。直连需要会合节点，插件**不提供**公共会合节点：用户要在自己有公网 IP 的 Linux 服务器上部署。最简单的是让用户在服务器上以 root 运行 [一键部署脚本](../deploy/rendezvous.sh)：`curl -fsSL https://raw.githubusercontent.com/DomenCai/paseo-remote-hand/main/deploy/rendezvous.sh | sudo bash`，并在云厂商安全组放行 `11010` 的 TCP 和 UDP；详见 [自建会合节点](direct.md#自建会合节点)。没有会合节点时，告诉用户这一点并停在这里，relay 照常可用。

用户给出会合节点地址后，在两台机器的插件目录分别运行（地址只写进本机插件配置，不要写进任何文档或提交）：

```sh
node dev/rpc.mjs direct.set '{"enabled":true,"peers":["udp://<host>:<port>","tcp://<host>:<port>"]}'
```

两端都启用并配好会合节点后，首次协商直连会自动下载约 30 MB 的 EasyTier 组件。大约 1 分钟后，hand 上 `brains.watch` 的 `transport` 变成 `direct`。打不通时会自动回到 relay，不影响使用。详见 [EasyTier 直连](direct.md)。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `spawn npm ENOENT` / `spawn git ENOENT` | Paseo 进程找不到 npm 或 git | 装好 Node / git 后，让用户彻底退出 Paseo App 再打开，然后重装；Node 由 nvm 等安装时，改用 Homebrew 或官方安装包 |
| `Plugins are globally disabled` | 插件总开关没开 | 回到第 2 步 |
| `requirements` / 版本不满足 | Paseo 低于 0.16.1 | 让用户升级 Paseo |
| `npm ci` 网络超时 | 访问 npm registry 慢或被墙 | 让用户配置代理，或给 npm 设置镜像后重试 |
| `git clone` 失败 | 访问 GitHub 失败 | 让用户检查网络或代理后重试 |
| 配对码无效或过期 | 超过 5 分钟或已用过 | 让 brain 重新生成配对码 |
| `endpoint.get` 一直是 `connecting` | 连不上 relay | 让用户检查网络；`lastError` 里有具体原因 |
| brain 一直是 `disconnected` | brain 关机、Paseo 未运行或网络不通 | 让用户检查 brain；hand 上 `brains.watch` 的 `lastError` 有具体原因 |
| 模型列表为空 | brain 上没有可用 provider，或 brain 限制了开放的 provider | 让用户在 brain 的「已连接设备」→「访问控制」里检查 |

查看插件日志：

```sh
paseo plugin logs remote-hand
```

## 卸载

1. hand 上：插件页 → Remote hand →「远端机器」→ 点进机器 → 页面底部「移除机器」→ 点「移除」。
2. 两台机器分别运行：

   ```sh
   paseo plugin remove remote-hand
   ```

插件数据目录会保留，重新安装时会复用原来的设备身份。
