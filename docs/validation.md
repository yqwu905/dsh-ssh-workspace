# 验证记录与部署验收

日期：2026-10-22。基线：DSH npm latest `0.2.1-rc.2`，官方 master `687f282e8625c6b8d11ff58211a90524be2e4317`。Node v24.19.0，Linux x64。

插件版本：0.2.3。此次增量重跑 typecheck、build、unit/SSHFS 参数回归、连接生命周期/沙箱诊断回归和 Web smoke；真实加密 SSH 传输及 helper 安装结果沿用 0.2.0 的记录（安装/传输实现未修改）。新增沙箱预检使用真实官方 SSH provider/RPC framing 与内存传输测试，没有验证用户服务器的实际内核/容器能力。

## 已完成

| 检查 | 结果与证据范围 |
|---|---|
| `npm run typecheck` | 严格 TypeScript 检查通过 |
| `npm run build` | host ESM、browser 懒加载 CJS factory、声明文件生成通过 |
| `npm test` | 41/41 通过；设置 `SSHFS_TEST_BINARY` 指向实际 SSHFS 3.7.3。默认从 PATH 查找，未安装时仅真实解析测试 skip。结果摘要保存在 `test-results.txt` |
| 沙箱诊断回归 | 官方 SSH provider 重复包装的错误可定位到远程；Host 故障单独显示。不可用时连接/项目指令读取仍可用、没有 process RPC；检查接口返回失败详情，断开清除诊断、重连重新检测；运行态诊断不写入严格配置。路由保留 `workspace-write`、`SANDBOX_UNAVAILABLE` 与原因链，不回退；只读预检保留 partial、超时有界 |
| 首轮对话离线回归 | 使用真实 Manager、已发布的 SshConnection/SSH providers/RPC framing，SSH 子进程由内存流替代。修复前复现相同 pending request limit/error 状态；修复后验证慢心跳重叠时读取项目指令成功、128 个普通 RPC 满载不误报离线、真实流断开后拒绝访问与重连、慢状态检查不重叠及旧连接检查不污染重连 |
| SSHFS 参数回归 | 真实 SSHFS 3.7.3 / libfuse 3.14.0 重现 `ForwardAgent=no` 错误；修复后只有有意添加的探针选项被拒绝，避免尝试挂载/连接。真实 OpenSSH `-G` 验证禁止 agent 转发、严格 host key、BatchMode、keepalive 以及 alias 的 HostName/User/Port/ProxyJump 保留 |
| `npm run test:ssh` | 4 pass、1 skip（Node 统计包括父测试）；真实 OpenSSH client 与非特权 SSH2 fixture 完成加密连接、并行 cwd、反向 TCP SSE；Manager 连接失败后没有泄露可用 provider |
| `npm run test:web` | 真实已发布 dsh Web profile 启动；401 未登录、403 不可信 Origin、登录后 SSH config API、无 helper 字段的自动模式、手动模式 CRUD、browser module discovery 通过 |
| `npm run test:install` | 6/6 通过（含父测试）；真实 OpenSSH + SSH2 fixture：完整自动安装及原生模块加载、重连复用不上传、损坏重装、截断/错误摘要拒绝、后台 Manager 状态与配置持久化 |
| 跨平台依赖准备 | Host 上对 Linux arm64、macOS x64/arm64 分别执行锁定的目标平台 `npm ci --ignore-scripts`，确认对应 PTY/system/Koffi 原生资源存在；未在这些远端平台执行运行包 |
| SSH 配置导入 | 嵌套/通配 Include、多别名、去重、循环引用、通配/否定过滤、缺失配置、错误提示及不返回私钥内容通过 |
| Helper archive 部署 | checksum、manifest、路径穿越/链接/模式拒绝测试通过；模拟 SSH 传输下的安装 shell 验证通过 |
| 文件与进程路由 | 真实 Cordis 服务装卸；双服务器 target 隔离；原生本地/沙箱 FS 作为远端测试替身，验证 stale guard、写模式及 symlink 越界 |
| 离线与删除 | 断线拒绝 host 回退；删除注册后保存 tombstone；删除服务器、重启后历史路径仍被阻止 |

## 仍未验证的范围

本执行环境没有 `/dev/fuse`，限制 AF_UNIX socket 创建，且生产 sshd 的 chroot 不被允许。测试没有放宽这些限制。

因此尚未实际跑通：**SSHFS 真挂载 → 官方 native helper/ControlMaster → 真实远程进程/PTY/取消/远程 sandbox → Web 对话完整链路**。`test:ssh` 对这一项明确 skip；其余 SSH 测试不等同于此项通过。没有调用真实 LLM，也没有完成浏览器交互/视觉自动化验收。没有实测 A30/910B 或跨机器生产时延。

这是安装包齐全、接口已对齐的测试版，不是已经在你的 SSH 服务器上部署并验收的生产版本。插件现在自动准备并经 SSH 部署官方 npm helper 及独立 Node，不要求用户手动安装。Linux x64 已通过上述安装验收；macOS/arm64 目前只检查目标依赖准备，真实运行仍待验收。

## 在部署机完成验收

```bash
npm ci
npm run typecheck
# 需要 sshfs 在 PATH；也可设置 SSHFS_TEST_BINARY=/path/to/sshfs
npm test
npm run build
npm run test:web
# 首次在 Host 下载锁定依赖和 Node；测试远端屏蔽环境中的 node/npm/curl/wget
npm run test:install
# 具备 sshd、AF_UNIX、所需本地权限的 Linux 测试主机：
RUN_SSHD=1 npm run test:ssh
```

生产 sshd 测试只创建临时 host key、client key、配置和目录，不修改现有 SSH 登录配置。`RUN_SSHD=1` 的权限条件以测试脚本报错为准。

FUSE/Web/模型综合验收步骤：

1. 在 host 确认 `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ALIAS true` 成功，SSHFS 与 FUSE 可用。
2. 从 `~/.ssh/config` 选择两个服务器，保持自动安装并连接；远端不预装 helper/Node，确认部署成功及 `rg` 可用。再次连接确认无需上传，修改一次测试安装文件确认自动换目录重装。
3. 每台添加一个专门测试目录。确认原生 workspace 的文件树与远程 `ls` 一致，不能看到一个空的本地替代目录。
4. 两个对话同时运行 `hostname; pwd`、读写不同文件。检查命令实际在对应服务器运行，host 和另一台服务器无错误写入。
5. 新建持久 terminal，执行短任务、前台等待和后台任务，点击停止后核实远程进程组清理。重复检查 read-only 与 workspace-write。
6. 在只允许 SSH 的服务器上完成一次真实模型对话，确认模型连接只由 host 发起；另测一个已配置反向 API 端口的 SSE 请求。
7. 训练程序从远程修改文件后刷新 Web。验证核心文件读写的版本冲突提示，以及目录外 symlink 的拒绝行为。
8. 断网、断开、卸载、删除 workspace 后重开历史对话，确认失败信息明确，绝不在 host 创建同名项目并继续执行。
9. 分别抽查你实际使用的第三方插件与 skill 脚本，记录执行位置和远程依赖；直接 child_process 插件不在自动路由保证内。
10. 测量连续小文件读取、rg、短 bash 的 warm P50/P95，再与直接 SSH 和本地 dsh 对比。不要把 SSH2 回环测试当成生产性能结论。

自动安装 fixture 使用真实加密 SSH 传输及实际 Linux x64 Node/原生依赖；远端 PATH 中的 node/npm/curl/wget 被故意禁用。它不是断网生产服务器、真实浏览器、macOS 或 arm64 的综合验收。AF_UNIX/FUSE 限制仍影响后续原生 helper 会话链路，不影响本次已验证的安装流程。
