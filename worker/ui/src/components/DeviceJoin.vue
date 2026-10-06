<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from "vue";
import { loadState, state } from "../monitor";
import { activeInvitation, checkInvitation, clearInvitation, createInvitation, type Invitation } from "../invitations";
const emit = defineEmits<{ registered: [id: string] }>();
const dialog = ref<HTMLDialogElement>(), attempt = ref<Invitation>(), now = ref(Date.now());
const copied = ref(false), message = ref(""), copyError = ref("");
const creating = ref(false), checking = ref(false), closed = ref(false);
let timer: ReturnType<typeof setInterval> | undefined, lastCheck = 0;
const valid = computed(() => !closed.value && attempt.value && activeInvitation(state.network, now.value)?.id === attempt.value.id);
const remaining = computed(() => {
  const seconds = Math.max(0, Math.ceil(((attempt.value?.expires_at || 0) - now.value) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
});
async function check(manual = false) {
  if (!dialog.value?.open || !attempt.value || checking.value || creating.value || closed.value) return;
  const id = attempt.value.id;
  checking.value = true; lastCheck = Date.now();
  try {
    const receipt = await checkInvitation(id);
    if (!dialog.value?.open || attempt.value?.id !== id) return;
    if (receipt.state === "registered" && receipt.node_id) {
      if (!await loadState(true)) throw new Error("无法读取设备配置，请再次检查。");
      if (!dialog.value?.open || attempt.value?.id !== id) return;
      if (!state.nodes.some(node => node.node_id === receipt.node_id && node.state === "approved")) throw new Error("设备已移除，请重新添加。");
      dialog.value.close(); clearInvitation(); attempt.value = undefined;
      emit("registered", receipt.node_id); return;
    }
    if (receipt.state === "closed") { closed.value = true; clearInvitation(); message.value = "指令已失效，请重新添加设备。"; }
    else if (manual) message.value = "设备尚未请求，请重试指令";
    copyError.value = "";
  } catch (error) {
    if (dialog.value?.open && attempt.value?.id === id) copyError.value = (error as Error).message;
  } finally { checking.value = false; }
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
onUnmounted(stopTimer);
async function open() {
  if (creating.value || checking.value || dialog.value?.open) return;
  now.value = Date.now(); copied.value = false; copyError.value = ""; message.value = "";
  await nextTick(); dialog.value?.showModal();
  stopTimer(); timer = setInterval(tick, 1000);
  if (attempt.value && !closed.value) { await check(); if (!dialog.value?.open) return; }
  creating.value = true;
  try {
    attempt.value = { ...await createInvitation(state.network) }; now.value = Date.now(); closed.value = false; lastCheck = now.value;
  } catch (error) { copyError.value = (error as Error).message; }
  finally { creating.value = false; }
}
async function copyCommand() {
  now.value = Date.now(); if (!valid.value || !attempt.value) return;
  try { await navigator.clipboard.writeText(attempt.value.command); copied.value = true; copyError.value = ""; }
  catch { copyError.value = "复制失败，请选中指令手动复制。"; }
}
defineExpose({ open });
</script>
<template>
  <dialog ref="dialog" class="dialog join-dialog" aria-labelledby="join-heading" @close="stopTimer">
    <div class="dialog-heading"><h2 id="join-heading">添加设备</h2><button type="button" class="button-quiet" aria-label="关闭添加设备" @click="dialog?.close()">✕</button></div>
    <p class="muted">在设备上执行指令即可加入。有效 5 分钟，仅限一台设备。</p>
    <div class="join-code"><code>{{ creating ? '正在生成指令…' : attempt?.command || '请关闭后重新添加设备。' }}</code></div>
    <p class="hint join-status"><span v-if="attempt">剩余 {{ remaining }}</span><span role="status">{{ message }}</span></p>
    <p v-if="copyError" class="form-error" role="alert">{{ copyError }}</p>
    <div class="dialog-actions"><button type="button" class="secondary" :disabled="creating || !valid" @click="copyCommand">{{ copied ? '已复制' : '复制' }}</button><button type="button" :disabled="creating || checking || !attempt || closed" @click="check(true)">{{ checking ? '检查中…' : '检查' }}</button></div>
  </dialog>
</template>
<style scoped>
.join-dialog .join-code{margin-top:20px}
.join-dialog code{white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}
.join-status{display:flex;flex-wrap:wrap;gap:8px 16px;font-variant-numeric:tabular-nums}
</style>
