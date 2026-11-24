// 上游的流 → ResponsesBuilder：Chat Completions 的分块、Anthropic Messages 的事件各一个泵。
// 上游中途报错（流里的 error 事件 / 带 error 的分块）抛 StreamError，由调用方发 response.failed。
import { readSse } from './sse.mjs';

export class StreamError extends Error {
  constructor(message, code = 'server_error') { super(message); this.code = code; }
}

const CONTEXT_RE = /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|input is too long|token limit/i;
/** 上游的报错文字 → Codex 认的错误码（超窗口时它会自动压缩再试）。 */
export const errorCode = (message, status = 0) => (CONTEXT_RE.test(String(message || '')) ? 'context_length_exceeded'
  : status === 429 ? 'rate_limit_exceeded' : 'server_error');

const errText = (e) => (typeof e === 'string' ? e : e?.message || e?.error?.message || JSON.stringify(e));

// 上游的流没说完就断了（没有 [DONE]、没有结束原因）：当成失败交给 Codex 重试，别把截断的输出当完整结果
const CUT = '上游的流没说完就断了';

/**
 * Chat Completions 的一块（流式分块或整段应答都是这个形状：choices[0].delta / .message）喂进 builder。
 * 返回这一块的 finish_reason（没有 = ''）；带 error 的抛 StreamError。onCall(tool_call) 看每个调用增量（记思维签名用）。
 */
function feedChat(j, b, usage, onCall) {
  if (j.error) { const m = errText(j.error); throw new StreamError(m, errorCode(m)); }
  if (j.usage) {
    const u = j.usage, d = u.prompt_tokens_details || {};
    usage.input = u.prompt_tokens || 0;
    usage.cached = d.cached_tokens || u.prompt_cache_hit_tokens || 0;
    usage.output = u.completion_tokens || 0;
    usage.reasoning = u.completion_tokens_details?.reasoning_tokens || 0;
  }
  const ch = j.choices && j.choices[0];
  if (!ch) return '';
  const d = ch.delta || ch.message || {};
  const r = d.reasoning_content ?? d.reasoning;
  if (typeof r === 'string') b.reasoning(r);
  if (typeof d.content === 'string') b.text(d.content);
  for (const tc of d.tool_calls || []) {
    if (onCall) onCall(tc);
    // 有的上游不给 index（每块一个完整调用），按 id 区分
    const key = Number.isInteger(tc.index) ? `i${tc.index}` : `d${tc.id || b.tools.size}`;
    b.tool(key, { id: tc.id, name: tc.function?.name, args: tc.function?.arguments });
  }
  return ch.finish_reason || '';
}
const chatIncomplete = (finish) => (finish === 'length' ? 'max_output_tokens' : finish === 'content_filter' ? 'content_filter' : '');

/** Chat Completions 的流式分块。usage 在最后一块（stream_options.include_usage），有的上游放在带 finish_reason 的那块。 */
export async function pumpChat(stream, b, { signal, onCall } = {}) {
  const usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
  let finish = '', done = false;
  for await (const { data } of readSse(stream, signal)) {
    if (!data) continue;
    if (data.trim() === '[DONE]') { done = true; break; }
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    finish = feedChat(j, b, usage, onCall) || finish;
  }
  if (!done && !finish) throw new StreamError(CUT, 'server_error');
  return b.finish({ usage, incomplete: chatIncomplete(finish) });
}

/** 上游没理 stream:true、回了整段 JSON 的 Chat Completions 应答。 */
export function feedChatJson(j, b, { onCall } = {}) {
  const usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
  const finish = feedChat(j, b, usage, onCall);
  if (!j?.choices?.length) throw new StreamError('上游的应答里没有 choices', 'server_error');
  return b.finish({ usage, incomplete: chatIncomplete(finish) });
}

/** Anthropic Messages 的事件流。input 含缓存命中与写入（Codex 口径的 input_tokens 是整段输入）。 */
export async function pumpMessages(stream, b, { signal } = {}) {
  const u = { in: 0, read: 0, write: 0, out: 0 };
  const take = (x) => {
    if (!x) return;
    if (Number.isFinite(x.input_tokens)) u.in = x.input_tokens;
    if (Number.isFinite(x.cache_read_input_tokens)) u.read = x.cache_read_input_tokens;
    if (Number.isFinite(x.cache_creation_input_tokens)) u.write = x.cache_creation_input_tokens;
    if (Number.isFinite(x.output_tokens)) u.out = x.output_tokens;
  };
  const blocks = new Map();   // index → 'thinking' | 'text' | 'tool'
  let stop = '', ended = false;
  for await (const { data } of readSse(stream, signal)) {
    if (!data) continue;
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    switch (j.type) {
      case 'message_start': take(j.message?.usage); break;
      case 'content_block_start': {
        const cb = j.content_block || {};
        if (cb.type === 'tool_use') { blocks.set(j.index, 'tool'); b.tool(`i${j.index}`, { id: cb.id, name: cb.name }); }
        else if (cb.type === 'thinking') { blocks.set(j.index, 'thinking'); if (cb.thinking) b.reasoning(cb.thinking); }
        else if (cb.type === 'text') { blocks.set(j.index, 'text'); if (cb.text) b.text(cb.text); }
        break;
      }
      case 'content_block_delta': {
        const d = j.delta || {};
        if (d.type === 'text_delta') b.text(d.text);
        else if (d.type === 'thinking_delta') b.reasoning(d.thinking);
        else if (d.type === 'input_json_delta' && blocks.get(j.index) === 'tool') b.tool(`i${j.index}`, { args: d.partial_json });
        break;
      }
      case 'message_delta': take(j.usage); if (j.delta?.stop_reason) stop = j.delta.stop_reason; break;
      case 'message_stop': ended = true; break;
      case 'error': { const m = errText(j.error); throw new StreamError(m, errorCode(m, j.error?.type === 'rate_limit_error' ? 429 : 0)); }
      default: break;
    }
  }
  if (!ended && !stop) throw new StreamError(CUT, 'server_error');
  return b.finish({
    usage: { input: u.in + u.read + u.write, cached: u.read, output: u.out },
    incomplete: messagesIncomplete(stop),
  });
}
const messagesIncomplete = (stop) => (stop === 'max_tokens' ? 'max_output_tokens' : stop === 'refusal' ? 'content_filter' : '');

/** 上游回了整段 JSON 的 Anthropic Messages 应答（type: 'message'）。 */
export function feedMessagesJson(j, b) {
  if (j?.type === 'error' || j?.error) { const m = errText(j.error || j); throw new StreamError(m, errorCode(m, j?.error?.type === 'rate_limit_error' ? 429 : 0)); }
  if (!Array.isArray(j?.content)) throw new StreamError('上游的应答里没有 content', 'server_error');
  j.content.forEach((cb, i) => {
    if (cb?.type === 'thinking' && cb.thinking) b.reasoning(cb.thinking);
    else if (cb?.type === 'text' && cb.text) b.text(cb.text);
    else if (cb?.type === 'tool_use') b.tool(`i${i}`, { id: cb.id, name: cb.name, args: JSON.stringify(cb.input ?? {}) });
  });
  const x = j.usage || {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return b.finish({
    usage: { input: n(x.input_tokens) + n(x.cache_read_input_tokens) + n(x.cache_creation_input_tokens), cached: n(x.cache_read_input_tokens), output: n(x.output_tokens) },
    incomplete: messagesIncomplete(j.stop_reason),
  });
}
