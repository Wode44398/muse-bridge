// Single source of truth for "which models can each provider call, and what
// effort tiers does each model actually expose". Grounded in the July-2026 state
// of each vendor's API (verified against official docs), because the reasoning
// controls differ not just per provider but per MODEL:
//
//   Anthropic (adaptive)  opus-5.x, opus-4-8/4-7, sonnet-5-5/4-6, haiku-5-5 → thinking:{type:"adaptive"} +
//                         output_config.effort low/medium/high/xhigh/max（官方 effort 文档 2026-10-09：
//                         Sonnet 4.6 只有 max、没有 xhigh）。budget_tokens now 400s on these models.
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
//   Qwen                  qwen3.8 → enable_thinking + reasoning_effort low/medium/xhigh（high/max 是 xhigh 的别名）；
//                         qwen3.7 → enable_thinking + thinking_budget（没有 reasoning_effort）。3.8 只有 max/flash 两个型号
//                         （qwen3.8-plus 不存在，实测 model_not_found），两个都是原生
//                         多模态：红→绿→蓝探针片经 video_url 能按序答对（实测 09-10）。
//   Zhipu                 glm-5.2 → thinking:{type} + reasoning_effort (high/max);
//                         glm-5.3 / glm-5.3-flash → 恒思考（thinking.type 只收 enabled）
//                         + reasoning_effort low/high/max（服务端默认 max）；5.3 纯文本、
//                         5.3-flash 原生多模态。glm-5 → thinking:{type} (on/off only)。
//                         注意：本机这把 key 调 glm-5.3* 会回 1113「余额不足或无可用资源
//                         包」，同一把 key 调 glm-5.2 正常——是 5.3 没进资源包，不是欠费。
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
//   Local (llama.cpp)     qwen3.8-27b → reasoning_effort 走 chat_template_kwargs，
//                         因为 Qwen3.8 把它做在 chat template 里而非顶层字段；
//                         模板只认 low/medium/xhigh，关思考是 enable_thinking:false。
//                         实测（2026-09-01，llama-server b10729）：tool_calls 与
//                         reasoning_content 的流式增量都符合 OpenAI 形状。
//
// The frontend renders the chat-bar model menu + effort menu straight from this,
// so the two stay in lockstep with the adapters.

import type { ProviderId } from "./providers/types.ts";
import { getCustomProvider, hostOf, isCustomProviderId, isSharedProvider, listCustomProviders, type CustomModel, type CustomProvider } from "./custom-providers.ts";
import { autoThinkSlots, slotView } from "./custom-tiers.ts";
import { MK } from "./model-knowledge.ts";
import { DEFAULT_MEDIA_BUDGET } from "./agent/media-budget.ts";
import { localAiSettings, STRATA_MODEL, strataSettings } from "./localai.ts";
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
  // Anthropic fast mode（`speed:"fast"` + beta 头 fast-mode-2026-02-01）。2026-10-14 用真 key 逐个型号实测：
  // Opus 5.5 / Opus 5 / Opus 4.8 回 usage.speed=fast；Sonnet 5.5、Sonnet 4.6、Opus 4.7、Haiku 5.5 直接 400。
  fast?: boolean;
  note?: string;
  // 只有自定义服务的型号有：不发参数也会思考；autoThinkAt = 选着也照样思考的档（什么都不发的槽，胶囊据此写「模型自带思考」，
  // 不比对档名文字——custom-tiers.ts autoThinkSlots）；group = id 里的 vendor/ 前缀（菜单分组）
  alwaysThinks?: boolean;
  autoThinkAt?: ThinkingLevel[];
  group?: string;
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
  // 只有自定义服务有：卡片副标题显示的主机名、协议；all = 服务里一共多少个型号（菜单只列启用的对话型号）
  // shared = 管理员实例上标了「共享给成员」；managed = 成员实例上这条是管理员共享过来的（不给地址，只能用不能改）
  custom?: { host: string; protocol: string; all: number; shared?: boolean; managed?: boolean };
}

// Global effort ordering — used to clamp a chosen level to a model's supported set.
export const EFFORT_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const CATALOG: ProviderSpec[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    // 没用过 Claude 时的默认＝当前主力 Opus 5.5（以前一直停在 Sonnet 4.6，维护者 10-11 嫌「莫名其妙的老模型」）；
    // 用过的话切回这家继承上次的型号，见 config.ts preferredModel。
    defaultModel: "claude-opus-5-5",
    models: [
      // R1（#1）：ctx / maxOut 取自官方模型页（platform.claude.com/docs/en/models/*，2026-09-23 核对）：
      // 5 个 Opus/Sonnet 都是 1M 上下文、同步 Messages API 最多 128K 输出；Haiku 4.5 是 200K / 64K。
      // 以前适配器不读目录，一律 200k / 8192——Opus 5.5 一轮最多写 8192 token 就被截断。
      // 真请求核对：dimensio 这边（测试服、正式服的 harness/.env）都没有 Anthropic key，没法实测；
      // 配上 key 后用 Models API（GET /v1/models/{id} 回 max_input_tokens / max_tokens）核一遍即可。
      // Opus 5.5（2026-09-22）：Opus 5 的接班人，更便宜（$4/$20，cache read $0.20/M），1M 上下文
      // （裸 id 即 1M）、128k 输出、知识截止 2026-06；adaptive thinking + effort（API 默认 medium）。
      { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", image: true, ctx: 1_000_000, maxOut: 128_000, fast: true, note: "新主力 · 1M 上下文" },
      // Opus 5（2026-07-24）：Claude 5 家族日常主力——接近 Fable 5 智力、半价（$5/$25），
      // adaptive thinking + effort（API 默认 high），知识截止 2026-05。
      { id: "claude-opus-5", label: "Opus 5", efforts: ["low", "medium", "high", "xhigh", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, fast: true, note: "上一代主力 · 复杂 agent 编码" },
      // Sonnet 5.5（2026-09-28）：Sonnet 档新版；effort 五档、默认 high；ctx / maxOut 沿用同档 Sonnet 4.6 取值，
      // 配上 Anthropic key 后用 Models API 核一遍。
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, note: "均衡 · 新一代 Sonnet" },
      { id: "claude-opus-4-8", label: "Opus 4.8", efforts: ["low", "medium", "high", "xhigh", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, fast: true, note: "旗舰 · 自适应思考" },
      { id: "claude-opus-4-7", label: "Opus 4.7", efforts: ["low", "medium", "high", "xhigh", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, note: "长程 agent · 高清视觉" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", efforts: ["low", "medium", "high", "max"], image: true, ctx: 1_000_000, maxOut: 128_000, note: "均衡" },
      // Haiku 5.5（2026-10-07）：$0.10/$0.50（prompt 超 10 万 token 起 $0.50/$2.50），1M 上下文（裸 id）、128k 输出，
      // adaptive thinking 不可关（适配器走 adaptive 分支，「关」档落成 effort low）；effort 五档、API 默认 medium。
      { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", image: true, ctx: 1_000_000, maxOut: 128_000, note: "极速 · 新一代 Haiku" },
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
      // 思考档用官方 reasoning_effort low / medium / xhigh（官方默认 xhigh，思维链最长 262144 token）。dimensio 默认 medium：
      // 以前的默认 high 是 thinking_budget 32k 的成本闸，xhigh 不封顶，换档不能悄悄放大账单。
      { id: "qwen3.8-max", label: "Qwen3.8 Max", efforts: ["off", "low", "medium", "xhigh"], defaultEffort: "medium", image: true, video: true, ctx: 1_000_000, maxOut: 131_072, note: "旗舰 2.4T · 图/视频 · 1M ctx" },
      { id: "qwen3.8-flash", label: "Qwen3.8 Flash", efforts: ["off", "low", "medium", "xhigh"], defaultEffort: "medium", image: true, video: true, ctx: 1_000_000, maxOut: 131_072, note: "多模态快模 · 1M ctx" },
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
    // defaultModel 仍是 glm-5.2：本机这把 key 调 glm-5.3* 一律 1113（资源包没覆盖
    // 5.3），把默认改成 5.3 会让整家 provider 开箱即废。资源包到位后把下面这行换成
    // glm-5.3 即可，别的都不用动。
    defaultModel: "glm-5.2",
    models: [
      // 5.3 系列恒思考（thinking.type 只收 enabled）→ efforts 里没有 off；
      // 三档 low/high/max 与服务端一致（默认 max）。1M ctx / 128K max out。
      // image/video 取自官方模型页，未能实测（这把 key 调不通，见上）——按「猜错要
      // 吃 400、猜没有只退化成抽帧」的老规矩，video 一律不敢标 true。
      { id: "glm-5.3", label: "GLM-5.3", efforts: ["low", "high", "max"], image: false, ctx: 1_000_000, maxOut: 131_072, note: "旗舰 · 恒思考 · 1M ctx" },
      { id: "glm-5.3-flash", label: "GLM-5.3 Flash", efforts: ["low", "high", "max"], image: true, ctx: 1_000_000, maxOut: 131_072, note: "多模态 · 1/40 价 · 1M ctx" },
      // R1：5.2 / 5 取自智谱官方模型页（docs.bigmodel.cn/cn/guide/models/text/*，2026-09-23）：
      // GLM-5.2 1M / 128K 输出，GLM-5 200K / 128K 输出。真请求核对（09-23）：GLM-5.2 对 max_tokens=1e8
      // 回「限制数值范围[1,131072]」；GLM-5 这把 key 回 1113（资源包不含，同 5.3），没法实测，按文档。
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
      // Gemini 3 family uses thinkingLevel (no true "off"; 3.5 Flash 多一档 minimal，官方注明 minimal 也不保证完全不想);
      // 2.5 uses thinkingBudget
      // and can disable. All Gemini chat models are multimodal.
      // R1：ctx / maxOut 取自官方模型页（ai.google.dev/gemini-api/docs/models/*，2026-09-23）：
      // 三个型号都是输入 1,048,576 / 输出 65,536。真请求核对（09-23，models.get 的 inputTokenLimit /
      // outputTokenLimit）：三个型号一致。
      // Gemini 4 Argon（2026-10-13 上架）：models.get 实测 inputTokenLimit 1,048,576 / outputTokenLimit 32,768；
      // thinkingLevel 只收 LOW/MEDIUM/HIGH（MINIMAL 400）；函数调用 + google_search 同开要 includeServerSideToolInvocations（encode 已带）。
      { id: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"], image: true, ctx: 1_048_576, maxOut: 32_768, note: "旗舰 · 第四代" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", efforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium", image: true, ctx: 1_048_576, maxOut: 65_536, note: "最新 Flash · 1M ctx" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", efforts: ["low", "medium", "high"], image: true, ctx: 1_048_576, maxOut: 65_536, note: "旗舰 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", efforts: ["off", "low", "medium", "high"], image: true, ctx: 1_048_576, maxOut: 65_536, note: "稳定 · 可关思考" },
    ],
  },
  {
    // 本机 llama.cpp（llama-server），OpenAI 兼容端点。唯一一家「不过网、不花钱、
    // 断网可用」的服务；模型权重与启动脚本在 E:\LLM\，服务没起来时这一家会以
    // http 连接错误示人（不做假装可用的探活）。
    id: "local",
    name: "本机",
    baseUrl: "http://127.0.0.1:8080/v1",
    defaultModel: "qwen3.8-27b",
    models: [
      // Qwen3.8-27B UD-Q4_K_XL + MTP 投机解码头，跑在 RTX 5090 上实测 108 tok/s。
      // reasoning_effort 走 chat_template_kwargs（不是顶层字段）。R4（#40）：档位按本机 GGUF 里的
      // chat template 实测——模板只认 low / medium / xhigh，'high' 被改写成 xhigh（菜单顶档就叫
      // xhigh，与模板同名），关思考要 enable_thinking:false（发 none 会 raise_exception，整个请求被
      // 拒）。档位文字排在渲染后提示词的最前面，改档等于整段 KV 重算。契约测试
      // local-effort-contract.test.ts 对照模板本身。默认沿用改前的实际档位 xhigh。ctx / image 这里只是
      // 默认值（启动脚本的 -c 131072 + mmproj），实际由「本机」面板的启动参数覆盖，见 withLocalSettings。
      { id: "qwen3.8-27b", label: "Qwen3.8 27B", efforts: ["off", "low", "medium", "xhigh"], defaultEffort: "xhigh", image: true, ctx: 131_072, maxOut: 32_768, note: "本机 · 离线可用 · 视觉" },
      // Strata 引擎（E:\Strata，端口 8081，适配器按型号换端点：localai.ts localModelBaseUrl）跑 Qwen3.8-Flash-Next
      // 125B MoE（180B 总参 / 6B 激活）的官方 GSQ-RCO IQ3_S。id 沿用最初接入的 Orca 无审查版时起的 strata-orca（前端与旧会话都认它）。
      // 2026-10-06 同机实测：难题 43/46 与 Qwen 27B 持平，长上下文读入快约 3 倍。用的是同一套 Qwen 模板：
      // 档位同样只认 low / medium / xhigh + enable_thinking:false（serve/frontend.py EFFORT），chat_template_kwargs 照发。
      // ctx / image 由面板里 Strata 的启动参数覆盖（默认 128k、识图关——官方版的识图模块没装）。
      { id: "strata-orca", label: "Qwen3.8 Flash Next 125B", efforts: ["off", "low", "medium", "xhigh"], defaultEffort: "medium", image: false, ctx: 131_072, maxOut: 32_768, note: "本机 · 离线可用" },
    ],
  },
];

// 自定义服务（custom-providers.ts）按同一形状并进目录：只列启用的对话型号（asr / tts 这类不进菜单）；上下文、输出、视觉 /
// 视频 / 音频取型号记录（识别出来的或用户改过的）；档位表经 custom-tiers.ts 映射成七级思考档，档名不同的进 effortLabels。
function customModelSpec(m: CustomModel, protocol: CustomProvider["protocol"]): ModelSpec {
  const v = slotView(m);
  const group = m.id.includes("/") ? m.id.split("/")[0].slice(0, 40) : "";
  return {
    id: m.id,
    label: m.label || m.id,
    efforts: v.efforts,
    ...(v.defaultEffort ? { defaultEffort: v.defaultEffort } : {}),
    ...(Object.keys(v.labels).length ? { effortLabels: v.labels } : {}),
    image: m.vision,
    ...(m.video ? { video: true } : {}),
    ...(m.audio ? { audio: true } : {}),
    ctx: m.contextWindow,
    maxOut: m.maxOutput,
    ...(m.alwaysThinks ? { alwaysThinks: true, autoThinkAt: autoThinkSlots(m, protocol) } : {}),
    ...(group ? { group } : {}),
  };
}
function customSpec(c: CustomProvider): ProviderSpec {
  const chat = c.models.filter((m) => m.enabled && m.kind === "chat");
  // 一个能对话的都没有（老配置全是语音模型）：至少把默认型号留在菜单里，别让这家变成空的
  const shown = chat.length ? chat : c.models.filter((m) => m.id === c.defaultModel);
  // 管理员共享给成员的：地址不下发（成员只管用）
  const managed = isSharedProvider(c.id);
  return {
    id: c.id as ProviderId,
    name: c.name,
    ...(managed ? {} : { baseUrl: c.baseUrl }),
    defaultModel: c.defaultModel,
    custom: {
      host: managed ? "" : hostOf(c.baseUrl),
      protocol: c.protocol,
      all: c.models.length,
      ...(managed ? { managed: true } : c.shared ? { shared: true } : {}),
    },
    models: shown.map((m) => customModelSpec(m, c.protocol)),
  };
}

// 本机这家的上下文 / 视觉由「本机」面板里的启动参数决定（localai.ts）：报得比服务端 -c 大会在长会话里被截断，
// 关了视觉（没挂 mmproj）还当能看图，图片会被 llama-server 整个拒掉——改走辅助视觉。
// 两台引擎各跟各的设置（Qwen 27B ← E:\LLM\local-ai.json，Strata ← E:\Strata\local-ai.json）。
function withLocalSettings(s: ProviderSpec): ProviderSpec {
  if (s.id !== "local") return s;
  return {
    ...s,
    models: s.models.map((m) => {
      if (m.id === STRATA_MODEL) {
        const { ctx, vision } = strataSettings();
        return { ...m, ctx, image: vision, note: vision ? "本机 · 离线可用 · 视觉" : m.note };
      }
      const { ctx, vision } = localAiSettings();
      return { ...m, ctx, image: vision, note: vision ? m.note : "本机 · 离线可用" };
    }),
  };
}

// 内置八家 + 用户加的自定义服务（按添加顺序）。凡是「这个 provider 存不存在 / 有哪些型号」都从这里查。
export function allProviders(): ProviderSpec[] {
  const custom = listCustomProviders();
  return [...CATALOG.map(withLocalSettings), ...custom.map(customSpec)];
}

export function providerSpec(p: ProviderId): ProviderSpec {
  if (isCustomProviderId(p)) {
    const c = getCustomProvider(p);
    if (c) return customSpec(c);
  }
  return withLocalSettings(CATALOG.find((s) => s.id === p) ?? CATALOG[0]);
}

// R12：这家 provider 一次请求里历史图片的额度（目录没配的项取默认）。自定义服务按型号家族取（共用型号表：经第三方接的
// 小米同样只让最近 2 张工具图入模）。
export function providerMediaBudget(p: ProviderId, model?: string): { maxImages: number; maxBytes: number; keepRecent?: number } {
  const media = isCustomProviderId(p) ? (model ? MK.tableEntry(model)?.media : undefined) : CATALOG.find((s) => s.id === p)?.media;
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

// 目录外的 id（自定义服务里没登记的型号）：按共用型号表 → 名字猜（和 Claude 外接同一条视觉正则）
function guessImages(modelId: string): boolean {
  const e = MK.tableEntry(modelId);
  return typeof e?.vision === "boolean" ? e.vision : MK.VISION_RE.test(MK.bareModelId(modelId));
}

// Per-model context/output limits for adapters whose provider-level defaults
// are too coarse (see ModelSpec.ctx/maxOut). Unknown models return {}.
// 这个型号能不能开 fast mode（目录外的 id 一律不能：发了必 400）
export function modelSupportsFast(p: ProviderId, modelId: string): boolean {
  return modelSpec(p, modelId)?.fast === true;
}

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
  // 自定义服务同理推广：开 / 关式（或任何带关闭档）的型号，非关闭的请求只在非关闭档里挑（向下取，没有就取最低的非关闭档）
  if (isCustomProviderId(p) && spec && level !== "off" && efforts.some((e) => e !== "off")) {
    const on = efforts.filter((e) => e !== "off");
    const want = EFFORT_ORDER.indexOf(level);
    const below = on.filter((e) => EFFORT_ORDER.indexOf(e) <= want);
    return below.length ? below[below.length - 1] : on[0];
  }
  // 本机模板把 'high' 改写成 xhigh：旧会话 / 保存的选择 / 子 agent 覆盖里的 high 实际一直是 xhigh，
  // 照旧给 xhigh，别按「向下取」悄悄降成 medium。（旧的 max 向下取本来就落到 xhigh。）
  // Qwen3.8 不跟：旧的 high 是 thinking_budget 32k 封顶，升成不封顶的 xhigh 会悄悄放大账单，按常规向下取 medium。
  if (p === "local" && level === "high" && efforts.includes("xhigh")) return "xhigh";
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
