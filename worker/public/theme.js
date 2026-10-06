"use strict";
(() => {
  let theme = "dark";
  try { const stored = localStorage.getItem("cf-monitor-theme"); if (stored === "light" || stored === "dark") theme = stored; } catch {}
  const button = document.getElementById("toggle-theme");
  function apply() {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    button.textContent = theme === "dark" ? "☀ 浅色" : "☾ 深色";
    button.setAttribute("aria-label", theme === "dark" ? "切换浅色模式" : "切换深色模式");
  }
  apply(); button.addEventListener("click", () => { theme = theme === "dark" ? "light" : "dark"; apply(); try {localStorage.setItem("cf-monitor-theme", theme);} catch {} });
})();
