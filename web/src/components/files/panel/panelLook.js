// 工作空间（手机 FilesPanel）的纯展示件：线稿字形、位置名与字形、绝对路径换算、日期 / 大小 / 种类文案、传输行文案、文件图标。
import { locale, t, tr } from '../../../lib/i18n.js';
import { fmtSize, kindOf } from '../../../lib/files/common.js';

export const G = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/></svg>',
  folderAdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>',
  zip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4h7A1.5 1.5 0 0 1 17 5.5V7"/><path d="M12 11v5M12 16l-2.2-2.2M12 16l2.2-2.2"/></svg>',
  reveal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7h7l2 2h8v10h-17z"/><path d="M12 12v4M10 14h4"/></svg>',
  select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5 11 15.5 16.5 9.5"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.8 19a4.6 4.6 0 0 1-.6-9.16 5.8 5.8 0 0 1 11.2-1.32A4.9 4.9 0 0 1 16.6 19H6.8Z"/></svg>',
  pcAdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h16v13H4z"/><path d="M8 3v3M16 3v3M12 10v5M9.5 12.5h5"/></svg>',
  remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
};
// 「发送给 AI」各目标的小图标（白字形，垫在 kit 彩色圆角方块上，同设置页 IconTile）
// Media Studio 用自己的 App 瓦片：暖墨方块 + 象牙标（同 assets/icons/studio.svg，scripts/brand/studio-mark.cjs）
export const STUDIO_TILE = 'linear-gradient(#282521, #0f0e0c)';
export const AI_IC = {
  claude: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2.5l2 6.1 6.1 1.9-6.1 2L12 18.5l-2-6 -6.1-2 6.1-1.9z"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.2l4.6 2.8L10 14.8z" fill="#fff" stroke="none"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.5" fill="#fff" stroke="none"/><path d="M4 16.5l5-4 4 3 3-2 4 3"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"><path d="M5 10v4M9 7.5v9M13 9v6M17 6v12M21 10v4"/></svg>',
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="2.6" fill="#fff" stroke="none"/><circle cx="17" cy="16" r="2.6" fill="#fff" stroke="none"/></svg>',
  first: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7.5 5.5v13" stroke-width="2.6"/></svg>',
  last: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M16.5 5.5v13" stroke-width="2.6"/></svg>',
  ref: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg>',
};
// target 在 root 之内 → root 相对路径（'/' 分隔，''＝就是根）；不在 → null。Windows 路径不分大小写
export function relUnderAbs(root, target) {
  const win = /^([a-z]:|\\\\)/i.test(String(root || ''));
  const norm = (p) => { const s = String(p || ''); return (win ? s.replace(/\//g, '\\') : s).replace(/[\\/]+$/, ''); };
  const cmp = (s) => (win ? s.toLowerCase() : s);
  const r = norm(root), tg = norm(target);
  if (cmp(tg) === cmp(r)) return '';
  if (!cmp(tg).startsWith(cmp(r) + (win ? '\\' : '/'))) return null;
  return tg.slice(r.length + 1).split(/[\\/]+/).filter(Boolean).join('/');
}
// 绝对路径落进哪个位置：取最深的那个（D:\Notes\x 落「工作空间」，不落 E:\）
export function resolveStart(list, abs) {
  let best = null;
  for (const loc of list || []) {
    const rel = relUnderAbs(loc.path, abs);
    if (rel != null && (!best || String(loc.path).length > String(best.loc.path).length)) best = { loc, rel };
  }
  return best;
}
export const locLabel = (l) => (/^drive-/.test(l?.id || '') ? t('{d} 盘', { d: String(l.name || '').replace(/:$/, '') }) : tr(l?.name || ''));
export const LOC_GLYPH = {
  ws: '<path d="M4 11.2 12 4l8 7.2"/><path d="M6 10v9h12v-9"/>',
  home: '<circle cx="12" cy="8.4" r="3.4"/><path d="M5.2 19.5c.9-3.4 3.5-5.2 6.8-5.2s5.9 1.8 6.8 5.2"/>',
  drive: '<rect x="3.5" y="6.5" width="17" height="11" rx="2.6"/><path d="M7.2 13.6h.01M10.6 13.6h6.2"/>',
  dir: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/>',
};
export const locGlyph = (l) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${LOC_GLYPH[l?.id === 'ws' ? 'ws' : l?.id === 'home' ? 'home' : /^drive-/.test(l?.id || '') ? 'drive' : 'dir']}</svg>`;
// Windows 形态的完整路径（简介里给人看的），盘根 'C:\' 拼子路径不能先剥尾分隔符
export const winAbs = (root, rel) => (rel ? (/[\\/]$/.test(root) ? root : root + '\\') + rel : root).replace(/\//g, '\\');
export const rootIcon = (mode) => (mode === 'all' ? PHONE_GLYPH : FOLDER_GLYPH);
export const FICON = {
  apk: '#34c759', md: '#8e8e93', text: '#8e8e93', doc: '#8e8e93', pdf: '#ff383c',
  zip: '#ff8d28', mov: '#6d7cff', img: '#0088ff', audio: '#ff2d55',
};
export const iconColor = (name) => FICON[kindOf(name)] || '#8e8e93';
// 格式器按需建一次复用（fmtTime 每行文件都调；切语言会整页重载，locale 运行期不变）
export const DTF = {};
export const dtf = (k, o) => (DTF[k] ??= new Intl.DateTimeFormat(locale(), o));
export function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  // 中文输出与原先一致：「09:05」「9月28日」；英文「9:05 AM」「Sep 28」
  if (sameDay) return dtf('hm', { timeStyle: 'short' }).format(d);
  const yd = new Date(now); yd.setDate(now.getDate() - 1);
  if (d.toDateString() === yd.toDateString()) return t('昨天');
  return dtf('md', { month: 'short', day: 'numeric' }).format(d);
}
// 简介用：完整日期时间（中文「2026年9月28日 09:05」，英文「Sep 28, 2026, 9:05 AM」）
export function fmtFull(ms) {
  if (!ms) return '—';
  return dtf('full', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}
// 简介用：文件种类描述（按扩展名/类型）
// t() 在调用时取：模块加载时界面语言的字典未必已到
export const KIND_LABEL = () => ({ img: t('图片'), mov: t('视频'), audio: t('音频'), pdf: t('PDF 文稿'), zip: t('压缩归档'), md: t('Markdown 文稿'), text: t('文本文稿'), doc: t('文稿'), apk: t('安卓安装包') });
export function typeLabel(item) {
  if (item.isDir) return t('文件夹');
  const ext = (item.name.split('.').pop() || '').toUpperCase();
  const base = KIND_LABEL()[kindOf(item.name)] || t('文件');
  return item.name.includes('.') ? t('{kind}（.{ext}）', { kind: base, ext: ext.toLowerCase() }) : base;
}
// 传输行：第一行右侧＝百分比或终态；第二行＝「已传 / 总大小 · 实时速度」（排队/重连时换成说明，失败给原因）。
// 总大小未知（下载响应缺 content-length）时只显示已传字节，别出 NaN%。
export const pctOf = (tk) => (tk.total > 0 ? Math.min(100, Math.floor((tk.sent / tk.total) * 100)) : 0);
export const xferState = (tk) => tk.status === 'done' ? t('完成') : tk.status === 'error' ? t('失败') : tk.status === 'cancelled' ? t('已取消')
  : tk.total > 0 ? pctOf(tk) + '%' : '';
export function xferDetail(tk) {
  if (tk.status === 'error') return tk.error || '';
  if (tk.status === 'done') return tk.total > 0 ? fmtSize(tk.total) : '';
  if (tk.status === 'cancelled') return tk.total > 0 ? fmtSize(tk.total) : '';
  if (tk.note === 'queued') return t('排队中…');
  const amount = tk.total > 0 ? fmtSize(tk.sent) + ' / ' + fmtSize(tk.total) : fmtSize(tk.sent);
  if (tk.note === 'retry') return amount + ' · ' + t('网络不稳，重连中…');
  return amount + (tk.bps > 0 ? ' · ' + fmtSize(tk.bps) + '/s' : '');
}

// 「本地位置」行图标：文件夹（蓝）/ 整机存储（绿手机）
export const FOLDER_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="#0088ff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/></svg>';
export const PHONE_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M10.5 18.6h3"/></svg>';
export const PC_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M9 20.5h6M12 16.5v4"/></svg>';
export const GLYPH = {
  img: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><circle cx="9" cy="9.6" r="1.7"/><path d="m6 17 4.2-4.4 3 3 2.4-2.5 2.9 3.1"/>',
  mov: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="m10.3 9.5 4.4 2.5-4.4 2.5v-5Z" fill="#fff" stroke="none"/>',
  audio: '<path d="M9 17.5V6.8l9-2v10.7"/><circle cx="6.8" cy="17.5" r="2.3"/><circle cx="15.8" cy="15.5" r="2.3"/>',
  pdf: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/>',
  zip: '<rect x="4.5" y="6" width="15" height="13" rx="2.4"/><path d="M12 6v13" stroke-dasharray="2.4 2"/>',
  apk: '<rect x="7" y="3" width="10" height="18" rx="2.4"/><path d="M10.5 18h3"/>',
  md: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/>',
  text: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h4"/>',
  doc: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/>',
  dir: '<path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/>',
};
export const fileGlyph = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPH[k] || GLYPH.doc}</svg>`;

// iOS 文件 app 原版风文件图标：白色文档纸 + 右上折角 + 底部彩色类型标签条
export const TYPE_COLOR = { pdf: '#ff3b30', img: '#32ade6', mov: '#5856d6', audio: '#ff2d55', zip: '#ff9500', md: '#8e8e93', text: '#8e8e93', apk: '#34c759', doc: '#007aff' };
export function fileIcon(name) {
  const k = kindOf(name);
  const c = TYPE_COLOR[k] || '#007aff';
  const label = name.includes('.') ? (name.split('.').pop() || '').toUpperCase().slice(0, 4) : '';
  return `<svg viewBox="0 0 28 34" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 4a3 3 0 0 1 3-3h11.5L25 8.5V30a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V4Z" fill="#fff" stroke="#d6d6da" stroke-width="1"/>
    <path d="M17.5 1 25 8.5h-5.5A2 2 0 0 1 17.5 6.5V1Z" fill="#e6e6ea"/>
    <rect x="3" y="20.5" width="22" height="9.5" rx="2.6" fill="${c}"/>
    ${label ? `<text x="14" y="27.4" font-size="6" font-weight="700" letter-spacing="-.2" fill="#fff" text-anchor="middle" font-family="-apple-system,'SF Pro Text',sans-serif">${label}</text>` : ''}
  </svg>`;
}
