// 私有 overlay 网页层的清单（纯函数，不读环境变量、不碰配置、导入无副作用）。
// 两处共用：
//   · 服务端 runtime/overlay-web.mjs：运行时扫 <overlay>/web，发 /app/_ov/manifest.json，往 HTML 壳里插首屏标签；
//   · 前端构建 web/scripts/overlay-bundle.mjs：维护者自己出 apk 时把 overlay 打进 www/app/_ov/，在构建期往壳里写同样的标签
//     （离线壳本地秒开，首帧就是原版，不从服务器拉任何代码）。
// 清单字段见 overlay-web.mjs 顶部注释。ver 是整个 overlay 的版本戳（所有文件的路径 + 内容哈希）：
// 地址带 ?v=<ver> 的请求可以长缓存，overlay 里任何文件一改 ver 就变，页面拿到的新地址自然绕开旧缓存。
// 必须按内容、不能按修改时间：web 的 prebuild 每次构建都原样重写 chatgpt/work-picker.runtime.js，按 mtime 算的话
// 每次部署 ver 都变，壁纸（2.3MB）与字体（1MB+）全部换地址重下——国内经 Cloudflare 回源每次首屏要多等十几秒（10-25 查实）。

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';

export const OV_PREFIX = '/app/_ov/';
const IMG_EXT = /\.(png|jpe?g|webp|avif|gif|svg)$/i;

export const varNameOf = (rel) => '--ov-' + rel.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();

// 一段相对路径 → URL 片段（中文文件名、空格逐段编码）
export const encRel = (rel) => String(rel).split('/').map(encodeURIComponent).join('/');

/** dir 下所有文件（跳过点开头的段；skip(rel) 为真的也跳过，目录按 'a/b/' 形式问）→ [{ rel, size, mtimeMs }]，按 rel 排序。 */
export function walkFiles(dir, { skip = () => false } = {}) {
  const out = [];
  (function walk(d, rel) {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!skip(r + '/')) walk(path.join(d, e.name), r); }
      else if (e.isFile() && !skip(r)) {
        let st = null;
        try { st = statSync(path.join(d, e.name)); } catch {}
        if (st) out.push({ rel: r, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
      }
    }
  })(dir, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// 文件内容哈希，按 绝对路径 + 大小 + 修改时间 记住（服务端每 5 秒重扫一次清单，没动过的文件不重读）
const digests = new Map();
function contentDigest(abs, f) {
  const key = f.size + ':' + f.mtimeMs;
  const hit = digests.get(abs);
  if (hit && hit.key === key) return hit.d;
  let d;
  try { d = createHash('sha1').update(readFileSync(abs)).digest('hex'); } catch { d = key; }
  digests.set(abs, { key, d });
  return d;
}

/**
 * 扫 webDir（<overlay>/web）→ { manifest, files:Set<rel> }；目录不存在 → 文件为空的清单（调用方自己判断要不要当没有）。
 * prefix：清单里的 base（服务端与 apk 包里都是 /app/_ov/）。skip：同 walkFiles。
 */
export function buildManifest(webDir, { prefix = OV_PREFIX, skip, warn = () => {} } = {}) {
  const list = walkFiles(webDir, { skip });
  const files = list.map((f) => f.rel);
  const has = new Set(files);
  let conf = {};
  try {
    const raw = readFileSync(path.join(webDir, 'overlay.json'), 'utf8');
    conf = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) || {};
  } catch (e) {
    if (has.has('overlay.json')) warn('overlay.json 读不了：' + ((e && e.message) || e));
  }
  const css = arr(conf.css).filter((f) => has.has(f));
  const vars = {};
  for (const d of arr(conf.varDirs)) {
    const pre = d.replace(/\/*$/, '/');
    for (const f of files) if (f.startsWith(pre) && IMG_EXT.test(f)) vars[varNameOf(f)] = f;
  }
  for (const [k, v] of Object.entries(conf.vars && typeof conf.vars === 'object' ? conf.vars : {})) {
    if (/^--[A-Za-z0-9_-]+$/.test(k) && typeof v === 'string' && has.has(v)) vars[k] = v;
  }
  const modules = {};
  for (const [k, v] of Object.entries(conf.modules && typeof conf.modules === 'object' ? conf.modules : {})) {
    if (typeof v === 'string' && has.has(v)) modules[k] = v;
  }
  const data = conf.data && typeof conf.data === 'object' ? conf.data : {};
  const h = createHash('sha1');
  for (const f of list) h.update(f.rel + '\0' + contentDigest(path.join(webDir, ...f.rel.split('/')), f) + '\n');
  const ver = h.digest('hex').slice(0, 10);
  const manifest = { v: 1, name: String(conf.name || ''), base: prefix, ver, css, vars, modules, data, files };
  return { manifest, files: has };
}

const withVer = (u, ver) => (ver ? u + (u.includes('?') ? '&' : '?') + 'v=' + ver : u);

/** </head> 前要插的那几行。manifest 为 null：只有 window.__OVERLAY__=null（前端据此不再去取清单）。 */
export function headTags(manifest, prefix = OV_PREFIX) {
  const json = JSON.stringify(manifest).replace(/[<\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  let s = `<script>window.__OVERLAY__=${json};</script>`;
  if (!manifest) return s;
  const ver = manifest.ver || '';
  for (const c of manifest.css) s += `<link rel="stylesheet" href="${withVer(prefix + encRel(c), ver)}" data-ov>`;
  const vars = Object.entries(manifest.vars).map(([k, v]) => `${k}:url("${withVer(prefix + encRel(v), ver)}")`).join(';');
  if (vars) s += `<style data-ov>:root:root{${vars}}</style>`;
  return s;
}

/** 一段 HTML 的 </head> 前插标签（没有 </head> 原样返回）。 */
export function injectHead(html, tags) {
  const i = html.indexOf('</head>');
  return i >= 0 ? html.slice(0, i) + tags + html.slice(i) : html;
}

/**
 * 样式表里相对的 url(...) 补上 ?v=<ver>（overlay.css 引的字体跟着长缓存）。
 * 绝对地址、data:、根路径、#片段不动；已经带 v= 的不重复加。
 */
export function stampCssUrls(css, ver) {
  if (!ver) return css;
  return css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (all, q, u) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(u) || /[?&]v=/.test(u)) return all;
    return `url(${q}${withVer(u, ver)}${q})`;
  });
}
