// 评分模块（ratings.mjs）与快照生成（scripts/model-ratings-sync.mjs）的回归：-max 后缀只在真是档位时才剥、旧版指数的条目
// 带 old 且不进 families / 排名 / 中位数、分项按约定键带进快照、新本机型号的别名与 derived、按档位取评分。
// 库与快照一律用测试自己给的假数据；最后一条只核对已提交快照的结构（不钉具体分数——随发版变）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as K from './ratings.mjs';
import * as S from '../../scripts/model-ratings-sync.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V5 = ['aa-briefcase', 'automationbench-aa', 'critpt-v2-hard', 'frontiercode-2-0', 'gdp-pdf', 'hle-diamond', 'omniscience', 'terminal-bench-science', 'terminalbench-4-0'];
const V4 = ['aa-briefcase', 'artificial-analysis-long-context-reasoning', 'automationbench-aa', 'critpt', 'gdp-pdf', 'gdpval-aa', 'humanitys-last-exam', 'omniscience', 'scicode', 'terminalbench-4-0'];

// 库里真实出现的 slug（截自 2026-11-04 的 aa_models.json）
const SLUGS = [
  'claude-opus-5-5', 'claude-opus-5-5-xhigh', 'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
  'claude-haiku-5-5', 'claude-haiku-5-5-xhigh', 'claude-haiku-5-5-high', 'claude-haiku-5-5-medium', 'claude-haiku-5-5-low',
  'claude-4-5-haiku-reasoning', 'claude-4-5-sonnet-thinking', 'claude-sonnet-4-6-adaptive',
  'deepseek-v4-1-flash-1017', 'deepseek-v4-1-flash-1017-high', 'deepseek-v4-1-flash-1017-non-reasoning',
  'deepseek-v4-1-flash', 'deepseek-v4-1-flash-non-reasoning',
  'gemini-4-argon', 'gemini-4-carbon', 'gemini-4-carbon-medium', 'gemini-4-carbon-low',
  'qwen3-8-max', 'qwen3-8-max-0803', 'qwen3-7-max', 'qwen3-8-27b', 'qwen3-8-27b-medium', 'qwen3-8-27b-low', 'qwen3-8-27b-non-reasoning',
  'qwen3-8-flash-next', 'qwen3-8-2-4t-a95b', 'glm-5-3', 'glm-5-3-low', 'glm-5-3-flash',
];

test('baseOf：-max 只在同族真有别的档位条目时才剥；Claude 各档、DeepSeek Flash 1017 各档、Gemini 4 Argon 不受影响', () => {
  const b = (s, slugs = SLUGS) => S.baseOf(s, slugs);
  // Qwen3.8 Max 是型号名不是档位：不能剥成 qwen3-8（那样 harness 的别名只能指向已弃用的 0803 旧条目）
  assert.equal(b('qwen3-8-max'), 'qwen3-8-max');
  assert.equal(b('qwen3-7-max'), 'qwen3-7-max');
  assert.equal(b('qwen3-8-max-0803'), 'qwen3-8-max-0803');
  for (const s of ['claude-opus-5-5', 'claude-opus-5-5-xhigh', 'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low']) {
    assert.equal(b(s), 'claude-opus-5-5', s);
  }
  for (const s of ['claude-haiku-5-5', 'claude-haiku-5-5-xhigh', 'claude-haiku-5-5-low']) assert.equal(b(s), 'claude-haiku-5-5', s);
  assert.equal(b('claude-4-5-haiku-reasoning'), 'claude-4-5-haiku');
  assert.equal(b('claude-4-5-sonnet-thinking'), 'claude-4-5-sonnet');
  assert.equal(b('claude-sonnet-4-6-adaptive'), 'claude-sonnet-4-6');
  for (const s of ['deepseek-v4-1-flash-1017', 'deepseek-v4-1-flash-1017-high', 'deepseek-v4-1-flash-1017-non-reasoning']) {
    assert.equal(b(s), 'deepseek-v4-1-flash-1017', s);
  }
  assert.equal(b('deepseek-v4-1-flash-non-reasoning'), 'deepseek-v4-1-flash');   // 不和 1017 混成一族
  assert.equal(b('gemini-4-argon'), 'gemini-4-argon');
  assert.equal(b('gemini-4-carbon-medium'), 'gemini-4-carbon');
  assert.equal(b('qwen3-8-27b-non-reasoning'), 'qwen3-8-27b');
  assert.equal(b('glm-5-3-low'), 'glm-5-3');
  // 真是档位的 -max：同族有带档位后缀的兄弟（-high / -low 等）
  assert.equal(b('foo-1-max', ['foo-1-max', 'foo-1-high', 'foo-1-low']), 'foo-1');
  assert.equal(b('bar-max', ['bar', 'bar-max', 'bar-high']), 'bar');
  // 只有不带后缀的本体不算：qwen3-8 与 qwen3-8-max 同时在库里时是两个型号
  assert.equal(b('bar-max', ['bar', 'bar-max']), 'bar-max');
  assert.equal(b('qwen3-8-max', [...SLUGS, 'qwen3-8']), 'qwen3-8-max');
  assert.equal(b('baz-max', ['baz-max', 'baz-max-high']), 'baz-max');   // 兄弟也带 max：max 是名字
  // 不给 slug 集合：一律不剥 max
  assert.equal(S.baseOf('foo-1-max'), 'foo-1-max');
});

// 假库：两版指数混着（v5 与 v4.3.2），带全量库与排行榜快照（分项）
const libs = [];
test.after(() => { for (const d of libs) rmSync(d, { recursive: true, force: true }); });
function fakeLib() {
  const src = mkdtempSync(path.join(os.tmpdir(), 'ratings-lib-'));
  libs.push(src);
  mkdirSync(path.join(src, 'aa_data', 'snapshots'), { recursive: true });
  const row = (slug, short, ii, ev, extra = {}) => ({ slug, short, creator: 'X', ii, c: { total: 1 }, rel: '2026-10-01', ev, ...extra });
  writeFileSync(path.join(src, 'aa_data', 'aa_models.json'), JSON.stringify([
    row('qwen3-8-max', 'Qwen3.8 Max (0902)', 33.6, V5),
    row('qwen3-8-max-0803', 'Qwen3.8 Max', 40.2, V4, { dep: true }),
    row('qwen3-8-27b', 'Qwen3.8 27B (xhigh)', 20.1, V5),
    row('qwen3-8-27b-medium', 'Qwen3.8 27B (medium)', 17.5, V5),
    row('qwen3-8-27b-non-reasoning', 'Qwen3.8 27B (non-reasoning)', 10, V5),
    row('qwen3-8-flash-next', 'Qwen3.8-Flash-Next', 39.8, V4),
    row('glm-5-3-flash', 'GLM-5.3-Flash', 27.8, V5),
    row('kimi-k3', 'Kimi K3 (max)', 43.6, V4, { dep: true }),
    row('est-model', 'Est', 30, [], { est: true }),
  ]));
  writeFileSync(path.join(src, 'aa_data', 'aa_models_full.json'), JSON.stringify([
    { slug: 'qwen3-8-27b-medium', terminalBench40: 0.0512, lcr: 0.797, hleDiamond: 0.067, frontierCode20: 0.115, tauBanking: 0.474, ifbench: null },
    { slug: 'qwen3-8-flash-next', terminalBench40: 0.253 },
  ]));
  // 两份排行榜快照：取日期最新的那份补缺
  writeFileSync(path.join(src, 'aa_data', 'snapshots', 'aa_leaderboard_2026-10-01.json'), JSON.stringify([{ slug: 'glm-5-3-flash', scores: { 'terminalbench-4-0': 0.1 } }]));
  writeFileSync(path.join(src, 'aa_data', 'snapshots', 'aa_leaderboard_2026-11-04.json'), JSON.stringify([
    { slug: 'glm-5-3-flash', scores: { 'terminalbench-4-0': 0.328, 'tau2-bench': 0.5, 'mlcr-aa': 0.117, 'gpqa-diamond': 0.8 } },
    { slug: 'qwen3-8-27b-medium', scores: { 'terminalbench-4-0': 0.9, ifbench: 0.42 } },
  ]));
  return src;
}

test('快照生成：只有现行版本（v5）不带 old；旧版条目带 old + ver；分项按约定键、全量库优先排行榜补缺；体积不炸', () => {
  const snap = S.buildSnapshot(fakeLib(), { today: '2026-11-07' });
  assert.equal(snap.version, 2);
  assert.equal(snap.index, 'v5.0');
  const by = Object.fromEntries(snap.models.map((m) => [m.slug, m]));
  for (const s of ['qwen3-8-max', 'qwen3-8-27b', 'qwen3-8-27b-medium', 'glm-5-3-flash']) assert.equal(by[s].old, undefined, s);
  for (const s of ['qwen3-8-max-0803', 'qwen3-8-flash-next', 'kimi-k3']) assert.deepEqual([by[s].old, by[s].ver], [true, 'v4.3.2'], s);
  assert.equal(by['est-model'].old, undefined);   // 估算值按现行公式估，不算旧
  assert.equal(by['qwen3-8-max'].base, 'qwen3-8-max');
  assert.deepEqual(by['qwen3-8-27b-medium'].subs, { tb40: 5.1, lcr: 79.7, hleD: 6.7, fc2: 11.5, tau3: 47.4, ifbench: 42 });
  assert.deepEqual(by['glm-5-3-flash'].subs, { tb40: 32.8, mlcr: 11.7, tau2: 50 });   // 不认的分项（gpqa）不带
  assert.equal(by['qwen3-8-max'].subs, undefined);
  // 现行版本排在旧分前面
  const firstOld = snap.models.findIndex((m) => m.old);
  assert.ok(snap.models.slice(firstOld).every((m) => m.old));
  const text = S.snapshotText(snap);
  assert.deepEqual(JSON.parse(text), snap);
  assert.doesNotMatch(text, /ratings-lib|Users|Vault/);   // 不带库路径
});

test('loadRatings：旧分不进 families；qwen3.8-max 落到 v5 的 Qwen3.8 Max 而不是 0803 旧条目', () => {
  const I = K.loadRatings(S.buildSnapshot(fakeLib(), { today: 't' }));
  assert.equal(I.version, 'v5.0');
  assert.ok([...I.families.values()].flat().every((m) => !m.old));
  assert.ok(I.oldFamilies.has('qwen3-8-flash-next'));
  assert.deepEqual(K.familyOf(I, 'qwen3.8-max').map((m) => m.slug), ['qwen3-8-max']);
  assert.equal(K.familyOf(I, 'k3'), null);   // Kimi K3 只有旧分：不进阶梯（按未评分处理）
  assert.equal(K.loadRatings(null), null);
  assert.equal(K.loadRatings({ models: [{ slug: 'x' }] }), null);
});

const SNAP = {
  generated: '2026-11-07', index: 'v5.0',
  models: [
    { slug: 'claude-opus-5-5', base: 'claude-opus-5-5', effort: 'max', ii: 59.1, cost: 67 },
    { slug: 'claude-opus-5-5-xhigh', base: 'claude-opus-5-5', effort: 'xhigh', ii: 57.4, cost: 40, subs: { tb40: 59.6 } },
    { slug: 'claude-opus-5-5-high', base: 'claude-opus-5-5', effort: 'high', ii: 51.7, cost: 23 },
    { slug: 'claude-opus-5-5-low', base: 'claude-opus-5-5', effort: 'low', ii: 40, cost: 8 },
    { slug: 'deepseek-v4-1-flash-1017', base: 'deepseek-v4-1-flash-1017', effort: 'max', ii: 32.5, cost: 1.5, rel: '2026-10-17' },
    { slug: 'deepseek-v4-1-flash-1017-high', base: 'deepseek-v4-1-flash-1017', effort: 'high', ii: 28.6, cost: 1, rel: '2026-10-17' },
    { slug: 'deepseek-v4-1-flash-1017-non-reasoning', base: 'deepseek-v4-1-flash-1017', effort: 'off', ii: 18.5, cost: 0.3, rel: '2026-10-17' },
    { slug: 'qwen3-8-27b', base: 'qwen3-8-27b', effort: 'xhigh', ii: 20.1, cost: 20 },
    { slug: 'qwen3-8-27b-medium', base: 'qwen3-8-27b', effort: 'medium', ii: 17.5, cost: 14.5 },
    { slug: 'qwen3-8-27b-non-reasoning', base: 'qwen3-8-27b', effort: 'off', ii: 10, cost: 25 },
    { slug: 'gemini-4-argon', base: 'gemini-4-argon', effort: 'high', ii: 50.4, cost: 26, dep: false },
    { slug: 'mimo-v2-6-pro', base: 'mimo-v2-6-pro', effort: '', ii: 29.9, cost: 5 },
    { slug: 'qwen3-8-flash-next', base: 'qwen3-8-flash-next', effort: '', ii: 39.8, cost: 2.5, old: true, ver: 'v4.3.2', subs: { tb40: 25.3 } },
    { slug: 'kimi-k3', base: 'kimi-k3', effort: 'max', ii: 43.6, cost: 13, old: true, ver: 'v4.3.2', dep: true },
  ],
};

test('normKey 与别名：两边合一（custom: 前缀、[1m]、日期、斜杠）；harness 多出的 qwen / k3 / strata 条目都在', () => {
  assert.equal(K.normKey('custom:p-1:Qwen3.8-27B'), 'qwen3-8-27b');
  assert.equal(K.normKey('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(K.normKey('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(K.normKey(' Gemini 4 Argon '), 'gemini-4-argon');
  assert.equal(K.normKey(undefined), '');
  for (const k of ['k3', 'k3-256k', 'strata-orca', 'strata-flash-iq3s', 'strata-orca-iq3xxs', 'strata-flash-nvfp4', 'qwen3-8-flash-next-fp8', 'qwen3-8-27b']) {
    assert.ok(K.ALIASES[k], k);
  }
  for (const k of ['strata-orca', 'strata-flash-iq3s', 'strata-orca-iq3xxs', 'strata-flash-nvfp4', 'qwen3-8-flash-next-fp8']) {
    assert.equal(K.ALIASES[k], 'qwen3-8-flash-next', k);
  }
  assert.equal(K.ALIASES['qwen3-8-max'], undefined);   // 以前指向已弃用的 0803 旧条目
  // Kimi 端点上的 K3.1 Pro（两个 id）对上 AA 的 kimi-k3-1-pro
  for (const id of ['k3.1-pro', 'k3.1-pro-highspeed']) assert.equal(K.ALIASES[K.normKey(id)], 'kimi-k3-1-pro', id);
});

test('lookupRating：按档位取（同名档 → 不高于它的最强档 → 最低档），不给档位取最强；返回约定字段', () => {
  const I = K.loadRatings(SNAP);
  const r = K.lookupRating(I, 'claude-opus-5-5', { effort: 'xhigh' });
  assert.deepEqual(r, { slug: 'claude-opus-5-5-xhigh', base: 'claude-opus-5-5', ii: 57.4, version: 'v5.0', effort: 'xhigh', subs: { tb40: 59.6 }, date: '', deprecated: false, cost: 40, exact: true, name: 'claude-opus-5-5-xhigh' });
  assert.equal(K.lookupRating(I, 'claude-opus-5-5').slug, 'claude-opus-5-5');                       // 最强
  assert.deepEqual([K.lookupRating(I, 'claude-opus-5-5', { effort: 'medium' }).effort, K.lookupRating(I, 'claude-opus-5-5', { effort: 'medium' }).exact], ['low', false]);
  assert.equal(K.lookupRating(I, 'deepseek-flash', { effort: 'high' }).slug, 'deepseek-v4-1-flash-1017-high');
  assert.equal(K.lookupRating(I, 'deepseek-chat', { effort: 'off' }).slug, 'deepseek-v4-1-flash-1017-non-reasoning');
  assert.equal(K.lookupRating(I, 'deepseek-flash').slug, 'deepseek-v4-1-flash-1017');               // 不思考那条不算最强
  assert.equal(K.lookupRating(I, 'qwen3.8-27b', { effort: 'medium' }).ii, 17.5);
  assert.equal(K.lookupRating(I, 'qwen3.8-27b', { effort: 'low' }).effort, 'medium');               // 低于全部档：取最低档
  assert.equal(K.lookupRating(I, 'gemini-4-argon', { effort: 'xhigh' }).effort, 'high');
  assert.equal(K.lookupRating(I, 'mimo-v2.6-pro', { effort: 'high' }).ii, 29.9);                    // 只有一种配置
  assert.equal(K.lookupRating(I, 'deepseek/deepseek-v4.1-flash-1017').base, 'deepseek-v4-1-flash-1017');   // vendor/ 前缀
  assert.equal(K.lookupRating(I, 'nope'), null);
  assert.equal(K.lookupRating(null, 'claude-opus-5-5'), null);
});

test('lookupRating：本机 / 量化版本带 derived；只有旧分的族默认认不出，allowOld 才给且带 old 与旧版本号', () => {
  const I = K.loadRatings(SNAP);
  assert.equal(K.lookupRating(I, 'qwen3.8-27b').derived, undefined);
  assert.equal(K.lookupRating(I, 'qwen3.8-27b', { provider: 'local' }).derived, true);
  assert.equal(K.lookupRating(I, 'qwen3.8-27b-Q4_K_M').derived, true);                              // 量化后缀
  assert.equal(K.lookupRating(I, 'qwen3.8-27b-Q4_K_M').base, 'qwen3-8-27b');
  // Qwen3.8 Flash Next 只有 v4.3.2 的分：现行口径认不出（调用方按中位偏保守），显式 allowOld 才给
  for (const id of ['strata-orca', 'strata-flash-iq3s', 'strata-orca-iq3xxs', 'strata-flash-nvfp4', 'qwen3.8-flash-next-fp8']) {
    assert.equal(K.lookupRating(I, id), null, id);
    const o = K.lookupRating(I, id, { allowOld: true });
    assert.deepEqual([o.base, o.version, o.old, o.derived, o.subs.tb40], ['qwen3-8-flash-next', 'v4.3.2', true, true, 25.3], id);
  }
  assert.deepEqual([K.lookupRating(I, 'k3', { allowOld: true }).deprecated, K.lookupRating(I, 'k3', { allowOld: true }).old], [true, true]);
  assert.equal(K.familyOf(I, 'strata-orca'), null);   // 阶梯不认旧分
});

test('ratingsSummary：只算现行版本；全部档位口径与每族最强口径都给，顶层 = 每族最强', () => {
  const s = K.ratingsSummary(K.loadRatings(SNAP));
  assert.equal(s.version, 'v5.0');
  assert.equal(s.allEfforts.count, 12);
  // 每族最强：opus 59.1、deepseek 32.5、qwen27b 20.1、argon 50.4、mimo 29.9 → 中位 32.5
  assert.deepEqual(s.bestPerFamily, { median: 32.5, p25: 29.9, p75: 50.4, count: 5 });
  assert.deepEqual([s.median, s.p25, s.p75, s.count], [32.5, 29.9, 50.4, 5]);
  assert.deepEqual(K.ratingsSummary(null), { median: 0, p25: 0, p75: 0, count: 0, version: '', allEfforts: { median: 0, p25: 0, p75: 0, count: 0 }, bestPerFamily: { median: 0, p25: 0, p75: 0, count: 0 } });
});

test('已提交的快照：现行版本有名字、旧分都带 old + ver、Qwen3.8 Max 自成一族、体积在预算内', () => {
  const file = path.join(HERE, '..', 'config', 'model-ratings.json');
  const text = readFileSync(file, 'utf8');
  const j = JSON.parse(text);
  assert.ok(j.index, '快照没写现行指数版本');
  for (const m of j.models) if (m.old) assert.ok(m.ver, `${m.slug} 是旧分但没写版本`);
  const qmax = j.models.find((m) => m.slug === 'qwen3-8-max');
  if (qmax) assert.equal(qmax.base, 'qwen3-8-max');
  for (const m of j.models) for (const k of Object.keys(m.subs || {})) assert.ok(k in K.SUB_KEYS, `${m.slug} 带了约定外的分项 ${k}`);
  assert.ok(Buffer.byteLength(text) < 81_000, `快照 ${Buffer.byteLength(text)} 字节，超出原来 2.5 倍`);
  const I = K.loadRatings(j);
  assert.ok(I.models.length > 0);
});
