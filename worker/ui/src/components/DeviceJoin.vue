<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from "vue";
import { loadState, state } from "../monitor";
import { activeInvitation, checkInvitation, clearInvitation, createInvitation, type Invitation } from "../invitations";
import { installCommands } from "../install-commands";
const emit = defineEmits<{ registered: [id: string] }>();
const dialog = ref<HTMLDialogElement>(), attempt = ref<Invitation>(), now = ref(Date.now());
const copied = ref<"unix" | "installed" | "">(""), message = ref(""), copyError = ref("");
const creating = ref(false), manualChecking = ref(false), closed = ref(false);
const commands = computed(() => attempt.value ? installCommands(attempt.value, attempt.value.command.endsWith(" --allow-local-http")) : { windows: [] });
let timer: ReturnType<typeof setInterval> | undefined, lastCheck = 0;
let generation = 0, disposed = false;
type CheckTask = { id:string; generation:number; manual:boolean; promise:Promise<void> };
let pendingCheck: CheckTask | undefined;
const valid = computed(() => !closed.value && attempt.value && activeInvitation(state.network, now.value)?.id === attempt.value.id);
const remaining = computed(() => {
  const seconds = Math.max(0, Math.ceil(((attempt.value?.expires_at || 0) - now.value) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
});
function currentDialog(version:number) {
  return !disposed && version === generation && !!dialog.value?.open;
}
function currentCheck(task:CheckTask) {
  return currentDialog(task.generation) && attempt.value?.id === task.id && !closed.value;
}
function check(manual = false):Promise<void> {
  if (!dialog.value?.open || !attempt.value || creating.value || closed.value || disposed) return Promise.resolve();
  if (manual) { manualChecking.value = true; message.value = "正在检查…"; copyError.value = ""; }
  if (pendingCheck?.generation === generation && pendingCheck.id === attempt.value.id) {
    pendingCheck.manual ||= manual;
    return pendingCheck.promise;
  }
  const task:CheckTask = { id:attempt.value.id, generation, manual, promise:Promise.resolve() };
  pendingCheck = task; lastCheck = Date.now();
  task.promise = (async () => {
    try {
      const receipt = await checkInvitation(task.id);
      if (!currentCheck(task)) return;
      if (receipt.state === "registered" && receipt.node_id) {
        if (!await loadState(true)) throw new Error("无法读取设备配置，请再次检查。");
        if (!currentCheck(task)) return;
        if (!state.nodes.some(node => node.node_id === receipt.node_id && node.state === "approved")) throw new Error("设备已移除，请重新添加。");
        dialog.value!.close(); clearInvitation(); attempt.value = undefined;
        emit("registered", receipt.node_id); return;
      }
      if (receipt.state === "closed") { closed.value = true; clearInvitation(); message.value = "指令已失效，请重新添加设备。"; }
      else if (task.manual) message.value = "设备尚未请求，请重试指令";
      copyError.value = "";
    } catch (error) {
      if (currentCheck(task)) { copyError.value = (error as Error).message; if (task.manual) message.value = ""; }
    } finally {
      if (pendingCheck === task) pendingCheck = undefined;
      if (currentDialog(task.generation)) manualChecking.value = false;
    }
  })();
  return task.promise;
}
function tick() {
  if (!dialog.value?.open || document.hidden) return;
  now.value = Date.now();
  if (attempt.value && now.value > attempt.value.expires_at + 30_000) {
    closed.value = true; clearInvitation(); message.value = "指令已失效，请重新添加设备。";
  }
  if (attempt.value && !closed.value && now.value - lastCheck >= 2000) void check();
}
function stopTimer() { clearInterval(timer); timer = undefined; }
function close() {
  stopTimer(); generation++; pendingCheck = undefined; manualChecking.value = false; creating.value = false;
}
onUnmounted(() => { disposed = true; close(); });
async function open() {
  if (creating.value || dialog.value?.open || disposed) return;
  const version = ++generation;
  now.value = Date.now(); copied.value = ""; copyError.value = ""; message.value = "";
  await nextTick(); if (disposed || version !== generation) return;
  dialog.value?.showModal();
  stopTimer(); timer = setInterval(tick, 1000);
  if (attempt.value && !closed.value) { await check(); if (!currentDialog(version)) return; }
  creating.value = true;
  try {
    const invitation = await createInvitation(state.network);
    if (!currentDialog(version)) return;
    attempt.value = { ...invitation }; now.value = Date.now(); closed.value = false; lastCheck = now.value;
  } catch (error) { if (currentDialog(version)) copyError.value = (error as Error).message; }
  finally { if (currentDialog(version)) creating.value = false; }
}
async function copyCommand(kind: "unix" | "installed") {
  const command = kind === "unix" ? commands.value.unix : attempt.value?.command;
  now.value = Date.now(); if (!valid.value || !command) return;
  const version = generation;
  try { await navigator.clipboard.writeText(command); if (currentDialog(version)) { copied.value = kind; copyError.value = ""; } }
  catch { if (currentDialog(version)) copyError.value = "复制失败，请选中指令手动复制。"; }
}
defineExpose({ open });
</script>
<template>
  <dialog ref="dialog" class="dialog join-dialog" aria-labelledby="join-heading" @close="close">
    <div class="dialog-heading"><h2 id="join-heading">添加设备</h2><button type="button" class="button-quiet" aria-label="关闭添加设备" @click="dialog?.close()">✕</button></div>
    <div class="join-content">
    <p class="muted">在设备上执行指令即可加入。有效 5 分钟，仅限一台设备。</p>
    <section v-if="commands.windows.length" class="install-section">
      <div class="install-heading"><h3>Windows</h3><span class="muted">下载安装包</span></div>
      <div class="windows-downloads"><a v-for="asset in commands.windows" :key="asset.label" class="button secondary" :href="asset.url" target="_blank" rel="noopener noreferrer">{{ asset.label }} 下载</a></div>
    </section>
    <section v-if="commands.unix" class="install-section">
      <div class="install-heading"><h3>Linux / macOS <span class="muted">自动安装并加入</span></h3><button type="button" class="secondary small" :disabled="creating || !valid" @click="copyCommand('unix')">{{ copied === 'unix' ? '已复制' : '复制' }}</button></div>
      <div class="join-code install-code"><code>{{ commands.unix }}</code></div>
    </section>
    <section class="install-section">
      <div class="install-heading"><h3>安装后加入</h3><button type="button" class="secondary small" :disabled="creating || !valid" @click="copyCommand('installed')">{{ copied === 'installed' ? '已复制' : '复制' }}</button></div>
      <p class="muted install-hint">Windows 安装后在管理员终端执行；已安装客户端也可使用。</p>
      <div class="join-code"><code>{{ creating ? '正在生成指令…' : attempt?.command || '请关闭后重新添加设备。' }}</code></div>
    </section>
    </div>
    <p class="hint join-status"><span v-if="attempt">剩余 {{ remaining }}</span><span role="status">{{ message }}</span></p>
    <p v-if="copyError" class="form-error" role="alert">{{ copyError }}</p>
    <div class="dialog-actions"><button type="button" :disabled="creating || manualChecking || !attempt || closed" :aria-busy="manualChecking" @click="check(true)">检查</button></div>
  </dialog>
</template>
<style scoped>
.join-dialog[open]{display:flex;flex-direction:column;overflow:hidden}
.join-dialog .dialog-heading,.join-status,.dialog-actions{flex-shrink:0}
.join-content{min-height:0;overflow:auto;overscroll-behavior:contain;padding-right:4px}
.join-content>p{font-size:12px;line-height:1.8;margin:0}
.install-section{margin-top:20px}
.install-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;min-height:30px}
.install-heading h3{font-size:13px;font-weight:600;margin:0}
.install-heading span,.install-hint{font-size:11px}
.windows-downloads{display:flex;flex-wrap:wrap;gap:10px}
.install-hint{margin:0 0 10px;line-height:1.7}
.join-dialog .join-code{align-items:flex-start;overflow:auto;margin-top:0}
.join-dialog .install-code{max-height:140px}
.join-dialog code{white-space:pre-wrap;overflow-wrap:anywhere;user-select:all;line-height:1.7}
.dialog-actions button{min-width:76px}
.join-dialog .dialog-actions{margin-top:6px}
.join-status{display:flex;flex-wrap:wrap;gap:8px 16px;font-variant-numeric:tabular-nums}
</style>
