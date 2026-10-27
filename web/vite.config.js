import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { bridgeModuleChunks } from './scripts/module-chunks.mjs';
import { chatgptPage } from './scripts/chatgpt-overlay.mjs';
import { overlayBundle } from './scripts/overlay-bundle.mjs';   // apk 出包时把私有 overlay 打进离线壳（公开版 / 没有 overlay 什么都不做）

// The Bridge — mobile web frontend.
// Dev serves at the root (base '/') so the page loads at http://127.0.0.1:5173/.
// Production builds to ../public/app with base '/app/', which the node server
// serves at /app during the transition (legacy public/index.html stays at /).
//
// Dev proxies /api + /healthz to a running bridge backend. Point BRIDGE_API at a
// loopback NO_AUTH dev instance (PORT=8788 BRIDGE_NO_AUTH=1 node src/server.mjs)
// so calls need no token and SSE streams pass through; changeOrigin rewrites Host
// to the target so the backend's loopback/Origin guard accepts the proxied request.
// 8799 属于 harness（routes/harness.mjs 里写死），bridge dev 后端不能占它。
const API = process.env.BRIDGE_API || 'http://127.0.0.1:8788';

// Harness 分页的新前端：源码在同仓库的 harness/ 子目录，经 @hx 别名以源码形式编进
// bridge 包（Svelte 5 + TS，vite 原生吃得动）。单一真相源——harness 网页版 / 独立壳 /
// bridge 分页共用一套组件，改一处三端生效。相对本文件解析，worktree 里同样成立。
const HARNESS_SRC = fileURLToPath(new URL('../harness/web/src', import.meta.url));

// apk 出包改道：build-apk.ps1 设 BRIDGE_APK_OUT 指向临时目录时，做一次全新构建
// （emptyOutDir）专供 apk。生产 public/app 因「构建即部署不打断旧页面」积着最多
// 7 天的陈旧 hash 资产（见 pruneOldAssets），整目录拷进 apk 全是死重——v4.36 实测
// 28.8MB，干净构建只有 14.6MB。改道后出包完全不碰 public/app。
const APK_OUT = process.env.BRIDGE_APK_OUT || '';

// Codex 分页的界面（ChatGPT 页面）不在本仓库，由维护者的私有 overlay 提供（<overlay>/web/chatgpt/）：构建结束拷进
// <outDir>/chatgpt 并给它引用的脚本 / 样式打内容哈希；dev 从 overlay 直接发 /chatgpt/*。没有 overlay 或公开版出包
// （BRIDGE_EDITION=public）就不带，Codex 分页打开时提示「此版本未包含」。见 scripts/chatgpt-overlay.mjs。

// 新旧构建的 hash 资产并存：生产 8787 上「构建即部署」，emptyOutDir 一清空，
// 已打开的旧页面下一次懒加载（预览器/编辑器 chunk）就 404——桌面壳/手机端表现为
// 「无法预览此文档 Failed to fetch dynamically imported module」。改为不清目录，
// 旧 chunk 留任老页面继续用（内容 hash 文件名天然不冲突），这里按 mtime 清理
// 7 天前的陈旧资产防堆积。前端另有 staleGuard（vite:preloadError 自动刷新）双保险。
function pruneOldAssets(days = 7) {
  let dir; // <outDir>/assets —— apk 改道构建时目录全新，天然无可清理项
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
  // bridgeModuleChunks：产物按「核心 / 各功能扩展」归属写进 bridge-modules.json（模块化打包与验收用）
  plugins: [svelte(), chatgptPage(), overlayBundle(), pruneOldAssets(), bridgeModuleChunks({ webRoot: fileURLToPath(new URL('.', import.meta.url)) })],
  base: command === 'build' ? '/app/' : '/',
  resolve: {
    alias: { '@hx': HARNESS_SRC },
  },
  build: {
    outDir: APK_OUT || '../public/app',
    // 生产不清空：旧 hash 资产留给已打开的旧页面继续懒加载（见 pruneOldAssets 注释）。
    // apk 改道构建必须清空，保证包里只有当前引用闭包、零死 chunk。
    emptyOutDir: !!APK_OUT,
    target: 'es2020',
    // 两个入口：index.html = 完整 app；quick.html = 桌面壳全局热键呼出的 Quick Ask 浮窗。
    // 浮窗刻意独立成一个入口而不是 App 的一条路由——它要在后台预热待命，不该为了
    // 一条输入框把壁纸/Dock/助手球/会话恢复全拖起来。共享的只有几个纯模块，rollup
    // 自动抽成公共 chunk。列了 input 就必须把 index 一起列上（默认值会被覆盖）。
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        quick: fileURLToPath(new URL('quick.html', import.meta.url)),
        // solo.html = 单开一个对话（Claude 分页分屏的另一格 / 拖出 app 的独立窗口，src/lib/solo.js）
        solo: fileURLToPath(new URL('solo.html', import.meta.url)),
      },
    },
    // esbuild 的 CSS 压缩会删掉 filter/backdrop-filter 多函数值之间的必需空格
    // （blur(22px) saturate(1.2) → blur(22px)saturate(1.2)），使整条声明无效被浏览器丢弃，
    // 导致设置页/登录卡等所有毛玻璃在 prod 失效（dev 不压缩故正常）。CSS 仅 ~45KB，
    // gzip 后压不压缩差别极小，关掉 CSS 压缩根治此 bug；JS 仍照常压缩。
    cssMinify: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 允许 dev 从 web/ 上级 import 后端的 src/config/capabilities.mjs（caps.js 的编译期兜底）等 src/ 下的共用代码、
    // harness/web/src（@hx 别名）。只放开这几个代码目录，不放开仓库根：数据根 = 程序根时 config.json、
    // claude-providers/connector-secrets.key、users/ 都在仓库根，/@fs/ 会把它们当静态文件发出去（pv- 预览链接绕过鉴权）。
    // deny 会整个替换 vite 默认值，默认那四条照抄再加凭据文件。
    fs: {
      allow: ['.', '../src', '../harness/web', '../node_modules'],
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/config.json*', '**/connector-secrets.*', '**/public-access.json'],
    },
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/healthz': { target: API, changeOrigin: true },
      // 私有 overlay（清单、原版字体与素材、运行时模块）：dev 页没有服务端注入，前端去这里取清单
      '/app/_ov': { target: API, changeOrigin: true },
    },
  },
}));
