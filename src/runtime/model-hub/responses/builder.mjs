// 拼 Responses 的输出：上游（Chat Completions / Anthropic Messages）的流解出来的思考、正文、工具调用一段段喂进来，
// 按 Codex 认的顺序吐事件：
//   response.created → 每一项 output_item.added → 增量（reasoning_summary_text.delta / output_text.delta / function_call_arguments.delta）
//   → output_item.done → response.completed（或 response.failed）
// 工具调用整段攒到上游说完才发：参数是一段 JSON，攒齐了才知道 custom 工具的原文；Codex 也只在 output_item.done 时执行。
import { randomBytes } from 'node:crypto';
import { callForCodex } from './tools.mjs';

const rid = (p) => `${p}_${randomBytes(12).toString('hex')}`;

/**
 * usage → Codex 读的形状。u = { input, cached, output, reasoning }（input 含缓存命中）。
 */
export function responsesUsage(u = {}) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const input = n(u.input), output = n(u.output);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: Math.min(input, n(u.cached)) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Math.min(output, n(u.reasoning)) },
    total_tokens: input + output,
  };
}

export class ResponsesBuilder {
  /** emit(event) 收每一条事件对象；names = 展平工具名 → 原工具。 */
  constructor({ model = '', names = new Map(), emit = () => {} } = {}) {
    this.id = rid('resp');
    this.model = model;
    this.names = names;
    this.emit = emit;
    this.output = [];          // 已经 done 的项（最后放进 response.completed）
    this.cur = null;           // 正在写的 { kind: 'reasoning' | 'message', item, index, text }
    this.tools = new Map();    // 上游的调用键 → { id, name, args }，按出现顺序
    this.started = false;
    this.finished = false;
    this.seq = 0;
  }
  #send(ev) { this.emit({ ...ev, sequence_number: this.seq++ }); }
  #shell(status) {
    return { id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: this.model, output: [] };
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.#send({ type: 'response.created', response: this.#shell('in_progress') });
  }
  #index() { return this.output.length; }
  #close() {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    if (c.kind === 'reasoning') {
      this.#send({ type: 'response.reasoning_summary_text.done', item_id: c.item.id, output_index: c.index, summary_index: 0, text: c.text });
      this.#send({ type: 'response.reasoning_summary_part.done', item_id: c.item.id, output_index: c.index, summary_index: 0, part: { type: 'summary_text', text: c.text } });
      // 只给摘要：上游的思考原文 / 签名 Codex 回传了也没有用（下一轮按摘要回放）
      const item = { ...c.item, summary: [{ type: 'summary_text', text: c.text }] };
      this.output.push(item);
      this.#send({ type: 'response.output_item.done', output_index: c.index, item });
    } else {
      const part = { type: 'output_text', text: c.text, annotations: [] };
      this.#send({ type: 'response.output_text.done', item_id: c.item.id, output_index: c.index, content_index: 0, text: c.text });
      this.#send({ type: 'response.content_part.done', item_id: c.item.id, output_index: c.index, content_index: 0, part });
      const item = { ...c.item, status: 'completed', content: [part] };
      this.output.push(item);
      this.#send({ type: 'response.output_item.done', output_index: c.index, item });
    }
  }
  #open(kind) {
    if (this.cur && this.cur.kind === kind) return this.cur;
    this.#close();
    const index = this.#index();
    const item = kind === 'reasoning'
      ? { id: rid('rs'), type: 'reasoning', summary: [] }
      : { id: rid('msg'), type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    this.cur = { kind, item, index, text: '' };
    this.#send({ type: 'response.output_item.added', output_index: index, item });
    if (kind === 'reasoning') {
      this.#send({ type: 'response.reasoning_summary_part.added', item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } });
    } else {
      this.#send({ type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    }
    return this.cur;
  }
  reasoning(delta) {
    if (!delta) return;
    this.start();
    const c = this.#open('reasoning');
    c.text += delta;
    this.#send({ type: 'response.reasoning_summary_text.delta', item_id: c.item.id, output_index: c.index, summary_index: 0, delta });
  }
  text(delta) {
    if (!delta) return;
    this.start();
    const c = this.#open('message');
    c.text += delta;
    this.#send({ type: 'response.output_text.delta', item_id: c.item.id, output_index: c.index, content_index: 0, delta });
  }
  /** 一次调用的一段：key 区分同一轮里的几个调用；id / name 第一次给到就记下，args 逐段拼。 */
  tool(key, { id, name, args } = {}) {
    this.start();
    let t = this.tools.get(key);
    if (!t) { t = { id: '', name: '', args: '' }; this.tools.set(key, t); }
    if (id && !t.id) t.id = String(id);
    if (name && !t.name) t.name = String(name);
    if (args) t.args += String(args);
  }
  /** 上游说完：收尾正在写的项、发出工具调用、发 response.completed。usage 形状见 responsesUsage。 */
  finish({ usage, incomplete = '' } = {}) {
    if (this.finished) return;
    this.start();
    this.#close();
    for (const t of this.tools.values()) {
      if (!t.name) continue;
      const callId = t.id || rid('call');
      const base = callForCodex(this.names, t.name, t.args, callId);
      const index = this.#index();
      const item = { id: rid(base.type === 'custom_tool_call' ? 'ctc' : 'fc'), ...base, status: 'completed' };
      this.#send({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', ...(base.type === 'custom_tool_call' ? { input: '' } : { arguments: '' }) } });
      if (base.type === 'custom_tool_call') {
        this.#send({ type: 'response.custom_tool_call_input.delta', item_id: item.id, output_index: index, delta: item.input });
        this.#send({ type: 'response.custom_tool_call_input.done', item_id: item.id, output_index: index, input: item.input });
      } else {
        this.#send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: item.arguments });
        this.#send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments });
      }
      this.output.push(item);
      this.#send({ type: 'response.output_item.done', output_index: index, item });
    }
    this.finished = true;
    const response = { ...this.#shell('completed'), output: this.output, usage: responsesUsage(usage) };
    // 撞了输出上限也按完成发：Codex 对 response.incomplete 直接报错丢掉整轮，已经写出来的正文和调用都白费
    if (incomplete) response.incomplete_details = { reason: incomplete };
    this.#send({ type: 'response.completed', response });
    return response;
  }
  /** 上游中途出错：已经发出去的事件收不回来，用 response.failed 收尾（Codex 认 error.code 判断要不要重试 / 压缩）。 */
  fail(message, code = 'server_error') {
    if (this.finished) return;
    this.start();
    this.finished = true;
    this.#send({ type: 'response.failed', response: { ...this.#shell('failed'), output: this.output, error: { code, message: String(message || 'upstream error') } } });
  }
}
