// 自定义 API（模型服务）的契约：注册表校验与密钥不外泄、参数注入优先级、思考预算与输出上限联动、兼容裁剪、
// 模型映射、OpenAI 请求翻译、流式翻译（文本 / 思考 / 工具调用）、代理端到端（假上游）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-providers-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const P = await import('./runtime/claude-providers.mjs');
const T = await import('./runtime/claude-providers-transform.mjs');
const X = await import('./runtime/claude-providers-proxy.mjs');
// fetch（undici 全局连接池）照代理回的 Keep-Alive: timeout=65 把空闲连接留约一分钟，进程得挂到那时才退：跑完关掉它
test.after(() => globalThis[Symbol.for('undici.globalDispatcher.1')]?.close());

const base = (over = {}) => P.normalizeProvider({
  name: 'Test', protocol: 'anthropic', baseUrl: 'https://api.example.com/anthropic',
  models: [
    { id: 'big-1', label: 'Big', contextWindow: 128000, maxOutput: 16000, thinking: 'budget', vision: true },
    { id: 'tiny-1', label: 'Tiny', maxOutput: 4000, thinking: 'none', vision: false },
  ],
  fastModel: 'tiny-1',
  ...over,
});

test('注册表：坏地址 / 保留请求头 / 重复模型一律 400', () => {
  assert.throws(() => P.normalizeProvider({ baseUrl: 'ftp://x' }), /http/);
  assert.throws(() => P.normalizeProvider({ baseUrl: 'https://u:p@x.com' }), /账号密码/);
  assert.throws(() => P.normalizeProvider({ baseUrl: 'https://x.com', headers: [{ name: 'Authorization', value: 'x' }] }), /bridge 自己管/);
  assert.throws(() => P.normalizeProvider({ baseUrl: 'https://x.com', models: [{ id: 'a' }, { id: 'a' }] }), /重复/);
  assert.throws(() => P.normalizeProvider({ baseUrl: 'https://x.com', params: { temperature: 3 } }), /temperature/);
  assert.throws(() => P.normalizeProvider({ baseUrl: 'https://x.com', params: { extraBody: '[1]' } }), /JSON 对象/);
  const p = base();
  assert.equal(p.defaultModel, 'big-1');
  assert.equal(p.authStyle, 'x-api-key');
});

test('注册表：Key 只给尾 4 位；custom 模型 id 解析与停用', () => {
  const p = P.createProvider({ name: 'A', baseUrl: 'https://a.example.com', apiKey: 'sk-secret-123456', models: [{ id: 'm/x:1', label: 'M' }] });
  assert.equal(p.hasKey, true);
  assert.equal(p.keyTail, '3456');
  assert.ok(!JSON.stringify(P.listProviders()).includes('sk-secret'));
  assert.equal(P.providerKey(p.id), 'sk-secret-123456');
  const cid = P.customModelId(p.id, 'm/x:1');
  assert.deepEqual(P.parseCustomModel(cid), { pid: p.id, mid: 'm/x:1' });
  assert.ok(P.resolveCustomModel(cid));
  P.updateProvider(p.id, { models: [{ id: 'm/x:1', enabled: false }] });
  assert.equal(P.resolveCustomModel(cid), null);
  P.updateProvider(p.id, { apiKey: '' });
  assert.equal(P.providerKey(p.id), '');
  P.deleteProvider(p.id);
  assert.equal(P.getProvider(p.id), null);
});

test('参数优先级：CLI < 服务级 < 模型级 < 额外请求体；输出上限不超模型上限', () => {
  const p = base({ params: { temperature: 0.3, topP: 0.9, stop: ['END'], maxTokens: 99999 } });
  p.models[0].params = P.normalizeParams({ temperature: 0.7, extraBody: '{"metadata":{"user_id":"u1"},"top_k":5}' });
  const { body } = T.applyParams({ model: 'big-1', max_tokens: 32000, messages: [], temperature: 1 }, p, p.models[0], 'off-unknown');
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.top_k, 5);
  assert.deepEqual(body.stop_sequences, ['END']);
  assert.equal(body.metadata.user_id, 'u1');
  assert.ok(body.max_tokens <= 16000);
});

test('思考：按强度给预算，预算 < 输出上限；服务策略 off / 模型不支持就不发', () => {
  const p = base();
  const hi = T.applyParams({ model: 'big-1', max_tokens: 8000, messages: [] }, p, p.models[0], 'high').body;
  assert.equal(hi.thinking.type, 'enabled');
  assert.ok(hi.thinking.budget_tokens < hi.max_tokens);
  const lo = T.applyParams({ model: 'big-1', max_tokens: 8000, messages: [] }, p, p.models[0], 'low').body;
  assert.ok(lo.thinking.budget_tokens < hi.thinking.budget_tokens);
  const off = T.applyParams({ model: 'big-1', max_tokens: 8000, messages: [], thinking: { type: 'enabled', budget_tokens: 4000 } }, base({ params: { thinking: 'off' } }), p.models[0], 'high').body;
  assert.equal(off.thinking, undefined);
  const tiny = T.applyParams({ model: 'tiny-1', max_tokens: 8000, messages: [] }, p, p.models[1], 'high').body;
  assert.equal(tiny.thinking, undefined);
});

test('模型映射：后台 haiku → 小任务模型；未知 → 会话主模型', () => {
  const p = base();
  assert.equal(T.mapModel('claude-haiku-4-5', p, 'big-1'), 'tiny-1');
  assert.equal(T.mapModel('claude-opus-5-5', p, 'big-1'), 'big-1');
  assert.equal(T.mapModel('tiny-1', p, 'big-1'), 'tiny-1');
});

test('兼容裁剪：去缓存标记 / 精简字段 / 服务端工具 / 不认图片 / 历史思考', () => {
  const p = base();
  const body = {
    model: 'tiny-1', max_tokens: 100, context_management: {}, output_config: { effort: 'high' },
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'Bash', input_schema: {} }, { type: 'web_search_20250305', name: 'web_search' }],
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }, { type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'ok' }] },
    ],
  };
  const { body: b } = T.applyParams(body, p, p.models[1], 'high');
  assert.equal(b.context_management, undefined);
  assert.equal(b.output_config, undefined);
  assert.equal(b.system[0].cache_control, undefined);
  assert.deepEqual(b.tools.map((t) => t.name), ['Bash']);
  assert.equal(b.messages[0].content[0].type, 'text');
  assert.deepEqual(b.messages[1].content.map((x) => x.type), ['text']);
});

test('OpenAI 请求翻译：系统 / 工具调用 / 工具结果 / 图片 / reasoning_effort', () => {
  const p = base({ protocol: 'openai', baseUrl: 'https://o.example.com/v1', compat: { maxTokensField: 'max_completion_tokens' } });
  // 档位按模型自定义：xhigh 原样发（以前被折成 high）
  const m = { ...p.models[0], thinking: 'effort', efforts: [{ id: 'low', name: 'Low', value: 'low' }, { id: 'xhigh', name: 'Extra', value: 'xhigh' }], effortField: '' };
  const body = {
    model: 'big-1', max_tokens: 500, stream: true, system: 'S',
    tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }],
    tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'functions.Read:0', name: 'Read', input: { p: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'functions.Read:0', content: [{ type: 'text', text: 'file' }] }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] },
    ],
  };
  const o = T.openAIReasoning(T.toOpenAI(body, p, m), m, 'xhigh');
  assert.equal(o.messages[0].role, 'system');
  assert.equal(o.messages[2].tool_calls[0].id, 'functions_Read_0');
  assert.equal(o.messages[3].role, 'tool');
  assert.equal(o.messages[3].tool_call_id, 'functions_Read_0');
  assert.equal(o.messages[4].content[0].type, 'image_url');
  assert.equal(o.tools[0].function.name, 'Read');
  assert.equal(o.tool_choice, 'required');
  assert.equal(o.max_completion_tokens, 500);
  assert.equal(o.reasoning_effort, 'xhigh');
  assert.deepEqual(o.stream_options, { include_usage: true });
});

// —— 2026-10-21：自动识别 / 按模型的档位 / 老配置迁移 ——
const K = await import('./runtime/claude-model-knowledge.mjs');

test('识别：非对话模型 / 型号表 / 接口元数据 / 协议决定思考写法', () => {
  for (const id of ['mimo-v2.5-asr', 'mimo-v2.5-tts-voiceclone', 'text-embedding-3-small', 'whisper-1', 'bge-reranker-v2', 'gpt-image-1']) assert.equal(K.guessKind(id), 'other', id);
  for (const id of ['mimo-v2.6-pro', 'deepseek-flash', 'qwen3.8-max', 'gpt-5', 'claude-opus-5-5', 'k3']) assert.equal(K.guessKind(id), 'chat', id);
  const a = K.guessModel('mimo-v2.6-pro', { protocol: 'anthropic' });
  assert.equal(a.contextWindow, 1_000_000);
  assert.equal(a.maxOutput, 131_072);
  assert.equal(a.vision, true);
  assert.equal(a.alwaysThinks, true);
  assert.deepEqual(a.efforts.map((t) => t.id), ['off', 'on']);
  assert.deepEqual(a.efforts[0].value, { thinking: { type: 'disabled' } });
  assert.equal(a.effortDefault, '');
  assert.equal(a.source.contextWindow, 'table');
  const o = K.guessModel('mimo-v2.6-pro', { protocol: 'openai' });
  assert.equal(o.effortField, 'reasoning_effort');
  assert.deepEqual(o.efforts.map((t) => t.value), ['none', 'high']);
  // Anthropic Models API 的字段
  const api = K.guessModel('claude-x', { api: { id: 'claude-x', max_input_tokens: 500000, max_tokens: 64000, capabilities: { image_input: { supported: false } } } });
  assert.equal(api.contextWindow, 500000);
  assert.equal(api.maxOutput, 64000);
  assert.equal(api.vision, false);
  assert.equal(api.source.contextWindow, 'api');
  // OpenRouter 风格
  const orr = K.guessModel('vendor/some-model:free', { protocol: 'openai', api: { id: 'vendor/some-model:free', context_length: 65536, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning'] } });
  assert.equal(orr.contextWindow, 65536);
  assert.equal(orr.vision, true);
  assert.equal(orr.thinking, 'effort');
  // 什么都不知道：默认值、不思考、不看图
  const u = K.guessModel('my-own-model');
  assert.equal(u.contextWindow, 200_000);
  assert.equal(u.vision, false);
  assert.equal(u.thinking, 'none');
  assert.equal(u.source.contextWindow, 'default');
});

test('老配置迁移：小米那份（anthropic + …/v1、asr 当默认、全 200K）读进来就改对，原有行为不丢', () => {
  assert.equal(K.fixKnownBaseUrl('anthropic', 'https://token-plan-cn.xiaomimimo.com/v1'), 'https://token-plan-cn.xiaomimimo.com/anthropic');
  assert.equal(K.fixKnownBaseUrl('openai', 'https://token-plan-cn.xiaomimimo.com/v1'), 'https://token-plan-cn.xiaomimimo.com/v1');
  assert.equal(K.fixKnownBaseUrl('anthropic', 'https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic');
  const legacyModel = (id, thinking = 'none') => ({ id, label: id, enabled: true, contextWindow: 200000, maxOutput: 32000, vision: true, thinking, params: {} });
  const p = P.normalizeProvider({
    name: '小米', protocol: 'anthropic', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', defaultModel: 'mimo-v2.5-asr',
    models: [legacyModel('mimo-v2.5-asr'), legacyModel('mimo-v2.5-tts'), legacyModel('mimo-v2.6-flash'), legacyModel('mimo-v2.6-pro', 'effort'), legacyModel('my-budget', 'budget'), legacyModel('my-adaptive', 'adaptive')],
  });
  const by = Object.fromEntries(p.models.map((m) => [m.id, m]));
  assert.equal(by['mimo-v2.5-asr'].kind, 'other');
  assert.equal(by['mimo-v2.5-tts'].kind, 'other');
  assert.equal(by['mimo-v2.5-asr'].enabled, false);   // 老配置没标 kind：认出是非对话的就默认不启用
  assert.equal(by['mimo-v2.5-tts'].enabled, false);
  assert.equal(by['mimo-v2.6-flash'].enabled, true);
  assert.equal(p.defaultModel, 'mimo-v2.6-flash');
  const pro = by['mimo-v2.6-pro'];
  assert.equal(pro.contextWindow, 1_000_000);
  assert.equal(pro.maxOutput, 131_072);
  assert.equal(pro.alwaysThinks, true);
  assert.deepEqual(pro.efforts.map((t) => t.id), ['off', 'on']);
  assert.equal(pro.effortDefault, '');
  // 老的 budget：五档、默认 high（以前没选也按 high 发）；老的 adaptive：单档自适应
  assert.deepEqual(by['my-budget'].efforts.map((t) => t.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(by['my-budget'].effortDefault, 'high');
  assert.deepEqual(by['my-adaptive'].efforts.map((t) => t.id), ['adaptive']);
  // 迁移只做一次：规范化后的再规范化不变；落盘后 kind 有值，人手动打开的非对话模型不再被关掉
  const again = P.normalizeProvider(p, p);
  assert.deepEqual(again.models.map((m) => [m.id, m.kind, m.enabled, m.contextWindow, m.efforts.length, m.effortDefault]), p.models.map((m) => [m.id, m.kind, m.enabled, m.contextWindow, m.efforts.length, m.effortDefault]));
  const reopened = P.normalizeProvider({ ...p, models: p.models.map((m) => (m.id === 'mimo-v2.5-asr' ? { ...m, enabled: true } : m)) }, p);
  assert.equal(reopened.models.find((m) => m.id === 'mimo-v2.5-asr').enabled, true);
  // 选择器清单只给对话模型；「显示在模型列表」关掉的标 hidden
  const created = P.createProvider({ ...p, showInPicker: false });
  const view = P.customModelsView().filter((m) => m.provider === created.id);
  assert.deepEqual(view.map((m) => m.name).sort(), ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'my-adaptive', 'my-budget']);
  assert.ok(view.every((m) => m.hidden === true));
  // 菜单的上下文徽章要知道值是不是估的（table / guess / default 加「≈」）：来源原样带出去
  const srcOf = (id) => (P.getProvider(created.id).models.find((m) => P.customModelId(created.id, m.id) === id)?.source?.contextWindow) || '';
  assert.ok(view.length && view.every((m) => m.ctxSource === srcOf(m.id)));
  assert.ok(view.some((m) => m.ctxSource), '迁移来的模型带着来源');
  assert.deepEqual(view.find((m) => m.name === 'mimo-v2.6-pro').efforts, [{ id: 'off', name: '关闭' }, { id: 'on', name: '开启' }]);
  const cid = P.customModelId(created.id, 'mimo-v2.6-pro');
  assert.equal(P.customEffortOk(cid, 'off'), true);
  assert.equal(P.customEffortOk(cid, 'xhigh'), false);
  assert.ok(P.resolveCustomModel(cid));   // 隐藏不影响正在用的会话
  P.deleteProvider(created.id);
});

test('档位：按模型的档位表发；没选用默认档、默认档空就什么都不发；不在表里的按没选', () => {
  const p = P.normalizeProvider({ name: 'M', protocol: 'anthropic', baseUrl: 'https://x.example.com/anthropic', models: [{ id: 'mimo-v2.6-pro' }] });
  const m = p.models[0];
  const send = (eff) => T.applyParams({ model: m.id, max_tokens: 1000, messages: [], thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }, p, m, eff).body;
  assert.equal(send('').thinking, undefined);            // 不选 = 不发（厂商默认）
  assert.equal(send('').output_config, undefined);       // CLI 自己的 output_config.effort 不转发
  assert.deepEqual(send('off').thinking, { type: 'disabled' });
  assert.deepEqual(send('on').thinking, { type: 'enabled' });
  assert.equal(send('xhigh').thinking, undefined);       // 官方档位带过来：按没选
  // 服务策略 off：压到「关闭」档；on：没选时用最高档
  const pOff = { ...p, params: { ...p.params, thinking: 'off' } };
  assert.deepEqual(T.applyParams({ model: m.id, max_tokens: 100, messages: [] }, pOff, m, 'on').body.thinking, { type: 'disabled' });
  const pOn = { ...p, params: { ...p.params, thinking: 'on' } };
  assert.deepEqual(T.applyParams({ model: m.id, max_tokens: 100, messages: [] }, pOn, m, '').body.thinking, { type: 'enabled' });
  // 自定义写入字段：点分路径
  const q = P.normalizeProvider({ name: 'Q', protocol: 'openai', baseUrl: 'https://q.example.com/v1', models: [{ id: 'x', thinking: 'effort', efforts: [{ id: 'deep', name: '深', value: 'high' }], effortField: 'reasoning.effort', effortDefault: 'deep' }] });
  const qm = q.models[0];
  const { body, effort } = T.applyParams({ model: 'x', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, q, qm, '');
  assert.equal(effort, 'deep');
  const oai = T.openAIReasoning(T.toOpenAI(body, q, qm), qm, effort);
  assert.deepEqual(oai.reasoning, { effort: 'high' });
  // 档位校验
  assert.throws(() => P.normalizeProvider({ baseUrl: 'https://x.com', models: [{ id: 'a', thinking: 'effort', efforts: [{ id: 'Bad Id' }] }] }), /档位 ID/);
  assert.throws(() => P.normalizeProvider({ baseUrl: 'https://x.com', models: [{ id: 'a', thinking: 'effort', efforts: [{ id: 'a' }], effortField: '__proto__.x' }] }), /写入字段/);
  // 切到「不思考」后看不见的档位表不校验（前端也放行），直接清空
  const none = P.normalizeProvider({ baseUrl: 'https://x.com', models: [{ id: 'a', thinking: 'none', efforts: [{ id: '高' }], effortDefault: '高' }] });
  assert.deepEqual([none.models[0].efforts, none.models[0].effortDefault], [[], '']);
});

test('老版 apk 的编辑器：带回空档位表又选了预算 / 自适应 / 档位，按老规则补档位，别变成什么都不发', () => {
  const p = P.normalizeProvider({ baseUrl: 'https://x.com/v1', protocol: 'openai', models: [
    { id: 'b', thinking: 'budget', efforts: [] }, { id: 'a', thinking: 'adaptive', efforts: [] }, { id: 'e', thinking: 'effort', efforts: [] }, { id: 'n', thinking: 'none', efforts: [] },
  ] });
  const by = Object.fromEntries(p.models.map((m) => [m.id, m]));
  assert.deepEqual(by.b.efforts.map((t) => t.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(by.b.effortDefault, 'high');
  assert.deepEqual([by.a.efforts.map((t) => t.id), by.a.effortDefault], [['adaptive'], 'adaptive']);
  assert.deepEqual([by.e.efforts.map((t) => t.id), by.e.effortDefault], [['low', 'medium', 'high'], 'high']);
  assert.deepEqual(by.n.efforts, []);
  const ap = P.normalizeProvider({ baseUrl: 'https://x.com/anthropic', models: [{ id: 'b', thinking: 'budget', efforts: [], maxOutput: 32000 }] });
  assert.equal(T.applyParams({ model: 'b', max_tokens: 8000, messages: [] }, ap, ap.models[0], '').body.thinking.type, 'enabled');
});

test('小任务模型只认启用的对话模型：指到 asr 上的就地清掉，env 也不映射过去', async () => {
  const p = P.normalizeProvider({ baseUrl: 'https://x.com/anthropic', fastModel: 'mimo-v2.5-asr', models: [{ id: 'mimo-v2.6-flash', kind: 'chat' }, { id: 'mimo-v2.5-asr', kind: 'other', enabled: true }] });
  assert.equal(p.fastModel, '');
  const off = P.normalizeProvider({ baseUrl: 'https://x.com/anthropic', fastModel: 'b', models: [{ id: 'a', kind: 'chat' }, { id: 'b', kind: 'chat', enabled: false }] });
  assert.equal(off.fastModel, '');
  const env = await X.providerEngineEnv({}, { provider: { ...p, id: 'p-000000', fastModel: 'mimo-v2.5-asr' }, model: p.models[0], effort: '' });
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'mimo-v2.6-flash');
});

test('上游报错：非 JSON 的 429 保留 429（CLI 照样重试、错误卡说限流），非 JSON 的 4xx 才改 400', () => {
  const prov = { name: '网关', protocol: 'openai', baseUrl: 'https://g.example.com/v1' };
  const r429 = X.upstreamError(prov, 'https://g.example.com/v1/chat/completions', 429, '<html>429 Too Many Requests</html>');
  assert.deepEqual([r429.status, r429.type], [429, 'rate_limit_error']);
  const r502 = X.upstreamError(prov, 'u', 502, 'Bad Gateway');
  assert.deepEqual([r502.status, r502.type], [502, 'api_error']);
  const r418 = X.upstreamError(prov, 'u', 418, 'teapot');
  assert.deepEqual([r418.status, r418.type], [400, 'invalid_request_error']);
  assert.equal(X.upstreamError(prov, 'u', 429, JSON.stringify({ error: { message: 'slow down' } })), null);   // JSON 的照原样转发
});

test('隐私：safeguards 一律不发给第三方；metadata 只有官方端点才转发', () => {
  const p = base();
  const b = T.applyParams({ model: 'tiny-1', max_tokens: 10, messages: [], safeguards: [{ classifier_context: { home_dir: 'C:/Users/x' } }], metadata: { user_id: 'acct' } }, p, p.models[1], '').body;
  assert.equal(b.safeguards, undefined);
  assert.equal(b.metadata, undefined);
  const official = base({ preset: 'anthropic', baseUrl: 'https://api.anthropic.com', compat: { slimBody: false } });
  const b2 = T.applyParams({ model: 'tiny-1', max_tokens: 10, messages: [], safeguards: [{}], metadata: { user_id: 'acct' } }, official, official.models[1], '').body;
  assert.equal(b2.safeguards, undefined);
  assert.equal(b2.metadata.user_id, 'acct');
});

test('不思考的模型才剥历史思考；不发参数也会想的（alwaysThinks）留着', () => {
  const p = P.normalizeProvider({ name: 'A', baseUrl: 'https://a.example.com', models: [{ id: 'plain', thinking: 'none', efforts: [] }, { id: 'thinker', thinking: 'none', efforts: [], alwaysThinks: true }] });
  const msgs = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'ok' }] }];
  assert.deepEqual(T.applyParams({ model: 'plain', max_tokens: 10, messages: msgs }, p, p.models[0], '').body.messages[0].content.map((x) => x.type), ['text']);
  assert.deepEqual(T.applyParams({ model: 'thinker', max_tokens: 10, messages: msgs }, p, p.models[1], '').body.messages[0].content.map((x) => x.type), ['thinking', 'text']);
});

test('探测解析：输出上限与 reasoning_effort 可选值从报错原文里读', () => {
  assert.equal(X.parseLimit("'max_tokens' 10000000 is out of supported range (0, 131072]"), 131072);
  assert.equal(X.parseLimit('max_tokens supports at most 131072 completion tokens'), 131072);
  assert.equal(X.parseLimit('valid range of max_tokens is [1, 393216]'), 393216);
  assert.equal(X.parseLimit('Range of max_tokens should be [1, 131072]'), 131072);
  assert.equal(X.parseLimit('nothing here'), null);
  assert.deepEqual(X.parseEffortList("reasoning_effort must be one of 'none', 'low', 'medium' or 'high'"), ['none', 'low', 'medium', 'high']);
});

test('压缩点：自定义模型没设压缩点不覆盖（真实窗口走 CLAUDE_CODE_MAX_CONTEXT_TOKENS），设了按比例', async () => {
  const C = await import('./runtime/ctx-usage.mjs');
  assert.equal(C.customCompactWindow(undefined, 1_000_000), undefined);
  assert.equal(C.customCompactWindow(0.5, 1_000_000), 533_000);
  assert.equal(C.customCompactWindow(0.5, 32_000), undefined);   // 到不了原生窗口以下：不覆盖
  // 200K 窗口设得低：夹到 100K（约 67K 压缩），别退回不覆盖（约 167K 才压）；原生窗口不到 100K 的 CLI 自己按 min 夹回
  assert.equal(C.customCompactWindow(0.3, 200_000), 100_000);
  assert.equal(C.customCompactWindow(0.1, 64_000), 100_000);
});

const parseSse = (s) => s.split('\n\n').filter(Boolean).map((blk) => JSON.parse(blk.split('\n').find((l) => l.startsWith('data:')).slice(5)));

test('OpenAI 流式翻译：思考 → 文本 → 两个工具调用 → 用量与停止原因', () => {
  const t = new T.OpenAIStream('m1');
  let out = '';
  out += t.push({ choices: [{ delta: { reasoning_content: 'think ' } }] });
  out += t.push({ choices: [{ delta: { content: 'Hi' } }] });
  out += t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"cmd":' } }] } }] });
  out += t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] });
  out += t.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
  out += t.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 7 } });
  out += t.end();
  const ev = parseSse(out);
  const types = ev.map((e) => e.type);
  assert.equal(types[0], 'message_start');
  const starts = ev.filter((e) => e.type === 'content_block_start').map((e) => e.content_block.type);
  assert.deepEqual(starts, ['thinking', 'text', 'tool_use', 'tool_use']);
  const json = ev.filter((e) => e.delta && e.delta.type === 'input_json_delta' && e.index === 2).map((e) => e.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(json), { cmd: 'ls' });
  const md = ev.find((e) => e.type === 'message_delta');
  assert.equal(md.delta.stop_reason, 'tool_use');
  assert.equal(md.usage.output_tokens, 7);
  assert.equal(types.at(-1), 'message_stop');
  // 每个 start 都有配对的 stop
  assert.equal(ev.filter((e) => e.type === 'content_block_stop').length, 4);
});

// —— 代理端到端：假上游（Anthropic / OpenAI 两种），走真代理 + 真改写 ——
async function fakeUpstream(handler) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    seen.push({ url: req.url, headers: req.headers, body });
    handler(req, res, body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() };
}

test('代理：Anthropic 协议改写参数、换鉴权、不外泄 OAuth、按强度给思考', async () => {
  const up = await fakeUpstream((req, res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 3, output_tokens: 1 } })); });
  try {
    const p = P.createProvider({ name: 'Fake', baseUrl: up.url, apiKey: 'k-anth', compat: { useProxy: false }, params: { temperature: 0.2 }, models: [{ id: 'big-1', thinking: 'budget', maxOutput: 20000 }] });
    const env = await X.providerEngineEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret', PATH: 'x' }, { provider: P.getProvider(p.id), model: P.getProvider(p.id).models[0], effort: 'low' });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.ok(env.ANTHROPIC_BASE_URL.includes('/p/' + p.id + '/low/big-1'));
    const r = await fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer oauth-secret', 'anthropic-beta': 'x' }, body: JSON.stringify({ model: 'big-1', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(r.status, 200);
    const s = up.seen[0];
    assert.equal(s.headers['x-api-key'], 'k-anth');
    assert.equal(s.headers.authorization, undefined);
    assert.equal(s.headers['anthropic-beta'], undefined);
    assert.equal(s.body.temperature, 0.2);
    assert.equal(s.body.thinking.type, 'enabled');
    assert.ok(X.providerLog(p.id).length >= 1);
    P.deleteProvider(p.id);
  } finally { up.close(); }
});

test('fast：只有官方 api.anthropic.com + 实测支持的 Opus 才算；第三方地址、OpenAI 协议、Sonnet 一律不算', () => {
  const off = P.normalizeProvider({ name: 'A', baseUrl: 'https://api.anthropic.com', models: [{ id: 'claude-opus-5-5' }, { id: 'claude-opus-4-7' }, { id: 'claude-sonnet-5-5' }] });
  assert.equal(P.customSupportsFast(off, off.models[0]), true);
  assert.equal(P.customSupportsFast(off, off.models[1]), false);   // Opus 4.7 走 API 带 speed 必 400
  assert.equal(P.customSupportsFast(off, off.models[2]), false);
  const relay = P.normalizeProvider({ name: 'R', baseUrl: 'https://relay.example.com', models: [{ id: 'claude-opus-5-5' }] });
  assert.equal(P.customSupportsFast(relay, relay.models[0]), false);
  const oai = P.normalizeProvider({ name: 'O', protocol: 'openai', baseUrl: 'https://api.anthropic.com/v1', models: [{ id: 'claude-opus-5-5' }] });
  assert.equal(P.customSupportsFast(oai, oai.models[0]), false);
  // 探测结论压过实测表
  P._resetFastProbesForTests({ 'claude-opus-5-5': { ok: false, at: Date.now() }, 'claude-sonnet-5-5': { ok: true, at: Date.now() } });
  assert.equal(P.customSupportsFast(off, off.models[0]), false);
  assert.equal(P.customSupportsFast(off, off.models[2]), true);
  // 过期的探测不算，回落实测表
  P._resetFastProbesForTests({ 'claude-opus-5-5': { ok: false, at: Date.now() - P.FAST_PROBE_TTL - 1 } });
  assert.equal(P.customSupportsFast(off, off.models[0]), true);
  P._resetFastProbesForTests();
});

test('官方 API：CLI 的 beta 头照转（context_management 离了 beta 头必 400）；第三方剥头时连依赖字段一起剥；speed 只由开关决定', () => {
  const body = { model: 'claude-opus-5-5', max_tokens: 100, messages: [], context_management: { edits: [] }, speed: 'fast' };
  const off = P.normalizeProvider({ name: 'A', preset: 'anthropic', baseUrl: 'https://api.anthropic.com', compat: { stripBetas: true, slimBody: false }, params: { extraBody: '{"speed":"fast","x":1}' }, models: [{ id: 'claude-opus-5-5' }] });
  assert.equal(T.keepsBetas(off), true);                      // 老配置勾着「去掉 beta 请求头」也照转
  const o = T.applyParams(body, off, off.models[0], '').body;
  assert.deepEqual(o.context_management, { edits: [] });
  assert.equal(o.speed, undefined);                           // CLI 带的、额外请求体写的 speed 都不发
  assert.equal(o.x, 1);
  const third = P.normalizeProvider({ name: 'R', baseUrl: 'https://relay.example.com', compat: { stripBetas: true, slimBody: false }, models: [{ id: 'claude-opus-5-5' }] });
  assert.equal(T.keepsBetas(third), false);
  assert.equal(T.applyParams(body, third, third.models[0], '').body.context_management, undefined);
  const keep = P.normalizeProvider({ name: 'K', baseUrl: 'https://relay.example.com', compat: { stripBetas: false, slimBody: false }, models: [{ id: 'm' }] });
  assert.deepEqual(T.applyParams(body, keep, keep.models[0], '').body.context_management, { edits: [] });
  assert.equal(T.applyParams(body, keep, keep.models[0], '').body.speed, 'fast');   // 第三方的 speed 不归开关管，原样
});

test('fast 自动识别：官方地址逐个型号真打一次，200 / fast 额度 429 = 支持，400 不认 speed = 不支持，网络错不下结论', async () => {
  P._fastHostForTests('127.0.0.1');
  P._resetFastProbesForTests();
  X._resetFastProbeStateForTests();
  const up = await fakeUpstream((req, res, body) => {
    const err = (status, type, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type, message } })); };
    if (body.model === 'claude-sonnet-5-5') return err(400, 'invalid_request_error', "'claude-sonnet-5-5' does not support the `speed` parameter. This feature is only available on supported models.");
    if (body.model === 'claude-opus-5') return err(429, 'rate_limit_error', 'rate limit of 0 fast mode input tokens per minute');
    if (body.model === 'flaky') return err(500, 'api_error', 'boom');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1, speed: 'fast' } }));
  });
  try {
    const p = P.createProvider({ name: 'Anth', baseUrl: up.url, apiKey: 'k', compat: { useProxy: false }, models: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5' }, { id: 'flaky' }, { id: 'off', enabled: false }] });
    const changes = [];
    const unsub = X.onFastProbeChange((e) => changes.push(e));
    assert.equal(await X.ensureFastProbes(P.getProvider(p.id)), 3);
    const sent = up.seen.filter((s) => s.body);
    assert.ok(sent.every((s) => s.body.speed === 'fast' && s.body.max_tokens === 1 && /fast-mode-2026-02-01/.test(s.headers['anthropic-beta'])));
    assert.ok(!sent.some((s) => s.body.model === 'off'));
    assert.equal(P.fastProbe('claude-opus-5-5'), true);
    assert.equal(P.fastProbe('claude-sonnet-5-5'), false);
    assert.equal(P.fastProbe('claude-opus-5'), true);
    assert.equal(P.fastProbe('flaky'), null);
    assert.equal(changes.length, 3);
    const view = P.customModelsView().filter((m) => m.provider === p.id);
    assert.deepEqual(view.map((m) => [m.id.split(':').pop(), m.fast]), [['claude-opus-5-5', true], ['claude-sonnet-5-5', false], ['claude-opus-5', true], ['flaky', false]]);
    // 探过的不重探；不下结论的 10 分钟内也不重探
    const n = up.seen.length;
    assert.equal(await X.ensureFastProbes(P.getProvider(p.id)), 0);
    assert.equal(up.seen.length, n);
    unsub();
    P.deleteProvider(p.id);
  } finally { up.close(); P._resetFastProbesForTests(); X._resetFastProbeStateForTests(); }
});

test('代理 fast：带 speed 与 beta 头；fast 额度 429 当场按普通速度重发、退避期内不再带、通知正在跑的轮', async () => {
  P._fastHostForTests('127.0.0.1');
  X._resetFastForTests();
  let refuse = false;
  const up = await fakeUpstream((req, res, body) => {
    if (refuse && body.speed === 'fast') { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your organization’s rate limit of 0 fast mode input tokens per minute' } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 3, output_tokens: 1 } }));
  });
  try {
    const p = P.createProvider({ name: 'Anth', baseUrl: up.url, apiKey: 'k', compat: { useProxy: false }, retries: 2, models: [{ id: 'claude-opus-5-5' }] });
    const prov = P.getProvider(p.id);
    const env = await X.providerEngineEnv({}, { provider: prov, model: prov.models[0], effort: 'high', fast: true });
    assert.ok(env.ANTHROPIC_BASE_URL.includes('/p/' + p.id + '/high.f/claude-opus-5-5'));
    const call = () => fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal((await call()).status, 200);
    assert.equal(up.seen[0].body.speed, 'fast');
    assert.match(up.seen[0].headers['anthropic-beta'], /fast-mode-2026-02-01/);

    refuse = true;
    const events = [];
    const off = X.onFastFallback((e) => events.push(e));
    const n = up.seen.length;
    assert.equal((await call()).status, 200);
    assert.equal(up.seen.length - n, 2);                  // fast 那次不走通用重试：一次 429 + 一次普通速度
    assert.equal(up.seen.at(-1).body.speed, undefined);
    assert.equal(up.seen.at(-1).headers['anthropic-beta'], undefined);
    assert.equal(events.length, 1);
    assert.equal(X.fastCooling(p.id), true);
    off();

    const m = up.seen.length;
    assert.equal((await call()).status, 200);             // 退避期内直接普通速度
    assert.equal(up.seen.length - m, 1);
    assert.equal(up.seen.at(-1).body.speed, undefined);

    // 不开 fast 的轮（路径没有 .f）从不带
    const plain = await X.providerEngineEnv({}, { provider: prov, model: prov.models[0], effort: 'high' });
    assert.ok(!plain.ANTHROPIC_BASE_URL.includes('.f/'));
    P.deleteProvider(p.id);
  } finally { up.close(); X._resetFastForTests(); }
});

test('代理：OpenAI 协议流式整体翻译成 Anthropic SSE', async () => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  try {
    const p = P.createProvider({ name: 'Oai', protocol: 'openai', baseUrl: up.url + '/v1', apiKey: 'k-oai', compat: { useProxy: false }, models: [{ id: 'gpt-x' }] });
    const env = await X.providerEngineEnv({}, { provider: P.getProvider(p.id), model: P.getProvider(p.id).models[0], effort: '' });
    const r = await fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-x', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    const text = await r.text();
    const ev = parseSse(text);
    const textOut = ev.filter((e) => e.delta && e.delta.type === 'text_delta').map((e) => e.delta.text).join('');
    assert.equal(textOut, 'Hello');
    assert.equal(up.seen[0].url, '/v1/chat/completions');
    assert.equal(up.seen[0].headers.authorization, 'Bearer k-oai');
    assert.equal(ev.find((e) => e.type === 'message_delta').usage.output_tokens, 2);
    P.deleteProvider(p.id);
  } finally { up.close(); }
});

test('代理：上游 503 先重试再成功；超限重试后如实报错', async () => {
  let n = 0;
  const up = await fakeUpstream((req, res) => {
    n++;
    if (n < 2) { res.writeHead(503); res.end('busy'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'message', content: [], usage: {} }));
  });
  try {
    const p = P.createProvider({ name: 'R', baseUrl: up.url, compat: { useProxy: false }, retries: 2, models: [{ id: 'm' }] });
    const env = await X.providerEngineEnv({}, { provider: P.getProvider(p.id), model: P.getProvider(p.id).models[0], effort: '' });
    const r = await fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', max_tokens: 10, messages: [] }) });
    assert.equal(r.status, 200);
    assert.equal(n, 2);
    P.deleteProvider(p.id);
  } finally { up.close(); }
});

test('代理：CLI 的 env 带真实上下文窗口、只补 1 次重试；档位 id 进地址', async () => {
  const p = P.createProvider({ name: 'E', baseUrl: 'https://e.example.com/anthropic', models: [{ id: 'mimo-v2.6-pro' }] });
  try {
    const prov = P.getProvider(p.id);
    const env = await X.providerEngineEnv({ CLAUDE_CODE_MAX_RETRIES: '10' }, { provider: prov, model: prov.models[0], effort: 'off' });
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '131072');
    assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '1');
    assert.ok(env.ANTHROPIC_BASE_URL.includes('/p/' + p.id + '/off/'));
  } finally { P.deleteProvider(p.id); }
});

test('代理：上游 404（地址 / 协议不对）与 401 改写成 400 + 人话，CLI 不再说「所选模型有问题」「登录失效」', async () => {
  const up = await fakeUpstream((req, res) => {
    if (req.url === '/v1/messages') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html><body><center>404 Not Found</center><hr><center>openresty</center></body></html>'); return; }
    if (req.url === '/k/v1/messages') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Invalid API Key' } })); return; }
    res.writeHead(500); res.end();
  });
  try {
    const a = P.createProvider({ name: '小米', baseUrl: up.url + '/v1', compat: { useProxy: false }, retries: 0, models: [{ id: 'm' }] });
    const env = await X.providerEngineEnv({}, { provider: P.getProvider(a.id), model: P.getProvider(a.id).models[0], effort: '' });
    const r = await fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', max_tokens: 10, messages: [] }) });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error.type, 'invalid_request_error');
    assert.match(j.error.message, /接口地址不对/);
    // 不是实测过的站（小米 xiaomimimo.com）就只说「有的服务」——中转的 …/v1/messages 常常本来就是 Anthropic 接口
    assert.match(j.error.message, /有的服务 …\/v1 下只有 OpenAI 兼容接口/);
    const b = P.createProvider({ name: 'K', baseUrl: up.url + '/k', compat: { useProxy: false }, retries: 0, models: [{ id: 'm' }] });
    const env2 = await X.providerEngineEnv({}, { provider: P.getProvider(b.id), model: P.getProvider(b.id).models[0], effort: '' });
    const r2 = await fetch(env2.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', max_tokens: 10, messages: [] }) });
    assert.equal(r2.status, 400);
    const m2 = (await r2.json()).error.message;
    assert.match(m2, /API Key 被拒绝了（401）：Invalid API Key/);
    assert.match(m2, /去「设置 › Claude › 模型服务 › K」检查 Key/);   // 服务名和后面的动词隔开
    assert.doesNotMatch(m2, /^模型服务「/);                            // 错误卡标题已带服务名，正文不再以它开头
    P.deleteProvider(a.id); P.deleteProvider(b.id);
  } finally { up.close(); }
});

test('设置页：Anthropic 端点下没有 /models 时去同站 /v1 拉；一键识别协议推荐能通的地址；草稿也能测', async () => {
  // 仿小米：/anthropic/v1/messages 与 /v1/chat/completions 通，/v1/messages 404，/anthropic/v1/models 404，/v1/models 有列表
  const up = await fakeUpstream((req, res) => {
    const ok = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/v1/models') return ok({ data: [{ id: 'mimo-v2.5-asr', object: 'model' }, { id: 'mimo-v2.6-pro', object: 'model' }] });
    if (req.url === '/anthropic/v1/messages') return ok({ type: 'message', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 3, output_tokens: 1 } });
    if (req.url === '/v1/chat/completions') return ok({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>404</html>');
  });
  try {
    const draft = { protocol: 'anthropic', baseUrl: up.url + '/anthropic', authStyle: 'x-api-key', apiKey: 'k', compat: { useProxy: false }, headers: [], models: [] };
    const list = await X.fetchRemoteModels(draft);
    assert.deepEqual(list.map((m) => [m.id, m.kind]), [['mimo-v2.5-asr', 'other'], ['mimo-v2.6-pro', 'chat']]);
    assert.equal(list[1].contextWindow, 1_000_000);
    const d = await X.detectProtocol({ ...draft, baseUrl: up.url + '/v1', name: '小米' });
    assert.equal(d.ok, false);
    assert.equal(d.current.result, 'missing');
    assert.deepEqual([d.suggest.protocol, d.suggest.baseUrl], ['anthropic', up.url + '/anthropic']);
    assert.ok(d.results.some((r) => r.protocol === 'openai' && r.baseUrl === up.url + '/v1' && r.result === 'ok'));
    const norm = P.normalizeProvider({ ...draft, name: '草稿', models: [{ id: 'mimo-v2.6-pro' }] });
    const t = await X.testProvider({ draft: { ...norm, apiKey: 'k' } });
    assert.equal(t.ok, true);
    assert.equal(t.reply, 'OK');
    const bad = await X.testProvider({ draft: { ...norm, baseUrl: up.url + '/v1', apiKey: 'k' } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /接口地址不对/);
  } finally { up.close(); }
});

test('探测能力逐档试时不被服务的「思考：始终关」改写；测试连接照策略发', async () => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: '2' }], usage: { input_tokens: 3, output_tokens: 1 } })); });
  try {
    const p = { ...P.normalizeProvider({ name: 'M', baseUrl: up.url + '/anthropic', compat: { useProxy: false }, params: { thinking: 'off' }, models: [{ id: 'mimo-v2.6-pro' }] }), apiKey: 'k' };
    const r = await X.probeModel(p, p.models[0]);
    assert.deepEqual(r.tiers.map((x) => [x.id, x.ok]), [['off', true], ['on', true]]);
    const sent = up.seen.map((s) => s.body && s.body.thinking && s.body.thinking.type).filter(Boolean);
    assert.ok(sent.includes('enabled'), '探测 on 档要真发 enabled：' + JSON.stringify(sent));
    up.seen.length = 0;
    await X.testProvider({ draft: p });
    assert.deepEqual(up.seen[0].body.thinking, { type: 'disabled' });   // 测试连接 = 真实对话没选档位时的样子（策略压到关闭档）
  } finally { up.close(); }
});

// —— 2026-10-21：型号知识和 dimensio 的自定义服务共用一份（src/model-knowledge/），以 dimensio catalog 的逐型号实测为准合表 ——
test('共用型号知识：claude-model-knowledge 只是转出；Sonnet 4.6 没有 xhigh；Haiku 4.5 的关闭档不开思考；中转省掉 claude- 前缀也认得', async () => {
  const S = await import('./model-knowledge/index.mjs');
  assert.equal(K.guessModel, S.guessModel);
  assert.equal(K.tableEntry, S.tableEntry);
  // 老配置迁移（没有档位表）按型号表补档位：Sonnet 4.6 只有四档（以前开了 xhigh，选了必 400）
  const p = P.normalizeProvider({ name: 'A', protocol: 'anthropic', baseUrl: 'https://api.example.com', models: [{ id: 'claude-sonnet-4-6', thinking: 'none' }, { id: 'claude-haiku-4-5', thinking: 'none' }, { id: 'opus-5-5', thinking: 'none' }] });
  const by = Object.fromEntries(p.models.map((m) => [m.id, m]));
  assert.deepEqual(by['claude-sonnet-4-6'].efforts.map((t) => t.id), ['low', 'medium', 'high', 'max']);
  assert.equal(by['opus-5-5'].contextWindow, 1_000_000);
  assert.equal(by['opus-5-5'].effortDefault, 'medium', 'Opus 5.5 的 API 默认档是 medium');
  const h = by['claude-haiku-4-5'];
  assert.deepEqual(h.efforts.map((t) => t.id), ['off', 'low', 'medium', 'high']);
  const send = (eff) => T.applyParams({ model: h.id, max_tokens: 1000, messages: [] }, p, h, eff).body;
  assert.equal(send('off').thinking, undefined, 'budget 方式的关闭档：不开思考');
  assert.equal(send('').thinking, undefined, '没选档位：什么都不发');
  assert.deepEqual(send('high').thinking, { type: 'enabled', budget_tokens: 12000 });
});

// —— 子 agent 调度：档位互换、跨服务路由（设置 › Claude › 对话 › 子 agent 调度偏好）——
test('子 agent 选档：官方五档 ⇄ 模型档位表，同名直取、其余按相对位置；Ultracode = 最高的开着的档', () => {
  const five = { efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id })) };
  const three = { efforts: [{ id: 'off' }, { id: 'minimal' }, { id: 'normal' }, { id: 'deep' }] };
  assert.equal(T.tierForLevel(five, 'xhigh'), 'xhigh');
  assert.equal(T.tierForLevel(three, 'low'), 'minimal');
  assert.equal(T.tierForLevel(three, 'medium'), 'normal');
  assert.equal(T.tierForLevel(three, 'max'), 'deep');
  assert.equal(T.tierForLevel({ efforts: [] }, 'high'), '');
  assert.equal(T.levelForTier(five, 'medium'), 'medium');
  assert.equal(T.levelForTier(three, 'deep'), 'max');
  assert.equal(T.levelForTier(three, 'off'), 'low');
  assert.equal(T.levelForTier(three, ''), 'high');            // 没选、也没默认档
  assert.equal(P.customTopTier(three), 'deep');
  assert.equal(P.customTopTier({ efforts: [{ id: 'off' }] }), '');
});

test('子 agent 选模型：主循环 / 继承档位的照用路径档；自己挑了档的换算；写了别的服务的模型名就跨服务', () => {
  const a = base();
  const big = a.models[0];   // budget 五档
  const other = { id: 'p-other0', models: [{ id: 'mimo-flash', enabled: true, efforts: [{ id: 'low' }, { id: 'high' }] }] };
  const lookup = (n) => (n === 'mimo-flash' ? { provider: other, model: other.models[0] } : null);
  const sess = T.levelForTier(big, 'xhigh');
  let r = T.pickTarget({ model: 'big-1', output_config: { effort: sess } }, a, big, 'xhigh', lookup);
  assert.deepEqual([r.model.id, r.effort, r.routed], ['big-1', 'xhigh', false]);
  r = T.pickTarget({ model: 'big-1', output_config: { effort: 'low' } }, a, big, 'xhigh', lookup);
  assert.equal(r.effort, 'low');
  r = T.pickTarget({ model: 'mimo-flash', output_config: { effort: 'medium' } }, a, big, 'xhigh', lookup);
  assert.deepEqual([r.provider.id, r.model.id, r.effort, r.routed], ['p-other0', 'mimo-flash', 'low', true]);
  r = T.pickTarget({ model: 'claude-haiku-4-5' }, a, big, 'xhigh', lookup);   // 后台小任务：小模型、它自己的默认档
  assert.deepEqual([r.model.id, r.effort], ['tiny-1', '']);
});

test('代理：子 agent 写了另一个服务的模型名 → 用那个服务的地址和 Key；重名型号要写 custom:<服务>:<型号>', async () => {
  const hit = (tag) => (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: tag }], usage: { input_tokens: 1, output_tokens: 1 } })); };
  const upA = await fakeUpstream(hit('A')), upB = await fakeUpstream(hit('B'));
  try {
    const a = P.createProvider({ name: 'A', baseUrl: upA.url, apiKey: 'k-a', compat: { useProxy: false }, models: [{ id: 'big-1', thinking: 'budget', maxOutput: 20000 }, { id: 'dup' }] });
    const b = P.createProvider({ name: 'B', baseUrl: upB.url, apiKey: 'k-b', compat: { useProxy: false }, models: [{ id: 'mimo-flash', thinking: 'budget', maxOutput: 8000 }, { id: 'dup' }] });
    const env = await X.providerEngineEnv({}, { provider: P.getProvider(a.id), model: P.getProvider(a.id).models[0], effort: 'max' });
    const post = (body) => fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_tokens: 4000, messages: [{ role: 'user', content: 'hi' }], ...body }) });
    assert.equal((await post({ model: 'mimo-flash', output_config: { effort: 'low' } })).status, 200);
    assert.equal(upB.seen.length, 1);
    assert.equal(upB.seen[0].headers['x-api-key'], 'k-b');
    assert.equal(upB.seen[0].body.model, 'mimo-flash');
    assert.ok(upB.seen[0].body.max_tokens <= 8000);
    assert.equal((await post({ model: 'big-1', output_config: { effort: 'max' } })).status, 200);   // 主循环：路径档 max
    const hiBudget = upA.seen[0].body.thinking.budget_tokens;
    assert.equal((await post({ model: 'big-1', output_config: { effort: 'low' } })).status, 200);   // 同模型的子 agent 自己挑了 low
    assert.ok(upA.seen[1].body.thinking.budget_tokens < hiBudget);
    assert.equal(P.resolveSubagentModel('dup'), null);                                     // 重名：裸 id 不认
    assert.equal(P.resolveSubagentModel(`custom:${b.id}:dup`).provider.id, b.id);
    assert.ok(P.subagentModelCatalog().some((m) => m.name === `custom:${b.id}:dup`));
    assert.ok(P.subagentModelCatalog().some((m) => m.name === 'mimo-flash'));
    P.deleteProvider(a.id); P.deleteProvider(b.id);
  } finally { upA.close(); upB.close(); }
});
