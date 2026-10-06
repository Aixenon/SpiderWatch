import { githubSettings } from "./github-fixture";
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { hash as credentialHash } from "../src/model";
import { issueInvitation } from "../src/identity";

const origin = "http://127.0.0.1", repo = "monitor-owner/agent-releases", node = "a".repeat(32);
const file = "spider-watch-windows-amd64.exe", hash = "a".repeat(64), revision = "c".repeat(40);
const setup = "spider-watch-windows-amd64-setup.exe";
const binary = new TextEncoder().encode("MZ test executable"), installer = new TextEncoder().encode("#!/bin/sh\necho installed\n");
type Manifest = { version: string; revision: string; assets: { url: string; bytes: number; sha256: string }[] };
type Options = { scriptLength?: number | null; scriptBody?: Uint8Array; version?: string; revision?: string; metadataStatus?: number; metadata?: unknown; extra?: string; length?: number; encoding?: string; binaryStatus?: number; body?: () => BodyInit; beforeMetadata?: () => Promise<void> };
const configured = () => ({ ...env, UPDATE_GITHUB_REPOSITORY: repo });
const stub = (settings = configured()) => env.MONITOR.getByName(settings.MONITOR_GROUP);
async function setDOEnv(settings = configured()) {
  const digest = await credentialHash("b".repeat(64));
  await runInDurableObject(stub(settings), (instance, ctx) => {
    Reflect.set(instance, "env", { ...Reflect.get(instance, "env"), ASSETS: env.ASSETS, UPDATE_GITHUB_REPOSITORY: settings.UPDATE_GITHUB_REPOSITORY });
    ctx.storage.sql.exec("INSERT OR IGNORE INTO nodes(node_id,name,key_hash,state,host) VALUES (?,'update-fixture',?,'approved','{}')", node, digest);
  });
}
function makeRequest(path: string, method = "GET", body?: unknown) {
  return new Request(path.startsWith("http") ? path : origin + (path.startsWith("/api/") ? "/panel" + path : path), { method,
    headers: { Origin: origin, "Content-Type": "application/json", "X-Monitor-Update-Protocol": "2", "X-Monitor-Node-ID": node, Authorization: "Bearer " + "b".repeat(64), Cookie: "sensitive=local" },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function request(path: string, method = "GET", body?: unknown, settings = configured()) {
  const response = await worker.fetch(makeRequest(path, method, body), settings);
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
}
function bundle(options: Options = {}) {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("No runtime external fetch allowed"); });
  const observed: Request[] = [];
  const assets = vi.spyOn(env.ASSETS, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), path = new URL(req.url).pathname;
    observed.push(req);
    if (path === "/_downloads/current.json") {
      await options.beforeMetadata?.();
      if (options.metadataStatus) return new Response(null, { status: options.metadataStatus });
      const asset = { os: "windows", arch: "amd64", file, bytes: binary.length, sha256: hash };
      return Response.json(options.metadata ?? { schema: 1, version: options.version || "0.7.1", revision: options.revision || revision, repository: repo, build: "d".repeat(64),
        assets: [asset], files: [asset, { file: setup, bytes: binary.length, sha256: hash }, { file: "install.sh", bytes: installer.length, sha256: hash }], extra: options.extra });
    }
    if (path === "/install.sh") return new Response(req.method === "HEAD" ? null : options.scriptBody ?? installer, { headers: {
      ...(options.scriptLength === null ? {} : { "Content-Length": String(options.scriptLength ?? installer.length) }), "Content-Type": "text/x-shellscript",
    } });
    if (path.startsWith("/_downloads/") && [file, setup].some(name => path.endsWith("/" + name))) {
      const headers = new Headers();
      if (options.length !== undefined) headers.set("Content-Length", String(options.length));
      if (options.encoding) headers.set("Content-Encoding", options.encoding);
      return new Response(req.method === "HEAD" ? null : options.body?.() ?? binary, { status: options.binaryStatus || 200, headers });
    }
    return new Response(null, { status: 404 });
  });
  return { options, assets, network, observed };
}
const enable = (path = "agent/stable", settings = configured()) => request("/api/updates/config", "PUT", { enabled: true, distribution_path: path }, settings);
const check = () => request("/v1/update/check");
const manifest = async () => (await (await request("/v1/updates/agent/stable/manifest.json")).json()) as Manifest;
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it("serves the deployed revision and streams same-origin assets without GitHub or source-cache writes", async () => {
  const source = bundle(); await setDOEnv();
  const snapshot = () => runInDurableObject(stub(), (_, ctx) => ctx.storage.sql.exec("SELECT * FROM config ORDER BY id").toArray());
  const before = await snapshot();
  expect(await (await check()).json()).toMatchObject({ enabled: true, version: "0.7.1", revision });
  const metadata = await manifest(); expect(metadata.revision).toBe(revision);
  expect(metadata.assets[0].url).toBe(`${origin}/v1/updates/agent/stable/0.7.1/${hash}/${file}`);
  const response = await request(metadata.assets[0].url);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(binary);
  expect(response.headers.get("Content-Length")).toBe(String(binary.length));
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(await snapshot()).toEqual(before);
  expect(source.network).not.toHaveBeenCalled();
  for (const req of source.observed) for (const key of ["Authorization", "Cookie", "X-Monitor-Node-ID"]) expect(req.headers.has(key)).toBe(false);
});

it("keeps the exact legacy update JSON schema unless revision support is requested", async () => {
  bundle(); await setDOEnv();
  for (const path of ["/v1/update/check", "/v1/updates/agent/stable/manifest.json"]) {
    const legacy = makeRequest(path); legacy.headers.delete("X-Monitor-Update-Protocol");
    const response = await worker.fetch(legacy, configured()); expect(response.status).toBe(200);
    const data = await response.json<Record<string, unknown>>();
    expect(data).not.toHaveProperty("revision");
    expect(Object.keys(data).sort()).toEqual((path.endsWith("check") ? ["enabled", "version", "release_tag", "manifest_url"] : ["schema", "version", "release_tag", "assets"]).sort());
    expect(data.version).toBe("0.7.1");
  }
});

it("uses newly deployed metadata immediately, including after DO eviction and on the same base version", async () => {
  const source = bundle(); await setDOEnv(); await check();
  source.options.revision = "e".repeat(40);
  expect(await (await check()).json()).toMatchObject({ revision: "e".repeat(40) });
  await evictDurableObject(stub()); await setDOEnv();
  expect(await (await check()).json()).toMatchObject({ revision: "e".repeat(40) });
  expect(await runInDurableObject(stub(), (_, ctx) => ctx.storage.sql.exec("SELECT id FROM config WHERE id=6").toArray())).toEqual([]);
});

it("preserves distribution paths and disabled/manual policies without fetching asset metadata", async () => {
  const source = bundle(); await setDOEnv();
  expect(await (await request("/v1/update/automatic")).json()).toMatchObject({ enabled: false });
  expect(source.assets).not.toHaveBeenCalled();
  await request(`/api/nodes/${node}`, "PATCH", { auto_update: true });
  expect(await (await request("/v1/update/automatic")).json()).toMatchObject({ enabled: true });
  await enable("windows/stable");
  expect((await manifest()).version).toBe("0.7.1");
  await request("/api/updates/config", "PUT", { enabled: false, distribution_path: "windows/stable" });
  const count = source.assets.mock.calls.length;
  expect(await (await check()).json()).toMatchObject({ enabled: false });
  expect((await request("/v1/updates/windows/stable/manifest.json")).status).toBe(404);
  expect(source.assets).toHaveBeenCalledTimes(count);
});

it("rechecks revocation and manual-mode changes while static metadata is being read", async () => {
  const source = bundle(); await setDOEnv(); await request(`/api/nodes/${node}`, "PATCH", { auto_update: true });
  const result = await runInDurableObject(stub(), async instance => {
    let started!: () => void, release!: () => void;
    const arrival = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    source.options.beforeMetadata = async () => { started(); await gate; };
    const headers = { "X-Monitor-Role": "updates", "X-Monitor-Auth-Expires": String(Date.now() + 60000), "X-Monitor-Original-URL": origin + "/v1/update/automatic", "X-Monitor-Original-Method": "GET", "X-Monitor-Node-ID": node, Authorization: "Bearer " + "b".repeat(64) };
    const pending = instance.fetch(new Request("http://do/internal/update-state", { headers })); await arrival;
    const changed = await instance.fetch(new Request(origin + `/api/nodes/${node}`, { method: "PATCH", headers: { "X-Monitor-Role": "admin", "X-Monitor-Auth-Expires": String(Date.now() + 60000) }, body: JSON.stringify({ auto_update: false }) }));
    expect(changed.status).toBe(200); release();
    return (await pending).json();
  });
  expect(result).toMatchObject({ config: { enabled: false } });
});

it("requires registered credentials for metadata and binary GET/HEAD, even when the assets exist", async () => {
  const source = bundle(); await setDOEnv(); const metadata = await manifest();
  const paths = ["/v1/update/check", "/v1/update/automatic", "/v1/updates/agent/stable/manifest.json", metadata.assets[0].url];
  const beforeAssets = source.assets.mock.calls.length;
  for (const path of paths) for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(new Request(path.startsWith("http") ? path : origin + path, { method }), configured());
    expect(response.status).toBe(401); await response.body?.cancel();
  }
  await request(`/api/nodes/${node}`, "DELETE");
  for (const path of paths) for (const method of ["GET", "HEAD"]) expect((await request(path, method)).status).toBe(403);
  expect(source.assets).toHaveBeenCalledTimes(beforeAssets);
  expect(source.network).not.toHaveBeenCalled();
});

it("rejects missing, malformed, oversized, redirecting and untrusted static manifests", async () => {
  const source = bundle({ metadataStatus: 404 }); await setDOEnv();
  expect(await (await check()).json()).toMatchObject({ code: "update_bundle_unavailable" });
  source.options.metadataStatus = 302; expect((await check()).status).toBe(503);
  source.options.metadataStatus = undefined;
  for (const change of [{ version: "0.7.1-beta.1" }, { version: "1000000000.1.0" }, { version: "0.7.1", revision: "bad" }, { revision, extra: "x".repeat(65536) }, { extra: undefined, metadata: { schema: 1, files: [{ file: "../secret" }] } }]) {
    Object.assign(source.options, change); expect((await check()).status).toBe(502);
  }
  expect(source.observed.some(req => req.url.endsWith(".exe"))).toBe(false);
});

it("rejects mismatched lengths, compression, redirects, partial and malformed binary streams", async () => {
  const source = bundle(); await setDOEnv(); const url = (await manifest()).assets[0].url;
  for (const change of [{ length: binary.length + 1 }, { length: undefined, encoding: "gzip" }, { encoding: undefined, binaryStatus: 302 }, { binaryStatus: 206 }]) {
    Object.assign(source.options, change); expect((await request(url)).status).toBe(502);
  }
  source.options.binaryStatus = undefined;
  for (const size of [binary.length - 1, binary.length + 1]) {
    source.options.body = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(size)); controller.close(); } });
    await expect(request(url)).rejects.toThrow();
  }
});

it("cancels static binary reads when the client disconnects", async () => {
  const source = bundle(); await setDOEnv(); const url = (await manifest()).assets[0].url;
  let canceled!: () => void; const cancellation = new Promise<void>(resolve => { canceled = resolve; });
  source.options.body = () => new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1)); }, cancel() { canceled(); } });
  const response = await worker.fetch(makeRequest(url), configured());
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel(); await cancellation;
});

it("blocks raw asset paths, internal paths, panel aliases, unsafe settings, and unauthenticated Windows downloads", async () => {
  const source = bundle(), monitor = vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("must not enter DO"); });
  for (const path of ["/_downloads/current.json", "/panel/_downloads/current.json", "/panel/%5fdownloads/current.json", "/internal/install-authorize", "/internal/update-state", "/agent-releases/index.json"]) expect((await request(path)).status).toBe(404);
  for (const path of ["../secret", "/absolute", "agent//stable", "Agent/Stable", "https://example.test", "api/files", "a".repeat(65)]) expect((await enable(path)).status).toBe(400);
  expect((await worker.fetch(new Request("https://monitor.example.test/panel/downloads/" + setup), githubSettings())).status).toBe(401);
  expect((await worker.fetch(new Request(origin + "/panel/api/updates/config", { method: "PUT", headers: { Origin: "https://evil.invalid" }, body: "{}" }), configured())).status).toBe(403);
  expect(monitor).not.toHaveBeenCalled(); expect(source.assets).not.toHaveBeenCalled();
});

it("serves the public script and authenticated Windows installer without waking the DO", async () => {
  const source = bundle(), monitor = vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("must not enter DO"); });
  expect(await (await request("/install.sh")).text()).toContain("#!/bin/sh");
  expect((await request("/install.sh", "HEAD")).status).toBe(200);
  expect(new Uint8Array(await (await request("/panel/downloads/" + setup)).arrayBuffer())).toEqual(binary);
  expect((await request("/panel/downloads/../private")).status).toBe(404);
  expect(monitor).not.toHaveBeenCalled(); expect(source.network).not.toHaveBeenCalled();
});

it("serves a bounded public installer when ASSETS omits Content-Length, including HEAD", async () => {
  const source = bundle({ scriptLength: null });
  const monitor = vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("must not enter DO"); });
  for (const method of ["GET", "HEAD"]) {
    const response = await request("/install.sh", method);
    expect(response.status).toBe(200); expect(response.headers.get("Content-Length")).toBe(String(installer.length));
    expect(await response.text()).toBe(method === "HEAD" ? "" : new TextDecoder().decode(installer));
  }
  source.options.scriptBody = new Uint8Array(65537);
  expect(await (await request("/install.sh")).json()).toMatchObject({ code: "installer_unavailable" });
  source.options.scriptBody = new Uint8Array();
  expect((await request("/install.sh")).status).toBe(503);
  source.options.scriptBody = installer; source.options.scriptLength = installer.length + 1;
  expect((await request("/install.sh")).status).toBe(503);
  expect(monitor).not.toHaveBeenCalled(); expect(source.network).not.toHaveBeenCalled();
});

it("allows installation downloads only while the particular invitation remains unconsumed", async () => {
  const source = bundle(); await setDOEnv();
  const created = await (await request("/api/invitations", "POST")).json<{ id: string; server: string }>();
  const token = new URLSearchParams(new URL(created.server).hash.slice(1)).get("invite")!;
  const base = "/bootstrap/install/" + encodeURIComponent(token);
  expect(await (await request(base + "/current.json")).json()).toMatchObject({ version: "0.7.1", revision });
  expect(new Uint8Array(await (await request(base + "/0.7.1/" + file)).arrayBuffer())).toEqual(binary);
  expect((await request(base + "/0.7.0/" + file)).status).toBe(404);
  expect((await request(base + "/0.7.1/secret.txt")).status).toBe(404);
  await request("/api/invitations/" + created.id, "DELETE");
  expect((await request(base + "/current.json")).status).toBe(403);
  expect((await request(base + "/0.7.1/" + file, "HEAD")).status).toBe(403);
  expect(source.network).not.toHaveBeenCalled();
});

it("rejects invalid or expired invitation download tokens before a DO lookup", async () => {
  const source = bundle(), expired = await issueInvitation(env, node, Date.now() - 1);
  const monitor = vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("must not enter DO"); });
  for (const token of ["invalid", expired, node + "." + (Date.now() + 60000) + "." + "b".repeat(43) + "="]) {
    expect((await request("/bootstrap/install/" + encodeURIComponent(token) + "/current.json")).status).toBe(403);
  }
  expect(monitor).not.toHaveBeenCalled(); expect(source.assets).not.toHaveBeenCalled();
});

it("checks a registered device platform and version using the bundled deployment", async () => {
  bundle(); await setDOEnv();
  await runInDurableObject(stub(), (_, ctx) => ctx.storage.sql.exec("UPDATE nodes SET host=? WHERE node_id=?", JSON.stringify({ os: "Windows", arch: "amd64", agent_version: "0.7.0" }), node));
  expect(await (await request(`/api/nodes/${node}/update-check`, "POST")).json()).toMatchObject({ version: "0.7.1", revision, current_version: "0.7.0", available: true });
  for (const [currentRevision, expected] of [[revision, false], ["e".repeat(40), true], [undefined, true]] as const) {
    await runInDurableObject(stub(), (_, ctx) => ctx.storage.sql.exec("UPDATE nodes SET host=? WHERE node_id=?", JSON.stringify({ os: "Windows", arch: "amd64", agent_version: "0.7.1", agent_revision: currentRevision }), node));
    expect(await (await request(`/api/nodes/${node}/update-check`, "POST")).json()).toMatchObject({ available: expected });
  }
  await request(`/api/nodes/${node}`, "DELETE");
  expect((await request(`/api/nodes/${node}/update-check`, "POST")).status).toBe(404);
});
