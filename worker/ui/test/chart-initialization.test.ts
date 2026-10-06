import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { chartGeometry } from "../../public/resource-charts.js";
import { request } from "../src/api-client";
import { authenticated, lockSession } from "../src/session";

vi.mock("../src/api-client", () => ({ request: vi.fn() }));
vi.mock("../src/session", async () => {
  const { ref } = await import("vue");
  const authenticated = ref(false), listeners = new Set<() => void>();
  let generation = 0;
  return {
    authenticated, hasSession: () => authenticated.value, sessionGeneration: () => generation,
    onSessionInvalidated: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    lockSession: () => { generation++; authenticated.value = false; for (const listener of listeners) listener(); },
  };
});
class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  send = vi.fn(); close = vi.fn();
  constructor() { Socket.latest = this; }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const page = { hidden: true, addEventListener: vi.fn() };
const requestMock = vi.mocked(request);
const start = Date.UTC(2026, 9, 6);
let monitor: typeof import("../src/monitor");
function node(time = start, interval?: number) {
  return { node_id: "new-device", name: "New device", nickname: "", icon: "server", group_id: null,
    state: "approved", auto_update: false, connected: true, last_seen: time, report_interval_seconds: interval,
    host: { hostname: "new-device", os: "linux", arch: "amd64", cpus: 2, agent_version: "0.2.0" },
    metrics: { time: new Date(time).toISOString(), cpu_percent: 20, memory: { total_bytes: 100, used_bytes: 40 }, networks: [] },
  };
}
function snapshot(nodes = [node()]) {
  return { group: "network", node_groups: [], nodes,
    settings: { active_seconds: 5, idle_seconds: 600, version: 1, updated_at: 0 } };
}
function receive(time: number, interval?: number) {
  Socket.latest.receive({ type: "metrics", node_id: "new-device", last_seen: time,
    report_interval_seconds: interval, metrics: node(time).metrics });
}
function points() { return monitor.resourcePoints("new-device"); }
async function open(initial = snapshot()) {
  requestMock.mockResolvedValue(initial);
  await monitor.loadState(true);
  monitor.watchLive(true); Socket.latest.onopen?.();
  await monitor.loadState();
}
beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", page); vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("location", { protocol: "https:", host: "monitor.test" });
  monitor = await import("../src/monitor");
});
beforeEach(async () => {
  vi.setSystemTime(start); page.hidden = true; lockSession(); await nextTick();
  requestMock.mockReset(); authenticated.value = true; await nextTick(); page.hidden = false;
});
afterEach(async () => { page.hidden = true; lockSession(); await nextTick(); vi.clearAllTimers(); });
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("starts a newly joined device empty, then adds only its first real report", async () => {
  const initial = node(0); initial.metrics.time = "";
  await open(snapshot([initial]));
  expect(points()).toEqual([]);
  expect(chartGeometry([], ["cpu"], 100, 60000, start).series[0].path).toBe("");
  receive(start, 5);
  expect(points()).toHaveLength(1);
  expect(chartGeometry(points().map(({ time, cpu }) => ({ time, cpu })), ["cpu"], 100, 60000, start).series[0].markers).toEqual([{ x: 632, y: 72 }]);
});

it("merges initial state, initial socket replay and first detail history as one sample", async () => {
  await open(); receive(start, 5); receive(start, 5);
  requestMock.mockResolvedValueOnce({ from: start - 60000, to: start, points: [points()[0]], interval_seconds: 600 });
  await monitor.loadHistory("new-device", 60);
  expect(points()).toHaveLength(1);
  receive(start + 5000, 5);
  expect(points().map(point => point.time)).toEqual([start, start + 5000]);
  const graph = chartGeometry(points().map(({ time, cpu }) => ({ time, cpu })), ["cpu"], 100, 60000, start + 5000);
  expect(graph.series[0].path.match(/L/g)).toHaveLength(1);
  expect(graph.series[0].markers).toEqual([]);
});

it("loads a just-joined node missing from the first snapshot without duplicating its socket report", async () => {
  await open(snapshot([]));
  requestMock.mockResolvedValue(snapshot([node(start, 5)]));
  receive(start, 5); await monitor.loadState(); receive(start, 5);
  expect(monitor.state.nodes).toHaveLength(1);
  expect(points().map(point => point.time)).toEqual([start]);
});

it("uses the actual fallback report interval instead of making every minute a disconnected dot", async () => {
  await open(snapshot([node(start, 60)]));
  receive(start + 60000, 60); receive(start + 120000, 60);
  expect(points().map(point => point.cpu)).toEqual([20, 20, 20]);
  expect(points().map(point => point.interval_seconds)).toEqual([60, 60, 60]);
  receive(start + 300000, 60);
  expect(points().map(point => point.cpu)).toEqual([20, 20, 20, null, 20]);
});

it("keeps a newer socket sample and its reporting interval when an older state read finishes", async () => {
  await open(snapshot([node(start, 5)]));
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  requestMock.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const reading = monitor.loadState(true); await Promise.resolve();
  receive(start + 60000, 60);
  resolve(snapshot([node(start, 5)])); await reading;
  expect(monitor.state.nodes[0].report_interval_seconds).toBe(60);
  receive(start + 120000, 60);
  expect(points().map(point => point.cpu)).toEqual([20, 20, 20]);
});

it.each([undefined, 0, -1, NaN])("falls back to the configured interval for invalid report metadata %s", async interval => {
  await open(snapshot([node(start, interval)]));
  receive(start + 5000, interval);
  expect(points().map(point => point.interval_seconds)).toEqual([5, 5]);
  receive(start + 25000, interval);
  expect(points().map(point => point.cpu)).toEqual([20, 20, null, 20]);
});
