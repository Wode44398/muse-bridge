// Media Studio 的线稿资产（v2「墨与象牙」，方案 §5.2）：24 网格、1.6 描边、圆头圆角，
// 与设置页 lib/settingsIcons.js 同一家族。只用 currentColor——种类不靠颜色区分，靠字形和文字。

export const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ——— 种类字形（侧栏缩略图、托盘、菜单、设置页的种类行共用） ——— */
export const KIND = {
  // 图像：画框 + 一道地平线 + 日轮
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><path d="M3.8 15.6l4.4-4.2a1.5 1.5 0 0 1 2.1 0l6.1 6.1"/><circle cx="15.6" cy="9.4" r="1.5"/>',
  // 视频：画框 + 播放三角
  video: '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><path d="M10.2 9.3v5.4l4.6-2.7z"/>',
  // 配音：气泡 + 三道声波
  voice: '<path d="M7 4.5h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-5.2l-4.3 3.3v-3.3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z"/><path d="M9 9.2v2.6M12 8v5M15 9.2v2.6"/>',
  // 音乐：一对八分音符
  music: '<path d="M9 17.5V6.6l10-2.1v10.9"/><circle cx="6.8" cy="17.5" r="2.2"/><circle cx="16.8" cy="15.4" r="2.2"/><path d="M9 9.6l10-2.1"/>',
};
/** 作品 / 任务 / 目录的任意一种 kind 叫法 → 种类字形 */
export function kindGlyph(kind) {
  const k = { speech: 'voice', audio: 'voice', tts: 'voice' }[kind] || kind;
  return KIND[k] || KIND.image;
}

/* ——— 界面图标 ——— */
const I = {
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  side: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M9.5 4.5v15"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  gear: '<path d="M12.22 2.75h-.44a1.9 1.9 0 0 0-1.9 1.9v.17a1.9 1.9 0 0 1-.95 1.64l-.41.24a1.9 1.9 0 0 1-1.9 0l-.14-.08a1.9 1.9 0 0 0-2.6.7l-.21.36a1.9 1.9 0 0 0 .7 2.6l.14.09a1.9 1.9 0 0 1 .95 1.63v.49a1.9 1.9 0 0 1-.95 1.65l-.14.08a1.9 1.9 0 0 0-.7 2.6l.21.36a1.9 1.9 0 0 0 2.6.7l.14-.08a1.9 1.9 0 0 1 1.9 0l.41.24a1.9 1.9 0 0 1 .95 1.64v.17a1.9 1.9 0 0 0 1.9 1.9h.44a1.9 1.9 0 0 0 1.9-1.9v-.17a1.9 1.9 0 0 1 .95-1.64l.41-.24a1.9 1.9 0 0 1 1.9 0l.14.08a1.9 1.9 0 0 0 2.6-.7l.21-.37a1.9 1.9 0 0 0-.7-2.6l-.14-.08a1.9 1.9 0 0 1-.95-1.65v-.48a1.9 1.9 0 0 1 .95-1.65l.14-.08a1.9 1.9 0 0 0 .7-2.6l-.21-.36a1.9 1.9 0 0 0-2.6-.7l-.14.08a1.9 1.9 0 0 1-1.9 0l-.41-.24a1.9 1.9 0 0 1-.95-1.64v-.17a1.9 1.9 0 0 0-1.9-1.9z"/><circle cx="12" cy="12" r="2.8"/>',
  tray: '<path d="M4 13.5h4.2l1.3 2.5h5l1.3-2.5H20"/><path d="M5.5 6.5h13L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-4.5z"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  chevR: '<path d="m9.5 6 6 6-6 6"/>',
  up: '<path d="M12 18.5V6M6.5 11.5 12 6l5.5 5.5"/>',
  search: '<circle cx="11" cy="11" r="6.2"/><path d="m15.6 15.6 4 4"/>',
  more: '<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  sliders: '<path d="M4 8h8.5M17.5 8H20M4 16h2.5M11.5 16H20"/><circle cx="15" cy="8" r="2.5"/><circle cx="9" cy="16" r="2.5"/>',
  folder: '<path d="M3.5 7.6A2.6 2.6 0 0 1 6.1 5h3.1c.5 0 1 .2 1.3.6l1.3 1.5h6.1a2.6 2.6 0 0 1 2.6 2.6v7.7a2.6 2.6 0 0 1-2.6 2.6H6.1a2.6 2.6 0 0 1-2.6-2.6z"/><path d="M3.5 10.5h17"/>',
  device: '<rect x="6.5" y="3" width="11" height="18" rx="2.8"/><path d="M10.5 18h3"/>',
  download: '<path d="M12 4.5v10M8 10.5l4 4 4-4"/><path d="M4.5 16.5v1a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-1"/>',
  trash: '<path d="M5 7h14M10 4h4"/><path d="M7 7l.8 11.2a2 2 0 0 0 2 1.8h4.4a2 2 0 0 0 2-1.8L17 7"/>',
  open: '<rect x="4" y="4" width="16" height="16" rx="2.6"/><path d="M9 15l6-6M10.5 9H15v4.5"/>',
  save: '<path d="M3.5 7.6A2.6 2.6 0 0 1 6.1 5h3.1c.5 0 1 .2 1.3.6l1.3 1.5h6.1a2.6 2.6 0 0 1 2.6 2.6v7.7a2.6 2.6 0 0 1-2.6 2.6H6.1a2.6 2.6 0 0 1-2.6-2.6z"/><path d="M12 10.5v6M9.5 14l2.5 2.5 2.5-2.5"/>',
  reveal: '<path d="M3.5 7.6A2.6 2.6 0 0 1 6.1 5h3.1c.5 0 1 .2 1.3.6l1.3 1.5h6.1a2.6 2.6 0 0 1 2.6 2.6v7.7a2.6 2.6 0 0 1-2.6 2.6H6.1a2.6 2.6 0 0 1-2.6-2.6z"/><circle cx="12" cy="13.6" r="2.2"/><path d="m13.6 15.2 1.9 1.9"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  swap: '<path d="M16 4.5l3.5 3.5-3.5 3.5M19.5 8H8M8 19.5 4.5 16 8 12.5M4.5 16H16"/>',
  warn: '<path d="M12 9v4.5"/><path d="M12 16.6h.01" stroke-width="2.2"/><path d="M10.3 4.6 3.6 16.3a2 2 0 0 0 1.7 3h13.4a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"/>',
  arrowUR: '<path d="M8 16 16 8M9.5 8H16v6.5"/>',
  reload: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19.5 4.5v4h-4"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.4"/><path d="M8.8 8.8h.01M15.2 15.2h.01M15.2 8.8h.01M8.8 15.2h.01M12 12h.01" stroke-width="2.3"/>',
  play: '<path d="M8 5.8v12.4L18.2 12z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.8" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.6" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor" stroke="none"/>',
  edit: '<path d="M14.5 5.5l4 4L9 19H5v-4z"/><path d="M12.5 7.5l4 4"/>',
  ref: '<rect x="3.5" y="8" width="11.5" height="11.5" rx="2.4"/><path d="M8.5 4.5h8.6a2.4 2.4 0 0 1 2.4 2.4v8.6"/>',
  first: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="M8.5 5.5v13"/>',
  last: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="M15.5 5.5v13"/>',
  text: '<path d="M5 6.5h14M5 11h14M5 15.5h9"/>',
  audio: '<path d="M4.5 10v4M8.2 7.5v9M12 5v14M15.8 8.5v7M19.5 11v2"/>',
  dock: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M14.5 4.5v15"/>',
  reuse: '<path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/><path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4.5 15"/><path d="M4.5 19.5V15H9"/>',
  next: '<path d="M5.5 5.5v6.5a3 3 0 0 0 3 3h10"/><path d="M15 11.5l3.5 3.5-3.5 3.5"/>',
};
/** 线稿图标的 SVG 字串（sz：边长 px，默认跟随 CSS） */
export function icon(name, sz) {
  const body = I[name] || KIND[name] || '';
  const s = sz ? ` width="${sz}" height="${sz}"` : '';
  return `<svg viewBox="0 0 24 24"${s} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
/* ——— Studio 标「错拍」（web/public/assets/icons/studio-mono.svg 的简化重绘：拱 + 水面 + 错开半拍的倒影弧）———
   给作品栏栏头 22px 用；只用 currentColor（深浅两套自动跟墨走）。几何取自 scripts/brand/studio-mark.cjs 出的 64px 图标。 */
export const MARK = '<svg viewBox="21.9 22.4 61.2 61.2" aria-hidden="true">'
  + '<path fill="currentColor" d="M25.693 55A17.7 17.7 0 0 1 61.093 55H55.593A12.2 12.2 0 0 0 31.193 55Z"/>'
  + '<path fill="currentColor" d="M24.4 54.43Q54 53.62 83.6 54.43a.575.575 0 0 1 0 1.15Q54 56.38 24.4 55.57a.575.575 0 0 1 0-1.15Z"/>'
  + '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".6" d="M58.66 57.75A11.96 11.96 0 0 0 81.56 59.05"/>'
  + '</svg>';

/** 角色 → 图标名（素材角标、落点槽、添加素材层） */
export const ROLE_ICON = { edit: 'edit', ref: 'ref', first: 'first', last: 'last', audio: 'audio', video: 'video', text: 'text' };

/* ——— 画布空态线稿（120×80 视口、1.25 描边、圆头）———
   四幅同一母题：同一个画框（71×49、圆角 6，居中），框里放这种媒介自己的东西；坐标都落在半像素上，线宽一致。
   图像＝地平线与日轮；视频＝播放三角 + 框底一条带播放头的时间线；配音＝三行字过渡成一排声波；音乐＝五线谱上一道正弦。 */
const FRAME = '<rect x="24.5" y="12.5" width="71" height="49" rx="6"/>';
const ART = {
  // 内部线条一律离框内缘 ≥6px、单色（不用第二种灰），粗细只用来分主次
  image: FRAME + '<path d="M30.5 52.5L42 42l9 7.5 8.5-7 30 12"/><circle cx="77.5" cy="27.5" r="4"/>',
  video: FRAME + '<path d="M55.5 26.5v14l11.5-7z"/><path d="M32.5 52.5h55" stroke-width=".75"/><path d="M32.5 52.5h17" stroke-width="2.25"/><path d="M49.5 49.5v6"/>',
  voice: FRAME + '<path d="M33.5 29.5h18M33.5 37h13M33.5 44.5h16"/><path d="M62.5 34.5v5M68.5 29.5v15M74.5 24.5v25M80.5 31.5v11M86.5 35.5v3"/>',
  music: FRAME + '<path d="M30.5 25h59M30.5 31h59M30.5 37h59M30.5 43h59M30.5 49h59" stroke-width=".75"/><path d="M32.25 37C36.85 37 36.9 26.5 41.5 26.5C50.75 26.5 50.75 47.5 60 47.5C69.25 47.5 69.25 26.5 78.5 26.5C83.1 26.5 83.15 37 87.75 37"/>',
};
export function art(page) {
  return `<svg viewBox="0 0 120 80" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ART[page] || ''}</svg>`;
}

/** 比例值（「16:9」）→ 一个按比例缩放的发丝矩形，放在比例格子里 */
export function aspectBox(v, max = 14) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(v || ''));
  if (!m) return '';
  const a = Number(m[1]), b = Number(m[2]);
  if (!(a > 0 && b > 0)) return '';
  const w = a >= b ? max : Math.max(3, Math.round((max * a) / b));
  const h = b >= a ? max : Math.max(3, Math.round((max * b) / a));
  return `<svg viewBox="0 0 ${max + 2} ${max + 2}" width="${max + 2}" height="${max + 2}" aria-hidden="true"><rect x="${1 + (max - w) / 2}" y="${1 + (max - h) / 2}" width="${w}" height="${h}" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
}
export const isAspect = (v) => /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(String(v || ''));
