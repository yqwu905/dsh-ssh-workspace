# dsh-ssh-workspace

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地/SSH 混合工作区 bundle。它提供带路由的 `ctx.fs`、`ctx.subprocess` 和目录选择器：普通本机路径继续使用 DSH 原生本地实现，只有确定性的 SSH 工作区锚点才进入对应服务器的远端执行世界，无需修改 Agent 或各个工具。

[English](README.md)

## 功能

- 在 DSH 的“设置 → 插件 → SSH 工作区”中添加、编辑和删除多台 SSH 服务器。
- 每台服务器可独立配置主机、端口、用户、远程根目录、主机密钥指纹、启动工作区和认证方式。
- 支持私钥、ssh-agent、自动认证和强制仅密码认证；密码写入 DSH credential store，不保存在普通设置中，也不会回显到浏览器。
- 同一个“添加工作区”入口可浏览本机文件系统和所有已配置服务器。
- 配置 SSH 后，已有本地工作区仍可正常使用 Read、Write、Edit、Bash、Glob、Grep、终端及其他进程类工具。
- `Read`、`Write`、`Edit`、目录列表等文件工具通过 SFTP 操作远端文件。
- Bash、后台任务、Glob、Grep、LSP、PTY 终端和进程外 subagent 都经对应 SSH 连接执行。
- 同一路径可存在于多台服务器；内部 target 带服务器 ID，不会串到另一台服务器。
- 远端源文件不会同步或挂载到本机。本机只保存空的工作区锚点，默认位于 `~/.dsh/ssh-workspaces/`。

```text
DSH session cwd
  ├─ 普通本机路径 ───────────── 原生本地 fs / subprocess
  └─ SSH 本机空锚点 ─────────── server-aware path mapper
      ├─ Read / Write / Edit ── SFTP ── 远端文件
      └─ Bash / Glob / Grep ─── SSH ─── 远端进程
```

## 要求

- 与 DeepSeek Harness `0.1.0-rc.7` 兼容的 profile。
- Node.js `^22.19.0` 或 `>=24`。
- 可直接连接的 POSIX SSH 服务器。
- Bash 工具需要远端 `bash`；Glob/Grep 需要远端 `rg`（ripgrep）；LSP 与 subagent 还需要各自的远端可执行文件。
- 目前不解析 `~/.ssh/config`，也不支持 `ProxyJump` / `ProxyCommand`。

## 安装

推荐安装构建后的 tarball：

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

发布包内嵌 `ssh2` 的纯 JavaScript / Node crypto 实现，不包含安装期构建脚本，也不要求批准可选原生加速模块。DSH profile 关闭了 peer 自动安装，因此 pnpm 可能提示 peer dependency warning；这些 peer 由 profile 的 DSH base / Web bundle 提供。

## 在 UI 中配置多台服务器

1. 启动 Web profile，打开“设置 → 插件 → 插件配置”。
2. 展开“SSH 工作区”，点击“添加 SSH 服务器”。
3. 填写显示名称、主机、端口、用户名、远程根目录，以及经可信渠道核对的 SHA256 主机密钥指纹。
4. 选择认证方式：
   - “私钥 / SSH Agent”：可填写 DSH 主机上的私钥路径；留空时尝试 ssh-agent 和常用密钥文件。
   - “仅密码”：填写密码。此模式明确禁用私钥发现和 ssh-agent，不会悄悄回退为密钥登录。
   - “自动”：组合使用可用的私钥、ssh-agent 或密码凭据。
5. “启动时注册的工作区”每行填写一个远程绝对目录。
6. 保存设置。可继续添加其他服务器；每台服务器都有独立的连接、认证、根目录与工作区列表。

密码字段是只写的：保存后页面只显示“已配置密码”，不会把密码取回浏览器。设置中的 `passwordRef` 只是凭据引用，真实密码由 [DSH credentials](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/credentials) 保存。配置卡遵循 DSH 的 [settings](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/settings) 与 [settings card](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-settings-card) 机制。

保存后点击侧栏“添加工作区”，目录选择器的第一层会先显示“Local filesystem”，随后列出所有服务器名称。选择本地入口可浏览宿主机目录，选择服务器则浏览其远程根目录；“Workspaces”面包屑可随时返回两类入口。

### 主机密钥

默认必须填写 SHA256 主机密钥指纹。可以取得候选指纹：

```sh
ssh-keyscan -p 22 ssh.example.com 2>/dev/null | ssh-keygen -lf - -E sha256
```

`ssh-keyscan` 本身不能证明服务器身份；请通过云控制台、运维渠道或服务器本机核对。仅在一次性测试主机上可勾选“允许未验证的主机密钥”，这会关闭服务器身份校验。

### Glob / Grep

DSH 的 Glob/Grep 使用随宿主平台打包的 ripgrep 路径。插件识别该路径，把它替换为远端 `rg`，并把本机锚点参数映射成相应服务器的远程路径。远端没有 `rg` 时请安装 ripgrep，或在服务器卡片中填写“远端 ripgrep 可执行文件”的绝对路径。

## 无界面与兼容配置

`servers` 是规范的多服务器配置；`DSH_SSH_SERVERS` 接受同样结构的 JSON 数组。密码仍只应来自环境变量或 credential store，绝不要把明文写进 JSON/YAML。

```sh
export DSH_SSH_PASSWORD_STAGING='从安全渠道注入的密码'
export DSH_SSH_SERVERS='[
  {
    "id":"prod-key",
    "name":"Production",
    "host":"prod.example.com",
    "port":22,
    "username":"developer",
    "root":"/srv/projects",
    "authMode":"key",
    "privateKeyPath":"~/.ssh/id_ed25519",
    "hostKeySha256":"SHA256:VERIFIED_PROD_FINGERPRINT",
    "workspaces":[{"path":"/srv/projects/api","title":"Production API"}]
  },
  {
    "id":"staging-password",
    "name":"Staging",
    "host":"staging.example.com",
    "port":22,
    "username":"tester",
    "root":"/home/tester",
    "authMode":"password",
    "passwordEnv":"DSH_SSH_PASSWORD_STAGING",
    "hostKeySha256":"SHA256:VERIFIED_STAGING_FINGERPRINT",
    "workspaces":[{"path":"/home/tester/workspace","title":"Staging workspace"}]
  }
]'

dsh --profile web
```

旧版单服务器 `DSH_SSH_HOST`、`DSH_SSH_USER`、`DSH_SSH_ROOT` 等环境变量仍兼容，但只在 `servers` 为空时使用。YAML 示例见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)，环境变量示例见 [`examples/env.sh`](examples/env.sh)。

## 工作区路径如何工作

DSH 工作区注册器只接受本机存在的目录。插件为每台服务器创建独立的确定性空锚点，例如：

```text
~/.dsh/ssh-workspaces/prod-key/api
~/.dsh/ssh-workspaces/staging-password/workspace
```

远程 Session 的 `cwd` 保存本机锚点；混合文件和子进程 provider 在执行前，根据规范化的真实路径和服务器 ID 翻译回远程目录。本地 Session 则保留普通本机规范路径，并委托给 DSH 原生本地 provider。路由由工作区明确决定，不会根据一个可能同时存在于本地和远端的绝对路径猜测。macOS `/private/tmp` 等路径别名也会先经 `realpath` 统一。锚点不含远端源码，删除 DSH 工作区或本机锚点不会删除服务器文件。

## 安全边界与限制

- 每台服务器的 `root` 是文件工具、目录浏览和进程工作目录的路径边界，不是远端命令沙箱。Bash 命令拥有 SSH 用户的完整权限，也能在命令内部访问 `root` 之外；生产环境应使用专用低权限账号、容器或服务器侧强制策略。
- 本机 sandbox 无法约束服务器进程。bundle 保留 `dsh-bash-sandbox` 作为 DSH shell capability 包装层，但权限预设固定为 `danger-full-access`；命令权限等同于 SSH 用户权限。
- bundle 启用期间，本地工作区同样使用全局 `danger-full-access` 预设。本地命令和文件修改具有 DSH 宿主账号权限，建议用权限受限的专用账号运行该 profile。
- SFTP overwrite 使用 OpenSSH `posix-rename` 扩展，guarded create 使用 `hardlink` 扩展。缺少扩展时会明确失败，不会静默退化为非原子覆盖。
- SSH channel 关闭不能证明故意 daemonize 的所有远端孙进程都已退出。
- PTY 可交互、可写入和发信号，但 SSH 协议不暴露 foreground PGID；Harness 会使用有界静默检测。
- 收集输出保留有界 tail，不生成可恢复的 spill 文件。

## 开发与 E2E 验证

```sh
npm ci
npm run typecheck
npm test
npm run test:bundle
npm run test:loopback
npm run build
npm run pack:check
```

`test:loopback` 会启动一次性本地 SSH 服务器，在同一 provider 实例中验证密码认证、主机密钥校验、SFTP、远程命令以及本地/SSH 路由。正式验收还应把当前 tarball 安装进真实 DSH profile，通过 Web UI 添加至少一个本地工作区和两台逻辑服务器，并在本地、远程 Agent 会话中分别验证 Read/Write/Bash/Glob/Grep；常规单元测试不能代替这一步。
