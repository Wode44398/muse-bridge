// Markdown 编辑键位与输入处理（向 Obsidian 的编辑手感看齐）。index.js 只装配，这里集中：
//   · mdKeymap（Prec.high，先于 historyKeymap / defaultKeymap）：Enter / Shift-Enter / Backspace /
//     Tab / 格式快捷键 / 跟随链接 / smart Home
//   · 输入处理：选区包裹、自动配对括号、全角【【→[[、URL 粘贴成链接
//   · 有序列表自动重排（transactionFilter，与原操作同一撤销步）
//   · detectIndentUnit：按文档既有缩进风格定 indentUnit
// 约定：所有改文档的命令在只读态返回 false、不改文档；组字（IME）中的事务一律不插手。
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, EditorSelection, ChangeSet, Prec, Transaction, Compartment } from '@codemirror/state';
import { syntaxTree, ensureSyntaxTree, indentUnit } from '@codemirror/language';
import { deleteLine, insertNewlineAndIndent } from '@codemirror/commands';
import { insertNewlineContinueMarkupCommand, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { closeBrackets, closeBracketsKeymap, startCompletion } from '@codemirror/autocomplete';
import { toggleFormat, indentList, outdentList, insertLink, toggleTask, taskCharPos } from './commands.js';

const ANDROID = typeof navigator === 'object' && /Android\b/.test(navigator.userAgent);
// 与 closeBrackets 同口径：Android 上 CM 走 EditContext，看 composing；其余看 compositionStarted
const imeBusy = (view) => (ANDROID ? view.composing : view.compositionStarted);
const inside = (node, names) => { for (let n = node; n; n = n.parent) if (names.includes(n.name)) return n; return null; };
const CODE_CTX = ['InlineCode', 'FencedCode', 'CodeBlock'];
const inCodeCtx = (state, pos) => !!inside(syntaxTree(state).resolveInner(pos, -1), CODE_CTX);
const singleCursor = (state) => state.selection.ranges.length === 1 && state.selection.main.empty;

// ———— Enter ————
// lang-markdown 的续行命令，nonTightLists:false：空项回车一次就退出（嵌套时退一级），不再走
// 「第二项为空 → 把紧凑列表变松散再多插一个空项」那条分支（只有一项的列表回车两次退不出去）
const continueList = insertNewlineContinueMarkupCommand({ nonTightLists: false });

// 光标恰在列表前缀末、后面还有正文时回车：在本行上方插一个空项，正文连同光标下移到新行前缀末
//（Obsidian 同款）。原命令会删掉光标前的空白，上一行只剩一个没空格的「-」，列表就散了。
// 序号交给重排过滤器；已勾选的任务前缀复制成未勾选。
const ITEM_HEAD = /^([>\s]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
function enterAtItemStart(view) {
  const { state } = view;
  if (!singleCursor(state)) return false;
  const head = state.selection.main.head, line = state.doc.lineAt(head);
  const m = ITEM_HEAD.exec(line.text);
  if (!m || head !== line.from + m[0].length || !line.text.slice(m[0].length).trim()) return false;
  if (syntaxTree(state).resolveInner(line.from + m[1].length, 1).name !== 'ListMark') return false;   // 代码块里的「- x」不算
  const ins = m[0].replace(/\[[xX]\]/, '[ ]') + state.lineBreak;
  view.dispatch({ changes: { from: line.from, insert: ins }, selection: { anchor: head + ins.length }, scrollIntoView: true, userEvent: 'input' });
  return true;
}

// 空引用行（可嵌套、非列表行）回车一次就退出最内一层：本行变成外层前缀（顶级为空行），另起一行
// 接着写。lang-markdown 要连着两个空 > 行才退，中途还留一个孤立的「>」。必须留这个空行——直接
// 删成「> foo\n|」的话，接着打的字会成为引用段落的懒续行，仍在引用里。
function exitEmptyQuote(view) {
  const { state } = view;
  if (!singleCursor(state)) return false;
  const head = state.selection.main.head, line = state.doc.lineAt(head);
  if (!/^[ \t>]*>[ \t]*$/.test(line.text)) return false;
  const gt = line.text.lastIndexOf('>');
  if (head < line.from + gt + 1) return false;
  if (syntaxTree(state).resolveInner(line.from + gt, 1).name !== 'QuoteMark') return false;
  // 外层前缀原样保留：列表项里的引用，「>」前面的空白是列表续行缩进（剥掉就连列表一起退出了）；
  // 只有外层以「>」结尾时，中间那个空格才是分隔符——空行上去掉、新行补回一个
  const outer = line.text.slice(0, gt);
  const blank = outer.replace(/\s+$/, '');
  const ins = blank + state.lineBreak + (/\S$/.test(outer) ? outer + ' ' : outer);
  view.dispatch({ changes: { from: line.from, to: line.to, insert: ins }, selection: { anchor: line.from + ins.length }, scrollIntoView: true, userEvent: 'input' });
  return true;
}

// 列表项的续行（懒续行 / 缩进续行，本行自己没有标记）上回车：lang-markdown 拿首行标记的宽度去切
// 本行，短续行（「  周一交」「bc」）切完为空就被当成空项，整行正文被删。续行只做普通换行：去掉光标
// 前后的空白，新行沿用本行自己的前导空白与引用「>」（懒续行顶格就还顶格）。
function enterOnContinuation(view) {
  const { state } = view;
  if (!singleCursor(state)) return false;
  const head = state.selection.main.head, line = state.doc.lineAt(head);
  const lead = /^[ \t>]*/.exec(line.text)[0];
  if (head < line.from + lead.length || !line.text.slice(lead.length).trim()) return false;
  const node = syntaxTree(state).resolveInner(head, -1);
  if (inside(node, CODE_CTX)) return false;
  const item = inside(node, ['ListItem']);
  if (!item || item.from >= line.from) return false;   // 列表项首行（含嵌套项首行）仍交给原命令
  let from = head, to = head;
  while (from > line.from + lead.length && /[ \t]/.test(state.sliceDoc(from - 1, from))) from--;
  while (to < line.to && /[ \t]/.test(state.sliceDoc(to, to + 1))) to++;
  const ins = state.lineBreak + lead;
  view.dispatch({ changes: { from, to, insert: ins }, selection: { anchor: from + ins.length }, scrollIntoView: true, userEvent: 'input' });
  return true;
}

// 续写列表 / 引用后，光标后面紧跟的空白一起删掉：词尾（空格前）回车拆项时新项才是「- 下午开会」、
// 光标停在正文起点。原命令只删光标前的空白，留下「-  下午开会」——LP 把标记连同其后的空白一起藏成
// 圆点，光标就落进了隐藏前缀（输入法的第一个字母会漏进文档）。
function continueMarkup(view) {
  const { state } = view;
  let tr = null;
  if (!continueList({ state, dispatch: (t) => { tr = t; } })) return false;
  if (singleCursor(state)) {
    const h = tr.newSelection.main.head, doc = tr.newDoc, l = doc.lineAt(h);
    const n = /^[ \t]*/.exec(doc.sliceString(h, l.to))[0].length;
    if (n) {
      const changes = tr.changes.compose(ChangeSet.of({ from: h, to: h + n }, doc.length, state.lineBreak));
      tr = state.update({ changes, selection: { anchor: h }, scrollIntoView: true, userEvent: 'input' });
    }
  }
  view.dispatch(tr);
  return true;
}

// indentUnit 的 Compartment：index.js 按 detectIndentUnit 装进来、setDoc 时重配；codeEnter 临时借用。
export const indentConf = new Compartment();
// 代码块里回车走 CM 的 insertNewlineAndIndent（代码语言智能缩进），但它按 indentUnit 重新生成
// 缩进字符：\t 风格的文档里空格缩进的代码、空格风格文档里 tab 缩进的代码，一回车就混进另一种
// 字符。本行缩进字符与文档单位不一致时，临时把 indentUnit 换成本行的风格算一遍，只取它的改动。
function codeEnter(view) {
  const { state } = view;
  if (!singleCursor(state)) return false;
  const head = state.selection.main.head;
  if (!inside(syntaxTree(state).resolveInner(head, -1), ['FencedCode', 'CodeBlock'])) return false;
  const ws = /^[ \t]*/.exec(state.doc.lineAt(head).text)[0];
  const want = ws.includes('\t') ? '\t' : ws.length % 4 ? '  ' : '    ';
  if (!ws || state.facet(indentUnit).includes('\t') === want.includes('\t')) return false;
  const tmp = state.update({ effects: indentConf.reconfigure(indentUnit.of(want)) }).state;
  return insertNewlineAndIndent({
    state: tmp,
    dispatch: (tr) => view.dispatch({ changes: tr.changes, selection: tr.selection, scrollIntoView: true, userEvent: 'input' }),
  });
}

function enter(view) {
  if (view.state.readOnly) return false;
  return enterAtItemStart(view) || exitEmptyQuote(view) || codeEnter(view) || enterOnContinuation(view) || continueMarkup(view);
}

// Shift+Enter = 软换行（Obsidian newlineAndIndentOnly）：换行后补到正文列——引用保留「>」，
// 列表标记换成等宽空白，这样续行在阅读态与 LP 里都属于同一项、对齐正文。
const SOFT_PREFIX = /^([>\s]*)((?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
function softBreak(view) {
  const { state } = view;
  if (state.readOnly) return false;
  view.dispatch(state.changeByRange((r) => {
    const line = state.doc.lineAt(r.from);
    const m = SOFT_PREFIX.exec(line.text);
    let pad = '';
    if (m[0] && r.from - line.from >= m[0].length) {
      const w = countCols(m[1] + (m[2] || '')) - countCols(m[1]);
      pad = m[1] + ' '.repeat(w);
    }
    const ins = state.lineBreak + pad;
    return { changes: { from: r.from, to: r.to, insert: ins }, range: EditorSelection.cursor(r.from + ins.length) };
  }), { scrollIntoView: true, userEvent: 'input' });
  return true;
}
function countCols(s) {
  let c = 0;
  for (const ch of s) c = ch === '\t' ? c + 4 - (c % 4) : c + 1;
  return c;
}

// ———— smart Home（移植 Obsidian 的 Home/Cmd-←）————
// 列表/引用行：先到正文起点，已在正文起点才到行首；折行时以视觉行为准（第二个视觉行起按普通
// Home 到该视觉行首）。源码模式同样生效。userEvent 用 'select.home'：Live Preview 的光标夹紧
// 若有「从正文起点往左跳上一行」的分支，应只对方向键生效、排除它。
// 前缀口径与 LP 隐藏的前缀一致（Obsidian bO 只认标记后一个空格）：标记后 1–4 个空格或 tab、任务框后
// 一个空格（框后是 tab 时停在框后）。否则「-   foo」「-\tfoo」这类行，正文起点算在隐藏前缀里面，
// Shift+Home 选到前缀中间，一退格连标记一起删掉。
const HOME_PREFIX = /^([>\s]*)((?:[*+-]|\d+[.)])[ \t]{1,4}(?:\[.\](?: |(?=\t)))?)?/;
function smartHome(extend) {
  return (view) => {
    const { state } = view;
    const ranges = state.selection.ranges.map((r) => {
      const line = state.doc.lineAt(r.head);
      let f = view.moveToLineBoundary(r, false, true);
      if (f.head === r.head && f.head !== line.from) f = view.moveToLineBoundary(r, false, false);
      const m = HOME_PREFIX.exec(line.text);
      if (m && m[0] && f.head <= line.from + m[0].length) {
        const k = line.from + m[1].length + (m[2] || '').length;
        f = EditorSelection.cursor(k < r.head ? k : line.from);
      }
      return extend ? EditorSelection.range(r.anchor, f.head, f.goalColumn) : f;
    });
    view.dispatch({ selection: EditorSelection.create(ranges, state.selection.mainIndex), scrollIntoView: true, userEvent: 'select.home' });
    return true;
  };
}

// ———— Alt-Enter 跟随链接 / 切换勾选 ————
// 规则与 livePreview.js 的 linkClick 一致：[[双链]] → onNavigate(目标, 小节)；http/mailto/tel → openLink；
// 其余相对路径 → openRel。Alt-Enter 不在链接上而在任务行 → 切换勾选。都不是 → false（Mod-Enter 只跟随
// 链接，落空回到 defaultKeymap 的 insertBlankLine，任务行上也不抢）。
function openHref(href, opts) {
  if (/^(https?:|mailto:|tel:)/i.test(href)) opts.openLink?.(href);
  else if (href) opts.openRel?.(href);
}
function followLink(opts, toggle) {
  return (view) => {
    const { state } = view;
    const head = state.selection.main.head;
    const tree = syntaxTree(state);
    for (const side of [-1, 1]) {
      for (let n = tree.resolveInner(head, side); n; n = n.parent) {
        if (n.name === 'Wikilink' || n.name === 'WikilinkEmbed') {
          const m = /^!?\[\[([^[\]]+)\]\]$/.exec(state.sliceDoc(n.from, n.to));
          if (!m) break;
          let target = m[1], sub = '';
          const p = target.indexOf('|');
          if (p >= 0) target = target.slice(0, p);
          const h = target.indexOf('#');
          if (h >= 0) { sub = target.slice(h + 1).trim(); target = target.slice(0, h); }
          opts.onNavigate?.(target.trim(), sub);
          return true;
        }
        if (n.name === 'Link' || n.name === 'Autolink') {
          const u = n.getChild('URL');
          if (!u) break;
          openHref(state.sliceDoc(u.from, u.to), opts);
          return true;
        }
        if (n.name === 'URL') { openHref(state.sliceDoc(n.from, n.to), opts); return true; }
      }
    }
    if (!toggle || state.readOnly) return false;
    const at = taskCharPos(state, state.doc.lineAt(head));
    if (at < 0) return false;
    view.dispatch({ changes: { from: at, to: at + 1, insert: /[xX]/.test(state.sliceDoc(at, at + 1)) ? ' ' : 'x' }, userEvent: 'input' });
    return true;
  };
}

export function mdKeymap(opts = {}) {
  const home = smartHome(false), homeExt = smartHome(true);
  const follow = followLink(opts, true), followOnly = followLink(opts, false);
  return [
    { key: 'Mod-s', preventDefault: true, run: () => { opts.onSave?.(); return true; } },
    { key: 'Enter', run: enter, shift: softBreak },
    ...closeBracketsKeymap,   // 光标在自动补出的一对括号中间：退格连删一对（先于列表标记退格）
    { key: 'Backspace', run: (v) => !v.state.readOnly && deleteMarkupBackward(v) },
    { key: 'Tab', run: indentList, shift: outdentList },
    { key: 'Mod-]', run: indentList },
    { key: 'Mod-[', run: outdentList },
    { key: 'Mod-b', run: (v) => toggleFormat(v, 'bold') },
    { key: 'Mod-i', run: (v) => toggleFormat(v, 'italic') },
    { key: 'Mod-k', run: insertLink },
    { key: 'Mod-l', run: toggleTask },
    // %% 注释，盖过 defaultKeymap 的 <!-- --> toggleComment；围栏代码块里仍交给它（按代码语言插 // # 等）
    { key: 'Mod-/', run: (v) => !inside(syntaxTree(v.state).resolveInner(v.state.selection.main.head, -1), ['FencedCode', 'CodeBlock']) && toggleFormat(v, 'comment') },
    { key: 'Mod-d', run: deleteLine },
    { key: 'Alt-Enter', run: follow },
    { key: 'Mod-Enter', run: followOnly },
    { key: 'Home', run: home, shift: homeExt, preventDefault: true },
    { mac: 'Cmd-ArrowLeft', run: home, shift: homeExt, preventDefault: true },
  ];
}

// ———— 输入处理 ————
// 有选区时敲这些符号 = 包裹选区（选区留在内部，连敲两次得 ==x== ~~x~~ [[x]] %%x%%）。
// 旧行为是直接把选中文字替换掉。组字中 / 只读不处理。
const WRAP_CHARS = '*_=~$%`[(';
const wrapInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (text.length !== 1 || !WRAP_CHARS.includes(text) || imeBusy(view) || view.state.readOnly) return false;
  const { state } = view, sel = state.selection;
  if (sel.ranges.some((r) => r.empty) || from !== sel.main.from || to !== sel.main.to) return false;
  const close = text === '[' ? ']' : text === '(' ? ')' : text;
  view.dispatch(state.changeByRange((r) => ({
    changes: [{ from: r.from, insert: text }, { from: r.to, insert: close }],
    range: EditorSelection.range(r.anchor + 1, r.head + 1),
  })), { userEvent: 'input.type', scrollIntoView: true });
  return true;
});

// 自动配对只开 ( [ { `：* _ 不配对（行首敲「* 」列表会变成「**」），' " 不配对（英文缩写）。
// 代码块里跟随代码语言自己的配置（languageDataAt 先取到内层语言的值）。
const pairConfig = EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{', '`'] } }]);

// 全角转换（Obsidian expandText）：输入法打出的「【【」→「[[」（并补「]]」）、「！【【」→「![[」、
// 「】】」→「]]」。只在组字结束后看光标前的文本，dispatch 放进微任务（不在 update 周期里改文档）。
function expandFullwidth(view) {
  const { state } = view;
  if (view.composing || state.readOnly || !singleCursor(state)) return;
  const head = state.selection.main.head, line = state.doc.lineAt(head);
  const before = state.sliceDoc(Math.max(line.from, head - 3), head);
  const after = state.sliceDoc(head, Math.min(line.to, head + 2));
  const m = /[！!]?【【$/.exec(before);
  if (m) {
    if (inCodeCtx(state, head)) return;
    const open = m[0].length === 3 ? '![[' : '[[';
    const changes = [{ from: head - m[0].length, to: head, insert: open }];
    if (after === '】】') changes.push({ from: head, to: head + 2, insert: ']]' });   // 输入法自己配了对
    else if (after !== ']]') changes.push({ from: head, insert: ']]' });
    view.dispatch({ changes, selection: { anchor: head - m[0].length + open.length }, userEvent: 'input.type' });
    startCompletion(view);   // 没装补全时是空操作
    return;
  }
  if (/】】$/.test(before) && !inCodeCtx(state, head)) {
    // 后面已有补出的「]]」→ 删掉全角、光标越过它；否则原地换成半角
    if (after === ']]') view.dispatch({ changes: { from: head - 2, to: head }, selection: { anchor: head }, userEvent: 'input.type' });
    else view.dispatch({ changes: { from: head - 2, to: head, insert: ']]' }, selection: { anchor: head }, userEvent: 'input.type' });
  }
}
const fullwidth = [
  EditorView.updateListener.of((u) => {
    if (u.docChanged && u.transactions.some((tr) => tr.isUserEvent('input.type'))) queueMicrotask(() => expandFullwidth(u.view));
  }),
  // 组字上屏那一笔可能在 composing 仍为真时就派发了：compositionend 后（排在 CM 自己的收尾微任务之后）再看一次
  EditorView.domEventHandlers({
    compositionend: (e, view) => { Promise.resolve().then(() => Promise.resolve()).then(() => expandFullwidth(view)); return false; },
  }),
];

// 选区在单行内、剪贴板是 URL → [选中文字](url)（Obsidian 同款，不管选区里有什么格式节点；lang-markdown
// 自带的版本遇到 **选中** 这类格式内部就拒绝，所以 markdown() 传 pasteURLAsLink:false 换成这个）。
// 代码里、或选中的本身就是 URL（想替换）时照常粘贴。
const URL_RE = /^(https?:\/\/|mailto:|www\.)\S+$/i;
const pasteLink = EditorView.domEventHandlers({
  paste(e, view) {
    const { state } = view;
    if (state.readOnly) return false;
    const { ranges } = state.selection;
    if (ranges.some((r) => r.empty || state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number)) return false;
    let url = (e.clipboardData?.getData('text/plain') || '').trim();
    if (!URL_RE.test(url)) return false;
    if (ranges.some((r) => URL_RE.test(state.sliceDoc(r.from, r.to).trim()) || inCodeCtx(state, r.from + 1))) return false;
    if (/^www\./i.test(url)) url = 'https://' + url;
    e.preventDefault();
    view.dispatch(state.changeByRange((r) => ({
      changes: [{ from: r.from, insert: '[' }, { from: r.to, insert: '](' + url + ')' }],
      range: EditorSelection.cursor(r.to + url.length + 4),
    })), { userEvent: 'input.paste', scrollIntoView: true });
    return true;
  },
});

// ———— 有序列表自动重排（思路来自 Obsidian smartIndentList 的 transactionFilter）————
// Enter / Backspace / Tab / Alt+↑↓ / 剪切 / 粘贴后，受影响的有序列表按「首项序号 + 下标」重写，
// 作为 sequential 追加改动并进原事务（同一撤销步）。只处理结构性改动：跨行的改动，或落在行首
// 列表前缀区（含改动后形成的前缀）的改动——在正文里打字不触发，「1. 1. 1.」式列表不会被悄悄改掉。
// 组字、撤销/重做、程序整篇替换（无 userEvent）一律放行。
// 首项序号：首项所在行没被改动 → 原样保留；被改动了（在首项前插空项、把首项移走…）→ 取旧文档
// 同位置那张列表的首项序号；缩进/减缩进造出来的嵌套子列表一律从 1 开始。例外两种以新号为准、
// 后面顺延：① 首项行上只有「序号数字里插/删/换数字」（用户就地改起始号，源码模式；LP 不揭示序号，
// 改起始号就切源码）；② 旧首项的序号整个被替换掉、新首项又是这次插进来的（整行重打、全选粘贴一张
// 新列表）——旧首号已无从沿用，粘进来的「5. 6.」不该被改回「1. 2.」。
const OL_LINE = /^(?:[ \t]*>[ ]?)*[ \t]*\d{1,9}[.)](?:[ \t]|$)/;
const OL_DIGITS = /^((?:[ \t]*>[ ]?)*[ \t]*)(\d{1,9})[.)](?:[ \t]|$)/;
const LIST_PREFIX_LEN = /^(?:[ \t]*>[ ]?)*[ \t]*(?:\d{1,9}[.)]|[-*+])(?:[ \t]+|$)/;
const prefixLen = (text) => { const m = LIST_PREFIX_LEN.exec(text); return m ? m[0].length : 0; };
// 有序项的序号与其位置：按 ListMark 取（ListItem.from 是父项正文列，深缩进的子项不在标记上）
const itemNum = (doc, li) => {
  const mk = li.getChild('ListMark'), m = mk && /^(\d+)[.)]$/.exec(doc.sliceString(mk.from, mk.to));
  return m ? { from: mk.from, num: m[1] } : null;
};

const renumber = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const ev = tr.annotation(Transaction.userEvent);
  if (!ev || !/^(input|delete|move)(\.|$)/.test(ev) || /^input\.(type\.compose|renumber)/.test(ev)) return tr;
  const oldDoc = tr.startState.doc, newDoc = tr.newDoc;
  let structural = false;
  const spans = [];
  // 按新文档行号记：只在旧行序号数字区里改数字的行 / 有别的改动的行（前者是「就地改号」的判据）
  const numEdit = new Set(), otherEdit = new Set();
  tr.changes.iterChanges((fA, tA, fB, tB, ins) => {
    spans.push([fB, tB]);
    const oL = oldDoc.lineAt(fA);
    const dm = OL_DIGITS.exec(oL.text), ds = dm ? oL.from + dm[1].length : -1;
    const digits = !!dm && fA >= ds && tA <= ds + dm[2].length && ins.lines === 1 && /^\d*$/.test(ins.toString());
    (digits ? numEdit : otherEdit).add(newDoc.lineAt(fB).number);
    if (structural) return;
    if (ins.lines > 1 || tA > oL.to) { structural = true; return; }
    const nL = newDoc.lineAt(fB);
    if (fA - oL.from < Math.max(prefixLen(oL.text), prefixLen(nL.text))) structural = true;
  });
  if (!structural) return tr;
  // 预检：改动行及上下各一行里有没有有序项（没有就不必建新状态）
  const changed = new Set();
  let near = false;
  for (const [f, t] of spans) {
    const a = newDoc.lineAt(f).number, b = newDoc.lineAt(t).number;
    for (let n = a; n <= b; n++) changed.add(n);
    for (let n = Math.max(1, a - 1); n <= Math.min(newDoc.lines, b + 1) && !near; n++) near = OL_LINE.test(newDoc.line(n).text);
  }
  if (!near) return tr;
  const state = tr.state;
  const end = Math.max(...spans.map(([, t]) => t));
  const tree = ensureSyntaxTree(state, Math.min(newDoc.length, newDoc.lineAt(end).to + 1 + 400), 50) || syntaxTree(state);
  const lists = new Map();
  for (const [f, t] of spans) {
    const a = newDoc.lineAt(f);
    const bn = newDoc.lineAt(t).number;
    const b = newDoc.line(Math.min(newDoc.lines, bn + 1));
    tree.iterate({ from: a.from, to: b.to, enter: (n) => { if (n.name === 'OrderedList') lists.set(n.from, n.node); } });
  }
  const dedent = ev === 'input.indent' || ev === 'delete.dedent';
  const oldTree = syntaxTree(tr.startState);
  // [a,b] 整个落在某处被删 / 被替换的旧区间里；p 落在这次插入的新文本里
  const deleted = (a, b) => { let hit = false; tr.changes.iterChangedRanges((fA, tA) => { if (fA < tA && fA <= a && tA >= b) hit = true; }); return hit; };
  const inserted = (p) => { let hit = false; tr.changes.iterChangedRanges((fA, tA, fB, tB) => { if (fB <= p && p < tB) hit = true; }); return hit; };
  const changes = [];
  for (const list of lists.values()) {
    const items = list.getChildren('ListItem');
    if (!items.length) continue;
    const m0 = itemNum(newDoc, items[0]);
    if (!m0) continue;
    let start = +m0.num;
    const nested = list.parent?.name === 'ListItem';
    const ln0 = newDoc.lineAt(m0.from).number;
    if (dedent && nested) start = 1;
    else if (changed.has(ln0) && !(numEdit.has(ln0) && !otherEdit.has(ln0))) {
      // 旧文档同一行、同一列（标记所在列）处的列表：按列取，嵌套子列表才不会取到外层列表的首号
      const nl = newDoc.lineAt(m0.from);
      const ol = oldDoc.lineAt(tr.changes.invertedDesc.mapPos(nl.from, 1));
      const op = Math.min(ol.to, ol.from + (m0.from - nl.from));
      for (let n = oldTree.resolveInner(op, 1); n; n = n.parent) {
        if (n.name !== 'OrderedList') continue;
        const f = n.getChild('ListItem'), om = f && itemNum(oldDoc, f);
        if (om && !(deleted(om.from, om.from + om.num.length) && inserted(m0.from))) start = +om.num;
        break;
      }
    }
    items.forEach((li, i) => {
      const m = itemNum(newDoc, li);
      const want = String(start + i);
      if (m && m.num !== want) changes.push({ from: m.from, to: m.from + m.num.length, insert: want });
    });
  }
  return changes.length ? [tr, { changes, sequential: true, userEvent: 'input.renumber' }] : tr;
});

// 缩进风格探测：列表行的前导空白里出现过 \t → '\t'；否则用空格——宽度取已缩进列表行的最小缩进
//（夹在 2–4），没有可参考的缩进行取 2（AI 写的笔记普遍 2 空格）；空文档 → '\t'（Obsidian 默认 useTab）。
// 列表 Tab 本身按目标列精确补空格，这个宽度只影响代码块缩进等按单位缩进的场合。
export function detectIndentUnit(text) {
  const s = String(text);
  if (!s.trim()) return '\t';
  let min = 0;
  for (const line of s.split('\n', 3000)) {
    const m = /^(?:[ \t]*>[ ]?)*([ \t]+)(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.exec(line);
    if (!m) continue;
    if (m[1].includes('\t')) return '\t';
    min = min ? Math.min(min, m[1].length) : m[1].length;
  }
  return ' '.repeat(min ? Math.max(2, Math.min(4, min)) : 2);
}

// 键位与输入处理整包（index.js 放在 historyKeymap/defaultKeymap 之前）
export function mdKeys(opts = {}) {
  return [
    Prec.high(keymap.of(mdKeymap(opts))),
    Prec.high(wrapInput),   // 先于 closeBrackets 的 inputHandler：有选区时统一走包裹
    closeBrackets(),
    pairConfig,
    fullwidth,
    pasteLink,
    renumber,
  ];
}
