import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { panelAuthFailure } from "../src/panel-auth";
import { githubSettings, origin, sessionHeaders, sessionName, sessionToken } from "./github-fixture";

afterEach(() => vi.restoreAllMocks());
function noStorage() { return vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("Must not access a DO"); }); }

it("keeps unconfigured deployments closed and explains the required GitHub configuration", async () => {
  const storage = noStorage(), configured = { ...env, LOCAL_DEV: "false" }, assets = vi.spyOn(env.ASSETS, "fetch");
  const api = await worker.fetch(new Request(origin + "/panel/api/session", { headers: { Accept: "text/html" } }), configured);
  expect(api.status).toBe(503); expect(await api.json()).toEqual({ code: "auth_not_configured" });
  for (const method of ["GET", "HEAD"]) {
    const page = await worker.fetch(new Request(origin + "/panel/", { method, headers: { Accept: "text/html" } }), configured);
    expect(page.status).toBe(503); expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const text = await page.text();
    if (method === "HEAD") expect(text).toBe("");
    else for (const value of ["登录尚未配置", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "ADMIN_GITHUB_IDS", "SESSION_SECRET"]) expect(text).toContain(value);
  }
  expect(storage).not.toHaveBeenCalled(); expect(assets).not.toHaveBeenCalled();
});

it("offers a GitHub login page without exposing protected resources or fetching GitHub", async () => {
  const storage = noStorage(), fetch = vi.spyOn(globalThis, "fetch"), assets = vi.spyOn(env.ASSETS, "fetch");
  for (const path of ["/panel/api/session", "/panel/api/state", "/panel/api/live", "/panel/style.css", "/panel/"]) {
    const response = await worker.fetch(new Request(origin + path, { headers: { "X-Monitor-Role": "admin", "Cf-Access-Authenticated-User-Email": "owner@example.test" } }), githubSettings());
    expect(response.status).toBe(401);
  }
  const page = await worker.fetch(new Request(origin + "/panel/", { headers: { Accept: "text/html" } }), githubSettings());
  expect(await page.text()).toContain("使用 GitHub 登录");
  expect(storage).not.toHaveBeenCalled(); expect(assets).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it("returns verified identity and expiry without a database call, token or GitHub secret", async () => {
  const config = githubSettings(), headers = await sessionHeaders(config), storage = noStorage(), fetch = vi.spyOn(globalThis, "fetch");
  const response = await worker.fetch(new Request(origin + "/panel/api/session", { headers }), config);
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body).toEqual({ authenticated: true, user_id: "12345", login: "owner", expires_at: expect.any(Number), mode: "github" });
  expect(JSON.stringify(body)).not.toContain(headers.Cookie); expect(JSON.stringify(body)).not.toContain(config.GITHUB_CLIENT_SECRET);
  expect(storage).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it("rejects expired sessions and non-admin accounts and preserves protected HTML cache policy", async () => {
  const config = githubSettings(), storage = noStorage();
  for (const [changes, status] of [[{ exp: 1 }, 401], [{ sub: "999" }, 403]] as const) {
    const response = await worker.fetch(new Request(origin + "/panel/api/session", { headers: { Cookie: sessionName + "=" + await sessionToken(config, changes) } }), config);
    expect(response.status).toBe(status);
  }
  vi.spyOn(env.ASSETS, "fetch").mockResolvedValue(new Response("<h1>SpiderWatch</h1>", { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } }));
  const headers = await sessionHeaders(config), page = await worker.fetch(new Request(origin + "/panel/", { headers }), config);
  expect(page.headers.get("Cache-Control")).toBe("private, no-store"); await page.text();
  for (const path of ["/panel/api/session", "/panel/auth/login"]) expect((await worker.fetch(new Request(origin + path, { method: "POST", headers }), config)).status).toBe(405);
  expect(storage).not.toHaveBeenCalled();
});

it("labels loopback sessions explicitly and rejects public local mode", async () => {
  const storage = noStorage();
  const response = await worker.fetch(new Request("http://127.0.0.1/panel/api/session"), env);
  expect(await response.json()).toMatchObject({ authenticated: true, login: null, mode: "local" });
  expect((await worker.fetch(new Request(origin + "/panel/api/session"), env)).status).toBe(403);
  expect(storage).not.toHaveBeenCalled();
});

it.each([
  ["token", "503", "<small>授权交换 · GitHub HTTP 503</small>"],
  ["profile", "403", "<small>账户读取 · GitHub HTTP 403</small>"],
  ["session", "", "<small>建立会话</small>"],
  ["token", '<script>alert("status-secret")</script>', "<small>授权交换</small>"],
  ['<script>alert("stage-secret")</script>', "503", ""],
] as const)("renders only fixed diagnostic labels for step %s", async (step, upstream, expected) => {
  const request = new Request(origin + "/panel/auth/github/callback", { headers: { Accept: "text/html" } });
  const response = panelAuthFailure(request, new Response("response-body-secret", { status: 502, headers: {
    "X-SpiderWatch-Auth-Error": "github_http_error", "X-SpiderWatch-Auth-Step": step,
    "X-SpiderWatch-GitHub-Status": upstream,
  } }));
  const html = await response.text();
  expect(html).toContain("<h1>GitHub 请求失败</h1>");
  if (expected) expect(html).toContain(expected);
  else expect(html).not.toContain("GitHub HTTP");
  for (const value of ["response-body-secret", "status-secret", "stage-secret", "<script>"]) expect(html).not.toContain(value);
  if (upstream.includes("script")) expect(html).not.toContain("GitHub HTTP");
});
