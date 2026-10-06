# SpiderWatch

Cloudflare Workers + SQLite Durable Objects 网络监控面板，配套单文件客户端 `spider-watch`。前端随 Worker 一起部署，无需单独部署 Pages、数据库或 R2。

## 部署到 Cloudflare

需要一个 Cloudflare 账户、托管在该账户中的域名，以及自己的 GitHub 仓库。将项目放入仓库后启用 GitHub Actions。

源码仓库可以私有保存；现有客户端安装与自动更新依赖可访问的公开 GitHub Releases。

### 1. 配置 Cloudflare Access

1. 在 Cloudflare Zero Trust 中设置团队名，记下 `https://你的团队.cloudflareaccess.com`。
2. 在 **Integrations → Identity providers** 添加 **Cloudflare**，开启 **Restrict to account members**。
3. 在 **Access → Applications** 创建自托管应用，域名使用准备给面板的子域名，例如 `monitor.example.com`。登录方式只选择 **Cloudflare**，Allow 策略只允许自己的管理员邮箱，保留标准登录页。复制该应用的 **Application Audience (AUD)**。
4. 为同一域名的以下路径创建更具体的 Access 应用，使用 **Bypass → Everyone**：`/v1/*`、`/bootstrap/enroll`、`/bootstrap/status`。这些路径由客户端签名或一次性邀请验证；其余页面和 `/api/*` 必须保持 Access 保护。

不要把整个面板域名设为 Bypass。无需添加人机验证。Access 团队域名、AUD 和管理员邮箱需由部署者提供，程序不会从未验证的请求自动认领管理员。

### 2. 设置 GitHub 部署参数

在仓库 **Settings → Secrets and variables → Actions** 中设置：

| 类型 | 名称 | 内容 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare 的 Edit Cloudflare Workers 模板 Token，限定目标账户和域名；需允许 Worker 部署及域名路由配置 |
| Secret | `INVITATION_SECRET` | 至少 32 字符的随机密钥，保持固定；用于签发短期注册邀请 |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | 目标 Cloudflare 账户 ID |
| Variable | `PANEL_DOMAIN` | 面板完整域名，不含 `https://` |
| Variable | `ACCESS_TEAM_DOMAIN` | 第 1 步的团队域名，支持带或不带 `https://` |
| Variable | `ACCESS_PANEL_AUD` | 面板 Access 应用的 AUD |
| Variable | `ADMIN_EMAILS` | 允许登录的邮箱，多个用逗号分隔，与 Access 策略一致 |
| Variable，可选 | `WORKER_NAME` | 默认 `spider-watch`；部署后不要随意改名，否则会创建另一套存储 |

可用本机 Node.js 生成邀请密钥：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。将结果直接保存到 GitHub Secret，不提交到仓库。

### 3. 一键部署

进入 **Actions → Deploy SpiderWatch to Cloudflare → Run workflow**。工作流一起发布前端、Worker、SQLite Durable Object 和自定义域名。完成后打开面板域名，使用 Cloudflare 标准页面登录，默认进入总览。

部署自动读取当前 `GITHUB_REPOSITORY`，把客户端更新源设为自己的仓库。Fork 后无需修改源码里的仓库地址。部署不会自动创建客户端 Release，先完成下一节的发布步骤。

后续更新面板代码后，再运行同一工作流。保持 Worker 名称和 `MONITOR_GROUP` 不变，设备身份和设置会保留。不要仅在 Cloudflare 控制台修改这些部署变量；下一次部署以 GitHub 设置为准。

也可以本地部署（Node.js 22 或更新版本）：

```sh
cd worker
npm ci
npx wrangler login
npm run setup
```

按提示填写域名、Access AUD 和邮箱。本地流程自动从 Git 的 `origin` 识别 GitHub 仓库，生成并保存邀请密钥到被 Git 忽略的 `worker/deployment.local.json`，之后重复运行即可。无 Git 元数据的源码包需设置环境变量 `UPDATE_GITHUB_REPOSITORY=拥有者/仓库`。预检查可用 `npm run setup -- --dry-run`，不会上传。

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

Cloudflare 参考：[标准 Access 应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)、[Cloudflare 登录方式](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/)、[部署时上传 Secret](https://developers.cloudflare.com/workers/configuration/secrets/)。
