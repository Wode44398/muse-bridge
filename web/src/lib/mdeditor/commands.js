// 格式工具栏命令：包裹/去包裹行内标记、行前缀切换、标题循环、插表格、缩进。
// 全部经 dispatch 走正规变更（撤销/重做天然可用）。
import { EditorSelection } from '@codemirror/state';
import { undo as cmUndo, redo as cmRedo } from '@codemirror/commands';
import { emptyTableSrc } from './table.js';
import { requestAutoAdd } from './props.js';

function wrapInline(view, left, right = left) {
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
  if (changes.length) view.dispatch({ changes });
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
  if (changes.length) view.dispatch({ changes });
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
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

// 清除格式：抹掉选区内的行内标记（保留 _，snake_case 不受伤）
function clearFormat(view) {
  if (view.state.readOnly) return;
  view.dispatch(view.state.changeByRange((r) => {
    if (r.empty) return { range: r };
    const text = view.state.sliceDoc(r.from, r.to);
    const clean = text.replace(/(\*\*|__|~~|==|%%|`|\*)/g, '');
    if (clean === text) return { range: r };
    return { changes: { from: r.from, to: r.to, insert: clean }, range: EditorSelection.range(r.from, r.from + clean.length) };
  }));
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
    const src = '> [!note] 标注\n' + body;
    view.dispatch({ changes: { from, to, insert: src }, selection: { anchor: from + src.length }, scrollIntoView: true });
    view.focus();
    return;
  }
  insertBlockAfter(view, '> [!note] 标注\n> ', '> [!note] '.length + '标注'.length);
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

function indentLines(view, out) {
  if (view.state.readOnly) return;
  const changes = [];
  for (const l of coveredLines(view.state)) {
    if (out) {
      const m = /^(\t| {1,4})/.exec(l.text);
      if (m) changes.push({ from: l.from, to: l.from + m[0].length });
    } else {
      changes.push({ from: l.from, insert: '\t' });
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

let olCounter = 0;
export const commands = {
  undo: (v) => { cmUndo(v); v.focus(); },
  redo: (v) => { cmRedo(v); v.focus(); },
  heading: cycleHeading,
  bold: (v) => wrapInline(v, '**'),
  italic: (v) => wrapInline(v, '*'),
  strike: (v) => wrapInline(v, '~~'),
  highlight: (v) => wrapInline(v, '=='),
  code: (v) => wrapInline(v, '`'),
  math: (v) => wrapInline(v, '$'),
  comment: (v) => wrapInline(v, '%%'),
  clearFormat,
  wikilink: (v) => wrapInline(v, '[[', ']]'),
  link: (v) => wrapInline(v, '[', '](链接)'),
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
  indent: (v) => indentLines(v, false),
  outdent: (v) => indentLines(v, true),
  selectAll: (v) => { v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }); v.focus(); },
};
export { setHeading };
