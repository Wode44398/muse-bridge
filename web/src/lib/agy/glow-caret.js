// agy 输入框的「尾焰光标」（11-19）：官网 antigravity.google hero 打字光标的复刻——上蓝下彩、尾部散开，
// 下半截彩虹缓缓流动；闪烁照系统 1060ms 硬闪（demo：前端设计/agy-caret/v5-官方对比.html 的 B2）。
// 原生光标用 caret-color: transparent 藏起来，由这里画的 .agy-caret 接管；形状与动画全在 theme.css。
// 定位：1em = 字形高（font-size 设成它，同原生光标），水平以插入点为中心。
// 用法：<textarea use:glowCaret>，textarea 的直接父元素必须是定位容器（如 .agy-input-wrap）。样式在 theme.css。

const COPY = [
  'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariationSettings',
  'fontFeatureSettings', 'fontKerning', 'fontVariantLigatures', 'fontVariantNumeric',
  'fontVariantEastAsian', 'fontVariantCaps', 'fontOpticalSizing',
  'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'tabSize',
  'wordBreak', 'overflowWrap', 'lineBreak', 'whiteSpace', 'hyphens',
  'direction', 'unicodeBidi', 'textRendering', 'textAlign',
];

export function glowCaret(ta) {
  const box = ta.parentElement;
  if (!box || typeof CSS === 'undefined' || !CSS.supports?.('color', 'color-mix(in srgb, red 50%, blue)')) return {};

  const caret = document.createElement('div');
  caret.className = 'agy-caret hidden';
  caret.setAttribute('aria-hidden', 'true');
  caret.innerHTML = '<i class="fl"></i>';
  box.appendChild(caret);
  box.classList.add('cv-on');

  // 镜像 div：按 textarea 亚像素真宽复刻折行，优先在完整单文本节点上用折叠 Range 测光标矩形
  const mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    top: '0', left: '-9999px', borderStyle: 'solid', borderColor: 'transparent', pointerEvents: 'none',
  });
  document.body.appendChild(mirror);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';

  let raf = 0;
  function measure() {
    const cs = getComputedStyle(ta);
    for (const k of COPY) mirror.style[k] = cs[k];
    const lang = ta.closest('[lang]')?.lang;
    if (lang) mirror.lang = lang;
    else mirror.removeAttribute('lang');

    // 用 getComputedStyle.width（亚像素真值，不受祖先 transform 缩放影响）替代四舍五入的 ta.clientWidth：
    // 1.5x 等非整数 DPR 下外框 1px 边框会折算成 0.667px，导致 textarea 实宽带小数（如 526.67px）；
    // clientWidth 取整为 527px 会让镜像比 textarea 多塞进 1 个字，光标在下一行整字错位。
    // 同时扣除真实竖向滚动条占宽（有滚动条时 offsetWidth - clientWidth - 边框 >= 2px）。
    const csW = parseFloat(cs.width);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const rawSb = ta.offsetWidth - ta.clientWidth - (bl + br);
    const sb = rawSb >= 2 ? Math.round(rawSb) : 0;
    const width = Number.isFinite(csW) && csW > 0 ? Math.max(0, csW - sb) : ta.clientWidth;
    mirror.style.width = width + 'px';

    const val = ta.value;
    const pos = Math.min(val.length, Math.max(0, ta.selectionEnd ?? val.length));
    // 优先在未切分的单文本节点上用折叠 Range 测量：避免插入 \u200b 产生假折行点，
    // 防止光标位于已折行英文词中间或中文标点（如全角逗号）前时被提前断到上一行。
    mirror.textContent = val;
    const m = mirror.getBoundingClientRect();
    let r = null;
    const tn = mirror.firstChild;
    if (tn && tn.nodeType === 3 && val.length > 0 && !(pos > 0 && val[pos - 1] === '\n')) {
      const range = document.createRange();
      range.setStart(tn, pos);
      range.setEnd(tn, pos);
      const rects = range.getClientRects();
      if (rects.length && rects[0].height > 0) r = rects[0];
    }
    if (!r) {
      mirror.textContent = val.slice(0, pos);
      mirror.appendChild(mark);
      mirror.appendChild(document.createTextNode(val.slice(pos)));
      r = mark.getClientRects()[0] || mark.getBoundingClientRect();
    }
    return {
      x: r.left - m.left - ta.scrollLeft,
      y: r.top - m.top - ta.scrollTop,
      h: r.height,
    };
  }

  function place() {
    raf = 0;
    if (document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) {
      caret.classList.add('hidden');
      return;
    }
    const { x, y, h } = measure();
    // 光标在容器里的位置（absolute 以内边距盒为基准）；超出 textarea 可视区就藏
    const left = ta.offsetLeft + x;
    const top = ta.offsetTop + y;
    if (!(h > 0) || y + h <= 0 || y >= ta.clientHeight) { caret.classList.add('hidden'); return; }
    // 高 = 字形高（同原生光标）；整行高会比字高出一截、看着粗重（11-19 维护者：手机上太浓重）
    const W = Math.max(h * 0.187, 8);
    caret.style.fontSize = h + 'px';
    caret.style.setProperty('--x', (left - W / 2) + 'px');
    caret.style.setProperty('--y', top + 'px');
    // 原生行为：一有输入 / 挪动就立刻常亮、闪烁从头计时
    caret.classList.remove('hidden');
    caret.style.animation = 'none';
    void caret.offsetWidth;
    caret.style.animation = '';
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(place); };
  const onSel = () => { if (document.activeElement === ta) schedule(); };

  const evs = ['focus', 'blur', 'input', 'scroll', 'compositionstart', 'compositionupdate', 'compositionend'];
  for (const e of evs) ta.addEventListener(e, schedule);
  document.addEventListener('selectionchange', onSel);
  window.addEventListener('resize', schedule);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  ro?.observe(ta);
  ro?.observe(box);
  document.fonts?.ready?.then(schedule);
  if (document.activeElement === ta) schedule();

  return {
    // value 变化（外部改了草稿，如选斜杠命令）时重新定位
    update: schedule,
    destroy() {
      cancelAnimationFrame(raf);
      for (const e of evs) ta.removeEventListener(e, schedule);
      document.removeEventListener('selectionchange', onSel);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      caret.remove();
      mirror.remove();
      box.classList.remove('cv-on');
    },
  };
}
