// Anthropic ⇄ Gemini 原生协议翻译（claude-providers-gemini.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGemini, fromGemini, GeminiStream, sanitizeSchema, SIG_PREFIX, SKIP_SIGNATURE, rememberSignature } from './claude-providers-gemini.mjs';
import { applyParams } from './claude-providers-transform.mjs';
import { guessModel } from '../model-knowledge/knowledge.mjs';

const prov = { id: 'p-gem', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', compat: {}, params: {}, models: [] };
const model = (id, extra = {}) => ({ id, enabled: true, vision: true, contextWindow: 1_048_576, maxOutput: 65_536, ...guessModel(id, { protocol: 'gemini' }), ...extra });

// 把 Anthropic SSE 字符串拆回事件
const events = (s) => s.split('\n\n').filter(Boolean).map((x) => JSON.parse(x.split('\n').find((l) => l.startsWith('data: ')).slice(6)));

test('请求：system、角色、工具、工具结果按名字配对、图片、采样参数', () => {
  const body = {
    model: 'gemini-4-carbon', max_tokens: 4096, temperature: 0.3, stop_sequences: ['END'],
    system: [{ type: 'text', text: '你是助手' }, { type: 'text', text: '第二段' }],
    tools: [
      { name: 'Bash', description: '跑命令', input_schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } },
      { type: 'web_search_20250305', name: 'web_search' },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看看目录' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a.txt' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }] }, { type: 'text', text: '继续' }] },
    ],
  };
  const g = toGemini(body, prov, model('gemini-4-carbon'));
  assert.deepEqual(g.systemInstruction, { parts: [{ text: '你是助手\n\n第二段' }] });
  // 工具结果单独一条 user，后面的图片和正文另起一条（混在一条里 Vertex 400）
  assert.deepEqual(g.contents.map((c) => c.role), ['user', 'model', 'user', 'user']);
  assert.deepEqual(g.contents[0].parts[1], { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
  const call = g.contents[1].parts[1];
  assert.deepEqual(call.functionCall, { name: 'Bash', args: { command: 'ls' } });
  // 没有签名的调用（别家留下的）：Gemini 3+ 第一个调用填占位值
  assert.equal(call.thoughtSignature, SKIP_SIGNATURE);
  assert.deepEqual(g.contents[2].parts, [{ functionResponse: { name: 'Bash', response: { output: 'a.txt' } } }]);
  assert.deepEqual(g.contents[3].parts, [{ inlineData: { mimeType: 'image/png', data: 'BBBB' } }, { text: '继续' }]);
  // CLI 夹在 messages 里的 system 消息：按 user 正文，和前一条普通 user 并成一条
  const s = toGemini({ messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }] }, prov, model('gemini-4-carbon'));
  assert.deepEqual(s.contents, [{ role: 'user', parts: [{ text: 'a' }, { text: 'b' }] }]);
  const decl = g.tools[0].functionDeclarations[0];
  assert.equal(decl.parametersJsonSchema.$schema, undefined);
  assert.equal(decl.parametersJsonSchema.additionalProperties, false);
  assert.deepEqual(g.tools[1], { googleSearch: {} });
  assert.deepEqual(g.toolConfig, { includeServerSideToolInvocations: true });
  assert.equal(g.generationConfig.maxOutputTokens, 4096);
  assert.equal(g.generationConfig.temperature, 0.3);
  assert.deepEqual(g.generationConfig.stopSequences, ['END']);
  // 会思考的家族：要思考摘要
  assert.equal(g.generationConfig.thinkingConfig.includeThoughts, true);
});

test('思维签名：思考块里装的签名回放到紧跟着的调用上；2.x 不补占位；内存表兜底', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '想一下', signature: SIG_PREFIX + 'SIG-A' },
      { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { p: 1 } },
      { type: 'tool_use', id: 'toolu_b', name: 'Read', input: { p: 2 } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'x' }, { type: 'tool_result', tool_use_id: 'toolu_b', content: 'y', is_error: true }] },
  ];
  const g = toGemini({ messages: msgs }, prov, model('gemini-4-argon'));
  const parts = g.contents[1].parts;
  assert.equal(parts.length, 2, '思考正文不回放');
  assert.equal(parts[0].thoughtSignature, 'SIG-A');
  assert.equal(parts[1].thoughtSignature, undefined, '并行调用只有第一个带签名');
  assert.deepEqual(g.contents[2].parts[1].functionResponse, { name: 'Read', response: { error: 'y' } });
  // Anthropic 自己的签名（从 Claude 换过来）不当成 Gemini 的
  const foreign = toGemini({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'EqQBCkgIBRAB' }, { type: 'tool_use', id: 't1', name: 'X', input: {} }] }] }, prov, model('gemini-3.1-pro-preview'));
  assert.equal(foreign.contents[1].parts[0].thoughtSignature, SKIP_SIGNATURE);
  const old = toGemini({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'X', input: {} }] }] }, prov, model('gemini-2.5-flash'));
  assert.equal(old.contents[1].parts[0].thoughtSignature, undefined);
  rememberSignature('t3', 'SIG-MEM');
  const mem = toGemini({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'X', input: {} }] }] }, prov, model('gemini-4-carbon'));
  assert.equal(mem.contents[1].parts[0].thoughtSignature, 'SIG-MEM');
});

test('档位：applyParams 不写 Anthropic 形状，toGemini 按 thinkingLevel 写；额外请求体的 gemini 子对象并进去', () => {
  const m = model('gemini-4-carbon');
  assert.equal(m.thinking, 'effort');
  const p = { ...prov, models: [m] };
  const { body, effort } = applyParams({ model: m.id, max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }, p, m, 'low');
  assert.equal(effort, 'low');
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
  const g = toGemini({ ...body, gemini: { safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }] } }, p, m, effort);
  assert.deepEqual(g.generationConfig.thinkingConfig, { thinkingLevel: 'LOW', includeThoughts: true });
  assert.equal(g.safetySettings.length, 1);
  // 2.5 Flash 关闭档：thinkingBudget 0，不加 includeThoughts
  const f = model('gemini-2.5-flash');
  const g2 = toGemini({ messages: [{ role: 'user', content: 'hi' }] }, { ...prov, models: [f] }, f, 'off');
  assert.deepEqual(g2.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  // 不会思考的老型号：不发 thinkingConfig
  const old = toGemini({ messages: [{ role: 'user', content: 'hi' }] }, prov, model('gemini-2.0-flash'));
  assert.equal(old.generationConfig, undefined);
});

test('精简历史时 Gemini 签名思考块留着', () => {
  const m = model('gemini-4-carbon');
  const p = { ...prov, compat: { stripThinkingHistory: true }, models: [m] };
  const { body } = applyParams({ model: m.id, max_tokens: 100, messages: [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '…', signature: SIG_PREFIX + 'S' }, { type: 'thinking', thinking: 'x', signature: 'anthropic' }, { type: 'tool_use', id: 'k', name: 'X', input: {} }] },
  ] }, p, m, '');
  assert.deepEqual(body.messages[1].content.map((b) => b.signature || b.type), [SIG_PREFIX + 'S', 'tool_use']);
});

test('非流式应答：思考、正文、调用（签名进思考块）、用量、停止原因', () => {
  const msg = fromGemini({
    responseId: 'r-1',
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
      { text: '先想', thought: true }, { text: '再想', thought: true },
      { text: '我来看看' },
      { functionCall: { name: 'Bash', args: { command: 'ls' } }, thoughtSignature: 'SIG-1' },
    ] } }],
    usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
  }, 'gemini-4-carbon');
  assert.deepEqual(msg.content.map((b) => b.type), ['thinking', 'text', 'thinking', 'tool_use']);
  assert.equal(msg.content[0].thinking, '先想再想');
  assert.equal(msg.content[2].signature, SIG_PREFIX + 'SIG-1');
  assert.equal(msg.stop_reason, 'tool_use');
  assert.deepEqual(msg.usage, { input_tokens: 400, output_tokens: 50, cache_read_input_tokens: 600 });
  // 往回翻：签名落在调用上
  const back = toGemini({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: msg.content }] }, prov, model('gemini-4-carbon'));
  assert.equal(back.contents[1].parts.find((p) => p.functionCall).thoughtSignature, 'SIG-1');
  // 被拦：没有候选
  const blocked = fromGemini({ promptFeedback: { blockReason: 'SAFETY' } }, 'g');
  assert.equal(blocked.stop_reason, 'refusal');
  assert.match(blocked.content[0].text, /SAFETY/);
  assert.equal(fromGemini({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'x' }] } }] }, 'g').stop_reason, 'max_tokens');
});

test('流式：思考→正文→带签名的调用→用量，事件序列合法', () => {
  const tr = new GeminiStream('gemini-4-carbon');
  let s = '';
  s += tr.push({ candidates: [{ content: { parts: [{ text: '想', thought: true }] } }] });
  s += tr.push({ candidates: [{ content: { parts: [{ text: '法', thought: true }] } }] });
  s += tr.push({ candidates: [{ content: { parts: [{ functionCall: { name: 'Read', args: { file: 'a' } }, thoughtSignature: 'SIG-S' }, { functionCall: { name: 'Read', args: { file: 'b' } } }] } }] });
  s += tr.push({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 } });
  s += tr.end();
  const ev = events(s);
  assert.deepEqual(ev.map((e) => e.type), [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_delta', 'content_block_stop',   // 思考 + 签名
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ]);
  assert.equal(ev[4].delta.type, 'signature_delta');
  assert.equal(ev[4].delta.signature, SIG_PREFIX + 'SIG-S');
  assert.equal(ev[6].content_block.type, 'tool_use');
  assert.deepEqual(JSON.parse(ev[7].delta.partial_json), { file: 'a' });
  assert.notEqual(ev[6].content_block.id, ev[9].content_block.id);
  assert.equal(ev[12].delta.stop_reason, 'tool_use');
  assert.deepEqual(ev[12].usage, { input_tokens: 10, output_tokens: 12 });
  // 块下标连续
  assert.deepEqual(ev.filter((e) => e.type === 'content_block_start').map((e) => e.index), [0, 1, 2]);
});

test('流式：正文后面直接来带签名的调用 → 补一个空思考块装签名；联网搜索来源接在正文后', () => {
  const tr = new GeminiStream('g');
  let s = tr.push({ candidates: [{ content: { parts: [{ text: '好的' }, { functionCall: { name: 'X', args: {} }, thoughtSignature: 'Q' }] } }] });
  s += tr.end();
  const starts = events(s).filter((e) => e.type === 'content_block_start').map((e) => e.content_block.type);
  assert.deepEqual(starts, ['text', 'thinking', 'tool_use']);
  const t2 = new GeminiStream('g');
  let s2 = t2.push({ candidates: [{ content: { parts: [{ text: '答案' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://a.example/x', title: 'A' } }] }, finishReason: 'STOP' }] });
  s2 += t2.end();
  const text = events(s2).filter((e) => e.delta && e.delta.type === 'text_delta').map((e) => e.delta.text).join('');
  assert.match(text, /答案[\s\S]*\[A\]\(https:\/\/a\.example\/x\)/);
});

test('WebSearch 请求：来源翻成 server_tool_use + web_search_tool_result（CLI 只从这里读出处）；精简请求不剥 Gemini 的 web_search', () => {
  const g = { webSearchQueries: ['node lts'], groundingChunks: [{ web: { uri: 'https://x.example/1', title: 'x.example' } }, { web: { uri: 'https://y.example/2', title: 'y.example' } }] };
  const tr = new GeminiStream('g', { search: true });
  let s = tr.push({ candidates: [{ content: { parts: [{ text: '结果' }] }, groundingMetadata: g, finishReason: 'STOP' }] });
  s += tr.end();
  const ev = events(s);
  const starts = ev.filter((e) => e.type === 'content_block_start').map((e) => e.content_block);
  assert.deepEqual(starts.map((b) => b.type), ['text', 'server_tool_use', 'web_search_tool_result']);
  assert.equal(starts[2].tool_use_id, starts[1].id);
  assert.deepEqual(starts[2].content.map((r) => r.url), ['https://x.example/1', 'https://y.example/2']);
  assert.equal(JSON.parse(ev.find((e) => e.delta && e.delta.type === 'input_json_delta').delta.partial_json).query, 'node lts');
  assert.ok(!ev.some((e) => e.delta && e.delta.type === 'text_delta' && /来源/.test(e.delta.text)), '搜索请求不再把来源拼进正文');
  const msg = fromGemini({ candidates: [{ content: { parts: [{ text: '结果' }] }, groundingMetadata: g }] }, 'g', { search: true });
  assert.deepEqual(msg.content.map((b) => b.type), ['text', 'server_tool_use', 'web_search_tool_result']);
  const m = model('gemini-4-argon');
  const { body } = applyParams({ model: m.id, max_tokens: 100, messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }] }, { ...prov, compat: { slimBody: true }, models: [m] }, m, '');
  assert.deepEqual(toGemini(body, prov, m).tools, [{ googleSearch: {} }]);
  // 别的协议照旧剥掉
  const { body: ob } = applyParams({ model: m.id, max_tokens: 100, messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, { ...prov, protocol: 'openai', compat: { slimBody: true }, models: [m] }, m, '');
  assert.equal(ob.tools, undefined);
});

test('sanitizeSchema 只去 $schema', () => {
  assert.deepEqual(sanitizeSchema({ $schema: 'x', type: 'object', properties: { a: { $schema: 'y', const: 1, type: ['string', 'null'] } } }),
    { type: 'object', properties: { a: { const: 1, type: ['string', 'null'] } } });
});
