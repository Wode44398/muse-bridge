// Anthropic Messages ⇄ Gemini generateContent（Google 原生协议）翻译（纯函数 + 一个内存签名表，无网络；单测见 claude-providers-gemini.test.mjs）。
//
//   toGemini(body, provider, model, tierId)   applyParams 改写后的 Anthropic 请求 → generateContent 请求体
//   GeminiStream                              streamGenerateContent?alt=sse 的每个 data → Anthropic SSE 事件
//   fromGemini(json, modelId)                 非流式应答 → Anthropic message
//
// 2026-11-13 起 Claude 的自定义服务除了 Anthropic / OpenAI 也认 Gemini 原生协议（AI Studio 的 Key、模型中心的 Vertex）。
// 原生协议比 Google 的 OpenAI 兼容入口多三样：思考摘要（includeThoughts）、完整 JSON Schema 的工具参数（parametersJsonSchema）、
// 思维签名能跟着会话走（下面）。
//
// 思维签名：Gemini 3 起每一步的第一个 functionCall 带 thoughtSignature，下一轮回放这条调用时不带回去就 400。
// Anthropic 消息里没有放它的地方，所以借 thinking 块的 signature 装（加 SIG_PREFIX 前缀）：签名到的时候若正好开着思考块就写进它，
// 否则在 tool_use 前面补一个空思考块。CLI 会把思考块连同签名原样回传，回放时「思考块的签名 → 紧跟着的那个调用」，
// 进程重启、会话恢复都不丢。兜底两层：按 tool_use id 记在内存里（CLI 压缩上下文、换模型时可能丢思考块）；
// 再记不到的（别家模型留下的调用）照官方迁移写法在这一轮第一个调用上填 SKIP_SIGNATURE。
// 正文 part 上的签名官方说「建议带回、不校验」，不保留。
import { tierOf, writeTier, deepMerge, bareModelId } from '../model-knowledge/knowledge.mjs';

export const SIG_PREFIX = 'bridge-gemini-sig:';
export const SKIP_SIGNATURE = 'skip_thought_signature_validator';
const SIG_MAX = 4000;
// 「3 代」及以后（含 Gemini 4）：强制回放签名。1.x / 2.x 不校验，不补占位
const GEN3_PLUS = /gemini-(?![12]\.)\d/i;
// 会思考、认 thinkingConfig 的家族（2.0 及更早发了会 400）
const THINKS = /gemini-(?![1]\.|2\.0)\d/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const rand = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

// —— 签名表（tool_use id → thoughtSignature；插入序 = 新旧序）——
const sigs = new Map();
export function rememberSignature(id, sig) {
  if (typeof id !== 'string' || !id || typeof sig !== 'string' || !sig) return;
  sigs.delete(id);
  sigs.set(id, sig);
  if (sigs.size > SIG_MAX) sigs.delete(sigs.keys().next().value);
}
export const _signatureFor = (id) => sigs.get(id);

// 工具参数走 parametersJsonSchema（完整 JSON Schema）：老的 parameters 字段只认 OpenAPI 子集，Claude Code / MCP 工具里常见的
// const、type 数组、exclusiveMinimum、propertyNames 一个都不认，挂着的工具里有一个就整轮 400（dimensio 2026-11-13 在 Vertex 上实测）。
// 只去掉 $schema 这个方言声明。
export function sanitizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!isObj(schema)) return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) if (k !== '$schema') out[k] = sanitizeSchema(v);
  return out;
}

const textOfSystem = (s) => (typeof s === 'string' ? s
  : Array.isArray(s) ? s.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n\n') : '');

function mediaPart(source, fallbackMime) {
  const s = source || {};
  if (s.type === 'base64' && s.data) return { inlineData: { mimeType: s.media_type || fallbackMime, data: s.data } };
  if (s.type === 'url' && s.url) return { fileData: { mimeType: s.media_type || fallbackMime, fileUri: s.url } };
  if (s.type === 'text' && typeof s.data === 'string') return { text: s.data };
  return null;
}

function toolResultParts(b, vision) {
  const c = b.content;
  if (typeof c === 'string') return { text: c, media: [] };
  const text = [], media = [];
  for (const x of Array.isArray(c) ? c : []) {
    if (!x) continue;
    if (x.type === 'text') text.push(x.text);
    else if (x.type === 'image') { const p = vision ? mediaPart(x.source, 'image/png') : null; if (p) media.push(p); else text.push('[图片]'); }
    else if (x.type === 'document') { const p = mediaPart(x.source, 'application/pdf'); if (p) media.push(p); }
  }
  return { text: text.filter(Boolean).join('\n'), media };
}

/** 一条 Anthropic 消息 → Gemini 的 parts。nameById：tool_use id → 工具名（functionResponse 按名字配对）。 */
function partsOf(m, nameById, model) {
  const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
  const parts = [];
  if (m.role === 'assistant') {
    let pending = '';   // 上一个思考块里装的签名，给紧跟着的调用
    let signed = false;
    const calls = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'thinking') {
        if (typeof b.signature === 'string' && b.signature.startsWith(SIG_PREFIX)) pending = b.signature.slice(SIG_PREFIX.length);
        continue;   // 思考正文不回放（Gemini 不收自己的思考摘要当输入）
      }
      if (b.type === 'text') { if (b.text) parts.push({ text: b.text }); continue; }
      if (b.type === 'tool_use') {
        const part = { functionCall: { name: b.name, args: isObj(b.input) ? b.input : {} } };
        const sig = pending || sigs.get(b.id) || '';
        if (sig) { part.thoughtSignature = sig; signed = true; }
        pending = '';
        parts.push(part);
        calls.push(part);
      }
      // redacted_thinking、server_tool_use 等：Gemini 没有对应物，丢掉
    }
    if (!signed && calls.length && GEN3_PLUS.test(bareModelId(model.id))) calls[0].thoughtSignature = SKIP_SIGNATURE;
    return parts;
  }
  // user：functionResponse 排在前面（Gemini 要求紧跟带调用的那一轮、个数对得上），工具结果里的图片和其余内容跟在后面
  const responses = [], rest = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'tool_result') {
      const { text, media } = toolResultParts(b, model.vision);
      const response = b.is_error ? { error: text || 'error' } : { output: text };
      responses.push({ functionResponse: { name: nameById.get(b.tool_use_id) || 'tool', response } });
      rest.push(...media);
    } else if (b.type === 'text') { if (b.text) rest.push({ text: b.text }); }
    else if (b.type === 'image') rest.push((model.vision && mediaPart(b.source, 'image/png')) || { text: '[图片：当前模型不支持图像输入，已省略]' });
    else if (b.type === 'document') { const p = mediaPart(b.source, 'application/pdf'); if (p) rest.push(p); }
  }
  return [...responses, ...rest];
}

/**
 * applyParams 之后的 Anthropic 请求 → generateContent 请求体。tierId：applyParams 回的档位 id（effort 方式在这里按 Gemini 写法落）。
 * 额外请求体里的 gemini 子对象原样深合并进翻译后的请求（同 OpenAI 协议的 openai 子对象）。
 */
export function toGemini(body, provider, model, tierId = '') {
  const nameById = new Map();
  for (const m of body.messages || []) {
    if (m && m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use') nameById.set(b.id, b.name);
  }
  // functionResponse 必须自己单独一条：和正文混在同一条 user 里，Vertex 上的 Gemini 4 回 400「Requests ending with a model turn
  // are not supported」（2026-11-13 实测；拆成两条相邻的 user 就是 200）。CLI 的工具结果后面常跟着 system-reminder 正文。
  const contents = [];
  const isResp = (p) => !!p.functionResponse;
  const add = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    // 同一角色连着两条（中间那条只剩思考被丢了、或 CLI 夹了 system 消息）：并成一条——工具结果与别的内容不并
    if (last && last.role === role && last.parts.every((p) => !isResp(p)) && parts.every((p) => !isResp(p))) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of body.messages || []) {
    if (!m) continue;
    // CLI 2.1.3xx 起会在 messages 里夹 role:'system' 的消息（会话中途的提示）：Gemini 只有开头一份 systemInstruction，按 user 正文发
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = partsOf(m, nameById, model);
    if (role === 'user') { add(role, parts.filter(isResp)); add(role, parts.filter((p) => !isResp(p))); }
    else add(role, parts);
  }
  const out = { contents };
  const sys = textOfSystem(body.system);
  if (sys) out.systemInstruction = { parts: [{ text: sys }] };

  const fns = (Array.isArray(body.tools) ? body.tools : []).filter((t) => t && t.name && (!t.type || t.type === 'custom'));
  // 官方服务端工具里只有联网搜索有对应物（CLI 的 WebSearch 单独发一个只带它的请求）：换成 Gemini 自带的 google_search
  const search = wantsSearch(body);
  const tools = [];
  if (fns.length) {
    tools.push({ functionDeclarations: fns.map((t) => ({ name: t.name, description: t.description || '', parametersJsonSchema: sanitizeSchema(t.input_schema || { type: 'object', properties: {} }) })) });
  }
  if (search) tools.push({ googleSearch: {} });
  if (tools.length) out.tools = tools;
  if (fns.length && search) out.toolConfig = { includeServerSideToolInvocations: true };
  const tc = body.tool_choice;
  if (fns.length && isObj(tc) && tc.type !== 'auto') {
    const fc = tc.type === 'any' ? { mode: 'ANY' } : tc.type === 'tool' ? { mode: 'ANY', allowedFunctionNames: [tc.name] } : tc.type === 'none' ? { mode: 'NONE' } : null;
    if (fc) out.toolConfig = { ...(out.toolConfig || {}), functionCallingConfig: fc };
  }

  const gc = {};
  if (body.max_tokens) gc.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) gc.temperature = body.temperature;
  if (body.top_p !== undefined) gc.topP = body.top_p;
  if (body.top_k !== undefined) gc.topK = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) gc.stopSequences = body.stop_sequences.slice(0, 5);
  // budget 方式的档位（Anthropic 形状，applyParams 已写好）→ thinkingBudget
  if (isObj(body.thinking) && body.thinking.type === 'enabled' && body.thinking.budget_tokens > 0) gc.thinkingConfig = { thinkingBudget: body.thinking.budget_tokens };
  if (Object.keys(gc).length) out.generationConfig = gc;

  let res = out;
  // effort 方式：档位值按 Gemini 写法（型号知识层的 gemini 模板是整段 generationConfig.thinkingConfig）
  if (tierId && model.thinking === 'effort') res = writeTier(res, model, tierOf(model, tierId), 'gemini');
  // 会思考的家族都要思考摘要（Claude 里显示成思考块）；thinkingBudget 0 = 明确关了，不加
  const think = res.generationConfig && res.generationConfig.thinkingConfig;
  if (isObj(think) ? think.thinkingBudget !== 0 && think.includeThoughts === undefined : THINKS.test(bareModelId(model.id))) {
    res = deepMerge(res, { generationConfig: { thinkingConfig: { includeThoughts: true } } });
  }
  if (isObj(body.gemini)) res = deepMerge(res, body.gemini);
  return res;
}

// —— 应答 ——
const STOP_MAP = { STOP: 'end_turn', MAX_TOKENS: 'max_tokens', SAFETY: 'refusal', RECITATION: 'refusal', PROHIBITED_CONTENT: 'refusal', BLOCKLIST: 'refusal', SPII: 'refusal', IMAGE_SAFETY: 'refusal' };
/** Gemini 用量 → Anthropic 口径（promptTokenCount 含缓存命中，扣出来单报；输出 = 正文 + 思考）。 */
export function usageOf(u) {
  const prompt = ((u && u.promptTokenCount) || 0) + ((u && u.toolUsePromptTokenCount) || 0);
  const read = Math.min(prompt, (u && u.cachedContentTokenCount) || 0);
  return {
    input_tokens: prompt - read,
    output_tokens: ((u && u.candidatesTokenCount) || 0) + ((u && u.thoughtsTokenCount) || 0),
    ...(read ? { cache_read_input_tokens: read } : {}),
  };
}
const toolId = (fc) => (fc && fc.id ? 'toolu_' + safeId(fc.id) : 'toolu_g' + rand());
// —— 联网搜索的来源（groundingMetadata）——
const webHits = (g) => (g && Array.isArray(g.groundingChunks) ? g.groundingChunks : []).map((c) => c && c.web).filter((w) => w && w.uri).slice(0, 20)
  .map((w) => ({ title: String(w.title || w.uri), url: String(w.uri) }));
/** 这个请求是不是 CLI 的 WebSearch（带官方 web_search 服务端工具）：应答要按那个工具的块形状给。 */
export const wantsSearch = (body) => (Array.isArray(body && body.tools) ? body.tools : []).some((t) => t && typeof t.type === 'string' && /^web_search/.test(t.type));
// WebSearch 请求：来源按官方 web_search 工具的形状给（server_tool_use + web_search_tool_result）——CLI 的 WebSearch 只从
// web_search_tool_result 里读出处，正文另算。别的请求（模型自己用了搜索，罕见）拼成一段 Markdown 列表接在正文后。
function searchBlocks(g) {
  const hits = webHits(g);
  if (!hits.length) return null;
  const id = 'srvtoolu_g' + rand();
  const query = (g && Array.isArray(g.webSearchQueries) ? g.webSearchQueries : []).join(' / ');
  return [
    { type: 'server_tool_use', id, name: 'web_search', input: { query } },
    { type: 'web_search_tool_result', tool_use_id: id, content: hits.map((h) => ({ type: 'web_search_result', url: h.url, title: h.title, encrypted_content: '', page_age: null })) },
  ];
}
function sourcesText(g) {
  const list = webHits(g);
  if (!list.length) return '';
  return '\n\n来源：\n' + list.map((w) => `- [${w.title.replace(/[[\]]/g, '')}](${w.url})`).join('\n');
}
function blockedText(json) {
  const r = json && json.promptFeedback && json.promptFeedback.blockReason;
  return r ? `（Gemini 拒绝了这次请求：${r}）` : '';
}

/** 非流式应答 → Anthropic message。opts.search：这是 CLI 的 WebSearch 请求（wantsSearch）。 */
export function fromGemini(json, modelId, { search = false } = {}) {
  const cand = (json && Array.isArray(json.candidates) && json.candidates[0]) || {};
  const content = [];
  let sawCall = false;
  for (const p of (cand.content && cand.content.parts) || []) {
    if (!p) continue;
    if (p.functionCall) {
      const id = toolId(p.functionCall);
      if (p.thoughtSignature) {
        rememberSignature(id, p.thoughtSignature);
        const prev = content[content.length - 1];
        if (prev && prev.type === 'thinking' && !prev.signature) prev.signature = SIG_PREFIX + p.thoughtSignature;
        else content.push({ type: 'thinking', thinking: '', signature: SIG_PREFIX + p.thoughtSignature });
      }
      content.push({ type: 'tool_use', id, name: p.functionCall.name || '', input: isObj(p.functionCall.args) ? p.functionCall.args : {} });
      sawCall = true;
    } else if (typeof p.text === 'string' && p.text) {
      const kind = p.thought === true ? 'thinking' : 'text';
      const prev = content[content.length - 1];
      if (prev && prev.type === kind && !(kind === 'thinking' && prev.signature)) prev[kind] += p.text;
      else content.push(kind === 'thinking' ? { type: 'thinking', thinking: p.text, signature: '' } : { type: 'text', text: p.text });
    }
  }
  const blocked = !content.length && blockedText(json);
  const found = search ? searchBlocks(cand.groundingMetadata) : null;
  if (found) content.push(...found);
  const extra = (found ? '' : sourcesText(cand.groundingMetadata)) || blocked;
  if (extra) content.push({ type: 'text', text: extra.replace(/^\n+/, content.length ? '\n\n' : '') });
  return {
    id: 'msg_' + String(json && json.responseId || rand()).replace(/[^A-Za-z0-9_]/g, ''),
    type: 'message', role: 'assistant', model: modelId, content,
    stop_reason: sawCall ? 'tool_use' : blocked ? 'refusal' : STOP_MAP[cand.finishReason] || 'end_turn',
    stop_sequence: null,
    usage: usageOf(json && json.usageMetadata),
  };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * streamGenerateContent?alt=sse → Anthropic SSE。用法同 OpenAIStream：每个 data JSON → push(json) 得到要写回的字符串；结束 → end()。
 * 思考 part（thought:true）→ thinking 块；正文 → text 块；functionCall 整条到（不分片）→ tool_use 块一次给全参数。
 */
export class GeminiStream {
  constructor(modelId, { search = false } = {}) {
    this.model = modelId;
    this.search = search;
    this.started = false;
    this.block = null;     // { kind:'thinking'|'text', index }
    this.index = -1;
    this.sawCall = false;
    this.finish = '';
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.grounding = null;
    this.blocked = '';
    this.done = false;
  }
  #start() {
    if (this.started) return '';
    this.started = true;
    return sse('message_start', { type: 'message_start', message: { id: 'msg_' + rand(), type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  #close() {
    if (!this.block) return '';
    const s = sse('content_block_stop', { type: 'content_block_stop', index: this.block.index });
    this.block = null;
    return s;
  }
  #open(kind, contentBlock) {
    let s = this.#close();
    this.index += 1;
    this.block = { kind, index: this.index };
    return s + sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: contentBlock });
  }
  #delta(delta) { return sse('content_block_delta', { type: 'content_block_delta', index: this.block.index, delta }); }
  #text(kind, text) {
    let s = '';
    if (!this.block || this.block.kind !== kind) s += this.#open(kind, kind === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' });
    return s + this.#delta(kind === 'thinking' ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text });
  }
  push(json) {
    let s = this.#start();
    if (!json) return s;
    if (json.usageMetadata) this.usage = usageOf(json.usageMetadata);
    if (json.promptFeedback && json.promptFeedback.blockReason) this.blocked = blockedText(json);
    const cand = Array.isArray(json.candidates) && json.candidates[0];
    if (!cand) return s;
    for (const p of (cand.content && cand.content.parts) || []) {
      if (!p) continue;
      if (p.functionCall) {
        const id = toolId(p.functionCall);
        if (p.thoughtSignature) {
          rememberSignature(id, p.thoughtSignature);
          // 签名装进思考块：正开着思考块就写进它，否则补一个空思考块
          if (!this.block || this.block.kind !== 'thinking') s += this.#open('thinking', { type: 'thinking', thinking: '', signature: '' });
          s += this.#delta({ type: 'signature_delta', signature: SIG_PREFIX + p.thoughtSignature });
        }
        s += this.#open('tool', { type: 'tool_use', id, name: p.functionCall.name || '', input: {} });
        s += this.#delta({ type: 'input_json_delta', partial_json: JSON.stringify(isObj(p.functionCall.args) ? p.functionCall.args : {}) });
        s += this.#close();
        this.sawCall = true;
      } else if (typeof p.text === 'string' && p.text) {
        s += this.#text(p.thought === true ? 'thinking' : 'text', p.text);
      }
    }
    if (cand.groundingMetadata) this.grounding = cand.groundingMetadata;
    if (cand.finishReason) this.finish = cand.finishReason;
    return s;
  }
  end() {
    if (this.done) return '';
    this.done = true;
    let s = this.#start();
    const empty = this.index < 0;
    const stop = this.sawCall ? 'tool_use' : empty && this.blocked ? 'refusal' : STOP_MAP[this.finish] || 'end_turn';
    const found = this.search ? searchBlocks(this.grounding) : null;
    if (found) {
      const [use, result] = found;
      s += this.#open('server', { ...use, input: {} });
      s += this.#delta({ type: 'input_json_delta', partial_json: JSON.stringify(use.input) });
      s += this.#open('server', result) + this.#close();
    }
    const extra = (found ? '' : sourcesText(this.grounding)) || (empty ? this.blocked : '');
    if (extra) s += this.#text('text', empty ? extra.replace(/^\n+/, '') : extra);
    s += this.#close();
    s += sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { ...this.usage } });
    s += sse('message_stop', { type: 'message_stop' });
    return s;
  }
  error(message) {
    return sse('error', { type: 'error', error: { type: 'api_error', message: String(message || 'upstream error') } });
  }
}
