// 子 agent 选型阶梯（2026-10-30）：按用户自己维护的模型性价比库给「能派的模型 × 推理档位」排出四档首选。
//
// 数据：src/config/model-ratings.json——发版导出时由 scripts/model-ratings-sync.mjs 从库里压出来的快照（库随时在改，
// 每个版本只认发版那一刻的数据）。每条 = Artificial Analysis 的一个「模型 × 档位」：智力指数 ii、官方 API 每任务成本（元），
// 外加 Anthropic 订阅 plan 的每任务等效成本。
//
// 用法有三处，都按同一份候选表算，结论一致：
//   · 系统提示（claude-turn-settings 的 dispatchNudge）：只给 Claude 一张约十行的阶梯——每档首选 + 一个备选，
//     被更便宜又更聪明的选项全面胜出的配置不进表；Claude 只管判断子任务属于哪一档。
//   · 虚拟模型名 auto:top / auto:hard / auto:normal / auto:light：动态工作流 agent({ model:'auto:hard' }) 原样进 body.model，
//     请求经过 bridge 时（官方订阅会话走 claude-upstream，自定义 API 会话走 claude-providers-proxy）换成这一档的首选模型与档位。
//   · 工作流面板：auto:* 的 agent 显示实际落到的模型（tool-summary 从子 agent 转录读回）。
//
// 成本口径跟着「这个子 agent 实际怎么付钱」走：官方订阅会话里 Claude 别名（opus/sonnet/haiku/fable）花的是订阅额度，
// 按订阅等效单价算（账号是 Pro 用 Pro 的，否则按 Max 20x）；第三方服务按官方 API 价。自定义 API 会话里一律 API 价。
//
// 匹配：配置里的型号 id / 显示名归一（小写、点与空格换横线、去 8 位日期后缀与 [1m]）后对快照里的 base（slug 去掉档位后缀）
// 精确匹配，不做前缀匹配（claude-opus-5 不能吞掉 claude-opus-5-5）；对不上的查 ALIASES。配了但库里没有的照样列出（标「未评分」），
// 库里有但没配的不出现。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subagentModelCatalog, resolveSubagentModel, customModelId } from './claude-providers.mjs';
import { accountPlan } from './status.mjs';
import { activeAccountId } from './claude-account.mjs';

const SNAPSHOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'model-ratings.json');
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// 型号名对不上库里 slug 的（服务商自起的名字、库里另起的名字）。键是归一后的 id，值是快照里的 base。
const ALIASES = {
  'gemini-argon': 'gemini-4-argon',
  'gemini-carbon': 'gemini-4-carbon',
  'deepseek-flash': 'deepseek-v4-1-flash-1017',
  'deepseek-chat': 'deepseek-v4-1-flash-1017',
  'mimo-v2-6-pro-ultraspeed': 'mimo-v2-6-pro',
  'claude-haiku-4-5': 'claude-4-5-haiku',
  'claude-sonnet-4-5': 'claude-4-5-sonnet',
};

// 官方订阅会话里 Agent 工具与工作流都认的 Claude 别名 → 当前内核把它解析成的型号（CLI 2.1.29x；新模型上架时跟 capabilities.mjs 一起改）
export const CLAUDE_SUBS = [
  { alias: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { alias: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { alias: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { alias: 'fable', id: 'claude-fable-5-1', label: 'Fable 5.1' },
];

// 四档：key 是 auto:<key>；frac = 门槛占「可派模型里最高智力指数」的比例（top 档取最高分 −1.5 以内最便宜的）
export const TIERS = [
  { key: 'top', title: '最难', use: '最难的裁决、最终验证' },
  { key: 'hard', title: '难', use: '设计取舍、难排查的问题', frac: 0.88 },
  { key: 'normal', title: '常规', use: '常规实现、一般审查', frac: 0.6 },
  { key: 'light', title: '机械', use: '检索、读文件、机械改动、格式整理', frac: 0.4 },
];
const TOP_SLACK = 1.5;
export const AUTO_RE = /^auto:(top|hard|normal|light)$/i;
export const isAutoModel = (s) => typeof s === 'string' && AUTO_RE.test(s.trim());

let cache = null;
/** 快照（没有 / 坏了 → null，调度提示回到不带阶梯的老写法）。 */
export function loadRatings() {
  if (cache !== null) return cache || null;
  try {
    const j = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    cache = j && Array.isArray(j.models) && j.models.length ? index(j) : false;
  } catch { cache = false; }
  return cache || null;
}
export function _setRatingsForTests(j) { cache = j ? index(j) : j === null ? null : false; }

function index(j) {
  const families = new Map();
  for (const m of j.models) {
    if (!families.has(m.base)) families.set(m.base, []);
    families.get(m.base).push(m);
  }
  return { ...j, families, plans: j.plans || {} };
}

/** 型号 id / 显示名 → 归一键：小写、去 custom:<服务>: 前缀与 [1m]、点 / 下划线 / 空格换横线、去末尾 8 位日期。 */
export function normKey(s) {
  let t = String(s || '').trim().toLowerCase().replace(/\[1m\]$/, '');
  t = t.replace(/^custom:[^:]+:/, '');
  t = t.replace(/[._\s/]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return t.replace(/-\d{8}$/, '');
}

/** 配置里的一个模型 → 快照里的那一族评分（[{ slug, effort, ii, cost, ... }]）；对不上 → null。 */
export function familyFor(id, label, R = loadRatings()) {
  if (!R) return null;
  for (const raw of [id, label]) {
    const k = normKey(raw);
    if (!k) continue;
    const base = ALIASES[k] || k;
    const fam = R.families.get(base);
    if (fam) return fam;
  }
  return null;
}

// 同一档位多条（同族不同快照）：未弃用优先，再取最新
function bestByEffort(fam) {
  const out = new Map();
  for (const v of fam) {
    const cur = out.get(v.effort);
    if (!cur || (!!cur.dep > !!v.dep) || (!!cur.dep === !!v.dep && String(v.rel) > String(cur.rel))) out.set(v.effort, v);
  }
  return [...out.values()];
}

/** 当前激活号的订阅档（Pro 用 Pro 的等效价，其余按 Max 20x）。 */
export function currentPlan() {
  try { return accountPlan(activeAccountId()) === 'pro' ? 'pro' : 'max20'; } catch { return 'max20'; }
}

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
  return +(v.cost * r).toPrecision(3);
}

const levelsCapable = (efforts) => (efforts || []).filter((e) => LEVELS.includes(e)).length >= 2;

/**
 * 候选表：[{ write, label, effort, ii, cost, channel:'sub'|'api', provider, ctx, vision, est }]，外加 unrated（配了但库里没有）。
 *   catalog   subagentModelCatalog(owner)
 *   official  主会话是官方订阅模型（Claude 别名走订阅；第三方里的 claude-* 型号在这种会话里不转发，不算候选）
 *   routed    官方会话这一轮经上游代理、工作流能写第三方模型名；false = 只剩 Claude 别名
 */
export function candidates({ catalog = [], official = false, routed = false, plan = 'max20' } = {}, R = loadRatings()) {
  const out = [], unrated = [];
  if (!R) return { list: out, unrated: catalog.slice() };
  if (official) {
    for (const c of CLAUDE_SUBS) {
      const fam = R.families.get(c.id);
      if (!fam) continue;
      for (const v of bestByEffort(fam)) {
        if (!LEVELS.includes(v.effort)) continue;
        out.push({ write: c.alias, label: c.label, effort: v.effort, ii: v.ii, cost: subCost(v, plan, R), channel: 'sub', provider: 'Claude 订阅', ctx: 0, vision: true, est: !!v.est });
      }
    }
    if (!routed) return { list: out, unrated: [] };
  }
  for (const m of catalog) {
    const bare = m.name.includes(':') ? m.name.split(':').slice(2).join(':') : m.name;
    if (official && /^(claude[-_.]|opus|sonnet|haiku|fable)/i.test(bare)) continue;   // 订阅会话里这些名字一律走订阅，见 claude-upstream.routedModel
    const fam = familyFor(bare, m.label, R);
    if (!fam) { unrated.push(m); continue; }
    let vs = bestByEffort(fam).filter((v) => v.effort !== 'off');
    if (!vs.length) vs = bestByEffort(fam);
    if (levelsCapable(m.efforts)) vs = vs.filter((v) => LEVELS.includes(v.effort) || v.effort === '');
    else vs = [vs.reduce((a, b) => (b.ii > a.ii ? b : a))].map((v) => ({ ...v, effort: '' }));   // 档位不是官方五档：只认它最强的那条，effort 不写
    for (const v of vs) {
      out.push({ write: m.name, label: m.label, effort: v.effort, ii: v.ii, cost: v.cost, channel: 'api', provider: m.provider, ctx: m.contextWindow || 0, vision: !!m.vision, est: !!v.est });
    }
  }
  return { list: out, unrated };
}

const cheapest = (xs) => xs.reduce((a, b) => (!a || b.cost < a.cost || (b.cost === a.cost && b.ii > a.ii) ? b : a), null);

/** 一组候选 → 四档 [{ ...TIER, floor, pick, alt }]；候选为空 → []。 */
export function ladderOf(list) {
  if (!list.length) return [];
  const top = Math.max(...list.map((c) => c.ii));
  return TIERS.map((t) => {
    const floor = t.frac ? top * t.frac : top - TOP_SLACK;
    const ok = list.filter((c) => c.ii >= floor);
    const pick = cheapest(ok);
    // 备选：首选走订阅时给一个不占订阅额度的；否则换一个模型（首选服务报错 / 限额、或要交叉验证时用）
    const pool = ok.filter((c) => (pick.channel === 'sub' ? c.channel !== 'sub' : c.write !== pick.write));
    let alt = cheapest(pool);
    // 订阅额度用满时总得有地方派：不占额度的模型都够不着这档，就给其中最强的一个，标「略弱」
    if (!alt && pick.channel === 'sub') {
      const api = list.filter((c) => c.channel !== 'sub');
      if (api.length) alt = { ...api.reduce((a, b) => (b.ii > a.ii || (b.ii === a.ii && b.cost < a.cost) ? b : a)), weaker: true };
    }
    return { ...t, floor, pick, alt };
  });
}

/** 阶梯全貌：{ tiers, agentTool, others, unrated }；没有快照或一个评上分的都没有 → null。 */
export function buildLadder(opts = {}, R = loadRatings()) {
  if (!R) return null;
  const { list, unrated } = candidates(opts, R);
  const tiers = ladderOf(list);
  if (!tiers.length) return null;
  const agentTool = opts.official ? ladderOf(list.filter((c) => c.channel === 'sub')) : [];
  const used = new Set(tiers.flatMap((t) => [t.pick, t.alt].filter(Boolean).map((c) => c.write)));
  const others = [];
  for (const c of list) if (!used.has(c.write) && !others.some((o) => o.write === c.write)) others.push(c);
  return { tiers, agentTool, others, unrated, generated: R.generated };
}

/**
 * auto:<档> → 这一档首选的落点：{ kind:'claude', model, effort }（订阅会话的 Claude）或 { kind:'provider', provider, model, effort }；
 * 不是 auto 名 / 没有可用候选 → null。owner = 会话身份（成员用自己的 + 管理员共享的服务）。
 */
export function resolveAuto(name, owner, { official = false } = {}) {
  const m = AUTO_RE.exec(String(name || '').trim());
  if (!m || !owner) return null;
  const lad = buildLadder({ catalog: subagentModelCatalog(owner), official, routed: official, plan: currentPlan() });
  const tier = lad && lad.tiers.find((t) => t.key === m[1].toLowerCase());
  if (!tier) return null;
  const p = tier.pick;
  if (p.channel === 'sub') {
    const c = CLAUDE_SUBS.find((x) => x.alias === p.write);
    return c ? { kind: 'claude', model: c.id, effort: p.effort } : null;
  }
  const hit = resolveSubagentModel(p.write, owner);
  return hit ? { kind: 'provider', provider: hit.provider, model: hit.model, effort: p.effort } : null;
}

/** 把请求体里的 auto:* 换成落点（model 与 output_config.effort）；回新对象。 */
export function applyAutoTarget(body, target) {
  // 第三方写成 custom:<服务>:<型号>：重名型号也落到阶梯选中的那一家
  const out = { ...body, model: target.kind === 'claude' ? target.model : customModelId(target.provider.id, target.model.id) };
  if (target.effort) out.output_config = { ...(body.output_config && typeof body.output_config === 'object' ? body.output_config : {}), effort: target.effort };
  return out;
}
