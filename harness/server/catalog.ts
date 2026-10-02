// Single source of truth for "which models can each provider call, and what
// effort tiers does each model actually expose". Grounded in the July-2026 state
// of each vendor's API (verified against official docs), because the reasoning
// controls differ not just per provider but per MODEL:
//
//   Anthropic (adaptive)  opus-5, opus-4-8/4-7, sonnet-4-6 → thinking:{type:"adaptive"} +
//                         output_config.effort (low/medium/high/xhigh). budget_tokens
//                         now 400s on these models.
//   Anthropic (legacy)    haiku-4-5 → thinking:{type:"enabled",budget_tokens} only;
//                         no effort/adaptive.
//   DeepSeek              thinking:{type} + reasoning_effort. 2026-09-10 上新
//                         DeepSeek-V4.1-Flash，正式 ID 就叫 `deepseek-flash`（旧的
//                         deepseek-v4-flash / -vision-exp 只是临时转发别名，实测
//                         回包 model 字段已是 deepseek-flash）。V4.1 起 low/high/max
//                         三档都是真档位（实测 low 的思维链明显更短），且**原生视觉**
//                         ——但只吃 image_url，video_url 直接 400（实测），所以 video:false。
//                         v4-pro 自 2026-09-14 04:00 UTC 起全量转发到 V4.1-Flash 并按其
//                         计价，留在单子里只为过渡。deepseek-chat/-reasoner 早已 EOL。
//   Qwen                  qwen3.7/3.8 → enable_thinking + thinking_budget
//                         (no reasoning_effort; no "max")。3.8 只有 max/flash 两个型号
//                         （qwen3.8-plus 不存在，实测 model_not_found），两个都是原生
//                         多模态：红→绿→蓝探针片经 video_url 能按序答对（实测 09-10）。
//   Zhipu                 glm-5.2 → thinking:{type} + reasoning_effort (high/max);
//                         glm-5.3 / glm-5.3-flash → 恒思考（thinking.type 只收 enabled）
//                         + reasoning_effort low/high/max（服务端默认 max）；5.3 纯文本、
//                         5.3-flash 原生多模态。glm-5 → thinking:{type} (on/off only)。
//   Kimi                  Kimi-for-Coding subscription API (api.kimi.com/coding/v1).
//                         Every model thinks permanently (supports_thinking_type:"only",
//                         no off switch). 2026-09-11 /models re-probe: kimi-for-coding
//                         now serves K2.8 Preview (1M ctx, think_efforts low/high/max,
//                         server default max) and k3-256k joined (256k, no video in);
//                         k3's server default effort moved max→high. Only the K2.7
//                         Highspeed id still lacks an effort ladder (field ignored,
//                         no 400). The endpoint never validates reasoning_effort, so
//                         the ladder is trusted from /models, not from a rejection.
//                         All ingest image+video except k3-256k (image only). The old
//                         open-platform kimi-k2/kimi-latest ids are EOL and 401 here.
//
// The frontend renders the chat-bar model menu + effort menu straight from this,
// so the two stay in lockstep with the adapters.

import type { ProviderId } from "./providers/types.ts";
import { getCustomProvider, hostOf, isCustomProviderId, listCustomProviders, type CustomProvider } from "./custom-providers.ts";
import { DEFAULT_MEDIA_BUDGET } from "./agent/media-budget.ts";
import type { ThinkingLevel } from "./agent/turn.ts";

export interface ModelSpec {
  id: string;
  label: string;
  // Supported effort tiers, ascending. "off" means thinking can be fully disabled.
  efforts: ThinkingLevel[];
  // First-selection default when "high" is not a real tier of this model.
  defaultEffort?: ThinkingLevel;
  // Some APIs expose a thinking switch rather than different intensities.
  effortLabels?: Partial<Record<ThinkingLevel, string>>;
  // Whether THIS model can see images itself (vs. needing the vision-verify channel).
  image: boolean;
  // Whether it ingests VIDEO natively. Verified live per provider, never assumed
  // from a docs page: Kimi k3/K2.7 answer a red→green→blue probe clip correctly
  // through a video_url part (2026-08-20).
  video?: boolean;
  audio?: boolean;
  // Per-model capability overrides for the OpenAI-compatible adapter (its flat
  // defaults are 128k ctx / 16k out, which starves 1M-context or permanently-
  // thinking models — reasoning tokens bill against the output budget).
  ctx?: number;
  maxOut?: number;
  // R11：按成本压缩的触发线（token）覆盖值。不配就走默认：窗口 ≥ 512K 的模型在 256K 压（agent/context.ts）。
  compactAt?: number;
  note?: string;
}

export interface ProviderSpec {
  id: ProviderId;
  name: string;
  baseUrl?: string; // omitted for anthropic (SDK default)
  defaultModel: string;
  models: ModelSpec[];
  // R12：一次请求里历史图片的额度（张数、base64 字节）。超了才按批退役最老的工具图（agent/media-budget.ts）；
  // 不配走默认 20 张 / 24 MB。keepRecent = 最近几张工具图永不退（默认 3）。
  media?: { maxImages?: number; maxBytes?: number; keepRecent?: number };
  // 只有自定义服务有：卡片副标题显示的主机名
  custom?: { host: string };
}

// Global effort ordering — used to clamp a chosen level to a model's supported set.
export const EFFORT_ORDER: ThinkingLevel[] = ["off", "low", "medium", "high", "max"];

export const CATALOG: ProviderSpec[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    defaultModel: "claude-sonnet-4-6",
    models: [
      // R1（#1）：ctx / maxOut 取自官方模型页（platform.claude.com/docs/en/models/*，2026-09-23 核对）：
      // 5 个 Opus/Sonnet 都是 1M 上下文、同步 Messages API 最多 128K 输出；Haiku 4.5 是 200K / 64K。
      // 以前适配器不读目录，一律 200k / 8192——Opus 5.5 一轮最多写 8192 token 就被截断。
      // 配上 key 后可用 Models API（GET /v1/models/{id} 回 max_input_tokens / max_tokens）核一遍。
      // Opus 5.5（2026-09-22）：Opus 5 的接班人，更便宜（$4/$20，cache read $0.20/M），1M 上下文
      // （裸 id 即 1M）、128k 输出、知识截止 2026-06；adaptive thinking + effort（API 默认 medium）。
      { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, note: "新主力 · 1M 上下文" },
      // Opus 5（2026-07-24）：Claude 5 家族日常主力——接近 Fable 5 智力、半价（$5/$25），
      // adaptive thinking + effort（API 默认 high），知识截止 2026-05。
      { id: "claude-opus-5", label: "Opus 5", efforts: ["low", "medium", "high", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, note: "上一代主力 · 复杂 agent 编码" },
      // Sonnet 5.5（2026-09-28）：Sonnet 档新版；effort 五档、默认 high；ctx / maxOut 沿用同档 Sonnet 4.6 取值，
      // 配上 Anthropic key 后用 Models API 核一遍。
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ["low", "medium", "high", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, note: "均衡 · 新一代 Sonnet" },
      { id: "claude-opus-4-8", label: "Opus 4.8", efforts: ["low", "medium", "high", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, note: "旗舰 · 自适应思考" },
      { id: "claude-opus-4-7", label: "Opus 4.7", efforts: ["low", "medium", "high", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, note: "长程 agent · 高清视觉" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", efforts: ["low", "medium", "high", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, note: "均衡" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: ["off", "low", "medium", "high"], image: true, ctx: 200_000, maxOut: 64_000, note: "极速 · 传统思考预算" },
    ],
  },
  {
    id: "openai",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash",
    models: [
      // maxOut 实测自 api.deepseek.com：两个型号的服务端硬上限都是 393216
      // （393217 即报 "valid range of max_tokens is [1, 393216]"）。session.ts
      // 的 budget 天花板仍会把实际请求夹到 65536——这里只记录真实能力。
      { id: "deepseek-flash", label: "V4.1 Flash", efforts: ["off", "low", "high", "max"], image: true, ctx: 1_000_000, maxOut: 393_216, note: "V4.1 · 原生视觉 · 1M ctx" },
      { id: "deepseek-v4-pro", label: "V4 Pro（退役中）", efforts: ["off", "high", "max"], image: false, ctx: 1_000_000, maxOut: 393_216, note: "09-14 起转发至 V4.1 Flash" },
    ],
  },
  {
    id: "qwen",
    name: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.8-max",
    models: [
      // 3.8 全系原生多模态（图 + 视频，实测），1M ctx / 128K max out；没有 plus 档。
      { id: "qwen3.8-max", label: "Qwen3.8 Max", efforts: ["off", "low", "medium", "high"], image: true, video: true, ctx: 1_000_000, maxOut: 131_072, note: "旗舰 2.4T · 图/视频 · 1M ctx" },
      { id: "qwen3.8-flash", label: "Qwen3.8 Flash", efforts: ["off", "low", "medium", "high"], image: true, video: true, ctx: 1_000_000, maxOut: 131_072, note: "多模态快模 · 1M ctx" },
      // R1：3.7 三个型号取自百炼官方模型页（help.aliyun.com/zh/model-studio/qwen3-7-*，2026-09-23）：
      // 上下文 1000000，最大输出 131072（思考 / 非思考同）。以前没声明，按扁平默认 128k / 16k 算。
      // 真请求核对（09-23）：三个型号对 max_tokens=1e8 都回「Range of max_tokens should be [1, 131072]」。
      { id: "qwen3.7-max", label: "Qwen3.7 Max", efforts: ["off", "low", "medium", "high"], image: false, ctx: 1_000_000, maxOut: 131_072, note: "旗舰" },
      { id: "qwen3.7-plus", label: "Qwen3.7 Plus", efforts: ["off", "low", "medium", "high"], image: true, ctx: 1_000_000, maxOut: 131_072, note: "均衡 · 多模态" },
      { id: "qwen3.7-flash", label: "Qwen3.7 Flash", efforts: ["off", "low", "medium", "high"], image: false, ctx: 1_000_000, maxOut: 131_072, note: "轻量快" },
    ],
  },
  {
    id: "zhipu",
    name: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    // defaultModel 是 glm-5.2：它对各档资源包都可用；glm-5.3* 要账号的资源包覆盖 5.3，
    // 否则一律回 1113。
    defaultModel: "glm-5.2",
    models: [
      // 5.3 系列恒思考（thinking.type 只收 enabled）→ efforts 里没有 off；
      // 三档 low/high/max 与服务端一致（默认 max）。1M ctx / 128K max out。
      // image/video 取自官方模型页，未能实测——按「猜错要
      // 吃 400、猜没有只退化成抽帧」的老规矩，video 一律不敢标 true。
      { id: "glm-5.3", label: "GLM-5.3", efforts: ["low", "high", "max"], image: false, ctx: 1_000_000, maxOut: 131_072, note: "旗舰 · 恒思考 · 1M ctx" },
      { id: "glm-5.3-flash", label: "GLM-5.3 Flash", efforts: ["low", "high", "max"], image: true, ctx: 1_000_000, maxOut: 131_072, note: "多模态 · 1/40 价 · 1M ctx" },
      // R1：5.2 / 5 取自智谱官方模型页（docs.bigmodel.cn/cn/guide/models/text/*，2026-09-23）：
      // GLM-5.2 1M / 128K 输出，GLM-5 200K / 128K 输出。真请求核对（09-23）：GLM-5.2 对 max_tokens=1e8
      // 回「限制数值范围[1,131072]」；GLM-5 未能实测，按文档。
      { id: "glm-5.2", label: "GLM-5.2", efforts: ["off", "high", "max"], image: false, ctx: 1_000_000, maxOut: 131_072, note: "Coding/长程 · 1M ctx" },
      { id: "glm-5", label: "GLM-5", efforts: ["off", "high"], image: false, ctx: 200_000, maxOut: 131_072, note: "旗舰" },
    ],
  },
  {
    id: "kimi",
    name: "Kimi",
    baseUrl: "https://api.kimi.com/coding/v1",
    defaultModel: "k3",
    models: [
      // 全系恒思考（无 off 档）。effort 阶梯/ctx/video 逐条以 /models 实测为准
      // （2026-09-11）：K2.8 Preview 顶着老 id kimi-for-coding 上线，长出三档并扩到 1M。
      { id: "k3", label: "K3", efforts: ["low", "high", "max"], image: true, video: true, ctx: 1_048_576, maxOut: 65_536, note: "旗舰 · 1M ctx · 恒思考" },
      { id: "k3-256k", label: "K3 256k", efforts: ["low", "high", "max"], image: true, video: false, ctx: 262_144, maxOut: 65_536, note: "旗舰 · 256k · 不吃视频" },
      { id: "kimi-for-coding", label: "K2.8 Preview", efforts: ["low", "high", "max"], image: true, video: true, ctx: 1_048_576, maxOut: 65_536, note: "编码特化 · 1M ctx · 预览" },
      { id: "kimi-for-coding-highspeed", label: "K2.7 Highspeed", efforts: ["high"], image: true, video: true, ctx: 262_144, maxOut: 65_536, note: "极速 ≈180 tok/s" },
    ],
  },
  {
    id: "mimo",
    name: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    defaultModel: "mimo-v2.6-pro",
    // Official docs (2026-09-22): 1M context / 128K output, image/video/audio input.
    // https://mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/deep-thinking.md
    // Deep thinking is enabled/disabled ONLY; low/medium/high are equivalent,
    // and Chat Completions rejects reasoning_effort=max. Pro/Flash verified live
    // with native image/video/audio and streaming tool continuations. UltraSpeed
    // uses the same documented schema; the Token Plan CN endpoint rejects it.
    // 多图认不准最新那张（2026-09-30 实测）：会话里攒到 5 张以上工具图时，MiMo 会把新截图认成历史里某张旧图
    // （连续 5 次把正常页面报成早先那张 ERR_FILE_NOT_FOUND），与服务端缓存无关（打破缓存照错）。按原会话回放：
    // 只留最近 2 张全对，3 张在后段仍错。所以只让最近 2 张工具图入模，更早的退成一句文字（要看就重读）。
    media: { maxImages: 2, keepRecent: 2 },
    models: [
      { id: "mimo-v2.6-pro", label: "MiMo V2.6 Pro", efforts: ["off", "high"], effortLabels: { off: "关闭", high: "开启" }, image: true, video: true, ctx: 1_000_000, maxOut: 131_072, audio: true, note: "旗舰 · 图/视频/音频 · 1M ctx" },
      { id: "mimo-v2.6-pro-ultraspeed", label: "MiMo V2.6 Pro UltraSpeed", efforts: ["off", "high"], effortLabels: { off: "关闭", high: "开启" }, image: true, video: true, audio: true, ctx: 1_000_000, maxOut: 131_072, note: "极速 · 需单独 API 权限 · 10× 单价" },
      { id: "mimo-v2.6-flash", label: "MiMo V2.6 Flash", efforts: ["off", "high"], effortLabels: { off: "关闭", high: "开启" }, image: true, video: true, ctx: 1_000_000, maxOut: 131_072, audio: true, note: "高效 · 图/视频/音频 · 1M ctx" },
    ],
  },
  {
    id: "gemini",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-3.5-flash",
    // 内联数据（图片 base64）连同文字整个请求不能超过 20 MB，给文字留出余量
    media: { maxBytes: 14_000_000 },
    models: [
      // Gemini 3 family uses thinkingLevel (no true "off"); 2.5 uses thinkingBudget
      // and can disable. All Gemini chat models are multimodal.
      // R1：ctx / maxOut 取自官方模型页（ai.google.dev/gemini-api/docs/models/*，2026-09-23）：
      // 三个型号都是输入 1,048,576 / 输出 65,536。真请求核对（09-23，models.get 的 inputTokenLimit /
      // outputTokenLimit）：三个型号一致。
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", efforts: ["low", "medium", "high"], image: true, ctx: 1_048_576, maxOut: 65_536, note: "最新 Flash · 1M ctx" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", efforts: ["low", "medium", "high"], image: true, ctx: 1_048_576, maxOut: 65_536, note: "旗舰 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", efforts: ["off", "low", "medium", "high"], image: true, ctx: 1_048_576, maxOut: 65_536, note: "稳定 · 可关思考" },
    ],
  },
];

// 自定义服务（custom-providers.ts）按同一形状并进目录：型号只知道名字，思考档只有 off（不发任何厂商专属参数），
// 视觉按名字启发式猜，上下文 / 输出走适配器的扁平默认。
function customSpec(c: CustomProvider): ProviderSpec {
  return {
    id: c.id as ProviderId,
    name: c.name,
    baseUrl: c.baseUrl,
    defaultModel: c.defaultModel,
    custom: { host: hostOf(c.baseUrl) },
    models: c.models.map((id) => ({ id, label: id, efforts: ["off"], image: guessImages(id) })),
  };
}

// 内置七家 + 用户加的自定义服务（按添加顺序）。凡是「这个 provider 存不存在 / 有哪些型号」都从这里查。
export function allProviders(): ProviderSpec[] {
  const custom = listCustomProviders();
  return [...CATALOG, ...custom.map(customSpec)];
}

export function providerSpec(p: ProviderId): ProviderSpec {
  if (isCustomProviderId(p)) {
    const c = getCustomProvider(p);
    if (c) return customSpec(c);
  }
  return CATALOG.find((s) => s.id === p) ?? CATALOG[0];
}

// R12：这家 provider 一次请求里历史图片的额度（目录没配的项取默认）。
export function providerMediaBudget(p: ProviderId): { maxImages: number; maxBytes: number; keepRecent?: number } {
  const media = CATALOG.find((s) => s.id === p)?.media;
  return {
    maxImages: media?.maxImages ?? DEFAULT_MEDIA_BUDGET.maxImages,
    maxBytes: media?.maxBytes ?? DEFAULT_MEDIA_BUDGET.maxBytes,
    ...(media?.keepRecent !== undefined ? { keepRecent: media.keepRecent } : {}),
  };
}

export function modelSpec(p: ProviderId, modelId: string): ModelSpec | undefined {
  return providerSpec(p).models.find((m) => m.id === modelId);
}

// One capability decision for the UI, main-agent context, Browser feedback and
// attachment ingestion. Known catalog entries always win; the fallback only
// serves custom endpoints/models that are intentionally absent from the picker.
export function modelSupportsAudio(provider: ProviderId, model: string): boolean {
  return modelSpec(provider, model)?.audio === true;
}

export function modelSupportsVideo(p: ProviderId, modelId: string): boolean {
  const known = modelSpec(p, modelId);
  if (known) return known.video === true;
  // Unknown/custom endpoints: assume no video. Guessing wrong costs a hard 400
  // mid-turn, while guessing "no" costs only a frame-sampled fallback.
  return false;
}

export function modelSupportsImages(p: ProviderId, modelId: string): boolean {
  const known = modelSpec(p, modelId);
  if (known) return known.image;
  if (p === "anthropic" || p === "gemini" || p === "kimi") return true;
  return guessImages(modelId);
}

function guessImages(modelId: string): boolean {
  return /(?:^|[-_.])(vl|vision|omni)(?:$|[-_.])|gpt-[45]|^o[0-9]|glm-[\d.]+v/i.test(modelId);
}

// Per-model context/output limits for adapters whose provider-level defaults
// are too coarse (see ModelSpec.ctx/maxOut). Unknown models return {}.
export function modelLimits(p: ProviderId, modelId: string): { ctx?: number; maxOut?: number; compactAt?: number } {
  const known = modelSpec(p, modelId);
  return known ? { ctx: known.ctx, maxOut: known.maxOut, compactAt: known.compactAt } : {};
}

export function defaultModel(p: ProviderId): string {
  return providerSpec(p).defaultModel;
}

export function providerBaseUrl(p: ProviderId): string | undefined {
  return providerSpec(p).baseUrl;
}

// Clamp a desired effort to what the given model actually supports: pick the
// highest supported tier that is ≤ desired, else the lowest supported tier.
export function clampEffort(
  p: ProviderId,
  modelId: string,
  level: ThinkingLevel,
): ThinkingLevel {
  const spec = modelSpec(p, modelId);
  const efforts = spec?.efforts ?? ["off"];
  if (efforts.includes(level)) return level;
  // A non-off request must not become disabled when moving to MiMo's binary
  // switch (e.g. a low-effort subagent inherited from another model).
  if (p === "mimo" && spec && level !== "off") return "high";
  const want = EFFORT_ORDER.indexOf(level);
  let best: ThinkingLevel | null = null;
  for (const e of efforts) {
    if (EFFORT_ORDER.indexOf(e) <= want) {
      if (best === null || EFFORT_ORDER.indexOf(e) > EFFORT_ORDER.indexOf(best)) best = e;
    }
  }
  if (best) return best;
  // Nothing at or below → return the lowest supported tier.
  return [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))[0];
}

// A sensible default effort when first selecting a model: prefer "high" if the
// model supports it (matches most vendors' own defaults), else "low", else first.
export function defaultEffort(p: ProviderId, modelId: string): ThinkingLevel {
  const spec = modelSpec(p, modelId);
  const efforts = spec?.efforts ?? ["off"];
  if (spec?.defaultEffort && efforts.includes(spec.defaultEffort)) return spec.defaultEffort;
  if (efforts.includes("high")) return "high";
  if (efforts.includes("low")) return "low";
  return efforts[0];
}
