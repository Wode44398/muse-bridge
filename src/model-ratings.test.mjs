// 子 agent 选型阶梯（runtime/model-ratings.mjs）与快照生成（scripts/model-ratings-sync.mjs）：
// 库目录 → 快照的字段与口径、型号名匹配（别名、不做前缀匹配、日期后缀）、候选的付费口径、四档取法、
// 自定义 API 会话里 auto:<档> 经本机代理落到首选（假上游）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-ratings-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
delete process.env.HTTPS_PROXY; delete process.env.https_proxy;

const S = await import('../scripts/model-ratings-sync.mjs');
const R = await import('./runtime/model-ratings.mjs');
const P = await import('./runtime/claude-providers.mjs');
const X = await import('./runtime/claude-providers-proxy.mjs');
test.after(() => globalThis[Symbol.for('undici.globalDispatcher.1')]?.close());

test('快照生成：档位从 short 名解析、base 去档位后缀；API 成本以图表口径为准（分时段取贵的），订阅只取 Anthropic 三档', () => {
  assert.equal(S.effortOf('Claude Opus 5.5 (max with fallback)'), 'max');
  assert.equal(S.effortOf('GPT-6.1 Terra (non-reasoning)'), 'off');
  assert.equal(S.effortOf('MiMo-V2.6-Pro'), '');
  assert.equal(S.baseOf('claude-4-5-haiku-reasoning'), 'claude-4-5-haiku');
  assert.equal(S.baseOf('deepseek-v4-1-flash-1017'), 'deepseek-v4-1-flash-1017');
  const src = path.join(tmp, 'lib');
  mkdirSync(path.join(src, 'aa_data'), { recursive: true });
  writeFileSync(path.join(src, 'aa_data', 'aa_models.json'), JSON.stringify([
    { slug: 'claude-opus-5-5', short: 'Claude Opus 5.5 (max with fallback)', creator: 'Anthropic', ii: 58.406, c: { total: 10 }, rel: '2026-09-22' },
    { slug: 'claude-opus-5-5-high', short: 'Claude Opus 5.5 (high with fallback)', creator: 'Anthropic', ii: 51.69, c: { total: 3.5 }, rel: '2026-09-22' },
    { slug: 'ds-flash', short: 'DS Flash (max)', ii: 32.49, c: { total: 0.5 }, dep: true },
    { slug: 'broken', short: 'x' },
  ]));
  writeFileSync(path.join(src, 'build_plan_chart.py'), 'FX = 7.0\n');
  writeFileSync(path.join(src, 'api_value_points.csv'), '﻿模型厂商,AA模型(档位),每任务成本_官方API_元,时段\nDS,DS Flash (max),2.0,闲时\nDS,DS Flash (max),4.0,高峰\n');
  writeFileSync(path.join(src, 'plan_value_points.csv'), 'Plan,AA模型(档位),每任务成本_中_元\nClaude Max 20x,Claude Opus 5.5 (max with fallback),1.43\nClaude Max 20x,"Claude Opus 5.5 (high with fallback)",0.5\nChatGPT Pro,Claude Opus 5.5 (max with fallback),9\n');
  const snap = S.buildSnapshot(src, { today: '2026-10-30' });
  assert.equal(snap.fx, 7);
  assert.equal(snap.models.length, 3);
  const by = Object.fromEntries(snap.models.map((m) => [m.slug, m]));
  assert.deepEqual([by['claude-opus-5-5'].base, by['claude-opus-5-5'].effort, by['claude-opus-5-5'].ii, by['claude-opus-5-5'].cost], ['claude-opus-5-5', 'max', 58.4, 70]);
  assert.equal(by['claude-opus-5-5-high'].base, 'claude-opus-5-5');
  assert.equal(by['ds-flash'].cost, 4);
  assert.equal(by['ds-flash'].dep, true);
  assert.deepEqual(snap.plans, { max20: { 'claude-opus-5-5': 1.43, 'claude-opus-5-5-high': 0.5 } });
  assert.doesNotMatch(JSON.stringify(snap), /lib|Users|Vault/);   // 不带库路径（公开版也带这份快照）
});

const RATINGS = {
  generated: 't',
  plans: { max20: { 'claude-opus-5-5': 1.4, 'claude-opus-5-5-high': 0.5, 'claude-haiku-5-5-medium': 0.01 } },
  models: [
    { slug: 'claude-opus-5-5', base: 'claude-opus-5-5', effort: 'max', ii: 58, cost: 67 },
    { slug: 'claude-opus-5-5-high', base: 'claude-opus-5-5', effort: 'high', ii: 52, cost: 23 },
    { slug: 'claude-opus-5', base: 'claude-opus-5', effort: 'max', ii: 50, cost: 39 },
    { slug: 'claude-haiku-5-5-medium', base: 'claude-haiku-5-5', effort: 'medium', ii: 25, cost: 0.6 },
    { slug: 'claude-4-5-haiku-reasoning', base: 'claude-4-5-haiku', effort: '', ii: 17, cost: 1 },
    { slug: 'gemini-4-argon', base: 'gemini-4-argon', effort: 'high', ii: 50, cost: 26 },
    { slug: 'dsv4', base: 'dsv4', effort: 'max', ii: 23, cost: 12, rel: '2026-08-13' },
    { slug: 'dsv4-old', base: 'dsv4', effort: 'max', ii: 30, cost: 1, rel: '2026-04-24', dep: true },
    { slug: 'mimo-v2-6-flash', base: 'mimo-v2-6-flash', effort: '', ii: 27, cost: 0.86 },
  ],
};

test('匹配：归一后精确对 base（不做前缀匹配）、别名、日期后缀、显示名兜底', () => {
  R._setRatingsForTests(RATINGS);
  try {
    const slugs = (id, label) => (R.familyFor(id, label) || []).map((m) => m.slug).sort();
    assert.deepEqual(slugs('claude-opus-5'), ['claude-opus-5']);                     // 不吞 claude-opus-5-5
    assert.deepEqual(slugs('claude-opus-5-5[1m]'), ['claude-opus-5-5', 'claude-opus-5-5-high']);
    assert.deepEqual(slugs('custom:p-1:mimo-v2.6-flash'), ['mimo-v2-6-flash']);
    assert.deepEqual(slugs('claude-haiku-4-5-20251001'), ['claude-4-5-haiku-reasoning']);   // 去日期 + 别名
    assert.deepEqual(slugs('gemini-argon'), ['gemini-4-argon']);                     // 别名
    assert.deepEqual(slugs('weird-id', 'Gemini 4 Argon'), ['gemini-4-argon']);        // 显示名兜底
    assert.equal(R.familyFor('claude-opus-4-7'), null);
  } finally { R._setRatingsForTests(null); }
});

test('候选与阶梯：订阅会话的 Claude 按订阅等效价、第三方 claude-* 不算；同档多条取未弃用；档位不是官方五档的不写 effort', () => {
  R._setRatingsForTests(RATINGS);
  try {
    const catalog = [
      { name: 'claude-opus-5', label: 'Opus 5 (API)', provider: 'Anthropic API', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { name: 'gemini-argon', label: 'Gemini 4 Argon', provider: 'G', contextWindow: 200000, vision: false, efforts: ['medium', 'high'] },
      { name: 'dsv4', label: 'DS', provider: 'D', efforts: ['off', 'on'] },
      { name: 'mimo-v2.6-flash', label: 'MiMo', provider: '小米', efforts: [] },
      { name: 'odd-4-7', label: 'Claude Opus 4.7', provider: 'X', efforts: [] },
    ];
    const off = R.candidates({ catalog, official: true, routed: true, plan: 'max20' });
    assert.ok(!off.list.some((c) => c.write === 'claude-opus-5'));               // 订阅会话：claude-* 一律走订阅
    const opusMax = off.list.find((c) => c.write === 'opus' && c.effort === 'max');
    assert.deepEqual([opusMax.cost, opusMax.channel], [1.4, 'sub']);
    assert.deepEqual(off.list.find((c) => c.write === 'dsv4') && [off.list.find((c) => c.write === 'dsv4').ii, off.list.find((c) => c.write === 'dsv4').effort], [23, '']);
    assert.equal(off.list.find((c) => c.write === 'gemini-argon').effort, 'high');
    assert.deepEqual(off.unrated.map((m) => m.name), ['odd-4-7']);
    const notRouted = R.candidates({ catalog, official: true, routed: false, plan: 'max20' });
    assert.ok(notRouted.list.every((c) => c.channel === 'sub'));

    const L = R.buildLadder({ catalog, official: true, routed: true, plan: 'max20' });
    const pick = (k) => { const t = L.tiers.find((x) => x.key === k); return [t.pick.write, t.pick.effort, t.alt && t.alt.write]; };
    assert.deepEqual(pick('top'), ['opus', 'max', 'gemini-argon']);
    assert.deepEqual(pick('hard'), ['opus', 'high', 'gemini-argon']);
    assert.deepEqual(pick('light'), ['haiku', 'medium', 'mimo-v2.6-flash']);
    assert.equal(L.tiers.find((x) => x.key === 'top').alt.weaker, true);
    assert.deepEqual(L.agentTool.map((t) => t.pick.write + '/' + t.pick.effort), ['opus/max', 'opus/high', 'opus/high', 'haiku/medium']);
    assert.ok(L.others.some((c) => c.write === 'dsv4'));

    const cus = R.buildLadder({ catalog, official: false });
    assert.ok(cus.tiers.every((t) => t.pick.channel === 'api'));
    assert.equal(cus.tiers.find((t) => t.key === 'top').pick.write, 'gemini-argon');   // 同分取便宜的
    assert.equal(R.buildLadder({ catalog: [], official: false }), null);
    R._setRatingsForTests(false);
    assert.equal(R.buildLadder({ catalog, official: true }), null);
  } finally { R._setRatingsForTests(null); }
});

test('applyAutoTarget：订阅 Claude 改型号与档位；第三方写成 custom:<服务>:<型号>；没档位不动 output_config', () => {
  const body = { model: 'auto:hard', output_config: { effort: 'low', format: { type: 'json' } } };
  assert.deepEqual(R.applyAutoTarget(body, { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' }),
    { model: 'claude-opus-5-5', output_config: { effort: 'high', format: { type: 'json' } } });
  assert.deepEqual(R.applyAutoTarget(body, { kind: 'provider', provider: { id: 'p-1' }, model: { id: 'm' }, effort: '' }),
    { model: 'custom:p-1:m', output_config: { effort: 'low', format: { type: 'json' } } });
  assert.equal(R.isAutoModel('auto:top'), true);
  assert.equal(R.isAutoModel('auto:max'), false);
});

test('自定义 API 会话：auto:<档> 经本机代理落到阶梯首选的服务与型号', async () => {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen.push({ key: req.headers['x-api-key'], body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  R._setRatingsForTests(RATINGS);
  const a = P.createProvider({ name: 'A', baseUrl: url, apiKey: 'k-a', compat: { useProxy: false }, models: [{ id: 'claude-opus-5', thinking: 'budget', maxOutput: 20000 }] });
  const b = P.createProvider({ name: 'B', baseUrl: url, apiKey: 'k-b', compat: { useProxy: false }, models: [{ id: 'mimo-v2.6-flash', maxOutput: 8000 }] });
  try {
    const env = await X.providerEngineEnv({}, { provider: P.getProvider(a.id), model: P.getProvider(a.id).models[0], effort: '' });
    const post = (model) => fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal((await post('auto:light')).status, 200);
    assert.deepEqual([seen[0].key, seen[0].body.model], ['k-b', 'mimo-v2.6-flash']);
    assert.equal((await post('auto:top')).status, 200);
    assert.deepEqual([seen[1].key, seen[1].body.model], ['k-a', 'claude-opus-5']);
    R._setRatingsForTests(false);
    const bad = await post('auto:hard');
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /auto:hard/);
  } finally {
    R._setRatingsForTests(null);
    P.deleteProvider(a.id); P.deleteProvider(b.id);
    srv.close(); srv.closeAllConnections();
  }
});
