// 模型档案：按模型家族调系统提示词、工具说明、请求参数与 loop 行为，都改这里的数据，不在各处散写 if/else。
//
// 档案 = 家族识别 + 智力分档 + 姿态 + 五块可调项（prompt / tools / sampling / providerExtras / loop）+ 旁路请求（side）。
//
// 姿态（posture）两种：
//   lean     —— 默认。按强模型校准：精简系统提示词、不设完成门禁、不追问、不提醒、工具不带 verify 参数与 VerificationAudit。
//   hardened —— 给实测评分偏低的型号挂上的加固：取值逐项等于姿态改造之前的现状（门禁、先读后改、待办提醒、原文提示词……）。
// 判定在 resolveProfile：只有实测评分（tier.source === "aa"）低于 HARDENED_BELOW_II 的才 hardened；认不出、按中位推的、
// 没评分的一律 lean。家族覆盖表 FAMILY_OVERRIDES 与环境变量 DIMENSIO_PROFILE_OVERRIDES 都能用 posture 键强制任一姿态。
// 主会话的姿态只在第一次建 state 时判，之后由调用方经 pinnedPosture 传回来沿用（system 与工具表是按它建的）。
//
// 解析时机：会话建立 / 换型号重建（session.ts buildState，两条路都经它）、子 agent 与 Workflow 节点（subagent.ts，按路由后的
// 实际目标型号）。解析一次放进 AgentState.profile，loop 各处现读 state.profile——同一个会话中途不变，换型号换的是整份 state。
//
// 默认值的来源仍是各模块的常量（loop.ts / loop-guard.ts / repetition.ts / subagent.ts / context.ts），这里只在函数里读
// 它们（不在模块顶层读）：loop.ts → state.ts → profile.ts → loop.ts 是个环，顶层取值会撞上未初始化的绑定。
import { unknownPatches } from "./prompt-patches.ts";
import { PROMPT_VARIANTS, type PromptVariant } from "./prompt-variants.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { coreModule, coreUrl } from "../core-link.ts";
import { MK } from "../model-knowledge.ts";
import { CATALOG } from "../catalog.ts";
import { getCustomModel, isCustomProviderId } from "../custom-providers.ts";
import type { ThinkingLevel } from "./turn.ts";
import type { ToolPolicy } from "../tools/types.ts";
import {
  DENIALS_BEFORE_STOP,
  EMPTY_RESPONSE_RETRIES,
  MAX_ANSWER_NUDGES,
  MAX_CUTOFF_NUDGES,
  MAX_LENGTH_CONTINUES,
  MAX_PARALLEL_TOOLS,
  RETRY_ATTEMPTS,
} from "./loop.ts";
import { TODO_REMIND_TURNS } from "./loop/limits.ts";
import { GUARD_DEFAULTS, type GuardLimits } from "./loop-guard.ts";
import { REPETITION_DEFAULTS, type RepetitionLimits } from "./repetition.ts";
import { SUBMIT_ATTEMPTS, SUBMIT_NUDGES } from "./subagent.ts";
import { SUMMARY_BUDGET, type SummaryProfile } from "./context.ts";
import { DEFERRED_FAMILIES, HARDENED_DEFERRED_FAMILIES } from "./deferred-tools.ts";

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

// 姿态：lean = 默认（按强模型校准）；hardened = 改造前的全部加固
export type Posture = "lean" | "hardened";
export const POSTURES: readonly Posture[] = ["lean", "hardened"];

// 低于这个 AA 智力指数（Artificial Analysis Intelligence Index，快照 v5.0 口径）的实测型号用 hardened。
// 依据：v5.0 快照 210 条的中位约 30、下四分位约 18.5；20 以下是小参数本机模型、非推理档与上一代轻量型号
//（如 qwen3.8-27b 的 low / non-reasoning、gemini-3.5-flash-lite、gpt-oss-20b），目录里在用的型号默认档都在 20 以上。
export const HARDENED_BELOW_II = 20;

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
  // 完成门禁：改了代码却没有通过的验证（或有没跑过的反向依赖测试）就想收尾时，撤回答复、追问补验证（verify-nudge）。
  // off = 不追问也不撤回，模型不带工具调用就照常收尾。答复下的「未验证」尾注不归这里管；只思考 / 半句停下的追问各有字段
  verifyGate: "on" | "off";
  // 待办提醒：连着这么多个工具回合没看到待办清单，就在下一次请求末尾带一份（压缩后立刻带一次）；0 = 不提醒
  todoReminderEvery: number;
  todoReminderOnlyIncomplete: boolean; // 只在清单里还有没做完的项时提醒；false = 清单非空就提醒
  // 只有思考、没有答复就要收尾时：nudge = 追加一句追问（次数见 maxAnswerNudges）；retry = 不追加消息，把这次调用当空响应
  // 原样重发（与空响应共用每次调用 emptyResponseRetries 的次数），重发用完仍只有思考就照常收尾
  thinkingOnly: "nudge" | "retry";
  // 主会话最终答复下的验证尾注（「未验证」、最后一次检查没过、VerificationAudit 豁免、通过的回执）：off = 不附。
  // 没落地的编辑与记忆审计放行那两行不归这里管
  verifyFootnote: "on" | "off";
}

export interface ModelProfile {
  family: ModelFamily;
  familySource: FamilySource;
  tier: ProfileTier;
  posture: Posture;
  postureReason: string; // 为什么是这个姿态（评分 / 覆盖），给日志与测试看
  // 提示词变体与补丁：补丁 id 见 prompt-patches.ts，只加进主会话的系统提示词（子 agent 不加）
  prompt: { variant: PromptVariant; patches: string[] };
  tools: {
    editFormat: "str_replace"; // Edit 的编辑格式（现状 old_string/new_string 精确替换）
    deferredFamilies: readonly (readonly string[])[]; // 延迟加载的工具族（deferred-tools.ts DEFERRED_FAMILIES）
    subset: string[] | null; // 只下发这些工具；null = 不裁
    pathAliases: Record<string, string>; // 额外的参数名别名（别名 → 规范名），叠在各工具自带的别名表下面（工具表优先）；默认空
    // verify:true 的写法契约（Bash 的只读 / 无关命令与吞退出码的 ||、&、开头 !；Eval 返回非布尔；Network 缺 filter / expectedStatus）：
    // strict = 打回（不执行，或判为畸形）；lenient = 不打回，按没带 verify 照常执行，结果末尾注明不记作验证证据——
    // 证据账只收归属得清的检查，放松写法不会多出假绿
    verifyContract: "strict" | "lenient";
    // Edit 要不要先 Read：strict = 没读过就否决；off = 不要求（仍现读文件匹配，old_string 须唯一命中照旧）。
    // Write 覆盖已有文件的先读要求不归这里管，见 readBeforeWrite
    readBeforeEdit: "strict" | "off";
    // Write 覆盖已有文件前要读到什么程度：full = 每一行都读过；any = 这个会话读过它任意一段；off = 不要求。
    // 读过之后磁盘上又被别人改了，三档都拦（不盖掉没见过的内容）
    readBeforeWrite: "full" | "any" | "off";
    // 验证证据的工具形状：on = Bash / Eval / Network 的 schema 带 verify 参数（Network 连带 expectedStatus）、下发 VerificationAudit；
    // off = 都不出现，模型照旧传了 verify 就静默去掉、按普通调用执行。建会话时定一次，同一会话内工具表不变
    verifyTools: "on" | "off";
    // 工具说明：lean = 工具自带的精简说明；hardened = 姿态改造前的说明原文（agent/tool-descriptions.ts）。参数 schema 不分姿态
    descriptions: "lean" | "hardened";
  };
  sampling: Record<string, number>; // 采样参数；空 = 不发任何采样参数（现状）。P0 不下发
  providerExtras: Record<string, unknown>; // 原样并进请求体（Turn.hints.providerExtras，三个适配器都会合并）；空 = 不挂
  loop: LoopProfile;
  // 记忆：autoRecall = 每轮开跑前按用户这句话检索、把命中的记忆与项目知识追加成一条内部消息。lean 关（记忆索引常驻 system，
  // 每轮的召回多半是噪音）；hardened 开
  memory: { autoRecall: boolean };
  // 压缩摘要：mode = inline（主模型接着原对话写）| sidecar（旁路请求）；maxOutputTokens = 输出上限的基准（随窗口缩放）；
  // thinking = inherit（inline 跟主请求同档、sidecar 关思考）或指定档位
  side: { summary: SummaryProfile };
}

// 家族覆盖：深合并到该姿态的档案上（数组整体替换）；posture 键强制姿态（先定姿态、再叠其余各项）。为空 = 只按评分判姿态。
type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type ProfilePatch = DeepPartial<Omit<ModelProfile, "family" | "familySource" | "tier" | "postureReason">>;
export const FAMILY_OVERRIDES: Partial<Record<ModelFamily, ProfilePatch>> = {};

// 评测臂的档案覆盖（evals/ab/matrix.ts 的变体文件原样写进这个环境变量）：{ "<家族>" | "*": ProfilePatch }，叠在家族覆盖之上。
// 正式服不设。写坏了直接抛：评测臂起不来，比按错的档案跑完一整轮再发现强。
let envOverrides: { raw: string; map: Partial<Record<ModelFamily | "*", ProfilePatch>> } | null = null;

// 门禁类开关的合法取值：拼错了（"of"）读的地方会按默认走，评测臂看着开了其实没开，所以在这里就挡住
const SWITCHES: [group: "loop" | "tools" | "memory", key: string, ok: (v: unknown) => boolean, want: string][] = [
  ["loop", "verifyGate", (v) => v === "on" || v === "off", "on | off"],
  ["loop", "thinkingOnly", (v) => v === "nudge" || v === "retry", "nudge | retry"],
  ["loop", "todoReminderEvery", (v) => Number.isInteger(v) && (v as number) >= 0, "非负整数"],
  ["loop", "todoReminderOnlyIncomplete", (v) => typeof v === "boolean", "true | false"],
  ["loop", "verifyFootnote", (v) => v === "on" || v === "off", "on | off"],
  ["tools", "verifyContract", (v) => v === "strict" || v === "lenient", "strict | lenient"],
  ["tools", "readBeforeEdit", (v) => v === "strict" || v === "off", "strict | off"],
  ["tools", "readBeforeWrite", (v) => v === "full" || v === "any" || v === "off", "full | any | off"],
  ["tools", "verifyTools", (v) => v === "on" || v === "off", "on | off"],
  ["tools", "descriptions", (v) => v === "lean" || v === "hardened", "lean | hardened"],
  ["memory", "autoRecall", (v) => typeof v === "boolean", "true | false"],
];
function badSwitches(patch: ProfilePatch | undefined): string[] {
  const out: string[] = [];
  if (patch && "posture" in patch && !(POSTURES as readonly unknown[]).includes(patch.posture)) out.push(`posture=${JSON.stringify(patch.posture)}（应为 lean | hardened）`);
  for (const [group, key, ok, want] of SWITCHES) {
    const block = patch?.[group] as Record<string, unknown> | undefined;
    if (block && typeof block === "object" && key in block && !ok(block[key])) out.push(`${group}.${key}=${JSON.stringify(block[key])}（应为 ${want}）`);
  }
  return out;
}
function overridesFromEnv(): Partial<Record<ModelFamily | "*", ProfilePatch>> {
  const raw = process.env.DIMENSIO_PROFILE_OVERRIDES?.trim() ?? "";
  if (envOverrides?.raw === raw) return envOverrides.map;
  let map: Partial<Record<ModelFamily | "*", ProfilePatch>> = {};
  if (raw) {
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("DIMENSIO_PROFILE_OVERRIDES 要是 { 家族: 覆盖 } 形状的 JSON 对象");
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (k !== "*" && !(MODEL_FAMILIES as readonly string[]).includes(k)) throw new Error(`DIMENSIO_PROFILE_OVERRIDES 里不认识的家族：${k}`);
      const patches = (v as ProfilePatch)?.prompt?.patches;
      const bad = Array.isArray(patches) ? unknownPatches(patches) : [];
      if (bad.length) throw new Error(`DIMENSIO_PROFILE_OVERRIDES 里不认识的提示词补丁：${bad.join(", ")}`);
      const variant = (v as ProfilePatch)?.prompt?.variant;
      if (variant !== undefined && !(PROMPT_VARIANTS as readonly string[]).includes(variant)) throw new Error(`DIMENSIO_PROFILE_OVERRIDES 里不认识的提示词变体：${String(variant)}`);
      const wrong = badSwitches(v as ProfilePatch);
      if (wrong.length) throw new Error(`DIMENSIO_PROFILE_OVERRIDES 里取值不对的开关：${wrong.join(", ")}`);
    }
    map = j as typeof map;
  }
  envOverrides = { raw, map };
  return map;
}

// ── 默认档案（lean）与加固覆盖（hardened）────────────────────────────────────────
export function defaultLoopProfile(): LoopProfile {
  return {
    maxAnswerNudges: MAX_ANSWER_NUDGES,
    maxCutoffNudges: 0, // 半句停下不追问（被输出上限截断的续写 lengthContinues 照旧）
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
    verifyGate: "off",
    todoReminderEvery: 0,
    todoReminderOnlyIncomplete: true,
    thinkingOnly: "retry",
    verifyFootnote: "off",
  };
}

/** hardened 相对 lean 改的那几项：取值逐项等于姿态改造之前的现状（各模块原来的常量）。
 * Write 覆盖先读要求回到「每一行都读过」；推迟的工具回到推迟范围扩大前的五族；工具说明回到改造前的原文；压缩摘要走旁路（弱模型不适合接着原对话写摘要）；
 * 每轮自动召回照旧开着。 */
export function hardenedPatch(): ProfilePatch {
  return {
    loop: { maxCutoffNudges: MAX_CUTOFF_NUDGES, verifyGate: "on", todoReminderEvery: TODO_REMIND_TURNS, thinkingOnly: "nudge", verifyFootnote: "on" },
    tools: { verifyContract: "strict", readBeforeEdit: "strict", verifyTools: "on", readBeforeWrite: "full", deferredFamilies: HARDENED_DEFERRED_FAMILIES, descriptions: "hardened" },
    side: { summary: { mode: "sidecar" } },
    memory: { autoRecall: true },
  };
}

const NO_TIER: ProfileTier = { ii: null, subs: {}, derived: false, source: "none", conservative: false };

/** 默认档案（lean、家族未知、不评分）：AgentState 没拿到档案时用它。 */
export function defaultProfile(): ModelProfile {
  return {
    family: "unknown",
    familySource: "none",
    tier: { ...NO_TIER, subs: {} },
    posture: "lean",
    postureReason: "default",
    prompt: { variant: "default", patches: [] },
    tools: { editFormat: "str_replace", deferredFamilies: DEFERRED_FAMILIES, subset: null, pathAliases: {}, verifyContract: "lenient", readBeforeEdit: "off", verifyTools: "off", readBeforeWrite: "any", descriptions: "lean" },
    sampling: {},
    providerExtras: {},
    loop: defaultLoopProfile(),
    memory: { autoRecall: false },
    side: { summary: { ...SUMMARY_BUDGET } },
  };
}

/** 加固档案（= 姿态改造前的现状档案，家族未知、不评分）：测试与需要显式加固的地方用。 */
export function hardenedProfile(): ModelProfile {
  return { ...deepMerge(defaultProfile(), hardenedPatch()), posture: "hardened", postureReason: "explicit" };
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
  qwen4: "qwen",
  "qwen38-open": "qwen",
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
  // 已经定下的姿态（会话建立时定一次、随会话落盘，见 session/build-state.ts）：给了就用它，评分与覆盖表的 posture 键都不再改它；
  // 覆盖表的其余各项照常叠上去。同一会话中途换思考档 / 换型号 / 重启恢复，姿态（连同 system 与工具表）不跟着翻
  pinnedPosture?: { posture: Posture; reason: string };
}

function customLabel(provider: string, model: string): string | undefined {
  if (!isCustomProviderId(provider)) return undefined;
  try {
    return getCustomModel(provider, model)?.label || undefined;
  } catch {
    return undefined;
  }
}

// 评分定姿态：只有实测分（source aa）低于阈值的才加固；按中位推的、没有评分的都按 lean
function postureFromTier(tier: ProfileTier): { posture: Posture; reason: string } {
  if (tier.source !== "aa" || tier.ii === null) return { posture: "lean", reason: tier.source === "none" ? "no rating" : `no measured rating (${tier.source})` };
  return tier.ii < HARDENED_BELOW_II
    ? { posture: "hardened", reason: `aa ii ${tier.ii} < ${HARDENED_BELOW_II}` }
    : { posture: "lean", reason: `aa ii ${tier.ii} >= ${HARDENED_BELOW_II}` };
}

/** 这个 provider + 型号的档案。每次返回一份新对象（调用方可以放心持有）。 */
export function resolveProfile(provider: string, model: string, opts: ResolveOptions = {}): ModelProfile {
  const label = opts.label ?? customLabel(provider, model);
  const { family, familySource } = resolveFamily(provider, model, label ? { label } : undefined);
  const tier = resolveTier(provider, model, family, { ...(opts.effort ? { effort: String(opts.effort) } : {}), ...(label ? { label } : {}) });
  const env = overridesFromEnv();
  // 覆盖层从低到高：家族覆盖表 → 环境变量的 * → 环境变量的本家族；posture 键后者压前者
  const layers: [string, ProfilePatch | undefined][] = [
    [`FAMILY_OVERRIDES.${family}`, FAMILY_OVERRIDES[family]],
    ["DIMENSIO_PROFILE_OVERRIDES.*", env["*"]],
    [`DIMENSIO_PROFILE_OVERRIDES.${family}`, env[family]],
  ];
  let { posture, reason } = postureFromTier(tier);
  for (const [name, patch] of layers) {
    if (patch?.posture) {
      posture = patch.posture;
      reason = `${name} (${reason})`;
    }
  }
  if (opts.pinnedPosture) ({ posture, reason } = opts.pinnedPosture);
  let merged = posture === "hardened" ? deepMerge(defaultProfile(), hardenedPatch()) : defaultProfile();
  for (const [, patch] of layers) merged = deepMerge(merged, patch);
  return { ...merged, family, familySource, tier, posture, postureReason: reason };
}

/** 档案里管工具契约的两项，交给工具的那一份。 */
export function profileToolPolicy(p: ModelProfile): ToolPolicy {
  return { verifyContract: p.tools.verifyContract, readBeforeEdit: p.tools.readBeforeEdit, readBeforeWrite: p.tools.readBeforeWrite };
}

/** 档案要并进请求体的字段（Turn.hints.providerExtras）；空 = 不挂 hints（与接入前的请求完全一样）。 */
export function profileProviderExtras(p: ModelProfile): Record<string, unknown> | undefined {
  return Object.keys(p.providerExtras).length ? p.providerExtras : undefined;
}
