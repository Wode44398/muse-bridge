// 浮层横向兜底（use:clampX）——
// 输入栏上方那几个弹层（模型菜单 / Effort 卡 / 额度卡）都是 absolute + 贴着触发芯片的
// 某一侧展开。芯片本身不在屏幕边缘时，宽度固定的弹层就会整块探出视口：折叠屏分屏、
// 桌面小窗（≤260px 可用宽）下模型菜单左半截直接被切掉。
// 挂上这个 action：渲染后量一次自身 rect，越界就顺着自己的锚定边（left/right）平移回
// 视口内。用定位属性而不是 transform——ModelPicker 的入场动画就跑在 transform 上，
// 两者会打架。窗口尺寸变化再量一次。
// 参数：数字=pad；对象={ anchor:'left'|'right', pad }。
// 【坑】锚定边不能靠 getComputedStyle(node).right === 'auto' 判：CSSOM 对 positioned 元素的
// top/right/bottom/left 一律返回【使用值】（px），永远不是 'auto'，所以左锚（left:0）的弹层
// 会被误判成右锚、改的是 right——left 与 right 同时给定时 LTR 下 right 被忽略，等于没动
//（额度环弹层在手机上右半截探出屏幕就是这么来的，2026-09-01）。左锚的调用方显式传 anchor。
export function clampX(node, opts = 8) {
  const o = typeof opts === 'number' ? { pad: opts } : (opts || {});
  const pad = o.pad ?? 8;
  const anchorLeft = o.anchor ? o.anchor === 'left' : getComputedStyle(node).right === 'auto';
  const prop = anchorLeft ? 'left' : 'right';
  const fit = () => {
    node.style[prop] = '';                       // 先还原成 CSS 原值再量，避免逐次累加
    const r = node.getBoundingClientRect();
    const w = window.innerWidth;
    let dx = 0;
    if (r.left < pad) dx = pad - r.left;
    else if (r.right > w - pad) dx = w - pad - r.right;
    if (!dx) return;
    const base = parseFloat(getComputedStyle(node)[prop]) || 0;
    node.style[prop] = Math.round(base + (anchorLeft ? dx : -dx)) + 'px';
  };
  fit();
  window.addEventListener('resize', fit);
  return { destroy() { window.removeEventListener('resize', fit); } };
}
