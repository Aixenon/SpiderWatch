import { GITHUB_MARK_PATH } from "./github-mark";

// These messages are fixed strings; never render text returned by GitHub.
const loginErrors: Record<string, [string, string]> = {
  github_client_credentials_invalid: ["GitHub 应用配置不正确", "GitHub 拒绝了应用凭据。请在 Worker 的变量和机密中检查 GITHUB_CLIENT_ID 与 GITHUB_CLIENT_SECRET 是否来自同一个 OAuth App，并使用该应用的有效 Client Secret。"],
  github_callback_mismatch: ["GitHub 回调地址不匹配", "请将 OAuth App 的 Authorization callback URL 设置为当前面板域名加 /panel/auth/github/callback，然后重新登录。"],
  oauth_code_invalid: ["登录授权已失效", "授权码已过期、已使用或无法验证。请点击重新登录，不要刷新此回调页面。"],
  github_email_unverified: ["GitHub 邮箱尚未验证", "请先在 GitHub 验证账户邮箱，然后重新登录。"],
  github_app_unavailable: ["GitHub 应用不可用", "此 OAuth App 已被停用，请在 GitHub 检查应用状态。"],
  github_connection_failed: ["连接 GitHub 失败", "服务器暂时无法连接 GitHub 或读取其响应，请稍后重新登录。"],
  github_http_error: ["GitHub 请求失败", "GitHub 返回了错误响应，请稍后重新登录。"],
  github_redirect_rejected: ["GitHub 验证地址异常", "GitHub 验证接口返回了意外跳转，本次登录已停止，请稍后重新登录。"],
  github_rate_limited: ["GitHub 请求过于频繁", "GitHub 暂时限制了验证请求，请稍后重新登录。"],
  github_token_exchange_failed: ["GitHub 授权验证失败", "GitHub 未能完成授权码验证。请检查 OAuth App 的配置，然后重新登录。"],
  github_token_rejected: ["GitHub 授权已失效", "GitHub 拒绝了本次授权，请重新登录。"],
  github_profile_failed: ["无法读取 GitHub 账户", "授权后读取账户信息失败，请稍后重新登录。"],
  github_profile_invalid: ["GitHub 账户信息无效", "GitHub 未返回有效的个人账户信息，请使用个人账户重新登录。"],
  github_response_invalid: ["GitHub 响应无效", "GitHub 返回了无法识别的验证响应，请稍后重新登录。"],
  github_session_failed: ["无法建立登录会话", "请检查 Worker 的 SESSION_SECRET 配置，并查看运行日志中的错误代码。"],
};

// Keep the login page independent of protected assets and application data.
export function panelAuthFailure(request: Request, response: Response): Response {
  if (!["GET", "HEAD"].includes(request.method) ||
      !(request.headers.get("Accept")?.includes("text/html") || request.headers.get("Sec-Fetch-Dest") === "document")) return response;
  const status = response.status;
  const code = response.headers.get("X-SpiderWatch-Auth-Error") || "";
  const detail = Object.hasOwn(loginErrors, code) ? loginErrors[code] : undefined;
  const normalLogin = status === 401 && !detail;
  const [title, message, link] = detail
    ? [...detail, '<a href="/panel/auth/login">重新登录</a>']
    : status === 503
    ? ["登录尚未配置", "在 Cloudflare 控制台打开此 Worker 的设置 → 变量和机密，添加：<br><code>GITHUB_CLIENT_ID</code>：OAuth 应用 ID<br><code>GITHUB_CLIENT_SECRET</code>：OAuth 应用密钥<br><code>ADMIN_GITHUB_IDS</code>：管理员数字 ID，多个用逗号分隔。<br>部署脚本自动生成 <code>SESSION_SECRET</code>。保存配置后刷新页面。", ""]
    : status === 403
      ? ["没有访问权限", "当前 GitHub 账户不在管理员名单中。", '<a href="/panel/auth/login">切换 GitHub 账户</a>']
      : status === 429
        ? ["请求过于频繁", "请稍后再试。", '<a href="/panel/auth/login">重新登录</a>']
        : status === 502
          ? ["暂时无法登录", "暂时无法完成 GitHub 验证，请稍后重试。", '<a href="/panel/auth/login">重新登录</a>']
          : status === 400
            ? ["登录未完成", "登录请求已过期或无效，请重新登录。", '<a href="/panel/auth/login">重新登录</a>']
            : ["登录 SpiderWatch", "使用 GitHub 账户登录后查看和管理设备。", '<a href="/panel/auth/login">使用 GitHub 登录</a>'];
  const step = response.headers.get("X-SpiderWatch-Auth-Step"), upstream = response.headers.get("X-SpiderWatch-GitHub-Status") || "";
  const stage = step === "token" ? "授权交换" : step === "profile" ? "账户读取" : step === "session" ? "建立会话" : "";
  const description = message + (detail && stage ? `<small>${stage}${/^[1-5][0-9]{2}$/.test(upstream) ? ` · GitHub HTTP ${upstream}` : ""}</small>` : "");
  const content = normalLogin
    ? `<main class="login-entry"><a class="github-login" href="/panel/auth/login"><svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><path d="${GITHUB_MARK_PATH}"/></svg><span>使用 GitHub 登录</span></a></main>`
    : `<main><header>SpiderWatch<small>NETWORK MONITOR</small></header><h1>${title}</h1><p>${description}</p>${link}</main>`;
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${normalLogin ? "SpiderWatch" : `${title} · SpiderWatch`}</title><style>:root{font-family:system-ui,sans-serif;color-scheme:light dark;color:#22324f;background:#f4f6fb}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(360px,calc(100vw - 80px));padding:32px;border:1px solid #d5deed;border-radius:16px;background:#fff}header{font-weight:650}header small{letter-spacing:2px;font-size:9px}h1{font-size:24px;margin:28px 0 12px}p{font-size:14px;line-height:1.8;color:#5b6b85}a{display:block;text-align:center;margin-top:24px;padding:13px;border-radius:8px;background:#1e40af;color:#fff;text-decoration:none}small{display:block;color:#5b6b85;line-height:1.6;margin-top:8px}a:focus-visible{outline:3px solid #8aaeff;outline-offset:3px}.login-entry{display:grid;place-items:center;width:auto;padding:24px;border:0;border-radius:0;background:transparent}.login-entry .github-login{display:inline-flex;align-items:center;justify-content:center;gap:10px;box-sizing:border-box;min-width:240px;height:44px;margin:0;padding:0 20px;border:1px solid #1b1f2426;border-radius:8px;background:#24292f;color:#fff;font-size:14px;font-weight:600;line-height:20px}.github-login svg{flex:none}.login-entry .github-login:hover{background:#343b43}@media(prefers-color-scheme:dark){:root{background:#0f172a;color:#e9effa}main{background:#172238;border-color:#2c3c58}p,small{color:#a1afc6}a{background:#264ca8}.login-entry{background:transparent}.login-entry .github-login{background:#f0f3f6;color:#24292f;border-color:#ffffff26}.login-entry .github-login:hover{background:#dce3eb}}</style>${content}</html>`;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/html; charset=utf-8"); headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff"); headers.set("Referrer-Policy", "no-referrer");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  return new Response(request.method === "HEAD" ? null : html, { status, headers });
}
