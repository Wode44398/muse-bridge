// 滚动边缘（方案 §12）：内容滚进标题 / 顶栏下面时化开，不被一刀切掉（iOS 26 scroll edge effect 同一个意思）。
// 按滚动位置往节点上写 --fe-t / --fe-b，配合 studio.css 的 `.studio-root .fe` 遮罩：
//   停在顶上时 --fe-t 为 0（卡片上沿的圆角原样露着），一滚就跟着长到满；底边同理，下面没东西了就收掉。
// 只改遮罩，不动布局；滚动、尺寸变化、内容增减都会重算（一帧一次）。
// 用法：<div use:edgeFade={{ top: 22, bot: 26 }}>；bot: 0 表示不管底边（底下另有渐隐，比如输入栏的纸色渐变）。
export function edgeFade(node, opts = {}) {
  let { top = 22, bot = 24 } = opts;
  let raf = 0;
  node.classList.add('fe');
  const set = () => {
    raf = 0;
    const st = node.scrollTop, rest = node.scrollHeight - node.clientHeight - st;
    // 先走 2px 再开始化（轻轻一碰不出边），之后按滚动距离长满
    node.style.setProperty('--fe-t', Math.max(0, Math.min(top, (st - 2) * 0.9)).toFixed(1) + 'px');
    node.style.setProperty('--fe-b', (bot ? Math.max(0, Math.min(bot, rest * 0.9)) : 0).toFixed(1) + 'px');
  };
  const q = () => { if (!raf) raf = requestAnimationFrame(set); };
  node.addEventListener('scroll', q, { passive: true });
  const ro = new ResizeObserver(q); ro.observe(node);
  const mo = new MutationObserver(q); mo.observe(node, { childList: true, subtree: true });
  set();
  return {
    update(o = {}) { top = o.top ?? 22; bot = o.bot ?? 24; q(); },
    destroy() { node.removeEventListener('scroll', q); ro.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf); node.classList.remove('fe'); },
  };
}
