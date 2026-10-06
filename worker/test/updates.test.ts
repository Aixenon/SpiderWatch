import { githubSettings } from "./github-fixture";
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { hash as credentialHash } from "../src/model";
import type { UpdateCache } from "../src/update-source";

const origin = "http://127.0.0.1", repo = "monitor-owner/agent-releases";
const configured = () => ({ ...env, UPDATE_GITHUB_REPOSITORY: repo });
const file = "spider-watch-windows-amd64.exe", hash = "a".repeat(64);
const binary = new TextEncoder().encode("MZ test executable");
type Manifest = { version: string; assets: { url: string; bytes: number; sha256: string }[] };
type SourceOptions = { version?: string; sha256?: string; apiStatus?: number; apiHeaders?: Record<string, string>; redirect?: string;
  body?: () => BodyInit; length?: number; encoding?: string; binaryStatus?: number; manifestBytes?: number; extraManifest?: string; beforeAPI?: () => Promise<void> };
function stub(settings = configured()) { return env.MONITOR.getByName(settings.MONITOR_GROUP); }
async function setDOEnv(settings = configured()) {
  // Env passed to worker.fetch does not modify the DO's deployment bindings.
  // Clone only the test instance's env; never mutate the shared test bindings.
  const digest = await credentialHash("b".repeat(64));
  await runInDurableObject(stub(settings), (instance,ctx) => {
    Reflect.set(instance, "env", { ...Reflect.get(instance, "env"), UPDATE_GITHUB_REPOSITORY: settings.UPDATE_GITHUB_REPOSITORY });
    ctx.storage.sql.exec("INSERT OR IGNORE INTO nodes(node_id,name,key_hash,state,host) VALUES (?,'update-fixture',?,'approved','{}')","a".repeat(32),digest);
  });
}
function makeRequest(path: string, method = "GET", body?: unknown) {
  return new Request(path.startsWith("http") ? path : origin + (path.startsWith("/api/") ? "/panel" + path : path), { method,
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Access-Client-Id": "must-stay-local", "CF-Access-Client-Secret": "must-stay-local", "X-Monitor-Node-ID":"a".repeat(32), Authorization: "Bearer " + "b".repeat(64), "cf-access-jwt-assertion": "must-stay-local" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function request(path: string, method = "GET", body?: unknown, settings = configured()) {
  const response = await worker.fetch(makeRequest(path, method, body), settings);
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
}
function github(options: SourceOptions = {}) {
  const observed: { url: string; headers: Headers; redirect: RequestInit["redirect"]; signal: AbortSignal | null | undefined }[] = [];
  const source = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input), version = options.version || "0.4.0", digest = options.sha256 || hash;
    observed.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect, signal: init?.signal });
    const asset = { os: "windows", arch: "amd64", file, bytes: options.manifestBytes ?? binary.length, sha256: digest, url: "https://attacker.invalid/ignored.exe" };
    const manifest = JSON.stringify({ schema: 1, version, assets: [asset], ...(options.extraManifest ? { extra: options.extraManifest } : {}) });
    if (url.startsWith("https://api.github.com/repos/") && url.endsWith("/releases/latest")) {
      await options.beforeAPI?.();
      if (options.apiStatus) return new Response(null, { status: options.apiStatus, headers: options.apiHeaders });
      return Response.json({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [
        { name: "update-manifest.json", size: manifest.length, state: "uploaded", browser_download_url: "http://169.254.169.254/ignored" },
        { name: file, size: asset.bytes, digest: `sha256:${digest}`, state: "uploaded" },
      ] });
    }
    if (url.endsWith("/update-manifest.json")) return new Response(manifest);
    if (url.startsWith("https://github.com/") && url.endsWith("/" + file)) {
      if (options.redirect) return new Response(null, { status: 302, headers: { Location: options.redirect } });
      return executable();
    }
    if (url === "https://release-assets.githubusercontent.com/release.bin") return executable();
    throw new Error("Unexpected upstream: " + url);
  });
  function executable() {
    const headers = new Headers({ "Content-Type": "application/octet-stream" });
    if (options.length !== undefined) headers.set("Content-Length", String(options.length));
    if (options.encoding) headers.set("Content-Encoding", options.encoding);
    return new Response(options.body ? options.body() : binary, { status: options.binaryStatus || 200, headers });
  }
  return { source, options, observed };
}
const enable = (path = "agent/stable", settings = configured()) => request("/api/updates/config", "PUT", { enabled: true, distribution_path: path }, settings);
const check = (settings = configured()) => request("/v1/update/check", "GET", undefined, settings);
const getManifest = async () => (await (await request("/v1/updates/agent/stable/manifest.json")).json()) as Manifest;
async function editCache(edit: (cache: UpdateCache) => void, settings = configured()) {
  await runInDurableObject(stub(settings), (_, ctx) => {
    const row = ctx.storage.sql.exec<{ value: string }>("SELECT value FROM config WHERE id=6").toArray()[0];
    const cache = JSON.parse(row.value) as UpdateCache; edit(cache);
    ctx.storage.sql.exec("UPDATE config SET value=? WHERE id=6", JSON.stringify(cache));
  });
}
const expire = () => editCache(cache => { cache.checked_at = Date.now() - 301_000; cache.retry_at = 0; });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it("fetches release metadata only on enabled demand and streams a same-origin executable", async () => {
  await setDOEnv(); const remote = github();
  expect(await (await request("/api/updates/config")).json()).toMatchObject({ enabled: true, ready: false });
  await request("/api/updates/config", "PUT", { enabled: false, distribution_path: "agent/stable" });
  expect(await (await check()).json()).toMatchObject({ enabled: false });
  expect((await enable()).status).toBe(200);
  expect(remote.source).not.toHaveBeenCalled();
  expect(await (await check()).json()).toMatchObject({ enabled: true, version: "0.4.0", manifest_url: origin + "/v1/updates/agent/stable/manifest.json" });
  expect(remote.source).toHaveBeenCalledTimes(2);
  expect(remote.observed[0].signal).toBe(remote.observed[1].signal);
  const manifest = await getManifest();
  expect(manifest.assets[0].url).toBe(`${origin}/v1/updates/agent/stable/0.4.0/${hash}/${file}`);
  const response = await request(manifest.assets[0].url);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(binary);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Length")).toBe(String(binary.length));
  expect(response.headers.get("Location")).toBeNull();
  expect(remote.source).toHaveBeenCalledTimes(3);
  for (const observed of remote.observed) {
    expect(observed.redirect).toBe("manual");
    for (const secret of ["Authorization", "CF-Access-Client-Id", "CF-Access-Client-Secret", "cf-access-jwt-assertion", "Cookie"]) expect(observed.headers.has(secret)).toBe(false);
    expect(observed.url).not.toContain("attacker");
  }
});

it("persists the five-minute cache through eviction and keeps cache-hit reads free of SQL writes", async () => {
  await setDOEnv(); const remote = github(); await enable(); await check();
  await evictDurableObject(stub()); await setDOEnv();
  const snapshot = () => runInDurableObject(stub(), (_, ctx) => ctx.storage.sql.exec("SELECT * FROM config ORDER BY id").toArray());
  const before = await snapshot();
  for (let index = 0; index < 3; index++) expect((await check()).status).toBe(200);
  expect((await request("/api/updates/check", "POST", {})).status).toBe(200);
  expect(await snapshot()).toEqual(before);
  expect(remote.source).toHaveBeenCalledTimes(2);
  await expire(); expect((await check()).status).toBe(200);
  expect(remote.source).toHaveBeenCalledTimes(4);
});

it("coalesces concurrent cold checks without blocking administration and rechecks a concurrent disable", async () => {
  await setDOEnv();
  const remote = github();
  await enable();
  const responses = await runInDurableObject(stub(), async instance => {
    let arrived!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { arrived = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    remote.options.beforeAPI = async () => { arrived(); await gate; };
    const headers = { "X-Monitor-Role": "updates", "X-Monitor-Auth-Expires": String(Date.now() + 60_000) };
    const cold = () => instance.fetch(new Request("http://do/internal/update-state", { method: "POST", headers }));
    const first = cold(); await started; const second = cold();
    expect((await instance.fetch(new Request("http://do/internal/update-config", { method: "PUT", headers, body: JSON.stringify({ enabled: false, distribution_path: "other/stable" }) }))).status).toBe(200);
    release();
    return Promise.all((await Promise.all([first, second])).map(response => response.json()));
  });
  for (const response of responses) expect(response).toMatchObject({ config: { enabled: false, distribution_path: "other/stable" } });
  expect(remote.source).toHaveBeenCalledTimes(2);
  expect(await (await check()).json()).toEqual({ enabled: false, version: null, release_tag: null, manifest_url: null });
});

it("negative-caches upstream failures, respects rate-limit backoff and reports errors instead of no update", async () => {
  await setDOEnv(); const remote = github({ apiStatus: 429, apiHeaders: { "Retry-After": "180" } }); await enable();
  const first = await check(); expect(first.status).toBe(503);
  expect(await first.json()).toMatchObject({ code: "github_rate_limited" });
  expect(Number(first.headers.get("Retry-After"))).toBeGreaterThanOrEqual(179);
  expect((await check()).status).toBe(503); expect(remote.source).toHaveBeenCalledTimes(1);
  await evictDurableObject(stub()); await setDOEnv();
  expect((await check()).status).toBe(503); expect(remote.source).toHaveBeenCalledTimes(1);
  expect(await (await request("/api/updates/config")).json()).toMatchObject({ source_error: "github_rate_limited", ready: false });
  await expire(); remote.options.apiStatus = undefined;
  expect((await check()).status).toBe(200); expect(remote.source).toHaveBeenCalledTimes(3);
});

it("retains previous URLs and path aliases while rejecting mutated and regressed releases", async () => {
  await setDOEnv(); const remote = github(); await enable(); await check();
  const old = await getManifest();
  await expire(); remote.options.version = "0.5.0"; expect((await check()).status).toBe(200);
  expect((await enable("windows/stable")).status).toBe(200);
  expect((await request(old.assets[0].url)).status).toBe(200);
  expect((await getManifest()).version).toBe("0.5.0");
  await expire(); remote.options.sha256 = "b".repeat(64);
  expect(await (await check()).json()).toMatchObject({ code: "release_changed" });
  await expire(); remote.options.version = "0.3.0"; remote.options.sha256 = hash;
  expect(await (await check()).json()).toMatchObject({ code: "release_version_regressed" });
  expect((await getManifest()).version).toBe("0.5.0");
  expect((await request(old.assets[0].url)).status).toBe(200);
});

it("isolates both network settings and cached source repositories", async () => {
  await setDOEnv(); const remote = github(); await enable(); await check();
  const other = { ...configured(), MONITOR_GROUP: "separate-network" }; await setDOEnv(other);
  expect(await (await request("/api/updates/config", "GET", undefined, other)).json()).toMatchObject({ enabled: true, ready: false });
  const changed = { ...configured(), UPDATE_GITHUB_REPOSITORY: "another-owner/releases" }; await setDOEnv(changed);
  expect(await (await request("/api/updates/config", "GET", undefined, changed)).json()).toMatchObject({ enabled: true, ready: false });
  expect(remote.source).toHaveBeenCalledTimes(2);
  expect((await check(changed)).status).toBe(200);
  expect(remote.observed[2].url).toContain("/repos/another-owner/releases/");
});

it("guards Access, Origin, internal paths, old static downloads and unsafe configuration", async () => {
  const remote = github(), monitor = vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("should not reach DO"); });
  const production = { ...githubSettings(), UPDATE_GITHUB_REPOSITORY: configured().UPDATE_GITHUB_REPOSITORY };
  for (const path of ["/panel/api/updates/config", "/v1/update/check", "/v1/updates/agent/stable/manifest.json"]) expect((await request("https://monitor.example.test" + path, "GET", undefined, production)).status).toBe(401);
  expect((await worker.fetch(new Request(origin + "/panel/api/updates/config", { method: "PUT", headers: { Origin: "https://attacker.invalid" }, body: "{}" }), configured())).status).toBe(403);
  for (const path of ["/internal/update-config", "/internal/update-state", "/agent-releases", "/agent-releases/index.json"]) expect((await request(path)).status).toBe(404);
  for (const path of ["../secret", "/absolute", "agent//stable", "Agent/Stable", "https://example.test", "api/files", "a".repeat(65)]) expect((await enable(path)).status).toBe(400);
  expect((await enable("agent/stable", { ...env, UPDATE_GITHUB_REPOSITORY: "" })).status).toBe(503);
  expect((await request("/v1/update/check", "POST", {})).status).toBe(405);
  expect(monitor).not.toHaveBeenCalled(); expect(remote.source).not.toHaveBeenCalled();
});

it("limits release metadata and rejects unsupported releases before downloading any program", async () => {
  await setDOEnv(); const remote = github({ version: "0.4.0-beta.1" }); await enable();
  expect((await check()).status).toBe(502);
  for (const change of [{ version: "1000000000.0.0" }, { version: "0.4.0", manifestBytes: 16 * 1024 * 1024 + 1 }, { manifestBytes: binary.length, extraManifest: "a".repeat(64 * 1024) }]) {
    await expire(); Object.assign(remote.options, change);
    expect((await check()).status).toBe(502);
  }
  expect(remote.observed.some(call => call.url.endsWith(".exe"))).toBe(false);
});

it("follows allowed GitHub redirects server-side and rejects dangerous redirect targets", async () => {
  await setDOEnv(); const remote = github({ redirect: "https://release-assets.githubusercontent.com/release.bin" }); await enable(); await check();
  const url = (await getManifest()).assets[0].url;
  expect(new Uint8Array(await (await request(url)).arrayBuffer())).toEqual(binary);
  for (const target of ["http://169.254.169.254/credentials", "https://attacker.invalid/file", "https://user:pass@github.com/file", "https://github.com:444/file"]) {
    remote.options.redirect = target;
    expect(await (await request(url)).json()).toMatchObject({ code: "unsafe_release_redirect" });
    expect(remote.observed.some(call => call.url === target)).toBe(false);
  }
});

it("rejects mismatched lengths, encoded or partial upstreams, and short or overlong streams", async () => {
  await setDOEnv(); const remote = github(); await enable(); await check();
  const url = (await getManifest()).assets[0].url;
  remote.options.length = binary.length + 1; expect((await request(url)).status).toBe(502);
  remote.options.length = undefined; remote.options.encoding = "gzip"; expect((await request(url)).status).toBe(502);
  remote.options.encoding = undefined; remote.options.binaryStatus = 206; expect((await request(url)).status).toBe(502);
  remote.options.binaryStatus = undefined;
  for (const size of [binary.length - 1, binary.length + 1]) {
    remote.options.body = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(size)); controller.close(); } });
    await expect(request(url)).rejects.toThrow();
  }
});

it("cancels the upstream executable stream when the client stops reading", async () => {
  await setDOEnv(); const remote = github(); await enable(); await check();
  const url = (await getManifest()).assets[0].url;
  let canceled!: () => void;
  const cancellation = new Promise<void>(resolve => { canceled = resolve; });
  remote.options.body = () => new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1)); }, cancel() { canceled(); } });
  const response = await worker.fetch(makeRequest(url), configured());
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel(); await cancellation;
});

it("persists each device update policy and skips GitHub entirely in manual mode", async () => {
  await setDOEnv(); const remote = github(), id = "a".repeat(32);
  expect(await (await request("/v1/update/automatic")).json()).toMatchObject({enabled:false});
  expect(remote.source).not.toHaveBeenCalled();
  expect((await request(`/api/nodes/${id}`, "PATCH", {auto_update:true})).status).toBe(200);
  await evictDurableObject(stub()); await setDOEnv();
  const state = await (await request("/api/state?view=live")).json<any>();
  expect(state.nodes.find((n:any) => n.node_id===id).auto_update).toBe(true);
  expect(await (await request("/v1/update/automatic")).json()).toMatchObject({enabled:true,version:"0.4.0"});
  expect(remote.source).toHaveBeenCalledTimes(2);
  expect((await request(`/api/nodes/${id}`, "PATCH", {nickname:"should-not-save",auto_update:"true"})).status).toBe(400);
  const unchanged = await (await request("/api/state?view=live")).json<any>();
  expect(unchanged.nodes[0]).toMatchObject({auto_update:true,nickname:""});
  await request(`/api/nodes/${id}`, "PATCH", {auto_update:false}); await expire();
  expect(await (await request("/v1/update/automatic")).json()).toMatchObject({enabled:false});
  expect(remote.source).toHaveBeenCalledTimes(2);
  expect((await check()).status).toBe(200);
  expect(remote.source).toHaveBeenCalledTimes(4);
});

it("checks device platform/version without downloading and rejects removed device checks", async () => {
  await setDOEnv(); const remote=github(), id="a".repeat(32);
  await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("UPDATE nodes SET host=? WHERE node_id=?",JSON.stringify({os:"Windows",arch:"amd64",agent_version:"0.3.0"}),id));
  expect(await (await request(`/api/nodes/${id}/update-check`,"POST")).json()).toEqual({version:"0.4.0",current_version:"0.3.0",available:true});
  expect(remote.source).toHaveBeenCalledTimes(2);
  await request(`/api/nodes/${id}`,"DELETE");
  expect((await request(`/api/nodes/${id}/update-check`,"POST")).status).toBe(404);
  expect(remote.source).toHaveBeenCalledTimes(2);
});

it("requires a registered credential for both cached manifests and executable GET/HEAD", async () => {
  await setDOEnv(); const remote=github(); await check(); const manifest=await getManifest();
  const paths=["/v1/update/check","/v1/update/automatic","/v1/updates/agent/stable/manifest.json",manifest.assets[0].url];
  for(const path of paths) for(const method of ["GET","HEAD"]) {
    const absent=await worker.fetch(new Request(path.startsWith("http")?path:origin+path,{method}),configured());
    expect(absent.status).toBe(401); await absent.body?.cancel();
  }
  await request(`/api/nodes/${"a".repeat(32)}`,"DELETE");
  for(const path of paths) for(const method of ["GET","HEAD"]) expect((await request(path,method)).status).toBe(403);
  expect(remote.source).toHaveBeenCalledTimes(2);
});

it("honors manual mode selected during a cold automatic check", async () => {
  await setDOEnv(); const remote=github(), id="a".repeat(32);
  await request(`/api/nodes/${id}`,"PATCH",{auto_update:true});
  const result=await runInDurableObject(stub(),async instance=>{
    let arrived!:()=>void, release!:()=>void;
    const started=new Promise<void>(resolve=>{arrived=resolve;}), gate=new Promise<void>(resolve=>{release=resolve;});
    remote.options.beforeAPI=async()=>{arrived();await gate;};
    const headers={"X-Monitor-Role":"updates","X-Monitor-Auth-Expires":String(Date.now()+60000),"X-Monitor-Original-URL":origin+"/v1/update/automatic","X-Monitor-Original-Method":"GET","X-Monitor-Node-ID":id,Authorization:"Bearer "+"b".repeat(64)};
    const pending=instance.fetch(new Request("http://do/internal/update-state",{method:"POST",headers}));
    await started;
    const changed=await instance.fetch(new Request(origin+`/api/nodes/${id}`,{method:"PATCH",headers:{"X-Monitor-Role":"admin","X-Monitor-Auth-Expires":String(Date.now()+60000)},body:JSON.stringify({auto_update:false})}));
    expect(changed.status).toBe(200); release();
    return (await pending).json();
  });
  expect(result).toMatchObject({config:{enabled:false}});
});
