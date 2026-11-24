// Responses 的 input（Codex 每轮都发整段历史）→ 中性的对话表，再由 to-chat / to-messages 各自落成上游的形状。
//
// 中性表：
//   system     { role: 'system', text }                                  instructions + 开头的 developer / system 消息
//   user       { role: 'user', parts: [{ type: 'text', text } | { type: 'image', url }] }
//   assistant  { role: 'assistant', text, reasoning, calls: [{ id, name（展平名）, args（JSON 文本）}] }
//   tool       { role: 'tool', id, text, images: [url] }
// 丢掉的：reasoning 项（只把摘要留给 assistant 回放用，密文上游解不开）、托管工具的调用记录（web_search_call 等）、压缩项、引用项。
import { callForUpstream } from './tools.mjs';

const TEXT_PARTS = new Set(['input_text', 'output_text', 'text', 'summary_text', 'refusal']);

function partsOf(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (!c || typeof c !== 'object') continue;
    if (TEXT_PARTS.has(c.type)) { const t = c.type === 'refusal' ? c.refusal : c.text; if (typeof t === 'string' && t) out.push({ type: 'text', text: t }); }
    else if (c.type === 'input_image') {
      const url = typeof c.image_url === 'string' ? c.image_url : c.image_url?.url;
      if (url) out.push({ type: 'image', url });
    } else if (c.type === 'input_file') {
      out.push({ type: 'text', text: `[file${c.filename ? ' ' + c.filename : ''} omitted: this model endpoint cannot read attached files]` });
    }
  }
  return out;
}
const textOf = (parts) => parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');

/** 工具输出（字符串或内容项数组）→ { text, images }。 */
function toolOutput(output) {
  if (typeof output === 'string') return { text: output, images: [] };
  const parts = partsOf(output);
  return { text: textOf(parts), images: parts.filter((p) => p.type === 'image').map((p) => p.url) };
}

/**
 * Responses 请求体 → { system, messages }。
 * 开头（第一条非系统消息之前）的 developer / system 消息并进 system；之后出现的（Codex 中途插的权限、模式说明）当 user 消息发，
 * 免得上游拒收夹在中间的 system。调用与结果配对：缺结果的调用补一条占位结果，找不到调用的结果改成一段 user 文本。
 */
export function toNeutral(req) {
  const sys = [];
  if (typeof req.instructions === 'string' && req.instructions.trim()) sys.push(req.instructions);
  const msgs = [];
  let reasoning = '';
  const lastAssistant = () => {
    const m = msgs[msgs.length - 1];
    if (m && m.role === 'assistant') return m;
    const n = { role: 'assistant', text: '', reasoning: '', calls: [] };
    msgs.push(n);
    return n;
  };
  const items = typeof req.input === 'string' ? [{ type: 'message', role: 'user', content: req.input }] : Array.isArray(req.input) ? req.input : [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const type = it.type || (it.role ? 'message' : '');
    if (type === 'message') {
      const parts = partsOf(it.content);
      if (it.role === 'developer' || it.role === 'system') {
        const t = textOf(parts);
        if (!t) continue;
        if (!msgs.length) sys.push(t);
        else msgs.push({ role: 'user', parts: [{ type: 'text', text: t }] });
      } else if (it.role === 'assistant') {
        const t = textOf(parts);
        if (!t) continue;
        const a = lastAssistant();
        // 调用之后又出了一段正文：另起一条，免得正文排到工具结果前面
        const m = a.calls.length ? (msgs.push({ role: 'assistant', text: '', reasoning: '', calls: [] }), msgs[msgs.length - 1]) : a;
        m.text = m.text ? `${m.text}\n${t}` : t;
        if (reasoning) { m.reasoning = m.reasoning ? `${m.reasoning}\n${reasoning}` : reasoning; reasoning = ''; }
      } else if (parts.length) {
        msgs.push({ role: 'user', parts });
      }
    } else if (type === 'reasoning') {
      const t = (Array.isArray(it.summary) ? it.summary : []).map((s) => s?.text).filter((x) => typeof x === 'string' && x).join('\n');
      if (t) reasoning = reasoning ? `${reasoning}\n${t}` : t;
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      if (!it.call_id) continue;
      const a = lastAssistant();
      if (reasoning) { a.reasoning = a.reasoning ? `${a.reasoning}\n${reasoning}` : reasoning; reasoning = ''; }
      const { name, args } = callForUpstream(it);
      a.calls.push({ id: String(it.call_id), name, args });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      if (!it.call_id) continue;
      const { text, images } = toolOutput(it.output);
      msgs.push({ role: 'tool', id: String(it.call_id), text, images });
    }
    // 其余（web_search_call、tool_search_call / output、compaction、item_reference、additional_tools…）不发给上游
  }
  return { system: sys.join('\n\n'), messages: pairCalls(msgs) };
}

// 每条带调用的 assistant 后面紧跟它的全部结果（顺序同调用）；缺的补占位，孤儿结果变 user 文本，空的 assistant 去掉
function pairCalls(msgs) {
  const results = new Map();
  for (const m of msgs) if (m.role === 'tool' && !results.has(m.id)) results.set(m.id, m);
  const called = new Set();
  for (const m of msgs) if (m.role === 'assistant') for (const c of m.calls) called.add(c.id);
  const used = new Set(), out = [];
  for (const m of msgs) {
    if (m.role === 'assistant') {
      if (!m.text && !m.calls.length) continue;
      // 同一个调用 id 出现两次的只留第一次（上游按 id 配对结果）
      const calls = m.calls.filter((c) => !used.has(c.id) && used.add(c.id));
      if (!m.text && !calls.length) continue;
      out.push({ ...m, calls });
      for (const c of calls) {
        out.push(results.get(c.id) || { role: 'tool', id: c.id, text: '(no output: the call was interrupted)', images: [] });
      }
    } else if (m.role === 'tool') {
      if (called.has(m.id)) continue;   // 已经跟在它的调用后面
      out.push({ role: 'user', parts: [{ type: 'text', text: `[tool output${m.id ? ' ' + m.id : ''}]\n${m.text}` }] });
    } else out.push(m);
  }
  return out;
}
