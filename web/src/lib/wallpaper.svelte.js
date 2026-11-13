// 主页明暗双系统壁纸（设置页·壁纸分区的数据层）。
// 主页的「明/暗」= ui.glassMode 'B'/'A'（静态风景 vs flux 的既有双方案）；本模块给两个
// 系统各挂一个可选壁纸槽（wp.light / wp.dark），内置库 + 用户上传壁纸。选择持久化 localStorage。
// 上传壁纸【存进工作空间】的「壁纸」文件夹（后端 /api/wallpaper/*，服务端落盘，跨设备可见/可管），
// 上传时可随附一张深度图，附了才有空间壁纸选项。Home 按「当前系统的槽」渲染。
//
// 「选的」和「用的」分开：pref 是存下来的选择（null = 跟默认），wp.light / wp.dark 是此刻实际显示的。
// 选的那张暂时用不了（上传清单里没有、已经下架的内置壁纸……）时显示当前默认，但不改 pref、不写回本机——
// 等它能用了（上传清单拉到了）自动换回去。
import { ui } from './state.svelte.js';
import { api } from './api.js';
import { cloudFileUrl } from './preview.svelte.js';
import { t } from './i18n.js';
import { ovUrl } from './overlay.svelte.js';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// 内置库（名称/分系来自设计稿《壁纸设置 v2》；流光=flux 流体引擎本体，缩略用渐变示意）
export const WPLIB = {
  // 明亮系：多洛米蒂（原版资源，原图与深度图都在 /app/_ov/wallpapers/）
  dolomites: { name: t('多洛米蒂'), src: 'wallpapers/dolomites.jpg', depth: 'wallpapers/depth/dolomites.png', sys: 'light' },
  // 深色系
  flux:      { name: t('流光'), dyn: true, sys: 'dark',
    css: 'radial-gradient(60% 50% at 70% 28%, rgba(48,116,249,.55), rgba(48,116,249,0) 62%), radial-gradient(70% 60% at 24% 76%, rgba(113,137,255,.38), rgba(113,137,255,0) 66%), radial-gradient(40% 35% at 42% 50%, rgba(20,60,140,.4), rgba(20,60,140,0) 70%), linear-gradient(160deg, #0c1322 0%, #05070d 100%)' },
};
// 2026-11-03 起流光换成轻量引擎（wallpaper/drift.js），iOS 也照常提供——之前因 WASM 流体在 WebKit 上又卡又费电而排除。
const BUILTIN = { light: ['dolomites'], dark: ['flux'], spatial: ['dolomites'] };
const FALLBACK = { light: 'dolomites', dark: 'flux' };

// 设置页列出的内置壁纸（上传壁纸另接在后面）；SPATIAL_IDS = 其中带深度图的
export const LIGHT_IDS = [...BUILTIN.light];
export const DARK_IDS = [...BUILTIN.dark];
export const SPATIAL_IDS = [...BUILTIN.spatial];

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
let uploadsKnown = false;   // 上传清单拉过一次了（拉之前选着的上传壁纸先按可用算）

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ light: pref.light, dark: pref.dark })); } catch {}
}

export const wpIsUpload = (id) => String(id).startsWith('up-');
const uploadItem = (id) => wp.uploads.find((u) => u.id === id);

function usable(id) {
  if (!id) return false;
  if (wpIsUpload(id)) return !uploadsKnown || !!uploadItem(id);
  return hasOwn(WPLIB, id);
}
const effId = (slot) => (usable(pref[slot]) ? pref[slot] : FALLBACK[slot]);

// 两个槽 = 选的那张（能用时）或默认。不写 pref、不写本机。
function reconcile() {
  const l = effId('light'), d = effId('dark');
  if (wp.light !== l) wp.light = l;
  if (wp.dark !== d) wp.dark = d;
}
// 首屏同步定下两个槽：第一帧就是选的那张，不先闪一下默认
reconcile();

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

// 壁纸定义：上传（工作空间文件 URL）或内置（原版资源地址）。
// 返回 { name, sys?, dyn?, url?, css? }；不认识的 id 兜底成流光（与以前一致）。
export function wpDef(id) {
  const up = uploadItem(id);
  if (up) return { name: up.name, url: up.url };
  const w = hasOwn(WPLIB, id) ? WPLIB[id] : null;
  if (!w) return WPLIB.flux;
  return { ...w, url: w.src ? ovUrl(w.src) : null };
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

// 删除上传壁纸（服务端删文件+清单）。若正被选用则回退默认。
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
// 内置壁纸的深度图随原版资源一起（WPLIB 的 depth）；上传壁纸只有上传时随附了深度图才有（item.depthUrl），
// 运行时不再生成。动态壁纸(flux)本身就是动的，不提供此选项。开关+幅度按明/暗系统各存。
// 有深度图 = 提供空间壁纸选项：内置的多洛米蒂，或上传时附了深度图的上传壁纸。
export function wpHasDepth(id) {
  if (BUILTIN.spatial.includes(id)) return true;
  const up = uploadItem(id);
  return !!(up && up.hasDepth);
}
export function wpDepthUrl(id) {
  if (BUILTIN.spatial.includes(id)) return ovUrl(WPLIB[id].depth);
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
