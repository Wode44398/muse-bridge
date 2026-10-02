// 格式工具栏命令：切换行内格式、行前缀切换、标题循环、插表格、列表缩进、插链接、切换任务。
// 全部经 dispatch 走正规变更（撤销/重做天然可用）。菜单/浮条调 commands.xxx（末尾会 focus），
// 键位（keys.js）直接用导出的纯命令（返回 boolean，不抢焦点）。
import { EditorSelection, countColumn } from '@codemirror/state';
import { undo as cmUndo, redo as cmRedo, indentMore, indentLess, isolateHistory } from '@codemirror/commands';
import { syntaxTree, ensureSyntaxTree, indentUnit } from '@codemirror/language';
import { emptyTableSrc } from './table.js';
import { requestAutoAdd } from './props.js';
import { t } from '../i18n.js';

// 从 node 往上找第一个名字在 names 里的祖先（含自身）
function ancestor(node, names) {
  for (let n = node; n; n = n.parent) if (names.includes(n.name)) return n;
  return null;
}
const CODE_NODES = ['FencedCode', 'CodeBlock'];
function inCode(state, pos) {
  return !!ancestor(syntaxTree(state).resolveInner(pos, 1), CODE_NODES);
}

// ———— 行内格式切换（移植 Obsidian toggleMarkdownFormatting）————
// 与旧版「看选区外侧字符串是不是标记」相比：判断已有格式一律看语法树（**粗** 里按 Mod-I 不会
// 误削一层 * 把粗体变斜体；光标在粗体中间再按 Mod-B 是取消而不是插出 ****）；空选区作用于光标
// 所在整词（中文连续字=一个词，与 Obsidian 一致）；多行选区逐行夹紧到内容区（列表/引用/标题前缀
// 与行尾空白不进标记，空行跳过），不再产出跨段落、永远不生效的 **para\n\npara**。
const FMT = {
  bold: { mark: '**', nodes: ['StrongEmphasis'] },
  italic: { mark: '*', nodes: ['Emphasis'] },   // 只认 Emphasis：** 是 StrongEmphasis，不会被当斜体
  strike: { mark: '~~', nodes: ['Strikethrough'] },
  highlight: { mark: '==', nodes: ['OmHighlight'] },
  code: { mark: '`', nodes: ['InlineCode'] },
  math: { mark: '$', nodes: ['InlineMath'] },
  comment: { mark: '%%', nodes: ['ObsComment'] },
};
// 内容区：去掉 缩进/引用 > /列表标记（含任务框）/标题 # 前缀与行尾空白
const LINE_HEAD = /^[\s>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?/;
function contentRange(line) {
  const head = LINE_HEAD.exec(line.text)[0].length;
  const tail = line.text.replace(/\s+$/, '').length;
  return { from: line.from + head, to: line.from + Math.max(head, tail) };
}
// frontmatter 区间：它在 lezer 树之外（树里还会被误读成分割线 / setext 标题），只能按正则圈。
// 与 livePreview.js 的 frontmatterEnd 同口径，抄一份，命令层不依赖 LP
function frontmatterEnd(doc) {
  if (doc.lines < 2 || doc.line(1).text !== '---') return 0;
  const cap = Math.min(doc.lines, 300);
  for (let i = 2; i <= cap; i++) if (/^---\s*$/.test(doc.line(i).text)) return doc.line(i).to;
  return 0;
}
// 结构行：多行加粗 / 切待办时要原样跳过——改了就变结构（表格不成表、分割线和 setext 标题变段落、
// 属性面板消失、链接定义失效…）。按内容区起点查树，引用里的「> ---」也认得出。
// task=true（Mod-L）时整个 setext 标题与脚注定义也跳过：标题文字行前加「- [ ] 」，下划线就成了懒续行
const STRUCT_BLOCKS = ['Table', 'HorizontalRule', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock',
  'LinkReference', 'FencedCode', 'CodeBlock', 'BlockMath'];
function structuralLine(state, line, fmEnd, task) {
  if (fmEnd > 0 && line.from <= fmEnd) return true;
  if (!line.text.trim()) return false;
  const n = syntaxTree(state).resolveInner(contentRange(line).from, 1);
  if (ancestor(n, STRUCT_BLOCKS)) return true;
  if (task) return !!ancestor(n, ['SetextHeading1', 'SetextHeading2', 'FootnoteDef']);
  const hm = ancestor(n, ['HeaderMark']);
  return !!hm && /^SetextHeading/.test(hm.parent?.name || '');   // setext 下划线行
}
const FN_DEF = /^\[\^[^\]\s]+\]:[ \t]*/;   // 脚注定义的标签：加格式只包后面的正文
// 格式节点两端的标记区间：有 *Mark 子节点（强调/删除/高亮/行内码）按子节点，
// 数学/注释这类整段叶子节点按固定宽度
function markSpans(node, spec) {
  const kids = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (/Mark$/.test(c.name)) kids.push(c);
  if (kids.length >= 2) return [[kids[0].from, kids[0].to], [kids[kids.length - 1].from, kids[kids.length - 1].to]];
  const w = spec.mark.length;
  return [[node.from, node.from + w], [node.to - w, node.to]];
}
// 覆盖 [from,to] 的同类格式节点（空选区要求光标严格在节点内部）
function fmtNodeAt(state, from, to, spec) {
  const tree = syntaxTree(state);
  for (const side of [1, -1]) {
    for (let n = tree.resolveInner(from, side); n; n = n.parent) {
      if (!spec.nodes.includes(n.name)) continue;
      if (from === to ? n.from < from && from < n.to : n.from <= from && n.to >= to) return n;
    }
  }
  return null;
}

export function toggleFormat(view, kind) {
  const spec = FMT[kind];
  const { state } = view;
  if (!spec || state.readOnly) return false;
  const tree = syntaxTree(state);
  const tx = state.changeByRange((r) => {
    // 两端空白不进标记（Obsidian Bp）
    let h = r.from, p = r.to;
    while (h < p && /\s/.test(state.sliceDoc(h, h + 1))) h++;
    while (p > h && /\s/.test(state.sliceDoc(p - 1, p))) p--;
    const hit = fmtNodeAt(state, h, p, spec);
    if (hit) {
      const [open, close] = markSpans(hit, spec);
      // 光标恰在收尾标记前（「Mod-B → 打字 → Mod-B」的第二下）：跳出格式，不改文档
      if (r.empty && r.head === close[0]) return { range: EditorSelection.cursor(hit.to) };
      const cs = state.changes([{ from: open[0], to: open[1] }, { from: close[0], to: close[1] }]);
      if (r.empty) return { changes: cs, range: EditorSelection.cursor(cs.mapPos(r.head, 1)) };
      return { changes: cs, range: EditorSelection.range(cs.mapPos(h, 1), cs.mapPos(Math.min(p, hit.to), -1)) };
    }
    // 要加格式的片段
    const segs = [];
    let cursorAt = null;
    if (r.empty) {
      const w = state.wordAt(r.head);
      if (w) segs.push([w.from, w.to]);
      else {
        const ins = spec.mark + spec.mark;
        return { changes: { from: r.head, insert: ins }, range: EditorSelection.cursor(r.head + spec.mark.length) };
      }
      cursorAt = r.head;
    } else {
      const lf = state.doc.lineAt(h).number, lt = state.doc.lineAt(p).number;
      const fmEnd = lf < lt ? frontmatterEnd(state.doc) : 0;
      for (let n = lf; n <= lt; n++) {
        const line = state.doc.line(n);
        const c = contentRange(line);
        let E = Math.min(Math.max(c.from, h), p);
        const M = Math.min(Math.max(c.to, h), p);
        if (E >= M || inCode(state, E)) continue;
        if (lf < lt && structuralLine(state, line, fmEnd, false)) continue;   // 单行选区照旧（表格单元格里也能加粗）
        if (E === c.from) E += (FN_DEF.exec(state.sliceDoc(E, M)) || [''])[0].length;
        if (E < M) segs.push([E, M]);
      }
      if (!segs.length) return { range: r };
    }
    const changes = [];
    for (let [E, M] of segs) {
      // 片段里（或跨片段边界）已有的同类格式先拆掉再整体包，免得产出 **a **b** c** 这种嵌套
      const inner = [];
      tree.iterate({
        from: E, to: M,
        enter: (n) => { if (spec.nodes.includes(n.name) && n.to > E && n.from < M) { inner.push(n.node); return false; } },
      });
      for (const n of inner) {
        E = Math.min(E, n.from); M = Math.max(M, n.to);
        for (const [f, t2] of markSpans(n, spec)) changes.push({ from: f, to: t2 });
      }
      changes.push({ from: E, insert: spec.mark }, { from: M, insert: spec.mark });
    }
    const cs = state.changes(changes);
    if (cursorAt != null) {
      const w = segs[0];
      return { changes: cs, range: EditorSelection.cursor(cs.mapPos(cursorAt, cursorAt === w[1] ? -1 : 1)) };
    }
    return { changes: cs, range: EditorSelection.range(cs.mapPos(h, 1), cs.mapPos(p, -1)) };
  });
  view.dispatch(tx, { userEvent: 'input.type', scrollIntoView: true });
  return true;
}

// 成对包裹（双链 [[ ]] 用；无语法树语义可判，保留旧的字符串判定）
function wrapPair(view, left, right = left) {
  if (view.state.readOnly) return;
  view.dispatch(view.state.changeByRange((r) => {
    const { state } = view;
    const text = state.sliceDoc(r.from, r.to);
    const before = state.sliceDoc(Math.max(0, r.from - left.length), r.from);
    const after = state.sliceDoc(r.to, Math.min(state.doc.length, r.to + right.length));
    if (before === left && after === right) {          // 已包裹（外侧）→ 去包裹
      return {
        changes: [{ from: r.from - left.length, to: r.from }, { from: r.to, to: r.to + right.length }],
        range: EditorSelection.range(r.from - left.length, r.to - left.length),
      };
    }
    if (text.startsWith(left) && text.endsWith(right) && text.length >= left.length + right.length) {   // 选中含标记 → 去包裹
      return {
        changes: [{ from: r.from, to: r.from + left.length }, { from: r.to - right.length, to: r.to }],
        range: EditorSelection.range(r.from, r.to - left.length - right.length),
      };
    }
    return {
      changes: [{ from: r.from, insert: left }, { from: r.to, insert: right }],
      range: EditorSelection.range(r.from + left.length, r.to + left.length),
    };
  }));
  view.focus();
}

function coveredLines(state) {
  const out = [];
  const seen = new Set();
  for (const r of state.selection.ranges) {
    const lf = state.doc.lineAt(r.from).number, lt = state.doc.lineAt(r.to).number;
    for (let n = lf; n <= lt; n++) {
      if (!seen.has(n)) { seen.add(n); out.push(state.doc.line(n)); }
    }
  }
  return out;
}

// 行前缀类命令（列表 / 待办 / 引用 / 标题）的派发：光标跟到插入内容之后（assoc 1），被改动行上的
// 空光标若仍落在行首前缀里（原本在缩进前、或 # 串中间），挪到前缀末。不带选区时 CM 按 assoc -1 映射，
// 光标留在新前缀前面——LP 里前缀是隐藏的，接着打字就插到「- 」前面，列表/标题当场散掉。
function dispatchPrefix(view, changes) {
  const { state } = view;
  const cs = state.changes(changes);
  const doc = cs.apply(state.doc), touched = new Set();
  cs.iterChangedRanges((fA, tA, fB, tB) => {
    for (let n = doc.lineAt(fB).number; n <= doc.lineAt(tB).number; n++) touched.add(n);
  });
  const ranges = state.selection.ranges.map((r) => {
    const m = r.map(cs, 1);
    if (!m.empty) return m;
    const line = doc.lineAt(m.head);
    if (!touched.has(line.number)) return m;
    const k = line.from + LINE_HEAD.exec(line.text)[0].length;
    return m.head < k ? EditorSelection.cursor(k) : m;
  });
  view.dispatch({ changes: cs, selection: EditorSelection.create(ranges, state.selection.mainIndex), userEvent: 'input', scrollIntoView: true });
}

// 行前缀切换：全部已有 → 移除；否则补齐（保留缩进）
function toggleLinePrefix(view, make, re) {
  if (view.state.readOnly) return;
  const lines = coveredLines(view.state).filter((l) => l.text.trim() !== '' || view.state.selection.main.empty);
  if (!lines.length) return;
  const has = (l) => re.test(l.text.replace(/^\s*/, ''));
  const allHave = lines.every(has);
  const changes = [];
  for (const l of lines) {
    const indent = l.text.match(/^\s*/)[0].length;
    if (allHave) {
      const m = re.exec(l.text.slice(indent));
      if (m) changes.push({ from: l.from + indent, to: l.from + indent + m[0].length });
    } else if (!has(l)) {
      changes.push({ from: l.from + indent, insert: typeof make === 'function' ? make(l) : make });
    }
  }
  if (changes.length) dispatchPrefix(view, changes);
  view.focus();
}

function cycleHeading(view) {
  if (view.state.readOnly) return;
  const changes = [];
  for (const l of coveredLines(view.state)) {
    const m = /^(#{1,6}) /.exec(l.text);
    if (!m) changes.push({ from: l.from, insert: '# ' });
    else if (m[1].length >= 6) changes.push({ from: l.from, to: l.from + m[0].length });
    else changes.push({ from: l.from, insert: '#' });
  }
  if (changes.length) dispatchPrefix(view, changes);
  view.focus();
}

function insertTable(view) {
  if (view.state.readOnly) return;
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const src = emptyTableSrc(2, 1);
  const prefix = line.text.trim() === '' ? '' : '\n';
  const insert = prefix + src + '\n';
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + prefix.length + src.length + 1 },
  });
  view.focus();
}

// 指定级标题（0=正文：只摘掉现有 # 前缀）
function setHeading(view, level) {
  if (view.state.readOnly) return;
  const changes = [];
  for (const l of coveredLines(view.state)) {
    const m = /^#{1,6}\s+/.exec(l.text);
    const mark = level ? '#'.repeat(level) + ' ' : '';
    if (m) { if (m[0] !== mark) changes.push({ from: l.from, to: l.from + m[0].length, insert: mark }); }
    else if (level && l.text.trim() !== '') changes.push({ from: l.from, insert: mark });
  }
  if (changes.length) dispatchPrefix(view, changes);
  view.focus();
}

// 清除格式：抹掉选区内的行内标记（保留 _，snake_case 不受伤）
function clearFormat(view) {
  if (view.state.readOnly) return;
  // 逐行只清内容区里的行内标记：整段正则替换会把多行选区里的「* 列表」标记、「***」分割线、
  // ``` 围栏一起抹掉（同多行加粗那条的口径：结构行、代码行跳过；单行选区照旧，表格格子里也能清）
  const { state } = view;
  const changes = [];
  for (const r of state.selection.ranges) {
    if (r.empty) continue;
    const lf = state.doc.lineAt(r.from).number, lt = state.doc.lineAt(r.to).number;
    const fmEnd = lf < lt ? frontmatterEnd(state.doc) : 0;
    for (let n = lf; n <= lt; n++) {
      const line = state.doc.line(n);
      const c = contentRange(line);
      const E = Math.max(c.from, r.from), M = Math.min(c.to, r.to);
      if (E >= M || inCode(state, E)) continue;
      if (lf < lt && structuralLine(state, line, fmEnd, false)) continue;
      const text = state.sliceDoc(E, M);
      const clean = text.replace(/(\*\*|__|~~|==|%%|`|\*)/g, '');
      if (clean !== text) changes.push({ from: E, to: M, insert: clean });
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input.type' });
  view.focus();
}

// 块级插入：光标行为空则原地放，否则另起一行；光标落进 curOff 指定的偏移
function insertBlockAfter(view, src, curOff) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const prefix = line.text.trim() === '' ? '' : '\n';
  const insert = prefix + src + '\n';
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + prefix.length + (curOff ?? src.length + 1) },
    scrollIntoView: true,
  });
  view.focus();
}

function insertHr(view) {
  if (view.state.readOnly) return;
  insertBlockAfter(view, '---');
}

// 标注：有选区 → 选中行整体降为 callout 正文；无选区 → 模板（光标停在标题处）
function insertCallout(view) {
  if (view.state.readOnly) return;
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty) {
    const from = state.doc.lineAt(r.from).from, to = state.doc.lineAt(r.to).to;
    const body = state.sliceDoc(from, to).split('\n').map((l) => '> ' + l).join('\n');
    const src = '> [!note] ' + t('标注') + '\n' + body;
    view.dispatch({ changes: { from, to, insert: src }, selection: { anchor: from + src.length }, scrollIntoView: true });
    view.focus();
    return;
  }
  const title = t('标注');   // 插进文档的 callout 标题占位（光标停在它后面）
  insertBlockAfter(view, '> [!note] ' + title + '\n> ', '> [!note] '.length + title.length);
}

// 代码块：有选区 → 选中行围栏包裹；无选区 → 空围栏（光标进栏内）
function insertCodeBlock(view) {
  if (view.state.readOnly) return;
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty) {
    const from = state.doc.lineAt(r.from).from, to = state.doc.lineAt(r.to).to;
    const inner = state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: '```\n' + inner + '\n```' },
      selection: { anchor: from + 3 },
      scrollIntoView: true,
    });
    view.focus();
    return;
  }
  insertBlockAfter(view, '```\n\n```', 4);
}

// 数学块：同代码块逻辑，$$ 围栏
function insertMathBlock(view) {
  if (view.state.readOnly) return;
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty) {
    const inner = state.sliceDoc(r.from, r.to);
    const src = '$$\n' + inner + '\n$$';
    view.dispatch({ changes: { from: r.from, to: r.to, insert: src }, selection: { anchor: r.from + src.length }, scrollIntoView: true });
    view.focus();
    return;
  }
  insertBlockAfter(view, '$$\n\n$$', 3);
}

// 脚注：光标处放 [^n] 标记，文档末尾补定义行，光标跳到定义处
function insertFootnote(view) {
  if (view.state.readOnly) return;
  const { state } = view;
  const doc = state.doc.toString();
  let n = 1;
  while (doc.includes(`[^${n}]`)) n++;
  const mark = `[^${n}]`;
  const pos = state.selection.main.to;
  const tail = (doc.endsWith('\n') ? '' : '\n') + (doc.includes('[^') ? '' : '\n') + `${mark}: `;
  view.dispatch({
    changes: [{ from: pos, insert: mark }, { from: state.doc.length, insert: tail }],
    selection: { anchor: state.doc.length + mark.length + tail.length },
    scrollIntoView: true,
  });
  view.focus();
}

// 笔记属性：面板在就直接开一条新属性；没有 frontmatter 就先铺空块（面板一渲染自动开行）；
// 源码模式没有面板 → 光标送进 YAML 里手写
function insertProps(view) {
  if (view.state.readOnly) return;
  const panel = view.dom.querySelector('.mde-props');
  if (panel?.__addProp) { panel.__addProp(); return; }
  const { doc } = view.state;
  if (doc.line(1).text.trim() === '---') {
    view.dispatch({ selection: { anchor: Math.min(doc.line(2).from, doc.length) }, scrollIntoView: true });
    view.focus();
    return;
  }
  requestAutoAdd();
  view.dispatch({ changes: { from: 0, insert: '---\n---\n' }, selection: { anchor: 8 }, scrollIntoView: true });
}

// ———— 列表缩进（结构感知）————
// 旧版每行行首插 \t：子项不跟着走（语法树里变成兄弟）、第一项下沉成缩进代码块、2 空格文档里
// 混进 \t 后层级算错、段落/引用里按 Tab 变代码块。现在按语法树整棵子树移动：
//   缩进   目标列 = 前一个兄弟项的正文列；它已有子项 → 对齐最后那个子项的标记列（没有前一个兄弟 →
//          不动，避免孤立嵌套/代码块）
//   减缩进 目标列 = 父项的标记列（父级不是列表项 → 不动）
// 缩进字符跟文档既有风格走（indentUnit 由 index.js 按文档探测后放进 Compartment）：\t 风格每级
// 插一个 \t（仍落在「子项」区间时），否则精确补到目标列。引用里的列表插在 > 之后。
// 有序序号不在这里改——交给 keys.js 的重排过滤器（与本次缩进同一撤销步）。
const QUOTE_MARK = /^[ \t]*>[ ]?/;
function quoteDepth(node) {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) if (p.name === 'Blockquote') d++;
  return d;
}
// 跳过 depth 层引用标记后的偏移；层数不够（懒续行）→ -1
function skipQuotes(text, depth) {
  let i = 0;
  for (let k = 0; k < depth; k++) {
    const m = QUOTE_MARK.exec(text.slice(i));
    if (!m) return -1;
    i += m[0].length;
  }
  return i;
}
const colOf = (s) => countColumn(s, 4);
function makeIndent(col, useTab) {
  return useTab ? '\t'.repeat(Math.floor(col / 4)) + ' '.repeat(col % 4) : ' '.repeat(col);
}
// 列表项几何：标记列 / 正文列（相对外层引用前缀之后；CommonMark：标记后 1–4 个空白归标记，
// 空项或空白超 4 个时正文列 = 标记后 1 格）。标记列按 ListMark 量：lezer 的 ListItem.from 是父项的
// 正文列（不是标记所在列），子项比父项正文列缩得更深（「- 」下 4 空格、tab 加空格混用）时会少算。
function itemGeom(state, li) {
  const mark = li.getChild('ListMark');
  const line = state.doc.lineAt(mark.from);
  const base = line.from + Math.max(0, skipQuotes(line.text, quoteDepth(li)));
  const markCol = colOf(state.sliceDoc(base, mark.from));
  let k = mark.to;
  while (k < line.to && k - mark.to < 5 && /[ \t]/.test(state.sliceDoc(k, k + 1))) k++;
  const gap = k - mark.to;
  const contentCol = gap >= 1 && gap <= 4 && k < line.to
    ? colOf(state.sliceDoc(base, k))
    : colOf(state.sliceDoc(base, mark.to)) + 1;
  return { markCol, contentCol };
}
// 选区覆盖到的列表项（取最外层，子树由移动自然带上）；同时报告是否落在代码块里
function selectedItems(state) {
  // 解析拉到选区后面一段就够（子树一般不长）；超大文档首按 Tab 不为整篇解析卡住
  const upto = Math.min(state.doc.length, state.selection.ranges.reduce((m, r) => Math.max(m, r.to), 0) + 5000);
  const tree = ensureSyntaxTree(state, upto, 100) || syntaxTree(state);
  const items = [];
  let code = false;
  for (const r of state.selection.ranges) {
    const lf = state.doc.lineAt(r.from).number;
    let lt = state.doc.lineAt(r.to).number;
    if (!r.empty && lt > lf && r.to === state.doc.line(lt).from) lt--;   // 选到下一行行首不算那行
    for (let n = lf; n <= lt; n++) {
      const line = state.doc.line(n);
      const ws = /^[\s>]*/.exec(line.text)[0].length;
      if (ws >= line.length) continue;
      let node = tree.resolveInner(line.from + ws, 1);
      for (; node; node = node.parent) {
        if (CODE_NODES.includes(node.name)) { code = true; node = null; break; }
        if (node.name === 'ListItem') break;
      }
      if (node && !items.some((x) => x.from === node.from)) items.push(node);
    }
  }
  const top = items.filter((it) => !items.some((o) => o !== it && o.from <= it.from && o.to >= it.to && (o.from < it.from || o.to > it.to)));
  return { items: top.sort((a, b) => a.from - b.from), code };
}
// 子树逐行（跳过空行与不够层数的懒续行）改缩进；fn(at, ind) 返回该行的 change 或 null
function eachSubtreeLine(state, li, fn, out) {
  const depth = quoteDepth(li);
  const l0 = state.doc.lineAt(li.from).number, l1 = state.doc.lineAt(li.to).number;
  for (let n = l0; n <= l1; n++) {
    const line = state.doc.line(n);
    const q = skipQuotes(line.text, depth);
    if (q < 0 || !line.text.slice(q).trim()) continue;
    const ind = /^[ \t]*/.exec(line.text.slice(q))[0];
    const c = fn(line.from + q, ind);
    if (c) out.push(c);
  }
}
function dispatchIndent(view, changes, userEvent) {
  const { state } = view;
  const cs = state.changes(changes);
  // 光标跟着文字走（assoc 1）：行首插缩进时插入点后的光标不被留在缩进前面。
  // 每次缩进 / 减缩进自成一个撤销步：'delete.dedent'（沿用 CM indentLess 的命名）会被 history 在
  // 500ms 内与相邻改动合并——连按两下 Shift-Tab 一次撤回两级，Tab 后立刻 Shift-Tab 撤一次毫无变化
  view.dispatch({ changes: cs, selection: state.selection.map(cs, 1), userEvent, annotations: isolateHistory.of('full'), scrollIntoView: true });
}

// 列表项的最后一个子列表的最后一项（前一兄弟已有子项时，新子项要与它们同级）
function lastSubItem(li) {
  const sub = li.lastChild;
  if (!sub || (sub.name !== 'BulletList' && sub.name !== 'OrderedList')) return null;
  let k = sub.lastChild;
  while (k && k.name !== 'ListItem') k = k.prevSibling;
  return k;
}

export function indentList(view) {
  const { state } = view;
  if (state.readOnly) return false;
  const { items, code } = selectedItems(state);
  if (!items.length) return code ? indentMore(view) : true;   // 段落/标题/引用：吞掉 Tab 不做事（行首 \t 会变代码块）
  const useTab = state.facet(indentUnit).includes('\t');
  const changes = [];
  for (const li of items) {
    let prev = li.prevSibling;
    while (prev && prev.name !== 'ListItem') prev = prev.prevSibling;
    if (!prev) continue;
    const g = itemGeom(state, li), pg = itemGeom(state, prev);
    // 新标记列的合法区间 [lo, hi)：不小于前一项的正文列（成为它的子项），又不能够到它最后一个子项
    // 的正文列（否则成了孙项，一次缩两级）；没有子项时上限是正文列+4（再深就是缩进代码块）。
    // 精确落点：有子项 → 对齐那个子项的标记列（同级），没有 → 前一项的正文列
    const sub = lastSubItem(prev), sg = sub && itemGeom(state, sub);
    const lo = pg.contentCol, hi = sg ? sg.contentCol : lo + 4;
    const target = sg ? Math.max(lo, sg.markCol) : lo;
    // \t 风格：加一个 \t 仍落在 [lo, hi) 里就整棵子树行首各插 \t（整 4 列位移，行内原有 tab 对齐不变）；
    // 否则（100. 这类宽标记、前一项的子项是 2 空格缩进）退回精确列
    const tabOk = useTab && g.markCol + 4 >= lo && g.markCol + 4 < hi;
    const exact = target - g.markCol, delta = tabOk ? 4 : exact;
    if (delta <= 0) continue;
    eachSubtreeLine(state, li, (at, ind) => {
      // 「>- b」这种 > 后直接跟内容的行：插进去的第一个空白会被当成引用标记的可选空格吃掉，相对列
      // 少 1（插 2 空格只剩 1 列，还是兄弟）——多补一格，并且只用空格（tab 被吃掉半格，列更难算）
      if (!ind && at > 0 && state.sliceDoc(at - 1, at) === '>') return { from: at, insert: ' '.repeat(exact + 1) };
      if (tabOk) return { from: at, insert: '\t' };
      if (!ind.includes('\t')) return { from: at, insert: ' '.repeat(delta) };
      return { from: at, to: at + ind.length, insert: makeIndent(colOf(ind) + delta, useTab) };   // 行首空白里有 tab：按列重写
    }, changes);
  }
  if (changes.length) dispatchIndent(view, changes, 'input.indent');
  return true;
}

export function outdentList(view) {
  const { state } = view;
  if (state.readOnly) return false;
  const { items, code } = selectedItems(state);
  if (!items.length) return code ? indentLess(view) : true;
  const useTab = state.facet(indentUnit).includes('\t');
  const changes = [];
  for (const li of items) {
    const parent = li.parent?.parent;
    if (!parent || parent.name !== 'ListItem') continue;
    const delta = itemGeom(state, li).markCol - itemGeom(state, parent).markCol;
    if (delta <= 0) continue;
    eachSubtreeLine(state, li, (at, ind) => {
      const col = colOf(ind);
      if (!col) return null;
      if (col <= delta) return { from: at, to: at + ind.length };       // 懒续行等缩进不足的：清零
      let i = 0, c = 0;
      while (i < ind.length && c < delta) { c = ind[i] === '\t' ? c + 4 - (c % 4) : c + 1; i++; }
      const tabby = ind.includes('\t');
      // 恰好删掉开头 delta 列的整字符、剩下的空白列宽不变（没有 tab，或位移是 4 的倍数）→ 只删这段前缀；
      // 否则按列重写（tab 风格文档里混着 tab 的行也重写成规范写法：「\t    - c」→「\t- c」）
      if (c === delta && !(tabby && useTab) && (!ind.slice(i).includes('\t') || delta % 4 === 0)) return { from: at, to: at + i };
      return { from: at, to: at + ind.length, insert: makeIndent(col - delta, tabby) };
    }, changes);
  }
  if (changes.length) dispatchIndent(view, changes, 'delete.dedent');
  return true;
}

// ———— 插链接（Obsidian insertMarkdownLink）————
// 有选区 → [sel]() 光标进括号；空选区 → []() 光标进方括号；选中的是 URL → [](url) 光标进方括号。
// 旧版把占位词「链接」当 URL 插进去，还得手动删。
const URL_RE = /^(https?:\/\/|mailto:|www\.)\S+$/i;
export function insertLink(view) {
  const { state } = view;
  if (state.readOnly) return false;
  view.dispatch(state.changeByRange((r) => {
    if (r.empty) return { changes: { from: r.from, insert: '[]()' }, range: EditorSelection.cursor(r.from + 1) };
    const sel = state.sliceDoc(r.from, r.to);
    if (URL_RE.test(sel.trim())) {
      const ins = '[](' + sel.trim() + ')';
      return { changes: { from: r.from, to: r.to, insert: ins }, range: EditorSelection.cursor(r.from + 1) };
    }
    return { changes: [{ from: r.from, insert: '[' }, { from: r.to, insert: ']()' }], range: EditorSelection.cursor(r.to + 3) };
  }), { userEvent: 'input.type', scrollIntoView: true });
  return true;
}

// ———— 切换任务（Obsidian toggle-checklist-status，逐行）————
// 普通行 → 「- [ ] 」；列表行 → 标记后插「[ ] 」；任务行 → [ ] ↔ [x]。代码块里的行不碰。
const TASK_LINE = /^((?:[ \t]*>[ ]?)*[ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([ xX])\]/;
const LIST_LINE = /^((?:[ \t]*>[ ]?)*[ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const QUOTE_INDENT = /^(?:[ \t]*>[ ]?)*[ \t]*/;
function isListMark(state, pos) {
  return syntaxTree(state).resolveInner(pos, 1).name === 'ListMark';
}
// 该行若是任务行，返回勾选字符的位置（否则 -1）
export function taskCharPos(state, line) {
  const m = TASK_LINE.exec(line.text);
  if (!m || !isListMark(state, line.from + m[1].length)) return -1;
  return line.from + m[1].length + m[2].length + m[3].length + 1;
}
export function toggleTask(view) {
  const { state } = view;
  if (state.readOnly) return false;
  const lines = coveredLines(state);
  const fmEnd = frontmatterEnd(state.doc);
  const changes = [];
  for (const line of lines) {
    if (lines.length > 1 && !line.text.trim()) continue;
    if (inCode(state, line.from + /^\s*/.exec(line.text)[0].length)) continue;
    if (structuralLine(state, line, fmEnd, true)) continue;   // 只选了一行结构行：整条命令不做事
    const at = taskCharPos(state, line);
    if (at >= 0) { changes.push({ from: at, to: at + 1, insert: /[xX]/.test(state.sliceDoc(at, at + 1)) ? ' ' : 'x' }); continue; }
    const m = LIST_LINE.exec(line.text);
    if (m && isListMark(state, line.from + m[1].length)) {
      changes.push({ from: line.from + m[0].length, insert: m[3] ? '[ ] ' : ' [ ] ' });
      continue;
    }
    changes.push({ from: line.from + QUOTE_INDENT.exec(line.text)[0].length, insert: '- [ ] ' });
  }
  if (!changes.length) return true;
  const cs = state.changes(changes);
  view.dispatch({ changes: cs, selection: state.selection.map(cs, 1), userEvent: 'input', scrollIntoView: true });
  return true;
}

// 菜单/浮条入口：执行后把焦点还给编辑器
const withFocus = (fn) => (v) => { fn(v); v.focus(); };

let olCounter = 0;
export const commands = {
  undo: (v) => { cmUndo(v); v.focus(); },
  redo: (v) => { cmRedo(v); v.focus(); },
  heading: cycleHeading,
  bold: withFocus((v) => toggleFormat(v, 'bold')),
  italic: withFocus((v) => toggleFormat(v, 'italic')),
  strike: withFocus((v) => toggleFormat(v, 'strike')),
  highlight: withFocus((v) => toggleFormat(v, 'highlight')),
  code: withFocus((v) => toggleFormat(v, 'code')),
  math: withFocus((v) => toggleFormat(v, 'math')),
  comment: withFocus((v) => toggleFormat(v, 'comment')),
  clearFormat,
  wikilink: (v) => wrapPair(v, '[[', ']]'),
  link: withFocus(insertLink),
  toggleTask: withFocus(toggleTask),
  bullet: (v) => toggleLinePrefix(v, '- ', /^[-*+] (?!\[)/),
  ordered: (v) => { olCounter = 0; toggleLinePrefix(v, () => `${++olCounter}. `, /^\d+[.)] /); },
  task: (v) => toggleLinePrefix(v, '- [ ] ', /^[-*+] \[[ xX]\] /),
  quote: (v) => toggleLinePrefix(v, '> ', /^> ?/),
  table: insertTable,
  props: insertProps,
  hr: insertHr,
  callout: insertCallout,
  codeblock: insertCodeBlock,
  mathblock: insertMathBlock,
  footnote: insertFootnote,
  indent: withFocus(indentList),
  outdent: withFocus(outdentList),
  indentList: withFocus(indentList),
  outdentList: withFocus(outdentList),
  selectAll: (v) => { v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }); v.focus(); },
};
export { setHeading };
