// 输入栏里几样东西进场 / 退场的 Svelte 过渡（要等退场演完才拿掉节点的，WAAPI 做不了，用这个）。
// 曲线和 motion.js 同口径：进场带一点回弹（弹簧），退场短而直接（ease-in）。

import { reduced } from '../motion.js';

/** 与 motion.js spring() 同一条弹簧，写成 Svelte 过渡要的 easing(p)。 */
export function springEase(bounce = 0.15, dur = 0.55) {
  const z = Math.min(0.999, 1 - bounce), w = 6.2 / (z * dur), wd = w * Math.sqrt(1 - z * z);
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    const x = p * dur;
    return 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + (z * w / wd) * Math.sin(wd * x));
  };
}

const easeIn = (p) => p * p * p;
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const pop = springEase(0.32, 0.5);
const snap = springEase(0.18, 0.34);

/** 附件卡：从 0.9 弹到原大。 */
export function chipIn() {
  if (reduced()) return { duration: 0 };
  return { duration: 360, easing: pop, css: (t) => `opacity:${Math.min(1, t * 2)};transform:scale(${0.9 + 0.1 * t})` };
}
export function chipOut() {
  if (reduced()) return { duration: 0 };
  return { duration: 140, easing: easeIn, css: (t) => `opacity:${t};transform:scale(${0.9 + 0.1 * t})` };
}

/** 输入栏上沿的一张卡 / 一行状态：从下面升起来，落定时轻轻一弹。 */
export function riseIn(node, { dy = 14 } = {}) {
  if (reduced()) return { duration: 0 };
  return { duration: 420, easing: snap, css: (t, u) => `opacity:${Math.min(1, t * 1.6)};transform:translateY(${u * dy}px) scale(${0.97 + 0.03 * t})` };
}

/**
 * 卡片退场的去向由调用方当场决定（how 是函数：退场开始那一刻才问）：
 *   'up'    轮到它了，滑进对话（往上走）
 *   'steer' 现在插话（往上一小段）
 *   'right' 你删掉的（往右让开）
 *   'none'  换了线程，旧的直接拿掉
 */
export function cardOut(node, { how } = {}) {
  if (reduced()) return { duration: 0 };
  const k = typeof how === 'function' ? how() : how || 'right';
  if (k === 'none') return { duration: 0 };
  if (k === 'up') return { duration: 260, easing: easeIn, css: (t, u) => `opacity:${t};transform:translateY(${-30 * u}px) scale(${0.98 + 0.02 * t})` };
  if (k === 'steer') return { duration: 180, easing: easeIn, css: (t, u) => `opacity:${t};transform:translateY(${-16 * u}px)` };
  return { duration: 180, easing: easeIn, css: (t, u) => `opacity:${t};transform:translateX(${12 * u}px)` };
}

/** 一行字淡出（往下一点）。 */
export function lineOut() {
  if (reduced()) return { duration: 0 };
  return { duration: 160, easing: easeIn, css: (t, u) => `opacity:${t};transform:translateY(${4 * u}px)` };
}

/** 从零高度长出来 / 收回去（拒绝时的输入框、计划药丸以外的小块）。 */
export function growY(node, { dur = 360 } = {}) {
  if (reduced()) return { duration: 0 };
  const h = node.offsetHeight;
  return { duration: dur, easing: easeOut, css: (t) => `height:${t * h}px;opacity:${t};overflow:hidden` };
}
