// 工作空间 · 桌面版（FilesDesktop）的纯展示件：绝对路径换算、可执行类型名单、日期 / 种类文案、类型图标、两个输入框动作。
import { isEn, locale, t } from '../../../lib/i18n.js';
import { extOf, officeCat } from '../../../lib/fileKinds.js';
import { typeIconSvg } from '../../../lib/fileGrid.js';
import { kindOf } from '../../../lib/files/common.js';

// —— 绝对路径（Windows 盘符 / UNC / POSIX 三种形态）——
export const isWinAbs = (p) => /^[A-Za-z]:|^\\\\/.test(String(p || ''));
export const sepOf = (p) => (isWinAbs(p) ? '\\' : '/');
// 统一分隔符、去掉尾分隔符（'E:\' → 'E:'，'/' → ''）；比较用 foldAbs（Windows 不分大小写）
export const normAbs = (p) => { const s = String(p || ''); return (isWinAbs(s) ? s.replace(/\//g, '\\') : s).replace(/[\\/]+$/, ''); };
export const foldAbs = (p) => { const s = normAbs(p); return isWinAbs(s) ? s.toLowerCase() : s; };
// 盘根 'E:\' 直接去掉尾分隔符会变成 'E:'（Windows 上那是「E 盘当前目录」），所以只在没有尾分隔符时才补
export function joinPath(base, rel) {
  const b = String(base || ''), sep = sepOf(b);
  const r = String(rel || '').split(/[\\/]+/).filter(Boolean).join(sep);
  if (!r) return b;
  return /[\\/]$/.test(b) ? b + r : b + sep + r;
}
// target 在 root 之内 → root 相对路径（'/' 分隔，''=就是根）；不在 → null
export function relUnder(root, target) {
  const r = foldAbs(root), tg = foldAbs(target), sep = sepOf(target);
  if (tg === r) return '';
  if (!tg.startsWith(r + sep)) return null;
  return normAbs(target).slice(normAbs(root).length + 1).split(/[\\/]+/).filter(Boolean).join('/');
}
// 绝对路径拆成地址栏各段：[{ label, abs }]，首段是盘符 / UNC 共享 / '/'
export function splitAbs(abs) {
  const a = String(abs || '');
  if (!isWinAbs(a)) {
    const parts = a.split('/').filter(Boolean);
    return [{ label: '/', abs: '/' }, ...parts.map((p, i) => ({ label: p, abs: '/' + parts.slice(0, i + 1).join('/') }))];
  }
  const norm = normAbs(a);
  const unc = norm.match(/^\\\\[^\\]+\\[^\\]+/);
  const head = unc ? unc[0] : norm.slice(0, 2).toUpperCase();
  const parts = norm.slice(head.length).split('\\').filter(Boolean);
  return [{ label: head, abs: unc ? head : head + '\\' }, ...parts.map((p, i) => ({ label: p, abs: head + '\\' + parts.slice(0, i + 1).join('\\') }))];
}
export const baseName = (p) => normAbs(p).split(/[\\/]/).filter(Boolean).pop() || String(p || '');
export function addrFocus(node) { node.focus(); node.select(); }
// 双击不直接运行的可执行类型（右键仍可显式「用默认应用打开」）——这是安全名单，不是类型词表
export const EXEC_EXTS = ['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'lnk'];
// 重命名输入框：自动聚焦并选中主文件名（不含扩展名），键盘事件不外泄给全局快捷键。
// 选区要等一拍：use: 先于 bind:value 执行，此刻 value 还是空串，当场 setSelectionRange 等于什么都没选，
// 随后填值光标落到末尾——F2 改名 / 新建后键入就成了在旧名后面追加（「未命名.md周报」）。
export function renameInput(node) {
  node.focus();
  queueMicrotask(() => {
    if (document.activeElement !== node) return;
    const dot = node.value.lastIndexOf('.');
    node.setSelectionRange(0, dot > 0 ? dot : node.value.length);
  });
}
// 日期交给 Intl（按界面语言）：中文仍是「9月28日 15:04 / 2025/09/28 15:04 / 2025年9月28日 15:04」，
// 英文按 GLOSSARY §1.9 出 12 小时制「Sep 28, 3:04 PM / Sep 28, 2025, 3:04 PM」。
export const dtf = (d, o) => new Intl.DateTimeFormat(locale(), o).format(d);
export function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date(), en = isEn();
  const p = (n) => String(n).padStart(2, '0');
  const hm = en ? dtf(d, { hour: 'numeric', minute: '2-digit' }) : `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return t('今天 {time}', { time: hm });
  const yd = new Date(now); yd.setDate(now.getDate() - 1);
  if (d.toDateString() === yd.toDateString()) return t('昨天 {time}', { time: hm });
  const sameYear = d.getFullYear() === now.getFullYear();
  if (en) return dtf(d, { ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return dtf(d, sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' + hm;
}
export function fmtFull(ms) {
  if (!ms) return '—';
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  if (isEn()) return dtf(d, { dateStyle: 'medium', timeStyle: 'short' });
  return dtf(d, { year: 'numeric', month: 'long', day: 'numeric' }) + ` ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 「类型」列：扩展名 + 类别（PNG 图片 / PNG image）；英文语序与中文一致但要小写名词，故每类一个带 {ext} 的键
export const KIND_LABEL = {
  img: (ext) => t('{ext} 图片', { ext }),
  mov: (ext) => t('{ext} 视频', { ext }),
  audio: (ext) => t('{ext} 音频', { ext }),
  pdf: () => t('PDF 文稿'),
  zip: (ext) => t('{ext} 压缩归档', { ext }),
  md: (ext) => (isEn() ? t('Markdown 文件') : `${ext} Markdown`),   // 中文仍是「MD Markdown」；英文「MD Markdown」读着像重复，改用 Windows 口吻的类型名（110px 类型列放得下）
  text: (ext) => t('{ext} 文本', { ext }),
  html: (ext) => t('{ext} 网页', { ext }),
  apk: (ext) => t('{ext} 安装包', { ext }),
};
// Office 三类按 Windows / Finder 的口吻叫「Word 文稿」「Excel 表格」「PPT 演示文稿」；OpenDocument / RTF 不是微软格式，前面挂扩展名
export const MS_OFFICE = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
export const OFFICE_LABEL = {
  word: (ms, ext) => (ms ? t('Word 文稿') : t('{ext} 文稿', { ext })),
  sheet: (ms, ext) => (ms ? t('Excel 表格') : t('{ext} 表格', { ext })),
  slides: (ms, ext) => (ms ? t('PPT 演示文稿') : t('{ext} 演示文稿', { ext })),
};
export function typeLabel(it) {
  if (it.isDir) return t('文件夹');
  const ext = extOf(it.name);
  if (!ext) return t('文件');
  const oc = officeCat(it.name);
  if (oc && OFFICE_LABEL[oc]) return OFFICE_LABEL[oc](MS_OFFICE.has(ext), ext.toUpperCase());
  const lb = KIND_LABEL[kindOf(it.name)];
  return lb ? lb(ext.toUpperCase()) : t('{ext} 文件', { ext: ext.toUpperCase() });
}
// 类型图标（缩略图 / 系统图标到位前的占位）：与查看器同一家线稿（lib/fileGrid.js），颜色跟文字走，不按类型上色
export const fileIcon = (name) => typeIconSvg(name);
