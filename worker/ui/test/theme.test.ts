import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "vue";

let theme: typeof import("../src/theme") | undefined;
let page: EventTarget & { hidden: boolean; documentElement: { dataset: Record<string, string>; style: Record<string, string> }; querySelector: ReturnType<typeof vi.fn> };
let browser: EventTarget;
let values: Map<string, string>;
const localTime = (hour: number, minute = 0, second = 0) => new Date(2026, 9, 6, hour, minute, second);

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(localTime(12));
  values = new Map();
  page = Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: {}, style: {} }, querySelector: vi.fn(() => null) });
  browser = new EventTarget();
  vi.stubGlobal("document", page); vi.stubGlobal("window", browser);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => { theme?.stopTheme(); theme = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
async function start() { theme = await import("../src/theme"); theme.startTheme(); return theme; }

describe("local clock display mode", () => {
  it("defaults to the current local time instead of keeping an old permanent dark preference", async () => {
    values.set("cf-monitor-theme", "dark");
    const mode = await start();
    expect(mode.themeMode.value).toBe("auto");
    expect(page.documentElement.dataset.theme).toBe("light");
    expect(page.documentElement.style.colorScheme).toBe("light");
  });
  it("changes at 07:00 and 19:00 while the page stays open", async () => {
    vi.setSystemTime(localTime(6, 59, 59));
    const mode = await start();
    expect(mode.theme.value).toBe("dark");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mode.theme.value).toBe("light");
    vi.setSystemTime(localTime(18, 59, 59)); browser.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(mode.theme.value).toBe("dark");
  });
  it("does no periodic work while hidden and catches up after sleep", async () => {
    const mode = await start();
    page.hidden = true; page.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(localTime(22));
    page.hidden = false; page.dispatchEvent(new Event("visibilitychange"));
    expect(mode.theme.value).toBe("dark");
    expect(vi.getTimerCount()).toBe(1);
  });
  it("detects a changed system clock without another page load", async () => {
    const mode = await start();
    vi.setSystemTime(localTime(23));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mode.theme.value).toBe("dark");
  });
  it("keeps explicit manual mode across time changes and can return to automatic", async () => {
    values.set("spider-watch-theme-mode", "dark");
    const mode = await start();
    expect(mode.theme.value).toBe("dark"); expect(vi.getTimerCount()).toBe(0);
    mode.setThemeMode("light"); vi.setSystemTime(localTime(22)); browser.dispatchEvent(new Event("focus"));
    expect(mode.theme.value).toBe("light");
    expect(values.get("spider-watch-theme-mode")).toBe("light");
    mode.setThemeMode("auto");
    expect(mode.theme.value).toBe("dark"); expect(vi.getTimerCount()).toBe(1);
  });
  it("still follows time when storage is unavailable and cleans up its timer", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    const mode = await start(); mode.setThemeMode("auto");
    expect(mode.theme.value).toBe("light");
    mode.startTheme(); expect(vi.getTimerCount()).toBe(1);
    mode.stopTheme(); expect(vi.getTimerCount()).toBe(0);
  });
  it("updates an already open tab when another tab changes or clears the preference", async () => {
    const mode = await start();
    values.set("spider-watch-theme-mode", "dark");
    browser.dispatchEvent(Object.assign(new Event("storage"), { key: "spider-watch-theme-mode" }));
    expect(mode.theme.value).toBe("dark"); expect(vi.getTimerCount()).toBe(0);
    values.clear(); browser.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
    expect(mode.themeMode.value).toBe("auto"); expect(mode.theme.value).toBe("light");
  });
});
