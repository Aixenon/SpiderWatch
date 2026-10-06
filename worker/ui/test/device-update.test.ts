import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceUpdate } from "../src/device-update";
import { APIError, apiErrorMessage } from "../src/api-client";
import type { UpdateCheck } from "../src/monitor";

const startTime = Date.UTC(2026, 9, 6);
function job(state: UpdateCheck["state"], overrides: Partial<UpdateCheck> = {}): UpdateCheck {
  return { request_id: "a".repeat(32), state, version: "0.2.1", revision: "b".repeat(40), updated_at: Date.now(), expires_at: startTime + 60000, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const context = { node: "node-a", generation: 1, authorized: true, visible: true };
  const start = vi.fn<() => Promise<UpdateCheck>>(), status = vi.fn<() => Promise<UpdateCheck | null>>().mockResolvedValue(null);
  const installed = vi.fn();
  const update = createDeviceUpdate({ start, status, installed,
    current: id => context.node === id, generation: () => context.generation,
    authorized: () => context.authorized, visible: () => context.visible,
  });
  return { update, context, start, status, installed };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(startTime); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("device update dialog lifecycle", () => {
  it("sends once, follows acknowledgements, and confirms installation only from the server", async () => {
    const { update, start, status, installed } = setup();
    await update.open("node-a");
    await vi.advanceTimersByTimeAsync(9000);
    expect(status).toHaveBeenCalledTimes(1); // No job means no polling.
    const sending = deferred<UpdateCheck>(); start.mockReturnValue(sending.promise);
    const first = update.start(); await update.start();
    expect(start).toHaveBeenCalledTimes(1);
    sending.resolve(job("requested")); await first;
    expect(update.message.value).toContain("等待设备确认"); expect(installed).not.toHaveBeenCalled();
    await update.start(); expect(start).toHaveBeenCalledTimes(1);
    status.mockResolvedValueOnce(job("accepted")).mockResolvedValueOnce(job("updating")).mockResolvedValueOnce(job("installed"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(update.message.value).toContain("已接收"); expect(installed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(update.message.value).toContain("等待重启后确认"); expect(installed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(update.message.value).toContain("确认已更新"); expect(installed).toHaveBeenCalledTimes(1);
    expect(update.busy.value).toBe(false);
    await vi.advanceTimersByTimeAsync(30000); expect(status).toHaveBeenCalledTimes(4);
  });

  it("does not display success when the local deadline passes without confirmation", async () => {
    const { update, status, installed } = setup();
    status.mockResolvedValue(job("requested", { expires_at: startTime + 5000 }));
    await update.open("node-a"); await vi.advanceTimersByTimeAsync(5000);
    expect(update.message.value).toContain("等待超时"); expect(update.failed.value).toBe(true);
    expect(installed).not.toHaveBeenCalled();
    status.mockResolvedValue(job("timeout")); await vi.advanceTimersByTimeAsync(1000);
    expect(update.busy.value).toBe(false);
    const calls = status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000); expect(status).toHaveBeenCalledTimes(calls);
  });

  it("ignores an old request after closing and reopening the same device", async () => {
    const { update, status, installed } = setup();
    const old = deferred<UpdateCheck | null>(); status.mockReturnValueOnce(old.promise);
    const opening = update.open("node-a"); update.close();
    status.mockResolvedValueOnce(job("accepted", { request_id: "c".repeat(32) }));
    await update.open("node-a");
    old.resolve(job("installed")); await opening;
    expect(update.state.job?.request_id).toBe("c".repeat(32));
    expect(update.state.job?.state).toBe("accepted"); expect(installed).not.toHaveBeenCalled();
  });

  it("ignores late send results after switching device or invalidating the session", async () => {
    const { update, context, start, installed } = setup();
    await update.open("node-a"); const old = deferred<UpdateCheck>(); start.mockReturnValueOnce(old.promise);
    const sending = update.start(); update.close(); context.node = "node-b"; context.generation++;
    await update.open("node-b"); old.resolve(job("installed")); await sending;
    expect(update.state.job).toBeNull(); expect(update.state.sending).toBe(false); expect(installed).not.toHaveBeenCalled();
    update.close(); const calls = start.mock.calls.length; context.authorized = false;
    await update.start(); expect(start).toHaveBeenCalledTimes(calls);
  });

  it("pauses hidden polling, does not overlap reads, and stops on close", async () => {
    const { update, context, status } = setup(); status.mockResolvedValueOnce(job("accepted"));
    await update.open("node-a"); context.visible = false; update.visibilityChanged();
    await vi.advanceTimersByTimeAsync(12000); expect(status).toHaveBeenCalledTimes(1);
    const reading = deferred<UpdateCheck | null>(); status.mockReturnValueOnce(reading.promise);
    context.visible = true; update.visibilityChanged();
    await vi.advanceTimersByTimeAsync(12000); expect(status).toHaveBeenCalledTimes(2);
    update.close(); reading.resolve(job("installed")); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30000); expect(status).toHaveBeenCalledTimes(2); expect(update.state.job).toBeNull();
  });

  it("keeps an unconfirmed job visible after a transient read failure", async () => {
    const { update, status, installed } = setup(); status.mockResolvedValueOnce(job("updating"));
    await update.open("node-a"); status.mockRejectedValueOnce(new Error("暂时无法读取"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(update.state.job?.state).toBe("updating"); expect(update.state.error).toBe("暂时无法读取"); expect(installed).not.toHaveBeenCalled();
    status.mockResolvedValueOnce(job("failed", { code: "update_trigger_failed" }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(update.message.value).toContain("重新运行新版安装器"); expect(update.busy.value).toBe(false);
  });

  it("explains old clients and failed installer tasks without claiming a successful send", async () => {
    const { update, start } = setup(); await update.open("node-a");
    start.mockRejectedValue(new APIError(apiErrorMessage("update_client_upgrade_required"), "update_client_upgrade_required"));
    await update.start(); expect(update.state.error).toContain("运行一次新版安装器"); expect(update.state.job).toBeNull();
    expect(apiErrorMessage("update_trigger_failed")).toContain("更新任务不可用");
    expect(apiErrorMessage("update_device_offline")).toContain("离线");
    expect(apiErrorMessage("update_send_failed")).toContain("连接已中断");
  });

  it("resumes a concurrent task reported by the server instead of sending duplicates", async () => {
    const { update, start, status } = setup(); await update.open("node-a");
    start.mockRejectedValue(new APIError(apiErrorMessage("update_request_conflict"), "update_request_conflict"));
    status.mockResolvedValue(job("accepted"));
    await update.start(); expect(status).toHaveBeenCalledTimes(2); expect(update.busy.value).toBe(true);
    await update.start(); expect(start).toHaveBeenCalledTimes(1);
  });
});
