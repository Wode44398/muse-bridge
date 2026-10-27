// 私有 overlay 的前端一侧（服务端见 src/runtime/overlay-web.mjs，开源路线 2.1 / 2.5）。
//
// 公开构建只带开源字体与自有素材。维护者自己的部署在服务端配了 overlay 目录时，原素材（专有字体、原版动画帧、
// 只在私有部署用的模块……）在运行时叠加：
//   · 在线页（服务端同源提供的 HTML）：服务端已在 </head> 前插好 window.__OVERLAY__、样式表和 url 变量，首屏即生效；
//   · 维护者自己出的 apk：出包时 overlay 已打进包里（www/app/_ov/），壳里同样写好了 window.__OVERLAY__
//     （web/scripts/overlay-bundle.mjs），本地读、首帧即原版，不碰网络；
//   · 没有注入的同源页（vite dev、旧服务端）：就近取 /app/_ov/manifest.json；
//   · 没打进 overlay 的离线壳（公开版 apk 连上了带 overlay 的服务器）：只接受「不会执行」的部分——样式表、url 变量、
//     图片地址、data 数据；modules 一律不 import（离线壳这个源挂着读写本地文件夹、下载安装的原生桥，不能让服务器往手机里推代码）。
//     上次取到的清单记在本机，下次启动同步挂上（字体与图片走 HTTP 缓存），再在后台刷新；取不到时等联网 / 服务器恢复 /
//     换了地址再取。
// 公开版（没有 overlay）：window.__OVERLAY__ 为 null，什么都不做，一切走自有实现。
//
// 用法：
//   ovUrl('logo-animations/strips/thinking.svg', 公开版地址)   overlay 有这个文件 → overlay 的地址，否则公开版地址
//   ovData('marks')                                          overlay 清单 data 里的一项（没有 → null）
//   await ovModule('landingTexture')                          overlay 提供的 ES 模块（没有 / 加载失败 / 远端只读模式 → null）
//   ovMarks()                                                 overlay 带了哪几套原版运行标记（设置「思考动画」据此显示选项）
// ov 是 $state：清单晚到（离线壳）时，用到它的组件自己会重算。

import { getServerBase, isOffline, onServerBaseChange, onServerRecovered } from './server.js';

const BASE = import.meta.env.BASE_URL;   // 构建 '/app/'，dev '/'
const PREFIX = '/app/_ov/';
const CACHE_KEY = 'bridge.ov.remote';     // 离线壳：{ origin, m } 上次从服务器取到的清单（丢了只是多等一次网络）

// remote：清单来自另一个源（离线壳跨源取的）——只读模式，不 import 模块
export const ov = $state({ ready: false, on: false, remote: false, base: '', ver: '', files: {}, modules: {}, data: {} });

let settle;
const readyP = new Promise((r) => { settle = r; });
/** 清单定下来（有或没有）时 resolve。 */
export const overlayReady = () => readyP;

const encRel = (rel) => String(rel).split('/').map(encodeURIComponent).join('/');
const verOf = (m) => (typeof m.ver === 'string' && /^[0-9a-z]+$/i.test(m.ver) ? m.ver : '');
const withVer = (u, v = ov.ver) => (v ? u + (u.includes('?') ? '&' : '?') + 'v=' + v : u);

let injected = [];   // 本模块自己挂上的 <link>/<style>（换清单时先撤掉）
function uninject() { for (const n of injected) { try { n.remove(); } catch {} } injected = []; }
function inject(m, base) {
  uninject();
  try {
    const head = document.head;
    const v = verOf(m);
    for (const c of Array.isArray(m.css) ? m.css : []) {
      if (typeof c !== 'string') continue;
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = withVer(base + encRel(c), v);
      l.dataset.ov = '';
      head.appendChild(l);
      injected.push(l);
    }
    const vars = Object.entries(m.vars && typeof m.vars === 'object' ? m.vars : {})
      .filter(([k, f]) => /^--[A-Za-z0-9_-]+$/.test(k) && typeof f === 'string')
      .map(([k, f]) => `${k}:url("${withVer(base + encRel(f), v).replace(/["\\]/g, '')}")`).join(';');
    if (vars) {
      const s = document.createElement('style');
      s.dataset.ov = '';
      s.textContent = `:root:root{${vars}}`;
      head.appendChild(s);
      injected.push(s);
    }
  } catch {}
}

function finish() { if (!ov.ready) { ov.ready = true; settle(); } }

// m：清单（null = 没有 overlay）；origin：清单所在的源（'' = 本页同源）；remote：只读模式
function apply(m, origin, { remote = false } = {}) {
  if (m && typeof m === 'object' && Array.isArray(m.files)) {
    const base = origin + (typeof m.base === 'string' && m.base.startsWith('/') ? m.base : PREFIX);
    ov.base = base;
    ov.ver = verOf(m);
    ov.files = Object.fromEntries(m.files.filter((f) => typeof f === 'string').map((f) => [f, 1]));
    ov.modules = !remote && m.modules && typeof m.modules === 'object' ? m.modules : {};
    ov.data = m.data && typeof m.data === 'object' ? m.data : {};
    ov.remote = remote;
    ov.on = true;
    if (typeof document !== 'undefined') {
      // 服务端 / 出包时已经在壳里插过（那几行不是本模块挂的）就不再挂第二份
      if (injected.length || !document.querySelector('[data-ov]')) inject(m, base);
      document.documentElement.dataset.overlay = m.name || '1';
    }
  } else if (ov.on) {
    // 刷新后发现 overlay 没了（离线壳换了服务器）：撤回公开版
    uninject();
    ov.on = false; ov.remote = false; ov.base = ''; ov.ver = ''; ov.files = {}; ov.modules = {}; ov.data = {};
    if (typeof document !== 'undefined') delete document.documentElement.dataset.overlay;
  }
  finish();
}

/** overlay 里有没有这个文件（相对 overlay 的 web/）。 */
export function ovHas(rel) { return !!(ov.on && ov.files[rel]); }

/** overlay 有这个文件 → 它的地址（带版本戳，可长缓存）；否则 fallback（缺省 = 公开构建里同一路径）。 */
export function ovUrl(rel, fallback) {
  if (ov.on && ov.files[rel]) return withVer(ov.base + encRel(rel));
  return fallback === undefined ? BASE + rel : fallback;
}

/** overlay 清单 data 里的一项；没有 overlay / 没有这项 → null。 */
export function ovData(key) { return ov.on && ov.data && ov.data[key] != null ? ov.data[key] : null; }

/** overlay 带了哪几套原版运行标记：{ clay, sprite, classic }（都没有 = 公开版，只有自绘星标）。 */
export function ovMarks() {
  const m = ovData('marks');
  return { clay: !!(m && m.clay && ov.modules.clayMark), sprite: !!ov.modules.spriteMark, classic: !!(m && m.strips) };
}

const mods = new Map();
/** overlay 提供的 ES 模块（清单 modules 里的名字）；没有 / 加载失败 / 远端只读模式 → null。每个名字只 import 一次。 */
export function ovModule(name) {
  if (!mods.has(name)) {
    mods.set(name, readyP.then(() => {
      const rel = ov.on && !ov.remote && ov.modules[name];
      if (!rel) return null;
      return import(/* @vite-ignore */ withVer(ov.base + encRel(rel))).catch((e) => {
        console.warn('[overlay] 模块 ' + name + ' 加载失败，走公开版：', e?.message || e);   // i18n-ignore 只进控制台
        return null;
      });
    }));
  }
  return mods.get(name);
}

// —— 取清单（同源页 / 离线壳）——
function fetchManifest(origin) {
  let ctl = null, timer = 0;
  try { ctl = new AbortController(); timer = setTimeout(() => ctl.abort(), 5000); } catch {}
  return fetch(origin + PREFIX + 'manifest.json', { cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
    .then((r) => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : Promise.reject(new Error('http ' + r.status))))
    .finally(() => clearTimeout(timer));
}

function readCache() {
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); return c && typeof c === 'object' && typeof c.origin === 'string' ? c : null; } catch { return null; }
}
function writeCache(origin, m) {
  try { if (m) localStorage.setItem(CACHE_KEY, JSON.stringify({ origin, m })); else localStorage.removeItem(CACHE_KEY); } catch {}
}

// 离线壳的远端只读模式：先同步挂上次的清单，再后台刷新；失败了等联网 / 服务器恢复 / 换地址再取
function startRemote() {
  let origin = getServerBase();
  let applied = '';   // 已挂上的清单（JSON），同样的就不重挂
  let busy = false, ok = false;
  const cached = readCache();
  if (origin && cached && cached.origin === origin && cached.m) { applied = JSON.stringify(cached.m); apply(cached.m, origin, { remote: true }); }
  const refresh = () => {
    if (busy || !origin) { finish(); return; }
    busy = true;
    const at = origin;
    fetchManifest(at).then((m) => {
      if (at !== origin) return;
      ok = true;
      writeCache(at, m);
      const s = JSON.stringify(m);
      if (s !== applied) { applied = s; apply(m, at, { remote: true }); }
    }).catch(() => {}).finally(() => { busy = false; finish(); });
  };
  refresh();
  const retry = () => { if (!ok) refresh(); };
  try { window.addEventListener('online', retry); } catch {}
  try { onServerRecovered(retry); } catch {}
  // 服务器换了地址（地址自愈 / 改了地址）：旧地址的清单作废，按新地址重取
  try { onServerBaseChange(() => { origin = getServerBase(); ok = false; applied = ''; refresh(); }); } catch {}
}

(function init() {
  if (typeof window === 'undefined') { finish(); return; }
  const pre = window.__OVERLAY__;
  if (pre !== undefined) { apply(pre, ''); return; }
  if (isOffline()) { startRemote(); return; }
  // 没被服务端注入的同源页（dev、旧服务端）：就近取，取不到 = 没有 overlay
  fetchManifest('').then((m) => apply(m, ''), () => apply(null, ''));
})();
