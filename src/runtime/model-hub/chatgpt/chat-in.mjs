// Chat Completions 请求 → 订阅通道收的 Responses 请求。
// 规矩（preview-limitations）：store:false、stream:true；input 带全部上下文；system 角色的条目会被拒，开头的系统提示放 instructions，
// 中途的系统消息改成 developer；max_output_tokens、temperature、top_p 这些字段一律不带。
import { createHash } from 'node:crypto';

const textOf = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => (p && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') ? p.text : '')).filter(Boolean).join('\n') : '');

function userParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : [];
  const out = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (!p || typeof p !== 'object') continue;
    if ((p.type === 'text' || p.type === 'input_text') && p.text) out.push({ type: 'input_text', text: String(p.text) });
    else if (p.type === 'image_url' && p.image_url) {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url.url;
      if (url) out.push({ type: 'input_image', image_url: String(url), detail: p.image_url.detail || 'auto' });
    } else if (p.type === 'file' && p.file && (p.file.file_data || p.file.file_url)) {
      out.push({ type: 'input_file', ...(p.file.file_data ? { file_data: p.file.file_data } : { file_url: p.file.file_url }), ...(p.file.filename ? { filename: p.file.filename } : {}) });
    }
    // 音频输入这条通道不支持：丢掉，不让整次请求 400
  }
  return out;
}

const args = (a) => (typeof a === 'string' ? a : JSON.stringify(a ?? {}));
const callsOf = (m) => (Array.isArray(m.tool_calls) ? m.tool_calls.filter((c) => c && c.function && c.function.name) : []);

// OpenRouter 写法的 reasoning_details（dimensio 在别的线路上回放过来的）里带着本家的加密推理：认得出就直接用
function detailsReasoning(m) {
  const out = [];
  for (const d of Array.isArray(m.reasoning_details) ? m.reasoning_details : []) {
    if (d && d.type === 'reasoning.encrypted' && typeof d.data === 'string' && /openai/i.test(String(d.format || ''))) {
      out.push({ type: 'reasoning', ...(d.id ? { id: String(d.id) } : {}), summary: [], encrypted_content: d.data });
    }
  }
  return out;
}

function toolChoice(tc) {
  if (tc === 'auto' || tc === 'none' || tc === 'required') return tc;
  if (tc && typeof tc === 'object' && tc.type === 'function' && tc.function?.name) return { type: 'function', name: tc.function.name };
  return undefined;
}

function textFormat(rf) {
  if (!rf || typeof rf !== 'object') return undefined;
  if (rf.type === 'json_object') return { type: 'json_object' };
  if (rf.type === 'json_schema' && rf.json_schema) {
    const j = rf.json_schema;
    return { type: 'json_schema', name: j.name || 'output', schema: j.schema || {}, ...(typeof j.strict === 'boolean' ? { strict: j.strict } : {}) };
  }
  return undefined;
}

/** 同一段对话每轮都给同一个 prompt_cache_key（上游按它把请求送到同一批缓存上）：型号 + 系统提示 + 第一条用户消息。 */
function cacheKey(model, instructions, input) {
  const first = input.find((x) => x.type === 'message' && x.role === 'user');
  const h = createHash('sha256').update(`${model}\n${instructions.slice(0, 8000)}\n${JSON.stringify(first?.content || '').slice(0, 4000)}`).digest('hex');
  return `bridge-${h.slice(0, 32)}`;
}

/**
 * chat = Chat Completions 请求体；recall({ callIds, text }) → 代存的推理条目 | null（不给 = 不回放）。
 * 返回 Responses 请求体（总是 stream:true、store:false）。
 */
export function chatToResponses(chat, { recall = null } = {}) {
  const c = chat && typeof chat === 'object' ? chat : {};
  const instructions = [];
  const input = [];
  let leading = true;
  for (const m of Array.isArray(c.messages) ? c.messages : []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      const text = textOf(m.content);
      if (!text) continue;
      if (leading) instructions.push(text);
      else input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
      continue;
    }
    leading = false;
    if (role === 'user') {
      const parts = userParts(m.content);
      if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
    } else if (role === 'assistant') {
      const calls = callsOf(m);
      const text = textOf(m.content);
      const rs = (recall && recall({ callIds: calls.map((x) => String(x.id)), text: calls.length ? '' : text })) || detailsReasoning(m);
      if (rs && rs.length) input.push(...rs);
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const x of calls) input.push({ type: 'function_call', call_id: String(x.id), name: String(x.function.name), arguments: args(x.function.arguments) });
    } else if (role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(m.tool_call_id || ''), output: typeof m.content === 'string' ? m.content : textOf(m.content) });
    } else if (role === 'function') {
      // 老式 function 角色：没有 id 对得上，按普通文本交给模型
      const text = textOf(m.content);
      if (text) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `[${m.name || 'function'} 的结果]\n${text}` }] });
    }
  }
  const model = String(c.model || '');
  const ins = instructions.join('\n\n');
  const out = { model, input, store: false, stream: true, include: ['reasoning.encrypted_content'] };
  if (ins) out.instructions = ins;
  const tools = (Array.isArray(c.tools) ? c.tools : []).filter((t) => t && t.type === 'function' && t.function?.name).map((t) => ({
    type: 'function', name: String(t.function.name), description: String(t.function.description || ''),
    parameters: t.function.parameters && typeof t.function.parameters === 'object' ? t.function.parameters : { type: 'object', properties: {} },
    // Responses 的函数工具默认是 strict：agent 们的工具参数表大多不满足 strict 的要求，没明说就关掉
    strict: t.function.strict === true,
  }));
  if (tools.length) {
    out.tools = tools;
    const tc = toolChoice(c.tool_choice);
    if (tc !== undefined) out.tool_choice = tc;
    if (typeof c.parallel_tool_calls === 'boolean') out.parallel_tool_calls = c.parallel_tool_calls;
  }
  const effort = typeof c.reasoning_effort === 'string' ? c.reasoning_effort : typeof c.reasoning?.effort === 'string' ? c.reasoning.effort : '';
  out.reasoning = effort === 'none' ? { effort: 'none' } : { ...(effort ? { effort } : {}), summary: 'auto' };
  const fmt = textFormat(c.response_format);
  const verbosity = typeof c.verbosity === 'string' ? c.verbosity : '';
  if (fmt || verbosity) out.text = { ...(fmt ? { format: fmt } : {}), ...(verbosity ? { verbosity } : {}) };
  out.prompt_cache_key = typeof c.prompt_cache_key === 'string' && c.prompt_cache_key ? c.prompt_cache_key.slice(0, 64) : cacheKey(model, ins, input);
  return out;
}
