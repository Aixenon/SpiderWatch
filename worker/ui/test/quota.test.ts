import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { QuotaSnapshot } from "../../src/quota-model";
import { request } from "../src/api-client";
import { authenticated } from "../src/session";
import { nextQuotaRefresh, quota, quotaError, refreshQuota } from "../src/quota";

vi.mock("../src/api-client", () => ({ request: vi.fn() }));
vi.mock("../src/session", async () => {
  const { ref } = await import("vue");
  return { authenticated: ref(false) };
});

const requestMock = vi.mocked(request);
const start = Date.UTC(2026, 0, 1);
function snapshot(retryAt = Date.now() + 300000): QuotaSnapshot {
  return { source: "local", status: "recorded", day: "2026-01-01", checked_at: Date.now(), retry_at: retryAt, rows: [
    { id: "do_requests", name: "DO 折算请求", value: 123, limit: 100000, unit: "次", period: "day", scope: "network" },
  ] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  authenticated.value = false; await nextTick();
  vi.useFakeTimers(); vi.setSystemTime(start);
  vi.stubGlobal("document", { hidden: false });
  requestMock.mockReset();
  authenticated.value = true; await nextTick();
});
afterEach(async () => {
  authenticated.value = false; await nextTick();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("panel quota requests", () => {
  it("coalesces simultaneous callers and reuses data for at least five minutes", async () => {
    const response = deferred<QuotaSnapshot>();
    requestMock.mockReturnValueOnce(response.promise);
    const first = refreshQuota(), second = refreshQuota();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith("/quota");
    response.resolve(snapshot(start)); await Promise.all([first, second]);
    expect(quota.value?.rows[0].value).toBe(123);
    expect(nextQuotaRefresh()).toBe(start + 300000);
    vi.setSystemTime(start + 299999); await refreshQuota();
    expect(requestMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 300000);
    requestMock.mockResolvedValueOnce(snapshot()); await refreshQuota();
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("honors a longer server retry time", async () => {
    requestMock.mockResolvedValueOnce(snapshot(start + 900000));
    await refreshQuota();
    expect(nextQuotaRefresh()).toBe(start + 900000);
    vi.setSystemTime(start + 600000); await refreshQuota();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does not request quota while hidden or signed out", async () => {
    vi.stubGlobal("document", { hidden: true }); await refreshQuota();
    vi.stubGlobal("document", { hidden: false });
    authenticated.value = false; await nextTick(); await refreshQuota();
    expect(requestMock).not.toHaveBeenCalled();
    expect(quota.value).toBeUndefined();
  });

  it("retains the last result and backs off for five minutes after failure", async () => {
    requestMock.mockResolvedValueOnce(snapshot()); await refreshQuota();
    const previous = quota.value;
    vi.setSystemTime(start + 300000);
    requestMock.mockRejectedValueOnce(new Error("连接失败")); await refreshQuota();
    expect(quota.value).toEqual(previous);
    expect(quotaError.value).toBe("连接失败");
    expect(nextQuotaRefresh()).toBe(start + 600000);
    await refreshQuota();
    expect(requestMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(start + 600000);
    requestMock.mockResolvedValueOnce(snapshot()); await refreshQuota();
    expect(quotaError.value).toBe("");
  });

  it("clears quota on logout and ignores the old session response", async () => {
    const oldResponse = deferred<QuotaSnapshot>(), newResponse = deferred<QuotaSnapshot>();
    requestMock.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const oldRead = refreshQuota();
    authenticated.value = false; await nextTick();
    expect(quota.value).toBeUndefined();
    expect(nextQuotaRefresh()).toBe(0);
    authenticated.value = true; await nextTick();
    const newRead = refreshQuota();
    oldResponse.resolve(snapshot()); await oldRead;
    expect(quota.value).toBeUndefined();
    const joinedRead = refreshQuota();
    expect(requestMock).toHaveBeenCalledTimes(2);
    const current = snapshot(); current.rows[0].value = 456;
    newResponse.resolve(current); await Promise.all([newRead, joinedRead]);
    expect(quota.value?.rows[0].value).toBe(456);
  });

  it("does not restore an error or retry deadline after logout", async () => {
    const response = deferred<QuotaSnapshot>();
    requestMock.mockReturnValueOnce(response.promise);
    const reading = refreshQuota();
    authenticated.value = false; await nextTick();
    response.reject(new Error("旧会话请求失败")); await reading;
    expect(quotaError.value).toBe("");
    expect(nextQuotaRefresh()).toBe(0);
    expect(quota.value).toBeUndefined();
  });
});
