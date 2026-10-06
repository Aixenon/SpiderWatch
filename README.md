# SpiderWatch

Cloudflare Workers + SQLite Durable Objects 网络监控面板，配套单文件客户端 `spider-watch`。前端随 Worker 一起部署，无需单独部署 Pages、数据库或 R2。

## 部署到 Cloudflare

需要一个 Cloudflare 账户和包含本项目完整源码的 GitHub 仓库。通过 Cloudflare Workers Builds 连接仓库即可部署；面板使用 GitHub 登录，无需开通 Zero Trust。可以使用 `workers.dev` 地址，也可绑定自己的域名。

源码仓库可以私有保存；现有客户端安装与自动更新依赖可访问的公开 GitHub Releases。

### 1. 连接仓库并部署

在 Cloudflare 控制台进入 **Workers & Pages → Create application → Import a repository**，授权 GitHub 并选择已有仓库。使用以下构建配置：

| 配置 | 值 |
|---|---|
| Worker 名称 | `spider-watch` |
| Root directory | `/`（默认仓库根目录） |
| Build command | 留空 |
| Deploy command | `npm run deploy` |
| Preview command | `npm run preview` |

关闭 **Enable Preview Builds**，生产分支选择 `main`。当前配置用于正式部署，分支预览需要独立设置登录和资源绑定。

点击 **Save and Deploy**。Cloudflare 一起发布前端、Worker 和 SQLite Durable Object；部署脚本自动补齐注册邀请密钥和独立的会话签名密钥，后续部署保留已有密钥。

已经把 Root directory 填为 `worker` 的项目也可继续使用相同命令。如果日志提示找不到 `/opt/buildhome/repo/package.json`，请部署仓库最新提交；根目录现已提供安装与部署入口。

首次部署会提供 `workers.dev` 地址。登录配置未完成时，页面只显示配置提示，不能取得管理权限。

### 2. 设置 GitHub 登录

1. 确定面板地址，例如 `https://spider-watch.你的子域.workers.dev`。使用自定义域名时，先在 Worker 的 **Settings → Domains & Routes** 添加域名。
2. 打开 GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**。Application name 填 `SpiderWatch`，Homepage URL 填面板地址，Authorization callback URL 填 `https://你的面板地址/panel/auth/github/callback`。无需启用 Device Flow。创建后复制 Client ID，并生成 Client Secret；每位部署者创建自己的 OAuth 应用。
3. 访问 `https://api.github.com/users/你的GitHub用户名`，记录返回的数字 `id`（不是 `node_id`）。在 Worker 的 **Settings → Variables and Secrets** 添加以下运行时配置并保存部署：

| 名称 | 内容 |
|---|---|
| `GITHUB_CLIENT_ID` | OAuth 应用的 Client ID，类型 Text |
| `GITHUB_CLIENT_SECRET` | OAuth 应用的 Client Secret，类型 Secret |
| `ADMIN_GITHUB_IDS` | 允许登录的 GitHub 数字 ID，多个用逗号分隔，类型 Text |

`SESSION_SECRET` 由部署脚本自动生成，无需手动填写。登录配置不完整时拒绝访问，不会让首位访问者自动成为管理员。后续发布保留控制台中的登录配置、域名以及 `workers.dev` 开关；更换面板域名时也要更新 GitHub OAuth 回调地址。

已有 Access 部署请先部署新版并填好 GitHub 配置，再删除本项目的 Access 应用和 Bypass 应用，关闭 Worker 级 Access 保护。旧的 `ACCESS_TEAM_DOMAIN`、`ACCESS_PANEL_AUD`、`ACCESS_AGENT_AUD`、`ADMIN_EMAILS` 可从运行时配置移除。

面板和管理接口位于 `/panel/`，根地址自动跳转。登录采用 GitHub 授权码、PKCE 和管理员 ID 白名单；会话为 8 小时，Worker 本地验证签名 Cookie，无需逐次访问 GitHub 或数据库。退出清除当前浏览器会话；如需使全部已签发会话失效，可更换 `SESSION_SECRET`。已建立的实时连接按原会话到期时间关闭。客户端继续使用专用 Ed25519 密钥和一次性邀请，不依赖 GitHub 登录。

### 3. 登录并添加设备

打开面板，点击 **使用 GitHub 登录**，通过 GitHub 官方授权页返回后进入总览。按下节安装客户端，然后在 **管理 → 添加设备** 中复制注册指令，到目标设备执行即可加入网络。

后续推送代码到连接的分支，Cloudflare 会自动重新部署。保持 Worker 名称 `spider-watch` 和 `MONITOR_GROUP` 不变，设备身份与设置会保留。部署面板不会自动创建客户端 Release；需要发布客户端时，按下一节操作。

本地部署备选（Node.js 22 或更新版本）：

```sh
cd worker
npm ci
npx wrangler login
npm run deploy
```

本地部署使用同一流程，自动识别首次或已有部署；域名和 GitHub 登录配置仍在 Cloudflare 控制台管理。

## 发布与安装客户端

推送稳定版本标签，例如 `v0.7.0`。**SpiderWatch builds** 生成各平台客户端、Windows 安装包及 SHA-256 清单，并发布 Release。失败时保留草稿，可重跑；已发布的版本不覆盖，需要新标签。用于安装和自动更新的 Release 必须公开可访问。

普通提交、Pull Request 和手动运行也会编译，但只产生 Actions 下载产物，不发布稳定更新。

### 平台

| 系统 | 编译目标 |
|---|---|
| Windows | x64 / amd64、32 位 x86 / 386、ARM64 |
| macOS | Intel / amd64、Apple Silicon / ARM64 |
| Linux | amd64、386、ARMv5 / v6 / v7、ARM64、MIPS / MIPSLE、MIPS64 / MIPS64LE、RISC-V 64、LoongArch64、PPC64LE、s390x |

Linux 提供静态二进制，无需按 Ubuntu、Debian、Alpine 等发行版选择不同安装包。ARMv5 和 MIPS 使用软件浮点，MIPS 大小端分别提供；安装脚本按用户空间位数和字节序选择对应版本。ARMv6/v7 需要相应浮点支持。RISC-V 使用 RVA20U64 基线，未提供 RISC-V 32 位和 macOS 32 位包。

Windows 要求 Windows 10 / Server 2016 或更新版本；macOS 要求 macOS 13 或更新版本。Linux 还须满足所用 Go 版本的内核和 CPU 要求，静态链接不代表支持任意老内核。参考：[Go 支持平台](https://go.dev/doc/install/source#environment)、[Go 最低系统要求](https://go.dev/wiki/MinimumRequirements)。

### 安装

进入客户端发布仓库的 **Releases**，复制该版本的安装命令。命令和附件脚本已包含仓库名及版本号，安装时无需再填写仓库参数。

- **Windows**：下载对应架构的 `spider-watch-windows-架构-setup.exe`，运行安装向导。默认安装到 `C:\Program Files\SpiderWatch`，注册开机服务和更新任务，添加命令到 PATH。安装后新开管理员终端。也可使用 Release 提供的 `curl.exe` + PowerShell 命令。
- **Linux / macOS**：使用 Release 提供的 `curl` 下载 `install.sh`，再执行 `sudo sh install.sh`。同一个脚本识别系统和架构，并适配 systemd、OpenRC、procd 或 launchd。程序位于 `/opt/spider-watch/spider-watch`，命令链接位于 `/usr/local/bin/spider-watch`。需要 curl、CA 证书和 SHA-256 校验工具。
- **手动运行**：直接下载对应的单个二进制。Unix 安装脚本可加 `--no-service --prefix "$HOME/.local/bin"`；也可用 `--arch` 指定清单中的架构。没有支持的服务管理器时，脚本会说明原因，不假装完成开机启动。

### 加入网络与更新

安装完成后，在面板 **管理 → 添加设备** 中复制注册指令。Linux/macOS 在指令前加 `sudo`；Windows 在新的管理员终端粘贴执行：

```sh
spider-watch configure --server "面板提供的完整邀请地址" --join 网络代码
```

邀请最多有效 5 分钟，仅首台成功注册的设备可使用。客户端自动生成专用 Ed25519 密钥和随机设备 ID，注册后直接加入；已安装的服务自动开始运行。不要分享注册指令或本地配置文件。旧版已有身份可通过 `--config` 指定原配置文件继续使用；安装到新目录不会自动读取任意旧私钥。

设备配置中可设置名称、分组、图标和自动更新。自动更新由系统每 6 小时检查一次；手动可执行 `spider-watch --update`，Unix 使用 sudo，Windows 使用管理员终端。检查但不安装：`spider-watch update --check`。OpenRC/procd 的自动更新需要正在运行的 cron 服务。

更新仅允许已注册设备从自己的 Worker 下载；Worker 从当前固定仓库的稳定 GitHub Release 按需读取，客户端校验版本、大小和 SHA-256 后替换。首次安装从公开 Release 获取，后续设备更新不依赖公开安装入口。没有额外常驻更新进程。

Windows 可在 **设置 → 应用 → SpiderWatch → 卸载** 移除程序、服务和更新任务。卸载保留 `%ProgramData%\spider-watch\state` 中的设备身份，以便重装复用；永久撤销设备请同时在面板删除。Unix 身份位于 `/var/lib/spider-watch/state`。

## 面板设置

- **总览**：设备状态、总 CPU 使用率、物理内存、卷容量汇总及网卡上下行总速率。点击设备进入处理器、内存、网络、磁盘四块详情；每张网卡显示独立的上下行曲线，点击物理磁盘展开所属逻辑卷。
- **管理**：添加或删除设备，配置昵称、图标、分组和更新方式。
- **设置**：面板开启时默认每 5 秒采集上报，可设为 2–300 秒；关闭时可选 2、5、10 分钟，默认 10 分钟，且不能短于开启间隔。保存后持续生效。额度显示本项目 Durable Objects 请求、SQLite 读写和运行用量的估算，未接入 Cloudflare 账户账单 API，每 5 分钟自动刷新。

客户端启动时检查可用内存，低于 16 MiB 拒绝运行；Go 内存软目标 20 MiB、RSS 预算 32 MiB、发布二进制上限 16 MiB。Windows 工作集上限和 Linux systemd 设有系统限制；macOS、OpenRC/procd 依靠定期 RSS 检查，不能承诺瞬时硬上限。程序及更新临时文件以 64 MiB 磁盘预算设计。

磁盘采集以当前权限可读的本地卷为单位，不扫描文件夹大小或读取裸盘内容。无法识别物理归属的卷单独显示，重复挂载合并，APFS 共享存储池只汇总一次。旧版客户端需更新后才能提供物理归属和 APFS 容器用量。单次最多采集 32 个卷和 16 个非回环网卡。系统未提供的细项显示不可用；物理内存、缓存、已提交虚拟内存存在重叠，不能直接相加。

实时曲线保留浏览器收到的最近 120 个采样点。长期历史保存在 Durable Object 的 SQLite 中，按“面板关闭”间隔记录并保留 7 天，查看面板时也保持此保存间隔。较长时间范围合并为最多 1008 个图形点，原始记录保持不变。历史采用批量存储和无损压缩；数据保存、读取、到期删除及定时唤醒仍会消耗 Cloudflare 额度。

macOS 的物理归属及 APFS 容器容量最多缓存 5 分钟，每卷数据仍随正常采样更新。

参考：[GitHub OAuth 应用](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)、[GitHub 登录流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[Workers 构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[部署时上传 Secret](https://developers.cloudflare.com/workers/configuration/secrets/)。
