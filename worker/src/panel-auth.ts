// Access serves the standard login page at the edge. This page is only a
// fail-closed diagnostic when deployment configuration is missing or incorrect.
export function panelAuthFailure(request: Request, response: Response): Response {
  if (!["GET", "HEAD"].includes(request.method) ||
      !(request.headers.get("Accept")?.includes("text/html") || request.headers.get("Sec-Fetch-Dest") === "document")) return response;
  const status = response.status;
  const [title, description, link] = status === 503
    ? ["登录尚未配置", "在 Cloudflare 控制台打开此 Worker 的设置 → 变量和机密，添加以下三个值：<br><code>ACCESS_TEAM_DOMAIN</code>：Access 团队域名<br><code>ACCESS_PANEL_AUD</code>：面板 Access 应用的 AUD<br><code>ADMIN_EMAILS</code>：管理员邮箱，多个邮箱用逗号分隔。<br>保存并部署后刷新页面。", ""]
    : status === 403
      ? ["没有访问权限", "当前 Cloudflare 账户没有此面板的管理权限。", '<a href="/cdn-cgi/access/logout">切换 Cloudflare 账户</a>']
      : ["未通过登录验证", "请检查此域名的 Cloudflare Access 保护配置。正常访问会先进入 Cloudflare 标准登录页面。", '<a href="/panel/auth/login">重新登录</a>'];
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · SpiderWatch</title><style>:root{font-family:system-ui,sans-serif;color-scheme:light dark;color:#22324f;background:#f4f6fb}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(360px,calc(100vw - 80px));padding:32px;border:1px solid #d5deed;border-radius:16px;background:#fff}header{font-weight:650}header small{letter-spacing:2px;font-size:9px}h1{font-size:24px;margin:28px 0 12px}p{font-size:14px;line-height:1.8;color:#5b6b85}a{display:block;text-align:center;margin-top:24px;padding:13px;border-radius:8px;background:#1e40af;color:#fff;text-decoration:none}small{display:block;color:#5b6b85;line-height:1.6;margin-top:8px}a:focus-visible{outline:3px solid #8aaeff;outline-offset:3px}@media(prefers-color-scheme:dark){:root{background:#0f172a;color:#e9effa}main{background:#172238;border-color:#2c3c58}p,small{color:#a1afc6}a{background:#264ca8}}</style><main><header>SpiderWatch<small>NETWORK MONITOR</small></header><h1>${title}</h1><p>${description}</p>${link}</main></html>`;
  return new Response(request.method === "HEAD" ? null : html, { status, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  } });
}
