// 性价比图的纯函数（lib/dispatchChartMath.js）：视野与坐标、刻度、成本格式化、判定线的夹取 / 吸附 / 键盘步进、
// 每档落点（要和服务端 ladderOf 的规则一致）、前沿与阶梯、手柄散开、标注避让、提示框定位、厂商配色与形状。
// 纯 JS，不起浏览器：node --test web/src/lib/dispatchChartMath.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIER_KEYS, FLOOR_GAP, isNarrow, chartHeight, plotBox, extentOf, domainFrom, domainOf, sameDomain, lerpDomain, xOf, yOf, scoreAt, scorePerPx,
  yTicks, xTicks, thinTicks, fmtTick, fmtCost, fmtScore, roundFloor, floorBounds, clampFloor, snapFloor, stepFloor, floorsOrdered,
  pickForFloor, locatePicks, frontier, stairPath, nearestIndex, spreadLabels, placeLabels, placeTip,
  VCOLOR, VENDOR_SLOTS, vendorSlot, makerKey, vendorKeyOf, shapeKind, shapePath, decodePoint,
} from './dispatchChartMath.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('版面：宽 ≥ 720 高 420，窄屏高 340；图版四边的留白照原页，左边可以按手柄宽度放宽', () => {
  assert.equal(isNarrow(719), true);
  assert.equal(isNarrow(720), false);
  assert.equal(isNarrow(0), false, '还没量到宽度时不当窄屏');
  assert.equal(chartHeight(900), 420);
  assert.equal(chartHeight(380), 340);
  assert.deepEqual(plotBox(900, 420, false), { l: 50, t: 30, w: 900 - 50 - 14, h: 420 - 30 - 52 });
  assert.deepEqual(plotBox(380, 340, true), { l: 40, t: 30, w: 380 - 40 - 8, h: 340 - 30 - 46 });
  assert.equal(plotBox(900, 420, false, 86).l, 86, '手柄比刻度数字宽：左边跟着放宽');
  assert.equal(plotBox(900, 420, false, 20).l, 50, '不会比原页的留白更窄');
  assert.ok(plotBox(10, 10, true).w >= 1 && plotBox(10, 10, true).h >= 1, '挤到没地方也不出负数');
});

test('视野：横轴取到四分之一个数量级再各让 0.05，纵轴 0 到 min(100, ceil((最高分 + 4) / 10) × 10)', () => {
  const d = domainOf([{ cost: 0.0149, score: 31.2 }, { cost: 2.4, score: 64.6 }, { cost: 0.5, score: 50 }]);
  near(d.L0, Math.floor(Math.log10(0.0149) * 4) / 4 - 0.05);
  near(d.L1, Math.ceil(Math.log10(2.4) * 4) / 4 + 0.05);
  assert.equal(d.Y0, 0);
  assert.equal(d.Y1, 70);
  assert.equal(domainOf([{ cost: 1, score: 97 }]).Y1, 100, '封顶 100');
  // 成本正好在四分之一数量级上：不多退一格
  const q = domainOf([{ cost: 0.01, score: 20 }, { cost: 100, score: 40 }]);
  near(q.L0, -2.05);
  near(q.L1, 2.05);
  // 只有一个点也有宽度
  const one = domainOf([{ cost: 1, score: 50 }]);
  assert.ok(one.L1 > one.L0);
});

test('视野：成本 ≤ 0、不是数的点不参与；一个能画的都没有 → null', () => {
  assert.equal(domainOf([]), null);
  assert.equal(domainOf(null), null);
  assert.equal(domainOf([{ cost: 0, score: 50 }, { cost: -1, score: 50 }, { cost: NaN, score: 1 }, { cost: 1, score: undefined }, null]), null);
  const d = domainOf([{ cost: 0, score: 99 }, { cost: 1, score: 40 }]);
  assert.equal(d.Y1, 50, '没位置的点不抬高纵轴');
});

test('视野 · 没有价格的候选（free）：分数照样算进纵轴；一个有价格的都没有时横轴给一段默认的，图不变成空态', () => {
  // 候选里只有一个成本为 0 的型号（快照里 0 = 没有价格）：照旧算是 null（空态），free 口径下有视野
  const only = [{ cost: 0, score: 6.2 }];
  assert.equal(domainOf(only), null);
  const d = domainOf(only, { free: true });
  assert.ok(d, '有地方画');
  assert.equal(d.Y0, 0);
  assert.equal(d.Y1, 20);
  near(d.L0, -2.05);   // ¥0.01
  near(d.L1, 0.05);    // ¥1
  // 和有价格的混在一起：横轴只看有价格的，纵轴要够得着没价格的那个
  const mix = domainOf([{ cost: 0, score: 66 }, { cost: 1, score: 40 }, { cost: NaN, score: 30 }], { free: true });
  assert.equal(mix.Y1, 70);
  near(mix.L0, -0.05);
  near(mix.L1, 0.05);
  // 分数不是数的照旧不算
  assert.equal(domainOf([{ cost: 0, score: NaN }, { cost: 0 }, null], { free: true }), null);
  // extentOf：范围本身
  assert.deepEqual(extentOf([{ cost: 0.5, score: 10 }, { cost: 2, score: 30 }, { cost: 0, score: 99 }]), { lo: 0.5, hi: 2, best: 30 });
  assert.deepEqual(extentOf([{ cost: 0.5, score: 10 }, { cost: 0, score: 99 }], { free: true }), { lo: 0.5, hi: 0.5, best: 99 });
  assert.equal(extentOf([]), null);
});

test('视野 · 几份范围合成一个；纵轴要装得下判定线（reach）——线是绝对分，可能比眼下这批点都高', () => {
  const cands = extentOf([{ cost: 0.05, score: 27.8 }, { cost: 0.31, score: 45 }]);
  const rows = extentOf([{ cost: 0.002, score: 12 }, { cost: 150, score: 64.6 }]);
  assert.deepEqual(domainFrom([cands, rows]), domainOf([{ cost: 0.05, score: 27.8 }, { cost: 0.31, score: 45 }, { cost: 0.002, score: 12 }, { cost: 150, score: 64.6 }]));
  assert.deepEqual(domainFrom([cands, null]), domainOf([{ cost: 0.05, score: 27.8 }, { cost: 0.31, score: 45 }]), 'null 的那份跳过');
  assert.equal(domainFrom([null, null]), null);
  assert.equal(domainFrom([], 57), null, '没有点：有线也没处画');
  // 候选最高 45 → 纵轴本来到 50；「最难」的线在别的口径下调到了 57 → 纵轴放到 60，线画在它真实的位置上
  assert.equal(domainFrom([cands]).Y1, 50);
  assert.equal(domainFrom([cands], 57).Y1, 60);
  assert.equal(domainFrom([cands], 60).Y1, 60, '正好在整十上：线贴着图顶');
  assert.equal(domainFrom([cands], 60.1).Y1, 70);
  assert.equal(domainFrom([cands], 30).Y1, 50, '线在点下面：不影响');
  assert.equal(domainFrom([cands], 250).Y1, 100, '封顶 100');
  assert.equal(domainFrom([cands], NaN).Y1, 50);
  assert.equal(domainFrom([cands], -Infinity).Y1, 50, '一条线都没有');
  assert.equal(domainOf([{ cost: 1, score: 45 }], { reach: 57 }).Y1, 60);
});

test('坐标：X 是对数、Y 向上为大，scoreAt 是 yOf 的逆；视野插值两头对得上', () => {
  const dom = { L0: -2, L1: 1, Y0: 0, Y1: 70 }, box = { l: 80, t: 30, w: 600, h: 338 };
  near(xOf(0.01, dom, box), 80);
  near(xOf(10, dom, box), 680);
  near(xOf(1, dom, box), 80 + 400);
  near(yOf(0, dom, box), 368);
  near(yOf(70, dom, box), 30);
  near(scoreAt(yOf(56.3, dom, box), dom, box), 56.3);
  near(scorePerPx(dom, box), 70 / 338);
  const to = { L0: -3, L1: 2, Y0: 0, Y1: 80 };
  assert.deepEqual(lerpDomain(dom, to, 0), dom);
  assert.deepEqual(lerpDomain(dom, to, 1), to);
  near(lerpDomain(dom, to, 0.5).Y1, 75);
  assert.equal(sameDomain(dom, { ...dom }), true);
  assert.equal(sameDomain(dom, to), false);
  assert.equal(sameDomain(null, dom), false);
});

test('纵轴刻度：步长取至少分出 4 格的最大那个', () => {
  assert.deepEqual(yTicks({ Y0: 0, Y1: 70 }), [0, 10, 20, 30, 40, 50, 60, 70]);
  assert.deepEqual(yTicks({ Y0: 0, Y1: 30 }), [0, 5, 10, 15, 20, 25, 30]);
  assert.deepEqual(yTicks({ Y0: 0, Y1: 10 }), [0, 2, 4, 6, 8, 10]);
});

test('横轴刻度：跨度越宽主刻度越稀；次刻度是剩下的 2–9，跨度超过 4 个数量级不给', () => {
  const a = xTicks({ L0: -2.05, L1: 0.55 });   // 跨 2.6：主刻度 1 / 2 / 5
  assert.deepEqual(a.major.map(fmtTick), ['0.01', '0.02', '0.05', '0.1', '0.2', '0.5', '1', '2']);
  assert.ok(a.minor.some((v) => Math.abs(v - 0.03) < 1e-12) && a.minor.some((v) => Math.abs(v - 3) < 1e-12));
  assert.ok(a.minor.every((v) => !a.major.some((m) => Math.abs(m - v) < 1e-12)), '次刻度不和主刻度重');
  const wide = xTicks({ L0: -3.05, L1: 2.55 });   // 跨 5.6：只有整数量级
  assert.deepEqual(wide.major.map(fmtTick), ['0.001', '0.01', '0.1', '1', '10', '100']);
  assert.deepEqual(wide.minor, []);
  const tight = xTicks({ L0: -0.05, L1: 0.3 });   // 跨 0.35：最密的一组（左边让出的 0.05 里正好有个 0.9）
  assert.deepEqual(tight.major.map(fmtTick), ['0.9', '1', '1.2', '1.5']);
  assert.deepEqual(tight.minor, [], '1–9 全是主刻度，没有次刻度');
});

test('刻度数字：挨得太近的只留刻度线；三位有效数字、去掉多余的 0', () => {
  assert.deepEqual(thinTicks([10, 30, 55, 60, 100], 40), [true, false, true, false, true]);
  assert.deepEqual(thinTicks([], 40), []);
  assert.equal(fmtTick(0.05), '0.05');
  assert.equal(fmtTick(200), '200');
  assert.equal(fmtTick(1.5), '1.5');
  assert.equal(fmtTick(0.30000000000000004), '0.3');
});

test('成本格式：≥10 一位小数，≥0.1 两位，更小两位有效数字；分界按四舍五入之后算', () => {
  assert.equal(fmtCost(285.147), '¥285.1');
  assert.equal(fmtCost(67.39851), '¥67.4');
  assert.equal(fmtCost(10), '¥10.0');
  assert.equal(fmtCost(9.996), '¥10.0', '不写成 10.00');
  assert.equal(fmtCost(9.96), '¥9.96');
  assert.equal(fmtCost(1.25875), '¥1.26');
  assert.equal(fmtCost(0.1), '¥0.10');
  assert.equal(fmtCost(0.0996), '¥0.10', '不写成 0.1');
  assert.equal(fmtCost(0.0994), '¥0.099');
  assert.equal(fmtCost(0.0149), '¥0.015');
  assert.equal(fmtCost(0.05), '¥0.05');
  assert.equal(fmtCost(0.00111), '¥0.0011');
  assert.equal(fmtCost(0.00000012), '¥0.00000012', '很小也不用科学计数');
  assert.equal(fmtCost(0), '¥0');
  assert.equal(fmtCost(NaN), '—');
  assert.equal(fmtCost(-1), '—');
  assert.equal(fmtCost(undefined), '—');
  assert.equal(fmtScore(59.11), '59.1');
  assert.equal(fmtScore(60), '60.0');
  assert.equal(fmtScore(null), '—');
});

const FL = { top: 62.5, hard: 56, normal: 38, light: 25 };

test('判定线范围：不越过相邻两档（至少隔 0.5 分），也不出图的上下沿', () => {
  assert.equal(FLOOR_GAP, 0.5);
  assert.deepEqual(TIER_KEYS, ['top', 'hard', 'normal', 'light']);
  assert.deepEqual(floorBounds('top', FL, { min: 0, max: 70 }), { lo: 56.5, hi: 70 });
  assert.deepEqual(floorBounds('hard', FL, { min: 0, max: 70 }), { lo: 38.5, hi: 62 });
  assert.deepEqual(floorBounds('light', FL, { min: 0, max: 70 }), { lo: 0, hi: 37.5 });
  // 中间缺一档：找下一个有值的邻居
  assert.deepEqual(floorBounds('top', { top: 60, normal: 30 }, { min: 0, max: 70 }), { lo: 30.5, hi: 70 });
  // 邻居不在 0.1 的格子上：下界往上取、上界往下取，夹出来的值仍守序
  assert.deepEqual(floorBounds('hard', { top: 60.04, hard: 50, normal: 30.04 }), { lo: 30.6, hi: 59.5 });
});

test('拖动夹取：结果一位小数、夹在相邻两档之间；没有余地时原地不动', () => {
  assert.equal(clampFloor('hard', 50.26, FL, { min: 0, max: 70 }), 50.3);
  assert.equal(clampFloor('hard', 99, FL, { min: 0, max: 70 }), 62, '顶到最难档下面 0.5');
  assert.equal(clampFloor('hard', -5, FL, { min: 0, max: 70 }), 38.5, '压到常规档上面 0.5');
  assert.equal(clampFloor('top', 99, FL, { min: 0, max: 70 }), 70, '不出图的上沿');
  assert.equal(clampFloor('light', -3, FL, { min: 0, max: 70 }), 0);
  assert.equal(clampFloor('hard', 61.97, FL, { min: 0, max: 70 }), 62);
  // 上下两档只隔 0.6：中间这档没有合法位置
  assert.equal(clampFloor('hard', 40, { top: 50.3, hard: 50, normal: 49.7 }), 50);
  // 夹完之后四条线一定守序
  for (const v of [0, 12.34, 38.4, 38.5, 55.55, 62, 62.1, 100]) {
    const next = { ...FL, hard: clampFloor('hard', v, FL, { min: 0, max: 70 }) };
    assert.ok(floorsOrdered(next) && next.top - next.hard >= 0.5 - 1e-9 && next.hard - next.normal >= 0.5 - 1e-9, `hard=${next.hard}`);
  }
  assert.equal(roundFloor(56.25), 56.3);
  assert.equal(roundFloor(56.24), 56.2);
});

test('吸附：离目标不到容差就贴上去，否则原样；多个目标取最近的', () => {
  assert.equal(snapFloor(55.7, [56], 0.5), 56);
  assert.equal(snapFloor(55.4, [56], 0.5), 55.4);
  assert.equal(snapFloor(50, [49.8, 50.3], 0.5), 49.8);
  assert.equal(snapFloor(50, [], 0.5), 50);
  assert.equal(snapFloor(50, [NaN, undefined], 0.5), 50);
  assert.equal(snapFloor(50, null, 0.5), 50);
});

test('键盘步进：一步 0.5 分、Shift 2 分，同样夹在相邻两档之间', () => {
  assert.equal(stepFloor('hard', 1, FL, { min: 0, max: 70 }), 56.5);
  assert.equal(stepFloor('hard', -1, FL, { min: 0, max: 70 }), 55.5);
  assert.equal(stepFloor('hard', 1, FL, { big: true, min: 0, max: 70 }), 58);
  assert.equal(stepFloor('hard', -1, FL, { big: true, min: 0, max: 70 }), 54);
  assert.equal(stepFloor('hard', 1, { ...FL, hard: 61.8 }, { min: 0, max: 70 }), 62, '撞到上一档就停');
  assert.equal(stepFloor('top', 1, { ...FL, top: 69.8 }, { big: true, min: 0, max: 70 }), 70);
});

test('线高出纵轴上限（判定线是绝对分，换个口径纵轴就矮了）：碰一下不会被拽回纵轴上限', () => {
  // 订阅口径下把「最难」调到 57；切到候选最高 45 的口径，纵轴上限 50
  const fl = { top: 57, hard: 40, normal: 30, light: 20 }, axis = { min: 0, max: 50 };
  // 键盘：↓ 从原值往下走一步，↑ 不动（修之前两个方向都落到 50）
  assert.equal(stepFloor('top', -1, fl, axis), 56.5);
  assert.equal(stepFloor('top', 1, fl, axis), 57);
  assert.equal(stepFloor('top', -1, fl, { ...axis, big: true }), 55);
  assert.equal(stepFloor('top', 1, fl, { ...axis, big: true }), 57);
  // 走回纵轴里面之后照常：上限就是纵轴上限
  assert.equal(stepFloor('top', 1, { ...fl, top: 49.8 }, axis), 50);
  // 拖动：起手的偏移按线的真实位置算、夹取时带上起手的值（from）——手指挪 3px，值就从 57 挪 3px 的量
  const dom = { L0: -2, L1: 1, Y0: 0, Y1: 50 }, box = { l: 80, t: 30, w: 600, h: 338 };
  const y0 = 30;                                   // 线夹在图顶上画，手指按在这儿
  const grab = y0 - yOf(57, dom, box);             // 真实位置在图顶之上
  const dragTo = (y) => clampFloor('top', scoreAt(y - grab, dom, box), fl, { min: dom.Y0, max: dom.Y1, from: 57 });
  assert.equal(dragTo(y0 + 3), roundFloor(57 - 3 * scorePerPx(dom, box)));
  assert.equal(dragTo(y0 + 3), 56.6);
  assert.equal(dragTo(y0 - 3), 57, '往上拖不动，也不掉下来');
  assert.equal(dragTo(y0), 57, '拖回起点 = 原值');
  assert.equal(dragTo(y0 + 60), roundFloor(57 - 60 * scorePerPx(dom, box)), '拖进纵轴里面之后照样跟手');
  assert.equal(dragTo(y0 + 60), 48.1);
  // 不带 from 就是老行为：一律夹进 [min, max]
  assert.equal(clampFloor('top', 57, fl, axis), 50);
  assert.deepEqual(floorBounds('top', fl, axis), { lo: 40.5, hi: 50 });
  assert.deepEqual(floorBounds('top', fl, { ...axis, from: 57 }), { lo: 40.5, hi: 57 });
  // 相邻两档的约束照旧管着：from 只放宽纵轴那一头
  assert.equal(clampFloor('hard', 99, fl, { ...axis, from: 40 }), 50);
  assert.equal(clampFloor('hard', 99, { ...fl, top: 45 }, { ...axis, from: 40 }), 44.5);
  // 夹完仍然守序
  assert.ok(floorsOrdered({ ...fl, top: stepFloor('top', -1, fl, axis) }));
});

test('守序判断：top ≥ hard ≥ normal ≥ light，缺的档跳过', () => {
  assert.equal(floorsOrdered(FL), true);
  assert.equal(floorsOrdered({ top: 50, hard: 50, normal: 50, light: 50 }), true, '相等算守序（服务端也是 ≥）');
  assert.equal(floorsOrdered({ ...FL, normal: 57 }), false);
  assert.equal(floorsOrdered({ top: 40, light: 41 }), false);
  assert.equal(floorsOrdered({ top: 40, hard: null, light: 10 }), true);
  assert.equal(floorsOrdered({}), true);
});

const LIST = [
  { ii: 64.6, cost: 2.4 },    // 0 最强最贵
  { ii: 59.1, cost: 1.24 },   // 1
  { ii: 59.1, cost: 0.9 },    // 2 同分更便宜
  { ii: 52.0, cost: 0.9 },    // 3 同价更低分
  { ii: 41.0, cost: 0.2 },    // 4
  { ii: 30.0, cost: 0.015 },  // 5 最便宜
];

test('落点：线以上最便宜的；同价取更贴近线的；够不着 → 最强的那个并标 short（和服务端同一条规则）', () => {
  assert.deepEqual(pickForFloor(LIST, 25), { index: 5, short: false });
  assert.deepEqual(pickForFloor(LIST, 30), { index: 5, short: false }, '正好压在线上算够得着');
  assert.deepEqual(pickForFloor(LIST, 30.1), { index: 4, short: false });
  assert.deepEqual(pickForFloor(LIST, 45), { index: 3, short: false }, '同价 0.9：取分低（更贴近线）的');
  assert.deepEqual(pickForFloor(LIST, 55), { index: 2, short: false });
  assert.deepEqual(pickForFloor(LIST, 60), { index: 0, short: false });
  assert.deepEqual(pickForFloor(LIST, 70), { index: 0, short: true });
  assert.deepEqual(pickForFloor([{ ii: 50, cost: 2 }, { ii: 50, cost: 1 }], 80), { index: 1, short: true }, '够不着时并列最高分取便宜的');
  assert.equal(pickForFloor([], 10), null);
  assert.equal(pickForFloor([{ ii: NaN, cost: 1 }, null], 10), null);
});

test('落点 · 没有价格的候选（成本 0）：和服务端现行的 ladderOf 一样照常参与——它最便宜，够得着的档都落到它', () => {
  // 服务端哪天把「没有价格」的排除出图谱选档，这里要跟着改（两边必须同一条规则，拖动中的本地预估才和松手后的结果对得上）
  const list = [{ ii: 6.2, cost: 0 }, { ii: 30, cost: 0.015 }, { ii: 59.1, cost: 1.24 }];
  assert.deepEqual(pickForFloor(list, 5), { index: 0, short: false });
  assert.deepEqual(pickForFloor(list, 6.3), { index: 1, short: false });
  assert.deepEqual(pickForFloor([{ ii: 6.2, cost: 0 }], 20), { index: 0, short: true });
  assert.deepEqual(frontier(list), [1, 2], '前沿不算它：对数轴上没有位置，阶梯从第一个有价格的点起');
});

const CANDS = [
  { model: 'opus', effort: 'max', ii: 59.1, cost: 1.24 },
  { model: 'opus', effort: 'xhigh', ii: 57.4, cost: 0.747 },
  { model: 'opus', effort: 'high', ii: 51.7, cost: 0.433 },
  { model: 'haiku', effort: 'high', ii: 30, cost: 0.0149 },
  { model: 'custom:co:command-a-plus', effort: '', ii: 6.2, cost: 0 },
];

test('落点落在哪个点：候选里有这一格 → 那个点', () => {
  const { spots, ghosts } = locatePicks(CANDS, [{ model: 'opus', effort: 'max' }, { model: 'haiku', effort: 'high', ii: 30, cost: 0.0149 }, null]);
  assert.deepEqual(spots, [{ at: 0, ghost: -1, lent: false }, { at: 3, ghost: -1, lent: false }, { at: -1, ghost: -1, lent: false }]);
  assert.deepEqual(ghosts, []);
  // effort 的 '' / undefined / null 是一回事
  assert.equal(locatePicks(CANDS, [{ model: 'custom:co:command-a-plus' }]).spots[0].at, 4);
  assert.equal(locatePicks(CANDS, [{ model: 'custom:co:command-a-plus', effort: null }]).spots[0].at, 4);
  assert.deepEqual(locatePicks(CANDS, []).spots, []);
  assert.deepEqual(locatePicks(null, null), { spots: [], ghosts: [] });
});

test('落点落在哪个点 · 档位自定义落在没评分的推理强度上（服务端借了相近一档的分数与成本）', () => {
  // 最难档指定 opus + 不指定推理强度：候选里没有这一格，服务端按 high 估 → pick 带着 high 那一格的 ii / cost
  const est = { model: 'opus', effort: '', ii: 51.7, cost: 0.433, est: true };
  const a = locatePicks(CANDS, [est]);
  assert.deepEqual(a.spots, [{ at: 2, ghost: -1, lent: true }], '环套在被借的那个点上（opus · high），不另补一个重叠的虚点');
  assert.deepEqual(a.ghosts, []);
  // 被借的那个点同时是另一档的图谱落点：两档指向同一个点（环叠着画、签并排）
  const b = locatePicks(CANDS, [est, { model: 'opus', effort: 'high' }]);
  assert.equal(b.spots[0].at, 2);
  assert.equal(b.spots[1].at, 2);
  assert.equal(b.spots[0].lent, true);
  assert.equal(b.spots[1].lent, false);
  // 分数 / 成本在同模型的点里对不上（候选和落点不是同一批数据）→ 补一个虚点；两档指定同一格只补一个
  const odd = { model: 'opus', effort: 'minimal', ii: 44, cost: 0.2 };
  const c = locatePicks(CANDS, [odd, { ...odd }, { model: 'sonnet', effort: '', ii: 51.7, cost: 0.433 }]);
  assert.deepEqual(c.spots, [{ at: -1, ghost: 0, lent: false }, { at: -1, ghost: 0, lent: false }, { at: -1, ghost: 1, lent: false }]);
  assert.equal(c.ghosts.length, 2);
  assert.equal(c.ghosts[0], odd, '虚点就是那个 pick');
  assert.equal(c.ghosts[1].model, 'sonnet', '别的模型恰好同分同价不算借的');
  // 没有价格的模型上的自定义：成本 0 / 缺失彼此算相同
  assert.deepEqual(locatePicks(CANDS, [{ model: 'custom:co:command-a-plus', effort: 'high', ii: 6.2, cost: 0 }]).spots, [{ at: 4, ghost: -1, lent: true }]);
  assert.deepEqual(locatePicks(CANDS, [{ model: 'custom:co:command-a-plus', effort: 'high', ii: 6.2 }]).spots, [{ at: 4, ghost: -1, lent: true }]);
});

test('落点落在哪个点 · 调用方只给了 model / effort（没带分数）：对不上就不画环，不报错', () => {
  const r = locatePicks(CANDS, [{ model: 'opus', effort: '' }, { model: 'opus', effort: '', ii: NaN, cost: undefined }, { model: '没有这个模型', effort: 'high' }]);
  assert.deepEqual(r.spots, [{ at: -1, ghost: -1, lent: false }, { at: -1, ghost: -1, lent: false }, { at: -1, ghost: -1, lent: false }]);
  assert.deepEqual(r.ghosts, []);
});

test('落点一定在前沿上：线怎么拖，选中的都是阶梯上的点', () => {
  const front = new Set(frontier(LIST));
  for (let f = 0; f <= 64.6; f += 0.7) {
    const hit = pickForFloor(LIST, f);
    assert.ok(front.has(hit.index) || LIST.some((c, i) => front.has(i) && c.cost === LIST[hit.index].cost), `floor=${f} → #${hit.index}`);
  }
});

test('前沿：按成本升序、智力分创新高的留下；同价只有最高分的那个可能上榜', () => {
  assert.deepEqual(frontier(LIST), [5, 4, 2, 0]);
  assert.deepEqual(frontier([{ cost: 1, ii: 50 }, { cost: 2, ii: 40 }, { cost: 3, ii: 50 }]), [0], '更贵却不更强的不上榜（分数相同也不算创新高）');
  assert.deepEqual(frontier([{ cost: 0, ii: 99 }, { cost: 1, ii: NaN }, null, { cost: 1, ii: 10 }]), [3], '没位置的点不参与');
  assert.deepEqual(frontier([]), []);
});

test('阶梯：横着走到下一个点的成本再竖着上去，最后一段拉到图版右缘', () => {
  assert.deepEqual(stairPath([[10, 300], [50, 200], [90, 120]], 400), [[10, 300], [50, 300], [50, 200], [90, 200], [90, 120], [400, 120]]);
  assert.deepEqual(stairPath([[10, 300]], 400), [[10, 300], [400, 300]]);
  assert.deepEqual(stairPath([], 400), []);
});

test('最近的点：超过命中半径不算', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 100, y: 100 }];
  assert.equal(nearestIndex(pts, 7, 1, 24), 1);
  assert.equal(nearestIndex(pts, 60, 60, 24), -1);
  assert.equal(nearestIndex([], 0, 0, 24), -1);
});

test('手柄散开：隔得开的不动；挤在一起的围着重心均匀散开；整体不出上下界；顺序不变', () => {
  assert.deepEqual(spreadLabels([40, 100, 200, 300], 24, 30, 360), [40, 100, 200, 300]);
  // 两个挤在一起：各让一半
  assert.deepEqual(spreadLabels([100, 104], 24, 30, 360), [90, 114]);
  // 四个挤成一团：等距排开、重心不动
  const four = spreadLabels([100, 102, 104, 106], 24, 30, 360);
  for (let i = 1; i < 4; i++) near(four[i] - four[i - 1], 24);
  near((four[0] + four[3]) / 2, 103);
  // 顶到上沿 / 下沿：整体往里收
  assert.deepEqual(spreadLabels([30, 31], 24, 30, 360), [30, 54]);
  assert.deepEqual(spreadLabels([359, 360], 24, 30, 360), [336, 360]);
  // 锚点没排好序也行：返回的位置与输入同序
  const mixed = spreadLabels([200, 100, 104], 24, 30, 360);
  assert.deepEqual(mixed, [200, 90, 114]);
  assert.deepEqual(spreadLabels([], 24, 0, 100), []);
});

test('手柄散开 · 钉住一个：正在拖的那条留在自己的线上，别的给它让路', () => {
  const out = spreadLabels([100, 104, 200], 24, 30, 360, 1);
  assert.equal(out[1], 104, '钉住的不动');
  assert.ok(out[0] <= 104 - 24 && out[2] === 200);
  const up = spreadLabels([100, 104, 108], 24, 30, 360, 0);
  assert.deepEqual(up, [100, 124, 148]);
  const down = spreadLabels([100, 104, 108], 24, 30, 360, 2);
  assert.deepEqual(down, [60, 84, 108]);
});

const BOUNDS = { x0: 0, x1: 400, y0: 0, y1: 300 };

test('标注避让：先试右边；右边被占 / 出界换下一个位置；放不下的非必放项不放', () => {
  const one = placeLabels([{ x: 100, y: 100, r: 6, w: 60, h: 14 }], { bounds: BOUNDS });
  assert.deepEqual(one, [{ x: 110, y: 93, far: false }]);
  // 右边有个障碍 → 左边
  const left = placeLabels([{ x: 100, y: 100, r: 6, w: 60, h: 14 }], { bounds: BOUNDS, obstacles: [{ x0: 108, x1: 180, y0: 90, y1: 110 }] });
  assert.deepEqual(left, [{ x: 30, y: 93, far: false }]);
  // 贴着右缘 → 左边
  const edge = placeLabels([{ x: 380, y: 100, r: 6, w: 60, h: 14 }], { bounds: BOUNDS });
  assert.equal(edge[0].x, 380 - 6 - 4 - 60);
  // 两个标注不互相压
  const two = placeLabels([{ x: 100, y: 100, r: 6, w: 60, h: 14 }, { x: 104, y: 102, r: 6, w: 60, h: 14 }], { bounds: BOUNDS });
  const [a, b] = two;
  assert.ok(a && b);
  assert.ok(a.x + 60 < b.x || b.x + 60 < a.x || a.y + 14 <= b.y || b.y + 14 <= a.y, '两个框不相交');
  // 四面都是障碍：非必放 → null
  const none = placeLabels([{ x: 100, y: 100, r: 6, w: 60, h: 14 }], { bounds: BOUNDS, obstacles: [{ x0: 0, x1: 400, y0: 0, y1: 300 }] });
  assert.deepEqual(none, [null]);
});

test('标注避让 · 必放项：没有空位也给一个界内的位置；离点远的标 far（画引线）', () => {
  const must = placeLabels([{ x: 100, y: 100, r: 6, w: 60, h: 14, must: true }], { bounds: BOUNDS, obstacles: [{ x0: 0, x1: 400, y0: 0, y1: 300 }] });
  assert.ok(must[0]);
  assert.ok(must[0].x >= 0 && must[0].x + 60 <= 400 && must[0].y >= 0 && must[0].y + 14 <= 300);
  // 近处两圈都被一条横线和一个点占着：必放项多试两圈，落到远处的空位上（非必放项到第三圈为止就放弃）
  const band = [{ x0: 0, x1: 400, y0: 96, y1: 104 }, { x0: 0, x1: 400, y0: 60, y1: 92 }, { x0: 0, x1: 400, y0: 108, y1: 140 }];
  assert.deepEqual(placeLabels([{ x: 200, y: 100, r: 6, w: 60, h: 14 }], { bounds: BOUNDS, obstacles: band }), [null]);
  const reach = placeLabels([{ x: 200, y: 100, r: 6, w: 60, h: 14, must: true }], { bounds: BOUNDS, obstacles: band });
  assert.ok(reach[0].y + 14 < 60 || reach[0].y > 140, '落在两条带子之外');
  assert.equal(reach[0].far, true);
  // 哪儿都有东西：挑压得最少的——右边整个被占、左边只蹭到一个小角 → 左边
  const least = placeLabels([{ x: 200, y: 100, r: 6, w: 60, h: 14, must: true }], { bounds: { x0: 100, x1: 300, y0: 90, y1: 110 },
    obstacles: [{ x0: 205, x1: 300, y0: 80, y1: 120 }, { x0: 100, x1: 135, y0: 92, y1: 94 }] });
  assert.equal(least[0].x, 200 - 6 - 4 - 60);
  // 图版比标注还窄：硬塞进界内的左上
  const tiny = placeLabels([{ x: 10, y: 5, r: 6, w: 60, h: 14, must: true }], { bounds: { x0: 0, x1: 50, y0: 0, y1: 12 } });
  assert.ok(tiny[0] && tiny[0].x >= 0 && tiny[0].y >= 0);
  // 近处全被占，只能放到第二圈：标 far
  const far = placeLabels([{ x: 200, y: 150, r: 6, w: 40, h: 14 }], { bounds: BOUNDS, obstacles: [{ x0: 150, x1: 252, y0: 128, y1: 172 }] });
  assert.ok(far[0] && far[0].far === true);
});

// 点心到标注框的距离（框 = 左上角 q、宽 w、高 h）
const reachOf = (q, it, p) => Math.hypot(Math.min(Math.max(p.x, q.x), q.x + it.w) - p.x, Math.min(Math.max(p.y, q.y), q.y + it.h) - p.y);

test('标注避让 · 贴身排法（窄屏的档名签只剩一个字）：每个签挨着自己的点，离别的落点和别的签都更远', () => {
  // 手机 375 宽上的真实局面：「最难」「难」两个落点只隔 20px，上下各有一条判定线
  const bounds = { x0: 74, x1: 365, y0: 30, y1: 292 };
  const A = { id: 'top', x: 304.78, y: 71.11, r: 10, w: 21, h: 16, must: true }, B = { id: 'hard', x: 285.4, y: 77.52, r: 10, w: 21, h: 16, must: true };
  const ringOf = (it, extra) => ({ x0: it.x - 11, x1: it.x + 11, y0: it.y - 11, y1: it.y + 11, ...extra });
  const lines = [76.77, 88.83].map((y) => ({ x0: 72, x1: 367, y0: y - 2.5, y1: y + 2.5 }));
  // 旁边的普通点，和经过这两个落点的那段阶梯（组件里沿折线每 6px 放一个小方块）
  const rest = [[303.84, 89.59], [269.97, 105.81], [264.54, 99.02]].map(([x, y]) => ({ x0: x - 6, x1: x + 6, y0: y - 6, y1: y + 6 }));
  const path = [[264.54, 99.02], [285.4, 99.02], [285.4, 77.52], [304.78, 77.52], [304.78, 71.11], [367, 71.11]];
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i], [bx, by] = path[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 6));
    for (let j = 0; j <= n; j++) { const x = ax + ((bx - ax) * j) / n, y = ay + ((by - ay) * j) / n; rest.push({ x0: x - 2, x1: x + 2, y0: y - 2, y1: y + 2 }); }
  }
  rest.push(...lines);
  // 老排法：「难」的签被排到「最难」那个点的右边，离别人的点比离自己的点近——两个签分不清各指哪个
  const old = placeLabels([A, B], { bounds, obstacles: [ringOf(A), ringOf(B), ...rest] });
  assert.equal(old[1].far, true);
  assert.ok(reachOf(old[1], B, A) < reachOf(old[1], B, B), '老排法的问题：难的签挨着「最难」的点');
  // 贴身排法：各自挨着自己的点（不用引线），离别人的点、别人的签至少远出一截
  const snug = placeLabels([A, B], { bounds, obstacles: [ringOf(A, { of: 'top', pad: 6 }), ringOf(B, { of: 'hard', pad: 6 }), ...rest], gap: 2, clear: 6 });
  const items = [A, B];
  snug.forEach((q, i) => {
    const me = items[i], other = items[1 - i], oq = snug[1 - i];
    assert.equal(q.far, false, me.id + ' 贴着自己的点');
    assert.ok(reachOf(q, me, me) <= me.r + 3 + 1e-9, me.id + ' 离自己的点只有 gap（正上 / 正下多 1px）');
    assert.ok(reachOf(q, me, other) >= other.r + 6, me.id + ' 离别人的点远');
    // 两个签的框之间至少隔 clear
    const dx = Math.max(0, Math.max(q.x, oq.x) - Math.min(q.x + me.w, oq.x + other.w)), dy = Math.max(0, Math.max(q.y, oq.y) - Math.min(q.y + me.h, oq.y + other.h));
    assert.ok(Math.hypot(dx, dy) >= 6, '两个签不挨着');
    // 也没压着判定线
    assert.ok(lines.every((l) => q.y + me.h < l.y0 || q.y > l.y1), me.id + ' 不压线');
  });
  // 斜角的位置：签的一个角抵在离点心 r + gap 的地方
  assert.deepEqual(snug[0], { x: A.x - 10.5, y: A.y - 10 - 3 - 16, far: false }, '「最难」放正上方');
  near(snug[1].x, B.x - 12 * Math.SQRT1_2 - 21);
  near(snug[1].y, B.y - 12 * Math.SQRT1_2 - 16);
});

test('标注避让 · 贴身排法：只能放远处时，引线不许从别的落点身上穿过去', () => {
  const bounds = { x0: 0, x1: 400, y0: 0, y1: 300 };
  const B = { id: 'hard', x: 100, y: 100, r: 10, w: 21, h: 16, must: true };
  // 左半边整个被占（左、上、下都放不了），右边 40px 处是另一档的落点
  const wall = { x0: 0, x1: 99, y0: 0, y1: 300 };
  const other = { x0: 129, x1: 151, y0: 89, y1: 111, of: 'top', pad: 6 };
  const mine = { x0: 89, x1: 111, y0: 89, y1: 111, of: 'hard', pad: 6 };
  const [q] = placeLabels([B], { bounds, obstacles: [mine, other, wall], gap: 2, clear: 6 });
  assert.equal(q.far, true);
  // 第一个空位在别的落点右上方（x = 156），但从点拉过去的引线正好穿过那个落点：跳过，取下一个引线干净的位置
  assert.notEqual(q.x, 156);
  assert.deepEqual(q, { x: 172, y: 56, far: true });
  // 不是贴身排法（没给 clear）时照旧取第一个空位
  const [plain] = placeLabels([B], { bounds, obstacles: [{ ...mine, of: undefined, pad: 0 }, { x0: 123, x1: 157, y0: 83, y1: 117 }, wall], gap: 2 });
  assert.equal(plain.x, 156);
});

test('标注避让 · 贴身排法只管必放的档名签：别的标注、不给 clear 的调用都和原来一样', () => {
  const one = { x: 100, y: 100, r: 6, w: 60, h: 14 };
  assert.deepEqual(placeLabels([one], { bounds: BOUNDS, clear: 6 }), placeLabels([one], { bounds: BOUNDS }));
  assert.deepEqual(placeLabels([one], { bounds: BOUNDS, gap: 4 }), [{ x: 110, y: 93, far: false }]);
  assert.deepEqual(placeLabels([one], { bounds: BOUNDS, gap: 2 }), [{ x: 108, y: 93, far: false }]);
});

test('提示框定位：右边 → 左边 → 手机竖屏放不下就夹在图内放到下方 / 上方', () => {
  assert.deepEqual(placeTip(100, 100, 180, 80, 800, 420), { x: 114, y: 60 });
  assert.deepEqual(placeTip(700, 100, 180, 80, 800, 420), { x: 700 - 180 - 14, y: 60 }, '右边放不下 → 左边');
  assert.deepEqual(placeTip(100, 10, 180, 80, 800, 420), { x: 114, y: 0 }, '竖向夹在容器里');
  assert.deepEqual(placeTip(100, 410, 180, 80, 800, 420), { x: 114, y: 340 });
  // 窄屏：左右都放不下
  assert.deepEqual(placeTip(170, 100, 220, 90, 340, 340), { x: 60, y: 118 }, '放到点的下方');
  assert.deepEqual(placeTip(170, 300, 220, 90, 340, 340), { x: 60, y: 300 - 18 - 90 }, '下方不够 → 上方');
  assert.deepEqual(placeTip(20, 60, 220, 90, 340, 340), { x: 34, y: 15 }, '靠左的点右边放得下');
  assert.equal(placeTip(330, 100, 220, 90, 340, 340).x, 330 - 220 - 14, '靠右的点左边放得下');
});

test('厂商：creator → 厂商键 → 槽位；订阅算 Anthropic、plan 跟着卖 plan 的那家、API 跟着模型厂商', () => {
  assert.equal(makerKey('Anthropic'), 'anthropic');
  assert.equal(makerKey('Google'), 'gemini');
  assert.equal(makerKey('Z AI'), 'zhipu');
  assert.equal(makerKey('SpaceXAI'), 'grok');
  assert.equal(makerKey('Thinking Machines'), 'tm');
  assert.equal(makerKey('Kimi'), 'kimi');
  assert.equal(makerKey('Xiaomi'), 'mimo');
  assert.equal(makerKey('LongCat'), 'other_cn');
  assert.equal(makerKey('Cohere'), 'other');
  assert.equal(makerKey(''), 'other');
  assert.equal(makerKey(undefined), 'other');
  assert.equal(vendorKeyOf({ basis: 'sub', creator: 'Anthropic' }), 'anthropic');
  assert.equal(vendorKeyOf({ basis: 'plan', vkey: 'tp_volcengine', creator: 'DeepSeek' }), 'tp_volcengine');
  assert.equal(vendorKeyOf({ basis: 'plan', creator: 'Kimi' }), 'kimi', 'plan 口径却没带 vkey：退回模型厂商');
  assert.equal(vendorKeyOf({ basis: 'api', creator: 'DeepSeek' }), 'deepseek');
  assert.equal(vendorKeyOf(null), 'other');
  assert.equal(vendorSlot('anthropic'), 's2');
  assert.equal(vendorSlot('deepseek'), 's6');
  assert.equal(vendorSlot('other'), 'muted');
  assert.equal(vendorSlot('没见过'), 'muted');
  // 槽位表两套色各八个，表里用到的槽位都有色值
  for (const mode of ['light', 'dark']) assert.equal(Object.keys(VENDOR_SLOTS[mode]).length, 8);
  for (const slot of Object.values(VCOLOR)) assert.ok(slot === 'muted' || VENDOR_SLOTS.light[slot], slot);
  assert.equal(VENDOR_SLOTS.light.s2, '#eb6834');
  assert.equal(VENDOR_SLOTS.dark.s7, '#9085e9');
});

test('形状：海外圆、国内菱形、第三方平台方；有图谱的厂商表就听它的', () => {
  assert.equal(shapeKind('anthropic'), 'circle');
  assert.equal(shapeKind('deepseek'), 'diamond');
  assert.equal(shapeKind('tp_volcengine'), 'square');
  assert.equal(shapeKind('other_cn'), 'diamond');
  assert.equal(shapeKind('新来的', { cn: true, tp: false }), 'diamond');
  assert.equal(shapeKind('zhipu', { cn: false, tp: true }), 'square', '图谱说它是第三方平台');
  assert.equal(shapePath('circle', 6), 'M-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0');
  assert.equal(shapePath('diamond', 4, 10, 20), 'M10 15L15 20L10 25L5 20Z');
  assert.equal(shapePath('square', 10, 100, 100), 'M91 91h18v18h-18Z');
  // 多段拼成一条 path：每段都以绝对的 M 起头
  assert.match(shapePath('circle', 3, 5, 5) + shapePath('circle', 3, 9, 9), /^M2 5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M6 9a/);
});

test('全图的点：一行数组 → 对象', () => {
  assert.deepEqual(decodePoint(['anthropic', 'Claude Max', 'claude-opus-5-5', 'Claude Opus 5.5', 'max', 59.11, 1.25875, 'plan']),
    { vkey: 'anthropic', plan: 'Claude Max', slug: 'claude-opus-5-5', family: 'Claude Opus 5.5', effort: 'max', score: 59.11, cost: 1.25875, src: 'plan' });
  assert.equal(decodePoint(null).vkey, undefined);
});
