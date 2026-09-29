// 统一文件预览控制器 —— 工作空间文件与各 agent 产物共用的全屏沉浸查看器入口。
//
// 调用方只管把「描述符」交给 openPreview()，这里归一化成查看器认得的统一结构
// （kind + 各档可加载 URL），MediaViewer.svelte 据 kind 路由到具体子查看器（图/视频/音频/文档…）。
// 来源差异（?token 鉴权、衍生图）全收敛在此一处，子查看器与来源解耦。
//
// 描述符（调用方传入）：
//   服务端文件： { origin:'cloud',  rel, name?, kind?, ws? }        —— /api/file（Range 流，?token 白名单内）
//   Claude 产物：{ origin:'claude', id, path, name?, kind? }        —— /api/claude/artifact（会话项目/交付根授权）
//   dimensio 产物：{ origin:'harness', id, path, name?, kind? }     —— /api/harness/api/sessions/:id/artifact
//   可选 dataUrl / text：调用方已读好的内容（图片 dataURL / 文本），查看器直接用。

import { untrack } from 'svelte';
import { getToken } from './api.js';
import { apiUrl } from './server.js';
import { prefs } from './state.svelte.js';
import { reportUi } from './uiReport.js';
import { t } from './i18n.js';

// —— 扩展名 → 预览分类（决定路由到哪个子查看器）——
const EXT_KIND = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'amr'],
  pdf: ['pdf'],
  markdown: ['md', 'markdown', 'mdown', 'mkd'],
  office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'],
  // html：点开【直接渲染】（HtmlView 用 sandbox iframe），而非看源码。自包含页/PPT 类最常用。
  html: ['html', 'htm'],
};
// 纯文本/代码（svg 仍归文本看源码：<img> 渲染不了、且外链脚本不便隔离）。
const TEXT_EXT = ['txt', 'json', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'xml', 'svg', 'yml', 'yaml', 'py', 'sh', 'bat', 'ps1', 'ini', 'toml', 'conf', 'env', 'sql', 'vue', 'c', 'h', 'cpp', 'cc', 'hpp', 'java', 'kt', 'swift', 'php', 'lua', 'rb', 'go', 'rs', 'r', 'tex', 'rst', 'log'];

export function extOf(name = '') { return (String(name).split('.').pop() || '').toLowerCase(); }
export function kindOf(name = '') {
  const e = extOf(name);
  for (const k of Object.keys(EXT_KIND)) if (EXT_KIND[k].includes(e)) return k;
  if (TEXT_EXT.includes(e)) return 'text';
  return 'other';
}

// —— 媒体 URL（附 ?token：<img>/<video> 带不了 Authorization 头，只能查询参数携带）——
function tokenSuffix(sep) { const tok = getToken && getToken(); return tok ? sep + 'token=' + encodeURIComponent(tok) : ''; }

export function claudeArtifactUrl(id, filePath, { dl = false, name = '' } = {}) {
  return apiUrl('/api/claude/artifact?path=' + encodeURIComponent(filePath)
    + (id ? '&id=' + encodeURIComponent(id) : '')
    + (name ? '&name=' + encodeURIComponent(name) : '')
    + (dl ? '&dl=1' : '') + tokenSuffix('&'));
}
export function harnessArtifactUrl(id, filePath, { dl = false } = {}) {
  return apiUrl('/api/harness/api/sessions/' + encodeURIComponent(id) + '/artifact?path=' + encodeURIComponent(filePath)
    + (dl ? '&dl=1' : '') + tokenSuffix('&'));
}
export function cloudFileUrl(rel, { dl = false, thumb = false, preview = false, mt = 0, ws = '' } = {}) {
  const name = String(rel).split('/').pop() || 'file';
  // thumb=320 列表图标档 / preview=1280 画廊轻量档（服务端 sharp 衍生，见 files.mjs THUMB_TIERS）。
  // mt=文件 mtime（服务端忽略）：文件被同名替换时 URL 变化，绕开浏览器对旧衍生图的 max-age 缓存。
  const variant = thumb ? '&thumb=1' : preview ? '&thumb=preview' : '';
  return apiUrl('/api/file?path=' + encodeURIComponent(rel) + variant + (mt ? '&mt=' + Math.round(mt) : '') + (ws ? '&ws=' + encodeURIComponent(ws) : '') + (dl ? '&dl=1&name=' + encodeURIComponent(name) : '') + tokenSuffix('&'));
}
// 服务端把 office 文档转成的 PDF（LibreOffice headless，后端缓存）。OfficeView 探测此端点；
// 通了就用 PdfView 渲染（像素级还原），不通(没装/转换失败/离线)回落客户端 mammoth/SheetJS。
export function officePdfUrl(rel, ws = '') {
  return apiUrl('/api/file/office-pdf?path=' + encodeURIComponent(rel) + (ws ? '&ws=' + encodeURIComponent(ws) : '') + tokenSuffix('&'));
}
// 服务端 ffmpeg 转码流（VideoPlayer「流畅」档：直连播不动的 4K HEVC/mkv/avi 兜底）。
// 播放器自己在末尾追加 &t=<秒> 做续播 seek；probe=1 拿 {duration,...} 撑自定义时间轴。
export function cloudStreamUrl(rel, { probe = false, ws = '' } = {}) {
  return apiUrl('/api/file/stream?path=' + encodeURIComponent(rel) + (probe ? '&probe=1' : '') + (ws ? '&ws=' + encodeURIComponent(ws) : '') + tokenSuffix('&'));
}

// —— 归一化：把来源描述符变成查看器统一结构 ——
function normalize(raw) {
  const name = raw.name || (raw.rel ? String(raw.rel).split('/').pop() : '') || (raw.path ? String(raw.path).split(/[\\/]/).pop() : '') || (raw.id ? t('生成结果') : t('文件'));
  const kind = raw.kind || kindOf(name);
  const out = {
    key: raw.key || (raw.origin + ':' + (raw.ws || '') + ':' + (raw.path || raw.id || raw.rel || name)),
    origin: raw.origin, name, kind, ext: extOf(name),
    url: null,          // 原始（原图/原视频/原文件）
    previewUrl: null,   // 中等档（图：1280 衍生图；其余=url）
    thumbUrl: null,     // 缩略（图/视频海报：320 衍生图）
    poster: null,       // 视频海报帧
    downloadHref: null, // 下载链接（带 dl/token）
    dataUrl: raw.dataUrl ?? null,   // 调用方已读好的图片 base64 dataURL
    text: raw.text ?? null,         // 调用方已读好的文本内容
    editable: false,
    saveTarget: null,   // { origin:'cloud', rel, ws }（编辑保存用）
    cacheKey: raw.origin === 'cloud' ? 'c:' + (raw.ws || '') + ':' + raw.rel : null,  // 视频/音频本地缓存键
  };
  if (raw.origin === 'cloud') {
    const mt = raw.mt || 0;
    const ws = raw.ws || '';
    out.url = cloudFileUrl(raw.rel, { ws });
    // 图片三档：blur 底=320（与列表图标 URL 一致，直接命中浏览器缓存秒出）、
    // 画廊主图=1280 webp 轻量档（相册/漫画侧滑逐张拉原图慢网顶不住）、原图留给缩放升级。
    // gif 例外：衍生图会丢动画（服务端对 gif 也是回落原图），直接原图。
    // 「原图加载」（设置-通用 prefs.fullResMedia）：开=主图直接原图（预载器跟着预载原图），
    // blur 底保留；对下次 openPreview 生效（归一化在打开时跑一次）。
    if (kind === 'image' && out.ext !== 'gif') {
      out.previewUrl = prefs.fullResMedia ? out.url : cloudFileUrl(raw.rel, { preview: true, mt, ws });
      out.thumbUrl = cloudFileUrl(raw.rel, { thumb: true, mt, ws });
    } else out.previewUrl = out.url;
    // 视频海报=320 抽帧图（此前指向视频原字节，poster 属性根本不认）。
    out.poster = kind === 'video' ? cloudFileUrl(raw.rel, { thumb: true, mt, ws }) : out.url;
    // 转码流兜底（「流畅」档）：直连解不动/带宽顶不住时 VideoPlayer 自动/手动切换
    if (kind === 'video') { out.streamUrl = cloudStreamUrl(raw.rel, { ws }); out.streamProbeUrl = cloudStreamUrl(raw.rel, { probe: true, ws }); }
    out.downloadHref = cloudFileUrl(raw.rel, { dl: true, ws });
    out.saveTarget = { origin: 'cloud', rel: raw.rel, ws };
    if (kind === 'office') out.officePdfUrl = officePdfUrl(raw.rel, ws);   // 服务端转 PDF（OfficeView 探测，失败回落客户端）
  } else if (raw.origin === 'claude') {
    out.url = claudeArtifactUrl(raw.id, raw.path, { name });
    out.previewUrl = out.url;
    out.poster = out.url;
    out.downloadHref = claudeArtifactUrl(raw.id, raw.path, { dl: true, name });
    out.absPath = raw.path || '';
  } else if (raw.origin === 'harness') {
    out.url = harnessArtifactUrl(raw.id, raw.path);
    out.previewUrl = out.url;
    out.poster = out.url;
    out.downloadHref = harnessArtifactUrl(raw.id, raw.path, { dl: true });
    out.absPath = raw.path || '';
  }
  return out;
}

// 单条描述符归一化（DocViewer 双链跳转在查看器内部自建条目用；不动画廊状态）
export const normalizeItem = (raw) => normalize(raw);

// —— 全屏查看器共享状态 ——
export const preview = $state({
  open: false,
  items: [],     // 归一化后的条目（画廊）
  index: 0,
  host: 'app',   // 由哪个查看器实例接管：'app'=App 级全屏 | 'dock'=Claude 工作台侧栏内嵌实例
  detail: null,  // 子查看器上抛的细节（PDF 页码/md 编辑态），工作区协同的视图上报消费
});

// 视图上报（工作区协同）：agent 的 workspace.view 就靠这份知道「用户正在看哪个文件」。
function reportPreview() {
  const cur = preview.open ? preview.items[preview.index] : null;
  reportUi({
    preview: cur ? {
      open: true, host: preview.host, name: cur.name, kind: cur.kind, origin: cur.origin,
      rel: cur.saveTarget?.rel || cur.absPath || null,
      ws: cur.saveTarget?.ws || '',
      index: preview.index, count: preview.items.length,
      detail: preview.detail,
    } : { open: false },
  });
}

// 子查看器上抛当前细节（PdfView 页码 / DocViewer 编辑态）；合并进 detail 并随手上报。
// 【坑】调用方都在 $effect 里：这里若直接读 preview.detail 再写新对象，读会被登记成
// 该 effect 的依赖、写又立刻改它 → 自触发死循环 → effect_update_depth_exceeded 把整棵
// effect 树炸停（表现＝打开任何 md 转圈永挂、全 app 点击无响应）。untrack 包住读写，
// 值没变还直接跳过（防抖上报也不用空跑）。
export function setPreviewDetail(patch) {
  untrack(() => {
    const prev = preview.detail || {};
    let changed = false;
    for (const k in patch) if (prev[k] !== patch[k]) { changed = true; break; }
    if (!changed && preview.detail) return;
    preview.detail = { ...prev, ...patch };
    reportPreview();
  });
}

// 打开。rawItems = 单个描述符 或 数组（画廊）；index = 起始下标。
// opts.host='dock'：交给侧栏内嵌的 MediaViewer 实例（被 .dk-embed 的 transform 圈定，
// 预览/编辑留在侧栏里不再全屏接管）；缺省 'app' 维持全屏行为。
export function openPreview(rawItems, index = 0, opts = {}) {
  const list = (Array.isArray(rawItems) ? rawItems : [rawItems]).filter(Boolean).map(normalize);
  if (!list.length) return;
  preview.items = list;
  preview.index = Math.max(0, Math.min(index, list.length - 1));
  preview.host = opts.host || 'app';
  preview.open = true;
  preview.detail = null;
  reportPreview();
}
export function closePreview() { preview.open = false; preview.items = []; preview.index = 0; preview.host = 'app'; preview.detail = null; reportPreview(); }
export function previewGo(i) { if (i >= 0 && i < preview.items.length) { preview.index = i; preview.detail = null; reportPreview(); } }
export function previewNext() { if (preview.index < preview.items.length - 1) { preview.index++; preview.detail = null; reportPreview(); } }
export function previewPrev() { if (preview.index > 0) { preview.index--; preview.detail = null; reportPreview(); } }
