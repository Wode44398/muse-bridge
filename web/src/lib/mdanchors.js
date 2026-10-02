// 阅读态 y ↔ 源码位置 —— DocViewer 在 阅读/编辑/源码 之间切换时保住阅读进度用。
//
// 旧做法只拿标题当刻度、节内按源码字符数线性插值，两个毛病（验收 vis-1 / e2e-7）：
//   · 源码侧用正则数行首 #，渲染侧数全部 h1–h6，再按下标配对——引用/callout 里的标题、Setext 标题
//     多出一个就整体错一位，切换直接跳过一整节；
//   · 刻度太稀：同一节里长代码块（字多、屏上矮）挨着长列表（字少、屏上高），按字符插值偏出一屏。
// 现在的刻度是「顶层块」：用阅读态同一只 Marked 实例把正文切成顶层 token（按 raw 累加得源码偏移，
// 与分块渲染同一口径），和 .doc-md 的顶层元素按顺序配对（标签校验 + 小范围重同步；html 块这类
// 元素数不定的 token 不参与配对，只放宽下一个 token 的重同步窗口）。
// 块内再细分，但只细分编辑态也是「一行一行」排的块——列表逐项（含嵌套）、围栏代码逐行、段落与
// 普通引用按源码行（软换行 <br>）；callout / 表格 / 公式在编辑态是整块 widget，那边只能整块按字符
// 插值，这边也整块插值，两边口径才一致。
// 锚线落在两块之间的空隙里时，吸附到下一块的开头并记下像素差（off）：编辑态空行占一整行、比阅读态的
// 段距高，按字符插值会让空隙下面那块整体错开十几二十像素；吸附后下面的字对齐，只有锚线以上几行吃掉差值。
// 锚线那一行若有一小段附近不重复的纯文字（snipAt），另一态落位后直接找到这段字对齐——长段落两态折行
// 不完全一样、编辑态隐藏的 URL/标记也占字符数，光按字符插值会差出一行。
// 两个方向用的是同一张单调刻度表，阅读→编辑→阅读往返不漂移。编辑态那一侧见 mdeditor topPos/scrollToPos。

const nl = (s) => String(s).replace(/\r\n?/g, '\n');
const SKIP = new Set(['space', 'def', 'footnoteDef']);   // 不产出版面元素的 token
const PRED = {
  heading: (e) => /^H[1-6]$/.test(e.tagName),
  paragraph: (e) => e.tagName === 'P',
  text: (e) => e.tagName === 'P',
  blockquote: (e) => e.tagName === 'BLOCKQUOTE' || e.classList.contains('callout'),   // callout 是原地换成 div 的引用
  list: (e) => e.tagName === 'UL' || e.tagName === 'OL',
  code: (e) => e.tagName === 'PRE',
  table: (e) => e.tagName === 'TABLE',
  hr: (e) => e.tagName === 'HR',
  blockKatex: (e) => e.classList.contains('katex-display') || !!e.querySelector?.(':scope > .katex-display'),
};
const SNAP = 80;   // 吸附上限：锚线离下一块开头超过这么远就不吸附（大空隙里按比例走）
// 对齐用的文字片段：4–24 个不含换行/制表与 markdown 标记符的字（源码里与渲染后长得一样，两态都搜得到；
// 允许单个空格，英文才凑得出够长、不重复的片段）；并且要在 pos 前后 ±800 字的源码里只出现一次——
// 代码里的 variable、重复的短语会认错行。编辑态 mdeditor/index.js 的 topPos/scrollToPos 用同一口径
export const SNIP_RE = /^[^\t\n\r*_`~=[\]<>#|$%\\!&]{4,24}/;
export const snipUnique = (text, snip, pos) => {
  const lo = Math.max(0, Math.floor(pos) - 800), s = text.slice(lo, Math.floor(pos) + 800), i = s.indexOf(snip);
  return i >= 0 && s.indexOf(snip, i + 1) < 0;
};

// 源码侧：分块正文 → 顶层块 [{ type, start, end, tok }]（偏移已换算到整篇、换行已归一成 \n——
// 与 CM 文档同一坐标）。parts 是阅读态渲染用的同一组分块（findSafeCut 切在顶层块边界），
// base 是 frontmatter 的长度；lex(text) 返回该块的顶层 token（obsmd.lexObsBlocks）。
export function srcBlocks(parts, base, lex) {
  const out = [];
  let off = base;
  for (const raw of parts) {
    const part = nl(raw);
    let toks = [];
    try { toks = lex(part) || []; } catch {}
    let o = 0;
    for (const tk of toks) {
      const r = String(tk.raw || '');
      const s = off + Math.min(o, part.length);
      const e = off + Math.min(o + r.replace(/\s+$/, '').length, part.length);   // 终点=最后一个非空白字符之后
      o += r.length;
      if (SKIP.has(tk.type) || !r.trim()) continue;
      out.push({ type: tk.type, start: s, end: Math.max(s, e), tok: tk });
    }
    off += part.length;
  }
  return out;
}

// 刻度点 [源码, y, 类别]：'s'=块顶（块的起点）'e'=块底（块的终点）'m'=块内的行
// → 单调表（源码与 y 都不许回退，回退的点丢掉——配对偶有错位也只丢一个刻度，不会反向插值）
function table(pts) {
  const src = [], ys = [], kind = [];
  for (const [s, y, k] of pts) {
    if (!Number.isFinite(s) || !Number.isFinite(y)) continue;
    if (src.length && (s < src[src.length - 1] || y < ys[ys.length - 1])) continue;
    src.push(s); ys.push(y); kind.push(k || 'm');
  }
  return { src, ys, kind };
}
// 单调表上插值：from 非降序；落在两刻度之间按比例，重复刻度取靠后的那个
function seg(v, from) {
  let lo = 0, hi = from.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (from[mid] <= v) lo = mid; else hi = mid; }
  return lo;
}
function interp(v, from, to) {
  const n = from.length;
  if (!n) return 0;
  if (v <= from[0]) return to[0];
  if (v >= from[n - 1]) return to[n - 1];
  const lo = seg(v, from), hi = lo + 1, d = from[hi] - from[lo];
  return d > 0 ? to[lo] + ((v - from[lo]) / d) * (to[hi] - to[lo]) : to[lo];
}

// 文字所在「行盒」的顶：Range 量到的是字形框，按行高把半个行距补回去（CM 的行块顶是行盒顶）
function lineTop(rect, lh) { return Number.isFinite(lh) && lh > rect.height ? rect.top - (lh - rect.height) / 2 : rect.top; }
const lineHeightOf = (el) => parseFloat(getComputedStyle(el).lineHeight);

// 在源码 [lo, hi) 里顺序找一行字（去首尾空白后）；嵌套在引用/列表里的 token，raw 是剥掉前缀后的文本，
// 与源码对不上，只能这样按行回源码定位
function findLine(text, line, lo, hi) {
  const t = String(line).trim();
  if (!t) return -1;
  const at = text.indexOf(t, lo);
  return at >= 0 && at < hi ? at : -1;
}
// 所在源码行的行首：块/行的「顶」在编辑态对应的是整行的起点（含被隐藏的「> 」「- 」前缀和缩进）——
// 拿正文起点当刻度，编辑态行内按字符插值会把它算到行高的几分之一处（短行能差七八像素）
const bol = (text, at) => text.lastIndexOf('\n', at - 1) + 1;

// 阅读侧映射。root=.doc-md，page=滚动内容的原点元素（.doc-page），blocks=srcBlocks 结果，
// base=frontmatter 长度，total=全文长度，text=归一后的全文（嵌套 token 回源码定位用）。
// 返回 { toSrc(y) → { pos, off }, toY(pos) }，y 是 page 内坐标（= 阅读态 scrollTop 坐标系）；
// off>0 表示锚线落在空隙里、已吸附到下一块开头 pos，pos 在锚线下方 off 像素处。
export function readMapper({ root, page, blocks, base = 0, total, text = '' }) {
  const pageTop = page.getBoundingClientRect().top;
  const Y = (v) => v - pageTop;
  const els = [...root.children];

  // 顶层 token ↔ 顶层元素 顺序配对
  const pairs = [];
  let j = 0, loose = false;
  for (const b of blocks) {
    const want = PRED[b.type];
    if (!want) { loose = true; continue; }   // html / 未知扩展：元素数不定，不配对
    const lim = Math.min(els.length, j + (loose ? 64 : 4));
    let k = j;
    while (k < lim && !want(els[k])) k++;
    if (k < lim) {
      const r = els[k].getBoundingClientRect();
      pairs.push({ b, el: els[k], top: Y(r.top), bottom: Y(r.bottom) });
      j = k + 1;
      loose = false;
    }
  }

  // 粗刻度：[文首, 正文起点, 各块首尾…, 文末]
  const rootTop = Y(root.getBoundingClientRect().top);
  const pts = [[0, 0, 'm']];
  if (base > 0) pts.push([base, rootTop, 'm']);
  for (const p of pairs) { pts.push([p.b.start, p.top, 's']); pts.push([p.b.end, p.bottom, 'e']); }
  const last = pairs.length ? pairs[pairs.length - 1].bottom : rootTop;
  pts.push([total, Math.max(page.offsetHeight, last + 1), 'm']);
  const coarse = table(pts);

  // 细刻度：只给查询落进的那一块算（逐项逐行量 DOM，按需才做），算过就缓存
  const cache = new Map();
  const fine = (p) => {
    let f = cache.get(p);
    if (f) return f;
    const q = [[p.b.start, p.top, 's']];
    try { refine(p.b.tok, p.el, p.b.start, p.b.end, q, Y, text, true); } catch {}
    q.push([p.b.end, p.bottom, 'e']);
    q.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    f = table(q);
    cache.set(p, f);
    return f;
  };
  const pick = (y) => pairs.find((x) => y >= x.top && y <= x.bottom && x.bottom > x.top);

  return {
    paired: pairs.length,   // 排障用：配上了几个顶层块（与 blocks.length 差得多说明渲染与词法对不上）
    // 锚线上的一小段纯文字 + 它首字的顶相对锚线的像素差：块内按字符插值在「长段落 + 行内标记」时会差一行
    // （两态折行不完全一样、编辑态隐藏的 URL/标记也算字符），另一态找到同一段字直接对齐它
    snipAt(y, pos) {
      const r = root.getBoundingClientRect(), sy = y + pageTop;
      if (!document.caretRangeFromPoint) return null;
      for (let x = r.left + 2; x < r.right - 8; x += 18) {   // 行首可能是列表符号/缩进/公式，横向多试几处
        const cr = document.caretRangeFromPoint(x, sy);
        const n = cr?.startContainer;
        if (!n || n.nodeType !== 3 || !root.contains(n) || n.parentElement.closest('.katex, .doc-fence')) continue;
        const m = SNIP_RE.exec(n.data.slice(cr.startOffset, cr.startOffset + 24));
        if (!m || !snipUnique(text, m[0], pos)) continue;
        const rg = document.createRange();
        rg.setStart(n, cr.startOffset); rg.setEnd(n, cr.startOffset + 1);
        const c = rg.getClientRects()[0];
        if (!c || c.top > sy + 8 || c.bottom < sy - 8) continue;   // 得是锚线所在那一行的字
        return { snip: m[0], sdy: c.top - sy };
      }
      return null;
    },
    // 在 nearY 附近（±240px）找这段字，返回首字顶的页内 y；找不到或不止一处（重复短语会认错行）返回 null
    findSnip(snip, nearY) {
      const hits = [];
      const rg = document.createRange();
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (Y(r.bottom) < nearY - 240 || Y(r.top) > nearY + 240) continue;
        const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = tw.nextNode())) {
          for (let i = n.data.indexOf(snip); i >= 0; i = n.data.indexOf(snip, i + 1)) {
            rg.setStart(n, i); rg.setEnd(n, i + 1);
            const c = rg.getClientRects()[0];
            if (c && Math.abs(Y(c.top) - nearY) <= 240) hits.push(Y(c.top));
          }
        }
      }
      return hits.length === 1 ? hits[0] : null;
    },
    toSrc(y) {
      const p = pick(y);
      const t = p ? fine(p) : coarse;
      const n = t.src.length;
      if (n > 1 && y > t.ys[0] && y < t.ys[n - 1]) {
        const i = seg(y, t.ys);
        // 锚线在「上一块底 → 下一块顶」的空隙里：吸附到下一块开头
        if (t.kind[i] === 'e' && t.kind[i + 1] === 's' && t.ys[i + 1] - y <= SNAP) return { pos: t.src[i + 1], off: t.ys[i + 1] - y };
      }
      return { pos: interp(y, t.ys, t.src), off: 0 };
    },
    toY(s) {
      const p = pairs.find((x) => s >= x.b.start && s <= x.b.end && x.b.end > x.b.start);
      const t = p ? fine(p) : coarse;
      return interp(s, t.src, t.ys);
    },
  };
}

// 按块类型细分（verbatim=token 的 raw 就是源码原文、s 是它的准确起点；否则是嵌套 token，按行回源码找）
function refine(tok, el, s, e, q, Y, text, verbatim) {
  if (tok.type === 'list') listPts(tok, s, e, el, q, Y, text, verbatim);
  else if (tok.type === 'code') { if (verbatim && tok.codeBlockStyle !== 'indented') codePts(tok, s, el, q, Y); }
  else if (tok.type === 'paragraph' || tok.type === 'text') paraPts(tok, s, e, el, q, Y, text, verbatim);
  else if (tok.type === 'blockquote' && el.tagName === 'BLOCKQUOTE') quotePts(tok, s, e, el, q, Y, text);
}

// 列表：li ↔ items 逐项。顶层列表的项 raw 是源码原文（首尾相接），直接累加；嵌套的按首行回源码找。
// 项内首段按行细分（长项多行续写），子列表递归。
function listPts(tok, from, to, el, q, Y, text, verbatim) {
  const lis = [...el.children].filter((x) => x.tagName === 'LI');
  const items = tok.items || [];
  if (lis.length !== items.length) return;
  let o = from;
  for (let k = 0; k < items.length; k++) {
    const it = items[k], raw = String(it.raw || '');
    let s, e = null;
    if (verbatim) { s = o; o += raw.length; e = s + raw.replace(/\s+$/, '').length; }
    else {
      const at = findLine(text, raw.split('\n')[0], o, to);
      if (at < 0) continue;
      s = bol(text, at); o = at + 1;
    }
    const li = lis[k], r = li.getBoundingClientRect();
    q.push([s, Y(r.top), 's']);
    const hi = e ?? to;
    const subT = (it.tokens || []).filter((x) => x.type === 'list');
    const subE = [...li.children].filter((x) => x.tagName === 'UL' || x.tagName === 'OL');
    if (subT.length && subT.length === subE.length) subT.forEach((st, i) => listPts(st, s, hi, subE[i], q, Y, text, false));
    if (e != null) q.push([e, Y(r.bottom), 'e']);
  }
}

// 引用（非 callout）：子 token ↔ 子元素逐个配对，按首行回源码定位；段落再按行细分、嵌套引用/列表递归
function quotePts(tok, s, e, el, q, Y, text) {
  const kids = [...el.children];
  let j = 0, lo = s;
  for (const ct of tok.tokens || []) {
    const raw = String(ct.raw || '');
    if (SKIP.has(ct.type) || !raw.trim()) continue;
    const want = PRED[ct.type];
    if (!want) continue;
    let k = j;
    while (k < kids.length && k < j + 3 && !want(kids[k])) k++;
    if (k >= kids.length || !want(kids[k])) continue;
    j = k + 1;
    const lines = raw.replace(/\s+$/, '').split('\n').filter((l) => l.trim());
    const at = findLine(text, lines[0], lo, e);
    if (at < 0) continue;
    const lastAt = lines.length > 1 ? findLine(text, lines[lines.length - 1], at + 1, e) : at;
    const end = lastAt >= 0 ? lastAt + lines[lines.length - 1].trim().length : at + lines[0].trim().length;
    const r = kids[k].getBoundingClientRect();
    q.push([bol(text, at), Y(r.top), 's']);
    refine(ct, kids[k], at, end, q, Y, text, false);
    q.push([end, Y(r.bottom), 'e']);
    lo = end;
  }
}

// root 里第 idx 个字符的字形框（沿文本节点累加定位）
function charRects(root, idxs) {
  const out = new Map();
  if (!idxs.length) return out;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0, k = 0, n;
  const rg = document.createRange();
  while ((n = tw.nextNode()) && k < idxs.length) {
    const len = n.data.length;
    while (k < idxs.length && idxs[k] < acc + len) {
      const at = idxs[k] - acc;
      rg.setStart(n, at); rg.setEnd(n, at + 1);
      const r = rg.getClientRects()[0] || rg.getBoundingClientRect();
      if (r && (r.height || r.width)) out.set(idxs[k], r);
      k++;
    }
    acc += len;
  }
  return out;
}

// 围栏代码：源码第 k 行 ↔ 渲染后第 k 行首字的行盒顶（长行折行两态一致，行内按字符插值即可）
function codePts(tok, start, el, q, Y) {
  const code = el.querySelector('code');
  if (!code) return;
  const rawLines = String(tok.raw || '').split('\n');
  const lines = code.textContent.replace(/\n$/, '').split('\n');
  // 开围栏一行 + 代码行 + （可能有的）收尾围栏；行数对不上（缩进围栏被剥了缩进等）就不细分
  const body = rawLines.slice(1, 1 + lines.length);
  if (body.length !== lines.length) return;
  const starts = [], idxs = [];
  let so = start + rawLines[0].length + 1, co = 0;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].length) { starts.push(so); idxs.push(co); }
    so += body[k].length + 1;
    co += lines[k].length + 1;
  }
  const rects = charRects(code, idxs);
  const lh = lineHeightOf(code);
  idxs.forEach((ci, k) => { const r = rects.get(ci); if (r) q.push([starts[k], Y(lineTop(r, lh)), 'm']); });
}

// 段落：breaks:true 下源码每个单换行渲染成一个 <br>；数量对得上才逐行细分（第 k 行首字的行盒顶）。
// 顶层段落的行首直接由 raw 算；嵌套段落（引用/列表里）按行回源码找。
function paraPts(tok, s, e, el, q, Y, text, verbatim) {
  const brs = [...el.querySelectorAll('br')];
  if (!brs.length) return;
  const raw = String(tok.raw || '').replace(/\s+$/, '');
  const rawLines = raw.split('\n');
  if (rawLines.length - 1 !== brs.length) return;
  const starts = [];
  if (verbatim) { let o = s; for (let k = 0; k < rawLines.length - 1; k++) { o += rawLines[k].length + 1; starts.push(o); } }
  else {
    let lo = s;
    for (let k = 1; k < rawLines.length; k++) { const at = findLine(text, rawLines[k], lo, e + 1); starts.push(at < 0 ? -1 : bol(text, at)); if (at >= 0) lo = at + 1; }
  }
  const lh = lineHeightOf(el);
  const rg = document.createRange();
  brs.forEach((br, k) => {
    if (starts[k] < 0) return;
    // br 之后的第一个非空文本节点的首字
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    tw.currentNode = br;
    let n = tw.nextNode();
    while (n && !n.data.trim()) n = tw.nextNode();
    if (!n) return;
    const at = n.data.search(/\S/);
    rg.setStart(n, at); rg.setEnd(n, at + 1);
    const r = rg.getClientRects()[0];
    if (r) q.push([starts[k], Y(lineTop(r, lh)), 'm']);
  });
}
