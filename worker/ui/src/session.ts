import { ref } from "vue";
import { configureSessionAccess, request } from "./api-client";

export type Session = { authenticated: true; user_id: string; login: string | null; expires_at: number; mode: "local" | "github" };
export const authenticated = ref(false);
export const session = ref<Session | null>(null);
export const sessionLoading = ref(true);
export const sessionError = ref("");
export const loginURL = "/panel/auth/login";
let generation = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let starting: Promise<void> | undefined;
const invalidated = new Set<() => void>();
const errors: Record<string, string> = {
  login_required: "使用 GitHub 账户登录后查看和管理设备。",
  session_expired: "会话已到期，请重新登录。",
  admin_required: "当前 GitHub 账户没有此面板的管理权限。",
  auth_not_configured: "请先配置 GitHub OAuth 应用和管理员 ID。",
  connection_failed: "暂时无法验证登录，请重试。",
};
export function sessionGeneration() { return generation; }
export function onSessionInvalidated(callback: () => void) {
  invalidated.add(callback);
  return () => invalidated.delete(callback);
}
export function lockSession(code = "login_required") {
  generation++;
  clearTimeout(expiryTimer);
  session.value = null; authenticated.value = false; sessionLoading.value = false;
  sessionError.value = errors[code] || errors.login_required;
  for (const callback of invalidated) callback();
}
export function hasSession() {
  if (!authenticated.value || !session.value) return false;
  if (session.value.expires_at <= Date.now()) { lockSession("session_expired"); return false; }
  return true;
}
function armExpiry() {
  clearTimeout(expiryTimer);
  if (!hasSession()) return;
  expiryTimer = setTimeout(() => { if (hasSession()) armExpiry(); }, Math.min(2147483647, Math.max(1, session.value!.expires_at - Date.now())));
}
configureSessionAccess({ valid: hasSession, generation: sessionGeneration, lock: lockSession });
export function startSession(): Promise<void> {
  if (starting) return starting;
  sessionLoading.value = true; sessionError.value = "";
  starting = (async () => {
    const version = generation;
    try {
      const identity = await request<Session>("/session");
      if (version !== generation) return;
      if (identity.authenticated !== true || !Number.isFinite(identity.expires_at) || identity.expires_at <= Date.now()) {
        lockSession("session_expired"); return;
      }
      session.value = identity; authenticated.value = true; sessionError.value = "";
      armExpiry();
    } catch {
      if (version === generation) lockSession("connection_failed");
    } finally { sessionLoading.value = false; }
  })().finally(() => { starting = undefined; });
  return starting;
}
export async function logout() {
  if (session.value?.mode !== "local" && hasSession()) {
    const response = await fetch("/panel/auth/logout", { method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store" });
    if (!response.ok) throw new Error("退出失败，请重试。");
  }
  lockSession();
}
