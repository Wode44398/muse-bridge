// Antigravity 一轮的两个时点给别的功能挂钩：真人发了一条（onAgyUserTurn）、一轮跑完（onAgyTurnEnd）。
// 会话协作要在真人发话时清零「连续自动续」、拉取请求要在轮末从回复里认 <pr-created>——
// 这些功能各在自己的文件里登记，agents/agy.mjs 只在两个时点各调一次，不知道谁挂了什么。
// 钩子一律隔离：抛错只记日志，不影响这一轮。

const userHooks = new Set();
const endHooks = new Set();

/** fn(ctx, sessionId)：真人在这个会话里发了一条（新会话还没有 id 时不调）。 */
export function onAgyUserTurn(fn) { userHooks.add(fn); return () => userHooks.delete(fn); }
/** fn(ctx, gen, { status, text })：一轮收尾（completed / interrupted / failed），text = 最终回复。 */
export function onAgyTurnEnd(fn) { endHooks.add(fn); return () => endHooks.delete(fn); }

export function runAgyUserTurnHooks(ctx, sessionId) {
  if (!sessionId) return;
  for (const fn of userHooks) {
    try { fn(ctx, sessionId); } catch (e) { console.error('[agy] 发话钩子出错：', e?.message || e); }
  }
}

export function runAgyTurnEndHooks(ctx, gen, info = {}) {
  if (!gen?.sessionId) return;
  for (const fn of endHooks) {
    try {
      const r = fn(ctx, gen, info);
      if (r && typeof r.catch === 'function') r.catch((e) => console.error('[agy] 轮末钩子出错：', e?.message || e));
    } catch (e) { console.error('[agy] 轮末钩子出错：', e?.message || e); }
  }
}
