// 提示缓存寿命（cache-ttl.mjs）：取值顺序、厂商与线路的认法、文档没写的不编数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheTtl, cacheTtlMs, cacheTtlNote, normalizeCacheTtl, isLocalHost, CACHE_VENDORS } from './cache-ttl.mjs';

const min = (id, o) => cacheTtl(id, o).minutes;

test('用户填的最优先：0 = 不缓存 / 不提示，超过 1440 夹回', () => {
  assert.deepEqual(cacheTtl('gpt-6-astra', { host: 'api.openai.com', user: 12 }), { minutes: 12, source: 'user', vendor: 'openai' });
  assert.equal(min('claude-opus-5-5', { host: 'api.anthropic.com', user: 0, requestMinutes: 60 }), null);
  assert.equal(normalizeCacheTtl(99999), 1440);
  assert.equal(normalizeCacheTtl(null), undefined);
  assert.equal(normalizeCacheTtl(-3), undefined);
  assert.equal(normalizeCacheTtl('abc'), undefined);
});

test('Anthropic：默认 5 分钟；请求要了 1 小时就是 60；经 OpenRouter 按型号认', () => {
  assert.equal(min('claude-opus-5-5', { host: 'api.anthropic.com' }), 5);
  assert.deepEqual(cacheTtl('claude-opus-5-5', { host: 'api.anthropic.com', requestMinutes: 60 }), { minutes: 60, source: 'request', vendor: 'anthropic' });
  assert.equal(cacheTtl('anthropic/claude-opus-5.5', { host: 'openrouter.ai' }).source, 'family');
  assert.equal(min('anthropic/claude-opus-5.5', { host: 'https://openrouter.ai/api/v1' }), 5);
});

test('OpenAI：GPT-5.6 起至少 30 分钟，更早的取 5～10 分钟的下限', () => {
  assert.equal(min('gpt-6-astra', { host: 'api.openai.com' }), 30);
  assert.equal(min('openai/gpt-6.1-terra', { host: 'openrouter.ai' }), 30);
  assert.equal(min('gpt-5.6-mini', { host: 'api.openai.com' }), 30);
  assert.equal(min('gpt-5.5', { host: 'api.openai.com' }), 5);
  assert.equal(min('gpt-4.1', { host: 'api.openai.com' }), 5);
});

test('按主机认官方直连；聚合站与认不出的中转按型号；都认不出 = 不知道', () => {
  assert.equal(cacheTtl('k3.1-pro', { host: 'api.kimi.com' }).vendor, 'moonshot');
  assert.equal(min('k3.1-pro', { host: 'api.kimi.com' }), 5);
  assert.equal(min('deepseek-v4.1-flash', { host: 'api.deepseek.com' }), 120);
  assert.equal(min('glm-5.3', { host: 'open.bigmodel.cn' }), null);   // 文档没写，不编
  assert.equal(min('gemini-4-carbon', { host: 'aiplatform.googleapis.com' }), 5);
  assert.deepEqual(cacheTtl('mystery-1', { host: 'relay.example.com' }), { minutes: null, source: 'default', vendor: '' });
  assert.equal(min('claude-opus-5-5', { host: 'relay.example.com' }), 5);
});

test('本机 / 局域网的推理服务不提示（网关的 127.0.0.1 要换成上游再传）', () => {
  assert.equal(cacheTtl('qwen3.8-flash-next-fp8', { host: '127.0.0.1' }).source, 'local');
  assert.equal(min('qwen3.8-flash-next-fp8', { host: '192.168.1.20:8000' }), null);
  assert.equal(isLocalHost('172.20.0.3'), true);
  assert.equal(isLocalHost('8.8.8.8'), false);
  assert.equal(isLocalHost('localhost'), true);
});

test('毫秒版与说明', () => {
  assert.equal(cacheTtlMs('claude-opus-5-5', { host: 'api.anthropic.com' }), 300_000);
  assert.equal(cacheTtlMs('glm-5.3', { host: 'open.bigmodel.cn' }), 0);
  assert.equal(cacheTtlNote('glm-5.3', { host: 'open.bigmodel.cn' }), '官方未公布缓存时长');
  assert.equal(cacheTtlNote('gpt-6-astra', { host: 'api.openai.com', user: 3 }), '');
  for (const [k, v] of Object.entries(CACHE_VENDORS)) assert.ok(v.src.startsWith('https://'), `${k} 要有出处`);
});
