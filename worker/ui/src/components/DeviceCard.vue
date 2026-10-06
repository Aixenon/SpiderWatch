<script setup lang="ts">
import { computed } from "vue";
import { type Node } from "../monitor";
import { bytes, cpuCoreCounts, groupLabel, number, time, usageClass } from "../format";
import { diskSummary } from "../../../public/metrics.js";
import DeviceIcon from "./DeviceIcon.vue";

const props = defineProps<{ node: Node }>();
const hasReport = computed(() => props.node.last_seen > 0);
const live = computed(() => props.node.connected && hasReport.value);
const physicalCores = computed(() => cpuCoreCounts(props.node.host).physical);
const coreLabel = computed(() => physicalCores.value === "未知" ? "物理核心未知" : `${physicalCores.value} 物理核`);
const valid = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const percent = (used: number | null | undefined, total: number | null | undefined) => valid(used) && valid(total) && total > 0 ? used / total * 100 : null;
const resources = computed(() => {
  const metrics = props.node.metrics, memory = metrics?.memory, disk = diskSummary(metrics);
  return [
    { label: "CPU", value: live.value && valid(metrics?.cpu_percent) ? metrics.cpu_percent : null, detail: coreLabel.value, tone: "cpu" },
    { label: "内存", value: live.value ? percent(memory?.used_bytes, memory?.total_bytes) : null, detail: live.value && valid(memory?.used_bytes) && valid(memory?.total_bytes) && memory.total_bytes > 0 ? `${bytes(memory.used_bytes)} / ${bytes(memory.total_bytes)}` : "", tone: "memory" },
    { label: "磁盘", value: live.value ? percent(disk?.used_bytes, disk?.total_bytes) : null, detail: live.value && disk && valid(disk.used_bytes) && valid(disk.total_bytes) && disk.total_bytes > 0 ? `全部卷 · ${bytes(disk.used_bytes)} / ${bytes(disk.total_bytes)}` : "", tone: "disk" },
  ];
});
function rate(field: "rx_bytes_per_second" | "tx_bytes_per_second") {
  if (!live.value) return "—";
  const interfaces = props.node.metrics?.networks?.filter(network => valid(network[field]));
  return interfaces?.length ? `${bytes(interfaces.reduce((sum, network) => sum + (network[field] ?? 0), 0))}/s` : "—";
}
</script>

<template>
  <RouterLink :to="`/server/${node.node_id}`" class="device-card" :class="{ 'device-card-offline': !node.connected, 'device-card-degraded': node.connected && node.degraded }" :aria-label="`查看 ${node.name} 的详情，${node.connected ? '在线' : '离线'}`">
    <div class="device-card-heading"><div class="device-card-identity"><span class="device-card-icon" aria-hidden="true"><DeviceIcon :name="node.icon" /></span><span class="device-card-system" :title="`${node.host.os} · ${node.host.arch}`">{{ node.host.os }} · {{ node.host.arch }}</span></div><span v-if="!hasReport" class="device-card-status is-pending"><i></i>待上报</span></div>
    <h2 :title="node.name">{{ node.name }}</h2>
    <div class="device-card-group"><span :title="groupLabel(node.group_id)">{{ groupLabel(node.group_id) }}</span><span>{{ coreLabel }}</span></div>
    <div class="device-card-resources"><div v-for="resource in resources" :key="resource.label" class="device-card-resource" :class="[resource.tone, usageClass(resource.value)]" :title="resource.detail"><div><span>{{ resource.label }}</span><strong>{{ resource.value === null ? '—' : number(resource.value) }}<small v-if="resource.value !== null">%</small></strong></div><div class="device-card-meter" aria-hidden="true"><span v-if="resource.value !== null" :style="{ width: `${Math.min(100, resource.value)}%` }"></span></div></div></div>
    <div class="device-card-network"><div><span><i aria-hidden="true">↓</i> 接收</span><strong>{{ rate('rx_bytes_per_second') }}</strong></div><div><span><i aria-hidden="true">↑</i> 发送</span><strong>{{ rate('tx_bytes_per_second') }}</strong></div></div>
    <div class="device-card-footer"><span :title="hasReport ? new Date(node.last_seen).toLocaleString('zh-CN', { hour12: false }) : undefined">{{ !hasReport ? '等待首次上报' : node.connected ? `更新于 ${time(node.last_seen)}` : `最后在线 ${time(node.last_seen)}` }}</span><span aria-hidden="true">详情 <span>↗</span></span></div>
  </RouterLink>
</template>
