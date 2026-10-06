import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { base64url, decodeJwt } from "jose";
import worker from "../src/index";
import { githubSettings, origin, sessionName, flowName, sessionToken } from "./github-fixture";

afterEach(() => vi.restoreAllMocks());
function noStorage() { return vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("OAuth must not use a DO"); }); }
async function start(config = githubSettings()) {
  const response = await worker.fetch(new Request(origin + "/panel/auth/login?next=https://evil.example"), config);
  expect(response.status).toBe(302);
  const destination = new URL(response.headers.get("Location")!);
  const cookie = response.headers.getSetCookie()[0];
  return { destination, response, cookie: cookie.split(";")[0], rawCookie: cookie };
}
function callback(flow: Awaited<ReturnType<typeof start>>, query = "", headers: HeadersInit = {}, host = origin) {
  return new Request(host + "/panel/auth/github/callback?code=test-code&state=" + flow.destination.searchParams.get("state") + query,
    { headers: { Cookie: flow.cookie, ...headers } });
}
function mockGithub(user: Record<string, unknown> = { id: 12345, login: "owner", type: "User" }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (String(input) === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_fixture_secret", token_type: "bearer", scope: "" });
    expect(String(input)).toBe("https://api.github.com/user");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer gho_fixture_secret");
    return Response.json(user);
  });
}

it("uses a random state and S256 PKCE with a short secure host-only cookie and no permissions", async () => {
  const storage = noStorage(), fetch = vi.spyOn(globalThis, "fetch");
  const first = await start(), second = await start();
  const params = first.destination.searchParams, flow = decodeJwt(first.cookie.slice(flowName.length + 1));
  expect(first.destination.origin + first.destination.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(params.get("client_id")).toBe(githubSettings().GITHUB_CLIENT_ID);
  expect(params.get("redirect_uri")).toBe(origin + "/panel/auth/github/callback");
  expect(params.get("scope")).toBe(""); expect(params.get("code_challenge_method")).toBe("S256");
  expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(params.get("state")).not.toBe(second.destination.searchParams.get("state"));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(flow.verifier)));
  expect(params.get("code_challenge")).toBe(base64url.encode(new Uint8Array(digest)));
  expect(first.rawCookie).toContain("Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax"); expect(first.rawCookie).not.toContain("Domain=");
  expect(first.response.headers.get("Cache-Control")).toBe("no-store");
  expect(first.destination.href).not.toContain(githubSettings().GITHUB_CLIENT_SECRET);
  expect(first.destination.href).not.toContain(String(flow.verifier));
  expect(fetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
});

it("completes OAuth, checks the ID whitelist and uses a local session for subsequent requests", async () => {
  const storage = noStorage(), config = githubSettings(), flow = await start(config), remote = mockGithub();
  const response = await worker.fetch(callback(flow, "&next=https://evil.example"), config);
  expect(response.status).toBe(302); expect(response.headers.get("Location")).toBe("/panel/#/");
  const cookies = response.headers.getSetCookie(), session = cookies.find(value => value.startsWith(sessionName + "="))!;
  expect(session).toContain("Max-Age=28800; HttpOnly; Secure; SameSite=Lax");
  expect(cookies.some(value => value.startsWith(flowName + "=;") && value.includes("Max-Age=0"))).toBe(true);
  expect(cookies.join(";")).not.toContain("gho_fixture_secret");
  const sent = new URLSearchParams(remote.mock.calls[0][1]?.body as string);
  expect(sent.get("client_secret")).toBe(config.GITHUB_CLIENT_SECRET); expect(sent.get("code")).toBe("test-code");
  expect(sent.get("code_verifier")).toBe(decodeJwt(flow.cookie.slice(flowName.length + 1)).verifier);
  expect(sent.get("redirect_uri")).toBe(origin + "/panel/auth/github/callback");
  for (let i = 0; i < 3; i++) {
    const identity = await worker.fetch(new Request(origin + "/panel/api/session", { headers: { Cookie: session.split(";")[0] } }), config);
    expect(await identity.json()).toMatchObject({ user_id: "12345", login: "owner", mode: "github" });
  }
  expect(remote).toHaveBeenCalledTimes(2); expect(storage).not.toHaveBeenCalled();
});

it("rejects missing, mismatched, duplicated, expired, forged and cross-host state before outbound requests", async () => {
  const storage = noStorage(), flow = await start(), remote = vi.spyOn(globalThis, "fetch");
  const decoded = decodeJwt(flow.cookie.slice(flowName.length + 1)), config = githubSettings();
  const expired = await sessionToken(config, { ...decoded, exp: Math.floor(Date.now() / 1000) - 1 }, "spiderwatch-oauth");
  const wrongType = await sessionToken(config, decoded);
  const wrongState = callback(flow); const url = new URL(wrongState.url); url.searchParams.set("state", "a".repeat(43));
  const variants = [callback(flow, "", { Cookie: "" }), new Request(url, { headers: { Cookie: flow.cookie } }),
    callback(flow, "&state=another"), callback(flow, "&code=other"), callback(flow, "", { Cookie: flowName + "=" + expired }),
    callback(flow, "", { Cookie: flowName + "=" + wrongType }), callback(flow, "", { Cookie: flow.cookie + "tampered" }),
    callback(flow, "", {}, "https://other.example.test"), callback(flow, "", { Cookie: flow.cookie + "; " + flow.cookie })];
  for (const request of variants) {
    const response = await worker.fetch(request, config);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "oauth_state_invalid" });
    expect(response.headers.getSetCookie().join(";")).toContain("Max-Age=0");
  }
  expect(remote).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
});

it("rejects a used GitHub code instead of reissuing a session", async () => {
  noStorage(); const flow = await start(), remote = mockGithub();
  const first = await worker.fetch(callback(flow), githubSettings()); expect(first.status).toBe(302);
  remote.mockResolvedValue(Response.json({ error: "bad_verification_code" }));
  const again = await worker.fetch(callback(flow), githubSettings());
  expect(again.status).toBe(502); expect(again.headers.getSetCookie().some(value => value.startsWith(sessionName + "="))).toBe(false);
});

it("does not auto-enroll administrators and clears an earlier browser session on denial", async () => {
  const storage = noStorage(), flow = await start(); mockGithub({ id: 999, login: "owner", type: "User" });
  const response = await worker.fetch(callback(flow, "", { Accept: "text/html" }), githubSettings());
  expect(response.status).toBe(403); expect(await response.text()).toContain("不在管理员名单");
  const cookies = response.headers.getSetCookie();
  expect(cookies.some(value => value.startsWith(sessionName + "=;") && value.includes("Max-Age=0"))).toBe(true);
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer"); expect(storage).not.toHaveBeenCalled();
});

it("fails safely on GitHub errors, redirects, malformed or oversized replies without leaking secrets", async () => {
  noStorage(); const flow = await start(), remote = vi.spyOn(globalThis, "fetch");
  for (const response of [new Response("gho_secret", { status: 503 }), Response.redirect("https://evil.example"),
    new Response("not-json"), Response.json({ error: "bad_verification_code" }), Response.json({ access_token: "bad\r\nheader", token_type: "bearer" }),
    new Response("x".repeat(32769)), new Response("{}", { headers: { "Content-Length": "32769" } })]) {
    remote.mockResolvedValueOnce(response);
    const result = await worker.fetch(callback(flow), githubSettings());
    expect(result.status).toBe(502); expect(await result.json()).toEqual({ code: "github_unavailable" });
  }
  remote.mockRejectedValueOnce(new Error("fixture-secret"));
  expect((await worker.fetch(callback(flow), githubSettings())).status).toBe(502);
});

it("applies independent login and callback rate limits without accessing GitHub or storage", async () => {
  const storage = noStorage(), flow = await start(), remote = vi.spyOn(globalThis, "fetch");
  const limit = vi.fn(async () => ({ success: false })), config = { ...githubSettings(), LOGIN_LIMITER: { limit } };
  expect((await worker.fetch(new Request(origin + "/panel/auth/login"), config)).status).toBe(429);
  expect((await worker.fetch(callback(flow), config)).status).toBe(429);
  expect(limit.mock.calls).toHaveLength(2);
  expect(remote).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
});

it("logs out only through a same-origin POST and expires both cookies", async () => {
  const storage = noStorage(), remote = vi.spyOn(globalThis, "fetch"), config = githubSettings();
  for (const method of ["GET", "HEAD", "PUT"]) expect((await worker.fetch(new Request(origin + "/panel/auth/logout", { method }), config)).status).toBe(405);
  for (const Origin of ["", "https://evil.example"]) expect((await worker.fetch(new Request(origin + "/panel/auth/logout", { method: "POST", headers: { Origin } }), config)).status).toBe(403);
  const response = await worker.fetch(new Request(origin + "/panel/auth/logout", { method: "POST", headers: { Origin: origin } }), config);
  expect(response.status).toBe(204); expect(await response.text()).toBe("");
  expect(response.headers.getSetCookie()).toHaveLength(2);
  for (const value of response.headers.getSetCookie()) expect(value).toContain("Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  expect(remote).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
});
