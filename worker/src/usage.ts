import type { Settings } from "./model";
export const HOUR_MS = 3_600_000;
export const DAY_SECONDS = 86400;
// Compute/row allowances are shared across the account. databaseSize belongs
// to one object, so its usable Free storage ceiling is 1 GB, not the 5 GB
// account aggregate. Values use decimal GB, as Cloudflare does.
export const FREE_LIMITS = { worker_requests: 100000, do_requests: 100000, do_gb_seconds: 13000, sql_read: 5000000, sql_written: 100000, storage_bytes: 1_000_000_000, account_storage_bytes: 5_000_000_000 };
export const UPDATE_DISTRIBUTION_LIMITS = { file_bytes: 16 * 1024 * 1024, metadata_cache_seconds: 300, failure_cache_seconds: 60, github_unauthenticated_requests_per_hour: 60 };
export const UPDATE_USAGE_NOTE = "更新包由 GitHub Actions 发布到固定仓库的 Releases，设备或管理员手动检查时按需获取。每次检查或下载产生 Workers 请求及 DO 小配置查询；版本信息缓存 5 分钟，失败至少缓存 1 分钟，二进制由 Worker 从 GitHub 流式转发、不经过 DO。更新开销不按监控采样频率计算，GitHub 未认证 REST 另有每来源 IP 每小时 60 次限制。";
export const PRICING_AS_OF = "2026-10-06";
export type Counts = { fast_messages: number; idle_messages: number; other_messages: number; connections: number; viewer_connections: number; http_requests: number; alarms: number; sql_read: number; sql_written: number; handler_ms: number; device_seconds: number; view_seconds: number };
export type HourUsage = Counts & { hour: number };
export const countKeys: (keyof Counts)[] = ["fast_messages", "idle_messages", "other_messages", "connections", "viewer_connections", "http_requests", "alarms", "sql_read", "sql_written", "handler_ms", "device_seconds", "view_seconds"];
export function emptyCounts(): Counts { return Object.fromEntries(countKeys.map(k => [k, 0])) as Counts; }
export function addCounts(target: Counts, source: Partial<Counts>): void { for (const k of countKeys) target[k] += source[k] || 0; }
export function sumUsage(rows: HourUsage[]): Counts { const total = emptyCounts(); for (const r of rows) addCounts(total, r); return total; }
export function hourOf(ms: number): number { return Math.floor(ms / HOUR_MS); }
export function splitSpan(start: number, end: number, add: (hour: number, seconds: number) => void): void {
  for (let t = start; t < end;) {
    const h = hourOf(t), next = Math.min(end, (h + 1) * HOUR_MS);
    add(h, (next - t) / 1000); t = next;
  }
}

// Interval changes are modelled with observed UNION viewing time (two tabs do
// not double the viewing ratio) and observed overhead, not by scaling all costs
// with the number of metrics messages. Duration is deliberately an estimate.
export function forecast(settings: Settings, devices: number, rows: HourUsage[], observedSeconds: number, storageBytes: number) {
  const totals = sumUsage(rows), measured = observedSeconds >= 3600;
  const days = Math.max(observedSeconds / DAY_SECONDS, 1 / 24);
  const ratio = measured ? Math.max(0, Math.min(1, totals.view_seconds / observedSeconds)) : 1 / 24;
  const viewingSeconds = ratio * DAY_SECONDS;
  const metrics = devices * (viewingSeconds / settings.active_seconds + (DAY_SECONDS - viewingSeconds) / settings.idle_seconds);
  const observedDevices = totals.device_seconds / Math.max(observedSeconds, 1);
  // A brief agent test followed by hours of panel use is not a representative
  // fleet sample. Dividing by that near-zero exposure would multiply one-off
  // administration and viewer costs thousands of times.
  const representative = measured && observedDevices >= 1;
  const scale = representative ? devices / observedDevices : 1;
  const viewerConnects = measured ? totals.viewer_connections / days : 2;
  const agentConnects = measured ? Math.max(0, totals.connections - totals.viewer_connections) / days * scale : devices * 2;
  const connects = (representative ? agentConnects : Math.max(agentConnects, devices * 2)) + viewerConnects;
  const other = measured ? totals.other_messages / days : viewingSeconds / 30;
  const http = measured ? totals.http_requests / days : 66; // Conservative allowance for one viewing hour plus management.
  const historyWindows = devices > 0 ? DAY_SECONDS / settings.idle_seconds : 0;
  // ACKed checkpoints must survive eviction: retain one latest row per node.
  // One network-wide row holds the completed window. Window metadata and the
  // expired batch's deletion each cost a row too; gzip saves bytes, not rows.
  const snapshotWrites = devices * DAY_SECONDS / settings.idle_seconds;
  const historyWrites = snapshotWrites + historyWindows * 3;
  // A pending window gets a fallback alarm. An incoming frame or an existing
  // viewer alarm may flush it first, but budget for one wake per window. Old
  // observations from the per-device layout cannot erase this new overhead.
  const alarms = measured ? Math.max(totals.alarms / days, historyWindows) : viewingSeconds / 60 + connects + historyWindows;
  // A checkpoint writes one metering bucket + runtime, with headroom for UTC
  // hour boundaries. Alarm handlers checkpoint and schedule at most one next
  // alarm. Allow additional writes for connection/lease transitions; reads no
  // longer force two unconditional metering checkpoints per HTTP request.
  const groupWrites = DAY_SECONDS / 300 * 2 + 24 * 2 + alarms * 3 + connects * 4;
  const dailyMessages = totals.fast_messages + totals.idle_messages + totals.other_messages;
  const handlerMsPerMessage = dailyMessages > 0 ? totals.handler_ms / dailyMessages : 5;
  const handlerEstimate = (metrics + other) * handlerMsPerMessage / 1000 * 0.128;
  return {
    devices, observed_seconds: observedSeconds, observed_days: observedSeconds / DAY_SECONDS,
    viewing_ratio: ratio, viewing_hours_per_day: viewingSeconds / 3600,
    cost_basis: representative ? "observed_fleet" : "limited_device_exposure",
    basis: measured ? "observed" : "initial_assumption", confidence: observedSeconds >= 7 * DAY_SECONDS ? "long_term" : measured ? "warming_up" : "insufficient_data",
    messages_per_day: Math.ceil(metrics), worker_requests_per_day: Math.ceil(http + connects + (measured ? totals.viewer_connections / days : 2) * 3),
    do_requests_per_day: Math.ceil((metrics + other) / 20 + connects + http + alarms),
    sql_written_per_day: Math.ceil(Math.max(historyWrites + groupWrites, measured ? totals.sql_written / days * Math.max(1, scale) : 0)),
    history_storage: {
      strategy: "durable_latest_and_network_batches", compression: "chunked_adaptive_gzip_level_1",
      latest_rows_per_day: Math.ceil(snapshotWrites), batch_rows_per_day: Math.ceil(historyWindows),
      window_rows_per_day: Math.ceil(historyWindows), expired_rows_per_day: Math.ceil(historyWindows),
      base_rows_written_per_day: Math.ceil(historyWrites),
      // Metering, alarm scheduling and management are included above, not here.
      includes_operational_overhead: false,
    },
    sql_read_per_day: Math.ceil(measured ? totals.sql_read / days * Math.max(1, scale) : 10000),
    do_gb_seconds_handler_estimate: Math.ceil(handlerEstimate),
    // This is application telemetry, not billing: handler spans can overlap
    // and do not include every platform/constructor operation. Idle time that
    // is eligible for hibernation is free even before actual eviction; never
    // add a fixed ten-second billed wake window to every frame.
    do_gb_seconds_conservative: 0.128 * DAY_SECONDS,
    duration_basis: "application_estimate_not_bill",
    quota_scope: "network_usage_account_shared_limits",
    update_distribution: { source: "github_releases_on_demand", cost_basis: "manual_operations_not_sample_rate", limits: UPDATE_DISTRIBUTION_LIMITS, note: UPDATE_USAGE_NOTE },
    storage_bytes: storageBytes,
    limits: FREE_LIMITS, pricing_as_of: PRICING_AS_OF,
  };
}
