// Shared geometry for bounded live samples and the existing persisted history.
export const HISTORY_POINTS = 120;
export const DEFAULT_CHART_SECONDS = 300;
export const CHART_RANGES = [{seconds:60,label:"1 分钟"},{seconds:300,label:"5 分钟"},{seconds:1800,label:"30 分钟"},{seconds:3600,label:"1 小时"},{seconds:86400,label:"24 小时"},{seconds:604800,label:"7 天"}];
const valid = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function chartGeometry(input = [], keys = [], fixedMaximum, windowMs, endTime) {
  const samples = input.filter(p => p && Number.isFinite(p.time)).sort((a,b)=>a.time-b.time);
  const windowed = valid(windowMs) && windowMs > 0;
  const last = valid(endTime) ? endTime : (samples.at(-1)?.time ?? 0);
  const first = windowed ? last-windowMs : (samples.slice(-HISTORY_POINTS)[0]?.time ?? last);
  const points = windowed ? samples.filter(p=>p.time>=first&&p.time<=last) : samples.slice(-HISTORY_POINTS);
  const values = points.flatMap(p => keys.map(key => p[key]).filter(valid));
  const observed = values.length ? Math.max(...values) : 0;
  const maximum = valid(fixedMaximum) && fixedMaximum > 0 ? fixedMaximum : Math.max(1024, observed * 1.1);
  const span = Math.max(1, last - first);
  const series = keys.map(key => {
    let path = "", connected = false, segmentLength = 0, lastPosition;
    const markers = [];
    const endSegment = () => { if(segmentLength===1)markers.push(lastPosition);segmentLength=0; };
    for (const point of points) {
      if (!valid(point[key])) { endSegment();connected = false; continue; }
      const x = !windowed && points.length === 1 ? 632 : 40 + (point.time - first) / span * 592;
      const y = 88 - Math.min(maximum, point[key]) / maximum * 80;
      path += `${connected ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
      connected = true;segmentLength++;lastPosition={x,y};
    }
    endSegment();
    return {key, path:path.trim(),markers};
  });
  return {series, maximum, ticks:[{value:maximum,y:8},{value:maximum/2,y:48},{value:0,y:88}], first,last,count:points.length};
}
export function mergeResourceHistory(stored = [], live = [], idleSeconds = 600) {
  // Browser samples are denser and retain their explicit reconnection gaps.
  const first=live[0]?.time ?? Infinity,last=live.at(-1)?.time ?? -Infinity;
  const history=stored.filter(p=>p.time<first||p.time>last);
  const points=[];
  for(const point of [...history,...live].sort((a,b)=>a.time-b.time)){
    const previous=points.at(-1);
    if(previous&&point.time<=previous.time)continue;
    const interval=p=>valid(p?.interval_seconds)&&p.interval_seconds>0?p.interval_seconds:Math.max(1,idleSeconds);
    if(previous&&point.time-previous.time>Math.max(interval(previous),interval(point))*2500)points.push({time:previous.time+1,cpu:null,memory:null,networks:{}});
    points.push(point);
  }
  return points;
}
export function recordSample(history, node, expectedSeconds = 5) {
  const metrics = node.metrics || {}, sampleTime = Date.parse(metrics.time || "");
  // Server receipt time survives device reboots and wall-clock adjustments.
  // The same report keeps its receipt time when replayed in a state snapshot.
  const time = valid(node.last_seen) && node.last_seen > 0 ? node.last_seen : sampleTime;
  if (!node.connected || !Number.isFinite(sampleTime) || !Number.isFinite(time)) return;
  let points = history.get(node.node_id);
  if (!points) { points=[]; history.set(node.node_id, points); }
  const previous = points.at(-1);
  if (previous && time <= previous.time) return;
  // A reconnection or background pause is a gap, never a fabricated flat line.
  if (previous && time - previous.time > Math.max(1,expectedSeconds) * 2500) points.push({time:previous.time+1,cpu:null,memory:null,networks:{}});
  const networks = Object.create(null);
  for (const nic of Array.isArray(metrics.networks) ? metrics.networks.slice(0,16) : []) {
    if (!nic || typeof nic.name !== "string") continue;
    networks[nic.name] = {rx:valid(nic.rx_bytes_per_second)?nic.rx_bytes_per_second:null,tx:valid(nic.tx_bytes_per_second)?nic.tx_bytes_per_second:null};
  }
  const memory = metrics.memory;
  points.push({time,interval_seconds:Math.max(1,expectedSeconds),cpu:valid(metrics.cpu_percent)?metrics.cpu_percent:null,
    memory:memory && valid(memory.used_bytes) && valid(memory.total_bytes) && memory.total_bytes > 0 ? memory.used_bytes/memory.total_bytes*100 : null,networks});
  if (points.length > HISTORY_POINTS) points.splice(0, points.length-HISTORY_POINTS);
}
