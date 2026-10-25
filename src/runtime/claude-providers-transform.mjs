// 自定义 API 的请求 / 响应改写（纯函数，无网络——单测见 claude-providers.test.mjs）。
//
//   applyParams(body, provider, model, effort)   CLI 发来的 Anthropic Messages 请求 → 按服务 / 模型配置改写
//   toOpenAI(body, provider, model)              Anthropic Messages 请求 → OpenAI Chat Completions 请求
//   OpenAIStream                                 OpenAI 流式分块 → Anthropic SSE 事件（逐块喂、逐段吐）
//   fromOpenAI(json, model)                      OpenAI 非流式响应 → Anthropic message
//
// 参数优先级：CLI 原值 < 服务级默认 < 模型级覆盖 < 思考档位 < 额外请求体（最后深合并，用户说了算）。
//
// 思考（2026-10-21 改成按模型的档位表，见 claude-providers.mjs 文件头）：CLI 自己带的 thinking / output_config 一律不转发，
// 只发这一轮选中那一档的值；没选、选的不在这个模型的档位表里（比如从官方模型带过来的 xhigh）→ 用模型的默认档，
// 默认档也没有 = 什么都不发（厂商默认）。档位值在协议翻译之后才写：OpenAI 协议写进翻译后的请求（openAIReasoning）。

// 档位怎么写进请求（budget / adaptive / effort）、深合并、点分路径写值都在共用的型号知识模块里（dimensio 的自定义服务同一份）。
import { deepMerge, setPath, tierOf, writeTier, applyTier, OFF_TIER_IDS } from '../model-knowledge/knowledge.mjs';
export { deepMerge, setPath };
// 「关闭」档的常见名字：服务策略「始终关」找它，「始终开」跳过它
const OFF_TIERS = new Set(OFF_TIER_IDS);
// 第三方多半不认、开着「精简请求」时去掉的顶层字段（官方专属能力）。
const SLIM_FIELDS = ['context_management', 'container', 'mcp_servers', 'output_config', 'service_tier', 'betas'];
// CLI 2.1.299 起每个请求都带 safeguards（家目录、用户名、权限规则、git 状态，约 3KB 的分类器上下文）——
// 只该给 Anthropic 自己看，一律不发给第三方；metadata（含账号 user_id）同理，官方端点才转发。
const PRIVATE_FIELDS = ['safeguards'];
// 离了 anthropic-beta 头就 400「Extra inputs are not permitted」的字段：去掉 beta 头时跟着去掉
//（2026-10-23 官方 API 实测：CLI 每轮都带 context_management，只剥头不剥它 → 每条消息都 400）。
const BETA_FIELDS = ['context_management', 'mcp_servers', 'container'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// 模型级覆盖压在服务级默认上（null / 空 = 沿用服务级）。
export function effectiveParams(provider, model) {
  const a = provider.params || {}, b = (model && model.params) || {};
  const pick = (k) => (b[k] !== null && b[k] !== undefined ? b[k] : a[k] ?? null);
  const extra = [a.extraBody, b.extraBody].filter(Boolean).map((t) => { try { return JSON.parse(t); } catch { return null; } }).filter(isObj);
  return {
    maxTokens: pick('maxTokens'), temperature: pick('temperature'), topP: pick('topP'), topK: pick('topK'),
    thinking: pick('thinking') || 'auto', thinkingBudget: pick('thinkingBudget'),
    stop: [...new Set([...(a.stop || []), ...(b.stop || [])])].slice(0, 8),
    extra: extra.reduce((acc, o) => deepMerge(acc, o), {}),
  };
}

/**
 * 这一轮用哪一档（档位 id；'' = 什么都不发）。服务 / 模型策略：off 用「关闭」档（没有就不发）；
 * on 没选或选的是关闭档时用默认档、默认档也是空 / 关闭就用最高档；auto 跟会话，没选用默认档。
 */
export function tierFor(params, model, effort) {
  const tiers = (model && model.efforts) || [];
  if (!tiers.length) return '';
  const has = (id) => !!id && tiers.some((t) => t.id === id);
  if (params.thinking === 'off') return (tiers.find((t) => OFF_TIERS.has(t.id)) || {}).id || '';
  const pick = has(effort) ? effort : has(model.effortDefault) ? model.effortDefault : '';
  if (params.thinking === 'on' && (!pick || OFF_TIERS.has(pick))) {
    const on = tiers.filter((t) => !OFF_TIERS.has(t.id));
    return on.length ? on[on.length - 1].id : pick;
  }
  return pick;
}

/** 请求里的模型名 → 这个服务的真实模型（会话主模型 / 后台小任务模型 / 其它一律回主模型）。 */
export function mapModel(requested, provider, mainModelId) {
  const ids = new Set(provider.models.filter((m) => m.enabled).map((m) => m.id));
  if (requested && ids.has(requested)) return requested;
  if (/haiku/i.test(String(requested || '')) && provider.fastModel && ids.has(provider.fastModel)) return provider.fastModel;
  return mainModelId;
}

// —— 子 agent 各自选档（动态工作流 agent({effort}) / Agent 工具 effort）——
// CLI 把每个请求的档位写在 output_config.effort（官方五档；它不认识的第三方型号一律当作 xhigh / max 都支持，不会被夹）。
// 主会话也显式给 CLI 一档 sessionLevel = levelForTier(主模型, 本轮档位)：请求带的正是这一档 = 主循环或没指定档位、继承下来的子 agent，
// 照用路径里的档位（用户在输入框选的那档，含「默认」）；带的是别的档 = 子 agent 自己挑的，换算成目标模型档位表里对应的一档。
export const CLI_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const onTiers = (model) => ((model && model.efforts) || []).filter((t) => !OFF_TIERS.has(t.id));

/** 模型的一档 → 官方五档里最接近的一档（同名直接用，否则按在「开着的档」里的相对位置）。 */
export function levelForTier(model, tierId) {
  const id = tierId || (model && model.effortDefault) || '';
  if (OFF_TIERS.has(id)) return 'low';
  if (CLI_LEVELS.includes(id)) return id;
  const on = onTiers(model);
  const i = on.findIndex((t) => t.id === id);
  if (i < 0 || on.length < 2) return 'high';
  return CLI_LEVELS[Math.round((i / (on.length - 1)) * (CLI_LEVELS.length - 1))];
}

/** 官方五档的一档 → 这个模型档位表里的一档（同名直接用，否则按相对位置）；表空 / 认不出 → ''（模型默认档）。 */
export function tierForLevel(model, level) {
  const on = onTiers(model);
  const lv = String(level || '').toLowerCase();
  if (!on.length || !lv) return '';
  const same = on.find((t) => t.id.toLowerCase() === lv);
  if (same) return same.id;
  const i = CLI_LEVELS.indexOf(lv);
  if (i < 0) return '';
  return on[Math.round((i / (CLI_LEVELS.length - 1)) * (on.length - 1))].id;
}

/**
 * 这个请求实际发给谁、用哪档。lookup(name) 按模型名在所有启用的服务里找（动态工作流 agent({model:'mimo-v2.6-flash'})，
 * CLI 原样写进 body.model）；找到别的服务就跨服务转过去，routed=true（fast 只给会话自己的服务）。
 * 没找到 = 本服务内照旧（主模型 / 小任务模型 / 其它回主模型）。
 */
export function pickTarget(body, provider, model, effort, lookup) {
  const oc = body && body.output_config;
  const level = isObj(oc) && typeof oc.effort === 'string' ? oc.effort.toLowerCase() : '';
  const hit = lookup && body && body.model ? lookup(body.model) : null;
  if (hit && hit.provider.id !== provider.id) return { provider: hit.provider, model: hit.model, effort: level ? tierForLevel(hit.model, level) : '', routed: true };
  const target = (hit && hit.model) || provider.models.find((m) => m.id === mapModel(body && body.model, provider, model.id)) || model;
  const isMain = target.id === model.id;
  const inherit = !level || level === levelForTier(model, effort);
  return { provider, model: target, effort: isMain && inherit ? effort : level ? tierForLevel(target, level) : '', routed: false };
}

function stripBlocks(content, pred) { return Array.isArray(content) ? content.filter((b) => !pred(b)) : content; }
const IMAGE_NOTE = '[图片：当前模型不支持图像输入，已省略]';

// 不认图片的模型：图片块（含 tool_result 里的）换成一句话。
function dropImages(messages) {
  const fix = (content) => (Array.isArray(content) ? content.map((b) => {
    if (b && b.type === 'image') return { type: 'text', text: IMAGE_NOTE };
    if (b && b.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: fix(b.content) };
    return b;
  }) : content);
  return messages.map((m) => ({ ...m, content: fix(m.content) }));
}

function dropCacheControl(v) {
  if (Array.isArray(v)) return v.map(dropCacheControl);
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (k !== 'cache_control') out[k] = dropCacheControl(x);
  return out;
}

/**
 * CLI 的 Anthropic Messages 请求 → 按配置改写后的请求（仍是 Anthropic 形状；OpenAI 协议再过 toOpenAI）。
 * model：本轮模型的配置（会话选的那个）；effort：会话选的档位 id（空 = 没选）。回 { body, model: 实际模型, effort: 实际档位 id }。
 */
export function applyParams(body, provider, model, effort) {
  let b = { ...body };
  const target = provider.models.find((m) => m.id === mapModel(b.model, provider, model.id)) || model;
  b.model = target.id;
  const p = effectiveParams(provider, target);
  // 输出上限：参数优先，否则 CLI 要的值，都不超过模型上限
  const cap = target.maxOutput || 32_000;
  b.max_tokens = Math.min(p.maxTokens || b.max_tokens || cap, cap);
  // 思考：CLI 自己的 thinking / output_config 不转发，下面按档位重写（精简请求之后，免得被精简掉）
  const tierId = tierFor(p, target, effort);
  delete b.thinking;
  if (isObj(b.output_config)) {   // 只拿掉 effort，output_config 里别的（结构化输出的 format 之类）留着
    const { effort: _drop, ...rest } = b.output_config;
    if (Object.keys(rest).length) b.output_config = rest; else delete b.output_config;
  }
  // 采样参数（只在配置了时下发）
  if (p.temperature !== null) b.temperature = p.temperature;
  if (p.topP !== null) b.top_p = p.topP;
  if (p.topK !== null) b.top_k = p.topK;
  if (p.stop.length) b.stop_sequences = [...new Set([...(b.stop_sequences || []), ...p.stop])].slice(0, 8);
  // 兼容裁剪
  const c = provider.compat || {};
  if (Array.isArray(b.messages)) {
    if (!target.vision) b.messages = dropImages(b.messages);
    // 只在模型确实不会思考时剥历史思考块（「不思考」只是不发参数；小米这类不发参数也会想，剥了反而丢上下文）
    if (c.stripThinkingHistory || (target.thinking === 'none' && !target.alwaysThinks)) {
      b.messages = b.messages.map((m) => {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
        const content = stripBlocks(m.content, (x) => x && (x.type === 'thinking' || x.type === 'redacted_thinking'));
        return { ...m, content: content.length ? content : [{ type: 'text', text: '…' }] };
      });
    }
  }
  if (!c.promptCaching) { b = dropCacheControl(b); }
  if (c.slimBody) {
    for (const k of SLIM_FIELDS) delete b[k];
    // 官方的服务端工具（web_search_2025… 等带 type 的）第三方跑不了
    if (Array.isArray(b.tools)) b.tools = b.tools.filter((t) => !t || !t.type || t.type === 'custom');
    if (Array.isArray(b.tools) && !b.tools.length) { delete b.tools; delete b.tool_choice; }
  }
  if (!keepsBetas(provider)) for (const k of BETA_FIELDS) delete b[k];
  for (const k of PRIVATE_FIELDS) delete b[k];
  // 官方端点的 fast mode 只由模型菜单的开关决定（代理按 .f 段加 speed 与 beta 头）：CLI 或额外请求体里带的 speed 一律不算，
  // 不然手写在额外请求体里的 "speed":"fast" 关不掉、还缺 beta 头
  const official = isOfficial(provider);
  if (official) delete b.speed;
  if (!official) delete b.metadata;
  // 档位：budget / adaptive 是 Anthropic 形状（预算 < max_tokens，不够就往上抬、不超模型上限；budget 方式的关闭档不开思考）；
  // effort 方式在 Anthropic 协议这里写，OpenAI 协议翻译后再写（openAIReasoning）
  if (tierId && (target.thinking !== 'effort' || provider.protocol !== 'openai')) {
    b = applyTier(b, target, tierId, { protocol: 'anthropic', cap, baseBudget: p.thinkingBudget || 16_000 });
  }
  const extra = official && p.extra && 'speed' in p.extra ? (({ speed: _s, ...rest }) => rest)(p.extra) : p.extra;
  return { body: deepMerge(b, extra), model: target, effort: tierId };
}

// 官方端点（预设 anthropic 或 api.anthropic.com）：metadata 照常转发
export function isOfficial(provider) {
  if (provider.preset === 'anthropic') return true;
  try { return new URL(provider.baseUrl).hostname === 'api.anthropic.com'; } catch { return false; }
}
/** 转发 CLI 的 anthropic-beta 头：没开「去掉 beta 请求头」，或者就是官方端点（CLI 的 beta 官方全认，剥了反而 400）。 */
export const keepsBetas = (provider) => !(provider.compat && provider.compat.stripBetas) || isOfficial(provider);

// —— Anthropic → OpenAI ——
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');
// OpenAI 侧的 tool_call id 只要和同一请求里的 tool 消息对得上；统一洗成安全字符。
const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'call_' + Math.random().toString(36).slice(2, 10);

function imagePart(b) {
  const s = b.source || {};
  if (s.type === 'base64') return { type: 'image_url', image_url: { url: `data:${s.media_type || 'image/png'};base64,${s.data}` } };
  if (s.type === 'url') return { type: 'image_url', image_url: { url: s.url } };
  return null;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((x) => (x && x.type === 'text' ? x.text : x && x.type === 'image' ? '[图片]' : '')).filter(Boolean).join('\n');
}

export function toOpenAI(body, provider, model) {
  const out = { model: body.model, stream: !!body.stream };
  const msgs = [];
  const sys = typeof body.system === 'string' ? body.system : textOf(body.system);
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of body.messages || []) {
    if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
      const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      const calls = blocks.filter((b) => b && b.type === 'tool_use').map((b) => ({ id: safeId(b.id), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      // 回传上一轮思考：兼容里开了，或模型标了「不发参数也会思考」（小米 / Kimi 一类，思考模式下多轮工具调用不带回去会 400）
      if (provider.compat?.replayReasoning || model.alwaysThinks) {
        const r = blocks.filter((b) => b && b.type === 'thinking').map((b) => b.thinking).join('');
        if (r || calls.length) msg.reasoning_content = r;
      }
      msgs.push(msg);
      continue;
    }
    // user：tool_result 先拆成 tool 消息（必须紧跟带 tool_calls 的 assistant），剩下的拼一条 user
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    const parts = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'tool_result') {
        msgs.push({ role: 'tool', tool_call_id: safeId(b.tool_use_id), content: (b.is_error ? '[error] ' : '') + toolResultText(b.content) });
        // 工具结果里的图片：OpenAI 的 tool 消息装不下，补成一条 user 图片
        if (model.vision && Array.isArray(b.content)) for (const x of b.content) if (x && x.type === 'image') { const ip = imagePart(x); if (ip) parts.push(ip); }
      } else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') { const ip = model.vision ? imagePart(b) : null; parts.push(ip || { type: 'text', text: IMAGE_NOTE }); }
    }
    if (parts.length) msgs.push({ role: 'user', content: parts.every((x) => x.type === 'text') ? parts.map((x) => x.text).join('\n') : parts });
  }
  out.messages = msgs;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.filter((t) => t && t.name).map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
    const tc = body.tool_choice;
    if (tc && tc.type === 'any') out.tool_choice = 'required';
    else if (tc && tc.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc && tc.type === 'none') out.tool_choice = 'none';
  }
  out[provider.compat?.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens'] = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.top_k !== undefined) out.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences.slice(0, 4);
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

/** OpenAI 协议：把选中那一档写进翻译后的请求（effort 方式才写；tierId 来自 applyParams 的返回）。 */
export function openAIReasoning(out, model, tierId) {
  if (model.thinking !== 'effort' || !tierId) return out;
  return writeTier(out, model, tierOf(model, tierId), 'openai');
}

const STOP_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };
const usageOf = (u) => ({
  input_tokens: (u && (u.prompt_tokens ?? u.input_tokens)) || 0,
  output_tokens: (u && (u.completion_tokens ?? u.output_tokens)) || 0,
  ...(u && u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens ? { cache_read_input_tokens: u.prompt_tokens_details.cached_tokens } : {}),
});

/** OpenAI 非流式响应 → Anthropic message。 */
export function fromOpenAI(json, modelId) {
  const ch = (json && json.choices && json.choices[0]) || {};
  const msg = ch.message || {};
  const content = [];
  const reasoning = msg.reasoning_content || msg.reasoning;
  if (reasoning) content.push({ type: 'thinking', thinking: String(reasoning), signature: '' });
  if (msg.content) content.push({ type: 'text', text: String(msg.content) });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = c.function && c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = { _raw: c.function.arguments }; }
    content.push({ type: 'tool_use', id: safeId(c.id), name: c.function ? c.function.name : '', input });
  }
  return {
    id: 'msg_' + (json.id || Date.now().toString(36)).toString().replace(/[^A-Za-z0-9_]/g, ''),
    type: 'message', role: 'assistant', model: modelId, content,
    stop_reason: STOP_MAP[ch.finish_reason] || 'end_turn', stop_sequence: null,
    usage: usageOf(json.usage),
  };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * OpenAI 流式分块 → Anthropic SSE。用法：for 每个 data JSON → push(json) 得到要写回的字符串；结束 → end()。
 * 思考（reasoning_content / reasoning）→ thinking 块；正文 → text 块；tool_calls → tool_use 块（参数走 input_json_delta）。
 */
export class OpenAIStream {
  constructor(modelId) {
    this.model = modelId;
    this.started = false;
    this.block = null;        // { kind:'thinking'|'text'|'tool', index, key? }
    this.index = -1;
    this.tools = new Map();   // openai tool index → our block index
    this.stop = null;
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.done = false;
  }
  #start() {
    if (this.started) return '';
    this.started = true;
    return sse('message_start', { type: 'message_start', message: { id: 'msg_' + Date.now().toString(36), type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  #close() {
    if (!this.block) return '';
    const s = sse('content_block_stop', { type: 'content_block_stop', index: this.block.index });
    this.block = null;
    return s;
  }
  #open(kind, contentBlock, key) {
    let s = this.#close();
    this.index += 1;
    this.block = { kind, index: this.index, key };
    s += sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: contentBlock });
    return s;
  }
  push(json) {
    let s = this.#start();
    if (json && json.usage) this.usage = usageOf(json.usage);
    const ch = json && json.choices && json.choices[0];
    if (!ch) return s;
    const d = ch.delta || {};
    const reasoning = d.reasoning_content ?? d.reasoning;
    if (reasoning) {
      if (!this.block || this.block.kind !== 'thinking') s += this.#open('thinking', { type: 'thinking', thinking: '', signature: '' });
      s += sse('content_block_delta', { type: 'content_block_delta', index: this.block.index, delta: { type: 'thinking_delta', thinking: String(reasoning) } });
    }
    if (d.content) {
      if (!this.block || this.block.kind !== 'text') s += this.#open('text', { type: 'text', text: '' });
      s += sse('content_block_delta', { type: 'content_block_delta', index: this.block.index, delta: { type: 'text_delta', text: String(d.content) } });
    }
    for (const tc of d.tool_calls || []) {
      const ti = Number.isInteger(tc.index) ? tc.index : this.tools.size;
      if (!this.tools.has(ti) || (this.block && this.block.key !== 'tool' + ti)) {
        if (!this.tools.has(ti)) {
          s += this.#open('tool', { type: 'tool_use', id: safeId(tc.id || 'call_' + ti + '_' + Date.now().toString(36)), name: (tc.function && tc.function.name) || '', input: {} }, 'tool' + ti);
          this.tools.set(ti, this.index);
        }
      }
      const args = tc.function && tc.function.arguments;
      if (args && this.block && this.block.key === 'tool' + ti) {
        s += sse('content_block_delta', { type: 'content_block_delta', index: this.block.index, delta: { type: 'input_json_delta', partial_json: String(args) } });
      }
    }
    if (ch.finish_reason) this.stop = STOP_MAP[ch.finish_reason] || 'end_turn';
    return s;
  }
  end() {
    if (this.done) return '';
    this.done = true;
    let s = this.#start() + this.#close();
    s += sse('message_delta', { type: 'message_delta', delta: { stop_reason: this.stop || 'end_turn', stop_sequence: null }, usage: { output_tokens: this.usage.output_tokens, input_tokens: this.usage.input_tokens } });
    s += sse('message_stop', { type: 'message_stop' });
    return s;
  }
  error(message) {
    return sse('error', { type: 'error', error: { type: 'api_error', message: String(message || 'upstream error') } });
  }
}

/** 粗估 token（count_tokens 端点第三方多半没有）：按字符数 / 3.5。 */
export function estimateTokens(body) {
  const s = JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools });
  return Math.max(1, Math.ceil(s.length / 3.5));
}
