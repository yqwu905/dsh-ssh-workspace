# dsh-ssh-workspace

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 SSH 远程工作区 bundle。它遵循 Cordis 的服务替换方式，不改 Agent 或工具代码：把 `ctx.fs` 和 `ctx.subprocess` 同时换成 SSH provider，现有工具便进入同一个远端执行世界。

## 已支持

- 配置 SSH 主机、端口、用户、私钥 / ssh-agent / 环境变量密码，以及严格的主机密钥指纹校验。
- 把服务器上的目录自动注册成 DSH 工作区；Web 端“添加工作区”也能浏览和创建远端目录。
- `read`、`write`、`edit`、目录列表通过 SFTP 操作远端文件。
- Bash、后台任务、`grep` / `glob`、LSP、PTY 终端和进程外 subagent 都经 SSH 执行。它们直接复用 Harness 的既有工具层。
- 远端源文件不会同步或挂载到本机。本机只保存空的工作区锚点，默认位于 `~/.dsh/ssh-workspaces/`。

数据路径如下：

```text
Agent tools
  ├─ read/write/edit ── ctx.fs ────────── SFTP ── remote files
  └─ bash/grep/LSP/PTY ─ ctx.subprocess ─ SSH ─── remote processes

DSH workspace registry ─ local empty anchor ─ path mapper ─ remote directory
```

## 要求

- DeepSeek Harness `0.1.0-rc.7` 兼容的 profile。
- Node.js `^22.19.0` 或 `>=24`。
- 可直接连接的 POSIX SSH 服务器。远端 Bash 工具需要 `bash`；`grep` / `glob` 需要远端 `rg`；LSP 与 subagent 还需要各自的远端可执行文件。
- 目前不解析 `~/.ssh/config`，也不支持 `ProxyJump` / `ProxyCommand`。

## 安装

推荐安装已经构建好的 tarball：

```sh
npm ci
npm pack
dsh plugin --profile web add ./dsh-ssh-workspace-0.1.0.tgz
```

也可直接安装本地源码目录，但必须先构建：

```sh
npm ci
npm run build
dsh plugin --profile web add ./dsh-ssh-workspace
```

发布包已内嵌 `ssh2` 的纯 JavaScript / Node crypto 实现，不包含安装期构建脚本，也不要求批准可选原生加速模块。

DSH profile 关闭了 peer 自动安装，因此 pnpm 可能提示 peer dependency warning；这些 peer 由 profile 的 DSH base / Web bundle 统一提供。若随后出现实际的 module-not-found 错误，请确认 profile 使用兼容的 `0.1.0-rc.7` bundle，而不要在插件内复制另一套 Harness 运行时。

## 配置 SSH 服务器

bundle 默认从环境变量读取配置：

```sh
export DSH_SSH_HOST=ssh.example.com
export DSH_SSH_PORT=22
export DSH_SSH_USER=developer
export DSH_SSH_ROOT=/srv/projects
export DSH_SSH_PRIVATE_KEY="$HOME/.ssh/id_ed25519"
export DSH_SSH_HOST_KEY_SHA256='SHA256:已核验的指纹'
export DSH_SSH_WORKSPACES='[
  {"path":"/srv/projects/api","title":"API server"},
  {"path":"/srv/projects/web","title":"Web client"}
]'

dsh --profile web
```

`DSH_SSH_WORKSPACES` 是 JSON 数组。配置的目录会在启动时校验并注册。Web 页面中的“添加工作区”会改为浏览 `DSH_SSH_ROOT` 下的远端目录，所以也能在运行时添加未写入数组的目录。

认证方式按可用项组合：

- `DSH_SSH_PRIVATE_KEY`：本地私钥路径；省略时先尝试 `SSH_AUTH_SOCK`，再尝试 `~/.ssh/id_ed25519`、`id_ecdsa`、`id_rsa`。
- `DSH_SSH_PASSPHRASE`：私钥口令，只从环境变量读取。
- `DSH_SSH_PASSWORD`：密码，只从环境变量读取。
- `SSH_AUTH_SOCK`：ssh-agent socket。

也可在 profile 的后置 `cordis.patch.yml` 中重写 `ssh-workspace-runtime`；完整示例见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)。配置文件只应保存非敏感字段。

插件会替换 DSH 的自适应目录选择后端，并显式挂载浏览式 UI。因此 Web profile 中的“选择工作区”会浏览配置的 SSH 根目录，而不是打开宿主机原生目录对话框。

宿主机侧的工作区 anchor 会在注册前规范化。这样 DSH 会话保存的规范化 `cwd`（包括 macOS `/private/tmp` 这类路径别名）仍能正确映射到相应的远端目录，Bash 等子进程消费者不需要知道服务器绝对路径。

### 主机密钥

默认必须提供 `DSH_SSH_HOST_KEY_SHA256`。可用下面的命令取得候选指纹：

```sh
ssh-keyscan -p 22 ssh.example.com 2>/dev/null | ssh-keygen -lf - -E sha256
```

`ssh-keyscan` 本身不能证明服务器身份；请通过云控制台、运维渠道或服务器本机核对指纹。仅在一次性测试主机上可显式设置 `DSH_SSH_ACCEPT_UNKNOWN_HOST_KEY=1`，这会关闭主机身份校验。

## 工作区路径如何工作

标准 DSH 工作区注册器只接受本机存在的目录。插件为每个远端目录创建确定性的空目录，例如：

```text
~/.dsh/ssh-workspaces/developer@ssh.example.com-22/api
```

Session 的 `cwd` 保存这个本地锚点；`ctx.fs` 和 `ctx.subprocess` 在执行前把它翻译回 `/srv/projects/api`。锚点不包含远端源码，删除 DSH 工作区或锚点也不会删除服务器文件。

## 安全边界与已知限制

- `root` 是文件工具、目录浏览和进程工作目录的路径边界，不是远端命令沙箱。Bash 命令本身拥有 SSH 用户的全部权限，也可以在命令内部访问 `root` 之外；请使用专用低权限账号、容器或服务器侧强制命令 / MAC 策略进行隔离。
- 本机 sandbox 无法约束服务器进程。bundle 保留 `dsh-bash-sandbox` 作为 DSH shell capability 包装层，但把唯一权限预设固定为 `danger-full-access`；该模式不会调用本机 sandbox，命令权限完全等同于 SSH 用户权限。
- SFTP overwrite 使用 OpenSSH `posix-rename` 扩展，guarded create 使用 `hardlink` 扩展。缺少扩展的服务器会明确失败，不会静默退化成非原子覆盖。
- SSH channel 关闭是当前进程生命周期边界；插件无法像本机 provider 一样证明所有远端孙进程已经退出。不要在 Agent 命令里故意 daemonize。
- PTY 可交互、可写入和发信号，但 SSH 协议不暴露 foreground PGID / stdin-wait 证据；Harness 会退回到有界静默检测，信号结果中的 PGID 为 `-1`。
- 收集输出保留有界 tail，不生成可恢复的 spill 文件。
- 一个插件实例连接一台服务器、一个 `root`。要同时连接多台服务器，请为不同 profile 分别配置。

## 开发验证

```sh
npm ci
npm run typecheck
npm test
npm run test:bundle
npm run test:loopback
npm run build
npm run pack:check
```

单元测试覆盖路径隔离、shell 参数注入防护、主机指纹格式和有界输出游标。`test:loopback` 会在 `127.0.0.1` 启动一次性 SSH 服务器，验证 Cordis provider 启动、主机密钥校验、密码认证、SFTP resolve/stat、stdin 转发、远端命令与输出收集；它不访问外部服务器。针对真实服务器实现与扩展差异的测试仍需要单独提供测试主机和凭据。
