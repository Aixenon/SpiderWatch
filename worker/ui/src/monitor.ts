import { reactive, ref, watch } from "vue";
import type { Volume, Memory, CPUDetail } from "../../public/metrics.js";
import { normalizeDeviceIcon, type DeviceIconID } from "../../public/device-icons.js";
import { recordSample, mergeResourceHistory, type ResourcePoint } from "../../public/resource-charts.js";
import { createHistoryCache } from "../../public/resource-history.js";
import { createPanelRefresh } from "../../public/panel-refresh.js";
import { DEFAULT_SETTINGS, settingsInput, type Settings } from "../../src/model";
import { request } from "./api-client";
import { authenticated, hasSession, lockSession, onSessionInvalidated, sessionGeneration } from "./session";

export type Group = { id: string; name: string };
export type Point = ResourcePoint;
export type Network = { name: string; rx_bytes_per_second?: number; tx_bytes_per_second?: number; rx_bytes?: number; tx_bytes?: number };
export type NodeMetrics = {
  time?: string; cpu_percent?: number; memory?: Memory; cpu_detail?: CPUDetail;
  disks?: Volume[]; networks?: Network[]; agent_rss_bytes?: number; uptime_seconds?: number;
  [key: string]: unknown;
};
export type Node = {
  node_id: string; name: string; nickname: string; icon: DeviceIconID; group_id: string | null;
  state: "approved" | "pending" | "revoked"; auto_update: boolean; connected: boolean; last_seen: number;
  host: { hostname: string; os: string; arch: string; cpus: number; physical_cpus?: number; logical_cpus?: number; cpu_model?: string; kernel?: string; agent_version: string; ip?: string };
  metrics: NodeMetrics; series: Point[];
};
type StateResponse = { group: string; settings: Settings; node_groups: Group[]; nodes: Omit<Node, "series">[] };
type HistoryResponse = { points: Point[]; to: number; from?: number; interval_seconds?: number; resolution_seconds?: number };
export type UpdateCheck = {
  request_id: string; state: "requested" | "accepted" | "updating" | "installed" | "up_to_date" | "failed" | "timeout";
  version: string; revision: string; updated_at: number; expires_at: number; code?: string;
};
export const state = reactive({ network: "", settings: { ...DEFAULT_SETTINGS }, groups: [] as Group[], nodes: [] as Node[] });
export const runtime = reactive({ watching: false, notice: "", error: false, loading: false, ready: false, connection: "正在验证登录", last_tick: 0 });
export const lists = reactive({
  overview: { query: "", group: "all", status: "all", page: 1, size: 25 },
  admin: { query: "", group: "all", status: "all", page: 1, size: 25 },
});
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(message: string, error = false) {
  clearTimeout(noticeTimer); runtime.notice = message; runtime.error = error;
  if (message) noticeTimer = setTimeout(() => { runtime.notice = ""; }, 4500);
}
const liveHistory = new Map<string, Point[]>();
const historyRevision = ref(0);
const storedHistory = createHistoryCache((id, range) => request<HistoryResponse>("/nodes/" + encodeURIComponent(id) + "/history?range=" + range));
function metrics(value: NodeMetrics): NodeMetrics {
  const result = value && typeof value === "object" ? { ...value } : {};
  if (!result.memory || typeof result.memory !== "object") delete result.memory;
  if (!result.cpu_detail || typeof result.cpu_detail !== "object") delete result.cpu_detail;
  if (!Array.isArray(result.disks)) delete result.disks;
  if (Array.isArray(result.networks)) result.networks = result.networks.filter(nic => nic && typeof nic.name === "string");
  else delete result.networks;
  return result;
}
function recordNode(node: Node) {
  const previous = liveHistory.get(node.node_id)?.at(-1)?.time || 0;
  recordSample(liveHistory, node, state.settings.active_seconds);
  const points = liveHistory.get(node.node_id) || [], gap = points.at(-2);
  storedHistory.checkpoint(node.node_id, points.at(-1),
    gap && gap.time > previous && gap.cpu === null && gap.memory === null && Object.keys(gap.networks).length === 0 ? gap : undefined,
    state.settings.idle_seconds);
  node.series = points.slice();
}
async function readState(): Promise<boolean> {
  const generation = sessionGeneration();
  runtime.loading = true;
  try {
    const data = await request<StateResponse>("/state?view=live");
    if (generation !== sessionGeneration() || !hasSession()) return false;
    if (!Array.isArray(data.nodes) || !Array.isArray(data.node_groups) || !data.settings || typeof data.group !== "string") throw new Error("服务器状态无效，请刷新重试。");
    state.network = data.group; state.groups = data.node_groups;
    if (data.settings.version >= state.settings.version) state.settings = data.settings;
    const previous = new Map(state.nodes.map(node => [node.node_id, node]));
    state.nodes = data.nodes.map(raw => {
      const old = previous.get(raw.node_id);
      const next = { ...raw, metrics: metrics(raw.metrics), icon: normalizeDeviceIcon(raw.icon), series: [] as Point[] };
      // A snapshot already in flight must not replace a newer socket report.
      if (old && old.last_seen > next.last_seen) {
        next.metrics = old.metrics; next.last_seen = old.last_seen; next.connected = old.connected;
      }
      const node = old ? Object.assign(old, next) : next;
      recordNode(node);
      return node;
    });
    const ids = new Set(state.nodes.map(node => node.node_id));
    for (const id of liveHistory.keys()) if (!ids.has(id)) liveHistory.delete(id);
    for (const id of storedHistory.keys()) if (!ids.has(id)) storedHistory.delete(id);
    historyRevision.value++; runtime.ready = true;
    return true;
  } catch (error) {
    if (generation === sessionGeneration() && hasSession()) notify(error instanceof Error ? error.message : "无法读取设备状态，请重试。", true);
    return false;
  } finally { if (generation === sessionGeneration()) runtime.loading = false; }
}
const refresh = createPanelRefresh(readState, { enabled: () => hasSession() && !document.hidden });
export function loadState(fresh = false) { return refresh.load(fresh); }
function requireCurrentSession(generation: number) {
  if (generation !== sessionGeneration() || !hasSession()) throw new Error("会话已结束，请重新登录。");
}
async function mutate(path: string, method: string, body?: unknown) {
  const generation = sessionGeneration();
  await request(path, method, body);
  requireCurrentSession(generation);
  const loaded = await loadState(true);
  requireCurrentSession(generation);
  if (!loaded) throw new Error("更改已保存，但状态刷新失败，请刷新页面确认。");
}
export const api = {
  configure(id: string, nickname: string, groupID: string | null, icon?: string, autoUpdate?: boolean) {
    return mutate("/nodes/" + encodeURIComponent(id), "PATCH", {
      nickname, group_id: groupID, ...(icon === undefined ? {} : { icon }), ...(autoUpdate === undefined ? {} : { auto_update: autoUpdate }),
    });
  },
  nickname(id: string, nickname: string) { return mutate("/nodes/" + encodeURIComponent(id), "PATCH", { nickname }); },
  remove(id: string) { return mutate("/nodes/" + encodeURIComponent(id), "DELETE"); },
  assign(ids: string[], groupID: string | null) { return mutate("/nodes/groups", "PUT", { node_ids: ids, group_id: groupID }); },
  createGroup(name: string) { return mutate("/node-groups", "POST", { name }); },
  renameGroup(id: string, name: string) { return mutate("/node-groups/" + encodeURIComponent(id), "PUT", { name }); },
  removeGroup(id: string) { return mutate("/node-groups/" + encodeURIComponent(id), "DELETE"); },
  async saveSettings(active: number, idle: number) {
    const generation = sessionGeneration();
    let input;
    try { input = settingsInput({ active_seconds: active, idle_seconds: idle }); }
    catch { throw new Error("观看间隔需为 2–300 秒，无人观看间隔需为 30–86400 秒，且不小于观看间隔。"); }
    const saved = await request<Settings>("/settings", "PUT", input);
    requireCurrentSession(generation);
    if (saved.version >= state.settings.version) state.settings = saved;
    const loaded = await loadState(true);
    requireCurrentSession(generation);
    if (!loaded) throw new Error("更新间隔已保存，但状态刷新失败，请刷新页面确认。");
  },
  checkUpdate(id: string) { return request<UpdateCheck>("/nodes/" + encodeURIComponent(id) + "/update-check", "POST"); },
  updateStatus(id: string) { return request<UpdateCheck | null>("/nodes/" + encodeURIComponent(id) + "/update-status"); },
};
export function resourcePoints(id: string): Point[] {
  void historyRevision.value;
  return mergeResourceHistory(storedHistory.get(id).points, liveHistory.get(id) || [], state.settings.idle_seconds);
}
export function historyStatus(id: string) {
  void historyRevision.value;
  const entry = storedHistory.get(id);
  return { loading: !!entry.pending, error: entry.error };
}
export async function loadHistory(id: string, range: number, retry = false): Promise<void> {
  if (!hasSession() || !state.nodes.some(node => node.node_id === id)) return;
  const pending = storedHistory.load(id, range, retry);
  historyRevision.value++;
  if (pending) {
    await pending;
    historyRevision.value++;
  }
}

let wantsLive = false;
let socket: WebSocket | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let connectTimeout: ReturnType<typeof setTimeout> | undefined;
let acknowledgementTimeout: ReturnType<typeof setTimeout> | undefined;
let retry = 0;
function liveEnabled() { return wantsLive && !document.hidden && hasSession(); }
function clearSocketTimers() {
  clearInterval(heartbeat); heartbeat = undefined;
  clearTimeout(connectTimeout); connectTimeout = undefined;
  clearTimeout(acknowledgementTimeout); acknowledgementTimeout = undefined;
}
function scheduleReconnect() {
  clearTimeout(reconnect); reconnect = undefined;
  if (!liveEnabled()) return;
  const delay = Math.min(60000, 2000 * 2 ** Math.min(retry++, 5));
  reconnect = setTimeout(connect, delay + Math.random() * 1000);
}
function closeSocket(ws: WebSocket, code: number, reason: string) {
  try { ws.close(code, reason); }
  catch { /* The obsolete socket must not prevent timer cleanup or reconnecting. */ }
}
function lostConnection(ws: WebSocket, close = true) {
  if (socket !== ws) return;
  socket = undefined; clearSocketTimers();
  runtime.watching = false; runtime.connection = "连接中断，等待重连";
  // Browsers may never emit close for a half-open connection. Invalidate it now.
  if (close) closeSocket(ws, 4000, "connection timeout");
  scheduleReconnect();
}
function stopLive() {
  clearTimeout(reconnect); reconnect = undefined; clearSocketTimers();
  const old = socket; socket = undefined;
  if (old) closeSocket(old, 1000, "panel not viewing");
  runtime.watching = false; runtime.connection = hasSession() ? "实时观看已暂停" : "未登录";
}
function connect() {
  if (!liveEnabled() || socket) return;
  clearTimeout(reconnect); reconnect = undefined;
  const ws = new WebSocket((location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/panel/api/live");
  socket = ws; runtime.connection = "正在连接";
  connectTimeout = setTimeout(() => { lostConnection(ws); }, 15000);
  ws.onopen = () => {
    if (socket !== ws) return;
    if (!liveEnabled()) { stopLive(); return; }
    clearTimeout(connectTimeout); connectTimeout = undefined;
    runtime.watching = true; runtime.connection = "实时连接中";
    heartbeat = setInterval(() => {
      if (socket !== ws) return;
      if (!liveEnabled()) { stopLive(); return; }
      if (ws.readyState !== WebSocket.OPEN) { lostConnection(ws); return; }
      // Keep the existing 30-second heartbeat cadence; only its reply gets a watchdog.
      acknowledgementTimeout = setTimeout(() => { lostConnection(ws); }, 15000);
      try { ws.send(JSON.stringify({ type: "heartbeat" })); }
      catch { lostConnection(ws); }
    }, 30000);
    void loadState();
  };
  ws.onmessage = event => {
    if (socket !== ws || !hasSession()) return;
    let message: { type?: string; settings?: Settings; node_id?: string; metrics?: NodeMetrics; last_seen?: number };
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (["settings", "metrics", "refresh", "heartbeat_ack"].includes(message.type || "")) retry = 0;
    if (message.type === "heartbeat_ack") { clearTimeout(acknowledgementTimeout); acknowledgementTimeout = undefined; }
    else if (message.type === "settings" && message.settings && message.settings.version >= state.settings.version) state.settings = message.settings;
    else if (message.type === "metrics" && message.node_id && message.metrics && typeof message.last_seen === "number") {
      const node = state.nodes.find(candidate => candidate.node_id === message.node_id);
      if (!node) { void loadState(true); return; }
      if (message.last_seen < node.last_seen) return;
      node.metrics = metrics(message.metrics); node.last_seen = message.last_seen; node.connected = true;
      recordNode(node); historyRevision.value++; runtime.last_tick = message.last_seen;
    } else if (message.type === "refresh") void loadState(true);
    else if (message.type === "session_expired") lockSession("session_expired");
  };
  ws.onclose = () => { lostConnection(ws, false); };
  ws.onerror = () => { lostConnection(ws); };
}
export function watchLive(live: boolean) {
  wantsLive = live;
  if (liveEnabled()) { connect(); void loadState(); }
  else stopLive();
}
function resume() {
  if (!hasSession() || document.hidden) return;
  connect(); void loadState();
}
document.addEventListener("visibilitychange", () => {
  refresh.invalidate();
  if (document.hidden) stopLive(); else resume();
});
window.addEventListener("pagehide", () => { refresh.invalidate(); stopLive(); });
window.addEventListener("pageshow", resume);
window.addEventListener("online", () => {
  if (!liveEnabled()) return;
  stopLive(); connect();
});
setInterval(() => { if (hasSession() && !document.hidden) void loadState(); }, 120000);
watch(authenticated, valid => { if (valid) resume(); });
onSessionInvalidated(() => {
  wantsLive = false; stopLive(); refresh.invalidate(); clearTimeout(noticeTimer);
  state.network = ""; state.nodes = []; state.groups = []; state.settings = { ...DEFAULT_SETTINGS };
  liveHistory.clear(); storedHistory.clear(); historyRevision.value++;
  runtime.ready = false; runtime.loading = false; runtime.notice = ""; runtime.error = false; runtime.last_tick = 0;
});
