import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";

const origin="http://127.0.0.1", session="a".repeat(32), revision="c".repeat(40);
const host={hostname:"fallback-node",os:"windows",arch:"amd64",cpus:2,agent_version:"0.7.2",agent_revision:"b".repeat(40)};
const clients=new Set<WebSocket>(), stub=()=>env.MONITOR.getByName(env.MONITOR_GROUP);
const base64=(bytes:ArrayBuffer|Uint8Array)=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
async function identity() {
  const pair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
  const wire=new Uint8Array(51),view=new DataView(wire.buffer);
  view.setUint32(0,11);wire.set(new TextEncoder().encode("ssh-ed25519"),4);view.setUint32(15,32);
  const exported=await crypto.subtle.exportKey("raw",pair.publicKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("expected raw key");
  wire.set(new Uint8Array(exported),19);
  return {id:crypto.randomUUID().replaceAll("-",""),key:pair.privateKey,publicKey:"ssh-ed25519 "+base64(wire)};
}
type Identity=Awaited<ReturnType<typeof identity>>;
async function signed(device:Identity,path:string,method="GET",body?:unknown,extra:Record<string,string>={}) {
  const encoded=body===undefined?"":JSON.stringify(body),headers=new Headers({"Content-Type":"application/json","X-Monitor-Node-ID":device.id,
    "X-Monitor-Time":String(Date.now()),"X-Monitor-Nonce":crypto.randomUUID().replaceAll("-",""),...extra});
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(encoded)));
  const payload=["cf-monitor-auth-v1",method,origin,path,device.id,headers.get("X-Monitor-Time"),headers.get("X-Monitor-Nonce"),Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("")].join("\n");
  headers.set("X-Monitor-Signature",base64(await crypto.subtle.sign("Ed25519",device.key,new TextEncoder().encode(payload))));
  return new Request(origin+path,{method,headers,body:body===undefined?undefined:encoded});
}
async function consume(request:Request) {
  const response=await worker.fetch(request,env);
  return response.status===101?response:new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
}
const admin=(path:string,method="GET")=>consume(new Request(origin+"/panel"+path,{method,headers:{Origin:origin}}));
const state=async()=>await(await admin("/api/state?view=live")).json() as any;
async function registered() {
  const device=await identity(),invitation=await(await admin("/api/invitations","POST")).json() as any;
  const token=new URLSearchParams(new URL(invitation.server).hash.slice(1)).get("invite")!;
  const response=await consume(await signed(device,"/bootstrap/enroll","POST",{protocol:2,node_id:device.id,group:invitation.network,public_key:device.publicKey,host},{"X-Monitor-Invitation":token}));
  expect(response.status).toBe(200);return device;
}
function body(device:Identity,sequence=1,cpu=10,extra={}) {
  return {protocol:1,node_id:device.id,session,sequence,host,metrics:{time:new Date(Date.now()).toISOString(),cpu_percent:cpu},update_control:1,...extra};
}
const report=async(device:Identity,sequence=1,cpu=10,extra={})=>consume(await signed(device,"/v1/metrics","POST",body(device,sequence,cpu,extra)));
function receive(ws:WebSocket,type:string):Promise<any> {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.removeEventListener("message",listener);reject(new Error(type));},5000);const listener=(event:MessageEvent)=>{const body=JSON.parse(event.data as string);if(body.type===type){clearTimeout(timer);ws.removeEventListener("message",listener);resolve(body);}};ws.addEventListener("message",listener);});
}
async function socket(device:Identity,agentSession=session) {
  const response=await consume(await signed(device,"/v1/live","GET",undefined,{Upgrade:"websocket","X-Monitor-Agent-Version":host.agent_version,"X-Monitor-Agent-Revision":host.agent_revision}));
  expect(response.status).toBe(101);const ws=response.webSocket!;clients.add(ws);ws.accept();await receive(ws,"config");
  const ack=receive(ws,"hello_ack");const {agent_version,agent_revision,...info}=host;
  ws.send(JSON.stringify({type:"hello",protocol:2,session:agentSession,host:info,update_control:1}));await ack;return ws;
}
async function metrics(ws:WebSocket,sequence:number,cpu=20) {
  const ack=receive(ws,"ack");ws.send(JSON.stringify({type:"metrics",sequence,metrics:{time:new Date(Date.now()).toISOString(),cpu_percent:cpu}}));await ack;
}
async function viewer() {
  const response=await consume(new Request(origin+"/panel/api/live",{headers:{Origin:origin,Upgrade:"websocket"}}));
  expect(response.status).toBe(101);const ws=response.webSocket!;clients.add(ws);ws.accept();await receive(ws,"settings");return ws;
}
async function closeAgent() {
  await runInDurableObject(stub(),async(instance,ctx)=>{for(const ws of ctx.getWebSockets("agent")){ws.close(1000);await instance.webSocketClose(ws);}});
}
async function bundle() {
  vi.spyOn(env.ASSETS,"fetch").mockImplementation(async()=>Response.json({schema:1,version:"0.7.3",revision,repository:"owner/project",build:"d".repeat(64),
    assets:[{os:"windows",arch:"amd64",file:"spider-watch-windows-amd64.exe",bytes:2048,sha256:"a".repeat(64)}],
    files:[{file:"spider-watch-windows-amd64.exe",bytes:2048,sha256:"a".repeat(64)}]}));
  await runInDurableObject(stub(),instance=>Reflect.set(instance,"env",{...Reflect.get(instance,"env"),ASSETS:env.ASSETS,UPDATE_GITHUB_REPOSITORY:"owner/project"}));
}
afterEach(async()=>{for(const ws of clients)try{ws.close(1000);}catch{}clients.clear();vi.restoreAllMocks();await reset();});

it("authenticates HTTP metrics, limits their rate, and restores the latest snapshot after hibernation",async()=>{
  const device=await registered(),now=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(now);
  const first=await signed(device,"/v1/metrics","POST",body(device)),replay=first.clone();
  expect(await(await consume(first)).json()).toEqual({state:"approved",transport:"websocket",interval_seconds:60});
  expect((await consume(replay)).status).toBe(409);
  expect((await report(device,2)).status).toBe(429);
  clock.mockReturnValue(now+60000);
  expect((await report(device,1)).status).toBe(409);
  expect((await report(device,2,75)).status).toBe(200);
  const checkpoint=await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT last_seen,latest FROM nodes WHERE node_id=?",device.id).one());
  expect(checkpoint.last_seen).toBe(now);expect(JSON.parse(checkpoint.latest as string).cpu_percent).toBe(10);
  await evictDurableObject(stub());
  const node=(await state()).nodes[0];expect(node).toMatchObject({connected:true,last_seen:now+60000,report_interval_seconds:60,metrics:{cpu_percent:75}});
  const history=await(await admin(`/api/nodes/${device.id}/history?range=300`)).json() as any;
  expect(history.to).toBe(now+60000);expect(history.points.at(-1)).toMatchObject({time:now+60000,interval_seconds:60});
  clock.mockReturnValue(now+240001);expect((await state()).nodes[0].connected).toBe(false);
});

it("rejects unsigned, invalidly signed, revoked, oversized and compressed reports",async()=>{
  const device=await registered();
  const lookup=vi.spyOn(env.MONITOR,"getByName");
  expect((await consume(new Request(origin+"/v1/metrics",{method:"POST",body:"{}"}))).status).toBe(401);
  expect((await consume(await signed(device,"/v1/metrics","POST",{}, {"Content-Length":"32769"}))).status).toBe(413);
  expect((await consume(await signed(device,"/v1/metrics","POST",{}, {"Content-Encoding":"gzip"}))).status).toBe(415);
  expect(lookup).not.toHaveBeenCalled();lookup.mockRestore();
  const persisted=await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT value FROM config WHERE id=2").one().value);
  const valid=await signed(device,"/v1/metrics","POST",body(device));
  expect((await consume(new Request(valid.url,{method:"POST",headers:valid.headers,body:JSON.stringify(body(device,1,99))}))).status).toBe(401);
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT value FROM config WHERE id=2").one().value)).toBe(persisted);
  await admin(`/api/nodes/${device.id}`,"DELETE");expect((await report(device)).status).toBe(403);
});

it("preserves sequence ordering across WS to HTTP to WS without replacing a recovered socket",async()=>{
  const device=await registered(),now=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(now),ws=await socket(device);
  await metrics(ws,1);await closeAgent();
  clock.mockReturnValue(now+1000);expect((await report(device,1)).status).toBe(409);expect((await report(device,2,45)).status).toBe(200);
  const recovering=await socket(device);await metrics(recovering,3,70);
  clock.mockReturnValue(now+61000);expect(await(await report(device,4)).json()).toMatchObject({code:"websocket_active"});
  expect((await state()).nodes[0]).toMatchObject({connected:true,metrics:{cpu_percent:70}});
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT active FROM fallback_nodes WHERE node_id=?",device.id).one().active)).toBe(0);
});

it("replaces a genuinely stale WS even when usage accounting has touched its attachment",async()=>{
  const device=await registered(),now=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(now),ws=await socket(device);
  await metrics(ws,1);clock.mockReturnValue(now+181000);
  await runInDurableObject(stub(),instance=>Reflect.get(instance,"flushUsage").call(instance));
  expect((await report(device,2,55)).status).toBe(200);
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.getWebSockets("agent").filter(ws=>!ws.deserializeAttachment().closed).length)).toBe(0);
  expect((await state()).nodes[0]).toMatchObject({connected:true,metrics:{cpu_percent:55},report_interval_seconds:60});
});

it.each([false,true])("allows fallback after a WS has never delivered metrics (hello=%s)",async(hello)=>{
  const device=await registered(),now=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(now);
  if(hello) await socket(device);
  else {
    const response=await consume(await signed(device,"/v1/live","GET",undefined,{Upgrade:"websocket"}));
    expect(response.status).toBe(101);response.webSocket!.accept();clients.add(response.webSocket!);await receive(response.webSocket!,"config");
  }
  clock.mockReturnValue(now+60000);
  expect((await report(device,1,65)).status).toBe(200);
  expect((await state()).nodes[0]).toMatchObject({connected:true,metrics:{cpu_percent:65},report_interval_seconds:60});
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.getWebSockets("agent").filter(ws=>!ws.deserializeAttachment().closed).length)).toBe(0);
});

it("does not close a newly upgraded WS while an older HTTP body is still arriving",async()=>{
  const device=await registered(),now=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(now);
  const payload=body(device),signedRequest=await signed(device,"/v1/metrics","POST",payload);
  await runInDurableObject(stub(),async(instance,ctx)=>{
    let stream!:ReadableStreamDefaultController<Uint8Array>;
    const request=new Request(signedRequest.url,{method:"POST",headers:{...Object.fromEntries(signedRequest.headers),"X-Monitor-Role":"agent","X-Monitor-Auth-Expires":String(now+86400000)},body:new ReadableStream({start(controller){stream=controller;}})});
    const pending=instance.fetch(request);clock.mockReturnValue(now+5000);
    const response=await instance.fetch(await signed(device,"/v1/live","GET",undefined,{Upgrade:"websocket","X-Monitor-Role":"agent","X-Monitor-Auth-Expires":String(now+86400000)}));
    const client=response.webSocket!;client.accept();clients.add(client);
    clock.mockReturnValue(now+10000);stream.enqueue(new TextEncoder().encode(JSON.stringify(payload)));stream.close();
    const result=await pending;expect(result.status).toBe(409);expect(await result.json()).toEqual({code:"websocket_active"});
    expect(ctx.getWebSockets("agent").filter(ws=>!ws.deserializeAttachment().closed)).toHaveLength(1);
  });
});

it("rejects an old delayed HTTP session after a newer WS report and close",async()=>{
  const device=await registered(),now=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(now);
  const encoded=JSON.stringify(body(device,1,2)),signedRequest=await signed(device,"/v1/metrics","POST",JSON.parse(encoded));
  await runInDurableObject(stub(),async(instance,ctx)=>{
    let stream!:ReadableStreamDefaultController<Uint8Array>;
    const request=new Request(signedRequest.url,{method:"POST",headers:{...Object.fromEntries(signedRequest.headers),"X-Monitor-Role":"agent","X-Monitor-Auth-Expires":String(now+86400000)},body:new ReadableStream({start(controller){stream=controller;}})});
    const pending=instance.fetch(request);
    clock.mockReturnValue(now+5000);
    const opening=await signed(device,"/v1/live","GET",undefined,{Upgrade:"websocket","X-Monitor-Role":"agent","X-Monitor-Auth-Expires":String(now+86400000)});
    const response=await instance.fetch(opening),client=response.webSocket!;client.accept();clients.add(client);
    const server=ctx.getWebSockets("agent")[0];
    await instance.webSocketMessage(server,JSON.stringify(body(device,1,80,{session:"b".repeat(32)})));
    clock.mockReturnValue(now+7000);server.close(1000);await instance.webSocketClose(server);
    clock.mockReturnValue(now+30000);stream.enqueue(new TextEncoder().encode(encoded));stream.close();
    const result=await pending;expect(result.status).toBe(409);expect(await result.json()).toEqual({code:"stale_report"});
  });
  expect((await state()).nodes[0].metrics.cpu_percent).toBe(80);
});

it("piggybacks update commands during fallback and confirms the installed revision",async()=>{
  const device=await registered(),now=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(now);
  await bundle();expect((await report(device)).status).toBe(200);
  const job=await(await admin(`/api/nodes/${device.id}/update-check`,"POST")).json() as any;
  expect(job).toMatchObject({state:"requested",version:"0.7.3",revision,expires_at:now+900000});
  clock.mockReturnValue(now+60000);expect(await(await report(device,2)).json()).toMatchObject({update_request_id:job.request_id});
  const result=(state:string,extra={})=>signed(device,"/v1/update/result","POST",{request_id:job.request_id,state,...extra}).then(consume);
  expect((await result("accepted")).status).toBe(200);expect((await result("updating")).status).toBe(200);
  expect((await result("failed",{code:"update_trigger_failed"})).status).toBe(409);
  clock.mockReturnValue(now+120000);
  expect(await(await report(device,3,12,{host:{...host,agent_version:"0.7.3",agent_revision:revision}})).json()).not.toHaveProperty("update_request_id");
  expect(await(await admin(`/api/nodes/${device.id}/update-status`)).json()).toMatchObject({state:"installed"});
});

it("reports a missing bridge from an unclaimed HTTP update command",async()=>{
  const device=await registered();await bundle();await report(device);
  const job=await(await admin(`/api/nodes/${device.id}/update-check`,"POST")).json() as any;
  const result=await consume(await signed(device,"/v1/update/result","POST",{request_id:job.request_id,state:"failed",code:"update_trigger_failed"}));
  expect(result.status).toBe(200);expect(await(await admin(`/api/nodes/${device.id}/update-status`)).json()).toMatchObject({state:"failed",code:"update_trigger_failed"});
});

it("keeps HTTP counters through hibernation and avoids per-report quota checkpoints when a viewer can retain them",async()=>{
  const device=await registered(),now=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(now);
  await report(device);await evictDurableObject(stub());
  expect((await(await admin("/api/quota")).json() as any).rows.find((row:any)=>row.id==="workers").value).toBeGreaterThan(0);
  await viewer();const saved=await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT value FROM config WHERE id=2").one().value);
  clock.mockReturnValue(now+60000);expect((await report(device,2)).status).toBe(200);
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT value FROM config WHERE id=2").one().value)).toBe(saved);
  await evictDurableObject(stub());expect((await state()).nodes[0].last_seen).toBe(now+60000);
});

it.each(["consumed","expired"])("allows only one timely in-flight report after a 5 to 600 second change (%s)",async(mode)=>{
  const device=await registered(),now=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(now),ws=await socket(device);
  await viewer();await metrics(ws,1);
  await runInDurableObject(stub(),async(instance,ctx)=>{const server=ctx.getWebSockets("viewer")[0];server.close(1000);await instance.webSocketClose(server);});
  clock.mockReturnValue(now+(mode==="expired"?35000:5000));
  await runInDurableObject(stub(),async(instance,ctx)=>{
    const server=ctx.getWebSockets("agent")[0];
    await instance.webSocketMessage(server,JSON.stringify({type:"metrics",sequence:2,metrics:{time:new Date(Date.now()).toISOString(),cpu_percent:22}}));
    expect(server.deserializeAttachment().sequence).toBe(mode==="expired"?1:2);
    if(mode==="consumed"){
      clock.mockReturnValue(now+10000);
      await instance.webSocketMessage(server,JSON.stringify({type:"metrics",sequence:3,metrics:{time:new Date(Date.now()).toISOString(),cpu_percent:33}}));
      expect(server.deserializeAttachment().sequence).toBe(2);
    }
  });
});
