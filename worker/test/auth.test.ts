import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { authorize } from "../src/auth";
import worker from "../src/index";
import { githubSettings, origin, sessionName, sessionToken } from "./github-fixture";

afterEach(() => vi.restoreAllMocks());
const request = (token: string, host = origin) => new Request(host + "/panel/api/session", { headers: { Cookie: sessionName + "=" + token } });

it("verifies the signed session locally and authorizes stable GitHub IDs, not names", async () => {
  const configured = githubSettings(), fetch = vi.spyOn(globalThis, "fetch");
  expect(await authorize(request(await sessionToken()), configured, "admin")).toMatchObject({ subject: "12345", login: "owner" });
  expect(await authorize(request(await sessionToken(configured, { login: "renamed" })), configured, "admin")).toMatchObject({ subject: "12345", login: "renamed" });
  expect((await authorize(request(await sessionToken(configured, { sub: "999" })), configured, "admin") as Response).status).toBe(403);
  expect((await authorize(request(await sessionToken()), { ...configured, ADMIN_GITHUB_IDS: "999" }, "admin") as Response).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects expired, forged, wrongly scoped, malformed and oversized sessions without a lookup", async () => {
  const configured = githubSettings(), now = Math.floor(Date.now() / 1000), fetch = vi.spyOn(globalThis, "fetch");
  const valid = await sessionToken(), parts = valid.split("."); parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  const invalid = ["", "x".repeat(2049), parts.join("."),
    await sessionToken(configured, { exp: now - 1 }), await sessionToken(configured, { exp: undefined }),
    await sessionToken(configured, { iat: undefined }), await sessionToken(configured, { iat: now + 60 }),
    await sessionToken(configured, { exp: now + 28801 }), await sessionToken(configured, { aud: "another-site" }),
    await sessionToken(configured, { iss: "other" }), await sessionToken(configured, { sub: "owner" }),
    await sessionToken(configured, { login: "<script>" }), await sessionToken(configured, {}, "spiderwatch-oauth"),
    await sessionToken(configured, {}, "spiderwatch-session", "HS384"), await sessionToken({ ...configured, SESSION_SECRET: "b".repeat(64) })];
  for (const token of invalid) expect((await authorize(request(token), configured, "admin") as Response).status).toBe(401);
  expect((await authorize(request(valid, "https://other.example.test"), configured, "admin") as Response).status).toBe(401);
  expect((await authorize(new Request(origin, { headers: { Cookie: sessionName + "=" + valid + "; " + sessionName + "=" + valid } }), configured, "admin") as Response).status).toBe(401);
  expect((await authorize(new Request(origin, { headers: { Cookie: "padding=" + "x".repeat(16384) } }), configured, "admin") as Response).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});

it("fails closed when any GitHub login setting is missing or invalid", async () => {
  const configured = githubSettings(), fetch = vi.spyOn(globalThis, "fetch");
  const variants: Env[] = [];
  for (const key of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "ADMIN_GITHUB_IDS", "SESSION_SECRET"] as const) {
    const missing = { ...configured }; Reflect.deleteProperty(missing, key);
    variants.push(missing, { ...configured, [key]: "   " });
  }
  for (const ids of ["owner", "0", "12345,", "12345,owner", "12345,".repeat(51)]) variants.push({ ...configured, ADMIN_GITHUB_IDS: ids });
  for (const value of ["short", "z".repeat(64)]) variants.push({ ...configured, SESSION_SECRET: value });
  for (const config of variants) {
    const response = await authorize(new Request(origin), config, "admin") as Response;
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: "auth_not_configured" });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("ignores Access and client-provided identity headers and never uses a panel session as device authentication", async () => {
  const configured = githubSettings(), storage = vi.spyOn(env.MONITOR, "getByName");
  const token = await sessionToken();
  expect((await authorize(new Request(origin, { headers: { "cf-access-jwt-assertion": token, "Cf-Access-Authenticated-User-Email": "owner@example.test", "X-Monitor-Role": "admin" } }), configured, "admin") as Response).status).toBe(401);
  expect((await authorize(request(token), configured, "agent") as Response).status).toBe(401);
  expect((await worker.fetch(new Request(origin + "/v1/live", { headers: { Cookie: sessionName + "=" + token, Upgrade: "websocket" } }), configured)).status).toBe(401);
  expect(storage).not.toHaveBeenCalled();
});

it("requires HTTPS and limits local mode to loopback", async () => {
  expect((await authorize(new Request("http://monitor.example.test"), githubSettings(), "admin") as Response).status).toBe(400);
  expect((await authorize(new Request(origin), env, "admin") as Response).status).toBe(403);
  expect(await authorize(new Request("http://127.0.0.1"), env, "admin")).toMatchObject({ subject: "local-development" });
});
