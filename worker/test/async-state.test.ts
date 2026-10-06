import { invitationHeaders } from "./invitation-fixture";
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import worker from "../src/index";

const origin = "http://127.0.0.1", id = "d".repeat(32), key = "e".repeat(64);
const host = { hostname: "gzip-node", os: "linux", arch: "arm", cpus: 1, agent_version: "0.3.0" };
const clients = new Set<WebSocket>();
const stub = () => env.MONITOR.getByName(env.MONITOR_GROUP);
async function request(path: string, method = "GET", body?: unknown, extra = {}) {
  const response = await worker.fetch(new Request(origin + (path.startsWith("/api/") ? "/panel" + path : path), { method, headers: { ...(path.endsWith("/enroll") ? await invitationHeaders() : {}), Origin: origin, "Content-Type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  if (response.status === 101) return response;
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
}
function receive(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.removeEventListener("message", listener); reject(new Error("waiting for " + type)); }, 5000);
    const listener = (event: MessageEvent) => {
      const body = JSON.parse(event.data as string);
      if (body.type === type) { clearTimeout(timeout); ws.removeEventListener("message", listener); resolve(body); }
    };
    ws.addEventListener("message", listener);
  });
}
async function socket(path: string, headers = {}) {
  const response = await request(path, "GET", undefined, { Upgrade: "websocket", ...headers });
  expect(response.status).toBe(101);
  const ws = response.webSocket!; clients.add(ws); ws.accept(); return ws;
}
async function reportBytes() {
  const report = { protocol: 1, node_id: id, session: "f".repeat(32), sequence: 1, host, metrics: { time: new Date().toISOString(), cpu_percent: 12 } };
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}
afterEach(async () => { for (const ws of clients) { try { ws.close(1000); } catch {} } clients.clear(); await reset(); });

it.each([{ entering: true, action: "joins" }, { entering: false, action: "leaves" }])("keeps the current reporting interval when a viewer $action during gzip decoding", async ({ entering }) => {
  await request("/bootstrap/enroll", "POST", { protocol: 1, node_id: id, device_key: key, group: env.MONITOR_GROUP, host });
  const agent = await socket("/v1/live", { "X-Monitor-Node-ID": id, Authorization: "Bearer " + key });
  expect((await receive(agent, "config")).interval_seconds).toBe(600);
  if (!entering) { const active = receive(agent, "config"); await socket("/api/live"); expect((await active).interval_seconds).toBe(5); }
  const compressed = await reportBytes(), acknowledged = receive(agent, "ack");
  const interval = await runInDurableObject(stub(), async (instance, ctx) => {
    const agentSocket = ctx.getWebSockets("agent")[0];
    // The handler reaches its first decompression read before returning this
    // promise. Change viewer membership while that read is still suspended.
    const decoding = instance.webSocketMessage(agentSocket, compressed);
    let changing: Promise<unknown>;
    if (entering) {
      changing = instance.fetch(new Request(origin + "/api/live", { headers: { Upgrade: "websocket", "X-Monitor-Role": "admin", "X-Monitor-Auth-Expires": String(Date.now() + 86400_000) } })).then(response => {
        expect(response.status).toBe(101); const viewer = response.webSocket!; clients.add(viewer); viewer.accept();
      });
    } else changing = instance.webSocketClose(ctx.getWebSockets("viewer")[0]);
    await Promise.all([decoding, changing]);
    return (agentSocket.deserializeAttachment() as { interval: number }).interval;
  });
  await acknowledged;
  expect(interval).toBe(entering ? 5 : 600);
  const state = await (await request("/api/state")).json() as any;
  expect(state.usage.today.fast_messages).toBe(entering ? 1 : 0);
  expect(state.usage.today.idle_messages).toBe(entering ? 0 : 1);
});

it.each(["deleted","checkpoint"])("does not restore stale socket state after alarm scheduling (%s)",async(action)=>{
  await request("/bootstrap/enroll","POST",{protocol:1,node_id:id,device_key:key,group:env.MONITOR_GROUP,host});
  const client=await socket("/v1/live",{"X-Monitor-Node-ID":id,Authorization:"Bearer "+key});
  await receive(client,"config");
  const result=await runInDurableObject(stub(),async(instance,ctx)=>{
    const server=ctx.getWebSockets("agent")[0],original=Reflect.get(instance,"ensureAlarm") as ()=>Promise<void>;
    Reflect.set(instance,"ensureAlarm",async()=>{
      await original.call(instance);
      // Reproduce a state change at the storage await boundary.
      if(action==="deleted")Reflect.get(instance,"removeDevice").call(instance,id);
      else Reflect.get(instance,"flushUsage").call(instance);
    });
    try{
      await instance.webSocketMessage(server,JSON.stringify({protocol:1,node_id:id,session:"f".repeat(32),sequence:1,host,metrics:{time:new Date().toISOString(),cpu_percent:12}}));
      return {attachment:server.deserializeAttachment(),epoch:Reflect.get(instance,"runtime").epoch,
        live:Reflect.get(instance,"latest").has(id),nodes:ctx.storage.sql.exec("SELECT count(*) AS n FROM nodes WHERE node_id=?",id).one().n};
    }finally{Reflect.set(instance,"ensureAlarm",original);}
  });
  expect(result.attachment.epoch).toBe(result.epoch);
  if(action==="deleted"){
    expect(result.attachment.closed).toBe(true);expect(result.live).toBe(false);expect(result.nodes).toBe(0);
  }else{
    expect(result.live).toBe(true);expect(result.nodes).toBe(1);expect(result.attachment.sequence).toBe(1);
  }
});
