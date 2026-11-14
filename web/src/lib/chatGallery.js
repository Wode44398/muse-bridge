// 聊天会话的图片画廊：在对话里点任何一张图（用户上传、插话带的图、生成图、手机截图、工具截图、
// 助手交付的图片产物），都把本会话所有图片按出现顺序排成一个画廊，从点的那张开始翻。
// 点击处的缩略图位置（originRect）带给查看器，外框据此做从缩略图放大的开场。
//
// 只收图片：视频 / 音频单独打开（打开即播，不该被画廊翻页带着走）。
// 每类条目有固定的 key（attKey / mediaKey / toolKey / artKey），点击处按 key 在画廊里找到自己的下标；
// 找不到（比如子 agent 面板里的工具截图不在主会话消息里）就用调用方给的兜底列表单独打开。
import { chat } from './chat.svelte.js';
import { session } from './state.svelte.js';
import { openPreview, vertexFileName, cleanFileStem } from './preview.svelte.js';
import { toolShots } from './toolImages.js';
import { t } from './i18n.js';

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|svg)$/i;

// —— 各类条目 → 查看器描述符（带固定 key）——

export const attKey = (a) => 'att:' + (a.file || a.rel || a.path || a.url || a.name || '');
/** 用户 / 插话附件（chat.svelte.js 的 toUiAttachments 或直播 sentAttachments 形态）。打不开的（只剩名字）给 null */
export function attDescriptor(a, sid = session.id) {
  if (!a) return null;
  const isImg = a.kind === 'image';
  const base = { key: attKey(a), name: a.name, ...(isImg ? { kind: 'image' } : {}) };
  if (a.file) return { ...base, origin: 'upload', file: a.file };
  if (a.rel) return { ...base, origin: 'cloud', rel: a.rel };
  if (isImg && a.url) return { ...base, origin: 'url', url: a.url, thumbUrl: a.thumb || null };
  // 桌面壳零拷贝附件（本机绝对路径，没进 uploads）：借会话的产物通道取（服务端照常鉴权）
  if (a.path && sid && a.kind !== 'folder') return { ...base, origin: 'claude', id: sid, path: a.path };
  return null;
}

export const mediaKey = (seg) => 'vx:' + (seg.id || '');
/** 聊天里的生成媒体段 {id, mediaKind, prompt, dataUrl?, ext?} */
export function mediaDescriptor(seg) {
  const kind = seg.mediaKind === 'image' ? 'image' : seg.mediaKind === 'video' ? 'video' : 'audio';
  // 手机截图这类内嵌 data: 的没有媒体库 id（id 是 shot-…），直接用 data: 地址
  if (seg.dataUrl) return { key: mediaKey(seg), origin: 'url', url: seg.dataUrl, kind, prompt: seg.prompt || '', name: vertexFileName({ prompt: seg.prompt, dataUrl: seg.dataUrl, kind }) };
  return { key: mediaKey(seg), origin: 'vertex', id: seg.id, kind, prompt: seg.prompt || '', ...(seg.ext ? { ext: seg.ext } : {}) };
}

export const toolKey = (s) => 'tool:' + s.key;
/** 工具截图（lib/toolImages.js toolShots 的条目）。扩展名未知：标题里本来带图片扩展名就用它，否则按截图常见的 png */
export function toolDescriptor(s) {
  const cap = s.caption || '';
  const name = IMG_RE.test(cap) ? cleanFileStem(cap, 80) : (cleanFileStem(cap) || t('截图')) + '.png';
  return { key: toolKey(s), origin: 'url', kind: 'image', url: s.url, thumbUrl: s.thumb || null, name };
}

export const artKey = (a) => 'art:' + (a.path || a.name || '');
/** 助手交付的产物附件卡是不是图片（文件夹不算） */
export const isArtImage = (a) => a && a.kind !== 'folder' && IMG_RE.test(a.name || a.path || '');
function artDescriptor(a) {
  return { key: artKey(a), origin: 'claude', id: a.sessionId || session.id, path: a.path, name: a.name, kind: 'image' };
}

// —— 汇总 ——

/** 本会话所有图片，按出现顺序；同一张图出现多次（同一个上传发了两回）只留第一次 */
export function chatImages(messages = chat.messages, sid = session.id) {
  const out = [];
  const seen = new Set();
  const add = (d) => { if (d && d.key && !seen.has(d.key)) { seen.add(d.key); out.push(d); } };
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'user') {
      for (const a of m.attachments || []) if (a && a.kind === 'image' && a.url) add(attDescriptor(a, sid));
      continue;
    }
    for (const seg of m.segments || []) {
      if (seg.kind === 'steer') {
        for (const a of seg.atts || []) if (a && a.kind === 'image' && a.url) add(attDescriptor(a, sid));
      } else if (seg.kind === 'media') {
        if (seg.mediaKind === 'image' && seg.status === 'ready' && (seg.id || seg.dataUrl)) add(mediaDescriptor(seg));
      } else if (seg.kind === 'tools') {
        for (const s of toolShots(seg.tools, sid)) add(toolDescriptor(s));
      }
    }
    for (const a of m.attachments || []) if (isArtImage(a)) add(artDescriptor(a));
  }
  return out;
}

/** 点击处在视口里的位置（外框开场动画用） */
export function rectOf(el) {
  const r = el?.getBoundingClientRect?.();
  return r && r.width > 0 && r.height > 0 ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
}

/**
 * 打开会话画廊，定位到 key 那张。el：被点的缩略图（量 originRect）。
 * fallback：{ items, index } 在画廊里找不到这张时单独打开的列表（缺省不开）。
 * 返回是否打开了。
 */
export function openChatImage(key, el, fallback = null) {
  let items = chatImages();
  let i = items.findIndex((d) => d.key === key);
  if (i < 0) {
    if (!fallback || !fallback.items?.length) return false;
    items = fallback.items;
    i = Math.max(0, Math.min(fallback.index || 0, items.length - 1));
  }
  const r = rectOf(el);
  if (r) items = items.map((d, j) => (j === i ? { ...d, originRect: r } : d));
  openPreview(items, i);
  return true;
}

/** 非图片的单个附件 / 媒体（视频、音频、pdf…）：单独打开 */
export function openChatItem(desc, el) {
  if (!desc) return false;
  const r = rectOf(el);
  openPreview([r ? { ...desc, originRect: r } : desc], 0);
  return true;
}
