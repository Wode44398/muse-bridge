// 消息附件：发送时记下服务端文件名、落缓存前换掉 blob:、取图失败自愈、历史附件与助手产物的 URL。

import { getToken } from '../api.js';
import { apiUrl, mediaFallbackUrl } from '../server.js';
import { claudeArtifactUrl, kindOf as previewKindOf } from '../preview.svelte.js';
import { cacheMessages } from '../cache.js';
import { t as tt } from '../i18n.js';   // 本文件的 t 是工具行/任务局部变量，翻译函数取别名 tt

// 已上传进 uploads 的附件，记下它在服务端的文件名（file）：直播气泡照旧用本地 blob: 预览
// （秒显），但 blob 只活在这一页里——落缓存、页面重载、切会话回收后它就是死链。有了 file，
// 缓存/失败回退时都能换成服务端副本（/api/upload/raw），和重开会话时历史给的是同一条。
const UPLOAD_FILE_RE = /[\\/]uploads[\\/]([^\\/]+)$/;
export const sentAttachments = (list) => (list || []).map((a) => {
  // 任何类型都记（不只图片）：pdf / office / 代码附件点开预览也要能从 uploads 取回原文件
  const file = !a.local && a.path ? (UPLOAD_FILE_RE.exec(a.path) || [])[1] : null;
  return {
    path: a.path || null,
    name: a.name,
    kind: a.kind,
    url: a.url || null,
    ...(file ? { file } : {}),
    ...(a.quoteId ? { quoteId: a.quoteId } : {}),
    ...(a.local ? { local: true } : {}),
    ...(a.device ? { device: a.device } : {}),   // 引用电脑上的文件夹：气泡卡写「在哪台电脑上」
    ...(a.vurl ? { vurl: a.vurl } : {}),   // 视频的本地 blob：直播气泡用它定格首帧当封面（零网络）；落缓存前去掉
  };
});

const isBlobUrl = (u) => typeof u === 'string' && u.startsWith('blob:');

// 写本地缓存前把 blob: 预览换掉：能换成服务端副本就换（有 file），换不了就置空（气泡回落成
// 文件卡，等网络那份回来整表替换）。此前 finishTurn 把 blob 原样写进 IndexedDB，App 重启 /
// 被系统回收后再打开会话，缓存里的图全是死链——破图，且之后的合并认为「没变」永远修不好。
function persistable(list) {
  return (list || []).map((m) => {
    if (!m || m.role !== 'user' || !(m.attachments || []).some((a) => isBlobUrl(a?.url) || a?.vurl)) return m;
    return {
      ...m,
      attachments: m.attachments.map((x) => {
        if (!x || (!isBlobUrl(x.url) && !x.vurl)) return x;
        const { vurl, ...a } = x;   // 视频 blob 不落缓存：封面回落服务端抽帧（attVideoCover）
        if (!isBlobUrl(a.url)) return a;
        return a.file ? { ...a, url: uploadRawUrl(a.file), thumb: uploadRawUrl(a.file, 'preview') } : { ...a, url: null };
      }),
    };
  });
}
export const cacheChat = (sid, list) => cacheMessages(sid, persistable(list));

// 气泡 <img> 加载失败时的自愈（onerror 调）：
//   ① 正走 LAN → 降级回隧道重试（mediaFallbackUrl，与媒体图同款）；
//   ② 仍失败 → 依次试其余候选：缩略图 → 原图 → 按服务端文件名现算（带【当前】token 与地址，
//      治缓存里 token 已轮换 / 局域网地址写死 / blob 已回收的旧 URL）。
// 候选全试过就停手，交给元素自己的失败态（不会死循环）。
export function attImgFallback(img, a) {
  if (!img || !a) return;
  // 每一条试过的地址都记账（含 LAN 那条原址）：否则隧道版也失败后，候选里的 a.thumb 还是
  // LAN 原址，会被当成「没试过」又切回去——LAN↔隧道来回乒乓。
  const tried = (img.dataset.tried || '').split('\n').filter(Boolean);
  const go = (u) => { tried.push(u); img.dataset.tried = tried.join('\n'); img.src = u; };
  tried.push(img.src);
  const next = mediaFallbackUrl(img.src);
  if (next !== img.src && !tried.includes(next)) { go(next); return; }
  const cands = [a.thumb, a.url, a.file && uploadRawUrl(a.file, 'preview'), a.file && uploadRawUrl(a.file)]
    .filter((u) => u && !isBlobUrl(u) && !tried.includes(u));
  if (cands.length) go(cands[0]);
  else img.dataset.tried = tried.join('\n');
}

export function revokeMessageBlobUrls(list) {
  for (const m of list || []) {
    for (const a of m?.attachments || []) {
      if (typeof a?.url === 'string' && a.url.startsWith('blob:')) {
        try { URL.revokeObjectURL(a.url); } catch {}
      }
      if (isBlobUrl(a?.vurl)) { try { URL.revokeObjectURL(a.vurl); } catch {} }
    }
  }
}

// 历史附件（sessions.mjs 抽出的 {file,name} 或 {rel,name}）→ 前端消息附件 {name,kind,url}。
// 图片取图：uploads 里的（{file}）走 /api/upload/raw；工作空间直发的（{rel}，「发送给 AI」零拷贝）
// 走 /api/file。<img> 跨源带不了 Authorization，附 ?token=；见 auth.mjs 白名单。
// 非图片也留着 file / rel：文件卡点开走统一查看器（pdf / office / md / 代码…），取原文件同一条路。
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'svg'];
function uploadRawUrl(file, thumb) {
  const t = getToken();
  return apiUrl('/api/upload/raw?name=' + encodeURIComponent(file)
    + (thumb ? '&thumb=' + thumb : '') + (t ? '&token=' + encodeURIComponent(t) : ''));
}
function wsFileUrl(rel, thumb) {
  const t = getToken();
  return apiUrl('/api/file?path=' + encodeURIComponent(rel)
    + (thumb ? '&thumb=' + thumb : '') + (t ? '&token=' + encodeURIComponent(t) : ''));
}
// 每张图给两条 URL：
//   thumb —— 气泡里内联显示用（1280px webp，服务端 thumb-cache 缓存）
//   url   —— 原图，只在灯箱放大 / 下载时才拉
// 此前气泡直接挂原图：uploads 里躺着 15.8MB 的截图、7MB 的手机照，翻旧会话时手机要把
// 它们全下下来并解码成位图（4000px 的图 ≈ 30MB+ RGBA），几张就够把 WebView 挤到被系统
// 回收重载。服务端缩略图不可用时会自动回落原图，故这里无条件带 thumb= 即可。
export function toUiAttachments(list) {
  if (!Array.isArray(list) || !list.length) return [];
  return list.map((a) => {
    const name = a.name || a.file || tt('文件');
    if (a.kind === 'chat') return { name, kind: 'chat', url: null, quoteId: a.quoteId || null };   // 引用对话（sessions.mjs 按存盘名认出）
    if (a.kind === 'folder') return { name, kind: 'folder', url: null, ...(a.device ? { device: a.device } : {}) };   // 电脑上的文件夹（只引用没上传）
    const isImg = IMG_EXT.includes((name.split('.').pop() || '').toLowerCase());
    if (!isImg) return { name, kind: 'file', url: null, ...(a.file ? { file: a.file } : {}), ...(a.rel ? { rel: a.rel } : {}), ...(a.lfile ? { lfile: a.lfile } : {}) };
    const src = a.rel ? wsFileUrl : (a.file ? uploadRawUrl : null);
    const key = a.rel || a.file;
    return {
      name,
      kind: 'image',
      url: src ? src(key) : null,
      thumb: src ? src(key, 'preview') : null,
      ...(a.file ? { file: a.file } : {}), ...(a.rel ? { rel: a.rel } : {}),
    };
  });
}

// —— 用户消息里视频附件的封面：依次可试的来源（前一个加载失败就换下一个，全挂了气泡回落文件卡）——
//   ① 直播刚发出的那条：输入栏留下的本地 blob（vurl），<video> 定格首帧，零网络；
//   ② 服务端抽帧（ffmpeg，1280 档 webp）：上传的走 /api/upload/raw，工作空间里的走 /api/file，
//      桌面壳零拷贝引用的本机文件走 /api/claude/artifact（直播那条有本机路径；历史只剩文件名 lfile，
//      用 bridge-att:<名> 让服务端在本会话的附件清单里找回原路径）。
// 浏览器解不了的编码（HEVC 之类）①会失败，②照样出得来。
export const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|avi|3gp)$/i;
export const ATT_REF_PREFIX = 'bridge-att:';
export function attVideoCover(a, sid) {
  if (!a || a.kind === 'image' || a.kind === 'folder' || a.kind === 'chat' || a.device) return null;
  if (!VIDEO_EXT_RE.test(a.name || a.file || a.lfile || a.path || '')) return null;
  const out = [];
  if (isBlobUrl(a.vurl)) out.push({ video: a.vurl + '#t=0.1' });
  if (a.file) out.push({ img: uploadRawUrl(a.file, 'preview') });
  else if (a.rel) out.push({ img: wsFileUrl(a.rel, 'preview') });
  else if (sid && a.lfile) out.push({ img: claudeArtifactUrl(sid, ATT_REF_PREFIX + a.lfile) + '&thumb=preview' });
  else if (sid && a.path) out.push({ img: claudeArtifactUrl(sid, a.path) + '&thumb=preview' });
  return out.length ? out : null;
}

// —— 助手交付的产物附件（done 事件 / 历史重建共用）：补 kind + 预览/下载 URL ——
// 服务端只给 {name,path,kind,size,count,nav?}；URL 在客户端拼（带 ?token=，离线壳 <img>/下载
// 跨源带不了 Authorization）。文件夹无预览 URL：点卡走 nav 在工作台的工作空间视图里打开
// （服务端算好的 {rel} / {ws,rel}），没有 nav 才回落成整包 zip 下载。
export function toDeliverAtts(list, sessionId) {
  if (!Array.isArray(list) || !list.length) return [];
  return list.filter((a) => a && a.path).map((a) => {
    const name = a.name || String(a.path).split(/[\\/]/).pop() || tt('文件');
    if (a.kind === 'folder') {
      return { name, path: a.path, kind: 'folder', count: a.count || 0, sessionId,
        nav: a.nav && typeof a.nav === 'object' ? { ws: a.nav.ws || '', rel: a.nav.rel || '' } : null,
        downloadUrl: claudeArtifactUrl(sessionId, a.path, { dl: true, name: name + '.zip' }) };
    }
    const kind = previewKindOf(name);
    return { name, path: a.path, kind: kind === 'other' ? (a.kind || 'other') : kind, size: a.size || 0, sessionId,
      // nav：文件产物的工作台定位（父目录 + open=文件名）——点卡/点链接在右侧工作区打开预览
      nav: a.nav && typeof a.nav === 'object' ? { ws: a.nav.ws || '', rel: a.nav.rel || '', open: a.nav.open || '' } : null,
      url: claudeArtifactUrl(sessionId, a.path, { name }),
      downloadUrl: claudeArtifactUrl(sessionId, a.path, { dl: true, name }) };
  });
}
