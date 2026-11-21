// 把一段话送进某个 Antigravity 会话、让它接着干：子会话的汇报 / 会话间消息（会话协作）、CI 事件（拉取请求自动修复）共用。
//   · 这个会话正在跑：ifBusy 'queue' → 排进它的队（queue.mjs），这一轮收尾后作为下一轮发出；'busy' → 不动，回 busy 让调用方以后再来；
//   · 没在跑：无头开一轮（runAgyChat 不带请求 / 响应，同排队消息的开跑方式），工作目录、项目、附加目录按会话元数据。
// 只认这个身份自己记过的会话（会话元数据里有 cwd）；agy 只开给管理员。

import { findGenBySession, genEmit } from '@bridge/core/runtime/gen.mjs';
import { agyGenKey } from '../presence.mjs';
import { getSessionMeta } from '../sessions.mjs';
import { enqueue, listQueue } from '../queue.mjs';

// 送进去的话不是用户本人打的：开头一句说清，agy 界面上那条「用户消息」也看得懂
export const RELAY_NOTE = '（这条由 bridge 自动转来，不是用户本人发的。）';

export async function deliverToAgy(ctx, sessionId, text, { ifBusy = 'queue' } = {}) {
  const sid = String(sessionId || '').trim();
  if (!ctx || ctx.kind !== 'admin' || !ctx.agyDir || !sid) return { ok: false, reason: 'Antigravity 会话不可用' };
  const meta = getSessionMeta(ctx.agyDir, sid);
  if (!meta || !meta.cwd) return { ok: false, gone: true, reason: '找不到这个 Antigravity 会话（可能已删除）' };
  const message = `${RELAY_NOTE}\n\n${String(text || '')}`;
  const genKey = agyGenKey(ctx.key);
  const live = findGenBySession(genKey, sid);
  if (live && !live.done) {
    if (ifBusy !== 'queue') return { ok: false, busy: true, reason: '那个会话正在跑' };
    const item = enqueue(genKey, sid, { text: message });
    if (!item) return { ok: false, reason: '那个会话排队的消息太多了' };
    try { genEmit(live, { type: 'queue', sessionId: sid, items: listQueue(genKey, sid) }); } catch {}
    return { ok: true, how: 'queued' };
  }
  // 动态取：agents/agy.mjs 经 config → hub → 各组工具间接引到这里，静态 import 会成环
  const { runAgyChat } = await import('../agents/agy.mjs');
  runAgyChat(null, null, {
    message,
    sessionId: sid,
    cwd: meta.cwd,
    projectId: meta.projectId || null,
    additionalDirectories: Array.isArray(meta.additionalDirectories) ? meta.additionalDirectories : [],
    ctx,
  }).catch((err) => console.error('[agy] 转来的消息开跑失败：', err?.message || err));
  // runAgyChat 在第一个 await 之前就登记好了这一轮
  const g = findGenBySession(genKey, sid);
  return g && !g.done ? { ok: true, how: 'woke' } : { ok: false, reason: '没能开跑' };
}
