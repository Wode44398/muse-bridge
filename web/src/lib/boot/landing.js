// 门出画之后，主页上的东西挂在同一台相机上落位：每样东西从离门心近一成的地方、稍小一点，
// 被弹簧推到原位（几乎不回弹，相机落定不该晃）；离门心越远越晚到。图标晚 40ms 自己再弹一下。
//
// 透明度只加在「玻璃本身」和玻璃外面的东西上，绝不加在液态玻璃的祖先上：祖先 opacity < 1 会成为
// backdrop 根，玻璃采不到底下的页面、整块发黑。位移、缩放放在外层，透明度放在玻璃那一层。
import { ui } from '../state.svelte.js';
import { springCurve } from '../motion.js';

const SP = {
  place: springCurve({ stiffness: 520, damping: 42 }),   // ζ≈.92
  glyph: springCurve({ stiffness: 620, damping: 36 }),   // ζ≈.72
  slab: springCurve({ stiffness: 420, damping: 39 }),    // ζ≈.95
  dicon: springCurve({ stiffness: 620, damping: 35 }),   // ζ≈.70
};
const FADE = 'cubic-bezier(0, 0, .2, 1)';

function center(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: r.width > 0 && r.height > 0 };
}
function run(el, frames, opts) {
  if (!el) return 0;
  try {
    const a = el.animate(frames, { fill: 'backwards', ...opts });
    if (import.meta.env.DEV) (window.__landAnims ||= []).push(a);   // 调试：逐帧定格落位
  } catch {}
  return (opts.delay || 0) + (opts.duration || 0);
}
const fade = (el, delay, duration = 160) => run(el, [{ opacity: 0 }, { opacity: 1 }], { duration, delay, easing: FADE });

/**
 * 在门出画的那一帧调用（此时这些元素还藏着、几何已经是终态）。o = { cx, cy }：门心。
 * 返回落位全部结束还要多久（毫秒）。
 */
export function land({ cx, cy }) {
  let end = 0;
  const off = (p, amt) => `translate(${((cx - p.x) * amt).toFixed(2)}px, ${((cy - p.y) * amt).toFixed(2)}px)`;
  const dist = (p) => Math.hypot(p.x - cx, p.y - cy);

  // —— 手机 / 网页主页：入口方块 ——
  for (const en of document.querySelectorAll('.home .grid .entry')) {
    const p = center(en);
    if (!p.ok) continue;
    const d = Math.min(45, dist(p) * 0.14);
    end = Math.max(end, run(en, [{ transform: `${off(p, 0.07)} scale(.93)` }, { transform: 'none' }], { duration: SP.place.duration, delay: d, easing: SP.place.easing }));
    fade(en.querySelector('.tile'), d);
    const ico = en.querySelector('.ico');
    run(ico, [{ scale: '.88' }, { scale: '1' }], { duration: SP.glyph.duration, delay: d + 18, easing: SP.glyph.easing });
    for (const x of [ico, en.querySelector('.lbl'), en.querySelector('.badge')]) fade(x, d + 18, 140);
  }
  // 右上账户胶囊：透明度由它自己按 ui.booted 淡入（容器里有液态玻璃，不能在容器上叠透明度），这里只给位移
  const pill = document.querySelector('.home .plabel');
  const lc = document.querySelector('.home .lc-fade');
  if (pill && lc) {
    const p = center(pill);
    if (p.ok) run(lc, [{ transform: off(p, 0.05) }, { transform: 'none' }], { duration: SP.place.duration, delay: 50, easing: SP.place.easing });
  }

  // —— 桌面主页：Dock ——
  const dock = document.querySelector('.dh .dock');
  if (dock) {
    const p = center(dock);
    const t0 = 0;
    const slab = [{ transform: `${off(p, 0.06)} scale(.97)` }, { transform: 'none' }];
    const so = { duration: SP.slab.duration, delay: t0, easing: SP.slab.easing };
    run(dock, slab, so);
    if (dock.classList.contains('domglass')) fade(dock, t0, 160);   // DOM 玻璃：玻璃就在它身上，透明度加在它自己
    const fgd = document.querySelector('.dh .fgd');                 // Figma 玻璃画在 Dock 外面的画布上，跟着一起动
    if (fgd) { run(fgd, slab, so); fade(fgd, t0, 160); }
    end = Math.max(end, t0 + SP.slab.duration);
    // 图标从中间往两边弹出：中间离门心最近，最先到
    for (const it of dock.querySelectorAll('.ditem, .dsep')) {
      const q = center(it);
      const d = t0 + 25 + Math.abs(q.x - cx) * 0.18;
      if (!it.classList.contains('dsep')) run(it, [{ scale: '.62' }, { scale: '1' }], { duration: SP.dicon.duration, delay: d, easing: SP.dicon.easing });
      fade(it, d, 130);
      end = Math.max(end, d + SP.dicon.duration);
    }
    fade(document.querySelector('.dh .hint'), t0 + 240, 260);
  }

  // —— 插件卡片（两种主页都有）——
  for (const phc of document.querySelectorAll('.phc')) {
    const p = center(phc);
    if (!p.ok) continue;
    const d = Math.min(50, dist(p) * 0.14);
    run(phc, [{ transform: off(p, 0.06) }, { transform: 'none' }], { duration: SP.place.duration, delay: d, easing: SP.place.easing });
    for (const c of phc.querySelectorAll('.phc-card')) fade(c, d);
    end = Math.max(end, d + SP.place.duration);
  }

  // —— 左上标题：整行同一个落位进度（字距随之等比收拢、不参差），显影按字错开 10ms ——
  const brand = document.querySelector('.brand');
  if (brand) {
    brand.querySelectorAll('.bl').forEach((line, li) => {
      const d = 35 + li * 20;
      line.querySelectorAll('.ch').forEach((ch, i) => {
        const p = center(ch);
        run(ch, [{ transform: off(p, 0.05) }, { transform: 'none' }], { duration: SP.place.duration, delay: d, easing: SP.place.easing });
        fade(ch, d + i * 10, 160);
      });
      end = Math.max(end, d + SP.place.duration);
    });
  }

  ui.bootStage = 'land';
  setTimeout(() => { if (ui.bootStage === 'land') ui.bootStage = ''; }, end + 50);
  return end;
}
