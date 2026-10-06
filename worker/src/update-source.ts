import platforms from "../../client/internal/agent/platforms.json";
export const UPDATE_RETRY_MS = 60_000;
export const MAX_UPDATE_FILE = 16 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export type UpdateAsset = { os: string; arch: string; file: string; bytes: number; sha256: string };
export type UpdateRelease = { version: string; revision: string; release_tag: string; assets: UpdateAsset[] };
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
export type DownloadFile = { file: string; bytes: number; sha256: string };
export type BundledRelease = UpdateRelease & { schema: 1; repository: string; build: string; files: DownloadFile[] };
const FILES = new Set([
  ...platforms.map(p => `spider-watch-${p.os}-${p.arch}${p.os === "windows" ? ".exe" : ""}`),
  "spider-watch-windows-amd64-setup.exe", "spider-watch-windows-arm64-setup.exe", "spider-watch-windows-386-setup.exe",
  "install.sh", "install.ps1", "checksums.txt", "update-manifest.json", "release-info.json",
]);
export function bundledFilePath(version: string, file: string): string {
  if (!VERSION.test(version) || !FILES.has(file)) throw new UpdateSourceError("update_not_found", 404);
  return `/downloads/${file}`;
}
/** ASSETS is the immutable bundle uploaded alongside this Worker version. */
export async function bundledAsset(env: Env, path: string, method = "GET"): Promise<Response> {
  return env.ASSETS.fetch(new Request(`https://assets.internal${path}`, { method, headers: { "Accept-Encoding": "identity" } }));
}
export async function readBundledRelease(env: Env): Promise<BundledRelease> {
  const response = await bundledAsset(env, "/downloads/current.json");
  if (response.status !== 200) { await response.body?.cancel(); throw new UpdateSourceError("update_bundle_unavailable", 503); }
  const manifest = object(await readUpdateJSON(response, 64 * 1024));
  if (manifest.schema !== 1 || typeof manifest.version !== "string" || !VERSION.test(manifest.version)
    || typeof manifest.revision !== "string" || !/^[a-f0-9]{40}$/.test(manifest.revision)
    || typeof manifest.repository !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(manifest.repository)
    || typeof manifest.build !== "string" || !/^[a-f0-9]{64}$/.test(manifest.build)
    || !Array.isArray(manifest.assets) || !manifest.assets.length || manifest.assets.length > 32
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 32) throw new UpdateSourceError("invalid_update_manifest");
  const files = new Map<string, DownloadFile>();
  for (const value of manifest.files) {
    const f = object(value);
    if (typeof f.file !== "string" || !FILES.has(f.file) || files.has(f.file)
      || !Number.isSafeInteger(f.bytes) || (f.bytes as number) <= 0 || (f.bytes as number) > 25 * 1024 * 1024
      || typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new UpdateSourceError("invalid_update_manifest");
    files.set(f.file, { file: f.file, bytes: f.bytes as number, sha256: f.sha256 });
  }
  const seen = new Set<string>();
  const assets = manifest.assets.map(value => {
    const a = object(value), f = typeof a.file === "string" ? files.get(a.file) : undefined;
    if (!platforms.some(p => p.os === a.os && p.arch === a.arch)
      || a.file !== `spider-watch-${a.os}-${a.arch}${a.os === "windows" ? ".exe" : ""}`
      || !f || f.bytes > MAX_UPDATE_FILE || f.bytes !== a.bytes || f.sha256 !== a.sha256
      || seen.has(`${a.os}/${a.arch}`)) throw new UpdateSourceError("invalid_update_manifest");
    seen.add(`${a.os}/${a.arch}`);
    return { os: a.os, arch: a.arch, ...f } as UpdateAsset;
  });
  return { schema: 1, version: manifest.version, revision: manifest.revision, release_tag: `v${manifest.version}`,
    repository: manifest.repository, build: manifest.build, assets, files: [...files.values()] };
}
export async function streamBundledFile(env: Env, version: string, file: DownloadFile, method: string): Promise<Response> {
  const response = await bundledAsset(env, bundledFilePath(version, file.file), method);
  const length = response.headers.get("Content-Length"), encoding = response.headers.get("Content-Encoding");
  if (response.status !== 200 || (encoding && encoding !== "identity")
    || (length !== null && Number(length) !== file.bytes) || (method !== "HEAD" && !response.body)) {
    await response.body?.cancel(); throw new UpdateSourceError("asset_size_mismatch");
  }
  const body = method === "HEAD" ? null : response.body!.pipeThrough(new FixedLengthStream(file.bytes));
  return new Response(body, { headers: {
    "Content-Type": file.file.endsWith(".json") ? "application/json" : file.file === "install.sh" ? "text/x-shellscript; charset=utf-8" : "application/octet-stream",
    "Content-Length": String(file.bytes), "Content-Disposition": `attachment; filename="${file.file}"`,
    ETag: `"${file.sha256}"`, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  } });
}
