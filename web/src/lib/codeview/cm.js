// 代码 / 文本查看器内核（CM6）：默认只读，能切编辑；行号、当前行、折叠、自动换行、语法高亮（按扩展名懒加载语言）、
// 查找（高亮全部命中 + 计数 + 上下一个，区分大小写 / 正则 / 全字）、跳到行、日志级别着色、字号缩放。
// 对标 VS Code 只读预览与 GitHub 文件页。查找不用 @codemirror/search（没装、它的面板也不合本站外观）：
// 命中位置全篇算一次（上限 MAX_HITS），装饰只铺可见区，10MB 文档滚动不掉帧。
//
// 外观走 doctheme 的 --md-* 令牌（跟随明暗主题），配色类名 cvh-* 由 CodeView.svelte 着色。

import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap, Decoration, ViewPlugin, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { EditorState, Compartment, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { LanguageDescription, StreamLanguage, HighlightStyle, syntaxHighlighting, foldGutter, foldKeymap, bracketMatching } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { tags as T } from '@lezer/highlight';

import { MAX_HITS, findAll, looksLikeLog, LV_ERR, LV_WARN, LV_DIM, TS } from './textutil.js';
import { viewerSvg } from '../viewerIcons.js';

export { MAX_HITS, findAll, looksLikeLog };

// —— 语法配色：类名 → CodeView.svelte 里按 --md-c-* 着色 ——
const hl = HighlightStyle.define([
  { tag: [T.keyword, T.controlKeyword, T.moduleKeyword, T.operatorKeyword, T.definitionKeyword, T.modifier, T.self], class: 'cvh-kw' },
  { tag: [T.string, T.special(T.string), T.character, T.docString, T.attributeValue, T.inserted], class: 'cvh-str' },
  { tag: [T.number, T.bool, T.atom, T.null, T.unit, T.changed], class: 'cvh-num' },
  { tag: [T.function(T.variableName), T.function(T.propertyName), T.macroName, T.meta, T.annotation, T.processingInstruction], class: 'cvh-fn' },
  { tag: [T.typeName, T.className, T.namespace, T.tagName, T.standard(T.typeName)], class: 'cvh-type' },
  { tag: [T.propertyName, T.attributeName, T.labelName], class: 'cvh-prop' },
  { tag: [T.operator, T.punctuation, T.bracket, T.separator, T.derefOperator], class: 'cvh-op' },
  { tag: [T.regexp, T.escape, T.special(T.regexp), T.deleted, T.invalid], class: 'cvh-re' },
  { tag: [T.comment, T.lineComment, T.blockComment, T.docComment], class: 'cvh-cmt' },
  { tag: T.heading, class: 'cvh-h' },
  { tag: T.strong, class: 'cvh-b' },
  { tag: T.emphasis, class: 'cvh-i' },
  { tag: [T.link, T.url], class: 'cvh-link' },
]);

/** 按文件名 / 语言名找 CM 语言描述（找不到 → null，按纯文本显示） */
export function findLanguage(name = '', lang = '') {
  return (name && LanguageDescription.matchFilename(languages, name))
    || (lang && LanguageDescription.matchLanguageName(languages, lang, true))
    || null;
}

// —— 查找：命中位置 + 当前项，装饰只铺可见区 ——
const setSearch = StateEffect.define();   // { hits: Int32Array（[from,to] 平铺）, n, cur }
const searchPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.hits = null; this.n = 0; this.cur = -1; this.decorations = Decoration.none; this.build(view); }
  update(u) {
    let changed = false;
    for (const tr of u.transactions) for (const e of tr.effects) if (e.is(setSearch)) { ({ hits: this.hits, n: this.n, cur: this.cur } = e.value); changed = true; }
    if (u.docChanged && !changed && this.hits) { this.hits = null; this.n = 0; this.cur = -1; changed = true; }   // 改了字：等外面重搜
    if (changed || u.viewportChanged) this.build(u.view);
  }
  build(view) {
    const h = this.hits, n = this.n;
    if (!h || !n) { this.decorations = Decoration.none; return; }
    const b = new RangeSetBuilder();
    for (const { from, to } of view.visibleRanges) {
      // 二分找可见区里的第一个命中
      let lo = 0, hi = n;
      while (lo < hi) { const m = (lo + hi) >> 1; if (h[m * 2 + 1] <= from) lo = m + 1; else hi = m; }
      for (let i = lo; i < n && h[i * 2] < to; i++) {
        const a = h[i * 2], z = h[i * 2 + 1];
        if (z > a) b.add(a, z, i === this.cur ? hitCur : hitMark);
      }
    }
    this.decorations = b.finish();
  }
}, { decorations: (v) => v.decorations });
const hitMark = Decoration.mark({ class: 'cv-hit' });
const hitCur = Decoration.mark({ class: 'cv-hit cv-hit-cur' });

// —— 日志：级别词着色 + 错误行浅底（克制：只有 ERROR/FATAL 整行铺底，WARN 只染词，时间戳压灰）——
const logLineErr = Decoration.line({ class: 'cv-log-err' });
const logLineDim = Decoration.line({ class: 'cv-log-dim' });
const mkErr = Decoration.mark({ class: 'cv-lv-err' }), mkWarn = Decoration.mark({ class: 'cv-lv-warn' }), mkTs = Decoration.mark({ class: 'cv-log-ts' });
const logPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const b = new RangeSetBuilder(), doc = view.state.doc;
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = doc.lineAt(pos), s = line.text.length > 400 ? line.text.slice(0, 400) : line.text;
        const ts = TS.exec(s);
        const head = s.slice(0, 160);   // 级别词只认行首附近（正文里出现的 error 不算）
        const e = LV_ERR.exec(head), w = !e && LV_WARN.exec(head), d = !e && !w && LV_DIM.exec(head);
        if (e) b.add(line.from, line.from, logLineErr);
        else if (d) b.add(line.from, line.from, logLineDim);
        const marks = [];
        if (ts) marks.push([0, ts[0].length, mkTs]);
        if (e) marks.push([e.index, e.index + e[0].length, mkErr]);
        else if (w) marks.push([w.index, w.index + w[0].length, mkWarn]);
        marks.sort((x, y) => x[0] - y[0]);
        let last = -1;
        for (const [a, z, dec] of marks) { if (a >= last) { b.add(line.from + a, line.from + z, dec); last = z; } }
        pos = line.to + 1;
      }
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

// 只读：电脑端内容仍可聚焦（键盘移动、Ctrl+A、复制、当前行跟着走，光标在 CSS 里藏掉）；
// 触屏不可聚焦——一聚焦就弹软键盘，选字交给系统长按
const roExt = (editable, touch) => [EditorState.readOnly.of(!editable), EditorView.editable.of(editable || !touch)];
const editExt = (editable) => (editable ? [history(), keymap.of(historyKeymap)] : []);

// 外观：--md-* 令牌（跟随明暗）。写成 CM 主题而不是外部 CSS——基础主题的选择器特异度高，外部样式盖不稳
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--cv-fs, 13px)', color: 'var(--md-code-fg, var(--md-fg))', backgroundColor: 'var(--md-bg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--md-mono)', lineHeight: '1.6', overscrollBehavior: 'contain' },
  '.cm-content': { padding: '8px 0 calc(28px + var(--sab, 0px))', caretColor: 'var(--md-accent)' },
  '.cm-line': { padding: '0 18px 0 4px' },
  // 行号用 fg-3（fg-4 在暗色下对比度只有 2.9，读不清）；折叠标记仍用 fg-4，悬停才提亮
  '.cm-gutters': { backgroundColor: 'var(--md-bg)', color: 'var(--md-fg-3)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 14px', minWidth: '4ch', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLine': { backgroundColor: 'rgba(var(--md-ink), .04)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--md-fg-2)' },
  '.cm-foldGutter .cm-gutterElement': { display: 'flex', alignItems: 'center', padding: '0 4px 0 2px', color: 'var(--md-fg-4)', cursor: 'pointer', transition: 'color var(--mo-micro, 140ms)' },
  '.cm-foldMk': { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '14px', height: '1.6em' },
  '.cm-foldMk svg': { display: 'block', width: '12px', height: '12px' },
  '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--md-fg)' },
  '.cm-foldPlaceholder': { backgroundColor: 'rgba(var(--md-ink), .07)', border: 'none', color: 'var(--md-fg-3)', padding: '0 6px', margin: '0 2px', borderRadius: '4px' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { background: 'var(--md-accent-soft)' },
  '.cm-content ::selection': { backgroundColor: 'var(--md-accent-soft)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--md-accent)', borderLeftWidth: '2px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(var(--md-ink), .1)', outline: 'none' },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: 'var(--md-danger)' },
  '.cm-specialChar': { color: 'var(--md-danger)' },
});

// 折叠标记：查看器线稿图标（展开＝向下、收起＝向右），不用字符——⌄ / › 在各家字体里粗细、基线都不一样
function foldMarker(open) {
  const el = document.createElement('span');
  el.className = 'cm-foldMk';
  el.innerHTML = viewerSvg(open ? 'down' : 'chev', { stroke: 1.8 });
  return el;
}

/**
 * 建视图。opts：parent, doc, name（文件名，挑语言）, lang（fileKinds.langOf）, editable, wrap, log, onChange(text), onSelection()
 * 返回句柄（全部同步可调，语言异步到货后自己换上）
 */
export function createCodeView(opts) {
  const { parent, doc = '', name = '', lang = '', editable = false, wrap = false, log = false, touch = false } = opts;
  const langC = new Compartment(), wrapC = new Compartment(), roC = new Compartment(), editC = new Compartment(), logC = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        highlightSpecialChars(),
        touch ? [] : drawSelection(),   // 触屏用系统选区（自绘选区在不可聚焦的只读态里不跟手）
        theme,
        keymap.of(defaultKeymap),       // 只读态也要：方向键 / Home / End / Ctrl+A；改字的命令被 readOnly 拦住
        foldGutter({ markerDOM: foldMarker }),
        bracketMatching(),
        keymap.of(foldKeymap),
        syntaxHighlighting(hl),
        searchPlugin,
        langC.of([]),
        wrapC.of(wrap ? EditorView.lineWrapping : []),
        roC.of(roExt(editable, touch)),
        editC.of(editExt(editable)),
        logC.of(log ? logPlugin : []),
        EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': name }),
        EditorView.cursorScrollMargin.of({ x: 8, y: 48 }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange?.(u);
          if (u.selectionSet) opts.onSelection?.(u);
        }),
      ],
    }),
  });

  let langLoaded = null;
  const desc = findLanguage(name, lang);
  // 超大文档的流式（legacy）语言要从头逐行跑，滚到文末会顿：> 4MB 只给 lezer 语言上色
  let dead = false;
  if (desc) {
    langLoaded = desc.load().then((sup) => {
      if (dead) return;
      if (view.state.doc.length > 4 * 1024 * 1024 && sup?.language instanceof StreamLanguage) return;
      view.dispatch({ effects: langC.reconfigure(sup) });
    }).catch(() => {});
  }

  // 查找状态（外面的查找条读这里）
  let sq = null, res = { hits: null, n: 0, capped: false }, cur = -1, textMemo = null;
  const docText = () => {
    const d = view.state.doc;
    if (textMemo?.doc !== d) textMemo = { doc: d, text: d.toString() };
    return textMemo.text;
  };
  function pushHits() {
    view.dispatch({ effects: setSearch.of({ hits: res.hits, n: res.n, cur }) });
  }
  function revealCur() {
    if (cur < 0 || !res.n) return;
    const a = res.hits[cur * 2], z = res.hits[cur * 2 + 1];
    view.dispatch({ selection: { anchor: a, head: z }, effects: EditorView.scrollIntoView(a, { y: 'center' }) });
  }

  const api = {
    view,
    langLoaded,
    get lines() { return view.state.doc.lines; },
    setEditable(on) { view.dispatch({ effects: [roC.reconfigure(roExt(on, touch)), editC.reconfigure(editExt(on))] }); },
    setWrap(on) { view.dispatch({ effects: wrapC.reconfigure(on ? EditorView.lineWrapping : []) }); },
    setLog(on) { view.dispatch({ effects: logC.reconfigure(on ? logPlugin : []) }); },
    /** 整篇换正文（编码重选、格式化 / 原文切换）：滚动回到同一行附近 */
    setDoc(text) {
      if (text === docText()) return;
      const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
      const ln = view.state.doc.lineAt(top.from).number;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      const l = view.state.doc.line(Math.min(ln, view.state.doc.lines));
      view.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: 'start' }) });
      if (sq) api.search(sq);
    },
    /** 正文（按 eol 拼回原文的换行风格） */
    getText(eol = '\n') { const d = view.state.doc; return d.sliceString(0, d.length, eol); },
    /** 查找：返回 { n, cur, capped, error } */
    search(q) {
      sq = q && q.q ? q : null;
      if (!sq) { res = { hits: null, n: 0, capped: false }; cur = -1; pushHits(); return { n: 0, cur: -1, capped: false }; }
      res = findAll(docText(), sq);
      if (res.error) { cur = -1; pushHits(); return { n: 0, cur: -1, capped: false, error: true }; }
      // 当前项：光标 / 视口顶之后的第一个
      const from = view.state.selection.main.empty ? view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop)).from : view.state.selection.main.from;
      cur = -1;
      for (let i = 0; i < res.n; i++) if (res.hits[i * 2] >= from) { cur = i; break; }
      if (cur < 0 && res.n) cur = 0;
      pushHits();
      return { n: res.n, cur, capped: res.capped };
    },
    /** 上 / 下一个（dir=±1），回绕；返回同 search */
    step(dir = 1) {
      if (!res.n) return { n: 0, cur: -1, capped: res.capped };
      cur = (cur + dir + res.n) % res.n;
      pushHits();
      revealCur();
      return { n: res.n, cur, capped: res.capped };
    },
    reveal() { revealCur(); },
    /** 跳到第 n 行（可带列），居中、选中行首 */
    gotoLine(n, col = 1) {
      const d = view.state.doc;
      const l = d.line(Math.max(1, Math.min(d.lines, Math.round(n) || 1)));
      const pos = Math.min(l.to, l.from + Math.max(0, (Math.round(col) || 1) - 1));
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      return l.number;
    },
    /** 改字号后保住视口顶那一行 */
    keepTopWhile(fn) {
      const sc = view.scrollDOM;
      const blk = view.lineBlockAtHeight(sc.scrollTop);
      const frac = blk.height ? (sc.scrollTop - blk.top) / blk.height : 0;
      fn();
      view.requestMeasure({
        read: () => null,
        write: () => {
          const b2 = view.lineBlockAt(blk.from);
          sc.scrollTop = b2.top + frac * b2.height;
        },
      });
    },
    focus() { view.focus(); },
    selectionText() { const s = view.state.selection.main; return s.empty ? '' : view.state.sliceDoc(s.from, Math.min(s.to, s.from + 500)); },
    cursorLine() { return view.state.doc.lineAt(view.state.selection.main.head).number; },
    destroy() { dead = true; view.destroy(); },
  };
  return api;
}
