// 对话里的媒体进度卡：生成图片 / 视频 / 语音 / 音乐时先摆一张读秒的占位卡，生成完原地换成成品。
// 两条来路都从工具调用记录里算（纯函数，重开历史时靠同一份记录还原）：
//   · bridge 的媒体工具（media_image / media_video / media_speech / media_music，分段等待时由 media_result 取结果）——
//     成品路径在工具返回的 Markdown 链接里；
//   · agy 自带的生图（invoke_subagent 派 image-generator 子代理）——成品由服务端在子代理回报时随 background 事件带来，
//     记在工具记录的 media 字段上（logic.js 的 applyAgyStreamEvent）。

import { bridgeToolOf } from './logic.js';

const BRIDGE_KIND = { media_image: 'image', media_video: 'video', media_speech: 'speech', media_music: 'music' };
const LINK_RE = /\[([^\]\r\n]*)\]\(((?:[^()\r\n]|\([^()\r\n]*\))+?)\)/g;
// 任务还没跑完时工具的返回里带着任务 id（服务端 agy-bridge-tools.mjs 的 settleJob），之后由 media_result 按它取结果
const JOB_RE = /任务 id[：:]\s*([A-Za-z0-9_-]{6,})/;
const EXT_KIND = [
  [/\.(?:png|jpe?g|webp|gif|bmp|avif|heic|svg)$/i, 'image'],
  [/\.(?:mp4|webm|mov|m4v|mkv)$/i, 'video'],
  [/\.(?:mp3|wav|m4a|aac|ogg|flac|opus)$/i, 'audio'],
];

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const fileKind = (p) => (EXT_KIND.find(([re]) => re.test(p)) || [null, 'file'])[1];
export const pathKey = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:)/, '').toLowerCase();

/** 这个工具调用是不是在生成媒体：{ kind, native, result } 或 null（result = 它是来取结果的 media_result） */
export function mediaToolInfo(tool) {
  if (!tool) return null;
  const b = bridgeToolOf(tool);
  if (BRIDGE_KIND[b]) return { kind: BRIDGE_KIND[b], native: false, result: false };
  if (b === 'media_result') return { kind: '', native: false, result: true };
  const type = String(tool.args?.TypeName || tool.args?.typeName || '');
  if (String(tool.name || '') === 'invoke_subagent' && /image/i.test(type)) return { kind: 'image', native: true, result: false };
  return null;
}

/** 工具返回文字里的成品文件：[{ path, name, kind }]（只认绝对路径的 Markdown 链接，去重） */
export function mediaFilesInOutput(output) {
  const out = [];
  const seen = new Set();
  const text = String(output || '');
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(text)) !== null) {
    let p = m[2].trim().replace(/^<|>$/g, '');
    if (!p || /^(?:https?|data|mailto):/i.test(p)) continue;
    try { p = decodeURIComponent(p); } catch {}
    p = p.replace(/^file:\/\/\/?/i, '');
    if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(p)) continue;
    const kind = fileKind(p);
    if (kind === 'file') continue;
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: p, name: m[1].trim() || baseName(p), kind });
  }
  return out;
}

export const mediaJobOf = (output) => (JOB_RE.exec(String(output || '')) || [])[1] || '';

const running = (tool) => tool?.status === 'in_progress' || tool?.status === 'pending';
const failed = (tool) => tool?.status === 'failed' || tool?.status === 'error';

/**
 * 一个工具调用对应的进度卡段：{ kind:'media', id, mediaKind, status, startedAt, files } 或 null（不出卡）。
 *   status  'generating' 读秒占位 | 'ready' 成品
 *   tools   这条消息里全部的工具记录（找接手的 media_result 用）
 *   live    这条消息还在跑
 * 生成失败、被拒绝、被停下的不出卡——步骤行里已经写着结果。
 */
export function mediaSegOf(tool, { tools = [], live = false } = {}) {
  const info = mediaToolInfo(tool);
  if (!info) return null;
  if (tool.approvalState === 'denied' || tool.status === 'cancelled') return null;
  const id = 'media-' + String(tool.toolCallId || '');
  const base = { kind: 'media', id, mediaKind: info.kind, startedAt: tool.startedAt || 0, files: [] };

  if (info.native) {
    const m = tool.media;
    if (m?.files?.length) return { ...base, status: 'ready', files: m.files };
    // 子代理在后台画：工具调用本身一两秒就「完成」了，卡要一直读秒到回报为止（这一轮收尾还没回报就收掉）
    if (live && !failed(tool) && m?.state !== 'gone') return { ...base, status: 'generating' };
    return null;
  }

  if (failed(tool)) return null;
  const files = mediaFilesInOutput(tool.output);

  if (info.result) {
    // 取结果的调用自己不出占位卡（发起的那张还在读秒）；取到成品时由它出成品
    return files.length ? { ...base, mediaKind: files[0].kind === 'audio' ? 'speech' : files[0].kind, status: 'ready', files } : null;
  }

  if (running(tool)) return live ? { ...base, status: 'generating' } : null;
  if (files.length) return { ...base, status: 'ready', files };
  const job = mediaJobOf(tool.output);
  if (!job) return null;
  // 任务还在服务端跑：有 media_result 接手取到了（或明确失败了）就让位，否则接着读秒
  const taker = tools.find((x) => x !== tool && mediaToolInfo(x)?.result && String(x.args?.job || '') === job && !running(x));
  if (taker && (failed(taker) || mediaFilesInOutput(taker.output).length || !mediaJobOf(taker.output))) return null;
  return live ? { ...base, status: 'generating' } : null;
}

/** 这条消息里已经在进度卡上摆出来的成品路径（底部的交付物不再重复摆一遍） */
export function inlineMediaPaths(segs = []) {
  const set = new Set();
  for (const s of segs) {
    if (s?.kind !== 'media' || s.status !== 'ready') continue;
    for (const f of s.files || []) set.add(pathKey(f.path));
  }
  return set;
}
