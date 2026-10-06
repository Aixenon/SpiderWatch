import { computed, reactive } from "vue";
import type { UpdateCheck } from "./monitor";
import { apiErrorMessage } from "./api-client";

type Options = {
  start: (id: string) => Promise<UpdateCheck>;
  status: (id: string) => Promise<UpdateCheck | null>;
  current: (id: string) => boolean;
  generation: () => number;
  authorized: () => boolean;
  visible: () => boolean;
  installed?: () => void;
};
const active = (job: UpdateCheck | null) => !!job && ["requested", "accepted", "updating"].includes(job.state);

// One dialog owns this controller. Its epoch also distinguishes reopening the same device.
export function createDeviceUpdate(options: Options) {
  const state = reactive({ job: null as UpdateCheck | null, sending: false, reading: false, error: "", now: Date.now() });
  let nodeID = "", epoch = 0, session = 0;
  let poll: ReturnType<typeof setTimeout> | undefined, tick: ReturnType<typeof setInterval> | undefined;
  const pending = computed(() => active(state.job));
  const busy = computed(() => state.sending || state.reading || pending.value);
  const expired = computed(() => pending.value && !!state.job && state.job.expires_at <= state.now);
  const remaining = computed(() => {
    if (!pending.value || !state.job || expired.value) return "";
    const seconds = Math.max(0, Math.ceil((state.job.expires_at - state.now) / 1000));
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  });
  const message = computed(() => {
    if (state.sending) return "正在发送更新指令…";
    const job = state.job;
    if (!job) return state.reading ? "正在读取更新状态…" : "";
    if (expired.value || job.state === "timeout") return "更新等待超时，尚未收到设备完成确认。";
    if (job.state === "requested") return "更新指令已发送，等待设备确认…";
    if (job.state === "accepted") return "设备已接收更新指令，正在准备更新…";
    if (job.state === "updating") return "设备正在更新至 " + job.version + "，等待重启后确认…";
    if (job.state === "installed") return "设备已重新连接，确认已更新至 " + job.version + "。";
    if (job.state === "up_to_date") return "设备确认当前已是最新版本。";
    return apiErrorMessage(job.code || "update_failed");
  });
  const failed = computed(() => expired.value || state.job?.state === "failed" || state.job?.state === "timeout");
  function current(version = epoch) {
    return version === epoch && !!nodeID && session === options.generation() && options.authorized() && options.current(nodeID);
  }
  function stopTimers() { clearTimeout(poll); poll = undefined; clearInterval(tick); tick = undefined; }
  function close() {
    epoch++; nodeID = ""; stopTimers();
    state.job = null; state.sending = false; state.reading = false; state.error = "";
  }
  function schedule() {
    stopTimers();
    if (!current() || !pending.value || !options.visible()) return;
    // Expiration changes the display only. Only a server result can confirm installation.
    tick = setInterval(() => { state.now = Date.now(); }, 1000);
    poll = setTimeout(() => { void read(); }, 3000);
  }
  function apply(job: UpdateCheck | null) {
    const old = state.job;
    if (old && job && old.request_id === job.request_id && old.updated_at > job.updated_at) return;
    state.job = job; state.now = Date.now();
    if (job?.state === "installed" && (old?.request_id !== job.request_id || old.state !== "installed")) options.installed?.();
  }
  async function read() {
    if (!current() || !options.visible() || state.reading || state.sending) return;
    const version = epoch, id = nodeID;
    clearTimeout(poll); poll = undefined;
    state.reading = true;
    try {
      const job = await options.status(id);
      if (!current(version)) return;
      apply(job); state.error = "";
    } catch (error) {
      if (current(version)) state.error = error instanceof Error ? error.message : "暂时无法读取更新状态，请重试。";
    } finally {
      if (current(version)) { state.reading = false; schedule(); }
    }
  }
  async function open(id: string) {
    close(); nodeID = id; session = options.generation(); state.now = Date.now();
    await read();
  }
  async function start() {
    if (!current() || busy.value) return;
    const version = epoch, id = nodeID;
    let recoverExisting = false;
    stopTimers(); state.sending = true; state.error = "";
    try {
      const job = await options.start(id);
      if (!current(version)) return;
      apply(job);
    } catch (error) {
      if (current(version)) {
        state.job = null;
        state.error = error instanceof Error ? error.message : "更新指令发送失败，请重试。";
        recoverExisting = (error as { code?: string } | null)?.code === "update_request_conflict";
      }
    } finally {
      if (current(version)) {
        state.sending = false;
        if (recoverExisting) await read(); else schedule();
      }
    }
  }
  function visibilityChanged() {
    stopTimers(); state.now = Date.now();
    if (current() && options.visible() && pending.value) void read();
  }
  return { state, busy, pending, message, failed, remaining, open, close, start, visibilityChanged };
}
