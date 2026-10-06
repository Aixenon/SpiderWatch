import { state, type Node } from "./monitor";
const known = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const number = (value: number | null | undefined, digits = 1) => typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value) : "—";
export function cpuCoreCounts(host: Pick<Node["host"], "cpus" | "physical_cpus" | "logical_cpus">) {
  const count = (value: number | undefined) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? number(value, 0) : "未知";
  return { physical: count(host.physical_cpus), logical: count(host.logical_cpus === undefined ? host.cpus : host.logical_cpus) };
}
export function bytes(value: number | null | undefined) {
  if (!known(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${number(value)} ${units[i]}`;
}
export function usageClass(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return "usage-unknown";
  return value >= 85 ? "usage-critical" : value >= 60 ? "usage-warning" : "usage-normal";
}
export const memoryPercent = (node: Node) => {
  const memory = node.metrics.memory;
  return known(memory?.used_bytes) && known(memory?.total_bytes) && memory.total_bytes > 0 ? memory.used_bytes / memory.total_bytes * 100 : null;
};
export const groupLabel = (id: string | null) => state.groups.find(g => g.id === id)?.name || "未分组";
export const statusLabel = (node: Node) => node.state === "pending" ? "待加入" : node.connected ? "在线" : "离线";
export const time = (value: number) => value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "尚未上报";
export const interval = (seconds: number) => seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
export const uptime = (seconds: number | null | undefined) => known(seconds) ? `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时` : "不可用";
