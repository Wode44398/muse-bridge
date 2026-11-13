// 子 agent 调用策略子页的纯函数（dpUtil.js）。跑法：node --test web/src/components/claude/dispatch/dpUtil.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftOf, draftDiff, sameDraft, strategyPayload, hasFloorEdits, clipName, uniqueName,
  toCanonical, toPickerId, familyOf, keepEffort, chartPick, overridePick, estimateTiers,
  fmtWhen, chartFileProblem, CHART_MAX_BYTES,
  strategyLabel, effortLabelIn, chartTiersOf, anchorRect, menuStep, tabStep, sharedFlight, singleFlight, latestAfter,
} from './dpUtil.js';
import { vendorKeyOf } from '../../../lib/dispatchChartMath.js';

const PRIMARY = [{ id: 'claude-fable-5-2' }, { id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }];
const CANDS = [
  { model: 'fable', effort: 'max', ii: 62, cost: 4 },
  { model: 'opus', effort: 'max', ii: 57, cost: 1.2 },
  { model: 'opus', effort: 'medium', ii: 52, cost: 0.6 },
  { model: 'sonnet', effort: 'high', ii: 47, cost: 0.6 },
  { model: 'haiku', effort: 'low', ii: 30, cost: 0.05 },
  { model: 'custom:p-1:deepseek-v4', effort: '', ii: 41, cost: 0.02 },
];
const SERVER_TIERS = [
  { key: 'top', floorDefault: 60.5 }, { key: 'hard', floorDefault: 54.6 },
  { key: 'normal', floorDefault: 37.2 }, { key: 'light', floorDefault: 24.8 },
];

test('草稿：规整、比较、发给服务端的形状', () => {
  const s = { id: 's-1', name: ' 省钱 ', floors: { top: 60.04, hard: null, normal: 'x' }, overrides: { hard: { model: 'opus', effort: 'max' }, light: { model: '' } }, note: 'n', createdAt: 1 };
  const d = draftOf(s);
  assert.deepEqual(d.floors, { top: 60, hard: null, normal: null, light: null });
  assert.deepEqual(d.overrides, { top: null, hard: { model: 'opus', effort: 'max' }, normal: null, light: null });
  assert.equal(sameDraft(d, draftOf(s)), true);
  assert.equal(hasFloorEdits(d), true);
  assert.equal(hasFloorEdits(draftOf({})), false);

  const e = draftOf(s);
  e.floors.hard = 50; e.note = 'm';
  assert.deepEqual(draftDiff(e, d), { name: false, floors: true, overrides: false, note: true, any: true });
  e.overrides.hard = { model: 'opus', effort: 'high' };
  assert.equal(draftDiff(e, d).overrides, true);

  const p = strategyPayload(d);
  assert.equal(p.id, 's-1');
  assert.equal(p.name, '省钱');
  assert.equal('createdAt' in p, false);
  assert.equal('id' in strategyPayload({ ...d, id: '' }), false);
});

test('名字：截到 24 字、去空白、不撞名', () => {
  assert.equal(clipName('  a\n b  '), 'a b');
  assert.equal([...clipName('字'.repeat(40))].length, 24);
  assert.equal([...clipName('😀'.repeat(30))].length, 24);
  assert.equal(uniqueName(['策略 1', '策略 2'], (n) => `策略 ${n}`), '策略 3');
  assert.equal(uniqueName(['默认 副本'], (n) => (n > 1 ? `默认 副本 ${n}` : '默认 副本')), '默认 副本 2');
});

test('模型写法：菜单 id 与规范写法互换', () => {
  assert.equal(familyOf('claude-opus-5-5'), 'opus');
  assert.equal(toCanonical('claude-opus-5-5', PRIMARY), 'opus');
  assert.equal(toCanonical('claude-opus-4-8', PRIMARY), '');          // 旧型号没有别名
  assert.equal(toCanonical('custom:p-1:m', PRIMARY), 'custom:p-1:m');
  assert.equal(toPickerId('fable', PRIMARY), 'claude-fable-5-2');
  assert.equal(toPickerId('custom:p-1:m', PRIMARY), 'custom:p-1:m');
  assert.equal(toPickerId('gpt', PRIMARY), '');
  assert.equal(keepEffort('max', [{ id: 'low' }, { id: 'max' }]), 'max');
  assert.equal(keepEffort('max', [{ id: 'off' }, { id: 'on' }]), '');
});

test('图谱规则：线以上最便宜；同价取智力分低的；够不着取最强并标 short', () => {
  assert.equal(chartPick(CANDS, 60).pick.model, 'fable');
  assert.deepEqual([chartPick(CANDS, 45).pick.model, chartPick(CANDS, 45).pick.effort], ['sonnet', 'high']);   // 0.6 元有两格，取 47 分那格
  assert.equal(chartPick(CANDS, 35).pick.model, 'custom:p-1:deepseek-v4');
  const none = chartPick(CANDS, 90);
  assert.equal(none.short, true);
  assert.equal(none.pick.model, 'fable');
  assert.equal(chartPick([], 10), null);
  assert.equal(chartPick([{ model: 'x', effort: '', ii: 99, cost: 0.01, est: true }, ...CANDS], 60).pick.model, 'fable');   // 合成的格子不参与
});

test('档位自定义压过图谱；对不上模型就回落并标注', () => {
  assert.equal(overridePick(CANDS, { model: 'opus', effort: 'medium' }).ii, 52);
  const est = overridePick(CANDS, { model: 'opus', effort: 'low' });
  assert.equal(est.est, true);
  assert.equal(est.effort, 'low');
  assert.equal(overridePick(CANDS, { model: 'custom:gone:x', effort: '' }), null);

  const draft = draftOf({ floors: { normal: 45 }, overrides: { top: { model: 'opus', effort: 'max' }, light: { model: 'custom:gone:x', effort: '' } } });
  const tiers = estimateTiers(SERVER_TIERS, CANDS, draft);
  assert.deepEqual(tiers.map((x) => x.key), ['top', 'hard', 'normal', 'light']);
  assert.deepEqual([tiers[0].source, tiers[0].pick.model, tiers[0].floor], ['override', 'opus', 60.5]);
  assert.deepEqual([tiers[1].source, tiers[1].pick.model], ['chart', 'opus']);
  assert.deepEqual([tiers[2].floor, tiers[2].floorDefault, tiers[2].pick.model], [45, 37.2, 'sonnet']);
  assert.deepEqual([tiers[3].source, tiers[3].overrideSkipped, tiers[3].pick.model], ['chart', true, 'custom:p-1:deepseek-v4']);   // 24.8 以上最便宜的是 0.02 元那格
  assert.deepEqual(estimateTiers([], CANDS, draft), []);
  assert.deepEqual(estimateTiers(SERVER_TIERS, [], draft), []);
});

// 性价比图给一个点留位置的条件（PlanChart 的 entry）：成本是正数、智力分是数
const plottable = (p) => Number(p.cost) > 0 && Number.isFinite(Number(p.cost)) && Number.isFinite(Number(p.ii));

test('交给图的四档：落点带全，候选里没有的那一格也画得出来', () => {
  // 第三方模型只有「不指定」一格有评分，「难」档手动指定成 on：服务端按相近的档合成一格（est），候选里没有它
  const cands = [...CANDS.map((c) => ({ ...c, creator: 'Anthropic', basis: 'sub' })).slice(0, 5),
    { model: 'custom:p-1:deepseek-v4', effort: '', ii: 41, cost: 0.02, basis: 'api', creator: 'DeepSeek', label: 'DeepSeek V4' }];
  const serverTiers = [
    { key: 'top', floor: 60.5, floorDefault: 60.5, source: 'chart', short: false, pick: { model: 'fable', label: 'Fable 5.2', effort: 'max', ii: 62, cost: 4, basis: 'sub', provider: 'Claude 订阅' } },
    { key: 'hard', floor: 54.6, floorDefault: 54.6, source: 'override', short: false,
      pick: { model: 'custom:p-1:deepseek-v4', label: 'DeepSeek V4', effort: 'on', ii: 41, cost: 0.02, basis: 'api', provider: 'DeepSeek 官方', est: true } },
  ];
  const [top, hard] = chartTiersOf(serverTiers, cands);
  assert.deepEqual([top.key, top.floor, top.floorDefault, top.source, top.short], ['top', 60.5, 60.5, 'chart', false]);
  assert.equal(cands.some((c) => c.model === hard.pick.model && (c.effort || '') === hard.pick.effort), false);   // 候选里确实没有这一格
  assert.equal(plottable(hard.pick), true);                        // 只传 { model, effort } 时这里是 NaN，虚点补不出来
  assert.deepEqual([hard.pick.ii, hard.pick.cost, hard.pick.label, hard.pick.basis, hard.pick.est], [41, 0.02, 'DeepSeek V4', 'api', true]);
  assert.equal(hard.pick.creator, 'DeepSeek');                     // 服务端的落点不带 creator：从同模型的候选上借
  assert.equal(vendorKeyOf(hard.pick), 'deepseek');                // 不借的话 API 价的点会被归到「其他」
  assert.equal(vendorKeyOf(top.pick), 'anthropic');

  // 推理强度是 ''（换模型后留下的「不指定」）也照样带全，effort 规整成 ''
  const blank = chartTiersOf([{ key: 'normal', floor: 37, floorDefault: 37, source: 'override', pick: { model: 'opus', effort: undefined, ii: 55, cost: 1, basis: 'sub', est: true } }], cands)[0];
  assert.deepEqual([blank.pick.effort, blank.pick.creator, blank.short, plottable(blank.pick)], ['', 'Anthropic', false, true]);

  // 本地预估（overridePick 合成的格子）走同一条路
  const local = estimateTiers(SERVER_TIERS, cands, draftOf({ overrides: { hard: { model: 'custom:p-1:deepseek-v4', effort: 'on' } } }));
  const lh = chartTiersOf(local, cands).find((x) => x.key === 'hard');
  assert.deepEqual([lh.source, lh.pick.effort, lh.pick.est, plottable(lh.pick), vendorKeyOf(lh.pick)], ['override', 'on', true, true, 'deepseek']);
  assert.deepEqual(chartTiersOf(null, cands), []);
  assert.deepEqual(chartTiersOf([{ key: 'top' }], cands), []);     // 没有落点的档不给图
});

test('策略名：存的名字正好是「默认」时跟着界面语言走，自己起的原样', () => {
  assert.equal(strategyLabel('默认', 'Default'), 'Default');
  assert.equal(strategyLabel('默认', '默认'), '默认');
  assert.equal(strategyLabel('省钱', 'Default'), '省钱');
  assert.equal(strategyLabel('默认 副本', 'Default'), '默认 副本');     // 只认整个名字
  assert.equal(strategyLabel('Default', 'Default'), 'Default');
  assert.equal(strategyLabel('', 'Default'), 'Default');               // 空名：同外壳入口的判断
  assert.equal(strategyLabel(null, 'Default'), 'Default');
  assert.equal(strategyLabel('默认'), '默认');                          // 没给译名就原样
});

test('推理强度的叫法：和拉条面板同一张档位表', () => {
  const table = [{ id: 'low', name: 'Low' }, { id: 'xhigh', name: 'Extra' }, { id: 'max', name: 'Max' }];
  assert.equal(effortLabelIn(table, 'xhigh'), 'Extra');
  assert.equal(effortLabelIn(table, 'medium'), '');                    // 表里没有：由调用方退回通用叫法
  assert.equal(effortLabelIn(table, ''), '');
  assert.equal(effortLabelIn([{ id: '', name: '默认' }, { id: 'on', name: '开启' }], ''), '默认');
  assert.equal(effortLabelIn(null, 'max'), '');
});

test('浮层的锚点：片落到视口外面（软键盘弹出）时收回视口里', () => {
  // 375×667 的手机：片在 y 600–636；键盘弹出后视口只剩 367 高
  const chip = { left: 36, right: 142, top: 600, bottom: 636 };
  assert.deepEqual(anchorRect(chip, 375, 667), chip);                  // 在视口里：原样
  const a = anchorRect(chip, 375, 367);
  assert.deepEqual(a, { left: 36, right: 142, top: 367, bottom: 367 });
  // 模型菜单 / 拉条面板的摆法：下方放不下就朝上，底边 = 视口高 − 片的上沿 + 间距。收进来之后底边落在视口里
  const gap = 6, bottomEdge = 367 - (367 - a.top + gap);
  assert.equal(bottomEdge > 0 && bottomEdge <= 367, true);
  assert.equal(367 - (367 - chip.top + gap) > 367, true);              // 不收：底边在视口下面 227px，整张菜单压在键盘底下
  assert.deepEqual(anchorRect({ left: -20, right: 60, top: -50, bottom: -14 }, 375, 667), { left: 0, right: 60, top: 0, bottom: 0 });
  assert.deepEqual(anchorRect({ left: 300, right: 420, top: 10, bottom: 46 }, 375, 667), { left: 300, right: 375, top: 10, bottom: 46 });
  assert.deepEqual(anchorRect(null, 375, 667), { left: 0, right: 0, top: 0, bottom: 0 });
});

test('浮层里的键盘走位：方向键在各行之间走，Tab 圈在层里', () => {
  assert.equal(menuStep('ArrowDown', -1, 4), 0);
  assert.equal(menuStep('ArrowDown', 3, 4), 0);
  assert.equal(menuStep('ArrowUp', 0, 4), 3);
  assert.equal(menuStep('ArrowUp', -1, 4), 3);
  assert.equal(menuStep('Home', 2, 4), 0);
  assert.equal(menuStep('End', 0, 4), 3);
  assert.equal(menuStep('Enter', 1, 4), -1);
  assert.equal(menuStep('ArrowDown', 0, 0), -1);
  assert.equal(tabStep(-1, 3, false), 0);      // 焦点还在层外（背后的页面上）：进层里第一个
  assert.equal(tabStep(-1, 3, true), 2);
  assert.equal(tabStep(2, 3, false), 0);       // 最后一个再 Tab：回到第一个，不漏到背后的页面
  assert.equal(tabStep(0, 3, true), 2);
  assert.equal(tabStep(1, 3, false), -1);      // 中间的交给浏览器
  assert.equal(tabStep(0, 0, false), -1);
});

test('防连点：新建在途时不重复办，落定后的一小会儿也不办', async () => {
  let clock = 1000, runs = 0, release;
  const once = singleFlight({ cool: 400, now: () => clock });
  const job = () => { runs++; return new Promise((r) => { release = () => r('made-' + runs); }); };
  const a = once(job), b = once(job);          // 双击：第二下落在第一下还没回来的时候
  assert.equal(await b, undefined);
  assert.equal(runs, 1);
  release();
  assert.equal(await a, 'made-1');
  clock += 150;                                 // 第二下落在第一下已经办完之后（请求回得快）
  assert.equal(await once(job), undefined);
  assert.equal(runs, 1);
  clock += 400;                                 // 隔了一会儿再点：照常办
  const c = once(job);
  release();
  assert.equal(await c, 'made-2');
  // 办砸了也要放开（不然再也点不动）
  await assert.rejects(singleFlight()(async () => { throw new Error('boom'); }), /boom/);
  const again = singleFlight();
  await again(async () => { throw new Error('x'); }).catch(() => {});
  assert.equal(await again(async () => 'ok'), 'ok');
});

test('防连点：连点别的策略签只问一轮，落定后切到最后点的那一套', async () => {
  let asked = 0, answer;
  const shown = [];
  const gate = () => { asked++; return new Promise((r) => { answer = r; }); };
  const go = latestAfter(gate, (id) => shown.push(id));
  const first = go('s-b');
  assert.equal(go.busy(), true);
  await go('s-c');                              // 还在问的时候又点了一枚：只换目标
  assert.equal(asked, 1);
  answer(true);
  await first;
  assert.deepEqual(shown, ['s-c']);
  assert.equal(go.busy(), false);
  const second = go('s-d');                     // 选了「继续编辑」：哪儿也不去
  answer(false);
  await second;
  assert.deepEqual(shown, ['s-c']);
  assert.equal(asked, 2);

  // 「要保存吗」那一问：同时来问的都等同一个结果
  let rounds = 0, done;
  const settle = sharedFlight(() => { rounds++; return new Promise((r) => { done = r; }); });
  const p1 = settle(), p2 = settle();
  assert.equal(p1, p2);
  assert.equal(rounds, 1);
  done(true);
  assert.equal(await p2, true);
  const p3 = settle();                          // 落定之后再问是新的一轮
  assert.equal(rounds, 2);
  done(false);
  assert.equal(await p3, false);
});

test('导入时间的写法', () => {
  const now = new Date(2026, 10, 11, 9, 0).getTime();
  assert.equal(fmtWhen(new Date(2026, 10, 9, 14, 5).getTime(), now), '11-09 14:05');
  assert.equal(fmtWhen(new Date(2025, 0, 3, 1, 2).getTime(), now), '2025-01-03');
  assert.equal(fmtWhen('nope', now), '');
});

test('拖进来的文件像不像性价比图', () => {
  assert.equal(chartFileProblem({ name: '订阅plan性价比图.html', type: 'text/html', size: 100 }), '');
  assert.equal(chartFileProblem({ name: 'a.HTM', type: '', size: 100 }), '');
  assert.equal(chartFileProblem({ name: 'a.png', type: 'image/png', size: 100 }), 'type');
  assert.equal(chartFileProblem({ name: 'a.html', type: 'text/html', size: 0 }), 'empty');
  assert.equal(chartFileProblem({ name: 'a.html', type: 'text/html', size: CHART_MAX_BYTES + 1 }), 'size');
});
