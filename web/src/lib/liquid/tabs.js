// Tab 栏液态指示器（Kyant0 LiquidBottomTabs.kt 的交互，套在 bridge 的 kit「Tab Bar - iPhone」底栏上）。
// Kyant：指示器（选中胶囊）可按住拖动，按下放大 78/56、拖动拉伸（速度 /10）、松手吸到最近的 Tab；点别的 Tab＝animateToValue
//       （按下 → 滑过去 → 到位松开，滑动途中指示器化成透镜）；整栏按下放大 1 + 16/宽、拖动跟手偏移 4·EaseOut（松手 spring(1, 300) 回 0）；
//       指示器底下透出「选中样式」那层内容（染强调色、按下放大 1→1.2），未选那层在指示器处挖洞；触摸光斑 spring(0.5, 300)。
// kit 没有 Tab 按下态：按下的指示器借 kit 开关 / 滑块按下态的同一套玻璃配方（lens.js 'indicator'）。
// 结构（调用方提供）：bar＝玻璃底栏（可以带自己的 backdrop / isolation）；pill＝选中垫片；rowU / rowS＝未选 / 选中两层内容
//   （同样的 Tab 排两遍，pointer-events: none）；glow＝光斑层；lensHost＝页面根（透镜挂在它上面、压在底栏之上——
//   挂在带 backdrop 或 z-index 的底栏里，透镜伸出栏外的那圈会采不到页面而发黑）。
import { Damped, Spring, register, wake, clamp, lerp, stretch, composeEaseOut } from './core.js';
import { PressedLens } from './lens.js';
import { haptic } from '../dragdrop.svelte.js';

const K = 78 / 56;   // Kyant pressedScale

const capsuleMask = (w, h) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><rect width="${w}" height="${h}" rx="${h / 2}"/></svg>`)}")`;
function setMask(node, MASK, x, y, w, h, hole) {
  const s = node.style;
  s.webkitMaskImage = s.maskImage = hole ? `${MASK}, linear-gradient(#000,#000)` : MASK;
  s.webkitMaskPosition = s.maskPosition = hole ? `${x.toFixed(2)}px ${y.toFixed(2)}px, 0 0` : `${x.toFixed(2)}px ${y.toFixed(2)}px`;
  s.webkitMaskSize = s.maskSize = hole ? `${w.toFixed(2)}px ${h.toFixed(2)}px, 100% 100%` : `${w.toFixed(2)}px ${h.toFixed(2)}px`;
  s.webkitMaskRepeat = s.maskRepeat = 'no-repeat';
  s.webkitMaskComposite = hole ? 'xor' : ''; s.maskComposite = hole ? 'exclude' : '';
}

export class LiquidTabs {
  // o = { bar, pill, rowU, rowS, glow, lensHost, count, index, tabW, pad, selH, dark, onSelect(i) }
  constructor(o) {
    this.o = o;
    this.N = o.count;
    this.index = o.index || 0;
    this.d = new Damped(this.index, Math.max(1, this.N - 1), [K, K]);
    this.offset = new Spring(0, 1, 300);
    this.glowS = new Spring(0, .5, 300);
    this.lens = new PressedLens(o.lensHost, 'indicator', [o.tabW * K, (o.selH || 54) * K], { solid: false, dark: !!o.dark, z: 31 });
    // 指示器形状的遮罩（按指示器自己的宽高比画胶囊，拉伸到实际尺寸时两端仍是半圆）
    this.mask = capsuleMask(Math.round(o.tabW), o.selH || 54);
    this.lastP = -1;
    this.org = [0, 0];
    this.measure();
    this.bind();
    this.off = register(this);
  }
  get W() { return this.o.bar.offsetWidth || 1; }
  geom() { const o = this.o; return { T: o.tabW, x0: o.pad ?? 4, H: o.bar.offsetHeight || 62, selH: o.selH || 54 }; }
  // 底栏在透镜宿主里的位置（布局坐标，去掉按下放大的变换）
  measure() {
    const b = this.o.bar, br = b.getBoundingClientRect(), hr = this.o.lensHost.getBoundingClientRect();
    this.org = [br.left - hr.left + (br.width - b.offsetWidth) / 2, br.top - hr.top + (br.height - b.offsetHeight) / 2];
  }
  setDark(dark) { this.lens.setDark(dark); wake(this); }
  setTabW(w) { if (w === this.o.tabW) return; this.o.tabW = w; this.mask = capsuleMask(Math.round(w), this.geom().selH); this.lens.destroy(); this.lens = new PressedLens(this.o.lensHost, 'indicator', [w * K, this.geom().selH * K], { solid: false, dark: !!this.o.dark, z: 31 }); this.lastP = -1; wake(this); }
  // 外部改了选中（调用方状态）：滑过去（Kyant animateToValue）
  setIndex(i) {
    if (this.drag) return;
    this.index = i;
    if (Math.abs(this.d.value.t - i) > 1e-4) { this.d.animateToValue(i); wake(this); }
  }
  select(i) {
    i = clamp(i, 0, this.N - 1);
    if (i !== this.index) haptic('tick');
    this.d.animateToValue(i); wake(this);
    if (i !== this.index) {
      const want = i;
      this.o.onSelect?.(i);
      // 调用方没切过去（拒绝了，比如本地不可用）：指示器滑回去
      setTimeout(() => { if (this.index !== want && !this.drag) { this.d.animateToValue(this.index); wake(this); } }, 320);
    }
  }
  bind() {
    const h = this.o.bar, d = this.d;
    this.onDown = (e) => {
      if (e.button || this.drag) return;
      this.measure();
      wake(this);
      const g = this.geom(), r = h.getBoundingClientRect();
      const x = (e.clientX - r.left) * h.offsetWidth / Math.max(1, r.width), y = (e.clientY - r.top) * h.offsetHeight / Math.max(1, r.height);
      const left = g.x0 + d.value.x * g.T + this.panelOffset();
      if (x >= left && x <= left + g.T && y >= 4 && y <= 4 + g.selH) {
        try { h.setPointerCapture(e.pointerId); } catch {}
        this.drag = { id: e.pointerId, x: e.clientX, x0: e.clientX, mode: 'drag', moved: false };
        d.doPress(); this.glowS.t = 1; this.glowX = x;
      } else {
        this.drag = { id: e.pointerId, x: e.clientX, x0: e.clientX, mode: 'tap', tab: clamp(Math.floor((x - g.x0) / g.T), 0, this.N - 1) };
      }
    };
    this.onMove = (e) => {
      const g0 = this.drag;
      if (!g0 || e.pointerId !== g0.id || g0.mode !== 'drag') return;
      const dx = e.clientX - g0.x; g0.x = e.clientX;
      if (Math.abs(e.clientX - g0.x0) > 4) g0.moved = true;
      d.updateValue(d.value.t + dx / this.geom().T);
      this.offset.x = this.offset.t = this.offset.x + dx; this.offset.v = 0;
      this.glowX = (this.glowX ?? 0) + dx;
      wake(this);
    };
    this.onUp = (e) => {
      const g0 = this.drag;
      if (!g0 || e.pointerId !== g0.id) return;
      this.drag = null;
      if (g0.mode === 'drag') {
        this.offset.t = 0; this.glowS.t = 0;
        if (e.type === 'pointercancel') { d.updateValue(this.index); d.doRelease(); }
        else this.select(Math.round(d.value.t));
        d.doRelease();
      } else if (e.type === 'pointerup' && Math.abs(e.clientX - g0.x0) < 10) this.select(g0.tab);
      wake(this);
    };
    h.addEventListener('pointerdown', this.onDown);
    h.addEventListener('pointermove', this.onMove);
    h.addEventListener('pointerup', this.onUp);
    h.addEventListener('pointercancel', this.onUp);
  }
  destroy() {
    const h = this.o.bar;
    h.removeEventListener('pointerdown', this.onDown); h.removeEventListener('pointermove', this.onMove);
    h.removeEventListener('pointerup', this.onUp); h.removeEventListener('pointercancel', this.onUp);
    this.off?.(); this.lens.destroy();
    for (const n of [h, this.o.pill, this.o.rowU, this.o.rowS, this.o.glow]) if (n) { n.style.transform = ''; n.style.maskImage = n.style.webkitMaskImage = ''; }
  }
  isIdle() { return this.d.idle && this.offset.idle && this.glowS.idle; }
  panelOffset() { const f = clamp(this.offset.x / Math.max(1, this.W), -1, 1); return 4 * Math.sign(f) * composeEaseOut(Math.abs(f)); }
  step(dt) { this.d.step(dt); this.offset.step(dt); this.glowS.step(dt); }
  render() {
    const o = this.o, g = this.geom(), d = this.d, W = this.W;
    const p = clamp(d.press.x, 0, 1), po = this.panelOffset(), value = d.value.x;
    const s = 1 + 16 / W * p;                                       // 整栏按下放大 1 + 16/宽
    const W2 = W / 2, H2 = g.H / 2;
    o.bar.style.transformOrigin = '50% 50%';
    o.bar.style.transform = p > 1e-4 || Math.abs(po) > .01 ? `translateX(${po.toFixed(3)}px) scale(${s.toFixed(5)})` : '';
    const [sx, sy] = stretch(d.sx.x, d.sy.x, d.vel.x / 10);
    // 指示器中心（底栏布局坐标，含跟手偏移，不含整栏放大）
    const cx = g.x0 + value * g.T + g.T / 2 + po, cy = H2;
    const iw = g.T * sx, ih = g.selH * sy;
    // 换到栏内（已被整栏变换）的局部坐标
    const lx = W2 + (cx - po - W2) / s, ly = H2 + (cy - H2) / s, lw = iw / s, lh = ih / s;
    if (o.pill) {
      o.pill.style.transform = `translate(${(lx - g.T / 2).toFixed(3)}px, ${(ly - g.selH / 2).toFixed(3)}px) scale(${(sx / s).toFixed(5)}, ${(sy / s).toFixed(5)})`;
      o.pill.style.opacity = (1 - p).toFixed(4);           // Kyant：指示器表面 alpha = 1 − 按下进度
    }
    if (o.rowU) setMask(o.rowU, this.mask, lx - lw / 2, ly - lh / 2, lw, lh, true);
    if (o.rowS) {
      setMask(o.rowS, this.mask, lx - lw / 2, ly - lh / 2, lw, lh, false);
      if (Math.abs(p - this.lastP) > 1e-4) {
        this.lastP = p;
        const ts = lerp(1, 1.2, p);   // Kyant：隐藏层的 Tab 按下放大 1 → 1.2
        for (const t of o.rowS.children) t.style.transform = p > 1e-4 ? `scale(${ts.toFixed(4)})` : '';
      }
    }
    // 触摸光斑（白 8% 平铺 + 白 15% 径向，Plus 混合；底栏自己是隔离组，只加在栏上）
    if (o.glow) {
      const gg = clamp(this.glowS.x, 0, 1.2);
      if (gg > 1e-3) {
        const r = g.H * 1.5, st = [];
        for (let k = 0; k <= 5; k++) { const t = k / 5, dist = r / 2 + t * r / 2, a = 1 - (3 * t * t - 2 * t * t * t); st.push(`rgba(255,255,255,${(.15 * gg * a).toFixed(4)}) ${dist.toFixed(1)}px`); }
        o.glow.style.background = `radial-gradient(circle at ${lx.toFixed(1)}px ${H2}px, ${st.join(', ')}), rgba(255,255,255,${(.08 * gg).toFixed(4)})`;
        o.glow.style.display = '';
      } else o.glow.style.display = 'none';
    }
    // 透镜：挂在页面根上，按底栏在根里的位置换算
    this.lens.render(this.org[0] + cx, this.org[1] + cy, sx / K, sy / K, p);
  }
}
