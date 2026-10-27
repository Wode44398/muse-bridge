// 私有 overlay 的网页层（开源路线 2.1 / 2.5）。
//
// 公开仓只带开源字体与自有素材；维护者自己的部署把受版权保护的原素材（专有字体、官方动画帧、移植来的着色器……）
// 放在仓外的 overlay 目录，运行时叠加上去——构建产物本身保持干净，换不换 overlay 都不用重新构建。
// overlay 目录由 runtime/overlay-hooks.mjs 解析（BRIDGE_OVERLAY_DIR > config.json 的 overlayDir；都没设 = 公开版）。
// 本模块只管其中的 web/ 子目录：
//
//   <overlay>/web/overlay.json   清单（可选），字段都可省：
//       name      说明用的名字
//       css       页面首屏就要挂上的样式表（相对 web/）：字体 @font-face、把品牌字体变量指向原字体……
//       varDirs   这些目录下的每个图片生成一个 url 变量 --ov-<路径>（如 figma-glass/tb-orb44-dark.png →
//                 --ov-figma-glass-tb-orb44-dark），组件 CSS 写 var(--ov-…, url(公开版自有图))
//       vars      额外的 { "--变量名": "相对路径" }
//       modules   { 名字: "相对路径.js" }：前端 ovModule(名字) 运行时 import（公开版没有就走自有实现）
//       data      任意 JSON：前端 ovData(键) 读（例如原版动画的帧表）
//   <overlay>/web/<其余文件>      字体、图、动画帧、JS 模块……
//
// 对外：
//   GET /app/_ov/manifest.json   前端清单；没有 overlay 时回 null。apk 离线壳 / 跨源壳来取，带 ACAO:*
//   GET /app/_ov/<路径>          overlay 文件本身（ACAO:*：离线壳跨源加载字体与 ES 模块要它）
//   GET /app/<路径>              主构建、已装扩展里都没有而 overlay 里有 → 回落到 overlay（私有的整页、开发页）
//   HTML 壳（/、/index.html、/app、/app/index.html、/app/quick.html、/app/solo.html、/w/…、/c/…）：
//       </head> 前注入 window.__OVERLAY__（清单，没有 overlay 时为 null）、overlay 样式表与 url 变量，
//       首屏就是 overlay 的样子，不闪。同一处还插发行版声明 window.__DISTRO__、换掉壳里写死的品牌（config/distro.mjs）。
//   缓存：清单带版本戳 ver（全部文件的路径 + 内容的哈希）；页面引用的地址都带 ?v=<ver>，这样的请求回一年
//       immutable（样式表里的相对 url() 同时补上 ?v=），不带的照旧 no-cache。
//   维护者自己的 apk：出包时把 overlay 打进 www/app/_ov/、壳里写好同样的标签（web/scripts/overlay-bundle.mjs），
//       离线壳不从服务器取任何 overlay 代码。清单的生成与标签拼法在 overlay-manifest.mjs，两边共用。
// 前端一侧见 web/src/lib/overlay.svelte.js（ovUrl / ovModule / ovData）。
//
// 另：overlay 钩子 registerRoutes(router, ctx) 存在时，核心路由挂完后调用（私有接口），见 registerOverlayRoutes。

import path from 'node:path';
import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { OVERLAY_DIR, overlayHook } from './overlay-hooks.mjs';
import { PROGRAM_ROOT } from './paths.mjs';
import { mimeType } from './http-file.mjs';
import { compressedStatic } from '../routes/static-compress.mjs';
import { moduleWebDirs } from '../modules/registry.mjs';
import { OV_PREFIX, buildManifest, headTags, injectHead, stampCssUrls, varNameOf } from './overlay-manifest.mjs';
import { DISTRO, distroHeadTag, brandHtml, brandManifest } from '../config/distro.mjs';

export { OV_PREFIX, varNameOf };
const APP_DIR = path.join(PROGRAM_ROOT, 'public', 'app');

let webDir = '';
function dirOk(d) { try { return statSync(d).isDirectory(); } catch { return false; } }
if (OVERLAY_DIR) {
  const d = path.join(OVERLAY_DIR, 'web');
  if (dirOk(d)) webDir = d;
  else console.warn('[overlay] 配了 overlay 目录，但没有 ' + d + '：网页层照公开版');
}
// 测试用：换一个 overlay web 目录（'' = 关）。正式代码不调。
export function _setOverlayWebDir(d) { webDir = d || ''; cache = null; }
export const overlayWebDir = () => webDir;

const FONT_TYPES = {
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const contentType = (f) => FONT_TYPES[path.extname(f).toLowerCase()] || mimeType(f);

// —— 清单：扫一遍 web/ 下的文件（跳过点开头的），读 overlay.json（overlay-manifest.mjs）。5 秒内复用，overlay 里改了
// 文件刷新一下页面就生效 ——
let cache = null;   // { at, manifest, files:Set }
function load() {
  if (!webDir) return null;
  if (cache && Date.now() - cache.at < 5000) return cache;
  const { manifest, files } = buildManifest(webDir, { warn: (m) => console.warn('[overlay] ' + m) });
  cache = { at: Date.now(), manifest, files };
  return cache;
}
export function overlayManifest() { const c = load(); return c ? c.manifest : null; }

// </head> 前要插的那几行。没有 overlay：只有 window.__OVERLAY__=null（前端据此不再去取清单）。
export function overlayHeadTags() { return headTags(overlayManifest()); }

// 一段 web/ 内的相对路径 → 绝对文件路径；越界、点开头的段一律 null
function resolveIn(dir, rel) {
  if (!dir || !rel) return null;
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || p.includes('\\') || p.includes(':'))) return null;
  const abs = path.resolve(dir, ...parts);
  const root = path.resolve(dir);
  return abs.startsWith(root + path.sep) ? abs : null;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
const IMMUTABLE = 'public, max-age=31536000, immutable';

// ver：请求带的 ?v=。等于当前 overlay 的版本戳 → 长缓存（overlay 一改版本戳就变，页面拿到的是新地址）；
// 样式表里相对的 url() 也补上同一个 ?v=，字体跟着长缓存。不带 / 对不上（旧页面、手写地址）→ no-cache，每次回源验证。
async function sendFile(req, res, file, { cors = true, ver = '' } = {}) {
  let st;
  try { st = await stat(file); if (!st.isFile()) throw new Error('not a file'); } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...(cors ? CORS : {}) }); res.end('not found'); return;
  }
  const cur = ver ? overlayManifest()?.ver || '' : '';
  const pinned = !!ver && ver === cur;
  const etag = `W/"ov-${st.size}-${Math.round(st.mtimeMs)}${pinned ? '-' + ver : ''}"`;
  const head = { 'Cache-Control': pinned ? IMMUTABLE : 'no-cache', ETag: etag, ...(cors ? CORS : {}) };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  let buf = await readFile(file);
  let z = null;
  if (pinned && /\.css$/i.test(file)) buf = Buffer.from(stampCssUrls(buf.toString('utf8'), ver));   // 改写过的不进压缩缓存（键是原文件）
  else z = await compressedStatic(req, file, st, buf);
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, { ...head, 'Content-Type': contentType(file), ...(z ? { 'Content-Encoding': z.enc, Vary: 'Accept-Encoding' } : {}) });
  res.end(z ? z.body : buf);
}

// 构建期已经写进壳里的（apk 出包时 overlay-bundle.mjs 打进去的）不再插第二份——后插的会盖掉先插的
const BAKED = 'window.__OVERLAY__=';
const DISTRO_MARK = 'window.__DISTRO__=';

// HTML 壳要插的：overlay 那几行 + 发行版声明（config/distro.mjs，前端启动前就要读），已经有的不再插；
// 壳里写死的品牌（<title> 等）换成发行版的
function shellHtml(s) {
  let tags = '';
  if (!s.includes(BAKED)) tags += overlayHeadTags();
  if (!s.includes(DISTRO_MARK)) tags += distroHeadTag();
  return brandHtml(tags ? injectHead(s, tags) : s);
}

// HTML 壳的 res.end 截一下，</head> 前插 overlay 的几行。只碰 text/html、未压缩、字符串 / Buffer 一次性写出的响应。
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
const isFile = async (f) => { try { return (await stat(f)).isFile(); } catch { return false; } };

// 静态中间件：必须挂在 registerStaticRoutes 之前（/app/* 由它先看一眼）。没有 overlay 时只剩清单接口（回 null）
// 和 HTML 壳里那一行 window.__OVERLAY__=null。
export function registerOverlayWeb(router) {
  router.use(async (req, res, url) => {
    if (req.method !== 'GET') return;
    const p = url.pathname;
    if (p === OV_PREFIX + 'manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
      res.end(JSON.stringify(overlayManifest()));
      return false;
    }
    if (p.startsWith(OV_PREFIX)) {
      let rel; try { rel = decodeURIComponent(p.slice(OV_PREFIX.length)); } catch { rel = ''; }
      const file = resolveIn(webDir, rel);
      if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS }); res.end('not found'); return false; }
      await sendFile(req, res, file, { ver: url.searchParams.get('v') || '' });
      return false;
    }
    if (SHELL_EXACT.has(p) || ((p.startsWith('/w/') || p.startsWith('/c/')) && p.length > 3)) { injectInto(res); return; }
    if (SHELL_FILES.has(p)) {
      // 这三个壳本来走 /app/ 静态（可能被压缩）：这里直接读出来插好再发，no-cache 每次都拿到当前 overlay。
      const file = path.join(APP_DIR, p.slice(5));
      let html;
      try { html = await readFile(file, 'utf8'); } catch { return; }   // 读不到交回静态路由（404 照旧）
      html = shellHtml(html);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
      return false;
    }
    // PWA 清单的名字跟着发行版走（本体原样交给静态路由）
    if (p === '/app/manifest.webmanifest' && DISTRO.brand !== 'The Bridge') {
      let text;
      try { text = await readFile(path.join(APP_DIR, 'manifest.webmanifest'), 'utf8'); } catch { return; }
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(brandManifest(text));
      return false;
    }
    if (webDir && p.startsWith('/app/') && p.length > 5) {
      const c = load();
      let rel; try { rel = decodeURIComponent(p.slice(5)); } catch { return; }
      if (!c || !c.files.has(rel)) return;
      // 主构建、已装扩展有的照旧给它们（overlay 只补缺）
      if (await isFile(path.join(APP_DIR, rel))) return;
      for (const d of moduleWebDirs()) if (await isFile(path.join(d, rel))) return;
      const file = resolveIn(webDir, rel);
      if (!file) return;
      await sendFile(req, res, file, { cors: false });
      return false;
    }
  });
}

// overlay 的私有接口：钩子 registerRoutes(router, ctx) 存在就调一次（核心路由与扩展路由挂完之后）。
// 坏了只记日志，不拖垮核心。
export async function registerOverlayRoutes(router, ctx = {}) {
  const fn = overlayHook('registerRoutes');
  if (typeof fn !== 'function') return false;
  try { await fn(router, ctx); return true; } catch (e) {
    console.error('[overlay] registerRoutes 钩子出错：', (e && e.message) || e);
    return false;
  }
}
