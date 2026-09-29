// 表格 Excel 式编辑 widget —— Live Preview 里表格**永远保持渲染态**（Obsidian 1.5 同款）：
// 单元格 contenteditable 原地编辑，每次输入把整表序列化回写 markdown 源（IME 合成期缓冲）；
// 结构（增删行列/对齐）经工具条操作。文档是唯一真相源：widget 的 updateDOM 按新源码
// 增量对账 DOM，聚焦格内容一致就不碰 → 光标天然保住。
// 转义：格内 | ↔ \|；换行序列化成空格（GFM 单行约束），<br> 原样保留由渲染态显示。
import { WidgetType } from '@codemirror/view';
import { renderObsInline } from '../obsmd.js';
import { t } from '../i18n.js';

// ============ 模型：markdown ↔ {header, aligns, body} ============
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (ch === '|') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseTableSrc(src) {
  const lines = String(src).split('\n');
  const rows = lines.map(splitRow);
  const header = rows[0] || [];
  const aligns = (rows[1] || []).map((c) => {
    const s = c.trim();
    const l = s.startsWith(':'), r = s.endsWith(':') && s.length > 1;
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const body = rows.slice(2);
  const cols = Math.max(header.length, aligns.length, 1, ...body.map((r) => r.length));
  return { header, aligns, body, cols };
}

const escCell = (s) => String(s).replace(/\u00A0/g, ' ').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
const DELIM = { left: ':---', center: ':---:', right: '---:', '': '---' };

export function serializeTable(m) {
  const row = (r) => '| ' + Array.from({ length: m.cols }, (_, i) => escCell(r[i] ?? '')).join(' | ') + ' |';
  const delim = '| ' + Array.from({ length: m.cols }, (_, i) => DELIM[m.aligns[i] || ''] || '---').join(' | ') + ' |';
  return [row(m.header), delim, ...m.body.map(row)].join('\n');
}

export function emptyTableSrc(cols = 2, rows = 1) {
  return serializeTable({ header: Array.from({ length: cols }, (_, i) => t('列{n}', { n: i + 1 })), aligns: [], body: Array.from({ length: rows }, () => Array(cols).fill('')), cols });
}

// ============ widget ============
export class TableWidget extends WidgetType {
  constructor(src, opts) { super(); this.src = src; this.opts = opts; }
  eq(o) { return o.src === this.src; }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'mde-table';
    wrap.__src = this.src;
    wrap.__opts = this.opts;
    buildTable(wrap, view);
    return wrap;
  }
  updateDOM(dom, view) {
    if (!dom.classList || !dom.classList.contains('mde-table')) return false;
    dom.__opts = this.opts;
    if (dom.__src !== this.src) {
      dom.__src = this.src;
      patchTable(dom, view);
    }
    return true;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 80; }
}

// —— 定位：widget DOM → 文档区间（渲染后源码即 __src，from 由 posAtDOM 现算）——
function docRange(view, wrap) {
  const from = view.posAtDOM(wrap);
  return { from, to: from + wrap.__src.length };
}

function dispatchTable(view, wrap, nextSrc, extra) {
  if (view.state.readOnly) return;
  const { from, to } = docRange(view, wrap);
  if (view.state.sliceDoc(from, to) !== wrap.__src) return;   // 位置对不上就放弃这次写入（绝不写坏文档）
  view.dispatch({ changes: { from, to, insert: nextSrc }, ...(extra || {}) });
}

// 删除整表（连带后随空行）
function removeTable(view, wrap) {
  const { from, to } = docRange(view, wrap);
  let end = to;
  const doc = view.state.doc;
  if (end < doc.length && doc.sliceString(end, end + 1) === '\n') end++;
  view.dispatch({ changes: { from, to: end, insert: '' } });
  view.focus();
}

// ============ DOM 构建 ============
const BTN = (cls, title, svg) => `<button type="button" class="mde-tb ${cls}" title="${title}">${svg}</button>`;
const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const BAR_HTML =
  BTN('t-rowa', t('在下方插入行'), I('<path d="M3 5h18M3 10h18M12 14v7M8.5 17.5 12 21l3.5-3.5"/>')) +
  BTN('t-cola', t('在右侧插入列'), I('<path d="M5 3v18M10 3v18M14 12h7M17.5 8.5 21 12l-3.5 3.5"/>')) +
  BTN('t-rowd', t('删除本行'), I('<path d="M3 6h18M3 12h18M3 18h18M15 9l6 6M21 9l-6 6"/>')) +
  BTN('t-cold', t('删除本列'), I('<path d="M6 3v18M12 3v18M18 8l4 8M22 8l-4 8"/>')) +
  BTN('t-align', t('对齐方式'), I('<path d="M3 6h18M6 12h12M4 18h16"/>')) +
  BTN('t-del', t('删除表格'), I('<path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5"/>'));

function buildTable(wrap, view) {
  wrap.innerHTML = '';
  const opts = wrap.__opts || {};
  const bar = document.createElement('div');
  bar.className = 'mde-tbar';
  bar.innerHTML = BAR_HTML;
  const scroll = document.createElement('div');
  scroll.className = 'mde-tscroll';
  const table = document.createElement('table');
  scroll.appendChild(table);
  if (!opts.readOnly) wrap.appendChild(bar);
  wrap.appendChild(scroll);
  renderRows(wrap, table, parseTableSrc(wrap.__src), view);
  wireTable(wrap, view);
}

function cellKeyOf(cell) { return [+cell.dataset.r, +cell.dataset.c]; }

function setCellContent(cell, raw, focused) {
  cell.__raw = raw;
  if (focused) {
    if (cell.textContent !== raw) cell.textContent = raw;
    cell.classList.add('src');
  } else {
    cell.classList.remove('src');
    let html;
    try { html = renderObsInline(raw); } catch { html = null; }
    if (html == null || html === '') cell.textContent = raw;
    else cell.innerHTML = html;
  }
}

function makeCell(tag, r, c, raw, editable) {
  const cell = document.createElement(tag);
  cell.dataset.r = String(r);
  cell.dataset.c = String(c);
  if (editable) {
    cell.setAttribute('contenteditable', 'plaintext-only');
    if (!cell.isContentEditable) cell.setAttribute('contenteditable', 'true');   // 旧内核回退
  }
  setCellContent(cell, raw, false);
  return cell;
}

function renderRows(wrap, table, m, view) {
  const opts = wrap.__opts || {};
  const editable = !opts.readOnly && !view.state.readOnly;
  table.innerHTML = '';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (let c = 0; c < m.cols; c++) {
    const th = makeCell('th', -1, c, m.header[c] ?? '', editable);
    if (m.aligns[c]) th.style.textAlign = m.aligns[c];
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  const tbody = document.createElement('tbody');
  for (let r = 0; r < m.body.length; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < m.cols; c++) {
      const td = makeCell('td', r, c, m.body[r][c] ?? '', editable);
      if (m.aligns[c]) td.style.textAlign = m.aligns[c];
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(thead);
  table.appendChild(tbody);
}

// 源码变了 → 对账 DOM：结构变了整表重排（操作方自行恢复焦点），
// 只有内容变了则逐格同步、跳过与模型一致的聚焦格（保光标）。
function patchTable(wrap, view) {
  const m = parseTableSrc(wrap.__src);
  const table = wrap.querySelector('table');
  if (!table) return buildTable(wrap, view);
  const htr = table.tHead && table.tHead.rows[0];
  const structureOk = htr && htr.cells.length === m.cols &&
    table.tBodies[0] && table.tBodies[0].rows.length === m.body.length &&
    [...table.tBodies[0].rows].every((tr) => tr.cells.length === m.cols);
  if (!structureOk) { renderRows(wrap, table, m, view); return; }
  const active = document.activeElement;
  const sync = (cell, raw) => {
    const focused = cell === active;
    if (focused && escCell(cell.textContent) === escCell(raw)) { cell.__raw = cell.textContent.replace(/\u00A0/g, ' '); return; }
    setCellContent(cell, raw, focused);
  };
  for (let c = 0; c < m.cols; c++) {
    sync(htr.cells[c], m.header[c] ?? '');
    htr.cells[c].style.textAlign = m.aligns[c] || '';
  }
  const rows = table.tBodies[0].rows;
  for (let r = 0; r < m.body.length; r++) {
    for (let c = 0; c < m.cols; c++) {
      sync(rows[r].cells[c], m.body[r][c] ?? '');
      rows[r].cells[c].style.textAlign = m.aligns[c] || '';
    }
  }
}

// ============ 交互 ============
// 在元素内按屏幕坐标放光标（focus 切源码态后调用；点不准就落末尾）
function placeCaretAt(el, x, y) {
  const sel = window.getSelection();
  if (!sel) return;
  let range = null;
  try {
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); range.collapse(true); }
    }
  } catch {}
  if (!range || !el.contains(range.startContainer)) {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function focusCell(wrap, r, c, selectAll) {
  const cell = wrap.querySelector(`[data-r="${r}"][data-c="${c}"]`);
  if (!cell) return false;
  cell.focus();
  const sel = window.getSelection();
  if (sel && cell.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(cell);
    if (!selectAll) range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
}

function commitCell(view, wrap, cell) {
  const m = parseTableSrc(wrap.__src);
  const [r, c] = cellKeyOf(cell);
  const txt = cell.textContent.replace(/\u00A0/g, ' ');
  cell.__raw = txt;
  if (r === -1) { while (m.header.length < m.cols) m.header.push(''); m.header[c] = txt; }
  else {
    if (!m.body[r]) return;
    while (m.body[r].length < m.cols) m.body[r].push('');
    m.body[r][c] = txt;
  }
  const next = serializeTable(m);
  if (next === wrap.__src) return;
  dispatchTable(view, wrap, next);
}

function mutate(view, wrap, fn) {
  const m = parseTableSrc(wrap.__src);
  const [r, c] = wrap.__active || [-1, 0];
  const out = fn(m, r, c);
  if (out === 'remove') return removeTable(view, wrap);
  const next = serializeTable(m);
  if (next === wrap.__src) return;
  dispatchTable(view, wrap, next);
  if (out && out.focus) requestAnimationFrame(() => focusCell(wrap, out.focus[0], out.focus[1], out.selectAll));
}

const OPS = {
  't-rowa': (m, r, c) => {
    const at = r === -1 ? 0 : r + 1;
    m.body.splice(at, 0, Array(m.cols).fill(''));
    return { focus: [at, Math.max(0, c)] };
  },
  't-cola': (m, r, c) => {
    const at = c + 1;
    m.header.splice(at, 0, '');
    m.aligns.splice(at, 0, '');
    for (const row of m.body) row.splice(at, 0, '');
    m.cols++;
    return { focus: [r, at] };
  },
  't-rowd': (m, r, c) => {
    if (r === -1) return null;                        // 表头行不可删
    m.body.splice(r, 1);
    if (!m.body.length) return { focus: [-1, c] };    // 只剩表头也合法
    return { focus: [Math.min(r, m.body.length - 1), c] };
  },
  't-cold': (m, r, c) => {
    if (m.cols <= 1) return 'remove';
    m.header.splice(c, 1);
    m.aligns.splice(c, 1);
    for (const row of m.body) row.splice(c, 1);
    m.cols--;
    return { focus: [r, Math.min(c, m.cols - 1)] };
  },
  't-align': (m, r, c) => {
    const cycle = { '': 'left', left: 'center', center: 'right', right: '' };
    while (m.aligns.length < m.cols) m.aligns.push('');
    m.aligns[c] = cycle[m.aligns[c] || ''];
    return { focus: [r, c] };
  },
  't-del': () => 'remove',
};

function wireTable(wrap, view) {
  const isCell = (el) => el && (el.tagName === 'TD' || el.tagName === 'TH') && wrap.contains(el);

  wrap.addEventListener('focusin', (e) => {
    const cell = e.target;
    if (!isCell(cell)) return;
    wrap.classList.add('focus');
    wrap.__active = cellKeyOf(cell);
    setCellContent(cell, cell.__raw ?? cell.textContent, true);   // 聚焦 → 显示该格源码
  });

  wrap.addEventListener('focusout', (e) => {
    const cell = e.target;
    if (isCell(cell)) {
      if (wrap.__composing) { wrap.__composing = false; commitCell(view, wrap, cell); }
      setCellContent(cell, cell.__raw ?? '', false);              // 失焦 → 回到渲染态
    }
    setTimeout(() => { if (!wrap.contains(document.activeElement)) wrap.classList.remove('focus'); }, 0);
  });

  wrap.addEventListener('compositionstart', () => { wrap.__composing = true; });
  wrap.addEventListener('compositionend', (e) => {
    wrap.__composing = false;
    if (isCell(e.target)) commitCell(view, wrap, e.target);
  });

  wrap.addEventListener('input', (e) => {
    if (!isCell(e.target) || wrap.__composing) return;
    commitCell(view, wrap, e.target);
  });

  wrap.addEventListener('keydown', (e) => {
    const cell = e.target;
    if (!isCell(cell)) return;
    const m = parseTableSrc(wrap.__src);
    const [r, c] = cellKeyOf(cell);
    const go = (nr, nc, selectAll) => { e.preventDefault(); focusCell(wrap, nr, nc, selectAll); };

    if (e.key === 'Tab') {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      let nr = r, nc = c + dir;
      if (nc >= m.cols) { nr = r + 1; nc = 0; }
      if (nc < 0) { nr = r - 1; nc = m.cols - 1; }
      if (nr >= m.body.length) return mutate(view, wrap, OPS['t-rowa']);   // 最后一格 Tab → 追加一行
      if (nr < -1) return;
      focusCell(wrap, nr, nc, true);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (r + 1 >= m.body.length) return mutate(view, wrap, OPS['t-rowa']);
      focusCell(wrap, r + 1, c, true);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cell.blur();
      const { to } = docRange(view, wrap);
      view.dispatch({ selection: { anchor: Math.min(to + 1, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
      return;
    }
    const sel = window.getSelection();
    const collapsed = sel && sel.isCollapsed;
    if (e.key === 'ArrowUp' && collapsed && r > -1) return go(r - 1, c);
    if (e.key === 'ArrowDown' && collapsed && r + 1 < m.body.length) return go(r + 1, c);
  });

  // 工具条：pointerdown 防抢焦点，click 执行。
  // 格子聚焦必须显式接管：可编辑孤岛嵌在 CM contenteditable 宿主里时，
  // Chromium 对 mousedown 的默认动作会把焦点/选区给外层 cm-content 而不是格子
  //（点了没法编辑的根因）。preventDefault 掐掉默认动作，自己 focus + 按点按坐标放光标。
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mde-tb')) { e.preventDefault(); return; }
    const c = e.target.closest && e.target.closest('td,th');
    if (!c || !isCell(c)) return;
    wrap.__active = cellKeyOf(c);
    if (!c.isContentEditable) return;                       // 只读表格不接管
    if (document.activeElement === c) return;               // 已聚焦：光标调整交还原生
    e.preventDefault();                                     // 同时抑制宿主的 mousedown 默认动作
    c.focus();                                              // 正常路径：focusin 同步触发切源码态
    if (!c.classList.contains('src')) {                     // focusin 没送达（个别 WebView）→ 直接切
      wrap.classList.add('focus');
      setCellContent(c, c.__raw ?? c.textContent, true);
    }
    placeCaretAt(c, e.clientX, e.clientY);
  });
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.mde-tb');
    if (!btn || !wrap.contains(btn)) return;
    e.preventDefault();
    mutate(view, wrap, OPS[btn.classList[1]] || (() => null));
  });
}
