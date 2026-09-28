import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// dev 代理目标可用 HARNESS_API 覆盖（对着 8801 旁路实例开发，不打扰 live 8799）
const API = process.env.HARNESS_API || "http://localhost:8799";

export default defineConfig({
  plugins: [svelte()],
  build: {
    rollupOptions: {
      output: {
        // xterm 体积大且只有 Dock 终端用到：独立 chunk，主包保持苗条
        manualChunks: { xterm: ["@xterm/xterm", "@xterm/addon-fit"] },
      },
    },
  },
  server: {
    port: 5178,
    proxy: {
      // SSE 关缓冲，token 级流出
      "/api": {
        target: API,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
    },
  },
});
