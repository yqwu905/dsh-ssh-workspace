# DSH SSH Workspaces

面向 **DeepSeek Harness 0.2.1-rc.2** 的 Web 插件。2026-10-22 核对 npm `latest` 与官方源码，基线提交为 `687f282e8625c6b8d11ff58211a90524be2e4317`。当前为 **0.2.2 测试版**；完整真实 SSHFS 挂载验收仍需要具有 FUSE 权限的机器，详见 [测试记录](docs/validation.md)。

一个 host 运行 dsh、现有插件、skills、模型连接和会话存储；远程服务器提供目录、计算环境、GPU/NPU 和终端。插件不复制一套完整 dsh 到每台服务器。

| 需求 | 实现 |
|---|---|
| 多台 SSH 服务器 | Web 直接选择 `~/.ssh/config` 及 Include 中的 Host alias，密钥和 known_hosts 留在 host |
| Helper 自动安装 | Host 准备锁定依赖和目标平台 Node，经 SSH 安装、校验、缓存复用；远端无需联网 |
| 远程目录作为 workspace | SSHFS 挂载为真实目录，注册到原生 WorkspaceRegistry |
| 原生对话 | 沿用 dsh 的 workspace、对话、新建、历史、归档和恢复 |
| host 插件和 skills | 保留同一个 host profile、注册表、模型和设置，无需重复安装 |
| 低时延命令、搜索、终端 | 按 cwd 选择官方 SSH subprocess provider，共用持久 SSH 连接和 helper |
| 原生文件读写 | 通过官方 SSH filesystem provider，保留版本检查与远程写策略 |
| 远程无法访问 LLM | dsh 模型请求在 host 发出，远程不需要外网 |
| 远程程序需要调用 host API | 可配置 SSH `-R`，仅绑定远程 `127.0.0.1` |

## 安装

Host：Linux 或 macOS；Windows 请在 **WSL2** 运行 dsh。Node `^22.19 || >=24`、npm ≥ 10、curl、tar、OpenSSH、SSHFS/FUSE。首次准备 Helper 时 Host 需要访问 npm registry 和 `nodejs.org`；可沿用 Host 的 npm/curl 代理配置。远程：Linux（glibc）或 macOS，x64/arm64，已配置 SSH 登录，有 POSIX sh、tar、`sha256sum` 或 `shasum`；**无需预装 Node/npm/helper，无需外网**。搜索工具仍需要远程 `rg`。容器运行 host 时须由部署者配置 FUSE 设备和挂载权限。

```bash
# Ubuntu / Debian host 示例
sudo apt-get install sshfs

# 使用已有的 dsh；确认版本为 0.2.1-rc.2
dsh --version

# 交付包 release/ 下有预构建安装包，不必先构建源码
dsh plugin --profile web add /absolute/path/dsh-ssh-workspaces/release/dsh-ssh-workspaces-0.2.2.tgz
dsh web
```

安装后在 Web 侧栏打开 **SSH 工作区**。若插件运行版本不同，先停止并检查兼容性，不要忽略加载错误。源码开发：`npm ci && npm run build && npm test`，再 `npm pack`。

## 连接服务器

1. 在 **Host** 配置 SSH 密钥及 `known_hosts`，确保 `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ALIAS true` 成功。插件不保存密码、不跳过 host key 校验。
2. Web 侧栏打开 **SSH 工作区 → 添加服务器 → 从 ~/.ssh/config 选择**，选中服务器。也可以手动输入 alias。
3. 保持 **Helper 安装：自动安装（推荐）**，保存后点击 **连接**。无需填写 helper 路径、SHA-256、Node 路径或执行部署命令。
4. 面板显示“检测远程平台 → Host 准备运行包 → SSH 上传安装 → 校验 → 连接”。可关闭或刷新面板，后台任务继续；安装失败会保留错误并支持再次连接重试。
5. 连接成功后添加远程目录，例如 `/data/VOSR`，再打开 workspace 或新建对话。多个服务器和 workspace 可以沿用原生对话管理。

读取的是**运行 DSH 进程的 Host 账户**的 `~/.ssh/config`，不是浏览器所在电脑的配置。支持多别名 Host、Include 的嵌套/通配符和去重；过滤 `Host *`、通配模式及 `!` 排除项。只列出别名及来源文件，不读取私钥，不执行 `Match exec`。条件 Include 中的别名也是候选项，实际连接由 OpenSSH 按原配置解析，保留 ProxyJump、端口、IdentityFile 等语义；不复制或重写配置。无法枚举的 Include 会显示提示，也可直接填写 alias。

### 自动安装的工作方式

- Host 使用随插件发布的 `runtime/package-lock.json` 执行 `npm ci --ignore-scripts`，按远端 OS/CPU 安装官方 DSH `0.2.1-rc.2` 依赖及相应原生包。不会在远端运行 npm，也不会运行 npm 安装脚本。
- Host 下载匹配目标平台的 Node `24.19.0`，对照插件内固定的官方 SHA-256 校验。Node 无需加入远端 PATH，不影响已有 Node 或项目依赖。
- 通过 SSH stdin 传送完整压缩包，在远端用户目录 `~/.local/share/dsh-ssh-workspaces/runtimes/` 的临时目录解包，校验 archive、完整文件清单和每个摘要，实际加载 PTY/Koffi/system 原生模块，再移动到独立版本目录并设为只读。
- 完整路径、helper 摘要和启动配置由扩展自动保存。再次连接先校验并复用，不重复传输；若损坏或版本不同，自动安装到新目录，保留旧目录，不覆盖其他连接可能仍在使用的运行包。
- Host 运行包缓存位于 `<stateDir>/helper-cache/`；首台服务器准备后，同平台服务器可复用缓存。模型请求、插件、Skills 仍在 Host；安装后的工具调用继续复用官方 SSH 长连接。
- 远端安装目录须位于 workspace 之外。无需 sudo；安装包支持 Linux glibc/macOS 的 x64/arm64。具体系统库、内核及沙箱能力仍由启动/连接检查确认；不支持 musl Linux 或原生 Windows。

运行包是扩展根据官方 npm 包自动准备的，并非假定 GitHub 已发布独立 helper 可执行附件。首次安装需要 Host 有网；缓存完整时重连不需要重新下载。默认每个准备/传输步骤超时 10 分钟，可通过 `helperInstallTimeoutMs` 调整。失败或强制中断产生的旧版本/临时目录不用于新连接，管理员可在确认无连接使用后清理。

### 已有手动配置

v0.1 的服务器配置可直接读取，保留原有手动模式。需要由扩展管理时，断开后编辑服务器，将 **Helper 安装** 切换为 **自动安装**。

高级用户仍可选择手动模式接管已有的 executable 或 node-script helper；原 `scripts/deploy-helper.mjs` 保留，供部署已取得且核验过的官方 archive 使用。普通使用无需执行此脚本。

## SSHFS 与远程运行环境

SSHFS 将远程目录呈现为 **DSH Host 上的一个本地路径**，供原生 workspace 注册、Web 文件树和直接使用 `node:fs` 的插件访问。它不是下载或同步整个项目；通过挂载目录读写的仍是远程文件。浏览器所在电脑不需要挂载，远程服务器也不需要安装 SSHFS/FUSE。

挂载本身不提供远程执行能力。插件另外将 SSH workspace 的 `ctx.subprocess`、PTY 和 sandbox 调用路由到对应服务器的官方 helper，并将 Host 挂载路径转换为远程真实路径。因此正常 bash/搜索/终端里的进程在远程运行，使用远程 CPU、GPU/NPU、Python、CUDA/CANN 和项目依赖；它们不会因 SSHFS 挂载而改用 Host 的运行环境。普通模型请求、插件服务、skills 发现和会话记录继续在 Host。

环境变量以远程 helper 的进程环境为基础，由 DSH 按原有规则过滤并叠加调用者显式设置。它**不保证复现你在另一个交互式 SSH 终端里已经激活的 Conda/venv、module 或环境脚本状态**。默认 bash 工具每次调用启动新 shell，需要在同一次命令中激活环境，或直接使用远程解释器：

```bash
# 在 SSH workspace 的 bash 工具中执行；.venv 属于远程项目
source .venv/bin/activate && python train.py
# 或直接指定项目内的远程解释器
.venv/bin/python train.py
# 核对实际执行位置和解释器
hostname; pwd; command -v python
```

Conda 可用 `conda run -n ENV python train.py`（必要时指定远程 conda 的完整路径）；Ascend 等依赖环境脚本的项目应在同一命令先 `source` 远程实际的环境脚本。Helper 自带的 Node 仅用于 helper 自身，不会替换项目 Node/Python。第三方插件若绕过 DSH 接口直接调用 Host `child_process`，以及明确配置的 Host 执行例外，仍在 Host，详见下表。

### SSHFS 报 `unknown option(s): -o ForwardAgent=no`

这是 0.2.0 的挂载参数错误：SSHFS 对可转交的 SSH 选项使用白名单，`ForwardAgent` 不在其中，被错误送入 FUSE。0.2.1 将 SSH 选项统一放到固定的 `ssh_command=ssh -a ...` 中交给 OpenSSH 解析，保持禁止 agent 转发、批处理登录、严格 host key 校验和 keepalive，不需要修改你的 SSH config。

更新插件并重启 DSH Web 后，在原 workspace 记录上重试挂载即可；配置、远程目录和 helper 无需删除或重装。本次已用真实 SSHFS 3.7.3 / libfuse 3.14.0 重现旧错误并验证修复后的参数解析，完整挂载验收仍需可用的 FUSE 设备。

### 对话报 workspace offline，服务器报 pending request limit reached

0.2.0/0.2.1 的插件状态检查重复发送了官方 `SshConnection` 已经管理的心跳。两套定时器都每 10 秒触发，而协议只允许一个未完成的 heartbeat；两者重叠便报 `SSH helper pending request limit reached`，随后插件把服务器标为 error，文件路由因而拒绝访问。这可能在 workspace 添加成功后、首次对话读取项目指令时表现出来。普通 RPC 的 `maxPending=128` 与心跳的独立额度不同，增大普通请求上限不能解决此问题。

0.2.2 只保留官方连接的心跳；Web 状态检查改用只读的 `terminal.environment` 查询（不会创建终端或启动命令），同一连接最多一个检查在途。普通 RPC 暂时满载时跳过这一轮检查，不标离线、不重放业务操作；真实传输故障仍会标为 error 并阻止本地回退。

恢复步骤：更新插件到 0.2.2，重启 DSH Web；在 SSH 工作区面板重新连接服务器、挂载原 workspace，然后重试原对话。已有服务器配置、workspace 注册、历史对话和远程项目可保留；无需删除 helper 或修改 SSH config。

## 继承插件和 skills 的含义

**全部已启用插件和 skills 继续在同一个 host profile 中加载和可用。** 工具路由只改变受支持的执行接口，不更改插件安装列表、LLM 配置、登录状态或技能内容。

| 插件使用方式 | 执行位置 / 兼容性 |
|---|---|
| 调用 dsh 模型、网络、存储、skills、Web UI | host，复用原配置 |
| 使用 `ctx.fs` 的 read/write/edit | SSH workspace 内走远程 helper；host 路径保持本地 |
| 使用 `ctx.subprocess` 的 bash/grep/glob/terminal | 根据 workspace cwd 路由到对应远程 |
| 直接 `node:fs` 访问 workspace | 通过 SSHFS 看到远程目录，遵守远程账户权限；不具备原生远程写策略保证 |
| 直接 `child_process`、自带独立 runtime | 不会被通用路由自动接管，需要插件适配 |
| skill 调用 host 的绝对脚本路径/二进制 | 需在远程安装依赖并同步脚本，或明确让该程序在 host 执行 |

因此，本版**不声称任意第三方插件的所有系统调用都能自动远程化**。尤其依赖本地浏览器、桌面、CUDA、Node 原生模块或自己的子进程管理的插件，需要按实际用途决定执行位置。

Web 的“程序路径映射”接受 JSON，例如 `{"/host/path/to/python":"/remote/venv/bin/python"}`。默认只自动把 dsh 打包的 `rg` 映射为远程 `rg`，以及常见 shell 映射为远程 PATH 的同名 shell；不会猜测其他二进制。

“Host 执行程序”是显式例外清单，条目匹配 argv[0]，例如某个特定 host 工具的绝对路径。它会使这个程序及其沙箱继续运行在 host，cwd 为挂载目录。**不要为了某一个 skill 把所有 `python`/`node` 都放入清单**，否则训练命令也可能在 host 执行。官方已安装的 PTC worker 通过精确包路径识别并保留在 host，worker 调用的工具仍按 workspace 路由。

## 断网服务器访问 host LLM

普通 dsh 对话无需配置：模型请求始终由 host 发出。

若远程训练脚本/子代理也要访问 host 的 `http://127.0.0.1:8000/v1`，在服务器的“反向隧道”填：

```json
[{"remotePort":18000,"host":"127.0.0.1","port":8000}]
```

连接后，远程程序使用 `http://127.0.0.1:18000/v1`。SSE/流式输出经过 TCP 隧道原样传输。插件不复制、不注入 API Key；远程程序仍需正确的鉴权设置。外部 HTTPS LLM 的普通 dsh 请求仍直接从 host 访问；若远程程序必须访问外部地址，请先在 host 建立你控制的回环 API 网关，再转发该端口。插件限制目的地为 host 回环地址。

## 行为与限制

- 只支持 POSIX host/remote；Windows 原生 OpenSSH 的控制 socket 不在支持范围，WSL2 可作为 host。
- SSH server 必须允许 Unix-socket forwarding；可选反向 API 隧道还需要 remote TCP forwarding。
- 断线后拒绝新命令，不自动重放可能已执行的写入/命令。已完成或部分完成的远程效果不会自动回滚。
- 重启后保留服务器/workspace/对话记录，要求在面板手动重新连接、挂载；不会自动接管遗留挂载。
- 卸载或断开前检查活跃对话、jobs、子代理和 schedule；外部编辑器占用导致的 busy mount 会报错。
- 未挂载路径使用悬空标记，防止原生 UI 将其重新创建为空 host 目录。删除注册不会删除远程目录和历史会话；该挂载位置会保留离线保护标记。
- 命令应优先使用相对路径。对于包含 host 挂载路径且同时使用 heredoc、命令替换或复杂转义的 shell 文本，插件会拒绝不可靠的自动改写，提示改用相对路径。
- 核心文件接口拒绝指向已注册远程目录之外的符号链接；SSHFS 的 host 文件访问不能提供同等远程路径沙箱保证。安装在 host 的第三方插件仍属于受信任代码。
- SSHFS 禁用属性/目录缓存以减少远程训练程序修改文件后看到旧内容的风险；大目录文件树浏览仍有网络开销，批量搜索与命令应使用原生远程工具。
- 同一 profile 请只启用一份本插件。升级 dsh 后应重新运行测试与验收，当前没有跨版本兼容承诺。

配置、架构和源码定位见 [架构说明](docs/architecture.md)；部署后验收见 [测试记录](docs/validation.md)。
