// 子 agent 调用策略的图谱数据（runtime/dispatch-chart.mjs）：性价比图 HTML 的解析与坏输入、以内置快照为底的合并、
// planPoints 与 plan 均价、服务地址 → plan 的识别表、导入 / 清除 / 线上拉取的落盘（换根到临时目录，不碰真实数据根）。
// 另有一条读桌面上那份真文件的（不存在就跳过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-dispatch-chart-'));
process.env.BRIDGE_DATA_ROOT = tmp;
delete process.env.HTTPS_PROXY; delete process.env.https_proxy;

const C = await import('./dispatch-chart.mjs');
const K = await import('../model-knowledge/ratings.mjs');

const chartRoot = path.join(tmp, 'chart-root');
C.setChartRoot(() => chartRoot);
test.after(() => { C.setChartRoot(); rmSync(tmp, { recursive: true, force: true }); });

// ── 假数据 ──────────────────────────────────────────────────────────────────
const api = (slug, effort, score, cost, extra = {}) => ({
  id: 'api|' + slug, src: 'api', vkey: extra.vkey || 'anthropic', plan: '官方 API', planFull: '官方 API', price: 0,
  family: extra.family || slug, slug, aaName: extra.aaName || `${slug} (${effort})`, effort, creator: extra.creator || 'Anthropic',
  score, cost, dep: !!extra.dep, rel: extra.rel || '2026-11-01', ...(extra.tod ? { tod: extra.tod } : {}),
});
const plan = (vkey, planName, slug, effort, score, cost, extra = {}) => ({
  id: `${vkey}|${planName}|${slug}`, src: 'plan', vkey, plan: planName, planFull: extra.planFull || planName, price: extra.price ?? 100,
  family: extra.family || slug, slug, aaName: slug, effort, score, cost, legacy: extra.legacy ?? null, ...(extra.tod ? { tod: extra.tod } : {}),
});

function fakeData() {
  const points = [
    api('claude-opus-5-5', 'max', 61.234, 70.12345, { family: 'Claude Opus 5.5', aaName: 'Claude Opus 5.5 (max with fallback)' }),
    api('claude-opus-5-5-high', 'high', 52.06, 23.26659),
    api('claude-fable-5-2', 'max', 64.56, 178.217, { family: 'Claude Fable 5.2' }),
    api('claude-fable-5-2-high', 'high', 61.82, 60.5),
    api('kimi-k3', '默认', 47.04, 3.3333, { vkey: 'kimi', creator: 'Moonshot' }),
    api('glm-5-3-non-reasoning', '非推理', 30.0, 0.5, { vkey: 'zhipu', creator: 'Zhipu' }),
    // 分时段计价：同一 slug 两个点，取贵的
    api('deepseek-v4-1-flash-1017', 'max', 32.49, 4.04338, { vkey: 'deepseek', creator: 'DeepSeek', tod: '高峰' }),
    api('deepseek-v4-1-flash-1017', 'max', 32.49, 2.02169, { vkey: 'deepseek', creator: 'DeepSeek', tod: '闲时' }),
    // 订阅：Pro 没有 Fable；Max / Ultra 有；Team 不进 plans
    plan('anthropic', 'Claude Pro', 'claude-opus-5-5', 'max', 61.234, 1.25875, { planFull: 'Claude Pro' }),
    plan('anthropic', 'Claude Pro', 'claude-opus-5-5-high', 'high', 52.06, 0.44091, { planFull: 'Claude Pro' }),
    plan('anthropic', 'Claude Max', 'claude-opus-5-5', 'max', 61.234, 1.25875, { planFull: 'Claude Max 5x' }),
    plan('anthropic', 'Claude Max', 'claude-fable-5-2', 'max', 64.56, 12.86525, { planFull: 'Claude Max 5x' }),
    plan('anthropic', 'Claude Ultra', 'claude-opus-5-5', 'max', 61.234, 1.25875, { planFull: 'Claude Max 20x' }),
    plan('anthropic', 'Claude Ultra', 'claude-fable-5-2', 'max', 64.56, 12.86525, { planFull: 'Claude Max 20x' }),
    plan('anthropic', 'Claude Team 高级席', 'claude-opus-5-5', 'max', 61.234, 2.0, { planFull: 'Claude Team – Premium seat' }),
    // 第三方 plan：kimi 两个现行档 + 一个老档；分时段的取贵的
    plan('kimi', 'Kimi Plus', 'kimi-k3', '默认', 47.04, 0.3, { price: 134.31 }),
    plan('kimi', 'Kimi Pro', 'kimi-k3', '默认', 47.04, 0.6, { price: 268.62, tod: '高峰' }),
    plan('kimi', 'Kimi Pro', 'kimi-k3', '默认', 47.04, 0.2, { price: 268.62, tod: '闲时' }),
    plan('kimi', 'Kimi 老档', 'kimi-k3', '默认', 47.04, 0.01, { price: 50, legacy: '2026-09-24 起停售，老会员可按原规则续费' }),
    plan('zhipu', 'GLM Coding Lite', 'glm-5-3-non-reasoning', '非推理', 30.0, 0.0123456),
  ];
  // 凑够 50 个点
  for (let i = 0; i < 40; i++) points.push(plan('tp_filler', 'Filler ' + (i % 4), 'filler-' + i, 'high', 20 + i / 2, 1 + i));
  return {
    generated: '2026-11-09', fx: 6.7,
    source: 'Artificial Analysis Intelligence Index v5.0（测试）',
    vendors: [
      { key: 'anthropic', name: 'Anthropic', cn: false, tp: false },
      { key: 'kimi', name: 'Kimi', cn: true, tp: false },
      { key: 'tp_filler', name: 'Filler', cn: false, tp: true },
    ],
    plans: [
      { vkey: 'kimi', plan: 'Kimi Plus', price: 134.314, legacy: null },
      { vkey: 'kimi', plan: 'Kimi 老档', price: 50, legacy: '停售' },
    ],
    points,
  };
}

const BASE = {
  version: 2, generated: '2026-11-07', index: 'v5.0', fx: 6.7154, source: '内置',
  models: [
    { slug: 'claude-opus-5-5', base: 'claude-opus-5-5', effort: 'max', name: 'Claude Opus 5.5 (max with fallback)', creator: 'Anthropic', ii: 59.1, cost: 67.4, rel: '2026-09-22', subs: { tb40: 70.1 } },
    { slug: 'claude-fable-5-1', base: 'claude-fable-5-1', effort: 'max', name: 'Claude Fable 5.1 (max)', creator: 'Anthropic', ii: 49, cost: 87.6, rel: '2026-08-01' },
    { slug: 'claude-fable-5-1-high', base: 'claude-fable-5-1', effort: 'high', name: 'Claude Fable 5.1 (high)', creator: 'Anthropic', ii: 47, cost: 50.8, rel: '2026-08-01' },
    { slug: 'kimi-k3', base: 'kimi-k3', effort: '', name: 'Kimi K3', creator: 'Moonshot', ii: 47, cost: 3.3, rel: '2026-10-01', est: true },
    { slug: 'qwen3-8-max', base: 'qwen3-8-max', effort: '', name: 'Qwen3.8 Max', creator: 'Alibaba', ii: 40.2, cost: 9, rel: '2026-06-01', old: true, ver: 'v4.3.2' },
  ],
  plans: {
    pro: { 'claude-opus-5-5': 1.3 }, max5: { 'claude-opus-5-5': 1.3 }, max20: { 'claude-opus-5-5': 1.3, 'claude-sonnet-5-5': 1.2 },
    team: { 'claude-opus-5-5': 9 },
  },
};

const html = (D, { crlf = false } = {}) => {
  const nl = crlf ? '\r\n' : '\n';
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>订阅plan性价比图</title>',
    '<style>body{font:14px sans-serif}</style></head><body><canvas id="c"></canvas>',
    '<script>',
    'globalThis.__chartScriptRan = true;',
    'const DATA = ' + JSON.stringify(D) + ';',
    'const VCOLOR = { anthropic: "#d97757" };',
    'function render() { return DATA.points.length; }',
    '</script></body></html>',
  ].join(nl);
};

// ── 解析 ────────────────────────────────────────────────────────────────────
test('parseChartHtml：只取 const DATA 那一行的 JSON（LF / CRLF / Buffer 都行），不执行页面脚本', () => {
  const D = fakeData();
  assert.deepEqual(C.parseChartHtml(html(D)), D);
  assert.deepEqual(C.parseChartHtml(html(D, { crlf: true })), D);
  assert.deepEqual(C.parseChartHtml(Buffer.from(html(D), 'utf8')), D);
  assert.equal(globalThis.__chartScriptRan, undefined);
});

test('parseChartHtml：坏输入一律 400「这不是订阅 plan 性价比图」，超过 12MB 回 413', () => {
  const is400 = (x) => assert.throws(() => C.parseChartHtml(x), (e) => e.status === 400 && /这不是订阅 plan 性价比图/.test(e.message));
  is400('');
  is400(null);
  is400(12345);
  is400('<html><body>随便一个页面</body></html>');
  is400('<script>const DATA = {"points": [1, 2,</script>');               // JSON 坏了
  is400('<script>const DATA = 42;</script>');                              // 不是对象
  const few = fakeData(); few.points = few.points.slice(0, 49);
  is400(html(few));                                                        // 不到 50 个点
  const noAnthropicApi = fakeData(); noAnthropicApi.points = noAnthropicApi.points.filter((p) => !(p.src === 'api' && p.vkey === 'anthropic'));
  for (let i = 0; i < 10; i++) noAnthropicApi.points.push(plan('tp_filler', 'More', 'more-' + i, 'high', 30, 1));
  is400(html(noAnthropicApi));
  const notArray = fakeData(); notArray.points = { a: 1 };
  is400(html(notArray));
  const big = 'x'.repeat(C.CHART_MAX_BYTES + 1);
  assert.throws(() => C.parseChartHtml(big), (e) => e.status === 413);
});

// ── 合并 ────────────────────────────────────────────────────────────────────
test('chartToSnapshot：API 点按 slug 覆盖 / 新增（一位小数、三位有效数字、档位换写法、分项继承、分时段取贵的），底里其余原样保留', () => {
  const S = C.chartToSnapshot(fakeData(), BASE);
  assert.equal(S.version, 2);
  assert.equal(S.generated, '2026-11-09');
  assert.equal(S.fx, 6.7);
  assert.equal(S.index, 'v5.0');
  const by = new Map(S.models.map((m) => [m.slug, m]));
  // 覆盖：分数 / 成本取图表的，分项继承底里的
  assert.deepEqual(by.get('claude-opus-5-5'), {
    slug: 'claude-opus-5-5', base: 'claude-opus-5-5', effort: 'max', name: 'Claude Opus 5.5 (max with fallback)', creator: 'Anthropic',
    ii: 61.2, cost: 70.1, rel: '2026-11-01', subs: { tb40: 70.1 },
  });
  // 新增：Fable 5.2 各档自成一族
  assert.equal(by.get('claude-fable-5-2').base, 'claude-fable-5-2');
  assert.equal(by.get('claude-fable-5-2').cost, 178);
  assert.equal(by.get('claude-fable-5-2-high').base, 'claude-fable-5-2');
  assert.equal(by.get('claude-fable-5-2-high').effort, 'high');
  // 档位：默认 → ''、非推理 → off；base 去掉 -non-reasoning
  assert.equal(by.get('kimi-k3').effort, '');
  assert.equal(by.get('kimi-k3').est, true);   // 分数没变：est 继承
  assert.equal(by.get('glm-5-3-non-reasoning').effort, 'off');
  assert.equal(by.get('glm-5-3-non-reasoning').base, 'glm-5-3');
  // 分时段：取贵的
  assert.equal(by.get('deepseek-v4-1-flash-1017').cost, 4.04);
  assert.equal(S.models.filter((m) => m.slug === 'deepseek-v4-1-flash-1017').length, 1);
  // 底里有、图表没有：原样保留（含旧分）
  assert.deepEqual(by.get('claude-fable-5-1'), BASE.models[1]);
  assert.deepEqual(by.get('claude-fable-5-1-high'), BASE.models[2]);
  assert.deepEqual(by.get('qwen3-8-max'), BASE.models[4]);
  assert.equal(S.models.length, 5 + 5);   // 底 5 条（opus、kimi 被覆盖）+ 图表新增 5 个 slug
  // 现行在前、旧分在后、各自按分数降序
  const cur = S.models.filter((m) => !m.old);
  assert.ok(cur.every((m, i) => i === 0 || cur[i - 1].ii >= m.ii));
  assert.equal(S.models.at(-1).slug, 'qwen3-8-max');
  // 底没被改
  assert.equal(BASE.models[0].ii, 59.1);
});

test('chartToSnapshot：plans.pro / max5 / max20 换成图表 Anthropic 的 Pro / Max / Ultra，Team 不进，底里别的键保留', () => {
  const S = C.chartToSnapshot(fakeData(), BASE);
  assert.deepEqual(S.plans.pro, { 'claude-opus-5-5': 1.26, 'claude-opus-5-5-high': 0.441 });
  assert.deepEqual(S.plans.max5, { 'claude-opus-5-5': 1.26, 'claude-fable-5-2': 12.9 });
  assert.deepEqual(S.plans.max20, { 'claude-opus-5-5': 1.26, 'claude-fable-5-2': 12.9 });   // 整个换掉：底里的 sonnet 不留
  assert.deepEqual(S.plans.team, { 'claude-opus-5-5': 9 });
  // 图表的 planFull 也认（老名字 Max 5x / 20x）
  const D = fakeData();
  for (const p of D.points) if (p.vkey === 'anthropic' && p.src === 'plan') p.plan = p.planFull;
  const S2 = C.chartToSnapshot(D, BASE);
  assert.deepEqual(S2.plans.max5, S.plans.max5);
  assert.deepEqual(S2.plans.max20, S.plans.max20);
});

test('chartToSnapshot：planPoints 按 厂商 × plan 收每任务成本（分时段取贵的、老档标 legacy、月价取 plans 表），索引原样带出', () => {
  const S = C.chartToSnapshot(fakeData(), BASE);
  assert.deepEqual(S.planPoints.kimi, {
    'Kimi Plus': { legacy: false, price: 134.31, costs: { 'kimi-k3': 0.3 } },
    'Kimi Pro': { legacy: false, price: 268.62, costs: { 'kimi-k3': 0.6 } },
    'Kimi 老档': { legacy: true, price: 50, costs: { 'kimi-k3': 0.01 } },
  });
  assert.deepEqual(S.planPoints.zhipu['GLM Coding Lite'].costs, { 'glm-5-3-non-reasoning': 0.0123 });
  assert.equal(S.planPoints.anthropic['Claude Max'].costs['claude-fable-5-2'], 12.9);
  assert.equal(S.planPoints.api, undefined);   // API 点不进 planPoints
  const R = K.loadRatings(S);
  assert.equal(R.planPoints, S.planPoints);
  assert.deepEqual(K.loadRatings(BASE).planPoints, {});
});

test('chartToSnapshot：vkey / plan / slug 是原型链上的名字 → 不污染 Object.prototype、不抛错；toString 这类 plan 名照常当普通键收', () => {
  const D = fakeData();
  D.points.push(
    plan('__proto__', 'snap', 'x', 'high', 50, 2),
    plan('constructor', 'evil', 'x', 'high', 50, 2),
    plan('prototype', 'evil2', 'x', 'high', 50, 2),
    plan('kimi', '__proto__', 'kimi-k3', '默认', 47.04, 0.5),
    plan('kimi', 'Kimi Plus', '__proto__', '默认', 47.04, 0.5),
    plan('kimi', 'toString', 'kimi-k3', '默认', 47.04, 0.5),
    plan('kimi', 'hasOwnProperty', 'kimi-k3', '默认', 47.04, 0.5),
    api('__proto__', 'max', 50, 2),
    api('constructor', 'max', 50, 2),
  );
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  let S;
  try {
    S = C.chartToSnapshot(D, BASE);
    assert.equal(({}).snap, undefined);
    assert.equal(Object.evil, undefined);
    assert.equal(Object.prototype.evil2, undefined);
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  } finally {   // 旧实现会写到原型上：别让它漏到后面的用例
    delete Object.prototype.snap; delete Object.evil; delete Object.prototype.evil2;
  }
  assert.deepEqual(Object.keys(S.planPoints).sort(), ['anthropic', 'kimi', 'tp_filler', 'zhipu']);
  assert.ok(!Object.hasOwn(S.planPoints.kimi, '__proto__'));
  assert.ok(!Object.hasOwn(S.planPoints.kimi['Kimi Plus'].costs, '__proto__'));
  assert.deepEqual(S.planPoints.kimi.toString, { legacy: false, price: 100, costs: { 'kimi-k3': 0.5 } });
  assert.deepEqual(S.planPoints.kimi.hasOwnProperty, { legacy: false, price: 100, costs: { 'kimi-k3': 0.5 } });
  assert.ok(!S.models.some((m) => m.slug === '__proto__' || m.slug === 'constructor'));
  assert.deepEqual(S, JSON.parse(JSON.stringify(S)));
  // 整条导入也一样
  const r = C.importChartHtml(html(D), { name: 'proto.html' });
  assert.equal(({}).snap, undefined);
  assert.equal(r.points, D.points.length);
  assert.deepEqual(C.importedRatings().planPoints, S.planPoints);
  C.clearChart();
});

test('chartToSnapshot：分数不在 0–100、成本 ≤ 0 的点整个不收（底里同 slug 的行原样保留），月价越界记 0；结果和 JSON 往返完全一致', () => {
  const ref = C.chartToSnapshot(fakeData(), BASE);
  const D = fakeData();
  D.points.push(
    api('qwen3-8-max', '默认', 1e308, 9, { creator: 'Alibaba' }),            // 底里有的行：不能被 Infinity 分覆盖
    api('claude-fable-5-1', 'max', -40, 87.6),
    api('claude-fable-5-1-high', 'high', 250, 50.8),
    api('free', '默认', 60, -5, { vkey: 'kimi', creator: 'Moonshot' }),      // 负成本不能变成 0 成本混进来
    api('zero', '默认', 60, 0, { vkey: 'kimi', creator: 'Moonshot' }),
    api('kimi-k3', '默认', 47.04, Infinity, { vkey: 'kimi', creator: 'Moonshot' }),
    plan('kimi', 'Kimi Plus', 'kimi-k3', '默认', 47.04, -1),
    plan('kimi', 'Kimi Plus', 'kimi-k3', '默认', 1e308, 5),
  );
  const S = C.chartToSnapshot(D, BASE);
  assert.deepEqual(S, ref);
  assert.deepEqual(S, JSON.parse(JSON.stringify(S)));
  // 月价：图表 plans 表 / 点上的价不是有限的非负数 → 记 0
  const D2 = fakeData();
  D2.plans.push({ vkey: 'zhipu', plan: 'GLM 大', price: 1e308, legacy: null });
  D2.points.push(plan('zhipu', 'GLM 大', 'glm-5-3-non-reasoning', '非推理', 30, 0.5, { price: 1e308 }));
  D2.points.push(plan('zhipu', 'GLM 负', 'glm-5-3-non-reasoning', '非推理', 30, 0.5, { price: -3 }));
  const S2 = C.chartToSnapshot(D2, BASE);
  assert.equal(S2.planPoints.zhipu['GLM 大'].price, 0);
  assert.equal(S2.planPoints.zhipu['GLM 负'].price, 0);
  assert.deepEqual(S2, JSON.parse(JSON.stringify(S2)));
  // 解析门槛跟着收紧：只有越界的 anthropic API 点 → 不认这张图
  const D3 = fakeData();
  D3.points = D3.points.filter((p) => !(p.src === 'api' && p.vkey === 'anthropic'));
  D3.points.push(api('claude-x', 'max', 500, 1));
  assert.throws(() => C.parseChartHtml(html(D3)), { status: 400 });
});

test('chartToSnapshot：图表换了智力指数版本 → 底里留下来的现行行改标旧分（不进 families）', () => {
  const D = fakeData();
  D.source = 'Artificial Analysis Intelligence Index v5.1（测试）';
  const S = C.chartToSnapshot(D, BASE);
  assert.equal(S.index, 'v5.1');
  const fable51 = S.models.find((m) => m.slug === 'claude-fable-5-1');
  assert.equal(fable51.old, true);
  assert.equal(fable51.ver, 'v5.0');
  assert.equal(S.models.find((m) => m.slug === 'qwen3-8-max').ver, 'v4.3.2');   // 本来就是旧分的不动
  const R = K.loadRatings(S);
  assert.equal(R.families.has('claude-fable-5-1'), false);
  assert.equal(R.families.has('claude-fable-5-2'), true);
});

test('导入的图谱有了 Fable 5.2 正主：lookupRating 原样匹配优先，不再借 5.1 的分；没有正主时别名照旧', () => {
  const R = K.loadRatings(C.chartToSnapshot(fakeData(), BASE));
  const hit = K.lookupRating(R, 'claude-fable-5-2');
  assert.equal(hit.base, 'claude-fable-5-2');
  assert.equal(hit.ii, 64.6);
  assert.equal(K.familyOf(R, 'claude-fable-5-2').length, 2);
  const R0 = K.loadRatings(BASE);
  assert.equal(K.lookupRating(R0, 'claude-fable-5-2').base, 'claude-fable-5-1');
});

test('chartPoints：精简点表 [vkey, plan, slug, family, effort, score, cost, src] + vendors；同一 厂商 × plan × slug 取贵的', () => {
  const P = C.chartPoints(fakeData());
  assert.equal(P.generated, '2026-11-09');
  assert.deepEqual(P.vendors[0], { key: 'anthropic', name: 'Anthropic', cn: false, tp: false });
  assert.equal(P.vendors.length, 3);
  assert.ok(P.points.every((p) => Array.isArray(p) && p.length === 8));
  const opus = P.points.find((p) => p[2] === 'claude-opus-5-5' && p[7] === 'api');
  assert.deepEqual(opus, ['anthropic', '官方 API', 'claude-opus-5-5', 'Claude Opus 5.5', 'max', 61.2, 70.1, 'api']);
  const ds = P.points.filter((p) => p[2] === 'deepseek-v4-1-flash-1017');
  assert.equal(ds.length, 1);
  assert.equal(ds[0][6], 4.04);
  const kimiPro = P.points.filter((p) => p[0] === 'kimi' && p[1] === 'Kimi Pro');
  assert.deepEqual(kimiPro.map((p) => [p[4], p[6]]), [['', 0.6]]);
  assert.equal(P.points.find((p) => p[2] === 'glm-5-3-non-reasoning')[4], 'off');
  assert.equal(P.points.length, fakeData().points.length - 2);   // 两组分时段各并掉一个
});

// ── 服务地址 → plan ──────────────────────────────────────────────────────────
test('planOfBaseUrl：只认把握高的套餐专属端点，其余（含按量 API、OpenRouter、本机网关）一律 null', () => {
  const v = (u) => C.planOfBaseUrl(u)?.vkey ?? null;
  const yes = {
    'https://token-plan-cn.xiaomimimo.com/anthropic': 'mimo',
    'https://token-plan-sgp.xiaomimimo.com/v1': 'mimo',
    'https://api.kimi.com/coding/': 'kimi',
    'https://api.kimi.ai/coding/v1': 'kimi',
    'https://open.bigmodel.cn/api/coding/paas/v4': 'zhipu',
    'https://api.z.ai/api/coding/paas/v4': 'zhipu',
    'https://api.stepfun.com/step_plan/v1': 'stepfun',
    'https://api.stepfun.ai/step_plan/v1': 'stepfun',
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1': 'qwen',
    'https://ark.cn-beijing.volces.com/api/coding/v3': 'tp_volcengine',
    'https://qianfan.baidubce.com/v2/tokenplan': 'tp_comate',
    'https://qianfan.baidubce.com/anthropic/tokenplan/v1': 'tp_comate',
    'https://opencode.ai/zen/go/v1': 'tp_opencode',
    'https://opencode.ai/inference/go': 'tp_opencode',
    'api.kimi.com/coding': 'kimi',                       // 不带协议头也认
    'HTTPS://API.KIMI.COM/Coding/V1': 'kimi',            // 大小写不敏感
  };
  for (const [u, k] of Object.entries(yes)) assert.equal(v(u), k, u);
  const no = [
    'https://api.deepseek.com/anthropic', 'https://api.anthropic.com', 'https://api.xiaomimimo.com/anthropic',
    'https://openrouter.ai/api/v1', 'https://api.moonshot.cn/anthropic', 'https://api.kimi.com/v1',
    'https://open.bigmodel.cn/api/anthropic', 'https://api.z.ai/api/anthropic', 'https://api.stepfun.com/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://ark.cn-beijing.volces.com/api/v3',
    'https://qianfan.baidubce.com/v2', 'https://opencode.ai/zen/v1', 'http://127.0.0.1:8787/h-71ce1629/anthropic',
    'https://evil.com/api.kimi.com/coding', 'https://api.kimi.com.evil.com/coding', 'https://xtoken-plan-cn.xiaomimimo.com.evil.com/',
    'https://api.kimi.com/codingx', '', null, undefined, 'not a url :::',
  ];
  for (const u of no) assert.equal(v(u), null, String(u));
  assert.deepEqual(C.planOfBaseUrl('https://api.kimi.com/coding/'), { vkey: 'kimi', basis: 'plan', provider: 'moonshot' });
  assert.deepEqual(C.planOfBaseUrl('https://opencode.ai/zen/go/v1'), { vkey: 'tp_opencode', basis: 'plan' });   // 知识层不认识的主机：不带 provider
});

test('planCost：这家各现行 plan 里有这个 slug 的成本取算术平均（老档不算），一个都没有 → null', () => {
  const R = K.loadRatings(C.chartToSnapshot(fakeData(), BASE));
  assert.equal(C.planCost(R, 'kimi', 'kimi-k3'), 0.45);           // (0.3 + 0.6) / 2，老档 0.01 不算
  assert.equal(C.planCost(R, 'zhipu', 'glm-5-3-non-reasoning'), 0.0123);
  assert.equal(C.planCost(R, 'kimi', 'glm-5-3-non-reasoning'), null);
  assert.equal(C.planCost(R, 'mimo', 'kimi-k3'), null);
  assert.equal(C.planCost(R, '', 'kimi-k3'), null);
  assert.equal(C.planCost(null, 'kimi', 'kimi-k3'), null);
  assert.equal(C.planCost(K.loadRatings(BASE), 'kimi', 'kimi-k3'), null);
  // 只剩老档 → null
  const S = C.chartToSnapshot(fakeData(), BASE);
  for (const p of Object.values(S.planPoints.kimi)) p.legacy = true;
  assert.equal(C.planCost(K.loadRatings(S), 'kimi', 'kimi-k3'), null);
});

// ── 落盘 ────────────────────────────────────────────────────────────────────
test('导入 / 清除：写到换过的根下的 dispatch-chart/，chartMeta 跟着变，importedRatings 只在导入 / 清除后换对象', () => {
  C.clearChart();
  assert.equal(C.importedRatings(), null);
  assert.equal(C.chartAllPoints(), null);
  const m0 = C.chartMeta();
  assert.equal(m0.source, 'builtin');
  assert.match(m0.generated, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(m0.hasPlanPoints, false);

  const before = Date.now();
  const m1 = C.importChartHtml(html(fakeData()), { from: 'file', name: 'C:\\Users\\x\\Desktop\\订阅plan性价比图.html' });
  assert.equal(m1.source, 'imported');
  assert.equal(m1.generated, '2026-11-09');
  assert.equal(m1.from, 'file');
  assert.equal(m1.points, fakeData().points.length);
  assert.equal(m1.name, '订阅plan性价比图.html');
  assert.equal(m1.hasPlanPoints, true);
  assert.ok(m1.at >= before);
  const dir = path.join(chartRoot, 'dispatch-chart');
  assert.ok(existsSync(path.join(dir, 'ratings.json')));
  assert.ok(existsSync(path.join(dir, 'points.json')));
  assert.equal(existsSync(path.join(tmp, 'dispatch-chart')), false);   // 没写到默认根

  const r1 = C.importedRatings();
  assert.equal(C.importedRatings(), r1);                                // 同一个对象：调用方按身份缓存索引
  assert.equal(r1.imported.from, 'file');
  assert.ok(r1.models.some((m) => m.slug === 'claude-fable-5-2'));
  // 换根再换回：从盘上读回来的和内存里的一致
  C.setChartRoot(() => chartRoot);
  const r1b = C.importedRatings();
  assert.notEqual(r1b, r1);
  assert.deepEqual(r1b, r1);
  assert.deepEqual(C.chartAllPoints(), C.chartPoints(fakeData()));

  // 坏文件导入：抛 400，原来的数据不动
  assert.throws(() => C.importChartHtml('<html>nope</html>'), (e) => e.status === 400);
  assert.equal(C.importedRatings(), r1b);
  assert.equal(C.chartMeta().generated, '2026-11-09');

  // 再导一份：换对象
  const D2 = fakeData(); D2.generated = '2026-11-10';
  C.importChartHtml(html(D2), { from: 'url', name: 'https://model-plan-chart.pages.dev/' });
  const r2 = C.importedRatings();
  assert.notEqual(r2, r1b);
  assert.equal(C.chartMeta().generated, '2026-11-10');
  assert.equal(C.chartMeta().from, 'url');
  assert.equal(C.chartMeta().name, 'https://model-plan-chart.pages.dev/');

  // 清除：回到内置
  const m3 = C.clearChart();
  assert.equal(m3.source, 'builtin');
  assert.equal(C.importedRatings(), null);
  assert.equal(C.chartAllPoints(), null);
  assert.equal(existsSync(path.join(dir, 'ratings.json')), false);
  assert.equal(existsSync(path.join(dir, 'points.json')), false);
  C.clearChart();   // 清两次不报错
});

test('importedRatings：盘上的文件坏了 / 不是快照 → 当没导入过', () => {
  const root = mkdtempSync(path.join(tmp, 'bad-'));
  C.setChartRoot(root);
  try {
    const dir = path.join(root, 'dispatch-chart');
    C.importChartHtml(html(fakeData()));
    writeFileSync(path.join(dir, 'ratings.json'), '{ 坏了');
    C.setChartRoot(root);
    assert.equal(C.importedRatings(), null);
    assert.equal(C.chartMeta().source, 'builtin');
    writeFileSync(path.join(dir, 'ratings.json'), JSON.stringify({ models: [] }));
    C.setChartRoot(root);
    assert.equal(C.importedRatings(), null);
  } finally {
    C.setChartRoot(() => chartRoot);
  }
});

// ── 线上拉取 ────────────────────────────────────────────────────────────────
test('fetchChart：拉到就导入（from=url）；HTTP 错、超 12MB、网络错都抛带 status 的错，原数据不动', async () => {
  C.clearChart();
  const calls = [];
  const ok = async (url, init) => { calls.push([url, init]); return new Response(html(fakeData()), { status: 200, headers: { 'content-type': 'text/html' } }); };
  const m = await C.fetchChart({ fetchImpl: ok });
  assert.equal(calls[0][0], C.CHART_URL);
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  assert.equal(m.source, 'imported');
  assert.equal(m.from, 'url');
  const kept = C.importedRatings();

  await assert.rejects(C.fetchChart({ fetchImpl: async () => new Response('down', { status: 503 }) }), (e) => e.status === 502 && /503/.test(e.message));
  await assert.rejects(C.fetchChart({ fetchImpl: async () => new Response('x', { headers: { 'content-length': String(C.CHART_MAX_BYTES + 1) } }) }), (e) => e.status === 502 && /12MB/.test(e.message));
  // 不报长度、边读边超
  const chunk = new Uint8Array(1024 * 1024);
  const stream = () => new ReadableStream({ pull(c) { c.enqueue(chunk); } });
  await assert.rejects(C.fetchChart({ fetchImpl: async () => new Response(stream()) }), (e) => e.status === 502 && /12MB/.test(e.message));
  await assert.rejects(C.fetchChart({ fetchImpl: async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') }); } }), (e) => e.status === 502 && /ECONNRESET/.test(e.message));
  await assert.rejects(C.fetchChart({ fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); } }), (e) => e.status === 504);
  await assert.rejects(C.fetchChart({ fetchImpl: async () => new Response('<html>不是图</html>') }), (e) => e.status === 400);
  assert.equal(C.importedRatings(), kept);
  C.clearChart();
});

// ── 真文件（桌面上那份，不存在就跳过）────────────────────────────────────────
const REAL = 'C:/Users/you/Desktop/订阅plan性价比图.html';
test('真文件：解析、合并、planPoints、点表体积', { skip: !existsSync(REAL) && '桌面上没有订阅plan性价比图.html' }, () => {
  const D = C.parseChartHtml(readFileSync(REAL, 'utf8'));
  const base = JSON.parse(readFileSync(new URL('../config/model-ratings.json', import.meta.url), 'utf8'));
  const S = C.chartToSnapshot(D, base);
  const R = K.loadRatings(S);
  assert.ok(R.families.has('claude-fable-5-2'));
  assert.ok(S.plans.pro && S.plans.max5 && S.plans.max20);
  assert.ok(Object.keys(S.planPoints).length > 5);
  assert.ok(S.models.length >= base.models.length);
  const P = C.chartPoints(D);
  assert.ok(JSON.stringify(P).length < 1024 * 1024);
  // 落盘一遍（临时根）
  const root = mkdtempSync(path.join(tmp, 'real-'));
  C.setChartRoot(root);
  try {
    const m = C.importChartHtml(readFileSync(REAL), { name: '订阅plan性价比图.html' });
    assert.equal(m.source, 'imported');
    assert.ok(statSync(path.join(root, 'dispatch-chart', 'points.json')).size < 1024 * 1024);
  } finally {
    C.setChartRoot(() => chartRoot);
  }
});
