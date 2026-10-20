# dsh-ssh-fleet

在**一个** DeepSeek Harness（dsh）实例里同时连接多台 SSH 服务器：每个会话可以绑定到不同的服务器。模型调用、插件、技能和设置全部留在运行 dsh 的主机上，只有文件读写、命令、终端和搜索在会话所绑定的服务器上执行。

```
                    ┌─────────────────────── dsh 主机 ───────────────────────┐
  LLM API  ◀──────  │ Agent 循环 · 模型调用 · 会话日志 · 插件 · 技能 · 设置   │
                    │                                                        │
                    │  ctx.fs / ctx.subprocess / ctx.sandbox = 路由器         │
                    │      │ 会话 A(本地)  │ 会话 B(web1)   │ 会话 C(db1)      │
                    │      ▼               ▼                ▼                │
                    │  本地 provider    ssh ControlMaster  ssh ControlMaster  │
                    │  (隔离组)         + 宿主代理(可选)    + 宿主代理(可选)   │
                    └──────────────────────┬────────────────┬─────────────────┘
                                           │ SSH            │ SSH
                                 ┌─────────▼───────┐ ┌──────▼──────────┐
                                 │ web1: 只需 sshd  │ │ db1: 只需 sshd   │
                                 │ + POSIX sh       │ │ + POSIX sh       │
                                 └─────────────────┘ └─────────────────┘
```

## 解决的两个问题

1. **所有服务器配置一致**：服务器上不安装 dsh、插件、Node 或 Python。插件、技能、MCP、模型和权限设置只在主机上维护一份，对每台服务器自动生效：
   - 路由发生在 dsh 的能力接缝 `ctx.fs`、`ctx.subprocess`、`ctx.sandbox` 上，所以**任何通过这三个服务工作的插件**（内置的 read、write、edit、glob、grep、bash、持久终端、LSP、后台任务，以及你安装的第三方插件）都会自动在会话绑定的服务器上执行，不需要为每个插件单独适配。
   - 主机上的技能目录（`~/.dsh/skills`、`~/.agents/skills`，以及 `mirrors` 中配置的目录）会被**镜像**到每台服务器的 `~/.cache/dsh-ssh-fleet/mirror/`，并做路径翻译。模型看到的技能 Base directory 是服务器上的真实路径，技能自带的脚本和资源可以直接在服务器上运行。主机上修改技能后，最迟 3 秒（可配置）同步到服务器。
2. **服务器连不上 LLM API 也能用**：Agent 循环和全部模型请求都在主机上发出，服务器只需要能被主机 SSH 访问。如果服务器上的程序也需要联网（`pip install`、调用 API 的技能脚本等），可以开启**宿主代理**：
   - 主机起一个只监听 loopback 的 HTTP 代理，经 `ssh -R` 反向转发到每台服务器，并给远端进程注入带随机凭据的 `HTTP(S)_PROXY`；
   - 只放行白名单内的域名，默认禁止访问 loopback 和内网地址；
   - 可以链接主机自己的上游代理（`upstream: env`）。

## 与现有社区插件的区别

评估过 7 个社区 SSH 插件（NaNQiQ/deepseek-harness-remote-ssh、jk-uzi/dsh-multi-remote、MRZHUH/dsh-remote-server、pipipigu/dsh-ssh-control、chai1110/dsh-ssh-remote、ljh220300-eng/dsh-plugin-ssh-manager、UynajGI/dsh-ssh），没有一个能同时满足上面两点。它们要么只重新挂载了内置工具（第三方插件和技能仍在主机执行），要么技能脚本在服务器上不存在，要么在服务器上运行 dsh（违反第 2 点）。本插件的做法是：在能力接缝层按会话路由，再加上技能镜像。

## 安装

要求：

- 主机：Linux 或 macOS，dsh `>=0.2.1-rc.2 <0.3.0`，系统 OpenSSH 客户端（需支持 ControlMaster），`tar`。
- 服务器：Linux 或 macOS，sshd，POSIX `sh`，coreutils 或 BSD 工具。可选 `bwrap`（沙箱）、`rg`（若服务器没有 rg 且平台与主机相同，会自动上传主机的 rg）、`setsid` 或 `perl`（用于进程组）。

```sh
# 装到 web profile（也可以是 headless、sdk 或自建 profile）
dsh plugin --profile web add /path/to/dsh-ssh-fleet      # 本地目录
# 或：dsh plugin --profile web add github:yqwu905/dsh-ssh-workspace
```

插件以 bundle 形式提供：它的 `cordis.patch.yml` 会把原来的本地 provider（`fs-sandbox`、`subprocess`、`sandbox` 三行）挪进一个隔离组，再在根上挂载路由器。不绑定服务器的会话行为与原来完全一致。

## 配置服务器

先在主机的 `~/.ssh/config` 里配好免密登录（密钥或 agent，支持 ProxyJump 等），并接受主机指纹。插件使用 `BatchMode=yes`，不会弹出交互认证，也不会放宽 known_hosts 校验。

### 在网页版里配置（推荐）

打开 **设置 → 服务器**：

- **从 ~/.ssh/config 导入**：列出配置文件里的具体 `Host` 别名（会跟随 `Include`，跳过 `*`、`?`、`!` 通配条目），勾选后导入。导入的服务器直接用别名连接，原有的 ProxyJump、IdentityFile、Port 等设置继续由 OpenSSH 生效。已经添加过的别名会标出对应的服务器名。读取的文件路径可以修改。
- **添加 / 编辑**：名称、主机、用户、端口、私钥、默认目录、备注、额外 SSH 选项（每行一个 `Key=Value`）、命令沙箱（自动 / 不限制 / 拒绝）、主机代理开关。
- **测试连接**：用临时的独立连接测试，不影响已有会话。成功时显示系统、架构、主目录、耗时，以及是否有 bwrap 和 rg；失败时显示 ssh 的错误原文。每台服务器卡片上还有连接状态指示。
- **删除**：只删除配置，服务器上的文件不受影响。已绑定该服务器的会话会拒绝执行，直到你重新添加同名服务器。

修改即时生效，并写回 `hosts.json`（原子写入）。写在 `cordis.patch.yml` 里的服务器在页面上只读。

### 手工编辑 hosts.json

也可以直接写 `~/.dsh/ssh-fleet/hosts.json`（路径可配置）：

```json
{
  "hosts": [
    { "id": "web1", "host": "web1", "workspace": "~/app", "description": "生产 Web" },
    { "id": "gpu",  "host": "10.0.0.8", "user": "ml", "port": 2222, "workspace": "/data/train",
      "sshOptions": ["ProxyJump=bastion"], "proxy": true },
    { "id": "db1",  "host": "db1", "sandbox": "unconfined" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 名称，用于 `/ssh`、锚点目录和日志 |
| `host` | OpenSSH 目标：`~/.ssh/config` 别名或主机名 |
| `user` / `port` / `identityFile` / `sshOptions` | 透传给 ssh，`sshOptions` 对应 `-o Key=Value` |
| `workspace` | 默认远端工作目录，可以是绝对路径或 `~/...`，默认 `~` |
| `sandbox` | 覆盖全局的远端沙箱设置，见下文 |
| `proxy` | 覆盖全局的宿主代理开关 |

手工修改后，在会话里执行 `/ssh reload` 即可生效，无需重启。

插件自身的配置写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: ssh-fleet
  config:
    proxy:
      enabled: true                      # 给服务器提供宿主代理
      allow: ['*.deepseek.com', 'pypi.org', 'files.pythonhosted.org']   # 必填，默认空 = 全部拒绝
      upstream: env                      # 主机自己也走代理时：链接主机的 HTTPS_PROXY
      # allowPrivate: true               # 允许访问主机能到达的内网或 loopback 服务（默认禁止）
    mirrors: ['/home/me/team-skills']    # 额外镜像的主机目录（如自定义技能根）
    sandbox: auto
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `hosts` | `[]` | 直接写在配置里的服务器，会与 `hostsFile` 合并 |
| `hostsFile` | `$DSH_HOME/ssh-fleet/hosts.json` | 设为空字符串可禁用 |
| `anchorsDir` | `$DSH_HOME/ssh-fleet/anchors` | 锚点目录，见下文；设为空字符串可禁用 |
| `mirrorSkills` | `true` | 是否镜像 `<dshHome>/skills` 和 `<agentsHome>/skills` |
| `mirrors` | `[]` | 额外要镜像的主机目录 |
| `mirrorCheckIntervalMs` | `3000` | 技能变更检查的节流间隔 |
| `sandbox` | `auto` | 远端命令限权方式：`auto`/`bwrap` 有 bwrap 就用，否则拒绝受限模式；`unconfined` 不限权；`refuse` 总是拒绝 |
| `proxy.enabled` / `allow` / `allowPrivate` / `upstream` | `false` / `[]` / `false` / `''` | 宿主代理：开关；目标白名单（`*.suffix`、`*`）；是否允许解析到 loopback、内网、链路本地的目标；上游代理（`''` 直连，`env` 用主机环境变量，或填 `http://` URL） |
| `uploadRipgrep` | `true` | 服务器没有 rg 且与主机平台相同时，上传主机的 rg |
| `connectTimeoutSec` | `15` | SSH 连接超时（秒） |
| `helperWorkers` | `2` | 每台服务器常驻的 helper 进程数，文件操作经由它们执行，登录 shell 的启动脚本只运行一次（见下文"连接"）；`0` 表示每次操作单独执行一条 ssh 命令 |
| `controlDir` | `/tmp/dsh-sf-<uid>` | ControlMaster socket 目录。必须是当前用户私有的目录，路径要足够短（socket 路径上限约 104 字节） |
| `hostPaths` | `[]` | 远端会话中仍留在主机处理的路径前缀（默认已包含 dsh 的输出溢出目录 `<tmpdir>/dsh-subprocess-*`、`<tmpdir>/dsh-spill-*`） |

## 使用

### 网页版：添加服务器上的工作区（推荐）

点侧边栏或首页的 **添加工作区**，会先让你选择目录所在的位置：

- **本机**：打开 dsh 原本的目录选择器（浏览对话框或系统选择框），行为与不装本插件时一样；
- **某台服务器**：打开同样的浏览对话框，内容换成这台服务器上的目录。可以浏览、显示隐藏目录、新建文件夹，起点是该服务器的默认目录。选中后点 **打开**，就会创建一个名为 `web1:/home/alice/proj` 的工作区。

在这个工作区里新建的会话全部在那台服务器上运行，包括模型的文件和命令工具、右侧的 **工作区文件** 面板（浏览和预览远端文件）以及 **终端**。没有配置任何服务器时，不显示位置选择这一步。

### 绑定方式一：`/ssh` 命令

适合在已有的会话里临时切换服务器：

```
/ssh                 查看当前会话绑定和所有服务器状态
/ssh web1            绑定到 web1，工作目录切到它的 workspace
/ssh gpu /data/exp3  绑定到 gpu 的指定目录
/ssh local           回到本机
/ssh check [host]    连通性、rg、bwrap、代理状态
/ssh reload          重新读取 hosts.json
```

绑定以插件记录（`plugin:dsh-ssh-fleet/binding`）的形式写入会话日志，所以：

- 会话恢复、dsh 重启后，绑定依然有效；
- fork 出的会话继承绑定；
- 子 Agent（subagent、workflow 派生的 Agent）自动继承父会话的服务器，并在第一次请求时把绑定写进自己的日志；
- 如果绑定的服务器从 hosts.json 中删除，该会话会**拒绝执行**并给出提示（恢复配置后执行 `/ssh reload`，或执行 `/ssh local`），绝不会悄悄改在主机上执行。

### 绑定方式二：锚点目录（headless、SDK）

启动时插件会为每台服务器创建 `$DSH_HOME/ssh-fleet/anchors/<id>`。锚点路径编码了服务器上的目录：

| 主机上的锚点路径 | 对应 |
|---|---|
| `anchors/web1` | web1 的默认目录（`workspace`） |
| `anchors/web1/srv/app` | web1 上的 `/srv/app` |

只要会话的工作目录是某个锚点路径，会话就会自动、持久地绑定到该服务器，工作目录也会切换为对应的服务器路径。网页版的"添加服务器上的工作区"就是建在这样的锚点路径上（插件会创建对应的空占位目录）。

- **headless**：`cd ~/.dsh/ssh-fleet/anchors/web1 && dsh --profile headless "修复部署脚本"`
- **SDK**：`await session.setWorkingDirectory(`${DSH_HOME}/ssh-fleet/anchors/db1/var/log`)`
- **模型自己切换**：本机会话里，模型用 `working_directory` 工具 cd 进锚点目录，即可切到对应服务器。

在同一个 dsh 实例里，各会话互不影响、并发执行。例如 Web 里同时开着 web1、db1 和本地三个会话。

### 模型看到什么

绑定后，系统上下文里会多出一行说明，告诉模型文件、命令、终端和搜索都在服务器上执行。工作目录直接显示为服务器路径（如 `/home/alice/app`）。工具返回的路径都是服务器上的真实路径，模型可以直接在 bash 里使用。

## 沙箱与权限

dsh 原有的权限模式（read-only、workspace-write、danger-full-access）和审批流程不变，在远端按服务器路径执行：

- **文件写入**（write、edit）：workspace-write 模式下，只允许写入会话绑定的远端工作区，以及 `/tmp`、`/var/tmp`；超出范围会返回 dsh 标准的 `FS_SANDBOX_DENIED`，并附带提权提示。
- **命令**：受限模式下，如果服务器装有 bubblewrap，命令在 `bwrap` 中执行，参数与 dsh 本地沙箱一致：根文件系统只读、`--unshare-pid`；workspace-write 下工作区可写，`/tmp` 是临时 tmpfs。插件的状态目录（`~/.cache/dsh-ssh-fleet`，内含远端 helper）在任何受限模式下都是只读的。没有 bwrap 时拒绝执行，并提示三种解决办法：装 bwrap、把会话切到 danger-full-access，或给该主机设置 `"sandbox": "unconfined"`。
- 远端 helper 在每次建立连接时都会做内容比对，与插件自带版本不一致就重新安装。
- 远端执行身份就是 SSH 登录用户，所以实际权限边界首先取决于这个账号的权限。

## 实现要点

- **会话归属**：dsh 的 Agent 驱动会把当前 Agent 放在 `AsyncLocalStorage` 里（`ctx.agents.currentInitiator()`），覆盖提示词组装、技能目录、工具、后台任务等全过程。路由器据此判断每次 `ctx.fs` 或 `ctx.subprocess` 调用属于哪个会话。
  - 没有 Agent 归属的文件调用（例如 Web 文件面板）按路径路由：锚点路径去对应服务器，其他路径走本机。在这种上下文里，远端路径也以锚点形式返回，保证后续调用仍指向同一台服务器。
  - Web 终端由终端控制器在 Agent 运行之外创建。插件给它的 `create` 和 `shells` 补上所属 Agent 的归属，因此目录检查、shell 查找和启动都会落到会话绑定的服务器上。
- **网页版**：浏览器端是一个客户端插件（`client/`，用 esbuild 打包到 `client/dist/client.js`）。
  - 设置页通过 `settings.section` 插槽注册"服务器"分区。
  - 添加工作区的目录选择流程通过 ui-workspace 的 `directoryFlow` 插槽实现：以更低优先级覆盖原有的选择器，"本机"分支原样渲染被覆盖的选择器，服务器分支复用同一个浏览对话框，只把列目录和新建目录的调用换成服务器版本。
  - 主机端接口（`/api/ssh-fleet.*`）注册在 Web 连接的 fetch 路由上，继承 dsh Web 端的 Host/Origin 校验和登录 Cookie，只有所有者可以访问。
- **远端文件系统**：连接时把 `src/remote/helper.sh` 上传到 `~/.cache/dsh-ssh-fleet/`（按内容哈希命名），所有文件操作都通过它完成：路径规范化、stat、列目录、按版本做条件写入（临时文件加 `mv`，新建文件用 `ln` 原子发布）。语义与 `dsh-fs-local` 对齐：UTF-8 与二进制判定、CRLF 保留、过期版本拒绝。远端 target key 带服务器前缀，同一路径在不同服务器上不会冲突。
- **远端进程**：通过本地 subprocess provider 启动 `ssh` 客户端，因此输出收集、溢出文件、超时、后台任务等语义与本地完全一致。远端 wrapper 用 `setsid` 建立独立进程组并记录 pgid。客户端会一直保持 stdin 打开作为"生命线"，客户端一旦消失，远端就清理整个进程组。`terminate` 和 `job_kill` 会显式向远端进程组发送 TERM，宽限期后再发 KILL。持久终端使用 `ssh -tt`，关闭时由 pty 挂断回收远端会话。
- **连接**：每台服务器一个 OpenSSH ControlMaster（`ControlPersist=600`）。
  - sshd 用账号的登录 shell 执行每一条远程命令，而 bash 对 sshd 启动的命令也会执行 `/etc/bash.bashrc` 和 `~/.bashrc`（zsh 会执行 `~/.zshenv`）。启动脚本复杂的服务器上，每条命令都要多花几百毫秒甚至几秒。
  - 因此文件操作（stat、列目录、读写、查找命令等）不再每次单独执行 ssh 命令，而是交给每台服务器最多 `helperWorkers` 个常驻的 `helper.sh serve` 进程。启动脚本只在进程启动时运行一次，之后每次操作约 30 ms，与启动脚本的复杂度无关。启动脚本打印的内容会被跳过，不影响协议。
  - 常驻进程空闲 5 分钟后退出。它意外断开时，只读操作改用单独的 ssh 命令重试，写操作报连接失败，避免重复写入。
  - master 只由插件自己创建；命令和终端的 ssh 客户端只复用它，不会充当 master。
  - 所有客户端都关闭了转义字符（`EscapeChar=none`），终端里的 `~.` 等输入不会被 ssh 客户端截获。
  - master 丢失（断网、服务器重启、空闲超时）会被检测到，随后自动重连，并重建代理转发等初始化。

## 限制

- 直接调用 `node:fs` 或 `node:child_process`、不经过 `ctx.fs`、`ctx.subprocess` 的插件无法被远程化，仍在主机执行。MCP server 也在主机上运行（这通常正是想要的）。
- PTC（`run_code`、`workflow`）worker 需要主机运行时，始终在主机的私有目录里运行。它发起的工具调用和派生的 Agent 仍会按会话路由到服务器。
- 远端文件不支持 watch：Web 文件面板不会自动刷新远端改动，需要手动点刷新。面板上显示的路径是主机上的锚点路径。
- 主机打包的可执行文件（例如 node_modules 里的 language server）在远端会按同名命令查找。所以 LSP 要求服务器上已安装对应的 language server。
- 模型执行的命令、终端和后台任务仍然各自启动一次登录 shell，所以每条命令还是会运行一次 `~/.bashrc`。如果服务器上的 `~/.bashrc` 很慢，建议在文件开头加上 Ubuntu 默认的判断 `case $- in *i*) ;; *) return;; esac`，让非交互命令直接跳过。
- 远端账号的登录 shell 需要兼容 POSIX 引号（bash、zsh、sh、dash 均可）；连接时检测到 csh、tcsh、fish 会直接报错。
- 远端程序被信号杀死时，报告为退出码 `128+N`，不填 `signal` 字段（与在 `bash -c` 里观察到的一致）。
- read 工具为了统计总行数会读完整个文件。远端读取是流式的，内存占用有界，但大文件仍会完整传输一遍。
- 认证只支持密钥或 ssh-agent（`BatchMode`），不支持交互式密码。

## 测试

```sh
npm test                 # 单元测试，任何环境都能运行

# 端到端：在本机起两台 sshd（需要 root），构造 DSH_HOME 和 sdk 测试 profile
sudo test/lab/setup-sshd.sh /tmp/fleet-lab
export FLEET_LAB=/tmp/fleet-lab DSH_HOME=/tmp/fleet-lab/dshhome
npm install && npm run test:e2e
```

端到端测试使用真实的 dsh 运行时，配合按剧本返回工具调用的模拟模型（`test/mock-llm.js`），覆盖以下场景：

- 同一实例内三个会话并发跑在 web1、db1 和本机；
- 锚点编码任意远端目录（网页版工作区使用的形式）；
- write、read、edit、grep、glob 远端执行；
- `/ssh` 各个分支；
- 子 Agent 继承绑定；
- 重启后恢复会话；
- workspace-write 写入限制；
- 技能镜像与更新同步。

修改 `client/src` 后执行 `npm run build` 重新生成 `client/dist/client.js`（随包发布）。

## 排错

- `/ssh check` 会给出每台服务器的连接错误原文（ssh 的 stderr）。
- 手工确认是否能免密登录：`ssh -o BatchMode=yes <host> true`。
- 远端状态目录 `~/.cache/dsh-ssh-fleet/`（helper、镜像、运行记录）可以随时删除，下次连接会自动重建。
