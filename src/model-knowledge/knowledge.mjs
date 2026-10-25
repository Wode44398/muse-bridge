// 型号知识（2026-10-21 抽出）：bridge 的 Claude 外接（src/runtime/claude-providers*.mjs）和 dimensio 的自定义服务
// （harness/server/custom-providers.ts）共用这一份——以前两边各存一张表，30 个内置型号里 10 个对不上（Sonnet 4.6 被开了
// xhigh、选了必 400）。纯函数、无依赖、不联网：服务端、两边的网页都能直接 import。
//
// 一个型号的能力按可信度从高到低取，每个字段都记来源（界面对非 api / probe / user 的值加「≈」）：
//   api     端点 /models 返回的元数据（各家字段名五花八门，宽口径读，见 fromApi）
//   table   下面的已知型号表（以 dimensio harness/server/catalog.ts 的逐型号实测为准；harness 的
//           catalog-knowledge-contract.test.ts 守着两边一致，改了一边测试就红）
//   guess   按名字猜（视觉：vl / vision / omni；非对话：asr / tts / embedding …）
//   default 什么都不知道时的兜底——由调用方给（Claude CLI 视角 200K / 32K，dimensio 的 OpenAI 兼容适配器 128K / 16K）
//
// 思考方式（thinking / efforts / effortField / effortDefault / alwaysThinks，语义见 claude-providers.mjs 文件头）由「模板」
// 按协议生成：同一个型号走 Anthropic 端点和 OpenAI 端点，开关思考的字段完全不同（小米：前者只认 thinking.type=disabled，
// 后者只认 reasoning_effort none / low / medium / high——都是实测）。
//
// 档位 { id, name, value }：value 为 null = 这一档什么都不发；字符串 / 数字 / 布尔 = 写进 effortField 指的字段；对象 =
// effortField 为空时深合并进请求体根，否则写进那个字段。budget 方式下 value 是预算（null = 按基准换算；关闭档不开思考），
// adaptive 方式下 value 是 output_config.effort（null = 只发 thinking.type=adaptive）。

export const PROTOCOLS = ['anthropic', 'openai', 'gemini'];
export const TIER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
export const MAX_TIERS = 8;
// 「关闭」档的常见名字（服务策略「始终关」找它；budget 方式下这一档不开思考；dimensio 把它放进 off 槽）
export const OFF_TIER_IDS = Object.freeze(['off', 'none', 'disabled']);
export const ON_TIER_IDS = Object.freeze(['on', 'enabled']);
const OFF_SET = new Set(OFF_TIER_IDS);
export const isOffTier = (id) => OFF_SET.has(String(id || ''));

// —— 非对话模型：语音识别 / 合成、向量、重排、生图、审核……加进来默认不启用，也不进模型菜单 ——
export const NON_CHAT_RE = /(?:^|[-_.\/:])(?:asr|tts|whisper|transcri\w*|speech|voice\w*|audio|embed\w*|rerank\w*|moderation|dall-e|imagen|image|sora|veo|ocr|realtime)(?=$|[-_.\/:\d])/i;
export const VISION_RE = /(?:^|[-_.\/])(?:vl|vision|omni)(?:$|[-_.\/])|gpt-[45]|^o\d|glm-[\d.]+v|pixtral|llava|qvq/i;

/** 比对用的裸型号：去掉 vendor/ 前缀（含 Gemini 的 models/）、:free 之类的后缀和 [1m]。 */
export function bareModelId(id) {
  return String(id || '').toLowerCase().replace(/\[1m\]$/, '').replace(/:[a-z0-9-]+$/, '').split('/').pop();
}

export function guessKind(id, apiType = '') {
  const t = String(apiType || '').toLowerCase();
  if (t && /^(embedding|embeddings|rerank|tts|asr|audio|image|moderation|speech)$/.test(t)) return 'other';
  return NON_CHAT_RE.test(bareModelId(id)) ? 'other' : 'chat';
}

// —— 思考模板 ——
const T = (id, name, value = null) => ({ id, name, value });
const OFF = (name = '关闭') => T('off', name, { thinking: { type: 'disabled' } });
const ON = (name = '开启') => T('on', name, { thinking: { type: 'enabled' } });
export const LEVEL_NAMES = Object.freeze({ minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max', none: '关闭', off: '关闭', on: '开启' });
const levels = (ids, mk = (id) => id) => ids.map((id) => T(id, LEVEL_NAMES[id] || id, mk(id)));
const think = (thinking, efforts, { field = '', dflt = '', always = false } = {}) => ({ thinking, efforts, effortField: field, effortDefault: dflt, alwaysThinks: always });
const NONE = (always = false) => think('none', [], { always });
// Gemini 原生协议：思考写在 generationConfig.thinkingConfig（3 代起 thinkingLevel，2.5 是 thinkingBudget）
const gemLevel = (lv) => ({ generationConfig: { thinkingConfig: { thinkingLevel: lv.toUpperCase(), includeThoughts: true } } });
const gemBudget = (n) => ({ generationConfig: { thinkingConfig: n === 0 ? { thinkingBudget: 0 } : { thinkingBudget: n, includeThoughts: true } } });

/**
 * 模板 → { thinking, efforts, effortField, effortDefault, alwaysThinks }。协议不对路（比如 Claude 走 OpenAI 端点）时退到
 * 通用 reasoning_effort 三档；这个协议下没有已知写法回 null。opts.dflt：型号表里记的默认档（只用在模板自己的协议上）。
 */
export function thinkingTemplate(key, protocol, opts = {}) {
  const oai = protocol === 'openai';
  const anth = protocol === 'anthropic';
  const gem = protocol === 'gemini';
  const d = (fallback = '') => opts.dflt || fallback;
  const generic = (always = false) => (oai ? think('effort', levels(['low', 'medium', 'high']), { field: 'reasoning_effort', always }) : null);
  switch (key) {
    case 'claude-adaptive':   // 官方 Messages：thinking adaptive + output_config.effort，五档、默认 high（Opus / Haiku 5.5 默认 medium）
      return anth ? think('adaptive', levels(['low', 'medium', 'high', 'xhigh', 'max']), { dflt: d('high') }) : generic();
    case 'claude-adaptive-46': // Opus / Sonnet 4.6：同上但没有 xhigh（官方 effort 文档；选了必 400）
      return anth ? think('adaptive', levels(['low', 'medium', 'high', 'max']), { dflt: d('high') }) : generic();
    case 'claude-budget':     // Haiku 4.5 及更老：只有 thinking.budget_tokens（4K / 8K / 12K，同 dimensio 适配器），可以不开
      return anth ? think('budget', [T('off', '关闭'), T('low', 'Low', 4000), T('medium', 'Medium', 8000), T('high', 'High', 12000)], { dflt: d() }) : generic();
    case 'toggle':            // thinking.type disabled / enabled（DeepSeek、GLM 的 Anthropic 端点等）
      return gem ? null : think('effort', [OFF(), ON()], { dflt: d() });
    case 'mimo':              // 小米：不发参数也会思考；只能开 / 关（Anthropic 端点 thinking.type=disabled、OpenAI 端点 reasoning_effort=none）
      if (oai) return think('effort', [T('off', '关闭', 'none'), T('on', '开启', 'high')], { field: 'reasoning_effort', always: true });
      return anth ? think('effort', [OFF(), ON()], { always: true }) : null;
    case 'deepseek':          // V4.1：thinking.type + reasoning_effort low / high / max
      return oai ? think('effort', [OFF(), ...levels(['low', 'high', 'max'], (id) => ({ thinking: { type: 'enabled' }, reasoning_effort: id }))], { dflt: d() })
        : thinkingTemplate('toggle', protocol);
    case 'deepseek-v4':       // V4 Pro（退役中）：只有 high / max
      return oai ? think('effort', [OFF(), ...levels(['high', 'max'], (id) => ({ thinking: { type: 'enabled' }, reasoning_effort: id }))], { dflt: d() })
        : thinkingTemplate('toggle', protocol);
    case 'qwen38':            // Qwen3.8：enable_thinking + reasoning_effort low / medium / xhigh（high / max 是 xhigh 的别名）
      return oai ? think('effort', [T('off', '关闭', { enable_thinking: false }), ...levels(['low', 'medium', 'xhigh'], (id) => ({ enable_thinking: true, reasoning_effort: id }))], { dflt: d() }) : null;
    case 'qwen37':            // Qwen3.7：没有 reasoning_effort，只有 thinking_budget（8K / 16K / 32K，同 dimensio 适配器）
      return oai ? think('effort', [T('off', '关闭', { enable_thinking: false }), ...[['low', 8192], ['medium', 16384], ['high', 32768]].map(([id, n]) => T(id, LEVEL_NAMES[id], { enable_thinking: true, thinking_budget: n }))], { dflt: d() }) : null;
    case 'qwen-toggle':       // 更早的 Qwen3：enable_thinking 开 / 关
      return oai ? think('effort', [T('off', '关闭', false), T('on', '开启', true)], { field: 'enable_thinking', dflt: d() }) : null;
    case 'glm53':             // GLM-5.3：恒思考，reasoning_effort low / high / max
      if (oai) return think('effort', levels(['low', 'high', 'max']), { field: 'reasoning_effort', dflt: d(), always: true });
      return anth ? NONE(true) : null;
    case 'glm52':             // GLM-5.2：thinking.type + reasoning_effort high / max
      return oai ? think('effort', [OFF(), ...levels(['high', 'max'], (id) => ({ thinking: { type: 'enabled' }, reasoning_effort: id }))], { dflt: d() })
        : thinkingTemplate('toggle', protocol);
    case 'kimi':              // Kimi K3 / K2.8：恒思考，reasoning_effort low / high / max
      if (oai) return think('effort', levels(['low', 'high', 'max']), { field: 'reasoning_effort', dflt: d(), always: true });
      return anth ? NONE(true) : null;
    case 'always':            // 恒思考、没有档位（Kimi K2.7 Highspeed：reasoning_effort 发了也被忽略）
      return NONE(true);
    case 'gemini3':           // Gemini 3 / 4：thinkingLevel low / medium / high，关不掉
      return gem ? think('effort', levels(['low', 'medium', 'high'], gemLevel), { dflt: d(), always: true }) : generic(true);
    case 'gemini35f':         // Gemini 3.5 Flash：多一档 minimal（官方注明 minimal 也不保证完全不想）
      return gem ? think('effort', levels(['minimal', 'low', 'medium', 'high'], gemLevel), { dflt: d(), always: true }) : generic(true);
    case 'gemini25':          // Gemini 2.5 Flash：thinkingBudget，0 = 关
      return gem ? think('effort', [T('off', '关闭', gemBudget(0)), T('low', 'Low', gemBudget(512)), T('medium', 'Medium', gemBudget(-1)), T('high', 'High', gemBudget(24_576))], { dflt: d() }) : generic();
    case 'gemini25pro':       // Gemini 2.5 Pro：thinkingBudget 不能为 0
      return gem ? think('effort', [T('low', 'Low', gemBudget(512)), T('medium', 'Medium', gemBudget(-1)), T('high', 'High', gemBudget(24_576))], { dflt: d(), always: true }) : generic(true);
    case 'openai':            // GPT-5 / o 系列
      return generic();
    default: return null;
  }
}

// —— 已知型号表（按裸型号匹配，先具体后笼统）——
// ctx / out：上下文 / 输出上限；vision / video / audio：能不能直接收图 / 视频 / 音频；think：思考模板；dflt：首次选中时的默认档；
// media：一次请求里历史图片的额度（dimensio agent/media-budget.ts）。值以 dimensio catalog.ts（多数实测）为准，另补了中转常见的
// 去掉 claude- 前缀的别名（opus-5-5）。只写厂商公开信息：公开版导出会做泄漏扫描。
const MIMO_MEDIA = Object.freeze({ maxImages: 2, keepRecent: 2 });   // 多图认不准最新那张：只让最近 2 张工具图入模
const GEMINI_MEDIA = Object.freeze({ maxBytes: 14_000_000 });        // 内联数据连同文字整个请求不能超过 20 MB
const TABLE = [
  // Claude：5.x、Opus 4.7+ 是 1M / 128K + adaptive 五档；Opus / Sonnet 4.6 没有 xhigh；Haiku 4.5 及更老是 200K + budget
  { re: /^(?:claude-)?haiku-4-5/, ctx: 200_000, out: 64_000, vision: true, think: 'claude-budget' },
  { re: /^(?:claude-)?(?:opus|sonnet)-4-6/, ctx: 1_000_000, out: 128_000, vision: true, think: 'claude-adaptive-46' },
  { re: /^(?:claude-)?(?:opus|haiku)-5-5/, ctx: 1_000_000, out: 128_000, vision: true, think: 'claude-adaptive', dflt: 'medium' },
  { re: /^(?:claude-)?(?:opus|sonnet|haiku|fable)-(?:[5-9]|4-[7-9])/, ctx: 1_000_000, out: 128_000, vision: true, think: 'claude-adaptive' },
  { re: /^claude-/, ctx: 200_000, out: 64_000, vision: true, think: 'claude-budget' },
  // 小米 MiMo V2.6（官方文档 1M 上下文、图 / 视频 / 音频输入；输出上限 131072 是 400 报错里读出来的；默认会思考）
  { re: /^mimo-v2\.6/, ctx: 1_000_000, out: 131_072, vision: true, video: true, audio: true, think: 'mimo', media: MIMO_MEDIA },
  { re: /^mimo-/, think: 'mimo', media: MIMO_MEDIA },
  // DeepSeek V4.1 Flash（1M / 393216，原生看图但不收视频）；v4-flash 是它的临时别名；v4-pro 退役中
  { re: /^deepseek-(?:v4-)?flash/, ctx: 1_000_000, out: 393_216, vision: true, think: 'deepseek' },
  { re: /^deepseek-v4/, ctx: 1_000_000, out: 393_216, vision: false, think: 'deepseek-v4' },
  { re: /^deepseek-/, think: 'deepseek' },
  // Qwen：3.8 全系原生多模态（图 + 视频），默认 medium（xhigh 不封顶，换档不能悄悄放大账单）
  { re: /^qwen3\.8/, ctx: 1_000_000, out: 131_072, vision: true, video: true, think: 'qwen38', dflt: 'medium' },
  { re: /^qwen3\.7-plus/, ctx: 1_000_000, out: 131_072, vision: true, think: 'qwen37' },
  { re: /^qwen3\.7/, ctx: 1_000_000, out: 131_072, vision: false, think: 'qwen37' },
  { re: /^qwen3/, think: 'qwen-toggle' },
  // 智谱 GLM
  { re: /^glm-5\.3-flash/, ctx: 1_000_000, out: 131_072, vision: true, think: 'glm53' },
  { re: /^glm-5\.3/, ctx: 1_000_000, out: 131_072, vision: false, think: 'glm53' },
  { re: /^glm-5\.2/, ctx: 1_000_000, out: 131_072, vision: false, think: 'glm52' },
  { re: /^glm-5(?!\.)/, ctx: 200_000, out: 131_072, vision: false, think: 'toggle' },
  // Kimi（Kimi for Coding；/models 实测）：k3-256k 不吃视频
  { re: /^k3-256k/, ctx: 262_144, out: 65_536, vision: true, think: 'kimi' },
  { re: /^(?:k3|kimi-for-coding)(?!-highspeed)/, ctx: 1_048_576, out: 65_536, vision: true, video: true, think: 'kimi' },
  { re: /^kimi-for-coding-highspeed/, ctx: 262_144, out: 65_536, vision: true, video: true, think: 'always' },
  // Gemini（1,048,576 / 65,536；Gemini 4 Argon 输出 32,768）
  { re: /^gemini-4/, ctx: 1_048_576, out: 32_768, vision: true, think: 'gemini3', media: GEMINI_MEDIA },
  { re: /^gemini-3\.5-flash/, ctx: 1_048_576, out: 65_536, vision: true, think: 'gemini35f', dflt: 'medium', media: GEMINI_MEDIA },
  { re: /^gemini-3/, ctx: 1_048_576, out: 65_536, vision: true, think: 'gemini3', media: GEMINI_MEDIA },
  { re: /^gemini-2\.5-pro/, ctx: 1_048_576, out: 65_536, vision: true, think: 'gemini25pro', media: GEMINI_MEDIA },
  { re: /^gemini-2\.5/, ctx: 1_048_576, out: 65_536, vision: true, think: 'gemini25', media: GEMINI_MEDIA },
  { re: /^gemini-2/, ctx: 1_048_576, out: 65_536, vision: true, media: GEMINI_MEDIA },
  // OpenAI 推理模型
  { re: /^(?:gpt-5|o\d)/, vision: true, think: 'openai' },
];

/** 已知型号表里这一条（不认识回 null）。 */
export function tableEntry(id) {
  const bare = bareModelId(id);
  return TABLE.find((e) => e.re.test(bare)) || null;
}

const posInt = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };

/** /models 一项的元数据 → 能力（读不到的字段回 undefined）。 */
export function fromApi(x) {
  if (!x || typeof x !== 'object') return {};
  const tp = x.top_provider || {};
  const caps = x.capabilities || {};
  const arch = x.architecture || {};
  const meta = x.meta || {};
  const out = {};
  const ctx = posInt(x.context_length) || posInt(x.context_window) || posInt(x.max_context_length) || posInt(x.max_model_len)
    || posInt(x.max_input_tokens) || posInt(x.inputTokenLimit) || posInt(tp.context_length) || posInt(meta.n_ctx_train);
  if (ctx) out.contextWindow = ctx;
  const mo = posInt(x.max_output_tokens) || posInt(x.max_completion_tokens) || posInt(tp.max_completion_tokens) || posInt(x.outputTokenLimit)
    || (x.max_input_tokens ? posInt(x.max_tokens) : null);   // Anthropic Models API：max_tokens 与 max_input_tokens 成对出现
  if (mo) out.maxOutput = mo;
  const inMods = Array.isArray(arch.input_modalities) ? arch.input_modalities : Array.isArray(x.input_modalities) ? x.input_modalities : null;
  if (caps.image_input && typeof caps.image_input === 'object' && typeof caps.image_input.supported === 'boolean') out.vision = caps.image_input.supported;
  else if (inMods) out.vision = inMods.includes('image');
  else if (typeof caps.vision === 'boolean') out.vision = caps.vision;
  else if (typeof x.supports_image_in === 'boolean') out.vision = x.supports_image_in;
  else if (x.type === 'vlm') out.vision = true;
  if (inMods && inMods.includes('video')) out.video = true;
  if (inMods && inMods.includes('audio')) out.audio = true;
  const outMods = Array.isArray(arch.output_modalities) ? arch.output_modalities : Array.isArray(x.output_modalities) ? x.output_modalities : null;
  if (outMods && outMods.length && !outMods.includes('text')) out.kind = 'other';
  // Gemini 的 models.list：不支持 generateContent 的（向量、生图……）不是对话模型
  if (Array.isArray(x.supportedGenerationMethods) && x.supportedGenerationMethods.length && !x.supportedGenerationMethods.includes('generateContent')) out.kind = 'other';
  const sp = Array.isArray(x.supported_parameters) ? x.supported_parameters : null;
  const thinkTypes = caps.thinking && Array.isArray(caps.thinking.types) ? caps.thinking.types : null;
  if (thinkTypes) out.reasoning = thinkTypes.length > 0;
  else if (sp) out.reasoning = sp.includes('reasoning') || sp.includes('reasoning_effort') || sp.includes('include_reasoning');
  else if (typeof x.supports_reasoning === 'boolean') out.reasoning = x.supports_reasoning;
  else if (typeof x.thinking === 'boolean') out.reasoning = x.thinking;   // Gemini models.get
  // 接口直接给了档位（Kimi 的 think_efforts、Anthropic 的 capabilities.effort）
  const effList = Array.isArray(x.think_efforts) ? x.think_efforts
    : caps.effort && typeof caps.effort === 'object' ? Object.keys(caps.effort).filter((k) => caps.effort[k] && caps.effort[k].supported !== false) : null;
  if (effList && effList.length) out.effortIds = effList.map(String).filter((s) => TIER_ID_RE.test(s)).slice(0, MAX_TIERS);
  if (x.supports_thinking_type === 'only') out.alwaysThinks = true;
  return out;
}

/** /models 响应 → 条目数组（{data:[…]} / {models:[…]} / 裸数组三种形状；认不出回 null）。 */
export function parseModelList(j) {
  return Array.isArray(j && j.data) ? j.data : Array.isArray(j && j.models) ? j.models : Array.isArray(j) ? j : null;
}
/** 条目 → 型号 id（Gemini 的 models/ 前缀去掉）；取不到回 ''。 */
export function modelIdOf(x) {
  const raw = typeof x === 'string' ? x : x && typeof x === 'object' ? (typeof x.id === 'string' && x.id) || (typeof x.name === 'string' && x.name) || '' : '';
  return String(raw).replace(/^models\//, '').trim().slice(0, 200);
}
/** 条目 → 显示名。 */
export function labelOf(x, id) {
  const raw = x && typeof x === 'object' ? x.display_name || x.displayName || x.name || id : id;
  return String(raw || id).replace(/^models\//, '').slice(0, 80);
}

/**
 * 综合三层，给一个型号的能力猜测（拉取模型列表、加模型、读老配置都用它）。
 * 回 { kind, contextWindow, maxOutput, vision, video, audio, thinking, efforts, effortField, effortDefault, alwaysThinks, source:{…} }。
 * defaults：什么都不知道时的上下文 / 输出兜底，按调用方的视角给（不给 = Claude CLI 的 200K / 32K）。
 */
export function guessModel(id, { protocol = 'anthropic', api = null, defaults = null } = {}) {
  const dCtx = (defaults && posInt(defaults.contextWindow)) || 200_000;
  const dOut = (defaults && posInt(defaults.maxOutput)) || 32_000;
  const a = api ? fromApi(api) : {};
  const e = tableEntry(id);
  const source = {};
  const pick = (k, apiV, tblV, guessV, dflt) => {
    if (apiV !== undefined && apiV !== null) { source[k] = 'api'; return apiV; }
    if (tblV !== undefined && tblV !== null) { source[k] = 'table'; return tblV; }
    if (guessV !== undefined && guessV !== null) { source[k] = 'guess'; return guessV; }
    source[k] = 'default'; return dflt;
  };
  const kind = a.kind === 'other' ? 'other' : guessKind(id, api && api.type);
  const contextWindow = pick('contextWindow', a.contextWindow, e && e.ctx, null, dCtx);
  const maxOutput = pick('maxOutput', a.maxOutput, e && e.out, null, dOut);
  const vision = pick('vision', a.vision, e && e.vision, VISION_RE.test(bareModelId(id)) ? true : null, false);
  // 视频 / 音频只认接口声明和型号表（猜错要吃 400，猜没有只退化成抽帧 / 转写）
  const video = a.video === true || !!(e && e.video);
  const audio = a.audio === true || !!(e && e.audio);
  let th = e && e.think ? thinkingTemplate(e.think, protocol, { dflt: e.dflt }) : null;
  if (th) source.thinking = 'table';
  if (!th && a.effortIds && a.effortIds.length) {
    const field = protocol === 'openai' ? 'reasoning_effort' : protocol === 'gemini' ? 'generationConfig.thinkingConfig.thinkingLevel' : 'output_config.effort';
    th = think('effort', levels(a.effortIds, protocol === 'gemini' ? (x) => x.toUpperCase() : (x) => x), { field, always: !!a.alwaysThinks });
    source.thinking = 'api';
  }
  if (!th && a.reasoning === true) {
    th = thinkingTemplate(protocol === 'openai' ? 'openai' : protocol === 'gemini' ? 'gemini3' : 'toggle', protocol);
    if (th) source.thinking = 'api';
  }
  if (!th) { th = NONE(!!a.alwaysThinks); source.thinking = 'default'; }
  if (a.alwaysThinks) th.alwaysThinks = true;
  return { kind, contextWindow, maxOutput, vision, video, audio, ...th, source };
}

// —— 地址与协议 ——
// 已知的「地址配错」：小米 Token Plan 的 /v1 是 OpenAI 兼容地址，Anthropic 协议要用同站的 /anthropic（实测）。
// 老配置（协议 anthropic + …/v1）读进来时就地改正，不然每条消息都是上游 404。只收实测过的主机。
const ANTHROPIC_HOME = [
  { host: /(^|\.)xiaomimimo\.com$/i, path: '/anthropic' },
];
export function fixKnownBaseUrl(protocol, baseUrl) {
  if (protocol !== 'anthropic') return baseUrl;
  let u; try { u = new URL(baseUrl); } catch { return baseUrl; }
  const hit = ANTHROPIC_HOME.find((h) => h.host.test(u.hostname));
  if (!hit || !/^\/v1\/?$/.test(u.pathname)) return baseUrl;
  return u.origin + hit.path;
}

/** 同一站点上「另一种协议」可能的地址（一键识别协议时挨个试）：…/v1 ⇄ …/anthropic、根下的 /v1 与 /anthropic。 */
export function siblingBaseUrls(baseUrl) {
  let u; try { u = new URL(String(baseUrl).replace(/\/+$/, '')); } catch { return []; }
  const base = u.origin + u.pathname.replace(/\/+$/, '');
  const out = new Set([base]);
  if (/\/v1$/.test(base)) { out.add(base.replace(/\/v1$/, '/anthropic')); out.add(base.replace(/\/v1$/, '')); }
  if (/\/anthropic$/.test(base)) { out.add(base.replace(/\/anthropic$/, '/v1')); out.add(base.replace(/\/anthropic$/, '')); }
  out.add(u.origin + '/v1');
  out.add(u.origin + '/anthropic');
  return [...out];
}

/** 各协议的请求地址：Anthropic 的 base 可以带也可以不带 /v1（不会拼出 /v1/v1）；OpenAI 直接接；Gemini 按型号拼。 */
export function anthropicUrl(base, sub) { return /\/v1$/.test(base) ? base + sub.replace(/^\/v1/, '') : base + sub; }
export function openaiUrl(base, sub) { return base + sub; }
export function geminiUrl(base, model, stream = false) {
  return `${base}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
}
/** 编辑器里实时显示的「实际请求」。 */
export function endpointUrl(protocol, base, model = '') {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (protocol === 'openai') return openaiUrl(b, '/chat/completions');
  if (protocol === 'gemini') return geminiUrl(b, model || '{model}', true).replace('%7Bmodel%7D', '{model}');
  return anthropicUrl(b, '/v1/messages');
}
/** 拉模型列表要试的地址：主地址 + 404 后的备选（Anthropic 端点下常常没有 /models，小米、DeepSeek 一类去同站的 OpenAI 兼容地址拉）。 */
export function modelsUrlCandidates(protocol, base) {
  const b = String(base || '').replace(/\/+$/, '');
  let origin = ''; try { origin = new URL(b).origin; } catch {}
  if (protocol === 'gemini') return [b + '/models?pageSize=1000'];
  const primary = protocol === 'openai' ? openaiUrl(b, '/models') : anthropicUrl(b, '/v1/models?limit=1000');
  const alts = [
    /\/anthropic$/.test(b) ? b.replace(/\/anthropic$/, '/v1') + '/models' : '',
    b + '/models', b + '/v1/models', origin ? origin + '/v1/models' : '',
  ];
  return [...new Set([primary, ...alts].filter(Boolean))];
}
/**
 * 地址和协议对不上 → { to, alt, sure }；看不出毛病回 null。
 * sure = 说得准（实测过的站，或路径本身就说明了协议）：编辑器可以断言「会 404」并给一键改。
 * anthropic + …/v1 只在实测过的站（ANTHROPIC_HOME，小米）上 sure——new-api / one-api 一类中转的 …/v1/messages 本来就是
 * Anthropic 接口，别的站只提示「不确定就检测连接」，不给一键改地址。
 */
export function protocolMismatch(protocol, baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  let host = '';
  try { host = new URL(b).hostname; } catch { return null; }
  if (protocol === 'anthropic' && /\/v1$/.test(b) && host !== 'api.anthropic.com') {
    const known = ANTHROPIC_HOME.find((h) => h.host.test(host));
    return known ? { to: 'openai', alt: new URL(b).origin + known.path, sure: true } : { to: 'openai', alt: b.replace(/\/v1$/, '/anthropic'), sure: false };
  }
  if (protocol === 'openai' && /\/anthropic$/.test(b)) return { to: 'anthropic', alt: b.replace(/\/anthropic$/, '/v1'), sure: true };
  if (protocol === 'openai' && /generativelanguage\.googleapis\.com$/.test(host) && !/\/openai$/.test(b)) return { to: 'gemini', alt: b, sure: true };
  if (protocol === 'gemini' && /\/openai$/.test(b)) return { to: 'openai', alt: b, sure: true };
  return null;
}

// —— 档位写进请求 ——
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function deepMerge(base, extra) {
  if (!isObj(extra)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (BAD_KEYS.has(k)) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}
// 点分路径写值：中间层不是对象就建一个；值和已有的都是对象就深合并
export function setPath(obj, path, value) {
  const keys = String(path || '').split('.').filter(Boolean);
  if (!keys.length || keys.some((k) => BAD_KEYS.has(k))) return obj;
  let o = obj;
  for (const k of keys.slice(0, -1)) { o[k] = isObj(o[k]) ? { ...o[k] } : {}; o = o[k]; }
  const last = keys[keys.length - 1];
  o[last] = isObj(value) && isObj(o[last]) ? deepMerge(o[last], value) : value;
  return obj;
}
export const tierOf = (model, id) => ((model && model.efforts) || []).find((t) => t.id === id) || null;
/** effort 方式默认写哪个字段。 */
export function defaultTierField(protocol) {
  return protocol === 'openai' ? 'reasoning_effort' : protocol === 'gemini' ? 'generationConfig.thinkingConfig.thinkingLevel' : 'output_config.effort';
}
// effort 方式的写法：值是对象且没指定字段 → 深合并进请求体根；否则写进字段（没指定按协议默认）
export function writeTier(body, model, tier, protocol) {
  if (!tier || tier.value === null || tier.value === undefined) return body;
  const field = (model && model.effortField) || '';
  if (!field && isObj(tier.value)) return deepMerge(body, tier.value);
  return setPath({ ...body }, field || defaultTierField(protocol), tier.value);
}
// budget 方式档位值留空时，按档名换算预算（基准默认 16000）
export const BUDGET_SCALE = Object.freeze({ minimal: 0.0625, low: 0.125, medium: 0.5, high: 1, xhigh: 2, max: 4 });

/**
 * 把一档写进请求体（不改原对象）。budget / adaptive 是 Anthropic Messages 的写法（body.max_tokens、thinking、output_config）；
 * effort 按协议写字段或深合并。cap：输出上限的天花板（budget 方式要把 max_tokens 抬到预算之上）；baseBudget：预算基准。
 * 档位不在表里、或这一档的值为空 → 原样返回（什么都不发）。
 */
export function applyTier(body, model, tierId, { protocol = 'anthropic', cap = 0, baseBudget = 16_000 } = {}) {
  const tier = tierOf(model, tierId);
  if (!tier) return body;
  if (model.thinking === 'budget') {
    if (isOffTier(tier.id)) return body;   // 关闭档：不开思考
    const ceil = cap || model.maxOutput || 32_000;
    let budget = typeof tier.value === 'number' && tier.value > 0 ? Math.round(tier.value) : Math.round(baseBudget * (BUDGET_SCALE[tier.id] || 1));
    budget = Math.max(1024, budget);
    const b = { ...body };
    // Anthropic 要求 budget < max_tokens：输出上限不够就往上抬（不超天花板），还不够就压预算
    if (!(b.max_tokens > budget + 1024)) b.max_tokens = Math.min(ceil, budget + 4096);
    if (budget >= b.max_tokens) budget = Math.max(1024, b.max_tokens - 1024);
    if (budget < b.max_tokens) b.thinking = { type: 'enabled', budget_tokens: budget };
    return b;
  }
  if (model.thinking === 'adaptive') {
    let b = { ...body, thinking: { type: 'adaptive' } };
    if (isObj(tier.value)) b = deepMerge(b, tier.value);
    else if (tier.value !== null && tier.value !== undefined) b.output_config = { ...(isObj(b.output_config) ? b.output_config : {}), effort: tier.value };
    return b;
  }
  if (model.thinking === 'effort') return writeTier(body, model, tier, protocol);
  return body;
}
