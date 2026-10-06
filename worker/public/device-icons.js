// Shared, self-contained outline icons. No font, image CDN or runtime package.
export const DEVICE_ICONS = [
  { id: "server", label: "服务器", paths: ["M5 3h14v7H5zM5 14h14v7H5zM8 6.5h.01M8 17.5h.01M12 6.5h4M12 17.5h4"] },
  { id: "desktop", label: "台式机", paths: ["M3 3h18v13H3zM12 16v5M7 21h10M3 12h18"] },
  { id: "laptop", label: "笔记本", paths: ["M5 4h14v12H5zM5 16l-3 4h20l-3-4M10 18h4"] },
  { id: "router", label: "路由器", paths: ["M3 14h18v7H3zM6 14V8M18 14V8M6 18h.01M10 18h.01M14 18h4M8 6a6 6 0 0 1 8 0M10 9a3 3 0 0 1 4 0"] },
  { id: "network", label: "交换机", paths: ["M8 2h8v6H8zM2 16h6v6H2zM16 16h6v6h-6zM12 8v4M5 16v-4h14v4"] },
  { id: "nas", label: "NAS", paths: ["M5 2h14v20H5zM8 5h8v5H8zM8 13h8v5H8zM11 7.5h2M11 15.5h2M8 20h.01M16 20h.01"] },
  { id: "database", label: "数据库", paths: ["M4 5a8 3 0 1 0 16 0a8 3 0 1 0-16 0M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"] },
  { id: "cloud", label: "云主机", paths: ["M7 19H5a4 4 0 0 1-1-7.9A7 7 0 0 1 17.5 8A5.5 5.5 0 0 1 19 19H7Z"] },
  { id: "cpu", label: "芯片", paths: ["M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"] },
  { id: "raspberry-pi", label: "树莓派", paths: ["M3 3h18v18H3zM7 9h8v8H7zM6 3v3M10 3v3M14 3v3M18 3v3M18 10h3M18 14h3M7 21v-2M12 21v-2"] },
  { id: "windows", label: "Windows", paths: ["M3 5l8-1v8H3zM14 3.6l7-1V12h-7zM3 15h8v6l-8-1zM14 15h7v8l-7-1z"] },
  { id: "linux", label: "Linux", paths: ["M8 10V7a4 4 0 0 1 8 0v3l3 6-2 4H7l-2-4zM9 12c-3 3-2 7 3 7s6-4 3-7M10 7h.01M14 7h.01M10 10l2 2 2-2M8 20l-3 2M16 20l3 2"] },
  { id: "apple", label: "macOS", paths: ["M13 5c0-3 2-4 4-4 0 3-2 4-4 4M12 8c-2-2-6-2-8 2-2 4 2 12 5 12l3-1 3 1c2 0 4-3 5-6-4-2-4-5-1-7-2-3-5-3-7-1Z"] },
  { id: "container", label: "容器", paths: ["M3 6h18v13H3zM6 9v7M10 9v7M14 9v7M18 9v7M6 3h12M6 22h12"] },
  { id: "globe", label: "网站", paths: ["M22 12a10 10 0 1 0-20 0a10 10 0 1 0 20 0M2 12h20M12 2c-6 5-6 15 0 20 6-5 6-15 0-20Z"] },
  { id: "shield", label: "防火墙", paths: ["M12 2l8 4v6c0 5-5 8-8 10-3-2-8-5-8-10V6zM8 12l3 3 5-6"] },
];

export function getDeviceIcon(value) {
  return DEVICE_ICONS.find(icon => icon.id === value) || DEVICE_ICONS[0];
}

export function normalizeDeviceIcon(value) {
  return getDeviceIcon(value).id;
}
