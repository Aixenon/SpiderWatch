import { invitationHeaders } from "./invitation-fixture";
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import worker from "../src/index";
import type { DeviceIcon } from "../src/model";

const origin = "http://127.0.0.1", id = "c".repeat(32), key = "f".repeat(64);
const host = { hostname: "icon-test-computer", os: "windows", arch: "amd64", cpus: 2, agent_version: "0.3.0" };
const stub = () => env.MONITOR.getByName(env.MONITOR_GROUP);
type StateNode = { node_id: string; name: string; nickname: string; icon: DeviceIcon; group_id: string | null; state: string };
async function request(path: string, method = "GET", body?: unknown): Promise<Response> {
  const response = await worker.fetch(new Request(origin + (path.startsWith("/api/") ? "/panel" + path : path), { method,
    headers: { ...(path.endsWith("/enroll") ? await invitationHeaders() : {}), Origin: origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
}
const enroll = () => request("/bootstrap/enroll", "POST", { protocol: 1, node_id: id, device_key: key, host, group: env.MONITOR_GROUP });
const configure = (body: unknown) => request(`/api/nodes/${id}`, "PATCH", body);
async function node(): Promise<StateNode> { return ((await (await request("/api/state")).json()) as {nodes: StateNode[]}).nodes[0]; }
afterEach(async () => { await reset(); });

it("defaults new devices to server and restores an icon-only change after eviction", async () => {
  await enroll();
  const before = await node();
  expect(before).toMatchObject({ icon: "server", name: host.hostname, state: "approved" });
  expect((await configure({ icon: "raspberry-pi" })).status).toBe(200);
  await evictDurableObject(stub());
  expect(await node()).toMatchObject({ ...before, icon: "raspberry-pi" });
  expect(await (await enroll()).json()).toMatchObject({ state: "approved" });
});

it("adds the default icon to a legacy schema without changing names, groups or authorization", async () => {
  await enroll();
  const group = await (await request("/api/node-groups", "POST", { name: "existing-group" })).json() as {id: string};
  await configure({ nickname: "original name", group_id: group.id });
  await runInDurableObject(stub(), (_, ctx) => { ctx.storage.sql.exec("ALTER TABLE nodes DROP COLUMN icon"); ctx.storage.sql.exec("DELETE FROM config WHERE id=4"); });
  await evictDurableObject(stub());
  expect(await node()).toMatchObject({ node_id: id, icon: "server", name: "original name", nickname: "original name", group_id: group.id, state: "approved" });
  expect(await (await enroll()).json()).toMatchObject({ state: "approved" });
  await evictDurableObject(stub());
  expect((await node()).icon).toBe("server");
});

it("rejects invalid icons before changing any requested name or group", async () => {
  await enroll();
  const group = await (await request("/api/node-groups", "POST", { name: "destination" })).json() as {id: string};
  const before = await node();
  for (const icon of [null, "unknown", "<svg onload=alert(1)>", "https://example.com/icon.svg", { id: "server" }]) {
    const response = await configure({ nickname: "should not save", group_id: group.id, icon });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid_icon" });
    expect(await node()).toEqual(before);
  }
});

it("saves all display fields atomically and preserves icons in older configuration requests", async () => {
  await enroll();
  const group = await (await request("/api/node-groups", "POST", { name: "machines" })).json() as {id: string};
  expect((await configure({ nickname: "workstation", group_id: group.id, icon: "desktop" })).status).toBe(200);
  expect(await node()).toMatchObject({ name: "workstation", nickname: "workstation", group_id: group.id, icon: "desktop" });
  expect((await configure({ nickname: "", group_id: null })).status).toBe(200);
  expect(await node()).toMatchObject({ name: host.hostname, nickname: "", group_id: null, icon: "desktop" });
  expect((await configure({ nickname: "must not save", group_id: "0".repeat(32), icon: "cloud" })).status).toBe(404);
  expect(await node()).toMatchObject({ name: host.hostname, nickname: "", group_id: null, icon: "desktop" });
});
