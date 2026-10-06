<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { api, notify, state } from "../monitor";
import { bytes, number, usageClass } from "../format";
import { quota, quotaError, refreshQuota, nextQuotaRefresh } from "../quota";
import type { QuotaRow } from "../../../src/quota-model";

const active = ref(state.settings.active_seconds), idle = ref(state.settings.idle_seconds);
const saving = ref(false), dirty = ref(false);
watch(() => state.settings.version, () => {
  if (!dirty.value) { active.value = state.settings.active_seconds; idle.value = state.settings.idle_seconds; }
});
async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    await api.saveSettings(Number(active.value), Number(idle.value));
    dirty.value = false; active.value = state.settings.active_seconds; idle.value = state.settings.idle_seconds;
    notify("更新间隔已保存。");
  } catch (error) { notify((error as Error).message, true); }
  finally { saving.value = false; }
}
let timer: ReturnType<typeof setTimeout> | undefined, mounted = false;
async function updateQuota() {
  if (timer) clearTimeout(timer);
  if (!mounted || document.hidden) return;
  await refreshQuota();
  if (mounted && !document.hidden) timer = setTimeout(updateQuota, Math.max(1000, (nextQuotaRefresh() || Date.now() + 300000) - Date.now()));
}
onMounted(() => { mounted = true; document.addEventListener("visibilitychange", updateQuota); void updateQuota(); });
onUnmounted(() => { mounted = false; clearTimeout(timer); document.removeEventListener("visibilitychange", updateQuota); });
function value(row: QuotaRow, amount: number | null) { return amount === null ? "—" : row.unit === "bytes" ? bytes(amount) : `${number(amount, row.unit === "GB-s" ? 3 : 0)} ${row.unit}`; }
</script>

<template>
  <section class="settings-page">
    <div class="settings-overview">
      <section class="panel interval-panel" aria-labelledby="interval-heading">
        <div class="panel-heading"><h2 id="interval-heading">更新间隔</h2></div>
        <form class="interval-controls" @submit.prevent="save" @input="dirty = true" @change="dirty = true">
          <label for="active-seconds">面板开启<span class="interval-input"><input id="active-seconds" :disabled="saving" v-model.number="active" type="number" min="2" max="300" step="1" required aria-label="面板开启（秒）" /><span aria-hidden="true">秒</span></span></label>
          <label for="idle-seconds">面板关闭<span class="interval-input"><select id="idle-seconds" :disabled="saving" v-model.number="idle" required aria-label="面板关闭"><option :value="120">2 分钟</option><option :value="300">5 分钟</option><option :value="600">10 分钟</option><option v-if="![120,300,600].includes(state.settings.idle_seconds)" :value="state.settings.idle_seconds">{{ state.settings.idle_seconds }} 秒（当前）</option></select></span></label>
          <button type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
        </form>
      </section>
      <section class="panel network-panel" aria-labelledby="network-heading">
        <div class="panel-heading"><h2 id="network-heading">网络信息</h2></div>
        <dl class="network-facts"><div><dt>网络代码</dt><dd><code>{{ state.network }}</code></dd></div><div><dt>设备总数</dt><dd>{{ state.nodes.length }} <span>台</span></dd></div></dl>
      </section>
    </div>

    <section class="panel quota-panel" aria-labelledby="quota-heading">
      <div class="panel-heading"><h2 id="quota-heading">实时额度</h2></div>
      <div class="quota-meta"><span>{{ quota?.day || '今日' }} · UTC</span><span v-if="quota?.checked_at">{{ new Date(quota.checked_at).toLocaleTimeString('zh-CN', {hour12:false}) }}</span></div><p v-if="quotaError" class="form-error" role="alert">{{ quotaError }}</p><p v-else-if="!quota" class="muted" role="status">正在读取额度…</p>
      <div class="table-wrap"><table class="quota-table"><thead><tr><th>项目</th><th>已使用</th><th>免费额度</th><th>使用比例</th></tr></thead><tbody>
        <tr v-for="row in quota?.rows || []" :key="row.id"><td>{{ row.name }}</td><td>{{ value(row, row.value) }}</td><td class="muted">{{ value(row, row.limit) }}{{ row.period === 'day' ? '/日' : '' }}</td><td class="quota-percent"><template v-if="row.value !== null">{{ number(row.value / row.limit * 100, 2) }}%<div class="meter" :class="usageClass(row.value / row.limit * 100)"><span :style="{ width: `${Math.min(100, row.value / row.limit * 100)}%` }"></span></div></template><span v-else class="muted">—</span></td></tr>
      </tbody></table></div>
    </section>
  </section>
</template>

<style scoped>
.settings-page{padding-top:24px}
.quota-panel .panel-heading{margin-bottom:12px}.quota-meta{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin-bottom:18px}.quota-table{min-width:560px}.quota-percent{width:25%;min-width:120px}
.settings-overview{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:20px;margin-bottom:20px}
.settings-overview .panel{margin:0;padding:22px 24px;min-width:0}
.settings-overview .panel-heading{margin-bottom:20px}
.interval-controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;align-items:end;gap:16px;width:100%}
.interval-controls label{display:grid;gap:8px;min-width:0;font-size:12px}
.interval-input{display:block;position:relative}
.interval-input input{height:40px;width:100%;min-width:0;padding:0 38px 0 12px;font-size:14px;line-height:normal;appearance:textfield;-moz-appearance:textfield}
.interval-input select{height:40px;width:100%;min-width:0;padding:0 12px;font-size:14px;line-height:normal}
.interval-input input::-webkit-inner-spin-button,.interval-input input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.interval-input>span{position:absolute;right:12px;top:0;line-height:40px;font-size:12px;color:var(--muted);pointer-events:none}
.interval-controls button{justify-self:end;height:40px;min-width:80px;padding:0 18px;white-space:nowrap;font-size:13px}
.network-facts{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;margin:0}
.network-facts>div{min-width:0}
.network-facts dt{font-size:12px;line-height:18px;color:var(--muted);margin-bottom:8px}
.network-facts dd{display:flex;align-items:center;gap:6px;min-height:40px;margin:0;font-size:18px;font-variant-numeric:tabular-nums}
.network-facts dd code{font-size:14px;overflow-wrap:anywhere}
.network-facts dd>span{font-size:12px;color:var(--muted)}
@media(max-width:1040px){.settings-overview{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.settings-page{padding-top:18px}.settings-overview{gap:16px;margin-bottom:16px}.settings-overview .panel{padding:18px}.interval-controls{gap:12px}.network-facts{gap:16px}}
@media(max-width:380px){.interval-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.interval-controls button{grid-column:1/-1}}
</style>
