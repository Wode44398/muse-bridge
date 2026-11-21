// Antigravity 附件的外观纯逻辑：一个附件该画成「预览图瓦片」还是「类型卡」、类型卡用哪种字形与色系、
// 名字 / 扩展名 / 大小怎么写，以及把历史消息里服务端拼进用户原文的「本轮附加文件路径」前缀还原成附件。
// 零副作用（不碰 store / DOM），组件与测试都直接用。

import { iconKindOf, kindOf } from '../fileKinds.js';

// 类型卡的字形：Material Symbols 的图标名（页面的子集字体里要有，见 scripts/agy-symbols/fetch.py）。
// 原来是手绘的 24 画板线稿；键名没变（attLook 返回的 glyph 就是这里的键）。
export const ATT_ICON = {
  file: 'draft',
  doc: 'description',
  text: 'text_snippet',
  pdf: 'picture_as_pdf',
  sheet: 'table',
  slide: 'slideshow',
  code: 'code',
  audio: 'graphic_eq',
  video: 'movie',
  image: 'image',
  zip: 'folder_zip',
  folder: 'folder',
};

// 图标分类（fileKinds.iconKindOf）→ [字形, 色系]。只有文档 / 表格 / 演示 / PDF 带色（认类型用，同 Google 云端硬盘的四色），其余一律中性。
const FAMILY = {
  dir: ['folder', 'neutral'],
  doc: ['doc', 'blue'],
  md: ['doc', 'blue'],
  sheet: ['sheet', 'green'],
  slide: ['slide', 'yellow'],
  pdf: ['pdf', 'red'],
  text: ['text', 'neutral'],
  code: ['code', 'neutral'],
  html: ['code', 'neutral'],
  zip: ['zip', 'neutral'],
  audio: ['audio', 'neutral'],
  video: ['video', 'neutral'],
  image: ['image', 'neutral'],
};

const baseName = (p = '') => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return (x >= 100 || Number.isInteger(x) ? x.toFixed(0) : x.toFixed(1)) + ' ' + units[i];
}

// 附件 → 画法。media：'image' | 'video' | ''（空 = 画类型卡）；glyph / tone：类型卡左边那块；
// stem / ext：标题与扩展名分开（扩展名进副行）；size：有就带上。
export function attLook(att) {
  const a = att && typeof att === 'object' ? att : {};
  const name = String(a.name || '') || baseName(a.path) || '';
  const isDir = a.kind === 'folder' || a.isDir === true;
  const m = isDir ? null : /\.([^.\s\\/]{1,8})$/.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  const stem = m && m.index > 0 ? name.slice(0, m.index) : name;
  const icon = iconKindOf(name, { isDir, mime: a.mime || '' });
  const k = isDir ? 'other' : kindOf(name, a.mime || '');
  // 服务端 / 上传时标成图片的（粘贴的截图常常没有扩展名）也按图片画
  const media = isDir ? '' : (k === 'image' || a.kind === 'image' || a.isImage === true) ? 'image' : k === 'video' ? 'video' : '';
  const [glyph, tone] = FAMILY[icon] || ['file', 'neutral'];
  return { name, stem: stem || name, ext, isDir, media, glyph, tone, size: fmtBytes(a.size) };
}

// 类型卡副行：「PDF · 1.2 MB」；文件夹与没有扩展名的由调用方给词（要过 i18n）。
export function attMeta(look, { folderWord = '', fileWord = '' } = {}) {
  const head = look.isDir ? folderWord : (look.ext ? look.ext.toUpperCase() : fileWord);
  return [head, look.size].filter(Boolean).join(' · ');
}

// 预览图瓦片的宽高比：太瘦太扁的图收进一个范围（瓦片 object-fit: cover 裁边），拿不到尺寸用 fallback。
export function clampRatio(w, h, { min = 0.62, max = 2.1, fallback = 1.5 } = {}) {
  const r = Number(w) / Number(h);
  if (!Number.isFinite(r) || r <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(r * 1000) / 1000));
}

// 服务端把非图片附件写成提示词前缀（modules/agy/server/agents/agy.mjs buildPromptBlocks）：
//   本轮附加文件路径：\n- <路径>\n- <路径>\n\n<用户原文>
// 历史回放拿到的就是这段原文——还原成 { text, atts }，气泡里照样画附件，不把一串路径糊在话前面。
const ATTACHED_HEAD = '本轮附加文件路径：';   // i18n-ignore：服务端写进提示词的固定前缀，不是界面文案
export function splitAttachedPaths(text) {
  const s = String(text ?? '');
  if (!s.startsWith(ATTACHED_HEAD)) return { text: s, atts: [] };
  const lines = s.slice(ATTACHED_HEAD.length).split('\n');
  if (lines[0].trim() !== '') return { text: s, atts: [] };
  const atts = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.startsWith('- ')) break;
    const p = line.slice(2).trim();
    if (!p) break;
    // 上传目录里的存盘名带时间戳前缀（1795102601189-报告.pdf）：给人看的名字去掉它
    const name = (baseName(p) || p).replace(/^\d{10,}-(?=.)/, '');
    // 路径本身看不出是不是文件夹：没有扩展名、也不是 Dockerfile 这类认得的文件名的，当文件夹（用户拖进来的目录），点开在工作区里定位
    const isDir = !/\.[^.\s\\/]{1,8}$/.test(name) && iconKindOf(name) === 'file';
    atts.push({ path: p, name, kind: isDir ? 'folder' : (kindOf(name) === 'image' ? 'image' : 'file') });
  }
  if (!atts.length) return { text: s, atts: [] };
  return { text: lines.slice(i).join('\n').replace(/^\n+/, ''), atts };
}

const UPLOAD_FILE_RE = /[\\/]uploads[\\/]([^\\/]+)$/;
const LOCAL_URL_RE = /^(?:blob:|data:)/i;

function relInWorkspace(filePath = '', sessionCwd = '') {
  const nf = String(filePath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const nw = String(sessionCwd || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!nf || !nw) return null;
  const fold = (p) => (/^[A-Za-z]:(\/|$)/.test(p) ? p.toLowerCase() : p);
  const ff = fold(nf);
  const fw = fold(nw);
  if (ff.startsWith(fw + '/')) return nf.slice(nw.length + 1);
  return null;
}

// 输入栏草稿附件 → 统一查看器描述符（对标 Claude 页 Composer：图片优先本地 blob 零网络秒开，
// 视频已上传走 uploads 原件支持 Range 流、上传中或无 uploads 路径播本地 blob；其它非文件夹已上传文件亦可预览）
export function draftAttDescriptor(att, { sessionId = '', sessionCwd = '' } = {}) {
  if (!att || typeof att !== 'object') return null;
  const look = attLook(att);
  if (look.isDir) return null;

  const localUrl = LOCAL_URL_RE.test(att.url || '') ? att.url : '';
  const pathStr = typeof att.path === 'string' ? att.path : '';
  const uploadFile = !att.pending && pathStr ? ((UPLOAD_FILE_RE.exec(pathStr) || [])[1] || '') : '';
  const wsRel = !att.pending && pathStr ? relInWorkspace(pathStr, sessionCwd) : null;
  const name = look.name || 'file';

  if (look.media === 'image') {
    if (localUrl) return { origin: 'url', key: 'agy-draft:' + (pathStr || localUrl), url: localUrl, name, kind: 'image' };
    if (uploadFile) return { origin: 'upload', key: 'att:' + uploadFile, file: uploadFile, name, kind: 'image' };
    if (wsRel) return { origin: 'cloud', key: 'agy-ws:' + sessionCwd + ':' + wsRel, rel: wsRel, ws: sessionCwd, name, kind: 'image' };
    if (pathStr && sessionId) return { origin: 'agy', id: sessionId, path: pathStr, name, kind: 'image' };
    if (att.url) return { origin: 'url', key: 'agy-draft:' + (pathStr || att.url), url: att.url, name, kind: 'image' };
    return null;
  }

  if (look.media === 'video') {
    if (uploadFile) return { origin: 'upload', key: 'att:' + uploadFile, file: uploadFile, name, kind: 'video' };
    if (localUrl) return { origin: 'url', key: 'agy-draft:' + (pathStr || localUrl), url: localUrl, name, kind: 'video' };
    if (wsRel) return { origin: 'cloud', key: 'agy-ws:' + sessionCwd + ':' + wsRel, rel: wsRel, ws: sessionCwd, name, kind: 'video' };
    if (pathStr && sessionId) return { origin: 'agy', id: sessionId, path: pathStr, name, kind: 'video' };
    return null;
  }

  if (att.pending || !pathStr) return null;
  if (uploadFile) return { origin: 'upload', key: 'att:' + uploadFile, file: uploadFile, name };
  if (wsRel) return { origin: 'cloud', key: 'agy-ws:' + sessionCwd + ':' + wsRel, rel: wsRel, ws: sessionCwd, name };
  if (sessionId) return { origin: 'agy', id: sessionId, path: pathStr, name };
  return null;
}

// 点输入栏里的图片 / 视频瓦片：把草稿条中所有可预览的图片与视频收成一个画廊，左右切换浏览
export function buildDraftMediaGallery(atts, target, { sessionId = '', sessionCwd = '', originRect = null } = {}) {
  const list = Array.isArray(atts) ? atts : [];
  const items = [];
  let index = -1;
  for (const att of list) {
    if (!attLook(att).media) continue;
    const desc = draftAttDescriptor(att, { sessionId, sessionCwd });
    if (!desc) continue;
    if (att === target) index = items.length;
    items.push(desc);
  }
  if (index < 0) return null;
  if (originRect) items[index] = { ...items[index], originRect };
  return { items, index };
}
