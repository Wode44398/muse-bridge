// 手机整页形态顶栏的标签密度：按扣掉返回钮后的净宽三档——
// 'all' 全显图标与短词，'active' 只有选中那项显短词，'icon' 纯图标；中英文都不溢出。
export function tabMode(availWidth, toolCount) {
  const n = Math.max(1, Number(toolCount) || 1);
  const w = Number(availWidth) || 0;
  if (w >= n * 82) return 'all';
  if (w >= (n - 1) * 32 + 96) return 'active';
  return 'icon';
}
