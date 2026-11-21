// bridge 的 agent 操作管到 Antigravity：sessions.list / search / read 与 chat.send / wait / stop / pending / answer
// 带 agent:'agy' 时由核心（src/agent-api/ops/chat.mjs）转到这里，overview 也来问一句在跑什么。
// 返回的形状尽量与 Claude 那份一致（status: running|done|needs_input|error|stopped|queued|idle），
// 调用方换个 agent 参数就能照搬同一套流程。写操作一律走现成路由（/api/chat、/api/agy/stop、/api/agy/permission…），
// 准入、额度、附件守卫与已删除会话的拦截都在路由里，这里不复制。

import { findGenBySession, getLiveGens } from '@bridge/core/runtime/gen.mjs';
import { agyGenKey, AGY_LABEL } from './presence.mjs';
import { listQueue } from './queue.mjs';
import { listAgySessions, loadAgySessionDetail, isSessionDeleted } from './sessions.mjs';
import { searchAgySessions } from './transcript-search.mjs';
import { isAgySessionId } from './purge-files.mjs';
import { pickAllowOption } from './acp/bypass.mjs';

const TERMINAL = new Set(['done', 'error', 'interrupted']);
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
const keyOf = (ctx) => agyGenKey(ctx?.key || 'admin');
const msOf = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : 0; };

function needSid(kit, v) {
  const s = String(v || '').trim();
  if (!isAgySessionId(s)) throw new kit.OpError('bad_args', 'sessionId 格式不对', { hint: 'Antigravity 的会话 id 来自 sessions.list / chat.send（agent:"agy"）的返回' });
  return s;
}

function notDeleted(ctx, kit, sid) {
  if (isSessionDeleted(ctx?.agyDir, sid)) throw new kit.OpError('not_found', '这个对话已经删除');
}

// project：Antigravity 的项目 id，或一个文件夹绝对路径
const projectFilter = (p) => {
  const v = String(p || '').trim();
  if (!v) return {};
  return /[\\/]/.test(v) ? { cwd: v } : { projectId: v };
};

// ---- 在跑 / 在等人 ----
export function pendingOfGen(gen) {
  if (!gen || gen.done || !gen.sessionId) return [];
  const out = [];
  const p = gen.pendingPermission;
  if (p) {
    const tc = p.toolCall || {};
    out.push({
      id: String(p.requestId || ''), sessionId: gen.sessionId, kind: 'approval',
      tool: tc.name || tc.kind || '', title: clip(tc.title || tc.name || '', 300),
      options: (p.options || []).map((o) => o.name || o.optionId).filter(Boolean),
      answerWith: 'decision: once（允许这一次）| deny（拒绝）；或 cancel=true',
    });
  }
  const q = gen.pendingQuestion;
  if (q) {
    const fields = Array.isArray(q.fields) ? q.fields : [];
    out.push({
      id: String(q.requestId || ''), sessionId: gen.sessionId, kind: 'question',
      message: clip(q.message || '', 2000),
      questions: fields.map((f) => ({
        header: f.title || f.key || '', question: f.description || f.title || '', multiSelect: f.kind === 'multi',
        options: (f.options || []).map((o) => o.label).filter(Boolean), ...(f.required ? { required: true } : {}),
      })),
      answerWith: 'answers: 每个问题一项——选项文字（字符串）或 {selected:[…], custom:"…"}；或 cancel=true',
    });
  }
  return out;
}

function liveMap(ctx) {
  const m = new Map();
  for (const g of getLiveGens(keyOf(ctx))) if (g.sessionId) m.set(g.sessionId, g);
  return m;
}

function partialText(events, max = 2000) {
  let s = '';
  for (const ev of events) {
    if (ev.type === 'text' && typeof ev.text === 'string') s += ev.text;
    else if (ev.type === 'tool') s += '\n';
  }
  s = s.trim();
  return s.length > max ? '…' + s.slice(-max) : s;
}

function turnResult(sid, g) {
  let done = null, err = null, interrupted = null;
  for (const ev of g.events) {
    if (ev.type === 'done') done = ev;
    else if (ev.type === 'error') err = ev;
    else if (ev.type === 'interrupted') interrupted = ev;
  }
  if (done) {
    const files = (Array.isArray(done.attachments) ? done.attachments : []).map((a) => a.path || a.name).filter(Boolean);
    return { sessionId: sid, status: 'done', reply: String(done.result || ''), ...(files.length ? { files } : {}) };
  }
  if (err) return { sessionId: sid, status: 'error', error: String(err.message || '这一轮出错了') };
  if (interrupted || g.done) return { sessionId: sid, status: 'stopped', partial: interrupted?.result ? clip(interrupted.result, 2000) : partialText(g.events) };
  const pending = pendingOfGen(g);
  if (pending.length) return { sessionId: sid, status: 'needs_input', pending, partial: partialText(g.events), next: '用 chat.answer（agent:"agy"）回答，再 chat.wait 等结果' };
  return { sessionId: sid, status: 'running', startedAt: g.startedAt || 0, partial: partialText(g.events), next: '稍后 chat.wait（agent:"agy"）继续等' };
}

/** 等这个会话当前这一轮（与 Claude 的 waitTurn 同语义）。没有这一轮的记录返回 null。 */
export async function waitAgyTurn(ctx, sid, seconds, signal) {
  const key = keyOf(ctx);
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  for (;;) {
    const g = findGenBySession(key, sid);
    if (!g) return null;
    const r = turnResult(sid, g);
    if (r.status !== 'running' || Date.now() >= deadline || signal?.aborted) {
      const q = r.status === 'running' ? 0 : listQueue(key, sid).length;
      return q ? { ...r, queued: q, next: `还有 ${q} 条排队消息会接着发出，再 chat.wait 拿它们的回答` } : r;
    }
    await sleep(Math.min(500, Math.max(50, deadline - Date.now())), signal);
  }
}

function messageView(m, { tools = true } = {}) {
  const out = { role: m.role, text: String(m.text || '').trim() };
  if (m.role === 'assistant') {
    const names = (Array.isArray(m.tools) ? m.tools : []).map((t) => t?.name || t?.title || t?.kind).filter(Boolean);
    if (tools && names.length) out.tools = names;
    if (m.status === 'interrupted') out.interrupted = true;
  }
  const files = (Array.isArray(m.attachments) ? m.attachments : []).map((a) => a?.name || a?.path).filter(Boolean);
  if (files.length) out.files = files;
  return out;
}

async function loadDetail(ctx, kit, sid) {
  try {
    return await loadAgySessionDetail(ctx, sid);
  } catch (err) {
    if (err?.status === 404) throw new kit.OpError('not_found', err.message || '没有这个会话');
    throw new kit.OpError('failed', err?.message || '读取 Antigravity 会话失败');
  }
}

// ---- 操作 ----
async function list(ctx, args) {
  const res = await listAgySessions(ctx, { includeHidden: !!args.archived, ...projectFilter(args.project) });
  let rows = Array.isArray(res.sessions) ? res.sessions : [];
  if (args.archived) rows = rows.filter((s) => s.hidden);
  const live = liveMap(ctx);
  const offset = Math.max(0, Number.parseInt(args.cursor, 10) || 0);
  const limit = args.limit || 30;
  const page = rows.slice(offset, offset + limit).map((s) => {
    const g = live.get(s.sessionId);
    return {
      id: s.sessionId, title: s.title || '', updatedAt: Number(s.updatedMs) || msOf(s.updatedAt),
      project: s.projectId || '', ...(s.projectName ? { projectName: s.projectName } : {}), ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(g ? { running: true } : {}), ...(g && pendingOfGen(g).length ? { pending: true } : {}),
      ...(s.favorite ? { favorite: true } : {}), ...(s.hidden ? { archived: true } : {}),
    };
  });
  const more = rows.length > offset + limit;
  return { agent: 'agy', sessions: page, ...(more ? { more: true, cursor: String(offset + limit) } : {}), ...(res.warning ? { warning: res.warning } : {}) };
}

async function search(ctx, args) {
  const archived = args.archived || 'include';
  const r = await searchAgySessions(ctx, args.q, {
    limit: args.limit || 20,
    includeHidden: archived === 'include',
    onlyHidden: archived === 'only',
  });
  return {
    agent: 'agy',
    results: r.hits.map((h) => ({
      id: h.sessionId, title: h.title || '', updatedAt: msOf(h.updatedAt),
      ...(h.projectName ? { projectName: h.projectName } : {}), ...(h.cwd ? { cwd: h.cwd } : {}),
      ...(h.snippet ? { snippet: h.snippet } : {}), matchedIn: h.match, ...(h.role ? { role: h.role } : {}), ...(h.at ? { at: h.at } : {}),
      ...(h.hidden ? { archived: true } : {}),
    })),
    ...(r.indexing ? { partial: true } : {}),
  };
}

async function read(ctx, args, env, kit) {
  const sid = needSid(kit, args.sessionId);
  notDeleted(ctx, kit, sid);
  const d = await loadDetail(ctx, kit, sid);
  const all = Array.isArray(d.messages) ? d.messages : [];
  const limit = args.limit || 20;
  const g = findGenBySession(keyOf(ctx), sid);
  return {
    agent: 'agy', sessionId: sid, title: d.title || '', ...(d.cwd ? { cwd: d.cwd } : {}), project: d.projectId || '',
    messages: all.slice(-limit).map((m) => messageView(m, { tools: args.tools !== false })),
    ...(all.length > limit ? { truncated: true } : {}),
    ...(g && !g.done ? { running: true } : {}),
  };
}

async function send(ctx, args, env, kit) {
  const sid = args.sessionId ? needSid(kit, args.sessionId) : undefined;
  if (sid) notDeleted(ctx, kit, sid);
  const key = keyOf(ctx);
  const whenBusy = args.whenBusy || 'queue';
  let live = sid ? findGenBySession(key, sid) : null;
  if (live?.done) live = null;
  if (live && whenBusy === 'steer') {
    throw new kit.OpError('bad_args', 'Antigravity 不支持插进正在跑的这一轮', { hint: 'whenBusy 用 queue（这一轮结束后自动发）或 replace（停掉这一轮再发）' });
  }
  if (live && whenBusy === 'replace') {
    try { live.abort.abort(); } catch {}
    await within(live.settled, 10_000);
    live = null;
  }

  const body = { message: args.message, agent: 'agy' };
  if (sid) body.sessionId = sid;
  if (!sid && args.project) {
    const f = projectFilter(args.project);
    if (f.cwd) body.cwd = f.cwd;
    else body.agyProjectId = f.projectId;
  }
  if (args.model) body.agyModel = args.model;
  if (args.effort) body.agyThoughtLevel = args.effort;
  if (Array.isArray(args.attachments) && args.attachments.length) body.attachments = args.attachments.map(String).slice(0, 20);
  if (live) body.queue = true;

  const r = await kit.internalRequest(env.identity, 'POST', '/api/chat', body, {
    until: (ev) => ev.type === 'session' || TERMINAL.has(ev.type), timeoutMs: 90_000,
  });
  if (!r.sse) {
    const j = r.json || {};
    if (r.status === 200 && j.queued) {
      return { sessionId: sid, status: 'queued', note: '这一轮结束后自动发出（排队的消息一条一轮，按先后）', next: '之后 chat.wait（agent:"agy"）等结果' };
    }
    if (r.status === 200 && j.started && sid) {
      return (await waitAgyTurn(ctx, sid, args.wait || 0, env.signal)) || { sessionId: sid, status: 'running', next: 'chat.wait（agent:"agy"）等结果' };
    }
    const code = r.status === 401 ? 'unauthorized' : r.status === 403 ? 'forbidden' : r.status === 404 ? 'not_found' : r.status === 429 ? 'quota' : r.status === 409 ? 'conflict' : r.status === 400 ? 'bad_args' : 'failed';
    throw new kit.OpError(code, kit.routeError(r));
  }
  const sessEv = r.events.find((ev) => ev.type === 'session');
  const errEv = r.events.find((ev) => ev.type === 'error');
  r.res.detach();
  const got = (sessEv && sessEv.sessionId) || sid;
  if (!got) {
    if (errEv) throw new kit.OpError(errEv.kind === 'quota' ? 'quota' : 'failed', [errEv.title, errEv.message].filter(Boolean).join('：') || '没能开始');
    throw new kit.OpError('failed', r.timedOut ? '等了 90 秒还没开始（Antigravity 可能还在启动），稍后用 overview 看看' : '没能开始这一轮');
  }
  return (await waitAgyTurn(ctx, got, args.wait || 0, env.signal)) || { sessionId: got, status: 'running', next: 'chat.wait（agent:"agy"）等结果' };
}

async function wait(ctx, args, env, kit) {
  const sid = needSid(kit, args.sessionId);
  notDeleted(ctx, kit, sid);
  const r = await waitAgyTurn(ctx, sid, args.timeout ?? 60, env.signal);
  if (r) return r;
  const d = await loadDetail(ctx, kit, sid);
  const msgs = Array.isArray(d.messages) ? d.messages : [];
  const last = [...msgs].reverse().find((m) => m.role === 'assistant');
  return { sessionId: sid, status: 'idle', reply: last ? String(last.text || '').trim() : '', note: '这个会话现在没有在跑的轮；reply 是最后一条回答' };
}

async function stop(ctx, args, env, kit) {
  const sid = needSid(kit, args.sessionId);
  const r = await kit.internalRequest(env.identity, 'POST', '/api/agy/stop', { sessionId: sid });
  if (r.status !== 200) throw new kit.OpError(r.status === 403 ? 'forbidden' : 'failed', kit.routeError(r));
  return { sessionId: sid, stopped: true };
}

async function pending(ctx, args, env, kit) {
  const live = liveMap(ctx);
  if (args.sessionId) {
    const sid = needSid(kit, args.sessionId);
    return { pending: pendingOfGen(live.get(sid)) };
  }
  return { pending: [...live.values()].flatMap((g) => pendingOfGen(g)) };
}

// 字符串答案：是某个选项（文字或取值）就当选中，否则当自定义回答
function fieldValue(f, a) {
  const opts = Array.isArray(f.options) ? f.options : [];
  const pick = (s) => { const o = opts.find((x) => x.label === s || x.value === s); return o ? o.value : null; };
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const sel = (Array.isArray(a.selected) ? a.selected : []).map(String);
    if (f.kind === 'multi') return [...sel.map((s) => pick(s) ?? s), ...(a.custom ? [String(a.custom)] : [])];
    const first = sel.length ? (pick(sel[0]) ?? sel[0]) : (a.custom != null ? String(a.custom) : '');
    return fieldValue(f, first);
  }
  if (f.kind === 'multi') return (Array.isArray(a) ? a : [a]).map((s) => pick(String(s)) ?? String(s));
  if (f.kind === 'boolean') return a === true || /^(true|yes|y|1|是|好|对|允许)$/i.test(String(a).trim());
  if (f.kind === 'number') { const n = Number(a); return Number.isFinite(n) ? n : String(a); }
  const s = String(a ?? '');
  return f.kind === 'single' ? (pick(s) ?? s) : s;
}

async function answer(ctx, args, env, kit) {
  // overview / 侧栏通知里的 id 是「会话:请求」，这里两种都认
  const rid = String(args.id || '').split(':').pop();
  let gen = null, kind = '';
  for (const g of getLiveGens(keyOf(ctx))) {
    if (g.pendingPermission && String(g.pendingPermission.requestId) === rid) { gen = g; kind = 'approval'; break; }
    if (g.pendingQuestion && String(g.pendingQuestion.requestId) === rid) { gen = g; kind = 'question'; break; }
  }
  if (!gen) throw new kit.OpError('not_found', '这个提问已经答过、超时或不存在', { hint: '用 chat.pending（agent:"agy"）看现在还在等的' });

  let r;
  if (kind === 'approval') {
    const opts = gen.pendingPermission.options || [];
    let body;
    if (args.cancel) body = { requestId: rid, outcome: 'cancelled' };
    else if (['once', 'always', 'auto', 'accept'].includes(args.decision)) {
      const allow = pickAllowOption(opts);
      if (!allow) throw new kit.OpError('failed', '这张审批卡没有「允许」选项');
      body = { requestId: rid, optionId: allow.optionId };
    } else if (['deny', 'reject'].includes(args.decision)) {
      const no = opts.find((o) => String(o.kind).startsWith('reject')) || opts.find((o) => /^(deny|reject)/i.test(String(o.optionId)));
      body = no ? { requestId: rid, optionId: no.optionId } : { requestId: rid, outcome: 'cancelled' };
    } else {
      throw new kit.OpError('bad_args', '审批要给 decision：once / deny（或 cancel=true）');
    }
    r = await kit.internalRequest(env.identity, 'POST', '/api/agy/permission', body);
  } else {
    let body;
    if (args.cancel) body = { requestId: rid, action: 'cancel' };
    else {
      if (!Array.isArray(args.answers)) throw new kit.OpError('bad_args', '提问要给 answers（每个问题一项），或 cancel=true');
      const fields = Array.isArray(gen.pendingQuestion.fields) ? gen.pendingQuestion.fields : [];
      const content = {};
      fields.forEach((f, i) => { if (args.answers[i] !== undefined && args.answers[i] !== null) content[f.key] = fieldValue(f, args.answers[i]); });
      body = { requestId: rid, action: 'accept', content };
    }
    r = await kit.internalRequest(env.identity, 'POST', '/api/agy/question', body);
  }
  if (r.status === 409) throw new kit.OpError('not_found', '这个提问已经答过、超时或不存在');
  if (r.status !== 200) throw new kit.OpError(r.status === 403 ? 'forbidden' : 'failed', kit.routeError(r));
  return { answered: true, id: args.id, sessionId: gen.sessionId, next: '用 chat.wait（agent:"agy"）等这一轮接着跑完' };
}

function overview(ctx) {
  const running = [];
  const waiting = [];
  for (const g of getLiveGens(keyOf(ctx))) {
    if (!g.sessionId) continue;
    running.push({ sessionId: g.sessionId, startedAt: g.startedAt || 0, prompt: String(g.userText || '').slice(0, 200) });
    for (const p of pendingOfGen(g)) {
      waiting.push({ id: p.id, sessionId: p.sessionId, kind: p.kind, summary: p.title || p.message || p.questions?.[0]?.question || '' });
    }
  }
  return { agent: 'agy', label: AGY_LABEL, running, pending: waiting };
}

export const agyAgentOps = { list, search, read, send, wait, stop, pending, answer, overview };
