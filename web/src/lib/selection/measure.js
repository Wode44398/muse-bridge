// 把一个 Range 量成「按行的带子」：坐标相对墨层原点（墨层左上角在视口里的位置）。
//
// 一行属于哪个块：离文字最近的块级祖先——它的行盒就是这个祖先排出来的，按它的行高和内容区顶端
// 对齐成格子，同一段里上下相邻的带子才能严丝合缝地接上。不写死标签名单：各页的 Markdown 结构不一样。
export const PAD = 3;    // 墨比字左右各宽出一点，不贴着笔画
const MARK = 17;         // 列表圆点 / 序号到正文左缘的距离：从头选中一条列表项时，墨连圆点一起盖

const viewOf = (el) => el.ownerDocument.defaultView;

function blockOf(el, cache) {
  for (let e = el; e; e = e.parentElement) {
    let d = cache.get(e);
    if (d === undefined) { d = viewOf(e).getComputedStyle(e).display; cache.set(e, d); }
    if (d && !d.startsWith('inline') && d !== 'contents') return e;
  }
  return null;
}

// 不可选的字（.sel-text 里的按钮、代码块的复制钮）选区会跨过去，但浏览器本来就不给它涂色
function unselectable(el, cache) {
  let v = cache.get(el);
  if (v === undefined) {
    const cs = viewOf(el).getComputedStyle(el);
    v = (cs.userSelect || cs.webkitUserSelect) === 'none';
    cache.set(el, v);
  }
  return v;
}

// 选区是否盖住了这个块的开头（第一个非空白字）。列表项的墨要不要伸到圆点、复制 Markdown 要不要带「- 」都看它。
export function coversStart(range, el) {
  const tw = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    const i = n.data.search(/\S/);
    if (i < 0) continue;
    try { return range.comparePoint(n, i) === 0 && range.comparePoint(n, i + 1) === 0; } catch { return false; }
  }
  return false;
}

let bidN = 0;
const bids = new WeakMap();
const bidOf = (el) => { let v = bids.get(el); if (!v) { v = ++bidN; bids.set(el, v); } return v; };

export function measure(range, origin) {
  const doc = range.startContainer.ownerDocument;
  const anc = range.commonAncestorContainer;
  const nodes = [];
  if (anc.nodeType === 3) nodes.push(anc);
  else {
    const tw = doc.createTreeWalker(anc, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) if (range.intersectsNode(n)) nodes.push(n);
  }
  const disp = new Map(), sel = new Map(), blocks = new Map(), lines = new Map();
  for (const t of nodes) {
    if (!t.data.trim()) continue;
    const pe = t.parentElement;
    if (!pe || unselectable(pe, sel)) continue;
    const s = t === range.startContainer ? range.startOffset : 0;
    const e = t === range.endContainer ? range.endOffset : t.data.length;
    if (e <= s) continue;
    const block = blockOf(pe, disp);
    if (!block) continue;
    let bi = blocks.get(block);
    if (!bi) {
      const br = block.getBoundingClientRect(), cs = viewOf(block).getComputedStyle(block);
      const fs = parseFloat(cs.fontSize) || 16;
      const lh = parseFloat(cs.lineHeight) || fs * 1.25;   // normal：按常见字体近似
      bi = {
        id: bidOf(block), el: block, lh,
        top: br.top + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth),
        left: br.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
        right: br.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
      };
      blocks.set(block, bi);
    }
    const r = doc.createRange();
    r.setStart(t, s);
    r.setEnd(t, e);
    for (const rc of r.getClientRects()) {
      if (rc.width < 0.5) continue;
      const idx = Math.max(0, Math.round((rc.top + rc.height / 2 - bi.top - bi.lh / 2) / bi.lh));
      const key = bi.id + ':' + idx;
      const L = lines.get(key);
      if (!L) lines.set(key, { key, bi, idx, x1: rc.left, x2: rc.right });
      else { L.x1 = Math.min(L.x1, rc.left); L.x2 = Math.max(L.x2, rc.right); }
    }
  }
  const arr = [...lines.values()].sort((a, b) => (a.bi.top + a.idx * a.bi.lh) - (b.bi.top + b.idx * b.bi.lh) || a.x1 - b.x1);
  // 中间行铺满到段宽：只有真正的起点和终点是自由边，整块读起来是「一块」而不是一排参差的色条
  arr.forEach((L, i) => {
    if (i > 0) L.x1 = Math.min(L.x1, L.bi.left);
    if (i < arr.length - 1) L.x2 = Math.max(L.x2, L.bi.right);
  });
  const cov = new Map();
  for (const L of arr) {
    if (L.idx !== 0 || L.bi.el.tagName !== 'LI') continue;
    if (!cov.has(L.bi.el)) cov.set(L.bi.el, coversStart(range, L.bi.el));
    if (cov.get(L.bi.el)) L.x1 = Math.min(L.x1, L.bi.left - MARK);
  }
  return arr.map((L) => ({
    key: L.key, bid: L.bi.id, h: L.bi.lh,
    y1: L.bi.top + L.idx * L.bi.lh - origin.top,
    x1: L.x1 - origin.left - PAD,
    x2: L.x2 - origin.left + PAD,
  }));
}
