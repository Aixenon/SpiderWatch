<script setup lang="ts">
import { nextTick, ref } from "vue";
import { state } from "../monitor";
import DeviceJoin from "../components/DeviceJoin.vue";
import DeviceList from "../components/DeviceList.vue";
import GroupManager from "../components/GroupManager.vue";

const groupDialog = ref<HTMLDialogElement>(), groupsOpen = ref(false);
const deviceList = ref<InstanceType<typeof DeviceList>>();
const deviceJoin = ref<InstanceType<typeof DeviceJoin>>();
async function openGroups() { groupsOpen.value = true; await nextTick(); groupDialog.value?.showModal(); }
</script>

<template>
  <section class="admin-page">
    <section class="panel">
      <div class="panel-heading"><h2>设备管理 <span class="count-label">{{ state.nodes.length }}</span></h2><div class="row-actions"><button type="button" class="secondary small" @click="openGroups">管理分组</button><button type="button" class="small" @click="deviceJoin?.open()">添加设备</button></div></div>
      <DeviceJoin ref="deviceJoin" @registered="id => deviceList?.openConfig(id)" />
      <DeviceList ref="deviceList" />
    </section>
    <dialog ref="groupDialog" class="dialog group-manager-dialog" aria-labelledby="group-manager-heading" @close="groupsOpen = false">
      <div class="dialog-heading"><h2 id="group-manager-heading">管理分组</h2><button type="button" class="button-quiet" aria-label="关闭分组管理" @click="groupDialog?.close()">✕</button></div>
      <GroupManager v-if="groupsOpen" />
      <div class="dialog-actions"><button type="button" class="secondary" @click="groupDialog?.close()">完成</button></div>
    </dialog>
  </section>
</template>

<style scoped>
.admin-page{padding-top:24px}
@media(max-width:600px){.admin-page{padding-top:18px}}
</style>
