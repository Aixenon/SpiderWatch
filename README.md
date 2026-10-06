# SpiderWatch

Cloudflare Workers + SQLite Durable Objects 网络监控面板，配套单文件客户端 `spider-watch`。前端随 Worker 一起部署，无需单独部署 Pages、数据库或 R2。

面板使用 Vue 3，源码在 `worker/ui`。部署命令会自动检查并构建同一套界面；本地预览可运行 `npm --prefix worker run dev`，打开终端显示的本地地址。本地数据与线上数据独立。

## 部署到 Cloudflare

需要一个 Cloudflare 账户、托管在该账户下的域名和包含本项目完整源码的 GitHub 仓库。GitHub Actions 编译客户端后，将面板、Worker 和全部平台安装文件一起部署。面板使用 GitHub 登录，无需开通 Zero Trust。默认使用自定义域名，关闭 `workers.dev` 和预览地址。

源码仓库可以保持私有。首次安装和设备更新均从自己的 Worker 下载，无需公开 GitHub Release，也不使用 R2。

### 1. 配置自动部署

在 Cloudflare 创建使用 **Edit Cloudflare Workers** 模板的 API Token，权限范围只选择用于部署的账户。在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 配置：

| 位置 | 名称 | 内容 |
|---|---|---|
| Secrets | `CLOUDFLARE_API_TOKEN` | 上述部署 Token |
| Variables | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |
| Variables | `WORKER_NAME` | Worker 名称，默认 `spider-watch`；迁移已有面板时填写原名称 |

Token 只保存在 GitHub Secret 中，不写入源码。仓库名和源码提交会在编译时自动识别，Fork 后无需修改下载地址。已使用 Cloudflare Workers Builds 的项目，请在原 Worker 的构建设置中断开自动构建连接，避免两条发布流程同时运行。

打开仓库 **Actions → SpiderWatch builds → Run workflow**，选择默认分支运行；之后推送到默认分支会自动触发。19 个平台二进制、3 个 Windows 安装包与脚本全部生成并校验成功后，才部署同一提交的面板、Worker 和静态文件。任何编译或校验失败都不发布。Pull Request 和其他分支只编译，不部署生产环境。

部署脚本自动创建 SQLite Durable Object 绑定，并补齐注册邀请密钥和会话签名密钥；后续部署保留已有密钥与设置。

首次部署完成后，在 Worker 的 **Settings → Domains & Routes → Add → Custom Domain** 绑定面板域名，例如 `monitor.example.com`，再继续设置登录。登录配置未完成时，页面只显示配置提示，不能取得管理权限。

`worker/wrangler.jsonc` 中的 `workers_dev` 和 `preview_urls` 默认均为 `false`，每次部署按源码配置应用；已有部署启用的地址也会在下次部署时关闭。如需使用 `workers.dev`，将源码中的 `workers_dev` 显式改为 `true` 后重新部署；预览地址由 `preview_urls` 独立控制。

### 2. 设置 GitHub 登录

1. 确定已绑定的面板地址，例如 `https://monitor.example.com`。
2. 打开 GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**。Application name 填 `SpiderWatch`，Homepage URL 填面板地址，Authorization callback URL 填 `https://你的面板地址/panel/auth/github/callback`。无需启用 Device Flow。创建后复制 Client ID，并生成 Client Secret；每位部署者创建自己的 OAuth 应用。
3. 访问 `https://api.github.com/users/你的GitHub用户名`，记录返回的数字 `id`（不是 `node_id`）。在 Worker 的 **Settings → Variables and Secrets** 添加以下运行时配置并保存部署：

| 名称 | 内容 |
|---|---|
| `GITHUB_CLIENT_ID` | OAuth 应用的 Client ID，类型 Text |
| `GITHUB_CLIENT_SECRET` | OAuth 应用的 Client Secret，类型 Secret |
| `ADMIN_GITHUB_IDS` | 允许登录的 GitHub 数字 ID，多个用逗号分隔，类型 Text |

`SESSION_SECRET` 由部署脚本自动生成，无需手动填写。登录配置不完整时拒绝访问，不会让首位访问者自动成为管理员。后续发布保留控制台中的登录配置和自定义域名；`workers.dev` 与预览地址开关以源码配置为准。更换面板域名时也要更新 GitHub OAuth 回调地址。

登录失败时，页面会区分应用凭据错误、回调不匹配、授权码失效及 GitHub 连接失败。Client Secret 必须来自同一个 OAuth App，不能使用个人访问令牌代替；授权码失效时点击“重新登录”，不要刷新回调页面。运行日志仅记录验证阶段和固定错误代码，不记录凭据或 GitHub 响应正文。

已有 Access 部署请先部署新版并填好 GitHub 配置，再删除本项目的 Access 应用和 Bypass 应用，关闭 Worker 级 Access 保护。旧的 `ACCESS_TEAM_DOMAIN`、`ACCESS_PANEL_AUD`、`ACCESS_AGENT_AUD`、`ADMIN_EMAILS` 可从运行时配置移除。

面板和管理接口位于 `/panel/`，根地址自动跳转。登录采用 GitHub 授权码、PKCE 和管理员 ID 白名单；会话为 8 小时，Worker 本地验证签名 Cookie，无需逐次访问 GitHub 或数据库。退出清除当前浏览器会话；如需使全部已签发会话失效，可更换 `SESSION_SECRET`。已建立的实时连接按原会话到期时间关闭。客户端继续使用专用 Ed25519 密钥和一次性邀请，不依赖 GitHub 登录。

### 3. 登录并添加设备

打开面板，点击 **使用 GitHub 登录**，通过 GitHub 官方授权页返回后进入总览。按下节安装客户端，然后在 **管理 → 添加设备** 中复制注册指令，到目标设备执行即可加入网络。

保持 Worker 名称和 `MONITOR_GROUP` 不变，设备身份与设置会保留。每次默认分支发布都会同步全部客户端静态文件，创建 GitHub Release 是可选的归档步骤。

本地部署备选（Node.js 22 或更新版本）：先将本次 **SpiderWatch builds** 的 `spider-watch-release` 产物解压到 `client/dist`，再执行：

```sh
cd worker
npm ci
npx wrangler login
npm run deploy
```

本地部署使用同一流程；缺少平台、文件校验失败或产物不属于当前提交时会拒绝发布，避免清空已上线的安装文件。多账户环境需指定 `CLOUDFLARE_ACCOUNT_ID`，已有非默认名称的 Worker 需指定 `WORKER_NAME`。域名和 GitHub 登录配置仍在 Cloudflare 控制台管理。

## 发布与安装客户端

普通提交自动编译并同步到 Worker，无需先创建 Release。客户端版本维护在 `client/VERSION`；构建同时记录源码提交，设备可识别同一版本号下的新构建，已运行相同构建时不会重复下载。

如需正式 GitHub Release，推送与 `client/VERSION` 一致的稳定标签，例如 `v0.7.1`。发布失败时保留草稿，可重跑；已发布版本不覆盖，需要新标签。私有仓库的 Release 仍然私有，不影响 Worker 安装和更新。

### 平台

| 系统 | 编译目标 |
|---|---|
| Windows | x64 / amd64、32 位 x86 / 386、ARM64 |
| macOS | Intel / amd64、Apple Silicon / ARM64 |
| Linux | amd64、386、ARMv5 / v6 / v7、ARM64、MIPS / MIPSLE、MIPS64 / MIPS64LE、RISC-V 64、LoongArch64、PPC64LE、s390x |

Linux 提供静态二进制，无需按 Ubuntu、Debian、Alpine 等发行版选择不同安装包。ARMv5 和 MIPS 使用软件浮点，MIPS 大小端分别提供；安装脚本按用户空间位数和字节序选择对应版本。ARMv6/v7 需要相应浮点支持。RISC-V 使用 RVA20U64 基线，未提供 RISC-V 32 位和 macOS 32 位包。

Windows 要求 Windows 10 / Server 2016 或更新版本；macOS 要求 macOS 13 或更新版本。Linux 还须满足所用 Go 版本的内核和 CPU 要求，静态链接不代表支持任意老内核。参考：[Go 支持平台](https://go.dev/doc/install/source#environment)、[Go 最低系统要求](https://go.dev/wiki/MinimumRequirements)。

### 安装

在面板 **管理 → 添加设备** 中同时提供 Windows 安装包下载和 Linux/macOS 安装命令，地址均使用当前面板域名。脚本入口为 `https://你的面板域名/install.sh`，弹窗自动附带本次邀请和网络代码：

```sh
curl -fsS --connect-timeout 10 --max-time 120 'https://monitor.example.com/install.sh' | sh -s -- --server '面板提供的完整邀请地址' --join 网络代码
```

- **Windows**：登录面板后下载对应架构的 `spider-watch-windows-架构-setup.exe`，运行安装向导。默认安装到 `C:\Program Files\SpiderWatch`，注册开机服务和更新任务，添加命令到 PATH。安装后新开管理员终端执行加入指令。
- **Linux / macOS**：复制弹窗中的 `curl` 命令，下载脚本后自动安装并使用本次邀请加入。非 root 用户会通过 sudo 安装。同一个脚本识别系统和架构，并适配 systemd、OpenRC、procd 或 launchd。程序位于 `/opt/spider-watch/spider-watch`，命令链接位于 `/usr/local/bin/spider-watch`。需要 curl、CA 证书和 SHA-256 校验工具。
- **手动运行**：直接下载对应的单个二进制。Unix 安装脚本可加 `--no-service --prefix "$HOME/.local/bin"`；也可用 `--arch` 指定清单中的架构。没有支持的服务管理器时，脚本会说明原因，不假装完成开机启动。

### 加入网络与更新

Windows 安装完成或客户端已安装时，在面板 **管理 → 添加设备 → 安装后加入** 中复制注册指令。Linux/macOS 在指令前加 `sudo`；Windows 在新的管理员终端粘贴执行。使用弹窗自动安装命令的 Linux/macOS 设备无需再执行一次：

```sh
spider-watch configure --server "面板提供的完整邀请地址" --join 网络代码
```

邀请最多有效 5 分钟，仅首台成功注册的设备可使用。客户端自动生成专用 Ed25519 密钥和随机设备 ID，注册后直接加入；已安装的服务自动开始运行。不要分享注册指令或本地配置文件。旧版已有身份可通过 `--config` 指定原配置文件继续使用；安装到新目录不会自动读取任意旧私钥。

设备配置中可设置名称、分组、图标和自动更新。自动更新由系统每 6 小时检查一次；手动可执行 `spider-watch --update`，Unix 使用 sudo，Windows 使用管理员终端。检查但不安装：`spider-watch update --check`。OpenRC/procd 的自动更新需要正在运行的 cron 服务。

安装脚本公开可读，首次安装的文件下载需有效且未使用的邀请，成功加入后邀请立即关闭。Windows 面板下载需有效登录；后续更新仅允许已注册设备使用签名请求。所有安装和更新文件来自本次部署的 Worker 静态资源，客户端校验版本、大小和 SHA-256 后替换。文件流不经过 DO 存储，也不在下载时请求 GitHub；鉴权请求仍会消耗 Worker 和相应的 DO 调用。没有额外常驻更新进程。

Windows 可在 **设置 → 应用 → SpiderWatch → 卸载** 移除程序、服务和更新任务。卸载保留 `%ProgramData%\spider-watch\state` 中的设备身份，以便重装复用；永久撤销设备请同时在面板删除。Unix 身份位于 `/var/lib/spider-watch/state`。

## 面板设置

- **总览**：设备状态、总 CPU 使用率、物理内存、卷容量汇总及网卡上下行总速率。点击设备进入处理器、内存、网络、磁盘四块详情；每张网卡显示独立的上下行曲线，点击物理磁盘展开所属逻辑卷。
- **管理**：添加或删除设备，配置昵称、图标、分组和更新方式。
- **设置**：面板开启时默认每 5 秒采集上报，可设为 2–300 秒；关闭时可选 2、5、10 分钟，默认 10 分钟，且不能短于开启间隔。保存后持续生效。额度显示本项目 Durable Objects 请求、SQLite 读写和运行用量的估算，未接入 Cloudflare 账户账单 API，每 5 分钟自动刷新。

客户端启动时检查可用内存，低于 16 MiB 拒绝运行；Go 内存软目标 20 MiB、RSS 预算 32 MiB、发布二进制上限 16 MiB。Windows 工作集上限和 Linux systemd 设有系统限制；macOS、OpenRC/procd 依靠定期 RSS 检查，不能承诺瞬时硬上限。程序及更新临时文件以 64 MiB 磁盘预算设计。

磁盘采集以当前权限可读的本地卷为单位，不扫描文件夹大小或读取裸盘内容。无法识别物理归属的卷单独显示，重复挂载合并，APFS 共享存储池只汇总一次。旧版客户端需更新后才能提供物理归属和 APFS 容器用量。单次最多采集 32 个卷和 16 个非回环网卡。系统未提供的细项显示不可用；物理内存、缓存、已提交虚拟内存存在重叠，不能直接相加。

实时曲线保留浏览器收到的最近 120 个采样点。长期历史保存在 Durable Object 的 SQLite 中，按“面板关闭”间隔记录并保留 7 天，查看面板时也保持此保存间隔。较长时间范围合并为最多 1008 个图形点，原始记录保持不变。历史采用批量存储和无损压缩；数据保存、读取、到期删除及定时唤醒仍会消耗 Cloudflare 额度。

macOS 的物理归属及 APFS 容器容量最多缓存 5 分钟，每卷数据仍随正常采样更新。

参考：[GitHub OAuth 应用](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)、[GitHub 登录流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[GitHub Actions 部署 Worker](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[部署时上传 Secret](https://developers.cloudflare.com/workers/configuration/secrets/)。
