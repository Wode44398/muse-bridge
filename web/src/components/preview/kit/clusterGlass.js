// 触屏视频中央三钮（−10 / 播放暂停 / +10）的液态玻璃底。
// 材质走 lib/liquid/glass.js 的拆分版 Material（滤镜只做磨砂 + 折射 + 光照，其余图层画成 CSS 元素）：
// 压在视频画面上，按钮后面的画面被折射、边缘一圈高光，白色图标靠一层 30% 的黑垫着在亮画面上也读得清。
//
// 为什么能压在会动的画面上（viewer.css 的老规矩是「视频上不用 backdrop-filter」）：安卓 WebView 每出一帧都把屏上
// 所有 backdrop 滤镜重算一遍，所以这里只给三个小圆（52 / 68 / 52）用，而且【只在按钮露着的时候挂】——
// 收起后先淡出、再 display:none（看不见但还挂着的滤镜照样计费），播放中控件 3 秒自动收，暂停时画面不出帧也就不花钱。
//
// 摆放规矩（见 glass.js 顶部与 memory backdrop-filter 第三条）：玻璃和带 mix-blend 的装饰必须平铺在「含着底下画面的
// 那个容器」里（这里是 .vp-stage，<video> 就在里面），中间不能隔会建层叠上下文的父级；渐隐 / 缩放分别加在每个元素上。
// 所以不放进按钮里，而是作为舞台的兄弟节点插在按钮簇前面，位置按按钮的实际盒子摆。
//
// 用法（Svelte action，挂在按钮簇容器上；容器须是舞台里 position:absolute; inset:0 的那层）：
//   <div class="vp-cluster" use:clusterGlass={{ on: 可见 }}> <button data-glass>…</button> … </div>
// 生效后容器带上 .glass 类（按钮据此去掉自己的实底）。不支持 SVG backdrop 的内核（iOS / Firefox）不生效，按钮走 CSS 退路。
import { Material, LIQUID } from '../../../lib/liquid/glass.js';

const HI = [0.16, 0.16, 0.16, 1];
// 圆钮材质：参数取 kit「Liquid Glass - Regular」一族（折射 0.7、色散 0.2、光照 0.25、上下两道加亮内阴影），
// 深度按圆的大小给（kit 的 30 是给 34 圆角的大面板的，小圆上会把整个圆面都拧歪）；磨砂 8，画面细节不干扰图标
const layersOf = (d) => [
  { name: 'Fill', x: 0, y: 0, w: d, h: d, r: d / 2,
    fills: [{ color: [0, 0, 0], opacity: 0.3, blend: 'NORMAL' }],
    strokes: [{ color: [1, 1, 1], opacity: 0.16, blend: 'NORMAL' }], strokeWeight: 0.5 },
  { name: 'Glass Effect', x: 0, y: 0, w: d, h: d, r: d / 2,
    fills: [{ color: [1, 1, 1], opacity: 1, blend: 'MULTIPLY' }],
    effects: [
      { type: 'GLASS', frost: 8, refraction: 0.7, depth: Math.round(d * 0.24), dispersion: 0.2, lightAngle: 0, lightIntensity: 0.4, splay: 0.2 },
      { type: 'INNER_SHADOW', color: HI, radius: 10, x: 0, y: -40, spread: -40, blend: 'LINEAR_DODGE' },
      { type: 'INNER_SHADOW', color: HI, radius: 10, x: 0, y: 40, spread: -40, blend: 'LINEAR_DODGE' },
    ] },
];

const FADE = 180;

export function clusterGlass(node, opt = {}) {
  if (!LIQUID || typeof ResizeObserver === 'undefined') return {};
  const host = node.parentNode;
  if (!host) return {};
  let mats = null;          // [{ mat, el, btn, d }]
  let on = false, shown = false, hideT = 0, raf = 0, dead = false;

  const btns = () => [...node.querySelectorAll('[data-glass]')];
  function build() {
    if (mats) return true;
    try {
      mats = btns().map((btn) => {
        const d = Math.round(btn.offsetWidth) || 52;
        const el = document.createElement('div');
        el.className = 'lq-glass';
        Object.assign(el.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
        host.insertBefore(el, node);
        // 圆小、离眼睛近：位移场按 2x 烘（1x 的在手机上放大后折射带有台阶）
        const mat = new Material({ layers: layersOf(d), dark: true, fieldDpr: 2 });
        mat.attach(el);
        mat.mount(host);
        for (const e of mat.els) e.style.transition = `opacity ${FADE}ms cubic-bezier(.4,0,.2,1), transform 240ms cubic-bezier(.2,.8,.2,1)`;
        mat.setOpacity(0);
        mat.setVisible(false);
        return { mat, el, btn, d, pressed: false };
      });
    } catch { destroyMats(); return false; }
    if (!mats.length) { mats = null; return false; }
    return true;
  }
  function destroyMats() {
    if (!mats) return;
    for (const m of mats) { try { m.mat.destroy(); } catch {} try { m.el.remove(); } catch {} }
    mats = null;
  }
  function place() {
    if (!mats) return;
    for (const m of mats) {
      // 容器是舞台里 inset:0 的定位层 → 按钮的 offsetLeft / offsetTop 就是舞台坐标
      const x = m.btn.offsetLeft, y = m.btn.offsetTop;
      m.cx = x + m.d / 2; m.cy = y + m.d / 2;
      m.mat.moveTo(x, y);
      m.mat.transform(m.pressed ? 'scale(1.08)' : 'none', m.cx, m.cy);
    }
  }
  function apply() {
    clearTimeout(hideT); cancelAnimationFrame(raf);
    if (on) {
      if (!build()) { node.classList.remove('glass'); return; }
      node.classList.add('glass');
      place();
      for (const m of mats) m.mat.setVisible(true);
      shown = true;
      // 先以 0 不透明度上屏一帧，再过渡到 1（display 刚从 none 切回来，同一帧里改不出过渡）
      raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => { if (!dead && on && mats) for (const m of mats) m.mat.setOpacity(1); }); });
    } else if (mats && shown) {
      for (const m of mats) m.mat.setOpacity(0);
      hideT = setTimeout(() => { if (dead || on || !mats) return; shown = false; for (const m of mats) m.mat.setVisible(false); }, FADE + 40);
    }
  }
  // 按下：玻璃跟着按钮鼓一下（Kyant 按压的放大，1 + 4/高 ≈ 1.08）
  function press(e, down) {
    if (!mats) return;
    const b = e.target?.closest?.('[data-glass]');
    for (const m of mats) {
      const p = down && m.btn === b;
      if (p === m.pressed) continue;
      m.pressed = p;
      if (m.cx != null) m.mat.transform(p ? 'scale(1.08)' : 'none', m.cx, m.cy);
    }
  }
  const onDown = (e) => press(e, true), onUp = (e) => press(e, false);
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onUp);
  node.addEventListener('pointerleave', onUp);
  const ro = new ResizeObserver(() => { if (shown) place(); });
  ro.observe(node);

  on = !!opt.on;
  apply();
  return {
    update(o = {}) { const v = !!o.on; if (v === on) return; on = v; apply(); },
    destroy() {
      dead = true;
      clearTimeout(hideT); cancelAnimationFrame(raf);
      ro.disconnect();
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      node.removeEventListener('pointerleave', onUp);
      destroyMats();
    },
  };
}
