// 工作台底部 sheet 的拖拽关闭手势（移植自 harness touch.ts dragClose，纯 JS）。
//
// 两个起拖入口：
//  ① 把手区（handle()：grip + chip 条，touch-action:none）——Pointer Events，按下就接管，
//     上推有 rubber-band 阻尼。
//  ② 内容区（2026-10-20 新增）——原生 App 的规矩：内容已经滚到顶时往下拉，拉的就是卡片。
//     以前只有顶上那根十几像素高的把手能拖，手指放在文件网格上往下拽卡片纹丝不动（维护者录屏：
//     拽了 5 秒没反应，挪到把手上才动），这就是「不跟手」。
//     内容区的滚动容器是 touch-action:pan-y，浏览器一判定为滚动就会给 pointercancel、之后再
//     收不到 pointermove，所以这条走 Touch Events（passive:false）：在第一下有效 touchmove 上
//     决定归属——向下、偏竖直、沿途滚动容器都在顶端 → preventDefault 接管成拖卡片；否则整场
//     交还给原生滚动，不再过问。
//     不接管的地方：浏览器直播画布 / 终端 / 编辑器 / 输入框 / 卡片里开着的预览（各自有手势）、
//     文件页「按住拿起」之后（dragdrop 在场）、以及按住超过长按门槛才开始动的（那是长按）。
//
// 2026-11-25 方向锁 + 阻尼（维护者录屏：横滑 chip 条时整个抽屉跟着上下晃；故意往下拉只走一小段就弹回）：
//  · 把手区不再按下就接管，先等手指走出 SLOP 再看方向——偏竖直才拖抽屉，偏水平整场放手给 chip 条横滑。
//    chip 条是横向滚动容器，CSS 上给 touch-action:pan-x：竖向手势浏览器不认领，
//    就不会半路 pointercancel 把拖动掐断（那就是「拉一小段就拉不动」）。
//  · 内容区里落在横向滚动容器（代码 diff、表格、横滑条…）上的，竖直度要求更严（dy ≥ 2|dx|），
//    且只要那个容器已经被横着滚过就不接管。
//  · 下拉带一点阻尼：抽屉位移 = damp(手指位移)，起步约 0.9 倍、越往下越沉；
//    判关仍按【手指】位移与手速算，阻尼只影响观感、不让关起来更费劲。
//
// 跟手：每帧最多写一次 transform（rAF 合并），拖动期间零 transition + will-change；
// 遮罩随拖动进度变淡。松手按「位移 36% 或 速度>0.55px/ms」判关，按手速算滑出时长，
// 【滑完再卸载】（以前 0.3s 的过渡 0.16s 就被拆掉，看着像「啪」一下没了）。
// 鼠标不接管。

import { isDragging, HOLD_MS } from './dragdrop.svelte.js';

const SLOP = 6;   // 起拖判定门槛：必须小于 Chrome 的 touch slop（8px），否则这根手指已经判给滚动了
const NO_DRAG = 'canvas, .xterm, .cm-editor, input, textarea, select, [contenteditable=""], [contenteditable="true"], .mv-root, [data-sheet-nodrag]';

export function dragSheet(node, opts) {
  let mode = '';            // '' | 'drag'
  let base = 0;             // 起拖时手指的 Y（位移 = 当前 Y - base）
  let rubber = false;       // 把手起拖允许上推阻尼；内容区起拖上推夹在 0
  let pid = -1;             // 把手：pointerId
  let tid = null;           // 内容区：touch identifier
  let cur = 0, size = 0;
  let raw = 0;              // 手指实际下拉距离（判关用；cur 是阻尼后的抽屉位移）
  let hpend = null;         // 把手区待判定方向的按压 { id, x, y, t }
  let swallowClick = false; // 刚拖过抽屉：吞掉随后那一下 click（别顺手切了 chip）
  let samples = [];         // [t, y]，算松手速度（最近 ~90ms）
  let raf = 0;
  // 内容区待判定的触摸
  let pend = null;          // { id, x, y, t, atTop }

  const scrim = () => (opts.scrim ? opts.scrim() : null);

  // 入场动画（sheetUp，fill both）结束后摘掉：一直挂着的 transform 动画会压住内联 transform 的过渡，
  // 松手回弹/滑出可能没有动画直接跳。只认 sheet 自己的动画（子元素的 animationend 会冒上来）。
  function onAnimEnd(e) { if (e.target === node) node.style.animation = 'none'; }

  function paint() {
    raf = 0;
    node.style.transform = `translateY(${cur}px)`;
    const s = scrim();
    if (s) s.style.opacity = String(Math.max(0, 1 - Math.max(0, cur) / (size || 1)));
  }
  function setOffset(d) {
    cur = d;
    if (!raf) raf = requestAnimationFrame(paint);
  }
  function sample(t, y) {
    samples.push([t, y]);
    while (samples.length > 2 && t - samples[0][0] > 90) samples.shift();
  }
  function velocity() {
    if (samples.length < 2) return 0;
    const [t0, y0] = samples[0], [t1, y1] = samples[samples.length - 1];
    return (y1 - y0) / Math.max(1, t1 - t0);   // px/ms，正 = 向下
  }

  function begin(y, t, allowRubber) {
    mode = 'drag';
    base = y;
    rubber = allowRubber;
    cur = 0;
    raw = 0;
    swallowClick = true;
    size = node.offsetHeight;
    samples = [[t, y]];
    node.style.animation = 'none';
    node.style.transition = 'none';
    node.style.willChange = 'transform';
    const s = scrim();
    if (s) { s.style.animation = 'none'; s.style.transition = 'none'; }
  }
  // 下拉阻尼：起步斜率 0.9，拉到一屏高时约 0.55 倍，一直跟手、只是越来越沉
  function damp(d) { return (d * 0.9) / (1 + d / (1.8 * (size || 600))); }
  function move(y, t) {
    let d = y - base;
    raw = Math.max(0, d);
    if (d < 0) d = rubber ? -Math.pow(-d, 0.72) : 0;
    else d = damp(d);
    sample(t, y);
    setOffset(d);
  }
  function end() {
    if (mode !== 'drag') return;
    mode = '';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const v = velocity();
    const s = scrim();
    node.style.willChange = '';
    const close = raw > size * 0.3 || (v > 0.55 && raw > 24);
    if (close) {
      // 按手速滑完剩下的距离：甩得快就快、慢慢放就稳稳地走完，140–300ms 之间
      const left = Math.max(0, size - cur);
      const ms = Math.round(Math.min(300, Math.max(140, left / Math.max(v, 1.4))));
      const ease = `${ms}ms cubic-bezier(.25, .6, .4, 1)`;
      node.style.transition = `transform ${ease}`;
      node.style.transform = `translateY(${size}px)`;
      if (s) { s.style.transition = `opacity ${ease}`; s.style.opacity = '0'; }
      setTimeout(opts.onClose, ms);
    } else {
      node.style.transition = '';
      node.style.transform = '';
      if (s) { s.style.transition = 'opacity .3s ease'; s.style.opacity = ''; }
    }
  }

  // —— ① 把手：Pointer Events（先锁方向）——
  function onDown(e) {
    if (e.pointerType === 'mouse' || mode) return;
    const h = opts.handle?.();
    if (!h || !h.contains(e.target)) return;
    swallowClick = false;
    hpend = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  }
  function onMove(e) {
    if (hpend && e.pointerId === hpend.id) {
      const dx = e.clientX - hpend.x, dy = e.clientY - hpend.y;
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      const { y: y0, t: t0 } = hpend;
      hpend = null;
      if (Math.abs(dy) < Math.abs(dx)) return;          // 偏水平：这一场归 chip 条横滑
      pid = e.pointerId;
      begin(y0, t0, true);                               // 位移从按下处算，接管这一下就追上手指
      node.setPointerCapture?.(pid);
    }
    if (mode !== 'drag' || e.pointerId !== pid) return;
    move(e.clientY, e.timeStamp);
    if (Math.abs(cur) > 6) e.preventDefault?.();
  }
  function onUp(e) {
    if (hpend && e.pointerId === hpend.id) hpend = null;
    if (e.pointerId !== pid) return;
    pid = -1;
    end();
  }
  function onClickCapture(e) {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }

  // —— ② 内容区：Touch Events ——
  // 从触点往上到 sheet 为止，每一层能竖向滚动的容器都必须在顶端。
  function atTop(target) {
    for (let el = target; el && el !== node; el = el.parentElement) {
      if (el.scrollTop > 0) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return false;
      }
    }
    return true;
  }
  // 触点往上第一个真能横滑的容器（没有就 null）
  function hScroller(target) {
    for (let el = target; el && el !== node; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const ox = getComputedStyle(el).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'overlay') return el;
      }
    }
    return null;
  }
  function onTouchStart(e) {
    if (e.touches.length === 1) swallowClick = false;
    if (mode || e.touches.length !== 1) { pend = null; return; }
    const tgt = e.target;
    const h = opts.handle?.();
    if (h && h.contains(tgt)) return;                   // 把手区走 ①
    if (!(tgt instanceof Element) || tgt.closest(NO_DRAG)) return;
    const p = e.touches[0];
    const hs = hScroller(tgt);
    pend = { id: p.identifier, x: p.clientX, y: p.clientY, t: e.timeStamp, atTop: atTop(tgt), tgt, hs, hs0: hs ? hs.scrollLeft : 0 };
  }
  function onTouchMove(e) {
    if (mode === 'drag' && tid != null) {
      const p = [...e.changedTouches].find((x) => x.identifier === tid);
      if (!p) return;
      if (e.cancelable) e.preventDefault();
      move(p.clientY, e.timeStamp);
      return;
    }
    if (!pend) return;
    if (e.touches.length !== 1) { pend = null; return; }
    const p = [...e.changedTouches].find((x) => x.identifier === pend.id);
    if (!p) return;
    const dx = p.clientX - pend.x, dy = p.clientY - pend.y;
    if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;   // 还在抖动范围内，先不表态
    const ok = pend.atTop && dy > 0 && dy >= Math.abs(dx) * (pend.hs ? 2 : 1.2)
      && !(pend.hs && pend.hs.scrollLeft !== pend.hs0)          // 横滑区已经被横着带动过了，不抢
      && e.cancelable && !e.defaultPrevented && !isDragging()
      && e.timeStamp - pend.t < HOLD_MS                         // 按住够久才动 = 长按（拿起文件），不抢
      && atTop(pend.tgt);                                       // 按下后内容可能被惯性滚动带离顶端，再看一眼
    if (!ok) { pend = null; return; }                           // 这一场交给原生滚动
    e.preventDefault();
    tid = pend.id;
    const { y: y0, t: t0 } = pend;
    pend = null;
    // 位移从【按下的位置】算起：判定前那十来像素不吃掉，接管的这一下卡片就追上手指
    begin(y0, t0, false);
    move(p.clientY, e.timeStamp);
  }
  function onTouchEnd(e) {
    if (pend && [...e.changedTouches].some((x) => x.identifier === pend.id)) pend = null;
    if (tid == null || ![...e.changedTouches].some((x) => x.identifier === tid)) return;
    tid = null;
    end();
  }

  node.addEventListener('animationend', onAnimEnd);
  node.addEventListener('click', onClickCapture, true);
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onUp);
  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchmove', onTouchMove, { passive: false });
  node.addEventListener('touchend', onTouchEnd);
  node.addEventListener('touchcancel', onTouchEnd);
  return {
    update(next) { opts = next; },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      node.removeEventListener('animationend', onAnimEnd);
      node.removeEventListener('click', onClickCapture, true);
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
    },
  };
}
