<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useRoute } from "vue-router";
import { historyStatus, loadHistory, resourcePoints, state } from "../monitor";
import { bytes, cpuCoreCounts, groupLabel, number, statusLabel, time, uptime, usageClass } from "../format";
import { cpuDetails, memoryDetails, diskGroups, volumeName, diskSummary } from "../../../public/metrics.js";
import { CHART_RANGES, DEFAULT_CHART_SECONDS } from "../../../public/resource-charts.js";
import ResourceChart from "../components/ResourceChart.vue";
import DeviceIcon from "../components/DeviceIcon.vue";

const route = useRoute();
const node = computed(() => state.nodes.find(n => n.node_id === route.params.id && n.state === "approved"));
const cores = computed(() => node.value ? cpuCoreCounts(node.value.host) : { physical: "未知", logical: "未知" });
const disks = computed(() => diskGroups(node.value?.metrics));
const totalDisk = computed(() => diskSummary(node.value?.metrics));
const points = computed(() => node.value ? resourcePoints(node.value.node_id) : []);
const history = computed(() => node.value ? historyStatus(node.value.node_id) : { loading:false, error:"" });
const chartRanges = reactive<Record<string, number>>({});
const chartSeconds = computed(() => Math.max(DEFAULT_CHART_SECONDS, ...Object.values(chartRanges)));
const chartEnd = computed(() => Math.max(node.value?.last_seen || 0, points.value.at(-1)?.time || 0) || undefined);
const percentPoints = computed(() => points.value.map(point => ({time:point.time,cpu:point.cpu,memory:point.memory})));
const networkCards = computed(() => (node.value?.metrics.networks || []).map(nic => ({
  ...nic, points:points.value.map(point => ({time:point.time,rx:point.networks?.[nic.name]?.rx,tx:point.networks?.[nic.name]?.tx})),
})));
const display = (value: number|null|undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? bytes(value) : '不可用';
const percent = (value: number|null|undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${number(value)}%` : '不可用';
function changeRange(key:string, seconds:number) {
  if (!CHART_RANGES.some(range => range.seconds === seconds)) return;
  chartRanges[key] = seconds;
  if (node.value) void loadHistory(node.value.node_id, chartSeconds.value, !!history.value.error);
}
function retryHistory() {
  if (node.value) void loadHistory(node.value.node_id, chartSeconds.value, true);
}
watch(() => node.value?.node_id, () => {
  for (const key of Object.keys(chartRanges)) delete chartRanges[key];
  if (!node.value) return;
  void loadHistory(node.value.node_id, DEFAULT_CHART_SECONDS);
}, { immediate:true });
</script>

<template>
  <section v-if="node" class="resource-detail compact-resources">
    <RouterLink to="/" class="back-link">← 返回总览</RouterLink>
    <div class="page-heading resource-heading">
      <div class="resource-identity"><span class="resource-device-icon"><DeviceIcon :name="node.icon"/></span><div><h1>{{ node.name }}</h1><p class="muted">{{ groupLabel(node.group_id) }} · {{ node.host.os || '不可用' }} / {{ node.host.arch || '不可用' }}</p></div></div>
      <div class="detail-actions"><span class="status" :class="node.connected ? 'online' : 'offline'"><i></i>{{ statusLabel(node) }}</span></div>
    </div>
    <div v-if="!node.connected" class="inline-notice"><span>设备已离线，保留最后收到的数据。</span><span>最后在线 {{ time(node.last_seen) }}</span></div>
    <div v-if="history.error" class="inline-notice" role="status"><span>{{ history.error }}</span><button class="secondary small" :disabled="history.loading" @click="retryHistory">重试</button></div>

    <div class="resource-top-grid">
      <section class="panel resource-panel">
        <div class="panel-heading processor-heading"><h2 class="processor-title"><span>处理器</span><span v-if="node.host.cpu_model" class="cpu-model">{{ node.host.cpu_model }}</span></h2><strong class="resource-current">{{ percent(node.metrics.cpu_percent) }}</strong></div>
        <ResourceChart :key="`${node.node_id}:cpu`" title="处理器使用率" :points="percentPoints" :end-time="chartEnd" :lines="[{key:'cpu',color:'var(--resource-cpu)'}]" :maximum="100" @range-change="changeRange('cpu', $event)"/>
        <dl class="compact-facts cpu-facts">
          <div><dt>物理核心</dt><dd>{{ cores.physical }}</dd></div>
          <div><dt>逻辑核心</dt><dd>{{ cores.logical }}</dd></div>
          <div v-for="row in cpuDetails(node.metrics).slice(1)" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ percent(row.value) }}</dd></div>
        </dl>
      </section>

      <section class="panel resource-panel">
        <div class="panel-heading"><h2>内存</h2><strong class="resource-current">{{ display(node.metrics.memory?.used_bytes) }} <span>/ {{ display(node.metrics.memory?.total_bytes) }}</span></strong></div>
        <ResourceChart :key="`${node.node_id}:memory`" title="内存使用率" :points="percentPoints" :end-time="chartEnd" :lines="[{key:'memory',color:'var(--resource-memory)'}]" :maximum="100" @range-change="changeRange('memory', $event)"/>
        <dl class="compact-facts"><div v-for="row in memoryDetails(node.metrics.memory).slice(1)" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ display(row.value) }}<template v-if="row.total !== undefined"> / {{ display(row.total) }}</template></dd></div></dl>
      </section>
    </div>

    <section class="panel resource-panel">
      <div class="panel-heading"><h2>网络</h2><span class="subtle-label">{{ networkCards.length }} 张网卡</span></div>
      <div class="nic-grid">
        <article v-for="nic in networkCards" :key="nic.name" class="nic-card">
          <div class="nic-heading"><h3>{{ nic.name }}</h3><div class="network-legend"><span class="network-rx"><i aria-hidden="true"></i>↓ 接收 {{ node.connected ? display(nic.rx_bytes_per_second) + '/s' : '—' }}</span><span class="network-tx"><i aria-hidden="true"></i>↑ 发送 {{ node.connected ? display(nic.tx_bytes_per_second) + '/s' : '—' }}</span></div></div>
          <ResourceChart :key="`${node.node_id}:network:${nic.name}`" :title="`${nic.name} 上下行速率`" :points="nic.points" :end-time="chartEnd" :lines="[{key:'rx',color:'var(--resource-rx)'},{key:'tx',color:'var(--resource-tx)'}]" unit="bytes" @range-change="changeRange(`network:${nic.name}`, $event)"/>
          <dl class="nic-totals"><div><dt>累计接收</dt><dd>{{ display(nic.rx_bytes) }}</dd></div><div><dt>累计发送</dt><dd>{{ display(nic.tx_bytes) }}</dd></div></dl>
        </article>
      </div>
      <p v-if="!networkCards.length" class="muted resource-empty">暂无网卡数据</p>
    </section>

    <section class="panel resource-panel">
      <div class="panel-heading"><h2>磁盘</h2><span v-if="totalDisk" class="subtle-label">逻辑卷已用 {{ display(totalDisk.used_bytes) }} / {{ display(totalDisk.total_bytes) }}</span></div>
      <div class="physical-disks">
        <details v-for="disk in disks" :key="disk.id" class="physical-disk">
          <summary><span class="disk-chevron" aria-hidden="true">›</span><svg class="disk-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 15h18M7 17.5h.01M10 17.5h.01M7 8h10"/></svg><span class="disk-heading"><strong>{{ disk.kind === 'physical' ? disk.name : '未识别物理归属' }}</strong><span>{{ disk.volumes.length }} 个逻辑卷</span></span><span class="disk-capacity">{{ disk.kind === 'physical' && disk.size_bytes !== undefined ? display(disk.size_bytes) : '—' }}</span></summary>
          <div class="table-wrap"><table class="resource-table volume-table"><thead><tr><th>逻辑卷</th><th>文件系统</th><th>已用 / 总计</th><th>可用</th><th>使用率</th></tr></thead><tbody>
            <tr v-for="volume in disk.volumes" :key="volume.volume_id || volume.device || volume.mount"><td><strong>{{ volumeName(volume) }}</strong><small v-if="volume.mount">{{ volume.mount }}<template v-if="volume.capacity_group"> · 共享存储池</template></small></td><td>{{ volume.filesystem || '—' }}</td><td>{{ display(volume.used_bytes) }} / {{ display(volume.total_bytes) }}</td><td>{{ display(volume.available_bytes) }}</td><td><div class="volume-usage"><span>{{ volume.total_bytes ? percent(volume.used_bytes / volume.total_bytes * 100) : '—' }}</span><div class="meter" :class="usageClass(node.connected && volume.total_bytes ? volume.used_bytes / volume.total_bytes * 100 : null)"><span :style="{width:`${volume.total_bytes ? Math.min(100,volume.used_bytes/volume.total_bytes*100):0}%`}"></span></div></div></td></tr>
          </tbody></table></div>
        </details>
      </div>
      <p v-if="!disks.length" class="muted resource-empty">暂无可读取的磁盘</p>
    </section>

    <section class="panel resource-panel">
      <div class="panel-heading"><h2>系统信息</h2></div>
      <dl class="compact-facts system-facts">
        <div><dt>主机名</dt><dd>{{ node.host.hostname || '不可用' }}</dd></div>
        <div><dt>操作系统</dt><dd>{{ node.host.os || '不可用' }}</dd></div>
        <div><dt>架构</dt><dd>{{ node.host.arch || '不可用' }}</dd></div>
        <div><dt>CPU 型号</dt><dd>{{ node.host.cpu_model || '不可用' }}</dd></div>
        <div><dt>内核</dt><dd>{{ node.host.kernel || '不可用' }}</dd></div>
        <div><dt>总内存</dt><dd>{{ display(node.metrics.memory?.total_bytes) }}</dd></div>
        <div><dt>总存储容量</dt><dd>{{ display(totalDisk?.total_bytes) }}</dd></div>
        <div><dt>运行时间</dt><dd>{{ uptime(node.metrics.uptime_seconds) }}</dd></div>
        <div><dt>客户端版本</dt><dd>{{ node.host.agent_version || '不可用' }}</dd></div>
        <div v-if="node.host.ip"><dt>IP 地址</dt><dd>{{ node.host.ip }}</dd></div>
        <div class="system-device-id"><dt>设备 ID</dt><dd>{{ node.node_id }}</dd></div>
      </dl>
    </section>
  </section>
  <section v-else class="panel empty-state"><h1>设备暂不可查看</h1><RouterLink to="/" class="button secondary">返回总览</RouterLink></section>
</template>
