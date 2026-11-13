// 原版视觉资源（字体、玻璃图层、小人与品牌标、运行动画、壁纸、玻璃渲染等模块）的前端取用口。
//
// 只有一套：资源源头是维护者的私有 overlay（bridge-private 的 web/；发行树里是 frontend-assets/web），
// 每次前端构建都由 web/scripts/overlay-bundle.mjs 打进产物的 /app/_ov/，三个 HTML 壳首屏同步写好 window.__OVERLAY__、
// 样式表与 url 变量——网页、桌面壳、apk 离线壳都一样，本地读、首帧即原版。找不到资源的构建直接失败，没有降级版。
// 服务端（src/runtime/overlay-web.mjs）负责发 /app/_ov/ 下的文件；vite dev 没有壳注入，就近取 /app/_ov/manifest.json
// （vite 代理到后端）。
//
// 用法：
//   ovUrl('logo-animations/strips/thinking.svg')   资源地址（带版本戳，可长缓存）
//   ovData('marks')                                清单 data 里的一项（没有 → null）
//   await ovModule('landingTexture')               清单 modules 里的 ES 模块（加载失败 → null）
// ov 是 $state：dev 下清单晚到时，用到它的组件自己会重算。

const PREFIX = '/app/_ov/';

export const ov = $state({ ready: false, on: false, base: PREFIX, ver: '', files: {}, modules: {}, data: {} });

let settle;
const readyP = new Promise((r) => { settle = r; });
/** 清单定下来时 resolve。 */
export const overlayReady = () => readyP;

const encRel = (rel) => String(rel).split('/').map(encodeURIComponent).join('/');
const verOf = (m) => (typeof m.ver === 'string' && /^[0-9a-z]+$/i.test(m.ver) ? m.ver : '');
const withVer = (u, v = ov.ver) => (v ? u + (u.includes('?') ? '&' : '?') + 'v=' + v : u);

let injected = [];   // 本模块自己挂上的 <link>/<style>（只有 dev：壳里没有服务端 / 构建写好的标签）
function inject(m, base) {
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

function apply(m) {
  if (m && typeof m === 'object' && Array.isArray(m.files)) {
    ov.base = typeof m.base === 'string' && m.base.startsWith('/') ? m.base : PREFIX;
    ov.ver = verOf(m);
    ov.files = Object.fromEntries(m.files.filter((f) => typeof f === 'string').map((f) => [f, 1]));
    ov.modules = m.modules && typeof m.modules === 'object' ? m.modules : {};
    ov.data = m.data && typeof m.data === 'object' ? m.data : {};
    ov.on = true;
    if (typeof document !== 'undefined') {
      // 壳里已经写好（服务端 / 构建插的那几行）就不再挂第二份
      if (!injected.length && !document.querySelector('[data-ov]')) inject(m, ov.base);
      document.documentElement.dataset.overlay = m.name || '1';
    }
  } else {
    console.error('[overlay] 没有原版视觉资源清单：这份前端产物不完整，请重新构建');   // i18n-ignore 只进控制台
  }
  finish();
}

/** 清单里有没有这个文件（相对 web/）。 */
export function ovHas(rel) { return !!(ov.on && ov.files[rel]); }

/** 资源地址（带版本戳）。 */
export function ovUrl(rel) { return withVer(ov.base + encRel(rel)); }

/** 清单 data 里的一项；没有这项 → null。 */
export function ovData(key) { return ov.on && ov.data && ov.data[key] != null ? ov.data[key] : null; }

const mods = new Map();
/** 清单 modules 里的 ES 模块；加载失败 → null。每个名字只 import 一次。 */
export function ovModule(name) {
  if (!mods.has(name)) {
    mods.set(name, readyP.then(() => {
      const rel = ov.modules[name];
      if (!rel) { console.error('[overlay] 清单里没有模块 ' + name); return null; }   // i18n-ignore 只进控制台
      return import(/* @vite-ignore */ withVer(ov.base + encRel(rel))).catch((e) => {
        console.error('[overlay] 模块 ' + name + ' 加载失败：', e?.message || e);   // i18n-ignore 只进控制台
        return null;
      });
    }));
  }
  return mods.get(name);
}

(function init() {
  if (typeof window === 'undefined') { finish(); return; }
  const pre = window.__OVERLAY__;
  if (pre !== undefined) { apply(pre); return; }
  // vite dev：壳里没有注入，就近取（vite 代理 /app/_ov 到后端）
  let ctl = null, timer = 0;
  try { ctl = new AbortController(); timer = setTimeout(() => ctl.abort(), 5000); } catch {}
  fetch(PREFIX + 'manifest.json', { cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
    .then((r) => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : Promise.reject(new Error('http ' + r.status))))
    .then((m) => apply(m), () => apply(null))
    .finally(() => clearTimeout(timer));
})();
