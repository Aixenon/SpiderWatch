import { ref } from "vue";

const KEY = "cf-monitor-theme";
function initial(): "light" | "dark" {
  try { const saved = localStorage.getItem(KEY); if (saved === "light" || saved === "dark") return saved; } catch { /* Private browsing may block persistence. */ }
  return "dark";
}
export const theme = ref(initial());
function apply() { document.documentElement.dataset.theme = theme.value; document.documentElement.style.colorScheme = theme.value; }
apply();
export function toggleTheme() {
  theme.value = theme.value === "dark" ? "light" : "dark";
  apply();
  try { localStorage.setItem(KEY, theme.value); } catch { /* The current session still changes. */ }
}
