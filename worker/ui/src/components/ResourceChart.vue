<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { chartGeometry, CHART_RANGES, DEFAULT_CHART_SECONDS } from '../../../public/resource-charts.js';
import { bytes, number } from '../format';

const props = defineProps<{
  title:string;
  points:{time:number;[key:string]:number|null|undefined}[];
  lines:{key:string;color:string}[];
  maximum?:number;
  unit?:'bytes';
  endTime?:number;
}>();
const emit = defineEmits<{ 'range-change':[seconds:number] }>();
const rangeID = `chart-range-${useId()}`;
const rangeSeconds = ref(DEFAULT_CHART_SECONDS);
watch(rangeSeconds, seconds => emit('range-change', seconds));
const geometry = computed(() => chartGeometry(props.points,props.lines.map(line => line.key),props.maximum,rangeSeconds.value*1000,props.endTime));
const label = (value:number) => props.unit === 'bytes' ? bytes(value).replace(/iB|B/g,'').replace(' ','') : `${number(value)}%`;
const dateFormat = computed(() => new Intl.DateTimeFormat('zh-CN',{
  hour12:false,hour:'2-digit',minute:'2-digit',
  ...(rangeSeconds.value<3600?{second:'2-digit' as const}:{}),
  ...(rangeSeconds.value>=86400?{month:'2-digit' as const,day:'2-digit' as const}:{}),
}));
const axisLabels = computed(() => geometry.value.count ? [geometry.value.first,(geometry.value.first+geometry.value.last)/2,geometry.value.last].map(value=>dateFormat.value.format(value)) : ['等待采样','','']);
</script>

<template>
  <div class="resource-chart-controls">
    <label :for="rangeID" class="sr-only">{{ title }}时间范围</label>
    <select :id="rangeID" v-model.number="rangeSeconds"><option v-for="range in CHART_RANGES" :key="range.seconds" :value="range.seconds">{{ range.label }}</option></select>
  </div>
  <div class="resource-chart">
    <div class="resource-chart-plot">
      <span v-for="tick in geometry.ticks" :key="tick.value" class="resource-chart-tick" :style="{top:`${tick.y}%`}">{{ label(tick.value) }}</span>
      <svg viewBox="40 0 592 100" preserveAspectRatio="none" role="img" :aria-label="title">
        <line v-for="tick in geometry.ticks" :key="tick.value" x1="40" x2="632" :y1="tick.y" :y2="tick.y" class="resource-grid-line"/>
        <g v-for="line in geometry.series" :key="line.key">
          <path :d="line.path" fill="none" :stroke="lines.find(item => item.key===line.key)?.color" :stroke-dasharray="line.key==='tx'?'5 4':undefined" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
          <circle v-for="(marker,index) in line.markers" :key="index" :cx="marker.x" :cy="marker.y" r="2.2" :fill="lines.find(item => item.key===line.key)?.color"/>
        </g>
      </svg>
    </div>
    <div class="resource-chart-time"><span v-for="(value,index) in axisLabels" :key="index">{{ value }}</span></div>
  </div>
</template>

<style scoped>
.resource-chart-controls{display:flex;justify-content:flex-end;align-items:center;height:28px;margin-bottom:4px}
.resource-chart-controls select{height:28px;min-height:28px;min-width:94px;width:auto;padding:3px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel);color:var(--ink);font-size:12px;line-height:20px}
</style>
