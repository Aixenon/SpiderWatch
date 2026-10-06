import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { BATCH_PREVIOUS, BATCH_SELECT, HISTORY_BATCH_MAX_BYTES, decodeHistoryBatch, encodeHistoryBatch, type HistoryBatch, type HistoryWindow, type ResourcePoint } from "../src/history";
import { hash, type Metrics } from "../src/model";
import { hourOf } from "../src/usage";

const origin="http://127.0.0.1",key="e".repeat(64),host={hostname:"batch-node",os:"linux",arch:"amd64",cpus:2,agent_version:"test"};
const stub=()=>env.MONITOR.getByName(env.MONITOR_GROUP),nodeID=(index:number)=>index.toString(16).padStart(32,"0"),clients=new Set<WebSocket>();
type HistoryResponse={points:ResourcePoint[];from:number;to:number;raw_points:number;resolution_seconds:number};
type Internal={historyWindow:HistoryWindow|null;flushHistory(now:number,force?:boolean):void};
async function request(path:string,method="GET",body?:unknown,headers:HeadersInit={}) {
  const response=await worker.fetch(new Request(origin+(path.startsWith("/api/") ? "/panel"+path : path),{method,headers:{Origin:origin,"Content-Type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)}),env);
  return response.status===101?response:new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
}
function receive(ws:WebSocket,type:string):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.removeEventListener("message",listener);reject(new Error(type));},5000);const listener=(event:MessageEvent)=>{const body=JSON.parse(event.data as string);if(body.type===type){clearTimeout(timer);ws.removeEventListener("message",listener);resolve(body);}};ws.addEventListener("message",listener);});
}
async function seed(count:number) {
  await request("/api/state?view=live");const digest=await hash(key);
  await runInDurableObject(stub(),(_,ctx)=>ctx.storage.transactionSync(()=>{for(let i=1;i<=count;i++)ctx.storage.sql.exec("INSERT INTO nodes(node_id,name,key_hash,state,host) VALUES(?,?,?,'approved',?)",nodeID(i),"batch-node-"+i,digest,JSON.stringify(host));}));
}
async function settings(interval:number) {expect((await request("/api/settings","PUT",{active_seconds:5,idle_seconds:interval})).status).toBe(200);}
async function agent(index:number) {
  const response=await request("/v1/live","GET",undefined,{Upgrade:"websocket","X-Monitor-Node-ID":nodeID(index),Authorization:"Bearer "+key});
  expect(response.status).toBe(101);const ws=response.webSocket!;clients.add(ws);ws.accept();await receive(ws,"config");return ws;
}
const report=(index:number,sequence:number,cpu:number)=>JSON.stringify({protocol:1,node_id:nodeID(index),session:index.toString(16).padStart(32,"a"),sequence,host,metrics:{time:new Date().toISOString(),cpu_percent:cpu}});
async function send(ws:WebSocket,index:number,sequence:number,cpu:number) {const ack=receive(ws,"ack");ws.send(report(index,sequence,cpu));await ack;}
async function samples() {
  return runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec<{codec:string;payload:ArrayBuffer}>("SELECT codec,payload FROM history_batches").toArray().flatMap(row=>decodeHistoryBatch(row.codec,row.payload).samples));
}
afterEach(async()=>{for(const ws of clients){try{ws.close(1000);}catch{}}clients.clear();vi.restoreAllMocks();await reset();});

it("writes one shared historical batch for fifty asynchronous durable checkpoints and measures SQL costs",async({annotate})=>{
  const start=Date.parse("2026-10-06T12:00:00Z"),clock=vi.spyOn(Date,"now").mockReturnValue(start);
  await seed(50);await settings(120);for(let i=1;i<=50;i++)await agent(i);
  const evidence=await runInDurableObject(stub(),async(instance,ctx)=>{
    const stale:HistoryBatch={version:1,samples:[[nodeID(1),start-604800_001,120,'{"cpu_percent":1}']]},encoded=encodeHistoryBatch(stale);
    ctx.storage.sql.exec("INSERT INTO history_batches(id,until,generation,codec,payload) VALUES(?,?,?,?,?)",start-604920_000,start-604800_001,"expired",encoded.codec,encoded.payload);
    const sockets=new Map(ctx.getWebSockets("agent").map(socket=>[(socket.deserializeAttachment() as {id:string}).id,socket]));
    const sql=vi.spyOn(ctx.storage.sql,"exec"),alarms=vi.spyOn(ctx.storage,"setAlarm");
    const totals=()=>sql.mock.results.filter(result=>result.type==="return").reduce((sum,result)=>{const cursor=result.value as {rowsRead:number;rowsWritten:number};sum.read+=cursor.rowsRead;sum.written+=cursor.rowsWritten;return sum;},{read:0,written:0});
    try {
      for(let i=1;i<=50;i++){clock.mockReturnValue(start+i*2);await instance.webSocketMessage(sockets.get(nodeID(i))!,report(i,1,i));}
      const checkpoint={...totals(),setAlarm:alarms.mock.calls.length};
      sql.mockClear();alarms.mockClear();clock.mockReturnValue(start+120_002);
      await instance.alarm();const flush={...totals(),setAlarm:alarms.mock.calls.length};
      sql.mockClear();alarms.mockClear();
      (instance as unknown as Internal).flushHistory(Date.now());const repeated=totals();
      const rows=ctx.storage.sql.exec<{id:number;codec:string;payload:ArrayBuffer}>("SELECT id,codec,payload FROM history_batches").toArray();
      return {checkpoint,flush,repeated,rows:rows.length,samples:rows.flatMap(row=>decodeHistoryBatch(row.codec,row.payload).samples)};
    } finally {sql.mockRestore();alarms.mockRestore();}
  });
  expect(evidence.checkpoint.written).toBe(51);expect(evidence.checkpoint.setAlarm).toBe(1);
  expect(evidence.flush.written).toBeGreaterThanOrEqual(4);expect(evidence.flush.written).toBeLessThanOrEqual(6);
  expect(evidence.repeated.written).toBe(0);expect(evidence.rows).toBe(1);expect(evidence.samples).toHaveLength(50);
  expect(new Set(evidence.samples.map(sample=>sample[1])).size).toBe(50);
  await annotate(JSON.stringify({checkpoint:evidence.checkpoint,flush:evidence.flush,totalSQLWritten:evidence.checkpoint.written+evidence.flush.written,totalSetAlarm:evidence.checkpoint.setAlarm+evidence.flush.setAlarm}),"history-fifty-node-evidence");
});

it("persists a two-hundred-node sixteen-interface batch and serves one node after eviction",async({annotate})=>{
  const start=Date.parse("2026-10-06T13:00:00Z"),clock=vi.spyOn(Date,"now").mockReturnValue(start);
  await seed(200);await settings(120);
  const window:HistoryWindow={from:start,deadline:start+120_000,interval:120,generation:"max-fleet"};
  await runInDurableObject(stub(),(_,ctx)=>{
    ctx.storage.transactionSync(()=>{for(let i=1;i<=200;i++){
      const metrics:Metrics={time:new Date(start+i).toISOString(),cpu_percent:i%99+0.5,memory:{total_bytes:16_000_000_000,used_bytes:8_000_000_000},diagnostic:"d".repeat(6000),networks:Array.from({length:16},(_,j)=>({name:"eth"+j+"_"+"x".repeat(60),rx_bytes_per_second:i*123456.125+j,tx_bytes_per_second:i*76543.25+j}))};
      ctx.storage.sql.exec("UPDATE nodes SET latest=?,last_seen=?,history_window=?,history_interval_seconds=120 WHERE node_id=?",JSON.stringify(metrics),start+i,start,nodeID(i));
    }});
    ctx.storage.sql.exec("INSERT INTO config(id,value) VALUES(9,?)",JSON.stringify(window));return ctx.storage.setAlarm(window.deadline);
  });
  await evictDurableObject(stub());clock.mockReturnValue(window.deadline);expect(await runDurableObjectAlarm(stub())).toBe(true);
  const evidence=await runInDurableObject(stub(),(_,ctx)=>{
    const row=ctx.storage.sql.exec<{codec:string;payload:ArrayBuffer}>("SELECT codec,payload FROM history_batches").one(),batch=decodeHistoryBatch(row.codec,row.payload);
    return {samples:batch.samples.length,bytes:row.payload.byteLength,rawBytes:new TextEncoder().encode(JSON.stringify(batch)).byteLength,networks:JSON.parse(batch.samples[0][3]).networks.length,hasDiagnostic:batch.samples.some(sample=>sample[3].includes("diagnostic"))};
  });
  expect(evidence.samples).toBe(200);expect(evidence.networks).toBe(16);expect(evidence.hasDiagnostic).toBe(false);
  expect(evidence.rawBytes).toBeGreaterThan(250_000);expect(evidence.rawBytes).toBeLessThanOrEqual(HISTORY_BATCH_MAX_BYTES);expect(evidence.bytes).toBeLessThan(evidence.rawBytes);
  const result=await (await request(`/api/nodes/${nodeID(1)}/history?range=3600`)).json<HistoryResponse>();
  expect(result.raw_points).toBe(1);expect(result.points[0].cpu).toBe(1.5);expect(Object.keys(result.points[0].networks)).toHaveLength(16);
  await annotate(JSON.stringify(evidence),"history-max-fleet-evidence");
});

it("recovers pending snapshots after disconnect and eviction without overwriting their sample",async()=>{
  const start=Date.parse("2026-10-06T14:00:00Z"),clock=vi.spyOn(Date,"now").mockReturnValue(start);
  await seed(2);await settings(120);let first=await agent(1),second=await agent(2);
  await send(first,1,1,10);clock.mockReturnValue(start+20_000);await send(second,2,1,20);
  first.close(1000);clock.mockReturnValue(start+30_000);first=await agent(1);await send(first,1,1,99);first.close(1000);
  expect(await samples()).toHaveLength(0);await evictDurableObject(stub());
  clock.mockReturnValue(start+120_000);expect(await runDurableObjectAlarm(stub())).toBe(true);
  const stored=await samples();expect(stored).toHaveLength(2);
  expect(stored.find(sample=>sample[0]===nodeID(1))?.slice(1,3)).toEqual([start,120]);
  expect(JSON.parse(stored.find(sample=>sample[0]===nodeID(1))![3]).cpu_percent).toBe(10);
  expect(stored.find(sample=>sample[0]===nodeID(2))?.[1]).toBe(start+20_000);
});

it("closes pending history before changing settings and retains the old recording interval",async()=>{
  const start=Date.parse("2026-10-06T15:00:00Z"),clock=vi.spyOn(Date,"now").mockReturnValue(start);
  await seed(2);await settings(600);const first=await agent(1),second=await agent(2);
  await send(first,1,1,10);clock.mockReturnValue(start+20_000);await send(second,2,1,20);await settings(120);
  expect((await samples()).map(sample=>sample[2])).toEqual([600,600]);
  clock.mockReturnValue(start+120_000);await send(first,1,2,30);
  clock.mockReturnValue(start+140_000);await send(second,2,2,40);
  clock.mockReturnValue(start+240_000);expect(await runDurableObjectAlarm(stub())).toBe(true);
  const stored=await samples();expect(stored).toHaveLength(4);expect(stored.map(sample=>sample[2]).sort((a,b)=>a-b)).toEqual([120,120,600,600]);
  const result=await (await request(`/api/nodes/${nodeID(1)}/history?range=300`)).json<HistoryResponse>();
  expect(result.points.map(point=>[point.cpu,point.interval_seconds])).toEqual([[10,600],[30,120]]);
});

it("preserves each receipt time and metering buckets when a history window crosses UTC midnight",async()=>{
  const midnight=Date.parse("2026-10-07T00:00:00Z"),start=midnight-30_000,clock=vi.spyOn(Date,"now").mockReturnValue(start);
  await seed(2);await settings(120);const first=await agent(1),second=await agent(2);
  await send(first,1,1,10);clock.mockReturnValue(midnight+10_000);await send(second,2,1,20);
  await evictDurableObject(stub());clock.mockReturnValue(start+120_000);expect(await runDurableObjectAlarm(stub())).toBe(true);
  expect((await samples()).map(sample=>sample[1]).sort((a,b)=>a-b)).toEqual([start,midnight+10_000]);
  const hours=await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec<{hour:number}>("SELECT hour FROM usage ORDER BY hour").toArray().map(row=>row.hour));
  expect(hours).toContain(hourOf(start));expect(hours).toContain(hourOf(midnight));
});

it("recovers a reopened window in the same millisecond without mistaking the old batch for its commit",async()=>{
  const start=Date.parse("2026-10-06T15:30:00Z"),clock=vi.spyOn(Date,"now").mockReturnValue(start);
  await seed(2);await settings(600);const first=await agent(1),second=await agent(2);
  await send(first,1,1,10);await settings(120);await send(second,2,1,20);
  expect(await samples()).toHaveLength(1);
  await evictDurableObject(stub());clock.mockReturnValue(start+120_000);await runDurableObjectAlarm(stub());
  const stored=await samples();expect(stored).toHaveLength(2);
  expect(stored.map(sample=>[sample[0],sample[2]])).toEqual([[nodeID(1),600],[nodeID(2),120]]);
  await evictDurableObject(stub());
  expect(await runInDurableObject(stub(),instance=>Reflect.get(instance,"historyWindow"))).toBeNull();
});

it("reads only the predecessor and intersecting shared buckets while covering the full seven-day view",async()=>{
  const end=Date.parse("2026-10-06T16:00:00Z");vi.spyOn(Date,"now").mockReturnValue(end);
  await seed(2);
  await runInDurableObject(stub(),(_,ctx)=>ctx.storage.transactionSync(()=>{
    for(let i=0;i<5040;i++){
      const time=end-(5039-i)*120_000,batch:HistoryBatch={version:1,samples:[[nodeID(1),time,120,'{"cpu_percent":10,"history_interval_seconds":120}'],[nodeID(2),time+40_000,120,'{"cpu_percent":99}']]},encoded=encodeHistoryBatch(batch);
      ctx.storage.sql.exec("INSERT INTO history_batches(id,until,generation,codec,payload) VALUES(?,?,?,?,?)",time-10_000,time+40_000,"seed-"+i,encoded.codec,encoded.payload);
    }
    ctx.storage.sql.exec("UPDATE nodes SET last_seen=?,latest=?,history_interval_seconds=120 WHERE node_id=?",end,'{"cpu_percent":10}',nodeID(1));
  }));
  const short=await runInDurableObject(stub(),async(instance,ctx)=>{
    const spy=vi.spyOn(ctx.storage.sql,"exec");
    try {
      const response=await instance.fetch(new Request(`${origin}/api/nodes/${nodeID(1)}/history?range=300`,{headers:{"X-Monitor-Role":"admin","X-Monitor-Auth-Expires":String(Number.MAX_SAFE_INTEGER)}}));
      const result=await response.json<HistoryResponse>(),reads=spy.mock.results.filter((_,i)=>[BATCH_PREVIOUS,BATCH_SELECT].includes(spy.mock.calls[i][0])).map(result=>(result.value as {rowsRead:number}).rowsRead);
      return {result,reads};
    } finally {spy.mockRestore();}
  });
  expect(short.result.raw_points).toBe(3);expect(short.result.points.every(point=>point.cpu===10)).toBe(true);expect(short.reads).toHaveLength(2);expect(short.reads.reduce((a,b)=>a+b,0)).toBeLessThanOrEqual(5);
  const full=await (await request(`/api/nodes/${nodeID(1)}/history?range=604800`)).json<HistoryResponse>();
  expect(full.raw_points).toBe(5040);expect(full.points.length).toBeLessThanOrEqual(1008);expect(full.points[0].time).toBeLessThan(full.from+full.resolution_seconds*1000);expect(full.points.at(-1)?.time).toBe(end);
});

it("physically removes a deleted node from compressed batches and pending latest while retaining other nodes",async()=>{
  const start=Date.parse("2026-10-06T17:00:00Z"),clock=vi.spyOn(Date,"now").mockReturnValue(start);
  await seed(2);await settings(120);const first=await agent(1),second=await agent(2);
  await send(first,1,1,10);await send(second,2,1,20);clock.mockReturnValue(start+120_000);await runDurableObjectAlarm(stub());
  await send(first,1,2,30);await send(second,2,2,40);
  expect((await request(`/api/nodes/${nodeID(1)}`,"DELETE")).status).toBe(200);
  expect((await samples()).map(sample=>sample[0])).toEqual([nodeID(2)]);
  await evictDurableObject(stub());clock.mockReturnValue(start+240_000);await runDurableObjectAlarm(stub());
  expect((await samples()).map(sample=>sample[0])).toEqual([nodeID(2),nodeID(2)]);
  expect((await request(`/api/nodes/${nodeID(1)}/history?range=604800`)).status).toBe(404);
});
