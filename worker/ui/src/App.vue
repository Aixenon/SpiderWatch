<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { loadState, notify, runtime, state, watchLive } from "./monitor";
import { theme, themeMode, setThemeMode, startTheme, stopTheme, type ThemeMode } from "./theme";
import { authenticated, logout, sessionLoading, startSession } from "./session";
import Login from "./components/Login.vue";

const route = useRoute();
const exiting = ref(false);
const themeNames: Record<ThemeMode, string> = { auto: "自动", light: "浅色", dark: "深色" };
const nextTheme = computed<ThemeMode>(() => themeMode.value === "auto" ? "light" : themeMode.value === "light" ? "dark" : "auto");
const themeLabel = computed(() => themeMode.value === "auto" ? `自动 · ${themeNames[theme.value]}` : themeNames[themeMode.value]);
const themeHint = computed(() => `当前${themeLabel.value}，点击切换为${themeNames[nextTheme.value]}`);
const pending = computed(() => state.nodes.filter(n => n.state === "pending").length);
const livePage = computed(() => authenticated.value && (route.path === "/" || (route.path.startsWith("/server/") && state.nodes.some(n => n.node_id === route.params.id && n.state === "approved"))));
watch(livePage, watchLive, { immediate: true });
onMounted(startSession);
onMounted(startTheme);
onBeforeUnmount(() => { watchLive(false); stopTheme(); });
async function exit() {
  if (exiting.value) return;
  exiting.value = true;
  try { await logout(); } catch (error) { notify((error as Error).message, true); }
  finally { exiting.value = false; }
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <RouterLink to="/" class="brand" aria-label="SpiderWatch 总览">
        <span class="brand-icon"><svg viewBox="0 0 32 32" aria-hidden="true" style="stroke-width:1.5"><path d="M16 3v26M3 16h26M6.5 6.5l19 19M25.5 6.5l-19 19M16 4Q18 8 24.5 7.5Q24 14 28 16Q24 18 24.5 24.5Q18 24 16 28Q14 24 7.5 24.5Q8 18 4 16Q8 14 7.5 7.5Q14 8 16 4ZM16 10Q17 12 20.2 11.8Q20 15 22 16Q20 17 20.2 20.2Q17 20 16 22Q15 20 11.8 20.2Q12 17 10 16Q12 15 11.8 11.8Q15 12 16 10Z" /></svg></span>
        <span class="brand-wordmark"><span class="brand-name">SpiderWatch</span><small class="brand-tagline" aria-label="Network Monitor"><span v-for="(letter, index) in 'NETWORK MONITOR'" :key="index" aria-hidden="true">{{ letter === ' ' ? '\u00a0' : letter }}</span></small></span>
      </RouterLink>
      <nav v-if="authenticated" aria-label="主导航">
        <RouterLink to="/" :class="{ active: route.path === '/' || route.path.startsWith('/server/') }">总览</RouterLink>
        <RouterLink to="/admin" :class="{ active: route.path === '/admin' }">管理<span v-if="pending" class="nav-count">{{ pending }}</span></RouterLink>
        <RouterLink to="/settings" :class="{ active: route.path === '/settings' }">设置</RouterLink>
      </nav>
      <div class="header-end">
        <button type="button" class="secondary theme-toggle" :aria-label="themeHint" :title="themeHint" @click="setThemeMode(nextTheme)">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <template v-if="themeMode === 'auto'"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></template>
            <template v-else-if="themeMode === 'light'"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></template>
            <path v-else d="M20.7 13A8.7 8.7 0 0 1 11 3.3 8.7 8.7 0 1 0 20.7 13Z"/>
          </svg>
          <span>{{ themeLabel }}</span>
        </button>
        <button v-if="authenticated" class="button-quiet" aria-label="退出登录" :disabled="exiting" @click="exit">退出</button>
      </div>
    </header>

    <div v-if="authenticated && runtime.notice" class="notice" :class="{ error: runtime.error }" role="status" aria-live="polite">{{ runtime.notice }}</div>
    <main>
      <p v-if="sessionLoading" class="session-loading" role="status">正在加载…</p>
      <template v-else-if="authenticated">
        <div v-if="runtime.loading && !runtime.ready" class="session-loading" role="status">正在读取设备…</div>
        <div v-else-if="!runtime.ready" class="panel empty-state"><p>暂时无法读取设备。</p><button class="secondary small" @click="loadState(true)">重新加载</button></div>
        <RouterView v-else />
      </template>
      <Login v-else />
    </main>
  </div>
</template>

<style scoped>
.session-loading{text-align:center;color:var(--muted);padding:64px 0}
.theme-toggle{width:116px;min-height:34px;padding:5px 8px;gap:6px;font-size:12px;font-weight:500;background:var(--panel);color:var(--ink);border-color:var(--line)}
.theme-toggle svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
@media(max-width:600px){.theme-toggle{width:104px;font-size:11px}}
</style>
