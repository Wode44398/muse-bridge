// 子 agent 选型阶梯（2026-10-30）：按用户自己维护的模型性价比库给「能派的模型 × 推理档位」排出四档首选。
//
// 数据：src/config/model-ratings.json——发版导出时由 scripts/model-ratings-sync.mjs 从库里压出来的快照（库随时在改，
// 每个版本只认发版那一刻的数据）。每条 = Artificial Analysis 的一个「模型 × 档位」：智力指数 ii、官方 API 每任务成本（元），
// 外加 Anthropic 订阅 plan 的每任务等效成本。管理员导入过「订阅 plan 性价比图」（runtime/dispatch-chart.mjs）就用导入的那份，
// 它还带各家第三方 plan 的每任务成本（planPoints）。
//
// 用法有四处，都按同一份候选表算，结论一致：
//   · 系统提示（claude-turn-settings 的 dispatchNudge）：只给 Claude 一张约十行的阶梯——每档首选 + 一个备选，
//     被更便宜又更聪明的选项全面胜出的配置不进表；Claude 只管判断子任务属于哪一档。
//   · 虚拟模型名 auto:top / auto:hard / auto:normal / auto:light：动态工作流 agent({ model:'auto:hard' }) 原样进 body.model，
//     请求经过 bridge 时（官方订阅会话走 claude-upstream，自定义 API 会话走 claude-providers-proxy）换成这一档的首选模型与档位。
//   · 工作流面板：auto:* 的 agent 显示实际落到的模型（tool-summary 从子 agent 转录读回）。
//   · 设置 › 子 agent 调用策略的预览（ladderPreview）：四档落点、全部候选、号池里的 plan、图谱数据版本。
//
// 子 agent 调用策略（runtime/dispatch-policy.mjs，2026-11-11）：每档一条绝对智力分判定线 floor（没调过 = 默认线 defaultFloors），
// 这一档选「智力分 ≥ floor 的候选里成本最低的」（同价取更贴近判定线的）；谁都够不着 → 取最强的并标 short。
// 优先级：图谱 < 档位自定义（overrides，手动指定 模型 + 档位）< 口述备注（note，只进系统提示，这里不管）。
//
// 成本口径跟着「这个子 agent 实际怎么付钱」走：
//   · 官方订阅会话里 Claude 别名（opus/sonnet/haiku/fable）花的是订阅额度：号池里各订阅号的 plan 等效单价取均值（basis 'sub'）；
//   · 第三方服务：真实地址认得出是哪家的套餐端点、图谱里有这家 plan 的成本 → 这家各现行 plan 的均值（basis 'plan'）；
//     否则按官方 API 价（basis 'api'）。自定义 API 会话里没有订阅，Claude 型号也按 API / plan 价。
//
// 匹配：配置里的型号 id / 显示名归一（小写、点与空格换横线、去 8 位日期后缀与 [1m]）后对快照里的 base（slug 去掉档位后缀）
// 精确匹配，不做前缀匹配（claude-opus-5 不能吞掉 claude-opus-5-5）；对不上的查 ALIASES。配了但库里没有的照样列出（标「未评分」），
// 库里有但没配的不出现。归一、别名、同档取舍和 dimensio 的阶梯共用 src/model-knowledge/ratings.mjs；快照里没按现行智力指数
// 版本重算的旧分（old）不进候选——和新版分数不可比。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subagentModelCatalog, resolveSubagentModel, customModelId, subagentServiceUrl, customOwner } from './claude-providers.mjs';
import { accountPlan } from './status.mjs';
import { activeAccountId, listAccounts } from './claude-account.mjs';
import { guessModel } from '../model-knowledge/index.mjs';
import { normKey, familyOf, bestByEffort, loadRatings as indexRatings, RATING_LEVELS as LEVELS } from '../model-knowledge/ratings.mjs';
import { importedRatings, chartMeta, planOfBaseUrl, planCost } from './dispatch-chart.mjs';
import { policyFor, policyOfOwner, activeStrategy, sanitizeStrategy, canEditPolicy, TIER_KEYS } from './dispatch-policy.mjs';

export { normKey };

const SNAPSHOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'model-ratings.json');

// 官方订阅会话里 Agent 工具与工作流都认的 Claude 别名 → 当前内核把它解析成的型号（CLI 2.1.29x；新模型上架时跟 capabilities.mjs 一起改）
export const CLAUDE_SUBS = [
  { alias: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { alias: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { alias: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { alias: 'fable', id: 'claude-fable-5-2', label: 'Fable 5.2' },
];
const SUB_ALIASES = new Set(CLAUDE_SUBS.map((c) => c.alias));

// 四档：key 是 auto:<key>；frac = 默认线占「可派模型里最高智力指数」的比例（top 档的默认线 = 最高分 −1.5）
export const TIERS = [
  { key: 'top', title: '最难', use: '最难的裁决、最终验证' },
  { key: 'hard', title: '难', use: '设计取舍、难排查的问题', frac: 0.88 },
  { key: 'normal', title: '常规', use: '常规实现、一般审查', frac: 0.6 },
  { key: 'light', title: '机械', use: '检索、读文件、机械改动、格式整理', frac: 0.4 },
];
const TOP_SLACK = 1.5;
export const AUTO_RE = /^auto:(top|hard|normal|light)$/i;
export const isAutoModel = (s) => typeof s === 'string' && AUTO_RE.test(s.trim());

// —— 评分数据 ——
let builtinCache = null;            // 内置快照的索引：null = 还没读，false = 没有 / 坏了
let testOverride;                   // undefined = 不覆盖；索引对象 = 测试指定；false = 测试指定「没有评分」
let importedIdx = { src: null, idx: false };   // 导入的图谱：按 importedRatings() 返回的对象身份重建索引
/** 评分索引：有导入的图谱用导入的，否则内置快照（没有 / 坏了 → null，调度提示回到不带阶梯的老写法）。 */
export function loadRatings() {
  if (testOverride !== undefined) return testOverride || null;
  let im = null;
  try { im = importedRatings(); } catch (e) { console.error('[model-ratings] 读不出导入的图谱数据：', e?.message || e); }
  if (im) {
    if (importedIdx.src !== im) importedIdx = { src: im, idx: indexRatings(im) || false };
    if (importedIdx.idx) return importedIdx.idx;
  }
  if (builtinCache !== null) return builtinCache || null;
  try {
    const j = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    builtinCache = (j && Array.isArray(j.models) && j.models.length && indexRatings(j)) || false;
  } catch { builtinCache = false; }
  return builtinCache || null;
}
/** 测试用：传快照对象 = 用它；null = 回到正常来源（导入的 / 内置，内置重读）；false = 当作没有评分。 */
export function _setRatingsForTests(j) {
  if (j === null) { testOverride = undefined; builtinCache = null; importedIdx = { src: null, idx: false }; return; }
  testOverride = j ? indexRatings(j) || false : false;
}

/** 配置里的一个模型 → 快照里现行版本的那一族评分（[{ slug, effort, ii, cost, ... }]）；对不上 → null。 */
export function familyFor(id, label, R = loadRatings()) {
  return familyOf(R, id, label);
}

/** 当前激活号的订阅档（Pro 用 Pro 的等效价，其余按 Max 20x）。 */
export function currentPlan() {
  try { return accountPlan(activeAccountId()) === 'pro' ? 'pro' : 'max20'; } catch { return 'max20'; }
}

// 号池里各订阅号的套餐 → 快照 plans 的键（企业版等认不出的跳过）
const POOL_PLAN = Object.freeze({ pro: 'pro', max5x: 'max5', ultra: 'max20', max: 'max20', team: 'max20' });
/** 号池里识别出的 plan（每个号一条，不去重：订阅成本按号取均值）；一个都认不出 → ['max20']。
 *  令牌留空的号不跳过：它沿用本机登录态，照样在用订阅（认不出套餐的自然被跳过）。 */
export function poolPlans() {
  const out = [];
  try {
    for (const a of listAccounts()) {
      const k = a ? accountPlan(a.id) : null;
      if (typeof k === 'string' && Object.hasOwn(POOL_PLAN, k)) out.push(POOL_PLAN[k]);
    }
  } catch { /* 号池读不出来按 max20 */ }
  return out.length ? out : ['max20'];
}
const planList = (plan) => (Array.isArray(plan) && plan.length ? plan : typeof plan === 'string' && plan && plan !== 'pool' ? [plan] : poolPlans());

const sig3 = (x) => +x.toPrecision(3);

// 订阅等效成本：库里有就用；没有（如 Fable）按这个 plan 里其余模型「等效价 / API 价」的中位数折算
function subCost(v, plan, R) {
  const p = R.plans[plan] || R.plans.max20 || {};
  if (p[v.slug] > 0) return p[v.slug];
  const ratios = [];
  for (const [slug, c] of Object.entries(p)) {
    const api = (R.models.find((m) => m.slug === slug) || {}).cost;
    if (api > 0) ratios.push(c / api);
  }
  ratios.sort((a, b) => a - b);
  const r = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
  return sig3(v.cost * r);
}
// 号池均值：各号按自己的 plan 算一遍再取算术平均（都一样就原值，不再取整）
function poolCost(v, plans, R) {
  const xs = plans.map((p) => subCost(v, p, R));
  return xs.every((x) => x === xs[0]) ? xs[0] : sig3(xs.reduce((a, b) => a + b, 0) / xs.length);
}

const levelsCapable = (efforts) => (efforts || []).filter((e) => LEVELS.includes(e)).length >= 2;
const CLAUDE_NAME_RE = /^(claude[-_.]|opus|sonnet|haiku|fable)/i;
// 目录条目的型号段：只剥开头的 custom:<服务>: 前缀（重名时目录给的是全称）。型号 id 自己可以带冒号（Ollama 的 qwen3:32b、
// OpenRouter 的 xxx:free），不能见冒号就拆，否则 'qwen3:32b' 剥成空串、规范写法变成 custom:<服务>:
const bareOf = (name) => String(name).replace(/^custom:[^:]+:/, '');
// 目录条目的规范写法：有服务 id 的一律 custom:<服务>:<型号>（档位自定义按这个认），测试里的裸清单退回 name
const modelOf = (m) => (m.pid ? customModelId(m.pid, bareOf(m.name)) : m.name);

/**
 * 候选表：[{ write, model, label, effort, ii, cost, basis, vkey?, channel:'sub'|'api', provider, creator, slug, ctx, vision, est }]，
 * 外加 unrated（配了但库里没有）。
 *   catalog         subagentModelCatalog(owner)
 *   official        主会话是官方订阅模型（Claude 别名走订阅；第三方里的 claude-* 型号在这种会话里不转发，不算候选）
 *   routed          官方会话这一轮经上游代理、工作流能写第三方模型名；false = 只剩 Claude 别名
 *   plan            订阅成本口径：'pool'（缺省）= 号池均值；'pro' / 'max5' / 'max20' = 只按这一档；也可以传数组
 *   allowThirdParty false = 只要 Claude：官方会话只剩订阅候选；自定义 API 会话只留快照里 creator 是 Anthropic 的型号
 *   owner           会话身份（查第三方服务的真实地址认 plan；不传 = 主机）
 * write = 系统提示里教 Claude 写的名字；model = 规范写法（订阅写别名，第三方写 custom:<服务>:<型号>，见 dispatch-policy.mjs）。
 */
export function candidates({ catalog = [], official = false, routed = false, plan = 'pool', allowThirdParty = true, owner } = {}, R = loadRatings()) {
  const out = [], unrated = [];
  const onlyClaude = allowThirdParty === false;
  if (!R) return { list: out, unrated: onlyClaude ? catalog.filter((m) => CLAUDE_NAME_RE.test(bareOf(m.name))) : catalog.slice() };
  if (official) {
    const plans = planList(plan);
    for (const c of CLAUDE_SUBS) {
      const fam = R.families.get(c.id);
      if (!fam) continue;
      for (const v of bestByEffort(fam)) {
        if (!LEVELS.includes(v.effort)) continue;
        out.push({
          write: c.alias, model: c.alias, label: c.label, effort: v.effort, ii: v.ii, cost: poolCost(v, plans, R), basis: 'sub',
          channel: 'sub', provider: 'Claude 订阅', creator: 'Anthropic', slug: v.slug, ctx: 0, vision: true, est: !!v.est,
        });
      }
    }
    if (!routed || onlyClaude) return { list: out, unrated: [] };
  }
  const urls = new Map();   // 服务 id → 认出的 plan（null = 按 API 价）
  const planOf = (pid) => {
    if (!pid) return null;
    if (!urls.has(pid)) {
      let hit = null;
      try { hit = planOfBaseUrl(subagentServiceUrl(pid, owner)); } catch { hit = null; }
      urls.set(pid, hit);
    }
    return urls.get(pid);
  };
  for (const m of catalog) {
    const bare = bareOf(m.name);
    if (official && CLAUDE_NAME_RE.test(bare)) continue;   // 订阅会话里这些名字一律走订阅，见 claude-upstream.routedModel
    const fam = familyFor(bare, m.label, R);
    if (!fam) { if (!onlyClaude || CLAUDE_NAME_RE.test(bare)) unrated.push(m); continue; }
    if (onlyClaude && !fam.some((v) => v.creator === 'Anthropic')) continue;
    let vs = bestByEffort(fam).filter((v) => v.effort !== 'off');
    if (!vs.length) vs = bestByEffort(fam);
    if (levelsCapable(m.efforts)) vs = vs.filter((v) => LEVELS.includes(v.effort) || v.effort === '');
    else vs = [vs.reduce((a, b) => (b.ii > a.ii ? b : a))].map((v) => ({ ...v, effort: '' }));   // 档位不是官方五档：只认它最强的那条，effort 不写
    const pl = planOf(m.pid);
    for (const v of vs) {
      const pc = pl ? planCost(R, pl.vkey, v.slug) : null;
      out.push({
        write: m.name, model: modelOf(m), label: m.label, effort: v.effort, ii: v.ii,
        cost: pc != null ? pc : v.cost, basis: pc != null ? 'plan' : 'api', ...(pc != null ? { vkey: pl.vkey } : {}),
        channel: 'api', provider: m.provider, creator: v.creator || '', slug: v.slug,
        ctx: m.contextWindow || 0, vision: !!m.vision, est: !!v.est,
      });
    }
  }
  return { list: out, unrated };
}

// 首选：成本最低；同价取智力分低的（更贴近判定线——够用就行，把更强的留给更高一档）
const cheapest = (xs) => xs.reduce((a, b) => (!a || b.cost < a.cost || (b.cost === a.cost && b.ii < a.ii) ? b : a), null);
// 备选：成本最低；同价取智力分高的（备选是首选出问题时顶上的，同价就要更稳的那个；与改造前一致）
const cheapestAlt = (xs) => xs.reduce((a, b) => (!a || b.cost < a.cost || (b.cost === a.cost && b.ii > a.ii) ? b : a), null);
// 最强：智力分最高；同分取便宜的
const strongest = (xs) => xs.reduce((a, b) => (!a || b.ii > a.ii || (b.ii === a.ii && b.cost < a.cost) ? b : a), null);

// 判定线保留一位小数：往上取（智力分本身是一位小数，上取后「≥ 线」的结果和不取整完全一样）
const ceil1 = (x) => Math.ceil(x * 10 - 1e-6) / 10;
/** 默认线：{ top, hard, normal, light }——top = 候选里最高智力分 − 1.5，其余 = 最高分 × frac（一位小数）；候选为空 → 全 0。 */
export function defaultFloors(list) {
  const top = list && list.length ? Math.max(...list.map((c) => c.ii)) : 0;
  return Object.fromEntries(TIERS.map((t) => [t.key, Math.max(0, ceil1(t.frac ? top * t.frac : top - TOP_SLACK))]));
}

// 档位自定义 → 候选里的那一格：模型 + 档位都对上 = 那一格；档位对不上但模型在 = 按最接近的档合成一格（ii / cost 借那一档，标 est）；
// 模型不在候选里（被过滤 / 已删除 / 不调用非 Claude）→ null
function overrideCell(list, ov) {
  const same = list.filter((c) => c.model === ov.model);
  if (!same.length) return null;
  const e = String(ov.effort || '');
  const exact = same.find((c) => c.effort === e);
  if (exact) return exact;
  const want = LEVELS.indexOf(e === '' ? 'high' : e === 'minimal' ? 'low' : e);   // 不指定 = 按 high 估（Claude 与多数厂商的默认档）
  const ranked = same.filter((c) => LEVELS.includes(c.effort));
  let near;
  if (want < 0 || !ranked.length) near = strongest(same);
  else {
    const d = (c) => Math.abs(LEVELS.indexOf(c.effort) - want);
    near = ranked.reduce((a, b) => (d(b) < d(a) || (d(b) === d(a) && b.ii > a.ii) ? b : a));
  }
  return { ...near, effort: e, est: true };
}

/**
 * 一组候选 → 四档 [{ ...TIER, floor, floorDefault, pick, alt, source:'chart'|'override', short, overrideSkipped }]；候选为空 → []。
 *   floors     { top?, hard?, normal?, light? }：这一档的判定线（null / 不给 = 默认线）
 *   overrides  { <档>: { model, effort } | null }：手动指定，压过图谱（模型不在候选里 → 忽略，overrideSkipped:true）
 * pick 永不为 null；short = 没有候选够得着判定线，取了最强的。
 */
export function ladderOf(list, { floors, overrides } = {}) {
  if (!list || !list.length) return [];
  const def = defaultFloors(list);
  return TIERS.map((t) => {
    const fd = def[t.key];
    const fv = floors ? floors[t.key] : null;
    const floor = typeof fv === 'number' && Number.isFinite(fv) ? fv : fd;
    const ok = list.filter((c) => c.ii >= floor);
    let pick = cheapest(ok), short = false;
    if (!pick) { pick = strongest(list); short = true; }
    let source = 'chart', overrideSkipped = false;
    const ov = overrides && overrides[t.key];
    if (ov && typeof ov.model === 'string' && ov.model) {
      const hit = overrideCell(list, ov);
      if (hit) { pick = hit; source = 'override'; short = false; } else overrideSkipped = true;
    }
    // 备选：首选走订阅时给一个不占订阅额度的；否则换一个模型（首选服务报错 / 限额、或要交叉验证时用）
    const pool = ok.filter((c) => (pick.channel === 'sub' ? c.channel !== 'sub' : c.write !== pick.write));
    let alt = cheapestAlt(pool);
    // 订阅额度用满时总得有地方派：不占额度的模型都够不着这档，就给其中最强的一个，标「略弱」
    if (!alt && pick.channel === 'sub') {
      const api = list.filter((c) => c.channel !== 'sub');
      if (api.length) alt = { ...strongest(api), weaker: true };
    }
    return { ...t, floor, floorDefault: fd, pick, alt, source, short, overrideSkipped };
  });
}

// 策略里只给 Agent 工具那条路用的档位自定义：Agent 工具的 model 只认 Claude 别名
const aliasOverrides = (ov) => (ov ? Object.fromEntries(TIER_KEYS.map((k) => [k, ov[k] && SUB_ALIASES.has(ov[k].model) ? ov[k] : null])) : undefined);

/**
 * 阶梯全貌：{ tiers, agentTool, others, unrated, candidates, generated }；没有快照或一个评上分的都没有 → null。
 *   opts 同 candidates，外加 strategy（调用策略里的一套：取它的 floors / overrides；不给 = 默认线、不自定义）。
 *   agentTool：官方会话里 Agent 工具那条路（只能写 Claude 别名）的四档，同样吃 floors，档位自定义只认 Claude 别名的。
 */
export function buildLadder(opts = {}, R = loadRatings()) {
  if (!R) return null;
  const { list, unrated } = candidates(opts, R);
  const st = opts.strategy || null;
  const floors = st && st.floors, overrides = st && st.overrides;
  const tiers = ladderOf(list, { floors, overrides });
  if (!tiers.length) return null;
  const agentTool = opts.official ? ladderOf(list.filter((c) => c.channel === 'sub'), { floors, overrides: aliasOverrides(overrides) }) : [];
  const used = new Set(tiers.flatMap((t) => [t.pick, t.alt].filter(Boolean).map((c) => c.write)));
  const others = [];
  for (const c of list) if (!used.has(c.write) && !others.some((o) => o.write === c.write)) others.push(c);
  return { tiers, agentTool, others, unrated, candidates: list, generated: R.generated };
}

// owner 的生效策略：总开关关着 / 没登记过 → 默认阶梯（兼容关着时照样写 auto:<档> 的旧脚本）。
// 返回可直接展开进 buildLadder 的 { strategy, allowThirdParty }（或 {}）；回合提示那条路也用它，保证与 resolveAuto 同口径。
export function ladderOptsOf(owner) {
  let pol = null;
  try { pol = policyOfOwner(owner); } catch (e) { console.error('[model-ratings] 读不出子 agent 调用策略：', e?.message || e); }
  if (!pol || pol.enabled === false) return {};
  return { strategy: activeStrategy(pol), allowThirdParty: pol.allowThirdParty !== false };
}

/**
 * auto:<档> → 这一档首选的落点：{ kind:'claude', model, effort }（订阅会话的 Claude）或 { kind:'provider', provider, model, effort }；
 * 不是 auto 名 / 没有可用候选 → null。owner = 会话身份（成员用自己的 + 管理员共享的服务；按它登记的调用策略选）。
 * record = 把落点记进 served（工作流面板显示用）；只有真正改写请求的调用方记，预解析（start_session 选模型）传 false。
 */
export function resolveAuto(name, owner, { official = false, record = true } = {}) {
  const m = AUTO_RE.exec(String(name || '').trim());
  if (!m || !owner) return null;
  const lad = buildLadder({ catalog: subagentModelCatalog(owner), official, routed: official, plan: 'pool', owner, ...ladderOptsOf(owner) });
  const tier = lad && lad.tiers.find((t) => t.key === m[1].toLowerCase());
  if (!tier) return null;
  const p = tier.pick;
  let t = null;
  if (p.channel === 'sub') {
    const c = CLAUDE_SUBS.find((x) => x.alias === p.write);
    if (c) t = { kind: 'claude', model: c.id, effort: p.effort };
  } else {
    const hit = resolveSubagentModel(p.write, owner) || (p.model !== p.write ? resolveSubagentModel(p.model, owner) : null);
    if (hit) t = { kind: 'provider', provider: hit.provider, model: hit.model, effort: p.effort };
  }
  if (t && record) served.set(servedKey(owner, official, tier.key), { model: t.kind === 'claude' ? t.model : customModelId(t.provider.id, t.model.id), effort: t.effort || '' });
  return t;
}

/**
 * 设置页 / agent 接入工具用的完整预览（不落盘）：
 *   { basis, tiers:[{ key, title, use, floor, floorDefault, source, short, overrideSkipped, pick, agentTool }], candidates, unrated, poolPlans, chart }
 *   basis      'official'（缺省）= 主会话是官方订阅模型的口径；'custom' = 主会话是自定义 API 模型（候选全部来自服务清单、API / plan 价）
 *   strategy   不给 = 这个身份生效的那套；给了 = 按它算（拖判定线、改档位时的实时预览，宽松规范化）
 *   allowThirdParty  不给 = 策略文件里的
 * poolPlans = 号池里认出的套餐（去重）；只给能改策略的身份（canEditPolicy），其余身份恒为 []。
 * agentTool =普通子 agent（Agent 工具）那条路实际落到的，只在和 pick 不同时给，否则 null；custom 口径恒为 null。
 */
export function ladderPreview(ctx, { basis = 'official', strategy, allowThirdParty } = {}) {
  const b = basis === 'custom' ? 'custom' : 'official';
  const pol = policyFor(ctx);
  const st = strategy !== undefined && strategy !== null ? sanitizeStrategy(strategy) : activeStrategy(pol);
  const atp = typeof allowThirdParty === 'boolean' ? allowThirdParty : pol.allowThirdParty !== false;
  let owner = null;
  try { owner = customOwner(ctx); } catch { owner = null; }
  let catalog = [];
  try { catalog = owner ? subagentModelCatalog(owner) : []; } catch (e) { console.error('[model-ratings] 读不出可派的模型清单：', e?.message || e); }
  const official = b === 'official';
  const opts = { catalog, official, routed: official && catalog.length > 0, plan: 'pool', allowThirdParty: atp, owner: owner || undefined, strategy: st };
  const R = loadRatings();
  const L = buildLadder(opts, R);
  const pickView = (c) => ({
    model: c.model, label: c.label, effort: c.effort, ii: c.ii, cost: c.cost, basis: c.basis, provider: c.provider,
    ...(c.vkey ? { vkey: c.vkey } : {}), ...(c.est ? { est: true } : {}),
  });
  const tiers = L ? L.tiers.map((t) => {
    const a = official ? L.agentTool.find((x) => x.key === t.key) : null;
    const diff = a && (a.pick.model !== t.pick.model || a.pick.effort !== t.pick.effort);
    return {
      key: t.key, title: t.title, use: t.use, floor: t.floor, floorDefault: t.floorDefault, source: t.source, short: t.short,
      overrideSkipped: t.overrideSkipped, pick: pickView(t.pick),
      agentTool: diff ? { model: a.pick.model, label: a.pick.label, effort: a.pick.effort } : null,
    };
  }) : [];
  const { list, unrated } = L ? { list: L.candidates, unrated: L.unrated } : candidates(opts, R);
  return {
    basis: b, tiers,
    candidates: list.map((c) => ({ ...pickView(c), creator: c.creator || '' })),
    unrated: unrated.map((m) => ({ model: modelOf(m), label: m.label, provider: m.provider })),
    // 号池构成是主机配置：只给能改策略的身份，且只给去重后的套餐名（不透露有几个号）；快照访客 / 没命令行的成员给 []
    poolPlans: canEditPolicy(ctx) ? [...new Set(poolPlans())] : [],
    chart: chartMeta(),
  };
}

// 工作流面板显示 auto:<档> 真实落到的模型与档位：请求改写时记下每个身份每一档最近一次的落点（{ model, effort }，
// model 是 claude-* 或 custom:<服务>:<型号>）。重启后还没请求过的（只看历史）按当前阶梯现算一次。
// 键带口径：同一身份的官方订阅会话（claude-upstream）和自定义 API 会话（providers-proxy）落点不同，各记各的，互不覆盖。
const served = new Map();
const servedKey = (owner, official, tier) => owner + '|' + (official ? 1 : 0) + '|' + tier;
export function autoServed(name, owner, { official = true } = {}) {
  const m = AUTO_RE.exec(String(name || '').trim());
  if (!m || !owner) return null;
  const k = servedKey(owner, official, m[1].toLowerCase());
  if (!served.has(k)) { try { resolveAuto(name, owner, { official }); } catch { /* 阶梯算不出就不补 */ } }
  return served.get(k) || null;
}

// CLI 不认识 auto:<档> 这个名字，按未知型号只给 max_tokens=32000（2.1.3xx 实测：同一个 CLI 对 claude-opus-5-5 / claude-haiku-5-5
// 发 128000），换型号时不跟着改，子 agent 的输出上限就平白少了四分之三。max 档的长思考加上一份长回答就会撞线，
// 更要命的是自动压缩也沿用这个上限：摘要写不完 → 「automatic compaction failed」→ 子 agent 当场死掉（11-08 爱尔眼科工作流 8 个 agent 死在这上面）。
// 所以请求体里正好是这个默认值时，改成落点型号自己的上限；封顶按 CLI 对未知型号允许的最大值。部署者用 CLAUDE_CODE_MAX_OUTPUT_TOKENS 自定过就不动。
const CLI_UNKNOWN_MAX_TOKENS = 32_000;
const CLI_UNKNOWN_MAX_TOKENS_UPPER = 128_000;
function autoMaxTokens(body, target) {
  if (body.max_tokens !== CLI_UNKNOWN_MAX_TOKENS || process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) return null;
  const cap = target.kind === 'claude' ? guessModel(target.model, { protocol: 'anthropic' }).maxOutput : Number(target.model && target.model.maxOutput) || 0;
  const n = Math.min(cap, CLI_UNKNOWN_MAX_TOKENS_UPPER);
  return n > CLI_UNKNOWN_MAX_TOKENS ? n : null;
}

/** 把请求体里的 auto:* 换成落点（model、output_config.effort，以及 CLI 按未知型号给小了的 max_tokens）；回新对象。 */
export function applyAutoTarget(body, target) {
  // 第三方写成 custom:<服务>:<型号>：重名型号也落到阶梯选中的那一家
  const out = { ...body, model: target.kind === 'claude' ? target.model : customModelId(target.provider.id, target.model.id) };
  if (target.effort) out.output_config = { ...(body.output_config && typeof body.output_config === 'object' ? body.output_config : {}), effort: target.effort };
  const mt = autoMaxTokens(body, target);
  if (mt) out.max_tokens = mt;
  return out;
}
