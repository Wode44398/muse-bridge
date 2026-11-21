// bridge 自己在 Antigravity 的对话里向用户要一个「允许 / 不允许」（发短信、打电话、开自动修复 / 自动合并这类）。
//
// agy 前端只认 ACP elicitation 那种提问卡（events.mjs normalizeElicitationRequest 出的 question 事件），所以这里照那个格式
// 往这一轮的事件流里发一张，用户点了经 /api/agy/question 回来——requestId 带 bq- 前缀，路由先问这里（answerBridgeQuestion），
// 不是这里的才交给 ACP 客户端。agy 单次工具调用 180 秒硬上限：等待一律夹在 ASK_MAX_MS 以内，等不到按「用户没确认」收。
//
// 另一条确认渠道是 agy 自己的审批卡：这些工具调用不在免审批名单里，用户在审批卡上（看得到参数）手点了允许，
// 就不必再问一遍（takeManualApproval）。完全放行模式下审批是自动点的，不算。

import { randomBytes } from 'node:crypto';
import { genEmit } from '@bridge/core/runtime/gen.mjs';
import { noticeAgyPending, publishAgyRun } from '../presence.mjs';

export const ASK_MAX_MS = 120_000;
export const ALLOW = 'allow';

const pending = new Map();   // requestId -> { ownerKey, gen, finish }

const sameArgs = (want, got) => {
  for (const [k, v] of Object.entries(want || {})) {
    if (v === undefined) continue;
    if (JSON.stringify(got?.[k]) !== JSON.stringify(v)) return false;
  }
  return true;
};

/**
 * 这一轮里用户有没有在 agy 的审批卡上手点允许过这次调用（工具名 + 关键参数对得上、还没被用过）。用过就记下，同一张审批只认一次。
 * tool = 对外名（不带 mcp_bridge_ 前缀）。
 */
export function takeManualApproval(gen, tool, args = {}) {
  const evs = Array.isArray(gen?.events) ? gen.events : [];
  const used = (gen.bridgeApprovalsUsed ||= new Set());
  const resolved = new Map();
  for (const ev of evs) if (ev && ev.type === 'permission-resolved' && ev.requestId) resolved.set(String(ev.requestId), ev);
  for (let i = evs.length - 1; i >= 0; i--) {
    const ev = evs[i];
    if (!ev || ev.type !== 'permission') continue;
    const id = String(ev.requestId || '');
    if (!id || used.has(id)) continue;
    const tc = ev.toolCall || {};
    if (String(tc.name || '') !== 'mcp_bridge_' + tool) continue;
    const r = resolved.get(id);
    if (!r || r.auto || r.outcome !== 'selected' || /^(?:deny|reject)/i.test(String(r.optionId || ''))) continue;
    const a = tc.args && typeof tc.args === 'object' ? tc.args : (tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {});
    if (!sameArgs(args, a)) continue;
    used.add(id);
    return true;
  }
  return false;
}

/**
 * 在这一轮的对话里弹一张「允许 / 不允许」卡，等用户答。返回 'allow' | 'deny' | 'timeout' | 'gone'（这一轮已经结束或被停）。
 * signal：外面先有了结果（比如手机悬浮窗上点了）就撤卡。
 */
export function askAgyUser(ctx, gen, { message, detail = '', timeoutMs = ASK_MAX_MS, signal = null } = {}) {
  if (!gen || gen.done || !gen.sessionId) return Promise.resolve('gone');
  const requestId = 'bq-' + randomBytes(8).toString('hex');
  const wait = Math.min(Math.max(Number(timeoutMs) || ASK_MAX_MS, 1_000), ASK_MAX_MS);
  return new Promise((resolve) => {
    let timer = null;
    const genSignal = gen.abort?.signal;
    const finish = (verdict, action = 'cancel', content = null) => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      clearTimeout(timer);
      genSignal?.removeEventListener?.('abort', onAbort);
      signal?.removeEventListener?.('abort', onOuter);
      if (gen.pendingQuestion?.requestId === requestId) { gen.pendingQuestion = null; try { publishAgyRun(ctx, gen); } catch {} }
      try { genEmit(gen, { type: 'question-resolved', requestId, sessionId: gen.sessionId, action, content }); } catch {}
      resolve(verdict);
    };
    const onAbort = () => finish('gone');
    const onOuter = () => finish('gone');
    pending.set(requestId, { ownerKey: ctx?.key || '', gen, finish });
    const q = {
      type: 'question', requestId, sessionId: gen.sessionId, mode: 'form',
      message: String(message || '').slice(0, 600),
      fields: [{
        key: 'decision', kind: 'single', title: '你的决定', required: true,
        ...(detail ? { description: String(detail).slice(0, 600) } : {}),
        options: [{ value: ALLOW, label: '允许' }, { value: 'deny', label: '不允许' }],
      }],
    };
    gen.pendingQuestion = q;
    genEmit(gen, q);
    try { noticeAgyPending(ctx, gen); publishAgyRun(ctx, gen); } catch {}
    timer = setTimeout(() => finish('timeout'), wait);
    timer.unref?.();
    if (genSignal?.aborted || signal?.aborted) { finish('gone'); return; }
    genSignal?.addEventListener?.('abort', onAbort, { once: true });
    signal?.addEventListener?.('abort', onOuter, { once: true });
  });
}

/** /api/agy/question 先问这里：是 bridge 自己弹的卡就收下并返回结果，不是返回 null（交给 ACP 客户端）。 */
export function answerBridgeQuestion(ctx, requestId, { action = 'cancel', content = {} } = {}) {
  const id = String(requestId || '');
  if (!id.startsWith('bq-')) return null;
  const p = pending.get(id);
  if (!p) return { ok: false, error: '该提问已结束或不存在' };
  if (p.ownerKey && ctx?.key && p.ownerKey !== ctx.key) return { ok: false, error: '该提问已结束或不存在' };
  const accept = action === 'accept';
  const verdict = accept && content && content.decision === ALLOW ? 'allow' : 'deny';
  p.finish(verdict, accept ? 'accept' : (action === 'decline' ? 'decline' : 'cancel'), accept ? { decision: String(content?.decision || '') } : null);
  return { ok: true, requestId: id, action: accept ? 'accept' : 'cancel' };
}

export function _pendingBridgeQuestions() { return [...pending.keys()]; }
