// 按下态透镜（kit「Knob · Pressed」：Shadow 模糊环 + Glass Effect + Specular Light）——开关、滑块、Tab 指示器共用。
// 静止时就是一枚实心旋钮（CSS 胶囊）；按下进度 p 驱动：玻璃各层 alpha·p、折射带宽·p（8 档预烘）、实心表面 1−p、
// Kyant 的过渡磨砂 blur(8dp·(1−p))。玻璃滤镜在第一次按下时才建（一页几十个开关，静止时零滤镜、零开销）。
// WebKit / Firefox 没有 backdrop-filter: url()：只剩实心旋钮按 Kyant 的弹簧放大、拉伸（LIQUID === false）。
import { Material, LIQUID } from './glass.js';
import { KIT } from './kit.js';
import { clamp } from './core.js';

// Kyant 的过渡磨砂 blur(8dp·(1−p))：安卓 RenderEffect 半径 → σ = 0.57735·r + 0.5
const androidSigma = (r) => (r > 0 ? .57735 * r + .5 : 0);
// 透镜取样柔化：kit 画板（@3x）里磨砂为 0 的按下透镜边缘比直算更柔，等效背景先过 σ≈0.5pt 模糊（样稿逐像素拟合）
const BASE_BLUR = .5;

const el = (tag, cls, parent, style, before) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (style) Object.assign(e.style, style);
  if (before) parent.insertBefore(e, before); else parent.appendChild(e);
  return e;
};

export class PressedLens {
  // host：放透镜的容器（组件帧坐标，自身不能建层叠上下文）；kind：'toggle' | 'slider' | 'indicator'
  // frame：透镜帧尺寸（kit 按下态，静止时由 transform 缩回）；opt：{ solid, surface（CSS 颜色）, dark }
  // opt.z：给透镜的各元素统一 z-index（挂在页面根上、要压过别的层时用）
  constructor(host, kind, frame, opt = {}) {
    this.host = host; this.kind = kind; this.frame = frame; this.opt = opt;
    this.surface = opt.surface || '#fff';
    const [fw, fh] = frame;
    this.group = el('div', 'lq-lens', host, { position: 'absolute', left: '0', top: '0', width: fw + 'px', height: fh + 'px', transformOrigin: `${fw / 2}px ${fh / 2}px`, pointerEvents: 'none', willChange: 'transform' });
    if (opt.z != null) this.group.style.zIndex = String(opt.z);
    this.ring = el('div', 'lq-ring', this.group, { position: 'absolute', boxSizing: 'border-box', border: '1px solid #000', opacity: '0' });
    this.solid = el('div', 'lq-solid', this.group, { position: 'absolute', background: this.surface });
    const src = KIT.knobPressed(kind === 'slider' ? 'slider' : 'toggle');
    const fit = (L) => ({ ...L, w: fw + (L.w - src.frame.w), h: fh + (L.h - src.frame.h) });
    const [sh, ge, sp] = src.layers.map(fit);
    // 模糊环：Shadow 帧（INSIDE 1px 黑描边 + LAYER_BLUR 6，σ≈0.4227·6），在玻璃下面、玻璃会采到它
    Object.assign(this.ring.style, { left: sh.x + 'px', top: sh.y + 'px', width: sh.w + 'px', height: sh.h + 'px', borderRadius: Math.min(sh.r, sh.h / 2) + 'px', filter: `blur(${(.4227 * sh.effects[0].radius).toFixed(2)}px)` });
    this.ringOpacity = sh.opacity;
    Object.assign(this.solid.style, { left: sp.x + 'px', top: sp.y + 'px', width: sp.w + 'px', height: sp.h + 'px', borderRadius: Math.min(sp.r, sp.w / 2, sp.h / 2) + 'px' });
    if (opt.shadow) this.solid.style.boxShadow = opt.shadow;
    if (opt.solid === false) this.solid.style.display = 'none';
    this.layers = [ge, sp];
    this.mat = null; this.glassEl = null;
    this.active = null; this.lastP = -1; this.T = '';
  }
  ensure() {
    if (this.mat || !LIQUID) return;
    this.glassEl = el('div', 'lq-glass', this.host, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
    this.mat = new Material({
      layers: this.layers.map((L) => ({ ...L })), dark: !!this.opt.dark, dynamicDepth: true,
      // 透镜小、只在按下时挂着：场按设备分辨率烘（1x 的位移图在手机 WebView 上放大后折射带会出方块台阶）
      fieldDpr: 3,
      // 实心表面（kit 静止态旋钮）：放在 Specular 层的形状上，不透明度 = 1 − 按下进度
      extraFills: this.opt.solid === false ? [] : [{ layer: 1, css: this.surface, opacity: 1 }],
    });
    this.mat.attach(this.glassEl);
    this.mat.mount(this.host);
    if (this.opt.z != null) for (const e of this.mat.els) e.style.zIndex = String(this.opt.z);
    this.mat.setVisible(false);
  }
  setSurface(css) {
    if (css === this.surface) return;
    this.surface = css;
    this.solid.style.background = css;
    this.mat?.setExtraColor(0, css);
  }
  // 换主题：材质按新的明暗重建（下次按下时）
  setDark(dark) {
    if (!!dark === !!this.opt.dark) return;
    this.opt.dark = !!dark;
    if (this.mat) { this.mat.destroy(); this.glassEl.remove(); this.mat = null; this.glassEl = null; this.active = null; this.lastP = -1; }
  }
  destroy() { this.mat?.destroy(); this.group.remove(); this.glassEl?.remove(); }
  // cx, cy：透镜中心（宿主坐标）；scaleX/Y：相对按下帧的缩放；p：按下进度
  render(cx, cy, scaleX, scaleY, p) {
    const [fw, fh] = this.frame;
    const T = `translate(${(cx - fw / 2).toFixed(3)}px, ${(cy - fh / 2).toFixed(3)}px) scale(${scaleX.toFixed(5)}, ${scaleY.toFixed(5)})`;
    const q = clamp(p, 0, 1), on = q >= 1e-3;
    if (on && !this.mat) this.ensure();
    if (T !== this.T) {
      this.T = T;
      this.group.style.transform = T;
      if (this.mat && this.active !== false) this.mat.transform(T, fw / 2, fh / 2);
    }
    if (Math.abs(q - this.lastP) < 1e-4 && on === this.active) return;
    this.lastP = q;
    this.ring.style.opacity = (this.ringOpacity * q).toFixed(4);
    if (this.mat) this.mat.set({ alpha: [q, q], depth: q, preBlur: Math.max(androidSigma(8 * (1 - q)), BASE_BLUR), extra: [1 - q] });
    else if (!LIQUID && this.opt.solid !== false) this.solid.style.boxShadow = this.opt.shadow || (q > 1e-3 ? `0 ${(3 * q).toFixed(2)}px ${(10 * q).toFixed(2)}px rgba(0,0,0,${(.14 * q).toFixed(3)})` : '');
    // 按下进度为 0：不挂滤镜，实心旋钮露出；没有实心表面的（Tab 指示器）整个隐藏
    if (on !== this.active) {
      this.active = on;
      const solid = this.opt.solid !== false;
      if (this.mat) { this.mat.setVisible(on); if (on) this.mat.transform(T, fw / 2, fh / 2); }
      this.solid.style.display = solid && (!on || !this.mat) ? '' : 'none';
      this.group.style.visibility = on || solid ? 'visible' : 'hidden';
    }
  }
}
