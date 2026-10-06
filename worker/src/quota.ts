import { emptyQuota, type QuotaSnapshot } from "./quota-model";
import type { Counts } from "./usage";

// Recorded inbound messages include metrics, hello and application heartbeats.
// Outbound replies are not in these counters. No extra charge per wakeup.
export function localQuota(counts: Counts, storageBytes: number, now = Date.now()): QuotaSnapshot {
  const snapshot = emptyQuota(now);
  const ordinaryRequests = counts.connections + counts.http_requests;
  const messages = counts.fast_messages + counts.idle_messages + counts.other_messages;
  const values: Record<string, number | null> = {
    workers: ordinaryRequests,
    do_requests: Math.ceil(ordinaryRequests + counts.alarms + messages / 20),
    // Application active wall time × the DO's allocated 128 MB. This remains
    // an estimate: platform overhead and clock granularity are not observable.
    duration: counts.handler_ms / 1000 * 0.128,
    writes: counts.sql_written,
    reads: counts.sql_read,
    storage: storageBytes,
  };
  snapshot.checked_at = now;
  for (const row of snapshot.rows) row.value = values[row.id] ?? null;
  return snapshot;
}
