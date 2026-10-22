# SSH 已连接，但命令报 sandbox backend 不可用

这表示 DSH 收到了 `workspace-write`（或 `read-only`）策略，但执行命令的机器无法准备对应沙箱。聊天请求仍由 Host 发给模型，所以聊天成功与命令失败可以同时发生。SSHFS 只提供文件目录视图，也不提供进程沙箱。

0.2.4 起，自动 Helper 同时携带匹配平台的 **bubblewrap 0.13.1 静态运行器和官方 Landlock 启动器**。Linux x64/arm64 不再需要手动安装 bubblewrap，远端无需联网、sudo 或系统包管理器。macOS 使用系统自带的 sandbox-exec。

升级插件、重启 DSH 后重新连接自动模式服务器，会自动安装新的 runtime，旧目录保留；随后挂载原工作区即可。手动模式不会被擅自更改，可断开后编辑为自动安装。Host 本身运行 PTC 等命令所需的沙箱环境仍须由 Host 提供。

安装验证会检查完整摘要、执行位、目标平台，并实际执行内置 `bwrap --version`；连接时再用官方沙箱 profile 检查内核是否允许约束。安装校验通过不能说明运行内核启用了 Landlock、容器允许相关调用，或 bubblewrap 能创建命名空间。仅重装二进制无法修复这些系统条件。

内置 bwrap 优先；若它不可用，则探测原 PATH 中已有系统 bwrap，最后保留官方 Landlock 回退。整个过程不会修改 PATH、系统包、setuid 位或沙箱策略。探测与执行固定使用相同绝对路径，调用者的 PATH 覆盖不能替换已探测的运行器。详见 [源码与构建说明](../runtime/vendor/bubblewrap/NOTICE.md)。

## 先确定是哪台机器

从 0.2.3 起，连接时自动预检 Host 和远程的沙箱后端；Web 的 **检查连接与沙箱** 可重新查询。服务器卡片显示两份结果，失败时展开详细信息。沙箱不可用不再隐藏在“SSH 连接成功”后面，也不会因此把 SSH 标为离线。

| 位置 | 执行内容 | 在哪里修复 |
|---|---|---|
| `SSH server ALIAS (remote workspace ...)` | SSH workspace 的普通 bash、搜索等命令 | 该 SSH 账户实际运行的服务器/容器 |
| `DSH Host (PTC worker or hostExecutables exception ...)` | 保留在 Host 的官方 PTC worker、显式 Host 程序 | 运行 DSH 的 Host 进程所在环境 |
| `DSH Host (workspace ...)` | 本地工作区命令 | 运行 DSH 的 Host 进程所在环境 |

预检只调用官方 `confine`，请求 `read-only` 并丢弃返回的 argv，不执行项目命令，也不授予根目录写权限。Linux 官方实现会在这一步功能探测 bubblewrap/Landlock；部分平台的单一后端在真正执行时才验证。因此“已选择后端”不是每条命令都会成功的保证，`partial` 也不会显示成完整约束。每条命令仍遵循原策略和运行时检查。

## Linux 的恢复方式

在上表确定的执行环境中检查，而不是仅在浏览器电脑或容器宿主机的另一个账户下检查：

自动管理的远程 Helper 安装在私有目录，`command -v bwrap` 查不到它是正常的。对它请使用安装记录对应 runtime 中的 `tools/bin/bwrap`；下列 PATH 检查主要用于 Host/手动模式。

```bash
uname -r
command -v bwrap
# 最小只读探针；保留 stderr。成功也不等同于整个 DSH profile 已通过。
bwrap --ro-bind / / -- /bin/true
```

- **旧版远程 Helper 没有 `bwrap`**：升级到 0.2.4，保持自动模式后重新连接即可。**Host/手动模式没有 `bwrap`**：用该发行版受支持的包安装，例如 Debian/Ubuntu 的 `sudo apt-get install bubblewrap`。插件不会擅自修改系统包、内核或容器配置。
- **`Operation not permitted` / namespace 创建失败**：二进制已经存在，但当前环境不允许它工作。由部署者检查容器、安全策略和命名空间能力，或选择允许沙箱运行的执行环境。单纯重装包不能保证解决。
- **使用 Landlock**：需要内核实际启用并允许执行规则，不能只看内核版本号。自动 Helper 已带启动器，无需另装一个假的 runner 或将 runner 指向普通 shell。

若需单独查看远程 Helper 自带 Landlock 的探针结果，使用该服务器自动安装记录中 `Node.js 绝对路径` 对应的 runtime 目录（`.../node/bin/node` 向上三级），在远程账户中执行：

```bash
DSH_SSH_RUNTIME='/absolute/path/to/the/installed/runtime'
cd "$DSH_SSH_RUNTIME"
./tools/bin/bwrap --version
# 最小只读探针，便于保留具体的 namespace/权限错误：
./tools/bin/bwrap --ro-bind / / -- /bin/true
./node/bin/node --input-type=module -e 'import { launcherPath, probe } from "@deepseek-ai/node-addon-system/landlock-run"; console.log({launcher: launcherPath(), enforcement: probe()})'
```

结果为 `full`、`partial` 或 `unusable`；后者也可能来自启动器不可执行、系统库不匹配或探针超时，需结合系统日志判断。手动 Helper 应使用其实际依赖和运行时路径。不要改动只读 runtime 的文件或摘要。

修复远程后，停止正在使用该服务器的任务，在面板**断开、重新连接并挂载原工作区**；修复 Host 后**重启 DSH Web**。官方 provider 缓存后端选择，单点“检查”不会重启 helper。无需删除 workspace、对话或远程项目。

macOS 应检查命令执行环境中的 `sandbox-exec`；Linux 的安装命令不适用。

## 明确选择无沙箱执行的部署

如果部署者决定使用无沙箱的可信隔离环境，可以通过 DSH 原生的**当前会话权限控件 → 完全权限**自行确认，或配置其 `@deepseek-ai/dsh-sandbox-policy` 的 `mode: danger-full-access`。这会取消 DSH 的文件写入边界；“完全权限”预设还会调整审批策略。全局默认只影响没有会话覆盖的解析结果，已有会话应检查自身权限。

插件不会把 `workspace-write` 偷换成 `danger-full-access`，也不会在沙箱失败后把远程命令回退到 Host 或原样运行。返回错误保留 `SANDBOX_UNAVAILABLE` 和原因链，只补充执行位置并移除官方 SSH provider 的重复包装。

参考：[Linux Landlock 文档](https://docs.kernel.org/userspace-api/landlock.html)、[bubblewrap 官方项目](https://github.com/containers/bubblewrap)、[DSH 沙箱策略](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sandbox/sandbox-policy)。
