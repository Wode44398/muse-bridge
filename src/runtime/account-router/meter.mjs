// 号池计量：把「用了多少 token」和「额度桶涨了几个百分点」对起来，学出每个号每个桶「1% 大约是多少用量」。
// 智能分派靠它把「这段任务大概多大」和「这个号还剩多少」换成同一种单位比较。
//
// 用量折成统一的权重，单位 MW（百万）：输入 1、写缓存 1.25（1 小时档 2）、读缓存 0.1、输出 5——官方各项计价的比例。
// 同样的 token，不同家族吃的额度不一样（Fable 比 Opus 贵），所以学的是 rate[号][桶][家族] = 百分点 / MW。
//
// 响应头的利用率只精确到 1%，单个请求看不出涨幅：每个桶攒着「读数上次变化以来的用量」，读数一涨，按各家族当前估计
// 分摊涨的点数，计入指数衰减的累计和，比值取「点数和 / 用量和」（比逐次比值的平均稳）。刚开始不知道起点落在 1% 的哪儿，
// 第一次涨只用来对齐、不学。号也会被 bridge 以外的地方用（官方 App、claude.ai），那部分涨幅会算到 bridge 的用量头上，
// 估出来偏「号小」——偏保守能接受；单次样本截在当前估计的 4 倍以内，免得别处一大笔用量把估计带飞。

import { SHARED_BUCKETS, DEDICATED, relevantBucket } from './buckets.mjs';

const DECAY = 0.85;          // 每学一次，旧样本的分量乘这个（约等于记住最近十来次涨幅）
const PRIOR_POINTS = 2;      // 先验算作看过 2 个百分点
const MAX_SAMPLE_X = 4;      // 单次样本最多是当前估计的几倍

// 先验（还没学到时用）：Pro 号 5 小时桶每 MW 涨多少点，其余套餐按倍数缩。数字只求量级对，几次涨幅之后就被实测替换。
const PRO_FIVE_HOUR = 50;
const PLAN_SCALE = { pro: 1, max5x: 5, max: 10, ultra: 20, team: 10, enterprise: 10 };
const WEEK_OF_FIVE = 1 / 7;  // 周桶 ≈ 7 个 5 小时窗口
const FABLE_WEEK_OF_FIVE = 1 / 3;   // Fable 周限额比通用周桶小得多
const FAMILY_PRICE = { fable: 1.6, opus: 1, sonnet: 0.6, haiku: 0.2, other: 1 };

/** 一次响应的 usage → MW。 */
export function usageWeight(u) {
  if (!u || typeof u !== 'object') return 0;
  const n = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  const cw = n(u.cache_creation_input_tokens);
  const cw1h = Math.min(cw, n(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens));
  return (n(u.input_tokens) + 1.25 * (cw - cw1h) + 2 * cw1h + 0.1 * n(u.cache_read_input_tokens) + 5 * n(u.output_tokens)) / 1e6;
}

/** 一次请求的上下文有多长（token）：换号时整段要在新号上重新写一遍缓存。 */
export function contextTokens(u) {
  if (!u || typeof u !== 'object') return 0;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

export function priorRate(plan, bucket, family) {
  const scale = PLAN_SCALE[String(plan || '').toLowerCase()] || PLAN_SCALE.max;
  const five = PRO_FIVE_HOUR / scale * (FAMILY_PRICE[family] || 1);
  if (bucket === 'five_hour') return five;
  if (bucket === 'seven_day_overage_included') return five * FABLE_WEEK_OF_FIVE;
  return five * WEEK_OF_FIVE;   // seven_day 与其余周桶
}

/**
 * planOf(acct) → 套餐代号；limitsOf(acct) → 这个号的额度桶（status.accountLimits）。
 * 状态可以 dump() 出来落盘、load() 回去（pend 是进行中的累计，不落盘）。
 */
export function createMeter({ planOf = () => null, limitsOf = () => ({}) } = {}) {
  const st = new Map();   // `${acct}|${bucket}` -> { u, reset, synced, pend:{fam:MW}, sd:{fam}, sw:{fam} }
  const cell = (acct, k) => {
    const key = acct + '|' + k;
    let s = st.get(key);
    if (!s) st.set(key, (s = { u: null, reset: 0, synced: false, pend: {}, sd: {}, sw: {} }));
    return s;
  };

  function rate(acct, k, fam) {
    const prior = priorRate(planOf(acct), k, fam);
    const s = st.get(acct + '|' + k);
    const sd = s ? s.sd[fam] || 0 : 0, sw = s ? s.sw[fam] || 0 : 0;
    return (sd + PRIOR_POINTS) / (sw + PRIOR_POINTS / prior);
  }

  // 这次用量记到哪些桶：共用的两个 + 这个家族独占的 + 这个号带着的、管这个家族的 model_<名>。
  function bucketsFor(acct, fam) {
    const out = new Set(SHARED_BUCKETS);
    if (DEDICATED[fam]) out.add(DEDICATED[fam]);
    for (const [k, b] of Object.entries(limitsOf(acct) || {})) if (k.startsWith('model_') && relevantBucket(k, b, fam)) out.add(k);
    return out;
  }

  function addUsage(acct, fam, w) {
    if (!acct || !(w > 0)) return;
    for (const k of bucketsFor(acct, fam)) { const s = cell(acct, k); s.pend[fam] = (s.pend[fam] || 0) + w; }
  }

  // 一次读数：pct 是整数百分点，resetsAt 毫秒。返回 true = 学到了一个样本。
  function observe(acct, k, pct, resetsAt) {
    if (!acct || typeof pct !== 'number' || !isFinite(pct)) return false;
    const s = cell(acct, k);
    const resync = () => { s.synced = false; s.pend = {}; s.u = pct; s.reset = resetsAt || 0; };
    if (s.u == null) { resync(); return false; }
    // 窗口换了（重置时刻变了）或读数往回走：以前攒的用量对不上新窗口
    if ((resetsAt && s.reset && Math.abs(resetsAt - s.reset) > 120_000) || pct < s.u) { resync(); return false; }
    if (resetsAt) s.reset = resetsAt;
    if (pct === s.u) return false;
    const d = pct - s.u;
    s.u = pct;
    if (!s.synced) { s.synced = true; s.pend = {}; return false; }
    const fams = Object.keys(s.pend).filter((f) => s.pend[f] > 0);
    const exp = fams.reduce((a, f) => a + rate(acct, k, f) * s.pend[f], 0);
    if (!(exp > 0)) { s.pend = {}; return false; }   // 这段时间 bridge 没用过它：涨的是别处的用量
    for (const f of fams) {
      const r = rate(acct, k, f);
      const df = Math.min(d * (r * s.pend[f]) / exp, MAX_SAMPLE_X * r * s.pend[f]);
      s.sd[f] = (s.sd[f] || 0) * DECAY + df;
      s.sw[f] = (s.sw[f] || 0) * DECAY + s.pend[f];
    }
    s.pend = {};
    return true;
  }

  function dump() {
    const out = {};
    for (const [key, s] of st) if (Object.keys(s.sw).length) out[key] = { sd: s.sd, sw: s.sw };
    return out;
  }
  function load(obj) {
    for (const [key, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
      if (!v || typeof v !== 'object' || !key.includes('|')) continue;
      const s = { u: null, reset: 0, synced: false, pend: {}, sd: {}, sw: {} };
      for (const f of Object.keys(v.sw || {})) {
        const sd = Number(v.sd && v.sd[f]), sw = Number(v.sw[f]);
        if (sd >= 0 && sw > 0) { s.sd[f] = sd; s.sw[f] = sw; }
      }
      st.set(key, s);
    }
  }
  // 控制台展示：每个号每个桶学到的速率（已学到过的才列）。
  function learned(acct) {
    const out = {};
    for (const [key, s] of st) {
      if (!key.startsWith(acct + '|')) continue;
      const k = key.slice(acct.length + 1);
      for (const f of Object.keys(s.sw)) (out[k] || (out[k] = {}))[f] = +rate(acct, k, f).toPrecision(3);
    }
    return out;
  }
  return { rate, addUsage, observe, dump, load, learned };
}
