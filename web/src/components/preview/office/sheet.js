// 表格模型（SheetGrid 用）：SheetJS 读出来的工作簿 → 可直接上屏的紧凑模型。纯函数、不碰 DOM，Worker 与主线程共用。
//
// SheetJS 社区版读不到的几样自己从 xlsx 的 XML 里补：
//   · 冻结窗格（<sheetView><pane xSplit ySplit state="frozen">）与网格线开关（showGridLines）；
//   · 单元格样式（styles.xml 的 cellXfs → 字体粗斜体 / 字号 / 字色、填充色、对齐、自动换行），按单元格的 s 号挂上。
// 公式：Excel 存盘时带缓存值，直接用；openpyxl 之类写出的文件没有缓存值（只有公式），这里有一个小求值器把常见公式算出来
//   （四则 / 乘方 / 连接 / 比较 / 百分号、单元格与区域引用含跨表、SUM AVERAGE MIN MAX COUNT ROUND IF 等常用函数），
//   算不了的留空，公式栏里照样看得到公式。
//
// 模型（一张表）：
//   { name, hidden, nRows, nCols, colW: number[]（-1 = 隐藏）, rowH: number[] | null（0 = 缺省、-1 = 隐藏）, cells: (Cell[]|undefined)[],
//     merges: [{ r0, c0, r1, c1 }], covered: Set<packed>, anchors: Map<packed, mergeIndex>,
//     freeze: { rows, cols, auto }, grid: bool, clipped: { rows, cols } | null, view: { act, top } | null（存盘时的活动格 / 左上角） }
//   Cell = { w: 显示文本, k: 'n'|'s'|'b'|'e'|'d'|'', s?: 样式号（book.styles 下标）, f?: 公式（不带 =）, raw?: 公式栏里的值, l?: 链接 }
//   book = { sheets: Sheet[], styles: Style[], kind: 'xlsx'|'xls'|'ods'|'csv'|..., activeTab: 打开时的工作表 }
//   Style = { b?, i?, u?, st?（删除线）, sz?（px 换算前的磅值）, fg?, bg?, h?: 'left'|'center'|'right', v?: 'top'|'center'|'bottom', wrap?, ind? }

export const DEF_COL_W = 64;     // Excel 缺省列宽 8.43 字符 ≈ 64px
export const DEF_ROW_H = 22;
export const MAX_ROWS = 200_000;
export const MAX_COLS = 2_000;
export const PACK = 16384;       // 单元格打包键 r * PACK + c（Excel 最多 16384 列）
export const pack = (r, c) => r * PACK + c;

// —— 地址 ——
export function colName(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const addr = (r, c) => colName(c) + (r + 1);
export function decodeAddr(a) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(a || '').trim());
  return m ? { r: +m[2] - 1, c: colIndex(m[1]) } : null;
}
export function rangeLabel(sel) {
  if (!sel) return '';
  const a = addr(sel.r0, sel.c0);
  return sel.r0 === sel.r1 && sel.c0 === sel.c1 ? a : a + ':' + addr(sel.r1, sel.c1);
}

// —— 文本表格解码：先 UTF-8 严格解（坏字节即抛），失败回落 GBK（大陆 Excel 导出的常态），再不行宽松 UTF-8；BOM 剥掉 ——
//   SheetJS 对无 BOM 的 CSV 字节流按 cp1252 解，UTF-8 中文会全成「æ¾è...」，所以必须自己解码再喂字符串。
export function decodeText(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { try { text = new TextDecoder('gbk').decode(bytes); } catch { text = new TextDecoder().decode(bytes); } }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}

// —— 颜色 ——
// 主题色序号按 Excel 的习惯：0 = 背景 1（白）、1 = 文字 1（黑）、2 = 背景 2、3 = 文字 2、4~9 = 强调色 1~6（Office 缺省主题）
const THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF'];
function tintHex(hex, tint) {
  if (!tint) return hex;
  const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const out = ch.map((v) => Math.round(tint < 0 ? v * (1 + tint) : v + (255 - v) * tint));
  return out.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** <color rgb|theme|indexed tint> 的属性串 → '#RRGGBB' 或 '' */
export function xmlColor(attrs) {
  if (!attrs) return '';
  const g = (k) => { const m = new RegExp('\\b' + k + '="([^"]*)"').exec(attrs); return m ? m[1] : null; };
  const tint = parseFloat(g('tint') || '0') || 0;
  const rgb = g('rgb');
  if (rgb && /^[0-9a-f]{6,8}$/i.test(rgb)) return '#' + tintHex(rgb.slice(-6).toUpperCase(), tint);
  const th = g('theme');
  if (th != null && THEME[+th]) return '#' + tintHex(THEME[+th], tint);
  const ix = g('indexed');
  if (ix != null && INDEXED[+ix % 8] && +ix < 64) return '#' + INDEXED[+ix % 8];
  return '';
}

// —— xlsx 的 XML：样式表 / 工作表视图 / 单元格样式号 ——
const attr = (s, k) => { const m = new RegExp('\\s' + k + '="([^"]*)"').exec(s); return m ? m[1] : null; };

function parseStyles(xml) {
  if (!xml) return [];
  const sect = (tag) => { const m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>').exec(xml); return m ? m[1] : ''; };
  const fonts = [...sect('fonts').matchAll(/<font\b[^>]*?(?:\/>|>([\s\S]*?)<\/font>)/g)].map((m) => {
    const b = m[1] || '';
    const f = {};
    if (/<b(\s+val="(1|true)")?\s*\/>/.test(b)) f.b = 1;
    if (/<i(\s+val="(1|true)")?\s*\/>/.test(b)) f.i = 1;
    if (/<u\b(?![^>]*val="none")[^>]*\/>/.test(b)) f.u = 1;
    if (/<strike(\s+val="(1|true)")?\s*\/>/.test(b)) f.st = 1;
    const sz = /<sz\s+val="([\d.]+)"/.exec(b);
    if (sz) f.sz = +sz[1];
    const col = /<color\b([^>]*)\/>/.exec(b);
    if (col) f.fg = xmlColor(col[1]);
    return f;
  });
  const fills = [...sect('fills').matchAll(/<fill\b[^>]*>([\s\S]*?)<\/fill>/g)].map((m) => {
    const pf = /<patternFill\b([^>]*?)(?:\/>|>([\s\S]*?)<\/patternFill>)/.exec(m[1]);
    if (!pf || attr(pf[1], 'patternType') !== 'solid') return '';
    const fg = /<fgColor\b([^>]*)\/>/.exec(pf[2] || '');
    return fg ? xmlColor(fg[1]) : '';
  });
  return [...sect('cellXfs').matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)].map((m, i) => {
    const a = m[1], inner = m[2] || '';
    const st = { ...(fonts[+(attr(a, 'fontId') || 0)] || {}) };
    const bg = fills[+(attr(a, 'fillId') || 0)];
    if (bg) st.bg = bg;
    const al = /<alignment\b([^>]*)\/>/.exec(inner);
    if (al) {
      const h = attr(al[1], 'horizontal');
      if (h === 'center' || h === 'centerContinuous') st.h = 'center';
      else if (h === 'right') st.h = 'right';
      else if (h === 'left') st.h = 'left';
      const v = attr(al[1], 'vertical');
      if (v === 'center' || v === 'top') st.v = v;
      if (attr(al[1], 'wrapText') === '1' || attr(al[1], 'wrapText') === 'true') st.wrap = 1;
      const ind = +(attr(al[1], 'indent') || 0);
      if (ind) st.ind = ind;
    }
    // 缺省字体（11 磅、黑字）不算样式；0 号 xf 一般就是「常规」
    if (st.sz === 11) delete st.sz;
    if (st.fg === '#000000') delete st.fg;
    return i === 0 && !st.b && !st.i && !st.bg && !st.h ? null : st;
  });
}

function parseSheetXml(xml) {
  const out = { freeze: null, grid: true, styled: new Map(), view: null };
  if (!xml) return out;
  const head = xml.slice(0, Math.min(xml.length, (xml.indexOf('<sheetData') + 1 || 4000) + 200));
  const sv = /<sheetView\b([^>]*)>/.exec(head);
  if (sv && /showGridLines="(0|false)"/.test(sv[1])) out.grid = false;
  const pane = /<pane\b([^>]*)\/>/.exec(head);
  if (pane && /state="frozen(Split)?"/.test(pane[1])) {
    const cols = Math.round(+(attr(pane[1], 'xSplit') || 0));
    const rows = Math.round(+(attr(pane[1], 'ySplit') || 0));
    if (rows || cols) out.freeze = { rows, cols, auto: false };
  }
  // 存盘时的活动单元格与滚动位置（Excel 打开文件时停在哪，我们也停在哪）
  const sel = /<selection\b([^>]*)\/>/.exec(head);
  const act = sel ? attr(sel[1], 'activeCell') : null;
  const top = (pane && attr(pane[1], 'topLeftCell')) || (sv && attr(sv[1], 'topLeftCell')) || null;
  if (act || top) out.view = { act, top };
  // 单元格的样式号：<c r="B3" s="2" ...>（空单元格只有样式也要记，表头底色常铺在空格子上）
  const re = /<c\s+r="([A-Z]{1,3})(\d+)"([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const s = /\ss="(\d+)"/.exec(m[3]);
    if (s && s[1] !== '0') out.styled.set(pack(+m[2] - 1, colIndex(m[1])), +s[1]);
  }
  return out;
}

/** xlsx 包里 SheetJS 读不到的东西：{ styles: Style[]（按 xf 号）, sheets: { [表名]: { freeze, grid, styled } } } */
export function readXlsxExtras(bytes, fflate) {
  const { unzipSync, strFromU8 } = fflate;
  let files;
  try {
    files = unzipSync(bytes, { filter: (f) => /^xl\/(workbook\.xml|styles\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/i.test(f.name) });
  } catch { return null; }
  const text = (p) => (files[p] ? strFromU8(files[p]) : '');
  const wbXml = text('xl/workbook.xml');
  if (!wbXml) return null;
  const rels = new Map();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = attr(m[1], 'Id'), tgt = attr(m[1], 'Target');
    if (id && tgt) rels.set(id, tgt.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const sheets = {};
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const name = decodeXml(attr(m[1], 'name') || '');
    const rid = attr(m[1], 'r:id');
    const tgt = rels.get(rid);
    if (!tgt) continue;
    sheets[name] = parseSheetXml(text('xl/' + tgt));
  }
  const wv = /<workbookView\b([^>]*)\/?>/.exec(wbXml);
  const activeTab = Math.max(0, +(wv && attr(wv[1], 'activeTab')) || 0);
  return { styles: parseStyles(text('xl/styles.xml')), sheets, activeTab };
}

export function decodeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
}

// —— 文字宽度（CSV 自动列宽、溢出估算用）：中日韩全角算 2 ——
export function textUnits(s) {
  let n = 0;
  for (const ch of String(s)) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return n;
}

// —— 公式求值 ——
const ERR = (e) => ({ e });
const UNSUP = { unsup: true };          // 不支持的函数 / 名称：整条公式算不出来，显示留空
const isErr = (v) => v && typeof v === 'object' && (v.e || v.unsup);
const isRange = (v) => v && typeof v === 'object' && v.range;

function tokenize(src) {
  const toks = [];
  let i = 0;
  const s = src;
  const REF = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?/;
  const COLS = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})(?![\w(])/;
  const ROWS = /^\$?(\d+):\$?(\d+)/;
  const refAt = (sheet) => {
    const rest = s.slice(i);
    let m = REF.exec(rest);
    if (m && !/^[\w(]/.test(rest.slice(m[0].length))) {
      i += m[0].length;
      const r0 = +m[2] - 1, c0 = colIndex(m[1]);
      const r1 = m[4] ? +m[4] - 1 : r0, c1 = m[3] ? colIndex(m[3]) : c0;
      toks.push({ t: 'ref', sheet, r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) });
      return true;
    }
    if ((m = COLS.exec(rest))) {
      i += m[0].length;
      const a = colIndex(m[1]), b = colIndex(m[2]);
      toks.push({ t: 'ref', sheet, r0: 0, c0: Math.min(a, b), r1: Infinity, c1: Math.max(a, b) });
      return true;
    }
    if ((m = ROWS.exec(rest))) {
      i += m[0].length;
      const a = +m[1] - 1, b = +m[2] - 1;
      toks.push({ t: 'ref', sheet, r0: Math.min(a, b), c0: 0, r1: Math.max(a, b), c1: Infinity });
      return true;
    }
    return false;
  };
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let j = i + 1, v = '';
      for (; j < s.length; j++) {
        if (s[j] === '"') { if (s[j + 1] === '"') { v += '"'; j++; } else break; } else v += s[j];
      }
      toks.push({ t: 'str', v }); i = j + 1; continue;
    }
    if (ch === "'") {
      const end = s.indexOf("'!", i + 1);
      if (end < 0) throw new Error('bad sheet');
      const sheet = s.slice(i + 1, end).replace(/''/g, "'");
      i = end + 2;
      if (!refAt(sheet)) throw new Error('bad ref');
      continue;
    }
    if (ch === '#') {
      const m = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)/.exec(s.slice(i));
      if (!m) throw new Error('bad err');
      toks.push({ t: 'err', v: m[0] }); i += m[0].length; continue;
    }
    if (/[\d.]/.test(ch)) {
      if (ROWS.test(s.slice(i)) && refAt(null)) continue;
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (!m) throw new Error('bad num');
      toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(ch)) {
      const m = /^[A-Za-z_$\u0080-￿][\w.$\u0080-￿]*/.exec(s.slice(i));
      const id = m[0];
      if (s[i + id.length] === '!') { i += id.length + 1; if (!refAt(id)) throw new Error('bad ref'); continue; }
      if (refAt(null)) continue;
      i += id.length;
      let j = i; while (s[j] === ' ') j++;
      if (s[j] === '(') { toks.push({ t: 'fn', v: id.toUpperCase().replace(/^_XLFN\./, '') }); continue; }
      if (/^(TRUE|FALSE)$/i.test(id)) { toks.push({ t: 'bool', v: id.toUpperCase() === 'TRUE' }); continue; }
      toks.push({ t: 'name', v: id }); continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%(),;'.includes(ch)) { toks.push({ t: 'op', v: ch === ';' ? ',' : ch }); i++; continue; }
    throw new Error('bad char ' + ch);
  }
  return toks;
}

const num = (v) => {
  if (isErr(v)) return v;
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v).trim().replace(/,/g, ''));
  return Number.isFinite(n) && String(v).trim() !== '' ? n : ERR('#VALUE!');
};
const str = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? fmtGeneral(v) : String(v));
const truthy = (v) => (typeof v === 'string' ? (/^true$/i.test(v) ? true : /^false$/i.test(v) ? false : ERR('#VALUE!')) : !!num(v));
function fmtGeneral(v) {
  if (!Number.isFinite(v)) return '#NUM!';
  if (Number.isInteger(v)) return String(v);
  return String(+v.toPrecision(15));
}

function cmpVals(a, b) {
  const ta = typeof a === 'number' ? 0 : typeof a === 'string' ? 1 : 2;
  const tb = typeof b === 'number' ? 0 : typeof b === 'string' ? 1 : 2;
  if (a == null) return cmpVals(typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0, b);
  if (b == null) return cmpVals(a, typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0);
  if (ta !== tb) return ta - tb;
  if (ta === 1) { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 求一条公式（不带 =）。env：
 *   sheet：当前表序号 · sheetIndex(name) → 序号 | -1 · value(si, r, c) → 原始值（数字 / 字符串 / 布尔 / null / {e}）
 *   extent(si) → { rows, cols }（整列 / 整行引用收到已用区域）
 * 返回数字 / 字符串 / 布尔 / {e: '#DIV/0!'…} / UNSUP（算不了）
 */
export function evalFormula(src, env) {
  let toks;
  try { toks = tokenize(String(src).replace(/^=/, '')); } catch { return UNSUP; }
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p] && toks[p].t === 'op' && toks[p].v === v;
  const fail = () => { throw UNSUP; };

  const deref = (v) => {
    if (!isRange(v)) return v;
    return env.value(v.si, v.r0, v.c0);   // 标量位置上出现区域：取左上角（隐式交集的简化）
  };
  function eachIn(v, fn) {
    if (isRange(v)) {
      const ext = env.extent(v.si);
      const r1 = Math.min(v.r1, ext.rows - 1), c1 = Math.min(v.c1, ext.cols - 1);
      for (let r = v.r0; r <= r1; r++) for (let c = v.c0; c <= c1; c++) fn(env.value(v.si, r, c), true);
    } else fn(v, false);
  }
  function primary() {
    const tk = toks[p++];
    if (!tk) fail();
    if (tk.t === 'num' || tk.t === 'str' || tk.t === 'bool') return tk.v;
    if (tk.t === 'err') return ERR(tk.v);
    if (tk.t === 'name') return UNSUP;
    if (tk.t === 'ref') {
      const si = tk.sheet == null ? env.sheet : env.sheetIndex(tk.sheet);
      if (si < 0) return ERR('#REF!');
      return { range: true, si, r0: tk.r0, c0: tk.c0, r1: tk.r1, c1: tk.c1 };
    }
    if (tk.t === 'op' && tk.v === '(') {
      const v = expr();
      if (!isOp(')')) fail();
      p++;
      return v;
    }
    if (tk.t === 'fn') {
      if (!isOp('(')) fail();
      p++;
      const args = [];
      if (!isOp(')')) {
        for (;;) {
          args.push(isOp(',') || isOp(')') ? null : expr());
          if (isOp(',')) { p++; continue; }
          break;
        }
      }
      if (!isOp(')')) fail();
      p++;
      return callFn(tk.v, args);
    }
    fail();
  }
  function postfix() {
    let v = primary();
    while (isOp('%')) { p++; const n = num(deref(v)); v = isErr(n) ? n : n / 100; }
    return v;
  }
  function unary() {
    if (isOp('-')) { p++; const n = num(deref(unary())); return isErr(n) ? n : -n; }
    if (isOp('+')) { p++; return unary(); }
    return postfix();
  }
  const bin = (next, ops, apply) => () => {
    let a = next();
    while (peek() && peek().t === 'op' && ops.includes(peek().v)) {
      const op = toks[p++].v;
      const b = next();
      a = apply(op, deref(a), deref(b));
    }
    return a;
  };
  const arith = (op, a, b) => {
    const x = num(a), y = num(b);
    if (isErr(x)) return x;
    if (isErr(y)) return y;
    if (op === '+') return x + y;
    if (op === '-') return x - y;
    if (op === '*') return x * y;
    if (op === '/') return y === 0 ? ERR('#DIV/0!') : x / y;
    const r = Math.pow(x, y);
    return Number.isFinite(r) ? r : ERR('#NUM!');
  };
  const pow = bin(unary, ['^'], arith);
  const mul = bin(pow, ['*', '/'], arith);
  const add = bin(mul, ['+', '-'], arith);
  const cat = bin(add, ['&'], (op, a, b) => (isErr(a) ? a : isErr(b) ? b : str(a) + str(b)));
  const cmp = bin(cat, ['=', '<>', '<', '>', '<=', '>='], (op, a, b) => {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    const d = cmpVals(a, b);
    return op === '=' ? d === 0 : op === '<>' ? d !== 0 : op === '<' ? d < 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : d >= 0;
  });
  function expr() { return cmp(); }

  function nums(args, { countText = false } = {}) {
    const out = [];
    let err = null;
    for (const a of args) {
      eachIn(a, (v, inRange) => {
        if (err) return;
        if (isErr(v)) { err = v; return; }
        if (typeof v === 'number') out.push(v);
        else if (!inRange && v != null) { const n = num(v); if (isErr(n)) err = n; else out.push(n); }
        else if (countText && inRange && typeof v === 'boolean') out.push(v ? 1 : 0);
      });
    }
    return err || out;
  }
  function round(v, d, mode) {
    const x = num(deref(v)), n = num(deref(d ?? 0));
    if (isErr(x)) return x;
    if (isErr(n)) return n;
    const f = Math.pow(10, Math.trunc(n));
    const y = x * f;
    const r = mode === 'up' ? Math.sign(y) * Math.ceil(Math.abs(y) - 1e-9) : mode === 'down' ? Math.trunc(y) : Math.sign(y) * Math.round(Math.abs(y) + 1e-9);
    return r / f;
  }
  function callFn(name, args) {
    const a = (i) => deref(args[i] ?? null);
    switch (name) {
      case 'SUM': { const v = nums(args); return isErr(v) ? v : v.reduce((s, x) => s + x, 0); }
      case 'PRODUCT': { const v = nums(args); return isErr(v) ? v : v.reduce((s, x) => s * x, 1); }
      case 'AVERAGE': { const v = nums(args); return isErr(v) ? v : v.length ? v.reduce((s, x) => s + x, 0) / v.length : ERR('#DIV/0!'); }
      case 'MIN': { const v = nums(args); return isErr(v) ? v : v.length ? Math.min(...v) : 0; }
      case 'MAX': { const v = nums(args); return isErr(v) ? v : v.length ? Math.max(...v) : 0; }
      case 'COUNT': { let n = 0; for (const x of args) eachIn(x, (v) => { if (typeof v === 'number') n++; }); return n; }
      case 'COUNTA': { let n = 0; for (const x of args) eachIn(x, (v) => { if (v != null && v !== '') n++; }); return n; }
      case 'COUNTBLANK': { let n = 0; for (const x of args) eachIn(x, (v) => { if (v == null || v === '') n++; }); return n; }
      case 'ROUND': return round(args[0], args[1], '');
      case 'ROUNDUP': return round(args[0], args[1], 'up');
      case 'ROUNDDOWN': return round(args[0], args[1], 'down');
      case 'INT': { const x = num(a(0)); return isErr(x) ? x : Math.floor(x); }
      case 'ABS': { const x = num(a(0)); return isErr(x) ? x : Math.abs(x); }
      case 'SQRT': { const x = num(a(0)); return isErr(x) ? x : x < 0 ? ERR('#NUM!') : Math.sqrt(x); }
      case 'POWER': return arith('^', a(0), a(1));
      case 'MOD': { const x = num(a(0)), y = num(a(1)); if (isErr(x)) return x; if (isErr(y)) return y; return y === 0 ? ERR('#DIV/0!') : x - y * Math.floor(x / y); }
      case 'PI': return Math.PI;
      case 'IF': { const c = truthy(a(0)); if (isErr(c)) return c; return c ? (args.length > 1 ? a(1) ?? 0 : true) : (args.length > 2 ? a(2) ?? 0 : false); }
      case 'IFERROR': { const v = a(0); return isErr(v) && !v.unsup ? a(1) : v; }
      case 'AND': case 'OR': {
        let acc = name === 'AND', err = null;
        for (const x of args) eachIn(x, (v) => { if (err || v == null) return; const b = truthy(v); if (isErr(b)) err = b; else acc = name === 'AND' ? acc && b : acc || b; });
        return err || acc;
      }
      case 'NOT': { const b = truthy(a(0)); return isErr(b) ? b : !b; }
      case 'CONCATENATE': case 'CONCAT': {
        let s = '';
        for (const x of args) { let err = null; eachIn(x, (v) => { if (isErr(v)) err = v; else s += str(v); }); if (err) return err; }
        return s;
      }
      case 'LEN': { const v = a(0); return isErr(v) ? v : [...str(v)].length; }
      case 'UPPER': { const v = a(0); return isErr(v) ? v : str(v).toUpperCase(); }
      case 'LOWER': { const v = a(0); return isErr(v) ? v : str(v).toLowerCase(); }
      case 'TRIM': { const v = a(0); return isErr(v) ? v : str(v).trim().replace(/ +/g, ' '); }
      case 'LEFT': case 'RIGHT': {
        const v = a(0); if (isErr(v)) return v;
        const n = args.length > 1 ? num(a(1)) : 1; if (isErr(n)) return n;
        const cs = [...str(v)];
        return name === 'LEFT' ? cs.slice(0, n).join('') : cs.slice(Math.max(0, cs.length - n)).join('');
      }
      case 'MID': {
        const v = a(0), st = num(a(1)), n = num(a(2));
        if (isErr(v)) return v; if (isErr(st)) return st; if (isErr(n)) return n;
        return [...str(v)].slice(st - 1, st - 1 + n).join('');
      }
      default: return UNSUP;
    }
  }

  try {
    const v = deref(expr());
    if (p < toks.length) return UNSUP;
    return v == null ? 0 : v;
  } catch (e) {
    if (e === UNSUP) return UNSUP;
    return UNSUP;
  }
}

// —— 工作簿 → 模型 ——
const KIND = { n: 'n', s: 's', b: 'b', e: 'e', d: 'd', z: '' };

/**
 * @param XLSX  SheetJS 模块
 * @param fflate { unzipSync, strFromU8 }（读 xlsx 的冻结窗格与样式；没有就只用 SheetJS 读到的）
 * @param buf   ArrayBuffer | Uint8Array
 * @param ext   扩展名（csv / tsv 先自己解码）
 */
export function parseBook(XLSX, fflate, buf, ext) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const csv = ext === 'csv' || ext === 'tsv';
  const opts = { cellStyles: true, cellNF: true, cellDates: false, dense: false };
  let wb;
  if (csv) wb = XLSX.read(decodeText(bytes), { ...opts, type: 'string', FS: ext === 'tsv' ? '\t' : undefined, raw: false });
  else wb = XLSX.read(bytes, { ...opts, type: 'array' });
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const extras = !csv && zip && fflate && /^(xlsx|xlsm|xltx)$/.test(ext || 'xlsx') ? readXlsxExtras(bytes, fflate) : null;
  return buildBook(XLSX, wb, extras, { csv, kind: ext || 'xlsx' });
}

export function buildBook(XLSX, wb, extras, { csv = false, kind = 'xlsx' } = {}) {
  const styles = [];
  const xfMap = new Map();     // xf 号 → styles 下标
  const fillMap = new Map();   // xls / ods 只有填充色：颜色 → styles 下标
  const styleOfXf = (xf) => {
    if (xfMap.has(xf)) return xfMap.get(xf);
    const st = extras?.styles?.[xf];
    const id = st && Object.keys(st).length ? styles.push(st) - 1 : -1;
    xfMap.set(xf, id);
    return id;
  };
  const styleOfFill = (rgb) => {
    if (fillMap.has(rgb)) return fillMap.get(rgb);
    const id = styles.push({ bg: '#' + rgb }) - 1;
    fillMap.set(rgb, id);
    return id;
  };

  const names = wb.SheetNames || [];
  const sheets = names.map((name, si) => {
    const ws = wb.Sheets[name] || {};
    const meta = wb.Workbook?.Sheets?.[si];
    const ex = extras?.sheets?.[name] || null;
    let maxR = -1, maxC = -1;
    const keys = Object.keys(ws).filter((k) => k[0] !== '!');
    const pos = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const a = XLSX.utils.decode_cell(keys[i]);
      pos[i] = a;
      if (a.r > maxR) maxR = a.r;
      if (a.c > maxC) maxC = a.c;
    }
    for (const m of ws['!merges'] || []) { if (m.e.r > maxR) maxR = m.e.r; if (m.e.c > maxC) maxC = m.e.c; }
    if (ex?.styled) for (const k of ex.styled.keys()) { const r = Math.floor(k / PACK), c = k % PACK; if (r < MAX_ROWS && c < MAX_COLS) { if (r > maxR) maxR = r; if (c > maxC) maxC = c; } }
    const nRows = Math.min(maxR + 1, MAX_ROWS), nCols = Math.min(maxC + 1, MAX_COLS);
    const clipped = maxR + 1 > MAX_ROWS || maxC + 1 > MAX_COLS ? { rows: maxR + 1, cols: maxC + 1 } : null;
    const cells = new Array(nRows);
    const pending = [];
    for (let i = 0; i < keys.length; i++) {
      const { r, c } = pos[i];
      if (r >= nRows || c >= nCols) continue;
      const x = ws[keys[i]];
      const cell = { w: '', k: KIND[x.t] ?? '' };
      if (x.f) cell.f = String(x.f).replace(/^=/, '');
      const hasVal = x.v !== undefined && x.t !== 'z';
      if (hasVal) {
        cell.w = x.w != null ? String(x.w) : formatVal(XLSX, x.v, x.z);
        if (x.t === 'n' && cell.w !== fmtGeneral(x.v)) cell.raw = fmtGeneral(x.v);
        if (x.t === 'b') cell.w = x.v ? 'TRUE' : 'FALSE';
        cell.rv = x.t === 'e' ? ERR(x.w || '#N/A') : x.v;   // 原始值：别的公式引用它时用（建完模型就删）
      } else if (cell.f) {
        cell.k = 'n';
        cell.pf = 1;
        pending.push([r, c, x.z]);
      }
      if (x.z && x.z !== 'General') cell.z = x.z;
      if (x.l?.Target && /^(https?:|mailto:)/i.test(x.l.Target)) cell.l = x.l.Target;
      const xf = ex?.styled?.get(pack(r, c));
      if (xf != null) { const id = styleOfXf(xf); if (id >= 0) cell.s = id; }
      else if (!extras && x.s?.patternType === 'solid' && x.s.fgColor?.rgb && /^[0-9a-f]{6,8}$/i.test(x.s.fgColor.rgb)) {
        const rgb = x.s.fgColor.rgb.slice(-6).toUpperCase();
        if (rgb !== 'FFFFFF') cell.s = styleOfFill(rgb);
      }
      (cells[r] ||= [])[c] = cell;
    }
    // 只有样式没有值的格子（铺了底色的空白）
    if (ex?.styled) {
      for (const [k, xf] of ex.styled) {
        const r = Math.floor(k / PACK), c = k % PACK;
        if (r >= nRows || c >= nCols || cells[r]?.[c]) continue;
        const id = styleOfXf(xf);
        const st = id >= 0 ? styles[id] : null;
        if (st && (st.bg || st.b)) (cells[r] ||= [])[c] = { w: '', k: '', s: id };
      }
    }

    // 列宽 / 行高 / 隐藏
    const colW = new Array(nCols);
    const cols = ws['!cols'] || [];
    const autoCols = [];
    for (let c = 0; c < nCols; c++) {
      const d = cols[c];
      if (!d || (d.width == null && d.wpx == null && d.wch == null && !d.hidden)) autoCols.push(c);
      if (d?.hidden) colW[c] = -1;
      else if (d?.width != null) colW[c] = Math.max(8, Math.round(d.width * 7));
      else if (d?.wpx != null) colW[c] = Math.max(8, Math.round(d.wpx));
      else if (d?.wch != null) colW[c] = Math.max(8, Math.round(d.wch * 7 + 5));
      else colW[c] = DEF_COL_W;
    }
    let rowH = null;
    const rows = ws['!rows'] || [];
    if (rows.length) {
      rowH = new Array(nRows).fill(0);
      for (let r = 0; r < Math.min(rows.length, nRows); r++) {
        const d = rows[r];
        if (!d) continue;
        if (d.hidden) rowH[r] = -1;
        else if (d.hpx) rowH[r] = Math.max(4, Math.round(d.hpx));
        else if (d.hpt) rowH[r] = Math.max(4, Math.round(d.hpt * 96 / 72));
      }
      if (!rowH.some((h) => h)) rowH = null;
    }

    // 合并单元格：锚点 → 合并号；被盖住的格子（不画）
    const merges = [];
    const anchors = new Map();
    const covered = new Set();
    for (const m of ws['!merges'] || []) {
      const mg = { r0: m.s.r, c0: m.s.c, r1: Math.min(m.e.r, nRows - 1), c1: Math.min(m.e.c, nCols - 1) };
      if (mg.r1 < mg.r0 || mg.c1 < mg.c0) continue;
      anchors.set(pack(mg.r0, mg.c0), merges.push(mg) - 1);
      if ((mg.r1 - mg.r0 + 1) * (mg.c1 - mg.c0 + 1) <= 200_000) {
        for (let r = mg.r0; r <= mg.r1; r++) for (let c = mg.c0; c <= mg.c1; c++) if (r !== mg.r0 || c !== mg.c0) covered.add(pack(r, c));
      }
    }

    return {
      name, hidden: !!(meta && meta.Hidden), nRows, nCols, colW, rowH, cells, merges, anchors, covered,
      freeze: ex?.freeze || null, grid: ex ? ex.grid : true, clipped, pending, autoCols: csv ? null : autoCols,
      view: ex?.view || null,
    };
  });

  // 没有缓存值的公式：按需递归求值（带记忆与环检测），再按单元格格式格式化
  const index = new Map(names.map((n, i) => [n.toLowerCase(), i]));
  const memo = new Map();
  const visiting = new Set();
  const env = {
    sheet: 0,
    sheetIndex: (n) => index.get(String(n).toLowerCase()) ?? -1,
    extent: (si) => ({ rows: sheets[si]?.nRows || 0, cols: sheets[si]?.nCols || 0 }),
    value: (si, r, c) => rawValue(si, r, c),
  };
  function rawValue(si, r, c) {
    const cell = sheets[si]?.cells[r]?.[c];
    if (!cell) return null;
    if (!cell.pf) return cell.rv !== undefined ? cell.rv : null;
    const key = si * MAX_ROWS * PACK + pack(r, c);
    if (memo.has(key)) return memo.get(key);
    if (visiting.has(key)) return ERR('#REF!');   // 循环引用
    visiting.add(key);
    const prev = env.sheet;
    env.sheet = si;
    const v = evalFormula(cell.f, env);
    env.sheet = prev;
    visiting.delete(key);
    memo.set(key, v);
    return v;
  }
  for (let si = 0; si < sheets.length; si++) {
    const sh = sheets[si];
    for (const [r, c, z] of sh.pending) {
      const cell = sh.cells[r][c];
      const v = rawValue(si, r, c);
      if (v === UNSUP || (v && v.unsup)) { cell.w = ''; cell.k = ''; continue; }
      if (v && v.e) { cell.w = v.e; cell.k = 'e'; continue; }
      if (typeof v === 'number') { cell.w = formatVal(XLSX, v, z); cell.k = 'n'; if (cell.w !== fmtGeneral(v)) cell.raw = fmtGeneral(v); }
      else if (typeof v === 'boolean') { cell.w = v ? 'TRUE' : 'FALSE'; cell.k = 'b'; }
      else { cell.w = str(v); cell.k = 's'; }
    }
  }
  // 清掉建模用的中间字段，减小搬运体积
  for (const sh of sheets) {
    delete sh.pending;
    // 列宽：CSV 没有列宽，整列按内容定；xlsx 等没写列宽的列只在内容会被截断时放宽（Excel 会截断，看文件时放宽更好读）
    if (!sh.autoCols) autoWidths(sh, null);
    else if (sh.autoCols.length) autoWidths(sh, sh.autoCols);
    delete sh.autoCols;
    for (const row of sh.cells) if (row) for (const cell of row) if (cell) { delete cell.rv; delete cell.pf; }
    // 没写行高的行：大字号、自动换行的格子把行撑高（Excel 打开时也是这样自动调行高）
    autoRowHeights(sh, styles);
    // 没有文件里的冻结窗格：像表头的首行自动冻结（大表滚下去还知道每列是什么）
    if (!sh.freeze) sh.freeze = guessFreeze(sh);
  }
  const at = extras?.activeTab || 0;
  return { sheets, styles, kind, activeTab: at < sheets.length && !sheets[at].hidden ? at : Math.max(0, sheets.findIndex((x) => !x.hidden)) };
}

function formatVal(XLSX, v, z) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    // 浏览器里 xlsx.mjs 具名导出 SSF；Node 走 CJS 时 `import * as` 拿不到它，要从 default 上取
    const SSF = XLSX.SSF || XLSX.default?.SSF;
    try { return SSF.format(z || 'General', v); } catch { return fmtGeneral(v); }
  }
  return String(v);
}

function autoWidths(sh, only) {
  const { cells, colW, nRows, nCols, anchors } = sh;
  const want = only ? new Set(only) : null;
  const units = new Array(nCols).fill(0);
  const lim = Math.min(nRows, 500);
  for (let r = 0; r < lim; r++) {
    const row = cells[r];
    if (!row) continue;
    for (let c = 0; c < Math.min(row.length, nCols); c++) {
      if (want && !want.has(c)) continue;
      const cell = row[c];
      if (!cell?.w) continue;
      // 放宽模式：文字右边是空格子时 Excel 会溢出过去显示，不算；合并单元格的锚点不算
      if (want && (anchors.has(pack(r, c)) || (cell.k !== 'n' && !row[c + 1]?.w))) continue;
      units[c] = Math.max(units[c], textUnits(cell.w));
    }
  }
  for (let c = 0; c < nCols; c++) {
    if (want && !want.has(c)) continue;
    const need = Math.round(units[c] * 7.2 + 16);
    colW[c] = want ? (units[c] ? Math.max(colW[c], Math.min(240, need)) : colW[c]) : Math.max(48, Math.min(360, need));
  }
}

// 字号换算：Excel 的 11 磅 ≈ 我们格子的 13px（整张表按这个比例缩放字号）
export const fontPx = (sz) => (sz || 11) * 13 / 11;

function autoRowHeights(sh, styles) {
  const { cells, nRows, colW } = sh;
  for (let r = 0; r < nRows; r++) {
    const row = cells[r];
    if (!row || (sh.rowH && sh.rowH[r])) continue;
    let need = 0;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      const st = cell && cell.s != null ? styles[cell.s] : null;
      if (!st || (!st.wrap && !(st.sz > 11))) continue;
      const px = fontPx(st.sz);
      let lines = 1;
      if (st.wrap && cell.w && !sh.anchors.has(pack(r, c))) {
        const w = Math.max(16, (colW[c] > 0 ? colW[c] : DEF_COL_W) - 8);
        lines = 0;
        for (const part of cell.w.split('\n')) lines += Math.max(1, Math.ceil(textUnits(part) * px * 0.55 / w));
      }
      need = Math.max(need, Math.round(Math.min(12, lines) * px * 1.3 + 5.5));
    }
    if (need > DEF_ROW_H) (sh.rowH ||= new Array(nRows).fill(0))[r] = need;
  }
}

/** 首行像表头（两格以上、全是文字、下面几行里有数字）且表够长 → 冻结首行 */
export function guessFreeze(sh) {
  const none = { rows: 0, cols: 0, auto: true };
  if (!sh || sh.nRows < 25) return none;
  const head = sh.cells[0];
  if (!head) return none;
  const filled = head.filter((x) => x && x.w !== '');
  if (filled.length < 2 || filled.some((x) => x.k === 'n')) return none;
  for (let r = 1; r < Math.min(sh.nRows, 6); r++) if (sh.cells[r]?.some((x) => x && x.k === 'n')) return { rows: 1, cols: 0, auto: true };
  return none;
}

// —— 布局：前缀和与按像素找行列 ——
/** sizes（每项 px；负数 = 隐藏、0 或缺 = 缺省 def）→ Float64Array 前缀和（长度 n+1） */
export function prefix(sizes, n, def, zoom = 1) {
  const out = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const s = sizes ? sizes[i] : 0;
    out[i + 1] = out[i] + (s < 0 ? 0 : (s || def)) * zoom;
  }
  return out;
}
/** 前缀和里第一个「终点 > px」的下标（px 落在第几行 / 列） */
export function indexAt(pre, px) {
  let lo = 0, hi = pre.length - 2;
  if (hi < 0) return 0;
  if (px <= 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pre[mid + 1] > px) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** 表格里找文字（不分大小写）：返回 [{ r, c }]，按行优先；最多 limit 条 */
export function findCells(sh, q, limit = 50_000) {
  const out = [];
  const needle = String(q || '').toLowerCase();
  if (!needle || !sh) return out;
  for (let r = 0; r < sh.nRows; r++) {
    const row = sh.cells[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell && cell.w && cell.w.toLowerCase().includes(needle)) {
        out.push({ r, c });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** 选区 → 制表符分隔文本（复制到 Excel / 记事本都成表） */
export function selectionTsv(sh, sel) {
  if (!sh || !sel) return '';
  const lines = [];
  const r1 = Math.min(sel.r1, sh.nRows - 1), c1 = Math.min(sel.c1, sh.nCols - 1);
  for (let r = sel.r0; r <= r1; r++) {
    const row = sh.cells[r] || [];
    const vals = [];
    for (let c = sel.c0; c <= c1; c++) {
      const w = row[c]?.w ?? '';
      vals.push(/[\t\n"]/.test(w) ? '"' + w.replace(/"/g, '""') + '"' : w);
    }
    lines.push(vals.join('\t'));
  }
  return lines.join('\n');
}
