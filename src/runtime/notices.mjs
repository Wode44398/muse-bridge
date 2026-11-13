// 会话消息通知（2026-11-07）：「哪个会话在问你 / 跑完了 / 出错了」的单一来源。
//
// 以前每一端各凑各的：手机原生服务轮询 /api/active 只认「最新一轮 active→inactive」弹一条「Claude · 完成」，
// 并发好几个会话时只有最后一个会提醒；网页只给它自己挂着的那一轮弹；桌面壳主进程自己比对快照。没有一端知道
// 「是哪个会话」——更谈不上像微信那样每个会话单独一条、带会话名。
//
// 现在服务端在三个结点产出通知条目（按身份 key 隔离，只存内存，30 分钟过期，每 key 最多 40 条）：
//   · 提问 / 权限审批 / 计划审批 / 新会话提议 / 安全暂停 —— questions.mjs 的 sessionQuestions.set（唯一登记口）
//   · 一轮收尾（完成 / 出错；人自己按的停止不算）—— claude.mjs retireTurn
//   · 定时任务跑完（开了「通知我」的）—— routines-runner.mjs；模型 PushNotification —— push-notices.mjs
// 每条 = { id, kind, sub, sessionId, title, body, at }：
//   kind ∈ question | permission | done | error | push（客户端按本机分类开关取舍）；sub = 原始细分（plan / offer / refusal / routine…）；
//   title = 会话标题（像微信的联系人名；拿不到时为空，客户端自己兜底）；body = 题面 / 回复摘要 / 报错。
// 下发两路：账号总线 {type:'notice', …}（在线的网页 / 手机前台即时横幅）；GET /api/active 的 notices（带 ageMs，
// 手机原生后台服务每 5 秒轮询，人不在屏幕前也能按会话弹进通知栏）。

import { busPublish } from './bus.mjs';
import { onQuestionSet } from './questions.mjs';

const KEEP_MS = 30 * 60_000;
const MAX_PER_KEY = 40;
const store = new Map();     // key -> [item]
const titles = new Map();    // `${key}\0${sid}` -> 会话标题（开跑时解析好，提问 / 收尾直接用）
const seenAsk = new Map();   // qid -> at（同一张卡重复登记不重复通知）
let seq = 0;

const tkey = (key, sid) => `${key}\0${sid}`;
const clip = (s, n) => {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n) + '…' : v;
};

// 回复正文 → 一行摘要：代码块换成占位、去掉常见 Markdown 记号（通知栏里不渲染 Markdown）
export function plainSummary(md, n = 160) {
  let s = String(md || '');
  s = s.replace(/```[\s\S]*?(```|$)/g, ' [代码] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]{1,80}>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/\|/g, ' ');
  return clip(s, n);
}

function titleFor(key, sid) {
  const v = sid ? titles.get(tkey(key, sid)) : '';
  return v || '';
}
function rememberTitle(key, sid, title) {
  if (!key || !sid || !title) return;
  const k = tkey(key, sid);
  titles.delete(k);
  titles.set(k, clip(title, 60));
  while (titles.size > 600) titles.delete(titles.keys().next().value);
}

export function postNotice(key, { kind, sub = '', sessionId = null, title = '', body = '' } = {}) {
  if (!key || !kind) return null;
  const now = Date.now();
  const sid = sessionId ? String(sessionId) : null;
  const item = {
    id: `${now.toString(36)}-${(++seq).toString(36)}`,
    kind: String(kind), sub: String(sub || ''),
    sessionId: sid,
    title: clip(title || titleFor(key, sid), 60),
    body: clip(body, 240),
    at: now,
  };
  const list = (store.get(key) || []).filter((p) => now - p.at < KEEP_MS);
  list.push(item);
  while (list.length > MAX_PER_KEY) list.shift();
  store.set(key, list);
  busPublish(key, { type: 'notice', ...item });
  return item;
}

// 给轮询方：附 ageMs（服务端算好的「多久之前」）——手机与服务器时钟不同步也不会误判新旧。
export function recentNotices(key) {
  const now = Date.now();
  return (store.get(key) || [])
    .filter((p) => now - p.at < KEEP_MS)
    .map(({ at, ...p }) => ({ ...p, ageMs: now - at }));
}

// —— 一轮开跑：把会话标题解析好缓存起来（提问 / 收尾时要用，那时手上没有 ctx）——
let titleOfImpl = null;
async function sessionTitle(ctx, sid) {
  if (!titleOfImpl) titleOfImpl = (await import('./session-family.mjs')).sessionTitleOf;
  return titleOfImpl(ctx, sid);
}
export function noticeRunStart(ctx, gen) {
  if (!ctx || !gen || !gen.sessionId || ctx.snap) return;
  const key = ctx.key, sid = gen.sessionId;
  // 新会话第一轮：标题就是这条消息（解析出来之前先垫上）
  if (!titles.has(tkey(key, sid)) && gen.userText) rememberTitle(key, sid, gen.userText);
  sessionTitle(ctx, sid).then((v) => { if (v) rememberTitle(key, sid, v); }).catch(() => {});
}

// 这一轮的结局：从 gen.events 末尾往前找终止事件
export function turnOutcome(gen) {
  const evs = (gen && Array.isArray(gen.events)) ? gen.events : [];
  for (let i = evs.length - 1; i >= 0 && i >= evs.length - 400; i--) {
    const e = evs[i];
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'interrupted') return { kind: 'stopped' };
    if (e.type === 'done') {
      if (e.isError) return { kind: 'error', body: plainSummary(e.result, 200) };
      return { kind: 'done', body: plainSummary(e.result) };
    }
    if (e.type === 'error') {
      if (e.kind === 'busy') return { kind: 'skip' };
      const head = String(e.title || '').trim();
      const tail = String(e.hint || (head ? '' : e.message) || '').trim();
      return { kind: 'error', sub: String(e.kind || ''), body: clip([head, tail].filter(Boolean).join(' — '), 200) };
    }
  }
  return { kind: 'skip' };
}

export function noticeRunEnd(ctx, gen) {
  if (!ctx || !gen || !gen.sessionId || ctx.snap) return;
  // 悬浮胶囊的轮：人就盯着胶囊；定时任务：routines-runner 按任务自己的「通知我」开关单独发
  if (gen.source === 'capsule') return;
  if (gen.family && gen.family.origin && gen.family.origin.kind === 'routine') return;
  const o = turnOutcome(gen);
  if (o.kind !== 'done' && o.kind !== 'error') return;
  postNotice(ctx.key, { kind: o.kind, sub: o.sub || '', sessionId: gen.sessionId, body: o.body || '' });
}

// —— 提问类：sessionQuestions.set 的唯一登记口 ——
const KIND_OF = { question: 'question', offer: 'question', refusal: 'question', permission: 'permission', plan: 'permission' };
onQuestionSet((sid, entry) => {
  if (!sid || !entry || !entry.ownerKey) return;
  const qid = String(entry.qid || `${sid}:${entry.ts || 0}`);
  if (seenAsk.has(qid)) return;
  seenAsk.set(qid, Date.now());
  while (seenAsk.size > 500) seenAsk.delete(seenAsk.keys().next().value);
  const sub = String(entry.kind || 'question');
  const q = Array.isArray(entry.questions) ? entry.questions[0] || {} : {};
  postNotice(entry.ownerKey, {
    kind: KIND_OF[sub] || 'question', sub, sessionId: sid,
    body: String(q.question || q.header || ''),
  });
});

export function _resetNotices() { store.clear(); titles.clear(); seenAsk.clear(); }
