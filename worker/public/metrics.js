// Shared by the production panel and the private preview.
const known = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function volumes(metrics = {}) {
  const unique = new Map();
  for (const disk of Array.isArray(metrics.disks) ? metrics.disks : []) {
    if (!disk || typeof disk !== "object" || !known(disk.total_bytes) || !known(disk.used_bytes) || disk.used_bytes > disk.total_bytes) continue;
    const id = disk.volume_id || disk.device || disk.mount;
    if (typeof id !== "string" || unique.has(id)) continue;
    unique.set(id, disk);
  }
  return [...unique.values()];
}
export function diskSummary(metrics = {}) {
  const pools = new Map();
  const rows = volumes(metrics);
  for (const disk of rows) {
    const id = disk.capacity_group ? `pool:${disk.capacity_group}` : `volume:${disk.volume_id || disk.device || disk.mount}`;
    const old = pools.get(id);
    const hasPool = disk.capacity_group && known(disk.pool_total_bytes) && known(disk.pool_available_bytes) && disk.pool_available_bytes <= disk.pool_total_bytes;
    const value = hasPool ? {total_bytes:disk.pool_total_bytes,used_bytes:disk.pool_total_bytes-disk.pool_available_bytes}
      : {total_bytes:disk.total_bytes,used_bytes:disk.capacity_group ? null : disk.used_bytes};
    // Per-volume APFS usage is not container usage. Keep old-client pool usage
    // unavailable until explicit container counters arrive, rather than guess.
    if (!old || (old.used_bytes === null && hasPool)) pools.set(id,value);
    else if (old.used_bytes === null) old.total_bytes = Math.max(old.total_bytes,value.total_bytes);
  }
  if (!rows.length) return null;
  return [...pools.values()].reduce((sum, disk) => ({total_bytes: sum.total_bytes + disk.total_bytes, used_bytes: sum.used_bytes === null || disk.used_bytes === null ? null : sum.used_bytes + disk.used_bytes}), {total_bytes:0, used_bytes:0});
}
export function volumeName(disk) {
  const device = disk.device || disk.mount || "逻辑卷";
  return disk.label ? `${disk.label} · ${device}` : device;
}
// Membership comes from the OS, never from drive letters or partition-name guesses.
// A spanned logical volume can occur under several parents; only diskSummary
// calculates global volume capacity, so this hierarchy never multiplies it.
export function diskGroups(metrics = {}) {
  const groups = new Map();
  for (const volume of volumes(metrics)) {
    const parents = Array.isArray(volume.physical_disks) ? volume.physical_disks.filter(d => d && typeof d.id === "string" && d.id && typeof d.name === "string") : [];
    const unique = new Map(parents.map(d => [d.id, d]));
    if (!unique.size) unique.set("unmapped", {id:"unmapped", name:"未识别物理归属"});
    for (const [id, parent] of unique) {
      const key = parents.length ? `physical:${id}` : "unmapped";
      let group = groups.get(key);
      if (!group) {
        group = {id:key, name:parent.name, kind:parents.length ? "physical" : "unmapped", volumes:[], summary:null};
        if (known(parent.size_bytes) && parent.size_bytes > 0) group.size_bytes = parent.size_bytes;
        groups.set(key, group);
      }
      group.volumes.push(volume);
    }
  }
  for (const group of groups.values()) group.summary = diskSummary({disks:group.volumes});
  return [...groups.values()];
}
export function memoryDetails(memory = {}) {
  const rows = [
    { label:"物理内存", value:memory.used_bytes, total:memory.total_bytes },
    { label:"可用", value:memory.available_bytes },
    { label:"空闲", value:memory.free_bytes },
    { label:"缓存", value:memory.cached_bytes },
    { label:"缓冲区", value:memory.buffers_bytes },
    { label:"交换空间 / 分页文件", value:memory.swap_supported ? memory.swap_used_bytes : undefined, total:memory.swap_supported ? memory.swap_total_bytes : undefined },
    { label:"已提交虚拟内存", value:memory.committed_bytes, total:memory.commit_limit_bytes },
  ];
  for (const [key,label] of [["active_bytes","活跃"],["inactive_bytes","非活跃"],["wired_bytes","有线内存"]]) {
    if (known(memory[key])) rows.push({label,value:memory[key]});
  }
  return rows;
}
export function cpuDetails(metrics = {}) {
  const cpu = metrics.cpu_detail || {};
  return [["总使用率",metrics.cpu_percent],["用户态",cpu.user_percent],["内核态",cpu.system_percent],["空闲",cpu.idle_percent],["I/O 等待",cpu.iowait_percent],["虚拟化抢占",cpu.steal_percent]].map(([label,value])=>({label,value}));
}
