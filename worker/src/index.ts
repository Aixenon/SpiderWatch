import { authorize } from "./auth";
import { json } from "./model";
import { handleUpdates, isUpdatePath } from "./updates";
import { signedHeadersValid, verifyInvitation } from "./identity";
import { panelAuthFailure } from "./panel-auth";
export { MonitorGroup } from "./monitor";

function hasDeviceCredentials(request: Request): boolean {
  return signedHeadersValid(request) || /^[a-f0-9]{32}$/.test(request.headers.get("X-Monitor-Node-ID") || "")
    && /^Bearer [a-f0-9]{64}$/.test(request.headers.get("Authorization") || "");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/internal/") || url.pathname === "/agent-releases" || url.pathname.startsWith("/agent-releases/")) return json({ code: "not_found" }, 404);
    const bootstrap = url.pathname === "/bootstrap/enroll" || url.pathname === "/bootstrap/status";
    const agent = url.pathname.startsWith("/v1/");
    const local = env.LOCAL_DEV === "true" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (env.LOCAL_DEV === "true" && !local) return json({ code: "local_mode_requires_loopback" }, 403);
    if ((bootstrap || agent) && !local && url.protocol !== "https:") return json({ code: "https_required" }, 400);
    const enrollment = url.pathname === "/bootstrap/enroll" || url.pathname === "/v1/enroll";
    if (enrollment && Number(request.headers.get("Content-Length")) > 32768) return json({ code: "payload_too_large" }, 413);
    if (enrollment && !await verifyInvitation(env, request.headers.get("X-Monitor-Invitation") || "")) return json({ code: "invitation_invalid_or_expired" }, 403);
    if (bootstrap || enrollment) {
      if (request.method !== "POST" || request.headers.get("Upgrade")) return json({ code: "method_not_allowed" }, 405);
      const local = env.LOCAL_DEV === "true" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (env.LOCAL_DEV === "true" && !local) return json({ code: "local_mode_requires_loopback" }, 403);
      if (!local && url.protocol !== "https:") return json({ code: "https_required" }, 400);
      // Reject cheap-to-detect malformed public requests before waking the DO.
      // The DO still reads a bounded stream, since Content-Length can be absent.
      if (Number(request.headers.get("Content-Length")) > 32768) return json({ code: "payload_too_large" }, 413);
      if (url.pathname === "/bootstrap/status" && !hasDeviceCredentials(request)) return json({ code: "device_auth_required" }, 401);
      if (!local) {
        // New identities and approval polling use independent budgets, so
        // frequent polling cannot consume the stricter enrollment allowance.
        const limiter = enrollment ? env.BOOTSTRAP_ENROLL_LIMITER : env.BOOTSTRAP_LIMITER;
        if (!limiter) return json({ code: "bootstrap_not_configured" }, 503);
        if (!(await limiter.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" })).success) return json({ code: "rate_limited" }, 429);
      }
    }
    const signed = signedHeadersValid(request);
    // Header syntax is only an ingress check; the DO verifies the registered
    // public key, permission and replay protection before accepting a device.
    const auth = bootstrap || agent && signed ? { expires: Number.MAX_SAFE_INTEGER, subject: "device" } : await authorize(request, env, agent ? "agent" : "admin");
    if (auth instanceof Response) return !bootstrap && !agent && !url.pathname.startsWith("/api/") ? panelAuthFailure(request, auth) : auth;
    if (url.pathname === "/api/session" || url.pathname === "/auth/login") {
      if (request.method !== "GET") return json({ code: "method_not_allowed" }, 405);
      if (url.pathname === "/auth/login") return new Response(null, { status: 302, headers: { Location: "/#/", "Cache-Control": "no-store" } });
      // No DO or identity API lookup: expose only the already-verified identity.
      return json({ authenticated: true, email: "email" in auth ? auth.email : null, expires_at: auth.expires, mode: local ? "local" : "access" });
    }
    const mutation = !["GET", "HEAD"].includes(request.method);
    const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (!bootstrap && !agent && (mutation || upgrade) && request.headers.get("Origin") !== url.origin) return json({ code: "origin_rejected" }, 403);
    // Only small update settings/metadata enter the DO; binaries stream from GitHub.
    if (isUpdatePath(url.pathname)) {
      if (agent && !hasDeviceCredentials(request)) return json({code:"device_auth_required"},401);
      return handleUpdates(request, env);
    }
    if (request.method === "GET" && (url.pathname === "/v1/live" || /^\/v1\/nodes\/[a-f0-9]{32}\/status$/.test(url.pathname))
      && !hasDeviceCredentials(request)) return json({ code: "device_auth_required" }, 401);
    if (!bootstrap && !agent && !url.pathname.startsWith("/api/")) {
      if (mutation) return json({ code: "method_not_allowed" }, 405);
      const asset = await env.ASSETS.fetch(request);
      if (!asset.headers.get("Content-Type")?.includes("text/html")) return asset;
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "private, no-store");
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    }
    const headers = new Headers(request.headers);
    // Never trust a caller's copy of the authorization result.
    headers.set("X-Monitor-Role", bootstrap ? "bootstrap" : agent ? "agent" : "admin");
    headers.set("X-Monitor-Auth-Expires", String(auth.expires));
    headers.delete("cf-access-jwt-assertion");
    const forwarded = new Request(request, { headers });
    try {
      return await env.MONITOR.getByName(env.MONITOR_GROUP).fetch(forwarded);
    } catch {
      console.error(JSON.stringify({ event: "monitor_request_failed", method: request.method, path: url.pathname }));
      return json({ code: "temporarily_unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
