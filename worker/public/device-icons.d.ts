export type DeviceIconID = "server" | "desktop" | "laptop" | "router" | "network" | "nas" | "database" | "cloud" | "cpu" | "raspberry-pi" | "windows" | "linux" | "apple" | "container" | "globe" | "shield";
export type DeviceIconDefinition = { readonly id: DeviceIconID; readonly label: string; readonly paths: readonly string[] };
export const DEVICE_ICONS: readonly DeviceIconDefinition[];
export function getDeviceIcon(value: unknown): DeviceIconDefinition;
export function normalizeDeviceIcon(value: unknown): DeviceIconID;
