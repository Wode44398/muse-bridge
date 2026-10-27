// 主页明暗双系统壁纸（设置页·壁纸分区的数据层）。
// 主页的「明/暗」= ui.glassMode 'B'/'A'（静态风景 vs flux 的既有双方案）；本模块给两个
// 系统各挂一个可选壁纸槽（wp.light / wp.dark），内置库 + 私有 overlay 带来的壁纸 + 用户上传壁纸。选择持久化 localStorage。
// 上传壁纸【存进工作空间】的「壁纸」文件夹（后端 /api/wallpaper/*，服务端落盘，跨设备可见/可管），
// 上传时可随附一张深度图，附了才有空间壁纸选项。Home 按「当前系统的槽」渲染。
//
// 「选的」和「用的」分开：pref 是存下来的选择（null = 跟默认），wp.light / wp.dark 是此刻实际显示的。
// 选的那张暂时用不了（overlay 清单还没到、上传清单里没有……）时显示当前默认，但不改 pref、不写回本机——
// 等它能用了（overlay 晚到、离线壳里的图取回来了）自动换回去。
import { untrack } from 'svelte';
import { ui, setHomeModeGuard } from './state.svelte.js';
import { api } from './api.js';
import { cloudFileUrl } from './preview.svelte.js';
import { t, isEn } from './i18n.js';
import { IS_IOS } from './liquidGlass.js';
import { ov, ovData, ovHas, ovUrl } from './overlay.svelte.js';

const BASE = import.meta.env.BASE_URL;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// 内置库（名称/分系来自设计稿《壁纸设置 v2》；流光=flux 流体引擎本体，缩略用渐变示意）
export const WPLIB = {
  // 明亮系
  // 层峦：程序化生成的自有素材（scripts/spatial-depth/gen-ridges.mjs，4:3，cover+center；深度图同脚本精确生成）。
  // 2026-10-22 起公开版的明亮默认。原来的多洛米蒂照片（id dolomites）挪进了维护者的私有 overlay（见下方 overlay 壁纸）。
  ridges:    { name: t('层峦'), src: 'assets/wallpapers/ridges.jpg', sys: 'light' },
  // 深色系
  flux:      { name: t('流光'), dyn: true, sys: 'dark',
    css: 'radial-gradient(60% 50% at 70% 28%, rgba(48,116,249,.55), rgba(48,116,249,0) 62%), radial-gradient(70% 60% at 24% 76%, rgba(113,137,255,.38), rgba(113,137,255,0) 66%), radial-gradient(40% 35% at 42% 50%, rgba(20,60,140,.4), rgba(20,60,140,0) 70%), linear-gradient(160deg, #0c1322 0%, #05070d 100%)' },
};
// iOS 不跑流光（WebKit 里 WASM 流体 + 逐帧玻璃叠加又卡又费电）：
// 暗系统只剩用户上传的静态壁纸，一张都没选时暗系统不可用（见下方 setHomeModeGuard）。
const BUILTIN = { light: ['ridges'], dark: IS_IOS ? [] : ['flux'], spatial: ['ridges'] };
const FALLBACK = { light: 'ridges', dark: 'flux' };

// 设置页列出的内置 + overlay 壁纸（上传壁纸另接在后面）；SPATIAL_IDS = 其中带深度图的。$state 数组：overlay 壁纸
// 就绪 / 撤掉时原地改，读它的模板与 $derived 自己会重算（调用方照旧把它当数组用）。
export const LIGHT_IDS = $state([...BUILTIN.light]);
export const DARK_IDS = $state([...BUILTIN.dark]);
export const SPATIAL_IDS = $state([...BUILTIN.spatial]);

// —— 私有 overlay 带来的壁纸 ——
// 清单 data.wallpapers：[{ id, name, name_en?, src, depth?, sys?: 'light'|'dark', default?: true }]
//   src / depth：overlay web/ 下的相对路径（清单 files 里得有，没有的条目 / 深度图当不存在）；
//   default：该系统没选过（或选的用不了）时的默认壁纸，同系统多张取第一张；没有 = 内置默认（层峦 / 流光）。
// id 不能与内置库重名、不能以 up- 开头（上传壁纸的前缀）。公开版没有 overlay：这里一直是空的，一切照旧。
// 地址怎么来：
//   · 同源（网页、桌面壳、打进 overlay 的维护者 apk）：直接用 ovUrl。真被某个槽用上时后台探一下图能不能加载（apk 里
//     漏打了文件时本地会回一段文本），加载不了就当这张不存在，回退默认，不留黑屏；没用上的不探（网页上不白下 2MB 的图）；
//   · 离线壳的远端只读模式（公开版 apk 连着带 overlay 的服务器）：图在别的源上。进 WebGL / WebGPU 纹理和
//     getImageData 的图不能跨源（会被污染，读不出像素），而各处 new Image() 都没设 crossOrigin（同源图设了反而会在
//     部分环境加载失败）。所以这里先 fetch 成 blob（/app/_ov/ 带 ACAO:*），给出同源的 blob: 地址，取回来之前这张不算可用。
const OV_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
function readOvWallpapers() {
  const raw = ovData('wallpapers');
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const id = typeof x.id === 'string' ? x.id : '';
    if (!OV_ID.test(id) || id.startsWith('up-') || hasOwn(WPLIB, id) || seen.has(id)) continue;
    if (typeof x.src !== 'string' || !ovHas(x.src)) continue;
    seen.add(id);
    const zh = typeof x.name === 'string' ? x.name : '';
    const en = typeof x.name_en === 'string' ? x.name_en : '';
    const depth = typeof x.depth === 'string' && ovHas(x.depth) ? x.depth : '';
    out.push({
      id,
      name: (isEn() ? en || zh : zh || en) || id,
      sys: x.sys === 'dark' ? 'dark' : 'light',
      def: x.default === true,
      url: ovUrl(x.src),
      depthUrl: depth ? ovUrl(depth) : null,
    });
  }
  return out;
}

// id → { key, e（清单条目）, remote, st: 'ok'|'wait'|'bad', url, depthUrl, blobs, probed }；ovList 是其中可用的那些（按清单顺序）
const ovSt = new Map();
let ovOrder = [];
let ovList = $state.raw([]);
const ovItem = (id) => ovList.find((w) => w.id === id) || null;

const live = (s) => ovSt.get(s.e.id) === s;
function revoke(urls) { for (const u of urls) { try { URL.revokeObjectURL(u); } catch {} } }

// 同源：槽里用上它时后台探一下原图与深度图（与显示用的同一地址，浏览器复用缓存，不多花流量）。每张只探一次。
function probe(s) {
  if (s.remote || s.probed || s.st !== 'ok' || typeof Image !== 'function') return;
  s.probed = true;
  const test = (u, fail) => {
    const im = new Image();
    im.onerror = () => { if (live(s)) { fail(); publish(); } };
    im.src = u;
  };
  test(s.url, () => { s.st = 'bad'; });
  if (s.depthUrl) test(s.depthUrl, () => { s.depthUrl = null; });
}

// 远端只读模式：取成 blob 再给同源地址
async function toBlobUrl(u) {
  const r = await fetch(u, { mode: 'cors', credentials: 'omit' });
  if (!r.ok) throw new Error('http ' + r.status);
  const b = await r.blob();
  if (b.type && !/^image\//i.test(b.type)) throw new Error('not an image: ' + b.type);
  return URL.createObjectURL(b);
}
async function fetchRemote(s) {
  try {
    const url = await toBlobUrl(s.e.url);
    if (!live(s)) { revoke([url]); return; }
    s.blobs.push(url);
    s.url = url;
    if (s.e.depthUrl) {
      let d = null;
      try { d = await toBlobUrl(s.e.depthUrl); } catch {}
      if (!live(s)) { if (d) revoke([d]); return; }
      if (d) s.blobs.push(d);
      s.depthUrl = d;
    }
    s.st = 'ok';
  } catch {
    if (!live(s)) return;
    s.st = 'bad';
  }
  publish();
}

// 清单里的壁纸（readOvWallpapers 的结果）→ 状态表。同一张（地址没变）不重来；远端取失败的，清单再来一次时重试。
function syncOverlay(list, remote) {
  const drop = [];
  const keep = new Set();
  for (const e of list) {
    keep.add(e.id);
    const key = (remote ? 'r|' : 'l|') + e.url + '|' + (e.depthUrl || '');
    let s = ovSt.get(e.id);
    if (s && s.key === key && !(remote && s.st === 'bad')) { s.e = e; continue; }
    if (s) drop.push(...s.blobs);
    s = { key, e, remote, st: remote ? 'wait' : 'ok', url: remote ? null : e.url, depthUrl: remote ? null : e.depthUrl, blobs: [], probed: false };
    ovSt.set(e.id, s);
    if (remote) fetchRemote(s);
  }
  for (const [id, s] of ovSt) if (!keep.has(id)) { drop.push(...s.blobs); ovSt.delete(id); }
  ovOrder = list.map((e) => e.id);
  publish();
  revoke(drop);
}

function setIds(arr, next) {
  if (arr.length === next.length && arr.every((v, i) => v === next[i])) return;
  arr.splice(0, arr.length, ...next);
}
let ovSig = '[]';
// 可用的 overlay 壁纸 → ovList 与对外的几张列表（overlay 的排在内置前面），再按新情况校正两个槽
function publish() {
  const list = ovOrder.map((id) => ovSt.get(id)).filter((s) => s && s.st === 'ok')
    .map((s) => ({ id: s.e.id, name: s.e.name, sys: s.e.sys, def: s.e.def, url: s.url, depthUrl: s.depthUrl }));
  const sig = JSON.stringify(list);
  if (sig !== ovSig) { ovSig = sig; ovList = list; }
  setIds(LIGHT_IDS, [...list.filter((w) => w.sys === 'light').map((w) => w.id), ...BUILTIN.light]);
  setIds(DARK_IDS, [...list.filter((w) => w.sys === 'dark').map((w) => w.id), ...BUILTIN.dark]);
  setIds(SPATIAL_IDS, [...list.filter((w) => w.depthUrl).map((w) => w.id), ...BUILTIN.spatial]);
  reconcile();
}

// —— 选择 ——
const LS_KEY = 'bridge-wallpaper';
function loadPref() {
  const ok = (v) => (typeof v === 'string' && v ? v : null);
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (s && typeof s === 'object') return { light: ok(s.light), dark: ok(s.dark) };
  } catch {}
  return { light: null, dark: null };
}
const pref = loadPref();

// uploads: [{ id, name, sys, hasDepth, url, depthUrl }]，启动时从后端 /api/wallpaper/list 拉。
// light / dark 先占个位，下面 reconcile() 当场按 pref 定下来（模块求值完之前没人读）。
export const wp = $state({ light: FALLBACK.light, dark: FALLBACK.dark, uploads: [], ready: false });
let wpInit = false;
let uploadsKnown = false;   // 上传清单拉过一次了（拉之前选着的上传壁纸先按可用算）

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ light: pref.light, dark: pref.dark })); } catch {}
}

export const wpIsUpload = (id) => String(id).startsWith('up-');
const uploadItem = (id) => wp.uploads.find((u) => u.id === id);

function usable(id) {
  if (!id) return false;
  if (wpIsUpload(id)) return !uploadsKnown || !!uploadItem(id);
  return hasOwn(WPLIB, id) || !!ovItem(id);
}
function defaultId(slot) {
  const d = ovList.find((w) => w.sys === slot && w.def);
  return d ? d.id : FALLBACK[slot];
}
const effId = (slot) => (usable(pref[slot]) ? pref[slot] : defaultId(slot));

// 两个槽 = 选的那张（能用时）或当前默认。不写 pref、不写本机。
function reconcile() {
  if (!wpInit) return;
  const l = effId('light'), d = effId('dark');
  if (wp.light !== l) wp.light = l;
  if (wp.dark !== d) wp.dark = d;
  fixHomeMode();
  for (const id of [l, d]) { const s = ovSt.get(id); if (s) probe(s); }
}

// iOS：暗系统槽还是动态壁纸（默认流光）= 暗系统不可用。上传 / overlay 壁纸都是静态的，恒可用
//（上传清单还没拉回来时也按可用算，拉回来发现已删会回退默认，再走一遍下面的纠正）。
const darkUsable = () => !IS_IOS || !(hasOwn(WPLIB, wp.dark) && WPLIB[wp.dark].dyn);
setHomeModeGuard((mode) => mode !== 'A' || darkUsable());
function fixHomeMode() {
  if (ui.glassMode === 'A' && !darkUsable()) {
    ui.glassMode = 'B';
    try { localStorage.setItem('bridge-glass', 'B'); } catch {}
  }
}

// 首屏：服务端注入 / apk 烤进壳 / 离线壳缓存的 overlay 清单此刻已经挂上了，同步并进来再定两个槽——
// 第一帧就是选的那张，不先闪一下默认。
wpInit = true;
syncOverlay(readOvWallpapers(), ov.remote);
reconcile();

// 清单晚到（vite dev / 旧服务端就近取、离线壳首次取）或之后变了（离线壳换了服务器）：重新并一遍。
// 模块顶层建 root（见 composerDrafts.svelte.js 的说明）。
if (typeof window !== 'undefined') {
  $effect.root(() => {
    $effect(() => {
      const list = readOvWallpapers();
      const remote = ov.remote;
      untrack(() => syncOverlay(list, remote));
    });
  });
}

// 后端条目 { id, name, sys, hasDepth, file, depthFile } → 前端条目（file/depthFile 拼成可喂 <img> 的 URL）。
// http:true：壁纸要进 WebGL/WebGPU 纹理，桌面端不能走本地协议（跨源无 CORS，主页会画成一片黑）。
function toItem(x) {
  return {
    id: x.id, name: x.name || t('我的壁纸'), sys: x.sys === 'dark' ? 'dark' : 'light', hasDepth: !!x.hasDepth,
    url: cloudFileUrl(x.file, { http: true }),
    depthUrl: x.depthFile ? cloudFileUrl(x.depthFile, { http: true }) : null,
  };
}

// 启动拉取上传壁纸清单（失败静默——离线时上传壁纸不可用，回退默认）。
export async function refreshUploads() {
  try {
    const r = await api.wallpaperList();
    wp.uploads = (r && r.items || []).map(toItem);
  } catch {}
  if (uploadsKnown) reconcile();
}
(async () => {
  await refreshUploads();
  // 选中的上传壁纸不在清单里（已删/拉取失败）→ 显示默认，避免黑屏（pref 不动：下次拉到了照样是它）
  uploadsKnown = true;
  reconcile();
  wp.ready = true;
})();

// 壁纸定义：上传（工作空间文件 URL）、overlay（overlay 地址 / blob:）或内置（src 补 BASE 前缀）。
// 返回 { name, sys?, dyn?, url?, css? }；不认识的 id 兜底成流光（与以前一致）。
export function wpDef(id) {
  const up = uploadItem(id);
  if (up) return { name: up.name, url: up.url };
  const o = ovItem(id);
  if (o) return { name: o.name, sys: o.sys, url: o.url };
  const w = hasOwn(WPLIB, id) ? WPLIB[id] : null;
  if (!w) return WPLIB.flux;
  return { ...w, url: w.src ? BASE + w.src : null };
}

// 选定某系统的壁纸（persist；Home 响应 wp[slot] 自动换壁纸）。设置页只列能用的，选了就是它。
export function setWp(slot, id) { pref[slot] = id; persist(); reconcile(); }

// 一次选中的文件 → { image, depth }：单张 = 普通壁纸；两张 = 原图 + 深度图，文件名含
// depth / 深度 的那张是深度图（白=近、黑=远）。认不出来返回 null，由调用方提示。
const DEPTH_NAME = /depth|深度/i;
export function splitWpFiles(files) {
  const list = [...(files || [])];
  if (list.length === 1) return { image: list[0], depth: null };
  if (list.length !== 2) return null;
  const d = list.filter((f) => DEPTH_NAME.test(f.name || ''));
  if (d.length !== 1) return null;
  return { image: list.find((f) => f !== d[0]), depth: d[0] };
}

// 上传：POST 原图到工作空间（有深度图再附上）→ 入列表，返回新 id（调用方负责先降采样）。
// 深度图传失败就把刚传的原图也撤掉，不留下「想要空间却没空间」的半成品。
export async function addUpload(file, sys = 'light', depth = null) {
  const r = await api.wallpaperUpload(file.name || 'image.jpg', sys, file);
  if (!r || !r.item) throw new Error('upload failed');
  let item = r.item;
  if (depth) {
    try {
      const d = await api.wallpaperDepth(item.id, depth.name || 'depth.png', depth);
      if (!d || !d.item) throw new Error('depth upload failed');
      item = d.item;
    } catch (e) {
      try { await api.wallpaperDelete(item.id); } catch {}
      throw e;
    }
  }
  const it = toItem(item);
  wp.uploads = [...wp.uploads, it];
  return it.id;
}

// 删除上传壁纸（服务端删文件+清单）。若正被选用则回退默认（overlay 有默认壁纸就是它）。
export async function deleteUpload(id) {
  try { await api.wallpaperDelete(id); } catch {}
  wp.uploads = wp.uploads.filter((u) => u.id !== id);
  let changed = false;
  for (const slot of ['light', 'dark']) if (pref[slot] === id) { pref[slot] = null; changed = true; }
  if (changed) persist();
  reconcile();
}

// 当前主页系统（'light'|'dark'）与当前壁纸定义
export function homeSys() { return ui.glassMode === 'B' ? 'light' : 'dark'; }
export function curWpId() { return wp[homeSys()]; }

// —— 空间壁纸（景深视差）——
// 给静态壁纸叠一层深度视差：电脑指针跟随、手机重力(陀螺仪)跟随。
// 内置默认壁纸的深度图随包预生成在 assets/wallpapers/depth/<id>.png；overlay 壁纸的深度图在清单的 depth；
// 上传壁纸只有上传时随附了深度图才有（item.depthUrl），运行时不再生成。动态壁纸(flux)本身就是动的，不提供此选项。
// 开关+幅度按明/暗系统各存。
// 有深度图 = 提供空间壁纸选项：内置默认（随包）、带深度图的 overlay 壁纸，或上传时附了深度图的上传壁纸。
export function wpHasDepth(id) {
  const o = ovItem(id);
  if (o) return !!o.depthUrl;
  if (BUILTIN.spatial.includes(id)) return true;
  const up = uploadItem(id);
  return !!(up && up.hasDepth);
}
export function wpDepthUrl(id) {
  const o = ovItem(id);
  if (o) return o.depthUrl;
  if (BUILTIN.spatial.includes(id)) return BASE + 'assets/wallpapers/depth/' + id + '.png';
  const up = uploadItem(id);
  return up && up.hasDepth ? up.depthUrl : null;
}

const SP_KEY = 'bridge-spatial';
function loadSpatial() {
  try {
    const s = JSON.parse(localStorage.getItem(SP_KEY) || 'null');
    if (s) return {
      light: { on: !!(s.light && s.light.on), amp: (s.light && s.light.amp) ?? 0.55 },
      dark:  { on: !!(s.dark  && s.dark.on),  amp: (s.dark  && s.dark.amp)  ?? 0.55 },
    };
  } catch {}
  return { light: { on: false, amp: 0.55 }, dark: { on: false, amp: 0.55 } };
}
// amp: 0..1 归一化强度（SpatialLayer 内部映射到最大安全位移）；on: 该系统是否启用空间壁纸。
export const spatial = $state(loadSpatial());
function persistSpatial() {
  try { localStorage.setItem(SP_KEY, JSON.stringify({
    light: { on: spatial.light.on, amp: spatial.light.amp },
    dark:  { on: spatial.dark.on,  amp: spatial.dark.amp },
  })); } catch {}
}
export function setSpatialOn(slot, on) { spatial[slot].on = !!on; persistSpatial(); }
export function setSpatialAmp(slot, amp) { spatial[slot].amp = amp; persistSpatial(); }
