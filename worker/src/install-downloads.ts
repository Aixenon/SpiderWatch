import { verifyInvitation } from "./identity";
import { json } from "./model";
import { bundledAsset, readBundledRelease, streamBundledFile, UpdateSourceError } from "./update-source";

export function isInstallPath(path: string): boolean {
  return path === "/install.sh" || path.startsWith("/bootstrap/install/");
}
function failure(error: unknown): Response {
  if (error instanceof UpdateSourceError) return json({ code: error.code }, error.status);
  // Invitation-bearing URLs must never be included in application logs.
  console.error(JSON.stringify({ event: "install_download_failed" }));
  return json({ code: "download_temporarily_unavailable" }, 503);
}
async function installerBytes(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const maximum = 64 * 1024;
  const length = response.headers.get("Content-Length"), encoding = response.headers.get("Content-Encoding");
  if (response.status !== 200 || !response.body || (encoding && encoding !== "identity")
    || (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))
    || response.headers.get("Content-Type")?.includes("text/html")) {
    await response.body?.cancel(); throw new UpdateSourceError("installer_unavailable", 503);
  }
  // ASSETS may omit Content-Length. Only this small public script is buffered;
  // executable downloads keep their bounded native streams.
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new UpdateSourceError("installer_unavailable", 503); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size || (length !== null && size !== Number(length))) throw new UpdateSourceError("installer_unavailable", 503);
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export async function handleInstallDownload(request: Request, env: Env, local: boolean): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (!local && url.protocol !== "https:") return json({ code: "https_required" }, 400);
    if (!["GET", "HEAD"].includes(request.method) || request.headers.has("Upgrade")) return json({ code: "method_not_allowed" }, 405);
    if (url.search) return json({ code: "not_found" }, 404);
    if (url.pathname === "/install.sh") {
      const body = await installerBytes(await bundledAsset(env, "/install.sh"));
      return new Response(request.method === "HEAD" ? null : body, { headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8", "Content-Length": String(body.byteLength),
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      } });
    }
    const match = /^\/bootstrap\/install\/([^/]{1,200})\/(current\.json|[0-9.]+\/[^/]{1,100})$/.exec(url.pathname);
    if (!match) return json({ code: "not_found" }, 404);
    let token: string;
    try { token = decodeURIComponent(match[1]); } catch { return json({ code: "invitation_invalid_or_expired" }, 403); }
    const invitation = await verifyInvitation(env, token);
    if (!invitation) return json({ code: "invitation_invalid_or_expired" }, 403);
    if (!local) {
      if (!env.BOOTSTRAP_LIMITER) return json({ code: "bootstrap_not_configured" }, 503);
      if (!(await env.BOOTSTRAP_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" })).success) return json({ code: "rate_limited" }, 429);
    }
    const permission = await env.MONITOR.getByName(env.MONITOR_GROUP).fetch(new Request("http://do/internal/install-authorize", {
      headers: { "X-Monitor-Role": "install", "X-Monitor-Auth-Expires": String(invitation.expires), "X-Monitor-Invitation-ID": invitation.id },
    }));
    if (!permission.ok) return permission;
    await permission.body?.cancel();
    const release = await readBundledRelease(env);
    if (match[2] === "current.json") return request.method === "HEAD"
      ? new Response(null, { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } }) : json(release);
    const [version, name] = match[2].split("/");
    const file = release.files.find(file => file.file === name);
    if (version !== release.version || !file) return json({ code: "download_not_found" }, 404);
    return await streamBundledFile(env, version, file, request.method);
  } catch (error) { return failure(error); }
}
/** Called only after the panel session has been verified. */
export async function handlePanelDownload(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (!["GET", "HEAD"].includes(request.method)) return json({ code: "method_not_allowed" }, 405);
    const match = /^\/downloads\/(spider-watch-windows-(?:amd64|arm64|386)-setup\.exe)$/.exec(url.pathname);
    if (!match || url.search) return json({ code: "download_not_found" }, 404);
    const release = await readBundledRelease(env), file = release.files.find(file => file.file === match[1]);
    if (!file) return json({ code: "download_not_found" }, 404);
    return await streamBundledFile(env, release.version, file, request.method);
  } catch (error) { return failure(error); }
}
