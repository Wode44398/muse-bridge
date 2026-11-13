// 模拟安卓 WebView 跟随系统字号（apk 没调 setTextZoom，WebView 的 textZoom = 系统字体缩放）。
// WebView 的 textZoom 走的是 Blink 的 TextZoomFactor：所有计算后的 font-size 乘上系数，px 写死的 line-height 也乘
// （StyleBuilderConverter::ConvertLineHeight 的换算带 TextZoomFactor），px 写的宽高、内距不变——
// 所以「字变大了、框没变大」的溢出只有这样才测得出来。CDP 没有对应开关（Page.setFontSizes 只改默认字号，
// Studio 全是 px 字号，等于没测），这里改写 CSSOM：每条规则里 font-size / line-height 的 px（和关键字字号）乘系数，
// 根元素默认 16px 也乘；em / rem / % 是相对值，跟着放大，不重复乘。新插进来的样式表（懒加载的页面、HMR）定时补上。
export function textZoomScript(factor) {
  return `(() => {
  const F = ${Number(factor)};
  if (!(F > 0) || F === 1) return;
  window.__qaTextZoom = F;
  const done = new WeakSet();
  const ABS = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
  const scalePx = (v) => v.replace(/(-?\\d*\\.?\\d+)px/g, (m, n) => +(parseFloat(n) * F).toFixed(3) + 'px');
  function fix(st) {
    if (!st) return;
    const fs = st.getPropertyValue('font-size');
    if (fs) {
      const k = fs.trim();
      const nv = /px/.test(k) ? scalePx(k) : ABS[k] ? ABS[k] * F + 'px' : k;
      if (nv !== k) st.setProperty('font-size', nv, st.getPropertyPriority('font-size'));
    }
    const lh = st.getPropertyValue('line-height');
    if (lh && /px/.test(lh)) st.setProperty('line-height', scalePx(lh.trim()), st.getPropertyPriority('line-height'));
    // 字号令牌（--sd-fs-*、--fs-* 这类自定义属性）：font-size: var(--sd-fs-md) 不是 px 字面量，上面那条改不到，
    // 真机 TextZoom 乘的是计算后的字号、照样放大——令牌本身乘一次（2026-11-06：v3 改用字号令牌后 130% 档截图和 100% 逐字节相同，复核发现的）
    for (let i = 0; i < st.length; i++) {
      const p = st[i];
      if (!/^--[a-z0-9-]*(fs|font-size)[a-z0-9-]*$/.test(p)) continue;
      const v = st.getPropertyValue(p);
      if (v && /px/.test(v)) st.setProperty(p, scalePx(v.trim()), st.getPropertyPriority(p));
    }
  }
  function walk(rules) {
    for (const r of rules || []) {
      if (r.style) fix(r.style);
      if (r.cssRules && r.cssRules.length) walk(r.cssRules);
    }
  }
  function run() {
    for (const sh of document.styleSheets) {
      if (done.has(sh)) continue;
      try { walk(sh.cssRules); done.add(sh); } catch { /* 跨源或还没加载完，下一轮再试 */ }
    }
    for (const el of document.querySelectorAll('[style*="font-size"],[style*="line-height"]')) {
      if (el.__qaTz === el.getAttribute('style')) continue;
      fix(el.style); el.__qaTz = el.getAttribute('style');
    }
  }
  const root = document.createElement('style');
  root.textContent = ':where(html){font-size:' + 16 * F + 'px}';
  const boot = () => { (document.head || document.documentElement).prepend(root); done.add(root.sheet); run(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
  new MutationObserver(() => queueMicrotask(run)).observe(document, { childList: true, subtree: true, characterData: true });
  setInterval(run, 300);
})();`;
}
