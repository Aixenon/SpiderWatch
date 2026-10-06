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

it("fails closed before reading credentials when an Access setting is absent or blank", async () => {
  const configured = { ...env, LOCAL_DEV: "false", ACCESS_TEAM_DOMAIN: "monitor-settings.cloudflareaccess.com", ACCESS_PANEL_AUD: "panel", ADMIN_EMAILS: "owner@example.test" };
  const request = new Request("https://monitor.example.test/api/session", { headers: { "cf-access-jwt-assertion": "unverified" } });
  const fetch = vi.spyOn(globalThis, "fetch");
  const keys = ["ACCESS_TEAM_DOMAIN", "ACCESS_PANEL_AUD", "ADMIN_EMAILS"] as const;
  const absent = { ...configured };
  for (const key of keys) Reflect.deleteProperty(absent, key);
  const variants = [absent];
  for (const key of keys) {
    const missing = { ...configured };
    Reflect.deleteProperty(missing, key);
    variants.push(missing, { ...configured, [key]: "   " });
  }
  variants.push({ ...configured, ADMIN_EMAILS: " , , " });
  for (const settings of variants) {
    const result = await authorize(request, settings, "admin");
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("Expected configuration failure");
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ code: "access_not_configured" });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("normalizes copied Access team domains while preserving issuer, algorithm and expiry checks", async () => {
  const domain = "https://copied-team.cloudflareaccess.com", pair = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(pair.publicKey); jwk.kid = "copied"; jwk.alg = "RS256";
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    expect(String(input)).toBe(domain + "/cdn-cgi/access/certs");
    return Response.json({ keys: [jwk] });
  });
  const configured = { ...env, LOCAL_DEV: "false", ACCESS_TEAM_DOMAIN: domain, ACCESS_PANEL_AUD: "panel", ADMIN_EMAILS: " Other@Example.Test, OWNER@EXAMPLE.TEST " };
  const claims = () => new SignJWT({ email: "Owner@Example.Test" }).setIssuer(domain).setAudience("panel").setSubject("owner-id");
  const token = await claims().setProtectedHeader({ alg: "RS256", kid: "copied" }).setExpirationTime("1h").sign(pair.privateKey);
  const request = (value: string) => new Request("https://monitor.example.test/api/session", { headers: { "cf-access-jwt-assertion": value } });
  for (const team of ["copied-team.cloudflareaccess.com", " COPIED-TEAM.CLOUDFLAREACCESS.COM ", " HTTPS://COPIED-TEAM.CLOUDFLAREACCESS.COM/ "]) {
    expect(await authorize(request(token), { ...configured, ACCESS_TEAM_DOMAIN: team }, "admin")).toMatchObject({ subject: "owner-id", email: "owner@example.test" });
  }
  const wrongIssuer = await claims().setIssuer("https://other-team.cloudflareaccess.com").setProtectedHeader({ alg: "RS256", kid: "copied" }).setExpirationTime("1h").sign(pair.privateKey);
  const noExpiry = await claims().setProtectedHeader({ alg: "RS256", kid: "copied" }).sign(pair.privateKey);
  const wrongAlgorithm = await claims().setProtectedHeader({ alg: "HS256", kid: "copied" }).setExpirationTime("1h").sign(new Uint8Array(32).fill(7));
  const parts = token.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  for (const invalid of [wrongIssuer, noExpiry, wrongAlgorithm, parts.join(".")]) {
    expect((await authorize(request(invalid), configured, "admin") as Response).status).toBe(401);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects team domains containing another host, protocol or URL component without fetching keys", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const configured = { ...env, LOCAL_DEV: "false", ACCESS_PANEL_AUD: "panel", ADMIN_EMAILS: "owner@example.test" };
  for (const team of [
    "https://example.test", "https://team.cloudflareaccess.com.example.test", "http://team.cloudflareaccess.com",
    "https://team.cloudflareaccess.com:443", "https://team.cloudflareaccess.com/path", "team.cloudflareaccess.com/another",
    "https://team.cloudflareaccess.com?next=example.test", "https://team.cloudflareaccess.com#fragment",
    "https://user@team.cloudflareaccess.com", "https://team.cloudflareaccess.com@example.test", "https://team.cloudflareaccess.com\\evil",
    "https://-team.cloudflareaccess.com", "https://team-.cloudflareaccess.com", "https://a.b.cloudflareaccess.com",
  ]) {
    const result = await authorize(new Request("https://monitor.example.test", { headers: { "cf-access-jwt-assertion": "unverified" } }), { ...configured, ACCESS_TEAM_DOMAIN: team }, "admin");
    expect((result as Response).status).toBe(503);
  }
  expect(fetch).not.toHaveBeenCalled();
});
