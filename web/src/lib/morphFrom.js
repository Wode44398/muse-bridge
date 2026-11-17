// 容器变形入场：一个大窗口从发起它的那块小面板（菜单）原地长出来，而不是另起一段居中淡入。
//
// 用法：<div class="panel" use:morphFrom={from}>，from = { x, y, w, h, r }（起点矩形的视口坐标与圆角），不给就什么都不做
//       （照旧走它自己的 CSS 入场）。只管入场；出场照旧。
//
// 怎么动：
//  · 窗口挂上时已在终态排好版。先停掉它自己的 CSS 入场动画（否则量到的是缩放 / 位移中的矩形，两段动画还会叠在一起），
//    量出终态矩形，再用 clip-path 把它裁成起点那块大小：起点落在终态里面就原地裁（窗口真从菜单那块地方长出来），
//    伸出去的那一截用位移补齐。裁切框沿一条近临界阻尼的弹簧扩到整块，圆角从菜单的圆角过渡到窗口自己的圆角。
//  · 窗口底色在前 90ms 显出来（与菜单玻璃的淡出交叉）；内容等框扩到四成再淡入、轻轻上浮——早了边缘会切着半截字。
//  · 外面那层罩（.ov-scrim）原本整层 opacity 淡入，窗口是它的孩子，会跟着几乎透明、看不见「长出来」那一段：
//    改成只淡罩的底色，窗口自己不透明。
//  · clip-path 会把投影一起裁掉：变形期间不画投影，落定后投影淡入（像窗口落到纸面上）。
//  · 减弱动效：直接出现（不裁、不淡）。
import { springCurve, reduced } from './motion.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function morphFrom(node, from) {
  if (!from || !(from.w > 0) || !(from.h > 0) || typeof node.animate !== 'function') return;
  if (reduced()) return;
  // 先停掉它自己的入场（.ov-panel / 窄屏推入），再量终态
  node.style.animation = 'none';
  const F = node.getBoundingClientRect();
  if (!F.width || !F.height) { node.style.animation = ''; return; }
  const cs = getComputedStyle(node);
  const Rf = parseFloat(cs.borderTopLeftRadius) || 0;
  const shadow = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : '';
  const ow = Math.min(from.w, F.width), oh = Math.min(from.h, F.height);
  const L = clamp(from.x - F.left, 0, F.width - ow), T = clamp(from.y - F.top, 0, F.height - oh);
  const tx = from.x - F.left - L, ty = from.y - F.top - T;
  const R = F.width - L - ow, B = F.height - T - oh;
  const r0 = clamp(from.r || 0, 0, Math.min(ow, oh) / 2);

  const { easing, duration } = springCurve({ stiffness: 290, damping: 33 });
  const d = Math.min(Math.max(duration, 420), 640);
  const anims = [];
  const scrim = node.parentElement;
  // 外层是盖满屏的罩（宽屏 .ov-scrim；窄屏没有那个类、底色却是当场亮出来的）：只淡它的底色
  if (scrim && getComputedStyle(scrim).position === 'fixed') {
    const bg = getComputedStyle(scrim).backgroundColor;
    if (scrim.classList.contains('ov-scrim')) scrim.style.animation = 'none';
    anims.push(scrim.animate([{ backgroundColor: 'rgba(0, 0, 0, 0)' }, { backgroundColor: bg }], { duration: 280, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'backwards' }));
  }
  node.style.boxShadow = 'none';
  const grow = node.animate([
    { clipPath: `inset(${T}px ${R}px ${B}px ${L}px round ${r0}px)`, transform: `translate(${tx}px, ${ty}px)` },
    { clipPath: `inset(0px 0px 0px 0px round ${Rf}px)`, transform: 'translate(0px, 0px)' },
  ], { duration: d, easing, fill: 'backwards' });
  anims.push(grow);
  anims.push(node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90, easing: 'linear', fill: 'backwards' }));
  // 内容晚一拍：底色先成形，字等框扩开一些再出来（不然起点那一小块里挤着半截表单）
  const kids = [...node.children];
  for (const k of kids) {
    anims.push(k.animate([
      { opacity: 0, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'translateY(0px)' },
    ], { duration: 260, delay: Math.round(d * 0.42), easing: 'cubic-bezier(.05,.7,.1,1)', fill: 'backwards' }));
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    // animation 保持 none：清掉的话 CSS 入场动画会从头再放一遍（出场走的是 .closing 的过渡，不受影响）
    node.style.boxShadow = '';
    // 投影落定后淡入（变形期间被 clip-path 裁掉了）
    if (shadow && node.isConnected) node.animate([{ boxShadow: 'none' }, { boxShadow: shadow }], { duration: 200, easing: 'cubic-bezier(.4,0,.6,1)' });
  };
  grow.finished.then(finish, finish);
  return {
    destroy() {
      for (const a of anims) a.cancel();
    },
  };
}
