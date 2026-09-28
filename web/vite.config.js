import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Muse Bridge — web frontend.
// Dev serves at the root (base '/') so the page loads at http://127.0.0.1:5173/.
// Production builds to ../public/app with base '/app/', which the node server serves at /app.
//
// Dev proxies /api + /healthz to a running bridge backend. Point BRIDGE_API at a
// loopback NO_AUTH dev instance (PORT=8788 BRIDGE_NO_AUTH=1 node src/server.mjs)
// so calls need no token and SSE streams pass through; changeOrigin rewrites Host
// to the target so the backend's loopback/Origin guard accepts the proxied request.
// 8799 属于 harness（routes/harness.mjs 里写死），bridge dev 后端不能占它。
const API = process.env.BRIDGE_API || 'http://127.0.0.1:8788';

// dimensio 分页的前端：源码在同仓库的 harness/ 子目录，经 @hx 别名以源码形式编进
// bridge 包（Svelte 5 + TS，vite 原生吃得动）。单一真相源——harness 网页版与 bridge 分页
// 共用一套组件，改一处两端生效。相对本文件解析，worktree 里同样成立。
const HARNESS_SRC = fileURLToPath(new URL('../harness/web/src', import.meta.url));

// 新旧构建的 hash 资产并存：「构建即部署」时 emptyOutDir 一清空，已打开的旧页面下一次懒加载
// （预览器/编辑器 chunk）就 404——表现为「无法预览此文档 Failed to fetch dynamically imported
// module」。改为不清目录，旧 chunk 留给老页面继续用（内容 hash 文件名天然不冲突），这里按 mtime
// 清理 7 天前的陈旧资产防堆积。前端另有 staleGuard（vite:preloadError 自动刷新）双保险。
function pruneOldAssets(days = 7) {
  let dir; // <outDir>/assets
  return {
    name: 'bridge-prune-old-assets',
    apply: 'build',
    configResolved(c) { dir = join(resolve(c.root, c.build.outDir), 'assets'); },
    async closeBundle() {
      const { readdir, stat, unlink } = await import('node:fs/promises');
      const cutoff = Date.now() - days * 86400_000;
      let files = [];
      try { files = await readdir(dir); } catch { return; }
      for (const f of files) {
        try {
          const st = await stat(join(dir, f));
          if (st.isFile() && st.mtimeMs < cutoff) await unlink(join(dir, f));
        } catch { /* 单个清不掉不碍事 */ }
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [svelte(), pruneOldAssets()],
  base: command === 'build' ? '/app/' : '/',
  resolve: {
    alias: { '@hx': HARNESS_SRC },
  },
  build: {
    outDir: '../public/app',
    // 不清空：旧 hash 资产留给已打开的旧页面继续懒加载（见 pruneOldAssets 注释）。
    emptyOutDir: false,
    target: 'es2020',
    // 两个入口：index.html = 完整 app；solo.html = 单开一个对话（Claude 分页分屏的另一格 /
    // 拖出去的独立窗口，src/lib/solo.js）。共享模块 rollup 自动抽成公共 chunk。
    // 列了 input 就必须把 index 一起列上（默认值会被覆盖）。
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        solo: fileURLToPath(new URL('solo.html', import.meta.url)),
      },
    },
    // esbuild 的 CSS 压缩会删掉 filter/backdrop-filter 多函数值之间的必需空格
    // （blur(22px) saturate(1.2) → blur(22px)saturate(1.2)），使整条声明无效被浏览器丢弃，
    // 导致所有毛玻璃在 prod 失效（dev 不压缩故正常）。CSS 体积不大，gzip 后压不压缩差别极小，
    // 关掉 CSS 压缩根治此 bug；JS 仍照常压缩。
    cssMinify: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 允许 dev 从 web/ 上级 import 后端的 src/config/*.mjs（caps.js 的编译期兜底）；
    // 仓库根同时覆盖 harness/web/src（@hx 别名），无需再单列。
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/healthz': { target: API, changeOrigin: true },
    },
  },
}));
