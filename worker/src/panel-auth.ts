// Keep the login page independent of protected assets and application data.
export function panelAuthFailure(request: Request, response: Response): Response {
  if (!["GET", "HEAD"].includes(request.method) ||
      !(request.headers.get("Accept")?.includes("text/html") || request.headers.get("Sec-Fetch-Dest") === "document")) return response;
  const status = response.status;
  const [title, description, link] = status === 503
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
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · SpiderWatch</title><style>:root{font-family:system-ui,sans-serif;color-scheme:light dark;color:#22324f;background:#f4f6fb}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(360px,calc(100vw - 80px));padding:32px;border:1px solid #d5deed;border-radius:16px;background:#fff}header{font-weight:650}header small{letter-spacing:2px;font-size:9px}h1{font-size:24px;margin:28px 0 12px}p{font-size:14px;line-height:1.8;color:#5b6b85}a{display:block;text-align:center;margin-top:24px;padding:13px;border-radius:8px;background:#1e40af;color:#fff;text-decoration:none}small{display:block;color:#5b6b85;line-height:1.6;margin-top:8px}a:focus-visible{outline:3px solid #8aaeff;outline-offset:3px}@media(prefers-color-scheme:dark){:root{background:#0f172a;color:#e9effa}main{background:#172238;border-color:#2c3c58}p,small{color:#a1afc6}a{background:#264ca8}}</style><main><header>SpiderWatch<small>NETWORK MONITOR</small></header><h1>${title}</h1><p>${description}</p>${link}</main></html>`;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/html; charset=utf-8"); headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff"); headers.set("Referrer-Policy", "no-referrer");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  return new Response(request.method === "HEAD" ? null : html, { status, headers });
}
