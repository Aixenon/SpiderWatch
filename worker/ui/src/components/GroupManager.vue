<script setup lang="ts">
import { ref } from "vue";
import { api, notify, state } from "../monitor";

const name = ref(""), editing = ref(""), editName = ref(""), deleting = ref(""), error = ref("");
const busy = ref(false);
async function apply(action: () => Promise<void>, message: string) {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try { await action(); notify(message); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
function create() { return apply(async () => { await api.createGroup(name.value); name.value = ""; }, "分组已创建。"); }
function rename() { return apply(async () => { await api.renameGroup(editing.value, editName.value); editing.value = ""; }, "分组已重命名。"); }
function remove(id: string) { return apply(async () => { await api.removeGroup(id); deleting.value = ""; }, "分组已删除。"); }
</script>

<template>
  <section class="group-manager" aria-label="分组列表">
    <form class="group-create" @submit.prevent="create"><label class="sr-only" for="new-group-name">新分组名称</label><input id="new-group-name" v-model="name" maxlength="64" placeholder="例如：机房 A" :disabled="busy" required /><button type="submit" :disabled="busy">创建分组</button></form>
    <div class="group-rows">
      <div v-for="group in state.groups" :key="group.id" class="group-row">
        <form v-if="editing === group.id" class="group-create" @submit.prevent="rename"><label class="sr-only" :for="`rename-${group.id}`">新的分组名称</label><input :id="`rename-${group.id}`" v-model="editName" maxlength="64" :disabled="busy" required /><button type="submit" class="small" :disabled="busy">保存名称</button><button type="button" class="button-quiet small" :disabled="busy" @click="editing = ''">取消</button></form>
        <template v-else><div><strong>{{ group.name }}</strong><small>{{ state.nodes.filter(n => n.group_id === group.id).length }} 台设备</small></div><div class="row-actions"><button class="secondary small" :disabled="busy" :aria-label="`重命名 ${group.name}`" @click="editing = group.id; editName = group.name; deleting = ''">重命名</button><button class="danger small" :disabled="busy" :aria-label="`删除分组 ${group.name}`" @click="deleting = group.id">删除分组</button></div></template>
        <div v-if="deleting === group.id" class="group-confirm"><p>删除“{{ group.name }}”？设备将移至未分组。</p><div class="row-actions"><button class="secondary small" :disabled="busy" @click="deleting = ''">取消</button><button class="danger-solid small" :disabled="busy" @click="remove(group.id)">确认删除分组</button></div></div>
      </div>
      <p v-if="!state.groups.length" class="muted">暂无分组，可在上方创建。</p>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>
