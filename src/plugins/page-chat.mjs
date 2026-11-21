// 插件页面里和 Claude 对话：页面替使用者开的是【他自己的真会话】——出现在他的会话列表里（带应用标记），
// 走他的额度与权限；工具审批照常在 Claude 分页里批，页面不能代批（这里故意没有 answer 接口）。
//
//   POST _bridge/chat/start   { prompt, app?, model?, effort? } → { sessionId }
//   POST _bridge/chat/send    { sessionId, text }               → { ok: true, queued }
//   GET  _bridge/chat/events?session=                           → SSE（跨轮推送，见 chatEvents）
//   POST _bridge/chat/stop    { sessionId }                     → { ok: true }
//   GET  _bridge/chat/sessions?app=                             → [{ sessionId, app, label, at }]
//   GET  _bridge/chat/history?session=                          → { messages: [{ role, text }] }
//   POST _bridge/chat/watch   { sessionId, visible }            → { ok: true, watching, ttl }（页面正看着这个会话：收尾不弹通知）
//
// 每个操作都要插件声明并经使用者授权过 page.chat（requireGrant：没同意 403 needGrant，没声明 403 undeclared）；带会话 id 的操作还要会话是
// 【这个插件替这个使用者】开的（pluginSessions 的 plugin 与 owner 都对得上），否则一律 404——页面拿别人的、别的插件的、
// 用户自己在 Claude 分页开的会话 id 来试，什么都试不出来。
// 发消息一律经 internalRequest 走现成的 /api/chat：额度、并发上限、单写者判活、审批全是现成路由的；这里只翻译参数与结果。

import { EventEmitter } from 'node:events';
import { kernel } from './state.mjs';
import { findApp, canUsePluginPages } from './ui.mjs';
import { requireGrant, hasGrant, onGrantRevoked } from './page-grants.mjs';
import { internalRequest, routeError, identityOfCtx } from '../agent-api/internal.mjs';
import { pluginSessions, markPluginSession, getGens, getLiveGens, genSubscribe, onLiveGensChange } from '../runtime/gen.mjs';
import { writeSseHeaders, sseWrite, HEARTBEAT_MS } from '../runtime/sse.mjs';
import { setNoticeSuppressor } from '../runtime/notices.mjs';

export const PROMPT_MAX = 100_000;
export const IDLE_CLOSE_MS = 30 * 60_000;
const SID_RE = /^[0-9A-Za-z-]{8,80}$/;
const APP_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9._:\[\]-]{1,80}$/;
const EFFORT_RE = /^[a-z]{1,16}$/;
const TERMINAL = new Set(['done', 'error', 'interrupted']);

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// 会话必须是这个插件替这个使用者开的；否则当不存在
function ownSession(c, pluginId, sid) {
  const s = String(sid || '');
  const ps = SID_RE.test(s) ? pluginSessions.get(s) : null;
  if (!ps || ps.plugin !== pluginId || ps.owner !== c.key) throw err(404, '没有这个会话（不是这个插件替你开的）');
  return s;
}

// /api/chat 没开成 SSE（回了 JSON / 文本错误）→ 带人话的错误。状态码尽量原样（401 / 403 / 409 / 429 / 400），别的算 502。
function chatRouteError(r) {
  const j = r.json || {};
  const status = [400, 401, 403, 409, 413, 429].includes(r.status) ? r.status : 502;
  if (j.code === 'held_elsewhere') return err(409, '这个会话正被电脑上的 Claude Desktop / 命令行占着，等那边结束再发');
  return err(status, routeError(r));
}

// SSE 开起来了但没拿到会话 id：看错误帧。额度 → 429；忙（同时在跑的轮数到顶）→ 409；等太久 → 504。
function startError(r) {
  const e = r.events.find((ev) => ev.type === 'error');
  if (e) {
    const msg = [e.title, e.message].filter(Boolean).join('：') || '没能开始这一轮';
    const status = e.kind === 'quota' || e.kind === 'rate_limit' ? 429 : e.kind === 'busy' ? 409 : 502;
    return err(status, msg, { kind: String(e.kind || 'error') });
  }
  if (r.timedOut) return err(504, '等了 90 秒还没开始（服务器可能很忙），稍后再看看');
  return err(502, '没能开始这一轮');
}

const until = (ev) => ev.type === 'session' || TERMINAL.has(ev.type);

/** 开一个新会话：{ sessionId }。identity = 使用者身份（内部请求用）；ticketApp = 票据上的应用 id（独立页面以它为准）。 */
export async function chatStart(c, identity, pluginId, b, ticketApp = null) {
  requireGrant(pluginId, c.key, 'page.chat');
  const x = isObj(b) ? b : {};
  const prompt = typeof x.prompt === 'string' ? x.prompt : '';
  if (!prompt.trim()) throw err(400, '要 prompt：发给 Claude 的第一句话');
  if (prompt.length > PROMPT_MAX) throw err(413, `prompt 太长了（上限 ${PROMPT_MAX} 字）`);
  // 应用：票据上的为准；嵌入模式（宿主代发、没有票据）用请求体里的——宿主只放行本插件的路径，至多冒充本插件的另一个应用
  let app = ticketApp || null;
  if (!app && APP_RE.test(String(x.app || '')) && findApp(c, pluginId, String(x.app))) app = String(x.app);
  const label = (app && findApp(c, pluginId, app)?.title) || kernel.get(pluginId)?.name || pluginId;
  const body = { message: prompt, agent: 'claude', pluginOrigin: { plugin: pluginId, app, label } };
  if (MODEL_RE.test(String(x.model || ''))) body.model = String(x.model);
  if (EFFORT_RE.test(String(x.effort || ''))) body.effort = String(x.effort);
  // 不带 family：带了会按「无人值守的会话间发起」处理（session-family.mjs），这里是使用者本人在页面上发起的
  const r = await internalRequest(identity, 'POST', '/api/chat', body, { until, timeoutMs: 90_000 });
  if (!r.sse) throw chatRouteError(r);
  const sid = r.events.find((ev) => ev.type === 'session')?.sessionId;
  r.res.detach();   // 不再挂在这一轮上（关订阅不停这一轮）；页面要看进度走 chat/events
  if (!sid) throw startError(r);
  // 这里再亲手打一次标，别只靠 agents/claude/frames.mjs 的 onInit 打（经 plugin-origin.mjs，读本轮状态 run 上的
  // pluginOrigin）：新会话可能被预热好的 CLI（spare）接走，那条 init 消息落在预热那一轮的 run 上、拿不到这次的
  // pluginOrigin，标就漏了——之后 send / events / history 全会 404，会话列表也没有应用标签。
  // 两处标的内容一样，重复标是空操作（markPluginSession 比对后直接返回）。
  markPluginSession(String(sid), { plugin: pluginId, app, label, owner: c.key });
  return { sessionId: String(sid) };
}

/** 在本插件开的会话里接着说：这一会话正在跑就排队（这一轮结束后自动发）。 */
export async function chatSend(c, identity, pluginId, b) {
  requireGrant(pluginId, c.key, 'page.chat');
  const x = isObj(b) ? b : {};
  const sid = ownSession(c, pluginId, x.sessionId);
  const text = typeof x.text === 'string' ? x.text : '';
  if (!text.trim()) throw err(400, '要 text：要发的内容');
  if (text.length > PROMPT_MAX) throw err(413, `text 太长了（上限 ${PROMPT_MAX} 字）`);
  const body = { message: text, agent: 'claude', sessionId: sid };
  // 「正在跑」只认还没回 done 的轮：done 已发、只剩定局收尾（finalizing，1–3s 后才 closeTurn）的 gen 虽然还算 live，
  // 页面那头这一轮已经结束了。把它当在跑就会排进队列，要等收尾完 + 队列的延迟才发出（要多等 2–3s，页面还白看一句
  // 「上一轮还没完」）。普通发送在 /api/chat 里自带 fin-wait：喊它快收、收完接着用停放的 CLI——同 Claude 页
  //（done 那一刻 busy 就落了，之后的消息走普通发送）与侧栏工作点（routes/sessions.mjs 同样排除 finalizing）。
  if (getLiveGens(c.key).some((g) => g.sessionId === sid && !g.finalizing)) body.priority = 'later';
  let r = await internalRequest(identity, 'POST', '/api/chat', body, { until, timeoutMs: 90_000 });
  if (!r.sse) {
    if (r.status === 200 && body.priority) return { ok: true, queued: true };
    if (r.status === 409 && r.json?.code === 'not_running' && body.priority) {
      // 刚好收尾了：去掉排队重发一次
      delete body.priority;
      r = await internalRequest(identity, 'POST', '/api/chat', body, { until, timeoutMs: 90_000 });
      if (!r.sse) throw chatRouteError(r);
    } else throw chatRouteError(r);
  }
  const started = r.events.some((ev) => ev.type === 'session');
  r.res.detach();
  if (!started && r.events.some((ev) => ev.type === 'error')) throw startError(r);
  return { ok: true, queued: false };
}

export async function chatStop(c, identity, pluginId, b) {
  requireGrant(pluginId, c.key, 'page.chat');
  const sid = ownSession(c, pluginId, isObj(b) ? b.sessionId : '');
  const r = await internalRequest(identity, 'POST', '/api/stop', { sessionId: sid });
  if (r.status !== 200) throw err(r.status >= 400 && r.status < 500 ? r.status : 502, routeError(r));
  return { ok: true };
}

/**
 * 本插件替这个使用者开过的会话（app 给了就只要这个应用的），新的在前，最多 100 个。
 * 转录已经没了的（用户在 Claude 分页删了 / 清理掉了）不列：pluginSessions 只增不减，不筛的话页面会列出点开就 404 的会话。
 * 正在跑的轮所属的会话照列——新会话第一轮开起来到 CLI 落第一行转录之间，磁盘上还没有文件。
 */
export async function chatSessions(c, pluginId, app = '') {
  requireGrant(pluginId, c.key, 'page.chat');
  const want = APP_RE.test(String(app || '')) ? String(app) : '';
  const all = [];
  for (const [sid, ps] of pluginSessions) {
    if (!ps || ps.plugin !== pluginId || ps.owner !== c.key) continue;
    if (want && ps.app !== want) continue;
    all.push({ sessionId: sid, app: ps.app || null, label: ps.label || '', at: ps.at || 0 });
  }
  all.sort((a, b) => b.at - a.at);
  const live = new Set(getLiveGens(c.key).map((g) => g.sessionId).filter(Boolean));
  const exists = await transcriptChecker();
  const now = Date.now();
  for (const [k, exp] of missingUntil) if (exp <= now) missingUntil.delete(k);
  const out = [];
  for (const s of all) {
    if (out.length >= 100) break;
    if (live.has(s.sessionId)) { out.push(s); continue; }
    const mk = c.key + '\n' + s.sessionId;
    if (missingUntil.has(mk)) continue;
    if (exists(c, s.sessionId)) out.push(s);
    else missingUntil.set(mk, now + MISSING_TTL_MS);
  }
  return out;
}

// 「转录没了」的判定记一阵：定位器每次要重算项目与作用域、逐个查盘，转录没了的还得把所有作用域扫空才能下结论；
// pluginSessions 又只增不减，不记的话插件用久了，每次列会话都要把历史上删掉的会话全扫一遍、阻塞事件循环。
// 只记「没了」、不记「在」：在的会被用户随时删掉，没了的基本不会回来；万一回来（同一 id 又跑起来）会先以正在跑的身份照列，
// 过期后也会重新判定。按 (使用者, 会话) 记——定位器按身份找根目录，同一 id 在不同人那里结论可以不同。
const MISSING_TTL_MS = 60_000;
const missingUntil = new Map();   // `${ownerKey}\n${sessionId}` → 到期时刻

// 「这个会话的转录还在不在」：用现成的定位器（runtime/session-family.mjs 的 sessionFileOf，背后是 claude-projects 的
// locateSessionPaths——会话可能在任一项目目录、成员有自己的根），不自己拼路径。懒加载：session-family 依赖很重，
// 只有真有页面来列会话时才拉进来。定位器自己出错就当还在（宁可多列一个点开 404 的，也别因为一次读盘失败把列表清空）。
let transcriptCheck = null;
async function transcriptChecker() {
  if (transcriptCheck) return transcriptCheck;
  const { sessionFileOf } = await import('../runtime/session-family.mjs');
  transcriptCheck = (c, sid) => { try { return !!sessionFileOf(c, sid); } catch { return true; } };
  return transcriptCheck;
}
/** 测试用：换掉转录存在性检查（fn(ctx, sid) → 布尔；null 恢复真的定位器）。 */
export function _setTranscriptCheck(fn) { transcriptCheck = typeof fn === 'function' ? fn : null; missingUntil.clear(); }

// —— 页面报到「正看着这个会话」（_bridge/chat/watch）——
// 页面开着某个会话、而且在前台时每隔一阵报一次到（visible:true），切走 / 关掉时报 visible:false。
// 报到期内这个会话的一轮完成 / 出错不再弹 bridge 通知（人就盯着页面，再弹一条是打扰）；提问 / 审批照弹（notices.mjs）。
// 75 秒过期：页面崩了、断网了、标签页被系统冻结了没来得及说 visible:false，最多 75 秒后通知恢复（页面约 30 秒续一次）。
// 只记在内存里：进程重启就当没人看着，宁可多弹一条也别漏。
export const WATCH_TTL_MS = 75_000;
let watchTtl = WATCH_TTL_MS;
const watches = new Map();   // `${ownerKey}\n${sessionId}` → { plugin, exp }
const wkey = (owner, sid) => owner + '\n' + sid;
function pruneWatches(now = Date.now()) {
  for (const [k, w] of watches) if (w.exp <= now) watches.delete(k);
}

export function chatWatch(c, pluginId, b) {
  requireGrant(pluginId, c.key, 'page.chat');
  const x = isObj(b) ? b : {};
  const sid = ownSession(c, pluginId, x.sessionId);
  if (x.visible !== undefined && typeof x.visible !== 'boolean') throw err(400, 'visible 要 true（正看着）或 false（不看了）');
  const k = wkey(c.key, sid);
  if (x.visible === false) { watches.delete(k); return { ok: true, watching: false }; }
  const now = Date.now();
  pruneWatches(now);
  watches.set(k, { plugin: pluginId, exp: now + watchTtl });
  return { ok: true, watching: true, ttl: Math.round(watchTtl / 1000) };
}

/** 有没有插件页面正看着这个使用者的这个会话（报到没过期、插件还开着）。notices.mjs 的收尾通知据此不弹。 */
export function watchedByPage(ownerKey, sid) {
  if (!ownerKey || !sid) return false;
  const k = wkey(String(ownerKey), String(sid));
  const w = watches.get(k);
  if (!w) return false;
  if (w.exp <= Date.now() || !kernel.isActive(w.plugin)) { watches.delete(k); return false; }
  return true;
}

/** 测试用：改报到有效期（毫秒；不传恢复 75 秒）并清空现有报到。 */
export function _setWatchTtl(ms) { watchTtl = Number.isFinite(ms) && ms > 0 ? ms : WATCH_TTL_MS; watches.clear(); }

// 撤销 page.chat：这个插件替这个人报的到全部作废（页面已经没权再看了，别让它继续压着通知）
onGrantRevoked((plugin, owner, perm) => {
  if (perm !== 'page.chat') return;
  for (const [k, w] of watches) if (w.plugin === plugin && k.startsWith(owner + '\n')) watches.delete(k);
});
// 本模块一加载（插件系统起来了）就把钩子挂进通知；没有插件系统时 notices.mjs 什么都不挡
setNoticeSuppressor(watchedByPage);

// 一条消息的正文：用户消息是 text；Claude 的是各段正文（kind:'text' 的 md）拼起来（同 agent 接口 sessions.read）
function messageText(m) {
  if (m.role === 'user') return String(m.text || '');
  if (Array.isArray(m.segments)) {
    const t = m.segments.filter((s) => s && s.kind === 'text' && s.md).map((s) => s.md).join('\n').trim();
    if (t) return t;
  }
  return String(m.text || '').trim();
}

/** 会话的消息记录（读现成的 /api/session，同一份转录）：最近 200 条，每条截 20000 字。 */
export async function chatHistory(c, identity, pluginId, sessionId) {
  requireGrant(pluginId, c.key, 'page.chat');
  const sid = ownSession(c, pluginId, sessionId);
  const r = await internalRequest(identity, 'GET', '/api/session?id=' + encodeURIComponent(sid));
  // 新会话第一轮开起来到 CLI 落第一行转录之间磁盘上还没有文件（同 chatSessions）：轮还在跑就是「还没有记录」，不是「记录没了」，
  // 回空——页面刚 start 完就拉历史时不该看到红字，接着订阅事件流就能等到这一轮
  if (r.status === 404 && getLiveGens(c.key).some((g) => g.sessionId === sid)) return { messages: [] };
  if (r.status === 404) throw err(404, '这个会话的记录没有了');
  if (r.status !== 200 || !r.json) throw err(502, routeError(r));
  const all = Array.isArray(r.json.messages) ? r.json.messages : [];
  const messages = all
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, text: clip(messageText(m), 20000) }))
    .filter((m) => m.text);
  return { messages: messages.slice(-200) };
}

/** gen 事件 → 页面事件（查映射表）；不在表里的回 null，不转。 */
export function mapChatEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  switch (ev.type) {
    case 'text':
      return typeof ev.text === 'string' && ev.text ? { type: 'text', text: ev.text } : null;
    case 'tool':
      return { type: 'tool', id: String(ev.id || ''), name: String(ev.name || ''), status: 'start' };
    case 'tool_done':
      return { type: 'tool', id: String(ev.id || ''), status: 'done', isError: !!ev.isError };
    case 'perm_request':
      if (!ev.qid) return null;
      return {
        type: 'approval', kind: 'permission', qid: String(ev.qid), title: clip(ev.title || ev.displayName || ev.tool || '', 300),
        ...(ev.description ? { description: clip(ev.description, 2000) } : {}),
      };
    case 'plan_request': {
      if (!ev.qid) return null;
      const plan = String(ev.plan || '');
      const first = plan.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '计划';   // i18n-ignore
      return { type: 'approval', kind: 'plan', qid: String(ev.qid), title: clip(first, 300), ...(plan ? { description: clip(plan, 2000) } : {}) };
    }
    case 'question': {
      // 没有 qid 的 question 帧是「这个会话有没有待答」的状态通知，不是一张提问卡
      if (!ev.qid) return null;
      const q = Array.isArray(ev.questions) ? ev.questions[0] : null;
      return { type: 'approval', kind: 'question', qid: String(ev.qid), title: clip(q?.question || q?.header || '', 300) };
    }
    case 'perm_answer': case 'plan_answer': case 'answer':
      return ev.qid ? { type: 'approval.done', qid: String(ev.qid) } : null;
    case 'done':
      return { type: 'done', ok: !ev.isError, result: clip(ev.result || '', 20000) };
    case 'interrupted':
      return { type: 'done', ok: false, interrupted: true };
    case 'error':
      return { type: 'error', kind: String(ev.kind || 'error'), message: clip([ev.title, ev.message].filter(Boolean).join('：') || ev.hint || '', 2000) };
    default:
      return null;
  }
}

// 挂在 gen.subscribers 里的「假连接」：gen 往它写的是 SSE 文本（data: …\n\n），这里拆回事件对象交给 onEvent；
// gen 收尾时调 end()。emit('close') 让 genSubscribe 挂的监听把它从 subscribers 里摘掉。
class Tap extends EventEmitter {
  constructor(onEvent, onEnd) {
    super();
    this.writableEnded = false;
    this.pending = '';
    this.onEvent = onEvent;
    this.onEnd = onEnd;
  }
  write(chunk) {
    if (this.writableEnded || chunk == null) return true;
    this.pending += String(chunk);
    let i;
    while ((i = this.pending.indexOf('\n\n')) >= 0) {
      const block = this.pending.slice(0, i);
      this.pending = this.pending.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;   // 心跳注释
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      try { this.onEvent(ev); } catch {}
    }
    return true;
  }
  end() {
    if (this.writableEnded) return;
    this.writableEnded = true;
    try { this.onEnd(); } catch {}
    this.emit('close');
  }
  close() { if (!this.writableEnded) { this.writableEnded = true; this.emit('close'); } }
}

// 轮次号：同一轮（同一个 gen 对象）不管是连上时补发还是之后实时推，号都一样；SDK 断线重连去重靠它认「还是不是同一轮」，
// 光比 userText 认不出「同一句话又发了一遍」。gen 自己没有唯一字段：用开轮时刻（毫秒，overview 的 attach 也拿它当轮次）+
// 会话 id，再缀一个本进程递增号——排队的下一轮可能在上一轮收尾的同一毫秒开起来，光靠时刻会撞号。
// 按 gen 对象记住，第一次算出来以后不再变（新会话的 gen 起初没有会话 id，挂上时才有）。gen 只活在内存里，进程重启就没了，号不必跨进程。
const turnIds = new WeakMap();
let turnSeq = 0;
export function turnIdOf(g, sid = '') {
  let id = turnIds.get(g);
  if (id) return id;
  const at = Number.isFinite(g.startedAt) && g.startedAt > 0 ? Math.floor(g.startedAt) : Date.now();
  id = at.toString(36) + '.' + (++turnSeq).toString(36) + '-' + String(g.sessionId || sid || '');
  turnIds.set(g, id);
  return id;
}

/**
 * 页面订阅一个会话：SSE。连上时这一会话有正在跑的轮就先补发它已有的事件；之后每开一轮（页面发的、排队接着发的、
 * 用户在 Claude 分页里接着说的）都推 { type: 'turn', turn, userText } 再推这一轮的事件，直到页面断开或 30 分钟没有新轮。
 * turn 是这一轮的轮次号（见 turnIdOf），补发与实时推同号。
 * 前置检查（授权、归属）不过就抛，调用方回 JSON 错误；过了才写 SSE 头。
 * 连上以后条件也会变，变了就当场断开（SDK 重连时拿到 403 needGrant / 404 就停）：撤销 page.chat、插件停用 / 出错 / 卸载
 * 立刻断；成员不再能用这个插件的页面、账号停用 / 删除，在下一次心跳或下一轮挂上之前断。只要用户还在用这个会话，
 * 流就不会因为空闲自己关——不复核的话，撤了授权的页面照样能一直读到用户之后在 Claude 分页里接着说的内容。
 */
export function chatEvents(c, pluginId, sessionId, res, { idleMs = IDLE_CLOSE_MS, heartbeatMs = HEARTBEAT_MS } = {}) {
  requireGrant(pluginId, c.key, 'page.chat');
  const sid = ownSession(c, pluginId, sessionId);
  writeSseHeaders(res);
  res.write(': ok\n\n');
  const seen = new WeakSet();
  const taps = new Set();
  let closed = false;
  let idle = null;
  const send = (obj) => { if (!closed) sseWrite(res, obj); };
  const shut = () => { try { res.end(); } catch {} cleanup(); };
  // 还能不能接着推。hasGrant 每次现读 grants.json、identityOfCtx 现读账号库，所以只在心跳与新一轮挂上前调，不逐个事件调
  const allowed = () => {
    try {
      return canUsePluginPages(c, pluginId) && hasGrant(pluginId, c.key, 'page.chat') && !!identityOfCtx(c);
    } catch { return false; }
  };
  const recheck = () => {
    if (closed) return false;
    if (allowed()) return true;
    shut();
    return false;
  };
  const armIdle = () => {
    clearTimeout(idle);
    idle = null;
    if (taps.size || closed) return;
    idle = setTimeout(shut, idleMs);
    idle.unref?.();
  };
  const attach = (g) => {
    if (closed || seen.has(g)) return;
    seen.add(g);
    clearTimeout(idle);
    idle = null;
    send({ type: 'turn', turn: turnIdOf(g, sid), userText: clip(g.userText || '', 20000) });
    // 先补发缓冲里已有的（缓冲里相邻的正文增量已合并成块，页面照样当增量拼）
    for (const ev of g.events) { const m = mapChatEvent(ev); if (m) send(m); }
    if (g.done) { armIdle(); return; }
    const tap = new Tap((ev) => { const m = mapChatEvent(ev); if (m) send(m); }, () => { taps.delete(tap); armIdle(); });
    taps.add(tap);
    genSubscribe(g, tap);
  };
  // 有要挂的新轮才复核（onLiveGensChange 是全进程的，别的会话、别人的轮开了也会叫）
  const scan = () => {
    const fresh = getGens(c.key).filter((g) => !g.done && g.sessionId === sid && !seen.has(g));
    if (!fresh.length || closed || !recheck()) return;
    for (const g of fresh) attach(g);
  };
  // 新一轮占位时（tryStartGen）会通知；新会话的 gen 要等 SDK init 才有会话 id，所以心跳时也顺手再扫一遍兜底
  const off = onLiveGensChange(scan);
  const beat = setInterval(() => { if (!closed && !res.writableEnded && recheck()) { res.write(': ping\n\n'); scan(); } }, heartbeatMs);
  beat.unref?.();
  // 撤销 page.chat：当场断（不等心跳）
  const offRevoke = onGrantRevoked((plugin, owner, perm) => { if (plugin === pluginId && owner === c.key && perm === 'page.chat') shut(); });
  // 插件停用 / 出错 / 卸载 / 重载（重载可能去掉了声明或成员入口）：当场复核
  const offKernel = typeof kernel.on === 'function' ? kernel.on('change', () => { recheck(); }) : () => {};
  function cleanup() {
    if (closed) return;
    closed = true;
    off();
    offRevoke();
    offKernel();
    clearInterval(beat);
    clearTimeout(idle);
    for (const t of taps) t.close();
    taps.clear();
  }
  // 只听 res 的 close：IncomingMessage 的 close 在请求体读完时就会发（GET 立刻），不代表页面断开
  res.on('close', cleanup);
  scan();
  armIdle();
  return cleanup;
}
