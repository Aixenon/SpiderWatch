import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../src/index";

afterEach(() => vi.restoreAllMocks());
let sequence = 0;
async function fixture() {
  const domain = `https://panel-session-${++sequence}.cloudflareaccess.com`;
  const pair = await generateKeyPair("RS256", { extractable: true });
  const key = await exportJWK(pair.publicKey); key.kid = "session"; key.alg = "RS256";
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    expect(String(input)).toBe(domain + "/cdn-cgi/access/certs");
    return Response.json({ keys: [key] });
  });
  const configured = { ...env, LOCAL_DEV: "false", ACCESS_TEAM_DOMAIN: domain, ACCESS_PANEL_AUD: "panel-aud", ADMIN_EMAILS: "owner@example.test" };
  const token = (email = "owner@example.test", audience = "panel-aud", expires = Math.floor(Date.now() / 1000) + 3600) => new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "session" }).setIssuer(domain).setSubject("owner-id").setAudience(audience).setExpirationTime(expires).sign(pair.privateKey);
  return { configured, token };
}
function noStorage() {
  return vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("Session must not access a DO"); });
}

it("keeps an unconfigured deployment closed and gives browser navigation a setup message", async () => {
  const storage = noStorage(), configured = { ...env, LOCAL_DEV: "false" };
  const assets = vi.spyOn(env.ASSETS, "fetch");
  for (const key of ["ACCESS_TEAM_DOMAIN", "ACCESS_PANEL_AUD", "ADMIN_EMAILS"]) Reflect.deleteProperty(configured, key);
  const api = await worker.fetch(new Request("https://monitor.example.test/api/session", { headers: { Accept: "text/html" } }), configured);
  expect(api.status).toBe(503); expect(await api.json()).toEqual({ code: "access_not_configured" });
  const page = await worker.fetch(new Request("https://monitor.example.test/", { headers: { Accept: "text/html" } }), configured);
  expect(page.status).toBe(503); expect(page.headers.get("Cache-Control")).toBe("no-store");
  expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  const body = await page.text();
  expect(body).toContain("登录尚未配置");
  expect(body).toContain("Cloudflare 控制台");
  for (const key of ["ACCESS_TEAM_DOMAIN", "ACCESS_PANEL_AUD", "ADMIN_EMAILS"]) expect(body).toContain(key);
  const head = await worker.fetch(new Request("https://monitor.example.test/", { method: "HEAD", headers: { Accept: "text/html" } }), configured);
  expect(head.status).toBe(503); expect(await head.text()).toBe("");
  expect(storage).not.toHaveBeenCalled(); expect(assets).not.toHaveBeenCalled();
});

it("protects the session, panel, assets and live upgrade against missing or forged identity headers", async () => {
  const { configured } = await fixture(), storage = noStorage();
  const assets = vi.spyOn(env.ASSETS, "fetch");
  for (const path of ["/api/session", "/api/state", "/api/live", "/style.css", "/"]) {
    const response = await worker.fetch(new Request("https://monitor.example.test" + path, { headers: { "Cf-Access-Authenticated-User-Email": "owner@example.test", "X-Monitor-Role": "admin", ...(path === "/api/live" ? { Upgrade: "websocket" } : {}) } }), configured);
    expect(response.status).toBe(401);
  }
  expect(storage).not.toHaveBeenCalled(); expect(assets).not.toHaveBeenCalled();
});

it("returns only a verified account and expiry without a database call or returning the credential", async () => {
  const { configured, token } = await fixture(), jwt = await token(), storage = noStorage();
  const response = await worker.fetch(new Request("https://monitor.example.test/api/session", { headers: { "cf-access-jwt-assertion": jwt } }), configured);
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json<{ authenticated: boolean; email: string; expires_at: number; mode: string }>();
  expect(body).toEqual({ authenticated: true, email: "owner@example.test", expires_at: expect.any(Number), mode: "access" });
  expect(body.expires_at).toBeGreaterThan(Date.now()); expect(JSON.stringify(body)).not.toContain(jwt);
  expect(storage).not.toHaveBeenCalled();
});

it("rejects other audiences, expired tokens and non-admin accounts", async () => {
  const { configured, token } = await fixture(), storage = noStorage();
  for (const [jwt, status] of [[await token("owner@example.test", "another-app"), 401], [await token("owner@example.test", "panel-aud", 1), 401], [await token("stranger@example.test"), 403]] as const) {
    const response = await worker.fetch(new Request("https://monitor.example.test/api/session", { headers: { "cf-access-jwt-assertion": jwt } }), configured);
    expect(response.status).toBe(status);
  }
  expect(storage).not.toHaveBeenCalled();
});

it("requires authentication and always lands on overview, ignoring supplied destinations", async () => {
  const { configured, token } = await fixture(), jwt = await token(), storage = noStorage();
  expect((await worker.fetch(new Request("https://monitor.example.test/auth/login"), configured)).status).toBe(401);
  for (const view of ["/settings", "/admin", "/server/" + "a".repeat(32), "//evil.example", "https://evil.example", "/\\evil.example", "/api/nodes", "/settings\r\nSet-Cookie:bad"]) {
    const request = new Request("https://monitor.example.test/auth/login?view=" + encodeURIComponent(view), { headers: { "cf-access-jwt-assertion": jwt } });
    const response = await worker.fetch(request, configured);
    expect(response.status).toBe(302); expect(response.headers.get("Location")).toBe("/#/"); expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect(storage).not.toHaveBeenCalled();
});

it("does not cache protected HTML and does not accept session mutations", async () => {
  const { configured, token } = await fixture(), headers = { "cf-access-jwt-assertion": await token() }, storage = noStorage();
  vi.spyOn(env.ASSETS, "fetch").mockResolvedValue(new Response("<h1>SpiderWatch</h1>", { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } }));
  const page = await worker.fetch(new Request("https://monitor.example.test/", { headers }), configured);
  expect(page.status).toBe(200); expect(page.headers.get("Cache-Control")).toBe("private, no-store");
  for (const path of ["/api/session", "/auth/login"]) expect((await worker.fetch(new Request("https://monitor.example.test" + path, { method: "POST", headers }), configured)).status).toBe(405);
  expect(storage).not.toHaveBeenCalled();
});

it("labels local sessions explicitly and never accepts local mode on a public host", async () => {
  const storage = noStorage();
  const local = await worker.fetch(new Request("http://127.0.0.1/api/session"), env);
  expect(await local.json()).toMatchObject({ authenticated: true, email: null, mode: "local" });
  expect((await worker.fetch(new Request("https://monitor.example.test/api/session"), env)).status).toBe(403);
  expect(storage).not.toHaveBeenCalled();
});
