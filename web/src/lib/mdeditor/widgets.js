// Live Preview 的替换 widget 们：KaTeX 数学、图片、列表标记（圆点/序号/任务框）、分割线、
// 代码块围栏头（语言标签+复制）、callout 卡、双链胶囊。
//（frontmatter「笔记属性」面板在 props.js，表格在 table.js——都是常驻编辑 widget）
// 约定：widget 一律不改文档，改动只经 view.dispatch 走正规变更；ignoreEvent 默认 true
// （事件由 widget 自己处理，CM 不抢），需要 CM 定位光标的（HR/列表标记）显式放行。
import { WidgetType } from '@codemirror/view';
import katex from 'katex';
import { escapeHtml, renderObsInline } from '../obsmd.js';
import { ensureKatex } from '../md.js';
import { t } from '../i18n.js';

// —— KaTeX（渲染结果按公式缓存，上限 300 条）——
const mathCache = new Map();
function katexHtml(tex, display) {
  const key = (display ? 'D' : 'I') + tex;
  let html = mathCache.get(key);
  if (html == null) {
    try { html = katex.renderToString(tex, { throwOnError: false, displayMode: display }); }
    catch { html = '<span class="mde-math-err">' + escapeHtml(tex) + '</span>'; }
    if (mathCache.size > 300) mathCache.clear();
    mathCache.set(key, html);
  }
  return html;
}

// solid=true：未揭示时整块替换 $$…$$ 的那种（揭示态挂在源码下方的预览是 false）
export class MathWidget extends WidgetType {
  constructor(tex, display, solid = false) { super(); this.tex = tex; this.display = display; this.solid = solid; }
  eq(o) { return o.tex === this.tex && o.display === this.display && o.solid === this.solid; }
  toDOM(view) {
    // KaTeX 样式表跟阅读态走同一条懒加载（md.js）：直接在编辑态打开含公式的笔记时，阅读态没渲染过，
    // 样式表还没进来，.katex-mathml 没有隐藏规则，公式连同 MathML 文本显示两遍
    ensureKatex();
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'mde-math mde-math-block' : 'mde-math';
    el.innerHTML = katexHtml(this.tex, this.display);
    if (this.solid) {
      // 整块公式自己接管点击：交给 CM 的话光标落在块边上，那里在 DOM 里没有文字位置，浏览器会把插入点
      // 挪到下一段段首，揭示前打的字插错地方。上半块点 → 块首，下半块点 → 块尾（都会揭示源码）
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', (e) => {
        e.preventDefault();
        let pos;
        try { pos = view.posAtDOM(el); } catch { return; }
        // 光标放进公式内容里（上半块点 → 内容开头，下半块点 → 内容末尾），揭示后直接接着改公式；
        // 放在「$$」外面的话，紧接着打的字会把围栏拆散
        const b = view.lineBlockAt(pos), r = el.getBoundingClientRect();
        const src = view.state.sliceDoc(b.from, b.to);
        const open = src.startsWith('$$\n') ? 3 : 2, close = src.endsWith('\n$$') ? 3 : 2;
        const top = e.clientY < r.top + r.height / 2;
        view.dispatch({ selection: { anchor: top ? Math.min(b.from + open, b.to) : Math.max(b.to - close, b.from) }, scrollIntoView: true });
        view.focus();
      });
    }
    return el;
  }
  // 行内公式/预览：点击交给 CM 置光标到边界→触碰揭示源码；整块公式自己处理
  ignoreEvent() { return this.solid; }
}

// —— 行内 HTML（<kbd>/<sup>/<u>/<mark>/<span style>…，同一行内配成对的白名单标签）——
// 渲染走 obsmd.renderObsInline（DOMPurify 净化，与阅读态同一套）；点它 → CM 把光标放到边界、揭示源码
export class InlineHtmlWidget extends WidgetType {
  constructor(src) { super(); this.src = src; }
  eq(o) { return o.src === this.src; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'mde-html';
    el.innerHTML = renderObsInline(this.src);
    return el;
  }
  ignoreEvent() { return false; }
}

// —— 图片（相对路径已由 resolveUrl 解析）——
// 未揭示时替换 ![](…) 源码；揭示时源码照常显示、图片挂在源码后面（独占一行的图片挂成块，
// 在源码行下方）——点图不会让图消失、下文也不会整块上跳。
// 点图片：光标放到图片语法末尾（揭示源码）。ignoreEvent=true 自己接管：CM 默认把光标放到
// 点击处最近的位置，落在语法开头时揭示后图片会被挤到别处。
// 缩放（Obsidian 同款尺寸语法）：右下角把手拖动只改显示宽度，松手把「|宽」写回源码（已有尺寸就替换、
// 高度去掉保持比例），一次事务、Ctrl+Z 可撤。把手鼠标悬停时出现；揭示态（active，光标在源码里）常显——触屏没有悬停。
const IMG_SRC_RE = /^!\[\[[^\]\n]*\]\]|^!\[[^\]\n]*\]\([^)\n]*\)/;
const IMG_ANY_RE = /!\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g;
// widget DOM 所在处 → 那张图的源码区间：替换态 posAtDOM 落在源码开头，揭示态落在源码末尾（块图在行尾）
function imgRangeAt(view, el) {
  let pos;
  try { pos = view.posAtDOM(el); } catch { return null; }
  const line = view.state.doc.lineAt(pos), rel = pos - line.from;
  let best = null;
  for (const m of line.text.matchAll(IMG_ANY_RE)) {
    const a = m.index, b = a + m[0].length;
    if (a === rel || b === rel) return { from: line.from + a, to: line.from + b };
    if (!best && a <= rel && rel <= b) best = { from: line.from + a, to: line.from + b };
  }
  if (!best && line.text.trim().match(IMG_ANY_RE)?.[0] === line.text.trim()) {   // 块图：整行就是这张图
    const a = line.text.indexOf(line.text.trim());
    best = { from: line.from + a, to: line.from + a + line.text.trim().length };
  }
  return best;
}
// 源码里的尺寸换成 w（0＝去掉尺寸）：![[x|说明|300]] / ![说明|300](x)
export function withImgSize(src, w) {
  const swap = (inner) => {
    const parts = inner.split('|');
    if (parts.length > 1 && /^\d{1,5}(x\d{1,5})?$/.test(parts[parts.length - 1].trim())) parts.pop();
    if (w) parts.push(String(w));
    return parts.join('|');
  };
  let m = /^!\[\[([^\]\n]*)\]\]$/.exec(src);
  if (m) return '![[' + swap(m[1]) + ']]';
  m = /^!\[([^\]\n]*)\]\((.*)\)$/.exec(src);
  if (m) return '![' + swap(m[1]) + '](' + m[2] + ')';
  return null;
}
export class ImageWidget extends WidgetType {
  constructor(src, alt, block = false, w = 0, h = 0, active = false) {
    super(); this.src = src; this.alt = alt || ''; this.block = block; this.w = w; this.h = h; this.active = active;
  }
  eq(o) { return o.src === this.src && o.alt === this.alt && o.block === this.block && o.w === this.w && o.h === this.h && o.active === this.active; }
  toDOM(view) {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = 'mde-imgwrap' + (this.block ? ' mde-imgwrap-block' : '') + (this.active ? ' mde-img-active' : '');
    el.addEventListener('mousedown', (e) => e.preventDefault());   // 不起原生图片拖拽、不抢焦点
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (e.target.closest?.('.mde-img-rs')) return;
      let pos;
      try { pos = view.posAtDOM(el); } catch { return; }
      const { state } = view;
      // 块图挂在源码行后面：posAtDOM 落在行尾之后，光标回到该行行尾即可
      const at = this.block ? state.doc.lineAt(Math.max(0, pos - 1)).to
        : pos + (IMG_SRC_RE.exec(state.sliceDoc(pos, Math.min(state.doc.length, pos + 2000)))?.[0].length || 0);
      view.dispatch({ selection: { anchor: Math.min(at, state.doc.length) } });
      view.focus();
    });
    if (!this.src) { el.className += ' mde-img-broken'; el.textContent = '🖼 ' + (this.alt || t('图片')); return el; }
    const box = document.createElement('span');
    box.className = 'mde-imgbox';
    const img = document.createElement('img');
    img.className = 'mde-img';
    img.alt = this.alt;
    img.loading = 'lazy';
    img.draggable = false;
    if (this.w) img.style.width = this.w + 'px';
    if (this.h) img.style.height = this.h + 'px';
    img.onload = () => view.requestMeasure();
    img.onerror = () => { el.className += ' mde-img-broken'; box.remove(); el.textContent = '🖼 ' + (this.alt || t('加载失败')); view.requestMeasure(); };
    img.src = this.src;
    box.appendChild(img);
    if (!view.state.readOnly) box.appendChild(this.resizer(view, el, img));
    el.appendChild(box);
    return el;
  }
  resizer(view, el, img) {
    const h = document.createElement('span');
    h.className = 'mde-img-rs';
    h.title = t('拖动调整大小');
    h.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      const x0 = e.clientX, w0 = img.getBoundingClientRect().width;
      const max = Math.max(40, (view.contentDOM.clientWidth || w0) - 8);
      let w = Math.round(w0), moved = false;
      try { h.setPointerCapture(e.pointerId); } catch {}
      el.classList.add('mde-img-resizing');
      const move = (ev) => {
        if (Math.abs(ev.clientX - x0) > 2) moved = true;
        w = Math.round(Math.min(max, Math.max(40, w0 + ev.clientX - x0)));
        img.style.width = w + 'px';
        img.style.height = 'auto';
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        el.classList.remove('mde-img-resizing');
        if (!moved || view.state.readOnly) { img.style.width = this.w ? this.w + 'px' : ''; img.style.height = this.h ? this.h + 'px' : ''; return; }
        const r = imgRangeAt(view, el);
        const next = r && withImgSize(view.state.sliceDoc(r.from, r.to), w);
        if (!next) return;
        view.dispatch({ changes: { from: r.from, to: r.to, insert: next }, userEvent: 'input.resize' });
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
    return h;
  }
  get estimatedHeight() { return this.block ? 200 : -1; }
}

// —— 列表标记：圆点 / 序号 / 任务框 ——
// Live Preview 里「缩进空白 + 标记 + 其后空白」整段换成这个 widget（livePreview.js 的列表 pass），
// 占一个 24px 标记槽（= 阅读态 ul/ol 的 1.5em），行装饰按层级给 padding 与负 text-indent 做悬挂缩进。
// 几何照 Chromium 画 ::marker 的办法复刻（ListMarker::RelativeSymbolMarkerRect）：圆点 5px、
// 左缘距正文 17px、底边在基线上 2px；序号是同字体同字号的「1. 」右对齐——与阅读态逐像素一致。
//   kind: 'ul'（shape: disc/circle/square，按 ul 嵌套层级，同 UA 样式表）| 'ol'（text=源码标记+空格）
//         | 'task'（勾选框进标记槽）| 'box'（有序任务：序号占槽，勾选框跟在正文前）
export class ListMarkWidget extends WidgetType {
  constructor(kind, text = '', shape = 'disc', checked = false) {
    super(); this.kind = kind; this.text = text; this.shape = shape; this.checked = checked;
  }
  eq(o) { return o.kind === this.kind && o.text === this.text && o.shape === this.shape && o.checked === this.checked; }
  toDOM(view) {
    const s = document.createElement('span');
    s.className = 'mde-lm mde-lm-' + this.kind;
    if (this.kind === 'ol') s.textContent = this.text;
    else if (this.kind === 'ul') {
      const d = document.createElement('span');
      d.className = 'mde-lm-dot mde-lm-' + this.shape;
      s.appendChild(d);
    } else s.appendChild(taskBox(view, this.checked, s));
    return s;
  }
  // 圆点/序号放行：点它→CM 把光标放到标记旁→livePreview 的光标夹紧挪到正文起点；任务框自己处理点击
  ignoreEvent() { return this.kind === 'task' || this.kind === 'box'; }
}

// 任务勾选框（点按切换 [ ]/[x]，经 dispatch 改文档）。widget 从缩进/标记处开始，勾选框
// 在其后若干字符——从 widget 起点往后找第一个 [ ]/[x] 再改那一位，找不到就放弃（绝不写坏）。
function taskBox(view, checked, host) {
  const box = document.createElement('span');
  box.className = 'mde-task' + (checked ? ' on' : '');
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', String(checked));
  // 对勾用 CSS 画（editor.css 的 .mde-task.on::after），与阅读态 input.task-cb:checked::after 同一套几何
  box.addEventListener('mousedown', (e) => e.preventDefault());   // 勾一下不抢焦点、不挪光标
  box.addEventListener('click', (e) => {
    e.preventDefault();
    if (view.state.readOnly) return;
    let pos;
    try { pos = view.posAtDOM(host); } catch { return; }
    // widget 从行首缩进算起（深层任务的缩进可以很长），找到本行末为止
    const m = /\[([ xX])\]/.exec(view.state.sliceDoc(pos, view.state.doc.lineAt(pos).to));
    if (!m) return;
    const at = pos + m.index + 1;
    view.dispatch({ changes: { from: at, to: at + 1, insert: /x/i.test(m[1]) ? ' ' : 'x' }, userEvent: 'input.toggle' });
  });
  return box;
}

// —— 分割线 ---（点击→光标进行揭示源码）——
export class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'mde-hr';
    return el;
  }
  ignoreEvent() { return false; }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
}

// —— 代码块围栏头：语言标签 + 复制按钮（替换开围栏行）——
export class FenceHeadWidget extends WidgetType {
  constructor(lang, getCode) { super(); this.lang = lang || ''; this.getCode = getCode; }
  eq(o) { return o.lang === this.lang; }
  toDOM(view) {
    const el = document.createElement('span');
    el.className = 'mde-fencehead';
    const lang = document.createElement('span');
    lang.className = 'mde-fencelang';
    lang.textContent = this.lang;
    const copy = document.createElement('button');
    copy.className = 'mde-fencecopy';
    copy.type = 'button';
    copy.textContent = t('复制');
    copy.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      await copyText(this.getCode());
      copy.textContent = t('已复制');
      setTimeout(() => (copy.textContent = t('复制')), 1200);
    });
    // 点标签区（非复制键）→ 光标到围栏行首，揭示源码
    lang.addEventListener('click', () => {
      const pos = view.posAtDOM(el);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    el.appendChild(lang); el.appendChild(copy);
    return el;
  }
}

// —— callout 卡（整块替换；HTML 由 opts.renderMd（obsmd）生成，与阅读模式同观感）——
export class CalloutWidget extends WidgetType {
  constructor(src, opts) { super(); this.src = src; this.opts = opts; }
  eq(o) { return o.src === this.src; }
  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'mde-callout-w';
    try { el.innerHTML = this.opts.renderMd(this.src); } catch { el.textContent = this.src; }
    // 卡里的代码块补「语言 + 复制」头：阅读态 DocViewer 会补，编辑态不补的话两态卡高差 22px
    for (const pre of el.querySelectorAll('pre:not(.indented)')) {
      const code = pre.querySelector('code');
      const lang = (String(code?.className || '').match(/language-([\w+#-]+)/) || [])[1] || '';
      const head = document.createElement('div');
      head.className = 'mde-fencehead mde-co-fence';
      head.innerHTML = '<span class="mde-fencelang"></span><button type="button" class="mde-fencecopy"></button>';
      head.firstChild.textContent = lang;
      head.lastChild.textContent = t('复制');
      head.lastChild.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        await copyText(code?.textContent || '');
        head.lastChild.textContent = t('已复制');
        setTimeout(() => (head.lastChild.textContent = t('复制')), 1200);
      });
      pre.insertBefore(head, pre.firstChild);
    }
    wireEmbeddedLinks(el, view, this.opts);
    // 点卡片 → 展开源码编辑，光标尽量落在点中的那几个字旁边：取点击处前后各一小段渲染文字，
    // 回源码里找（源码多了「> 」与格式标记，找不到就退回块首）
    el.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input')) return;
      let base;
      try { base = view.posAtDOM(el); } catch { return; }
      view.dispatch({ selection: { anchor: base + locateInSource(this.src, e) }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
  get estimatedHeight() { return 60; }
}

// 渲染卡片里的点击点 → 源码内偏移（找不到返回 0）
function locateInSource(src, e) {
  const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  const node = r?.startContainer;
  if (!node || node.nodeType !== 3) return 0;
  const text = node.textContent || '', o = r.startOffset;
  const before = text.slice(Math.max(0, o - 12), o), after = text.slice(o, o + 12);
  let i;
  if (before && after && (i = src.indexOf(before + after)) >= 0) return i + before.length;
  if (after.trim() && (i = src.indexOf(after)) >= 0) return i;
  if (before.trim() && (i = src.indexOf(before)) >= 0) return i + before.length;
  return 0;
}

// —— 双链胶囊（[[目标|别名]] 渲染态；点按导航）——
export class WikilinkWidget extends WidgetType {
  constructor(target, head, alias, embed, opts) {
    super();
    this.target = target; this.head = head; this.alias = alias; this.embed = embed; this.opts = opts;
  }
  eq(o) { return o.target === this.target && o.head === this.head && o.alias === this.alias && o.embed === this.embed; }
  toDOM() {
    const a = document.createElement('a');
    a.className = 'mde-wk' + (this.embed ? ' mde-wk-embed' : '');
    a.textContent = this.alias || (this.target ? this.target + (this.head ? ' › ' + this.head : '') : this.head);
    // 按下就拦默认动作：否则浏览器先把光标落到「[[」前面、揭示成源码，同时又跳转
    a.addEventListener('mousedown', (e) => e.preventDefault());
    a.addEventListener('click', (e) => {
      e.preventDefault();
      this.opts.onNavigate?.(this.target, this.head);
    });
    return a;
  }
  ignoreEvent() { return true; }
}

// widget 内嵌 HTML 里的链接接管：a.wk → 双链导航；外链 → openLink；拦掉默认跳转
export function wireEmbeddedLinks(root, view, opts) {
  root.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || !root.contains(a)) return;
    e.preventDefault();
    e.stopPropagation();
    if (a.classList.contains('wk')) {
      const name = a.dataset.wk || '', head = a.dataset.head || '';
      opts.onNavigate?.(name, head);
      return;
    }
    const href = a.getAttribute('href') || '';
    if (/^(https?:|mailto:|tel:)/i.test(href)) opts.openLink?.(href);
  });
}
