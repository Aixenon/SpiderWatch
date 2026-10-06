import { FREE_LIMITS } from "./usage";

export const QUOTA_REFRESH_MS = 300_000;
export type QuotaRow = { id: string; name: string; value: number | null; limit: number; unit: string; period: "day" | "storage"; scope: "network" };
export type QuotaSnapshot = {
  source: "local" | "preview"; status: "recorded";
  day: string; checked_at: number | null; retry_at: number; rows: QuotaRow[];
};
export function emptyQuota(now = Date.now()): QuotaSnapshot {
  return { source: "local", status: "recorded", day: new Date(now).toISOString().slice(0, 10), checked_at: null, retry_at: now + QUOTA_REFRESH_MS,
    rows: [
      { id: "workers", name: "Workers 请求（已记录）", value: null, limit: FREE_LIMITS.worker_requests, unit: "次", period: "day", scope: "network" },
      { id: "do_requests", name: "DO 折算请求", value: null, limit: FREE_LIMITS.do_requests, unit: "次", period: "day", scope: "network" },
      { id: "duration", name: "DO 运行时长（估算）", value: null, limit: FREE_LIMITS.do_gb_seconds, unit: "GB-s", period: "day", scope: "network" },
      { id: "writes", name: "SQLite 写入", value: null, limit: FREE_LIMITS.sql_written, unit: "行", period: "day", scope: "network" },
      { id: "reads", name: "SQLite 读取", value: null, limit: FREE_LIMITS.sql_read, unit: "行", period: "day", scope: "network" },
      { id: "storage", name: "SQLite 存储", value: null, limit: FREE_LIMITS.storage_bytes, unit: "bytes", period: "storage", scope: "network" },
    ] };
}
