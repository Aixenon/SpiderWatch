import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "/panel/",
  plugins: [vue()],
  publicDir: "static",
  build: {
    outDir: fileURLToPath(new URL("../dist/panel", import.meta.url)),
    emptyOutDir: true,
  },
});
