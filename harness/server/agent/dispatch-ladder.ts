// 子 agent 选型阶梯：把「这个 dimensio 实例此刻真能用的模型 × 思考档」按性价比数据排成四档首选 + 备选。
//
// 数据：bridge 发版时压出来的模型性价比快照（config/model-ratings.json，经 core-link 取——源码直跑与离线包两种形态都成立）。
// 每条 = 一个「模型 × 档位」：智力指数 ii、官方 API 每任务成本（元）。快照缺了 / 坏了 → 没有阶梯，只给按难度定档的一句话。
//
// 三处用同一份候选表，结论一致：
//   · 系统提示的「Sub-agent models」一段（dispatchSection）：每档首选 + 一个备选，外加「其余可用」「未评分」各一行；
//   · 虚拟模型名 auto:top / auto:hard / auto:normal / auto:light（routeSubAgentModel）：Agent 工具与工作流 agent() 写它，
//     派发时换成这一档首选的 provider + 型号 + 档位（档位压过调用方自己写的 effort，再过一遍 clampEffort 的思考档契约）；
//   · 「服务:型号」写法（同一个型号 id 挂在两家服务下时用来点名其中一家），也在派发时拆开。
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

// ── 快照 ────────────────────────────────────────────────────────────────────
// 归一 / 别名 / 同档取舍 / 旧分剔除都在共用的 src/model-knowledge/ratings.mjs（bridge 的 Claude 子 agent 阶梯用同一份），经 MK 取。
let cache: Ratings | null | false | undefined;
export function loadRatings(): Ratings | null {
  if (cache === undefined) {
    try {
      const j = JSON.parse(readFileSync(fileURLToPath(coreUrl("config/model-ratings.json")), "utf8"));
      cache = (j && Array.isArray(j.models) && j.models.length && MK.loadRatings(j)) || false;
    } catch {
      cache = false;
    }
  }
  return cache || null;
}
// 测试用：给一份快照（null = 当作没有快照；undefined = 下次重读盘）
export function setRatingsForTests(j: RatingsSnapshot | null | undefined): void {
  cache = j === undefined ? undefined : j === null ? false : MK.loadRatings(j) || false;
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
}

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
// 档位表里官方五档不到两档（开 / 关式、只有一档）：只认它最强的那条评分，档位取它最高的非关闭档
const levelsCapable = (efforts: ThinkingLevel[]) => efforts.filter((e) => LEVELS.includes(e)).length >= 2;
const topOn = (efforts: ThinkingLevel[]): ThinkingLevel => {
  const on = efforts.filter((e) => e !== "off").sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return on[on.length - 1] ?? "off";
};

export function candidates(models: UsableModel[], R: Ratings | null = loadRatings()): { list: Candidate[]; unrated: UsableModel[] } {
  const list: Candidate[] = [];
  const unrated: UsableModel[] = [];
  if (!R) return { list, unrated: models.slice() };
  for (const m of models) {
    const fam = familyFor(m.model, m.label, R);
    if (!fam) {
      unrated.push(m);
      continue;
    }
    let rows = bestByEffort(fam).filter((v) => v.effort !== "off");
    if (!rows.length) rows = bestByEffort(fam);
    const cost = (v: RatingRow) => (m.billing === "local" ? 0 : v.cost);
    const push = (v: RatingRow, effort: ThinkingLevel) =>
      list.push({ ...m, base: v.base, effort: clampEffort(m.provider, m.model, effort), ii: v.ii, cost: cost(v), est: !!v.est });
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
  { key: "hard", use: "design trade-offs, hard debugging", frac: 0.88, effort: "high" },
  { key: "normal", use: "routine implementation, ordinary review", frac: 0.6, effort: "medium" },
  { key: "light", use: "search, reading files, mechanical edits", frac: 0.4, effort: "low" },
];
const TOP_SLACK = 1.5;
export const AUTO_RE = /^auto:(top|hard|normal|light)$/i;

export interface Tier {
  key: TierKey;
  use: string;
  pick: Candidate;
  alt: Candidate | null;
}

const sameModel = (a: UsableModel, b: UsableModel) => a.provider === b.provider && a.model === b.model;
const cheapest = (xs: Candidate[]) =>
  xs.reduce<Candidate | null>((a, b) => (!a || b.cost < a.cost || (b.cost === a.cost && b.ii > a.ii) ? b : a), null);

export function ladderOf(list: Candidate[]): Tier[] {
  if (!list.length) return [];
  const top = Math.max(...list.map((c) => c.ii));
  return TIERS.map((t) => {
    const floor = t.frac ? top * t.frac : top - TOP_SLACK;
    const ok = list.filter((c) => c.ii >= floor);
    const remote = ok.filter((c) => c.billing !== "local");
    const pick = cheapest(remote.length ? remote : ok)!;
    // 备选：首选那家报错 / 限流、或要交叉验证时用——先找别的模型族（K3 与 K3 256k 是同一个模型），没有再退到同族别的型号
    const alt = cheapest(ok.filter((c) => c.base !== pick.base)) ?? cheapest(ok.filter((c) => !sameModel(c, pick)));
    return { key: t.key, use: t.use, pick, alt };
  });
}

export interface Ladder {
  generated: string;
  tiers: Tier[];
  others: Candidate[];
  unrated: UsableModel[];
  usable: UsableModel[];
}
export function buildLadder(models: UsableModel[] = usableModels(), R: Ratings | null = loadRatings()): Ladder | null {
  if (!R) return null;
  const { list, unrated } = candidates(models, R);
  const tiers = ladderOf(list);
  if (!tiers.length) return null;
  const used = tiers.flatMap((t) => [t.pick, t.alt].filter((c): c is Candidate => !!c));
  const others: Candidate[] = [];
  for (const c of list) if (!used.some((u) => sameModel(u, c)) && !others.some((o) => sameModel(o, c))) others.push(c);
  return { generated: R.generated, tiers, others, unrated, usable: models };
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

export function dispatchSection(opts: { ladder?: boolean; text?: string; models?: UsableModel[] } = {}): string {
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
      for (const t of L.tiers) {
        lines.push(`- ${t.key} — ${t.use}: auto:${t.key} = ${cell(t.pick, usable, false)}${t.alt ? `; alt ${cell(t.alt, usable, true)}` : ""}`);
      }
      lines.push('Write model:"auto:<tier>" and omit effort: it resolves to that tier\'s pick and effort at dispatch. For an alt, or a model the user names, write the id in parentheses and set effort as listed.');
      if (L.others.length) lines.push(`Other usable models (outclassed here; only when named): ${nameList(L.others, usable)}`);
      if (L.unrated.length) lines.push(`Unrated (no data; only when named): ${nameList(L.unrated, usable)}`);
      lines.push("Ids are for tool calls only; to the user, call models by their display name.");
    } else {
      lines.push(head + ' Effort: light (search, reading, mechanical edits) low; normal (routine implementation, review) medium; hard (design trade-offs, hard debugging) high; top (hardest calls, final verification) xhigh — model:"auto:<tier>" sets it for you.');
      const others = usable.length > 1 ? usable : [];
      if (others.length) lines.push(`Usable models (no price/performance data; only when named): ${nameList(others, usable)}`);
    }
  }
  if (text) lines.push("User's dispatch preference (wins where it conflicts with the above):", text);
  return lines.length ? `## Sub-agent models\n${lines.join("\n")}` : "";
}

// ── 派发：auto:<档> 与「服务:型号」 ─────────────────────────────────────────────
export interface Routed {
  provider?: ProviderId;
  model?: string;
  thinking?: ThinkingLevel;
  auto?: TierKey;
}

/**
 * 子 agent 请求里的 model 若是 auto:<档> 或「服务:型号」，换成具体的 provider / 型号（auto 连档位一起）。
 * 其余原样（回 {}）。parent = 主会话自己的 provider / 型号（没有可用阶梯时 auto 落到它）。
 */
export async function routeSubAgentModel(
  model: string | undefined,
  parent: { provider: ProviderId; model: string },
  models?: UsableModel[], // 测试用：不给 = 此刻真能用的
): Promise<Routed | { error: string }> {
  const raw = model?.trim();
  if (!raw) return {};
  const auto = AUTO_RE.exec(raw);
  if (auto) {
    const key = auto[1].toLowerCase() as TierKey;
    const tierDef = TIERS.find((t) => t.key === key)!;
    if (prefValue<boolean>("subagentLadder")) {
      if (!models) await refreshLocalReady();
      const L = buildLadder(models ?? usableModels());
      const tier = L?.tiers.find((t) => t.key === key);
      if (tier) return { provider: tier.pick.provider, model: tier.pick.model, thinking: tier.pick.effort, auto: key };
    }
    return { provider: parent.provider, model: parent.model, thinking: clampEffort(parent.provider, parent.model, tierDef.effort), auto: key };
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
