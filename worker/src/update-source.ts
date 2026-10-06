import platforms from "../../client/internal/agent/platforms.json";
export const UPDATE_CACHE_MS = 300_000;
export const UPDATE_RETRY_MS = 60_000;
export const MAX_UPDATE_FILE = 16 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export type UpdateAsset = { os: string; arch: string; file: string; bytes: number; sha256: string };
export type UpdateRelease = { version: string; release_tag: string; assets: UpdateAsset[] };
export type UpdateConfig = { enabled: boolean; distribution_path: string; aliases: string[] };
export type UpdateCache = { repository: string; current: UpdateRelease | null; previous: UpdateRelease | null; checked_at: number; last_attempt_at: number; retry_at: number; error: string | null };
export type UpdateState = { config: UpdateConfig; source: UpdateCache };
export class UpdateSourceError extends Error {
  constructor(readonly code: string, readonly status = 502, readonly retryMs = UPDATE_RETRY_MS) { super(code); }
}
export function updateRepository(env: Env): string {
  const repository = env.UPDATE_GITHUB_REPOSITORY || "";
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(repository) ? repository : "";
}
export const emptyUpdateCache = (repository: string): UpdateCache => ({ repository, current: null, previous: null, checked_at: 0, last_attempt_at: 0, retry_at: 0, error: null });
export function validUpdatePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(value)
    && !value.split("/").some(part => ["api", "v1", "bootstrap", "manifest", "manifest-json"].includes(part));
}
export async function readUpdateJSON(response: Response | Request, limit: number): Promise<unknown> {
  if (!response.body) throw new UpdateSourceError("invalid_update_manifest");
  if (Number(response.headers.get("Content-Length") || 0) > limit) { await response.body.cancel(); throw new UpdateSourceError("update_metadata_too_large"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new UpdateSourceError("update_metadata_too_large"); }
      chunks.push(value);
    }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data));
  } catch (error) { if (error instanceof UpdateSourceError) throw error; throw new UpdateSourceError("invalid_update_manifest"); }
  finally { reader.releaseLock(); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UpdateSourceError("invalid_update_manifest");
  return value as Record<string, unknown>;
}
function retryDelay(response: Response): number {
  const after = response.headers.get("Retry-After"), now = Date.now();
  const seconds = after && /^\d+$/.test(after) ? Number(after) * 1000 : after ? Date.parse(after) - now : 0;
  const reset = Number(response.headers.get("X-RateLimit-Reset") || 0) * 1000 - now;
  return Math.min(3600_000, Math.max(UPDATE_RETRY_MS, Number.isFinite(seconds) ? seconds : 0, Number.isFinite(reset) ? reset : 0));
}
/** Fetch only constructed GitHub URLs. Never forward incoming auth headers. */
export async function fetchUpdateSource(initialURL: string, asset: boolean, signal: AbortSignal): Promise<Response> {
  let url = initialURL;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const parsed = new URL(url);
    const hosts = asset ? ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"] : ["api.github.com"];
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !hosts.includes(parsed.hostname)) throw new UpdateSourceError("unsafe_release_redirect");
    let response: Response;
    try { response = await fetch(url, { redirect: "manual", signal, headers: {
      "User-Agent": "spider-watch-updates", Accept: asset ? "application/octet-stream" : "application/vnd.github+json", "Accept-Encoding": "identity",
    } }); } catch { throw new UpdateSourceError(signal.aborted ? "github_timeout" : "github_unavailable"); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location"); await response.body?.cancel();
      if (!asset || !location || redirects === 3) throw new UpdateSourceError("unsafe_release_redirect");
      url = new URL(location, url).href; continue;
    }
    if (!response.ok) {
      const delay = retryDelay(response); await response.body?.cancel();
      if ([403, 429].includes(response.status)) throw new UpdateSourceError("github_rate_limited", 503, delay);
      throw new UpdateSourceError(response.status === 404 ? "release_not_found" : "github_unavailable");
    }
    return response;
  }
  throw new UpdateSourceError("unsafe_release_redirect");
}
export function updateAssetURL(repository: string, release: UpdateRelease, file: string): string {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(release.release_tag)}/${encodeURIComponent(file)}`;
}
export function sameUpdateRelease(left: UpdateRelease, right: UpdateRelease): boolean {
  return left.version === right.version && left.release_tag === right.release_tag && left.assets.length === right.assets.length
    && left.assets.every(a => right.assets.some(b => a.os === b.os && a.arch === b.arch && a.file === b.file && a.bytes === b.bytes && a.sha256 === b.sha256));
}
export async function fetchLatestUpdate(repository: string): Promise<UpdateRelease> {
  // The Agent's ordinary JSON request timeout is 10s; both requests and all
  // redirects share this 8s budget. No DO concurrency lock is held while waiting.
  const signal = AbortSignal.timeout(8000);
  const github = object(await readUpdateJSON(await fetchUpdateSource(`https://api.github.com/repos/${repository}/releases/latest`, false, signal), 256 * 1024));
  if (github.draft !== false || github.prerelease !== false || typeof github.tag_name !== "string"
    || !/^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(github.tag_name)
    || !Array.isArray(github.assets)) throw new UpdateSourceError("invalid_github_release");
  const sizes = new Map<string, { bytes: number; digest?: string }>();
  for (const raw of github.assets) {
    const asset = object(raw);
    if (typeof asset.name !== "string" || !Number.isSafeInteger(asset.size) || (asset.state !== undefined && asset.state !== "uploaded")) continue;
    if (sizes.has(asset.name)) throw new UpdateSourceError("invalid_github_release");
    sizes.set(asset.name, { bytes: asset.size as number, digest: typeof asset.digest === "string" ? asset.digest : undefined });
  }
  const manifestSize = sizes.get("update-manifest.json")?.bytes;
  if (!manifestSize || manifestSize > 64 * 1024) throw new UpdateSourceError("release_manifest_missing");
  const manifest = object(await readUpdateJSON(await fetchUpdateSource(updateAssetURL(repository, { version: "", release_tag: github.tag_name, assets: [] }, "update-manifest.json"), true, signal), 64 * 1024));
  if (manifest.schema !== 1 || typeof manifest.version !== "string" || !VERSION.test(manifest.version)
    || github.tag_name.replace(/^v/, "") !== manifest.version || !Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > 32) throw new UpdateSourceError("invalid_update_manifest");
  const seen = new Set<string>();
  const assets = manifest.assets.map(raw => {
    const a = object(raw);
    if (!platforms.some(p => p.os === a.os && p.arch === a.arch)
      || typeof a.file !== "string" || a.file !== `spider-watch-${a.os}-${a.arch}${a.os === "windows" ? ".exe" : ""}`
      || !Number.isSafeInteger(a.bytes) || (a.bytes as number) <= 0 || (a.bytes as number) > MAX_UPDATE_FILE
      || typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256) || seen.has(`${a.os}/${a.arch}`)) throw new UpdateSourceError("invalid_update_manifest");
    const upstream = sizes.get(a.file);
    if (!upstream || upstream.bytes !== a.bytes || (upstream.digest?.startsWith("sha256:") && upstream.digest !== `sha256:${a.sha256}`)) throw new UpdateSourceError("invalid_update_manifest");
    seen.add(`${a.os}/${a.arch}`);
    return { os: a.os, arch: a.arch, file: a.file, bytes: a.bytes, sha256: a.sha256 } as UpdateAsset;
  });
  if (signal.aborted) throw new UpdateSourceError("github_timeout");
  return { version: manifest.version, release_tag: github.tag_name, assets };
}
