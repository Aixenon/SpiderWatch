<script setup lang="ts">
import { computed, watch } from "vue";
import { lists, state } from "../monitor";
import DeviceCard from "../components/DeviceCard.vue";
import "../overview.css";

const filters = lists.overview;
const approved = computed(() => state.nodes.filter(node => node.state === "approved"));
const filtered = computed(() => {
  const query = filters.query.trim().toLowerCase();
  return approved.value.filter(node =>
    (!query || `${node.name} ${node.node_id} ${node.host.hostname}`.toLowerCase().includes(query))
    && (filters.group === "all" || (filters.group === "ungrouped" ? !node.group_id : node.group_id === filters.group))
    && (filters.status === "all" || (filters.status === "online" ? node.connected : !node.connected))
  ).sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.node_id.localeCompare(b.node_id));
});
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / filters.size)));
const cards = computed(() => filtered.value.slice((filters.page - 1) * filters.size, filters.page * filters.size));
watch(() => [filters.query, filters.group, filters.status, filters.size], () => { filters.page = 1; });
watch(pages, value => { filters.page = Math.min(value, filters.page); });
watch(() => state.groups.map(group => group.id), ids => {
  if (!["all", "ungrouped"].includes(filters.group) && !ids.includes(filters.group)) filters.group = "all";
});
function clearFilters() { Object.assign(filters, { query: "", group: "all", status: "all", page: 1 }); }
</script>

<template>
  <section class="device-overview" aria-labelledby="overview-heading">
    <h1 id="overview-heading" class="sr-only">设备总览</h1>
    <div class="list-toolbar overview-toolbar">
      <label class="search-field"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><input v-model="filters.query" type="search" placeholder="搜索设备" aria-label="搜索设备" /></label>
      <label class="sr-only" for="overview-group">查看分组</label>
      <select id="overview-group" v-model="filters.group"><option value="all">全部分组</option><option value="ungrouped">未分组</option><option v-for="group in state.groups" :key="group.id" :value="group.id">{{ group.name }}</option></select>
      <label class="sr-only" for="overview-status">查看状态</label>
      <select id="overview-status" v-model="filters.status"><option value="all">全部状态</option><option value="online">在线</option><option value="offline">离线</option></select>
      <span class="overview-device-count">{{ filtered.length }} 台设备</span>
    </div>
    <div v-if="cards.length" class="device-card-grid"><DeviceCard v-for="node in cards" :key="node.node_id" :node="node" /></div>
    <div v-else class="empty-state overview-empty"><h2>{{ approved.length ? '没有符合条件的设备' : '暂无已加入设备' }}</h2><p>{{ approved.length ? '试试其他名称、分组或状态。' : '加入设备后，它的运行状态会显示在这里。' }}</p><button v-if="approved.length" class="secondary small" @click="clearFilters">清除筛选</button><RouterLink v-else to="/admin" class="button secondary small">管理设备</RouterLink></div>
    <div v-if="filtered.length > filters.size" class="pagination overview-pagination"><span>共 {{ filtered.length }} 台 · 显示 {{ (filters.page - 1) * filters.size + 1 }}–{{ Math.min(filters.page * filters.size, filtered.length) }}</span><div><button class="secondary small" :disabled="filters.page <= 1" @click="filters.page--">上一页</button><span class="page-number">{{ filters.page }} / {{ pages }}</span><button class="secondary small" :disabled="filters.page >= pages" @click="filters.page++">下一页</button></div></div>
  </section>
</template>
