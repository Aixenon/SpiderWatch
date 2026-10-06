import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { githubSettings, sessionHeaders } from "./github-fixture";
import worker from "../src/index";

const localOrigin = "http://127.0.0.1";
const publicOrigin = "https://monitor.example.test";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function authorized() {
  const configured = githubSettings();
  return { configured, headers: await sessionHeaders(configured) };
}

function noStorage() {
  return vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("Must not reach a DO"); });
}

it("redirects only the two public entry points to a fixed panel URL", async () => {
  const storage = noStorage(), assets = vi.spyOn(env.ASSETS, "fetch");
  const production = { ...env, LOCAL_DEV: "false" };
  for (const path of ["/", "/panel", "/?next=https://evil.example", "/panel?redirect=//evil.example"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(new Request(publicOrigin + path, { method }), production);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/panel/");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
    expect((await worker.fetch(new Request(publicOrigin + path, { method: "POST" }), production)).status).toBe(405);
  }
  expect(storage).not.toHaveBeenCalled(); expect(assets).not.toHaveBeenCalled();
});

it("closes old root APIs and static URLs even for an authenticated administrator or local mode", async () => {
  const { configured, headers } = await authorized(), storage = noStorage(), assets = vi.spyOn(env.ASSETS, "fetch");
  for (const path of ["/api/session", "/api/state", "/api/live", "/auth/login", "/index.html", "/app.js", "/style.css", "/internal/update-state", "/agent-releases/setup.exe"]) {
    for (const [origin, bindings] of [[publicOrigin, configured], [localOrigin, env]] as const) {
      const response = await worker.fetch(new Request(origin + path, { headers }), bindings);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "not_found" });
    }
  }
  expect(storage).not.toHaveBeenCalled(); expect(assets).not.toHaveBeenCalled();
});

it("never interprets reserved namespaces nested under panel as device requests", async () => {
  const storage = noStorage(), assets = vi.spyOn(env.ASSETS, "fetch");
  for (const path of ["/panel/v1", "/panel/v1/live", "/panel/v1/enroll", "/panel/v1/update/check", "/panel/bootstrap/enroll", "/panel/bootstrap/status", "/panel/internal/update-state", "/panel/agent-releases/setup.exe", "/panel//v1/live", "/panel/%76%31/live", "/panel/%62ootstrap/status", "/panel/internal%2fupdate-state", "/panel/%5cv1/live"]) {
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(new Request(localOrigin + path, { method, headers: { Origin: localOrigin, "X-Monitor-Role": "agent" } }), env);
      expect(response.status).toBe(404);
    }
  }
  expect(storage).not.toHaveBeenCalled(); expect(assets).not.toHaveBeenCalled();
});

it("requires a verified panel identity for assets, administration and live sockets", async () => {
  const { configured } = await authorized(), storage = noStorage(), assets = vi.spyOn(env.ASSETS, "fetch");
  for (const path of ["/panel/", "/panel/index.html", "/panel/app.js", "/panel/api/session", "/panel/api/state", "/panel/api/live"]) {
    const response = await worker.fetch(new Request(publicOrigin + path, { headers: {
      "Cf-Access-Authenticated-User-Email": "owner@example.test", "X-Monitor-Role": "admin", "X-Monitor-Auth-Expires": String(Number.MAX_SAFE_INTEGER),
      ...(path.endsWith("/live") ? { Upgrade: "websocket", Origin: publicOrigin } : {}),
    } }), configured);
    expect(response.status).toBe(401);
  }
  expect(storage).not.toHaveBeenCalled(); expect(assets).not.toHaveBeenCalled();
});

it("serves authenticated panel assets from the physical asset root and keeps login inside panel", async () => {
  const { configured, headers } = await authorized(), storage = noStorage();
  const assets = vi.spyOn(env.ASSETS, "fetch").mockImplementation(async request => {
    expect(request).toBeInstanceOf(Request);
    expect(new URL((request as Request).url).pathname).toBe("/index.html");
    return new Response("<h1>SpiderWatch</h1>", { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } });
  });
  const page = await worker.fetch(new Request(publicOrigin + "/panel/index.html", { headers }), configured);
  expect(page.status).toBe(200); expect(page.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await page.text()).toContain("SpiderWatch");
  const session = await worker.fetch(new Request(publicOrigin + "/panel/api/session", { headers }), configured);
  expect(await session.json()).toMatchObject({ authenticated: true, login: "owner", mode: "github" });
  const login = await worker.fetch(new Request(publicOrigin + "/panel/auth/login?next=https://evil.example", { headers }), configured);
  expect(login.status).toBe(302); expect(login.headers.get("Location")).toBe("/panel/#/");
  expect(assets).toHaveBeenCalledTimes(1); expect(storage).not.toHaveBeenCalled();
});

it("rewrites same-origin asset redirects without following them", async () => {
  const storage = noStorage();
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Must not follow redirects"); });
  const assets = vi.spyOn(env.ASSETS, "fetch");
  for (const [location, expected] of [["/", "/panel/"], ["/docs/?a=1#start", "/panel/docs/?a=1#start"], ["../style.css", "/panel/style.css"], [localOrigin + "/index.html", "/panel/index.html"]]) {
    assets.mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: location } }));
    const response = await worker.fetch(new Request(localOrigin + "/panel/docs/index.html"), env);
    expect(response.status).toBe(301); expect(response.headers.get("Location")).toBe(expected);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  }
  expect(outbound).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
});

it("rejects external or invalid asset redirect destinations", async () => {
  const storage = noStorage();
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Must not follow redirects"); });
  const assets = vi.spyOn(env.ASSETS, "fetch");
  for (const location of ["https://evil.example/", "//evil.example/", "http://user:password@127.0.0.1/", "data:text/html,unsafe", "http://["]) {
    assets.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: location } }));
    const response = await worker.fetch(new Request(localOrigin + "/panel/index.html"), env);
    expect(response.status).toBe(502); expect(response.headers.has("Location")).toBe(false);
    expect(await response.json()).toEqual({ code: "invalid_asset_redirect" });
  }
  expect(outbound).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
});

it("preserves origin checks after routing panel mutations and WebSocket upgrades", async () => {
  const storage = noStorage();
  for (const [path, method, extra] of [["/panel/api/settings", "PUT", {}], ["/panel/api/live", "GET", { Upgrade: "websocket" }]] as const) {
    const response = await worker.fetch(new Request(localOrigin + path, { method, headers: { ...extra, Origin: "https://evil.example" } }), env);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ code: "origin_rejected" });
  }
  expect(storage).not.toHaveBeenCalled();
});

it("keeps invitation enrollment and signed device status at their unchanged root paths", async () => {
  const id = crypto.randomUUID().replaceAll("-", ""), encoder = new TextEncoder();
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const base64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const publicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(publicKey instanceof ArrayBuffer)) throw new Error("Expected raw public key");
  const wire = new Uint8Array(51), view = new DataView(wire.buffer);
  view.setUint32(0, 11); wire.set(encoder.encode("ssh-ed25519"), 4); view.setUint32(15, 32); wire.set(new Uint8Array(publicKey), 19);
  async function signed(origin: string, path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
    const encoded = body === undefined ? "" : JSON.stringify(body);
    const headers = new Headers({ "Content-Type": "application/json", "X-Monitor-Node-ID": id,
      "X-Monitor-Time": String(Date.now()), "X-Monitor-Nonce": crypto.randomUUID().replaceAll("-", ""), ...extra });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(encoded)));
    const payload = ["cf-monitor-auth-v1", method, origin, path, id, headers.get("X-Monitor-Time"), headers.get("X-Monitor-Nonce"), Array.from(digest, b => b.toString(16).padStart(2, "0")).join("")].join("\n");
    headers.set("X-Monitor-Signature", base64(await crypto.subtle.sign("Ed25519", pair.privateKey, encoder.encode(payload))));
    return new Request(origin + path, { method, headers, body: body === undefined ? undefined : encoded });
  }
  const invitationResponse = await worker.fetch(new Request(localOrigin + "/panel/api/invitations", { method: "POST", headers: { Origin: localOrigin } }), env);
  expect(invitationResponse.status).toBe(200);
  const invitation = await invitationResponse.json<{ server: string; network: string }>();
  const server = new URL(invitation.server), token = new URLSearchParams(server.hash.slice(1)).get("invite")!;
  expect(server.origin).toBe(localOrigin); expect(server.pathname).toBe("/");
  const missing = await worker.fetch(new Request(localOrigin + "/bootstrap/enroll", { method: "POST", body: "{}" }), env);
  expect(missing.status).toBe(403); expect(await missing.json()).toEqual({ code: "invitation_invalid_or_expired" });
  const enrolled = await worker.fetch(await signed(localOrigin, "/bootstrap/enroll", "POST", {
    protocol: 2, node_id: id, group: invitation.network, public_key: "ssh-ed25519 " + base64(wire),
    host: { hostname: "routing-test", os: "linux", arch: "amd64", cpus: 2, agent_version: "0.2.0" },
  }, { "X-Monitor-Invitation": token }), env);
  expect(enrolled.status).toBe(200); expect(await enrolled.json()).toMatchObject({ state: "approved" });
  const production = { ...env, LOCAL_DEV: "false", GITHUB_CLIENT_ID: "", ADMIN_GITHUB_IDS: "" };
  for (const [path, method] of [[`/v1/nodes/${id}/status`, "GET"], ["/bootstrap/status", "POST"]]) {
    const response = await worker.fetch(await signed(publicOrigin, path, method), production);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: "approved" });
  }
  const state = await worker.fetch(new Request(localOrigin + "/panel/api/state?view=live"), env);
  expect(state.status).toBe(200); expect(await state.json()).toMatchObject({ nodes: [{ node_id: id, state: "approved" }] });
});
