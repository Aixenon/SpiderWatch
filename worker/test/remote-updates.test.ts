import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { invitationHeaders } from "./invitation-fixture";

const origin="http://127.0.0.1", id="7".repeat(32), key="8".repeat(64), revision="c".repeat(40);
const headers={"X-Monitor-Node-ID":id,Authorization:"Bearer "+key};
const host={hostname:"remote-update",os:"windows",arch:"amd64",cpus:2};
const clients=new Set<WebSocket>(), stub=()=>env.MONITOR.getByName(env.MONITOR_GROUP);
async function request(path:string,method="GET",body?:unknown,extra:Record<string,string>={}) {
  const response=await worker.fetch(new Request(origin+(path.startsWith("/api/")?"/panel":"")+path,{method,headers:{Origin:origin,"Content-Type":"application/json",...extra},body:body===undefined?undefined:JSON.stringify(body)}),env);
  return response.status===101?response:new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
}
const status=async()=>await (await request(`/api/nodes/${id}/update-status`)).json() as any;
function receive(ws:WebSocket,type:string):Promise<any> {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.removeEventListener("message",listener);reject(new Error(type));},5000);const listener=(event:MessageEvent)=>{const body=JSON.parse(event.data as string);if(body.type===type){clearTimeout(timer);ws.removeEventListener("message",listener);resolve(body);}};ws.addEventListener("message",listener);});
}
async function setup() {
  const response=await request("/bootstrap/enroll","POST",{protocol:1,node_id:id,device_key:key,group:env.MONITOR_GROUP,host:{...host,agent_version:"0.7.1"}},await invitationHeaders());expect(response.status).toBe(200);
  vi.spyOn(env.ASSETS,"fetch").mockImplementation(async()=>Response.json({schema:1,version:"0.7.2",revision,repository:"owner/project",build:"d".repeat(64),
    assets:[{os:"windows",arch:"amd64",file:"spider-watch-windows-amd64.exe",bytes:2048,sha256:"a".repeat(64)}],
    files:[{file:"spider-watch-windows-amd64.exe",bytes:2048,sha256:"a".repeat(64)}]}));
  await refreshEnv();
}
async function refreshEnv() {await runInDurableObject(stub(),instance=>Reflect.set(instance,"env",{...Reflect.get(instance,"env"),ASSETS:env.ASSETS,UPDATE_GITHUB_REPOSITORY:"owner/project"}));}
async function socket(capability=true,version="0.7.1",build="b".repeat(40)) {
  const response=await request("/v1/live","GET",undefined,{...headers,Upgrade:"websocket","X-Monitor-Agent-Version":version,"X-Monitor-Agent-Revision":build});expect(response.status).toBe(101);
  const ws=response.webSocket!;clients.add(ws);ws.accept();await receive(ws,"config");
  const ack=receive(ws,"hello_ack");ws.send(JSON.stringify({type:"hello",protocol:2,session:crypto.randomUUID().replaceAll("-",""),host,...(capability?{update_control:1}:{})}));await ack;return ws;
}
async function dispatch(ws:WebSocket) {
  const command=receive(ws,"update");const response=await request(`/api/nodes/${id}/update-check`,"POST");expect(response.status).toBe(200);
  const job=await response.json() as any;expect(await command).toEqual({type:"update",request_id:job.request_id});return job;
}
const result=(job:any,state:string)=>request("/v1/update/result","POST",{request_id:job.request_id,state},headers);
afterEach(async()=>{for(const ws of clients){try{ws.close(1000);}catch{}}clients.clear();vi.restoreAllMocks();await reset();});

it("sends immediately, survives hibernation and confirms the installed revision on reconnect",async()=>{
  await setup();const ws=await socket();const job=await dispatch(ws);expect(job).toMatchObject({state:"requested",version:"0.7.2",revision});expect(job).not.toHaveProperty("claimed");
  await evictDurableObject(stub());await refreshEnv();
  expect(await(await request(`/api/nodes/${id}/update-check`,"POST")).json()).toEqual(job);
  expect(await(await request("/v1/update/request","GET",undefined,headers)).json()).toMatchObject({request_id:job.request_id,revision});
  expect((await result(job,"accepted")).status).toBe(200);
  expect((await result(job,"accepted")).status).toBe(409);
  expect(await(await request("/v1/update/request","GET",undefined,headers)).json()).toEqual({request_id:""});
  expect((await result(job,"updating")).status).toBe(200);
  ws.send(JSON.stringify({type:"update_ack",request_id:job.request_id,state:"accepted"}));
  await socket(true,"0.7.2","a".repeat(40));expect(await status()).toMatchObject({state:"updating"});
  await socket(true,"0.7.2",revision);expect(await status()).toMatchObject({state:"installed"});
  expect((await result(job,"failed")).status).toBe(409);
});

it("requires a capable online client and reports a missing system update task",async()=>{
  await setup();await socket(false);expect(await(await request(`/api/nodes/${id}/update-check`,"POST")).json()).toEqual({code:"update_client_upgrade_required"});
  const ws=await socket();const job=await dispatch(ws);
  ws.send(JSON.stringify({type:"update_ack",request_id:job.request_id,state:"failed",code:"update_trigger_failed"}));
  // A subsequent hello is ordered after this socket message and confirms processing.
  const ack=receive(ws,"ack");ws.send(JSON.stringify({type:"metrics",sequence:1,metrics:{time:new Date().toISOString(),cpu_percent:1}}));await ack;
  expect(await status()).toMatchObject({state:"failed",code:"update_trigger_failed"});
  expect((await result(job,"accepted")).status).toBe(409);
});

it("bounds expiry without alarms and removes jobs when authorization is deleted",async()=>{
  await setup();const ws=await socket();const job=await dispatch(ws);
  await runInDurableObject(stub(),(_,ctx)=>{job.expires_at=Date.now()-1;ctx.storage.sql.exec("UPDATE node_updates SET value=? WHERE node_id=?",JSON.stringify(job),id);});
  expect(await status()).toMatchObject({state:"timeout",code:"update_request_expired"});
  expect((await result(job,"accepted")).status).toBe(409);
  expect((await request("/v1/update/request")).status).toBe(401);
  await request(`/api/nodes/${id}`,"DELETE");
  expect((await request("/v1/update/request","GET",undefined,headers)).status).toBe(403);
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM node_updates").one().n)).toBe(0);
});

it("rejects unclaimed results, forged job IDs and uses one job for simultaneous clicks",async()=>{
  await setup();const ws=await socket();const command=receive(ws,"update");
  const responses=await Promise.all([request(`/api/nodes/${id}/update-check`,"POST"),request(`/api/nodes/${id}/update-check`,"POST")]);
  const jobs=await Promise.all(responses.map(response=>response.json())) as any[];expect(jobs[0].request_id).toBe(jobs[1].request_id);await command;
  expect((await result(jobs[0],"updating")).status).toBe(409);
  expect((await result({...jobs[0],request_id:"a".repeat(32)},"accepted")).status).toBe(409);
  expect((await result(jobs[0],"accepted")).status).toBe(200);
  expect((await result(jobs[0],"up_to_date")).status).toBe(200);expect(await status()).toMatchObject({state:"up_to_date"});
});

it("redelivers an unclaimed command after reconnect without creating a second job",async()=>{
  await setup();const first=await socket();const job=await dispatch(first);first.close(1000);
  await evictDurableObject(stub());await refreshEnv();
  const response=await request("/v1/live","GET",undefined,{...headers,Upgrade:"websocket","X-Monitor-Agent-Version":"0.7.1"});
  const ws=response.webSocket!;clients.add(ws);ws.accept();await receive(ws,"config");
  const command=receive(ws,"update"), hello=receive(ws,"hello_ack");
  ws.send(JSON.stringify({type:"hello",protocol:2,session:"e".repeat(32),host,update_control:1}));
  await hello;expect(await command).toEqual({type:"update",request_id:job.request_id});
  expect((await result(job,"accepted")).status).toBe(200);expect((await result(job,"accepted")).status).toBe(409);
  expect((await status()).request_id).toBe(job.request_id);
});
