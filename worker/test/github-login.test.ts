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
function tokenResponse(tokenType = "bearer") {
  return Response.json({ access_token: "gho_fixture_secret", token_type: tokenType, scope: "" });
}
async function expectFailure(response: Response, status: number, code: string, step: "token" | "profile" = "token", upstreamStatus?: number) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ code });
  expect(response.headers.get("X-SpiderWatch-Auth-Error")).toBe(code);
  expect(response.headers.get("X-SpiderWatch-Auth-Step")).toBe(step);
  expect(response.headers.get("X-SpiderWatch-GitHub-Status")).toBe(upstreamStatus === undefined ? null : String(upstreamStatus));
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const cookies = response.headers.getSetCookie();
  expect(cookies.some(value => value.startsWith(flowName + "=;") && value.includes("Max-Age=0"))).toBe(true);
  expect(cookies.some(value => value.startsWith(sessionName + "="))).toBe(false);
}
function mockGithub(user: Record<string, unknown> = { id: 12345, login: "owner", type: "User" }, tokenType = "bearer") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(init?.redirect).toBe("manual"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (String(input) === "https://github.com/login/oauth/access_token") return tokenResponse(tokenType);
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
  noStorage(); vi.spyOn(console, "warn").mockImplementation(() => {});
  const flow = await start(), remote = mockGithub();
  const first = await worker.fetch(callback(flow), githubSettings()); expect(first.status).toBe(302);
  remote.mockResolvedValue(Response.json({ error: "bad_verification_code" }));
  const again = await worker.fetch(callback(flow), githubSettings());
  await expectFailure(again, 400, "oauth_code_invalid");
});

it("does not auto-enroll administrators and clears an earlier browser session on denial", async () => {
  const storage = noStorage(), flow = await start(); mockGithub({ id: 999, login: "owner", type: "User" });
  const response = await worker.fetch(callback(flow, "", { Accept: "text/html" }), githubSettings());
  expect(response.status).toBe(403); expect(await response.text()).toContain("不在管理员名单");
  const cookies = response.headers.getSetCookie();
  expect(cookies.some(value => value.startsWith(sessionName + "=;") && value.includes("Max-Age=0"))).toBe(true);
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer"); expect(storage).not.toHaveBeenCalled();
});

it.each(["Bearer", "bEaReR"])("accepts the case-insensitive %s token type", async tokenType => {
  noStorage(); const flow = await start(), remote = mockGithub(undefined, tokenType);
  const response = await worker.fetch(callback(flow), githubSettings());
  expect(response.status).toBe(302); expect(remote).toHaveBeenCalledTimes(2);
  expect(response.headers.getSetCookie().some(value => value.startsWith(sessionName + "="))).toBe(true);
});

it.each([
  ["incorrect_client_credentials", 200, "github_client_credentials_invalid", 503],
  ["incorrect_client_credentials", 400, "github_client_credentials_invalid", 503],
  ["redirect_uri_mismatch", 200, "github_callback_mismatch", 503],
  ["redirect_uri_mismatch", 400, "github_callback_mismatch", 503],
  ["bad_verification_code", 200, "oauth_code_invalid", 400],
  ["unverified_user_email", 200, "github_email_unverified", 403],
  ["application_suspended", 403, "github_app_unavailable", 503],
  ["unknown-provider-error-with-secret", 400, "github_token_exchange_failed", 502],
] as const)("classifies %s with HTTP %i without logging provider data", async (error, upstreamStatus, code, status) => {
  const storage = noStorage(), config = githubSettings(), flow = await start(config);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const secret = `${config.GITHUB_CLIENT_SECRET} gho_fixture_secret ${flow.cookie} test-code`;
  const remote = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
    error, error_description: secret, error_uri: "https://evil.example/" + secret,
  }, { status: upstreamStatus }));
  await expectFailure(await worker.fetch(callback(flow), config), status, code);
  expect(warning.mock.calls).toEqual([[JSON.stringify({ event: "github_login_failed", stage: "token", code, status })]]);
  expect(remote).toHaveBeenCalledTimes(1); expect(storage).not.toHaveBeenCalled();
});

it.each([
  ["incorrect_client_credentials", 503, "github_client_credentials_invalid", "GitHub 应用配置不正确"],
  ["redirect_uri_mismatch", 503, "github_callback_mismatch", "GitHub 回调地址不匹配"],
  ["bad_verification_code", 400, "oauth_code_invalid", "登录授权已失效"],
  ["unverified_user_email", 403, "github_email_unverified", "GitHub 邮箱尚未验证"],
] as const)("shows a fixed actionable HTML message for %s", async (error, status, code, title) => {
  noStorage(); const config = githubSettings(), flow = await start(config);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const description = `<script>alert("provider-description-secret")</script>${config.GITHUB_CLIENT_SECRET}`;
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ error, error_description: description }));
  const response = await worker.fetch(callback(flow, "", { Accept: "text/html" }), config), html = await response.text();
  expect(response.status).toBe(status); expect(response.headers.get("X-SpiderWatch-Auth-Error")).toBe(code);
  expect(response.headers.get("X-SpiderWatch-Auth-Step")).toBe("token");
  expect(response.headers.get("X-SpiderWatch-GitHub-Status")).toBeNull();
  expect(response.headers.get("Content-Type")).toContain("text/html");
  expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(html).toContain(`<h1>${title}</h1>`); expect(html).toContain('href="/panel/auth/login">重新登录</a>');
  expect(html).toContain("<small>授权交换</small>");
  expect(html).not.toContain("登录尚未配置"); expect(html).not.toContain("不在管理员名单");
  for (const privateValue of ["provider-description-secret", "<script>", config.GITHUB_CLIENT_SECRET, flow.cookie]) {
    expect(html).not.toContain(privateValue); expect(JSON.stringify(warning.mock.calls)).not.toContain(privateValue);
  }
});

it("rejects HTTP errors, redirects, malformed or oversized replies without logging their contents", async () => {
  noStorage(); const flow = await start(), remote = vi.spyOn(globalThis, "fetch");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const cases: [Response, string, number?][] = [
    [new Response("gho_private_response", { status: 503 }), "github_http_error", 503],
    [Response.json({ message: "gho_private_response" }, { status: 503 }), "github_token_exchange_failed"],
    [Response.redirect("https://evil.example"), "github_redirect_rejected", 302],
    [new Response("not-json"), "github_response_invalid"],
    [Response.json(null), "github_response_invalid"], [Response.json([]), "github_response_invalid"],
    [Response.json({ access_token: "bad\r\nheader", token_type: "bearer" }), "github_response_invalid"],
    [Response.json({ access_token: "gho_private_response", token_type: "Basic" }), "github_response_invalid"],
    [new Response("x".repeat(32769)), "github_response_invalid"],
    [new Response("{}", { headers: { "Content-Length": "32769" } }), "github_response_invalid"],
  ];
  for (const [upstream, code, upstreamStatus] of cases) {
    remote.mockResolvedValueOnce(upstream);
    await expectFailure(await worker.fetch(callback(flow), githubSettings()), 502, code, "token", upstreamStatus);
    expect(warning).toHaveBeenLastCalledWith(JSON.stringify({ event: "github_login_failed", stage: "token", code, status: 502,
      ...(upstreamStatus ? { upstream_status: upstreamStatus } : {}) }));
  }
  expect(JSON.stringify(warning.mock.calls)).not.toContain("gho_private_response");
  expect(remote).toHaveBeenCalledTimes(cases.length);
});

it.each([
  [401, { message: "profile-secret" }, "github_token_rejected"],
  [403, { message: "profile-secret" }, "github_profile_failed"],
  [200, { id: "12345", login: "owner", type: "User" }, "github_profile_invalid"],
  [200, { id: 12345, login: "owner", type: "Organization" }, "github_profile_invalid"],
  [200, { id: 12345, login: "invalid_login", type: "User" }, "github_profile_invalid"],
] as const)("classifies profile HTTP %i and invalid identities", async (upstreamStatus, profile, code) => {
  noStorage(); const flow = await start(), warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const remote = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(Response.json(profile, { status: upstreamStatus }));
  await expectFailure(await worker.fetch(callback(flow), githubSettings()), 502, code, "profile");
  expect(warning.mock.calls).toEqual([[JSON.stringify({ event: "github_login_failed", stage: "profile", code, status: 502 })]]);
  expect(remote).toHaveBeenCalledTimes(2);
});

it.each([
  ["token", 429, {}], ["profile", 429, {}],
  ["token", 403, { "X-RateLimit-Remaining": "0" }], ["profile", 403, { "X-RateLimit-Remaining": "0" }],
  ["token", 403, { "Retry-After": "60" }], ["profile", 403, { "Retry-After": "60" }],
] as const)("identifies GitHub rate limiting at the %s step with HTTP %i", async (stage, status, headers) => {
  noStorage(); const flow = await start(), warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const remote = vi.spyOn(globalThis, "fetch");
  if (stage === "profile") remote.mockResolvedValueOnce(tokenResponse());
  remote.mockResolvedValueOnce(new Response(status === 429 ? null : "upstream-rate-limit-secret", { status, headers }));
  await expectFailure(await worker.fetch(callback(flow), githubSettings()), 429, "github_rate_limited", stage);
  expect(warning.mock.calls).toEqual([[JSON.stringify({ event: "github_login_failed", stage, code: "github_rate_limited", status: 429 })]]);
});

it.each(["token", "profile"] as const)("sanitizes fetch and stream failures at the %s step and releases errored readers", async stage => {
  noStorage(); const config = githubSettings(), flow = await start(config);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {}), remote = vi.spyOn(globalThis, "fetch");
  const secret = `${config.GITHUB_CLIENT_SECRET} gho_fixture_secret ${flow.cookie} test-code`;
  for (const failure of [new Error(secret), new DOMException(secret, "TimeoutError")]) {
    if (stage === "profile") remote.mockResolvedValueOnce(tokenResponse());
    remote.mockRejectedValueOnce(failure);
    await expectFailure(await worker.fetch(callback(flow), config), 502, "github_connection_failed", stage);
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); },
    pull(controller) { controller.error(new Error(secret)); },
  });
  if (stage === "profile") remote.mockResolvedValueOnce(tokenResponse());
  remote.mockResolvedValueOnce(new Response(body));
  await expectFailure(await worker.fetch(callback(flow), config), 502, "github_connection_failed", stage);
  expect(body.locked).toBe(false);
  expect(warning.mock.calls).toEqual(Array.from({ length: 3 }, () => [JSON.stringify({ event: "github_login_failed", stage, code: "github_connection_failed", status: 502 })]));
});

it.each(["token", "profile"] as const)("rejects redirects at the %s step without following or reflecting the destination", async stage => {
  noStorage(); const flow = await start(), warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const remote = vi.spyOn(globalThis, "fetch"), location = "https://evil.example/redirect-target-secret";
  for (const accept of ["application/json", "text/html"]) {
    if (stage === "profile") remote.mockResolvedValueOnce(tokenResponse());
    remote.mockResolvedValueOnce(new Response("upstream-body-secret", { status: 307, headers: {
      Location: location, "X-SpiderWatch-Auth-Step": "upstream-stage-secret", "X-SpiderWatch-GitHub-Status": "599",
    } }));
    const response = await worker.fetch(callback(flow, "", { Accept: accept, "X-SpiderWatch-Auth-Step": "request-stage-secret" }), githubSettings());
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("X-SpiderWatch-Auth-Step")).toBe(stage);
    expect(response.headers.get("X-SpiderWatch-GitHub-Status")).toBe("307");
    const headers = JSON.stringify([...response.headers]);
    if (accept === "application/json") await expectFailure(response, 502, "github_redirect_rejected", stage, 307);
    else {
      const html = await response.text();
      expect(response.status).toBe(502); expect(html).toContain("<h1>GitHub 验证地址异常</h1>");
      expect(html).toContain(`<small>${stage === "token" ? "授权交换" : "账户读取"} · GitHub HTTP 307</small>`);
      for (const value of [location, "upstream-body-secret", "upstream-stage-secret", "request-stage-secret"]) expect(html).not.toContain(value);
    }
    for (const value of [location, "upstream-body-secret", "upstream-stage-secret", "request-stage-secret"]) expect(headers).not.toContain(value);
  }
  const expectedUrls = stage === "token" ? ["https://github.com/login/oauth/access_token"]
    : ["https://github.com/login/oauth/access_token", "https://api.github.com/user"];
  expect(remote.mock.calls.map(([input]) => String(input))).toEqual([...expectedUrls, ...expectedUrls]);
  for (const [, init] of remote.mock.calls) expect(init?.redirect).toBe("manual");
  expect(warning.mock.calls).toEqual(Array.from({ length: 2 }, () => [JSON.stringify({ event: "github_login_failed", stage,
    code: "github_redirect_rejected", status: 502, upstream_status: 307 })]));
});

it.each(["token", "profile"] as const)("distinguishes non-JSON HTTP errors from network errors at the %s step", async stage => {
  noStorage(); const flow = await start(), warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const remote = vi.spyOn(globalThis, "fetch"), body = '<script>alert("upstream-body-secret")</script>';
  for (const accept of ["application/json", "text/html"]) {
    if (stage === "profile") remote.mockResolvedValueOnce(tokenResponse());
    remote.mockResolvedValueOnce(new Response(body, { status: 503, headers: {
      Location: "https://evil.example/http-error-secret", "X-SpiderWatch-Auth-Step": "upstream-stage-secret",
      "X-SpiderWatch-GitHub-Status": "599", "Content-Type": "text/html",
    } }));
    const response = await worker.fetch(callback(flow, "", { Accept: accept }), githubSettings());
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("X-SpiderWatch-Auth-Step")).toBe(stage);
    expect(response.headers.get("X-SpiderWatch-GitHub-Status")).toBe("503");
    expect(JSON.stringify([...response.headers])).not.toContain("secret");
    if (accept === "application/json") await expectFailure(response, 502, "github_http_error", stage, 503);
    else {
      const html = await response.text();
      expect(response.status).toBe(502); expect(html).toContain("<h1>GitHub 请求失败</h1>");
      expect(html).toContain(`<small>${stage === "token" ? "授权交换" : "账户读取"} · GitHub HTTP 503</small>`);
      expect(html).not.toContain("secret"); expect(html).not.toContain("<script>");
    }
  }
  expect(warning.mock.calls).toEqual(Array.from({ length: 2 }, () => [JSON.stringify({ event: "github_login_failed", stage,
    code: "github_http_error", status: 502, upstream_status: 503 })]));
});

it("preserves a response-size failure when cancelling its stream also fails", async () => {
  noStorage(); const flow = await start(), warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const cancel = vi.fn(() => { throw new Error("cancel-secret"); });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(32769)); }, cancel });
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body));
  await expectFailure(await worker.fetch(callback(flow), githubSettings()), 502, "github_response_invalid");
  expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
  expect(warning.mock.calls).toEqual([[JSON.stringify({ event: "github_login_failed", stage: "token", code: "github_response_invalid", status: 502 })]]);
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
