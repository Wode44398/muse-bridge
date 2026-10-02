// frontmatter「笔记属性」面板 —— Obsidian 式原地编辑 widget（替代旧的「点一下展开 YAML 源码」）。
// 面板即编辑器：键名（带补全）、值（按类型给文本/数字/日期/勾选框/标签胶囊）、类型（右键菜单）
// 全在面板上改，Live Preview 里永不揭示 YAML（要看源码去「源码」模式，同表格的路子）。
//
// 写回是**逐条外科手术**：只重写被动的那一条属性占的行，其余行（注释、缩进、嵌套 map、引号
// 风格）字节不动 —— 全量重新序列化会把这套手写 YAML 子集认不出的东西洗掉，绝不做。
// 文档仍是唯一真相源：每次编辑 dispatch 一次，回流经 updateDOM 增量对账 DOM，
// **聚焦中的输入框一律不碰** → 光标/输入法状态天然保住（同 table.js）。
//
// 类型记忆：YAML 没有类型声明，空值反推不出类型（清空日期 = 清空文本）。故面板 DOM 上挂
// __kinds 记住「这一条现在是什么类型」，只活在面板生命周期内，不落文件。
import { WidgetType } from '@codemirror/view';
import { parseYamlProps, propKind, PROP_ICONS } from '../obsmd.js';
import { t as tt } from '../i18n.js';   // 本文件局部变量大量叫 t（事件目标/胶囊节点），翻译函数用别名

// ============================== 模型：frontmatter 块 ↔ 属性项 ==============================
const KEY_RE = /^(?![-#\s])([^:]+):(?=\s|$)/;

// src = 含 --- 围栏的整块。返回 { items:[{key,value,from,to}], addAt }
//   from/to：该属性所有行在**块内**的字符区间（不含行尾换行；尾部空行不吞）
//   addAt  ：收尾围栏行首偏移（新属性插这儿）
export function parseBlock(src) {
  const lines = String(src).split('\n');
  const at = [];
  let acc = 0;
  for (const l of lines) { at.push(acc); acc += l.length + 1; }
  let close = lines.length;
  for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) { close = i; break; }
  const items = [];
  for (let i = 1; i < close; i++) {
    const m = KEY_RE.exec(lines[i]);
    if (!m) continue;                                   // 续行/列表项/注释 → 归上一条，不单独成项
    let end = i;
    for (let j = i + 1; j < close && !KEY_RE.test(lines[j]); j++) if (lines[j].trim()) end = j;
    const raw = lines.slice(i, end + 1).join('\n');
    const key = m[1].trim().replace(/^["']|["']$/g, '');
    let value;
    try { value = parseYamlProps(raw)[key]; } catch {}
    items.push({ key, value: value === undefined ? '' : value, from: at[i], to: at[end] + lines[end].length });
    i = end;
  }
  return { items, addAt: close < lines.length ? at[close] : acc };
}

const toArray = (v) => (Array.isArray(v) ? v : v === '' || v == null ? [] : [v]);
const txt = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''));

const PLAIN_KEY = /^[\w.一-鿿-]+$/;
const RISKY = /^[\s>|*&!%@`"'[\]{}#,-]|: |\s#|[:\s]$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;

// 标量 → YAML 片段（该加引号就加：会被读回成别的类型/破坏结构的一律引起来）
function scalar(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = txt(v).replace(/[\r\n]+/g, ' ').trim();     // 属性值单行（Obsidian 同）
  if (!s) return '';
  if (RISKY.test(s) || RESERVED.test(s) || /^-?\d+(\.\d+)?$/.test(s)) {
    return s.includes('"') && !s.includes("'") ? "'" + s + "'" : '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

// 一条属性 → YAML 行（可能多行：列表）
export function serialize(key, value, kind) {
  const k = PLAIN_KEY.test(key) ? key : JSON.stringify(key);
  if (kind === 'list' || kind === 'tags') {
    const arr = toArray(value).map(scalar).filter((s) => s !== '');
    return arr.length ? k + ':\n' + arr.map((s) => '  - ' + s).join('\n') : k + ': []';   // 空列表写 []，读回来还是列表
  }
  if (kind === 'bool') return k + ': ' + (value ? 'true' : 'false');
  if (kind === 'num') {
    const s = txt(value).trim();
    const n = Number(s);
    return k + ':' + (s && Number.isFinite(n) ? ' ' + n : '');
  }
  const s = scalar(value);
  return k + ':' + (s ? ' ' + s : '');
}

// 换类型时的值转换（尽量留住信息，留不住就给空）
export function convert(value, kind) {
  const s = Array.isArray(value) ? value.map(txt).join(', ') : txt(value);
  switch (kind) {
    case 'list': case 'tags': return Array.isArray(value) ? value : s ? [s] : [];
    case 'bool': return !!s && s !== 'false' && s !== '0';
    case 'num': { const n = Number(s.replace(/[^\d.\-+eE]/g, '')); return s.trim() && Number.isFinite(n) ? n : ''; }
    case 'date': { const m = /\d{4}-\d{2}-\d{2}/.exec(s); return m ? m[0] : ''; }
    case 'datetime': { const m = /(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s); return m ? m[1] + 'T' + (m[2] || '00:00') : ''; }
    default: return s;
  }
}

const KINDS = [
  { k: 'bool', label: tt('复选框') },
  { k: 'date', label: tt('日期') },
  { k: 'datetime', label: tt('日期 & 时间') },
  { k: 'list', label: tt('列表') },
  { k: 'num', label: tt('数字') },
  { k: 'text', label: tt('文本') },
];

// ============================== 键名补全 ==============================
// 常见键 + 本机学过的键（用过就记住类型，下次新建同名属性直接给对的控件）
const BUILTIN = {
  tags: 'tags', aliases: 'list', cssclasses: 'list', publish: 'bool', description: 'text',
  title: 'text', author: 'text', date: 'date', created: 'datetime', updated: 'datetime',
  source: 'text', cover: 'text', permalink: 'text', rating: 'num', status: 'text',
};
const LS_KEY = 'mde.propkeys';
let learned = null;
function learnedKinds() {
  if (learned) return learned;
  learned = {};
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (o && typeof o === 'object' && !Array.isArray(o)) learned = o;
  } catch {}
  return learned;
}
function learn(key, kind) {
  const m = learnedKinds();
  if (!key || m[key] === kind) return;
  m[key] = kind;
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - 80))) delete m[k];
  try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch {}
}
const kindGuess = (key) => learnedKinds()[key] || BUILTIN[key] || 'text';

function suggest(root, q, selfKey) {
  const used = new Set(parseBlock(root.__src).items.map((i) => i.key));
  used.delete(selfKey);
  const all = { ...BUILTIN, ...learnedKinds() };
  const s = q.trim().toLowerCase();
  const out = [];
  for (const key of Object.keys(all)) {
    if (used.has(key)) continue;
    const at = key.toLowerCase().indexOf(s);
    if (s && at < 0) continue;
    out.push({ key, kind: all[key], at: s ? at : 0 });
  }
  out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  return out.slice(0, 12);
}

// ============================== widget ==============================
let collapsed = false;      // 折叠态跨 widget 重建保留
let autoAdd = false;        // 「插入笔记属性」命令建好空 frontmatter 后，面板一渲染就自动开新行
export function requestAutoAdd() { autoAdd = true; }

export class PropsWidget extends WidgetType {
  constructor(src, opts, ro) { super(); this.src = src; this.opts = opts; this.ro = !!ro; }
  eq(o) { return o.src === this.src && o.ro === this.ro; }   // 只读切换也要换控件
  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'mde-props';
    el.__src = this.src;
    el.__opts = this.opts;
    el.__ro = this.ro;
    el.__kinds = {};
    build(el, view);
    wire(el, view);   // 事件全挂在 root 上代理，后续只换内部 DOM，不用重挂
    if (autoAdd) { autoAdd = false; setTimeout(() => addPending(el, view), 0); }
    return el;
  }
  updateDOM(dom, view) {
    if (!dom.classList || !dom.classList.contains('mde-props')) return false;
    dom.__opts = this.opts;
    if (dom.__ro !== this.ro) { dom.__ro = this.ro; dom.__src = this.src; build(dom, view); return true; }
    if (dom.__src !== this.src) { dom.__src = this.src; patch(dom, view); }
    return true;
  }
  get estimatedHeight() { return 80; }
}

const SVG = (d, w = 2.1) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
// 折叠箭头要带 mde-chev：尺寸/旋转规则挂在这个类上（editor.css），没它 svg 渲染成 0×0，用户看不出面板能折叠
const CHEV = SVG('<path d="m9 6 6 6-6 6"/>', 2.2).replace('<svg ', '<svg class="mde-chev" ');
const PLUS = SVG('<path d="M12 5v14M5 12h14"/>');
const iconOf = (kind) => PROP_ICONS[kind] || PROP_ICONS.text;
const rowOf = (el) => el.closest('.mde-prop');
const editable = (root, view) => !view.state.readOnly;   // 以 state 为准（setReadOnly 后 opts 会过期）

// —— 该行现在按什么类型显示：显式记忆优先，其次从值反推 ——
function kindFor(root, it) {
  const k = root.__kinds[it.key];
  const auto = propKind(it);
  if (!k || k === auto) return auto;
  if (auto === 'json') return 'json';                                  // 嵌套 map 认不了别硬转
  const empty = it.value === '' || it.value == null || (Array.isArray(it.value) && !it.value.length);
  return empty || k === 'text' || auto === 'text' ? k : auto;
}

function build(root, view) {
  root.innerHTML = '';
  root.classList.toggle('collapsed', collapsed);
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'mde-props-h';
  head.innerHTML = CHEV + tt('笔记属性') + '<span class="mde-props-n"></span>';
  const tbl = document.createElement('div');
  tbl.className = 'mde-props-tbl';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'mde-props-add';
  add.innerHTML = PLUS + '<span>' + tt('添加笔记属性') + '</span>';
  root.append(head, tbl, add);
  if (!editable(root, view)) add.style.display = 'none';
  fillRows(root, view);
}

function fillRows(root, view) {
  const { items } = parseBlock(root.__src);
  const tbl = root.querySelector('.mde-props-tbl');
  tbl.innerHTML = '';
  for (const it of items) tbl.appendChild(rowEl(root, view, it));
  root.querySelector('.mde-props-n').textContent = String(items.length);
  takeWant(root);
}

// 源码变了 → 对账：条目名/条数变了整表重排，否则逐行同步（聚焦中的输入框不碰）
function patch(root, view) {
  const { items } = parseBlock(root.__src);
  const tbl = root.querySelector('.mde-props-tbl');
  if (!tbl) return build(root, view);
  const rows = [...tbl.children].filter((r) => !r.classList.contains('pending'));
  if (rows.length !== items.length || rows.some((r, i) => r.dataset.key !== items[i].key)) return fillRows(root, view);
  items.forEach((it, i) => syncRow(root, view, rows[i], it));
  root.querySelector('.mde-props-n').textContent = String(items.length);
  takeWant(root);
}

function syncRow(root, view, row, it) {
  const kind = kindFor(root, it);
  const a = document.activeElement;
  const mine = row.contains(a);
  const ki = row.querySelector('.mde-pk');
  if (ki && a !== ki) ki.value = it.key;
  // 正在输入的框一律不碰（光标/输入法优先）；列表追加框例外——新胶囊得当场出来，
  // 重绘后把焦点还给它，接着敲下一条。
  if (row.__kind === kind && mine && (a.classList.contains('mde-pv') || a.classList.contains('mde-pk') || a.classList.contains('mde-chip-t'))) return;
  const backToAdd = mine && a.classList.contains('mde-padd');
  row.__kind = kind;
  row.querySelector('.mde-pk-ic').innerHTML = iconOf(kind);
  fillValue(root, view, row.querySelector('.mde-prop-v'), it, kind);
  if (backToAdd) row.querySelector('.mde-padd')?.focus();
}

// —— 行 ——
function rowEl(root, view, it) {
  const kind = kindFor(root, it);
  const row = document.createElement('div');
  row.className = 'mde-prop';
  row.dataset.key = it.key;
  row.__kind = kind;
  const kc = document.createElement('div');
  kc.className = 'mde-prop-k';
  const ic = document.createElement('button');
  ic.type = 'button';
  ic.className = 'mde-pk-ic';
  ic.title = tt('属性类型');
  ic.innerHTML = iconOf(kind);
  const ki = document.createElement('input');
  ki.className = 'mde-pk';
  ki.type = 'text';
  ki.spellcheck = false;
  ki.value = it.key;
  ki.placeholder = tt('属性名');
  if (!editable(root, view)) ki.readOnly = true;
  kc.append(ic, ki);
  const vc = document.createElement('div');
  vc.className = 'mde-prop-v';
  fillValue(root, view, vc, it, kind);
  row.append(kc, vc);
  return row;
}

function fillValue(root, view, cell, it, kind) {
  const ro = !editable(root, view);
  cell.innerHTML = '';
  cell.dataset.kind = kind;
  if (kind === 'json') {                                  // 嵌套 map 等面板表达不了的 → 原样只读展示
    const c = document.createElement('code');
    c.className = 'mde-prop-json';
    c.textContent = JSON.stringify(it.value);
    cell.appendChild(c);
    return;
  }
  if (kind === 'bool') {
    const b = document.createElement('input');
    b.type = 'checkbox';
    b.className = 'mde-pv-bool';
    b.checked = !!it.value;
    b.disabled = ro;
    cell.appendChild(b);
    return;
  }
  if (kind === 'list' || kind === 'tags') {
    const arr = toArray(it.value);
    arr.forEach((x, i) => cell.appendChild(chipEl(txt(x), i, kind, ro)));
    if (!ro) {
      const add = document.createElement('input');
      add.className = 'mde-padd';
      add.type = 'text';
      add.spellcheck = false;
      add.placeholder = arr.length ? '' : tt('空');
      cell.appendChild(add);
    } else if (!arr.length) cell.appendChild(emptyMark());
    return;
  }
  const inp = document.createElement('input');
  inp.className = 'mde-pv';
  inp.spellcheck = false;
  if (kind === 'date') inp.type = 'date';
  else if (kind === 'datetime') inp.type = 'datetime-local';
  else {
    inp.type = 'text';
    inp.placeholder = tt('空');
    if (kind === 'num') inp.inputMode = 'decimal';
  }
  inp.value = kind === 'datetime' ? txt(it.value).replace(' ', 'T').slice(0, 16) : txt(it.value);
  if (ro) inp.readOnly = true;
  cell.appendChild(inp);
}

function emptyMark() {
  const s = document.createElement('span');
  s.className = 'mde-prop-empty';
  s.textContent = tt('空');
  return s;
}

function chipEl(text, i, kind, ro) {
  const s = document.createElement('span');
  s.className = 'mde-chip' + (kind === 'tags' ? ' mde-chip-tag' : '');
  s.dataset.i = String(i);
  const t = document.createElement('span');
  t.className = 'mde-chip-t';
  if (!ro) {
    t.setAttribute('contenteditable', 'plaintext-only');
    if (!t.isContentEditable) t.setAttribute('contenteditable', 'true');   // 旧内核回退
  }
  t.textContent = text;
  s.appendChild(t);
  if (!ro) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'mde-chip-x';
    x.tabIndex = -1;
    x.title = tt('删除');
    x.textContent = '×';
    s.appendChild(x);
  }
  return s;
}

// ============================== 写回文档 ==============================
// 块内区间 → 文档区间；位置对不上（widget 与文档脱节）就放弃这次写入，绝不写坏文档
function edit(root, view, from, to, insert) {
  if (!editable(root, view)) return false;
  let base;
  try { base = view.posAtDOM(root); } catch { return false; }
  if (view.state.sliceDoc(base, base + root.__src.length) !== root.__src) return false;
  view.dispatch({ changes: { from: base + from, to: base + to, insert } });
  return true;
}

function itemOf(root, key) {
  return parseBlock(root.__src).items.find((x) => x.key === key) || null;
}

function commit(root, view, key, value, kind) {
  const it = itemOf(root, key);
  if (!it) return false;
  root.__kinds[key] = kind;                        // 记住类型：清空日期/数字后别退化成文本框
  const next = serialize(key, value, kind);
  if (next === root.__src.slice(it.from, it.to)) return false;
  learn(key, kind);
  return edit(root, view, it.from, it.to, next);
}

function addProp(root, view, key, kind) {
  const { items, addAt } = parseBlock(root.__src);
  if (!key || items.some((x) => x.key === key)) return false;
  root.__kinds[key] = kind;
  learn(key, kind);
  return edit(root, view, addAt, addAt, serialize(key, kind === 'list' || kind === 'tags' ? [] : '', kind) + '\n');
}

function renameProp(root, view, oldKey, newKey) {
  const { items } = parseBlock(root.__src);
  const it = items.find((x) => x.key === oldKey);
  if (!it || !newKey || newKey === oldKey || items.some((x) => x.key === newKey)) return false;
  const kind = root.__kinds[oldKey];
  if (kind) { delete root.__kinds[oldKey]; root.__kinds[newKey] = kind; }
  learn(newKey, kind || propKind(it));
  const head = root.__src.slice(it.from, it.to).split('\n')[0];
  const k = PLAIN_KEY.test(newKey) ? newKey : JSON.stringify(newKey);
  return edit(root, view, it.from, it.from + head.indexOf(':'), k);   // 只换键名那一段，值原样
}

function removeProp(root, view, key) {
  const { items } = parseBlock(root.__src);
  const it = items.find((x) => x.key === key);
  if (!it) return false;
  delete root.__kinds[key];
  if (items.length === 1) {                        // 删光最后一条 → 整个 frontmatter 块消失（同 Obsidian）
    if (!editable(root, view)) return false;
    let base;
    try { base = view.posAtDOM(root); } catch { return false; }
    const end = base + root.__src.length;
    if (view.state.sliceDoc(base, end) !== root.__src) return false;
    view.dispatch({ changes: { from: base, to: view.state.sliceDoc(end, end + 1) === '\n' ? end + 1 : end, insert: '' } });
    return true;
  }
  return edit(root, view, it.from, Math.min(it.to + 1, root.__src.length), '');
}

function setKind(root, view, key, kind) {
  const it = itemOf(root, key);
  if (!it) return;
  commit(root, view, key, convert(it.value, kind), kind);
  const row = root.querySelector(`.mde-prop[data-key="${cssEsc(key)}"]`);
  if (row && row.__kind !== kind) {                // 序列化结果没变（空值互转）→ 手动换控件
    row.__kind = kind;
    row.querySelector('.mde-pk-ic').innerHTML = iconOf(kind);
    fillValue(root, view, row.querySelector('.mde-prop-v'), itemOf(root, key) || it, kind);
  }
  want(root, key, 'v');
  takeWant(root);
}

const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

// —— 重排后把焦点找回来（dispatch → updateDOM 是同步的，标记完直接消费）——
function want(root, key, part) { root.__want = { key, part }; }
function takeWant(root) {
  const w = root.__want;
  if (!w) return;
  root.__want = null;
  const row = root.querySelector(`.mde-prop[data-key="${cssEsc(w.key)}"]`);
  if (!row) return;
  const el = w.part === 'k' ? row.querySelector('.mde-pk')
    : row.querySelector('.mde-pv, .mde-padd, .mde-pv-bool') || row.querySelector('.mde-chip-t');
  if (!el) return;
  el.focus();
  if (el.select && el.type !== 'date' && el.type !== 'datetime-local') el.select();
}

// ============================== 交互 ==============================
function valueOf(row) {
  const kind = row.__kind;
  const cell = row.querySelector('.mde-prop-v');
  if (kind === 'bool') return !!cell.querySelector('.mde-pv-bool')?.checked;
  if (kind === 'list' || kind === 'tags') return [...cell.querySelectorAll('.mde-chip-t')].map((t) => t.textContent.replace(/\u00A0/g, ' ').trim()).filter((s) => s !== '');
  return cell.querySelector('.mde-pv')?.value ?? '';
}

function commitRow(root, view, row) {
  commit(root, view, row.dataset.key, valueOf(row), row.__kind);
}

// 新属性行：先只在面板上开一行（键名没定就不往文件里写）
function addPending(root, view) {
  if (!editable(root, view)) return;
  const tbl = root.querySelector('.mde-props-tbl');
  const old = tbl.querySelector('.mde-prop.pending');
  if (old) { old.querySelector('.mde-pk')?.focus(); return; }
  const row = rowEl(root, view, { key: '', value: '' });
  row.classList.add('pending');
  row.dataset.key = '';
  tbl.appendChild(row);
  const ki = row.querySelector('.mde-pk');
  ki.focus();
  openSug(root, view, ki);
}

function commitKey(root, view, row) {
  const ki = row.querySelector('.mde-pk');
  const next = ki.value.trim();
  const old = row.dataset.key;
  closeSug(root);
  if (row.classList.contains('pending')) {
    row.remove();                                  // 占位行先撤，写成功了由重排出真行
    if (!next) return;
    want(root, next, 'v');                         // 落地后焦点接着去值格
    if (!addProp(root, view, next, kindGuess(next))) root.__want = null;
    return;
  }
  if (next === old) return;
  if (!next || !renameProp(root, view, old, next)) {
    ki.value = old;
    if (next && next !== old) bad(row);
  }
}

let badT = null;
function bad(row) {
  row.classList.add('bad');
  clearTimeout(badT);
  badT = setTimeout(() => row.classList.remove('bad'), 700);
}

// —— 键名补全下拉 ——
function openSug(root, view, ki) {
  const row = rowOf(ki);
  closeSug(root);
  const list = suggest(root, ki.value, row.dataset.key);
  if (!list.length) return;
  const q = ki.value.trim().toLowerCase();
  const box = document.createElement('div');
  box.className = 'mde-sug';
  for (const s of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mde-sug-i';
    b.dataset.key = s.key;
    b.innerHTML = iconOf(s.kind);
    const lb = document.createElement('span');
    if (q && s.at >= 0) {
      const hit = document.createElement('b');
      hit.textContent = s.key.slice(s.at, s.at + q.length);
      lb.append(document.createTextNode(s.key.slice(0, s.at)), hit, document.createTextNode(s.key.slice(s.at + q.length)));
    } else lb.textContent = s.key;
    b.appendChild(lb);
    box.appendChild(b);
  }
  box.firstChild.classList.add('on');
  row.querySelector('.mde-prop-k').appendChild(box);
}
function closeSug(root) { root.querySelector('.mde-sug')?.remove(); }
function sugMove(root, d) {
  const box = root.querySelector('.mde-sug');
  if (!box) return false;
  const all = [...box.children];
  const i = all.findIndex((e) => e.classList.contains('on'));
  all[i]?.classList.remove('on');
  const n = all[(i + d + all.length) % all.length];
  n?.classList.add('on');
  n?.scrollIntoView({ block: 'nearest' });
  return true;
}
function sugPick(root, view, ki, el) {
  const b = el || root.querySelector('.mde-sug .on');
  if (!b) return false;
  ki.value = b.dataset.key;
  closeSug(root);
  want(root, b.dataset.key, 'v');      // 选中键名 = 接着填值
  commitKey(root, view, rowOf(ki));
  takeWant(root);
  return true;
}

// —— 列表：追加/删除胶囊 ——
function pushChip(root, view, row, text) {
  const t = String(text).trim();
  if (!t) return;
  commit(root, view, row.dataset.key, valueOf(row).concat(t), row.__kind);
}
function dropChip(root, view, row, i) {
  const arr = valueOf(row);
  arr.splice(i, 1);
  commit(root, view, row.dataset.key, arr, row.__kind);
}

// —— 右键/图标菜单 ——
async function clip(root, text) {
  try { await navigator.clipboard.writeText(text); root.__opts?.flash?.(tt('已复制')); return true; }
  catch { root.__opts?.flash?.(tt('无法写入剪贴板')); return false; }
}
function menuItems(root, view, row) {
  const key = row.dataset.key;
  const ro = !editable(root, view);
  const cur = row.__kind === 'tags' ? 'list' : row.__kind;
  const items = [];
  if (!ro) {
    items.push({
      icon: 'info', label: tt('属性类型'),
      sub: KINDS.map((t) => ({ svg: iconOf(t.k), label: t.label, on: cur === t.k, run: () => setKind(root, view, key, t.k) })),
    });
    items.push('-');
    items.push({ icon: 'cut', label: tt('剪切'), run: async () => { const it = itemOf(root, key); if (it && await clip(root, root.__src.slice(it.from, it.to))) removeProp(root, view, key); } });
  }
  items.push({ icon: 'copy', label: tt('复制'), run: () => { const it = itemOf(root, key); if (it) clip(root, root.__src.slice(it.from, it.to)); } });
  if (!ro) {
    items.push({ icon: 'paste', label: tt('粘贴'), run: () => pasteInto(root, view, key) });
    items.push('-');
    items.push({ icon: 'trash', label: tt('移除'), danger: true, run: () => removeProp(root, view, key) });
  }
  return items;
}
// 粘贴：整条 `键: 值` YAML → 覆盖这一条的值（键名不动）；否则当纯值填进来
async function pasteInto(root, view, key) {
  let t = '';
  try { t = await navigator.clipboard.readText(); } catch {}
  if (!t) { root.__opts?.flash?.(tt('无法读取剪贴板，请用键盘粘贴')); return; }
  const row = root.querySelector(`.mde-prop[data-key="${cssEsc(key)}"]`);
  if (!row) return;
  let value = t;
  const m = KEY_RE.exec(t.split('\n')[0]);
  if (m) {
    try { const o = parseYamlProps(t); const k = Object.keys(o)[0]; if (k) value = o[k]; } catch {}
  }
  const kind = row.__kind === 'json' ? 'text' : row.__kind;
  commit(root, view, key, convert(value, kind), kind);
}

function wire(root, view) {
  const isChip = (el) => el && el.classList && el.classList.contains('mde-chip-t');
  root.__addProp = () => addPending(root, view);   // 「插入 → 笔记属性」命令的入口

  // 可编辑孤岛嵌在 CM contenteditable 宿主里：Chromium 的 mousedown 默认动作会把焦点抢给
  // 外层 cm-content（点了没法编辑的根因）。contenteditable 的胶囊自己接管焦点+光标，
  // 原生 input 让浏览器正常处理，只在没拿到焦点时补一刀。
  root.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (isChip(t)) {
      if (document.activeElement === t || !t.isContentEditable) return;
      e.preventDefault();
      t.focus();
      caretAt(t, e.clientX, e.clientY);
      return;
    }
    if (t.tagName === 'INPUT' && t.type !== 'checkbox' && document.activeElement !== t) {
      setTimeout(() => { if (root.contains(t) && document.activeElement !== t) t.focus(); }, 0);
    }
  });

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('.mde-props-h')) {
      collapsed = !collapsed;
      root.classList.toggle('collapsed', collapsed);
      return;
    }
    if (t.closest('.mde-props-add')) { addPending(root, view); return; }
    const sug = t.closest('.mde-sug-i');
    if (sug) { sugPick(root, view, rowOf(sug).querySelector('.mde-pk'), sug); return; }
    // 属性菜单：点这一行的类型图标弹出（同 Obsidian）。右键不接管，交还浏览器原生
    //（输入框里右键还能用系统粘贴，比自绘菜单读剪贴板可靠）。
    const ic = t.closest('.mde-pk-ic');
    if (ic) {
      const row = rowOf(ic);
      if (row.classList.contains('pending')) return;
      const r = ic.getBoundingClientRect();
      root.__opts?.openMenu?.(r.left, r.bottom + 4, menuItems(root, view, row));
      return;
    }
    const x = t.closest('.mde-chip-x');
    if (x) { dropChip(root, view, rowOf(x), +x.parentElement.dataset.i); return; }
    // 点值格空白 → 进这一条的输入框（手机上格子比控件好点）
    if (t.classList.contains('mde-prop-v')) t.querySelector('.mde-pv, .mde-padd, .mde-pv-bool')?.focus();
  });

  root.addEventListener('compositionstart', () => { root.__composing = true; });
  root.addEventListener('compositionend', (e) => {
    root.__composing = false;
    onInput(e);
  });

  function onInput(e) {
    if (root.__composing) return;
    const t = e.target;
    const row = rowOf(t);
    if (!row) return;
    if (t.classList.contains('mde-pk')) { openSug(root, view, t); return; }
    if (t.classList.contains('mde-padd')) return;                 // 追加框按 Enter/逗号才落地
    if (t.classList.contains('mde-pv') || isChip(t)) commitRow(root, view, row);
  }
  root.addEventListener('input', onInput);
  root.addEventListener('change', (e) => {
    const row = rowOf(e.target);
    if (row && (e.target.classList.contains('mde-pv-bool') || e.target.type === 'date' || e.target.type === 'datetime-local')) commitRow(root, view, row);
  });

  root.addEventListener('keydown', (e) => {
    const t = e.target;
    const row = rowOf(t);
    if (!row) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') {
      stop();
      if (root.querySelector('.mde-sug')) { closeSug(root); return; }
      if (row.classList.contains('pending')) { row.remove(); }
      t.blur();
      leave(view, root);
      return;
    }
    if (t.classList.contains('mde-pk')) {
      if (e.key === 'ArrowDown' && sugMove(root, 1)) return stop();
      if (e.key === 'ArrowUp' && sugMove(root, -1)) return stop();
      if (e.key === 'Enter') {
        stop();
        if (sugPick(root, view, t)) return;
        want(root, t.value.trim(), 'v');
        commitKey(root, view, row);
        takeWant(root);
        return;
      }
      return;
    }
    if (t.classList.contains('mde-padd')) {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        stop();
        pushChip(root, view, row, t.value);
        t.value = '';
        t.focus();
        return;
      }
      if (e.key === 'Backspace' && !t.value) {
        const chips = row.querySelectorAll('.mde-chip');
        if (chips.length) { stop(); dropChip(root, view, row, chips.length - 1); row.querySelector('.mde-padd')?.focus(); }
        return;
      }
      return;
    }
    if (isChip(t)) {
      if (e.key === 'Enter') { stop(); row.querySelector('.mde-padd')?.focus(); }
      return;
    }
    if (e.key === 'Enter' && t.classList.contains('mde-pv')) { stop(); t.blur(); leave(view, root); }
  });

  // 离开某一行 → 按模型重绘该行（数字/日期规范化、空列表补占位）
  root.addEventListener('focusout', (e) => {
    const row = rowOf(e.target);
    const wasKey = e.target.classList?.contains('mde-pk');
    setTimeout(() => {
      if (!root.isConnected) return;
      if (!root.contains(document.activeElement)) closeSug(root);
      if (!row || !root.contains(row) || row.contains(document.activeElement)) return;
      if (wasKey) { closeSug(root); commitKey(root, view, row); return; }
      const it = itemOf(root, row.dataset.key);
      if (it) syncRow(root, view, row, it);
    }, 0);
  });
}

// 光标交还编辑器：落到 frontmatter 之后
function leave(view, root) {
  let base = 0;
  try { base = view.posAtDOM(root); } catch {}
  const pos = Math.min(base + root.__src.length + 1, view.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

// 在元素内按屏幕坐标放光标（同 table.js；点不准就落末尾）
function caretAt(el, x, y) {
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
