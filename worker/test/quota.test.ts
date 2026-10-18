import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { localQuota } from "../src/quota";
import type { ActiveDuration } from "../src/active-duration";
import type { QuotaSnapshot } from "../src/quota-model";
import { emptyCounts, hourOf, type Counts } from "../src/usage";

const origin = "http://127.0.0.1", clients = new Set<WebSocket>();
const stub = () => env.MONITOR.getByName(env.MONITOR_GROUP);
const value = (snapshot: QuotaSnapshot, id: string) => snapshot.rows.find(row => row.id === id)!.value;
async function get() {
  const response = await worker.fetch(new Request(origin+"/panel/api/quota"), env);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return await response.json() as QuotaSnapshot;
}
async function resetCounters() {
  await runInDurableObject(stub(), (instance, ctx) => {
    ctx.storage.sql.exec("DELETE FROM usage");
    const runtime = Reflect.get(instance, "runtime");
    runtime.checkpoint = Date.now();
    ctx.storage.sql.exec("UPDATE config SET value=? WHERE id=2",JSON.stringify(runtime));
    (Reflect.get(instance, "pending") as Map<number,Counts>).clear();
  });
}
afterEach(async () => { for(const client of clients){try{client.close(1000);}catch{}}clients.clear();vi.restoreAllMocks();await reset(); });

it("reports raw inbound events, including HTTP, connections and alarms, without a billing conversion", () => {
  const data=localQuota({...emptyCounts(),connections:100,http_requests:900,fast_messages:15000,idle_messages:4900,other_messages:100,alarms:50,viewer_connections:50,handler_ms:90000},12345);
  expect(value(data,"do_requests")).toBe(21050);
  expect(value(data,"workers")).toBe(1000);
  expect(value(data,"storage")).toBe(12345);
  expect(value(data,"duration")).toBeCloseTo(11.52);
  expect(data.rows.every(row=>row.scope==="network")).toBe(true);
  expect(data.rows.find(row=>row.id==="do_requests")).toMatchObject({name:"DO 请求（实际）",limit:null});
  expect(data.source).toBe("local");
});
it.each([0,1,19,20,21,20000])("counts every one of %s messages as an actual event", messages => {
  const data=localQuota({...emptyCounts(),fast_messages:messages},0);
  expect(value(data,"do_requests")).toBe(messages);
});

it("never calls external Analytics, even with legacy credentials and a stale account snapshot", async () => {
  await runInDurableObject(stub(),(instance,ctx)=>{
    Reflect.set(instance,"env",{...Reflect.get(instance,"env"),CF_ANALYTICS_ACCOUNT_ID:"a".repeat(32),CF_ANALYTICS_API_TOKEN:"obsolete-token"});
    ctx.storage.sql.exec("INSERT INTO config(id,value) VALUES (8,?)",JSON.stringify({snapshot:{source:"cloudflare",rows:[{id:"do_requests",value:99999}]}}));
  });
  const upstream=vi.spyOn(globalThis,"fetch");
  const data=await get();
  expect(data.status).toBe("recorded");expect(value(data,"do_requests")).not.toBeNull();
  expect(value(data,"do_requests")).not.toBe(99999);expect(value(data,"storage")).toBeGreaterThan(0);
  expect(upstream).not.toHaveBeenCalled();expect(JSON.stringify(data)).not.toContain("obsolete-token");
});

it("merges today's persisted and pending counts without flushing or including yesterday or future buckets", async () => {
  const response=await worker.fetch(new Request(origin+"/panel/api/live",{headers:{Upgrade:"websocket",Origin:origin}}),env);
  const client=response.webSocket!;clients.add(client);client.accept();
  await resetCounters();
  await runInDurableObject(stub(),(instance,ctx)=>{
    const hour=hourOf(Date.now()),first=Math.floor(hour/24)*24;
    ctx.storage.sql.exec("INSERT INTO usage(hour,fast_messages,http_requests) VALUES (?,?,?)",hour,14000,700);
    ctx.storage.sql.exec("INSERT INTO usage(hour,fast_messages,http_requests) VALUES (?,?,?)",first-1,100000,100000);
    ctx.storage.sql.exec("INSERT INTO usage(hour,fast_messages,http_requests) VALUES (?,?,?)",hour+1,100000,100000);
    const pending=Reflect.get(instance,"pending") as Map<number,Counts>;
    pending.set(hour,{...emptyCounts(),idle_messages:6000,http_requests:300});
    pending.set(first-1,{...emptyCounts(),other_messages:100000});
  });
  const before=await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec<{value:string}>("SELECT value FROM config WHERE id=2").one().value);
  const first=await get(),second=await get();
  expect(value(first,"do_requests")).toBe(21001);expect(value(second,"do_requests")).toBe(21002);
  expect(first.day).toBe(new Date().toISOString().slice(0,10));
  const after=await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec<{value:string}>("SELECT value FROM config WHERE id=2").one().value);
  expect(after).toBe(before);
});

it("preserves uncheckpointed WebSocket usage through hibernation without counting it again after a checkpoint", async () => {
  const response=await worker.fetch(new Request(origin+"/panel/api/live",{headers:{Upgrade:"websocket",Origin:origin}}),env);
  expect(response.status).toBe(101);const client=response.webSocket!;clients.add(client);client.accept();
  await resetCounters();
  await runInDurableObject(stub(),(instance,ctx)=>{
    const hour=hourOf(Date.now());
    ctx.storage.sql.exec("INSERT INTO usage(hour,fast_messages) VALUES (?,40)",hour);
    const socket=ctx.getWebSockets()[0],attachment=socket.deserializeAttachment();
    attachment.hour=hour;attachment.epoch=Reflect.get(instance,"runtime").epoch;
    attachment.pending={...emptyCounts(),fast_messages:60,idle_messages:100,other_messages:20};
    socket.serializeAttachment(attachment);
  });
  const messages=(data:QuotaSnapshot)=>value(data,"do_requests")!-value(data,"workers")!;
  expect(messages(await get())).toBe(220);
  await evictDurableObject(stub());
  expect(messages(await get())).toBe(220);
  const state=await worker.fetch(new Request(origin+"/panel/api/state"),env);await state.arrayBuffer();
  expect(messages(await get())).toBe(220);
  await evictDurableObject(stub());expect(messages(await get())).toBe(220);
});

it("does not reuse an attachment from a previous persisted epoch", async () => {
  const response=await worker.fetch(new Request(origin+"/panel/api/live",{headers:{Upgrade:"websocket",Origin:origin}}),env);
  const client=response.webSocket!;clients.add(client);client.accept();await resetCounters();
  await runInDurableObject(stub(),(instance,ctx)=>{
    const hour=hourOf(Date.now());ctx.storage.sql.exec("INSERT INTO usage(hour,fast_messages) VALUES (?,100)",hour);
    const socket=ctx.getWebSockets()[0],attachment=socket.deserializeAttachment();
    attachment.epoch=Reflect.get(instance,"runtime").epoch-1;attachment.hour=hour;
    attachment.pending={...emptyCounts(),fast_messages:100};socket.serializeAttachment(attachment);
  });
  const data=await get();expect(value(data,"do_requests")!-value(data,"workers")!).toBe(100);
});

it("retains read-only HTTP requests without a WebSocket through consecutive hibernations", async () => {
  await resetCounters();
  for(let request=1;request<=3;request++) {
    const data=await get();
    expect(value(data,"workers")).toBe(request);
    expect(value(data,"do_requests")).toBe(request);
    await evictDurableObject(stub());
  }
});

it("counts rejected upgrades and expired requests once even when no socket can retain counters", async () => {
  await resetCounters();
  for(const test of [
    {path:"/api/live",upgrade:true,expires:Date.now()-1000},
    {path:"/api/unknown",upgrade:true,expires:Date.now()+60000},
    {path:"/api/state",upgrade:false,expires:Date.now()-1000},
  ]) {
    const response=await stub().fetch(new Request(origin+test.path,{headers:{
      "X-Monitor-Role":"admin","X-Monitor-Auth-Expires":String(test.expires),
      ...(test.upgrade?{Upgrade:"websocket"}:{}),
    }}));
    expect(response.status).toBe(test.expires<Date.now()?401:404);
    await response.arrayBuffer();
    await evictDurableObject(stub());
  }
  const data=await get();
  expect(value(data,"workers")).toBe(4);
  expect(value(data,"do_requests")).toBe(4);
});

it("counts a successful WebSocket upgrade exactly once, without an additional HTTP request", async () => {
  await resetCounters();
  const response=await worker.fetch(new Request(origin+"/panel/api/live",{headers:{Upgrade:"websocket",Origin:origin}}),env);
  expect(response.status).toBe(101);
  const client=response.webSocket!;clients.add(client);client.accept();
  await evictDurableObject(stub());
  const data=await get();
  expect(value(data,"workers")).toBe(2);
  expect(value(data,"do_requests")).toBe(2);
});

it("counts application heartbeats and expired-session messages, but not outbound replies", async () => {
  await resetCounters();
  const response=await worker.fetch(new Request(origin+"/panel/api/live",{headers:{Upgrade:"websocket",Origin:origin}}),env);
  const client=response.webSocket!;clients.add(client);client.accept();
  await runInDurableObject(stub(),async(instance,ctx)=>{
    await instance.webSocketMessage(ctx.getWebSockets("viewer")[0],JSON.stringify({type:"heartbeat"}));
  });
  const before=await get();
  expect(value(before,"workers")).toBe(2);
  expect(value(before,"do_requests")).toBe(3);
  await runInDurableObject(stub(),async(instance,ctx)=>{
    const socket=ctx.getWebSockets("viewer")[0],attachment=socket.deserializeAttachment();
    attachment.authExpires=Date.now()-1000;socket.serializeAttachment(attachment);
    await instance.webSocketMessage(socket,JSON.stringify({type:"heartbeat"}));
  });
  const after=await get();
  expect(value(after,"workers")).toBe(3);
  expect(value(after,"do_requests")).toBe(5);
});

it("retains admin authorization for the local usage endpoint", async () => {
  const upstream=vi.spyOn(globalThis,"fetch");
  const response=await worker.fetch(new Request("https://monitor.example.com/panel/api/quota"),{...env,LOCAL_DEV:"false"});
  expect(response.ok).toBe(false);expect(upstream).not.toHaveBeenCalled();
});

it("shows SQLite read, write and storage usage as separate quota rows",()=>{
  const data=localQuota({...emptyCounts(),sql_read:127,sql_written:31},8192);
  expect(value(data,"reads")).toBe(127);expect(value(data,"writes")).toBe(31);expect(value(data,"storage")).toBe(8192);
  expect(data.rows.filter(row=>row.name.startsWith("SQLite")).map(row=>[row.id,row.limit,row.unit,row.period])).toEqual([
    ["writes",100000,"行","day"],["reads",5000000,"行","day"],["storage",1000000000,"bytes","storage"],
  ]);
});

it("includes ongoing union duration in a quota read without counting overlapping work twice", async () => {
  await resetCounters();
  const data = await runInDurableObject(stub(), instance => {
    const duration = Reflect.get(instance,"duration") as ActiveDuration, now=Date.now();
    duration.begin(now-2000);duration.begin(now-1000);
    try { return (Reflect.get(instance,"readQuota") as ()=>QuotaSnapshot).call(instance); }
    finally { duration.end(now);duration.end(now); }
  });
  expect(value(data,"duration")).toBeCloseTo(.256,3);
});
