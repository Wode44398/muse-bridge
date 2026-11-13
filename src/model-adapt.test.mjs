// 各家模型的调用参数适配（2026-11 逐厂商审计后补的）：每条都对应一次真打确认过的行为，见各测试的注释。
import test from 'node:test';
import assert from 'node:assert/strict';
import { guessModel, tableEntry, replaysThinking, routeOf, fromApi } from './model-knowledge/knowledge.mjs';
import { vendorText, looksBilling } from './model-knowledge/diagnose.mjs';
import { upstreamError } from './runtime/claude-providers-proxy.mjs';
import { applyParams, toOpenAI, usageOf, padThinkingBlocks, OpenAIStream, estimateInputTokens } from './runtime/claude-providers-transform.mjs';

const tiersOf = (id, protocol) => guessModel(id, { protocol }).efforts.map((t) => t.id);
const model = (id, protocol, extra = {}) => ({ id, enabled: true, ...guessModel(id, { protocol }), ...extra });
const provider = (protocol, models, compat = {}) => ({ id: 'p-test', name: 'test', protocol, baseUrl: 'https://example.com/v1', models, compat, params: {} });
const TOOL_TURN = [
  { role: 'user', content: '北京天气？' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴' }] },
];

test('DeepSeek：聚合站写法 deepseek-v4.1-flash 认成 V4.1 Flash（识图、low / high / max），不落到 V4 Pro', () => {
  for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017', 'deepseek-v4-1-flash']) {
    const g = guessModel(id, { protocol: 'openai' });
    assert.equal(g.vision, true, id);
    assert.deepEqual(g.efforts.map((t) => t.id), ['off', 'low', 'high', 'max'], id);
  }
  const pro = guessModel('deepseek-v4-pro', { protocol: 'openai' });
  assert.equal(pro.vision, false);
  assert.deepEqual(pro.efforts.map((t) => t.id), ['off', 'low', 'high', 'max'], 'V4 Pro 也有 low 档（官方 /models）');
});

test('DeepSeek 的 /anthropic 端点：三档写 output_config.effort，不再只有开 / 关', () => {
  const g = guessModel('deepseek-flash', { protocol: 'anthropic' });
  assert.deepEqual(g.efforts.map((t) => t.id), ['off', 'low', 'high', 'max']);
  assert.deepEqual(g.efforts[0].value, { thinking: { type: 'disabled' } });
  assert.deepEqual(g.efforts[3].value, { thinking: { type: 'enabled' }, output_config: { effort: 'max' } });
  const m = model('deepseek-flash', 'anthropic');
  const out = applyParams({ model: 'deepseek-flash', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } }, provider('anthropic', [m]), m, 'low');
  assert.deepEqual(out.body.thinking, { type: 'enabled' });
  assert.deepEqual(out.body.output_config, { effort: 'low' });
  // 老会话里存的 on 档已经不在表里：按默认档处理（什么都不发 = 上游默认开思考），不报错
  const old = applyParams({ model: 'deepseek-flash', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] }, provider('anthropic', [m]), m, 'on');
  assert.equal(old.body.thinking, undefined);
});

test('DeepSeek（OpenAI 协议）：带工具调用的历史轮一律带 reasoning_content，没有原文带空串', () => {
  assert.equal(replaysThinking('deepseek-flash'), true);
  assert.equal(replaysThinking('deepseek/deepseek-v4.1-flash'), true);
  assert.equal(replaysThinking('qwen3.8-max'), false);
  const m = model('deepseek-flash', 'openai');
  const out = toOpenAI({ model: m.id, max_tokens: 100, messages: TOOL_TURN }, provider('openai', [m]), m);
  const a = out.messages.find((x) => x.role === 'assistant');
  assert.equal(a.reasoning_content, '');
  const withThinking = [TOOL_TURN[0], { role: 'assistant', content: [{ type: 'thinking', thinking: '要查天气', signature: '' }, ...TOOL_TURN[1].content] }, TOOL_TURN[2]];
  const out2 = toOpenAI({ model: m.id, max_tokens: 100, messages: withThinking }, provider('openai', [m]), m);
  assert.equal(out2.messages.find((x) => x.role === 'assistant').reasoning_content, '要查天气');
  // 没有回传规则的家族照旧不带
  const q = model('qwen3.8-max', 'openai');
  const out3 = toOpenAI({ model: q.id, max_tokens: 100, messages: withThinking }, provider('openai', [q]), q);
  assert.equal('reasoning_content' in out3.messages.find((x) => x.role === 'assistant'), false);
});

test('DeepSeek（Anthropic 协议）：带 tool_use 而没有 thinking 块的历史轮补一个空块；别家不补', () => {
  const m = model('deepseek-flash', 'anthropic');
  const out = applyParams({ model: m.id, max_tokens: 1000, messages: TOOL_TURN }, provider('anthropic', [m]), m, 'high');
  assert.deepEqual(out.body.messages[1].content[0], { type: 'thinking', thinking: '', signature: '' });
  assert.equal(out.body.messages[1].content[1].type, 'tool_use');
  // 已经有思考块的不动
  const signed = [TOOL_TURN[0], { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'sig' }, ...TOOL_TURN[1].content] }, TOOL_TURN[2]];
  assert.deepEqual(padThinkingBlocks(signed), signed);
  // 纯文本轮不补
  assert.deepEqual(padThinkingBlocks([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }])[0].content.length, 1);
  const mi = model('mimo-v2.6-pro', 'anthropic');
  const out2 = applyParams({ model: mi.id, max_tokens: 1000, messages: TOOL_TURN }, provider('anthropic', [mi]), mi, '');
  assert.equal(out2.body.messages[1].content[0].type, 'tool_use');
});

test('Claude：点号版本（聚合站 / 中转站写法）与横线写法同义', () => {
  for (const [dot, dash] of [['claude-opus-4.8', 'claude-opus-4-8'], ['anthropic/claude-sonnet-4.6', 'claude-sonnet-4-6'], ['claude-opus-5.5', 'claude-opus-5-5'], ['anthropic/claude-haiku-4.5', 'claude-haiku-4-5'], ['claude-fable-5.2', 'claude-fable-5-2']]) {
    assert.equal(tableEntry(dot), tableEntry(dash), dot);
    assert.ok(tableEntry(dot));
  }
  assert.deepEqual(tiersOf('claude-sonnet-4.6', 'anthropic'), ['low', 'medium', 'high', 'max']);
  assert.equal(guessModel('claude-opus-5.5', { protocol: 'anthropic' }).effortDefault, 'medium');
  assert.equal(guessModel('claude-opus-4.8', { protocol: 'anthropic' }).contextWindow, 1_000_000);
});

test('用量换算：缓存命中 / 写入从 input 里扣出来分开报（OpenAI、DeepSeek 两种字段）', () => {
  assert.deepEqual(usageOf({ prompt_tokens: 4000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 3700 } }), { input_tokens: 300, output_tokens: 10, cache_read_input_tokens: 3700 });
  assert.deepEqual(usageOf({ prompt_tokens: 3924, completion_tokens: 5, prompt_cache_hit_tokens: 3712 }), { input_tokens: 212, output_tokens: 5, cache_read_input_tokens: 3712 });
  assert.deepEqual(usageOf({ prompt_tokens: 7600, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 7574 } }), { input_tokens: 26, output_tokens: 5, cache_creation_input_tokens: 7574 });
  assert.deepEqual(usageOf({ prompt_tokens: 20, completion_tokens: 5 }), { input_tokens: 20, output_tokens: 5 });
  assert.deepEqual(usageOf(null), { input_tokens: 0, output_tokens: 0 });
  // 流式收尾也带上缓存读数
  const s = new OpenAIStream('m');
  s.push({ choices: [{ delta: { content: 'hi' } }] });
  s.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 80 } } });
  const tail = s.end();
  const delta = JSON.parse(tail.split('\n').find((l) => l.startsWith('data: ') && l.includes('message_delta')).slice(6));
  assert.deepEqual(delta.usage, { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 80 });
});

test('余额不足披着 429 的皮：智谱 1113、OpenAI insufficient_quota 认得出，普通限流不误判', () => {
  assert.equal(looksBilling(429, '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}'), true);
  assert.equal(looksBilling(429, '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}'), true);
  assert.equal(looksBilling(402, '{"error":{"message":"Insufficient Balance"}}'), true);
  assert.equal(looksBilling(429, '{"error":{"code":"1302","message":"您当前使用该 API 的并发数过高"}}'), false);
  assert.equal(looksBilling(429, '{"error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}'), false);
  assert.equal(looksBilling(400, '余额不足'), false);
  // Gemini 的普通每分钟限流：正文也说 exceeded your current quota，但它是限流，要照常重试
  assert.equal(looksBilling(429, '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.","status":"RESOURCE_EXHAUSTED"}}'), false);
  // 智谱 /anthropic 的余额不足：type 写的是 rate_limit_error，靠业务码认
  assert.equal(looksBilling(429, '{"type":"error","error":{"type":"rate_limit_error","code":"1113","message":"余额不足或无可用资源包,请充值。"}}'), true);
});

test('OpenRouter 转发的上游报错：把 metadata.raw 里的真正原因拼进来', () => {
  const body = JSON.stringify({ error: { message: 'Provider returned error', code: 400, metadata: { raw: '{"error":{"message":"Invalid image data"}}', provider_name: 'Azure' } }, user_id: 'user_x' });
  assert.equal(vendorText(body).msg, 'Provider returned error：Invalid image data');
  const plain = JSON.stringify({ error: { message: 'Provider returned error', metadata: { raw: 'context length exceeded' } } });
  assert.equal(vendorText(plain).msg, 'Provider returned error：context length exceeded');
  assert.equal(vendorText('{"error":{"message":"bad"}}').msg, 'bad');
});

test('线路：只把 openrouter.ai 认成 OpenRouter', () => {
  assert.equal(routeOf('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(routeOf('openrouter.ai'), 'openrouter');
  assert.equal(routeOf('https://api.deepseek.com'), '');
  assert.equal(routeOf('http://127.0.0.1:53398/x/h-1/openai'), '');
  assert.equal(routeOf(''), '');
  assert.equal(routeOf(undefined), '');
});

test('OpenRouter 线路：关闭档是 reasoning_effort:none（厂商直连的 thinking / enable_thinking 在那边被静默忽略）', () => {
  const or = (id) => guessModel(id, { protocol: 'openai', route: 'openrouter' });
  assert.deepEqual(or('deepseek/deepseek-v4.1-flash').efforts.map((x) => [x.id, x.value]), [['off', 'none'], ['low', 'low'], ['high', 'high'], ['max', 'max']]);
  assert.equal(or('deepseek/deepseek-v4.1-flash').effortField, 'reasoning_effort');
  // Qwen3.8 Max 在 OpenRouter 上必须思考：没有关闭档；Flash 只有 reasoning.enabled
  assert.deepEqual(or('qwen/qwen3.8-max-0902').efforts.map((x) => x.id), ['low', 'medium', 'xhigh']);
  assert.deepEqual(or('qwen/qwen3.8-flash').efforts.map((x) => [x.id, x.value]), [['off', { reasoning: { enabled: false } }], ['on', { reasoning: { enabled: true } }]]);
  // Claude 经 OpenAI 协议：OpenRouter 上五档都收（4.6 没有 xhigh），默认档跟官方一致
  assert.deepEqual(or('anthropic/claude-opus-5.5').efforts.map((x) => x.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(or('anthropic/claude-opus-5.5').effortDefault, 'medium');
  assert.deepEqual(or('anthropic/claude-sonnet-4.6').efforts.map((x) => x.id), ['low', 'medium', 'high', 'max']);
  // 厂商直连不变
  assert.deepEqual(guessModel('deepseek-flash', { protocol: 'openai' }).efforts[0].value, { thinking: { type: 'disabled' } });
  assert.deepEqual(guessModel('qwen3.8-max', { protocol: 'openai' }).efforts[0].value, { enable_thinking: false });
  assert.deepEqual(guessModel('claude-opus-5-5', { protocol: 'openai' }).efforts.map((x) => x.id), ['low', 'medium', 'high']);
});

test('新登记的家族：GPT-6、Grok、Muse、混元、Mistral、聚合站写法的 Kimi', () => {
  const ids = (id) => guessModel(id, { protocol: 'openai' }).efforts.map((x) => x.id);
  // GPT-6：必须思考的没有关闭档；能关的多一个 none；都不标 alwaysThinks（那会让历史思考以 reasoning_content 回传）
  for (const id of ['gpt-6.1-sol', 'openai/gpt-6.1-sol-pro', 'gpt-6-astra', 'openai/gpt-6-astra-pro', '~openai/gpt-astra-latest', 'gpt-6.1-terra-pro']) {
    assert.deepEqual(ids(id), ['low', 'medium', 'high', 'xhigh', 'max'], id);
  }
  for (const id of ['gpt-6.1-terra', 'openai/gpt-6-luna', 'gpt-6-luna-pro', 'gpt-6-sol', 'gpt-6-sol-pro', 'gpt-5.6-codex']) {
    assert.deepEqual(ids(id), ['off', 'low', 'medium', 'high', 'xhigh', 'max'], id);
    assert.equal(guessModel(id, { protocol: 'openai' }).efforts[0].value, 'none');
  }
  const sol = guessModel('openai/gpt-6.1-sol', { protocol: 'openai' });
  assert.deepEqual([sol.contextWindow, sol.maxOutput, sol.vision, sol.alwaysThinks, sol.effortDefault], [1_050_000, 128_000, true, false, 'medium']);
  // 老的 GPT-5 / o 系不变；gpt-oss 是开放权重，别被 GPT 的规则吞掉
  assert.deepEqual(ids('gpt-5.5'), ['low', 'medium', 'high']);
  assert.deepEqual(ids('o3'), ['low', 'medium', 'high']);
  const oss = guessModel('openai/gpt-oss-120b', { protocol: 'openai' });
  assert.deepEqual([oss.contextWindow, oss.vision, oss.efforts.map((x) => x.id)], [131_072, false, ['low', 'medium', 'high']]);
  assert.deepEqual(ids('x-ai/grok-4.7'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(ids('grok-4.5'), ['low', 'medium', 'high']);
  assert.deepEqual(ids('mistralai/mistral-large-4-0'), ['low', 'medium', 'high']);
  assert.deepEqual(ids('meta/muse-spark-1.3'), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(guessModel('meta/muse-ember', { protocol: 'openai' }).effortDefault, 'max');
  assert.equal(guessModel('meta/muse-ember', { protocol: 'openai' }).maxOutput, 524_288);
  assert.deepEqual(ids('muse-glimmer-30b'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(ids('tencent/hy4'), ['off', 'low', 'high']);
  // 聚合站的 kimi- 前缀：同一个恒思考型号（认不出会被当成不思考、历史思考被剥）
  const k = guessModel('moonshotai/kimi-k3.1-pro', { protocol: 'openai' });
  assert.deepEqual([k.alwaysThinks, k.efforts.map((x) => x.id), k.contextWindow], [true, ['low', 'high', 'max'], 1_048_576]);
  assert.equal(tableEntry('kimi-k3'), tableEntry('k3'));
  // Anthropic 协议下这些新家族没有已知写法：不瞎发
  assert.equal(guessModel('gpt-6.1-sol', { protocol: 'anthropic' }).thinking, 'none');
});

test('OpenRouter 的 /models 元数据：reasoning.supported_efforts 排成升序档位，none 记成能不能关，带默认档', () => {
  const a = fromApi({ id: 'x/new-model', reasoning: { supported_efforts: ['high', 'none', 'low', 'xhigh'], default_effort: 'high', mandatory: false } });
  assert.deepEqual([a.effortIds, a.effortOff, a.effortDefault], [['low', 'high', 'xhigh'], true, 'high']);
  const g = guessModel('x/new-model', { protocol: 'openai', api: { reasoning: { supported_efforts: ['high', 'none', 'low'], default_effort: 'low' } } });
  assert.deepEqual(g.efforts.map((x) => [x.id, x.value]), [['off', 'none'], ['low', 'low'], ['high', 'high']]);
  assert.equal(g.effortDefault, 'low');
  const must = guessModel('x/must-think', { protocol: 'openai', api: { reasoning: { supported_efforts: ['none', 'low', 'high'], mandatory: true } } });
  assert.deepEqual(must.efforts.map((x) => x.id), ['low', 'high']);
  // 表里有的型号以表为准（OpenRouter 对 Mistral Large 4 报的 [high, none] 是错的）
  const mis = guessModel('mistralai/mistral-large-4-0', { protocol: 'openai', api: { reasoning: { supported_efforts: ['high', 'none'] } } });
  assert.deepEqual(mis.efforts.map((x) => x.id), ['low', 'medium', 'high']);
});

test('OpenRouter 上的 Claude（OpenAI 协议）带顶层 cache_control；别家、别的线路不带', () => {
  const mk = (id, upstream) => { const m = model(id, 'openai'); return [{ model: id, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, { ...provider('openai', [m]), upstream }, m]; };
  assert.deepEqual(toOpenAI(...mk('anthropic/claude-opus-5.5', 'openrouter.ai')).cache_control, { type: 'ephemeral' });
  assert.equal('cache_control' in toOpenAI(...mk('openai/gpt-6-luna', 'openrouter.ai')), false);
  assert.equal('cache_control' in toOpenAI(...mk('anthropic/claude-opus-5.5', 'relay.example.com')), false);
  // 用户自己填 OpenRouter 地址的服务（没有 upstream 字段）：看地址
  const [b, p, m] = mk('anthropic/claude-opus-5.5', undefined);
  assert.deepEqual(toOpenAI(b, { ...p, baseUrl: 'https://openrouter.ai/api/v1' }, m).cache_control, { type: 'ephemeral' });
});

test('第三方端点：输出上限不超过「窗口 − 输入」（vLLM 这类超窗直接 400、不截断）；官方端点不动', () => {
  const m = { ...model('qwen3.8-flash-next-fp8', 'openai'), contextWindow: 262_144, maxOutput: 131_072 };
  const p = provider('openai', [m]);
  const big = 'x'.repeat(3.5 * 140_000);   // 约 14 万 token 的输入
  const out = applyParams({ model: m.id, max_tokens: 128_000, messages: [{ role: 'user', content: big }] }, p, m, '');
  assert.ok(out.body.max_tokens < 128_000 && out.body.max_tokens >= 100_000, String(out.body.max_tokens));
  assert.ok(140_000 + out.body.max_tokens <= 262_144);
  // 输入小的时候不动
  assert.equal(applyParams({ model: m.id, max_tokens: 128_000, messages: [{ role: 'user', content: 'hi' }] }, p, m, '').body.max_tokens, 128_000);
  // 估出来已经没地方了：留 4096 的下限（估算偏保守，别把回答截成几百字）
  const full = applyParams({ model: m.id, max_tokens: 128_000, messages: [{ role: 'user', content: 'x'.repeat(3.5 * 262_000) }] }, p, m, '');
  assert.equal(full.body.max_tokens, 4096);
  // 官方端点（预设 anthropic）自己会处理：不动
  const c = { ...model('claude-opus-5-5', 'anthropic'), contextWindow: 200_000 };
  const off = applyParams({ model: c.id, max_tokens: 64_000, messages: [{ role: 'user', content: 'x'.repeat(3.5 * 190_000) }] }, { ...provider('anthropic', [c]), preset: 'anthropic' }, c, '');
  assert.equal(off.body.max_tokens, 64_000);
});

test('输入估算：中文按字、图片不按 base64 算', () => {
  const zh = estimateInputTokens({ messages: [{ role: 'user', content: '中'.repeat(10_000) }] });
  assert.ok(zh > 6_000 && zh < 8_000, String(zh));
  // 思考块的签名、加密思考的密文不占上下文
  const sig = estimateInputTokens({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'S'.repeat(40_000) }, { type: 'redacted_thinking', data: 'D'.repeat(40_000) }] }] });
  assert.ok(sig < 200, String(sig));
  const img = estimateInputTokens({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2_000_000) } }] }] });
  assert.ok(img < 2_000, String(img));
});

test('非 Claude 型号的 Anthropic 兼容端点：历史里的 redacted_thinking 去掉（DeepSeek 实测 422）；Claude 型号照留', () => {
  const hist = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'enc' }, { type: 'text', text: 'ok' }] },
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'enc' }] },
    { role: 'user', content: 'go' },
  ];
  const d = model('deepseek-flash', 'anthropic');
  const out = applyParams({ model: d.id, max_tokens: 1000, messages: hist }, provider('anthropic', [d]), d, 'high');
  assert.deepEqual(out.body.messages[1].content, [{ type: 'text', text: 'ok' }]);
  assert.deepEqual(out.body.messages[2].content, [{ type: 'text', text: '…' }], '整轮只剩加密思考的补一个占位，不发空 content');
  const c = model('claude-opus-5-5', 'anthropic');
  const keep = applyParams({ model: c.id, max_tokens: 1000, messages: hist }, { ...provider('anthropic', [c]), baseUrl: 'https://relay.example.com' }, c, 'high');
  assert.equal(keep.body.messages[1].content[0].type, 'redacted_thinking');
});

test('adaptive 型号：CLI 自己定的思考显示方式（display）在按档位重写 thinking 后带回去', () => {
  const c = model('claude-opus-5-5', 'anthropic');
  const p = { ...provider('anthropic', [c]), preset: 'anthropic', compat: { promptCaching: true, slimBody: false, stripBetas: false } };
  const out = applyParams({ model: c.id, max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } }, p, c, 'low');
  assert.deepEqual(out.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(out.body.output_config, { effort: 'low' });
  const none = applyParams({ model: c.id, max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'adaptive' } }, p, c, 'low');
  assert.deepEqual(none.body.thinking, { type: 'adaptive' });
});

test('Kimi 的 Anthropic 入口：low / high / max 写 output_config.effort，关不掉', () => {
  const g = guessModel('k3.1-pro', { protocol: 'anthropic' });
  assert.deepEqual([g.efforts.map((x) => x.id), g.effortField, g.alwaysThinks], [['low', 'high', 'max'], 'output_config.effort', true]);
  const m = model('k3.1-pro', 'anthropic');
  const out = applyParams({ model: m.id, max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'adaptive' } }, provider('anthropic', [m]), m, 'max');
  assert.deepEqual(out.body.output_config, { effort: 'max' });
  assert.equal(out.body.thinking, undefined);
});

test('Kimi 订阅端点的 /models：think_efforts 现在是对象 { valid_efforts, default_effort }', () => {
  const a = fromApi({ id: 'k4-pro', think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'], default_effort: 'high' }, supports_thinking_type: 'only' });
  assert.deepEqual([a.effortIds, a.effortDefault, a.alwaysThinks], [['low', 'high', 'max'], 'high', true]);
  const g = guessModel('k4-pro', { protocol: 'openai', api: { think_efforts: { valid_efforts: ['low', 'high', 'max'], default_effort: 'high' }, supports_thinking_type: 'only' } });
  assert.deepEqual([g.efforts.map((x) => x.id), g.effortDefault, g.alwaysThinks], [['low', 'high', 'max'], 'high', true]);
  // 老的数组形状照认
  assert.deepEqual(fromApi({ think_efforts: ['low', 'high'] }).effortIds, ['low', 'high']);
});

test('聚合站的下架报错只念型号名（OpenRouter：No endpoints found for …）：说「找不到这个模型」，不说「接口地址不对」；模型中心的服务不露网关地址', () => {
  const p = { name: 'OpenRouter', protocol: 'openai', baseUrl: 'http://127.0.0.1:5/secretkey/h-1/openai', plugin: { id: 'model-hub', name: '模型中心' } };
  const body = JSON.stringify({ error: { message: 'No endpoints found for baidu/ernie-5.5-flash-preview.', code: 404 } });
  const e = upstreamError(p, p.baseUrl + '/chat/completions', 404, body, 'baidu/ernie-5.5-flash-preview');
  assert.match(e.message, /找不到这个模型/);
  // 真是地址不对（404 页）时：模型中心的服务不带网关地址，指到模型中心
  const e2 = upstreamError(p, p.baseUrl + '/chat/completions', 404, '<html>not found</html>', 'x/y');
  assert.equal(e2.message.includes('secretkey'), false);
  assert.match(e2.message, /模型中心/);
  // 用户自己填地址的服务照旧带地址
  const own = { name: '中转', protocol: 'openai', baseUrl: 'https://relay.example.com/v1' };
  assert.match(upstreamError(own, own.baseUrl + '/chat/completions', 404, '<html/>', 'x').message, /relay\.example\.com/);
  // 余额不足披着 429
  const b = upstreamError(own, own.baseUrl, 429, '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}', 'glm-5.3');
  assert.equal(b.status, 400);
  assert.match(b.message, /余额不足/);
});

test('老的 deepseek-chat / reasoner、第三方托管的蒸馏版：请求体不变（不带 reasoning_content、不补空思考块）', () => {
  for (const id of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-r1-distill-qwen-32b']) {
    assert.equal(replaysThinking(id), false, id);
    const m = model(id, 'openai');
    const a = toOpenAI({ model: id, max_tokens: 100, messages: TOOL_TURN }, provider('openai', [m]), m).messages.find((x) => x.role === 'assistant');
    assert.equal('reasoning_content' in a, false, id);
    const am = model(id, 'anthropic');
    assert.equal(applyParams({ model: id, max_tokens: 1000, messages: TOOL_TURN }, provider('anthropic', [am]), am, '').body.messages[1].content[0].type, 'tool_use', id);
  }
});

test('budget 思考档把 max_tokens 抬到预算之上之后，仍不超过剩余窗口（预算跟着压）', () => {
  const m = { ...model('claude-haiku-4-5', 'anthropic'), contextWindow: 200_000 };
  const p = { ...provider('anthropic', [m]), baseUrl: 'https://relay.example.com' };
  const input = 'x'.repeat(3.5 * 185_000);
  const out = applyParams({ model: m.id, max_tokens: 32_000, messages: [{ role: 'user', content: input }] }, p, m, 'high');
  const used = estimateInputTokens({ messages: [{ role: 'user', content: input }] });
  assert.ok(used + out.body.max_tokens <= 200_000, `${used} + ${out.body.max_tokens}`);
  assert.ok(out.body.thinking.budget_tokens < out.body.max_tokens);
});

test('Bedrock 写法、带前缀的中转 id 也认成 Claude：redacted_thinking 照留', () => {
  const hist = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'enc' }, { type: 'text', text: 'ok' }] }, { role: 'user', content: 'go' }];
  for (const id of ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-sonnet-4-5', 'cc-claude-opus-4-5', 'anthropic/claude-sonnet-4.5']) {
    // 这些写法型号表认不全，这里只看 Claude 判定：按会思考的型号给（不思考的型号历史思考本来就整段剥）
    const m = { id, enabled: true, ...guessModel('claude-sonnet-4-6', { protocol: 'anthropic' }) };
    const out = applyParams({ model: id, max_tokens: 1000, messages: hist }, { ...provider('anthropic', [m]), baseUrl: 'https://relay.example.com' }, m, '');
    assert.equal(out.body.messages[1].content[0].type, 'redacted_thinking', id);
  }
});

test('GPT-6 必须思考的型号：横线写法（gpt-6-1-sol）也不给关闭档', () => {
  for (const id of ['gpt-6-1-sol', 'gpt-6-1-sol-pro', 'gpt-6-1-terra-pro']) {
    assert.deepEqual(guessModel(id, { protocol: 'openai' }).efforts.map((x) => x.id), ['low', 'medium', 'high', 'xhigh', 'max'], id);
  }
});
