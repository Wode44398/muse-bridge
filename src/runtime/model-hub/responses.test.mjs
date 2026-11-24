// 网关的 Responses 段（给 Codex 用）：请求翻译（真实 Codex 请求体，脱敏后放在 testdata/）、流式结果翻回 Responses、
// 透传 / 翻译的分流与报错，以及模型中心里 codex 这个去向（老数据不变、只有勾了才发布、modelServices('codex') 带 Responses 地址）。
// 上游是假的（函数或本机 http），数据根是临时目录：不联网、不碰真实数据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-hub-responses-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
delete process.env.VERTEX_PROJECT;

const { toMessagesBody, effortFor, jsonFormatOf } = await import('./responses/request.mjs');
const { convertTools, flatName, callForCodex } = await import('./responses/tools.mjs');
const { ResponsesBuilder, responsesUsage } = await import('./responses/builder.mjs');
const { pumpChat, pumpMessages } = await import('./responses/upstream.mjs');
const { readSse } = await import('./responses/sse.mjs');
const { handleResponses, setResponsesModelSpec } = await import('./responses.mjs');
const { applyParams, toOpenAI, openAIReasoning } = await import('../claude-providers-transform.mjs');
const { cleanResponsesApi, autoResponsesApi, responsesModeOf } = await import('./advanced.mjs');
const S = await import('../model-services.mjs');
const R = await import('./registry.mjs');
const G = await import('./gateway.mjs');
const O = await import('./overview.mjs');

const fixture = (name) => JSON.parse(readFileSync(new URL(`./testdata/${name}.json`, import.meta.url), 'utf8'));
const specOf = (id, over = {}) => ({ id, label: id, contextWindow: 200000, maxOutput: 16000, vision: true, efforts: [], enabled: true, ...over });
const providerOf = (protocol, spec, over = {}) => ({ id: 'svc', name: 'svc', protocol, baseUrl: 'https://up.example/v1', upstream: 'up.example', compat: {}, params: {}, models: [spec], ...over });
// Responses 请求 → Chat Completions 请求（和网关走的是同一串改写）
function chatOf(req, spec = specOf(req.model)) {
  const { body, names } = toMessagesBody(req);
  const prov = providerOf('openai', spec);
  const a = applyParams(body, prov, spec, effortFor(req, spec));
  return { chat: openAIReasoning(toOpenAI(a.body, prov, a.model), a.model, a.effort), names };
}
const enc = new TextEncoder();
const streamOf = (text, cut = 7) => new ReadableStream({
  start(c) { for (let i = 0; i < text.length; i += cut) c.enqueue(enc.encode(text.slice(i, i + cut))); c.close(); },   // 故意切碎：\r\n 与 JSON 都会被拆开
});
const chatSse = (chunks) => chunks.map((j) => `data: ${typeof j === 'string' ? j : JSON.stringify(j)}\r\n\r\n`).join('');
const msgSse = (events) => events.map((j) => `event: ${j.type}\ndata: ${JSON.stringify(j)}\n\n`).join('');
async function collect(pump, text, names = new Map()) {
  const events = [];
  const b = new ResponsesBuilder({ model: 'm', names, emit: (e) => events.push(e) });
  let err = null, done = null;
  try { done = await pump(streamOf(text), b); } catch (e) { err = e; }
  return { events, types: events.map((e) => e.type), done, err };
}
async function sseOfResponse(res) {
  const out = [];
  for await (const ev of readSse(res.body)) out.push(JSON.parse(ev.data));
  return out;
}

after(async () => { await G._stopGatewayForTests(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

// —— 请求翻译 ——
test('纯文本：开头的 developer 并进 system、两条 user 并成一条；namespace 工具展平、托管工具（web_search）丢掉；落 Chat Completions', () => {
  const req = fixture('codex-text');
  const { chat, names } = chatOf(req);
  assert.equal(chat.model, 'mock-model');
  assert.equal(chat.stream, true);
  assert.deepEqual(chat.stream_options, { include_usage: true });
  assert.equal(chat.messages[0].role, 'system');
  assert.match(chat.messages[0].content, /^You are a coding agent/);
  assert.match(chat.messages[0].content, /<skills_instructions>|## Skills|permissions/i, '第二条 developer 也进了 system');
  assert.deepEqual(chat.messages.map((m) => m.role), ['system', 'user']);
  assert.match(chat.messages[1].content, /<environment_context>/);
  const toolNames = chat.tools.map((t) => t.function.name);
  assert.ok(toolNames.includes('exec_command'));
  assert.ok(toolNames.includes('multi_agent_v1__spawn_agent'), 'namespace 里的工具展平成 <ns>__<name>');
  assert.ok(!toolNames.some((n) => /web_search/.test(n)), '托管工具不发');
  const exec = chat.tools.find((t) => t.function.name === 'exec_command');
  assert.deepEqual(exec.function.parameters, req.tools.find((t) => t.name === 'exec_command').parameters, 'function 工具参数原样');
  assert.deepEqual(names.get('multi_agent_v1__spawn_agent'), { kind: 'function', name: 'spawn_agent', namespace: 'multi_agent_v1' });
  for (const k of ['store', 'include', 'prompt_cache_key', 'client_metadata', 'parallel_tool_calls', 'reasoning', 'input', 'text']) assert.ok(!(k in chat), `${k} 不发给上游`);
  assert.equal(chat.max_tokens, 16000, '输出上限按模型规格');
});

test('工具调用历史：function_call + output → assistant.tool_calls + tool 消息；Anthropic 侧是 tool_use / tool_result', () => {
  const req = fixture('codex-exec-history');
  const { chat } = chatOf(req);
  const a = chat.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  const call = req.input.find((x) => x.type === 'function_call');
  assert.equal(a.tool_calls[0].id, call.call_id);
  assert.equal(a.tool_calls[0].function.name, 'exec_command');
  assert.deepEqual(JSON.parse(a.tool_calls[0].function.arguments), JSON.parse(call.arguments));
  const t = chat.messages[chat.messages.indexOf(a) + 1];
  assert.equal(t.role, 'tool');
  assert.equal(t.tool_call_id, call.call_id);
  assert.equal(t.content, req.input.find((x) => x.type === 'function_call_output').output);

  const { body } = toMessagesBody(req, { replayThinking: false });
  const am = body.messages.find((m) => m.role === 'assistant');
  const use = am.content.find((b) => b.type === 'tool_use');
  assert.deepEqual(use, { type: 'tool_use', id: call.call_id, name: 'exec_command', input: JSON.parse(call.arguments) });
  const next = body.messages[body.messages.indexOf(am) + 1];
  assert.equal(next.role, 'user');
  assert.equal(next.content[0].type, 'tool_result');
  assert.equal(next.content[0].tool_use_id, call.call_id);
  assert.match(body.system, /^You are a coding agent/);
  assert.ok(body.tools.every((x) => x.name && x.input_schema), 'Anthropic 的工具形状');
});

test('apply_patch（custom 工具）：去程是只有 input 一个字符串参数的函数、语法写进说明；历史里的 custom_tool_call 变成 {input} 参数；tool_search 不转', () => {
  const req = fixture('codex-apply-patch');
  const { chat, names } = chatOf(req, specOf('gpt-5.5', { thinking: 'effort', effortField: 'reasoning_effort', efforts: [{ id: 'low', name: 'Low', value: 'low' }, { id: 'medium', name: 'Medium', value: 'medium' }, { id: 'high', name: 'High', value: 'high' }] }));
  const ap = chat.tools.find((t) => t.function.name === 'apply_patch');
  assert.deepEqual(ap.function.parameters.required, ['input']);
  assert.equal(ap.function.parameters.properties.input.type, 'string');
  assert.match(ap.function.description, /grammar/);
  assert.match(ap.function.description, /Begin Patch/, 'lark 语法原文进说明');
  assert.deepEqual(names.get('apply_patch'), { kind: 'custom', name: 'apply_patch' });
  assert.ok(!chat.tools.some((t) => /tool_search|web_search/.test(t.function.name)));
  const calls = chat.messages.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls);
  const patch = req.input.find((x) => x.type === 'custom_tool_call');
  const sent = calls.find((c) => c.id === patch.call_id);
  assert.deepEqual(JSON.parse(sent.function.arguments), { input: patch.input });
  const out = chat.messages.find((m) => m.role === 'tool' && m.tool_call_id === patch.call_id);
  assert.equal(out.content, req.input.find((x) => x.type === 'custom_tool_call_output' && x.call_id === patch.call_id).output);
  // 历史里的 update_plan 也照样配对（工具表里没有它也不丢历史）
  assert.ok(calls.some((c) => c.function.name === 'update_plan'));
  assert.equal(chat.reasoning_effort, 'medium', 'reasoning.effort → 模型档位');
});

test('推理历史：reasoning 项不发原样（密文丢掉）；摘要按型号回传成 reasoning_content；Anthropic 侧不带 thinking 块；中途的 developer 变 user', () => {
  const req = fixture('codex-reasoning-history');
  const plain = chatOf(req).chat;
  assert.ok(plain.messages.every((m) => m.reasoning_content === undefined), '型号不要求回传思考就不带');
  assert.ok(!JSON.stringify(plain).includes('ENC-A'), '密文不发');
  const thinks = chatOf(req, specOf('mock-model', { alwaysThinks: true })).chat;
  const withCall = thinks.messages.find((m) => m.tool_calls);
  assert.equal(withCall.reasoning_content, 'plan A-0');
  const texts = thinks.messages.filter((m) => m.role === 'assistant' && !m.tool_calls).map((m) => [m.content, m.reasoning_content]);
  assert.deepEqual(texts, [['[A] tool said ok (n=1)', 'think A-1'], ['[A] reply n=2', 'reply A-2']]);
  const roles = plain.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'user']);
  assert.match(plain.messages.at(-1).content, /<skills_instructions>[\s\S]*third turn plain/, '中途的 developer 和后面的 user 并成一条');
  const { body } = toMessagesBody(req, { replayThinking: false });
  assert.ok(!JSON.stringify(body.messages).includes('"thinking"'));
});

test('输入边角：instructions → system；缺结果的调用补占位、孤儿结果变文本；图片；tool_choice；text.format；effort 映射', () => {
  const req = {
    model: 'm', instructions: 'SYS', stream: true,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'zz', output: 'orphan' },
      { type: 'message', role: 'user', content: 'next' },
    ],
    tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    tool_choice: { type: 'function', name: 'exec_command' },
    text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object', properties: { a: { type: 'string' } } }, strict: true } },
  };
  const { body } = toMessagesBody(req);
  assert.match(body.system, /^SYS/);
  assert.match(body.system, /JSON Schema/);
  assert.deepEqual(body.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.deepEqual(body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: '(no output: the call was interrupted)' }] });
  assert.match(JSON.stringify(body.messages[2].content), /orphan/, '孤儿结果改成文本、和后面的 user 并在一起');
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'exec_command' });
  assert.deepEqual(toMessagesBody({ ...req, tool_choice: 'required' }).body.tool_choice, { type: 'any' });
  assert.equal(jsonFormatOf(req).name, 'out');
  const spec = specOf('m', { efforts: [{ id: 'none', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] });
  assert.equal(effortFor({ reasoning: { effort: 'high' } }, spec), 'high');
  assert.equal(effortFor({ reasoning: { effort: 'none' } }, spec), 'none');
  assert.equal(effortFor({ reasoning: { effort: 'minimal' } }, spec), 'low');
  assert.equal(effortFor({ reasoning: { effort: 'xhigh' } }, spec), 'high');
  assert.equal(effortFor({}, spec), '');
  assert.equal(effortFor({ reasoning: { effort: 'high' } }, specOf('m')), '');
});

test('工具名：namespace 里的 custom 工具；超长 / 带怪字符的名字截短补哈希且稳定；回程按名字表还原', () => {
  const { list, names } = convertTools([], [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description: 'run js' }] }]);
  assert.equal(list[0].name, 'functions__exec');
  assert.deepEqual(names.get('functions__exec'), { kind: 'custom', name: 'exec', namespace: 'functions' });
  const long = flatName('x'.repeat(80), 'mcp.server');
  assert.ok(long.length <= 64 && /^[A-Za-z0-9_-]+$/.test(long));
  assert.equal(long, flatName('x'.repeat(80), 'mcp.server'));
  assert.notEqual(flatName('a.b'), flatName('a_b'));
  assert.deepEqual(callForCodex(names, 'functions__exec', '{"input":"1+1"}', 'c9'), { type: 'custom_tool_call', call_id: 'c9', name: 'exec', input: '1+1', namespace: 'functions' });
  assert.deepEqual(callForCodex(names, 'unknown_tool', '', 'c8'), { type: 'function_call', call_id: 'c8', name: 'unknown_tool', arguments: '{}' });
});

// —— 流式结果翻回 Responses ——
test('Chat 流 → Responses SSE：created → 思考 → 正文 → 工具调用（namespace 还原、custom 变 custom_tool_call）→ completed（usage 映射）', async () => {
  const { names } = convertTools(fixture('codex-text').tools, [{ type: 'custom', name: 'apply_patch' }]);
  const text = chatSse([
    { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '想' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: '一想' } }] },
    { choices: [{ index: 0, delta: { content: '好' } }] },
    { choices: [{ index: 0, delta: { content: '的' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'multi_agent_v1__spawn_agent', arguments: '{"mess' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_y', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'age":"hi"}' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: ' Patch"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } },
    '[DONE]',
  ]);
  const { events, types, done, err } = await collect(pumpChat, text, names);
  assert.equal(err, null);
  assert.deepEqual(types.filter((t) => /created|output_item|completed|delta$/.test(t)), [
    'response.created',
    'response.output_item.added', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.delta', 'response.output_item.done',
    'response.output_item.added', 'response.output_text.delta', 'response.output_text.delta', 'response.output_item.done',
    'response.output_item.added', 'response.function_call_arguments.delta', 'response.output_item.done',
    'response.output_item.added', 'response.custom_tool_call_input.delta', 'response.output_item.done',
    'response.completed',
  ]);
  const doneItems = events.filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  assert.deepEqual(doneItems[0].summary, [{ type: 'summary_text', text: '想一想' }]);
  assert.ok(!('encrypted_content' in doneItems[0]), '思考只给摘要');
  assert.deepEqual(doneItems[1].content, [{ type: 'output_text', text: '好的', annotations: [] }]);
  assert.deepEqual({ ...doneItems[2], id: '' }, { id: '', type: 'function_call', call_id: 'call_x', name: 'spawn_agent', arguments: '{"message":"hi"}', namespace: 'multi_agent_v1', status: 'completed' });
  assert.deepEqual({ ...doneItems[3], id: '' }, { id: '', type: 'custom_tool_call', call_id: 'call_y', name: 'apply_patch', input: '*** Begin Patch', status: 'completed' });
  const completed = events.at(-1).response;
  assert.equal(completed.status, 'completed');
  assert.ok(completed.id.startsWith('resp_'));
  assert.deepEqual(completed.usage, { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 });
  assert.equal(completed.output.length, 4);
  assert.equal(done, completed);
  assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, i) => i));
  // output_index 连续、added 与 done 成对
  const idx = events.filter((e) => e.type === 'response.output_item.added').map((e) => e.output_index);
  assert.deepEqual(idx, [0, 1, 2, 3]);
});

test('Chat 流：中途的 error 分块 → response.failed（超窗口给 context_length_exceeded）；撞输出上限仍按 completed 发', async () => {
  const bad = await collect(pumpChat, chatSse([{ choices: [{ index: 0, delta: { content: 'x' } }] }, { error: { message: "This model's maximum context length is 8192 tokens" } }]));
  assert.equal(bad.err.code, 'context_length_exceeded');
  const len = await collect(pumpChat, chatSse([{ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'length' }] }, '[DONE]']));
  assert.equal(len.done.status, 'completed');
  assert.deepEqual(len.done.incomplete_details, { reason: 'max_output_tokens' });
  // DeepSeek 口径的缓存命中
  const ds = await collect(pumpChat, chatSse([{ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 } }]));
  assert.equal(ds.done.usage.input_tokens_details.cached_tokens, 4);
  // 结尾没有空行、没有 [DONE] 的流也收得住（最后一块带结束原因）
  const tail = await collect(pumpChat, 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'end' }, finish_reason: 'stop' }] }));
  assert.equal(tail.done.output[0].content[0].text, 'end');
  // 没有 [DONE]、也没有结束原因：流断在半截 → 失败（交给 Codex 重试），不把截断的输出当完整结果
  const cut = await collect(pumpChat, chatSse([{ choices: [{ index: 0, delta: { content: 'half' } }] }]));
  assert.equal(cut.done, null);
  assert.equal(cut.err.code, 'server_error');
  const cutMsg = await collect(pumpMessages, msgSse([{ type: 'message_start', message: { usage: {} } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]));
  assert.equal(cutMsg.err.code, 'server_error');
});

test('readSse：signal 中断时取消上游的流并抛 AbortError；调用方提前 break 也会取消上游', async () => {
  let cancelled = 0;
  const endless = () => new ReadableStream({
    pull(c) { c.enqueue(enc.encode('data: {"choices":[]}\n\n')); return new Promise((r) => setTimeout(r, 5)); },
    cancel() { cancelled++; },
  });
  const ac = new AbortController();
  let n = 0, err = null;
  try { for await (const _ of readSse(endless(), ac.signal)) { if (++n === 2) ac.abort(); } } catch (e) { err = e; }
  assert.equal(err?.name, 'AbortError');
  assert.equal(cancelled, 1);
  for await (const _ of readSse(endless())) break;
  assert.equal(cancelled, 2);
});

test('Anthropic 流 → Responses SSE：thinking / text / tool_use；usage 的输入含缓存读写；error 事件 → 失败', async () => {
  const text = msgSse([
    { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'exec_command', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"ls"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ]);
  const { events, done } = await collect(pumpMessages, text);
  const items = events.filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  assert.deepEqual(items.map((i) => i.type), ['reasoning', 'message', 'function_call']);
  assert.ok(!JSON.stringify(items).includes('SIG'), '签名不给 Codex');
  assert.equal(items[2].arguments, '{"cmd":"ls"}');
  assert.equal(items[2].call_id, 'toolu_1');
  assert.deepEqual(done.usage, { input_tokens: 100, input_tokens_details: { cached_tokens: 70 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 130 });
  const bad = await collect(pumpMessages, msgSse([{ type: 'message_start', message: { usage: {} } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]));
  assert.equal(bad.err.message, 'Overloaded');
  assert.equal(bad.err.code, 'server_error');
  assert.deepEqual(responsesUsage({ input: 5, cached: 9, output: 1, reasoning: 3 }).input_tokens_details.cached_tokens, 5, '命中数不超过输入');
});

// —— 处理器：分流、透传、报错 ——
function fakeUpstream(reply) {
  const calls = [];
  const fn = async (args) => { calls.push({ ...args, json: args.body ? JSON.parse(Buffer.from(args.body).toString('utf8') || 'null') : null }); return reply(args); };
  fn.calls = calls;
  return fn;
}
const sseResponse = (text) => new Response(streamOf(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const reqBody = (over = {}) => Buffer.from(JSON.stringify({ model: 'gpt-x', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], ...over }));
setResponsesModelSpec((s) => ({ upstream: '', compat: {}, models: [{ ...specOf('gpt-x'), agents: ['codex'] }, { ...specOf('only-claude'), agents: ['claude'] }] }));

test('处理器：GET /models 本地答勾给 codex 的；native 原样透传；翻译走 /chat/completions 并流式翻回', async () => {
  const svc = { id: 'h-1', name: 'S', kind: 'openai', baseUrl: 'https://api.openai.com/v1', lines: [{ id: 'l1', enabled: true }] };
  const models = await handleResponses({ service: svc, upstream: null, rest: '/models', search: '?client_version=1', method: 'GET', headers: {}, body: null });
  assert.deepEqual(models.json.data.map((m) => m.id), ['gpt-x']);

  const native = fakeUpstream(() => new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const r1 = await handleResponses({ service: svc, upstream: native, rest: '/responses', search: '', method: 'POST', headers: { 'content-type': 'application/json' }, body: reqBody() });
  assert.equal(native.calls[0].proto, 'openai');
  assert.equal(native.calls[0].rest, '/responses');
  assert.equal(native.calls[0].json.input[0].role, 'user', '请求体原样');
  assert.equal(await r1.text(), '{"ok":1}');

  const chat = fakeUpstream(() => sseResponse(chatSse([{ choices: [{ index: 0, delta: { content: 'yo' }, finish_reason: 'stop' }] }, '[DONE]'])));
  const s2 = { ...svc, baseUrl: 'https://api.deepseek.com/v1' };
  const r2 = await handleResponses({ service: s2, upstream: chat, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody() });
  assert.equal(chat.calls[0].rest, '/chat/completions');
  assert.equal(chat.calls[0].proto, 'openai');
  assert.equal(chat.calls[0].json.messages[0].content, 'hi');
  assert.equal(r2.headers.get('content-type'), 'text/event-stream');
  const evs = await sseOfResponse(r2);
  assert.equal(evs[0].type, 'response.created');
  assert.equal(evs.at(-1).type, 'response.completed');
  assert.equal(evs.find((e) => e.type === 'response.output_text.delta').delta, 'yo');
  // 强制翻译：官方地址也翻译
  const chat2 = fakeUpstream(() => sseResponse(chatSse(['[DONE]'])));
  await handleResponses({ service: { ...svc, responsesApi: 'translate' }, upstream: chat2, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody() });
  assert.equal(chat2.calls[0].rest, '/chat/completions');
  // 翻译模式下的 compact 之类：404
  const r3 = await handleResponses({ service: s2, upstream: chat, rest: '/responses/compact', search: '', method: 'POST', headers: {}, body: reqBody() });
  assert.equal(r3.status, 404);
  // 非流式：整段 response
  const r4 = await handleResponses({ service: s2, upstream: fakeUpstream(() => sseResponse(chatSse([{ choices: [{ index: 0, delta: { content: 'z' }, finish_reason: 'stop' }] }]))), rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody({ stream: false }) });
  assert.equal(r4.status, 200);
  assert.equal(r4.json.object, 'response');
  assert.equal(r4.json.output[0].content[0].text, 'z');
});

test('处理器：Anthropic 走 /v1/messages（带版本头、Claude 工具循环里不开思考）；Gemini 只认官方地址；上游报错带原文与错误码', async () => {
  setResponsesModelSpec(() => ({ upstream: 'api.anthropic.com', compat: { promptCaching: true }, models: [{ ...specOf('claude-sonnet-9', { thinking: 'adaptive', efforts: [{ id: 'high', name: 'High', value: 'high' }], effortDefault: 'high' }), agents: ['codex'] }] }));
  const ant = fakeUpstream(() => sseResponse(msgSse([{ type: 'message_start', message: { usage: { input_tokens: 1 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }])));
  const svc = { id: 'h-2', name: 'A', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', lines: [] };
  const plain = reqBody({ model: 'claude-sonnet-9' });
  await handleResponses({ service: svc, upstream: ant, rest: '/responses', search: '', method: 'POST', headers: {}, body: plain });
  assert.equal(ant.calls[0].rest, '/v1/messages');
  assert.equal(ant.calls[0].proto, 'anthropic');
  assert.equal(ant.calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(ant.calls[0].json.thinking?.type, 'adaptive', '普通一轮照开思考');
  const loop = reqBody({ model: 'claude-sonnet-9', input: [
    { type: 'message', role: 'user', content: 'go' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }], encrypted_content: 'X' },
    { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'done' },
  ] });
  await handleResponses({ service: svc, upstream: ant, rest: '/responses', search: '', method: 'POST', headers: {}, body: loop });
  assert.equal(ant.calls[1].json.thinking, undefined, '工具循环里没有带签名的思考块：这一步不开思考');
  assert.ok(!JSON.stringify(ant.calls[1].json.messages).includes('"thinking"'));

  setResponsesModelSpec(() => ({ models: [{ ...specOf('gemini-x'), agents: ['codex'] }] }));
  const g = fakeUpstream(() => sseResponse(chatSse(['[DONE]'])));
  const gsvc = { id: 'h-3', name: 'G', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', lines: [{ id: 'l', enabled: true }, { id: 'l2', enabled: true, baseUrl: 'https://generativelanguage.googleapis.com' }] };
  await handleResponses({ service: gsvc, upstream: g, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody({ model: 'gemini-x' }) });
  assert.equal(g.calls[0].service.kind, 'openai');
  assert.equal(g.calls[0].service.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(g.calls[0].service.lines[1].baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(g.calls[0].service.authStyle, 'bearer');
  assert.equal(g.calls[0].service.id, 'h-3', '同一个服务 id：线路状态共用');
  const off = await handleResponses({ service: { ...gsvc, baseUrl: 'https://relay.example/gemini' }, upstream: g, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody({ model: 'gemini-x' }) });
  assert.equal(off.status, 400);
  assert.match(off.json.error.message, /Gemini/);

  const e400 = fakeUpstream(() => new Response(JSON.stringify({ error: { message: 'maximum context length exceeded' } }), { status: 400 }));
  const r = await handleResponses({ service: { id: 'h-4', name: 'O', kind: 'openai', baseUrl: 'https://x.example/v1', lines: [] }, upstream: e400, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody({ model: 'gemini-x' }) });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json.error, { message: 'maximum context length exceeded', type: 'upstream_error', code: 'context_length_exceeded' });
  const bad = await handleResponses({ service: { id: 'h-4', kind: 'openai', baseUrl: 'https://x.example/v1', lines: [] }, upstream: e400, rest: '/responses', search: '', method: 'POST', headers: {}, body: Buffer.from('{oops') });
  assert.equal(bad.status, 400);
});

test('处理器：上游回整段 JSON 也翻得回来；Gemini 官方接口补回思维签名；Codex 取消时关掉上游的流', async () => {
  setResponsesModelSpec(() => ({ models: [{ ...specOf('gpt-x'), agents: ['codex'] }, { ...specOf('gemini-x'), agents: ['codex'] }, { ...specOf('claude-x'), agents: ['codex'] }] }));
  const jsonRes = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  const osvc = { id: 'h-5', name: 'O', kind: 'openai', baseUrl: 'https://x.example/v1', lines: [] };
  // Chat Completions 整段应答
  const cj = fakeUpstream(() => jsonRes({ choices: [{ index: 0, message: { role: 'assistant', content: 'whole', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
  const r1 = await handleResponses({ service: osvc, upstream: cj, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody({ stream: false }) });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.output[0].content[0].text, 'whole');
  assert.equal(r1.json.output[1].call_id, 'c9');
  assert.equal(r1.json.usage.output_tokens, 2);
  // Anthropic 整段应答（流式请求也照样流式翻回）
  const aj = fakeUpstream(() => jsonRes({ type: 'message', content: [{ type: 'text', text: 'hey' }], stop_reason: 'end_turn', usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 1 } }));
  const r2 = await handleResponses({ service: { id: 'h-6', name: 'A', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', lines: [] }, upstream: aj, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody({ model: 'claude-x' }) });
  const evs = await sseOfResponse(r2);
  assert.equal(evs.at(-1).type, 'response.completed');
  assert.equal(evs.at(-1).response.usage.input_tokens, 10);
  assert.equal(evs.find((e) => e.type === 'response.output_text.delta').delta, 'hey');

  // Gemini 官方：上游回的调用带签名 → 记下；下一轮回放这条调用时补回去（记不到的填占位值）
  const gsvc = { id: 'h-7', name: 'G', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', lines: [] };
  const g1 = fakeUpstream(() => sseResponse(chatSse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'gc1', type: 'function', function: { name: 'exec_command', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG-1' } } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
  ])));
  await sseOfResponse(await handleResponses({ service: gsvc, upstream: g1, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody({ model: 'gemini-x' }) }));
  const g2 = fakeUpstream(() => sseResponse(chatSse([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'])));
  await sseOfResponse(await handleResponses({ service: gsvc, upstream: g2, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody({ model: 'gemini-x', input: [
    { type: 'message', role: 'user', content: 'go' },
    { type: 'function_call', call_id: 'gc1', name: 'exec_command', arguments: '{}' },
    { type: 'function_call_output', call_id: 'gc1', output: 'done' },
    { type: 'function_call', call_id: 'gc-unknown', name: 'exec_command', arguments: '{}' },
    { type: 'function_call_output', call_id: 'gc-unknown', output: 'done' },
  ] }) }));
  const replayed = g2.calls[0].json.messages.flatMap((m) => m.tool_calls || []);
  assert.equal(replayed.find((c) => c.id === 'gc1')?.extra_content?.google?.thought_signature, 'SIG-1');
  assert.equal(replayed.find((c) => c.id === 'gc-unknown')?.extra_content?.google?.thought_signature, 'skip_thought_signature_validator');
  // 别家（普通 OpenAI 兼容）不补签名
  const o = fakeUpstream(() => sseResponse(chatSse(['[DONE]'])));
  await handleResponses({ service: osvc, upstream: o, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody({ input: [
    { type: 'message', role: 'user', content: 'go' },
    { type: 'function_call', call_id: 'gc1', name: 'exec_command', arguments: '{}' },
    { type: 'function_call_output', call_id: 'gc1', output: 'done' },
  ] }) });
  assert.ok(!JSON.stringify(o.calls[0].json).includes('thought_signature'));

  // Codex 取消读流：上游的流被取消（不在后台接着生成），上游请求拿到的 signal 也断开
  let upCancelled = false;
  const endless = fakeUpstream(() => new Response(new ReadableStream({
    pull(c) { c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] }) + '\n\n')); return new Promise((r) => setTimeout(r, 5)); },
    cancel() { upCancelled = true; },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const r3 = await handleResponses({ service: osvc, upstream: endless, rest: '/responses', search: '', method: 'POST', headers: {}, body: reqBody() });
  const rd = r3.body.getReader();
  await rd.read(); await rd.read();
  await rd.cancel();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(upCancelled, '上游的流被取消');
  assert.equal(endless.calls[0].signal.aborted, true);
});

test('Responses 接口的走法：auto 按地址（只有 api.openai.com / openrouter.ai 透传）、手动 native / translate、乱填报错', () => {
  const s = (baseUrl, lines = [], kind = 'openai') => ({ kind, baseUrl, lines });
  assert.equal(autoResponsesApi(s('https://api.openai.com/v1')), 'native');
  assert.equal(autoResponsesApi(s('https://openrouter.ai/api/v1')), 'native');
  assert.equal(autoResponsesApi(s('https://api.deepseek.com/v1')), 'translate');
  assert.equal(autoResponsesApi(s('https://api.openai.com/v1', [{ enabled: true }, { enabled: true, baseUrl: 'https://relay.example/v1' }])), 'translate', '混挂了别的地址就翻译');
  assert.equal(autoResponsesApi(s('https://api.openai.com/v1', [{ enabled: false, baseUrl: 'https://relay.example/v1' }, { enabled: true }])), 'native', '停用的线路不算');
  assert.equal(autoResponsesApi(s('https://api.anthropic.com', [], 'anthropic')), 'translate');
  assert.equal(responsesModeOf({ ...s('https://api.deepseek.com/v1'), responsesApi: 'native' }), 'native');
  assert.equal(cleanResponsesApi('auto'), undefined);
  assert.equal(cleanResponsesApi('translate'), 'translate');
  assert.throws(() => cleanResponsesApi('zzz', { strict: true }), /auto/);
  assert.equal(cleanResponsesApi('zzz'), undefined);
});

// —— 模型中心里的 codex 去向 ——
const HUB = path.join(tmp, 'hub');
test('codex 去向：老数据不加 codex；勾了才发布、带 Responses 地址；responsesApi 存取；总览的 codexHub 跟扩展走；网关的 responses 段能打通', async () => {
  // 老格式的数据（v2，模型没有 codex）
  mkdirSync(HUB, { recursive: true });
  writeFileSync(path.join(HUB, 'services.json'), JSON.stringify({ v: 2, vertex: { enabled: false, agents: ['claude', 'dimensio'], models: [] }, services: [
    { id: 'h-0000aaaa', name: '老服务', kind: 'openai', baseUrl: 'https://old.example/v1', enabled: true, strategy: 'order', useProxy: false, timeoutSec: 600, headers: [], members: false,
      lines: [{ id: 'l-1', label: 'Key 1', enabled: true }], models: [{ id: 'old-m', kind: 'text', agents: ['claude', 'dimensio'] }] },
  ] }));
  R._resetHubForTests(HUB);
  await R.initModelHub();
  const old = R.getHubService('h-0000aaaa');
  assert.ok(old, '老数据读得出来');
  assert.deepEqual(old.models.map((m) => m.agents), [['claude', 'dimensio']]);
  assert.equal(S.modelServices('codex').length, 0, '没勾 codex 就不发布给它');
  assert.equal(old.responsesApi, null);
  assert.equal(old.responsesAuto, 'translate');

  // 假的 Chat 上游
  const seen = [];
  const up = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chatSse([{ choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }, '[DONE]']));
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  try {
    const UP = `http://127.0.0.1:${up.address().port}/v1`;
    const r = R.createHubFromDetect({ baseUrl: UP, kind: 'openai', useProxy: false, key: 'k-test-1', catalog: [{ id: 'hub-m', kind: 'text' }, { id: 'claude-only', kind: 'text' }], assign: [{ id: 'hub-m', agents: ['codex'] }, { id: 'claude-only', agents: ['claude'] }] });
    const sid = r.service.id;
    assert.deepEqual(r.service.models.find((m) => m.id === 'hub-m').agents, ['codex']);
    const pub = S.modelServices('codex').find((x) => x.sid === sid);
    assert.ok(pub, '勾了 codex 就发布给它');
    assert.deepEqual(pub.models.map((m) => m.id), ['hub-m'], 'codex 只看到勾给它的');
    assert.equal(pub.responsesUrl, G.gatewayUrl(sid, 'responses'));
    assert.equal(typeof pub.members, 'boolean');
    assert.deepEqual(S.modelServices('claude').find((x) => x.sid === sid).models.map((m) => m.id), ['claude-only']);

    // responsesApi：存、视图、null 回到自动、乱填 400
    assert.equal(R.updateHubV2(sid, { responsesApi: 'native' }).service.responsesApi, 'native');
    assert.equal(R.updateHubV2(sid, { responsesApi: null }).service.responsesApi, null);
    assert.throws(() => R.updateHubV2(sid, { responsesApi: 'zzz' }), /auto/);

    // 走真网关：GET /models 与 POST /responses（auto → 翻译成 Chat）
    const base = pub.responsesUrl;
    const m = await (await fetch(base + '/models?client_version=0.1')).json();
    assert.deepEqual(m.data.map((x) => x.id), ['hub-m']);
    const res = await fetch(base + '/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'hub-m', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }] }) });
    assert.equal(res.status, 200);
    const evs = await sseOfResponse(res);
    assert.equal(evs.at(-1).type, 'response.completed');
    assert.equal(evs.at(-1).response.usage.total_tokens, 4);
    assert.equal(seen.at(-1).path, '/v1/chat/completions');
    assert.equal(seen.at(-1).auth, 'Bearer k-test-1', 'Key 由网关的池换上');
    assert.equal(seen.at(-1).body.model, 'hub-m');

    // 总览：codex 扩展没装 = false
    assert.equal(O.hubOverview().codexHub, false);
    O.setCodexHubProbe(() => true);
    assert.equal(O.hubOverview().codexHub, true);
    O.setCodexHubProbe(null);
  } finally {
    await new Promise((r) => up.close(r));
  }
});

test('model-services：codex 只收带 Responses 地址的服务；老规格（不写 agents）照旧只给 claude / dimensio', () => {
  const spec = { id: 'svc-x', name: 'X', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'mx' }] };
  const a = S.provideModelService('t-plugin', 'T', { ...spec, agents: ['codex'] });
  assert.equal(S.modelServices('codex').some((x) => x.models.some((m) => m.id === 'mx')), false, '没有 responsesUrl：codex 去向去掉');
  a.dispose();
  const b = S.provideModelService('t-plugin', 'T', { ...spec, agents: ['codex', 'claude'], responsesUrl: 'http://127.0.0.1:9/k/svc-x/responses/' });
  const c = S.modelServices('codex').find((x) => x.models.some((m) => m.id === 'mx'));
  assert.equal(c.responsesUrl, 'http://127.0.0.1:9/k/svc-x/responses');
  assert.equal(c.members, false);
  b.dispose();
  const d = S.provideModelService('t-plugin', 'T', spec);
  assert.ok(S.modelServices('claude').some((x) => x.models.some((m) => m.id === 'mx')));
  assert.ok(S.modelServices('dimensio').some((x) => x.models.some((m) => m.id === 'mx')));
  assert.equal(S.modelServices('codex').some((x) => x.models.some((m) => m.id === 'mx')), false);
  d.dispose();
});
