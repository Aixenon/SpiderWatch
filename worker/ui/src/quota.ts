import { ref, watch } from "vue";
import type { QuotaSnapshot } from "../../src/quota-model";
import { request } from "./api-client";
import { authenticated } from "./session";

export const quota = ref<QuotaSnapshot>();
export const quotaError = ref("");
let pending: Promise<void> | undefined, next = 0, generation = 0;
watch(authenticated, value => {
  if (!value) { generation++; quota.value = undefined; quotaError.value = ""; next = 0; pending = undefined; }
});

export async function refreshQuota(): Promise<void> {
  if (!authenticated.value || document.hidden || Date.now() < next) return;
  if (pending) return pending;
  const current = generation;
  const task = (async () => {
    try {
      const result = await request<QuotaSnapshot>("/quota");
      if (current !== generation || !authenticated.value) return;
      quota.value = result;
      quotaError.value = "";
      next = Math.max(Date.now() + 300000, result.retry_at);
    } catch (error) {
      if (current !== generation || !authenticated.value) return;
      quotaError.value = (error as Error).message;
      next = Date.now() + 300000;
    }
  })();
  pending = task;
  try { await task; }
  finally { if (pending === task) pending = undefined; }
}

export function nextQuotaRefresh(): number { return next; }
