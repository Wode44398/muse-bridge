// 「Claude 发起新会话」的卡片台账（2026-10-20，对齐官方 Claude Desktop 3.1623 的 start_session 三态 + dismiss_task）。
//
// 官方（主进程 proposeSideSession / enqueueBackgroundTaskSuggestion / awaitSideSessionOffer）：
//   · offer          —— 用户最新一条消息里点名了一件和手头无关的事：工具调用只带 title、阻塞等用户在卡上选
//                       「新会话 / 在这里做」；选了新会话，模型再带 proposal_id 调一次把任务说明补上，会话才开；
//   · own_initiative —— Claude 自己想到的后续工作：带完整任务说明落成一张提议卡，用户点「开始」（或口头说开）才跑，
//                       7 天过期，每个会话最多挂 20 张（超出挤掉最老的）；
//   · dismiss_task   —— 撤回一张还没被处理的卡。
// bridge 版把这些卡记在身份数据目录的 claude-session-proposals.json（与 claude-session-family.json 同目录、分开存，
// 父子关系那张表的形状不动）：{ v:1, proposals:{ task_xxxxxxxx:{…} }, muted:{ 会话 id:true } }。
// 卡片的结局都落在这里（不靠 tool_result 正文），历史重开、别的设备打开都按 toolUseId 对回工具行。
// 有了结局满 30 天的记录落盘时裁掉（KEEP_RESOLVED_MS），那次调用在历史里退回普通工具行。
// 每次变化推总线 {type:'proposal', sessionId:父会话, proposal}，多设备同步。
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, ID_RE } from '../jsonfile.mjs';
import { busPublish } from './bus.mjs';
import { pendingQuestions } from './questions.mjs';

export const PROPOSAL_TTL_MS = 7 * 24 * 3600_000;   // 官方 pb=6048e5
export const MAX_PENDING = 20;                        // 每个会话挂着的提议卡上限（官方 yb）
export const KEEP_RESOLVED_MS = 30 * 24 * 3600_000;  // 有了结局的卡留多久（之后裁掉，历史里那次调用退回普通工具行）
export const TASK_ID_RE = /^task_[0-9a-f]{8}$/;
export const newTaskId = () => 'task_' + randomUUID().replace(/-/g, '').slice(0, 8);

// 状态：
//   pending      卡在等用户（offer 卡 / 提议卡）
//   accepted     offer 卡上点了「新会话」，等模型补任务说明
//   starting     正在开（派生中）
//   started      已在自己的会话里开始（child = 子会话 id；auto = 「直接开始」档不弹卡直接开的）
//   kept_here    选了「在这里做」
//   dismissed    被撤回 / 用户点了忽略 / 被更新的卡挤掉（reason 说明）
//   expired      7 天没开始，过期
//   start_failed 没能开起来（reason 是原因；卡上可以再点一次）
//   superseded   offer 卡没人点，用户直接发了新消息
//   unanswered   offer 卡超时没人回答（或服务重启时还挂着；或选了新会话、这一轮却没补上任务说明）
const STATUSES = new Set(['pending', 'accepted', 'starting', 'started', 'kept_here', 'dismissed', 'expired', 'start_failed', 'superseded', 'unanswered']);
export const OPEN_STATUSES = new Set(['pending', 'start_failed', 'unanswered']);   // 用户还能在卡上点开始的

const fileFor = (ctx) => path.join(ctx.dataDir, 'claude-session-proposals.json');
const cache = new Map();   // file -> { proposals, muted }
const enabled = (ctx) => !!(ctx && ctx.dataDir);
const clip = (s, n) => String(s ?? '').slice(0, n);

function normalize(id, p) {
  if (!TASK_ID_RE.test(id) || !p || !ID_RE.test(String(p.parent || ''))) return null;
  return {
    id,
    parent: p.parent,
    kind: p.kind === 'offer' ? 'offer' : 'own',
    title: clip(p.title, 200),
    tldr: clip(p.tldr, 300),
    prompt: clip(p.prompt, 32_000),
    background: clip(p.background, 32_000),
    context: p.context === 'fork' ? 'fork' : 'fresh',
    useWorktree: typeof p.useWorktree === 'boolean' ? p.useWorktree : null,
    model: p.model ? clip(p.model, 80) : '',
    name: p.name ? clip(p.name, 40) : '',
    branchName: p.branchName ? clip(p.branchName, 80) : '',
    toolUseId: clip(p.toolUseId, 128),
    asked: clip(p.asked, 300),
    qid: clip(p.qid, 64),
    createdAt: Number(p.createdAt) || 0,
    expiresAt: Number(p.expiresAt) || 0,
    status: STATUSES.has(p.status) ? p.status : 'pending',
    child: ID_RE.test(String(p.child || '')) ? p.child : '',
    auto: !!p.auto,
    reason: clip(p.reason, 300),
    resolvedAt: Number(p.resolvedAt) || 0,
  };
}

function load(ctx) {
  const file = fileFor(ctx);
  if (cache.has(file)) return cache.get(file);
  const raw = readJson(file, {});
  const proposals = {};
  if (raw && raw.proposals && typeof raw.proposals === 'object') {
    for (const [id, p] of Object.entries(raw.proposals)) {
      const n = normalize(id, p);
      if (!n) continue;
      // 进程内存里的等待（offer 卡的阻塞调用、正在派生）随上一个进程一起没了：落到能解释的终态
      if (n.kind === 'offer' && (n.status === 'pending' || n.status === 'accepted')) { n.status = 'unanswered'; n.qid = ''; }
      if (n.status === 'starting') { n.status = 'start_failed'; n.reason = n.reason || '服务重启，没开起来'; }
      proposals[id] = n;
    }
  }
  const muted = {};
  if (raw && raw.muted && typeof raw.muted === 'object') for (const [sid, v] of Object.entries(raw.muted)) if (v && ID_RE.test(sid)) muted[sid] = true;
  // nextSweep：最早一张会过期的卡的到期时刻——没到就不必扫全表（0 = 卡变过，下次读时重算）
  const d = { proposals, muted, nextSweep: 0 };
  cache.set(file, d);
  return d;
}
// 还在走流程的状态（等用户 / 等任务说明 / 正在开）不裁；其余有了结局满 30 天的落盘前裁掉，台账不会只增不减
const LIVE_STATUSES = new Set(['pending', 'accepted', 'starting']);
function pruneResolved(d, now = Date.now()) {
  for (const [id, p] of Object.entries(d.proposals)) {
    if (!LIVE_STATUSES.has(p.status) && p.resolvedAt && now - p.resolvedAt > KEEP_RESOLVED_MS) delete d.proposals[id];
  }
}
const save = (ctx) => {
  const d = load(ctx);
  pruneResolved(d);
  d.nextSweep = 0;
  writeJson(fileFor(ctx), { v: 1, proposals: d.proposals, muted: d.muted });
};

/** 给前端的形状（自己人的卡，任务说明给到 4000 字够卡片「展开看全文」用）。 */
export function publicView(p) {
  if (!p) return null;
  return {
    id: p.id, parent: p.parent, kind: p.kind, title: p.title, tldr: p.tldr, prompt: p.prompt.slice(0, 4000),
    context: p.context, useWorktree: p.useWorktree, model: p.model, toolUseId: p.toolUseId, asked: p.asked,
    ...(p.qid && (p.status === 'pending') ? { qid: p.qid } : {}),
    createdAt: p.createdAt, expiresAt: p.expiresAt, status: p.status, child: p.child, auto: p.auto, reason: p.reason,
  };
}

function publish(ctx, p) {
  try { busPublish(ctx.key, { type: 'proposal', sessionId: p.parent, proposal: publicView(p) }); } catch {}
}

// 到期的提议卡置为 expired（读的时候顺手扫；变了就落盘并推总线）。
// 每次读都会走到这里：记下最早的到期时刻，没到就直接返回，不再每次扫全表。
export function sweepExpired(ctx, now = Date.now()) {
  if (!enabled(ctx)) return 0;
  const d = load(ctx);
  if (d.nextSweep && now < d.nextSweep) return 0;
  const hit = [];
  let next = Infinity;
  for (const p of Object.values(d.proposals)) {
    if (p.kind !== 'own' || !OPEN_STATUSES.has(p.status) || !p.expiresAt) continue;
    if (p.expiresAt <= now) { p.status = 'expired'; p.resolvedAt = now; hit.push(p); }
    else if (p.expiresAt < next) next = p.expiresAt;
  }
  if (hit.length) { save(ctx); for (const p of hit) publish(ctx, p); }
  d.nextSweep = next;
  return hit.length;
}

export function getProposal(ctx, id) {
  if (!enabled(ctx) || !TASK_ID_RE.test(String(id || ''))) return null;
  sweepExpired(ctx);
  return load(ctx).proposals[id] || null;
}

// 一次 start_session 正常只对应一张卡；万一有两条（旧数据），取最新的那条
export function findByToolUse(ctx, toolUseId) {
  if (!enabled(ctx) || !toolUseId) return null;
  let hit = null;
  for (const p of Object.values(load(ctx).proposals)) if (p.toolUseId === toolUseId && (!hit || p.createdAt >= hit.createdAt)) hit = p;
  return hit;
}

/** 某会话名下的卡（含已结束的，按创建时间）。 */
export function proposalsOf(ctx, parent) {
  if (!enabled(ctx) || !parent) return [];
  sweepExpired(ctx);
  return Object.values(load(ctx).proposals).filter((p) => p.parent === parent).sort((a, b) => a.createdAt - b.createdAt);
}

export function pendingOf(ctx, parent) {
  return proposalsOf(ctx, parent).filter((p) => p.kind === 'own' && p.status === 'pending');
}

/**
 * 记一张新卡。own 卡受「每会话最多 20 张挂着」约束：超出从最老的挤掉（置 dismissed / displaced）。
 * 返回 { proposal, displaced:[被挤掉的卡] }。
 */
export function addProposal(ctx, rec) {
  const d = load(ctx);
  const now = Date.now();
  const id = rec.id && TASK_ID_RE.test(rec.id) && !d.proposals[rec.id] ? rec.id : newTaskId();
  const p = normalize(id, {
    ...rec,
    createdAt: now,
    expiresAt: rec.kind === 'offer' ? 0 : now + PROPOSAL_TTL_MS,
    status: rec.status || 'pending',
  });
  if (!p) throw new Error('bad proposal');
  d.proposals[id] = p;
  const displaced = displaceOld(d, p, now);
  save(ctx);
  publish(ctx, p);
  for (const x of displaced) publish(ctx, x);
  return { proposal: p, displaced };
}

// own 卡挂着的超过 20 张：从最老的挤掉（置 dismissed / displaced），返回被挤掉的
function displaceOld(d, p, now) {
  const displaced = [];
  if (p.kind !== 'own' || p.status !== 'pending') return displaced;
  // 新来的（或刚退回的）这张自己不挤掉，挤别人
  const open = Object.values(d.proposals).filter((x) => x !== p && x.parent === p.parent && x.kind === 'own' && x.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  while (open.length > MAX_PENDING - 1) {
    const old = open.shift();
    old.status = 'dismissed'; old.reason = 'displaced'; old.resolvedAt = now;
    displaced.push(old);
  }
  return displaced;
}

/**
 * 把一张正要自动开的卡（「直接开始」档 starting）原样退回成等用户的卡：同一个 toolUseId 下始终只有这一条记录。
 * patch 可带 qid / asked（offer 卡）；提议卡重新起算 7 天，并照样受 20 张上限。返回 { proposal, displaced }。
 */
export function reopenProposal(ctx, id, patch = {}) {
  const d = load(ctx);
  const cur = d.proposals[id];
  if (!cur) return { proposal: null, displaced: [] };
  const now = Date.now();
  const p = normalize(id, { ...cur, ...patch, status: 'pending', auto: false, reason: '', resolvedAt: 0, expiresAt: cur.kind === 'offer' ? 0 : now + PROPOSAL_TTL_MS });
  d.proposals[id] = p;
  const displaced = displaceOld(d, p, now);
  save(ctx);
  publish(ctx, p);
  for (const x of displaced) publish(ctx, x);
  return { proposal: p, displaced };
}

/** 改一张卡（状态 / child / reason …），落盘并推总线。 */
export function updateProposal(ctx, id, patch) {
  const d = load(ctx);
  const p = d.proposals[id];
  if (!p) return null;
  const n = normalize(id, { ...p, ...patch });
  if (!n) return null;
  if (patch.status && patch.status !== p.status && !['pending', 'accepted', 'starting'].includes(patch.status)) n.resolvedAt = Date.now();
  if (patch.status && patch.status !== 'pending') n.qid = '';
  d.proposals[id] = n;
  save(ctx);
  publish(ctx, n);
  return n;
}

// 一轮收尾时还停在「已选新会话、等任务说明」的 offer 卡（官方 noteBriefNeverCame）：这一轮模型没把说明补上就结束了
//（用户点了停止、说明被打回后没再调、撞额度、CLI 崩了…）——落成 unanswered：卡片退回工具行、不再一直闪「正在写任务说明…」，
// 用户之后说「开吧」，模型照样能带 proposal_id 补说明再开；「直接开始」档两步走先占的自动名额还回去。
// gen.acceptedOffers = 这一轮记成 accepted 的卡（session-tools.mjs 挂上），session-family 的 familyTurnEnded 调。
export function settleAcceptedOffers(ctx, gen) {
  const ids = gen && gen.acceptedOffers;
  if (!enabled(ctx) || !ids || !ids.size) return 0;
  let n = 0;
  for (const id of ids) {
    const p = load(ctx).proposals[id];
    if (!p || p.status !== 'accepted') continue;
    updateProposal(ctx, id, { status: 'unanswered', reason: 'brief_never_came' });
    if (p.auto) releaseAutoStart(ctx, p.parent);
    n++;
  }
  ids.clear();
  return n;
}

// 「不再询问」（卡片菜单 / 官方 sideSessionOffersMuted）：这个会话以后的 offer 一律在这里做。
export function muteOffers(ctx, sid) {
  if (!enabled(ctx) || !ID_RE.test(String(sid || ''))) return;
  const d = load(ctx);
  if (d.muted[sid]) return;
  d.muted[sid] = true;
  save(ctx);
}
export const offersMuted = (ctx, sid) => enabled(ctx) && !!load(ctx).muted[sid];

// 会话被删：它名下的卡一并清掉。
export function forgetProposals(ctx, sid) {
  if (!enabled(ctx) || !sid) return;
  const d = load(ctx);
  let changed = false;
  for (const [id, p] of Object.entries(d.proposals)) if (p.parent === sid) { delete d.proposals[id]; changed = true; }
  if (d.muted[sid]) { delete d.muted[sid]; changed = true; }
  if (changed) save(ctx);
}

// —— 「直接开始」档的计数：自用户上一条消息起这个会话自动开了几个（内存；用户一发话清零）——
const autoStarts = new Map();   // key|sid -> n
export const AUTO_MAX = 4;
export const autoStartCount = (ctx, sid) => autoStarts.get(ctx.key + '|' + sid) || 0;
export function noteAutoStart(ctx, sid) { const k = ctx.key + '|' + sid; autoStarts.set(k, (autoStarts.get(k) || 0) + 1); }
// 先占的名额没用上（没开起来）：还回去
export function releaseAutoStart(ctx, sid) { const k = ctx.key + '|' + sid; const n = (autoStarts.get(k) || 0) - 1; if (n > 0) autoStarts.set(k, n); else autoStarts.delete(k); }
export function resetAutoStarts(ctx, sid) { autoStarts.delete(ctx.key + '|' + sid); }

// —— offer 卡的阻塞等待：用户在这一轮还没答卡就发了新消息 → 卡作废（chat 路由调）——
// gen.pendingOffer = { qid, taskId }，由 session-tools 的 offer 分支挂上 / 摘掉。
export function supersedeOffer(gen) {
  const po = gen && gen.pendingOffer;
  const w = po && po.qid ? pendingQuestions.get(po.qid) : null;
  if (!w) return false;
  w.settle({ choice: 'superseded' });
  return true;
}

// 测试用
export function _resetProposals() { cache.clear(); autoStarts.clear(); }
