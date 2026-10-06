import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { issueInvitation } from "../src/identity";

const origin = "http://127.0.0.1";
const host = {hostname:"dedicated-key-node",os:"windows",arch:"amd64",cpus:2,agent_version:"0.5.0"};
const sockets: WebSocket[] = [];
const stub = () => env.MONITOR.getByName(env.MONITOR_GROUP);
const base64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
async function identity(id = crypto.randomUUID().replaceAll("-","")) {
  const pair = await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]) as CryptoKeyPair;
  const wire = new Uint8Array(51), view = new DataView(wire.buffer);
  view.setUint32(0,11); wire.set(new TextEncoder().encode("ssh-ed25519"),4); view.setUint32(15,32);
  const exported = await crypto.subtle.exportKey("raw",pair.publicKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("expected raw public key");
  wire.set(new Uint8Array(exported),19);
  return {id, key:pair.privateKey, publicKey:"ssh-ed25519 "+base64(wire)};
}
type Identity = Awaited<ReturnType<typeof identity>>;
async function signed(device: Identity, path: string, method = "GET", body?: unknown, extra: Record<string,string> = {}, requestOrigin = origin) {
  const encoded = body === undefined ? "" : JSON.stringify(body);
  const headers = new Headers({"Content-Type":"application/json","X-Monitor-Node-ID":device.id,
    "X-Monitor-Time":String(Date.now()),"X-Monitor-Nonce":crypto.randomUUID().replaceAll("-",""),...extra});
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(encoded)));
  const digestText = Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");
  const payload = ["cf-monitor-auth-v1",method,requestOrigin,path,device.id,headers.get("X-Monitor-Time"),headers.get("X-Monitor-Nonce"),digestText].join("\n");
  headers.set("X-Monitor-Signature",base64(await crypto.subtle.sign("Ed25519",device.key,new TextEncoder().encode(payload))));
  return new Request(requestOrigin+path,{method,headers,body:body===undefined?undefined:encoded});
}
async function consume(request: Request) {
  const r = await worker.fetch(request,env);
  return r.status===101 ? r : new Response(await r.arrayBuffer(),{status:r.status,headers:r.headers});
}
async function admin(path:string, method="GET") {
  return consume(new Request(origin+"/panel"+path,{method,headers:{Origin:origin}}));
}
async function invite() {
  const r = await admin("/api/invitations","POST"); expect(r.status).toBe(200);
  const result = await r.json<{id:string;server:string;expires_at:number;network:string}>();
  return {...result,token:new URLSearchParams(new URL(result.server).hash.slice(1)).get("invite")!};
}
async function enrollment(device: Identity, invitation: Awaited<ReturnType<typeof invite>>) {
  return signed(device,"/bootstrap/enroll","POST",{protocol:2,node_id:device.id,group:invitation.network,public_key:device.publicKey,host},{"X-Monitor-Invitation":invitation.token});
}
async function registered() {
  const device = await identity(), invitation = await invite();
  expect(await (await consume(await enrollment(device,invitation))).json()).toMatchObject({state:"approved"});
  return {device,invitation};
}
afterEach(async()=>{for(const ws of sockets)try{ws.close(1000);}catch{} sockets.length=0;vi.restoreAllMocks();await reset();});

it("authenticates production HTTPS using device signatures without a shared gate",async()=>{
  const {device}=await registered(), productionOrigin="https://monitor.example.com";
  const production={...env,LOCAL_DEV:"false",ACCESS_AGENT_AUD:""} as Env;
  const request=await signed(device,`/v1/nodes/${device.id}/status`,"GET",undefined,{},productionOrigin);
  const response=await worker.fetch(request,production);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:"approved"});
});

it("rejects absent, forged and expired invitations before reaching a DO",async()=>{
  const expired = await issueInvitation(env,"a".repeat(32),Date.now()-1);
  const lookup = vi.spyOn(env.MONITOR,"getByName").mockImplementation(()=>{throw new Error("must not enter DO");});
  for(const token of ["",expired,"a".repeat(32)+"."+(Date.now()+300000)+"."+"b".repeat(43)+"="]){
    const r=await consume(new Request(origin+"/bootstrap/enroll",{method:"POST",headers:{"X-Monitor-Invitation":token},body:"{}"}));
    expect(r.status).toBe(403);
  }
  expect(lookup).not.toHaveBeenCalled();
});

it("opens only one five-minute window and a replacement command invalidates the previous one",async()=>{
  const first=await invite(), second=await invite(), device=await identity();
  expect(second.expires_at-Date.now()).toBeGreaterThan(290000);
  expect(second.expires_at-Date.now()).toBeLessThanOrEqual(300000);
  expect(new URL(second.server).hash).not.toContain("gate");
  const state=await (await admin("/api/state?view=live")).json<any>();
  expect(state.invitations.map((i:{id:string})=>i.id)).toEqual([second.id]);
  expect(await (await consume(await enrollment(device,first))).json()).toMatchObject({code:"registration_closed"});
  const clock=vi.spyOn(Date,"now").mockReturnValue(second.expires_at);
  try {
    const response=await consume(await enrollment(device,second));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({code:"invitation_invalid_or_expired"});
  } finally { clock.mockRestore(); }
});

it("closes old multi-device windows during upgrade while preserving registered identities",async()=>{
  const {device}=await registered();
  await invite();
  await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("UPDATE config SET value='2' WHERE id=4"));
  await evictDurableObject(stub());
  const state=await (await admin("/api/state?view=live")).json<any>();
  expect(state.invitations).toEqual([]);
  expect(state.nodes[0]).toMatchObject({node_id:device.id,state:"approved"});
  expect(await (await consume(await signed(device,"/bootstrap/status","POST"))).json()).toMatchObject({state:"approved"});
});

it("closes registration immediately after one concurrent claimant succeeds",async()=>{
  const invitation=await invite(), first=await identity(), second=await identity();
  expect(invitation.expires_at-Date.now()).toBeGreaterThan(290000);
  const requests=await Promise.all([enrollment(first,invitation),enrollment(second,invitation)]);
  const results=await Promise.all(requests.map(consume));
  expect(results.map(r=>r.status).sort()).toEqual([200,403]);
  const winner=results[0].status===200?first:second;
  expect(await (await consume(await enrollment(winner,invitation))).json()).toMatchObject({code:"registration_closed"});
  expect(await (await consume(await signed(winner,"/bootstrap/status","POST"))).json()).toMatchObject({state:"approved"});
  await evictDurableObject(stub());
  expect((await consume(await enrollment(winner,invitation))).status).toBe(403);
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.getAlarm())).toBeNull();
  const state=await (await admin("/api/state?view=live")).json<any>();
  expect(state.nodes).toHaveLength(1);expect(state.invitations).toHaveLength(0);
  expect(state.nodes[0]).toMatchObject({node_id:winner.id,state:"approved"});
  const rows=await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT key_hash,public_key FROM nodes").toArray());
  expect(rows).toEqual([{key_hash:"",public_key:winner.publicKey}]);
});

it("rejects key substitution and public-key reuse across UUIDs without consuming an unused invitation",async()=>{
  const {device}=await registered(), next=await invite();
  const impostor=await identity(device.id);
  expect((await consume(await enrollment(impostor,next))).status).toBe(409);
  const clone={...device,id:crypto.randomUUID().replaceAll("-","")};
  expect((await consume(await enrollment(clone,next))).status).toBe(409);
  const honest=await identity();
  expect((await consume(await enrollment(honest,next))).status).toBe(200);
});

it("requires private-key proof, binds the method/path/body, and retains replay protection after eviction",async()=>{
  const {device}=await registered();
  const request=await signed(device,"/bootstrap/status","POST");
  const copy=request.clone();
  expect((await consume(request)).status).toBe(200);
  await evictDurableObject(stub());
  expect((await consume(copy)).status).toBe(409);
  const other=await identity(device.id);
  expect((await consume(await signed(other,"/bootstrap/status","POST"))).status).toBe(401);
  const altered=await signed(device,"/bootstrap/status","POST");
  expect((await consume(new Request(altered,{body:"{}"}))).status).toBe(401);
  const stale=await signed(device,"/bootstrap/status","POST",undefined,{"X-Monitor-Time":String(Date.now()-61000)});
  expect((await consume(stale)).status).toBe(401);
  const bearer=new Request(origin+"/bootstrap/status",{method:"POST",headers:{"X-Monitor-Node-ID":device.id,Authorization:"Bearer "+"a".repeat(64)}});
  expect((await consume(bearer)).status).toBe(401);
});

it("expires and deletes only invitations, while approved identities survive and need no Access credential",async()=>{
  const {device,invitation}=await registered();
  await invite();
  await runInDurableObject(stub(),(_,ctx)=>{ctx.storage.sql.exec("UPDATE invitations SET expires_at=?",Date.now()-1);});
  // Restore the in-memory deadline after changing storage directly in this fixture.
  await evictDurableObject(stub());
  await runDurableObjectAlarm(stub());
  expect(await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("SELECT * FROM invitations").toArray())).toEqual([]);
  expect(await (await consume(await signed(device,"/bootstrap/status","POST"))).json()).toMatchObject({state:"approved"});
  expect((await consume(await enrollment(device,invitation))).status).toBe(403);
  const upgrade=await consume(await signed(device,"/v1/live","GET",undefined,{Upgrade:"websocket","X-Monitor-Agent-Version":"0.5.0"}));
  expect(upgrade.status).toBe(101);const ws=upgrade.webSocket!;sockets.push(ws);ws.accept();
  await evictDurableObject(stub());
  const state=await (await admin("/api/state?view=live")).json<any>();
  expect(state.nodes[0]).toMatchObject({state:"approved",connected:true});
});

it("cancels unused invitations and prevents a deleted device being recreated with a used invitation",async()=>{
  const unused=await invite(), fresh=await identity();
  await admin(`/api/invitations/${unused.id}`,"DELETE");
  expect((await consume(await enrollment(fresh,unused))).status).toBe(403);
  const {device,invitation}=await registered();
  await admin(`/api/nodes/${device.id}`,"DELETE");
  expect((await consume(await signed(device,"/bootstrap/status","POST"))).status).toBe(403);
  expect((await consume(await enrollment(device,invitation))).status).toBe(403);
  const newInvitation=await invite();
  expect(await (await consume(await enrollment(device,newInvitation))).json()).toMatchObject({state:"approved"});
});

it("authenticates update checks too, without querying GitHub for pending, unknown or revoked identities",async()=>{
  const {device}=await registered();
  await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("UPDATE nodes SET state='pending' WHERE node_id=?",device.id));
  const github=vi.spyOn(globalThis,"fetch").mockImplementation(()=>{throw new Error("unexpected upstream request");});
  expect((await consume(await signed(device,"/v1/update/check"))).status).toBe(403);
  const renewed=await invite();
  expect(await (await consume(await enrollment(device,renewed))).json()).toMatchObject({state:"approved"});
  expect(await (await consume(await signed(device,"/v1/update/check"))).json()).toMatchObject({enabled:false});
  await admin(`/api/nodes/${device.id}`,"DELETE");
  expect((await consume(await signed(device,"/v1/update/check"))).status).toBe(403);
  expect(github).not.toHaveBeenCalled();
});

it("tracks the exact invitation after registration, eviction and re-enrollment",async()=>{
  const device=await identity(), invitation=await invite();
  expect(await (await admin(`/api/invitations/${invitation.id}`)).json()).toMatchObject({state:"pending"});
  expect((await consume(await enrollment(device,invitation))).status).toBe(200);
  await evictDurableObject(stub());
  expect(await (await admin(`/api/invitations/${invitation.id}`)).json()).toEqual({state:"registered",node_id:device.id});
  expect(await (await admin(`/api/invitations/${"f".repeat(32)}`)).json()).toEqual({state:"closed"});
  const renewed=await invite();
  expect((await consume(await enrollment(device,renewed))).status).toBe(200);
  expect(await (await admin(`/api/invitations/${renewed.id}`)).json()).toEqual({state:"registered",node_id:device.id});
  expect(await (await admin(`/api/invitations/${invitation.id}`)).json()).toEqual({state:"closed"});
  await admin(`/api/nodes/${device.id}`,"DELETE");
  expect(await (await admin(`/api/invitations/${renewed.id}`)).json()).toEqual({state:"closed"});
});

it("blocks signed update downloads for pending, unknown and revoked keys before upstream work",async()=>{
  const {device}=await registered(), unknown=await identity();
  const remote=vi.spyOn(globalThis,"fetch").mockImplementation(()=>{throw new Error("unexpected download");});
  const paths=["/v1/update/automatic","/v1/updates/agent/stable/manifest.json",`/v1/updates/agent/stable/0.4.0/${"a".repeat(64)}/spider-watch-windows-amd64.exe`];
  await runInDurableObject(stub(),(_,ctx)=>ctx.storage.sql.exec("UPDATE nodes SET state='pending' WHERE node_id=?",device.id));
  for(const identity of [device,unknown]) for(const path of paths) for(const method of ["GET","HEAD"]) expect((await consume(await signed(identity,path,method))).status).toBe(403);
  await admin(`/api/nodes/${device.id}`,"DELETE");
  for(const path of paths) expect((await consume(await signed(device,path))).status).toBe(403);
  expect(remote).not.toHaveBeenCalled();
});
