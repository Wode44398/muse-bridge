// 性价比图组件（PlanChart.svelte）脚本部分的接线——纯函数在 lib/dispatchChartMath.test.js 里测，这里测它们在组件里接得对不对：
//   · 拖判定线时哪些派生量不该跟着重算（全图的点、坐标轴、候选点的坐标、前沿；标注避让只在落点换了的时候重排）
//   · 档位自定义落在候选里没有的推理强度上：环套在哪、怎么叠；pick 没带分数时不报错
//   · 没有价格的候选有地方画，只有它一个时图不变成空态
//   · 判定线比所有候选都高时纵轴装得下它，键盘 / 拖动从原值起步
//   · 窄屏上每个档名签挨着自己的点
// 做法：把组件 <script> 里的真代码抽出来包成一个模块（$props() 换成可写的状态，模板要读的派生量由一个 effect 代读），
// 用 svelte 客户端运行时在 node 里跑；依赖换成桩，dispatchChartMath.js 用真文件、外面包一层调用计数。不起浏览器。
// 这是白盒测试：TAIL 里按名字读组件内部的变量——组件里改了这些名字或 $props() 那一句的写法，这里要跟着改。
//   node --test web/src/components/claude/dispatch/PlanChart.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', '..', '..');
const require = createRequire(join(webRoot, 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const href = (p) => pathToFileURL(p).href;
const SV = {
  'svelte': href(join(svelteRoot, 'src', 'index-client.js')),
  'svelte/internal/client': href(join(svelteRoot, 'src', 'internal', 'client', 'index.js')),
  'svelte/internal/disclose-version': href(join(svelteRoot, 'src', 'internal', 'disclose-version.js')),
  'svelte/internal/flags/legacy': href(join(svelteRoot, 'src', 'internal', 'flags', 'legacy.js')),
};
const fixImports = (code) => code.replace(/from\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, s) => (SV[s] ? `from '${SV[s]}'` : m));

// —— 浏览器里才有的几样：够脚本跑起来就行 ——
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.getComputedStyle = () => ({ fontFamily: 'sans-serif' });
globalThis.document = {
  fonts: null, body: {}, dispatchEvent() {}, addEventListener() {}, removeEventListener() {},
  // 量字宽：汉字按字号、其余按 0.56 个字号
  createElement: () => ({ getContext: () => ({ font: '11px x', measureText(s) { const size = parseFloat(this.font.split(' ')[1]) || 11; return { width: [...String(s)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? size : size * 0.56), 0) }; } }) }),
};

// —— 搭模块 ——
const dir = mkdtempSync(join(tmpdir(), 'plan-chart-test-'));
mkdirSync(join(dir, 'lib'));
mkdirSync(join(dir, 'components', 'claude', 'dispatch'), { recursive: true });
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
writeFileSync(join(dir, 'lib', 'state.svelte.js'), 'export const ui = { theme: "light" };');
writeFileSync(join(dir, 'lib', 'i18n.js'), [
  'const fill = (s, p) => String(s).replace(/\\{(\\w+)\\}/g, (m, k) => (p && k in p ? p[k] : m));',
  'export const t = (s, p) => fill(s, p); export const tr = (s) => s;',
].join('\n'));
// 动效一律当场落定（等同「减少动态效果」）
writeFileSync(join(dir, 'lib', 'motion.js'), [
  'export const DUR = { base: 240 }; export const SPRING = { crisp: {} };',
  'export const reduced = () => true; export const bezier = () => (k) => k;',
  'export function spring(o) { o.onUpdate?.(o.to, 0); o.onDone?.(); return { cancel() {}, alive: false }; }',
].join('\n'));
writeFileSync(join(dir, 'lib', 'dragdrop.svelte.js'), 'export const haptic = () => {};');
writeFileSync(join(dir, 'lib', 'dispatchPolicy.svelte.js'), [
  'export const TIER_META = [',
  "  { key: 'top', title: '最难', short: '最', color: 'var(--dp-t-top)' }, { key: 'hard', title: '难', short: '难', color: 'var(--dp-t-hard)' },",
  "  { key: 'normal', title: '常规', short: '常', color: 'var(--dp-t-normal)' }, { key: 'light', title: '机械', short: '机', color: 'var(--dp-t-light)' },",
  '];',
  "export const modelName = (m) => String(m || ''); export const effortName = (m, e) => (e ? String(e) : '默认');",
].join('\n'));
// 纯函数用真的，每个函数外面包一层计数：数得出哪些派生量被重算了
const mathFile = join(webRoot, 'src', 'lib', 'dispatchChartMath.js');
const M = await import(href(mathFile));
writeFileSync(join(dir, 'lib', 'dispatchChartMath.js'), [
  `import * as M from '${href(mathFile)}';`,
  'export const counts = {};',
  ...Object.keys(M).map((name) => (typeof M[name] === 'function'
    ? `export const ${name} = (...a) => { counts.${name} = (counts.${name} || 0) + 1; return M.${name}(...a); };`
    : `export const ${name} = M.${name};`)),
].join('\n'));

// 追加在组件脚本末尾（同一个作用域）：代模板把它读的派生量都读一遍，再把内部的函数和量交出来
const TAIL = `
  svgEl = { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };
  $effect(() => {
    void empty; void W; void H; void box.l; void narrow;
    for (const k of yt) void lineGeo.some((l) => Math.abs(at(l).py - k.y) < PILL_H / 2 + 5);
    void xt.major.length; void xt.minor.length; void all.paths.length; void (stair && stair.line);
    for (const l of lineGeo) { const p = at(l); void p.y; void p.py; void l.short; void l.adjusted; void l.floor; void (active === l.key); }
    for (const k of order) { const d = dots[k]; void (!!drag && drag.moved && d.ii < drag.val); void (!!hover && hover.k === k); void pickedSet.has(k); void frontSet.has(k); void (k === tabAt); }
    void rings.length; void layout.caps.length; void layout.labels.length; void legend.vendors.length; void tip;
  });
  api = {
    set: (p) => { __props = { ...__props, ...p }; },
    startDrag, moveDrag, endDrag, onHandleKey,
    get empty() { return empty; }, get view() { return view; }, get box() { return box; }, get dots() { return dots; }, get all() { return all; },
    get lineGeo() { return lineGeo; }, get rings() { return rings; }, get layout() { return layout; }, get narrow() { return narrow; },
  };
`;
{
  const { compileModule } = await import(href(join(svelteRoot, 'src', 'compiler', 'index.js')));
  let body = readFileSync(join(here, 'PlanChart.svelte'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const imports = [];
  body = body.replace(/^[ \t]*import\s[\s\S]*?from\s+'[^']+';[ \t]*\r?\n/gm, (m) => { imports.push(m.trim()); return ''; });
  const props = body.match(/let \{([\s\S]*?)\} = \$props\(\);/);
  assert.ok(props, 'PlanChart.svelte 里没找到 `let { … } = $props();` 那一句：这个测试要跟着改');
  const decl = props[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, def] = s.split('=').map((x) => x.trim());
    return `const ${name} = $derived(__props.${name} ?? ${def === undefined ? 'undefined' : def});`;
  }).join('\n');
  body = body.replace(props[0], decl).replace(/\$props\.id\(\)/, "'pc'");
  const code = `${imports.map((s) => (/from 'svelte';$/.test(s) ? "import { tick, untrack } from 'svelte'; const onDestroy = () => {};" : s)).join('\n')}
export function mount(initial) {
  let api;
  let __props = $state.raw(initial);
  const stop = $effect.root(() => {
${body}
${TAIL}
  });
  return { api, stop };
}
`;
  writeFileSync(join(dir, 'components', 'claude', 'dispatch', 'PlanChart.gen.svelte.js'),
    fixImports(compileModule(code, { filename: 'PlanChart.gen.svelte.js', generate: 'client' }).js.code));
}
const { mount } = await import(href(join(dir, 'components', 'claude', 'dispatch', 'PlanChart.gen.svelte.js')));
const { counts } = await import(href(join(dir, 'lib', 'dispatchChartMath.js')));
const { flushSync } = await import(SV.svelte);
const resetCounts = () => { for (const k of Object.keys(counts)) delete counts[k]; };
const n = (name) => counts[name] || 0;

// —— 数据 ——
const sub = (model, label, effort, ii, cost) => ({ model, label, effort, ii, cost, basis: 'sub', provider: 'Claude 订阅', creator: 'Anthropic' });
const CANDS = [
  sub('opus', 'Opus 5.5', 'max', 59.1, 1.24), sub('opus', 'Opus 5.5', 'xhigh', 57.4, 0.747), sub('opus', 'Opus 5.5', 'high', 51.7, 0.433),
  sub('opus', 'Opus 5.5', 'medium', 48.1, 0.31), sub('opus', 'Opus 5.5', 'low', 34.5, 0.128),
  sub('sonnet', 'Sonnet 5.5', 'max', 54.2, 1.21), sub('sonnet', 'Sonnet 5.5', 'xhigh', 49.9, 0.499), sub('sonnet', 'Sonnet 5.5', 'high', 41.5, 0.209),
  sub('sonnet', 'Sonnet 5.5', 'medium', 30.8, 0.103), sub('sonnet', 'Sonnet 5.5', 'low', 25.6, 0.0684),
  sub('haiku', 'Haiku 5.5', 'max', 36.2, 0.0378), sub('haiku', 'Haiku 5.5', 'xhigh', 34.3, 0.023), sub('haiku', 'Haiku 5.5', 'high', 29.6, 0.0149),
  sub('haiku', 'Haiku 5.5', 'medium', 24.6, 0.00891), sub('haiku', 'Haiku 5.5', 'low', 18.6, 0.00453),
  { model: 'custom:kimi:kimi-k3-1-pro', label: 'Kimi K3.1 Pro', effort: '', ii: 46.5, cost: 0.31, basis: 'plan', vkey: 'kimi', provider: 'Kimi Code', creator: 'Kimi' },
  { model: 'custom:ds:deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash', effort: 'max', ii: 32.5, cost: 4.04, basis: 'api', provider: 'DeepSeek', creator: 'DeepSeek' },
  { model: 'custom:zai:glm-5-3-flash', label: 'GLM-5.3-Flash', effort: '', ii: 27.8, cost: 0.052, basis: 'plan', vkey: 'zhipu', provider: 'GLM Coding', creator: 'Z AI' },
];
const CUSTOM = CANDS.filter((c) => c.basis !== 'sub').map((c) => (c.label === 'Kimi K3.1 Pro' ? { ...c, ii: 45 } : c));   // 自定义 API 口径：最高 45
const FREE = { model: 'custom:co:command-a-plus', label: 'Command A+', effort: '', ii: 6.2, cost: 0, basis: 'api', provider: 'Cohere', creator: 'Cohere' };
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_FRAC = { hard: 0.88, normal: 0.6, light: 0.4 };
/** 调用方给的 tiers（另一条线改完之后的形状：pick 带 ii / cost / label / basis / est）。规则同服务端的 ladderOf。 */
function ladder(cands, { floors = {}, overrides = {} } = {}) {
  const best = Math.max(...cands.map((c) => c.ii)), up = (x) => Math.ceil(x * 10 - 1e-6) / 10;
  return ['top', 'hard', 'normal', 'light'].map((key) => {
    const floorDefault = Math.max(0, up(key === 'top' ? best - 1.5 : best * DEFAULT_FRAC[key]));
    const floor = Number.isFinite(floors[key]) ? floors[key] : floorDefault;
    const hit = M.pickForFloor(cands, floor);
    let pick = cands[hit.index], short = hit.short, source = 'chart';
    const ov = overrides[key], same = ov ? cands.filter((c) => c.model === ov.model) : [];
    if (same.length) {
      const want = LEVELS.indexOf(ov.effort === '' ? 'high' : ov.effort), dist = (c) => Math.abs(LEVELS.indexOf(c.effort) - want);
      pick = same.find((c) => c.effort === ov.effort) || { ...same.reduce((a, b) => (dist(b) < dist(a) ? b : a)), effort: ov.effort, est: true };
      source = 'override'; short = false;
    }
    return { key, floor, floorDefault, source, short, pick: { model: pick.model, effort: pick.effort, ii: pick.ii, cost: pick.cost, label: pick.label, basis: pick.basis, est: !!pick.est } };
  });
}
function synthRows(count) {
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const vk = ['anthropic', 'openai', 'gemini', 'kimi', 'zhipu', 'deepseek', 'qwen', 'tp_cursor', 'tp_volcengine', 'minimax'];
  return Array.from({ length: count }, (_, i) => [vk[i % vk.length], 'Plan ' + (i % 7), 'slug-' + i, 'Family ' + (i % 90), ['low', 'high', 'max'][i % 3],
    +(5 + rnd() * 55).toFixed(2), +Math.pow(10, -2.2 + rnd() * 4).toPrecision(4), i % 3 ? 'plan' : 'api']);
}
/** 开一张图。host = 模拟调用方：onfloor 每来一次就按草稿重排四档、换一份新的 tiers（DispatchPolicy 的做法）。 */
function open(props, { host = null } = {}) {
  const log = [];
  let floors = { ...(host && host.floors) };
  const chart = mount({
    editable: true, width: 900, ...props,
    onfloor: (key, value, info) => {
      log.push([key, value, !!(info && info.final)]);
      if (!host) return;
      floors = { ...floors, [key]: value };
      chart.api.set({ tiers: ladder(host.cands, { floors, overrides: host.overrides }) });
    },
  });
  flushSync();
  return { api: chart.api, log, close: chart.stop };
}
const pointer = (y, type = 'touch') => ({ pointerType: type, button: 0, pointerId: 7, clientX: 20, clientY: y, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } });
const key = (k, shiftKey = false) => ({ key: k, shiftKey, preventDefault() {} });
const lineOf = (chart, k) => chart.api.lineGeo.find((l) => l.key === k);
const dotOf = (chart, model, effort) => chart.api.dots.find((d) => d.c.model === model && d.c.effort === effort);

test('拖判定线：全图的点、坐标轴、候选点的坐标、前沿都不跟着重算；标注避让只在落点换了的时候重排', () => {
  const rows = synthRows(2400);
  const chart = open({ candidates: CANDS, tiers: ladder(CANDS), allPoints: { points: rows, vendors: [] }, showAll: true }, { host: { cands: CANDS } });
  assert.equal(chart.api.all.pos.length, rows.length, '全图的点都画出来了');
  const y0 = lineOf(chart, 'light').y, from = lineOf(chart, 'light').floor;
  chart.api.startDrag(pointer(y0), lineOf(chart, 'light'), 'handle');
  chart.api.moveDrag(pointer(y0 + 5));   // 过了起步的阈值
  flushSync();
  resetCounts();
  const before = chart.log.length, seen = new Set();
  const STEPS = 80;
  for (let i = 1; i <= STEPS; i++) {
    chart.api.moveDrag(pointer(y0 + 5 + i * 1.4));
    // 拖动途中调用方的实时预览隔一阵回来一次：候选数组换了身份、内容没变
    if (i % 10 === 0) chart.api.set({ candidates: structuredClone(CANDS) });
    flushSync();
    seen.add(chart.api.rings.map((r) => r.key + '@' + r.x.toFixed(1) + ',' + r.y.toFixed(1)).join(' '));
  }
  const steps = chart.log.length - before;
  assert.ok(steps >= STEPS * 0.9, `线确实一步步在动（${steps} 步）`);
  assert.ok(lineOf(chart, 'light').floor < from - 15, '判定线跟着手走');
  assert.ok(seen.size >= 2, '途中落点换过（环跟着换）');
  // 与判定线无关的：一次都不重算
  assert.equal(n('shapePath'), 0, '全图的 path（修之前每步把两千多个点重拼一遍）');
  assert.equal(n('xTicks') + n('yTicks') + n('thinTicks'), 0, '坐标轴');
  assert.equal(n('frontier') + n('stairPath'), 0, '前沿与阶梯');
  assert.equal(n('plotBox'), 0, '图版');
  assert.equal(n('xOf'), 0, '点的横坐标');
  assert.equal(n('extentOf'), 0, '点的范围');
  // 标注避让：只在落点换了的时候重排，不是每步一次
  assert.ok(n('placeLabels') <= seen.size, `标注避让重排了 ${n('placeLabels')} 次（落点组合 ${seen.size} 种）`);
  // 跟着线走的那几样每步都在算
  assert.equal(n('spreadLabels'), steps);
  assert.ok(n('pickForFloor') >= steps);
  // 松手：按最终的线位把标注再排一次，final 回调一次
  resetCounts();
  chart.api.endDrag(pointer(y0 + 5 + STEPS * 1.4));
  flushSync();
  assert.equal(chart.log.filter((x) => x[2]).length, 1);
  assert.equal(n('placeLabels'), 1);
  assert.equal(n('shapePath'), 0);
  chart.close();
});

test('档位自定义落在候选里没有的推理强度上：虚线环套在被借的那个点上、和别的档叠着画；pick 没带分数时不画也不报错', () => {
  // 最难档指定 opus + 不指定推理强度（候选里只有 low…max），服务端借 high 那一格；难档的线拖到 51，图谱落点也是 opus · high
  const tiers = ladder(CANDS, { floors: { hard: 51 }, overrides: { top: { model: 'opus', effort: '' } } });
  assert.deepEqual(tiers[0].pick, { model: 'opus', effort: '', ii: 51.7, cost: 0.433, label: 'Opus 5.5', basis: 'sub', est: true });
  const chart = open({ candidates: CANDS, tiers });
  const spot = dotOf(chart, 'opus', 'high');
  assert.equal(chart.api.dots.length, CANDS.length, '不另补一个和它重叠的虚点');
  assert.equal(chart.api.rings.length, 4, '四档都有环');
  const top = chart.api.rings.find((r) => r.key === 'top'), hard = chart.api.rings.find((r) => r.key === 'hard');
  assert.deepEqual([top.x, top.y, top.override], [spot.x, spot.y, true], '最难：虚线环，套在 opus · high 上');
  assert.deepEqual([hard.x, hard.y, hard.override], [spot.x, spot.y, false]);
  assert.notEqual(top.r, hard.r, '两个环一里一外，不叠成一个');
  const cap = chart.api.layout.caps.find((c) => c.tags.some((tg) => tg.key === 'top'));
  assert.deepEqual(cap.tags.map((tg) => tg.name), ['最难', '难'], '签并排');
  assert.equal(cap.text, 'Opus 5.5 · high');
  // 只有借点的那一档在这个点上：签后面写它真正指定的那一格（不指定推理强度）
  chart.api.set({ tiers: ladder(CANDS, { overrides: { top: { model: 'opus', effort: '' } } }) });
  flushSync();
  const alone = chart.api.layout.caps.find((c) => c.tags.some((tg) => tg.key === 'top'));
  assert.deepEqual(alone.tags.map((tg) => tg.name), ['最难']);
  assert.equal(alone.text, 'Opus 5.5');
  assert.equal(chart.api.rings.length, 4);
  // pick 带的分数在同模型的点里对不上 → 在那个位置补一个虚点，环套在虚点上
  const odd = ladder(CANDS);
  odd[0] = { ...odd[0], source: 'override', short: false, pick: { model: 'opus', effort: 'minimal', ii: 44, cost: 0.2, label: 'Opus 5.5', est: true } };
  chart.api.set({ tiers: odd });
  flushSync();
  assert.equal(chart.api.dots.length, CANDS.length + 1);
  const ghost = chart.api.dots[CANDS.length], ring = chart.api.rings.find((r) => r.key === 'top');
  assert.equal(ghost.ghost, true);
  assert.deepEqual([ring.x, ring.y, ring.override], [ghost.x, ghost.y, true]);
  // 调用方还是老形状（pick 只有 model / effort）：这一档没处画环，别的照常，不报错
  chart.api.set({ tiers: tiers.map((x) => ({ ...x, pick: { model: x.pick.model, effort: x.pick.effort } })) });
  flushSync();
  assert.deepEqual(chart.api.rings.map((r) => r.key), ['hard', 'normal', 'light']);
  assert.equal(chart.api.dots.length, CANDS.length);
  chart.close();
});

test('没有价格的候选（成本 0）：贴着图版左缘画，被选成落点时环套得上；只有它一个候选时图不是空态', () => {
  const cands = [...CANDS, FREE];
  const chart = open({ candidates: cands, tiers: ladder(cands, { floors: { light: 5 } }) });
  const free = dotOf(chart, FREE.model, '');
  assert.ok(free, '有这个点');
  assert.equal(free.free, true);
  assert.ok(free.x > chart.api.box.l && free.x < chart.api.box.l + 12, '贴着左缘');
  assert.ok(chart.api.dots.every((d) => d === free || d.x > free.x), '别的点都在它右边');
  const ring = chart.api.rings.find((r) => r.key === 'light');
  assert.deepEqual([ring.x, ring.y], [free.x, free.y], '机械档落到它上面（它最便宜）');
  assert.equal(chart.api.rings.length, 4);
  // 只有它一个
  chart.api.set({ candidates: [FREE], tiers: ladder([FREE]) });
  flushSync();
  assert.equal(chart.api.empty, false, '不是「还没有性价比数据」');
  assert.equal(chart.api.dots.length, 1);
  assert.equal(chart.api.rings.length, 4);
  assert.ok(chart.api.view.Y1 >= 10 && chart.api.view.L1 > chart.api.view.L0);
  // 真的一个候选都没有：空态
  chart.api.set({ candidates: [], tiers: [] });
  flushSync();
  assert.equal(chart.api.empty, true);
  chart.close();
});

test('判定线比所有候选都高（判定线是绝对分，换了口径）：纵轴装得下它；键盘 / 拖动都从原值起步，不被拽回纵轴上限', () => {
  // 订阅口径下把「最难」调到 57；切到自定义 API 口径，候选最高 45
  const host = { cands: CUSTOM, floors: { top: 57 } };
  const chart = open({ candidates: CUSTOM, tiers: ladder(CUSTOM, host) }, { host });
  const { box, view } = chart.api;
  assert.equal(view.Y1, 60, '纵轴放到 60（只看候选的话是 50）');
  const top = lineOf(chart, 'top');
  assert.ok(top.y > box.t, '线在它真实的位置上，不是夹在图顶');
  assert.ok(Math.abs(top.y - M.yOf(57, view, box)) < 1e-9);
  // 键盘：↓ 一步 0.5，↑ 一步 0.5（修之前两个方向都落到 50）
  chart.api.onHandleKey(key('ArrowDown'), lineOf(chart, 'top'));
  flushSync();
  assert.deepEqual(chart.log.at(-1), ['top', 56.5, true]);
  chart.api.onHandleKey(key('ArrowUp'), lineOf(chart, 'top'));
  flushSync();
  assert.deepEqual(chart.log.at(-1), ['top', 57, true]);
  // 鼠标抓着线往下挪 3px：值从 57 走 3px 的量
  const y0 = lineOf(chart, 'top').y;
  chart.api.startDrag(pointer(y0, 'mouse'), lineOf(chart, 'top'), 'line');
  chart.api.moveDrag(pointer(y0 + 3, 'mouse'));
  flushSync();
  assert.deepEqual(chart.log.at(-1), ['top', M.roundFloor(57 - 3 * M.scorePerPx(view, box)), false]);
  assert.equal(chart.api.view.Y1, 60, '拖动中纵轴不动');
  // 拖到 48：拖动中纵轴不跟着缩（线才跟手）；松手后线不再比候选高，纵轴收回 50
  chart.api.moveDrag(pointer(M.yOf(48, view, box), 'mouse'));
  flushSync();
  assert.deepEqual(chart.log.at(-1), ['top', 48, false]);
  assert.equal(chart.api.view.Y1, 60);
  chart.api.endDrag(pointer(M.yOf(48, view, box), 'mouse'));
  flushSync();
  assert.deepEqual(chart.log.at(-1), ['top', 48, true]);
  assert.equal(chart.api.view.Y1, 50);
  assert.ok(Math.abs(lineOf(chart, 'top').y - M.yOf(48, chart.api.view, chart.api.box)) < 1e-9);
  chart.close();
});

test('窄屏（375 宽）：档名签收成一个字，每个签挨着自己的点、离别的落点更远', () => {
  const chart = open({ candidates: CANDS, tiers: ladder(CANDS), width: 375 });
  assert.equal(chart.api.narrow, true);
  const caps = chart.api.layout.caps;
  assert.deepEqual(caps.map((c) => c.tags.map((tg) => tg.name).join('')), ['最', '难', '常', '机']);
  const gapTo = (c, p) => Math.hypot(Math.min(Math.max(p.x, c.px), c.px + c.w) - p.x, Math.min(Math.max(p.y, c.py), c.py + c.h) - p.y);
  for (const c of caps) {
    const own = gapTo(c, c);
    for (const o of caps) if (o !== c) assert.ok(gapTo(c, o) > own + 4, `「${c.tags[0].name}」的签离自己的点 ${own.toFixed(1)}，离「${o.tags[0].name}」的点 ${gapTo(c, o).toFixed(1)}`);
    // 贴着点的不用引线；被挤到远处的有引线
    assert.equal(!!c.lead, own > c.r + 8);
  }
  // 「最难」「难」两个落点只隔 20px 上下：两个签都贴着各自的点
  assert.ok(caps.slice(0, 2).every((c) => !c.lead));
  chart.close();
});
