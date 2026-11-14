// HTML 壳的发行版注入：</head> 前插 window.__DISTRO__（config/distro.mjs，前端启动前就要读），壳里写死的品牌（<title> 等）
// 换成发行版的；PWA 清单的名字同样跟着发行版走。
// 覆盖的壳：/、/index.html、/app、/app/index.html、/app/quick.html、/app/solo.html、/w/…、/c/…。
// 原版视觉资源（字体、玻璃图层、动画、模块）在前端源码 web/src/visuals/，构建时由 vite 收进产物，服务端不再另发、壳里也不再插标签。
// 必须挂在 registerStaticRoutes 之前（/app/* 由它先看一眼）。

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PROGRAM_ROOT } from './paths.mjs';
import { DISTRO, distroHeadTag, brandHtml, brandManifest } from '../config/distro.mjs';

const APP_DIR = path.join(PROGRAM_ROOT, 'public', 'app');
const DISTRO_MARK = 'window.__DISTRO__=';

/** 一段 HTML 的 </head> 前插标签（没有 </head> 原样返回）。 */
export function injectHead(html, tags) {
  const i = html.indexOf('</head>');
  return i >= 0 ? html.slice(0, i) + tags + html.slice(i) : html;
}

// HTML 壳要插的发行版声明（已经有的不再插），壳里写死的品牌换成发行版的
export function shellHtml(s) {
  return brandHtml(s.includes(DISTRO_MARK) ? s : injectHead(s, distroHeadTag()));
}

// HTML 壳的 res.end 截一下，</head> 前插发行版声明。只碰 text/html、未压缩、字符串 / Buffer 一次性写出的响应。
function injectInto(res) {
  const writeHead = res.writeHead, end = res.end;
  let html = false;
  res.writeHead = function (status, ...args) {
    const h = args.find((a) => a && typeof a === 'object');
    const ct = (h && (h['Content-Type'] || h['content-type'])) || res.getHeader('content-type');
    const enc = (h && (h['Content-Encoding'] || h['content-encoding'])) || res.getHeader('content-encoding');
    html = /text\/html/i.test(String(ct || '')) && !enc;
    if (html) {
      if (h) { delete h['Content-Length']; delete h['content-length']; }
      res.removeHeader('content-length');
    }
    return writeHead.call(this, status, ...args);
  };
  res.end = function (chunk, ...rest) {
    if (html && chunk != null && typeof chunk !== 'function') {
      const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : typeof chunk === 'string' ? chunk : null;
      if (s != null && s.includes('</head>')) chunk = shellHtml(s);
    }
    return end.call(this, chunk, ...rest);
  };
}

const SHELL_EXACT = new Set(['/', '/index.html', '/app']);
const SHELL_FILES = new Set(['/app/index.html', '/app/quick.html', '/app/solo.html']);

export function registerHtmlShell(router, { appDir = APP_DIR } = {}) {
  router.use(async (req, res, url) => {
    if (req.method !== 'GET') return;
    const p = url.pathname;
    if (SHELL_EXACT.has(p) || ((p.startsWith('/w/') || p.startsWith('/c/')) && p.length > 3)) { injectInto(res); return; }
    if (SHELL_FILES.has(p)) {
      // 这三个壳本来走 /app/ 静态（可能被压缩）：这里直接读出来插好再发，no-cache 每次都拿到当前发行版声明。
      let html;
      try { html = await readFile(path.join(appDir, p.slice(5)), 'utf8'); } catch { return; }   // 读不到交回静态路由（404 照旧）
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(shellHtml(html));
      return false;
    }
    // PWA 清单的名字跟着发行版走（本体原样交给静态路由）
    if (p === '/app/manifest.webmanifest' && DISTRO.brand !== 'The Bridge') {
      let text;
      try { text = await readFile(path.join(appDir, 'manifest.webmanifest'), 'utf8'); } catch { return; }
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(brandManifest(text));
      return false;
    }
  });
}
