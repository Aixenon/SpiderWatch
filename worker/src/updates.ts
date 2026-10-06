import { json } from "./model";
import { readUpdateJSON, streamBundledFile, updateRepository, validUpdatePath,
  UpdateSourceError, type UpdateConfig, type UpdateRelease, type UpdateState } from "./update-source";

export function isUpdatePath(path: string): boolean {
  return ["/api/updates/config", "/api/updates/check", "/api/updates/sync", "/v1/update/check", "/v1/update/automatic"].includes(path) || path.startsWith("/v1/updates/");
}
async function internal(request: Request, env: Env, path: string, method = "GET", body?: unknown): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.set("X-Monitor-Role", "updates");
  headers.set("X-Monitor-Auth-Expires", String(Date.now() + 60_000));
  headers.delete("X-Monitor-Original-URL"); headers.delete("X-Monitor-Original-Method");
  if (new URL(request.url).pathname.startsWith("/v1/")) {
    headers.set("X-Monitor-Original-URL", request.url);
    headers.set("X-Monitor-Original-Method", request.method);
  }
  return env.MONITOR.getByName(env.MONITOR_GROUP).fetch(new Request(`http://do/internal/${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  }));
}
async function updateState(request: Request, env: Env, refresh: boolean): Promise<UpdateState> {
  const response = await internal(request, env, "update-state", refresh ? "POST" : "GET");
  if (!response.ok) {
    const result = await response.json<{ code: string; retry_after_seconds?: number }>();
    throw new UpdateSourceError(result.code, response.status, (result.retry_after_seconds || 60) * 1000);
  }
  return response.json<UpdateState>();
}
function manifestURL(origin: string, path: string): string { return `${origin}/v1/updates/${path}/manifest.json`; }
function publicConfig({ config, source }: UpdateState, env: Env, origin: string) {
  return { enabled: config.enabled, distribution_path: config.distribution_path, github_repository: updateRepository(env),
    version: source.current?.version || null, revision: source.current?.revision || null, release_tag: source.current?.release_tag || null,
    last_checked_at: source.checked_at || null, last_synced_at: source.checked_at || null,
    retry_after_seconds: Math.max(0, Math.ceil((source.retry_at - Date.now()) / 1000)), source_error: source.error,
    ready: !!source.current, manifest_url: source.current ? manifestURL(origin, config.distribution_path) : null };
}
function publicManifest(release: UpdateRelease, origin: string, path: string, revision: boolean) {
  return { schema: 1, version: release.version, ...(revision ? { revision: release.revision } : {}), release_tag: release.release_tag,
    assets: release.assets.map(asset => ({ ...asset, url: `${origin}/v1/updates/${path}/${release.version}/${asset.sha256}/${asset.file}` })) };
}

/** Panel session and admin Origin are checked by index.ts before this handler. */
export async function handleUpdates(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/api/updates/sync") return json({ code: "use_update_check" }, 410);
    const allowedMethods = path === "/api/updates/config" ? ["GET", "PUT"] : path === "/api/updates/check" ? ["POST"] : ["GET", "HEAD"];
    if (!allowedMethods.includes(request.method)) return json({ code: "method_not_allowed" }, 405);
    if (path === "/api/updates/config" && request.method === "PUT") {
      let input: Partial<UpdateConfig> | null;
      try { input = await readUpdateJSON(request, 2048) as Partial<UpdateConfig> | null; }
      catch (error) { return json({ code: "invalid_update_config" }, error instanceof UpdateSourceError && error.code === "update_metadata_too_large" ? 413 : 400); }
      if (!input || typeof input.enabled !== "boolean" || !validUpdatePath(input.distribution_path)) return json({ code: "invalid_update_config" }, 400);
      const response = await internal(request, env, "update-config", "PUT", { enabled: input.enabled, distribution_path: input.distribution_path });
      if (!response.ok) return response;
      await response.body?.cancel();
      return json(publicConfig(await updateState(request, env, false), env, url.origin));
    }
    const deviceCheck = path === "/v1/update/check" || path === "/v1/update/automatic";
    // Older clients reject unknown JSON fields, so revision is opt-in.
    const revision = request.headers.get("X-Monitor-Update-Protocol") === "2";
    const state = await updateState(request, env, deviceCheck || path === "/api/updates/check");
    const { config, source } = state;
    if (path === "/api/updates/config" || path === "/api/updates/check") return json(publicConfig(state, env, url.origin));
    if (deviceCheck && (!config.enabled || !source.repository)) return json({ enabled: false, version: null, release_tag: null, manifest_url: null });
    if (deviceCheck) return json({ enabled: config.enabled && !!source.current && !!source.repository,
      version: source.current?.version || null, ...(revision ? { revision: source.current?.revision || null } : {}), release_tag: source.current?.release_tag || null,
      manifest_url: config.enabled && source.current && source.repository ? manifestURL(url.origin, config.distribution_path) : null });
    if (!config.enabled || !source.repository) return json({ code: "updates_disabled" }, 404);
    if (!source.current) return json({ code: "update_check_required" }, 409);
    const prefix = "/v1/updates/";
    const selectedPath = [config.distribution_path, ...config.aliases].sort((a, b) => b.length - a.length).find(candidate => path.startsWith(prefix + candidate + "/"));
    if (!selectedPath) return json({ code: "update_not_found" }, 404);
    const suffix = path.slice(prefix.length + selectedPath.length + 1);
    if (suffix === "manifest.json") return request.method === "HEAD" ? new Response(null, { headers: { "Cache-Control": "no-store" } }) : json(publicManifest(source.current, url.origin, selectedPath, revision));
    const pieces = suffix.split("/");
    if (pieces.length !== 3) return json({ code: "update_not_found" }, 404);
    const [version, hash, file] = pieces;
    const release = [source.current, source.previous].find(value => value?.version === version && value.assets.some(asset => asset.sha256 === hash && asset.file === file));
    const asset = release?.assets.find(value => value.sha256 === hash && value.file === file);
    if (!release || !asset) return json({ code: "update_not_found" }, 404);
    return await streamBundledFile(env, release.version, asset, request.method);
  } catch (error) {
    if (error instanceof UpdateSourceError) {
      const response = json({ code: error.code, retry_after_seconds: Math.ceil(error.retryMs / 1000) }, error.status);
      if (error.status >= 500) response.headers.set("Retry-After", String(Math.ceil(error.retryMs / 1000)));
      return response;
    }
    console.error(JSON.stringify({ event: "update_request_failed", path: new URL(request.url).pathname }));
    return json({ code: "update_temporarily_unavailable" }, 503);
  }
}
