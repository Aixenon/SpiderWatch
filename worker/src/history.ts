import { DEFAULT_SETTINGS, type Metrics } from "./model";
export { decodeHistoryBatch, encodeHistoryBatch, historyBatchSamples, removeHistoryNode, HISTORY_BATCH_MAX_BYTES, type HistoryBatch } from "./history-batch-codec";

export const HISTORY_MAX_POINTS = 1008;
export const HISTORY_MAX_BYTES = 2048;
export type HistoryWindow = { from: number; deadline: number; interval: number; generation: string };
export const BATCH_SELECT = "SELECT id,until,codec,payload FROM history_batches WHERE id>=? AND id<=?";
export const BATCH_PREVIOUS = "SELECT id,until,codec,payload FROM history_batches WHERE id<? ORDER BY id DESC LIMIT 1";
export type ResourcePoint = { time: number; cpu: number | null; memory: number | null; networks: Record<string, {rx:number|null;tx:number|null}>; interval_seconds?: number };

export function historyRange(url: URL): number | null {
  const values = url.searchParams.getAll("range");
  return values.length === 1 && /^(60|300|1800|3600|86400|604800)$/.test(values[0]) ? Number(values[0]) : null;
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nonnegative = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function resourcePoint(time: number, metrics: unknown): ResourcePoint {
  const m = record(metrics), memory = record(m?.memory), cpu = nonnegative(m?.cpu_percent);
  const total = nonnegative(memory?.total_bytes), used = nonnegative(memory?.used_bytes);
  const networks: ResourcePoint["networks"] = Object.create(null);
  if (Array.isArray(m?.networks)) for (const row of m.networks.slice(0, 16)) {
    const item = record(row), compact = m?.history_format === 1 && Array.isArray(row);
    const name = compact ? row[0] : item?.name;
    if (typeof name !== "string" || !name || name.length > 128) continue;
    networks[name] = {
      rx: item?.counter_reset === true ? null : nonnegative(compact ? row[1] : item?.rx_bytes_per_second),
      tx: item?.counter_reset === true ? null : nonnegative(compact ? row[2] : item?.tx_bytes_per_second),
    };
  }
  return {time,cpu:cpu !== null && cpu <= 100 ? cpu : null,memory:total !== null && total > 0 && used !== null && used <= total ? used/total*100 : null,networks};
}

export function storedResourcePoint(time: number, serialized: string): ResourcePoint {
  let metrics: unknown;
  try { metrics = JSON.parse(serialized); } catch { metrics = null; }
  const interval = record(metrics)?.history_interval_seconds;
  return { ...resourcePoint(time, metrics), interval_seconds: typeof interval === "number" && Number.isInteger(interval) && interval >= 30 && interval <= 86400 ? interval : DEFAULT_SETTINGS.idle_seconds };
}

// Keep a bounded historical summary and the interval used to record it. Full
// live snapshots retain all fields in nodes.latest without history metadata.
export function historySnapshot(metrics: Metrics, intervalSeconds: number): string {
  const encoder = new TextEncoder();
  const point = resourcePoint(0, metrics);
  const compact = {
    history_format: 1, cpu_percent: point.cpu,
    history_interval_seconds: intervalSeconds,
    memory: metrics.memory ? {total_bytes:metrics.memory.total_bytes,used_bytes:metrics.memory.used_bytes} : undefined,
    networks: Object.entries(point.networks).map(([name,rates]) => [name,rates.rx,rates.tx]),
  };
  let result = JSON.stringify(compact);
  // Extremely long interface names are retained exactly for series identity;
  // missing interfaces remain unavailable rather than receiving invented zeros.
  while (encoder.encode(result).byteLength > HISTORY_MAX_BYTES && compact.networks.length) {
    compact.networks.pop(); result = JSON.stringify(compact);
  }
  return result;
}
