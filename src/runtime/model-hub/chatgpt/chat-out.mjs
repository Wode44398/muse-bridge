// 订阅通道回的 Responses 事件流 → Chat Completions 的流式分块（或整段应答）。
// 推理摘要 → delta.reasoning_content（Claude 的本机代理、dimensio 都把它当思考）；函数调用按出现顺序编 tool_calls 的 index；
// 回复里的推理条目（带 encrypted_content）在结束时交给 onDone，由网关代存、下一轮回放。

const now = () => Math.floor(Date.now() / 1000);

export function chatUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const cached = u.input_tokens_details?.cached_tokens || 0;
  const reasoning = u.output_tokens_details?.reasoning_tokens || 0;
  return {
    prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0,
    total_tokens: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0),
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

const cleanReasoning = (it) => ({
  type: 'reasoning', ...(it.id ? { id: it.id } : {}),
  summary: Array.isArray(it.summary) ? it.summary.filter((s) => s && s.type === 'summary_text').map((s) => ({ type: 'summary_text', text: String(s.text || '') })) : [],
  encrypted_content: it.encrypted_content,
});

/** 这一条 Responses 事件是不是「回复已经开始产出内容」（之前到的失败可以换账号重发，之后就只能报错）。 */
export const isContentEvent = (ev) => /^response\.(output_item\.added|output_text\.delta|reasoning_summary_text\.delta|reasoning_text\.delta|function_call_arguments\.delta|content_part\.added)$/.test(ev?.type || '');
export const isTerminalEvent = (ev) => /^(response\.(completed|failed|incomplete)|error)$/.test(ev?.type || '');

/** 流里的失败事件 → { code, message }。 */
export function failureOf(ev) {
  if (ev?.type === 'error') return { code: String(ev.code || ev.error?.code || 'server_error'), message: String(ev.message || ev.error?.message || '上游出错') };
  const e = ev?.response?.error || {};
  return { code: String(e.code || 'server_error'), message: String(e.message || '上游出错') };
}

export class ChatFromResponses {
  /** model：回给 agent 的型号名；onDone({ items, callIds, text })：正常结束时调；onFail({ code, message })：流里失败时调。 */
  constructor({ model, onDone = null, onFail = null, includeUsage = true } = {}) {
    this.model = model;
    this.id = 'chatcmpl-' + Math.random().toString(36).slice(2, 14);
    this.created = now();
    this.onDone = onDone; this.onFail = onFail; this.includeUsage = includeUsage;
    this.tools = new Map();      // 条目 id / 输出序号 → { index, callId, name, args, sent }
    this.nextTool = 0;
    this.reasoning = [];
    this.callIds = [];
    this.text = '';
    this.thought = '';
    this.summaryParts = 0;
    this.started = false;
    this.finish = null;
    this.usage = null;
    this.error = null;
    this.done = false;
  }
  #chunk(delta, finish = null) {
    const out = [];
    if (!this.started) {
      this.started = true;
      out.push({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    }
    out.push({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    return out;
  }
  #tool(ev) { return this.tools.get(ev.item_id) || this.tools.get(`#${ev.output_index}`) || null; }

  /** 喂一条事件 → 要发出去的分块（数组，可能为空）。 */
  push(ev) {
    if (!ev || this.done) return [];
    switch (ev.type) {
      case 'response.output_item.added': {
        const it = ev.item || {};
        if (it.type !== 'function_call') return [];
        const t = { index: this.nextTool++, callId: String(it.call_id || it.id || `call_${this.nextTool}`), name: String(it.name || ''), args: '', sent: false };
        if (it.id) this.tools.set(it.id, t);
        this.tools.set(`#${ev.output_index}`, t);
        const a = typeof it.arguments === 'string' ? it.arguments : '';
        if (a) { t.args = a; t.sent = true; }
        return this.#chunk({ tool_calls: [{ index: t.index, id: t.callId, type: 'function', function: { name: t.name, arguments: a } }] });
      }
      case 'response.function_call_arguments.delta': {
        const t = this.#tool(ev);
        if (!t || !ev.delta) return [];
        t.args += ev.delta; t.sent = true;
        return this.#chunk({ tool_calls: [{ index: t.index, function: { arguments: String(ev.delta) } }] });
      }
      case 'response.function_call_arguments.done': {
        const t = this.#tool(ev);
        if (!t || t.sent || typeof ev.arguments !== 'string' || !ev.arguments) return [];
        t.args = ev.arguments; t.sent = true;
        return this.#chunk({ tool_calls: [{ index: t.index, function: { arguments: ev.arguments } }] });
      }
      case 'response.output_text.delta':
        if (!ev.delta) return [];
        this.text += ev.delta;
        return this.#chunk({ content: String(ev.delta) });
      case 'response.reasoning_summary_part.added':
        // 多段摘要之间空一行，别粘成一段
        if (this.summaryParts++ > 0 && this.thought) { this.thought += '\n\n'; return this.#chunk({ reasoning_content: '\n\n' }); }
        return [];
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (!ev.delta) return [];
        this.thought += ev.delta;
        return this.#chunk({ reasoning_content: String(ev.delta) });
      case 'response.output_item.done': {
        const it = ev.item || {};
        if (it.type === 'reasoning' && it.encrypted_content) this.reasoning.push(cleanReasoning(it));
        else if (it.type === 'function_call') {
          const t = (it.id && this.tools.get(it.id)) || this.tools.get(`#${ev.output_index}`);
          if (t) {
            this.callIds.push(t.callId);
            if (!t.sent && typeof it.arguments === 'string' && it.arguments) { t.args = it.arguments; t.sent = true; return this.#chunk({ tool_calls: [{ index: t.index, function: { arguments: it.arguments } }] }); }
          } else {
            // 没见过 added 就直接 done 的调用：整个补发
            const nt = { index: this.nextTool++, callId: String(it.call_id || it.id), name: String(it.name || ''), args: String(it.arguments || ''), sent: true };
            this.callIds.push(nt.callId);
            return this.#chunk({ tool_calls: [{ index: nt.index, id: nt.callId, type: 'function', function: { name: nt.name, arguments: nt.args } }] });
          }
        } else if (it.type === 'message' && !this.text) {
          // 有的流不发增量、只在 done 里给全文
          const text = (Array.isArray(it.content) ? it.content : []).filter((p) => p && p.type === 'output_text').map((p) => p.text).join('');
          if (text) { this.text = text; return this.#chunk({ content: text }); }
        }
        return [];
      }
      case 'response.completed':
      case 'response.incomplete': {
        const r = ev.response || {};
        this.usage = chatUsage(r.usage);
        const why = r.incomplete_details?.reason;
        this.finish = ev.type === 'response.incomplete'
          ? (why === 'content_filter' ? 'content_filter' : 'length')
          : (this.callIds.length || this.nextTool ? 'tool_calls' : 'stop');
        this.done = true;
        if (this.onDone && ev.type === 'response.completed') { try { this.onDone({ items: this.reasoning, callIds: this.callIds, text: this.text }); } catch {} }
        const out = this.#chunk({}, this.finish);
        if (this.includeUsage && this.usage) out.push({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: this.usage });
        return out;
      }
      case 'response.failed':
      case 'error': {
        this.error = failureOf(ev);
        this.done = true;
        if (this.onFail) { try { this.onFail(this.error); } catch {} }
        return [{ error: { message: this.error.message, type: 'upstream_error', code: this.error.code } }];
      }
      default:
        return [];
    }
  }
  /** 流没等到结束事件就断了。 */
  cut() {
    if (this.done) return [];
    this.done = true;
    this.error = { code: 'server_error', message: 'ChatGPT 的回复流没说完就断了' };
    return [{ error: { message: this.error.message, type: 'upstream_error', code: this.error.code } }];
  }
  /** 非流式请求：整段应答。 */
  message() {
    const tools = [...new Set(this.tools.values())].sort((a, b) => a.index - b.index);
    return {
      id: this.id, object: 'chat.completion', created: this.created, model: this.model,
      choices: [{
        index: 0, finish_reason: this.finish || 'stop',
        message: {
          role: 'assistant', content: this.text || (tools.length ? null : ''),
          ...(this.thought ? { reasoning_content: this.thought } : {}),
          ...(tools.length ? { tool_calls: tools.map((t) => ({ id: t.callId, type: 'function', function: { name: t.name, arguments: t.args } })) } : {}),
        },
      }],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}
