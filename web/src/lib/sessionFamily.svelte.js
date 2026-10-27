// 会话派生与会话间消息的前端一侧（服务端 src/runtime/session-family.mjs）。
//  · parseSessionText：用户气泡的正文里认出服务端拼的信封——
//      <session-message from name title relation [kind="brief"]>正文</session-message>   另一个会话发来的话 / 父会话派的任务
//      <side-sessions-event> … <note from name title status>开头 400 字</note> … </side-sessions-event>   子会话汇报
//      <cross-session-message from from-name from-session source>正文</cross-session-message>   官方 Claude Desktop / 终端会话发来的（session-peers.mjs）
//      <session-hint>…</session-hint>   只给模型看的提示，界面上不显示
//    其余文字（用户自己打的字，攒着的会话消息会附在它后面）照常当气泡。
//  · 会话引用：工具行 / 卡片要跳到「标题叫 X 的子会话」「name 叫 y 的会话」——按侧栏会话列表（ClaudePage 注册进来）
//    与本轮流里的 family_link 事件解析成会话 id。
//  · 「Claude 发起新会话」的卡（2026-10-20，对齐官方 Desktop 3.1623；服务端 session-proposals.mjs / routes/session-collab.mjs）：
//    collab.proposals 按 task_xxxxxxxx 记 offer 卡 / 提议卡 / 直接开始档的「已开始」卡，工具行按 toolUseId 对上。
//    三路来源：GET /api/claude/proposals（打开会话时）、总线 {type:'proposal'}（权威，多设备同步）、
//    本轮流里的 offer / offer_answer / proposal / family_link 帧（只往前推状态，attach 重放旧帧不会把卡拨回去）。
//  · 跨会话消息「待你确认」（设置 crossSessionInbound = hold）：collab.holds[会话] = 扣着的消息，总线 {type:'peer_hold'}，
//    hello.peerHolds 重连对账；别的会话里新扣下的给个轻提示，侧栏「等你」小点走服务端顺带推的 question 帧。
import { api } from './api.js';
import { busOn } from './bus.js';
import { IS_CSNAP } from './csnap.js';
import { session, ui } from './state.svelte.js';
import { t } from './i18n.js';

const ATTR_RE = /(\w[\w-]*)="([^"]*)"/g;
function attrs(s) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) out[m[1]] = m[2];
  return out;
}

export function hasSessionEnvelope(text) {
  return typeof text === 'string' && /<(session-message|side-sessions-event|cross-session-message)\b/.test(text);
}

// → { parts: [{ kind:'message', from, name, title, relation, brief, body } | { kind:'event', notes:[...] }
//             | { kind:'peer', from, name, fromSession, source, body }], rest }
export function parseSessionText(text) {
  const parts = [];
  if (!hasSessionEnvelope(text)) return { parts, rest: text || '' };
  // 跨会话信封最先拆、正文原样留着不再往里解析：别的 Claude 会话发来的话里夹着 bridge 自己的信封，
  // 不能被拆成「父会话派来的任务」卡，也不能被当成 session-hint 藏掉（服务端 peerDisplay 另有一道中和）
  const peers = [];
  let rest = String(text).replace(/<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/g, (_, a, body) => {
    const x = attrs(a);
    const fromSession = x['from-session'] || '';
    peers.push({ kind: 'peer', from: x.from || '', name: x['from-name'] || '', fromSession, source: x.source || (/^local_/.test(fromSession) ? 'desktop' : ''), body: body.trim() });
    return '';
  });
  rest = rest.replace(/<session-hint>[\s\S]*?<\/session-hint>/g, '');
  rest = rest.replace(/<session-message\b([^>]*)>([\s\S]*?)<\/session-message>/g, (_, a, body) => {
    const x = attrs(a);
    parts.push({ kind: 'message', from: x.from || '', name: x.name || '', title: x.title || '', relation: x.relation || 'linked', brief: x.kind === 'brief', body: body.trim() });
    return '';
  });
  rest = rest.replace(/<side-sessions-event>([\s\S]*?)<\/side-sessions-event>/g, (_, inner) => {
    const notes = [];
    inner.replace(/<note\b([^>]*)>([\s\S]*?)<\/note>/g, (__, a, body) => {
      const x = attrs(a);
      notes.push({ from: x.from || '', name: x.name || '', title: x.title || '', status: x.status || 'done', text: body.trim() });
      return '';
    });
    parts.push({ kind: 'event', notes });
    return '';
  });
  parts.push(...peers);
  return { parts, rest: rest.trim() };
}

// 任务说明里的「【背景】/【任务】」小标题拆成段落（父会话派任务时服务端这样拼）
export function briefSections(body) {
  const out = [];
  const re = /【(背景|任务)】\s*([\s\S]*?)(?=【(?:背景|任务)】|$)/g;
  let m;
  while ((m = re.exec(body))) out.push({ label: m[1], text: m[2].trim() });
  return out.length ? out : [{ label: '', text: body }];
}

// —— 会话引用 ——
const store = $state({ links: [] });   // 本端看到过的 family_link：{ parent, child, title, name }
let source = () => [];
export function setSessionSource(fn) { source = typeof fn === 'function' ? fn : () => []; }
export function noteFamilyLink(ev) {
  if (!ev || !ev.child) return;
  // 从卡片 / 直接开始档开出来的：卡片当场切到「已开始」（总线那帧稍后到，权威值以它为准）
  if (ev.task) noteProposal({ id: ev.task, status: 'started', child: ev.child, ...(ev.toolUseId ? { toolUseId: ev.toolUseId } : {}), ...(ev.auto ? { auto: true } : {}) }, { weak: true });
  if (store.links.some((l) => l.child === ev.child)) return;
  store.links.push({ parent: ev.parent || '', child: ev.child, title: ev.title || '', name: ev.name || '' });
}

const list = () => { try { return source() || []; } catch { return []; } };
export function sessionById(id) { return id ? list().find((s) => s.id === id) || null : null; }
export function sessionTitle(id, fallback = '') {
  const s = sessionById(id);
  if (s && s.title) return s.title;
  const l = store.links.find((x) => x.child === id);
  return (l && l.title) || fallback;
}

// 父会话里「标题叫 title 的子会话」：先看本端流里的 family_link，再按会话列表的 spawnedBy + 标题
export function childByTitle(parentId, title) {
  if (!title) return '';
  const l = store.links.filter((x) => x.title === title && (!parentId || x.parent === parentId)).at(-1);
  if (l) return l.child;
  const hit = list().filter((s) => s.title === title && (!parentId || s.spawnedBy === parentId));
  return hit.length ? hit[0].id : '';
}

// send_message / read_session 的 to：id / name / "parent"
export function resolveSessionRef(currentId, to) {
  const v = String(to || '').trim();
  if (!v) return '';
  const all = list();
  if (v === 'parent') { const me = all.find((s) => s.id === currentId); return (me && me.spawnedBy) || ''; }
  if (all.some((s) => s.id === v)) return v;
  const l = store.links.find((x) => x.name === v);
  if (l) return l.child;
  if (v.length >= 8) { const p = all.find((s) => s.id.startsWith(v)); if (p) return p.id; }
  return '';
}

// 会话信息面板：同一棵树里的会话（来自 /api/claude/session-rail 的 family）
export const STATE_LABEL = { working: '正在干活', idle: '空闲' };
export const REL_LABEL = { parent: '父会话', child: '子会话', sibling: '兄弟会话', linked: '相关会话' };

// —— 「Claude 发起新会话」的卡 ——
// live：哪些会话此刻在跑（总线 hello.runs / run.start / run.end）——「已开始」卡判子会话在不在干活。
// 侧栏列表（setSessionSource）在分屏格 / 独立窗口里没有，不能只靠它。
export const collab = $state({ proposals: {}, holds: {}, live: {} });
const TASK_RE = /^task_[0-9a-f]{8}$/;
// 状态只往前走（流里的旧帧重放时不拨回去）；start_failed / unanswered 之后用户还能再点开始，由权威来源改回 starting
const RANK = { pending: 0, accepted: 1, starting: 2 };
const rank = (st) => (st in RANK ? RANK[st] : 3);
const LIVE = new Set(Object.keys(RANK));   // 还没结局的卡

/** 合并一张卡。weak = 来自本轮流里的帧：只补没有的字段、状态只往前推；否则（接口 / 总线）照单全收。 */
export function noteProposal(p, { weak = false } = {}) {
  if (!p || !TASK_RE.test(String(p.id || ''))) return;
  const cur = collab.proposals[p.id];
  if (!cur) { collab.proposals[p.id] = { status: 'pending', ...p }; return; }
  if (!weak) { Object.assign(cur, p); if (!('qid' in p)) delete cur.qid; return; }
  for (const [k, v] of Object.entries(p)) {
    if (k === 'status') { if (rank(v) > rank(cur.status)) cur.status = v; }
    else if (cur[k] === undefined || cur[k] === '' || cur[k] === null) cur[k] = v;
  }
}

/** 本轮流里的卡片帧（chat.svelte.js 转来）。 */
export function noteCollabEvent(ev) {
  if (!ev) return;
  if (ev.type === 'offer') {
    noteProposal({ id: ev.taskId, kind: 'offer', status: 'pending', qid: ev.qid, title: ev.title || '', toolUseId: ev.toolUseId || '', parent: ev.sessionId || '', asked: ev.asked || '' }, { weak: true });
  } else if (ev.type === 'offer_answer') {
    noteProposal({ id: ev.taskId, status: ev.status || 'dismissed' }, { weak: true });
  } else if (ev.type === 'proposal' && ev.proposal) {
    noteProposal({ ...ev.proposal, kind: ev.proposal.kind === 'offer' ? 'offer' : 'own' }, { weak: true });
  }
}

// 一次 start_session 正常只对应一张卡（服务端保证）；旧数据里万一有两条，取最新的那条
export function proposalForTool(toolUseId) {
  if (!toolUseId) return null;
  let hit = null;
  for (const p of Object.values(collab.proposals)) if (p.toolUseId === toolUseId && (!hit || (p.createdAt || 0) >= (hit.createdAt || 0))) hit = p;
  return hit;
}

// 打开会话时拉一次它名下的卡（历史重开、别的设备上答过的都靠这里对上）
const loaded = new Map();   // 会话 id -> Promise
export function loadProposals(sid, { force = false } = {}) {
  if (!sid || IS_CSNAP) return Promise.resolve();
  if (!force && loaded.has(sid)) return loaded.get(sid);
  const pr = api.get('/api/claude/proposals?session=' + encodeURIComponent(sid))
    .then((r) => { for (const p of (r && r.items) || []) noteProposal(p); })
    .catch(() => { loaded.delete(sid); });   // 没权限（普通注册用户）/ 离线：不缓存失败，下次再试
  loaded.set(sid, pr);
  return pr;
}

const errText = (e) => (e?.body && typeof e.body === 'object' ? (e.body.error || e.body.message) : '') || e?.message || '';

/** offer 卡上的选择：new_session / here / always_new / always_here（走 /api/answer，服务端 waitForAnswer 在等）。 */
export async function answerOffer(p, choice) {
  if (!p || !p.qid || p.busy) return { ok: false };
  p.busy = true;
  try { await api.answer(p.qid, { choice }); return { ok: true }; }
  catch (e) { p.error = errText(e); return { ok: false, error: p.error }; }
  finally { p.busy = false; }
}

/** 卡片上点「开始」（一张或「全部开始」）。useWorktree 只对单张生效（「选项」里改的）。 */
export async function startProposals(ids, { useWorktree } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => TASK_RE.test(String(id)));
  if (!list.length) return { ok: false };
  for (const id of list) { const p = collab.proposals[id]; if (p) { p.busy = true; p.error = ''; } }
  try {
    const r = await api.post('/api/claude/proposal/start', {
      ...(list.length === 1 ? { taskId: list[0] } : { ids: list }),
      ...(list.length === 1 && typeof useWorktree === 'boolean' ? { useWorktree } : {}),
    });
    for (const x of (r && r.results) || []) {
      if (x.proposal) noteProposal(x.proposal);
      const p = collab.proposals[x.id];
      if (p && !x.ok && x.error) p.error = x.error;
    }
    return r || { ok: false };
  } catch (e) {
    const err = errText(e);
    for (const x of (e?.body && e.body.results) || []) if (x.proposal) noteProposal(x.proposal);
    for (const id of list) { const p = collab.proposals[id]; if (p) p.error = err; }
    return { ok: false, error: err };
  } finally {
    for (const id of list) { const p = collab.proposals[id]; if (p) p.busy = false; }
  }
}

/** 卡片右上 X：忽略这条建议。 */
export async function dismissProposal(id) {
  const p = collab.proposals[id];
  if (!p || p.busy) return;
  p.busy = true;
  try { const r = await api.post('/api/claude/proposal/dismiss', { taskId: id }); if (r && r.proposal) noteProposal(r.proposal); }
  catch (e) { if (e?.body && e.body.proposal) noteProposal(e.body.proposal); else p.error = errText(e); }
  finally { p.busy = false; }
}

// —— 跨会话消息「待你确认」——
let holdsOff = false;   // 不是主机管理员（接口 401/403）：这条通道没有，别每切一个会话都问一次
export function loadPeerHolds(sid) {
  if (!sid || IS_CSNAP || holdsOff) return;
  api.get('/api/claude/peer-hold?session=' + encodeURIComponent(sid))
    .then((r) => { collab.holds[sid] = Array.isArray(r && r.items) ? r.items : []; })
    .catch((e) => { if (e && (e.status === 401 || e.status === 403)) holdsOff = true; });
}
/** action：accept = 投递给这个会话；refuse = 拒收（整批）。 */
export async function resolvePeerHolds(sid, action) {
  try { await api.post('/api/claude/peer-hold', { session: sid, action }); collab.holds[sid] = []; return { ok: true }; }
  catch (e) { return { ok: false, error: errText(e) }; }
}

// 别的会话里刚扣下一条（当前打开的会话有横条，不用提醒）：轻提示一下——停放的 CLI 15 分钟到点退出，扣着的就作废了。
// 侧栏那个会话的「等你」小点由服务端顺带推的 question 帧点亮。
const showToast = (text) => { import('./toast.svelte.js').then((m) => m.showToast(text)).catch(() => {}); };
const notifyKind = (kind, opts) => { import('./notify.js').then((m) => m.notifyKind(kind, opts)).catch(() => {}); };
const srcLabel = (x) => (x.source === 'desktop' ? t('Claude Desktop 会话') : x.source === 'terminal' ? t('终端会话') : t('另一个 Claude 会话'));
function noteHolds(sid, items) {
  const prev = new Set((collab.holds[sid] || []).map((x) => x.uuid));
  collab.holds[sid] = items;
  const fresh = items.filter((x) => !prev.has(x.uuid));
  if (fresh.length && !IS_CSNAP) {
    const x = fresh[fresh.length - 1];
    const body = t('{name}（{src}）发来一条消息，等你确认', { name: x.name || t('未命名会话'), src: srcLabel(x) });
    if (sid !== session.id) showToast(body);
    // 人不在页面上（标签页藏着 / 窗口最小化）也得知道：走「Claude 提问」那一类系统通知，按消息去重；正看着这个会话时不弹
    notifyKind('question', { body, watching: sid === session.id && ui.screen === 'claude' && !document.hidden, tag: 'peer:' + x.uuid });
  }
}

busOn((ev) => {
  if (!ev || !ev.type) return;
  if (ev.type === 'proposal' && ev.proposal) noteProposal(ev.proposal);
  else if (ev.type === 'peer_hold' && ev.sessionId) noteHolds(ev.sessionId, Array.isArray(ev.items) ? ev.items : []);
  else if (ev.type === 'run.start' && ev.sessionId) collab.live[ev.sessionId] = true;
  else if (ev.type === 'run.end' && ev.sessionId) delete collab.live[ev.sessionId];
  if (ev.type === 'hello') {
    collab.live = Object.fromEntries((ev.runs || []).filter((r) => r && r.sessionId).map((r) => [r.sessionId, true]));
    // 重连：断开期间的卡片变化补一遍——只当场重拉当前会话和还有卡没结局的会话（只有它们可能在断线期间变）；
    // 其余打开过的标成过期、下次打开时再拉（手机一页里来回切过几十个会话，每次切回前台不再一齐打出几十个请求）
    const busy = new Set(Object.values(collab.proposals).filter((p) => p.parent && LIVE.has(p.status)).map((p) => p.parent));
    for (const sid of [...loaded.keys()]) {
      if (sid === session.id || busy.has(sid)) loadProposals(sid, { force: true });
      else loaded.delete(sid);
    }
    // 「待你确认」：hello 带了快照（新服务端、领头实例）就整份对账；没带（同源跟随实例拿到的是缓存的 hello）就把看过的会话重拉一遍
    if (ev.peerHolds && typeof ev.peerHolds === 'object') {
      for (const sid of Object.keys(collab.holds)) if (!ev.peerHolds[sid]) collab.holds[sid] = [];
      for (const [sid, items] of Object.entries(ev.peerHolds)) collab.holds[sid] = Array.isArray(items) ? items : [];
    } else {
      for (const sid of Object.keys(collab.holds)) loadPeerHolds(sid);
    }
  }
});
