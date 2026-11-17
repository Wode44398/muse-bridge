// 状态行运行态（时长 · tokens · 思考中…/运行工具中…）：事件推进 + 计时器按 200ms 取当前该显示哪条。

import { session } from '../state.svelte.js';
// 权限模式 / 逐次审批卡 / 计划审批卡（2026-10-20）：帧处理与状态都在 permissions.svelte.js，这里只转发
import { hasPendingApproval } from '../permissions.svelte.js';

// —— 状态行「正在干啥」（官方 /code 页 working line 同款：时长 · tokens · 思考中…/运行工具中…）——
// 移植自桌面包的会话运行态 reducer：waiting ∈ sending → starting（SSE 接通）→ preparing（init）→
// model（发起 API 请求 / 新消息开跑）⇄ tools（主链工具在跑，全部回完回到 model）；正文/思考一开写就清空。
// 思考另记起止：进行中 =「思考中…」（按本轮时长升级措辞），结束后至少凑满 2s 再换成「已思考 N 秒」留 2s。
// 待回结果的工具 id 不进响应式（只有当前这一轮在用，attach 重放按事件顺序重建）。
export const pendingTools = new Set();
const THINK_MIN_MS = 2000, THOUGHT_SHOW_MS = 2000, HINT_HOLD_MS = 650, REPLAY_MS = 400;
function thinkBegin(m) {
  if (m.thinkStart) return;
  m.thinkStart = Date.now();
  m.thinkEnd = null;
}
function thinkFinish(m) {
  if (!m.thinkStart) return;
  const now = Date.now();
  // attach 整轮重放会在几毫秒内灌完历史帧：那时算出来的「思考了 0 秒」是假的，不留。
  m.thinkEnd = now - (m.replayAt || 0) < REPLAY_MS ? null : { start: m.thinkStart, end: now };
  m.thinkStart = 0;
}
export function trackRun(m, ev) {
  switch (ev.type) {
    case 'attach':
      pendingTools.clear();
      m.wait = 'model'; m.thinkStart = 0; m.thinkEnd = null; m.retry = null; m.compacting = false;
      m.hint = null; m.hintAt = 0; m.replayAt = Date.now();
      return;
    case 'session': if (m.wait === 'sending' || m.wait === 'starting') m.wait = 'preparing'; return;
    case 'mode':
      m.retry = null;
      if (ev.mode === 'thinking') { thinkBegin(m); m.wait = null; if (m.phase !== 'thinking') m.phase = 'thinking'; }
      else if (ev.mode === 'requesting') { thinkFinish(m); m.wait = 'model'; pendingTools.clear(); }
      return;
    case 'thinking': m.retry = null; thinkBegin(m); m.wait = null; return;
    case 'text': m.retry = null; thinkFinish(m); m.wait = null; return;
    case 'widget_start': case 'widget_delta': m.retry = null; thinkFinish(m); m.wait = null; return;   // 图表代码在出 = 在写
    case 'tool':
      m.retry = null; thinkFinish(m); m.wait = 'tools';
      pendingTools.add(ev.id || '#' + ev.index);
      return;
    case 'tool_done':
      pendingTools.delete(ev.id);
      if (!pendingTools.size && m.wait === 'tools') m.wait = 'model';
      return;
    case 'compact': m.compacting = ev.phase === 'start'; return;
    case 'retry':
      m.retry = { attempt: Number(ev.attempt) || 0, max: Number(ev.max) || 0, kind: ev.errorKind || '', status: ev.status || 0 };
      return;
    case 'question': case 'bg_hold': case 'refusal_prompt': case 'perm_request': case 'plan_request': case 'offer': thinkFinish(m); m.wait = null; return;
  }
}
// 当前该显示哪条状态（纯函数，计时器每 200ms 调一次）。返回 {k,…} 或 null；文案在 Thread 里按 k 取。
function computeHint(m, now) {
  if (m.compacting) return { k: 'compact' };
  if (m.retry) return { k: 'retry', ...m.retry };
  if (m.paused || m.offerQid || m.segments.some((s) => s.kind === 'ask' && !s.answered) || hasPendingApproval(m, session.id)) return { k: 'ask' };   // offerQid：「新会话 / 在这里做」卡在等
  if (m.bgHold) return null;   // 挂起等后台任务：右侧任务芯片已经说明在等什么
  // 官方 /code 页 working line 按思考时长分档（rdt：15/30/45/60 秒）——注意不是聊天页那套每 8 秒轮换的动词
  const sec = Math.floor((now - m.startedAt) / 1000);
  const thinking = () => ({ k: 'think', n: sec >= 60 ? 4 : sec >= 45 ? 3 : sec >= 30 ? 2 : sec >= 15 ? 1 : 0 });
  if (m.thinkStart) return thinking();
  if (m.thinkEnd) {
    const dur = m.thinkEnd.end - m.thinkEnd.start;
    const until = m.thinkEnd.end + Math.max(0, THINK_MIN_MS - dur);
    if (now < until) return thinking();
    if (now < until + THOUGHT_SHOW_MS) return { k: 'thought', n: Math.max(1, Math.round(dur / 1000)) };
  }
  return m.wait ? { k: m.wait } : null;
}
const hintKey = (h) => (h ? h.k + ':' + (h.n ?? '') + ':' + (h.attempt ?? '') : '');
// 换文案至少停留 650ms（官方同款防抖）：Read 这类 20ms 的工具不至于把「运行工具中…」闪成一帧。
export function tickHint(m, now) {
  const h = computeHint(m, now);
  if (hintKey(h) === hintKey(m.hint)) return;
  if (m.hint && now - m.hintAt < HINT_HOLD_MS) return;
  m.hint = h;
  m.hintAt = now;
}
