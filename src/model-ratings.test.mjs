// 子 agent 选型阶梯（runtime/model-ratings.mjs）与快照生成（scripts/model-ratings-sync.mjs）：
// 库目录 → 快照的字段与口径、型号名匹配（别名、不做前缀匹配、日期后缀）、候选的付费口径、四档取法、
// 自定义 API 会话里 auto:<档> 经本机代理落到首选（假上游）。
// 子 agent 调用策略（2026-11-11）：默认线、判定线 / 档位自定义 / short、不调用非 Claude、号池均值、第三方 plan 成本
//（含模型中心服务按真实地址认 plan）、不传策略与改造前的取法一致、resolveAuto 按 owner 的策略、ladderPreview 的形状。
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
delete process.env.VERTEX_PROJECT;   // 模型中心那条用例：不发布 Vertex（免得它的型号混进候选）

const S = await import('../scripts/model-ratings-sync.mjs');
const R = await import('./runtime/model-ratings.mjs');
const P = await import('./runtime/claude-providers.mjs');
const X = await import('./runtime/claude-providers-proxy.mjs');
const D = await import('./runtime/dispatch-policy.mjs');
const A = await import('./runtime/claude-account.mjs');
const H = await import('./runtime/model-hub/registry.mjs');
const G = await import('./runtime/model-hub/gateway.mjs');
const { ROOT } = await import('./config/index.mjs');
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

test('applyAutoTarget：CLI 按未知型号给的 max_tokens=32000 换成落点型号的上限（封顶 128000）；别的值不动', () => {
  const claude = { kind: 'claude', model: 'claude-haiku-5-5', effort: 'max' };
  assert.equal(R.applyAutoTarget({ model: 'auto:normal', max_tokens: 32000 }, claude).max_tokens, 128000);
  assert.equal(R.applyAutoTarget({ model: 'auto:normal', max_tokens: 20000 }, claude).max_tokens, 20000);
  const prov = (maxOutput) => ({ kind: 'provider', provider: { id: 'p' }, model: { id: 'm', maxOutput }, effort: '' });
  assert.equal(R.applyAutoTarget({ model: 'auto:top', max_tokens: 32000 }, prov(65536)).max_tokens, 65536);
  assert.equal(R.applyAutoTarget({ model: 'auto:top', max_tokens: 32000 }, prov(943718)).max_tokens, 128000);
  assert.equal(R.applyAutoTarget({ model: 'auto:top', max_tokens: 32000 }, prov(16384)).max_tokens, 32000);
  assert.equal('max_tokens' in R.applyAutoTarget({ model: 'auto:top' }, prov(65536)), false);
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

// —— 子 agent 调用策略 ——

// 带 creator、三档订阅等效价与第三方 plan 成本的快照
const RATINGS2 = {
  generated: 't2',
  plans: {
    max20: { 'claude-opus-5-5': 1.4, 'claude-opus-5-5-high': 0.5, 'claude-sonnet-5-5-high': 0.2, 'claude-haiku-5-5-medium': 0.01 },
    pro: { 'claude-opus-5-5': 2.1, 'claude-opus-5-5-high': 0.8, 'claude-sonnet-5-5-high': 0.5, 'claude-haiku-5-5-medium': 0.05 },
    max5: { 'claude-opus-5-5': 1.6, 'claude-opus-5-5-high': 0.6, 'claude-sonnet-5-5-high': 0.3, 'claude-haiku-5-5-medium': 0.02 },
  },
  planPoints: { kimi: { Allegretto: { costs: { 'kimi-k3': 2 } }, Moderato: { costs: { 'kimi-k3': 4.5 } }, 旧档: { legacy: true, costs: { 'kimi-k3': 100 } } } },
  models: [
    { slug: 'claude-opus-5-5', base: 'claude-opus-5-5', effort: 'max', ii: 58, cost: 67, creator: 'Anthropic' },
    { slug: 'claude-opus-5-5-high', base: 'claude-opus-5-5', effort: 'high', ii: 52, cost: 23, creator: 'Anthropic' },
    { slug: 'claude-sonnet-5-5-high', base: 'claude-sonnet-5-5', effort: 'high', ii: 45, cost: 10, creator: 'Anthropic' },
    { slug: 'claude-haiku-5-5-medium', base: 'claude-haiku-5-5', effort: 'medium', ii: 25, cost: 0.6, creator: 'Anthropic' },
    { slug: 'claude-opus-5', base: 'claude-opus-5', effort: 'max', ii: 50, cost: 39, creator: 'Anthropic' },
    { slug: 'gemini-4-argon', base: 'gemini-4-argon', effort: 'high', ii: 50, cost: 26, creator: 'Google' },
    { slug: 'kimi-k3', base: 'kimi-k3', effort: '', ii: 47, cost: 20, creator: 'Moonshot' },
    { slug: 'mimo-v2-6-flash', base: 'mimo-v2-6-flash', effort: '', ii: 27, cost: 0.86, creator: 'Xiaomi' },
  ],
};
const LV = ['low', 'medium', 'high', 'xhigh', 'max'];
const CAT2 = [
  { name: 'claude-opus-5', label: 'Opus 5 (API)', provider: 'Anthropic API', efforts: LV },
  { name: 'gemini-argon', label: 'Gemini 4 Argon', provider: 'G', efforts: ['medium', 'high'] },
  { name: 'kimi-k3', label: 'Kimi K3', provider: 'Moonshot', efforts: [] },
  { name: 'mimo-v2.6-flash', label: 'MiMo', provider: '小米', efforts: [] },
  { name: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'X', efforts: [] },
  { name: 'odd-4-7', label: 'Odd', provider: 'X', efforts: [] },
];
const OFF2 = { catalog: CAT2, official: true, routed: true, plan: 'max20' };
const at = (L, k) => L.find((t) => t.key === k);
const pe = (c) => c.write + '/' + c.effort;
const picks = (L) => L.map((t) => pe(t.pick));

// 改造前的四档取法，原样抄过来对照：判定线 = 最高分 × frac（top = 最高分 − 1.5），成本最低、同价取智力分高的
const oldCheapest = (xs) => xs.reduce((a, b) => (!a || b.cost < a.cost || (b.cost === a.cost && b.ii > a.ii) ? b : a), null);
function oldLadder(list) {
  if (!list.length) return [];
  const top = Math.max(...list.map((c) => c.ii));
  return R.TIERS.map((t) => {
    const floor = t.frac ? top * t.frac : top - 1.5;
    const ok = list.filter((c) => c.ii >= floor);
    const pick = oldCheapest(ok);
    const pool = ok.filter((c) => (pick.channel === 'sub' ? c.channel !== 'sub' : c.write !== pick.write));
    let alt = oldCheapest(pool);
    if (!alt && pick.channel === 'sub') {
      const api = list.filter((c) => c.channel !== 'sub');
      if (api.length) alt = { ...api.reduce((a, b) => (b.ii > a.ii || (b.ii === a.ii && b.cost < a.cost) ? b : a)), weaker: true };
    }
    return { key: t.key, floor, pick, alt };
  });
}
const altSig = (t) => (t.alt ? pe(t.alt) + (t.alt.weaker ? '!' : '') : '-');
// 新旧一档对一档比：判定线只差一位小数的上取；首选相同则备选也要相同；首选不同只许是「同价、新的智力分更低且够得着线」（契约的同价规则）
function sameAsOld(nw, old) {
  assert.equal(nw.length, old.length);
  let ties = 0;
  for (let i = 0; i < old.length; i++) {
    const a = old[i], b = nw[i];
    assert.equal(b.key, a.key);
    assert.ok(b.floor >= a.floor - 1e-9 && b.floor - a.floor < 0.1 + 1e-9, `${a.key} 档默认线 ${b.floor} 对不上原来的 ${a.floor}`);
    assert.equal(b.floorDefault, b.floor);
    assert.deepEqual([b.source, b.short, b.overrideSkipped], ['chart', false, false]);
    if (pe(a.pick) === pe(b.pick)) { assert.equal(altSig(b), altSig(a), `${a.key} 档备选变了`); continue; }
    assert.ok(b.pick.cost === a.pick.cost && b.pick.ii < a.pick.ii && b.pick.ii >= a.floor, `${a.key} 档首选 ${pe(a.pick)} → ${pe(b.pick)} 不是同价取舍`);
    ties++;
  }
  return ties;
}

test('默认线：top = 最高分 − 1.5，其余 = 最高分 × frac，一位小数往上取；候选为空全 0', () => {
  const L = (...xs) => xs.map((ii) => ({ ii }));
  assert.deepEqual(R.defaultFloors(L(58, 50, 25)), { top: 56.5, hard: 51.1, normal: 34.8, light: 23.2 });
  assert.deepEqual(R.defaultFloors(L(60)), { top: 58.5, hard: 52.8, normal: 36, light: 24 });
  assert.deepEqual(R.defaultFloors(L(1)), { top: 0, hard: 0.9, normal: 0.6, light: 0.4 });
  assert.deepEqual(R.defaultFloors([]), { top: 0, hard: 0, normal: 0, light: 0 });
  assert.deepEqual(R.ladderOf([]), []);
  assert.deepEqual(R.ladderOf([], { floors: { top: 10 } }), []);
});

test('不传策略 = 改造前的默认阶梯（判定线 = 原 frac 规则）：小快照逐档一致，内置快照随机清单只差同价取舍', () => {
  R._setRatingsForTests(RATINGS);
  try {
    const catalog = [
      { name: 'claude-opus-5', label: 'Opus 5 (API)', provider: 'Anthropic API', efforts: LV },
      { name: 'gemini-argon', label: 'Gemini 4 Argon', provider: 'G', efforts: ['medium', 'high'] },
      { name: 'dsv4', label: 'DS', provider: 'D', efforts: ['off', 'on'] },
      { name: 'mimo-v2.6-flash', label: 'MiMo', provider: '小米', efforts: [] },
    ];
    for (const official of [true, false]) {
      for (const plan of ['max20', 'pro']) {
        const opts = { catalog, official, routed: true, plan };
        const { list } = R.candidates(opts);
        const L = R.buildLadder(opts);
        assert.equal(sameAsOld(L.tiers, oldLadder(list)), 0);
        assert.equal(sameAsOld(L.agentTool, official ? oldLadder(list.filter((c) => c.channel === 'sub')) : []), 0);
        assert.deepEqual(R.buildLadder({ ...opts, strategy: null }).tiers.map(altSig), L.tiers.map(altSig));
        // 把默认线原样写进策略 / 空策略：结果不变
        assert.deepEqual(picks(R.ladderOf(list, { floors: R.defaultFloors(list) })), picks(L.tiers));
        assert.deepEqual(picks(R.buildLadder({ ...opts, strategy: D.sanitizeStrategy({}) }).tiers), picks(L.tiers));
      }
    }
  } finally { R._setRatingsForTests(null); }

  const Rx = R.loadRatings();   // 内置快照
  assert.ok(Rx && Rx.families.size > 10);
  const bases = [...Rx.families.keys()];
  let seed = 7, runs = 0, ties = 0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 400; i++) {
    const cat = [];
    for (let j = 0, n = 1 + Math.floor(rnd() * 12); j < n; j++) {
      const b = bases[Math.floor(rnd() * bases.length)];
      if (!cat.some((c) => c.name === b)) cat.push({ name: b, label: b, provider: 'X', efforts: rnd() < 0.7 ? LV : [] });
    }
    for (const official of [true, false]) {
      for (const plan of ['max20', 'pro', ['max20', 'pro']]) {
        const opts = { catalog: cat, official, routed: true, plan };
        const { list } = R.candidates(opts, Rx);
        const L = R.buildLadder(opts, Rx);
        if (!L) { assert.equal(list.length, 0); continue; }
        runs++;
        ties += sameAsOld(L.tiers, oldLadder(list));
        if (official) ties += sameAsOld(L.agentTool, oldLadder(list.filter((c) => c.channel === 'sub')));
      }
    }
  }
  assert.ok(runs > 1000);
  assert.ok(ties < runs / 50, `同价取舍 ${ties} 次 / ${runs}`);   // 只是极少数的同价情形
});

test('同价规则：首选取更贴近判定线（智力分更低）的；备选同价仍取更稳的；够不着线取最强并标 short；pick 永不为 null', () => {
  const c = (write, ii, cost) => ({ write, model: write, label: write, effort: '', ii, cost, channel: 'api', provider: 'X' });
  const list = [c('a', 50, 1), c('b', 40, 1), c('big', 60, 5), c('d', 45, 1)];
  const L = R.ladderOf(list);
  assert.deepEqual(picks(L), ['big/', 'big/', 'b/', 'b/']);
  assert.equal(at(L, 'normal').alt.write, 'a');
  assert.equal(at(L, 'hard').alt, null);
  const S = R.ladderOf(list, { floors: { top: 99, hard: 99, normal: 99, light: 99 } });
  assert.ok(S.every((t) => t.pick && t.pick.write === 'big' && t.short === true && t.floor === 99 && t.source === 'chart'));
  assert.equal(at(S, 'top').floorDefault, 58.5);
  assert.ok(R.ladderOf(list, { floors: { top: 'x', hard: NaN } }).every((t) => t.floor === t.floorDefault));   // 不合规的线 = 默认线
});

test('判定线：调了线首选跟着变（订阅会话的 Agent 工具那条路同样吃线）；够不着 → 取最强的、标 short', () => {
  R._setRatingsForTests(RATINGS2);
  try {
    const def = R.buildLadder(OFF2);
    assert.deepEqual(picks(def.tiers), ['opus/max', 'opus/high', 'sonnet/high', 'haiku/medium']);
    assert.deepEqual(def.tiers.map((t) => t.floor), [56.5, 51.1, 34.8, 23.2]);
    assert.equal(at(def.tiers, 'top').alt.write, 'gemini-argon');
    assert.equal(at(def.tiers, 'top').alt.weaker, true);
    assert.deepEqual(def.unrated.map((m) => m.name), ['odd-4-7']);

    const st = D.sanitizeStrategy({ floors: { top: 51, hard: 46, normal: 46, light: 26 } });
    const L = R.buildLadder({ ...OFF2, strategy: st });
    assert.deepEqual(picks(L.tiers), ['opus/high', 'opus/high', 'opus/high', 'sonnet/high']);
    assert.deepEqual([at(L.tiers, 'top').floor, at(L.tiers, 'top').floorDefault], [51, 56.5]);
    assert.ok(L.tiers.every((t) => t.source === 'chart' && !t.short));
    assert.deepEqual(picks(L.agentTool), ['opus/high', 'opus/high', 'opus/high', 'sonnet/high']);
    assert.ok(L.candidates.length >= 7);

    const S = R.buildLadder({ ...OFF2, strategy: { floors: { top: 70 } } });
    assert.deepEqual([pe(at(S.tiers, 'top').pick), at(S.tiers, 'top').short, at(S.tiers, 'hard').short], ['opus/max', true, false]);
    assert.equal(at(S.agentTool, 'top').short, true);
  } finally { R._setRatingsForTests(null); }
});

test('档位自定义：模型 + 档位对上 = 那一格；档位对不上按最接近的档合成（est）；模型不在候选里忽略（overrideSkipped）；Agent 工具只认别名', () => {
  R._setRatingsForTests(RATINGS2);
  try {
    const overrides = {
      top: { model: 'custom:p-deadbeef:gone', effort: '' },
      hard: { model: 'gemini-argon', effort: 'high' },
      normal: { model: 'sonnet', effort: 'max' },
      light: { model: 'opus', effort: '' },
    };
    const L = R.buildLadder({ ...OFF2, strategy: { floors: { top: null }, overrides } });
    const top = at(L.tiers, 'top'), hard = at(L.tiers, 'hard'), normal = at(L.tiers, 'normal'), light = at(L.tiers, 'light');
    assert.deepEqual([top.source, top.overrideSkipped, pe(top.pick)], ['chart', true, 'opus/max']);
    assert.deepEqual([hard.source, hard.overrideSkipped, pe(hard.pick), hard.pick.est], ['override', false, 'gemini-argon/high', false]);
    assert.deepEqual([normal.source, pe(normal.pick), normal.pick.ii, normal.pick.cost, normal.pick.est], ['override', 'sonnet/max', 45, 0.2, true]);
    assert.deepEqual([light.source, pe(light.pick), light.pick.ii, light.pick.est], ['override', 'opus/', 52, true]);   // 不指定 = 按 high 估
    assert.ok(light.alt && light.alt.channel !== 'sub');
    // Agent 工具那条路：第三方的自定义不认，回到图谱
    assert.deepEqual(L.agentTool.map((t) => [t.source, pe(t.pick)]), [['chart', 'opus/max'], ['chart', 'opus/high'], ['override', 'sonnet/max'], ['override', 'opus/']]);
    // 自定义压过 short
    const S = R.buildLadder({ ...OFF2, strategy: { floors: { top: 70 }, overrides: { top: { model: 'opus', effort: 'high' } } } });
    assert.deepEqual([at(S.tiers, 'top').source, at(S.tiers, 'top').short, pe(at(S.tiers, 'top').pick)], ['override', false, 'opus/high']);
    // 不调用非 Claude：第三方的自定义被滤掉 → 忽略
    const N = R.buildLadder({ ...OFF2, allowThirdParty: false, strategy: { overrides } });
    assert.deepEqual([at(N.tiers, 'hard').source, at(N.tiers, 'hard').overrideSkipped, pe(at(N.tiers, 'hard').pick)], ['chart', true, 'opus/high']);
    assert.equal(at(N.tiers, 'normal').source, 'override');
  } finally { R._setRatingsForTests(null); }
});

test('不调用非 Claude：订阅会话只剩订阅候选；自定义 API 会话只留快照里 creator 是 Anthropic 的型号', () => {
  R._setRatingsForTests(RATINGS2);
  try {
    const off = R.candidates({ ...OFF2, allowThirdParty: false });
    assert.ok(off.list.length === 4 && off.list.every((c) => c.channel === 'sub' && c.basis === 'sub' && c.creator === 'Anthropic'));
    assert.deepEqual(off.unrated, []);
    const L = R.buildLadder({ ...OFF2, allowThirdParty: false });
    assert.ok(L.tiers.every((t) => t.pick.channel === 'sub' && (!t.alt || t.alt.channel === 'sub')));
    assert.ok(L.others.every((c) => c.channel === 'sub'));

    const cus = R.candidates({ catalog: CAT2, official: false, allowThirdParty: false });
    assert.deepEqual(cus.list.map((c) => [pe(c), c.creator, c.basis, c.cost]), [['claude-opus-5/max', 'Anthropic', 'api', 39]]);
    assert.deepEqual(cus.unrated.map((m) => m.name), ['claude-opus-4-7']);
    assert.ok(R.buildLadder({ catalog: CAT2, official: false, allowThirdParty: false }).tiers.every((t) => t.pick.write === 'claude-opus-5'));
    const all = R.candidates({ catalog: CAT2, official: false });
    assert.deepEqual(all.list.map((c) => c.write), ['claude-opus-5', 'gemini-argon', 'kimi-k3', 'mimo-v2.6-flash']);
    assert.deepEqual(all.unrated.map((m) => m.name), ['claude-opus-4-7', 'odd-4-7']);
    assert.equal(at(R.buildLadder({ catalog: CAT2, official: false }).tiers, 'top').pick.write, 'gemini-argon');
    R._setRatingsForTests(false);
    assert.deepEqual(R.candidates({ catalog: CAT2, allowThirdParty: false }).unrated.map((m) => m.name), ['claude-opus-5', 'claude-opus-4-7']);
  } finally { R._setRatingsForTests(null); }
});

test('号池均值：订阅成本 = 各号按自己的 plan 算出来取算术平均；号池里认出的 plan 按号列（不去重），一个都认不出 → max20', () => {
  R._setRatingsForTests(RATINGS2);
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmp, 'no-login-'));   // 留空令牌的号不去读本机真实的登录凭据
  const added = [], before = A.listAccounts();
  try {
    const cost = (plan, w = 'opus', e = 'max') => R.candidates({ catalog: [], official: true, plan }).list.find((c) => c.write === w && c.effort === e).cost;
    assert.equal(cost('max20'), 1.4);
    assert.equal(cost('pro'), 2.1);
    assert.equal(cost(['max20', 'pro']), 1.75);
    assert.equal(cost(['max20', 'pro', 'pro']), 1.87);                    // 三位有效数字
    assert.equal(cost(['max20', 'max20']), 1.4);
    assert.equal(cost(['max20', 'pro'], 'haiku', 'medium'), 0.03);
    assert.equal(cost(['max5', 'max20']), 1.5);

    assert.deepEqual(R.poolPlans(), ['max20']);                           // 号池里一个都认不出
    assert.equal(cost(undefined), 1.4);
    for (const a of before) A.updateAccount(a.id, { plan: 'pro' });
    for (const plan of ['max5x', 'ultra']) { const r = A.addAccount({ label: 'T-' + plan, token: 'tok-' + plan, plan }); assert.ok(r.ok); added.push(r.id); }
    const want = [...before.map(() => 'pro'), 'max5', 'max20'];
    assert.deepEqual(R.poolPlans(), want);
    assert.equal(cost(undefined), cost(want));
    assert.equal(cost('pool'), cost(want));
    assert.equal(R.candidates({ catalog: [], official: true }).list.every((c) => c.basis === 'sub'), true);
  } finally {
    for (const id of added) A.deleteAccount(id);
    for (const a of before) A.updateAccount(a.id, { plan: a.plan || '' });
    if (cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = cfg;
    R._setRatingsForTests(null);
  }
});

test('resolveAuto：按 owner 登记的调用策略选；总开关关着照默认阶梯；成员没登记过按默认', () => {
  R._setRatingsForTests(RATINGS2);
  D._resetPolicyForTests();
  const host = { kind: 'admin', shell: true, dataDir: ROOT, key: 'admin' };
  const mem = { kind: 'user', key: 'u:ratings-m1', shell: true, dataDir: path.join(tmp, 'members', 'm1', '.bridge') };
  const pick = (tier, owner = P.HOST_OWNER) => { const t = R.resolveAuto('auto:' + tier, owner, { official: true }); return t && [t.kind, t.model, t.effort]; };
  try {
    assert.deepEqual(pick('light'), ['claude', 'claude-haiku-5-5', 'medium']);
    assert.deepEqual(pick('normal'), ['claude', 'claude-sonnet-5-5', 'high']);
    D.saveStrategy(host, { id: 's-00000000', floors: { normal: 50 }, overrides: { light: { model: 'opus', effort: 'high' } } });
    assert.deepEqual(pick('light'), ['claude', 'claude-opus-5-5', 'high']);
    assert.deepEqual(pick('normal'), ['claude', 'claude-opus-5-5', 'high']);
    assert.deepEqual(R.autoServed('auto:light', P.HOST_OWNER), { model: 'claude-opus-5-5', effort: 'high' });
    D.updatePolicy(host, { enabled: false });
    assert.deepEqual(pick('light'), ['claude', 'claude-haiku-5-5', 'medium']);   // 关着：默认阶梯（兼容照样写 auto:<档> 的旧脚本）
    assert.deepEqual(pick('normal'), ['claude', 'claude-sonnet-5-5', 'high']);
    D.updatePolicy(host, { enabled: true });
    D.saveStrategy(mem, { id: 's-00000000', overrides: { light: { model: 'sonnet', effort: 'high' } } });
    assert.deepEqual(pick('light', mem.key), ['claude', 'claude-haiku-5-5', 'medium']);   // 没登记过：默认
    D.notePolicyOwner(mem.key, mem);
    assert.deepEqual(pick('light', mem.key), ['claude', 'claude-sonnet-5-5', 'high']);
    assert.deepEqual(pick('light'), ['claude', 'claude-opus-5-5', 'high']);              // 主机的不受影响
    assert.equal(R.resolveAuto('auto:max', P.HOST_OWNER, { official: true }), null);
  } finally {
    D.saveStrategy(host, { id: 's-00000000', floors: { normal: null }, overrides: { light: null } });
    D._resetPolicyForTests();
    R._setRatingsForTests(null);
  }
});

test('ladderPreview：完整形状；第三方按真实地址认 plan（basis plan / vkey）否则 API 价；实时预览的策略、不调用非 Claude、custom 口径', () => {
  R._setRatingsForTests(RATINGS2);
  D._resetPolicyForTests();
  const host = { kind: 'admin', shell: true, dataDir: ROOT, key: 'admin' };
  const mk = (name, baseUrl, id) => P.createProvider({ name, baseUrl, apiKey: 'k-' + id, compat: { useProxy: false }, models: [{ id }] });
  const g = mk('Gemini 中转', 'https://relay.example.com', 'gemini-argon');
  const k = mk('Kimi 套餐', 'https://api.kimi.com/coding', 'kimi-k3');
  const m = mk('Moonshot', 'https://api.moonshot.cn/anthropic', 'kimi-k3');
  try {
    assert.match(P.subagentServiceUrl(k.id), /^https:\/\/api\.kimi\.com\/coding/);
    assert.equal(P.subagentServiceUrl('p-ffffffff'), null);
    assert.equal(P.subagentServiceUrl(''), null);
    const cat = P.subagentModelCatalog();
    assert.ok(cat.every((x) => typeof x.pid === 'string'));
    assert.equal(cat.find((x) => x.pid === g.id).name, 'gemini-argon');      // 全服唯一：仍写裸型号
    assert.deepEqual(cat.filter((x) => x.pid === k.id || x.pid === m.id).map((x) => x.name).sort(), [`custom:${k.id}:kimi-k3`, `custom:${m.id}:kimi-k3`].sort());

    const pv = R.ladderPreview(host);
    assert.deepEqual(Object.keys(pv).sort(), ['basis', 'candidates', 'chart', 'poolPlans', 'tiers', 'unrated']);
    assert.equal(pv.basis, 'official');
    assert.ok(Array.isArray(pv.poolPlans) && pv.poolPlans.length >= 1);
    assert.equal(pv.tiers.length, 4);
    for (const t of pv.tiers) {
      assert.deepEqual(Object.keys(t).sort(), ['agentTool', 'floor', 'floorDefault', 'key', 'overrideSkipped', 'pick', 'short', 'source', 'title', 'use']);
      for (const f of Object.keys(t.pick)) assert.ok(['model', 'label', 'effort', 'ii', 'cost', 'basis', 'provider', 'vkey', 'est'].includes(f), f);
      assert.equal(t.agentTool, null);                                      // 四档都落在订阅上：和 Agent 工具那条路一样
    }
    assert.deepEqual(pv.tiers.map((t) => t.pick.model + '/' + t.pick.effort), ['opus/max', 'opus/high', 'sonnet/high', 'haiku/medium']);
    assert.deepEqual([pv.tiers[0].floor, pv.tiers[0].floorDefault, pv.tiers[0].source, pv.tiers[0].short], [56.5, 56.5, 'chart', false]);
    const cand = (model) => pv.candidates.find((c) => c.model === model);
    assert.deepEqual(['basis', 'vkey', 'cost', 'creator'].map((f) => cand(`custom:${k.id}:kimi-k3`)[f]), ['plan', 'kimi', 3.25, 'Moonshot']);   // 旧档不算
    assert.deepEqual(['basis', 'vkey', 'cost'].map((f) => cand(`custom:${m.id}:kimi-k3`)[f]), ['api', undefined, 20]);
    const gem = cand(`custom:${g.id}:gemini-argon`);
    assert.deepEqual([gem.basis, gem.cost, gem.creator], ['api', 26, 'Google']);
    assert.ok(pv.candidates.filter((c) => c.basis === 'sub').every((c) => c.creator === 'Anthropic' && ['opus', 'sonnet', 'haiku'].includes(c.model)));
    assert.ok(pv.candidates.every((c) => !('est' in c) || c.est === true));

    // 实时预览：拖线 + 指定第三方
    const draft = { floors: { light: 26 }, overrides: { hard: { model: gem.model, effort: gem.effort } } };
    const p2 = R.ladderPreview(host, { strategy: draft });
    const h2 = p2.tiers.find((t) => t.key === 'hard');
    assert.deepEqual([h2.source, h2.pick.model], ['override', gem.model]);
    assert.deepEqual(h2.agentTool, { model: 'opus', label: 'Opus 5.5', effort: 'high' });   // Agent 工具只能写别名：落到图谱的那格
    const l2 = p2.tiers.find((t) => t.key === 'light');
    assert.deepEqual([l2.floor, l2.floorDefault, l2.pick.model, l2.agentTool], [26, 23.2, 'sonnet', null]);
    const p3 = R.ladderPreview(host, { strategy: draft, allowThirdParty: false });
    const h3 = p3.tiers.find((t) => t.key === 'hard');
    assert.deepEqual([h3.source, h3.overrideSkipped, h3.pick.model], ['chart', true, 'opus']);
    assert.ok(p3.candidates.every((c) => c.basis === 'sub'));

    // custom 口径：没有订阅，候选全来自服务清单
    const pc = R.ladderPreview(host, { basis: 'custom' });
    assert.equal(pc.basis, 'custom');
    assert.ok(pc.tiers.every((t) => t.agentTool === null));
    assert.ok(pc.candidates.every((c) => c.basis !== 'sub'));
    assert.equal(pc.tiers[0].pick.model, gem.model);
    const hc = pc.tiers.find((t) => t.key === 'hard').pick;
    assert.deepEqual([hc.model, hc.basis, hc.vkey, hc.cost], [`custom:${k.id}:kimi-k3`, 'plan', 'kimi', 3.25]);

    // 不给 strategy = 这个身份生效的那套
    D.saveStrategy(host, { id: 's-00000000', floors: { top: 70 } });
    const p4 = R.ladderPreview(host);
    assert.deepEqual([p4.tiers[0].floor, p4.tiers[0].floorDefault, p4.tiers[0].short, p4.tiers[0].pick.model], [70, 56.5, true, 'opus']);
    // 快照访客：没有服务清单，照样能算（只剩订阅）
    const ps = R.ladderPreview({ kind: 'snap', shell: false, snap: { token: 't' } });
    assert.equal(ps.tiers.length, 4);
    assert.ok(ps.candidates.every((c) => c.basis === 'sub'));
    assert.equal(ps.tiers[0].floor, 56.5);                                 // 只读默认，不吃主机的策略
  } finally {
    D.saveStrategy(host, { id: 's-00000000', floors: { top: null } });
    D._resetPolicyForTests();
    for (const p of [g, k, m]) P.deleteProvider(p.id);
    R._setRatingsForTests(null);
  }
});

test('ladderPreview.poolPlans：只给能改策略的身份、只给去重后的套餐名；快照访客 / 没命令行的成员 / 分享 → []（其余照算）', () => {
  R._setRatingsForTests(RATINGS2);
  D._resetPolicyForTests();
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmp, 'no-login-'));   // 留空令牌的号不去读本机真实的登录凭据
  const added = [];
  try {
    for (const plan of ['ultra', 'ultra', 'max5x']) {
      const r = A.addAccount({ label: 'PP-' + added.length, token: 'tok-pp-' + added.length, plan });
      assert.ok(r.ok); added.push(r.id);
    }
    const all = R.poolPlans();
    assert.ok(all.length > new Set(all).size, JSON.stringify(all));          // 号池按号列：有重复
    const host = { kind: 'admin', shell: true, dataDir: ROOT, key: 'admin' };
    const shellMember = { kind: 'user', key: 'u:pp-1', shell: true, dataDir: path.join(tmp, 'members', 'pp1', '.bridge') };
    for (const ctx of [host, shellMember]) assert.deepEqual(R.ladderPreview(ctx).poolPlans, [...new Set(all)]);
    const plain = { kind: 'user', key: 'u:pp-2', shell: false, dataDir: path.join(tmp, 'members', 'pp2', '.bridge') };
    for (const ctx of [{ kind: 'snap', shell: false, snap: { token: 't' } }, plain, { kind: 'share', shell: false }]) {
      assert.equal(D.canEditPolicy(ctx), false);
      const pv = R.ladderPreview(ctx);
      assert.deepEqual(pv.poolPlans, []);
      assert.equal(pv.tiers.length, 4);
    }
  } finally {
    for (const id of added) A.deleteAccount(id);
    if (cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = cfg;
    D._resetPolicyForTests();
    R._setRatingsForTests(null);
  }
});

test('autoServed：键带口径——同一身份的官方 / 自定义会话各记各的；预解析（record:false）不改面板显示', () => {
  R._setRatingsForTests(RATINGS2);
  D._resetPolicyForTests();
  const host = { kind: 'admin', shell: true, dataDir: ROOT, key: 'admin' };
  const mi = P.createProvider({ name: '小米', baseUrl: 'https://mimo.example.com', apiKey: 'k-mi', compat: { useProxy: false }, models: [{ id: 'mimo-v2.6-flash', label: 'MiMo' }] });
  const H0 = P.HOST_OWNER;
  const mimo = { model: `custom:${mi.id}:mimo-v2.6-flash`, effort: '' };
  try {
    const c = R.resolveAuto('auto:light', H0, { official: false });          // 自定义 API 会话（providers-proxy）
    assert.deepEqual([c.kind, c.provider.id, c.model.id], ['provider', mi.id, 'mimo-v2.6-flash']);
    const o = R.resolveAuto('auto:light', H0, { official: true });           // 官方订阅会话（claude-upstream）
    assert.deepEqual([o.kind, o.model, o.effort], ['claude', 'claude-haiku-5-5', 'medium']);
    assert.deepEqual(R.autoServed('auto:light', H0, { official: false }), mimo);   // 没被官方那次覆盖
    assert.deepEqual(R.autoServed('auto:light', H0, { official: true }), { model: 'claude-haiku-5-5', effort: 'medium' });
    // 预解析（start_session 选模型）不记：面板仍是上一次真正改写请求的落点
    D.saveStrategy(host, { id: 's-00000000', overrides: { light: { model: 'opus', effort: 'high' } } });
    const pre = R.resolveAuto('auto:light', H0, { official: true, record: false });
    assert.deepEqual([pre.model, pre.effort], ['claude-opus-5-5', 'high']);
    assert.deepEqual(R.autoServed('auto:light', H0, { official: true }), { model: 'claude-haiku-5-5', effort: 'medium' });
    R.resolveAuto('auto:light', H0, { official: true });
    assert.deepEqual(R.autoServed('auto:light', H0, { official: true }), { model: 'claude-opus-5-5', effort: 'high' });
    assert.deepEqual(R.autoServed('auto:light', H0, { official: false }), mimo);
  } finally {
    D.saveStrategy(host, { id: 's-00000000', overrides: { light: null } });
    D._resetPolicyForTests();
    P.deleteProvider(mi.id);
    R._setRatingsForTests(null);
  }
});

test('型号 id 自带冒号（Ollama 的 qwen3:32b）：规范写法是 custom:<服务>:qwen3:32b——候选 / 未评分 / 档位自定义 / saveStrategy / auto 解析全链路对得上', () => {
  R._setRatingsForTests(RATINGS2);
  D._resetPolicyForTests();
  const host = { kind: 'admin', shell: true, dataDir: ROOT, key: 'admin' };
  const o = P.createProvider({
    name: 'Ollama', baseUrl: 'https://ollama.example.com', apiKey: 'k-ol', compat: { useProxy: false },
    models: [{ id: 'qwen3:32b', label: 'Kimi K3' }, { id: 'llama3.1:8b' }],
  });
  const want = `custom:${o.id}:qwen3:32b`;
  try {
    assert.equal(P.parseCustomModel(want).mid, 'qwen3:32b');
    const cat = P.subagentModelCatalog().filter((x) => x.pid === o.id);
    assert.deepEqual(cat.map((x) => x.name), ['qwen3:32b', 'llama3.1:8b']);   // 全服唯一：目录给裸 id
    const { list, unrated } = R.candidates({ catalog: cat, official: false });
    assert.deepEqual(list.map((c) => [c.write, c.model]), [['qwen3:32b', want]]);
    assert.deepEqual(unrated.map((m) => m.name), ['llama3.1:8b']);
    const pv = R.ladderPreview(host, { basis: 'custom' });
    assert.ok(pv.candidates.some((c) => c.model === want));
    assert.deepEqual(pv.unrated.filter((u) => u.provider === 'Ollama').map((u) => u.model), [`custom:${o.id}:llama3.1:8b`]);
    // 档位自定义用候选里的写法 → 命中（实时预览那条路）
    const overrides = { hard: { model: want, effort: '' } };
    const h = R.ladderPreview(host, { basis: 'custom', strategy: { overrides } }).tiers.find((t) => t.key === 'hard');
    assert.deepEqual([h.source, h.overrideSkipped, h.pick.model], ['override', false, want]);
    // 存得上；存完生效的那套也命中，auto 解析照样按 write 路由到这个服务
    const saved = D.saveStrategy(host, { id: 's-00000000', overrides });
    assert.equal(saved.strategy.overrides.hard.model, want);
    const h2 = R.ladderPreview(host, { basis: 'custom' }).tiers.find((t) => t.key === 'hard');
    assert.deepEqual([h2.source, h2.pick.model], ['override', want]);
    const t = R.resolveAuto('auto:hard', P.HOST_OWNER, { official: false, record: false });
    assert.deepEqual([t.kind, t.provider.id, t.model.id], ['provider', o.id, 'qwen3:32b']);
  } finally {
    D.saveStrategy(host, { id: 's-00000000', overrides: { hard: null } });
    D._resetPolicyForTests();
    P.deleteProvider(o.id);
    R._setRatingsForTests(null);
  }
});

test('模型中心发布的服务：按它在模型中心里的真实地址认 plan（第一条启用的线路，线路地址空 = 服务地址）', async () => {
  R._setRatingsForTests(RATINGS2);
  H._resetHubForTests(path.join(tmp, 'hub'));
  await H.initModelHub();
  const made = [];
  try {
    const mk = (name, lines) => { const s = H.createHubService({ name, kind: 'anthropic', baseUrl: 'https://api.kimi.com/coding', useProxy: false, models: ['kimi-k3'], lines }); made.push(s.id); return s; };
    mk('Kimi 套餐', [{ label: '停用', key: 'k-off-1', baseUrl: 'https://api.moonshot.cn/anthropic', enabled: false }, { label: '甲', key: 'k-on-1' }]);
    mk('Kimi 转发', [{ label: '乙', key: 'k-on-2', baseUrl: 'https://api.moonshot.cn/anthropic' }]);
    const cat = P.subagentModelCatalog().filter((x) => /kimi-k3$/.test(x.name));
    assert.equal(cat.length, 2);
    const byName = (re) => cat.find((x) => re.test(x.provider));
    const plan = byName(/套餐/), relay = byName(/转发/);
    assert.ok(plan && relay, JSON.stringify(cat));
    assert.match(P.subagentServiceUrl(plan.pid), /^https:\/\/api\.kimi\.com\/coding/);
    assert.match(P.subagentServiceUrl(relay.pid), /^https:\/\/api\.moonshot\.cn\/anthropic/);
    const { list } = R.candidates({ catalog: cat, official: false });
    const of = (pid) => list.find((c) => c.model === `custom:${pid}:kimi-k3`);
    assert.deepEqual([of(plan.pid).basis, of(plan.pid).vkey, of(plan.pid).cost], ['plan', 'kimi', 3.25]);
    assert.deepEqual([of(relay.pid).basis, of(relay.pid).cost], ['api', 20]);
    assert.equal(R.buildLadder({ catalog: cat, official: false }).tiers[0].pick.model, `custom:${plan.pid}:kimi-k3`);
  } finally {
    for (const id of made) { try { H.deleteHubService(id); } catch { /* 删不掉也不影响别的用例 */ } }
    await G._stopGatewayForTests();
    H._resetHubForTests();
    R._setRatingsForTests(null);
  }
});
