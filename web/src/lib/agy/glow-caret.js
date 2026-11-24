// agy 输入框的「尾焰光标」（11-19）：官网 antigravity.google hero 打字光标的复刻——上蓝下彩、尾部散开，
// 下半截彩虹缓缓流动；闪烁照系统 1060ms 硬闪（demo：前端设计/agy-caret/v5-官方对比.html 的 B2）。
// 原生光标用 caret-color: transparent 藏起来，由这里画的 .agy-caret 接管；形状与动画全在 theme.css。
// 定位：1em = 字形高（font-size 设成它，同原生光标），水平以插入点为中心。
// 用法：<textarea use:glowCaret>，textarea 的直接父元素必须是定位容器（如 .agy-input-wrap）。样式在 theme.css。

const COPY = [
  'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariationSettings',
  'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'tabSize',
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

  // 镜像 div：零宽标记的矩形 = 原生光标的位置与高度（字形内容区，不是行高）
  const mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    top: '0', left: '-9999px', borderStyle: 'solid', borderColor: 'transparent', pointerEvents: 'none',
  });
  document.body.appendChild(mirror);
  const mark = document.createElement('span');
  mark.textContent = '​';

  let raf = 0;
  function measure() {
    const cs = getComputedStyle(ta);
    for (const k of COPY) mirror.style[k] = cs[k];
    mirror.style.width = ta.clientWidth + 'px';
    const pos = ta.selectionEnd;
    mirror.textContent = ta.value.slice(0, pos);
    mirror.appendChild(mark);
    mirror.appendChild(document.createTextNode(ta.value.slice(pos)));
    const m = mirror.getBoundingClientRect();
    const r = mark.getClientRects()[0] || mark.getBoundingClientRect();
    return { x: r.left - m.left, y: r.top - m.top - ta.scrollTop, h: r.height };
  }

  function place() {
    raf = 0;
    if (document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) {
      caret.classList.add('hidden');
      return;
    }
    const { x, y, h } = measure();
    // 光标在 cbox 里的位置（absolute 以内边距盒为基准）；超出 textarea 可视区就藏
    const left = ta.offsetLeft + x;
    const top = ta.offsetTop + y;
    if (y + h < 0 || y > ta.clientHeight) { caret.classList.add('hidden'); return; }
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
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  ro?.observe(ta);
  ro?.observe(box);
  document.fonts?.ready?.then(schedule);

  return {
    // value 变化（外部改了草稿，如选斜杠命令）时重新定位
    update: schedule,
    destroy() {
      cancelAnimationFrame(raf);
      for (const e of evs) ta.removeEventListener(e, schedule);
      document.removeEventListener('selectionchange', onSel);
      ro?.disconnect();
      caret.remove();
      mirror.remove();
      box.classList.remove('cv-on');
    },
  };
}
