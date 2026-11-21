// 一行放不下就把字号缩到正好放得下（stat 积木的数值用）。
// 不在 CSS 里按字符估宽：粗体 tabular 数字、¥、逗号小数点在各平台字体里宽度差得多，估小了数字就从中间折行
// （「¥12,000.0 / 0」第一行单独看像另一个数），所以量实际排出来的宽度。

/**
 * 放得下的字号（px）：natural 是按 max 字号排成一行的宽度，avail 是可用宽度。
 * 留 3% 余量、向下取到 0.5px——量出来的宽度是取整的，字号缩放后字形宽度也不是严格等比。
 * 最小 min：缩到 min 还放不下就交给折行。
 */
export function fitFontSize({ max, min = 15, avail, natural }) {
  if (!(max > 0) || !(avail > 0) || !(natural > 0) || natural <= avail) return max;
  const px = Math.floor((max * avail / natural) * 0.97 * 2) / 2;
  return Math.max(Math.min(min, max), Math.min(max, px));
}

// Svelte action：use:fitText={{ min, key }}。CSS 给的 font-size 当上限；key 变了（值换了）或宽度变了就重量。
// 量法：清掉自己设的字号、临时不折行，读 scrollWidth 对 clientWidth。
export function fitText(node, opts = {}) {
  let o = opts || {};
  let lastW = -1, alive = true;
  const fit = () => {
    if (!alive) return;
    const w = node.clientWidth;
    lastW = w;
    if (!w) return;
    node.style.fontSize = '';
    node.style.whiteSpace = 'nowrap';
    const max = parseFloat(getComputedStyle(node).fontSize) || 0;
    const natural = node.scrollWidth;
    node.style.whiteSpace = '';
    const px = fitFontSize({ max, min: o.min ?? 15, avail: w, natural });
    if (px < max) node.style.fontSize = px + 'px';
  };
  // 字号变了高度跟着变，也会触发观察；只认宽度变化，免得来回量
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (node.clientWidth !== lastW) fit(); }) : null;
  ro?.observe(node);
  fit();
  // 网页字体晚到时宽度会变，到了再量一次
  document.fonts?.ready?.then(fit, () => {});
  return {
    update(next) { o = next || {}; queueMicrotask(fit); },
    destroy() { alive = false; ro?.disconnect(); },
  };
}
