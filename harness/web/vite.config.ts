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
    // 共用的型号知识模块在仓库根的 src/model-knowledge（lib/model-knowledge.ts 相对引用）：开发态只多放开这一个目录，构建本来就能解析。
    // 不能放开到仓库根：数据根 = 程序根的部署上，config.json / connector-secrets.key 会被 /@fs/ 当静态文件发出去（pv- 预览链接绕过鉴权）。
    // allow 相对 vite root 解析，必须带 "."；deny 会整个替换 vite 默认值，所以默认那四条照抄再加凭据文件。
    fs: {
      allow: [".", "../../src/model-knowledge"],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/config.json*", "**/connector-secrets.*", "**/public-access.json"],
    },
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
