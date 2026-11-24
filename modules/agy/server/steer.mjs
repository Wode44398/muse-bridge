// 中途插话：一轮还在跑时用户又发了一条，直接送进这一轮（agy 做完手头这一步就读到，不打断）。
// 与排队（queue.mjs）的区别：排队的话要等这一轮整个收尾才作为下一轮发出。

import { genEmit } from '@bridge/core/runtime/gen.mjs';
import { acpFor } from './acp/index.mjs';
import { noteSessionMeta } from './sessions.mjs';
import { extractUserImageAtts } from './user-media.mjs';

let seq = 0;

/**
 * 把一条消息插进 gen 这一轮。成功返回 { ok: true, steer }，并往这一轮的事件流推一条 steer 事件
 * （各端据此在回答中间摆出这条用户消息；断线重连重放时也靠它）。
 * 这一轮此刻收不了消息（还在挂载会话、正在被停下）返回 { ok: false }，由调用方改走排队。
 */
export function steerAgyTurn(gen, { ctx, sessionId, message = '', attachments = [], userAtts = [], blocks = [], fallback = null } = {}) {
  const sid = String(sessionId || gen?.sessionId || '');
  if (!gen || gen.done || !sid) return { ok: false, reason: 'not_running' };
  const r = acpFor(ctx, sid).steerPrompt(sid, blocks, fallback);
  if (!r?.ok) return { ok: false, reason: r?.reason || 'not_running' };
  const steer = {
    id: 'st-' + Date.now().toString(36) + '-' + (++seq).toString(36),
    text: String(message || ''),
    atts: Array.isArray(userAtts) ? userAtts : [],
    at: Date.now(),
  };
  const steerImages = extractUserImageAtts(attachments, userAtts);
  if (steerImages.length && ctx?.agyDir) {
    const promptText = (Array.isArray(blocks) ? blocks.find((b) => b?.type === 'text')?.text : '') || steer.text;
    noteSessionMeta(ctx.agyDir, sid, {
      appendUserMedia: { prompt: promptText, images: steerImages, at: new Date().toISOString() },
    });
  }
  // 这一轮「最后一条用户消息」换成了它：被停下时的记录、最后一轮的统计都按它对
  gen.lastUserText = steer.text;
  genEmit(gen, { type: 'steer', sessionId: sid, ...steer });
  return { ok: true, steer };
}
