// 触屏选区的「位置」与「词」：位置 = { n: 文本节点, o: 偏移 }，选区 = 一对位置（不进浏览器的选区）。
//
// 长按按词选：中文没有空格，靠 Intl.Segmenter 分词（Chromium 的 ICU 对汉字用词典切分）；行内的路径、链接整个选，
// 选半截路径没用。按钮之类不可选的字不算。

const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

function selectable(el) {
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  return (cs.userSelect || cs.webkitUserSelect) !== 'none';
}

// 视口坐标 → 文本位置；落在不可选的字或非文本上返回 null
export function caretAt(doc, x, y) {
  let n = null, o = 0;
  if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(x, y); if (r) { n = r.startContainer; o = r.startOffset; } }
  else if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(x, y); if (p) { n = p.offsetNode; o = p.offset; } }
  if (!n || n.nodeType !== 3 || !n.parentElement || !selectable(n.parentElement)) return null;
  return { n, o };
}

// 手指压着的是哪一个字：落点给的是字与字之间的缝，回头看左右两个字谁真的盖着这个 x
function charAt(doc, pt, x) {
  const r = doc.createRange(), len = pt.n.data.length;
  for (const i of [pt.o, pt.o - 1]) {
    if (i < 0 || i >= len) continue;
    r.setStart(pt.n, i); r.setEnd(pt.n, i + 1);
    const rc = r.getClientRects()[0];
    if (rc && x >= rc.left - 1 && x <= rc.right + 1) return i;
  }
  return Math.min(pt.o, len - 1);
}

export function elRange(el) {
  const tw = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let first = null, last = null, n;
  while ((n = tw.nextNode())) {
    if (!n.data.length || !n.parentElement || !selectable(n.parentElement)) continue;
    if (!first) first = n;
    last = n;
  }
  return first ? { s: { n: first, o: 0 }, e: { n: last, o: last.data.length } } : null;
}

// 长按点中的那个词；点在空白、标点之间返回 null（不接管，交给页面）
export function wordAt(doc, pt, x) {
  const pe = pt.n.parentElement;
  const tok = pe.closest('code, a[href]');
  if (tok && !tok.closest('pre')) return elRange(tok);
  const s = pt.n.data;
  if (!s.trim()) return null;
  const i = charAt(doc, pt, x);
  if (!s[i] || !s[i].trim()) return null;
  let best = null, bd = Infinity;
  if (SEG) {
    for (const g of SEG.segment(s)) {
      if (!g.isWordLike) continue;
      const a = g.index, b = a + g.segment.length, d = i < a ? a - i : i >= b ? i - b + 1 : 0;
      if (d < bd) { bd = d; best = [a, b]; }
      if (d === 0) break;
    }
  }
  if (!best || bd > 0) best = [i, i + 1];   // 标点、符号：只选这一个字
  return { s: { n: pt.n, o: best[0] }, e: { n: pt.n, o: best[1] } };
}

// 两个位置的先后：<0 = a 在前
export function cmp(a, b) {
  if (a.n === b.n) return a.o - b.o;
  const r = a.n.ownerDocument.createRange();
  r.setStart(a.n, a.o);
  return -r.comparePoint(b.n, b.o);
}

export function mkRange(s, e) {
  const r = s.n.ownerDocument.createRange();
  r.setStart(s.n, s.o);
  r.setEnd(e.n, e.o);
  return r;
}

export const alive = (p) => !!(p && p.n.isConnected && p.o <= p.n.data.length);
