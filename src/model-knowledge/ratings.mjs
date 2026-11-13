// 模型评分（2026-11-07 抽出）：bridge 的子 agent 阶梯（src/runtime/model-ratings.mjs）和 dimensio 的阶梯
// （harness/server/agent/dispatch-ladder.ts）以前各存一份归一 / 别名 / 同档取舍，已经分叉（harness 多了 qwen / k3 / strata 几条，
// bridge 多了 custom:<服务>: 前缀）。这里合成一份，再加上按模型家族调提示词要用的 lookupRating / ratingsSummary。
// 纯函数、无依赖、不读盘：快照对象由调用方读好传进来（bridge 读 src/config/model-ratings.json，harness 经 core-link 读同一份）。
//
// 快照（scripts/model-ratings-sync.mjs 生成）每条 = Artificial Analysis 的一个「模型 × 推理档位」：
//   slug、base（slug 去档位后缀 = 一族）、effort（low…max / off / '' = 只有一种配置）、ii 智力指数、cost 官方 API 每任务元、
//   rel 发布日、dep 已弃用、est 估算值、subs 分项（0–100，键见 SUB_KEYS），old（+ ver）= 没按现行指数版本重算的旧分。
// 旧分和现行版本不可比（同一个 Qwen3.8 Max：v4.3.2 40.2、v5 33.6），所以 old 条目不进 families、不参与任何排名与中位数；
// 只在 lookupRating 显式 allowOld 时返回（带 old:true 与它自己的 version，分项仍可参考——单项评测的分数不随指数版本变）。
// 快照可选带 planPoints（各家订阅 plan 的每任务成本，导入的性价比图才有，见 src/runtime/dispatch-chart.mjs），索引原样带出。
// slug → 族名（baseOf）、short 名 → 档位（effortOf）也放在这里：快照生成脚本和导入性价比图（runtime/dispatch-chart.mjs）共用一套算法。

export const RATING_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// slug 末尾的档位后缀 → 同一个模型（family）的 base。max 不在这里：它也常是型号名的一部分（qwen3-8-max 是 Qwen3.8 Max，
// 不是 Qwen3.8 的 max 档），只有同族真有别的档位条目时才当档位剥（见 baseOf）
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|non-reasoning|reasoning|adaptive|thinking)$/;
const MAX_SUFFIX = /-max$/;

/** short 名括号里的档位：「(max with fallback)」→ max；「(non-reasoning)」→ off；没有括号 / 认不出 → ''（模型默认档）。 */
export function effortOf(short) {
  const m = /\(([^)]*)\)\s*$/.exec(String(short || ''));
  if (!m) return '';
  const t = m[1].trim().toLowerCase();
  if (/^non-reasoning\b/.test(t)) return 'off';
  const w = t.split(/[\s,]+/)[0];
  return RATING_LEVELS.includes(w) ? w : '';
}

const stripEffort = (s) => {
  while (EFFORT_SUFFIX.test(s)) s = s.replace(EFFORT_SUFFIX, '');
  return s;
};

/**
 * slug → 族名（base）。slugs = 库里全部 slug：-max 只在「去掉它之后库里还有带档位后缀的兄弟落在同一族」时才当档位剥
 * （同族有 xxx-high / xxx-low 之类）；只有光秃秃的 xxx 不算——AA 同时收录 qwen3-8 与 qwen3-8-max 时那是两个型号。
 * 不给 slugs 就一律不剥 max。
 */
export function baseOf(slug, slugs = null) {
  const s0 = String(slug || '').toLowerCase();
  const s = stripEffort(s0);
  if (MAX_SUFFIX.test(s) && slugs) {
    const b = s.replace(MAX_SUFFIX, '');
    for (const t of slugs) {
      const o = String(t || '').toLowerCase();
      if (o !== s0 && o !== b && stripEffort(o) === b) return stripEffort(b);
    }
  }
  return s;
}
// 分项键 → 含义（快照里只带这几项，没有的省略）
export const SUB_KEYS = Object.freeze({
  tb40: 'Terminal-Bench 4.0',
  lcr: 'AA-LCR（长上下文推理）',
  mlcr: 'AA-MLCR',
  scicode: 'SciCode',
  hleD: 'HLE-Diamond',
  fc2: 'FrontierCode 2.0',
  tau3: 'τ³-Banking',
  ifbench: 'IFBench（指令遵循）',
  tau2: 'τ²-Bench',
  tbh: 'Terminal-Bench Hard',
});

// 型号名对不上快照 slug 的（服务商自起的名字、库里另起的名字、本机量化版）。键是 normKey 之后的 id，值是快照里的 base。
export const ALIASES = Object.freeze({
  'gemini-argon': 'gemini-4-argon',
  'gemini-carbon': 'gemini-4-carbon',
  'deepseek-flash': 'deepseek-v4-1-flash-1017',
  'deepseek-chat': 'deepseek-v4-1-flash-1017',
  'mimo-v2-6-pro-ultraspeed': 'mimo-v2-6-pro',
  'claude-haiku-4-5': 'claude-4-5-haiku',
  'claude-sonnet-4-5': 'claude-4-5-sonnet',
  // Fable 5.2（2026-11-09 发布）内置快照里还没有：先借 5.1 的分数排阶梯；快照 / 导入的性价比图里有了正主就自动让位（原样匹配优先），内置快照有了再删这行
  'claude-fable-5-2': 'claude-fable-5-1',
  k3: 'kimi-k3',
  'k3-256k': 'kimi-k3',
  // Kimi for Coding 端点上的 K3.1 Pro（highspeed 是同一模型的极速档，2 倍计费）
  'k3-1-pro': 'kimi-k3-1-pro',
  'k3-1-pro-highspeed': 'kimi-k3-1-pro',
  'qwen3-8-27b': 'qwen3-8-27b',
  // 本机 / 自建服务的 Qwen3.8 Flash Next 125B：分数取官方全精度那条（derived，见 DERIVED）
  'strata-orca': 'qwen3-8-flash-next',
  'strata-flash-iq3s': 'qwen3-8-flash-next',
  'strata-orca-iq3xxs': 'qwen3-8-flash-next',
  'strata-flash-nvfp4': 'qwen3-8-flash-next',
  'qwen3-8-flash-next-fp8': 'qwen3-8-flash-next',
});
// 别名里属于「量化 / 本机版本」的：分数不是本机实测，lookupRating 返回 derived:true
const DERIVED = new Set(['strata-orca', 'strata-flash-iq3s', 'strata-orca-iq3xxs', 'strata-flash-nvfp4', 'qwen3-8-flash-next-fp8']);
// 名字末尾的量化标记（normKey 之后）：去掉还能对上的也算 derived（如 qwen3.8-27b-Q4_K_M → qwen3-8-27b-q4-k-m）
const QUANT_SUFFIX = /-(?:fp8|fp4|nvfp4|mxfp4|int8|int4|w4a16|w8a8|awq|gptq|gguf|mlx|bf16|fp16|iq[1-4](?:-[a-z]{1,3})?|q[2-8](?:-k)?(?:-[a-z0-9]{1,2})?)$/;

/** 型号 id / 显示名 → 归一键：小写、去 custom:<服务>: 前缀与 [1m]、点 / 下划线 / 空格 / 斜杠换横线、去末尾 8 位日期。 */
export function normKey(id) {
  let t = String(id ?? '').trim().toLowerCase().replace(/\[1m\]$/, '');
  t = t.replace(/^custom:[^:]+:/, '');
  t = t.replace(/[._\s/]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return t.replace(/-\d{8}$/, '');
}

/** 快照对象 → 索引（快照缺了 / 坏了 / 一条有效的都没有 → null）。只有现行版本的条目进 families。 */
export function loadRatings(snapshotJson) {
  const j = snapshotJson;
  if (!j || typeof j !== 'object' || !Array.isArray(j.models)) return null;
  const models = [], old = [];
  const families = new Map(), oldFamilies = new Map();
  for (const m of j.models) {
    if (!m || typeof m.slug !== 'string' || typeof m.ii !== 'number') continue;
    const row = typeof m.base === 'string' ? m : { ...m, base: m.slug };
    const [list, fams] = row.old ? [old, oldFamilies] : [models, families];
    list.push(row);
    const fam = fams.get(row.base) ?? [];
    fam.push(row);
    fams.set(row.base, fam);
  }
  if (!models.length && !old.length) return null;
  return {
    generated: String(j.generated ?? ''), version: String(j.index ?? ''), fx: j.fx, source: j.source,
    plans: j.plans && typeof j.plans === 'object' ? j.plans : {},
    planPoints: j.planPoints && typeof j.planPoints === 'object' ? j.planPoints : {},
    models, old, families, oldFamilies,
  };
}

// 一个原始名字 → 要试的归一键（整串；带 vendor/ 前缀的再试斜杠后面那段）
function keysOf(raw) {
  const s = String(raw ?? '').trim().replace(/^custom:[^:]+:/i, '');
  const out = [normKey(s)];
  if (s.includes('/')) out.push(normKey(s.split('/').pop()));
  return out.filter((k, i) => k && out.indexOf(k) === i);
}

// 归一键 → { base, derived }（先原样，再查别名，再去量化后缀）；fams 里没有 → null。
// 原样优先：借分的别名（如 Fable 5.2 借 5.1）在快照 / 导入的性价比图里有了正主之后自动让位。
function resolveKey(k, fams) {
  const hit = (key) => {
    if (fams.has(key)) return { base: key, derived: false };
    const base = ALIASES[key];
    return base && fams.has(base) ? { base, derived: DERIVED.has(key) } : null;
  };
  let r = hit(k);
  if (r) return r;
  for (let t = k; QUANT_SUFFIX.test(t);) {
    t = t.replace(QUANT_SUFFIX, '');
    r = hit(t);
    if (r) return { ...r, derived: true };
  }
  return null;
}

function resolve(index, names, fams) {
  for (const raw of names) {
    for (const k of keysOf(raw)) {
      const r = resolveKey(k, fams);
      if (r) return r;
    }
  }
  return null;
}

/** 配置里的型号（id、显示名依次试）→ 快照里现行版本的那一族评分；对不上 → null。不做前缀匹配（claude-opus-5 不吞 claude-opus-5-5）。 */
export function familyOf(index, id, label) {
  if (!index) return null;
  const r = resolve(index, [id, label], index.families);
  return r ? index.families.get(r.base) : null;
}

/** 同一档位多条（同族不同快照）：未弃用优先，再取最新。 */
export function bestByEffort(fam) {
  const out = new Map();
  for (const v of fam || []) {
    const cur = out.get(v.effort);
    if (!cur || Number(!!cur.dep) > Number(!!v.dep) || (!!cur.dep === !!v.dep && String(v.rel ?? '') > String(cur.rel ?? ''))) out.set(v.effort, v);
  }
  return [...out.values()];
}

const strongest = (rows) => rows.reduce((a, b) => (b.ii > a.ii ? b : a));
/** 一族里最强的一条（有开思考的档就不取「不思考」那条）。 */
export function strongestOf(fam) {
  const rows = bestByEffort(fam);
  if (!rows.length) return null;
  const on = rows.filter((v) => v.effort !== 'off');
  return strongest(on.length ? on : rows);
}

// 按请求的档位挑一条：同名档 → 不高于它的最强一档 → 最低一档；off 没有不思考评分时取最弱那条（偏保守）；不给档位 = 最强
function pickRow(fam, effort) {
  const rows = bestByEffort(fam);
  const e = String(effort ?? '').trim().toLowerCase();
  if (!e || e === 'on' || e === 'auto') return { row: strongestOf(fam), exact: !e };
  if (e === 'off' || e === 'none' || e === 'disabled') {
    const off = rows.find((v) => v.effort === 'off');
    return off ? { row: off, exact: true } : { row: rows.reduce((a, b) => (b.ii < a.ii ? b : a)), exact: false };
  }
  const want = RATING_LEVELS.indexOf(e === 'minimal' ? 'low' : e);
  const exact = rows.find((v) => v.effort === e);
  if (exact) return { row: exact, exact: true };
  const levels = rows.filter((v) => RATING_LEVELS.includes(v.effort));
  if (want < 0 || !levels.length) return { row: strongestOf(fam), exact: false };
  const below = levels.filter((v) => RATING_LEVELS.indexOf(v.effort) <= want);
  if (below.length) return { row: strongest(below), exact: false };
  return { row: levels.reduce((a, b) => (RATING_LEVELS.indexOf(b.effort) < RATING_LEVELS.indexOf(a.effort) ? b : a)), exact: false };
}

/**
 * 一个型号（+ 档位）→ 它的评分；对不上 → null。
 * opts.provider === 'local'（本机引擎）或名字是量化 / 本机别名 → derived:true（分数取官方全精度条目，不是实测）。
 * opts.label 显示名兜底；opts.allowOld = 现行版本没有时退到旧版条目（返回 old:true，ii 不能和现行版本比）。
 */
export function lookupRating(index, modelId, opts = {}) {
  if (!index) return null;
  const names = [modelId, opts.label];
  let r = resolve(index, names, index.families);
  let fams = index.families;
  if (!r && opts.allowOld) {
    r = resolve(index, names, index.oldFamilies);
    fams = index.oldFamilies;
  }
  if (!r) return null;
  const { row, exact } = pickRow(fams.get(r.base), opts.effort);
  if (!row) return null;
  const out = {
    slug: row.slug, base: row.base, ii: row.ii,
    version: row.old ? String(row.ver || 'old') : index.version,
    effort: row.effort, subs: { ...(row.subs || {}) }, date: String(row.rel ?? ''), deprecated: !!row.dep,
    cost: typeof row.cost === 'number' ? row.cost : 0, exact, name: String(row.name ?? row.slug),
  };
  if (row.est) out.est = true;
  if (row.old) out.old = true;
  if (r.derived || opts.provider === 'local') out.derived = true;
  return out;
}

// 分位数（线性插值，和 numpy 默认一致）
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const round1 = (x) => Math.round(x * 10) / 10;
function stats(values) {
  const s = values.slice().sort((a, b) => a - b);
  return { median: round1(quantile(s, 0.5)), p25: round1(quantile(s, 0.25)), p75: round1(quantile(s, 0.75)), count: s.length };
}

/**
 * 现行版本的分布：allEfforts = 每个「模型 × 档位」一条；bestPerFamily = 每族只取最强那条（「一个典型模型」的口径）。
 * 顶层的 median / p25 / p75 / count 取 bestPerFamily（认不出的型号按中位估时用它）。旧版条目一律不算。
 */
export function ratingsSummary(index) {
  const empty = { median: 0, p25: 0, p75: 0, count: 0 };
  if (!index) return { ...empty, version: '', allEfforts: { ...empty }, bestPerFamily: { ...empty } };
  const all = stats(index.models.map((m) => m.ii));
  const best = stats([...index.families.values()].map((f) => strongestOf(f)).filter(Boolean).map((m) => m.ii));
  return { ...best, version: index.version, allEfforts: all, bestPerFamily: best };
}
