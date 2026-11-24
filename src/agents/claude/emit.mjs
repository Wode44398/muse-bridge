import { emitBridgeEvent, ownerOf as eventOwner, clip as eventClip } from '../../plugins/events.mjs';

// 这一轮发给前端的事件顺带喂给插件：turn.start / turn.end。

// runModel 要到下文才赋值：这里可能早于它被调到（号池换号提示），取不到就用请求里的 model
function curModel(run) {
  const { model } = run.plan;
  try { return run.runModel || model || ''; } catch { return model || ''; }
}

// 插件订阅的 turn.start / turn.end（plugins/events.mjs）：从这一轮的事件流里看——每个 gen 一轮（挂起接力会换 gen），
// 头一个事件发 turn.start，done / interrupted / error 发 turn.end（各一次）。预热占位轮没有消息，不发。
export function pluginTap(run, obj) {
  const { sessionId, effort, source, ctx, isSpare, viaAgent } = run.plan;
  try {
    if (!obj || !run.gen) return;
    let t = run.evTurns.get(run.gen);
    if (!t) {
      if (isSpare && !run.turnText) return;
      t = { t0: Date.now(), sid: run.gen.sessionId || sessionId || null, tools: new Set(), ended: false };
      run.evTurns.set(run.gen, t);
      emitBridgeEvent('turn.start', {
        agent: 'claude', kind: 'chat', owner: eventOwner(ctx), sessionId: t.sid, isNew: !sessionId,
        model: curModel(run), effort: effort || '', source: source || '', cwd: ctx.cwd || '',
        message: eventClip(run.turnText || '', 4000), ...(viaAgent ? { via: viaAgent } : {}),
      });
    }
    if (obj.sessionId && !t.sid) t.sid = obj.sessionId;
    if (obj.type === 'tool' && obj.name) t.tools.add(String(obj.name));
    if (!t.ended && (obj.type === 'done' || obj.type === 'interrupted' || obj.type === 'error')) {
      t.ended = true;
      emitBridgeEvent('turn.end', {
        agent: 'claude', kind: 'chat', owner: eventOwner(ctx), sessionId: obj.sessionId || t.sid || run.gen.sessionId || null,
        model: curModel(run), ok: obj.type === 'done' && !obj.isError, stopped: obj.type === 'interrupted',
        ...(obj.type === 'error' ? { error: eventClip(obj.message || obj.title || '', 1000) } : {}),
        result: obj.type === 'done' ? eventClip(obj.result || '', 8000) : '',
        costUsd: obj.type === 'done' ? Number(obj.cost) || 0 : 0, durationMs: Date.now() - t.t0, tools: [...t.tools], ...(viaAgent ? { via: viaAgent } : {}),
      });
    }
  } catch {}
}
