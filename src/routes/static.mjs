// Static page serving.
//
// `/` and `/index.html`: the NEW Vite frontend (multi-file build under public/app),
// with the capabilities snapshot inlined as window.__CAPS__ so caps.js reads it
// directly (the /api/capabilities endpoint requires auth, so a logged-out first
// paint would otherwise have no model list). no-store so iOS Safari never caches.
//
// `/app` and `/app/*`: the new frontend's entry + static assets (hashed JS/CSS,
// fonts, mascot, icons). The mini-router is exact-match with no
// wildcards, so a middleware handles the /app/ prefix.

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { CAPABILITIES } from '../config/capabilities.mjs';
import { PUBLIC_DIR } from '../config/index.mjs';
import { mimeType } from '../runtime/http-file.mjs';

// 本表只放【共享表 MIME_TYPES 里没有的】前端产物类型（字体 / wasm / manifest / sourcemap）。
// 其余一律回落共享表，省得每加一种构建产物就要在两处各补一遍——`.mjs` 就是这么漏掉的：
// 本表没有 → 落到 octet-stream → 浏览器按规范拒绝执行该 MIME 的模块。
//
// 回落时【绝不能带 safe:true】：那个开关是给「用户上传的文件从 bridge 源被访问」用的，
// 会把 js/mjs/css/svg/html 全部降级成 text/plain 以免在本源执行脚本。/app/* 是我们自己
// 构建出来的产物、本就该执行，套上 safe 会让整个前端直接起不来。
const STATIC_TYPES = {
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

// 缓存策略分三档（之前一律 no-store，在线壳每次冷启动重下 ~9MB JS/字体）：
//   · /app/assets/*（vite 带内容 hash 的文件名）→ immutable 一年，改了内容名字必变。
//   · 其余静态文件（public/ 的图标/壁纸等，无 hash）→ no-cache + ETag：每次仍发请求，
//     但未变化时 304 零字节返回。
//   · HTML（含注入的 caps）→ 维持 no-store（serveHtml 路径，不走这里）。
async function serveStatic(req, res, file, { immutable = false } = {}) {
  try {
    const st = await stat(file);
    const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
    if (req && req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    const buf = await readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] || mimeType(file),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

export function registerStaticRoutes(router) {
  // New frontend assets at /app/* (router has no wildcard — intercept the prefix).
  router.use(async (req, res, url) => {
    if (req.method !== 'GET' || !url.pathname.startsWith('/app/')) return;
    // decodeURIComponent so percent-encoded paths (e.g. CJK asset filenames like
    // claude-小人-正面站立.svg) resolve to the real on-disk file instead of 404.
    let rel; try { rel = decodeURIComponent(url.pathname.slice(5)); } catch { rel = url.pathname.slice(5); }
    rel = rel.replace(/\.\.+/g, '').replace(/^\/+/, '');
    await serveStatic(req, res, path.join(PUBLIC_DIR, 'app', rel), { immutable: rel.startsWith('assets/') });
    return false; // handled — stop dispatch
  });

  // Inline the capabilities snapshot so window.__CAPS__ is ready before any script
  // runs (caps.js prefers it; avoids the auth-gated /api/capabilities on first paint).
  const injectCaps = (html) => {
    const tag = `<script>window.__CAPS__=${JSON.stringify(CAPABILITIES)};</script>`;
    return html.includes('<!-- CAPS_INJECT -->')
      ? html.replace('<!-- CAPS_INJECT -->', tag)
      : html.replace('</head>', tag + '</head>');
  };
  const serveHtml = (file) => async (_req, res) => {
    try {
      const html = injectCaps(await readFile(file, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('failed to serve page');
    }
  };

  const serveApp = serveHtml(path.join(PUBLIC_DIR, 'app', 'index.html'));    // new frontend

  router.on('GET', '/', serveApp);
  router.on('GET', '/index.html', serveApp);
  router.on('GET', '/app', serveApp);

  // 零信息探活端点：部署脚本、看门狗、前端可达性检测都用它。
  router.on('GET', '/healthz', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('ok'); });
}
