// 智能分派的打分：一个任务该放到哪个号。纯函数，输入是各号额度、这个任务、其它在跑的任务，输出排好序的候选和理由。
//
// 先分两档：装得下这一段（剩余额度 ≥ 预计用量 × 1.25）的号永远排在装不下的前面——这样长活开跑前就挑能跑完的号，
// 不会跑到一半撞墙再拆到第二个号上。装不下的之间按「能装下多少」排。档内再按这几项加减分：
//   · 留在原号：缓存还热就加分（上下文越长，换号重建缓存越贵）；换到别的号时，重建缓存的量也算进它要装下的量里。
//   · 跟主任务同号：子 agent、后台小请求优先跟会话主线程在一个号上。
//   · 替稀缺额度让路：家族独占的桶（Fable 周限额）只能给那个家族用，共用的 5 小时 / 每周额度谁都能用。
//     一个 Opus 任务放在还有 Fable 余量、且共用额度正卡着 Fable 的号上，每用一点就少一点 Fable 能用的；
//     放在 Fable 已用完（或根本没有 Fable，比如 Pro 号）的号上，一点不耽误 Fable——按「会吃掉多少别的家族的可用量」扣分。
//   · 用别人用不了的额度（维护者 11-23）：Fable 已用完 / 没有 Fable 的号，剩下的共用额度到 Fable 重置前只有非 Fable 任务用得上，
//     非 Fable 任务优先去那里——直接加分，不管共用额度此刻卡不卡 Fable（上面那项只在共用额度正卡着 Fable 时才扣分，
//     Fable 被它自己的周限额先卡住时等于零，Opus 就会被「均衡」「快重置」拉回还能跑 Fable 的号）。Fable 越快恢复，加分越少。
//   · 快重置的先用：离重置越近、剩得越多的额度越该先用掉（过了重置点就作废了）。半小时内就重置的桶不算（同 capacity）：
//     几分钟里根本用不掉多少，过了点又是满的。
//   · 分开并行：号上已经在跑的任务越多扣分越多，并行的任务各占一个号，也就不会一起把一个号挤满、再一起换号。
//   · 均衡：同样装得下时，周额度（Fable 任务看 Fable 周限额）剩得多的号优先——各号的余量拉平，以后并行的任务都还有号可去；
//     Fable 任务因此落在 Fable 剩得最多的号上。
//   · 余量：这一段的预计用量离号的余量越远越从容。
// 其它在跑的任务还要用的量先从各号的余量里预留出来再算。

import { relevantBucket, isShared, DEDICATED } from './buckets.mjs';

export const FIT_MARGIN = 1.25;
const REFILL_SOON = 30 * 60_000;                  // 这么快就重置的桶不算卡脖子（中途会补满）
const TAU = { five_hour: 1.5 * 3600_000, other: 36 * 3600_000 };   // 「快重置」的时间尺度
const W = { stickWarm: 0.8, stickCold: 0.25, parent: 0.6, scarce: 1.5, free: 1.4, urgency: 1.2, load: 0.35, loadSub: 0.15, balance: 0.8, room: 0.6, order: 0.02 };
const FREE_HORIZON = 24 * 3600_000;   // 稀缺家族在这个号上还要挡这么久以上，「用别人用不了的额度」拿满分；更快恢复的按比例减
const UNKNOWN_PCT = { five_hour: 0, seven_day: 30, dedicated: 30 };   // 这个号没报过这个桶：5 小时多半是新窗口，周桶不知道就按 30%
// 没报过也当它存在的独占桶：非 Pro 号都有 Fable 周限额（Pro 没有的由 blocked 挡掉）；Opus / Sonnet 周限额现在多数号没有，没报过就是没有。
const ASSUMED = new Set([DEDICATED.fable]);

/**
 * accounts: [{ id, idx, plan, limits:{[桶]:{pct,resetsAt,label?}}, blocked:{[家族]:bool}, soft:bool（当前任务家族快满了） }]
 * task:     { family, est（MW）, rebuild（MW，换到别的号要重建的缓存）, warm, current（当前绑的号）, parent（主线程的号） }
 * others:   [{ acct, family, rem（MW）, sub }]
 * rate(acct, 桶, 家族) → 百分点 / MW
 * demanded(家族) → 最近有没有人用
 * 返回 [{ id, fits, cover, cap, score, parts }]，第一个就是选中的。全被挡住时返回 []。
 */
export function rankAccounts({ accounts, task, others = [], rate, demanded = () => true, now = Date.now(), limitPct = 98 }) {
  const fam = task.family;
  let pool = accounts.filter((a) => !a.blocked[fam] && !a.soft);
  let fallback = false;
  if (!pool.length) { pool = accounts.filter((a) => !a.blocked[fam]); fallback = true; }   // 都快满了：退到只排除真用满的
  if (!pool.length) return [];

  const rows = pool.map((a) => {
    const P = projected(a, others, rate, now);
    const cap = capacity(a, fam, P, rate, now, limitPct);
    const moving = !!task.current && a.id !== task.current;
    const need = task.est + (moving ? task.rebuild : 0);
    const cover = need > 0 ? cap / need : Infinity;
    const parts = {};
    if (a.id === task.current) parts.stick = task.warm ? W.stickWarm + Math.min(2, task.rebuild / Math.max(task.est, 1e-6)) : W.stickCold;
    if (!task.current && task.parent && a.id === task.parent) parts.parent = W.parent;
    const loss = scarceLoss(a, fam, task.est, P, rate, now, limitPct, demanded);
    if (loss.total > 0) { parts.scarce = -W.scarce * loss.total; parts.scarceFor = loss.top; }
    const fr = freeShare(a, fam, now, demanded);
    if (fr.v > 0) { parts.free = W.free * fr.v; parts.freeFor = fr.top; }
    const u = urgency(a, fam, P, now, limitPct);
    if (u > 0) parts.urgency = W.urgency * u;
    const load = others.filter((o) => o.acct === a.id).reduce((s, o) => s + (o.sub ? W.loadSub : W.load), 0);
    if (load > 0) parts.load = -load;
    parts.balance = W.balance * weeklyLeft(a, fam, P, limitPct);
    parts.room = W.room * Math.log10(Math.min(10, Math.max(1, cover)));
    parts.order = -W.order * (a.idx || 0);
    const score = Object.values(parts).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    return { id: a.id, fits: cover >= FIT_MARGIN, cover, cap, score, parts, fallback };
  });
  rows.sort((x, y) => (y.fits - x.fits) || (x.fits ? y.score - x.score : (y.cover - x.cover) || (y.score - x.score)));
  return rows;
}

// 各桶「算上别的任务预留之后」的占用（百分点）。
function projected(a, others, rate, now) {
  const P = {};
  for (const k of bucketsOf(a)) P[k] = pctNow(a, k, now);
  for (const o of others) {
    if (o.acct !== a.id) continue;
    for (const k of Object.keys(P)) if (relevantBucket(k, a.limits[k], o.family)) P[k] += rate(a.id, k, o.family) * o.rem;
  }
  return P;
}

function bucketsOf(a) {
  const ks = new Set(['five_hour', 'seven_day', ...ASSUMED, ...Object.keys(a.limits || {})]);
  for (const k of [...ks]) if (k === 'overage' || k === 'seven_day_oauth_apps') ks.delete(k);
  return ks;
}
const known = (a, k) => isShared(k) || ASSUMED.has(k) || !!(a.limits && a.limits[k]);

function pctNow(a, k, now) {
  const b = a.limits && a.limits[k];
  if (b && typeof b.pct === 'number') return b.resetsAt && b.resetsAt <= now ? 0 : b.pct;   // 过了重置点 = 已清零
  return isShared(k) ? UNKNOWN_PCT[k] : UNKNOWN_PCT.dedicated;
}

const refillsSoon = (a, k, now) => { const r = a.limits && a.limits[k] && a.limits[k].resetsAt; return !!r && r > now && r - now < REFILL_SOON; };

// 这个家族在这个号上还能用多少（MW）：所有管它的桶里最紧的那个。快重置的桶不算。
export function capacity(a, fam, P, rate, now, limitPct = 98) {
  let cap = Infinity;
  for (const k of Object.keys(P)) {
    if (!relevantBucket(k, a.limits[k], fam) || !known(a, k)) continue;
    if (refillsSoon(a, k, now)) continue;
    cap = Math.min(cap, Math.max(0, limitPct - P[k]) / rate(a.id, k, fam));
  }
  return Number.isFinite(cap) ? cap : 1e3;
}

// 放这个任务会吃掉多少「别的家族」的可用量（按每 MW 本任务算，0 = 一点不耽误）。只看最近有人用的、在这个号上有独占桶的家族。
// 返回 { total, top（吃得最多的那个家族） }。
function scarceLoss(a, fam, est, P, rate, now, limitPct, demanded) {
  let total = 0, top = '', topLost = 0;
  for (const [c, k] of Object.entries(DEDICATED)) {
    if (c === fam || !demanded(c) || a.blocked[c] || !known(a, k)) continue;
    const before = capacity(a, c, P, rate, now, limitPct);
    if (!(before > 0)) continue;
    const after = { ...P };
    for (const s of Object.keys(after)) if (isShared(s) && relevantBucket(s, a.limits[s], fam)) after[s] += rate(a.id, s, fam) * est;
    const lost = Math.min(before, Math.max(0, before - capacity(a, c, after, rate, now, limitPct))) / Math.max(est, 1e-6);
    total += lost;
    if (lost > topLost) { topLost = lost; top = c; }
  }
  return { total, top };
}

// 这个号的共用额度有多「白给」：别的稀缺家族（有独占桶的，实际就是 Fable）最近有人用、但在这个号上被挡住了（用完 / Pro 没有），
// 它剩下的共用额度那个家族用不上。按挡住还剩多久打折（0–1），取最大的那个家族。
// 只有别的号上那个家族还能用时才有意义——全池都挡住就谁也不占谁的，调用方（rankAccounts）对所有号一视同仁，差值为零。
function freeShare(a, fam, now, demanded) {
  let v = 0, top = '';
  for (const c of Object.keys(DEDICATED)) {
    if (c === fam || !demanded(c) || !(a.blocked && a.blocked[c]) || (a.blocked && a.blocked[fam])) continue;
    const until = a.until && a.until[c] != null ? a.until[c] : Infinity;
    const x = Math.min(1, Math.max(0, until - now) / FREE_HORIZON);
    if (x > v) { v = x; top = c; }
  }
  return { v, top };
}

// 这个家族要用的周桶里最紧的那个还剩几成（0–1）。
function weeklyLeft(a, fam, P, limitPct) {
  let left = 1;
  for (const k of Object.keys(P)) {
    if (k === 'five_hour' || !relevantBucket(k, a.limits[k], fam) || !known(a, k)) continue;
    left = Math.min(left, Math.max(0, limitPct - P[k]) / 100);
  }
  return left;
}

// 快重置的额度先用：每个管这个家族的桶，「剩下的比例 × 离重置有多近」，取最大的那个。
function urgency(a, fam, P, now, limitPct) {
  let u = 0;
  for (const k of Object.keys(P)) {
    const b = a.limits && a.limits[k];
    if (!b || !b.resetsAt || b.resetsAt <= now || !relevantBucket(k, b, fam) || refillsSoon(a, k, now)) continue;
    const left = Math.max(0, limitPct - P[k]) / 100;
    const tau = k === 'five_hour' ? TAU.five_hour : TAU.other;
    u = Math.max(u, left * Math.exp(-(b.resetsAt - now) / tau));
  }
  return u;
}

/**
 * 选中的号为什么是它：跟第二名比，哪一项拉开的差距最大。返回理由代号（界面翻成人话）。
 *   fit_only 只有它装得下这一段 · room 剩余额度最多 · keep_<家族> 不占那个家族（多是 Fable）的额度 · fable_room Fable 剩得最多 ·
 *   expiring 额度快重置了先用掉 · spread 和在跑的任务分开 · with_parent 跟主任务同号 · fallback 都快满了挑最空的 · only 只有这一个号能用
 *   refit（vsId = 原号时）原号剩下的装不下这一段
 * vsId：跟指定的号比（新一段开跑前换号时跟原号比），不给就跟第二名比。
 */
export function reasonFor(rows, task, vsId = '') {
  const a = rows[0];
  const b = (vsId && rows.find((r) => r.id === vsId)) || rows[1];
  if (!a) return '';
  if (a.fallback) return 'fallback';
  if (!b || b === a) return 'only';
  if (a.fits && !b.fits) return vsId ? 'refit' : 'fit_only';
  const gap = {};
  for (const k of new Set([...Object.keys(a.parts), ...Object.keys(b.parts)])) if (k !== 'scarceFor' && k !== 'freeFor') gap[k] = (a.parts[k] || 0) - (b.parts[k] || 0);
  const top = Object.entries(gap).filter(([k, v]) => v > 0.05 && k !== 'order' && k !== 'stick').sort((x, y) => y[1] - x[1])[0];
  const k = top ? top[0] : 'room';
  if (k === 'scarce') return 'keep_' + (b.parts.scarceFor || 'fable');
  if (k === 'free') return 'keep_' + (a.parts.freeFor || 'fable');
  if (k === 'urgency') return 'expiring';
  if (k === 'load') return 'spread';
  if (k === 'parent') return 'with_parent';
  return task.family === 'fable' ? 'fable_room' : 'room';
}
