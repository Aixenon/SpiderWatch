import { invitationHeaders } from "./invitation-fixture";
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import worker from "../src/index";
import { decodeMessage } from "../src/compression";

const origin = "http://127.0.0.1", id = "a".repeat(32), key = "b".repeat(64);
const host = { hostname:"computer-name", os:"linux", arch:"arm", cpus:1, agent_version:"0.3.0" };
const stub = () => env.MONITOR.getByName(env.MONITOR_GROUP);
const headers = { "X-Monitor-Node-ID":id, Authorization:"Bearer " + key };
async function request(path: string, method = "POST", body?: unknown, extra = {}) {
  const response = await worker.fetch(new Request(origin + path, {method, headers:{ ...(path.endsWith("/enroll") ? await invitationHeaders() : {}),Origin:origin, "Content-Type":"application/json", ...extra}, body:body === undefined ? undefined : JSON.stringify(body)}),env);
  return new Response(await response.arrayBuffer(), {status:response.status, headers:response.headers});
}
afterEach(async () => { await reset(); });

it("redeems an invitation immediately and preserves legacy pending credential restrictions", async () => {
  const join = {protocol:1, node_id:id, device_key:key, group:env.MONITOR_GROUP, name:"client-must-not-assign-this", host};
  expect(await (await request("/bootstrap/enroll","POST",join)).json()).toMatchObject({state:"approved"});
  await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("UPDATE nodes SET state='pending' WHERE node_id=?",id));
  expect((await request("/bootstrap/status")).status).toBe(401);
  expect((await request("/bootstrap/status","POST",undefined,{...headers,Authorization:"Bearer " + "c".repeat(64)})).status).toBe(401);
  expect(await (await request("/bootstrap/status","POST",undefined,headers)).json()).toEqual({state:"pending",transport:"websocket",interval_seconds:300});
  expect((await request("/bootstrap/status","GET",undefined,headers)).status).toBe(405);
  const state = await (await request("/api/state","GET")).json() as any;
  expect(state.nodes[0].name).toBe(host.hostname);
  expect((await request(`/api/nodes/${id}/approve`)).status).toBe(404);
  expect(await (await request("/bootstrap/status","POST",undefined,headers)).json()).toMatchObject({state:"pending"});
  // Legacy pending devices must redeem a fresh invitation, just like new devices.
  expect(await (await request("/bootstrap/enroll","POST",join)).json()).toMatchObject({state:"approved"});
  // Use a test-only injected credential on this real DO to exercise disclosure
  // rules. Restore local mode before the next request/suite.
  await runInDurableObject(stub(), instance => Object.assign((instance as any).env, {LOCAL_DEV:"false", AGENT_ACCESS_CLIENT_ID:"test-service-id", AGENT_ACCESS_CLIENT_SECRET:"test-service-secret"}));
  try {
    const response = await worker.fetch(new Request("https://127.0.0.1/bootstrap/status", {method:"POST",headers}),env);
    const credentials = new Response(await response.arrayBuffer(), {status:response.status,headers:response.headers});
    expect(credentials.headers.get("Cache-Control")).toBe("no-store");
    expect(await credentials.json()).toMatchObject({state:"approved",access:{client_id:"test-service-id",client_secret:"test-service-secret"}});
  } finally { await runInDurableObject(stub(), instance => { (instance as any).env.LOCAL_DEV = "true"; }); }
  const panel = await (await request("/api/state","GET")).text();
  expect(panel).not.toContain("test-service-secret"); expect(panel).not.toContain(key);
  const production = {...env, LOCAL_DEV:"false", ACCESS_TEAM_DOMAIN:"https://test.cloudflareaccess.com", ACCESS_AGENT_AUD:"agent-aud"};
  expect((await worker.fetch(new Request("https://monitor.example.com/v1/live",{headers:{Upgrade:"websocket",...headers,"X-Monitor-Role":"bootstrap"}}),production)).status).toBe(401);
  expect((await worker.fetch(new Request("http://monitor.example.com/bootstrap/status",{method:"POST",headers}),production)).status).toBe(400);
  await request(`/api/nodes/${id}`,"DELETE");
  expect((await request("/bootstrap/status","POST",undefined,headers)).status).toBe(403);
  expect(await (await request("/bootstrap/enroll","POST",join)).json()).toMatchObject({state:"approved"});
});

it("persists panel-assigned nicknames through rejoin and hibernation", async () => {
  const join={protocol:1,node_id:id,device_key:key,group:env.MONITOR_GROUP,host};
  await request("/bootstrap/enroll","POST",join);
  expect((await request(`/api/nodes/${id}`,"PATCH",{nickname:"机房一号"})).status).toBe(200);
  await evictDurableObject(stub());
  await request("/bootstrap/enroll","POST",{...join,name:"overwritten-by-client"});
  const panel = await (await request("/api/state","GET")).json() as any;
  expect(panel.nodes[0]).toMatchObject({name:"机房一号",nickname:"机房一号"});
  await request(`/api/nodes/${id}`,"PATCH",{nickname:""});
  expect((await (await request("/api/state","GET")).json() as any).nodes[0].name).toBe(host.hostname);
});

it("limits public enrollment to five per IP without consuming the 120 approval polls", async () => {
  const production = { ...env, LOCAL_DEV: "false", INVITATION_SECRET:"local-development-invitations-only" };
  const address = "2001:db8:" + crypto.randomUUID().replace(/-/g, "").slice(0, 24).match(/.{4}/g)!.join(":");
  async function bootstrap(path: string, body?: unknown, device = {}) {
    const response = await worker.fetch(new Request("https://monitor.example.com" + path, {
      method: "POST", headers: { ...(path.endsWith("/enroll") ? await invitationHeaders() : {}), "CF-Connecting-IP": address, "Content-Type": "application/json", ...device },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), production);
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  }
  for (let index = 0; index < 5; index++) {
    const node = index === 0 ? id : index.toString(16).padStart(32, "0");
    expect((await bootstrap("/bootstrap/enroll", { protocol: 1, node_id: node, device_key: key, group: env.MONITOR_GROUP, host })).status).toBe(200);
  }
  expect((await bootstrap("/bootstrap/enroll", { protocol: 1, node_id: "9".repeat(32), device_key: key, group: env.MONITOR_GROUP, host })).status).toBe(429);
  for (let index = 0; index < 120; index++) expect((await bootstrap("/bootstrap/status", undefined, headers)).status).toBe(200);
  expect((await bootstrap("/bootstrap/status", undefined, headers)).status).toBe(429);
  const panel = await (await request("/api/state", "GET")).json() as any;
  expect(panel.nodes).toHaveLength(5);
});

async function gzip(value: string) {
  const bytes = new TextEncoder().encode(value);
  const source = new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}});
  return new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}
it("decodes gzip in Workers and bounds inflated data and corrupt streams", async () => {
  const raw=JSON.stringify({cpu:12,memory:16777216,interfaces:Array(16).fill("eth0")});
  expect(await decodeMessage(await gzip(raw))).toBe(raw);
  expect(await decodeMessage(raw)).toBe(raw);
  await expect(decodeMessage(await gzip("a".repeat(32769)))).rejects.toThrow("message_too_large");
  await expect(decodeMessage(new Uint8Array(100).buffer)).rejects.toThrow("invalid_compression");
  const corrupt = new Uint8Array(await gzip(raw)); corrupt[corrupt.length-8] ^= 1;
  await expect(decodeMessage(corrupt.buffer)).rejects.toThrow();
});
