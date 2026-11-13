// 液态玻璃 · 材质引擎（「长什么样」＝ iOS 27 UI Kit 的 Figma 图层，对页面 DOM 背景实时折射）
// 移植自样稿 lg-figma.js 的「拆分版」（触屏默认那套）：滤镜只做必须读背景的事——磨砂、折射、光照（约 5 个节点），
// 玻璃元素就是玻璃形状本身、由元素圆角裁边；其余图层（细描边线、填充、内阴影、描边、边缘高光）按 Figma 顺序画成 CSS 元素。
// 为什么拆：安卓 WebView 每画一帧都把屏幕上所有 backdrop-filter 整条重算（与哪里在动无关），feImage 位图按像素、
// 节点按个数计费——精确版一块 Tab 栏 70 个节点≈34ms/帧（真机 SM-S9370 实测，见 memory backdrop-filter 第四条）。
// 公式出处：design/figma-glass-port（Figma WGSL 原件逆向）与样稿 figma-glass-math.md。
// 只在 Chromium 内核里有效（backdrop-filter: url(#svg)）；WebKit / Firefox 由调用方走 CSS 退路（LIQUID === false）。
import { NO_SVG_BACKDROP } from '../liquidGlass.js';
import { clamp } from './core.js';

const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const LIQUID = typeof document !== 'undefined' && !NO_SVG_BACKDROP && !/Firefox\//.test(UA)
  && typeof CSS !== 'undefined' && (CSS.supports?.('backdrop-filter', 'blur(1px)') || CSS.supports?.('-webkit-backdrop-filter', 'blur(1px)'));

const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const SVGNS = 'http://www.w3.org/2000/svg';
export const LEVELS = 8;     // 折射带宽随按下进度变化时，按 8 档预烘位移图
export const SDF_RANGE = 8;  // 距离场编码范围 ±4（节点单位）
const OPTS = { quant: 'lum' };   // Figma 非 NORMAL 填充的 rgba8 量化：只对 LUMINOSITY 计入（样稿实测误差最小）

/* ---------- 形状：有向距离（<0 在内）。kit 里用到的胶囊平滑度实际为 0（effectiveSmoothing），一律按普通圆角矩形 ---------- */
export function sdfOf(s) {
  if (s.sdf) return s.sdf;
  const w = Math.max(s.w, 1e-6), h = Math.max(s.h, 1e-6);
  const r = Math.min(Math.max(s.r || 0, 0), w / 2, h / 2);
  const cx = s.x + w / 2, cy = s.y + h / 2, hx = w / 2 - r, hy = h / 2 - r;
  return (px, py) => {
    const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
}

/* ---------- 玻璃的场（figma-glass-math.md §4、§6）：sn＝二维偏移（节点单位），add＝光照，rim＝边缘主高光方向系数 ---------- */
function rrectNormal(px, py, bx, by, Rr, bevel) {
  const r = Math.min(bx, by, Rr);
  const ex = Math.abs(px) - (bx - r), ey = Math.abs(py) - (by - r);
  const thr = Rr <= bevel ? -bevel : 0;
  if (Math.max(ex, ey) <= thr) return [0, 0];
  const lift = Math.max(-Math.min(ex, ey), 0);
  const nx = ex + lift, ny = ey + lift, L2 = nx * nx + ny * ny;
  if (!(L2 > 1e-10)) return [0, 0];
  const s = 1 / Math.sqrt(L2);
  return [nx * s * Math.sign(px), ny * s * Math.sign(py)];
}
function glassField(g, shape, P) {
  const { W, H, D, x0, y0 } = g, N = W * H;
  const sn = new Float32Array(2 * N), add = new Float32Array(N);
  const Dd = P.depth, RI = P.refraction, bev = 1, LI = P.lightIntensity || 0, splay = P.splay || 0;
  const th = (P.lightAngle || 0) * Math.PI / 180 + Math.PI / 2, lx = Math.cos(th), ly = Math.sin(th);
  const inner = .999 * Dd, rim = RI * .2 * inner;
  const sdf = sdfOf(shape);
  let maxOff = 0;
  const w = shape.w, h = shape.h, rr = Math.min(Math.max(shape.r, 0), w / 2, h / 2);
  const cx = shape.x + w / 2, cy = shape.y + h / 2, bx = w / 2, by = h / 2;
  const rN = Math.max(rr, Math.max(bev, Dd)), rL = rr;
  for (let j = 0; j < H; j++) {
    const y = y0 + (j + .5) / D;
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + .5) / D, o = j * W + i;
      const d = sdf(x, y);
      if (d < -(Dd + bev) - 1) continue;
      if (d > 2) continue;
      const gg = clamp((d + Dd + bev) / Math.max(1e-5, Dd), 0, 1);
      const magIn = clamp(RI * Dd * Math.pow(gg, 3.5), -inner, inner);
      const tR = clamp((d + bev + 1e-4) / Math.max(1e-5, .7 * bev + 1e-4), 0, 1);
      const mag = magIn + (rim - magIn) * tR;
      const px = x - cx, py = y - cy;
      const n0 = rrectNormal(px, py, bx, by, rN, bev), nL = rrectNormal(px, py, bx, by, rL, bev);
      const pl = Math.hypot(px, py), rx = pl > 1e-5 ? px / pl : 0, ry = pl > 1e-5 ? py / pl : 0;
      const Nx = n0[0] * (1 - splay) + rx * splay, Ny = n0[1] * (1 - splay) + ry * splay;
      sn[2 * o] = -Nx * mag; sn[2 * o + 1] = -Ny * mag;
      maxOff = Math.max(maxOff, Math.abs(sn[2 * o]), Math.abs(sn[2 * o + 1]));
      if (LI) {
        const s3 = clamp((d + Dd) / Math.max(1e-5, Dd - bev + 1e-4), 0, 1) ** 2;
        add[o] = (Nx * lx + Ny * ly) * s3 * .05 * LI;   // 边缘 1px 内的主高光（L1、L2）交给 CSS 细环（rimCss）
      }
    }
  }
  return { sn, add, maxOff };
}

/* ---------- 图像缓存与编码：同形状、同参数、同分辨率的场只烘一次（整页几十个开关共用一套） ---------- */
const cache = new Map();
function memo(key, fn) {
  let v = cache.get(key);
  if (v === undefined) { v = fn(); cache.set(key, v); if (cache.size > 200) cache.delete(cache.keys().next().value); }
  return v;
}
// CPU 画布：GPU 加速画布每次 toDataURL 都要等 GPU 读回（实测每张 200–300ms），CPU 画布≈0
let cv = null, cx2 = null;
function canvas(W, H) {
  if (!cv) { cv = document.createElement('canvas'); cx2 = cv.getContext('2d', { willReadFrequently: true }); }
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  return cx2;
}
function dispURL(g, sn, scale, light) {
  const c = canvas(g.W, g.H), img = c.createImageData(g.W, g.H), d = img.data;
  for (let k = 0; k < g.W * g.H; k++) {
    d[k * 4] = Math.round(clamp(.5 + sn[2 * k] / scale, 0, 1) * 255);
    d[k * 4 + 1] = Math.round(clamp(.5 + sn[2 * k + 1] / scale, 0, 1) * 255);
    d[k * 4 + 2] = light ? Math.round(clamp(.5 + light[k], 0, 1) * 255) : 128; d[k * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return cv.toDataURL();
}

/* ---------- SVG 滤镜图 ---------- */
let defs = null, seq = 0;
function ensureDefs() {
  if (defs && defs.isConnected) return defs;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  defs = document.createElementNS(SVGNS, 'defs');
  svg.appendChild(defs); document.body.appendChild(svg);
  return defs;
}
class Graph {
  constructor(filter) { this.f = filter; this.n = 0; }
  add(tag, attrs, inputs = []) {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (inputs[0]) el.setAttribute('in', inputs[0]);
    if (inputs[1]) el.setAttribute('in2', inputs[1]);
    const r = 'r' + (++this.n); el.setAttribute('result', r);
    this.f.appendChild(el);
    el._r = r;
    return el;
  }
  img(w, h) { return this.add('feImage', { x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none' }); }
  chanA(input, c) { const v = [0, 0, 0, 0, 0]; v[c] = 1; return this.add('feColorMatrix', { type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ' + v.join(' ') }, [input]); }
  chanGray(input, c) { const v = [0, 0, 0, 0, 0]; v[c] = 1; const r = v.join(' '); return this.add('feColorMatrix', { type: 'matrix', values: `${r}  ${r}  ${r}  0 0 0 0 1` }, [input]); }
  transferA(input, type, attrs) {
    const t = this.add('feComponentTransfer', {}, [input]);
    const f = document.createElementNS(SVGNS, 'feFuncA'); f.setAttribute('type', type);
    for (const k in attrs) f.setAttribute(k, attrs[k]);
    t.appendChild(f);
    return t;
  }
  flood(rgb, a) { return this.add('feFlood', { 'flood-color': `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`, 'flood-opacity': a }); }
  comp(op, a, b, k) { return this.add('feComposite', Object.assign({ operator: op }, k ? { k1: k[0], k2: k[1], k3: k[2], k4: k[3] } : {}), [a, b]); }
}
function newFilter(prefix) {
  const f = document.createElementNS(SVGNS, 'filter');
  f.id = prefix + (++seq);
  for (const [k, v] of Object.entries({ 'color-interpolation-filters': 'sRGB', filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', x: 0, y: 0, width: 1, height: 1 })) f.setAttribute(k, v);
  ensureDefs().appendChild(f);
  return f;
}

/* Figma 非 NORMAL 填充先画进 rgba8 预乘纹理：颜色被量化成 round(C·α·255)/round(α·255) */
function quantPaint(rgb, a) {
  const aq = Math.round(clamp(a, 0, 1) * 255);
  if (!aq) return [rgb, 0];
  return [rgb.map((v) => Math.min(1, Math.round(v * a * 255) / aq)), aq / 255];
}
function invert(G, input) {
  const t = G.add('feComponentTransfer', {}, [input]);
  for (const ch of ['feFuncR', 'feFuncG', 'feFuncB']) { const f = document.createElementNS(SVGNS, ch); f.setAttribute('type', 'linear'); f.setAttribute('slope', '-1'); f.setAttribute('intercept', '1'); t.appendChild(f); }
  return t;
}
const FE_BLEND = { DARKEN: 'darken', LIGHTEN: 'lighten', MULTIPLY: 'multiply', SCREEN: 'screen', LUMINOSITY: 'luminosity', OVERLAY: 'overlay', COLOR: 'color', HUE: 'hue', SATURATION: 'saturation' };
// 「颜色 C、覆盖 α（alpha 图 aImg）」按混合模式叠到 F 上（液滴的细描边线用）
function blendInto(G, F, mode, rgb, opacity, aImg) {
  if (mode === 'LUMINOSITY') [rgb, opacity] = quantPaint(rgb, opacity);
  const P = G.comp('in', G.flood(mode === 'LINEAR_BURN' ? rgb.map((v) => 1 - v) : rgb, opacity)._r, aImg._r);
  switch (mode) {
    case 'NORMAL': return G.comp('over', P._r, F)._r;
    case 'LINEAR_DODGE': return G.comp('arithmetic', F, P._r, [0, 1, 1, 0])._r;
    case 'LINEAR_BURN': return invert(G, G.comp('arithmetic', invert(G, F)._r, P._r, [0, 1, 1, 0])._r)._r;
    default: return FE_BLEND[mode] ? G.add('feBlend', { mode: FE_BLEND[mode] }, [P._r, F])._r : F;
  }
}
// 均匀填充（不带遮罩）：液滴的填充铺满整个滤镜区域，最后由形状遮罩一次写回
function flatFill(G, F, mode, rgb, a) {
  if (mode === 'LUMINOSITY') [rgb, a] = quantPaint(rgb, a);
  switch (mode) {
    case 'NORMAL': return G.comp('over', G.flood(rgb, a)._r, F)._r;
    case 'LINEAR_DODGE': return G.comp('arithmetic', F, G.flood(rgb, a)._r, [0, 1, 1, 0])._r;
    case 'LINEAR_BURN': return G.comp('arithmetic', F, G.flood(rgb.map((v) => 1 - a * (1 - v)), 1)._r, [0, 1, 1, -1])._r;
    default: return FE_BLEND[mode] ? G.add('feBlend', { mode: FE_BLEND[mode] }, [G.flood(rgb, a)._r, F])._r : F;
  }
}

/* ---------- 其余图层 → CSS 元素 ----------
   LINEAR_BURN 用 multiply 等效（b₀ 取玻璃常见亮度：明 0.95 / 暗 0.11）；LINEAR_DODGE ＝ plus-lighter（精确）。
   注意（Chromium）：同一个层叠上下文里既有玻璃（backdrop-filter）又有 mix-blend 元素时，这一组会画进独立合成面，
   玻璃只采得到这个面里的东西——所以玻璃和装饰要平铺在一个本身就含有底下内容（不透明页面底）的祖先里，
   中间别包会建层叠上下文的容器（transform / opacity / filter / z-index / fixed）。 */
const CSS_BLEND = { NORMAL: 'normal', LINEAR_DODGE: 'plus-lighter', LINEAR_BURN: 'multiply', MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay', DARKEN: 'darken', LIGHTEN: 'lighten', LUMINOSITY: 'luminosity', COLOR: 'color', HUE: 'hue', SATURATION: 'saturation' };
function cssPaint(blend, rgb, a, dark) {
  if (blend === 'LUMINOSITY' && OPTS.quant === 'lum') [rgb, a] = quantPaint(rgb, a);
  let c = rgb.slice(0, 3);
  if (blend === 'LINEAR_BURN') { const b0 = dark ? .11 : .95; c = c.map((v) => clamp((b0 + v - 1) / b0, 0, 1)); }
  return { color: `rgba(${c.map((v) => Math.round(v * 255)).join(',')},${(+a).toFixed(4)})`, mode: CSS_BLEND[blend] || 'normal' };
}
const radiusOf = (q) => Math.min(Math.max(q.r || 0, 0), q.w / 2, q.h / 2);
// 边缘主高光（figma-glass-math.md §6 的 L1、L2）：光源角 0° 时方向系数只和法线竖直分量有关 → 0.6px 内环 × 竖向渐变遮罩
function rimCss(q, ge) {
  const r = radiusOf(q), h = q.h, LI = ge.lightIntensity;
  const th = (ge.lightAngle || 0) * Math.PI / 180 + Math.PI / 2, ly = Math.sin(th);
  const f = (ny) => { const c = ny * ly; return (smoothstep(.35, 1, -c) + .6 * smoothstep(.35, 1, c)) * LI; };
  const ny = (y) => (y < r ? (y - r) / r : y > h - r ? (y - (h - r)) / r : 0);
  const fmax = Math.max(1e-6, f(-1), f(1));
  const stops = [];
  for (let k = 0; k <= 32; k++) { const y = h * k / 32; stops.push(`rgba(0,0,0,${(f(ny(y)) / fmax).toFixed(3)}) ${(100 * k / 32).toFixed(1)}%`); }
  const g = Math.round(fmax * 255), mask = `linear-gradient(to bottom, ${stops.join(', ')})`;
  return { boxShadow: `inset 0 0 0 .6px rgb(${g},${g},${g})`, mixBlendMode: 'plus-lighter', maskImage: mask, webkitMaskImage: mask };
}
// 一组 Figma 图层 → CSS 装饰说明。opt.fills=false 不出填充；opt.hair=false 不出细描边线；opt.rim=false 不出边缘高光
function decorSpecs(layers, gi, ge, dark, extraFills, opt = {}) {
  const D = [], external = [];
  const push = (li, q, css, extra) => D.push({ layer: li, x: q.x, y: q.y, w: q.w, h: q.h, r: radiusOf(q), css, extra });
  layers.forEach((L, li) => {
    const q = L.shape || L, fx = L.effects || [];
    const groups = new Map();
    for (const e of fx) if (e.type === 'DROP_SHADOW') {
      if (e.blend === 'NORMAL') { external.push({ layer: li, e, shape: q }); continue; }
      const k = e.blend + '|' + e.color.join(',');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    if (opt.hair !== false) for (const list of groups.values()) {
      const p = cssPaint(list[0].blend, list[0].color, list[0].color[3], dark);
      push(li, q, { boxShadow: list.map((e) => `${e.x}px ${e.y}px ${(2 * .4227 * e.radius).toFixed(2)}px ${e.spread || 0}px ${p.color}`).join(', '), mixBlendMode: p.mode });
    }
    if (opt.rim !== false && li === gi && ge.lightIntensity) push(li, q, rimCss(q, ge));
    if (opt.fills !== false) {
      for (const f of L.fills || []) {
        if (f.blend === 'MULTIPLY' && f.color.every((v) => v >= .9999)) continue;
        const p = cssPaint(f.blend, f.color, f.opacity, dark);
        push(li, q, { background: p.color, mixBlendMode: p.mode });
      }
      for (const [k, ex] of extraFills.entries()) if (ex.layer === li) push(li, q, { background: ex.css || 'rgb(255,255,255)' }, k);
    }
    let last = null;
    for (const e of fx) if (e.type === 'INNER_SHADOW') {
      const p = cssPaint(e.blend, e.color, e.color[3], dark);
      const sh = `inset ${e.x}px ${e.y}px ${(2 / Math.sqrt(6) * e.radius).toFixed(3)}px ${e.spread || 0}px ${p.color}`;
      if (last && last.key === p.mode + p.color) last.css.boxShadow += ', ' + sh;
      else { push(li, q, { boxShadow: sh, mixBlendMode: p.mode }); last = D[D.length - 1]; last.key = p.mode + p.color; }
    }
    for (const st of L.strokes || []) {
      const p = cssPaint(st.blend, st.color, st.opacity, dark);
      push(li, q, { boxShadow: `inset 0 0 0 ${L.strokeWeight}px ${p.color}`, mixBlendMode: p.mode });
    }
  });
  return { D, external };
}
function makeDecor(spec, parent, ref) {
  return spec.map((d) => {
    const n = document.createElement('div');
    n.className = 'lq-decor';
    Object.assign(n.style, { position: 'absolute', pointerEvents: 'none', borderRadius: d.r + 'px', width: d.w + 'px', height: d.h + 'px' }, d.css);
    parent.insertBefore(n, ref);
    return { ...d, el: n };
  });
}
// 整体变换：t 绕父元素坐标里的 (cx, cy)，按每个元素自己的 left/top 换算 transform-origin
function transformEls(els, t, cx, cy) {
  for (const e of els) {
    e.style.transformOrigin = `${(cx - parseFloat(e.style.left || 0)).toFixed(3)}px ${(cy - parseFloat(e.style.top || 0)).toFixed(3)}px`;
    e.style.transform = t;
  }
}
export const cssShadow = (e) => `${e.x}px ${e.y}px ${(2 * .4227 * e.radius).toFixed(2)}px ${e.spread || 0}px rgba(0,0,0,${(+e.color[3]).toFixed(4)})`;

/* ======================================================================
   材质：一组 Figma 图层（含一层 GLASS）→ 一个小滤镜 + CSS 装饰
   spec = { layers（x,y,w,h,r 相对组件帧）, dark, fieldDpr, dynamicDepth, extraFills:[{layer, css}] }
   动态参数 set({ alpha:[每层], depth 0..1, preBlur σ, extra:[每个额外填充] })
   ====================================================================== */
export class Material {
  constructor(spec) {
    this.spec = spec;
    this.filter = newFilter('lqs');
    this.id = this.filter.id;
    this.state = { alpha: spec.layers.map(() => 1), depth: 1, preBlur: 0, extra: (spec.extraFills || []).map((e) => e.opacity ?? 1) };
    this.ox = 0; this.oy = 0; this.opacity = 1;
    this.decor = [];
    this.build();
  }
  build() {
    const sp = this.spec, dark = !!sp.dark;
    const gi = (this.gi = sp.layers.findIndex((L) => (L.effects || []).some((e) => e.type === 'GLASS')));
    const GL = sp.layers[gi], ge = GL.effects.find((e) => e.type === 'GLASS'), gs = GL.shape || GL;
    this.box = [gs.x, gs.y, gs.w, gs.h];
    this.radius = radiusOf(gs);
    const w = gs.w, h = gs.h;
    const FD = Math.min(Math.min(3, window.devicePixelRatio || 1), sp.fieldDpr || .5);
    const lf = { x0: 0, y0: 0, W: Math.max(1, Math.round(w * FD)), H: Math.max(1, Math.round(h * FD)), D: FD };
    const shape = { x: 0, y: 0, w, h, r: gs.r };
    const levels = sp.dynamicDepth ? LEVELS : 1;
    const CA = (ge.dispersion || 0) * .2;
    const { maps, scale, maxOff } = memo('S|' + [w, h, gs.r, FD, levels].join(',') + JSON.stringify(ge), () => {
      const maps = [];
      let scale = 0, top = null, maxOff = 0;
      for (let lv = levels; lv >= 1; lv--) {
        const fld = glassField(lf, shape, { ...ge, depth: ge.depth * lv / levels });
        if (!scale) { maxOff = fld.maxOff; scale = Math.max(1, 2 * fld.maxOff * (1 + CA) + 1); }
        if (lv === levels && ge.lightIntensity) top = fld.add;
        maps[lv - 1] = dispURL(lf, fld.sn, scale, top);
      }
      return { maps, scale, maxOff };
    });
    this.filter.setAttribute('width', w); this.filter.setAttribute('height', h);
    this.filter.replaceChildren();
    const G = new Graph(this.filter);
    const map = G.img(w, h); map.setAttribute('href', maps[maps.length - 1]);
    const sig0 = ge.frost / Math.sqrt(6);
    const blur = G.add('feGaussianBlur', { stdDeviation: sig0, edgeMode: 'duplicate' }, ['SourceGraphic']);
    const facs = CA / 2 * maxOff < .5 ? [1] : [1 + CA / 2, 1, 1 - CA / 2];
    const disp = facs.map((f) => G.add('feDisplacementMap', { scale: f * scale, xChannelSelector: 'R', yChannelSelector: 'G' }, [blur._r, map._r]));
    let Gs = disp[0]._r;
    if (disp.length > 1) {
      const pick = ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 1', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0 1'];
      const ch = disp.map((d, k) => G.add('feColorMatrix', { type: 'matrix', values: pick[k] }, [d._r]));
      Gs = G.comp('arithmetic', G.comp('arithmetic', ch[0]._r, ch[1]._r, [0, 1, 1, 0])._r, ch[2]._r, [0, 1, 1, 0])._r;
    }
    if (ge.lightIntensity) G.comp('arithmetic', Gs, G.chanGray(map._r, 2)._r, [0, 1, 1, -.5]);
    this.dyn = { blur, sig0, glass: { maps, map, disp, facs, scale, levels } };
    const { D, external } = decorSpecs(sp.layers, gi, ge, dark, sp.extraFills || []);
    this.decorSpec = D;
    this.external = external;
    if (this.parent) this.mount(this.parent);
    this.apply();
    this.place();
    return this;
  }
  // 装饰元素插到玻璃元素后面（同一父元素、平铺）
  mount(parent) {
    for (const d of this.decor) d.el.remove();
    this.parent = parent;
    const ref = this.el && this.el.parentNode === parent ? this.el.nextSibling : null;
    this.decor = makeDecor(this.decorSpec, parent, ref);
    if (this.hidden) this.setVisible(false);
    this.place(); this.apply();
    return this;
  }
  get els() { return [this.el, ...this.decor.map((d) => d.el)].filter(Boolean); }
  attach(el) {
    el.style.backdropFilter = el.style.webkitBackdropFilter = `url(#${this.id})`;
    el.style.borderRadius = this.radius + 'px';
    if (!el.style.position) el.style.position = 'absolute';
    this.el = el;
    this.place(); this.apply();
    return el;
  }
  place() {
    const b = this.box;
    if (this.el) Object.assign(this.el.style, { left: (this.ox + b[0]) + 'px', top: (this.oy + b[1]) + 'px', width: b[2] + 'px', height: b[3] + 'px' });
    for (const d of this.decor) { d.el.style.left = (this.ox + d.x) + 'px'; d.el.style.top = (this.oy + d.y) + 'px'; }
  }
  moveTo(x, y) { this.ox = x; this.oy = y; this.place(); }
  transform(t, cx, cy) { transformEls(this.els, t, cx, cy); }
  setOpacity(a) { this.opacity = a; this.apply(); }
  setVisible(on) { this.hidden = !on; for (const e of this.els) e.style.display = on ? '' : 'none'; }
  // 额外填充（透镜表面）的颜色：开关旋钮在开 / 关之间换色时跟着走
  setExtraColor(k, css) { for (const d of this.decor) if (d.extra === k && d.css.background !== css) { d.css.background = css; d.el.style.background = css; } }
  set(p) {
    const st = this.state;
    if (p.alpha) p.alpha.forEach((a, i) => { if (a != null) st.alpha[i] = a; });
    if (p.depth != null) st.depth = p.depth;
    if (p.preBlur != null) st.preBlur = p.preBlur;
    if (p.extra) p.extra.forEach((a, i) => { if (a != null) st.extra[i] = a; });
    this.apply();
  }
  apply() {
    const st = this.state, o = this.opacity;
    if (this.el) this.el.style.opacity = (o * st.alpha[this.gi]).toFixed(4);
    // 额外填充（Kyant 的白色表面 alpha = 1 − 按下进度）只按自己的不透明度走，不乘图层系数
    for (const d of this.decor) d.el.style.opacity = (o * (d.extra != null ? clamp(st.extra[d.extra], 0, 1) : st.alpha[d.layer])).toFixed(4);
    const dy = this.dyn;
    if (!dy) return;
    dy.blur.setAttribute('stdDeviation', Math.sqrt(dy.sig0 * dy.sig0 + st.preBlur * st.preBlur).toFixed(3));
    const gl = dy.glass, k = clamp(st.depth, 0, 1), lv = Math.max(1, Math.ceil(k * gl.levels - 1e-6));
    if (gl.lv !== lv) { gl.lv = lv; gl.map.setAttribute('href', gl.maps[lv - 1]); }
    const sc = gl.levels === 1 ? 1 : k / (lv / gl.levels);
    gl.disp.forEach((el, i) => el.setAttribute('scale', (gl.facs[i] * gl.scale * sc).toFixed(3)));
  }
  destroy() { this.filter.remove(); for (const d of this.decor) d.el.remove(); this.decor = []; }
}

/* ======================================================================
   液滴材质（菜单从按钮长出来）：形状每帧都变，一张 0.5x 图（R 距离场、G/B 位移）逐帧重算；
   滤镜 = 填充 → 磨砂 → 折射 → 按距离场切出的液滴形状写回（细描边线也由距离场切出、跟着融合形状走），约 12 个节点。
   内阴影、边缘高光画成 CSS 元素，按菜单本体摆放（按钮残影消失、接近终态尺寸时才淡入）。光照项省略（运动中看不出）。
   spec = { layers: kit Medium 的两层（同一形状）, dark, fastDpr }
   ====================================================================== */
export class MorphGlass {
  constructor(spec) {
    this.spec = spec;
    this.filter = newFilter('lqm');
    this.id = this.filter.id;
    this.decor = [];
    const [L0, L1] = spec.layers, dark = !!spec.dark;
    const G = new Graph(this.filter);
    this.img1 = G.img(1, 1);
    let F = 'SourceGraphic';
    for (const fl of L0.fills || []) if (!(fl.blend === 'MULTIPLY' && fl.color.every((v) => v >= .9999))) F = flatFill(G, F, fl.blend, fl.color, fl.opacity);
    const ge = (this.ge = L1.effects.find((e) => e.type === 'GLASS'));
    const blur = G.add('feGaussianBlur', { stdDeviation: ge.frost / Math.sqrt(6), edgeMode: 'duplicate' }, [F]);
    this.scale = 2 * ge.refraction * ge.depth + 1;
    let Gs = G.add('feDisplacementMap', { scale: this.scale.toFixed(3), xChannelSelector: 'G', yChannelSelector: 'B' }, [blur._r, this.img1._r])._r;
    for (const fl of L1.fills || []) if (!(fl.blend === 'MULTIPLY' && fl.color.every((v) => v >= .9999))) Gs = flatFill(G, Gs, fl.blend, fl.color, fl.opacity);
    const DPR = window.devicePixelRatio || 1, K = SDF_RANGE * DPR;
    const sdfA = G.chanA(this.img1._r, 0);
    const m = G.transferA(sdfA._r, 'linear', { slope: K, intercept: .5 - .5 * K });
    let outside = 'SourceGraphic';
    const hair = (L0.effects || []).find((e) => e.type === 'DROP_SHADOW' && e.blend !== 'NORMAL' && !e.x && !e.y);
    if (hair) {
      const g = G.transferA(sdfA._r, 'linear', { slope: K, intercept: .5 - .5 * K + (hair.spread || 0) * DPR });
      const ring = G.comp('out', g._r, m._r);
      const p = cssPaint(hair.blend, hair.color, 1, dark);
      const c = p.color.match(/[\d.]+/g).slice(0, 3).map((v) => v / 255);
      outside = blendInto(G, outside, p.mode === 'plus-lighter' ? 'LINEAR_DODGE' : p.mode === 'multiply' ? 'MULTIPLY' : 'NORMAL', c, hair.color[3], ring);
    }
    G.comp('arithmetic', G.comp('in', Gs, m._r)._r, G.comp('out', outside, m._r)._r, [0, 1, 1, 0]);
    const ds = decorSpecs([L0, L1], 1, ge, dark, [], { fills: false, hair: false });
    this.decorSpec = ds.D;
    this.external = ds.external;
  }
  // box：玻璃元素盒子（容器坐标）；sdf(x,y)：融合形状（同一坐标）；center：splay 用的中心
  frame(box, sdf, center) {
    const D = this.spec.fastDpr || .5, ge = this.ge;
    const W = Math.max(1, Math.round(box[2] * D)), H = Math.max(1, Math.round(box[3] * D)), N = W * H;
    const X = (i) => box[0] + (i + .5) / D, Y = (j) => box[1] + (j + .5) / D;
    const S = new Float32Array(N);
    for (let j = 0; j < H; j++) { const y = Y(j); for (let i = 0; i < W; i++) S[j * W + i] = sdf(X(i), y); }
    const Dd = ge.depth, RI = ge.refraction, bev = 1, inner = .999 * Dd, rim = RI * .2 * inner, splay = ge.splay || 0;
    const c = canvas(W, H), img = c.createImageData(W, H), px = img.data;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const o = j * W + i, d = S[o], q = o * 4;
      px[q] = clamp(.5 - d / SDF_RANGE, 0, 1) * 255; px[q + 3] = 255;
      let sx = 0, sy = 0;
      if (d < 3 && d > -(Dd + bev) - 1) {
        const gg = clamp((d + Dd + bev) / Math.max(1e-5, Dd), 0, 1);
        const magIn = clamp(RI * Dd * Math.pow(gg, 3.5), -inner, inner);
        const tR = clamp((d + bev + 1e-4) / Math.max(1e-5, .7 * bev + 1e-4), 0, 1);
        const mag = magIn + (rim - magIn) * tR;
        const gx = (i < W - 1 ? S[o + 1] : d) - (i > 0 ? S[o - 1] : d), gy = (j < H - 1 ? S[o + W] : d) - (j > 0 ? S[o - W] : d), gl = Math.hypot(gx, gy) || 1;
        const x = X(i) - center[0], y = Y(j) - center[1], pl = Math.hypot(x, y) || 1;
        const Nx = (gx / gl) * (1 - splay) + (x / pl) * splay, Ny = (gy / gl) * (1 - splay) + (y / pl) * splay;
        sx = -Nx * mag; sy = -Ny * mag;
      }
      px[q + 1] = (.5 + sx / this.scale) * 255; px[q + 2] = (.5 + sy / this.scale) * 255;
    }
    c.putImageData(img, 0, 0);
    // 尺寸没变就只换图（改滤镜区域会让浏览器重建整条滤镜，真机一次 15–20ms）
    if (this.lastW !== box[2] || this.lastH !== box[3]) {
      this.lastW = box[2]; this.lastH = box[3];
      this.img1.setAttribute('width', box[2]); this.img1.setAttribute('height', box[3]);
      this.filter.setAttribute('width', box[2]); this.filter.setAttribute('height', box[3]);
    }
    this.img1.setAttribute('href', cv.toDataURL());
  }
  mount(parent, ref) { for (const d of this.decor) d.el.remove(); this.decor = makeDecor(this.decorSpec, parent, ref || null); return this; }
  // 装饰按菜单本体 (x, y, w, h, r) 摆放；尺寸取整到像素、变了才改（带模糊的 inset 阴影每改一次尺寸就要重新光栅化）
  placeDecor(x, y, w, h, r, tf, a = 1) {
    const q = [Math.round(x), Math.round(y), Math.round(w), Math.round(h), Math.round(r)], key = q.join();
    for (const d of this.decor) {
      const s = d.el.style;
      if (d.key !== key) { d.key = key; s.left = q[0] + 'px'; s.top = q[1] + 'px'; s.width = q[2] + 'px'; s.height = q[3] + 'px'; s.borderRadius = q[4] + 'px'; }
      s.transformOrigin = '0 0'; s.transform = tf ? tf(q[0], q[1]) : '';
      s.opacity = a.toFixed(3); s.visibility = a > .002 ? '' : 'hidden';
    }
  }
  setDecorVisible(on) { for (const d of this.decor) d.el.style.display = on ? '' : 'none'; }
  destroy() { this.filter.remove(); for (const d of this.decor) d.el.remove(); this.decor = []; }
}
