// AskUserQuestion bridge between Claude's tool-call interception and the phone.
// The model's AskUserQuestion tool is interactive; headless it auto-returns an
// empty answer (the phone never sees the question). We intercept it in
// canUseTool, push the question to the phone over SSE, wait for the phone to
// POST its choice to /api/answer, then feed that choice back to the model as
// the (denied) tool result — deny.message is the only channel that becomes the
// tool_result content the model reads.

import { readBody } from './body.mjs';
import { contextFor } from './identity.mjs';
import { claudeSetting } from './claude-settings.mjs';

// 「Claude 提问无人回答时」（设置 questionTimeout，2026-10-20）：多久没人答就让 Claude 自己接着做
//（canUseTool 把超时当「用户没作答，可以改用文字问或按已有信息继续」回给模型）。never = 一直等。
// 原先硬编码 10 分钟；注册表默认仍是 10m，老行为不变。
const QUESTION_TIMEOUT_MS = { never: 0, '5m': 300_000, '10m': 600_000, '30m': 1_800_000 };
export function questionTimeoutMs(ctx) {
  const v = claudeSetting(ctx, 'questionTimeout');
  return Object.hasOwn(QUESTION_TIMEOUT_MS, v) ? QUESTION_TIMEOUT_MS[v] : 600_000;
}

// qid -> { settle(value) }
export const pendingQuestions = new Map();

// 「哪些会话在等人回答」——会话列表的待回答点、/api/active 的 asks（apk 通知）、桌面壳系统通知都读它。
// 2026-10-20 起一个会话可以同时挂好几条（逐次权限审批卡：并行工具 / 多个子 agent 各自要批），
// 内部是 sid → Map(qid → entry)；对外保留 Map 的读法（has / get / keys / entries 每个会话一条 = 最新那条），
// 老调用点不用改。写法：set(sid, entry) 按 entry.qid 追加；delete(sid, qid) 只删那一条，delete(sid) 整个会话清掉。
// entry = { qid, questions:[{header, question}], ts, ownerKey?, kind? }。
// ownerKey（发起这一轮的身份）：读点用 keysFor / entriesFor 只给本人看——这张表是全服共用的，
// 以前 /api/stream hello、/api/sessions、/api/overview 把全服的待回答会话 id（带题面）吐给任何登录身份。
class SessionPending {
  #m = new Map();
  set(sid, entry) {
    if (!sid || !entry) return this;
    let per = this.#m.get(sid);
    if (!per) { per = new Map(); this.#m.set(sid, per); }
    per.set(String(entry.qid || ''), entry);
    return this;
  }
  delete(sid, qid) {
    const per = this.#m.get(sid);
    if (!per) return false;
    if (qid === undefined) return this.#m.delete(sid);
    const ok = per.delete(String(qid));
    if (!per.size) this.#m.delete(sid);
    return ok;
  }
  has(sid) { return !!this.#m.get(sid)?.size; }
  get(sid) { const per = this.#m.get(sid); return per && per.size ? [...per.values()].pop() : undefined; }
  list(sid) { return [...(this.#m.get(sid)?.values() || [])]; }
  clear() { this.#m.clear(); }
  get size() { return this.#m.size; }
  *keys() { for (const [sid, per] of this.#m) if (per.size) yield sid; }
  *entries() { for (const sid of this.keys()) yield [sid, this.get(sid)]; }
  [Symbol.iterator]() { return this.entries(); }
  // 按身份过滤。没带 ownerKey 的老条目只给主机 admin 看（宁可少亮一个点，也不把别人的提问漏出去）。
  *keysFor(key) { for (const [sid, per] of this.#m) if ([...per.values()].some((e) => visibleTo(e, key))) yield sid; }
  *entriesFor(key) {
    for (const sid of this.keysFor(key)) yield [sid, this.list(sid).filter((e) => visibleTo(e, key)).pop()];
  }
  hasFor(sid, key) { return this.list(sid).some((e) => visibleTo(e, key)); }
}
const visibleTo = (e, key) => (e && e.ownerKey ? e.ownerKey === key : key === 'admin');
export const sessionQuestions = new SessionPending();

// 总线 {type:'question', pending} / run.end 带的「这个会话还在不在等你」：本表里这个身份的条目，再加上别处登记的
// 等待源（session-peers.mjs 的跨会话消息「待你确认」——它不进本表，免得 retireTurn 整会话清除时被抹掉）。
// 以前各写点各自 sessionQuestions.has(sid)：答完一张卡就推 pending:false，把同会话还扣着的跨会话消息那颗点也熄了，
// 而且 has 不分身份。登记口是函数，避免 questions.mjs ⇄ session-peers.mjs 循环 import。
const pendingSources = new Set();
export function registerPendingSource(fn) { if (typeof fn === 'function') pendingSources.add(fn); }
export function pendingFor(sid, key) {
  if (!sid) return false;
  if (sessionQuestions.hasFor(sid, key)) return true;
  for (const fn of pendingSources) { try { if (fn(key, sid)) return true; } catch {} }
  return false;
}

// timeoutMs：0 / null = 不设超时（一直等到有人答 / 这一轮被停掉：逐次权限审批、计划审批、提问超时设为「一直等」）；不传 = 10 分钟。
export function waitForAnswer(qid, signal, timeoutMs = 600_000, ownerKey = null) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      done = true;
      pendingQuestions.delete(qid);
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { if (!done) { cleanup(); reject(new Error('aborted')); } };
    const timer = timeoutMs > 0 ? setTimeout(() => { if (!done) { cleanup(); reject(new Error('timeout')); } }, timeoutMs) : null;
    pendingQuestions.set(qid, {
      // ownerKey = the identity (admin / u:<name>) whose turn raised this question.
      // Only that identity may answer it (see handleAnswer).
      ownerKey,
      settle: (value) => { if (!done) { cleanup(); resolve(value); } },
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function formatAnswer(questions, ans) {
  if (ans && ans.cancelled) {
    return '（用户取消了这次选择，没有作答。可以改用普通文字向用户提问，或根据已有信息继续。）';
  }
  const answers = (ans && Array.isArray(ans.answers)) ? ans.answers : [];
  const lines = ['用户在手机上回答了你刚才的提问，选择如下：'];
  questions.forEach((q, i) => {
    const a = answers[i] || {};
    const picks = [];
    if (Array.isArray(a.selected)) picks.push(...a.selected.filter(Boolean));
    if (a.custom && String(a.custom).trim()) picks.push('（自定义）' + String(a.custom).trim());
    lines.push('');
    lines.push('【' + (q.header || ('问题' + (i + 1))) + '】' + (q.question || ''));
    lines.push('答：' + (picks.length ? picks.join('、') : '（未选）'));
  });
  return lines.join('\n');
}

// 审批卡的答复字段（/api/answer 与管理台代答共用）：只截长、不判值——取值由等待方校验。
export function permAnswerFields(p) {
  const out = {};
  if (typeof p?.decision === 'string') out.decision = p.decision.slice(0, 20);
  if (typeof p?.mode === 'string') out.mode = p.mode.slice(0, 40);
  if (typeof p?.feedback === 'string') out.feedback = p.feedback.slice(0, 8000);
  if (p?.ack === true) out.ack = true;   // 审批卡「允许，并切换到自动模式」带着首次确认框点过「启用」
  return out;
}

// POST /api/answer handler: the phone POSTs the user's choice; we settle the
// promise that the canUseTool interception is awaiting.
export async function handleAnswer(req, res, { identify }) {
  // Any authenticated caller (admin OR an account user) may answer — a sandboxed
  // user rides their bridge_user cookie. Previously this required the admin token,
  // so a logged-in user could never answer their own Claude's question and it hung
  // until timeout.
  const id = identify(req);
  // 公开只读分享（share）不能答题；聊天快照访客（snap）要能答自己快照里的提问，照旧放行。
  if (!id || id.kind === 'none' || id.kind === 'share') {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad json');
    return;
  }
  const qid = String(parsed.qid || '');
  const entry = pendingQuestions.get(qid);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('no pending question for that id');
    return;
  }
  // Bind the answer to the identity whose turn raised the question. The qid is only
  // ever sent over that caller's own SSE stream; this is defense-in-depth so a
  // leaked qid can't be used by another account to answer (or hijack) the question.
  if (entry.ownerKey && entry.ownerKey !== contextFor(id).key) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  // choice：安全栅门 Paused 卡的二选一（retry_fallback / edit_prompt），由等待方自己校验取值。
  const choice = typeof parsed.choice === 'string' ? parsed.choice.slice(0, 40) : undefined;
  // 权限审批卡 / 计划审批卡（runtime/permissions.mjs）：decision / mode / feedback 截长后原样透传，等待方白名单校验。
  const perm = permAnswerFields(parsed);
  entry.settle(parsed.cancelled ? { cancelled: true } : { answers: Array.isArray(parsed.answers) ? parsed.answers : [], ...(choice ? { choice } : {}), ...perm });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
