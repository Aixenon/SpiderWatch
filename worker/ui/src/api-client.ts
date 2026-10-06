type SessionAccess = { valid: () => boolean; generation: () => number; lock: (code: string) => void };
let access: SessionAccess = { valid: () => false, generation: () => 0, lock: () => {} };
export function configureSessionAccess(value: SessionAccess) { access = value; }
export class APIError extends Error {
  constructor(message: string, public code = "request_failed", public retryAfterSeconds = 0) { super(message); }
}
const errors: Record<string, string> = {
  invalid_settings: "观看间隔需为 2–300 秒，无人观看间隔需为 30–86400 秒，且不小于观看间隔。",
  invalid_node_group: "分组名称需为 1–64 个字符。", invalid_nickname: "名字最多 128 个字符，不能包含控制字符。",
  invalid_icon: "请选择列表中的设备图标。", invalid_group_members: "请选择有效的设备分组。",
  group_name_exists: "已有同名分组。", too_many_groups: "最多支持 50 个分组。",
  node_group_not_found: "分组已删除，请刷新。", node_not_found: "设备已删除，请刷新。",
  invitation_not_configured: "邀请功能尚未配置，请检查部署设置。",
  update_platform_unavailable: "此设备暂没有可用的更新包。", update_repository_not_configured: "尚未配置客户端更新仓库。",
  release_not_found: "更新仓库暂无可用的公开稳定版。", release_manifest_missing: "更新版本缺少有效的发布清单。",
  invalid_github_release: "更新版本信息无效。", github_rate_limited: "GitHub 暂时限制了请求次数，请等待后重试。",
  github_timeout: "连接 GitHub 超时，请稍后重试。", github_unavailable: "GitHub 暂时不可用，请稍后重试。",
  unsafe_release_redirect: "更新下载地址无效，请检查发布来源。",
  release_changed: "已发布版本的内容发生变化，请发布新的版本号。", release_version_regressed: "可用版本低于已检查版本，已拒绝降级。",
  updates_disabled: "本网络尚未启用更新分发。", update_temporarily_unavailable: "更新服务暂时不可用，请稍后重试。",
  temporarily_unavailable: "服务暂时不可用，请稍后重试。", too_many_viewers: "实时观看人数已达上限，请稍后重试。",
};
export async function request<T = unknown>(path: string, method = "GET", body?: unknown, options: Pick<RequestInit, "keepalive" | "signal"> = {}): Promise<T> {
  const url = path.startsWith("/panel/api/") ? path : "/panel/api" + (path.startsWith("/") ? path : "/" + path);
  const isSession = url === "/panel/api/session";
  if (!isSession && !access.valid()) throw new APIError("请先登录。", "login_required");
  const generation = access.generation();
  const response = await fetch(url, {
    ...options,
    method, credentials: "same-origin", redirect: "manual", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (generation !== access.generation()) throw new APIError("会话已结束，请重新登录。", "session_expired");
  if (response.type === "opaqueredirect" || response.redirected || response.headers.get("Content-Type")?.includes("text/html")) {
    access.lock("login_required"); throw new APIError("请重新登录。", "login_required");
  }
  let result: T & { code?: string; retry_after_seconds?: number };
  try { result = await response.json(); }
  catch { throw new APIError("服务器返回了无效响应，请重试。"); }
  if (generation !== access.generation()) throw new APIError("会话已结束，请重新登录。", "session_expired");
  const code = result?.code || String(response.status);
  if (response.status === 401 || code === "admin_required" || code === "auth_not_configured") {
    access.lock(code); throw new APIError("请重新登录。", code);
  }
  if (!isSession && !access.valid()) throw new APIError("会话已结束，请重新登录。", "session_expired");
  if (!response.ok) throw new APIError(errors[code] || "操作失败：" + code, code, Number(result?.retry_after_seconds) || 0);
  return result;
}
