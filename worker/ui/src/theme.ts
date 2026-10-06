import { ref } from "vue";

export type Theme = "light" | "dark";
export type ThemeMode = "auto" | Theme;
const KEY = "spider-watch-theme-mode";

export function timeTheme(now = new Date()): Theme {
  return now.getHours() >= 7 && now.getHours() < 19 ? "light" : "dark";
}
function savedMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* The theme still works without browser storage. */ }
  return "auto";
}
export const themeMode = ref<ThemeMode>(savedMode());
export const theme = ref<Theme>(themeMode.value === "auto" ? timeTheme() : themeMode.value);
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

function syncTheme() {
  clearTimeout(timer);
  const now = new Date();
  theme.value = themeMode.value === "auto" ? timeTheme(now) : themeMode.value;
  document.documentElement.dataset.theme = theme.value;
  document.documentElement.style.colorScheme = theme.value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.value === "dark" ? "#0f172a" : "#f4f6fb");
  if (!started || document.hidden || themeMode.value !== "auto") return;
  const boundary = new Date(now);
  if (now.getHours() < 7) boundary.setHours(7, 0, 0, 0);
  else if (now.getHours() < 19) boundary.setHours(19, 0, 0, 0);
  else { boundary.setDate(boundary.getDate() + 1); boundary.setHours(7, 0, 0, 0); }
  // Recheck the local clock after adjustments; hidden tabs do no periodic work.
  timer = setTimeout(syncTheme, Math.min(60_000, Math.max(1, boundary.getTime() - now.getTime())));
}
export function setThemeMode(value: ThemeMode) {
  if (!["auto", "light", "dark"].includes(value)) return;
  themeMode.value = value;
  try { localStorage.setItem(KEY, value); } catch { /* Keep the selection for this page. */ }
  syncTheme();
}
function storageChanged(event: StorageEvent) {
  if (event.key !== KEY && event.key !== null) return;
  themeMode.value = savedMode();
  syncTheme();
}
export function startTheme() {
  if (started) return;
  started = true;
  document.addEventListener("visibilitychange", syncTheme);
  window.addEventListener("focus", syncTheme);
  window.addEventListener("pageshow", syncTheme);
  window.addEventListener("storage", storageChanged);
  syncTheme();
}
export function stopTheme() {
  started = false;
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", syncTheme);
  window.removeEventListener("focus", syncTheme);
  window.removeEventListener("pageshow", syncTheme);
  window.removeEventListener("storage", storageChanged);
}
syncTheme();
