import { invitationHeaders } from "./invitation-fixture";
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import worker from "../src/index";

const origin = "http://127.0.0.1", id = "d".repeat(32), key = "e".repeat(64);
const host = { hostname: "existing-computer", os: "windows", arch: "amd64", cpus: 2, agent_version: "0.3.0" };
const stub = () => env.MONITOR.getByName(env.MONITOR_GROUP);
async function request(path: string, method = "GET", body?: unknown): Promise<Response> {
  const response = await worker.fetch(new Request(origin + (path.startsWith("/api/") ? "/panel" + path : path), { method,
    headers: { ...(path.endsWith("/enroll") ? await invitationHeaders() : {}), Origin: origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
}
const enroll = (group: string) => request("/bootstrap/enroll", "POST", { protocol: 1, node_id: id, device_key: key, host, group });
afterEach(async () => { await reset(); });

it("persists a random sixteen-character code and accepts both cases without resetting approval", async () => {
  const initial = await (await request("/api/state")).json() as {group: string};
  expect(initial.group).toMatch(/^[a-z0-9]{16}$/);
  expect(initial.group).not.toBe(env.MONITOR_GROUP);
  expect(await (await enroll(initial.group.toUpperCase())).json()).toMatchObject({ state: "approved" });
  await evictDurableObject(stub());
  const restored = await (await request("/api/state")).json() as {group: string};
  expect(restored.group).toBe(initial.group);
  expect(await (await enroll(restored.group)).json()).toMatchObject({ state: "approved" });
  expect(await (await enroll(restored.group.toUpperCase())).json()).toMatchObject({ state: "approved" });
  const wrong = (restored.group[0] === "0" ? "1" : "0") + restored.group.slice(1);
  expect((await enroll(wrong)).status).toBe(404);
  expect(await (await enroll(env.MONITOR_GROUP)).json()).toMatchObject({ state: "approved" });
});

it("migrates a legacy database in the same namespace while retaining its approved identities", async () => {
  await enroll(env.MONITOR_GROUP);
  await runInDurableObject(stub(), (_, ctx) => {
    // The earlier schema has settings/runtime records and device approval but
    // no separate public network identity or migration-version record.
    ctx.storage.sql.exec("DELETE FROM config WHERE id IN (3,4)");
  });
  await evictDurableObject(stub());
  const migrated = await (await request("/api/state")).json() as {group: string; nodes: {node_id: string; state: string}[]};
  expect(migrated.group).toMatch(/^[a-z0-9]{16}$/);
  expect(migrated.nodes).toMatchObject([{ node_id: id, state: "approved" }]);
  expect(await (await enroll(env.MONITOR_GROUP)).json()).toMatchObject({ state: "approved" });
  expect(await (await enroll(migrated.group.toUpperCase())).json()).toMatchObject({ state: "approved" });
  await evictDurableObject(stub());
  expect((await (await request("/api/state")).json() as {group: string}).group).toBe(migrated.group);
});

it("validates the complete device configuration before saving name and group atomically", async () => {
  await enroll(env.MONITOR_GROUP);
  const group = await (await request("/api/node-groups", "POST", { name: "机房" })).json() as {id: string};
  expect((await request(`/api/nodes/${id}`, "PATCH", { nickname: "should-not-save", group_id: "f".repeat(32) })).status).toBe(404);
  const unchanged = await (await request("/api/state")).json() as any;
  expect(unchanged.nodes[0]).toMatchObject({ name: host.hostname, nickname: "", group_id: null, state: "approved" });
  expect((await request(`/api/nodes/${id}`, "PATCH", { nickname: "bad\nname", group_id: group.id })).status).toBe(400);
  expect((await request(`/api/nodes/${id}`, "PATCH", { nickname: "机房一号", group_id: group.id })).status).toBe(200);
  await evictDurableObject(stub());
  expect(await (await enroll(env.MONITOR_GROUP)).json()).toMatchObject({ state: "approved" });
  const restored = await (await request("/api/state")).json() as any;
  expect(restored.nodes[0]).toMatchObject({ name: "机房一号", nickname: "机房一号", group_id: group.id, state: "approved" });
  expect((await request(`/api/nodes/${id}`, "PATCH", { group_id: null })).status).toBe(200);
  expect((await (await request("/api/state")).json() as any).nodes[0]).toMatchObject({ name: "机房一号", group_id: null, state: "approved" });
});

it("does not recreate a group assignment when a device is deleted during a configuration body read", async () => {
  await enroll(env.MONITOR_GROUP);
  const group = await (await request("/api/node-groups", "POST", { name: "temporary" })).json() as {id: string};
  const result = await runInDurableObject(stub(), async (instance, ctx) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const role = { "X-Monitor-Role": "admin", "X-Monitor-Auth-Expires": String(Date.now() + 60_000) };
    const saving = instance.fetch(new Request(origin + `/api/nodes/${id}`, { method: "PATCH", headers: role, body }));
    expect((await instance.fetch(new Request(origin + `/api/nodes/${id}`, { method: "DELETE", headers: role }))).status).toBe(200);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ nickname: "late", group_id: group.id })));
    controller.close();
    const response = await saving;
    return { status: response.status, memberships: ctx.storage.sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM node_group_members").one().n };
  });
  expect(result).toEqual({ status: 404, memberships: 0 });
});
