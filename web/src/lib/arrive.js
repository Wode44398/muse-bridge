// 晚到的内容怎么进场、怎么离场（Svelte 过渡函数）。
//
// 页面推进来时已经有的东西跟着页面一起出现，不该再单独动一下；只有页面挂好以后才到的数据（冷开时的网络回包、
// 开关改完后多出 / 少掉的一行）需要过渡——否则下面的内容一帧之内被推开，就是「结构反复横跳」。
// Svelte 的过渡默认是局部的：跟着父块一起创建的元素不播，只有所在的 {#if} / {#each} 自己后来加减的才播，
// 正好对上「晚到」。所以用法就是直接挂：{#each rows as r (r.id)}<div in:grow out:grow>…{/each}。
//
// grow：高度（连同上下内边距、外边距）从 0 长到位，同时淡入——下面的行被平滑推开；离场反过来。
// 只动 height 会逐帧重排，所以只用在一两行、一小组上；整页换内容用 swap（只动 opacity）。
import { DUR, reduced, bezier } from './motion.js';

const STD = bezier(0.2, 0, 0, 1);
const DECEL = bezier(0.05, 0.7, 0.1, 1);

export function grow(node, { duration = DUR.base, delay = 0 } = {}) {
  if (reduced()) return { duration: 0 };
  const cs = getComputedStyle(node);
  const h = node.offsetHeight;
  if (!h) return { duration: 0 };
  const pt = parseFloat(cs.paddingTop) || 0, pb = parseFloat(cs.paddingBottom) || 0;
  const mt = parseFloat(cs.marginTop) || 0, mb = parseFloat(cs.marginBottom) || 0;
  return {
    duration, delay, easing: STD,
    // 透明度比高度慢半拍到位（k²）：先让出位置，内容再显出来，不会在半高时就看清被裁掉的字
    css: (k) => `height:${k * h}px;min-height:0;padding-top:${k * pt}px;padding-bottom:${k * pb}px;margin-top:${k * mt}px;margin-bottom:${k * mb}px;opacity:${k * k};overflow:hidden`,
  };
}

/** 原地换内容（同一块位置上的文字 / 整卡正文换了一版）：只淡入，不动布局。配 {#key 值} 用。 */
export function swap(node, { duration = DUR.quick, delay = 0 } = {}) {
  if (reduced()) return { duration: 0 };
  return { duration, delay, easing: DECEL, css: (k) => `opacity:${k}` };
}
