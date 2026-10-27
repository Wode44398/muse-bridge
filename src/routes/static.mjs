// Static page serving.
//
// `/` and `/index.html`: the NEW Vite frontend (multi-file build under public/app),
// with the capabilities snapshot inlined as window.__CAPS__ so caps.js reads it
// directly (the /api/capabilities endpoint requires auth, so a logged-out first
// paint would otherwise have no model list). no-store so iOS Safari never caches.
//
// `/legacy`: the old single-file frontend, kept as a fallback during the cutover.
//
// `/app` and `/app/*`: the new frontend's entry + static assets (hashed JS/CSS,
// fonts, wallpaper, mascot, icons). The mini-router is exact-match with no
// wildcards, so a middleware handles the /app/ prefix.
//
// `/debug.html`: the local-only debug console, served whole.

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { moduleWebDirs } from '../modules/registry.mjs';
import { CAPABILITIES } from '../config/capabilities.mjs';
import { PUBLIC_DIR, NO_AUTH } from '../config/index.mjs';
import { mimeType } from '../runtime/http-file.mjs';
import { compressedStatic } from './static-compress.mjs';

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
// 文本类产物（js/css/svg/json…）按 Accept-Encoding 发 br / gzip（static-compress.mjs，压一次记在内存里）。
async function serveStatic(req, res, file, { immutable = false } = {}) {
  try {
    const st = await stat(file);
    const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
    if (req && req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    const buf = await readFile(file);
    const ext = path.extname(file);
    const z = await compressedStatic(req, file, st, buf);
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] || mimeType(file),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
      ...(z ? { 'Content-Encoding': z.enc, Vary: 'Accept-Encoding' } : {}),
    });
    res.end(z ? z.body : buf);
  } catch {
    if (res.headersSent) { try { res.destroy(); } catch {} return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

// /app/<rel> 落到哪个文件：主构建优先，没有再去已装功能扩展（离线包）自带的 web/ 里找。
// 以前每个资源请求同步 existsSync 一遍（本机每次 0.3–0.6ms，冷启动几十个资源一起来）；改成异步 stat。
async function resolveAppFile(rel) {
  const main = path.join(PUBLIC_DIR, 'app', rel);
  const isFile = async (f) => { try { return (await stat(f)).isFile(); } catch { return false; } };
  if (await isFile(main)) return main;
  for (const d of moduleWebDirs()) {
    const f = path.join(d, rel);
    if (await isFile(f)) return f;
  }
  return main;
}

export function registerStaticRoutes(router) {
  // New frontend assets at /app/* (router has no wildcard — intercept the prefix).
  router.use(async (req, res, url) => {
    if (req.method !== 'GET' || !url.pathname.startsWith('/app/')) return;
    // decodeURIComponent so percent-encoded paths (e.g. CJK asset filenames like
    // claude-小人-正面站立.svg) resolve to the real on-disk file instead of 404.
    let rel; try { rel = decodeURIComponent(url.pathname.slice(5)); } catch { rel = url.pathname.slice(5); }
    rel = rel.replace(/\.\.+/g, '').replace(/^\/+/, '');
    // 主构建里没有的，去已装功能扩展（离线包）自带的 web/ 里找——基础版的主包不含扩展前端 chunk。
    const file = await resolveAppFile(rel);
    await serveStatic(req, res, file, { immutable: rel.startsWith('assets/') });
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
  const serveLegacy = serveHtml(path.join(PUBLIC_DIR, 'index.html'));        // old single-file (fallback)

  router.on('GET', '/', serveApp);
  router.on('GET', '/index.html', serveApp);
  router.on('GET', '/app', serveApp);
  router.on('GET', '/legacy', serveLegacy);

  // ACAO:* 必须有——离线壳（appassets 源）跨源 fetch /healthz 做局域网探活，无此头
  // 浏览器会拦掉响应让 fetch reject，导致 LAN 自动直连永远探不通、形同虚设。零信息端点，放行安全。
  router.on('GET', '/healthz', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end('ok'); });
  // 调试控制台只在本地 NO_AUTH 桌面实例提供；隧道侧 404（其 /api/admin/* 本就 404，HTML 壳也不外露）。
  router.on('GET', '/debug.html', (req, res) => {
    if (!NO_AUTH) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    serveStatic(req, res, path.join(PUBLIC_DIR, 'debug.html'));
  });
}
