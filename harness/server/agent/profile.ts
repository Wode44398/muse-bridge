// 模型档案（P0 骨架）：以后按模型家族调系统提示词、工具说明、请求参数与 loop 行为，都改这里的数据，不在各处散写 if/else。
//
// 档案 = 家族识别 + 智力分档 + 五块可调项（prompt / tools / sampling / providerExtras / loop）+ 旁路请求（side）。
// P0 的约定：所有取值等于接入前的现状——家族覆盖表 FAMILY_OVERRIDES 为空，系统提示词、工具 schema、请求体、loop 行为逐字节
// 不变（model-profile-golden.test.ts 对着接入前生成的金样锁死；model-profile.test.ts 断言 loop 默认值等于原模块常量）。
// 智力分档本期只算不用：哪里都不读 tier。
//
// 解析时机：会话建立 / 换型号重建（session.ts buildState，两条路都经它）、子 agent 与 Workflow 节点（subagent.ts，按路由后的
// 实际目标型号）。解析一次放进 AgentState.profile，loop 各处现读 state.profile——同一个会话中途不变，换型号换的是整份 state。
//
// 默认值的来源仍是各模块的常量（loop.ts / loop-guard.ts / repetition.ts / subagent.ts / context.ts），这里只在函数里读
// 它们（不在模块顶层读）：loop.ts → state.ts → profile.ts → loop.ts 是个环，顶层取值会撞上未初始化的绑定。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { coreModule, coreUrl } from "../core-link.ts";
import { MK } from "../model-knowledge.ts";
import { CATALOG } from "../catalog.ts";
import { getCustomModel, isCustomProviderId } from "../custom-providers.ts";
import type { ThinkingLevel } from "./turn.ts";
import {
  DENIALS_BEFORE_STOP,
  EMPTY_RESPONSE_RETRIES,
  MAX_ANSWER_NUDGES,
  MAX_CUTOFF_NUDGES,
  MAX_LENGTH_CONTINUES,
  MAX_PARALLEL_TOOLS,
  RETRY_ATTEMPTS,
} from "./loop.ts";
import { GUARD_DEFAULTS, type GuardLimits } from "./loop-guard.ts";
import { REPETITION_DEFAULTS, type RepetitionLimits } from "./repetition.ts";
import { SUBMIT_ATTEMPTS, SUBMIT_NUDGES } from "./subagent.ts";
import { SUMMARY_BUDGET } from "./context.ts";
import { DEFERRED_FAMILIES } from "./deferred-tools.ts";

// ── 形状 ──────────────────────────────────────────────────────────────────────
export const MODEL_FAMILIES = [
  "claude", "gpt", "gemini", "deepseek", "qwen", "glm", "kimi", "mimo", "minimax", "step", "hunyuan", "grok", "muse", "unknown",
] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
// 家族是怎么认出来的：型号名（含自定义服务的显示名）/ model-knowledge 表的思考模板键 / 内置厂商 id / 没认出来
export type FamilySource = "name" | "label" | "think" | "provider" | "none";

export interface ProfileTier {
  ii: number | null; // AA 智力指数；source=none 时为 null
  subs: Record<string, number>; // 分项（键名见 ratings.mjs SUB_KEYS），没有的键省略
  derived: boolean; // 量化 / 本机版本：分数取自官方全精度条目，不是本机实测
  source: "aa" | "median-fallback" | "none";
  conservative: boolean; // 认不出、按中位推的：用的时候往保守里靠
  basis?: "family" | "global"; // median-fallback 时：同族中位 / 全库中位
  slug?: string; // 命中的快照条目
  version?: string; // 指数版本（如 v5.0）
}

export interface LoopProfile {
  maxAnswerNudges: number; // 只思考没答复的追问次数（loop.ts MAX_ANSWER_NUDGES）
  maxCutoffNudges: number; // 断在半句的追问次数（MAX_CUTOFF_NUDGES）
  lengthContinues: number; // 被输出上限截断后自动续写次数（MAX_LENGTH_CONTINUES）
  emptyResponseRetries: number; // 流什么都没带回来时重发几次（EMPTY_RESPONSE_RETRIES）
  retryAttempts: number; // 一次模型调用的总尝试次数（RETRY_ATTEMPTS）
  maxParallelTools: number; // 一批并行只读调用的上限（MAX_PARALLEL_TOOLS）
  denialsBeforeStop: number; // 连续几次没被批准就收尾（DENIALS_BEFORE_STOP）
  guard: GuardLimits; // 重复 / 失败 / 周期熔断阈值（loop-guard.ts）
  repetition: RepetitionLimits; // 文本复读检测阈值（repetition.ts）
  submitAttempts: number; // 子 agent SubmitResult 校验失败的总机会数（subagent.ts SUBMIT_ATTEMPTS）
  submitNudges: number; // 子 agent 没交 SubmitResult 就收尾时的追问次数（SUBMIT_NUDGES）
  noopBashResample: boolean; // 空操作 Bash（echo 之类）重采样：P0 只占位，loop 不读
  stopWhenAttended: boolean; // 熔断在有人在场时也真停（现状：只在无人值守时停）
}

export interface ModelProfile {
  family: ModelFamily;
  familySource: FamilySource;
  tier: ProfileTier;
  // 提示词变体与补丁：P0 只有 default、补丁为空（prompt.ts / subagent.ts 收到档案但不改任何输出）
  prompt: { variant: "default"; patches: string[] };
  tools: {
    editFormat: "str_replace"; // Edit 的编辑格式（现状 old_string/new_string 精确替换）
    deferredFamilies: readonly (readonly string[])[]; // 延迟加载的工具族（deferred-tools.ts DEFERRED_FAMILIES）
    subset: string[] | null; // 只下发这些工具；null = 不裁
    pathAliases: Record<string, string>; // 参数名别名（如 file_path → path）；P0 为空、不读
  };
  sampling: Record<string, number>; // 采样参数；空 = 不发任何采样参数（现状）。P0 不下发
  providerExtras: Record<string, unknown>; // 原样并进请求体（Turn.hints.providerExtras，三个适配器都会合并）；空 = 不挂
  loop: LoopProfile;
  side: { summary: { thinking: ThinkingLevel; maxOutputTokens: number } }; // 旁路请求（压缩摘要）
}

// 家族覆盖：阶段 2/3 改行为就往这里填（深合并到默认档案上；数组整体替换）。P0 为空 = 全部等于现状。
type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type ProfilePatch = DeepPartial<Omit<ModelProfile, "family" | "familySource" | "tier">>;
export const FAMILY_OVERRIDES: Partial<Record<ModelFamily, ProfilePatch>> = {};

// ── 默认档案（= 现状）──────────────────────────────────────────────────────────
export function defaultLoopProfile(): LoopProfile {
  return {
    maxAnswerNudges: MAX_ANSWER_NUDGES,
    maxCutoffNudges: MAX_CUTOFF_NUDGES,
    lengthContinues: MAX_LENGTH_CONTINUES,
    emptyResponseRetries: EMPTY_RESPONSE_RETRIES,
    retryAttempts: RETRY_ATTEMPTS,
    maxParallelTools: MAX_PARALLEL_TOOLS,
    denialsBeforeStop: DENIALS_BEFORE_STOP,
    guard: structuredClone(GUARD_DEFAULTS),
    repetition: { ...REPETITION_DEFAULTS },
    submitAttempts: SUBMIT_ATTEMPTS,
    submitNudges: SUBMIT_NUDGES,
    noopBashResample: false,
    stopWhenAttended: false,
  };
}

const NO_TIER: ProfileTier = { ii: null, subs: {}, derived: false, source: "none", conservative: false };

/** 现状档案（家族未知、不评分）：AgentState 没拿到档案时用它，行为与接入前一致。 */
export function defaultProfile(): ModelProfile {
  return {
    family: "unknown",
    familySource: "none",
    tier: { ...NO_TIER, subs: {} },
    prompt: { variant: "default", patches: [] },
    tools: { editFormat: "str_replace", deferredFamilies: DEFERRED_FAMILIES, subset: null, pathAliases: {} },
    sampling: {},
    providerExtras: {},
    loop: defaultLoopProfile(),
    side: { summary: { ...SUMMARY_BUDGET } },
  };
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cur = out[k];
    // 覆盖表里的数组 / 对象整份克隆再放进档案：档案是每次新建的，调用方改它不该改到覆盖表本身
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur) ? deepMerge(cur, v) : v && typeof v === "object" ? structuredClone(v) : v;
  }
  return out as T;
}

// ── 家族识别 ──────────────────────────────────────────────────────────────────
// 内置厂商 id → 家族（注意 DeepSeek 的厂商 id 叫 openai；本机 local 跑什么都有可能，不按 id 认）
const PROVIDER_FAMILY: Record<string, ModelFamily> = {
  anthropic: "claude",
  openai: "deepseek",
  qwen: "qwen",
  zhipu: "glm",
  kimi: "kimi",
  mimo: "mimo",
  gemini: "gemini",
};

// 型号名（归一后）→ 家族，先具体后笼统。strata-* 是本机 Strata 引擎跑的 Qwen3.8 Flash Next 各量化版；hy3 / hunyuan 是腾讯混元；
// k3 / k2.x / kimi-* 是 Kimi；o1/o3/o4… 是 OpenAI 推理型号（orca 之类不会误中：o 后面要紧跟数字）。
const NAME_RULES: [ModelFamily, RegExp][] = [
  ["qwen", /^(?:qwen|qwq|strata)(?:\d|[-.]|$)/],
  ["claude", /^(?:claude|opus|sonnet|haiku|fable)(?:-|$)/],
  ["deepseek", /^deepseek/],
  ["glm", /^(?:glm|chatglm|zhipu|codegeex)/],
  ["kimi", /^(?:kimi|moonshot|k[2-9](?:[.-]|$))/],
  ["mimo", /^mimo/],
  ["minimax", /^(?:minimax|abab)/],
  ["step", /^step(?:\d|[-.]|$)/],
  ["hunyuan", /^(?:hunyuan|hy\d)/],
  ["grok", /^grok/],
  ["muse", /^muse(?:-|$)/],
  ["gemini", /^gemini/], // Gemma 是开放权重、多经 OpenAI 兼容端点跑，不套 Gemini 的覆盖
  ["gpt", /^(?:gpt|chatgpt|codex|o\d)(?:\d|[-.]|$)/],
];

// model-knowledge 表的思考模板键 → 家族（toggle 这类通用模板不认）
const THINK_FAMILY: Record<string, ModelFamily> = {
  "claude-adaptive": "claude",
  "claude-adaptive-46": "claude",
  "claude-budget": "claude",
  mimo: "mimo",
  deepseek: "deepseek",
  qwen38: "qwen",
  qwen37: "qwen",
  "qwen-toggle": "qwen",
  glm53: "glm",
  glm52: "glm",
  kimi: "kimi",
  gemini3: "gemini",
  gemini35f: "gemini",
  gemini25: "gemini",
  gemini25pro: "gemini",
  openai: "gpt",
};

const PROVIDER_PREFIX_RE = /^(?:custom:[^:]+:|custom-[0-9a-f]{8}:|(?:anthropic|openai|qwen|zhipu|kimi|mimo|gemini|local):)/;
// Bedrock 写法：跨区推理前缀（us. / eu. / apac. / global. …）+ 厂商名（anthropic. / openai. / google.），如 us.anthropic.claude-…-v1:0。
// 其它厂商名（deepseek. / qwen. / moonshot. / minimax.）本身就能按名认出，不去掉
const BEDROCK_PREFIX_RE = /^(?:(?:us|eu|apac|global|jp|au|ca|us-gov)\.)?(?:(?:anthropic|openai|google)\.)?/;

/** 型号名归一：小写、去 [1m]、去「custom:<服务>:」与「厂商:」前缀、去 vendor/ 前缀（取最后一段）、去 Bedrock 的区域.厂商. 前缀、去 :tag 后缀。 */
export function familyKey(id: unknown): string {
  let s = String(id ?? "").trim().toLowerCase().replace(/\[1m\]$/, "");
  s = s.replace(PROVIDER_PREFIX_RE, "");
  s = (s.split("/").pop() ?? "").replace(BEDROCK_PREFIX_RE, "");
  return s.replace(/:[a-z0-9.-]+$/, "").replace(/\s+/g, "-");
}

const byName = (key: string): ModelFamily | undefined => (key ? NAME_RULES.find(([, re]) => re.test(key))?.[0] : undefined);

export function resolveFamily(
  provider: string,
  model: string,
  custom?: { label?: string },
): { family: ModelFamily; familySource: FamilySource } {
  const key = familyKey(model);
  const named = byName(key);
  if (named) return { family: named, familySource: "name" };
  const label = custom?.label ? familyKey(custom.label) : "";
  const labeled = label ? byName(label) : undefined;
  if (labeled) return { family: labeled, familySource: "label" };
  let think: string | undefined;
  try {
    think = MK.tableEntry(key)?.think;
  } catch {
    think = undefined;
  }
  const thought = think ? THINK_FAMILY[think] : undefined;
  if (thought) return { family: thought, familySource: "think" };
  const fromProvider = PROVIDER_FAMILY[provider];
  if (fromProvider) return { family: fromProvider, familySource: "provider" };
  return { family: "unknown", familySource: "none" };
}

// ── 智力分档（src/model-knowledge/ratings.mjs，ratings 线实现；缺了就 source:"none"，不报错）────────────────
// 只声明这里用到的那部分接口（ratings.d.mts 是完整的；这边不直接 import 它的类型，模块缺席时类型检查也照过）。
interface RatingHitLike {
  slug?: string;
  ii: number;
  subs?: Record<string, number>;
  derived?: boolean;
  version?: string;
}
interface StatsLike {
  median?: number;
  count?: number;
}
interface SummaryLike extends StatsLike {
  version?: string;
  allEfforts?: StatsLike;
  bestPerFamily?: StatsLike;
}
export interface RatingsApi {
  loadRatings(snapshotJson: unknown): unknown;
  lookupRating(index: unknown, modelId: unknown, opts?: { provider?: string; effort?: string }): RatingHitLike | null;
  ratingsSummary(index: unknown): SummaryLike;
}
interface RatingsHandle {
  api: RatingsApi;
  index: unknown;
  familyMedian: Map<ModelFamily, number | null>;
}

let ratingsCache: RatingsHandle | null | undefined;
function ratings(): RatingsHandle | null {
  if (ratingsCache === undefined) {
    ratingsCache = null;
    try {
      const api = coreModule<RatingsApi>("model-knowledge/ratings.mjs");
      const snapshot = JSON.parse(readFileSync(fileURLToPath(coreUrl("config/model-ratings.json")), "utf8"));
      const index = typeof api?.lookupRating === "function" ? api.loadRatings(snapshot) : null;
      if (index) ratingsCache = { api, index, familyMedian: new Map() };
    } catch {
      ratingsCache = null; // 模块或快照缺了 / 坏了：不评分
    }
  }
  return ratingsCache;
}

/** 测试用：给一份评分接口与快照（null = 当作没有；undefined = 下次重新加载）。 */
export function setRatingsForTests(api: RatingsApi | null | undefined, snapshot?: unknown): void {
  if (api === undefined) ratingsCache = undefined;
  else if (api === null) ratingsCache = null;
  else {
    const index = api.loadRatings(snapshot);
    ratingsCache = index ? { api, index, familyMedian: new Map() } : null;
  }
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const finitePos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

// 按型号 id 查；查不到而有显示名（自定义服务的 id 常是自起的名字）再拿显示名当型号名查一次。opts 只给约定内的 provider / effort
function lookup(h: RatingsHandle, model: string, label: string | undefined, opts: { provider: string; effort?: string }): RatingHitLike | null {
  const hit = h.api.lookupRating(h.index, model, opts);
  if (hit || !label || label === model) return hit;
  return h.api.lookupRating(h.index, label, opts);
}

// 同族中位：目录里同一家族、有评分的内置型号各取最强口径，取中位
function familyMedian(h: RatingsHandle, family: ModelFamily): number | null {
  if (family === "unknown") return null;
  if (h.familyMedian.has(family)) return h.familyMedian.get(family)!;
  const iis: number[] = [];
  for (const p of CATALOG) {
    for (const m of p.models) {
      if (resolveFamily(p.id, m.id).family !== family) continue;
      const hit = lookup(h, m.id, m.label, { provider: p.id });
      if (hit && finitePos(hit.ii)) iis.push(hit.ii);
    }
  }
  const v = median(iis);
  h.familyMedian.set(family, v);
  return v;
}

export function resolveTier(
  provider: string,
  model: string,
  family: ModelFamily,
  opts: { effort?: string; label?: string } = {},
): ProfileTier {
  const h = ratings();
  if (!h) return { ...NO_TIER, subs: {} };
  try {
    const hit = lookup(h, model, opts.label, { provider, ...(opts.effort ? { effort: opts.effort } : {}) });
    if (hit && finitePos(hit.ii)) {
      return {
        ii: hit.ii,
        subs: { ...(hit.subs ?? {}) },
        derived: hit.derived === true,
        source: "aa",
        conservative: false,
        ...(hit.slug ? { slug: hit.slug } : {}),
        ...(hit.version ? { version: hit.version } : {}),
      };
    }
    const fam = familyMedian(h, family);
    const summary = h.api.ratingsSummary(h.index);
    const version = summary?.version ? { version: summary.version } : {};
    if (fam !== null) return { ii: fam, subs: {}, derived: false, source: "median-fallback", conservative: true, basis: "family", ...version };
    // 全库中位：口径不止一个时取低的那个（偏保守）
    const medians = [summary?.allEfforts?.median, summary?.bestPerFamily?.median, summary?.median].filter(finitePos);
    if (medians.length) {
      return { ii: Math.min(...medians), subs: {}, derived: false, source: "median-fallback", conservative: true, basis: "global", ...version };
    }
  } catch {
    // 评分模块的实现出错不该挡住会话：当作没有评分
  }
  return { ...NO_TIER, subs: {} };
}

// ── 解析 ──────────────────────────────────────────────────────────────────────
export interface ResolveOptions {
  effort?: ThinkingLevel | string; // 会话的思考档（评分按档位取）
  label?: string; // 显示名（自定义服务不给就去注册表里取）
}

function customLabel(provider: string, model: string): string | undefined {
  if (!isCustomProviderId(provider)) return undefined;
  try {
    return getCustomModel(provider, model)?.label || undefined;
  } catch {
    return undefined;
  }
}

/** 这个 provider + 型号的档案。每次返回一份新对象（调用方可以放心持有）。 */
export function resolveProfile(provider: string, model: string, opts: ResolveOptions = {}): ModelProfile {
  const label = opts.label ?? customLabel(provider, model);
  const { family, familySource } = resolveFamily(provider, model, label ? { label } : undefined);
  const base = defaultProfile();
  const merged = deepMerge(base, FAMILY_OVERRIDES[family]);
  return {
    ...merged,
    family,
    familySource,
    tier: resolveTier(provider, model, family, { ...(opts.effort ? { effort: String(opts.effort) } : {}), ...(label ? { label } : {}) }),
  };
}

/** 档案要并进请求体的字段（Turn.hints.providerExtras）；空 = 不挂 hints（与接入前的请求完全一样）。 */
export function profileProviderExtras(p: ModelProfile): Record<string, unknown> | undefined {
  return Object.keys(p.providerExtras).length ? p.providerExtras : undefined;
}
