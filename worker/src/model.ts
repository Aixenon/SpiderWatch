export type Settings = { active_seconds: number; idle_seconds: number; version: number; updated_at: number };
export const DEFAULT_SETTINGS: Settings = { active_seconds: 5, idle_seconds: 600, version: 1, updated_at: 0 };
export const MAX_NODES = 200;
export const NETWORK_CODE_LENGTH = 16;
export type NetworkIdentity = { code: string; legacy_alias: string };
export const DEVICE_ICON_IDS = ["server", "desktop", "laptop", "router", "network", "nas", "database", "cloud", "cpu", "raspberry-pi", "windows", "linux", "apple", "container", "globe", "shield"] as const;
export type DeviceIcon = typeof DEVICE_ICON_IDS[number];
export function isDeviceIcon(value: unknown): value is DeviceIcon {
  return typeof value === "string" && (DEVICE_ICON_IDS as readonly string[]).includes(value);
}

// Rejection sampling avoids modulo bias without adding a UUID/base encoder.
// The durable record is created once; the routing namespace is kept separate.
export function randomNetworkCode(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(32);
  let code = "";
  while (code.length < NETWORK_CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 252) code += alphabet[byte % alphabet.length];
      if (code.length === NETWORK_CODE_LENGTH) break;
    }
  }
  return code;
}
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const VIEW_LEASE_MS = 90_000;
export const CHECKPOINT_MS = 300_000;
export const USAGE_RETENTION_DAYS = 90;
export const HISTORY_RETENTION_DAYS = 7;
export type NodeState = "pending" | "approved" | "revoked";
export type Device = { node_id: string; name: string; nickname: string; icon: DeviceIcon; auto_update: number; key_hash: string; public_key: string; state: NodeState; host: string; latest: string; last_seen: number };
// cpus is the legacy process-available count. Optional physical/logical counts
// share the active OS/guest system scope and are omitted when unknown.
export type Host = { hostname: string; os: string; arch: string; cpus: number; physical_cpus?: number; logical_cpus?: number; cpu_model?: string; agent_version: string; agent_revision?: string; kernel?: string };
export type Metrics = { time: string; cpu_percent?: number; memory?: { total_bytes: number; used_bytes: number }; agent_rss_bytes?: number; [key: string]: unknown };
export type Report = { protocol: number; node_id: string; session: string; sequence: number; host: Host; metrics: Metrics; type?: string };

export function settingsInput(value: unknown): { active_seconds: number; idle_seconds: number } {
  if (!value || typeof value !== "object") throw new Error("invalid_settings");
  const v = value as Record<string, unknown>;
  const active = v.active_seconds, idle = v.idle_seconds;
  if (!Number.isInteger(active) || !Number.isInteger(idle) || typeof active !== "number" || typeof idle !== "number"
    || active < 2 || active > 300 || idle < 30 || idle > 86400 || idle < active) throw new Error("invalid_settings");
  return { active_seconds: active, idle_seconds: idle };
}
export function validHost(v: unknown): v is Host {
  if (!v || typeof v !== "object") return false;
  const h = v as Host;
  return [h.hostname, h.os, h.arch, h.agent_version].every(s => typeof s === "string" && s.length <= 128)
    && (h.agent_revision === undefined || (typeof h.agent_revision === "string" && /^[a-f0-9]{40}$/.test(h.agent_revision)))
    && Number.isInteger(h.cpus) && h.cpus >= 1 && h.cpus <= 65536
    && (h.cpu_model === undefined || (typeof h.cpu_model === "string" && h.cpu_model.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(h.cpu_model)))
    && (h.physical_cpus === undefined || (Number.isInteger(h.physical_cpus) && h.physical_cpus >= 1 && h.physical_cpus <= 65536))
    && (h.logical_cpus === undefined || (Number.isInteger(h.logical_cpus) && h.logical_cpus >= 1 && h.logical_cpus <= 65536
      && (h.physical_cpus === undefined || h.physical_cpus <= h.logical_cpus)));
}
const MEMORY_DETAILS = ["free_bytes", "cached_bytes", "buffers_bytes", "active_bytes", "inactive_bytes", "wired_bytes", "committed_bytes", "commit_limit_bytes"];
const CPU_DETAILS = ["user_percent", "system_percent", "idle_percent", "iowait_percent", "steal_percent"];
function optionalNumbers(value: Record<string, unknown>, keys: string[], maximum = Number.MAX_VALUE): boolean {
  return keys.every(key => value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= maximum));
}
function validDetails(m: Metrics): boolean {
  if (m.cpu_detail !== undefined) {
    if (!m.cpu_detail || typeof m.cpu_detail !== "object" || Array.isArray(m.cpu_detail)
      || !optionalNumbers(m.cpu_detail as Record<string, unknown>, CPU_DETAILS, 100)) return false;
  }
  if (m.memory && !optionalNumbers(m.memory, MEMORY_DETAILS)) return false;
  // Older clients omit volume identities and detail counters; keep them valid.
  if (m.disks !== undefined && m.disks !== null) {
    if (!Array.isArray(m.disks) || m.disks.length > 32) return false;
    for (const disk of m.disks) {
      if (!disk || typeof disk !== "object" || Array.isArray(disk)
        || ![disk.total_bytes, disk.used_bytes].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
        || disk.used_bytes > disk.total_bytes || !optionalNumbers(disk, ["available_bytes","pool_total_bytes","pool_available_bytes"])) return false;
      if ((disk.pool_total_bytes === undefined) !== (disk.pool_available_bytes === undefined)
        || (disk.pool_total_bytes !== undefined && (!disk.capacity_group || disk.pool_available_bytes > disk.pool_total_bytes))) return false;
      for (const [key, limit] of [["volume_id", 256], ["device", 128], ["label", 128], ["filesystem", 32], ["capacity_group", 128]] as const) {
        if (disk[key] !== undefined && (typeof disk[key] !== "string" || disk[key].length > limit)) return false;
      }
      if (disk.physical_disks !== undefined) {
        if (!Array.isArray(disk.physical_disks) || disk.physical_disks.length > 8) return false;
        const ids = new Set<string>();
        for (const parent of disk.physical_disks) {
          if (!parent || typeof parent !== "object" || typeof parent.id !== "string" || !parent.id || parent.id.length > 128
            || typeof parent.name !== "string" || !parent.name || parent.name.length > 128 || !optionalNumbers(parent,["size_bytes"]) || ids.has(parent.id)) return false;
          ids.add(parent.id);
        }
      }
    }
  }
  return true;
}
export function validReport(v: unknown, id: string): v is Report {
  if (!v || typeof v !== "object") return false;
  const r = v as Report, m = r.metrics;
  return r.protocol === 1 && r.node_id === id && /^[a-f0-9]{32}$/.test(r.session)
    && Number.isSafeInteger(r.sequence) && r.sequence > 0 && validHost(r.host)
    && !!m && typeof m === "object" && !Array.isArray(m) && typeof m.time === "string" && m.time.length <= 64 && Number.isFinite(Date.parse(m.time))
    && (m.cpu_percent === undefined || (Number.isFinite(m.cpu_percent) && m.cpu_percent >= 0 && m.cpu_percent <= 100))
    && (m.agent_rss_bytes === undefined || (Number.isSafeInteger(m.agent_rss_bytes) && m.agent_rss_bytes >= 0))
    && (!m.memory || (Number.isFinite(m.memory.total_bytes) && Number.isFinite(m.memory.used_bytes)
      && m.memory.total_bytes >= 0 && m.memory.used_bytes >= 0 && m.memory.used_bytes <= m.memory.total_bytes)) && validDetails(m);
}
export async function readJSON(request: Pick<Request, "body">, maximum = MAX_MESSAGE_BYTES): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty_body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("body_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { data.set(c, offset); offset += c.byteLength; }
  return JSON.parse(new TextDecoder().decode(data));
}
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
export async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
