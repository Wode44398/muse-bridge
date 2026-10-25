// 共用型号知识模块的自检：① 每个 .d.mts 声明的值导出 = 运行时的导出（harness 是 TS + strict，声明漏了就是 any、多了就是假的）；
// ② 合表时以 dimensio catalog 为准修掉的漂移不再回来（harness/server/catalog-knowledge-contract.test.ts 逐型号对照，这里只守几条
// Claude 外接也会直接踩到的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function declared(file) {
  const src = readFileSync(path.join(HERE, file), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+\*\s+from\s+["'](.+?)["']/gm)) {
    for (const n of declared(m[1].replace(/\.mjs$/, '.d.mts'))) names.add(n);
  }
  return names;
}

for (const base of ['knowledge', 'diagnose', 'editor', 'index']) {
  test(`${base}.d.mts 声明的导出与运行时一致`, async () => {
    const mod = await import(`./${base}.mjs`);
    const runtime = Object.keys(mod).sort();
    const types = [...declared(`${base}.d.mts`)].sort();
    assert.deepEqual(types, runtime);
  });
}

test('合表后的几条：Sonnet / Opus 4.6 没有 xhigh；中转省掉 claude- 前缀也认得；兜底值由调用方给', async () => {
  const K = await import('./index.mjs');
  const ids = (id, protocol = 'anthropic') => K.guessModel(id, { protocol }).efforts.map((t) => t.id);
  assert.deepEqual(ids('claude-sonnet-4-6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(ids('claude-opus-4-6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(ids('claude-opus-4-7'), ['low', 'medium', 'high', 'xhigh', 'max']);
  const alias = K.guessModel('opus-5-5', { protocol: 'openai' });
  assert.equal(alias.contextWindow, 1_000_000);
  assert.equal(alias.vision, true);
  assert.equal(K.guessModel('claude-opus-5-5').effortDefault, 'medium');
  // 不在自己协议上的模板（Claude 走 OpenAI 端点）不带型号表的默认档：没选就什么都不发
  assert.equal(alias.effortDefault, '');
  // Haiku 4.5：budget 四档（关闭 + 4K / 8K / 12K），关闭档不开思考
  const h = K.guessModel('claude-haiku-4-5');
  assert.deepEqual(h.efforts.map((t) => [t.id, t.value]), [['off', null], ['low', 4000], ['medium', 8000], ['high', 12000]]);
  assert.equal(K.applyTier({ max_tokens: 1000 }, h, 'off').thinking, undefined);
  assert.deepEqual(K.applyTier({ max_tokens: 1000 }, h, 'high', { cap: 64_000 }).thinking, { type: 'enabled', budget_tokens: 12000 });
  // 兜底值：不给 = Claude CLI 视角 200K / 32K；dimensio 传自己适配器的 128K / 16K
  assert.equal(K.guessModel('my-finetune-7b').contextWindow, 200_000);
  const d = K.guessModel('my-finetune-7b', { protocol: 'openai', defaults: { contextWindow: 128_000, maxOutput: 16_384 } });
  assert.deepEqual([d.contextWindow, d.maxOutput, d.source.contextWindow], [128_000, 16_384, 'default']);
  // Gemini 原生协议的档位写进 generationConfig.thinkingConfig
  const g = K.guessModel('gemini-2.5-flash', { protocol: 'gemini' });
  assert.deepEqual(K.applyTier({ generationConfig: { maxOutputTokens: 100 } }, g, 'off', { protocol: 'gemini' }).generationConfig, { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } });
});

test('检测连接的判读：通了优先，同等时当前组合 > 同协议换地址 > 换协议', async () => {
  const D = await import('./diagnose.mjs');
  assert.equal(D.classifyProbe(200, '{}'), 'ok');
  assert.equal(D.classifyProbe(404, '<html>nope</html>'), 'missing');
  assert.equal(D.classifyProbe(404, '{"error":{"message":"model not found"}}'), 'model');
  assert.equal(D.classifyProbe(401, '{"error":"bad key"}'), 'auth');
  const draft = { protocol: 'anthropic', baseUrl: 'https://x.example.com/v1' };
  const r = D.pickDetect([
    { protocol: 'anthropic', baseUrl: 'https://x.example.com/v1', result: 'missing' },
    { protocol: 'openai', baseUrl: 'https://x.example.com/v1', result: 'ok' },
    { protocol: 'anthropic', baseUrl: 'https://x.example.com/anthropic', result: 'ok' },
  ], draft);
  assert.equal(r.ok, false);
  assert.deepEqual([r.suggest.protocol, r.suggest.baseUrl], ['anthropic', 'https://x.example.com/anthropic']);
  assert.equal(D.looksNotChat(400, '{"error":{"message":"ASR request requires a user message with input_audio content"}}'), true);
  assert.equal(D.looksNotChat(400, '{"error":{"message":"messages[0] system role is not allowed for TTS model"}}'), true);
  assert.equal(D.looksNotChat(400, '{"error":{"message":"invalid temperature"}}'), false);
  // 中转不收音频 ≠ 不是对话模型：不能引导用户把正常的对话型号关掉
  for (const msg of ['input_audio is not supported', 'This model does not support audio input', 'voice cloning failed', 'assistant role must follow user']) {
    assert.equal(D.looksNotChat(400, JSON.stringify({ error: { message: msg } })), false, msg);
  }
  assert.equal(D.looksNoAudio(400, '{"error":{"message":"input_audio is not supported"}}'), true);
  assert.equal(D.looksNoAudio(400, '{"error":{"message":"该模型不支持音频输入"}}'), true);
  assert.equal(D.looksNoAudio(400, '{"error":{"message":"ASR request requires a user message with input_audio content"}}'), false);
  assert.equal(D.looksNotChat(400, '{"error":{"message":"text-embedding-3-small is an embedding model"}}'), true);
  // 中文中转的 404「模型 xxx 不存在」是型号不对，不是地址不对
  assert.equal(D.classifyProbe(404, '{"error":{"message":"模型 foo-1 不存在"}}'), 'model');
  assert.equal(D.mentionsModel('foo-1 不存在', 'foo-1'), true);
  assert.equal(D.mentionsModel('Not Found'), false);
});

test('地址和协议对不上：只有实测过的站说得肯定；中转的 …/v1 + Anthropic 只提示', async () => {
  const K = await import('./knowledge.mjs');
  const D = await import('./diagnose.mjs');
  assert.deepEqual(K.protocolMismatch('anthropic', 'https://token-plan-cn.xiaomimimo.com/v1'), { to: 'openai', alt: 'https://token-plan-cn.xiaomimimo.com/anthropic', sure: true });
  assert.equal(K.protocolMismatch('anthropic', 'https://relay.example.com/v1').sure, false);
  assert.equal(K.protocolMismatch('anthropic', 'https://api.anthropic.com/v1'), null);
  assert.equal(K.protocolMismatch('openai', 'https://x.example.com/anthropic').sure, true);
  assert.match(D.endpointHint('anthropic', 'https://relay.example.com/v1'), /^有的服务/);
  assert.match(D.endpointHint('anthropic', 'https://token-plan-cn.xiaomimimo.com/v1'), /^这个站/);
});
