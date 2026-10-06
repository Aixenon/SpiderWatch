import { createRemoteJWKSet, jwtVerify } from "jose";
import { json } from "./model";

// Cache only public keys; jose refreshes on rotation and cache expiry.
let keyCache: { domain: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

function accessDomain(value: string | undefined): string {
  const host = (value || "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(host) ? `https://${host}` : "";
}

export async function authorize(request: Request, env: Env, role: "agent" | "admin"): Promise<{ expires: number; subject: string; email?: string } | Response> {
  const host = new URL(request.url).hostname;
  if (env.LOCAL_DEV === "true") {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return json({ code: "local_mode_requires_loopback" }, 403);
    return { expires: Date.now() + 86400_000, subject: "local-development" };
  }
  const domain = accessDomain(env.ACCESS_TEAM_DOMAIN);
  const audience = (role === "agent" ? env.ACCESS_AGENT_AUD : env.ACCESS_PANEL_AUD)?.trim();
  const allowed = (env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!domain || !audience || role === "admin" && !allowed.length) return json({ code: "access_not_configured" }, 503);
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16384) return json({ code: "access_required" }, 401);
  try {
    if (keyCache?.domain !== domain) keyCache = { domain, keys: createRemoteJWKSet(new URL(domain + "/cdn-cgi/access/certs"), { timeoutDuration: 5000 }) };
    const keys = keyCache.keys;
    const { payload } = await jwtVerify(token, keys, { issuer: domain, audience, algorithms: ["RS256"] });
    if (!payload.exp) return json({ code: "invalid_access_token" }, 401);
    if (role === "admin") {
      if (typeof payload.email !== "string" || !allowed.includes(payload.email.toLowerCase())) return json({ code: "admin_required" }, 403);
    }
    return { expires: payload.exp * 1000, subject: String(payload.sub || ""), ...(role === "admin" ? { email: String(payload.email).toLowerCase() } : {}) };
  } catch { return json({ code: "invalid_access_token" }, 401); }
}
