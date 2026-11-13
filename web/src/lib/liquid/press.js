// 液态玻璃按钮的按压手感（Svelte action）＝ Kyant0 LiquidButton.kt + InteractiveHighlight.kt 原参数：
//   按下进度 spring(0.5, 300) → 放大 1 + 4/高；手指拖动时按钮朝手指方向 tanh 跟随（初始斜率 0.05、上限＝短边）、
//   沿拖动方向拉长（最多 4/高）；按住时白 8% 平铺 + 白 15% 径向光斑（半径＝短边 1.5 倍，Plus 混合）。
// 用法：<button use:liquidPress> 或 use:liquidPress={{ glow: false }}。光斑是一个 mix-blend 子元素：按钮自己要是隔离组
//   （isolation: isolate，或本身带 backdrop-filter），Plus 才只加在按钮自己的玻璃上。
// 液滴菜单从按钮长出来时要「渐隐 / 撞一下」：pressOf(node).extra 叠一段额外变换（MorphMenu 经 GlassButton 登记的 triggers 用）。
import { Spring, register, wake, clamp } from './core.js';

const ctls = new WeakMap();
export const pressOf = (node) => ctls.get(node);

export function liquidPress(node, opt = {}) {
  let o = { glow: true, ...opt };
  let glow = null;
  const ctl = {
    p: new Spring(0, .5, 300), ox: new Spring(0, .5, 300), oy: new Spring(0, .5, 300),
    sx: 0, sy: 0, w: 44, h: 44, extra: '', lastT: null,
    step(dt) { this.p.step(dt); this.ox.step(dt); this.oy.step(dt); },
    isIdle() { return this.p.idle && this.ox.idle && this.oy.idle; },
    render() {
      const w = this.w, h = this.h, p = Math.max(0, this.p.x), minD = Math.min(w, h), maxD = Math.max(w, h);
      const ox = this.ox.x, oy = this.oy.x;
      let t = '';
      if (p > 1e-4 || Math.abs(ox) + Math.abs(oy) > .01) {
        const scale = 1 + 4 / h * p;
        const tx = minD * Math.tanh(.05 * ox / minD), ty = minD * Math.tanh(.05 * oy / minD);
        const ang = Math.atan2(oy, ox), md = 4 / h;
        const sx = scale + md * Math.abs(Math.cos(ang) * ox / maxD) * Math.min(w / h, 1);
        const sy = scale + md * Math.abs(Math.sin(ang) * oy / maxD) * Math.min(h / w, 1);
        t = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      }
      if (this.extra) t = t ? t + ' ' + this.extra : this.extra;
      if (t !== this.lastT) { this.lastT = t; node.style.transform = t; }
      if (glow) {
        if (p > 1e-3) {
          const r = minD * 1.5, px = clamp(this.sx + ox, 0, w), py = clamp(this.sy + oy, 0, h);
          glow.style.background = `radial-gradient(circle at ${px.toFixed(1)}px ${py.toFixed(1)}px, rgba(255,255,255,${(.15 * p).toFixed(3)}) ${(r / 2).toFixed(1)}px, rgba(255,255,255,0) ${r.toFixed(1)}px), rgba(255,255,255,${(.08 * p).toFixed(3)})`;
          glow.style.display = '';
        } else glow.style.display = 'none';
      }
    },
    setExtra(t) { this.extra = t || ''; this.render(); },
  };
  ctls.set(node, ctl);
  function mkGlow() {
    if (glow || !o.glow) return;
    glow = document.createElement('span');
    glow.className = 'lq-glow';
    glow.setAttribute('aria-hidden', 'true');
    Object.assign(glow.style, { position: 'absolute', inset: '0', borderRadius: 'inherit', pointerEvents: 'none', mixBlendMode: 'plus-lighter', display: 'none' });
    node.appendChild(glow);
  }
  mkGlow();
  // 按住期间在 window 上跟踪：手指滑出再抬起（元素收不到 pointerup）也能松开；不抓指针，点击语义照旧
  let press = null;
  function down(e) {
    if (press || node.disabled || o.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const r = node.getBoundingClientRect();
    ctl.w = node.offsetWidth || r.width; ctl.h = node.offsetHeight || r.height;
    ctl.sx = (e.clientX - r.left) * ctl.w / Math.max(1, r.width); ctl.sy = (e.clientY - r.top) * ctl.h / Math.max(1, r.height);
    press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    ctl.p.t = 1; ctl.ox.snap(0); ctl.oy.snap(0); wake(ctl);
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', up, true);
  }
  function move(e) {
    if (!press || e.pointerId !== press.id) return;
    ctl.ox.snap(e.clientX - press.x); ctl.oy.snap(e.clientY - press.y); wake(ctl);
  }
  function up(e) {
    if (!press || (e && e.pointerId !== press.id)) return;
    press = null; ctl.p.t = 0; ctl.ox.t = 0; ctl.oy.t = 0; wake(ctl);
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', up, true);
  }
  node.addEventListener('pointerdown', down);
  const off = register(ctl);
  return {
    update(n) { o = { glow: true, ...n }; if (o.glow) mkGlow(); else if (glow) { glow.remove(); glow = null; } },
    destroy() { up(); off(); node.removeEventListener('pointerdown', down); glow?.remove(); ctls.delete(node); },
  };
}
