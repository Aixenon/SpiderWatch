import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc", environment: "local" } })],
  test: { include: ["test/**/*.test.ts"], testTimeout: 15000, hookTimeout: 15000, fileParallelism: false },
});
