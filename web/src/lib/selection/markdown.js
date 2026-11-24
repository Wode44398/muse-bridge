// 「复制为 Markdown」：按块生成，规则只有一条——选区盖住了一个块的开头，才带上这个块的标记
// （「- 」「1. 」「## 」「> 」、代码围栏）；从块中间开始选就只给行内文字。和墨的样子一致：
// 墨盖住了列表圆点，复制出来就有「- 」。
import { coversStart } from './measure.js';

const viewOf = (el) => el.ownerDocument.defaultView;
const isBlock = (el) => { const d = viewOf(el).getComputedStyle(el).display; return d && !d.startsWith('inline') && d !== 'contents'; };

function blockOf(el) {
  for (let e = el; e; e = e.parentElement) if (isBlock(e)) return e;
  return null;
}

function inline(n) {
  if (n.nodeType === 3) return n.data.replace(/\s+/g, ' ');
  if (n.nodeType !== 1) return '';
  const el = n, tag = el.tagName;
  const view = viewOf(el);
  if ((view.getComputedStyle(el).userSelect || '') === 'none') return '';
  const inner = () => [...el.childNodes].map(inline).join('');
  switch (tag) {
    case 'STRONG': case 'B': return '**' + inner() + '**';
    case 'EM': case 'I': return '*' + inner() + '*';
    case 'DEL': case 'S': return '~~' + inner() + '~~';
    case 'CODE': return '`' + el.textContent + '`';
    case 'BR': return '\n';
    case 'IMG': return el.getAttribute('alt') ? `![${el.getAttribute('alt')}](${el.getAttribute('src') || ''})` : '';
    case 'A': {
      const href = el.getAttribute('href') || '';
      const txt = inner();
      return /^(https?:|mailto:)/i.test(href) ? `[${txt}](${href})` : txt;
    }
    default: return inner();
  }
}

function langOf(pre) {
  const code = pre.querySelector('code');
  const m = (code?.className || '').match(/language-([\w+#-]+)/);
  return pre.dataset.lang || code?.dataset.lang || (m ? m[1] : '');
}

export function rangeToMd(range) {
  const doc = range.startContainer.ownerDocument;
  const anc = range.commonAncestorContainer;
  const texts = [];
  if (anc.nodeType === 3) texts.push(anc);
  else {
    const tw = doc.createTreeWalker(anc, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) if (n.data.trim() && range.intersectsNode(n)) texts.push(n);
  }
  // 文档顺序里每段文字所属的块，去重；PRE 整块算一个（里面的 code 是行内的）
  const blocks = [];
  const seen = new Set();
  for (const t of texts) {
    let b = t.parentElement && blockOf(t.parentElement);
    if (!b) continue;
    const pre = b.closest('pre');
    if (pre) b = pre;
    if (seen.has(b)) continue;
    seen.add(b);
    blocks.push(b);
  }
  const out = [];
  for (const b of blocks) {
    const r = doc.createRange();
    r.selectNodeContents(b);
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
    // 松散列表里 li 套着 p：标记按 li 算
    const li = b.tagName === 'LI' ? b : (b.parentElement?.tagName === 'LI' && b.parentElement.firstElementChild === b ? b.parentElement : null);
    const head = li || b;
    const whole = coversStart(range, head);
    if (b.tagName === 'PRE') {
      const code = r.toString().replace(/\n$/, '');
      if (!code.trim()) continue;
      out.push({ t: 'pre', s: coversStart(range, b) ? '```' + langOf(b) + '\n' + code + '\n```' : code });
      continue;
    }
    let text = [...r.cloneContents().childNodes].map(inline).join('').replace(/[ \t]+/g, ' ').trim();
    if (!text) continue;
    const quoted = !!b.closest('blockquote');
    let t = 'p';
    if (li) {
      const list = li.parentElement;
      let depth = 0;
      for (let e = list.parentElement; e; e = e.parentElement) if (e.tagName === 'LI') depth++;
      const n = list.tagName === 'OL' ? (+list.getAttribute('start') || 1) + [...list.children].indexOf(li) : 0;
      if (whole) text = '  '.repeat(depth) + (n ? n + '. ' : '- ') + text;
      t = 'li';
    } else if (/^H[1-6]$/.test(b.tagName)) {
      if (whole) text = '#'.repeat(+b.tagName[1]) + ' ' + text;
      t = 'h';
    }
    if (quoted && whole) text = text.split('\n').map((l) => '> ' + l).join('\n');
    out.push({ t, s: text });
  }
  return out.map((o, i) => (i === 0 ? '' : (o.t === 'li' && out[i - 1].t === 'li' ? '\n' : '\n\n')) + o.s).join('');
}
