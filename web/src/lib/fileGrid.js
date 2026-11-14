// 文件列表的显示方式与网格（手机 FilesPanel、电脑 FilesDesktop 共用的一套）：
//   · 视图偏好：列表 / 图标 / 大图标，全局一份；相册类文件夹（DCIM、截图……或以图片视频为主）另记一份、缺省图标视图
//   · 排序偏好：键 + 方向，规则见 files-business.js makeFileComparator（两端与画廊同序）
//   · /api/files/meta 补充元数据（图片宽高、视频时长、文件夹项目数）：先渲染列表，再分批补；没算完的隔一会儿再要
//   · 打开文件时的序列：同文件夹图片与视频按列表顺序组成一个画廊，文档组成前后翻页序列，音频自成一组
//   · 类型线稿图标：同 viewerIcons 一家（24 网格、1.6 描边、只用 currentColor），缺的在这里补画
import { kindOf, iconKindOf } from './fileKinds.js';
import { VI } from './viewerIcons.js';
import { normalizeSort } from './files-business.js';

// —— 时长 1:23 / 1:02:03 ——
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// —— 视图偏好 ——
export const VIEW_MODES = Object.freeze(['list', 'grid', 'large']);
const VIEW_KEY = 'bridge.files.view';
const SORT_KEY = 'bridge.files.sort';
const okMode = (m) => VIEW_MODES.includes(m);
const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };

/** { view: 'list'|'grid'|'large', album: null|'list'|'grid'|'large' } */
export function loadViewPrefs() {
  try {
    const raw = JSON.parse(store()?.getItem(VIEW_KEY) || 'null');
    return { view: okMode(raw?.view) ? raw.view : 'list', album: okMode(raw?.album) ? raw.album : null };
  } catch { return { view: 'list', album: null }; }
}
export function saveViewPrefs(prefs) {
  try { store()?.setItem(VIEW_KEY, JSON.stringify({ view: prefs.view, album: prefs.album })); } catch {}
}
/** 这个文件夹该用哪种显示方式：相册类有自己的那一份，没记过时普通档是列表就给图标、否则沿用 */
export function viewFor(prefs, album) {
  if (!album) return prefs.view;
  return prefs.album ?? (prefs.view === 'list' ? 'grid' : prefs.view);
}
/** 在当前文件夹里切到 mode：相册类文件夹记进 album，其余记进全局 view */
export function withView(prefs, mode, album) {
  if (!okMode(mode)) return prefs;
  return album ? { ...prefs, album: mode } : { ...prefs, view: mode };
}

export function loadSortPref(fallback) {
  try { return normalizeSort(JSON.parse(store()?.getItem(SORT_KEY) || 'null'), fallback); } catch { return normalizeSort(null, fallback); }
}
export function saveSortPref(sort) {
  try { store()?.setItem(SORT_KEY, JSON.stringify({ key: sort.key, dir: sort.dir })); } catch {}
}

// —— 相册类文件夹：按名字（相机 / 截图 / 图片这类）或按内容（文件里至少 6 个、且六成以上是图片视频）——
const ALBUM_NAME = /^(dcim|camera|pictures?|photos?|screenshots?|screen ?recordings?|wallpapers?|gallery|相册|相机|照片|图片|截图|截屏|录屏|壁纸|图库)$/i;
export function isAlbumDir(dirName, items) {
  if (ALBUM_NAME.test(String(dirName || '').trim())) return true;
  let files = 0, media = 0;
  for (const it of items || []) {
    if (!it || it.isDir) continue;
    files++;
    const k = kindOf(it.name);
    if (k === 'image' || k === 'video') media++;
  }
  return media >= 6 && media >= files * 0.6;
}

// —— 补充元数据：fetcher() → { items: { 名字: { w, h, dur, n } }, pending }；pending>0 时隔 interval 再要，最多 tries 次。
// 返回停止函数（换目录 / 卸载时调；停了之后到货的结果直接丢弃）。
export function watchMeta(fetcher, onItems, { interval = 800, tries = 8 } = {}) {
  let stopped = false, timer = 0, n = 0;
  const tick = async () => {
    let r = null;
    try { r = await fetcher(); } catch {}
    if (stopped || !r) return;
    if (r.items && typeof r.items === 'object') onItems(r.items);
    if (r.pending > 0 && ++n < tries) timer = setTimeout(tick, interval);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

// —— 服务端列表缩略图能出哪些 ——
// 图片、视频两档都出；PDF 与 Office 首页、音频内嵌封面、TIFF 只在图标视图要（列表行的小图标犯不上为每个文稿起一次转换）。
// 失败一律 404，调用方退回类型线稿图标。
export const GRID_THUMB_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'mp3', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'tif', 'tiff']);
export function cloudThumbable(name, grid = false) {
  const k = kindOf(name);
  if (k === 'image' || k === 'video') return true;
  if (!grid) return false;
  const s = String(name || ''), i = s.lastIndexOf('.');
  return i > 0 && GRID_THUMB_EXT.has(s.slice(i + 1).toLowerCase());
}

// —— 打开文件时的序列 ——
/** 预览分组：'media'（图片 + 视频混合画廊）/ 'audio' / 'doc'（其余有内嵌查看器的）/ ''（没有查看器，单独处理） */
export function previewGroupOf(name) {
  const k = kindOf(name);
  if (k === 'image' || k === 'video') return 'media';
  if (k === 'audio') return 'audio';
  if (k === 'other') return '';
  return 'doc';
}
/** 在 list（已按当前排序、可见的那一份）里取 target 所在的那一组，返回 { seq, index }；accept(item) 可再筛一道 */
export function buildSequence(list, target, { groupOf = previewGroupOf, accept = null, same = (a, b) => a === b } = {}) {
  const g = groupOf(target?.name || '');
  if (!g) return { seq: [target], index: 0 };
  const seq = [];
  let index = -1;
  for (const f of list || []) {
    if (!f || f.isDir || groupOf(f.name) !== g) continue;
    const hit = same(f, target);
    if (!hit && accept && !accept(f)) continue;
    if (hit) index = seq.length;
    seq.push(f);
  }
  if (index < 0) return { seq: [target], index: 0 };
  return { seq, index };
}

/** 元素在视口里的矩形（查看器从它放大进入、关闭缩回）；完全不在视口 / 被 clip 容器挡住时给 null */
export function rectOf(el, clip = null) {
  if (!el?.getBoundingClientRect) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  const vw = globalThis.innerWidth || 0, vh = globalThis.innerHeight || 0;
  let top = 0, bottom = vh, left = 0, right = vw;
  if (clip?.getBoundingClientRect) {
    const c = clip.getBoundingClientRect();
    top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); left = Math.max(left, c.left); right = Math.min(right, c.right);
  }
  if (r.bottom <= top || r.top >= bottom || r.right <= left || r.left >= right) return null;
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

// —— 类型线稿图标（iconKindOf 的分类 → 24 网格线稿）——
const PAGE = '<path d="M7 3.75h6.6l4.65 4.65V18a2.25 2.25 0 0 1-2.25 2.25H7A2.25 2.25 0 0 1 4.75 18V6A2.25 2.25 0 0 1 7 3.75Z"/><path d="M13.5 3.9V8.5h4.6"/>';
export const FI = {
  dir: VI.folder,
  image: VI.image,
  video: VI.video,
  audio: VI.audio,
  sheet: VI.table,
  slide: VI.slides,
  html: VI.globe,
  code: VI.code,
  file: VI.file,
  pdf: PAGE + '<rect x="7.75" y="13.25" width="6.5" height="4" rx="1.1"/>',
  doc: PAGE + '<path d="M8 12.5h6.75M8 15.25h6.75M8 18h4"/>',
  text: PAGE + '<path d="M8 13h6.75M8 16.25h4.5"/>',
  md: PAGE + '<path d="M7.75 17.5v-4.75l1.9 2.2 1.9-2.2v4.75"/><path d="M15 12.75v4.75M13.5 16l1.5 1.5 1.5-1.5"/>',
  zip: '<rect x="4.75" y="3.75" width="14.5" height="16.5" rx="2.4"/><path d="M12 3.75v1.6M12 7.1v1.6M12 10.45v1.6"/><rect x="10.25" y="13.75" width="3.5" height="3.75" rx="1"/>',
  font: '<path d="M3.75 18.5 8.5 6l4.75 12.5M5.6 14h5.8"/><circle cx="17.25" cy="15.75" r="2.75"/><path d="M20 12.5v6"/>',
  book: '<path d="M5.25 18.5V6a2.25 2.25 0 0 1 2.25-2.25h11.25v13H7.5a2.25 2.25 0 0 0-2.25 2.25Zm0 0a1.75 1.75 0 0 0 1.75 1.75h11.75"/><path d="M9.25 8h5.5"/>',
  design: '<path d="M12 3.75 17.75 9.5l-2.25 7.25h-7L6.25 9.5Z"/><path d="M12 3.75v6.25"/><circle cx="12" cy="11.5" r="1.5"/><path d="M8.5 20.25h7"/>',
  app: '<rect x="4.5" y="4.5" width="15" height="15" rx="4.25"/><path d="M9.25 12h5.5M12 9.25v5.5"/>',
};
// 菜单与工具栏里额外要的几个
export const FGI = {
  list: '<path d="M8.75 6.5h10.5M8.75 12h10.5M8.75 17.5h10.5"/><path d="M4.75 6.5h.01M4.75 12h.01M4.75 17.5h.01" stroke-width="2.3"/>',
  grid: '<rect x="4" y="4" width="4.5" height="4.5" rx="1.2"/><rect x="9.75" y="4" width="4.5" height="4.5" rx="1.2"/><rect x="15.5" y="4" width="4.5" height="4.5" rx="1.2"/><rect x="4" y="9.75" width="4.5" height="4.5" rx="1.2"/><rect x="9.75" y="9.75" width="4.5" height="4.5" rx="1.2"/><rect x="15.5" y="9.75" width="4.5" height="4.5" rx="1.2"/><rect x="4" y="15.5" width="4.5" height="4.5" rx="1.2"/><rect x="9.75" y="15.5" width="4.5" height="4.5" rx="1.2"/><rect x="15.5" y="15.5" width="4.5" height="4.5" rx="1.2"/>',
  large: VI.thumbs,
  sortUp: '<path d="M12 19V5.5M6.75 10.25 12 5l5.25 5.25"/>',
  sortDown: '<path d="M12 5v13.5M6.75 13.75 12 19l5.25-5.25"/>',
  eye: '<path d="M2.75 12S6 5.75 12 5.75 21.25 12 21.25 12 18 18.25 12 18.25 2.75 12 2.75 12Z"/><circle cx="12" cy="12" r="2.75"/>',
  eyeOff: '<path d="M2.75 12S6 5.75 12 5.75 21.25 12 21.25 12 18 18.25 12 18.25 2.75 12 2.75 12Z"/><circle cx="12" cy="12" r="2.75"/><path d="M4.5 4.5l15 15"/>',
  preview: '<path d="M2.75 12S6 5.75 12 5.75 21.25 12 21.25 12 18 18.25 12 18.25 2.75 12 2.75 12Z"/><circle cx="12" cy="12" r="2.75"/>',
  pane: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M14.5 4.5v15"/>',
};
const svg = (inner, stroke = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
/** 类型图标的完整 SVG 串（{@html} 用） */
export function typeIconSvg(name, { isDir = false, stroke = 1.6 } = {}) {
  const k = iconKindOf(name, { isDir });
  return svg(FI[k] || FI.file, stroke);
}
export function uiIconSvg(key, stroke = 1.6) { return FGI[key] ? svg(FGI[key], stroke) : ''; }
/** 格子里的两行名字：转义后在连接符（- _ . ~ + · ，、）后面插 <wbr>，
 *  「超高-1080x8000.jpg」这类中英数混排就在「-」「.」处折行，而不是在第一个汉字后面断开、头一行只剩一个字；
 *  没有分隔符的长串仍靠 CSS overflow-wrap:anywhere 逐字断。<wbr> 不进 textContent，复制 / 查找不受影响。 */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function nameHtml(name) {
  return String(name ?? '').replace(/[&<>"']/g, (c) => ESC[c]).replace(/([-_.~+·，、])(?=[^\s])/g, '$1<wbr>');
}
/** 格子里类型图标下面那行小字（扩展名，最多 4 个字母）；没有扩展名给空 */
export function extBadge(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i + 1).toUpperCase().slice(0, 4) : '';
}
