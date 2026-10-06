import { invitationHeaders } from "./invitation-fixture";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { authorize } from "../src/auth";
import worker from "../src/index";

afterEach(async()=>{vi.restoreAllMocks();await reset();});
it("validates Access signatures, audience, expiration and the panel administrator",async()=>{
  const domain="https://monitor-test.cloudflareaccess.com",pair=await generateKeyPair("RS256",{extractable:true});
  const jwk=await exportJWK(pair.publicKey);jwk.kid="test-key";jwk.alg="RS256";
  vi.spyOn(globalThis,"fetch").mockImplementation(async input=>{
    expect(String(input)).toBe(domain+"/cdn-cgi/access/certs");
    return Response.json({keys:[jwk]});
  });
  const configured={...env,LOCAL_DEV:"false",INVITATION_SECRET:"local-development-invitations-only",ACCESS_TEAM_DOMAIN:domain,ACCESS_PANEL_AUD:"panel",ACCESS_AGENT_AUD:"agents",ADMIN_EMAILS:"owner@example.test"};
  const token=async(aud:string,email="owner@example.test",expired=false)=>new SignJWT({email})
    .setProtectedHeader({alg:"RS256",kid:"test-key"}).setIssuer(domain).setAudience(aud).setIssuedAt().setExpirationTime(expired?Math.floor(Date.now()/1000)-60:"1h").sign(pair.privateKey);
  const request=async(aud:string,email?:string,expired=false)=>new Request("https://monitor.example.test/api/state",{headers:{"cf-access-jwt-assertion":await token(aud,email,expired)}});
  expect(await authorize(await request("panel"),configured,"admin")).not.toBeInstanceOf(Response);
  expect((await authorize(await request("agents"),configured,"admin") as Response).status).toBe(401);
  expect((await authorize(await request("panel","stranger@example.test"),configured,"admin") as Response).status).toBe(403);
  expect((await authorize(await request("panel",undefined,true),configured,"admin") as Response).status).toBe(401);
  expect(await authorize(await request("agents","service@example.test"),configured,"agent")).not.toBeInstanceOf(Response);
  expect((await authorize(new Request("https://monitor.example.test"),configured,"admin") as Response).status).toBe(401);
  expect((await authorize(new Request("https://monitor.example.test"),{...configured,ACCESS_TEAM_DOMAIN:""},"admin") as Response).status).toBe(503);
  const enrollRequest=async(jwt?:string)=>new Request("https://agent.example.test/v1/enroll",{method:"POST",headers:{...await invitationHeaders(),"Content-Type":"application/json",...(jwt?{"cf-access-jwt-assertion":jwt}:{})},body:JSON.stringify({protocol:1,node_id:"f".repeat(32),device_key:"e".repeat(64),group:env.MONITOR_GROUP,host:{hostname:"service-node",os:"linux",arch:"arm",cpus:1,agent_version:"0.2.0"}})});
  expect((await worker.fetch(await enrollRequest(),configured)).status).toBe(401);
  expect((await worker.fetch(await enrollRequest(await token("panel")),configured)).status).toBe(401);
  const joined=await worker.fetch(await enrollRequest(await token("agents","service@example.test")),configured);
  expect(joined.status).toBe(200);expect(await joined.json()).toMatchObject({state:"approved"});
});
