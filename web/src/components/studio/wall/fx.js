// 作品墙的动效小件：挪位（FLIP，从当前样子接着走）、WAAPI 包一层、静默判断、几枚墙上专用的线稿。
// 只动 transform / opacity（手机性能纪律）；方案 §12.8 的三个坑都在这里处理：
//   ① 先挂进文档再起动画（调用方在 onMount / action 里调，元素已经在文档里）；
//   ② 挪位不 commitStyles：先读当前样子、撤掉旧动画、写终值，再从当前样子动画过去；
//   ③ 留着最后一帧的收起类动画，下次打开前先 cancel（anim() 回的句柄由调用方收着）。
import { reducedMotion, springEasing, SPRING_SOFT, SPRING, SPRING_POP, SPRING_SNAP } from '../../../modules/studio/motion.js';
import { progressAt } from '../../../modules/studio/ink.js';

export { SPRING_SOFT, SPRING, SPRING_POP, SPRING_SNAP };
export const EIN = 'cubic-bezier(.5,0,.75,0)';
export const EOUT = 'cubic-bezier(.16,1,.3,1)';
export const ease = (s) => springEasing(s);

/** 这一处要不要演：系统减少动态效果 / bridge 的「关掉入场动画」（StudioPage 在根上挂 .sd-noanim） */
export const quiet = (node) => reducedMotion() || !!node?.closest?.('.sd-noanim');

/** WAAPI 一层薄包装：o = { d, delay, e, fill }；节点不在文档里不演（坑 ①） */
export function anim(node, kf, o = {}) {
  if (!node?.isConnected || !node.animate) return null;
  try {
    return node.animate(kf, { duration: o.d ?? 240, delay: o.delay || 0, easing: o.e || EOUT, fill: o.fill || 'none' });
  } catch { return null; }
}

/**
 * 墙上一格的位置：use:place={{ x, y, w, h, anim, k }}。
 * 位置写成 transform、尺寸写成宽高；变了就 FLIP——同尺寸只走位移，尺寸也变（换列数、比例弹到真值）用 scale 补，
 * 始终只动 transform。上一段还没走完就从它此刻的样子接着走（撤掉它，不让它落定时把旧位置写回来）。
 */
export function place(node, pos) {
  let cur = null, run = null;
  function apply(p) {
    if (!p) return;
    const to = { x: p.x, y: p.y, w: p.w, h: p.h };
    const was = cur;
    cur = to;
    node._pos = to;
    if (was && was.x === to.x && was.y === to.y && was.w === to.w && was.h === to.h) return;
    let from = was;
    if (run && run.playState === 'running') {
      // 正在挪：量出此刻屏幕上的样子（矩阵里的位移和缩放 × 旧宽高）
      const cs = getComputedStyle(node);
      const m = new DOMMatrixReadOnly(cs.transform === 'none' ? undefined : cs.transform);
      const bw = parseFloat(cs.width) || to.w, bh = parseFloat(cs.height) || to.h;
      from = { x: m.m41, y: m.m42, w: bw * m.a, h: bh * m.d };
    }
    if (run) { run.cancel(); run = null; }
    node.style.transform = `translate(${to.x}px, ${to.y}px)`;
    node.style.width = to.w + 'px';
    node.style.height = to.h + 'px';
    if (!p.anim || !from || quiet(node)) return;
    const sx = from.w / to.w, sy = from.h / to.h;
    const same = Math.abs(sx - 1) < 0.002 && Math.abs(sy - 1) < 0.002;
    const a = `translate(${from.x}px, ${from.y}px)${same ? '' : ` scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`}`;
    run = anim(node, [{ transform: a }, { transform: node.style.transform }], {
      d: SPRING_SOFT.ms, e: ease(SPRING_SOFT), delay: Math.min(140, (p.k || 0) * 9), fill: 'backwards',
    });
  }
  node.style.transformOrigin = '0 0';
  node._halt = () => { run?.cancel(); run = null; };
  apply(pos);
  return { update: apply, destroy() { run?.cancel(); } };
}

/** 一格离开墙（取消、收起）：原地往里一收就没了——退场短、加速；旁边的同时挪过来 */
export function leaveCell(node) {
  const p = node._pos;
  node._halt?.();
  if (!p || quiet(node)) return { duration: 0 };
  return {
    duration: 170,
    easing: (x) => x * x,
    css: (t) => { const s = 0.94 + 0.06 * t; return `opacity:${t};transform:translate(${(p.x + (p.w * (1 - s)) / 2).toFixed(1)}px, ${(p.y + (p.h * (1 - s)) / 2).toFixed(1)}px) scale(${s.toFixed(4)})`; },
  };
}

/** 取景框的角（14 网格的一笔圆角折线） */
export const CORNER = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M1 9V3.2A2.2 2.2 0 0 1 3.2 1H9"/></svg>';

const G = {
  mute: '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M16 9.5l4.5 5M20.5 9.5 16 14.5"/>',
  volume: '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>',
  expand: '<path d="M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-6 6M4.5 19.5l6-6"/>',
};
/** 墙上专用的几枚线稿（静音 / 声音 / 全屏），同 icons.js 的 24 网格、1.6 描边 */
export function glyph(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${G[name] || ''}</svg>`;
}

const tsOf = (x) => (typeof x === 'number' ? x : Date.parse(x) || 0);
/**
 * 墨该晕到多少（0–0.93）：服务端的 progress（0–1）优先；没有就按已跑 / 预计时长估（ink.progressAt 永远到不了 1：
 * 等结果，不假装知道还要多久）。调用方每帧追着它走（指数逼近），别一跳一跳。
 */
export function inkTarget(job) {
  const p = Number(job?.progress);
  const ran = Math.max(Number(job?.elapsed || 0) * 1000, Date.now() - tsOf(job?.createdAt));
  const eta = (Number(job?.elapsed || 0) + Number(job?.eta || 0)) * 1000 || 30000;
  const est = progressAt(ran, eta);
  return p > 0 ? Math.max(0.93 * Math.min(1, p), est * 0.6) : est;
}
/** 任务 id → 显影引擎的种子（同一个任务每次重挂墨的形状一样） */
export function seedOf(id) { let s = 7; for (const c of String(id || '')) s = (s * 31 + c.charCodeAt(0)) | 0; return Math.abs(s) || 7; }
