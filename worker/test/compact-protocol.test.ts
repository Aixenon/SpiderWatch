import { invitationHeaders } from "./invitation-fixture";
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import worker from "../src/index";

const origin = "http://127.0.0.1", id = "7".repeat(32), key = "8".repeat(64);
const host = {hostname:"compact-node",os:"windows",arch:"amd64",cpus:2,physical_cpus:1,cpu_model:"Intel(R) Xeon(R) CPU",agent_version:"0.3.0"};
const headers = {"X-Monitor-Node-ID":id,Authorization:"Bearer "+key};
const clients = new Set<WebSocket>();
const stub = () => env.MONITOR.getByName(env.MONITOR_GROUP);
async function request(path:string, method="GET", body?:unknown, extra={}) {
  const r = await worker.fetch(new Request(origin+(path.startsWith("/api/") ? "/panel"+path : path),{method,headers:{...(path.endsWith("/enroll") ? await invitationHeaders() : {}),Origin:origin,"Content-Type":"application/json",...extra},body:body===undefined?undefined:JSON.stringify(body)}),env);
  return r.status===101?r:new Response(await r.arrayBuffer(),{status:r.status,headers:r.headers});
}
function receive(ws:WebSocket,type:string):Promise<any> {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.removeEventListener("message",listener);reject(new Error(type));},5000);const listener=(e:MessageEvent)=>{const body=JSON.parse(e.data as string);if(body.type===type){clearTimeout(timer);ws.removeEventListener("message",listener);resolve(body);}};ws.addEventListener("message",listener);});
}
async function enroll(approve=true) {
  await request("/bootstrap/enroll","POST",{protocol:1,node_id:id,device_key:key,group:env.MONITOR_GROUP,host});
  if(!approve)await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("UPDATE nodes SET state='pending' WHERE node_id=?",id));
}
async function socket() {
  const r=await request("/v1/live","GET",undefined,{...headers,Upgrade:"websocket","X-Monitor-Agent-Version":"0.4.0"});expect(r.status).toBe(101);
  const ws=r.webSocket!;clients.add(ws);ws.accept();expect(await receive(ws,"config")).toMatchObject({protocol:2,compression:"gzip"});return ws;
}
afterEach(async()=>{for(const ws of clients){try{ws.close(1000);}catch{}}clients.clear();await reset();});

it("remembers handshake version and hello host across hibernation, with compact gzip metrics",async()=>{
  await enroll();const ws=await socket();const helloAck=receive(ws,"hello_ack");
  const {agent_version:_,...helloHost}=host;
  ws.send(JSON.stringify({type:"hello",protocol:2,session:"9".repeat(32),host:helloHost}));await helloAck;
  await evictDurableObject(stub());
  const metrics={time:new Date().toISOString(),cpu_percent:31,cpu_detail:{user_percent:20,system_percent:11,idle_percent:69},
    memory:{total_bytes:1000,used_bytes:400,cached_bytes:200,free_bytes:100,committed_bytes:2000,commit_limit_bytes:1500},
    disks:[{volume_id:"volume-a",device:"C:",mount:"C:\\",filesystem:"NTFS",total_bytes:2000,used_bytes:1000}],
    networks:[{name:"Ethernet",rx_bytes:5000,tx_bytes:1000,rx_bytes_per_second:200,tx_bytes_per_second:100}]};
  const bytes=new TextEncoder().encode(JSON.stringify({type:"metrics",sequence:1,metrics}));
  const compressed=await new Response(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}).pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const ack=receive(ws,"ack");ws.send(compressed);expect(await ack).toMatchObject({sequence:1});
  const state=await (await request("/api/state?view=live")).json() as any;
  expect(state.nodes[0]).toMatchObject({host:{...host,agent_version:"0.4.0"},metrics});
  expect(state).not.toHaveProperty("usage");expect(state).not.toHaveProperty("forecast");
  await evictDurableObject(stub());
  expect((await (await request("/api/state?view=live")).json() as any).nodes[0].host.agent_version).toBe("0.4.0");
  expect((await (await request("/api/state?view=live")).json() as any).nodes[0].host.cpu_model).toBe(host.cpu_model);
});

it("requires hello before accepting compact metrics and bounds the version header",async()=>{
  await enroll();expect((await request("/v1/live","GET",undefined,{...headers,Upgrade:"websocket","X-Monitor-Agent-Version":"x".repeat(65)})).status).toBe(400);
  const ws=await socket();const closed=new Promise<CloseEvent>(resolve=>ws.addEventListener("close",resolve,{once:true}));
  ws.send(JSON.stringify({type:"metrics",sequence:1,metrics:{time:new Date().toISOString()}}));expect((await closed).code).toBe(1008);
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT count(*) AS n FROM history_batches").one().n)).toBe(0);
});

it("does not write SQLite for repeated pending polls or lightweight state reads",async()=>{
  await enroll(false);
  const epoch=()=>runInDurableObject(stub(),(_,ctx)=>JSON.parse(ctx.storage.sql.exec<{value:string}>("SELECT value FROM config WHERE id=2").one().value).epoch);
  const before=await epoch();
  for(let i=0;i<8;i++){
    expect(await (await request("/bootstrap/status","POST",{},{...headers})).json()).toMatchObject({state:"pending",interval_seconds:300});
    expect((await request("/api/state?view=live")).status).toBe(200);
  }
  expect(await epoch()).toBe(before);
  const full=await (await request("/api/state")).json() as any;expect(full.forecast).toBeDefined();expect(await epoch()).toBe(before);
});

it("keeps ten-minute snapshot pacing after reconnecting",async()=>{
  await enroll();let ws=await socket();
  const {agent_version:_,...helloHost}=host;
  async function send(socket:WebSocket,session:string){const hello=receive(socket,"hello_ack");socket.send(JSON.stringify({type:"hello",protocol:2,host:helloHost,session}));await hello;const ack=receive(socket,"ack");socket.send(JSON.stringify({type:"metrics",sequence:1,metrics:{time:new Date().toISOString(),cpu_percent:10}}));await ack;}
  await send(ws,"a".repeat(32));
  const seen=await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT last_seen FROM nodes").one().last_seen);
  ws.close(1000);ws=await socket();await send(ws,"b".repeat(32));
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT last_seen FROM nodes").one().last_seen)).toBe(seen);
});
