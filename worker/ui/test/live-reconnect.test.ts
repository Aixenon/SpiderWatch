import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { request } from "../src/api-client";
import { authenticated, lockSession } from "../src/session";

vi.mock("../src/api-client", () => ({ request: vi.fn() }));
vi.mock("../src/session", async () => {
  const { ref } = await import("vue");
  const authenticated = ref(false), listeners = new Set<() => void>();
  let generation = 0;
  return { authenticated, hasSession: () => authenticated.value, sessionGeneration: () => generation,
    onSessionInvalidated: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    lockSession: () => { generation++; authenticated.value = false; for (const listener of listeners) listener(); },
  };
});

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; }); // Half-open browsers may never deliver close.
  constructor(public url: string) { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const page = Object.assign(new EventTarget(), { hidden: true });
const windowEvents = new EventTarget();
let monitor: typeof import("../src/monitor");
const requestMock = vi.mocked(request);
const snapshot = { group: "network", node_groups: [], nodes: [], settings: { active_seconds: 5, idle_seconds: 600, version: 1, updated_at: 0 } };

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", page); vi.stubGlobal("window", windowEvents); vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { protocol: "https:", host: "monitor.test" });
  monitor = await import("../src/monitor");
});
beforeEach(async () => {
  vi.setSystemTime(Date.UTC(2026, 9, 6)); vi.spyOn(Math, "random").mockReturnValue(0);
  page.hidden = true; lockSession(); await nextTick();
  requestMock.mockReset().mockResolvedValue(snapshot);
  authenticated.value = true; await nextTick(); page.hidden = false;
  // A healthy prior connection resets backoff without exposing an implementation hook.
  monitor.watchLive(true); const warm = Socket.instances.at(-1)!; warm.open(); warm.receive({ type: "heartbeat_ack" });
  await monitor.loadState(); monitor.watchLive(false); Socket.instances = [];
});
afterEach(async () => { monitor.watchLive(false); page.hidden = true; lockSession(); await nextTick(); vi.clearAllTimers(); });
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("live connection recovery", () => {
  it("replaces a connection that never opens after fifteen seconds", async () => {
    monitor.watchLive(true); const stalled = Socket.instances[0];
    await vi.advanceTimersByTimeAsync(14999); expect(stalled.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(stalled.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); expect(Socket.instances).toHaveLength(2);
    // A stale event cannot clear the replacement's timeout or revive the old socket.
    stalled.open(); stalled.receive({ type: "heartbeat_ack" });
    await vi.advanceTimersByTimeAsync(15000); expect(Socket.instances[1].close).toHaveBeenCalled();
  });

  it("keeps thirty-second heartbeats and reconnects when their acknowledgement is missing", async () => {
    monitor.watchLive(true); const stalled = Socket.instances[0]; stalled.open();
    await vi.advanceTimersByTimeAsync(29999); expect(stalled.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(stalled.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "heartbeat" }));
    await vi.advanceTimersByTimeAsync(15000); expect(stalled.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); expect(Socket.instances).toHaveLength(2);
    expect(stalled.send).toHaveBeenCalledTimes(1);
  });

  it("accepts acknowledgement without increasing heartbeat frequency", async () => {
    monitor.watchLive(true); const live = Socket.instances[0]; live.open();
    await vi.advanceTimersByTimeAsync(30000); live.receive({ type: "heartbeat_ack" });
    await vi.advanceTimersByTimeAsync(30000); expect(live.close).not.toHaveBeenCalled(); expect(live.send).toHaveBeenCalledTimes(2);
    live.receive({ type: "heartbeat_ack" }); await vi.advanceTimersByTimeAsync(15000);
    expect(live.close).not.toHaveBeenCalled(); expect(Socket.instances).toHaveLength(1);
  });

  it("continues reconnecting even when closing the broken socket throws", async () => {
    monitor.watchLive(true); const broken = Socket.instances[0]; broken.open();
    broken.close.mockImplementationOnce(() => { throw new Error("socket close failed"); });
    expect(() => broken.onerror?.()).not.toThrow();
    await vi.advanceTimersByTimeAsync(2000); expect(Socket.instances).toHaveLength(2);
    expect(broken.send).not.toHaveBeenCalled();
  });

  it("backs off repeated unhealthy opens and resets only after a healthy message", async () => {
    monitor.watchLive(true); const first = Socket.instances[0]; first.open(); first.onerror?.();
    await vi.advanceTimersByTimeAsync(2000); const second = Socket.instances[1]; second.open(); second.onerror?.();
    await vi.advanceTimersByTimeAsync(2000); expect(Socket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000); const third = Socket.instances[2]; third.open(); third.receive({ type: "heartbeat_ack" }); third.onerror?.();
    await vi.advanceTimersByTimeAsync(2000); expect(Socket.instances).toHaveLength(4);
  });

  it("reconnects immediately on online and ignores callbacks from the old socket", async () => {
    monitor.watchLive(true); const old = Socket.instances[0]; old.open();
    windowEvents.dispatchEvent(new Event("online")); expect(Socket.instances).toHaveLength(2); expect(old.close).toHaveBeenCalled();
    const live = Socket.instances[1]; live.open(); old.onerror?.(); old.onclose?.();
    await vi.advanceTimersByTimeAsync(30000); expect(live.send).toHaveBeenCalledTimes(1); expect(old.send).not.toHaveBeenCalled();
    old.receive({ type: "heartbeat_ack" });
    await vi.advanceTimersByTimeAsync(15000); expect(live.close).toHaveBeenCalled();
  });

  it("cleans watchdogs when hidden or signed out and does not connect on non-live pages", async () => {
    monitor.watchLive(true); const old = Socket.instances[0]; old.open();
    await vi.advanceTimersByTimeAsync(30000); page.hidden = true; page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60000); expect(Socket.instances).toHaveLength(1); expect(old.send).toHaveBeenCalledTimes(1);
    windowEvents.dispatchEvent(new Event("online")); expect(Socket.instances).toHaveLength(1);
    page.hidden = false; page.dispatchEvent(new Event("visibilitychange")); expect(Socket.instances).toHaveLength(2);
    lockSession(); await nextTick(); await vi.advanceTimersByTimeAsync(60000); expect(Socket.instances).toHaveLength(2);
    windowEvents.dispatchEvent(new Event("online")); expect(Socket.instances).toHaveLength(2);
    authenticated.value = true; await nextTick(); monitor.watchLive(false);
    windowEvents.dispatchEvent(new Event("online")); expect(Socket.instances).toHaveLength(2);
  });
});
