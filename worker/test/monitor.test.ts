import { invitationHeaders } from "./invitation-fixture";
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { DEFAULT_SETTINGS, hash, VIEW_LEASE_MS } from "../src/model";
import { emptyCounts, forecast, hourOf, splitSpan } from "../src/usage";

const origin = "http://127.0.0.1";
const host = { hostname: "test-node", os: "linux", arch: "arm", cpus: 1, agent_version: "0.2.0" };
const id = "1".repeat(32), key = "2".repeat(64);
const clients = new Set<WebSocket>();
const stub = () => env.MONITOR.getByName(env.MONITOR_GROUP);
async function request(path: string, method = "GET", body?: unknown, headers?: HeadersInit) {
  const response = await worker.fetch(new Request(origin + path, { method, headers: { ...(path.endsWith("/enroll") ? await invitationHeaders() : {}), Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }), env);
  // Consume the DO response before eviction; an unread response keeps its
  // original request in flight, which a graceful eviction must wait for.
  if (response.status === 101) return response;
  return new Response(await response.arrayBuffer(), {status:response.status,headers:response.headers});
}
function deviceHeaders() { return { "X-Monitor-Node-ID": id, Authorization: "Bearer " + key }; }
function receive(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.removeEventListener("message", listener); reject(new Error("waiting for " + type)); }, 5000);
    const listener = (e: MessageEvent) => { const body = JSON.parse(e.data as string); if (body.type === type) { clearTimeout(timeout); ws.removeEventListener("message", listener); resolve(body); } };
    ws.addEventListener("message", listener);
  });
}
async function socket(path: string, headers?: Record<string,string>) {
  const r = await request(path, "GET", undefined, { Upgrade: "websocket", ...headers });
  expect(r.status).toBe(101); const ws=r.webSocket!; clients.add(ws); ws.accept(); return ws;
}
async function enroll(approved = true) {
  const r=await request("/v1/enroll","POST",{protocol:1,node_id:id,device_key:key,group:env.MONITOR_GROUP,host});
  expect((await r.json() as any).state).toBe("approved");
  // Existing installations can still contain legacy pending records.
  if(!approved)await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("UPDATE nodes SET state='pending' WHERE node_id=?",id));
}
afterEach(async () => { for(const ws of clients) { try { ws.close(1000); } catch {} } clients.clear(); await reset(); });

describe("monitor contracts in the Workers runtime", () => {
  it("persists configurable intervals across an actual eviction and rejects unsafe values", async () => {
    expect((await request("/api/settings","PUT",{active_seconds:7,idle_seconds:900})).ok).toBe(true);
    await evictDurableObject(stub());
    const state=await (await request("/api/state")).json() as any;
    expect(state.settings).toMatchObject({active_seconds:7,idle_seconds:900,version:2});
    expect((await request("/api/settings","PUT",{active_seconds:0,idle_seconds:30})).status).toBe(400);
  });
  it("keeps legacy pending records blocked and device credentials private", async () => {
    await enroll(false);
    expect((await request("/v1/live","GET",undefined,{Upgrade:"websocket",...deviceHeaders()})).status).toBe(403);
    expect((await request("/v1/enroll","POST",{protocol:1,node_id:id,device_key:"3".repeat(64),group:env.MONITOR_GROUP,host})).status).toBe(409);
    expect((await request("/v1/enroll","POST",{protocol:1,node_id:"3".repeat(32),device_key:key,group:"missing-network",host})).status).toBe(404);
    expect((await request("/v1/enroll","POST",{protocol:1,node_id:id,device_key:key,group:env.MONITOR_GROUP,host})).status).toBe(200);
    const text=await (await request("/api/state")).text(); expect(text).not.toContain(key);expect(text).not.toContain(await hash(key));
    expect((await request(`/v1/nodes/${id}/status`)).status).toBe(401);
    expect((await request("/api/tickets","POST")).status).toBe(404);
  });
  it("retains approval through eviction, reconnect, local leave and repeated joins", async () => {
    await enroll();await evictDurableObject(stub());
    const join=()=>request("/v1/enroll","POST",{protocol:1,node_id:id,device_key:key,group:env.MONITOR_GROUP,host});
    expect(await (await join()).json()).toMatchObject({state:"approved"});
    const first=await socket("/v1/live",deviceHeaders());await receive(first,"config");first.close(1000);
    expect(await (await request(`/v1/nodes/${id}`,"DELETE",undefined,deviceHeaders())).json()).toMatchObject({state:"approved"});
    await evictDurableObject(stub());
    expect(await (await join()).json()).toMatchObject({state:"approved"});
    expect((await (await request("/api/state")).json() as any).nodes).toHaveLength(1);
    const second=await socket("/v1/live",deviceHeaders());expect((await receive(second,"config")).state).toBe("approved");
  });
  it("switches all agents when first/last viewers change, including hibernated sockets", async () => {
    await enroll();const agent=await socket("/v1/live",deviceHeaders());
    expect((await receive(agent,"config")).interval_seconds).toBe(600);
    const active=receive(agent,"config"),first=await socket("/api/live");expect((await active).interval_seconds).toBe(5);
    const second=await socket("/api/live");await evictDurableObject(stub());
    first.close(1000);const state=await (await request("/api/state")).json() as any;expect(state.viewers).toBe(1);
    const idle=receive(agent,"config");second.close(1000);expect((await idle).interval_seconds).toBe(600);
    const changed=receive(agent,"config");await request("/api/settings","PUT",{active_seconds:8,idle_seconds:1200});expect((await changed).interval_seconds).toBe(1200);
  });
  it("expires abandoned viewers by alarm and restores low-frequency reporting", async () => {
    await enroll();const agent=await socket("/v1/live",deviceHeaders());await receive(agent,"config");
    const active=receive(agent,"config");await socket("/api/live");await active;
    await runInDurableObject(stub(),(_,ctx)=>{for(const ws of ctx.getWebSockets("viewer")){const a=ws.deserializeAttachment() as any;a.expires=Date.now()-1;ws.serializeAttachment(a);}});
    const idle=receive(agent,"config");expect(await runDurableObjectAlarm(stub())).toBe(true);expect((await idle).interval_seconds).toBe(600);
  });
  it("keeps report counters through hibernation without writing every metrics frame", async () => {
    await enroll();const agent=await socket("/v1/live",deviceHeaders());await receive(agent,"config");
    const report={protocol:1,node_id:id,session:"4".repeat(32),sequence:1,host,metrics:{time:new Date().toISOString(),cpu_percent:12,memory:{total_bytes:100,used_bytes:50}}};
    const ack=receive(agent,"ack");agent.send(JSON.stringify(report));await ack;
    const checkpoint=await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT last_seen,latest FROM nodes WHERE node_id=?",id).one());
    expect(checkpoint.last_seen).toBeGreaterThan(0);
    expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT count(*) AS n FROM history_batches").one().n)).toBe(0);
    await evictDurableObject(stub());
    await runInDurableObject(stub(),(_,ctx)=>{for(const ws of ctx.getWebSockets("agent")){const a=ws.deserializeAttachment() as any;a.lastReport=Date.now()-601000;ws.serializeAttachment(a);}});
    const next=receive(agent,"ack");agent.send(JSON.stringify({...report,sequence:2}));await next;
    const state=await (await request("/api/state")).json() as any;expect(state.usage.today.idle_messages).toBe(2);
    expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT last_seen,latest FROM nodes WHERE node_id=?",id).one())).toEqual(checkpoint);
    expect(state.nodes[0].metrics.cpu_percent).toBe(12);
  });
  it("counts overlapping viewing sessions once and restores extended leases after hibernation", async () => {
    await socket("/api/live");await socket("/api/live");
    await runInDurableObject(stub(),(_,ctx)=>{
      const r=JSON.parse(ctx.storage.sql.exec<{value:string}>("SELECT value FROM config WHERE id=2").one().value);
      r.viewCursor=Date.now()-10000;r.viewExpires=Date.now()-5000;
      ctx.storage.sql.exec("UPDATE config SET value=? WHERE id=2",JSON.stringify(r));
      for(const ws of ctx.getWebSockets("viewer")){const a=ws.deserializeAttachment() as any;a.expires=Date.now()+VIEW_LEASE_MS;ws.serializeAttachment(a);}
    });await evictDurableObject(stub());
    const state=await (await request("/api/state")).json() as any;
    expect(state.usage.today.view_seconds).toBeGreaterThanOrEqual(10);expect(state.usage.today.view_seconds).toBeLessThan(15);
  });
  it("deletes membership, stops a connected device and requires a fresh invitation for the same identity", async()=>{
    await enroll();const agent=await socket("/v1/live",deviceHeaders());await receive(agent,"config");
    const ack=receive(agent,"ack");agent.send(JSON.stringify({protocol:1,node_id:id,session:"4".repeat(32),sequence:1,host,metrics:{time:new Date().toISOString(),cpu_percent:10}}));await ack;
    const group=await (await request("/api/node-groups","POST",{name:"机房"})).json() as any;
    await request("/api/nodes/groups","PUT",{node_ids:[id],group_id:group.id});
    const revoked=receive(agent,"revoked");await request(`/api/nodes/${id}`,"DELETE");expect((await revoked).state).toBe("revoked");
    expect((await (await request("/api/state")).json() as any).nodes).toHaveLength(0);
    expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT count(*) AS n FROM history_batches").one().n)).toBe(0);
    expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT count(*) AS n FROM node_group_members").one().n)).toBe(0);
    expect((await request(`/v1/nodes/${id}/status`,"GET",undefined,deviceHeaders())).status).toBe(403);
    expect((await request(`/api/nodes/${id}/approve`,"POST")).status).toBe(404);
    await evictDurableObject(stub());await enroll();
    const rejoined=await socket("/v1/live",deviceHeaders());expect((await receive(rejoined,"config")).state).toBe("approved");
  });
  it("persists batch groups, renames them and removes labels without changing approval", async()=>{
    await enroll();const other="3".repeat(32);
    await request("/v1/enroll","POST",{protocol:1,node_id:other,device_key:key,group:env.MONITOR_GROUP,host});
    const group=await (await request("/api/node-groups","POST",{name:"家用设备"})).json() as any;
    expect((await request("/api/node-groups","POST",{name:"家用设备"})).status).toBe(409);
    expect((await request("/api/node-groups","POST",{name:"\n"})).status).toBe(400);
    expect((await request("/api/nodes/groups","PUT",{node_ids:[id,"f".repeat(32)],group_id:group.id})).status).toBe(404);
    expect((await (await request("/api/state")).json() as any).nodes.every((n:any)=>n.group_id===null)).toBe(true);
    expect(await (await request("/api/nodes/groups","PUT",{node_ids:[id,other,id],group_id:group.id})).json()).toMatchObject({changed:2});
    await evictDurableObject(stub());
    const saved=await (await request("/api/state")).json() as any;expect(saved.node_groups).toEqual([group]);expect(saved.nodes.every((n:any)=>n.group_id===group.id)).toBe(true);
    expect(saved.nodes.find((n:any)=>n.node_id===id).state).toBe("approved");expect(saved.nodes.find((n:any)=>n.node_id===other).state).toBe("approved");
    await request(`/api/node-groups/${group.id}`,"PUT",{name:"家庭"});await evictDurableObject(stub());
    expect((await (await request("/api/state")).json() as any).node_groups[0].name).toBe("家庭");
    await request(`/api/node-groups/${group.id}`,"DELETE");await evictDurableObject(stub());
    const removed=await (await request("/api/state")).json() as any;expect(removed.node_groups).toEqual([]);expect(removed.nodes.every((n:any)=>n.group_id===null)).toBe(true);
    expect((await (await request(`/v1/nodes/${id}/status`,"GET",undefined,deviceHeaders())).json() as any).state).toBe("approved");
  });
  it("rejects cross-origin panel mutation and WebSocket connections",async()=>{
    expect((await request("/api/settings","PUT",{active_seconds:5,idle_seconds:600},{Origin:"https://attacker.invalid"})).status).toBe(403);
    expect((await request("/api/live","GET",undefined,{Upgrade:"websocket",Origin:"https://attacker.invalid"})).status).toBe(403);
    expect((await worker.fetch(new Request("https://public.invalid/api/state"),env)).status).toBe(403);
  });
  it("coordinates twenty independent agents and pushes a live report for every device",async()=>{
    const agents:WebSocket[]=[];
    for(let i=0;i<20;i++){
      const node=(i+10).toString(16).padStart(32,"0"),secret=(i+10).toString(16).padStart(64,"0");
      expect((await request("/v1/enroll","POST",{protocol:1,node_id:node,device_key:secret,group:env.MONITOR_GROUP,host})).ok).toBe(true);
      const agent=await socket("/v1/live",{"X-Monitor-Node-ID":node,Authorization:"Bearer "+secret});
      expect((await receive(agent,"config")).interval_seconds).toBe(600);agents.push(agent);
    }
    const active=agents.map(a=>receive(a,"config")),viewer=await socket("/api/live");
    expect((await Promise.all(active)).every(c=>c.interval_seconds===5)).toBe(true);
    for(let i=0;i<20;i++){
      const ack=receive(agents[i],"ack"),pushed=receive(viewer,"metrics");
      agents[i].send(JSON.stringify({protocol:1,node_id:(i+10).toString(16).padStart(32,"0"),session:"a".repeat(32),sequence:1,host,metrics:{time:new Date().toISOString(),cpu_percent:i}}));
      await ack;expect((await pushed).metrics.cpu_percent).toBe(i);
    }
    const state=await (await request("/api/state")).json() as any;
    expect(state.nodes.filter((n:any)=>n.connected)).toHaveLength(20);expect(state.usage.today.fast_messages).toBe(20);
    const idle=agents.map(a=>receive(a,"config"));viewer.close(1000);expect((await Promise.all(idle)).every(c=>c.interval_seconds===600)).toBe(true);
  });
  it("forecasts from durable seven-day history and previews intervals without changing them",async()=>{
    await request("/api/state");
    await runInDurableObject(stub(),(_,ctx)=>{
      const created=Date.now()-7*86400_000;
      const runtime=JSON.parse(ctx.storage.sql.exec<{value:string}>("SELECT value FROM config WHERE id=2").one().value);
      runtime.created=created;ctx.storage.sql.exec("UPDATE config SET value=? WHERE id=2",JSON.stringify(runtime));
      for(let day=0;day<7;day++)ctx.storage.sql.exec("INSERT OR REPLACE INTO usage (hour,view_seconds,device_seconds,connections,http_requests,other_messages,sql_written) VALUES (?,?,?,?,?,?,?)",hourOf(created+day*86400_000),3600,20*86400,40,60,120,7000);
    });await evictDurableObject(stub());
    const saved=await (await request("/api/state?days=30&devices=20")).json() as any;
    const preview=await (await request("/api/state?days=30&devices=20&active=10&idle=600")).json() as any;
    expect(saved.forecast.confidence).toBe("long_term");expect(saved.forecast.viewing_hours_per_day).toBeCloseTo(1,2);
    expect(preview.forecast.messages_per_day).toBeLessThan(saved.forecast.messages_per_day);
    expect(preview.settings.active_seconds).toBe(5);expect(preview.forecast.sql_written_per_day).toBeGreaterThanOrEqual(7000);
  });
});

describe("quota forecasting",()=>{
  it("does not amplify viewer and administration costs from a few seconds of agent exposure",()=>{
    const c=emptyCounts();Object.assign(c,{view_seconds:3600,device_seconds:35,connections:10,viewer_connections:5,http_requests:20,sql_written:20,sql_read:30});
    const f=forecast(DEFAULT_SETTINGS,20,[{hour:0,...c}],7200,4096);
    expect(f.cost_basis).toBe("limited_device_exposure");expect(f.sql_written_per_day).toBeLessThan(10000);expect(f.sql_read_per_day).toBe(360);
    expect(f.worker_requests_per_day).toBeLessThan(1000);
    const baseline=emptyCounts();Object.assign(baseline,{device_seconds:86400,connections:12,viewer_connections:10});
    const fleet=forecast(DEFAULT_SETTINGS,20,[{hour:0,...baseline}],86400,4096);
    expect(fleet.worker_requests_per_day).toBe(80); // 2 agent connections x20 +10 viewers +30 asset requests.
  });
  it("uses measured viewing history for changed intervals and separates frame billing from Worker requests",()=>{
    const c=emptyCounts();Object.assign(c,{view_seconds:3600,device_seconds:20*86400,connections:40,http_requests:60,other_messages:120,alarms:40});
    const f=forecast(DEFAULT_SETTINGS,20,[{hour:0,...c}],86400,4096);
    expect(f.messages_per_day).toBe(17160);expect(f.do_requests_per_day).toBe(1108);expect(f.worker_requests_per_day).toBe(100);
    expect(forecast({...DEFAULT_SETTINGS,active_seconds:10},20,[{hour:0,...c}],86400,4096).messages_per_day).toBe(9960);
    expect(forecast(DEFAULT_SETTINGS,20,[{hour:0,...c}],7*86400,4096).confidence).toBe("long_term");
  });
  it("splits device and viewing exposure across UTC hours",()=>{
    const spans:number[]=[];splitSpan(3590000,3610000,(_,seconds)=>spans.push(seconds));expect(spans).toEqual([10,10]);
    expect(hourOf(3600000)).toBe(1);
  });
  it("bases history writes on the idle interval regardless of live viewing or sampling",()=>{
    const c=emptyCounts();Object.assign(c,{device_seconds:20*86400,alarms:0,connections:0,viewer_connections:0});
    const withoutViewer=forecast(DEFAULT_SETTINGS,20,[{hour:0,...c}],86400,4096);
    const withViewer=forecast({...DEFAULT_SETTINGS,active_seconds:2},20,[{hour:0,...c,view_seconds:86400}],86400,4096);
    expect(withViewer.sql_written_per_day).toBe(withoutViewer.sql_written_per_day);
    const fast=forecast({...DEFAULT_SETTINGS,idle_seconds:30},20,[{hour:0,...c}],86400,4096);
    const hourly=forecast({...DEFAULT_SETTINGS,idle_seconds:3600},20,[{hour:0,...c}],86400,4096);
    // Twenty latest rows plus batch, expiry, metadata and alarm overhead.
    expect(fast.sql_written_per_day-withoutViewer.sql_written_per_day).toBe((2880-144)*26);
    expect(withoutViewer.sql_written_per_day-hourly.sql_written_per_day).toBe((144-24)*26);
    expect(fast.sql_written_per_day).toBeLessThan(fast.limits.sql_written);
  });
});
