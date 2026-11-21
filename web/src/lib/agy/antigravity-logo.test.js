import test from 'node:test';
import assert from 'node:assert/strict';
import './antigravity-logo.js';

const Logo = globalThis.AntigravityLogo;

test('antigravity-logo 使用单一 <mask> 隔离抗锯齿，杜绝多层 <clipPath> 黑边锯齿与 foreignObject', () => {
  assert.ok(Logo && typeof Logo.renderSVG === 'function');
  for (const state of Logo.states) {
    const svg = Logo.renderSVG(state, 0.35, { size: 52, ambientSec: 3.2 });
    assert.match(svg, /<mask id="[^"]+-mask"/, `${state} 应使用 SVG <mask>`);
    assert.match(svg, /mask="url\(#[^"]+-mask\)"/, `${state} 色云容器应挂载 mask`);
    assert.doesNotMatch(svg, /<clipPath/, `${state} 不应使用 <clipPath>（多层叠加会产生锯齿黑边）`);
    assert.doesNotMatch(svg, /<foreignObject/i, `${state} 不应使用 foreignObject`);
    assert.doesNotMatch(svg, /<feGaussianBlur/i, `${state} 默认不开启 glow 时不应包含 feGaussianBlur`);
    assert.match(svg, /shape-rendering="geometricPrecision"/, `${state} 应启用高精度曲线抗锯齿`);
  }
});

test('antigravity-logo 官方极光微流 ambient 态保持精确官方拱形且在官方四色锚点范围内平滑流动', () => {
  assert.ok(Logo.META.ambient && Logo.META.ambient.loop && Logo.META.ambient.continuous);
  const restSvg = Logo.renderSVG('static', 0, { size: 52 });
  const amb0Svg = Logo.renderSVG('ambient', 0, { size: 52, ambientSec: 0 });
  const amb4Svg = Logo.renderSVG('ambient', 0, { size: 52, ambientSec: 4.2 });

  const pathOf = (s) => s.match(/<path class="ag-mask-path"[^>]*d="([^"]+)"/)?.[1];
  const restPath = pathOf(restSvg);
  assert.ok(restPath && restPath.length > 80);
  // ambient 全程锁死精确官方拱形，不做轮廓变形
  assert.equal(pathOf(amb0Svg), restPath);
  assert.equal(pathOf(amb4Svg), restPath);
  // 流动前后内部极光云椭圆坐标确实变化
  assert.notEqual(amb0Svg, amb4Svg);

  // 核心蓝海层（g-blue）必须排在绿/金之后绘制，保证下半身与内拱腹忠于官方蓝色拓扑
  const idxEm = restSvg.indexOf('-g-em');
  const idxGold = restSvg.indexOf('-g-gold');
  const idxBlue = restSvg.indexOf('-g-blue');
  const idxIce = restSvg.indexOf('-g-ice');
  const idxRedTop = restSvg.indexOf('-g-redt');
  assert.ok(idxEm > 0 && idxGold > 0 && idxBlue > idxEm && idxBlue > idxGold, '蓝海云必须绘制在绿/金云之上');
  assert.ok(idxIce > idxBlue && idxRedTop > idxBlue, '冰蓝过渡与顶冠红必须绘制在蓝海云之上');
});

test('antigravity-logo 全态零四芒星、零表面白色扫光，且等待态严格端正无倾斜', () => {
  for (const state of Logo.states) {
    for (const t of [0.1, 0.35, 0.65, 0.9]) {
      const sc = Logo.computeScene(state, t, 'medium', 0, { phase: 'loop', ambientSec: t * 8 });
      for (const item of [...sc.under, ...sc.over]) {
        assert.notEqual(item.kind, 'star', `${state} 不应包含四芒星图元`);
      }
      assert.equal(sc.sheen, undefined, `${state} 不应输出表面白色扫光字段`);
    }
  }

  // waiting 全周期保持端正对称（顶峰居中 x ≈ 50）并带拱后同形极光柔影波
  for (const t of [0, 0.25, 0.5, 0.75]) {
    const sc = Logo.computeScene('waiting', t, 'medium', 0, { phase: 'loop' });
    assert.ok(Math.abs(sc.contour[0][0] - 50) < 0.8, `waiting t=${t} 拱顶应严格居中不偏斜`);
  }
  const waitMid = Logo.computeScene('waiting', 0.35, 'medium', 0, { phase: 'loop' });
  assert.ok(waitMid.under.some((it) => it.kind === 'fill'), 'waiting 应在拱后渲染同形柔影波');
});

test('antigravity-logo 桌面漫反射 glow 支持 hero 与 subtle 两档且无紧贴边散光滤镜', () => {
  const heroSvg = Logo.renderSVG('ambient', 0, { size: 52, glow: 'hero', ambientSec: 2 });
  const subtleSvg = Logo.renderSVG('thinking', 0.4, { size: 22, glow: 'subtle' });

  assert.match(heroSvg, /class="ag-glow-wide"/);
  assert.match(heroSvg, /class="ag-glow-desk"/);
  assert.match(subtleSvg, /class="ag-glow-wide"/);
  assert.doesNotMatch(subtleSvg, /class="ag-glow-desk"/);

  for (const svg of [heroSvg, subtleSvg]) {
    const sigmas = [...svg.matchAll(/stdDeviation="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.ok(sigmas.length >= 1);
    for (const s of sigmas) {
      assert.ok(s >= 16, `漫反射模糊半径 ${s} 过紧会产生散光白边`);
    }
  }
});

test('antigravity-logo 复合态切往其它运行态时直接液态转场，不绕回静态 A 拱', () => {
  const restContour = Logo.computeScene('static', 0, 'medium', 0, { phase: 'loop' }).contour;
  const maxDiff = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

  for (const [from, to] of [['editing', 'thinking'], ['searching', 'thinking'], ['editing', 'executing'], ['orbiting', 'writing']]) {
    const mid = Logo.computeScene(from, 0.5, 'medium', 0, { phase: 'loop' });
    const leaveEnd = Logo.computeScene(from, 0.999, 'medium', 0, {
      phase: 'leave',
      snap: { contour: mid.contour, lensState: mid.lensState, editState: mid.editState, phaseData: mid.phaseData },
      nextState: to,
    });
    assert.ok(maxDiff(leaveEnd.contour, restContour) > 3, `${from} → ${to} 离开尾帧不应回到静态 A 拱`);
  }
});

test('antigravity-logo 切后台 / 融合超时后切回 static 必落定官方拱形，不滞留在思考圆点', () => {
  const prevPerf = globalThis.performance;
  const prevDoc = globalThis.document;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancel = globalThis.cancelAnimationFrame;

  let fakeNow = 1000;
  let rafId = 0;
  let rafQueue = [];
  const mkEl = (tag) => {
    const el = {
      tagName: tag,
      attrs: {},
      style: {},
      children: [],
      classList: { add() {}, toggle() {} },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      hasAttribute(k) { return k in this.attrs; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      insertBefore(c) { c.parentNode = this; this.children.unshift(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      replaceChild(n, o) { const i = this.children.indexOf(o); if (i >= 0) this.children[i] = n; },
      addEventListener() {},
      removeEventListener() {},
      querySelector(sel) {
        if (sel === '.ag-mask-path') return el._mask || (el._mask = mkEl('path'));
        return mkEl('g');
      },
      set innerHTML(_v) {},
    };
    return el;
  };
  const tick = (ms) => {
    fakeNow += ms;
    const q = rafQueue.splice(0);
    for (const item of q) item.cb(fakeNow);
  };

  try {
    globalThis.performance = { now: () => fakeNow };
    globalThis.requestAnimationFrame = (cb) => { const id = ++rafId; rafQueue.push({ id, cb }); return id; };
    globalThis.cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter((x) => x.id !== id); };
    globalThis.document = { hidden: false, createElementNS: (_, t) => mkEl(t), addEventListener() {}, removeEventListener() {} };

    const staticD = Logo.computeScene('static', 0).bodyD;

    // 场景 1：思考液滴期间切后台后结束回到 static，必须直接落定官方拱形
    const ctl1 = Logo.mount(mkEl('span'), { state: 'thinking', glow: 'subtle' });
    for (let i = 0; i < 20; i++) tick(33);
    assert.notEqual(ctl1._el.maskPath.attrs.d, staticD);
    globalThis.document.hidden = true;
    ctl1.setState('static');
    assert.equal(ctl1._el.maskPath.attrs.d, staticD);
    ctl1.destroy();

    // 场景 2：可见态切回 static 启动融合后中途切后台超 356ms，再恢复可见必补画落定官方拱形
    globalThis.document.hidden = false;
    const ctl2 = Logo.mount(mkEl('span'), { state: 'thinking', glow: 'subtle' });
    for (let i = 0; i < 20; i++) tick(33);
    ctl2.setState('static');
    globalThis.document.hidden = true;
    rafQueue = [];
    fakeNow += 5000;
    globalThis.document.hidden = false;
    ctl2._syncLoop();
    assert.equal(ctl2._el.maskPath.attrs.d, staticD);
    assert.equal(ctl2._fromContour, null);
    ctl2.destroy();

    // 场景 3：thinking → success 播完后通过 onStateChange 通知回归 static，且轮廓等于官方拱形
    const states = [];
    const ctl3 = Logo.mount(mkEl('span'), {
      state: 'thinking',
      glow: 'subtle',
      onStateChange: (name) => states.push(name),
    });
    for (let i = 0; i < 20; i++) tick(33);
    ctl3.setState('success');
    for (let i = 0; i < 60; i++) tick(33);
    assert.equal(ctl3._playing, 'static');
    assert.equal(ctl3._el.maskPath.attrs.d, staticD);
    assert.equal(states[states.length - 1], 'static');
    ctl3.destroy();
  } finally {
    globalThis.performance = prevPerf;
    globalThis.document = prevDoc;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancel;
  }
});
