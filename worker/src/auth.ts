import { SignJWT, jwtVerify, base64url, type JWTPayload } from "jose";
import { timingSafeEqual } from "node:crypto";
import { json } from "./model";

const SESSION_COOKIE = "__Host-spiderwatch-session", FLOW_COOKIE = "__Host-spiderwatch-oauth";
const SESSION_SECONDS = 8 * 3600, FLOW_SECONDS = 300;
const encoder = new TextEncoder(), idPattern = /^[1-9][0-9]{0,15}$/;
type Settings = { clientId: string; clientSecret: string; key: Uint8Array; admins: Set<string> };
export type Identity = { expires: number; subject: string; login?: string };

export function localMode(request: Request, env: Env): boolean {
  return env.LOCAL_DEV === "true" && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(request.url).hostname);
}

function settings(env: Env): Settings | undefined {
  const clientId = env.GITHUB_CLIENT_ID?.trim() || "", clientSecret = env.GITHUB_CLIENT_SECRET?.trim() || "";
  const secret = env.SESSION_SECRET || "", admins = (env.ADMIN_GITHUB_IDS || "").split(",").map(id => id.trim());
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(clientId) || !/^[\x21-\x7e]{20,256}$/.test(clientSecret)
    || !/^[a-f0-9]{64}$/i.test(secret) || !admins.length || admins.length > 50 || admins.some(id => !idPattern.test(id))) return;
  return { clientId, clientSecret, key: encoder.encode(secret), admins: new Set(admins) };
}

function cookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie") || "";
  if (header.length > 16384) return;
  const values = header.split(";").map(part => part.trim()).filter(part => part.startsWith(name + "="));
  if (values.length !== 1) return;
  const value = values[0].slice(name.length + 1);
  return value.length <= 2048 ? value : undefined;
}

function setCookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}

function responseHeaders(): Headers {
  return new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = responseHeaders(); headers.set("Location", location);
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

function authError(code: string, status: number, clearSession = false): Response {
  const response = json({ code }, status);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.append("Set-Cookie", setCookie(FLOW_COOKIE, "", 0));
  if (clearSession) response.headers.append("Set-Cookie", setCookie(SESSION_COOKIE, "", 0));
  return response;
}

function audience(origin: string, config: Settings): string { return `${origin}|${config.clientId}`; }

async function sign(config: Settings, origin: string, type: string, subject: string, values: JWTPayload, seconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(values).setProtectedHeader({ alg: "HS256", typ: type }).setIssuer("spiderwatch")
    .setAudience(audience(origin, config)).setSubject(subject).setIssuedAt(now).setExpirationTime(now + seconds).sign(config.key);
}

async function verify(token: string, config: Settings, origin: string, type: string, seconds: number): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, config.key, { algorithms: ["HS256"], typ: type, issuer: "spiderwatch",
    audience: audience(origin, config), maxTokenAge: seconds, requiredClaims: ["exp", "iat", "sub"] });
  if (!payload.exp || !payload.iat || payload.exp > payload.iat + seconds || payload.iat > Math.floor(Date.now() / 1000)) throw new Error("Invalid lifetime");
  return payload;
}

export async function authorize(request: Request, env: Env, role: "agent" | "admin"): Promise<Identity | Response> {
  if (env.LOCAL_DEV === "true") return localMode(request, env)
    ? { expires: Date.now() + 86400_000, subject: "local-development" }
    : json({ code: "local_mode_requires_loopback" }, 403);
  // Device credentials are verified separately; panel cookies never authorize a device.
  if (role === "agent") return json({ code: "device_auth_required" }, 401);
  if (new URL(request.url).protocol !== "https:") return json({ code: "https_required" }, 400);
  const config = settings(env);
  if (!config) return json({ code: "auth_not_configured" }, 503);
  const token = cookie(request, SESSION_COOKIE);
  if (!token) return json({ code: "login_required" }, 401);
  try {
    const payload = await verify(token, config, new URL(request.url).origin, "spiderwatch-session", SESSION_SECONDS);
    if (!payload.sub || !idPattern.test(payload.sub) || typeof payload.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(payload.login)) throw new Error("Invalid identity");
    if (!config.admins.has(payload.sub)) return json({ code: "admin_required" }, 403);
    return { expires: payload.exp! * 1000, subject: payload.sub, login: payload.login };
  } catch { return json({ code: "invalid_session" }, 401); }
}

async function githubJSON(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body || Number(response.headers.get("Content-Length")) > 32768) {
    await response.body?.cancel(); throw new Error("GitHub unavailable");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 32768) throw new Error("GitHub response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const buffer = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  const data: unknown = JSON.parse(new TextDecoder().decode(buffer));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid GitHub response");
  return data as Record<string, unknown>;
}

// Receives the internal path after /panel has been removed by the router.
export async function handleLogin(request: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname;
  if (!["/auth/login", "/auth/github/callback", "/auth/logout"].includes(path)) return;
  if (path === "/auth/logout") {
    if (request.method !== "POST") return json({ code: "method_not_allowed" }, 405);
    if (request.headers.get("Origin") !== url.origin) return json({ code: "origin_rejected" }, 403);
    const headers = responseHeaders();
    headers.append("Set-Cookie", setCookie(SESSION_COOKIE, "", 0)); headers.append("Set-Cookie", setCookie(FLOW_COOKIE, "", 0));
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET" || request.headers.has("Upgrade")) return json({ code: "method_not_allowed" }, 405);
  if (localMode(request, env)) return redirect("/panel/#/");
  if (url.protocol !== "https:") return json({ code: "https_required" }, 400);
  const config = settings(env);
  if (!config) return authError("auth_not_configured", 503);
  const callback = url.origin + "/panel/auth/github/callback";
  if (path === "/auth/login") {
    if (!(await authorize(request, env, "admin") instanceof Response)) return redirect("/panel/#/");
    if (!env.LOGIN_LIMITER || !(await env.LOGIN_LIMITER.limit({ key: "start:" + (request.headers.get("CF-Connecting-IP") || "unknown") })).success) return authError("login_rate_limited", 429);
    const state = base64url.encode(crypto.getRandomValues(new Uint8Array(32))), verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
    const flow = await sign(config, url.origin, "spiderwatch-oauth", "oauth", { state, verifier }, FLOW_SECONDS);
    const destination = new URL("https://github.com/login/oauth/authorize");
    destination.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: callback, state,
      scope: "", code_challenge: base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)))), code_challenge_method: "S256", allow_signup: "false", prompt: "select_account" }).toString();
    return redirect(destination.href, [setCookie(FLOW_COOKIE, flow, FLOW_SECONDS)]);
  }
  const code = url.searchParams.get("code") || "", state = url.searchParams.get("state") || "", token = cookie(request, FLOW_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{1,256}$/.test(code)
    || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length !== 1) return authError("oauth_state_invalid", 400);
  let flow: JWTPayload;
  try {
    flow = await verify(token, config, url.origin, "spiderwatch-oauth", FLOW_SECONDS);
    if (flow.sub !== "oauth" || typeof flow.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(flow.state)
      || typeof flow.verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(flow.verifier)
      || !timingSafeEqual(encoder.encode(state), encoder.encode(flow.state))) throw new Error("State mismatch");
  } catch { return authError("oauth_state_invalid", 400); }
  if (!env.LOGIN_LIMITER || !(await env.LOGIN_LIMITER.limit({ key: "callback:" + (request.headers.get("CF-Connecting-IP") || "unknown") })).success) return authError("login_rate_limited", 429);
  try {
    const result = await githubJSON("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "SpiderWatch" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callback, code_verifier: String(flow.verifier) }).toString() });
    if (result.error || typeof result.access_token !== "string" || !/^[A-Za-z0-9_]{1,512}$/.test(result.access_token) || result.token_type !== "bearer") throw new Error("OAuth exchange failed");
    const user = await githubJSON("https://api.github.com/user", { headers: { Authorization: "Bearer " + result.access_token, Accept: "application/vnd.github+json", "User-Agent": "SpiderWatch", "X-GitHub-Api-Version": "2022-11-28" } });
    if (!Number.isSafeInteger(user.id) || !idPattern.test(String(user.id)) || typeof user.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(user.login) || user.type !== "User") throw new Error("Invalid GitHub identity");
    if (!config.admins.has(String(user.id))) return authError("admin_required", 403, true);
    const session = await sign(config, url.origin, "spiderwatch-session", String(user.id), { login: user.login }, SESSION_SECONDS);
    return redirect("/panel/#/", [setCookie(FLOW_COOKIE, "", 0), setCookie(SESSION_COOKIE, session, SESSION_SECONDS)]);
  } catch { return authError("github_unavailable", 502); }
}
