// 统一文件预览控制器 —— Vertex(生成媒体) 与 工作空间(云端/本地 SAF) 三处共用的全屏沉浸查看器入口。
//
// 调用方只管把「描述符」交给 openPreview()，这里归一化成查看器认得的统一结构
// （kind + 各档可加载 URL），MediaViewer.svelte 据 kind 路由到具体子查看器（图/视频/音频/文档…）。
// 来源差异（?token 鉴权、Vertex 衍生图、SAF 本地）全收敛在此一处，子查看器与来源解耦。
//
// 描述符（调用方传入，三种来源）：
//   Vertex 媒体： { origin:'vertex', id, name?, kind? }            —— /api/vertex/media（有 thumb/preview 衍生图）
//   云端文件：   { origin:'cloud',  rel, name?, kind? }            —— /api/file（Range 流，?token 白名单内）
//   手机本地：   { origin:'local',  rel, name?, kind?, dataUrl?, text? }  —— B6 前图片走 dataUrl、文本走已读 text
//   Codex 产物： { origin:'codex', id?, path, name?, kind? }             —— /api/codex/artifact（会话/上传目录授权）
//   Claude 产物：{ origin:'claude', id, path, name?, kind? }             —— /api/claude/artifact（会话项目/交付根授权）
//   dimensio 产物：{ origin:'harness', id, path, name?, kind? }          —— /api/harness/api/sessions/:id/artifact
//   聊天上传：   { origin:'upload', file, name?, kind? }             —— /api/upload/raw（本人 uploads 目录，file=存盘名）
//   现成地址：   { origin:'url', url, previewUrl?, thumbUrl?, downloadHref?, name, kind? }  —— 工具截图等已算好 URL 的
// Vertex 另可带 prompt（显示与下载名都由它生成：提示词前 40 字 + 按 ext/mime 补的扩展名）、ext（服务端存盘扩展名）。
// 任何来源都可另带：size（字节）、mt / mtime（毫秒）、mime（无扩展名时据此判类型）、link（可公开复制的链接），
// 给查看器的「文件信息」与「复制链接」用；不带也行，信息面板会按需用 Range 请求补。
// 也可带 originRect {x,y,w,h}（点击的缩略图在视口里的位置，外框据此做从缩略图放大的开场）、width/height（像素）、
// duration（秒）——都原样透传到条目上，调用方知道就带。

import { untrack } from 'svelte';
import { getToken } from './api.js';
import { apiUrl, mediaUrl, isOffline } from './server.js';
import { localFileUrl, hasLocalThumb, localThumbUrl, hasLocalPreview as localPreviewOk, hasLocalRegion, localTierUrl, localJpegUrl, localStat, LOCAL_TEXT_MAX } from './localfs.js';
import { prefs } from './state.svelte.js';
import { serverOnThisMachine, nativeWorkspaceFileUrl, nativeLocLocalOnly } from './nativeDesktop.js';
import { reportUi } from './uiReport.js';
import { t } from './i18n.js';

// —— 扩展名 → 预览分类：唯一词表在 lib/fileKinds.js（这里只转出，老调用方 import { kindOf } 照旧可用）——
// html 点开【直接渲染】（HtmlView sandbox iframe）；svg 按图片打开，查看器里另给「查看源码」（previewViewAs('text')）。
import { kindOf, extOf, serverConvertsOffice } from './fileKinds.js';
export { kindOf, extOf };

// —— 媒体 URL（附 ?token：<img>/<video> 跨源带不了 Authorization 头，离线壳只能查询参数携带）——
function tokenSuffix(sep) { const tok = getToken && getToken(); return tok ? sep + 'token=' + encodeURIComponent(tok) : ''; }

// 媒体元素用 mediaUrl：在家局域网直连时，只有这台设备实测过媒体能经 LAN 加载才走 LAN（见 server.js）
export function vertexMediaUrl(id, variant) {
  return mediaUrl('/api/vertex/media?id=' + encodeURIComponent(id) + (variant ? '&v=' + variant : '') + tokenSuffix('&'));
}
export function codexArtifactUrl(id, filePath, { dl = false, name = '' } = {}) {
  return apiUrl('/api/codex/artifact?path=' + encodeURIComponent(filePath)
    + (id ? '&id=' + encodeURIComponent(id) : '')
    + (name ? '&name=' + encodeURIComponent(name) : '')
    + (dl ? '&dl=1' : '') + tokenSuffix('&'));
}
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
// http=true：强制走 bridge HTTP。要喂 WebGL/WebGPU 纹理的图（壁纸）必须用它——本地协议
// bridge-workspace:// 对页面是跨源且不带 CORS 头，读进 GPU 会被安全策略拒绝（画布一片黑）。
export function cloudFileUrl(rel, { dl = false, thumb = false, grid = false, preview = false, max = false, media = false, mt = 0, ws = '', nativeLocation = '', http = false } = {}) {
  if (grid) thumb = false;   // grid＝文件列表大图标档（服务端 640，见 file-preview.mjs THUMB_TIERS）
  const name = String(rel).split('/').pop() || 'file';
  // 桌面客户端默认工作空间用受控本地协议直读：图片/PDF/音视频 Range/文本都不再
  // 绕 loopback HTTP。primary 的缩略图/衍生图/下载仍由 bridge 服务端处理（sharp 320
  // 缩略远轻于原字节，nativeLocation='primary' 不得短路它们）；额外授权位置、以及连远端
  // 服务端时「这台电脑」的全部位置，服务端根本不认识，只能恒走本地协议原字节。
  if (!ws && !http && ((serverOnThisMachine() && !dl && !thumb && !grid && !preview && !max) || nativeLocLocalOnly(nativeLocation))) {
    const nativeUrl = nativeWorkspaceFileUrl(rel, nativeLocation || 'primary');
    if (nativeUrl) return nativeUrl;
  }
  // thumb=320 列表图标档 / preview=1280 画廊轻量档（服务端 sharp 衍生，见 files.mjs THUMB_TIERS）/ max=放大用 ≤16.7MP 档（不超直出原字节）。
  // mt=文件 mtime（服务端忽略）：文件被同名替换时 URL 变化，绕开浏览器对旧衍生图的 max-age 缓存。
  const variant = thumb ? '&thumb=1' : grid ? '&thumb=grid' : preview ? '&thumb=preview' : max ? '&thumb=max' : '';
  // 缩略图 / 预览档只给 <img> 用，走 mediaUrl（局域网直连时媒体可能走不了 LAN，见 server.js）；下载、读正文照旧走 apiUrl。
  // media=原图但也是给 <img> 等媒体元素用（md 阅读态/编辑态的插图），同走 mediaUrl
  return (thumb || grid || preview || max || media ? mediaUrl : apiUrl)('/api/file?path=' + encodeURIComponent(rel) + variant + (mt ? '&mt=' + Math.round(mt) : '') + (ws ? '&ws=' + encodeURIComponent(ws) : '') + (dl ? '&dl=1&name=' + encodeURIComponent(name) : '') + tokenSuffix('&'));
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
// 音视频播放器衍生物（服务端 file-media.mjs）：what = media-meta | storyboard | media-cover | media-peaks；
// img=true 给 <img>/CSS 背景用（走 mediaUrl，同缩略图），否则给 fetch 用；extra 原样追加（如 '&img=1'）。
export function cloudMediaUrl(rel, what, { ws = '', mt = 0, img = false, extra = '' } = {}) {
  return (img ? mediaUrl : apiUrl)('/api/file/' + what + '?path=' + encodeURIComponent(rel) + (mt ? '&mt=' + Math.round(mt) : '') + (ws ? '&ws=' + encodeURIComponent(ws) : '') + extra + tokenSuffix('&'));
}

// HtmlView 的站点挂载请求：同一个鉴权接口带 site=1，服务端回 { url:'/api/hv/<id>/<入口>' }——
// 路径式 URL，页面里相对引用的 js/css/图片才解析得到（见 src/runtime/html-site.mjs）。
// 只走 bridge 服务端：桌面壳的额外授权位置服务端不认识，那种情况不给，HtmlView 回落 srcdoc。
function htmlSiteUrl(raw) {
  if (raw.origin === 'cloud') {
    if (nativeLocLocalOnly(raw.nativeLocation)) return null;
    return apiUrl('/api/file?site=1&path=' + encodeURIComponent(raw.rel) + (raw.ws ? '&ws=' + encodeURIComponent(raw.ws) : '') + tokenSuffix('&'));
  }
  if (raw.origin === 'claude') return claudeArtifactUrl(raw.id, raw.path) + '&site=1';
  if (raw.origin === 'codex') return codexArtifactUrl(raw.id, raw.path) + '&site=1';
  return null;
}


// —— 归一化：把来源描述符变成查看器统一结构 ——
function normalize(raw) {
  // vertex：调用方给的 name 没扩展名（旧调用方把提示词当 name 传）就按提示词重新生成规范文件名
  const promptName = raw.origin === 'vertex' && raw.name && !HAS_EXT.test(raw.name) ? raw.name : '';
  const name = (raw.origin === 'vertex' && !HAS_EXT.test(raw.name || '') ? vertexFileName(raw) : raw.name) || (raw.file ? String(raw.file).replace(/^\d{10,}-/, '') : '')
    || (raw.rel ? String(raw.rel).split('/').pop() : '') || (raw.path ? String(raw.path).split(/[\\/]/).pop() : '') || (raw.id ? t('生成结果') : t('文件'));
  const kind = raw.kind || kindOf(name, raw.mime);
  const out = {
    key: raw.key || (raw.origin + ':' + (raw.ws || raw.nativeLocation || '') + ':' + (raw.path || raw.id || raw.rel || raw.file || raw.url || name)),
    origin: raw.origin, name, kind, ext: extOf(name),
    nativeLocation: raw.nativeLocation || '',
    // 文件信息面板用（调用方知道就带上；不带时查看器按需用 Range 请求补大小/时间/类型）
    size: Number.isFinite(raw.size) ? raw.size : null,
    mtime: raw.mt || raw.mtime || null,
    mime: raw.mime || '',
    link: raw.link || '',   // 可公开复制的链接（如分享链接）；没有就不出「复制链接」——媒体 URL 带 ?token，不能当链接给人
    // 文件列表带来的元数据（/api/files/meta 二次补的，拿不到就是 null）：图片 / 视频查看器先按它占好比例
    width: Number(raw.width) > 0 ? Number(raw.width) : null,
    height: Number(raw.height) > 0 ? Number(raw.height) : null,
    duration: Number(raw.duration) > 0 ? Number(raw.duration) : null,
    // 点开的那一格在视口里的矩形 { x, y, w, h }：查看器从它放大进入 / 关闭时缩回
    originRect: raw.originRect && Number(raw.originRect.w) > 0 ? { x: +raw.originRect.x, y: +raw.originRect.y, w: +raw.originRect.w, h: +raw.originRect.h } : null,
    origKind: '',           // previewViewAs 换查看方式（svg 看源码）时记下原分类
    url: null,          // 原始（原图/原视频/原文件）
    previewUrl: null,   // 中等档（图：1280 衍生图；其余=url）
    thumbUrl: null,     // 缩略（图/视频海报：320 衍生图）
    // 「原图加载」（设置-通用 prefs.fullResMedia）打开时的快照：开 = 主图 / 预载 / 放大都是真原图，
    // 只有原图真解不了才退 maxUrl → lowUrl（ImageView 会提示一句）；关 = 主图 previewUrl，放大先升 maxUrl、再按 tileBase 分块
    fullRes: !!prefs.fullResMedia,
    maxUrl: null,       // 放大第一级：≤16.7MP 的 max 档（原图不超就是原图字节）；没有 = 放大直接升原图
    lowUrl: null,       // 原图与 max 档都解不了时的最后一档（preview 档）
    tileBase: null,     // 原图区域块基址（后接 &region=x,y,w,h&w=目标宽）；没有 = 不分块
    poster: null,       // 视频海报帧
    downloadHref: null, // 下载链接（带 dl/token）
    dataUrl: raw.dataUrl ?? null,   // 本地图片：调用方已读好的 base64 dataURL
    text: raw.text ?? null,         // 本地文本：调用方已读好的内容
    editable: false,
    startMode: raw.startMode || '',   // md 打开时的模式（'live' 等）；空＝沿用上次。新建的空笔记直接进编辑
    saveTarget: null,   // { origin:'cloud'|'local', rel }（B3 编辑保存用）
    cacheKey: raw.origin === 'vertex' ? 'v:' + raw.id : raw.origin === 'cloud' ? 'c:' + (raw.ws || raw.nativeLocation || '') + ':' + raw.rel : raw.origin === 'upload' ? 'u:' + raw.file : null,  // 视频/音频本地缓存键（本地来源不缓存）
    prompt: raw.prompt || promptName,   // 生成媒体的提示词（信息面板显示）
  };
  // 调用方带来的几何 / 时长：原样透传（外框开场动画、信息面板用）
  if (raw.originRect && Number.isFinite(raw.originRect.w)) out.originRect = raw.originRect;
  if (raw.width > 0 && raw.height > 0) { out.width = raw.width; out.height = raw.height; }
  if (raw.duration > 0) out.duration = raw.duration;
  if (raw.origin === 'vertex') {
    out.url = vertexMediaUrl(raw.id);
    out.lowUrl = vertexMediaUrl(raw.id, 'preview');
    out.previewUrl = out.fullRes ? out.url : out.lowUrl;
    out.thumbUrl = vertexMediaUrl(raw.id, 'thumb');
    out.poster = out.thumbUrl;
    out.downloadHref = out.url;
  } else if (raw.origin === 'cloud') {
    const mt = raw.mt || 0;
    const ws = raw.ws || '';
    const nativeLocation = raw.nativeLocation || '';
    const localOnly = nativeLocLocalOnly(nativeLocation);   // 服务端不认识的原生位置：没有任何服务端衍生物
    out.url = cloudFileUrl(raw.rel, { ws, nativeLocation });
    // 图片三档（同 vertex）：blur 底=320（与列表图标 URL 一致，直接命中浏览器缓存秒出）、
    // 画廊主图=1280 webp 轻量档（相册/漫画侧滑逐张拉原图慢网顶不住）、原图留给缩放升级。
    // gif 例外：衍生图会丢动画（服务端对 gif 也是回落原图），直接原图。
    // 「原图加载」（设置-通用 prefs.fullResMedia）：开=主图直接原图（预载器跟着预载原图），
    // blur 底保留；对下次 openPreview 生效（归一化在打开时跑一次）。
    // 关着时放大先升 max 档（服务端 ≤16.7MP，原图不超就直出原字节），再放大按可见区拉原图区域块（sharp extract）
    if (kind === 'image' && out.ext !== 'gif' && !localOnly && !(serverOnThisMachine() && !ws)) {
      out.lowUrl = cloudFileUrl(raw.rel, { preview: true, mt, ws, nativeLocation });
      out.previewUrl = out.fullRes ? out.url : out.lowUrl;
      out.thumbUrl = cloudFileUrl(raw.rel, { thumb: true, mt, ws, nativeLocation });
      if (out.ext !== 'svg') {
        out.maxUrl = cloudFileUrl(raw.rel, { max: true, mt, ws, nativeLocation });
        out.tileBase = cloudFileUrl(raw.rel, { media: true, mt, ws, nativeLocation, http: true });
      }
    } else out.previewUrl = out.url;
    // 视频海报=320 抽帧图（此前指向视频原字节，poster 属性根本不认）。
    out.poster = kind === 'video' ? (localOnly ? null : cloudFileUrl(raw.rel, { thumb: true, mt, ws })) : out.url;
    // 转码流兜底（「流畅」档）：直连解不动/带宽顶不住时 VideoPlayer 自动/手动切换
    if (kind === 'video' && !localOnly) { out.streamUrl = cloudStreamUrl(raw.rel, { ws }); out.streamProbeUrl = cloudStreamUrl(raw.rel, { probe: true, ws }); }
    out.downloadHref = cloudFileUrl(raw.rel, { dl: true, ws, nativeLocation });
    out.saveTarget = { origin: 'cloud', rel: raw.rel, ws, nativeLocation };
    // 服务端转 PDF（OfficeView 探测，失败回落客户端）：只给服务端 OFFICE_EXT 认的扩展名，csv/xlsm/ppsx 这类不送去白等 415
    if (kind === 'office' && !localOnly && serverConvertsOffice(name)) out.officePdfUrl = officePdfUrl(raw.rel, ws);
  } else if (raw.origin === 'local') {
    out.url = raw.dataUrl || localFileUrl(raw.rel);   // SAF 原生流式（带 Range），见 MainActivity.serveLocalFile
    out.previewUrl = out.url;
    if (!raw.dataUrl && isOffline() && localPreviewOk()) {
      // 新 apk（原生衍生档）：画廊主图=长边 1600（EXIF 已摆正、磁盘缓存），blur 底=320（与列表图标同一 URL，
      // 内存缓存秒出），缩放过 1:1 先升 max 档（≤16.7MP，原图不超就是原字节），再放大按可见区拉原图区域块
      // （BitmapRegionDecoder + 磁盘缓存，旧一点的 apk 没有就停在 max 档）；视频海报=1080 帧。
      // 「原图加载」开着：主图 / 预载 / 放大都是原图字节（原生对原图 URL 一律不降档）。
      // gif 留原图保动画、svg 是矢量；HEIC/HEIF WebView 解不了 → 原图改要原生按原分辨率转好的 JPEG。
      if (kind === 'image') {
        if (/^(heic|heif)$/.test(out.ext)) out.url = localJpegUrl(raw.rel);
        if (out.ext !== 'gif' && out.ext !== 'svg') {
          out.lowUrl = localTierUrl(raw.rel, 'preview');
          out.previewUrl = out.fullRes ? out.url : out.lowUrl;
          out.thumbUrl = localThumbUrl(raw.rel);
          out.maxUrl = localTierUrl(raw.rel, 'max');
          if (hasLocalRegion()) out.tileBase = localFileUrl(raw.rel);
        } else out.previewUrl = out.url;
      } else if (kind === 'video') out.poster = localTierUrl(raw.rel, 'poster');
      // 原生 localReadText 只读前 2MB：调用方读好的正文可能是截断的，原样交给编辑器会把文件存短。
      // 够长才查一次大小（2MB 字节解出来至少 ~70 万字符），超了就丢掉，让文本查看器按字节带上限读 url（截断有提示、不给存）
      if (typeof raw.text === 'string' && raw.text.length >= 650000) {
        const size = Number.isFinite(raw.size) ? raw.size : localStat(raw.rel)?.size;
        if (size > LOCAL_TEXT_MAX) { out.text = null; out.size = size; }
      }
    } else if (!raw.dataUrl && hasLocalThumb() && isOffline()) {
      // 上一代 apk：只有 320 缩略，当 blur 底/视频海报（更老的 apk/在线壳无此能力，保持无占位）。
      if (kind === 'image') out.thumbUrl = localThumbUrl(raw.rel);
      else if (kind === 'video') out.poster = localThumbUrl(raw.rel);
    }
    out.saveTarget = { origin: 'local', rel: raw.rel };
  } else if (raw.origin === 'codex') {
    out.url = codexArtifactUrl(raw.id, raw.path, { name });
    out.previewUrl = out.url;
    out.downloadHref = codexArtifactUrl(raw.id, raw.path, { dl: true, name });
    out.absPath = raw.path || '';   // 桌面壳原生另存为：本机绝对路径直拷（bridge 三形态都跑在本机）
  } else if (raw.origin === 'claude') {
    out.url = claudeArtifactUrl(raw.id, raw.path, { name });
    out.previewUrl = out.url;
    out.downloadHref = claudeArtifactUrl(raw.id, raw.path, { dl: true, name });
    out.absPath = raw.path || '';
  } else if (raw.origin === 'harness') {
    out.url = harnessArtifactUrl(raw.id, raw.path);
    out.previewUrl = out.url;
    out.downloadHref = harnessArtifactUrl(raw.id, raw.path, { dl: true });
    out.absPath = raw.path || '';
  } else if (raw.origin === 'upload') {
    // 聊天里上传的附件（本人 uploads 目录）：服务端 Range 流式 + 图片 320/1280 衍生档（gif 衍生会丢动画，走原图）
    const q = (extra, media) => (media ? mediaUrl : apiUrl)('/api/upload/raw?name=' + encodeURIComponent(raw.file) + extra + tokenSuffix('&'));
    out.url = q('', kind === 'image' || kind === 'video' || kind === 'audio');
    const derive = kind === 'image' && out.ext !== 'gif' && out.ext !== 'svg';
    if (derive) out.lowUrl = q('&thumb=preview', true);
    out.previewUrl = derive && !out.fullRes ? out.lowUrl : out.url;
    out.thumbUrl = derive ? q('&thumb=1', true) : null;
    out.downloadHref = q('&dl=1');
  } else if (raw.origin === 'url') {
    // 调用方已算好的地址（工具截图 /api/tool-image 等）
    out.url = raw.url || raw.dataUrl || null;
    out.previewUrl = raw.previewUrl || out.url;
    out.thumbUrl = raw.thumbUrl || null;
    out.downloadHref = raw.downloadHref || out.url;
  }
  // 描述符可选的几何信息（文件列表线传）：缩略图位置（FLIP 开合；对象或返回矩形的函数）、原图像素尺寸、视频时长
  if (raw.originRect && (typeof raw.originRect === 'function' || typeof raw.originRect === 'object')) out.originRect = raw.originRect;
  if (raw.width > 0 && raw.height > 0) { out.width = +raw.width; out.height = +raw.height; }
  if (raw.duration > 0) out.duration = +raw.duration;
  if (kind === 'html') out.siteUrl = htmlSiteUrl(raw);
  // 列表格子正显示着的那张缩略图（如大图标的 640 档）：查看器 blur 底 / 视频海报直接用它，命中浏览器缓存秒出
  if (raw.thumbUrl && typeof raw.thumbUrl === 'string') {
    if (kind === 'image' && out.thumbUrl) out.thumbUrl = raw.thumbUrl;
    else if (kind === 'video' && out.poster) out.poster = raw.thumbUrl;
  }
  return out;
}

// 生成媒体的规范文件名：提示词前 40 字（去掉文件名非法字符、折叠空白）+ 正确扩展名。
// 扩展名优先用服务端存盘的（ext），其次 dataUrl 的 MIME，最后按种类猜（与 studio jobs.mjs 的缺省一致）。
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg' };
const HAS_EXT = /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|mp3|wav|ogg|m4a|aac|flac)$/i;   // 只认媒体扩展名（提示词里的「example.com」不算）
const KIND_EXT = { image: 'png', video: 'mp4', audio: 'mp3', speech: 'wav', music: 'mp3' };
export function cleanFileStem(text, max = 40) {
  return Array.from(String(text || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('').replace(/[ .]+$/, '');
}
export function vertexFileName(raw) {
  const dm = /^data:([^;,]+)/.exec(raw.dataUrl || '');
  const ext = String(raw.ext || '').replace(/^\./, '').toLowerCase() || (dm && MIME_EXT[dm[1].toLowerCase()]) || MIME_EXT[String(raw.mime || '').toLowerCase()] || KIND_EXT[raw.kind] || 'png';
  return (cleanFileStem(raw.prompt || raw.name) || t('生成结果')) + '.' + ext;
}
/**
 * Studio 作品（modules/studio assets.mjs publicAsset：{id, mime, w, h, duration}）→ 查看器描述符。
 * 有提示词：提示词进信息面板、下载名按提示词生成；没有：用 fallback（「生成图像」这类类型名）+ 扩展名。
 */
export function vertexAssetItem(a, prompt, fallback, kind) {
  const base = { origin: 'vertex', id: a.id, kind, mime: a.mime || '' };
  if (a.w > 0 && a.h > 0) { base.width = a.w; base.height = a.h; }
  if (a.duration > 0) base.duration = a.duration;
  return prompt ? { ...base, prompt } : { ...base, name: vertexFileName({ name: fallback, mime: a.mime, kind }) };
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
  // 调用方注入的文件操作（openPreview 的 opts.actions）：查看器溢出菜单据此出「发送给 AI / 重命名 / 删除」。
  // 形如 { sendAi?(item), rename?(item, vctx), trash?(item, vctx) }（vctx = 查看器给的 { toast }：失败提示出在查看器里）；没给的项不显示。只有调用方知道怎么刷新自己的列表，
  // 所以删除 / 重命名后要从画廊里拿掉或换名，由回调自己调 previewRemove / previewPatch。
  actions: null,
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
  preview.actions = opts.actions || null;
  preview.open = true;
  preview.detail = null;
  dropLayers();
  reportPreview();
}
export function closePreview() { dropLayers(); preview.open = false; preview.items = []; preview.index = 0; preview.host = 'app'; preview.detail = null; preview.actions = null; reportPreview(); }

// 换一种方式看当前条目（svg 图 ↔ 源码；以后 html 渲染 ↔ 源码也走这里）。key 跟着变，外框按新 kind 重新路由；
// 再换回原分类时 key 还原，草稿 / 缓存这类按 key 记的东西不串。
export function previewViewAs(kind) {
  const i = preview.index, cur = preview.items[i];
  if (!cur || !kind || cur.kind === kind) return;
  const orig = cur.origKind || cur.kind;
  const base = cur.origKind ? cur.key.replace(/#view:[^#]*$/, '') : cur.key;
  preview.items[i] = { ...cur, kind, origKind: kind === orig ? '' : orig, key: kind === orig ? base : base + '#view:' + kind };
  preview.detail = null;
  reportPreview();
}
// 从画廊里拿掉一项（删除后用）：拿空了就关；当前项被拿掉时停在原位置（即下一张），到末尾则退一张。
export function previewRemove(i = preview.index) {
  if (i < 0 || i >= preview.items.length) return;
  const next = preview.items.filter((_, j) => j !== i);
  if (!next.length) { closePreview(); return; }
  preview.items = next;
  if (preview.index > i || preview.index >= next.length) preview.index = Math.max(0, preview.index - 1);
  preview.detail = null;
  reportPreview();
}
// 改一项的字段（重命名后换名、补 size/mtime）；改 name 不重算 URL——调用方要换地址就传新描述符给 previewReplace。
export function previewPatch(i, patch) {
  const cur = preview.items[i];
  if (!cur || !patch) return;
  preview.items[i] = { ...cur, ...patch };
  reportPreview();
}
// 用新描述符替换一项（重新归一化，URL 全部重算）
export function previewReplace(i, raw) {
  if (i < 0 || i >= preview.items.length || !raw) return;
  preview.items[i] = normalize(raw);
  if (i === preview.index) preview.detail = null;
  reportPreview();
}
export function previewGo(i) { if (i >= 0 && i < preview.items.length) { preview.index = i; preview.detail = null; reportPreview(); } }
export function previewNext() { if (preview.index < preview.items.length - 1) { preview.index++; preview.detail = null; reportPreview(); } }
export function previewPrev() { if (preview.index > 0) { preview.index--; preview.detail = null; reportPreview(); } }

// —— 查看器层叠（笔记里点附件、文档里点开另一个文件）——
// previewPush：把当前画廊整份压栈、换成新条目；之后的关闭（左上返回 / Esc / 系统返回）先出栈回到原条目，
// 栈空了才真关。openPreview / closePreview 一律清栈（全新打开不继承旧栈）。
// opts.resume：压栈时替换当前项的已归一化条目（DocViewer 在笔记间跳转过，回来要回到跳到的那篇，不是最初那篇）。
// opts.detail：回来时还原的 preview.detail（缺省沿用压栈时的）。
const layers = [];
export const previewLayers = $state({ depth: 0 });
function dropLayers() { layers.length = 0; previewLayers.depth = 0; }
export function previewPush(rawItems, index = 0, opts = {}) {
  if (!preview.open) { openPreview(rawItems, index, opts); return; }
  const list = (Array.isArray(rawItems) ? rawItems : [rawItems]).filter(Boolean).map(normalize);
  if (!list.length) return;
  const items = preview.items.slice();
  if (opts.resume && items[preview.index]) items[preview.index] = opts.resume;
  layers.push({ items, index: preview.index, actions: preview.actions, detail: opts.detail !== undefined ? opts.detail : preview.detail });
  previewLayers.depth = layers.length;
  preview.items = list;
  preview.index = Math.max(0, Math.min(index, list.length - 1));
  preview.actions = opts.actions || null;
  preview.detail = null;
  reportPreview();
}
// 出栈：回到上一层；没有可出的返回 false（调用方照常关闭）
export function previewPop() {
  const top = layers.pop();
  if (!top) return false;
  previewLayers.depth = layers.length;
  preview.items = top.items;
  preview.index = Math.max(0, Math.min(top.index, top.items.length - 1));
  preview.actions = top.actions;
  preview.detail = top.detail;
  reportPreview();
  return true;
}
