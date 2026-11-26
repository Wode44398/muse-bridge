// 发消息、在跑的轮、按帧放字、停止、插话、稍后发送、审批作答、重连。
//
// 一条线程同时只有一轮在跑；不同线程可以同时跑（后端每个会话一个 gen）。每轮的 SSE 事件归进它自己线程的那一份，
// 和你正在看哪条线程无关。新线程在 session 事件给出真 id 之前挂在 NEW 那份上。
//
// 呈现：网络 SSE 和屏幕上出字是解耦的——宿主按积压量匀速放字（72–320 字/秒，收尾时 0.55 秒内放完），
// 终态等显示缓冲排空再收口，所以小球和光标会领着最后几个字走完再收起。

import { startChat, resumeActive } from '../../sse.js';
import { noteFsChange } from '../../fsSync.svelte.js';
import { noteCodexAgentBrowser } from '../../dock.svelte.js';
import { busOn } from '../../bus.js';
import { t } from '../../i18n.js';
import { codexApi } from '../api.js';
import { newTurn, applyEvent } from '../turns.js';
import { haptic, processHaptic, resetProcessHaptic, chime } from '../feedback.js';
import { reduced } from '../motion.js';
import { codex, NEW, threadOf, blankThread, lastTurn } from './state.svelte.js';
import { PERMS, permOf, loadPool, loadUsage, loadModels } from './catalog.svelte.js';
import { refreshSessions, ctxOf, errText } from './sessions.svelte.js';

/** 正在跑的：线程对象 -> { handle, turn, pending, budget, lastAt } */
const runs = new Map();
let frame = 0;

const viewing = (th) => (codex.sessionId || '') === (th.id || '') && typeof document !== 'undefined' && !document.hidden;

/* ---------------- 按帧放字 ---------------- */

function safeEnd(text, wanted) {
  let end = Math.min(text.length, Math.max(0, wanted));
  if (end > 0 && end < text.length) {
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end += 1;
  }
  return end;
}

function tick(now) {
  frame = 0;
  let more = false;
  const flushAll = typeof document !== 'undefined' && (document.visibilityState !== 'visible' || reduced());
  for (const [th, r] of runs) {
    const turn = r.turn;
    const total = turn.answer.length;
    const shown = turn.shown < 0 ? total : turn.shown;
    if (flushAll) {
      turn.shown = total;
    } else if (shown < total) {
      if (!r.lastAt) r.lastAt = now - 34;
      const elapsed = Math.min(80, now - r.lastAt);
      if (elapsed < 28) { more = true; continue; }
      r.lastAt = now;
      const backlog = total - shown;
      let cps = Math.min(320, 72 + backlog * 1.5);
      if (r.pending) cps = Math.max(cps, backlog / 0.55);
      r.budget += cps * elapsed / 1000;
      const n = Math.max(1, Math.floor(r.budget));
      r.budget = Math.max(0, r.budget - n);
      const end = safeEnd(turn.answer, shown + n);
      const piece = turn.answer.slice(shown, end);
      turn.shown = end;
      if (/\S/.test(piece) && viewing(th)) haptic('text');
    }
    if (turn.shown < turn.answer.length) { more = true; continue; }
    r.lastAt = 0;
    r.budget = 0;
    if (r.pending) settle(th, r);
  }
  if (more) schedule();
}

function schedule() {
  if (!frame && typeof requestAnimationFrame !== 'undefined') frame = requestAnimationFrame(tick);
}

/* ---------------- 事件 ---------------- */

function moveNewThread(th, sid) {
  if (th.id || !sid) return;
  th.id = sid;
  codex.threads[sid] = th;
  if (codex.threads[NEW] === th) codex.threads[NEW] = blankThread('');
  if (!codex.sessionId && codex._pendingNew === th) codex.sessionId = sid;
  codex._pendingNew = null;
  // 侧栏先放一行（标题先用你的第一句），列表随后从服务端补齐
  if (!codex.sessions.some((s) => s.id === sid)) {
    const first = th.turns[0]?.user?.text || '';
    codex.sessions = [{ id: sid, title: first.slice(0, 60), mtime: Date.now(), projectId: th.projectId, projectName: '' }, ...codex.sessions];
  }
  if (!th.title) th.title = (th.turns[0]?.user?.text || '').slice(0, 60);
}

function onEvent(th, r, ev) {
  if (ev?.type === 'attach') {
    // 重连会把这一轮从头重放一遍：清掉已收的，保留你的话
    const old = r.turn;
    const fresh = newTurn({ text: old.user.text, attachments: old.user.attachments, live: true });
    fresh.key = old.key;
    fresh.startedAt = ev.startedAt || old.startedAt;
    Object.assign(old, { ...fresh, user: old.user });
    resetProcessHaptic();
    return;
  }
  if (TERMINAL.has(ev?.type)) {
    // 终态先压着：等屏幕上的字放完再收口（尾巴 0.55 秒内放完），小球领着最后几个字走完再收起
    if (ev.result && String(ev.result).length > r.turn.answer.length) r.turn.answer = String(ev.result);
    r.pending = ev;
    schedule();
    return;
  }
  const out = applyEvent(r.turn, ev);
  if (out.session) {
    const s = out.session;
    moveNewThread(th, s.sessionId);
    if (s.accountId) th.accountId = s.accountId;
    th.last = { model: s.model, effort: s.effort, serviceTier: s.serviceTier, sandbox: s.sandbox, approvalPolicy: s.approvalPolicy };
    if (viewing(th)) loadUsage(th.accountId);
  }
  if (out.row?.kind === 'tool' && /bridge[_-]?browser/i.test(out.row.ns) && out.row.args?.url) noteCodexAgentBrowser(out.row.args.url);
  if (ev.type === 'tool' && ev.tool?.kind === 'mcp' && /bridge[_-]browser/i.test(String(ev.tool.server || ''))) noteCodexAgentBrowser(ev.tool.url || 'about:blank');
  if (out.haptic?.startsWith('tick:')) { if (viewing(th)) processHaptic(out.haptic.slice(5)); }
  if (out.ask) {
    th.ask = { ...out.ask, kind: out.ask.type === 'perm_request' ? 'perm' : 'question' };
    if (viewing(th)) haptic('tick');
  }
  if (out.askClosed && th.ask?.qid === out.askClosed.qid) th.ask = null;
  if (out.rateLimits?.limits && (!codex.usageAccount || codex.usageAccount === out.rateLimits.accountId)) {
    codex.usage = { ...out.rateLimits.limits, accountId: out.rateLimits.accountId };
    codex.usageAccount = out.rateLimits.accountId || codex.usageAccount;
  }
  if (out.ctx) th.ctx = ctxOf(out.ctx);
  if (out.queue && th.id) loadQueue(th);
  if (out.fs) noteFsChange(out.fs);
  if (out.accountSwitch) { th.accountId = out.accountSwitch.to || th.accountId; loadPool(); }
  if (ev.type === 'text') schedule();
}

const TERMINAL = new Set(['done', 'interrupted', 'error']);

function settle(th, r) {
  const ev = r.pending;
  r.pending = null;
  applyEvent(r.turn, ev);
  runs.delete(th);
  th.running = false;
  if (th.ask && (ev.type !== 'done')) th.ask = null;
  r.turn.shown = -1;
  const hapticKind = ev.type === 'done' ? 'done' : ev.type === 'error' ? 'error' : 'click';
  if (viewing(th)) haptic(hapticKind);
  // 不在看这条线程（后台、别的线程、别的页面）时跑完：侧栏记一个蓝点，响一声
  const away = !viewing(th) || (typeof document !== 'undefined' && !document.hasFocus?.());
  if (th.id && !viewing(th) && ev.type !== 'interrupted') codex.unread = { ...codex.unread, [th.id]: ev.type === 'error' ? 'error' : 'done' };
  if (away && ev.type !== 'interrupted' && !r.turn.adopted) chime();
  if (th.id) { const l = { ...codex.liveRuns }; delete l[th.id]; codex.liveRuns = l; }
  refreshSessions();
  if (viewing(th)) loadUsage(th.accountId);
}

function handlersFor(th, r) {
  return {
    onEvent: (ev) => onEvent(th, r, ev),
    onError: (e) => onEvent(th, r, { type: 'error', message: errText(e, t('连接失败，请重试')), status: e?.status || '' }),
    onReconnecting: () => {},
    onClose: () => {
      // 连接断了又没收到终态（服务端重启这类）：按停止收口，别让小球一直转
      if (runs.get(th) === r && !r.pending) onEvent(th, r, { type: 'interrupted' });
    },
  };
}

/* ---------------- 发送 ---------------- */

/**
 * 发一句话。新线程要有项目。返回 false = 没发出去（原因写在 th.error / 线程里）。
 * attachments：[{ path, name, kind, mime, size }]（已上传好的）
 */
export function send(text, { attachments = [] } = {}) {
  const msg = String(text || '');
  if (!msg.trim() && !attachments.length) return false;
  const isNew = !codex.sessionId;
  const th = threadOf(codex.sessionId);
  if (runs.has(th)) return false;
  if (isNew && !codex.projectId) { th.error = t('先选一个项目'); return false; }
  th.error = '';
  if (isNew) { th.projectId = codex.projectId; codex._pendingNew = th; }
  const turn = newTurn({ text: msg, attachments, live: true });
  th.turns.push(turn);
  const live = th.turns[th.turns.length - 1];     // 推进数组后拿回代理过的那份，之后改它界面才跟着动
  th.running = true;
  th.ask = null;
  resetProcessHaptic();
  haptic('click');
  const perm = PERMS[permOf()] || PERMS.auto;
  const params = {
    agent: 'codex',
    message: msg,
    sessionId: codex.sessionId || undefined,
    codexModel: codex.model || undefined,
    codexEffort: codex.effort || undefined,
    codexServiceTier: codex.fast ? 'priority' : 'default',
    codexProjectId: isNew ? codex.projectId : undefined,
    codexApproval: perm.approval,
    codexSandbox: perm.sandbox,
    ...(codex.plan ? { codexMode: 'plan' } : {}),
    attachments: attachments.map((a) => a.path).filter(Boolean),
    codexAttachmentMeta: attachments.map((a) => ({ path: a.path, name: a.name, kind: a.kind, mime: a.mime, size: a.size })),
  };
  const r = { handle: null, turn: live, pending: null, budget: 0, lastAt: 0 };
  runs.set(th, r);
  r.handle = startChat(params, handlersFor(th, r), { scope: 'codex' });
  return true;
}

export function isRunning(th) {
  return !!th && runs.has(th);
}

export async function stop(th = threadOf(codex.sessionId)) {
  const r = runs.get(th);
  if (!r) return;
  // 屏幕上停在已经放出来的字，后面没放的不要了
  if (r.turn.shown >= 0) r.turn.answer = r.turn.answer.slice(0, r.turn.shown);
  haptic('click');
  try { await codexApi.stop(th.id || undefined); } catch {}
  r.handle?.stop?.();
  if (runs.get(th) === r && !r.pending) onEvent(th, r, { type: 'interrupted' });
}

/** 插话：插进正在跑的这一轮。记录里靠右一个小气泡。 */
export async function steer(text) {
  const th = threadOf(codex.sessionId);
  const r = runs.get(th);
  const msg = String(text || '').trim();
  if (!r || !msg || !th.id) return false;
  r.turn.rows.push({ kind: 'steer', id: 'steer:' + Date.now(), text: msg, pending: true });
  const row = r.turn.rows[r.turn.rows.length - 1];
  try {
    await codexApi.op('steer', th.id, { text: msg });
    row.pending = false;
    haptic('tick');
    return true;
  } catch (e) {
    row.pending = false;
    row.failed = errText(e, t('没插进去'));
    return false;
  }
}

/* ---------------- 稍后发送（排队） ---------------- */

const queueText = (q) => (Array.isArray(q?.input) ? q.input.filter((x) => x?.type === 'text').map((x) => x.text || '').join('\n') : String(q?.text || ''));

export async function loadQueue(th = threadOf(codex.sessionId)) {
  if (!th?.id) return;
  try {
    const r = await codexApi.queue(th.id);
    th.queue = (r?.queue || []).map((q) => ({ id: q.id, text: queueText(q) }));
  } catch {}
}

export async function enqueue(text) {
  const th = threadOf(codex.sessionId);
  const msg = String(text || '').trim();
  if (!msg || !th.id) return false;
  try {
    await codexApi.op('queue/add', th.id, { text: msg });
    await loadQueue(th);
    haptic('tick');
    return true;
  } catch (e) {
    th.error = errText(e, t('没排上'));
    return false;
  }
}

export async function updateQueued(id, text) {
  const th = threadOf(codex.sessionId);
  if (!th.id) return;
  await codexApi.op('queue/update', th.id, { id, text });
  await loadQueue(th);
}

export async function removeQueued(id) {
  const th = threadOf(codex.sessionId);
  if (!th.id) return;
  th.queue = th.queue.filter((q) => q.id !== id);
  try { await codexApi.op('queue/delete', th.id, { id }); } finally { loadQueue(th); }
}

export async function reorderQueue(ids) {
  const th = threadOf(codex.sessionId);
  if (!th.id) return;
  const byId = new Map(th.queue.map((q) => [q.id, q]));
  th.queue = ids.map((id) => byId.get(id)).filter(Boolean);
  try { await codexApi.op('queue/reorder', th.id, { ids }); } finally { loadQueue(th); }
}

/* ---------------- 审批 / 提问 ---------------- */

/**
 * 作答：审批 { decision:'once'|'always'|'rule'|'deny' }，提问 { answers:[{ selected:[…], custom? }] }，或 { cancelled:true }。
 * 返回 '' = 成功；否则是要显示的错误。404 = 这张卡在服务端已经没了（别的设备答过 / 这一轮结束），直接收卡。
 */
export async function answerAsk(th, payload) {
  const ask = th?.ask;
  if (!ask?.qid) return '';
  try {
    await codexApi.answer(ask.qid, payload);
    if (th.ask?.qid === ask.qid) th.ask = null;
    return '';
  } catch (e) {
    if (e?.status === 404) { if (th.ask?.qid === ask.qid) th.ask = null; return ''; }
    return errText(e, t('没送出去，再试一次'));
  }
}

/* ---------------- 重连 / 别处发起的轮 ---------------- */

async function attach(sessionId, userText = '', startedAt = 0) {
  if (!sessionId) return;
  const th = threadOf(sessionId);
  if (runs.has(th)) return;
  let turn = lastTurn(th);
  if (!turn?.live) {
    th.turns.push(newTurn({ text: userText, live: true }));
    turn = th.turns[th.turns.length - 1];
    if (startedAt) turn.startedAt = startedAt;
  }
  th.running = true;
  const r = { handle: null, turn, pending: null, budget: 0, lastAt: 0 };
  runs.set(th, r);
  try {
    r.handle = await resumeActive(handlersFor(th, r), { scope: 'codex', session: sessionId });
    if (!r.handle && runs.get(th) === r) {
      // 已经跑完了：收掉占位的那一轮，重读历史
      runs.delete(th);
      th.running = false;
      th.turns = th.turns.filter((x) => x !== turn);
      th.loaded = false;
    }
  } catch {
    if (runs.get(th) === r) { runs.delete(th); th.running = false; }
  }
}

/** 进页时接上所有在跑的轮（别的设备发起的、Codex 自己续跑的也算）。 */
export async function resumeAll() {
  let a = null;
  try { a = await codexApi.active(); } catch { return; }
  const list = Array.isArray(a?.runs) ? a.runs : a?.active && a.sessionId ? [{ sessionId: a.sessionId, userText: a.userText, startedAt: a.startedAt }] : [];
  for (const run of list) {
    codex.liveRuns = { ...codex.liveRuns, [run.sessionId]: { startedAt: run.startedAt || 0, userText: run.userText || '' } };
    attach(run.sessionId, run.userText || '', run.startedAt || 0);
  }
}

let offBus = null;
export function watchBus() {
  offBus?.();
  offBus = busOn((ev) => {
    if (ev?.type === 'codex.pool' && ev.pool) {
      codex.pool = ev.pool;
      // 额度卡还停在「读不到」，推来的快照里这个号已经有额度了（号刚起来）：补读一次
      const id = codex.usageAccount;
      if (id && codex.usage && !codex.usage.available && ev.pool.accounts?.some((a) => a.id === id && a.limits?.available)) loadUsage(id);
      return;
    }
    // 某个号的模型目录到了 / 变了（号刚起来）：重拉选择器
    if (ev?.type === 'codex.models') { loadModels(); return; }
    if (ev?.type !== 'codex.run' || !ev.sessionId) return;
    if (ev.live) {
      codex.liveRuns = { ...codex.liveRuns, [ev.sessionId]: { startedAt: ev.startedAt || 0, userText: ev.userText || '' } };
      // 正在看的线程或已经打开过的线程：接上看它跑
      const th = codex.threads[ev.sessionId];
      if (th && !runs.has(th)) attach(ev.sessionId, ev.userText || '', ev.startedAt || 0);
    } else {
      const l = { ...codex.liveRuns };
      delete l[ev.sessionId];
      codex.liveRuns = l;
      if (ev.error) {
        const th = codex.threads[ev.sessionId];
        if (th) th.error = ev.error;
      }
      refreshSessions();
    }
  });
  return offBus;
}

export function stopAll() {
  for (const [, r] of runs) r.handle?.stop?.();
  runs.clear();
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}
