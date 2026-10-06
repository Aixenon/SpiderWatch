<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { api, lists, loadState, notify, state, type Node } from "../monitor";
import { hasSession, onSessionInvalidated, sessionGeneration } from "../session";
import { createDeviceUpdate } from "../device-update";
import { groupLabel, statusClass, statusLabel } from "../format";
import { normalizeDeviceIcon } from "../../../public/device-icons.js";
import DeviceIconPicker from "./DeviceIconPicker.vue";
import DeviceIcon from "./DeviceIcon.vue";

const filters = lists.admin;
if (!["all", "pending", "online", "offline"].includes(filters.status)) filters.status = "all";
const deleteDialog = ref<HTMLDialogElement>(), deletingId = ref(""), deleteName = ref(""), deleteError = ref("");
const deleting = computed(() => state.nodes.find(node => node.node_id === deletingId.value));
const canDelete = computed(() => !!deleting.value && deleteName.value === deleting.value.name);
watch(() => deleting.value?.name, () => { deleteName.value = ""; deleteError.value = ""; if (!deleting.value) deleteDialog.value?.close(); });
const configDialog = ref<HTMLDialogElement>(), configuring = ref<Node>(), nickname = ref(""), configGroup = ref(""), configError = ref(""), configIcon = ref("server");
const configAutoUpdate = ref(false);
const configBusy = ref(false), deleteBusy = ref(false);
const update = createDeviceUpdate({
  start: api.checkUpdate, status: api.updateStatus,
  current: id => !!configDialog.value?.open && configuring.value?.node_id === id && state.nodes.some(node => node.node_id === id && node.state === "approved"),
  generation: sessionGeneration, authorized: hasSession, visible: () => !document.hidden,
  installed: () => { void loadState(true); },
});
const updateState = update.state, updateBusy = update.busy, updateMessage = update.message, updateFailed = update.failed, updateRemaining = update.remaining;
function clearConfig() { update.close(); configuring.value = undefined; }
watch(() => configuring.value && state.nodes.find(node => node.node_id === configuring.value?.node_id)?.state, membership => {
  if (configuring.value && membership !== "approved") { configDialog.value?.close(); clearConfig(); }
}, { flush: "sync" });
const removeSessionListener = onSessionInvalidated(() => { configDialog.value?.close(); clearConfig(); });
document.addEventListener("visibilitychange", update.visibilityChanged);
onBeforeUnmount(() => { update.close(); removeSessionListener(); document.removeEventListener("visibilitychange", update.visibilityChanged); });
const filtered = computed(() => state.nodes.filter(n => {
  const f = filters, q = f.query.trim().toLowerCase();
  return (!q || `${n.name} ${n.node_id} ${n.host.hostname}`.toLowerCase().includes(q))
    && (f.group === "all" || (f.group === "ungrouped" ? !n.group_id : n.group_id === f.group))
    && (f.status === "all" || (f.status === "pending" && n.state === "pending") || (f.status === "online" && n.state === "approved" && n.connected) || (f.status === "offline" && n.state === "approved" && !n.connected));
}).sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.node_id.localeCompare(b.node_id)));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / filters.size)));
const rows = computed(() => filtered.value.slice((filters.page - 1) * filters.size, filters.page * filters.size));
watch(() => [filters.query, filters.group, filters.status, filters.size], () => { filters.page = 1; });
watch(pages, value => { filters.page = Math.min(value, filters.page); });
watch(() => state.groups.map(group => group.id), ids => {
  if (configGroup.value && !ids.includes(configGroup.value)) configGroup.value = "";
  if (!["all", "ungrouped"].includes(filters.group) && !ids.includes(filters.group)) filters.group = "all";
});
function askDelete(node: Node) { deletingId.value = node.node_id; deleteName.value = ""; deleteError.value = ""; deleteDialog.value?.showModal(); }
function clearDelete() { deletingId.value = ""; deleteName.value = ""; deleteError.value = ""; }
function askConfig(node: Node) { configuring.value = node; configAutoUpdate.value = node.auto_update; nickname.value = node.nickname; configGroup.value = node.group_id || ""; configIcon.value = normalizeDeviceIcon(node.icon); configError.value = ""; configDialog.value?.showModal(); void update.open(node.node_id); }
async function saveConfig() {
  if (!configuring.value || configBusy.value) return;
  configBusy.value = true; configError.value = "";
  try { await api.configure(configuring.value.node_id, nickname.value, configGroup.value || null, configIcon.value, configAutoUpdate.value); configDialog.value?.close(); notify("设备配置已保存。"); }
  catch (error) { configError.value = (error as Error).message; }
  finally { configBusy.value = false; }
}
async function remove() {
  if (!canDelete.value || !deleting.value || deleteBusy.value) return;
  const node = deleting.value;
  deleteBusy.value = true; deleteError.value = "";
  try { await api.remove(node.node_id); deleteDialog.value?.close(); notify(`${node.name} 已删除。`); }
  catch (error) { deleteError.value = (error as Error).message; }
  finally { deleteBusy.value = false; }
}
function checkUpdate() { if (!configBusy.value) void update.start(); }
function openConfig(id: string) { const node = state.nodes.find(n => n.node_id === id && n.state === "approved"); if (node) askConfig(node); }
defineExpose({ openConfig });
function clearFilters() { Object.assign(filters, { query: "", group: "all", status: "all", page: 1 }); }
</script>

<template>
  <div class="device-list">
    <div class="list-toolbar">
      <label class="search-field"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><input v-model="filters.query" type="search" placeholder="搜索名称、设备 ID 或主机名" aria-label="搜索设备" /></label>
      <label class="sr-only" for="admin-group">查看分组</label><select id="admin-group" v-model="filters.group"><option value="all">全部分组</option><option value="ungrouped">未分组</option><option v-for="group in state.groups" :key="group.id" :value="group.id">{{ group.name }}</option></select>
      <label class="sr-only" for="admin-status">查看状态</label><select id="admin-status" v-model="filters.status"><option value="all">全部状态</option><option value="pending">待加入</option><option value="online">在线</option><option value="offline">离线</option></select>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>设备</th><th>分组</th><th>状态</th><th>设备 ID</th><th class="actions-col">操作</th></tr></thead>
        <tbody>
          <tr v-for="node in rows" :key="node.node_id">
            <td><div class="device-cell"><span class="device-cell-icon" aria-hidden="true"><DeviceIcon :name="node.icon" /></span><div class="device-cell-copy"><RouterLink v-if="node.state === 'approved'" :to="`/server/${node.node_id}`" class="device-name">{{ node.name }}</RouterLink><span v-else class="device-name">{{ node.name }}</span><small>{{ node.host.os }} · {{ node.host.arch }}</small></div></div></td>
            <td><span class="group-tag">{{ groupLabel(node.group_id) }}</span></td>
            <td><span class="status" :class="statusClass(node)"><i></i>{{ statusLabel(node) }}</span></td>
            <td><code :title="node.node_id">{{ node.node_id.slice(-12) }}</code></td><td class="actions-cell"><div class="row-actions"><button v-if="node.state === 'approved'" class="secondary small" @click="askConfig(node)">配置</button><button class="danger small" @click="askDelete(node)">删除</button></div></td>
          </tr>
        </tbody>
      </table>
      <div v-if="!rows.length" class="empty-state"><h3>没有符合条件的设备</h3><p>试试其他名称、分组或状态。</p><button class="secondary small" @click="clearFilters">清除筛选</button></div>
    </div>
    <div class="pagination"><span>共 {{ filtered.length }} 台<span v-if="filtered.length"> · 显示 {{ (filters.page - 1) * filters.size + 1 }}–{{ Math.min(filters.page * filters.size, filtered.length) }}</span></span><div><label>每页 <select v-model.number="filters.size" aria-label="每页设备数"><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option></select></label><button class="secondary small" :disabled="filters.page <= 1" @click="filters.page--">上一页</button><span class="page-number">{{ filters.page }} / {{ pages }}</span><button class="secondary small" :disabled="filters.page >= pages" @click="filters.page++">下一页</button></div></div>
    <dialog ref="configDialog" class="dialog device-config" aria-labelledby="device-config-heading" @cancel="event => { if (configBusy) event.preventDefault(); }" @close="clearConfig">
      <div class="dialog-heading"><h2 id="device-config-heading" tabindex="-1" autofocus>设备配置</h2><button type="button" class="button-quiet" aria-label="关闭设备配置" :disabled="configBusy" @click="configDialog?.close()">✕</button></div>
      <div class="device-config-scroll">
      <dl class="config-summary"><div><dt>设备 ID</dt><dd><code>{{ configuring?.node_id }}</code></dd></div><div><dt>客户端版本</dt><dd>{{ configuring?.host.agent_version || '未知' }}</dd></div></dl>
      <form id="device-config-form" class="device-config-fields" @submit.prevent="saveConfig">
        <label for="device-nickname">名字<input id="device-nickname" v-model="nickname" maxlength="128" :placeholder="configuring?.host.hostname" :disabled="configBusy" /></label>
        <label for="device-group">所属分组<select id="device-group" v-model="configGroup" :disabled="configBusy"><option value="">未分组</option><option v-for="group in state.groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label>
        <div class="device-update-row"><label class="update-toggle"><input v-model="configAutoUpdate" type="checkbox" :disabled="configBusy" />自动更新</label><button type="button" class="secondary small" :disabled="configBusy || updateBusy" @click="checkUpdate">检查更新</button></div>
        <p v-if="updateMessage" :class="updateFailed ? 'form-error' : 'hint'" role="status">{{ updateMessage }}<span v-if="updateRemaining"> · 剩余 {{ updateRemaining }}</span></p>
        <p v-if="updateState.error" class="form-error" role="alert">{{ updateState.error }}</p>
        <DeviceIconPicker v-model="configIcon" :disabled="configBusy" />
        <p v-if="configError" class="form-error" role="alert">{{ configError }}</p>
      </form>
      </div>
      <div class="dialog-actions"><button type="button" class="secondary" :disabled="configBusy" @click="configDialog?.close()">取消</button><button type="submit" form="device-config-form" :disabled="configBusy">{{ configBusy ? '保存中…' : '保存配置' }}</button></div>
    </dialog>
    <dialog ref="deleteDialog" class="dialog delete-device-dialog" aria-labelledby="delete-device-heading" aria-describedby="delete-device-effect" @close="clearDelete" @cancel="event => { if (deleteBusy) event.preventDefault(); }">
      <form @submit.prevent="remove">
        <div class="dialog-heading"><h2 id="delete-device-heading">删除设备</h2></div>
        <p id="delete-device-effect" class="muted">{{ deleting?.state === 'pending' ? '删除此设备的加入申请。' : '删除后撤销授权，重新加入需使用新邀请。' }}</p>
        <p class="delete-device-name"><strong>{{ deleting?.name }}</strong><small>设备 ID：{{ deleting?.node_id }}</small></p>
        <label for="delete-device-name">输入设备名称<input id="delete-device-name" v-model="deleteName" :disabled="deleteBusy" autofocus autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="delete-device-match" /></label>
        <p id="delete-device-match" class="hint">{{ deleteName && !canDelete ? '名称不匹配，请按上方名称输入。' : '名称须完全一致，包括大小写。' }}</p>
        <p v-if="deleteError" class="form-error" role="alert">{{ deleteError }}</p>
        <div class="dialog-actions"><button type="button" class="secondary" :disabled="deleteBusy" @click="deleteDialog?.close()">取消</button><button type="submit" class="danger-solid" :disabled="!canDelete || deleteBusy">{{ deleteBusy ? '删除中…' : '确认删除' }}</button></div>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.dialog.device-config{padding:0;max-width:min(680px,calc(100vw - 28px));max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow:hidden}
.dialog.device-config[open]{display:flex;flex-direction:column}
.device-config .dialog-heading{flex:none;margin:0;padding:16px 20px 12px}
.device-config-scroll{min-height:0;overflow-y:auto;padding:0 20px 18px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.config-summary{display:grid;grid-template-columns:minmax(0,1fr) minmax(90px,max-content);gap:20px;margin:0 0 16px;padding-bottom:14px;border-bottom:1px solid var(--line);font-size:12px}
.config-summary>div{min-width:0}
.config-summary dt{color:var(--muted);font-size:11px;margin-bottom:3px}
.config-summary dd{margin:0;overflow-wrap:anywhere}
.device-config-fields{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px;margin:0}
.device-config-fields>label{min-width:0;gap:6px}
.device-config-fields #device-nickname{margin:0}
.device-config-fields>.device-update-row,.device-config-fields>p,.device-config-fields>:deep(.device-icon-picker){grid-column:1 / -1}
.device-config-fields>p{margin:0;line-height:1.6}
.device-config .dialog-actions{flex:none;margin:0;padding:14px 20px;border-top:1px solid var(--line)}
@media(max-width:520px){
  .device-config .dialog-heading{padding:12px 16px 10px}
  .device-config-scroll{padding:0 16px 14px}
  .config-summary{grid-template-columns:minmax(0,1fr) 76px;gap:12px;margin-bottom:12px;padding-bottom:12px}
  .config-summary code{font-size:11px}
  .device-config-fields{gap:12px}
  .device-config .dialog-actions{padding:12px 16px}
}
.device-update-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:34px}
.device-update-row .update-toggle{display:flex;flex-direction:row;align-items:center;gap:8px;margin:0}
.update-toggle input{width:16px;height:16px;margin:0}
.delete-device-name { overflow-wrap:anywhere; margin:20px 0; }
.delete-device-name small { margin-top:6px; }
.delete-device-dialog label { display:grid; gap:8px; }
.delete-device-dialog input { width:100%; }
</style>
