import { githubSettings } from "./github-fixture";
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { BATCH_PREVIOUS, BATCH_SELECT, HISTORY_MAX_BYTES, HISTORY_MAX_POINTS, decodeHistoryBatch, encodeHistoryBatch, historySnapshot, resourcePoint, storedResourcePoint, type HistoryBatch, type ResourcePoint } from "../src/history";
import { hash, type Metrics } from "../src/model";

const origin="http://127.0.0.1", id="1".repeat(32), other="2".repeat(32), key="a".repeat(64);
const host={hostname:"history-node",os:"linux",arch:"amd64",cpus:2,agent_version:"test"};
const stub=()=>env.MONITOR.getByName(env.MONITOR_GROUP), clients=new Set<WebSocket>();
type HistoryResponse={points:ResourcePoint[];from:number;to:number;interval_seconds:number;resolution_seconds:number;raw_points:number};
async function request(path:string,method="GET",headers:HeadersInit={}) {
  const response=await worker.fetch(new Request(origin+(path.startsWith("/api/") ? "/panel"+path : path),{method,headers:{Origin:origin,...headers}}),env);
  return response.status===101?response:new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
}
async function seed(seen=0,metrics:unknown={}) {
  await request("/api/state?view=live");
  const digest=await hash(key);
  await runInDurableObject(stub(),(_,ctx)=>{
    ctx.storage.sql.exec("INSERT INTO nodes(node_id,name,key_hash,state,host,latest,last_seen) VALUES(?,?,?,'approved',?,?,?)",id,"history-node",digest,JSON.stringify(host),JSON.stringify(metrics),seen);
  });
}
function receive(ws:WebSocket,type:string):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.removeEventListener("message",listener);reject(new Error("waiting for "+type));},5000);
    const listener=(event:MessageEvent)=>{const value=JSON.parse(event.data as string);if(value.type===type){clearTimeout(timer);ws.removeEventListener("message",listener);resolve(value);}};
    ws.addEventListener("message",listener);
  });
}
async function settings(idle:number) {
  const response=await worker.fetch(new Request(origin+"/panel/api/settings",{method:"PUT",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({active_seconds:5,idle_seconds:idle})}),env);
  expect(response.status).toBe(200);await response.arrayBuffer();
}
async function agent() {
  const response=await request("/v1/live","GET",{"X-Monitor-Node-ID":id,Authorization:"Bearer "+key,Upgrade:"websocket"});
  expect(response.status).toBe(101);const ws=response.webSocket!;clients.add(ws);ws.accept();await receive(ws,"config");return ws;
}
async function send(ws:WebSocket,sequence:number,cpu=10,session="b".repeat(32)) {
  const ack=receive(ws,"ack");ws.send(JSON.stringify({protocol:1,node_id:id,session,sequence,host,metrics:{time:new Date().toISOString(),cpu_percent:cpu}}));await ack;
}
async function flush() {
  await runInDurableObject(stub(),instance=>(instance as unknown as {flushHistory(now:number,force:boolean):void}).flushHistory(Date.now(),true));
}
async function batches() {
  return runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec<{codec:string;payload:ArrayBuffer}>("SELECT codec,payload FROM history_batches").toArray().flatMap(row=>decodeHistoryBatch(row.codec,row.payload).samples));
}
afterEach(async()=>{for(const ws of clients){try{ws.close(1000);}catch{}}clients.clear();vi.restoreAllMocks();await reset();});

it("keeps history behind panel identity even with forged role/device headers",async()=>{
  const storage=vi.spyOn(env.MONITOR,"getByName");
  const configured={...githubSettings()};
  const response=await worker.fetch(new Request(`https://monitor.example.test/panel/api/nodes/${id}/history?range=300`,{headers:{"X-Monitor-Role":"admin","X-Monitor-Auth-Expires":String(Date.now()+3600_000),"X-Monitor-Node-ID":id,Authorization:"Bearer "+key}}),configured);
  expect(response.status).toBe(401);expect(response.headers.get("Cache-Control")).toBe("no-store");expect(storage).not.toHaveBeenCalled();
});

it("strictly bounds requested ranges and handles unknown and never-reporting nodes",async()=>{
  await seed();
  for(const value of ["","0","-1","301","604801","3e2","300.0","0300","300&range=60","Infinity"]){
    expect((await request(`/api/nodes/${id}/history${value?"?range="+value:""}`)).status).toBe(400);
  }
  for(const value of [60,300,1800,3600,86400,604800]){
    const response=await request(`/api/nodes/${id}/history?range=${value}`),body=await response.json<HistoryResponse>();
    expect(response.status).toBe(200);expect(body.points).toEqual([]);expect(body.to-body.from).toBe(value*1000);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect((await request(`/api/nodes/${other}/history?range=300`)).status).toBe(404);
  expect((await request(`/api/nodes/${id}/history?range=300`,"POST")).status).toBe(405);
});

it("uses server receipt times, isolates nodes in shared batches and preserves an offline right edge",async()=>{
  const seen=Date.now()-2*86400_000;
  await seed(seen,{time:"2099-01-01T00:00:00Z",cpu_percent:33,memory:{total_bytes:100,used_bytes:25}});
  await runInDurableObject(stub(),(_,ctx)=>{
    const sample=(node:string,time:number,cpu:number):HistoryBatch["samples"][number]=>[node,time,600,historySnapshot({time:"1900-01-01T00:00:00Z",cpu_percent:cpu,networks:[{name:"eth0",rx_bytes_per_second:0,tx_bytes_per_second:50}]},600)];
    const add=(start:number,samples:HistoryBatch["samples"])=>{const encoded=encodeHistoryBatch({version:1,samples});ctx.storage.sql.exec("INSERT INTO history_batches(id,until,generation,codec,payload) VALUES(?,?,?,?,?)",start,Math.max(start,...samples.map(row=>row[1])),"fixture-"+start,encoded.codec,encoded.payload);};
    add(seen-600_000,[sample(id,seen-600_000,66)]);
    add(seen-240_000,[sample(id,seen-120_000,22),sample(id,seen,99),sample(other,seen-60_000,88),sample(id,seen+30_000,55)]); // latest wins the duplicate receipt time; future samples stay outside the response.
  });
  await evictDurableObject(stub());
  const result=await (await request(`/api/nodes/${id}/history?range=300`)).json<HistoryResponse>();
  expect(result.from).toBe(seen-300_000);expect(result.to).toBe(seen);
  expect(result.points.map(p=>[p.time,p.cpu])).toEqual([[seen-120_000,22],[seen,33]]);
  expect(result.points[0].networks.eth0).toEqual({rx:0,tx:50});expect(result.points[1].memory).toBe(25);expect(result.points[1].networks).toEqual({});
});

it("reads bounded shared primary-key batches and aggregates the entire seven-day response",async()=>{
  const intervalMs=30_000,sampleCount=604800_000/intervalMs,seen=Date.now()-1000;await seed(seen,{cpu_percent:42});
  const evidence=await runInDurableObject(stub(),(_,ctx)=>{
    const reportedTime=new Date(seen).toISOString(),snapshot=historySnapshot({time:reportedTime,cpu_percent:1},30),otherSnapshot=historySnapshot({time:reportedTime,cpu_percent:99},30);
    ctx.storage.transactionSync(()=>{for(let i=0;i<sampleCount;i++){
      const timestamp=seen-(sampleCount-i)*intervalMs,encoded=encodeHistoryBatch({version:1,samples:[[id,timestamp,30,snapshot],[other,timestamp,30,otherSnapshot]]});
      ctx.storage.sql.exec("INSERT INTO history_batches(id,until,generation,codec,payload) VALUES(?,?,?,?,?)",timestamp-1000,timestamp,"fixture-"+i,encoded.codec,encoded.payload);
    }});
    const args=[seen-604800_000-1000,seen],cursor=ctx.storage.sql.exec(BATCH_SELECT,...args),rows=cursor.toArray();
    return {rows:rows.length,read:cursor.rowsRead,plan:ctx.storage.sql.exec("EXPLAIN QUERY PLAN "+BATCH_SELECT,...args).toArray(),count:ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM history_batches").one().n};
  });
  expect(evidence.rows).toBe(sampleCount);expect(evidence.read).toBeLessThanOrEqual(sampleCount);
  expect(JSON.stringify(evidence.plan)).toContain("INTEGER PRIMARY KEY");
  const body=await (await request(`/api/nodes/${id}/history?range=604800`)).json<HistoryResponse>();
  expect(body.points.length).toBeLessThanOrEqual(HISTORY_MAX_POINTS);expect(body.points.length).toBeGreaterThan(1000);expect(body.points.at(-1)).toMatchObject({time:seen,cpu:42});
  expect(body.points[0].time).toBeLessThan(body.from+body.resolution_seconds*1000);expect(body.raw_points).toBe(sampleCount+1);
  expect(body.resolution_seconds).toBe(601);expect(body.points[0].interval_seconds).toBe(601);
  expect(body.points.slice(0,-1).every(p=>p.cpu===1)).toBe(true);
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM history_batches").one().n)).toBe(evidence.count);
  const short=await runInDurableObject(stub(),async(instance,ctx)=>{
    const spy=vi.spyOn(ctx.storage.sql,"exec");
    try {
      const response=await instance.fetch(new Request(`${origin}/api/nodes/${id}/history?range=300`,{headers:{"X-Monitor-Role":"admin","X-Monitor-Auth-Expires":String(Number.MAX_SAFE_INTEGER)}}));
      const result=await response.json<HistoryResponse>();
      const reads=spy.mock.results.filter((_,i)=>[BATCH_PREVIOUS,BATCH_SELECT].includes(spy.mock.calls[i][0])).map(result=>(result.value as {rowsRead:number}).rowsRead);
      return {result,reads};
    } finally { spy.mockRestore(); }
  });
  expect(short.reads).toHaveLength(2);
  expect(short.reads.reduce((sum,value)=>sum+value,0)).toBeLessThanOrEqual(12);
  expect(short.result.raw_points).toBe(11);expect(short.result.points.at(-1)?.time).toBe(seen);
});

it("projects stored and live snapshots without inventing network rates or CPU/memory zeros",()=>{
  expect(storedResourcePoint(123,'not-json')).toEqual({time:123,cpu:null,memory:null,networks:{},interval_seconds:600});
  const point=resourcePoint(456,{cpu_percent:0,memory:{total_bytes:100,used_bytes:0},networks:[{name:"eth0",rx_bytes_per_second:0},{name:"eth1",counter_reset:true,rx_bytes_per_second:9,tx_bytes_per_second:4},{name:"__proto__",rx_bytes_per_second:8}]});
  expect(point.cpu).toBe(0);expect(point.memory).toBe(0);expect(point.networks.eth0).toEqual({rx:0,tx:null});expect(point.networks.eth1).toEqual({rx:null,tx:null});
  expect(Object.getPrototypeOf(point.networks)).toBeNull();expect(point.networks["__proto__"]).toEqual({rx:8,tx:null});
  expect(resourcePoint(1,{cpu_percent:101,memory:{total_bytes:0,used_bytes:1}})).toMatchObject({cpu:null,memory:null});
});

it("keeps compact history within two KiB with exact interface identities and available rates",()=>{
  const metrics:Metrics={time:new Date().toISOString(),cpu_percent:12.5,memory:{total_bytes:100,used_bytes:25},extra:"x".repeat(3000),networks:Array.from({length:16},(_,i)=>({name:"eth"+i,rx_bytes_per_second:i+0.25,tx_bytes_per_second:i*20}))};
  const serialized=historySnapshot(metrics,600),point=storedResourcePoint(10,serialized);
  expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(HISTORY_MAX_BYTES);expect(Object.keys(point.networks)).toHaveLength(16);
  expect(point).toMatchObject({cpu:12.5,memory:25,networks:{eth15:{rx:15.25,tx:300}}});
  metrics.networks=Array.from({length:16},(_,i)=>({name:String(i)+"网".repeat(120),rx_bytes_per_second:i+0.25,tx_bytes_per_second:2}));
  const long=historySnapshot(metrics,600),trimmed=storedResourcePoint(10,long);
  expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(HISTORY_MAX_BYTES);expect(Object.keys(trimmed.networks).length).toBeGreaterThan(0);expect(Object.keys(trimmed.networks).length).toBeLessThan(16);
  for(const [name,rates] of Object.entries(trimmed.networks)){expect(name).toContain("网".repeat(120));expect(rates.rx).toBe(Number.parseInt(name)+0.25);}
  for(const interval of [30,120,300,600,86400]) {
    const snapshot=historySnapshot(metrics,interval);
    expect(new TextEncoder().encode(snapshot).byteLength).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    expect(storedResourcePoint(10,snapshot).interval_seconds).toBe(interval);
  }
});

it("keeps full latest metrics, compact history and existing write cadence while merging live reports",async()=>{
  await seed();
  const response=await request("/v1/live","GET",{"X-Monitor-Node-ID":id,Authorization:"Bearer "+key,Upgrade:"websocket"});
  expect(response.status).toBe(101);const ws=response.webSocket!;clients.add(ws);ws.accept();await receive(ws,"config");
  const first:Metrics={time:new Date().toISOString(),cpu_percent:10,memory:{total_bytes:1000,used_bytes:500},diagnostic:"d".repeat(3000),networks:[{name:"eth0",rx_bytes:1000,tx_bytes:400,rx_bytes_per_second:100,tx_bytes_per_second:40}]};
  const send=async(sequence:number,metrics:Metrics)=>{const ack=receive(ws,"ack");ws.send(JSON.stringify({protocol:1,node_id:id,session:"b".repeat(32),sequence,host,metrics}));await ack;};
  await send(1,first);
  expect(await batches()).toEqual([]);await flush();
  const before=await runInDurableObject(stub(),(_,ctx)=>{const row=ctx.storage.sql.exec<{codec:string;payload:ArrayBuffer}>("SELECT codec,payload FROM history_batches").one();return {node:ctx.storage.sql.exec<{latest:string;last_seen:number}>("SELECT latest,last_seen FROM nodes WHERE node_id=?",id).one(),history:decodeHistoryBatch(row.codec,row.payload).samples[0][3]};});
  expect(JSON.parse(before.node.latest)).toEqual(first);expect(storedResourcePoint(1,before.history).networks.eth0).toEqual({rx:100,tx:40});expect(new TextEncoder().encode(before.history).byteLength).toBeLessThanOrEqual(2048);
  await runInDurableObject(stub(),(_,ctx)=>{const socket=ctx.getWebSockets("agent")[0],attachment=socket.deserializeAttachment();attachment.lastReport=Date.now()-600_001;socket.serializeAttachment(attachment);});
  await new Promise(resolve=>setTimeout(resolve,10));
  await send(2,{...first,cpu_percent:20});
  const body=await (await request(`/api/nodes/${id}/history?range=300`)).json<HistoryResponse>();
  expect(body.to).toBeGreaterThan(before.node.last_seen);expect(body.points.at(-1)).toMatchObject({time:body.to,cpu:20});
  const persisted=await runInDurableObject(stub(),(_,ctx)=>({latest:ctx.storage.sql.exec("SELECT latest,last_seen FROM nodes WHERE node_id=?",id).one(),count:ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM history_batches").one().n}));
  expect(persisted.latest).toEqual(before.node);expect(persisted.count).toBe(1);
  await evictDurableObject(stub());
  const offline=await (await request(`/api/nodes/${id}/history?range=300`)).json<HistoryResponse>();
  expect(offline.to).toBe(before.node.last_seen);expect(offline.points.at(-1)).toMatchObject({cpu:10,time:before.node.last_seen});
});

it.each([30,120,300,600,86400])("records at the selected %i-second idle cadence while viewers receive fast reports",async(interval)=>{
  const start=Math.floor(Date.now()/30_000)*30_000;
  const clock=vi.spyOn(Date,"now").mockReturnValue(start);
  await seed();await settings(interval);const ws=await agent();
  const active=receive(ws,"config"),response=await request("/api/live","GET",{Upgrade:"websocket"});
  const viewer=response.webSocket!;clients.add(viewer);viewer.accept();expect((await active).interval_seconds).toBe(5);
  await send(ws,1);
  const renew=()=>runInDurableObject(stub(),(_,ctx)=>{for(const socket of ctx.getWebSockets()){const a=socket.deserializeAttachment();a.authExpires=Number.MAX_SAFE_INTEGER;if(a.role==="viewer")a.expires=Date.now()+90_000;socket.serializeAttachment(a);}});
  clock.mockReturnValue(start+interval*1000-5000);await renew();await send(ws,2,20);
  expect(await batches()).toHaveLength(0);
  clock.mockReturnValue(start+interval*1000+5000);await renew();await send(ws,3,30);
  expect(await batches()).toHaveLength(1);await flush();
  const persisted=await runInDurableObject(stub(),(_,ctx)=>({rows:ctx.storage.sql.exec<{codec:string;payload:ArrayBuffer}>("SELECT codec,payload FROM history_batches").toArray().flatMap(row=>decodeHistoryBatch(row.codec,row.payload).samples),latest:ctx.storage.sql.exec<{latest:string;last_seen:number}>("SELECT latest,last_seen FROM nodes").one()}));
  expect(persisted.rows).toHaveLength(2);expect(persisted.rows.every(row=>row[0]===id)).toBe(true);
  expect(persisted.rows.every(row=>storedResourcePoint(row[1],row[3]).interval_seconds===interval)).toBe(true);
  expect(persisted.latest.last_seen).toBe(start+interval*1000+5000);
  expect(JSON.parse(persisted.latest.latest)).not.toHaveProperty("history_interval_seconds");
});

it("keeps checkpoint timing through settings changes, hibernation and reconnects",async()=>{
  const start=Math.floor(Date.now()/30_000)*30_000;
  const clock=vi.spyOn(Date,"now").mockReturnValue(start);
  await seed();await settings(30);let ws=await agent();
  const active=receive(ws,"config"),response=await request("/api/live","GET",{Upgrade:"websocket"});
  const viewer=response.webSocket!;clients.add(viewer);viewer.accept();await active;
  await send(ws,1);clock.mockReturnValue(start+5000);await send(ws,2,20);await evictDurableObject(stub());
  clock.mockReturnValue(start+30_000);await send(ws,3,30);
  const changed=receive(ws,"config");await settings(600);await changed;
  clock.mockReturnValue(start+35_000);await send(ws,4,40);await evictDurableObject(stub());
  expect(await batches()).toHaveLength(2);
  clock.mockReturnValue(start+630_000);await send(ws,5,50);
  await flush();
  const saved=await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec<{last_seen:number}>("SELECT last_seen FROM nodes").one().last_seen);
  ws.close(1000);clock.mockReturnValue(start+640_000);ws=await agent();await send(ws,1,60,"c".repeat(32));
  const rows=await runInDurableObject(stub(),(_,ctx)=>({seen:ctx.storage.sql.exec<{last_seen:number}>("SELECT last_seen FROM nodes").one().last_seen,history:ctx.storage.sql.exec<{codec:string;payload:ArrayBuffer}>("SELECT codec,payload FROM history_batches").toArray().flatMap(row=>decodeHistoryBatch(row.codec,row.payload).samples)}));
  expect(rows.history).toHaveLength(3);expect(rows.seen).toBe(saved);
  expect(rows.history.map(row=>storedResourcePoint(row[1],row[3]).interval_seconds).sort((a,b)=>a!-b!)).toEqual([30,30,600]);
});
