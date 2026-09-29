// Live Preview 的替换 widget 们：KaTeX 数学、图片、任务勾选框、分割线、
// 代码块围栏头（语言标签+复制）、callout 卡、双链胶囊。
//（frontmatter「笔记属性」面板在 props.js，表格在 table.js——都是常驻编辑 widget）
// 约定：widget 一律不改文档，改动只经 view.dispatch 走正规变更；ignoreEvent 默认 true
// （事件由 widget 自己处理，CM 不抢），需要 CM 定位光标的（图片/HR）显式放行。
import { WidgetType } from '@codemirror/view';
import katex from 'katex';
import { escapeHtml } from '../obsmd.js';
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

export class MathWidget extends WidgetType {
  constructor(tex, display) { super(); this.tex = tex; this.display = display; }
  eq(o) { return o.tex === this.tex && o.display === this.display; }
  toDOM() {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'mde-math mde-math-block' : 'mde-math';
    el.innerHTML = katexHtml(this.tex, this.display);
    return el;
  }
  ignoreEvent() { return false; }   // 点击→CM 置光标到边界→触碰揭示源码
}

// —— 图片（相对路径已由 resolveUrl 解析）——
export class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt || ''; }
  eq(o) { return o.src === this.src && o.alt === this.alt; }
  toDOM(view) {
    const el = document.createElement('span');
    el.className = 'mde-imgwrap';
    if (!this.src) { el.className += ' mde-img-broken'; el.textContent = '🖼 ' + (this.alt || t('图片')); return el; }
    const img = document.createElement('img');
    img.className = 'mde-img';
    img.alt = this.alt;
    img.loading = 'lazy';
    img.onload = () => view.requestMeasure();
    img.onerror = () => { el.className += ' mde-img-broken'; img.remove(); el.textContent = '🖼 ' + (this.alt || t('加载失败')); view.requestMeasure(); };
    img.src = this.src;
    el.appendChild(img);
    return el;
  }
  ignoreEvent() { return false; }
}

// —— 任务勾选框（点按切换 [ ]/[x]，经 dispatch 改文档）——
export class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM(view) {
    const box = document.createElement('span');
    box.className = 'mde-task' + (this.checked ? ' on' : '');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    box.addEventListener('click', (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      const pos = view.posAtDOM(box);
      const mark = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(mark)) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
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
      const text = this.getCode();
      try { await navigator.clipboard.writeText(text); } catch {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch {}
        ta.remove();
      }
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
    wireEmbeddedLinks(el, view, this.opts);
    // 点空白处 → 光标进块首，展开源码编辑
    el.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input')) return;
      const pos = view.posAtDOM(el);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
  get estimatedHeight() { return 60; }
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
    a.addEventListener('click', (e) => {
      e.preventDefault();
      this.opts.onNavigate?.(this.target, this.head);
    });
    return a;
  }
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
