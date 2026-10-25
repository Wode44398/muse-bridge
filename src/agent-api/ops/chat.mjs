// 对话与会话：项目、会话列表/搜索/读取，给 Claude 发消息、等结果、停止、回答提问与审批。
// 全部经进程内请求走现成路由（/api/chat、/api/session…），这里只做参数翻译与结果整理。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';
import { findGenBySession, getLiveGens } from '../../runtime/gen.mjs';
import { sessionQuestions } from '../../runtime/questions.mjs';
import { listQueue } from '../../runtime/claude-queue.mjs';
import { PERMISSION_MODES } from '../../config/claude-settings.mjs';

defineGroup('projects', '项目', 'Claude 的项目（每个项目一个工作目录）。');
defineGroup('sessions', '会话', 'Claude 会话的列表、搜索与读取。');
defineGroup('chat', '对话', '给 Claude 发消息、等结果、停止、回答它的提问与工具审批。');

const SID_RE = /^[0-9a-fA-F-]{8,}$/;
const TERMINAL = new Set(['done', 'error', 'interrupted']);
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const needSid = (v) => { if (!SID_RE.test(String(v || ''))) throw new OpError('bad_args', 'sessionId 格式不对', { hint: '会话 id 来自 sessions.list / chat.send 的返回' }); return String(v); };
// 会话从哪儿开起来的：bridge（网页 / 安卓 app / 本接口）、定时任务、服务器上直接跑的 Claude 命令行
const ORIGIN = { phone: 'bridge', routine: 'routine', desktop: 'cli' };
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

// ---- 一轮的状态：从 gen 缓冲里读 ----
function partialText(events, max = 2000) {
  let s = '';
  for (const ev of events) {
    if (ev.type === 'text' && typeof ev.text === 'string') s += ev.text;
    else if (ev.type === 'tool' || ev.type === 'tool_use') s += '\n';
  }
  s = s.trim();
  return s.length > max ? '…' + s.slice(-max) : s;
}

// 这个会话里在等人回答的提问 / 审批（只看调用者自己的）。详情从那一轮的帧里补（选项、要批的工具与入参预览）。
export function pendingOf(ctx, sid) {
  const entries = sessionQuestions.list(sid).filter((e) => (e.ownerKey ? e.ownerKey === ctx.key : ctx.key === 'admin'));
  if (!entries.length) return [];
  const g = findGenBySession(ctx.key, sid);
  const frames = new Map();
  for (const ev of g ? g.events : []) if (ev.qid && (ev.type === 'question' || ev.type === 'perm_request' || ev.type === 'plan_request' || ev.type === 'refusal_prompt')) frames.set(ev.qid, ev);
  return entries.map((e) => {
    const f = frames.get(e.qid) || {};
    const base = { id: e.qid, sessionId: sid, since: e.ts || 0 };
    if (f.type === 'perm_request' || e.kind === 'permission') {
      return { ...base, kind: 'approval', tool: f.tool || '', title: f.title || (e.questions?.[0]?.question || ''), description: f.description || '', preview: f.preview ?? null, reason: f.reason || '', canAlways: !!f.canAlways, canAuto: !!f.canAuto, answerWith: 'decision: once | always | auto | deny（deny 可带 feedback）' };
    }
    if (f.type === 'plan_request' || e.kind === 'plan') {
      return { ...base, kind: 'plan', plan: clip(f.plan || '', 20000), answerWith: 'decision: accept（可带 mode）| reject | revise（带 feedback）' };
    }
    if (f.type === 'refusal_prompt' || e.kind === 'refusal') {
      return { ...base, kind: 'paused', question: e.questions?.[0]?.question || '', answerWith: 'choice: retry_fallback | edit_prompt' };
    }
    const qs = Array.isArray(f.questions) ? f.questions : (e.questions || []);
    return {
      ...base, kind: 'question',
      questions: qs.map((q) => ({ header: q.header || '', question: q.question || '', multiSelect: !!q.multiSelect, options: (q.options || []).map((o) => (typeof o === 'string' ? o : o.label)).filter(Boolean) })),
      answerWith: 'answers: 每个问题一项——选项文字（字符串）或 {selected:[…], custom:"…"}',
    };
  });
}

// 一轮的结果。g = gen；没有 gen（太久以前跑的、服务重启过）返回 null。
function turnResult(ctx, sid, g) {
  const evs = g.events;
  let done = null, err = null, interrupted = false, bgHold = false;
  for (const ev of evs) {
    if (ev.type === 'done') done = ev;
    else if (ev.type === 'error') err = ev;
    else if (ev.type === 'interrupted') interrupted = true;
    else if (ev.type === 'bg_hold') bgHold = true;
    else if (ev.type === 'bg_release') bgHold = false;
  }
  if (done) {
    return {
      sessionId: sid, status: done.isError ? 'error' : 'done',
      reply: String(done.result || ''),
      ...(done.isError ? { error: String(done.result || '这一轮出错了') } : {}),
      ...(Array.isArray(done.attachments) && done.attachments.length ? { files: done.attachments.map((a) => a.path || a.file || a.name).filter(Boolean) } : {}),
      ...(typeof done.cost === 'number' ? { costUsd: done.cost } : {}),
      ...(bgHold && !g.done ? { background: true, note: '回答已出，但还有后台任务在跑；之后可能再出一轮' } : {}),
    };
  }
  if (err) return { sessionId: sid, status: 'error', error: [err.title, err.message].filter(Boolean).join('：') || '出错了', ...(err.kind ? { errorKind: err.kind } : {}) };
  if (interrupted || g.done) return { sessionId: sid, status: 'stopped', partial: partialText(evs) };
  const pending = pendingOf(ctx, sid);
  if (pending.length) return { sessionId: sid, status: 'needs_input', pending, partial: partialText(evs), next: '用 chat.answer 回答，再 chat.wait 等结果' };
  return { sessionId: sid, status: 'running', startedAt: g.startedAt || 0, partial: partialText(evs), next: '稍后 chat.wait 继续等' };
}

// 等这个会话当前这一轮：完成 / 出错 / 停了 / 要人回答 / 到点，先到先回。
export async function waitTurn(ctx, sid, seconds, signal) {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  for (;;) {
    const g = findGenBySession(ctx.key, sid);
    if (!g) return null;
    const r = turnResult(ctx, sid, g);
    if (r.status !== 'running' || Date.now() >= deadline || signal?.aborted) {
      // 这一轮收尾了但还有排队消息：会自动接着发，提醒调用方再等下一轮
      const q = r.status === 'running' ? 0 : listQueue(ctx.key, sid).length;
      return q ? { ...r, queued: q, next: `还有 ${q} 条排队消息会接着发出，再 chat.wait 拿它们的回答` } : r;
    }
    await sleep(Math.min(500, Math.max(50, deadline - Date.now())), signal);
  }
}

// 会话最后一条回答（那一轮已不在内存里时用：读 transcript）。
async function lastReply(env, sid) {
  const r = await internalRequest(env.identity, 'GET', '/api/session?id=' + encodeURIComponent(sid));
  if (r.status === 404) throw new OpError('not_found', '没有这个会话', { hint: '会话 id 来自 sessions.list' });
  if (r.status !== 200 || !r.json) throw new OpError('failed', routeError(r));
  const msgs = Array.isArray(r.json.messages) ? r.json.messages : [];
  const last = [...msgs].reverse().find((m) => m.role === 'assistant');
  return { sessionId: sid, status: 'idle', reply: last ? messageText(last) : '', note: '这个会话现在没有在跑的轮；reply 是最后一条回答' };
}

function messageText(m) {
  if (m.role === 'user') return String(m.text || '');
  if (Array.isArray(m.segments)) {
    const t = m.segments.filter((s) => s.kind === 'text' && s.md).map((s) => s.md).join('\n').trim();
    if (t) return t;
  }
  return String(m.text || '').trim();
}
function compactMessage(m, { tools = true } = {}) {
  const out = { role: m.role, text: messageText(m) };
  if (m.ts) out.at = m.ts;
  if (m.role === 'assistant' && Array.isArray(m.segments)) {
    const names = [];
    const asks = [];
    for (const s of m.segments) {
      if (s.kind === 'tools' && Array.isArray(s.tools)) for (const t of s.tools) names.push(t.name || t.tool || '?');
      if (s.kind === 'ask') asks.push({ answered: !!s.answered, items: (s.items || []).map((i) => i.question || i.header || '') });
    }
    if (tools && names.length) out.tools = names;
    if (asks.length) out.asked = asks;
  }
  if (Array.isArray(m.attachments) && m.attachments.length) out.files = m.attachments.map((a) => a.name || a.path || a.file).filter(Boolean);
  return out;
}

// ---- 项目 ----
defineOp({
  name: 'projects.list', title: '列出 Claude 项目',
  desc: '每个项目对应一个工作目录，新会话开在哪个项目里就在哪个目录干活。chat.send 的 project 参数填这里的 id。',
  need: ['agent:claude'],
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'GET', '/api/claude/projects');
    if (r.status !== 200 || !r.json) throw new OpError('failed', routeError(r));
    const projects = (r.json.projects || []).map((p) => ({
      id: p.id, name: p.label || p.name || '', ...(p.default ? { default: true } : {}),
      ...(ctx.kind === 'admin' && p.path ? { path: p.path } : {}),
      ...(p.quick ? { temporary: true } : {}),
    }));
    return { projects };
  },
});

// ---- 会话 ----
defineOp({
  name: 'sessions.list', title: '列出 Claude 会话',
  desc: '按最近活动倒序。可按项目筛、看已归档的。返回里 running=正在跑、pending=在等人回答。要翻下一页把上次返回的 cursor 传回来。',
  need: ['agent:claude'],
  params: {
    project: { type: 'string', desc: '只看这个项目（projects.list 的 id；临时对话用 @quick）' },
    archived: { type: 'boolean', default: false, desc: 'true = 只看已归档的' },
    limit: { type: 'integer', min: 1, max: 200, default: 30, desc: '每页条数' },
    cursor: { type: 'string', desc: '上一页返回的 cursor' },
  },
  handler: async (ctx, args, env) => {
    const q = new URLSearchParams({ limit: String(args.limit) });
    if (args.project) q.set('project', args.project);
    if (args.archived) q.set('view', 'archived');
    if (args.cursor) q.set('before', args.cursor);
    const r = await internalRequest(env.identity, 'GET', '/api/sessions?' + q);
    if (r.status !== 200 || !r.json) throw new OpError('failed', routeError(r));
    const j = r.json;
    const running = new Set([...(j.actives || []), ...(j.active ? [j.active] : [])].map((x) => (typeof x === 'string' ? x : x && x.sessionId)).filter(Boolean));
    const pending = new Set((j.pending || []).map(String));
    const sessions = (j.sessions || []).map((s) => ({
      id: s.id, title: s.title || '', updatedAt: Math.round(s.mtime || 0), project: s.projectId || '',
      ...(running.has(s.id) ? { running: true } : {}), ...(pending.has(s.id) || s.pending ? { pending: true } : {}),
      ...(s.archived ? { archived: true } : {}), ...(ORIGIN[s.origin] ? { startedFrom: ORIGIN[s.origin] } : {}),
      ...(s.parentId ? { parent: s.parentId } : {}),
    }));
    return { sessions, ...(j.more ? { more: true, cursor: String(j.cursor ?? (sessions.length ? sessions[sessions.length - 1].updatedAt : '')) } : {}) };
  },
});

defineOp({
  name: 'sessions.search', title: '全文搜索会话',
  desc: '在 Claude 会话的标题与正文里搜关键词（不分大小写）。',
  need: ['agent:claude'],
  params: {
    q: { type: 'string', required: true, max: 200, desc: '关键词' },
    limit: { type: 'integer', min: 1, max: 100, default: 20 },
    archived: { type: 'string', enum: ['include', 'exclude', 'only'], default: 'include', desc: '要不要包括已归档的' },
  },
  handler: async (ctx, args, env) => {
    const q = new URLSearchParams({ q: args.q, limit: String(args.limit), archived: args.archived });
    const r = await internalRequest(env.identity, 'GET', '/api/claude/search?' + q);
    if (r.status !== 200 || !r.json) throw new OpError('failed', routeError(r));
    const list = r.json.hits || [];
    return {
      results: list.map((s) => ({
        id: s.sessionId, title: s.title || '', updatedAt: Math.round(s.mtime || 0), project: s.projectId || '', ...(s.project ? { projectName: s.project } : {}),
        ...(s.snippet ? { snippet: s.snippet } : {}), ...(s.match ? { matchedIn: s.match } : {}), ...(s.archived ? { archived: true } : {}),
      })),
      ...(r.json.partial || r.json.truncated ? { partial: true } : {}),
    };
  },
});

defineOp({
  name: 'sessions.read', title: '读一个会话的消息',
  desc: '返回最近的若干条消息（用户与 Claude 交替）。Claude 的消息里 text 是正文，tools 是这条里调过的工具名。正在跑的轮还没写进记录时，用 chat.wait 看实时进度。',
  need: ['agent:claude'],
  params: {
    sessionId: { type: 'string', required: true },
    limit: { type: 'integer', min: 1, max: 80, default: 20, desc: '最近多少条' },
    tools: { type: 'boolean', default: true, desc: '要不要列出每条用过的工具名' },
  },
  handler: async (ctx, args, env) => {
    const sid = needSid(args.sessionId);
    const r = await internalRequest(env.identity, 'GET', '/api/session?id=' + encodeURIComponent(sid));
    if (r.status === 404) throw new OpError('not_found', '没有这个会话');
    if (r.status !== 200 || !r.json) throw new OpError('failed', routeError(r));
    const all = Array.isArray(r.json.messages) ? r.json.messages : [];
    const msgs = all.slice(-args.limit).map((m) => compactMessage(m, { tools: args.tools }));
    const g = findGenBySession(ctx.key, sid);
    return {
      sessionId: sid, project: r.json.projectId || '', messages: msgs,
      ...(all.length > args.limit || r.json.truncated ? { truncated: true } : {}),
      ...(g && !g.done ? { running: true } : {}),
      ...(r.json.archived ? { archived: true } : {}),
    };
  },
});

// ---- 对话 ----
defineOp({
  name: 'chat.send', title: '给 Claude 发一条消息',
  desc: [
    '不带 sessionId = 开新会话（可用 project 选项目）；带 sessionId = 在那个会话里接着说。',
    '默认发出去就返回（status=running），拿返回的 sessionId 调 chat.wait 等结果；也可以用 wait 直接等最多若干秒。',
    '会话正在跑时，whenBusy 决定怎么办：queue（默认，排队，这一轮结束后自动发）、steer（插进正在跑的这一轮）、replace（停掉这一轮，改发这条）。',
    'Claude 在 Muse Bridge 里有完整工具（读写文件、命令行按身份、联网搜索与抓网页……；这台服务器没有浏览器，不能打开网页截图）；它要你回答问题或批准工具时 status=needs_input，用 chat.answer 回。',
    '这一轮会出现在用户的界面上（会话列表、直播），和用户自己发的一样。',
  ].join(''),
  access: 'write', slow: true, need: ['agent:claude'],
  params: {
    message: { type: 'string', required: true, max: 100_000, desc: '要发的内容' },
    sessionId: { type: 'string', desc: '接着哪个会话说；不填开新会话' },
    project: { type: 'string', desc: '新会话开在哪个项目（projects.list 的 id）；不填用默认项目' },
    model: { type: 'string', desc: '模型 id（见 manual 的模型表）；不填用会话/服务器默认' },
    effort: { type: 'string', desc: '思考强度：low / medium / high / xhigh / max（以模型支持为准）' },
    permissionMode: { type: 'string', enum: [...PERMISSION_MODES], desc: '只对新会话生效。成员只能用 default / acceptEdits / plan' },
    attachments: { type: 'array', desc: '附件：服务器上的绝对路径（先用 files.write 写进工作空间，或用工作空间里已有的文件）' },
    worktree: { type: 'boolean', desc: '新会话先切一个 git worktree 再干活（项目得是 git 仓库）' },
    whenBusy: { type: 'string', enum: ['queue', 'steer', 'replace'], default: 'queue', desc: '会话正在跑时的处理' },
    wait: { type: 'integer', min: 0, max: 600, default: 0, desc: '最多等几秒拿结果；0 = 发出就返回' },
  },
  returns: '{ sessionId, status: running|done|needs_input|error|queued|steered, reply?, pending?, partial?, next? }',
  example: { message: '把工作空间里的 README.md 总结成三句话', wait: 120 },
  handler: async (ctx, args, env) => {
    const sid = args.sessionId ? needSid(args.sessionId) : undefined;
    const body = { message: args.message, agent: 'claude' };
    if (sid) body.sessionId = sid;
    if (args.project && !sid) body.claudeProjectId = args.project;
    if (args.model) body.model = args.model;
    if (args.effort) body.effort = args.effort;
    if (args.permissionMode && !sid) body.permissionMode = args.permissionMode;
    if (Array.isArray(args.attachments) && args.attachments.length) body.attachments = args.attachments.map(String).slice(0, 20);
    if (args.worktree && !sid) body.worktree = true;
    const busy = sid ? getLiveGens(ctx.key).some((g) => g.sessionId === sid) : false;
    if (busy && args.whenBusy === 'queue') body.priority = 'later';
    if (busy && args.whenBusy === 'steer') body.priority = 'next';

    const r = await internalRequest(env.identity, 'POST', '/api/chat', body, {
      until: (ev) => ev.type === 'session' || TERMINAL.has(ev.type), timeoutMs: 90_000,
    });
    if (!r.sse) {
      // 排队 / 插话成功是 200 JSON；其余是错误
      const j = r.json || {};
      if (r.status === 200 && body.priority) {
        return body.priority === 'later'
          ? { sessionId: sid, status: 'queued', note: '这一轮结束后自动发出（多条排队会合并成一条）', next: '之后 chat.wait 等结果' }
          : { sessionId: sid, status: 'steered', note: '已插进正在跑的这一轮', next: 'chat.wait 等这一轮结束' };
      }
      if (r.status === 409 && j.code === 'not_running' && body.priority) {
        // 刚好收尾了：去掉 priority 重发一次
        delete body.priority;
        return await sendFresh(ctx, env, body, args);
      }
      const code = r.status === 401 ? 'unauthorized' : r.status === 403 ? 'forbidden' : r.status === 429 ? 'quota' : r.status === 409 ? 'conflict' : r.status === 400 ? 'bad_args' : 'failed';
      throw new OpError(code, routeError(r), j.code === 'held_elsewhere' ? { hint: '这个会话正在别处续聊（另一个界面或服务器上的 Claude 命令行），等那边结束或换个会话' } : {});
    }
    return await afterStart(ctx, env, r, args);
  },
});

async function sendFresh(ctx, env, body, args) {
  const r = await internalRequest(env.identity, 'POST', '/api/chat', body, { until: (ev) => ev.type === 'session' || TERMINAL.has(ev.type), timeoutMs: 90_000 });
  if (!r.sse) throw new OpError(r.status === 429 ? 'quota' : 'failed', routeError(r));
  return afterStart(ctx, env, r, args);
}

async function afterStart(ctx, env, r, args) {
  const sessEv = r.events.find((ev) => ev.type === 'session');
  const errEv = r.events.find((ev) => ev.type === 'error');
  r.res.detach();   // 不再挂在这一轮上：之后的进度从 gen 缓冲里读（关掉订阅不会停掉这一轮）
  const sid = (sessEv && sessEv.sessionId) || args.sessionId;
  if (!sid) {
    if (errEv) throw new OpError(errEv.kind === 'quota' ? 'quota' : 'failed', [errEv.title, errEv.message].filter(Boolean).join('：') || '没能开始');
    throw new OpError('failed', r.timedOut ? '等了 90 秒还没开始（服务端可能很忙），稍后用 overview 看看' : '没能开始这一轮');
  }
  const res = await waitTurn(ctx, sid, args.wait, env.signal);
  return res || { sessionId: sid, status: 'running', next: 'chat.wait 等结果' };
}

defineOp({
  name: 'chat.wait', title: '等一个会话的结果',
  desc: '等这个会话当前这一轮：完成（done，带 reply）、出错（error）、被停（stopped）、要人回答（needs_input，带 pending）或到点（running，带目前的 partial），先到先回。会话没在跑时返回最后一条回答（status=idle）。',
  slow: true, need: ['agent:claude'],
  params: {
    sessionId: { type: 'string', required: true },
    timeout: { type: 'integer', min: 0, max: 600, default: 60, desc: '最多等几秒' },
  },
  handler: async (ctx, args, env) => {
    const sid = needSid(args.sessionId);
    const r = await waitTurn(ctx, sid, args.timeout, env.signal);
    return r || await lastReply(env, sid);
  },
});

defineOp({
  name: 'chat.stop', title: '停止一个会话正在跑的轮',
  desc: '默认只打断当前作答（还有后台任务时它们继续跑）；all=true 连后台任务一起停。',
  access: 'write', need: ['agent:claude'],
  params: {
    sessionId: { type: 'string', required: true },
    all: { type: 'boolean', default: false, desc: '连后台任务一起停' },
  },
  handler: async (ctx, args, env) => {
    const sid = needSid(args.sessionId);
    const r = await internalRequest(env.identity, 'POST', '/api/stop', { sessionId: sid, ...(args.all ? { release: true } : {}) });
    if (r.status !== 200) throw new OpError('failed', routeError(r));
    const j = r.json || {};
    return { sessionId: sid, stopped: true, ...(j.held ? { backgroundStillRunning: true } : {}) };
  },
});

defineOp({
  name: 'chat.pending', title: '列出在等人回答的提问与审批',
  desc: '不带 sessionId = 你所有会话里在等的；带 = 只看那个会话。每项给出 id、种类（question 提问 / approval 工具审批 / plan 计划审批 / paused 安全暂停）、内容和回答方式。',
  need: ['agent:claude'],
  params: { sessionId: { type: 'string', desc: '只看这个会话' } },
  handler: async (ctx, args) => {
    const sids = args.sessionId ? [needSid(args.sessionId)] : [...sessionQuestions.keysFor(ctx.key)];
    return { pending: sids.flatMap((sid) => pendingOf(ctx, sid)) };
  },
});

defineOp({
  name: 'chat.answer', title: '回答 Claude 的提问或审批',
  desc: [
    'id 来自 chat.pending / chat.wait 的 pending。',
    '提问（question）：answers 每个问题一项，可以是选项文字，或 {selected:[选项…], custom:"自定义回答"}。',
    '工具审批（approval）：decision = once（这次允许）/ always（以后同类都允许）/ auto（允许并切自动模式）/ deny（拒绝，可带 feedback 说明原因）。',
    '计划审批（plan）：decision = accept（可带 mode 指定之后的权限模式）/ reject / revise（带 feedback）。',
    '安全暂停（paused）：choice = retry_fallback / edit_prompt。cancel=true 表示不作答。',
    '用户的界面上同一张卡会同步消失。工具审批放行的是真操作，替用户批之前想清楚。',
  ].join(''),
  access: 'write', need: ['agent:claude'],
  params: {
    id: { type: 'string', required: true, desc: '提问 / 审批的 id' },
    answers: { type: 'array', desc: '提问的答案' },
    decision: { type: 'string', enum: ['once', 'always', 'auto', 'deny', 'accept', 'reject', 'revise', 'clear'] },
    mode: { type: 'string', enum: [...PERMISSION_MODES], desc: '计划通过后切到的权限模式' },
    feedback: { type: 'string', max: 8000 },
    choice: { type: 'string', enum: ['retry_fallback', 'edit_prompt'] },
    cancel: { type: 'boolean', default: false },
  },
  handler: async (ctx, args, env) => {
    const body = { qid: args.id };
    if (args.cancel) body.cancelled = true;
    else {
      if (args.answers) {
        // 字符串答案：是某个选项就当选中，否则当自定义回答
        const p = pendingFromAnyGen(ctx, args.id);
        const qs = p && p.kind === 'question' ? p.questions : [];
        body.answers = args.answers.map((a, i) => {
          if (a && typeof a === 'object') return { selected: Array.isArray(a.selected) ? a.selected.map(String) : [], ...(a.custom ? { custom: String(a.custom) } : {}) };
          const s = String(a ?? '');
          return (qs[i]?.options || []).includes(s) ? { selected: [s] } : { selected: [], custom: s };
        });
      }
      if (args.decision) body.decision = args.decision === 'revise' ? 'revise' : args.decision;
      if (args.mode) body.mode = args.mode;
      if (args.feedback) body.feedback = args.feedback;
      if (args.choice) body.choice = args.choice;
      if (!body.answers && !body.decision && !body.choice) throw new OpError('bad_args', '要给 answers、decision 或 choice 之一（或 cancel=true）');
    }
    const r = await internalRequest(env.identity, 'POST', '/api/answer', body);
    if (r.status === 404) throw new OpError('not_found', '这个提问已经答过、超时或不存在', { hint: '用 chat.pending 看现在还在等的' });
    if (r.status === 403) throw new OpError('forbidden', '这不是你的会话里的提问');
    if (r.status !== 200) throw new OpError('failed', routeError(r));
    return { answered: true, id: args.id, next: '用 chat.wait 等这一轮接着跑完' };
  },
});

function pendingFromAnyGen(ctx, qid) {
  for (const sid of sessionQuestions.keysFor(ctx.key)) {
    const hit = pendingOf(ctx, sid).find((p) => p.id === qid);
    if (hit) return hit;
  }
  return null;
}
