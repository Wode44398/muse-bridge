// 子 agent 选型阶梯：把「这个 dimensio 实例此刻真能用的模型 × 思考档」按性价比数据排成四档首选 + 备选。
//
// 数据：bridge 发版时压出来的模型性价比快照（config/model-ratings.json，经 core-link 取——源码直跑与离线包两种形态都成立）。
// 每条 = 一个「模型 × 档位」：智力指数 ii、官方 API 每任务成本（元）。快照缺了 / 坏了 → 没有阶梯，只给按难度定档的一句话。
// 管理员在 bridge 导入过「订阅 plan 性价比图」时用导入的那份（随调用策略一起从 bridge 取，见 dispatch-policy.ts）。
//
// 三处用同一份候选表，结论一致：
//   · 系统提示的「Sub-agent models」一段（dispatchSection）：每档首选 + 一个备选，外加「其余可用」「未评分」各一行；
//   · 虚拟模型名 auto:top / auto:hard / auto:normal / auto:light（routeSubAgentModel）：Agent 工具与工作流 agent() 写它，
//     派发时换成这一档首选的 provider + 型号 + 档位（档位压过调用方自己写的 effort，再过一遍 clampEffort 的思考档契约）；
//     StartSession 的 model 也能写它（只在调用策略的 session 范围开着时）；
//   · 「服务:型号」写法（同一个型号 id 挂在两家服务下时用来点名其中一家），也在派发时拆开。
//   另有 ladderPreview：bridge 设置页「子 agent 调用策略」的四档落点与候选点（dispatch-routes.ts）。
//
// 子 agent 调用策略（2026-11-14，bridge 设置 › dimensio › 子 agent 调用策略；取法见 dispatch-policy.ts）：取得到时由它说了算——
//   · 总开关关 → 不出这一段，auto:<档> 按改造前的默认解析（偏好 subagentLadder：默认阶梯，关着就落到主会话模型 + 按档换算的档位）；
//   · 生效范围：workflow = Workflow 的 agent()，subagent = Agent 工具，session = StartSession 的 auto:<档>。没勾的那条路不写进提示，
//     auto:<档> 同样按改造前的默认解析；StartSession 没勾 = 不解析 auto（当作没给 model，沿用本会话）；
//   · 每档一条绝对智力分判定线（没调过 = 默认线），这一档选「够线的候选里成本最低的，同价取更贴近线的」，够不着取最强的——
//     判定线与取舍和 bridge 的 Claude 阶梯共用 src/model-knowledge/ladder.mjs；本机模型照旧压到「没有云端够得着时才当首选」；
//   · 档位自定义（模型 + 推理强度）压过判定线：按 provider + 型号找候选，指定的那家没有就找同型号的别家，再没有（被过滤 / 删了 /
//     不调用非 Claude）就忽略这一档、走判定线；档位没有对应格子时借最近的官方档的分数与成本；
//   · 不调用非 Claude 模型 → 候选只留 Claude 各型号；
//   · 口述备注拼在这一段最后，压过上面的一切。
//   取不到（不是 bridge 拉起的、bridge 太旧）→ 一切照改造前：偏好 subagentLadder 开关与 subagentDispatch 文本。
// 「原生」在 dimensio 的意思：系统提示里没有这一段，模型派子 agent 时不写 model / effort，子 agent 沿用主会话的 provider、型号与思考档。
//
// 候选 = 目录里的每个对话型号，且：厂商没被部署方关掉、有可用的 Key（自定义服务、插件提供的、管理员共享的都一样算），
// 本机引擎（local）还要 /health 就绪——没起的本机模型不算能用。
//
// 计价口径 = 这个实例实际怎么付钱：dimensio 没有订阅额度那一说，云端一律按各家 API 价（快照里的 cost）；
// 本机模型不按 token 计费，记 0 元——但一张卡一次只服务一路，并行派出去会排队，所以本机模型只在「这一档没有云端模型够得着」
// 时才当首选，平时只当备选。Kimi for Coding 与 MiMo 的 tp- Key 是套餐额度，快照里没有套餐价，排序仍按 API 价、提示里标一句。
//
// 没有评分数据的型号：不进四档、auto:* 永远不会落到它；在提示里列在「未评分」一行，只在用户点名时用。
// 一个评上分的都没有（或开关关着）时 auto:<档> 落到主会话自己的模型，档位按 top→xhigh / hard→high / normal→medium / light→low。
//
// 匹配：型号 id 与显示名都试，归一（小写、去 [1m]、点 / 下划线 / 空格 / 斜杠换横线、去末尾 8 位日期）后对快照的 base 精确匹配
// （不做前缀匹配：claude-opus-5 不能吞掉 claude-opus-5-5），对不上查 ALIASES。快照里没按现行智力指数版本重算的旧分（old）
// 不进候选：和新版分数不可比（旧版 Qwen3.8 Max 40.2、v5 33.6）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { coreUrl } from "../core-link.ts";
import { MK, type RatingRow, type RatingsIndex as Ratings, type RatingsSnapshot } from "../model-knowledge.ts";
import { allProviders, canonicalModelId, clampEffort, defaultEffort, modelSpec, EFFORT_ORDER, type ModelSpec, type ProviderSpec } from "../catalog.ts";
import { hasKey, resolveKey } from "../config.ts";
import { disabledProviders } from "../tenant.ts";
import { engineOfModel, localEngineReady, type LocalEngine } from "../localai.ts";
import { prefValue } from "../prefs.ts";
import { inTestProcess } from "../paths.ts";
import type { ProviderId } from "../providers/types.ts";
import type { ThinkingLevel } from "./turn.ts";
import {
  currentDispatchPolicy,
  importedChartRatings,
  refreshDispatchPolicy,
  type DimPolicy,
  type PolicyStrategy,
  type PortableOverride,
} from "./dispatch-policy.ts";

// ── 快照 ────────────────────────────────────────────────────────────────────
// 归一 / 别名 / 同档取舍 / 旧分剔除都在共用的 src/model-knowledge/ratings.mjs（bridge 的 Claude 子 agent 阶梯用同一份），经 MK 取。
let builtin: Ratings | null | false | undefined; // 内置快照的索引：undefined = 还没读，false = 没有 / 坏了
let testRatings: Ratings | false | undefined; // 测试指定：false = 当作没有快照，undefined = 不覆盖
let importedIdx: { src: RatingsSnapshot | null; idx: Ratings | false } = { src: null, idx: false };
export function loadRatings(): Ratings | null {
  if (testRatings !== undefined) return testRatings || null;
  // bridge 导入过性价比图：用导入的那份（按对象身份重建索引）
  const im = importedChartRatings();
  if (im) {
    if (importedIdx.src !== im) importedIdx = { src: im, idx: MK.loadRatings(im) || false };
    if (importedIdx.idx) return importedIdx.idx;
  }
  if (builtin === undefined) {
    try {
      const j = JSON.parse(readFileSync(fileURLToPath(coreUrl("config/model-ratings.json")), "utf8"));
      builtin = (j && Array.isArray(j.models) && j.models.length && MK.loadRatings(j)) || false;
    } catch {
      builtin = false;
    }
  }
  return builtin || null;
}
// 测试用：给一份快照（null = 当作没有快照；undefined = 回到正常来源，内置的下次重读盘）
export function setRatingsForTests(j: RatingsSnapshot | null | undefined): void {
  if (j === undefined) {
    testRatings = undefined;
    builtin = undefined;
    return;
  }
  testRatings = j === null ? false : MK.loadRatings(j) || false;
}

export const normKey = (s: unknown): string => MK.normKey(s);
const familyFor = (id: string, label: string, R: Ratings): RatingRow[] | null => MK.familyOf(R, id, label);
const bestByEffort = (fam: RatingRow[]): RatingRow[] => MK.bestByEffort(fam);

// ── 能用的模型 ────────────────────────────────────────────────────────────────
// 本机引擎就绪与否：探一次 /health 记 30 秒；系统提示是同步拼的，只读缓存（没探过 = 不算能用）
const LOCAL_TTL_MS = 30_000;
const localSeen = new Map<LocalEngine, { ok: boolean; at: number }>();
let localOverride: ((engine: LocalEngine) => boolean) | null = null;
export function setLocalReadyForTests(fn: ((engine: LocalEngine) => boolean) | null): void {
  localOverride = fn;
  localSeen.clear();
}
function localReady(engine: LocalEngine): boolean {
  if (localOverride) return localOverride(engine);
  return localSeen.get(engine)?.ok === true;
}
export async function refreshLocalReady(): Promise<void> {
  // 测试进程不去碰本机端口（结果会随这台机器上起没起模型而变）：没设覆盖就一律当没起
  if (localOverride || inTestProcess() || disabledProviders().has("local")) return;
  const now = Date.now();
  await Promise.all(
    (["qwen", "strata"] as LocalEngine[]).map(async (e) => {
      const seen = localSeen.get(e);
      if (seen && now - seen.at < LOCAL_TTL_MS) return;
      localSeen.set(e, { ok: await localEngineReady(e).catch(() => false), at: Date.now() });
    }),
  );
}

type Billing = "api" | "plan" | "local";
function billingOf(p: ProviderId): Billing {
  if (p === "local") return "local";
  if (p === "kimi") return "plan";
  if (p === "mimo" && resolveKey("mimo")?.startsWith("tp-")) return "plan";
  return "api";
}

export interface UsableModel {
  provider: ProviderId;
  providerName: string;
  model: string;
  label: string;
  efforts: ThinkingLevel[];
  ctx: number;
  image: boolean;
  billing: Billing;
}
export function usableModels(): UsableModel[] {
  const off = disabledProviders();
  const out: UsableModel[] = [];
  for (const p of allProviders() as ProviderSpec[]) {
    if (off.has(p.id) || !hasKey(p.id) || p.custom?.hidden) continue;
    for (const m of p.models as ModelSpec[]) {
      if (p.id === "local" && !localReady(engineOfModel(m.id))) continue;
      out.push({
        provider: p.id, providerName: p.name, model: m.id, label: m.label || m.id,
        efforts: m.efforts?.length ? m.efforts : ["off"], ctx: m.ctx ?? 0, image: m.image, billing: billingOf(p.id),
      });
    }
  }
  return out;
}

// ── 候选与四档 ────────────────────────────────────────────────────────────────
export interface Candidate extends UsableModel {
  base: string; // 快照里的族（同一模型不同上下文版本算一族）
  effort: ThinkingLevel;
  ii: number;
  cost: number;
  est: boolean;
  creator: string;
}

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
// 档位表里官方五档不到两档（开 / 关式、只有一档）：只认它最强的那条评分，档位取它最高的非关闭档
const levelsCapable = (efforts: ThinkingLevel[]) => efforts.filter((e) => LEVELS.includes(e)).length >= 2;
const topOn = (efforts: ThinkingLevel[]): ThinkingLevel => {
  const on = efforts.filter((e) => e !== "off").sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return on[on.length - 1] ?? "off";
};
// 「Claude 模型」：快照里这一族的出品方是 Anthropic，或型号名就是 Claude 的（快照没写出品方时）
const CLAUDE_NAME_RE = /^(claude[-_.]|opus|sonnet|haiku|fable)/i;
const isClaudeFamily = (m: UsableModel, fam: RatingRow[] | null): boolean =>
  CLAUDE_NAME_RE.test(m.model) || !!fam?.some((v) => v.creator === "Anthropic");

/** 候选表 + 未评分。allowThirdParty:false = 只要 Claude 各型号（不调用非 Claude 模型）。 */
export function candidates(
  models: UsableModel[],
  R: Ratings | null = loadRatings(),
  { allowThirdParty = true }: { allowThirdParty?: boolean } = {},
): { list: Candidate[]; unrated: UsableModel[] } {
  const list: Candidate[] = [];
  const unrated: UsableModel[] = [];
  const pool = allowThirdParty ? models : models.filter((m) => isClaudeFamily(m, R ? familyFor(m.model, m.label, R) : null));
  if (!R) return { list, unrated: pool.slice() };
  for (const m of pool) {
    const fam = familyFor(m.model, m.label, R);
    if (!fam) {
      unrated.push(m);
      continue;
    }
    let rows = bestByEffort(fam).filter((v) => v.effort !== "off");
    if (!rows.length) rows = bestByEffort(fam);
    const cost = (v: RatingRow) => (m.billing === "local" ? 0 : v.cost);
    const push = (v: RatingRow, effort: ThinkingLevel) =>
      list.push({ ...m, base: v.base, effort: clampEffort(m.provider, m.model, effort), ii: v.ii, cost: cost(v), est: !!v.est, creator: v.creator || "" });
    if (levelsCapable(m.efforts)) {
      // 档位名就是厂商官方档名：只收这个型号菜单里真有的那几档（发出去即同名值）；只有一种配置的评分按菜单默认档
      for (const v of rows) {
        if (LEVELS.includes(v.effort) && m.efforts.includes(v.effort as ThinkingLevel)) push(v, v.effort as ThinkingLevel);
        else if (v.effort === "") push(v, defaultEffort(m.provider, m.model));
      }
    } else {
      push(rows.reduce((a, b) => (b.ii > a.ii ? b : a)), topOn(m.efforts));
    }
  }
  return { list, unrated };
}

export type TierKey = "top" | "hard" | "normal" | "light";
export const TIERS: { key: TierKey; use: string; frac?: number; effort: ThinkingLevel }[] = [
  { key: "top", use: "hardest judgment calls, final verification", effort: "xhigh" },
  { key: "hard", use: "design trade-offs, hard debugging", frac: MK.LADDER_FRACS.hard, effort: "high" },
  { key: "normal", use: "routine implementation, ordinary review", frac: MK.LADDER_FRACS.normal, effort: "medium" },
  { key: "light", use: "search, reading files, mechanical edits", frac: MK.LADDER_FRACS.light, effort: "low" },
];
export const AUTO_RE = /^auto:(top|hard|normal|light)$/i;

export interface Tier {
  key: TierKey;
  use: string;
  pick: Candidate;
  alt: Candidate | null;
  floor: number; // 这一档实际用的判定线
  floorDefault: number; // 默认线
  source: "chart" | "override"; // override = 档位自定义压过了判定线
  short: boolean; // 没有候选够得着判定线，取了最强的
  overrideSkipped: boolean; // 这一档有自定义，但指定的模型不在候选里，按判定线选了
}

const sameModel = (a: UsableModel, b: UsableModel) => a.provider === b.provider && a.model === b.model;

// 档位自定义 → 候选里的那一格。同一个型号挂在几家时每家各借一格，取最便宜的（同价先 Anthropic 自家，再按目录顺序）
function overrideCell(list: Candidate[], ov: PortableOverride): Candidate | null {
  const want = normKey(ov.model);
  const sameId = list.filter((c) => normKey(c.model) === want);
  const own = ov.provider ? sameId.filter((c) => c.provider === ov.provider) : [];
  const cells = own.length ? own : sameId;
  if (!cells.length) return null;
  const providers = [...new Set(cells.map((c) => c.provider))];
  let best: Candidate | null = null;
  for (const p of providers) {
    const mine = cells.filter((c) => c.provider === p);
    const model = mine[0].model;
    const raw = ov.effort.trim();
    const effort: ThinkingLevel = raw && EFFORT_ORDER.includes(raw as ThinkingLevel) ? clampEffort(p, model, raw as ThinkingLevel) : defaultEffort(p, model);
    const exact = mine.find((c) => c.effort === effort);
    const hit = exact ?? (() => {
      const near = MK.nearestEffortCell(mine, effort);
      return near ? ({ ...near, effort, est: true } as Candidate) : null;
    })();
    if (!hit) continue;
    if (!best || hit.cost < best.cost || (hit.cost === best.cost && best.provider !== "anthropic" && hit.provider === "anthropic")) best = hit;
  }
  return best;
}

/**
 * 一组候选 → 四档。strategy = 调用策略里生效的那一套（判定线 / 档位自定义）；不给 = 默认线、不自定义（改造前的阶梯）。
 * 首选：够线的候选里云端优先、成本最低（同价取更贴近线的）；够不着 → 最强的（short）。备选：够线的里换一个模型族（没有再退到同族别的型号），同价取更稳的。
 */
export function ladderOf(list: Candidate[], strategy?: PolicyStrategy | null): Tier[] {
  if (!list.length) return [];
  const def = MK.defaultFloors(list);
  return TIERS.map((t) => {
    const floorDefault = def[t.key];
    const floor = MK.floorOf(strategy?.floors, t.key, floorDefault);
    const at = MK.pickAtFloor(list, floor, { prefer: (c) => c.billing !== "local" });
    let pick = at.pick!;
    let short = at.short;
    let source: Tier["source"] = "chart";
    let overrideSkipped = false;
    const ov = strategy?.overrides?.[t.key];
    if (ov && ov.model) {
      const hit = overrideCell(list, ov);
      if (hit) {
        pick = hit;
        source = "override";
        short = false;
      } else overrideSkipped = true;
    }
    // 备选：首选那家报错 / 限流、或要交叉验证时用——先找别的模型族（K3 与 K3 256k 是同一个模型），没有再退到同族别的型号
    const ok = at.ok;
    const alt = MK.cheapestAltCell(ok.filter((c) => c.base !== pick.base)) ?? MK.cheapestAltCell(ok.filter((c) => !sameModel(c, pick)));
    return { key: t.key, use: t.use, pick, alt, floor, floorDefault, source, short, overrideSkipped };
  });
}

export interface Ladder {
  generated: string;
  tiers: Tier[];
  others: Candidate[];
  unrated: UsableModel[];
  usable: UsableModel[];
  candidates: Candidate[];
}
export function buildLadder(
  models: UsableModel[] = usableModels(),
  R: Ratings | null = loadRatings(),
  { strategy, allowThirdParty = true }: { strategy?: PolicyStrategy | null; allowThirdParty?: boolean } = {},
): Ladder | null {
  if (!R) return null;
  const { list, unrated } = candidates(models, R, { allowThirdParty });
  const tiers = ladderOf(list, strategy);
  if (!tiers.length) return null;
  const used = tiers.flatMap((t) => [t.pick, t.alt].filter((c): c is Candidate => !!c));
  const others: Candidate[] = [];
  for (const c of list) if (!used.some((u) => sameModel(u, c)) && !others.some((o) => sameModel(o, c))) others.push(c);
  return { generated: R.generated, tiers, others, unrated, usable: models, candidates: list };
}

// ── 系统提示的一段 ────────────────────────────────────────────────────────────
// 开关关着且没写调度偏好 → 不出这一段（零开销）。
const MAX_NAMES = 10;
const fmtCost = (c: number) => (c >= 10 ? c.toFixed(1) : c >= 0.1 ? c.toFixed(2) : c > 0 ? String(+c.toPrecision(2)) : "0");
const fmtCtx = (n: number) => (n >= 1e6 ? `${+(n / 1048576).toFixed(1)}M` : `${Math.round(n / 1024)}K`);

// 写进调用的 id：同一个型号 id 在能用的服务里不止一家时写成「服务:型号」
function idOf(m: UsableModel, usable: UsableModel[]): string {
  return usable.filter((u) => u.model === m.model).length > 1 ? `${m.provider}:${m.model}` : m.model;
}
function named(m: UsableModel, usable: UsableModel[]): string {
  const id = idOf(m, usable);
  return normKey(id) === normKey(m.label) ? id : `${m.label} (${id})`;
}
function cell(c: Candidate, usable: UsableModel[], withId: boolean): string {
  const notes = [`${Math.round(c.ii)}${c.est ? "?" : ""}`, c.billing === "local" ? "free" : `¥${fmtCost(c.cost)}`];
  if (c.billing === "local") notes.push("local GPU, one at a time");
  if (c.billing === "plan") notes.push("plan quota");
  if (c.ctx && c.ctx < 400_000) notes.push(`ctx ${fmtCtx(c.ctx)}`);
  if (!c.image) notes.push("no images");
  const who = withId ? named(c, usable) : c.label;
  return `${who}${c.effort !== "off" ? ` · ${c.effort}` : ""} [${notes.join(", ")}]`;
}
function nameList(ms: UsableModel[], usable: UsableModel[]): string {
  const shown = ms.slice(0, MAX_NAMES).map((m) => named(m, usable)).join(", ");
  return ms.length > MAX_NAMES ? `${shown}, +${ms.length - MAX_NAMES} more` : shown;
}
// 一档后面的来源标记：档位自定义压过判定线的标出来；判定线谁都够不着、取了最强的也标出来
const tierMark = (t: Tier) => (t.source === "override" ? " (user's pick)" : t.short ? " (nothing reaches this tier's bar; strongest)" : "");
const PREF_HEAD = "User's dispatch preference (wins where it conflicts with the above):";

/** 这个会话有哪几样派子 agent 的工具（建会话时按工具表定）。 */
export interface DispatchTools {
  agent: boolean;
  workflow: boolean;
  session: boolean;
}
const ALL_TOOLS: DispatchTools = { agent: true, workflow: true, session: false };

export function dispatchSection(
  opts: { ladder?: boolean; text?: string; models?: UsableModel[]; tools?: DispatchTools; policy?: DimPolicy | null } = {},
): string {
  const policy = opts.policy !== undefined ? opts.policy : currentDispatchPolicy();
  if (policy) return governedSection(policy, opts.tools ?? ALL_TOOLS, opts.models);
  // 改造前的写法只讲 Agent 工具与 Workflow：两样都没有（只有 StartSession）就不出
  if (opts.tools && !opts.tools.agent && !opts.tools.workflow) return "";
  const on = opts.ladder ?? prefValue<boolean>("subagentLadder");
  const text = String(opts.text ?? prefValue<string>("subagentDispatch")).trim();
  const lines: string[] = [];
  if (on) {
    void refreshLocalReady(); // 本机引擎的就绪状态给下一个会话用（这次按缓存）
    const usable = opts.models ?? usableModels();
    const L = buildLadder(usable);
    const head = "For each sub-agent (Agent tool, Workflow agent()) pick the model and effort by how hard ITS task is instead of inheriting this session's — the user explicitly asks for this.";
    if (L) {
      lines.push(head + ` Ladder from the user's price/performance data (${L.generated}; [intelligence score, ¥ per task at what this instance pays]):`);
      lines.push(...ladderRows(L, usable, false));
      lines.push('Write model:"auto:<tier>" and omit effort: it resolves to that tier\'s pick and effort at dispatch. For an alt, or a model the user names, write the id in parentheses and set effort as listed.');
      lines.push(...tailRows(L, usable));
    } else {
      lines.push(head + ' Effort: light (search, reading, mechanical edits) low; normal (routine implementation, review) medium; hard (design trade-offs, hard debugging) high; top (hardest calls, final verification) xhigh — model:"auto:<tier>" sets it for you.');
      const others = usable.length > 1 ? usable : [];
      if (others.length) lines.push(`Usable models (no price/performance data; only when named): ${nameList(others, usable)}`);
    }
  }
  if (text) lines.push(PREF_HEAD, text);
  return lines.length ? `## Sub-agent models\n${lines.join("\n")}` : "";
}

function ladderRows(L: Ladder, usable: UsableModel[], marks: boolean): string[] {
  return L.tiers.map(
    (t) => `- ${t.key} — ${t.use}: auto:${t.key} = ${cell(t.pick, usable, false)}${marks ? tierMark(t) : ""}${t.alt ? `; alt ${cell(t.alt, usable, true)}` : ""}`,
  );
}
function tailRows(L: Ladder, usable: UsableModel[]): string[] {
  const out: string[] = [];
  if (L.others.length) out.push(`Other usable models (outclassed here; only when named): ${nameList(L.others, usable)}`);
  if (L.unrated.length) out.push(`Unrated (no data; only when named): ${nameList(L.unrated, usable)}`);
  out.push("Ids are for tool calls only; to the user, call models by their display name.");
  return out;
}

// 调用策略管着的一段：按总开关与生效范围裁剪（只讲这个会话真有、范围也勾了的那几条路），备注压在最后
function governedSection(policy: DimPolicy, tools: DispatchTools, models?: UsableModel[]): string {
  if (!policy.enabled) return "";
  const sc = {
    agent: tools.agent && policy.scope.subagent,
    workflow: tools.workflow && policy.scope.workflow,
    session: tools.session && policy.scope.session,
  };
  if (!sc.agent && !sc.workflow && !sc.session) return "";
  void refreshLocalReady();
  const usable = models ?? usableModels();
  const L = buildLadder(usable, loadRatings(), { strategy: policy.strategy, allowThirdParty: policy.allowThirdParty });
  const via = [sc.agent && "Agent tool", sc.workflow && "Workflow agent()"].filter(Boolean).join(", ");
  // 这个会话有、但不归策略管的那条路：明说照默认（不写 model / effort，沿用本会话）
  const native = [tools.agent && !sc.agent && "Agent tool", tools.workflow && !sc.workflow && "Workflow agent()"].filter(Boolean).join(" and ");
  const lines: string[] = [];
  const head = via
    ? `For each sub-agent (${via}) pick the model and effort by how hard ITS task is instead of inheriting this session's — the user explicitly asks for this.`
    : "";
  if (L) {
    lines.push(`${head ? head + " " : ""}Ladder from the user's dispatch policy (${L.generated} data; [intelligence score, ¥ per task at what this instance pays]):`);
    lines.push(...ladderRows(L, usable, true));
    if (via) lines.push('Write model:"auto:<tier>" and omit effort: it resolves to that tier\'s pick and effort at dispatch. For an alt, or a model the user names, write the id in parentheses and set effort as listed.');
  } else if (head) {
    lines.push(head + ' Effort: light (search, reading, mechanical edits) low; normal (routine implementation, review) medium; hard (design trade-offs, hard debugging) high; top (hardest calls, final verification) xhigh — model:"auto:<tier>" sets it for you.');
  }
  if (native) lines.push(`${native} sub-agents are outside the policy: leave their model and effort unset (they inherit this session's).`);
  if (sc.session) lines.push('StartSession\'s model may be "auto:<tier>" (top / hard / normal / light); it resolves to that tier\'s pick. Omit it to inherit this session\'s.');
  if (L && via) lines.push(...tailRows(L, usable));
  const note = String(policy.strategy?.note ?? "").trim();
  if (note) lines.push(PREF_HEAD, note);
  return lines.length ? `## Sub-agent models\n${lines.join("\n")}` : "";
}

// ── 设置页的预览（bridge 设置 › dimensio › 子 agent 调用策略）────────────────────────
// 型号写成「厂商:型号」（和策略里档位自定义的写法一样，见 bridge 的 dispatch-policy.mjs）；label 是显示名，provider 是厂商显示名。
const previewId = (c: UsableModel) => `${c.provider}:${c.model}`;
const basisOf = (c: Candidate): Billing => c.billing;
function pickView(c: Candidate) {
  return {
    model: previewId(c), label: c.label, effort: c.effort, ii: c.ii, cost: c.cost, basis: basisOf(c), provider: c.providerName,
    ...(c.est ? { est: true } : {}),
  };
}
/** 按给的策略算四档落点与候选点（不给 = 默认线、不自定义）→ { tiers, candidates, unrated }；没有快照 / 一个评上分的都没有 → tiers 为空。 */
export async function ladderPreview(
  { strategy, allowThirdParty = true }: { strategy?: PolicyStrategy | null; allowThirdParty?: boolean } = {},
  models?: UsableModel[],
) {
  if (!models) await refreshLocalReady();
  const usable = models ?? usableModels();
  const R = loadRatings();
  const L = buildLadder(usable, R, { strategy, allowThirdParty });
  const { list, unrated } = L ? { list: L.candidates, unrated: L.unrated } : candidates(usable, R, { allowThirdParty });
  return {
    tiers: L
      ? L.tiers.map((t) => ({
          key: t.key, use: t.use, floor: t.floor, floorDefault: t.floorDefault, source: t.source, short: t.short,
          overrideSkipped: t.overrideSkipped, pick: pickView(t.pick),
        }))
      : [],
    candidates: list.map((c) => ({ ...pickView(c), creator: c.creator })),
    unrated: unrated.map((m) => ({ model: previewId(m), label: m.label, provider: m.providerName })),
    generated: R?.generated ?? "",
  };
}

// ── 派发：auto:<档> 与「服务:型号」 ─────────────────────────────────────────────
export interface Routed {
  provider?: ProviderId;
  model?: string;
  thinking?: ThinkingLevel;
  auto?: TierKey;
}
/** 这个子 agent / 会话是从哪条路派的：agent = Agent 工具，workflow = Workflow 的 agent()，session = StartSession。 */
export type DispatchVia = "agent" | "workflow" | "session";

/**
 * 子 agent 请求里的 model 若是 auto:<档> 或「服务:型号」，换成具体的 provider / 型号（auto 连档位一起）。
 * 其余原样（回 {}）。parent = 主会话自己的 provider / 型号（没有可用阶梯时 auto 落到它）。
 * via = 从哪条路派的（调用策略按它看生效范围）；StartSession 在策略管不着时不解析 auto（回 {}，沿用本会话）。
 */
export async function routeSubAgentModel(
  model: string | undefined,
  parent: { provider: ProviderId; model: string },
  models?: UsableModel[], // 测试用：不给 = 此刻真能用的
  { via = "agent" }: { via?: DispatchVia } = {},
): Promise<Routed | { error: string }> {
  const raw = model?.trim();
  if (!raw) return {};
  const auto = AUTO_RE.exec(raw);
  if (auto) {
    const key = auto[1].toLowerCase() as TierKey;
    const tierDef = TIERS.find((t) => t.key === key)!;
    const fallback: Routed = { provider: parent.provider, model: parent.model, thinking: clampEffort(parent.provider, parent.model, tierDef.effort), auto: key };
    await refreshDispatchPolicy();
    const policy = currentDispatchPolicy();
    const governed = !!policy && policy.enabled && (via === "workflow" ? policy.scope.workflow : via === "session" ? policy.scope.session : policy.scope.subagent);
    if (governed) {
      if (!models) await refreshLocalReady();
      const L = buildLadder(models ?? usableModels(), loadRatings(), { strategy: policy!.strategy, allowThirdParty: policy!.allowThirdParty });
      const tier = L?.tiers.find((t) => t.key === key);
      return tier ? { provider: tier.pick.provider, model: tier.pick.model, thinking: tier.pick.effort, auto: key } : fallback;
    }
    // 策略管不着这条路（关着 / 没勾 / 取不到）：StartSession 不解析 auto；子 agent 按改造前的默认解析
    if (via === "session") return {};
    if (prefValue<boolean>("subagentLadder")) {
      if (!models) await refreshLocalReady();
      const L = buildLadder(models ?? usableModels());
      const tier = L?.tiers.find((t) => t.key === key);
      if (tier) return { provider: tier.pick.provider, model: tier.pick.model, thinking: tier.pick.effort, auto: key };
    }
    return fallback;
  }
  // 「服务:型号」：冒号前是一个存在的厂商 id 才拆（型号 id 自己也可能带冒号，如 llama3:8b）
  const at = raw.indexOf(":");
  if (at > 0) {
    const pid = raw.slice(0, at);
    const spec = allProviders().find((p) => p.id === pid);
    if (spec) {
      const m = raw.slice(at + 1);
      // 旧 id（如 strata-orca）按目录别名认，派发时落到现行 id
      if (!modelSpec(spec.id, m)) return { error: `provider "${pid}" has no model "${m}"` };
      return { provider: spec.id, model: canonicalModelId(spec.id, m) };
    }
  }
  return {};
}
