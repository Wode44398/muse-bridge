// 流式 markdown 的「写头修补」——只作用于正在增长的末块（Thread 流式期间 streamBlocks 的尾巴）。
//
// 为什么要修：网络一批批送来的是「半截 markdown」，直接交给 marked 会在写头处出各种怪相，而且这些
// 怪相是【非单调】的——先显示出来的字符，下一批到了又变没或变样：
//   · 表格：表头行打完、分隔行还没来 → 先渲染成一段带竖线的正文，下一批「啪」地变成表格；
//     只有表头时按表头排列宽，首行一到列宽大变；半截数据行一边打一边把整张表的列宽来回顶。
//   · 「Hello\n-」→ marked 当 setext 标题，Hello 闪一下变大号 h2，下个字到了又缩回去。
//   · 「1」「##」「- 」「```py」→ 先显示成字面，再变成列表 / 标题 / 代码块。
//   · `**粗` / `` `代码 `` / `[链接](htt` → 星号、反引号、半截 URL 裸奔，补齐后又消失。
// 吐字引擎（claudeFade.js）按「可见字符」的序号逐字显形，前缀稳定是它的前提：已经显形的字后面
// 不能再变。所以这里的原则是：
//   1) 写头处不确定的东西【先扣住】——吐字本来就比到达慢两三百毫秒，扣住的那几个字在补齐之前
//      根本还没轮到显形，肉眼零代价；
//   2) 已能确定结构的【提前补齐】——未闭合的 `**` / `` ` `` / ~~ 在末尾补上闭合、进行中的代码块补上
//      闭合围栏，让正在写的粗体 / 代码从第一个字起就是最终样式。
// 只看末块（且主要只看最后一行），O(行长)；流式结束（live=false）后 Thread 直接渲染原文，
// 模型真忘了闭合的，最终仍按原文显示。

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// 末行「整行先扣住」的形态：结构还没定、显示出来下一刻就会变的行。
const HOLD_LINE = [
  /^ {0,3}(?:`{3,}|~{3,})[^`]*$/,                      // 围栏开头（含语言名）还没换行
  /^ {0,3}(?:`{1,2}|~{1,2})$/,                         // 一两个反引号 / 波浪线，可能长成围栏
  /^ {0,3}#{1,6}[ \t]*$/,                              // 只有井号的标题
  /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)]?)?[ \t]*$/, // 只有列表 / 引用标记（或纯数字，可能是「1.」）
  /^ {0,3}([-*_=])(?:[ \t]*\1)*[ \t]*$/,               // 分隔线 / setext 下划线（Hello\n- 会变 h2）
  /^[ \t]*(?:>[ \t]*)*[-*+][ \t]+\[[ xX]?\]?[ \t]*$/,  // 任务列表的复选框还没打完
  /^ {0,3}<[^>]*$/,                                    // 块级 HTML 起手
  /^ {0,3}\${1,2}[ \t]*$/,                             // $ / $$ 起手
];
const holdLine = (ln) => HOLD_LINE.some((re) => re.test(ln));

// 行首块标记（引用 / 列表 / 任务框 / 标题）——行内修补只动标记后面的正文，免得把「* 项」的星号当强调。
const BLOCK_PREFIX = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(?:#{1,6}[ \t]+)?/;

const isRow = (ln) => /^ {0,3}\|/.test(ln);
const isDelim = (ln) => /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(ln);
const endsWithPipe = (ln) => { const s = ln.trimEnd(); return s.endsWith('|') && !s.endsWith('\\|'); };

// GFM 单元格切分（只认未转义的 |；不用 lookbehind——iOS Safari <16.4 解析含 lookbehind 的正则字面量会整模块崩）。
export function splitCells(ln) {
  let s = ln.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (endsWithPipe(s)) s = s.trimEnd().slice(0, -1);
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === '|') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// —— 行内修补（单行）——
// 代码段：把已闭合的代码段内容遮成中性字符（不参与强调 / 链接判定）；找出未闭合的开头。
function maskCode(s) {
  const runs = [];
  const re = /`+/g;
  let m;
  while ((m = re.exec(s))) runs.push({ pos: m.index, n: m[0].length });
  const t = s.split('');
  let open = null;
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    let close = -1;
    for (let j = k + 1; j < runs.length; j++) if (runs[j].n === r.n) { close = j; break; }
    if (close < 0) { open = r; for (let i = r.pos; i < s.length; i++) t[i] = 'x'; break; }
    const end = runs[close].pos + r.n;
    for (let i = r.pos; i < end; i++) t[i] = 'x';
    k = close;
  }
  return { t: t.join(''), open };
}

const isSpace = (c) => !c || /\s/.test(c);
const isWord = (c) => !!c && /[\p{L}\p{N}]/u.test(c);

// 未闭合强调（** / * / _ / ~~）——栈式近似 CommonMark 的左右侧规则，够流式写头用。
function openEmphasis(t) {
  const stack = [];
  for (let i = 0; i < t.length;) {
    const ch = t[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch !== '*' && ch !== '_' && ch !== '~') { i++; continue; }
    let j = i;
    while (t[j] === ch) j++;
    const n = j - i, before = t[i - 1], after = t[j];
    const pos = i;
    i = j;
    if (ch === '~' && n < 2) continue;                          // 单个 ~ 是字面（md.js soloTilde）
    const top = stack[stack.length - 1];
    if (top && top.ch === ch && !isSpace(before)) { stack.pop(); continue; }
    const canOpen = !isSpace(after)
      && (ch !== '_' || !isWord(before))                         // 词内下划线永不算强调（snake_case）
      && (ch !== '*' || n >= 2 || !isWord(before));              // 词内单星号多半是乘号 / 字面
    if (canOpen) stack.push({ ch, n, pos });
  }
  return stack;
}

export function repairInline(src) {
  let s = src;
  // 结尾单个反斜杠（下一个字会被它转义掉）、半截实体（&amp → &）——扣住
  const bs = /\\+$/.exec(s);
  if (bs && bs[0].length % 2 === 1) s = s.slice(0, -1);
  s = s.replace(/&#?[a-zA-Z0-9]{0,12}$/, '');

  let { t, open } = maskCode(s);
  if (open && open.pos + open.n >= s.length) {                   // 只有开头的反引号、还没内容：扣住
    s = s.slice(0, open.pos);
    ({ t, open } = maskCode(s));
  }
  let link = null;
  if (!open) {
    let x = /<(?:\/?[A-Za-z][^<>]{0,40}|!-{0,2}|!--(?:(?!-->)[^])*)$/.exec(t);    // 半截 HTML 标签 / 注释
    if (x) { s = s.slice(0, x.index); t = t.slice(0, x.index); }
    if ((x = /!\[[^[\]]{0,200}(?:\](?:\([^()]*)?)?$/.exec(t))) {                  // 图片没写完：整个扣住
      s = s.slice(0, x.index); t = t.slice(0, x.index);
    } else if ((x = /\[([^[\]]*)\]\(([^()]*)$/.exec(t))) {                          // 链接文字已定、URL 还在打
      link = { at: x.index, end: x.index + 1 + x[1].length };
      t = t.slice(0, link.end) + 'x'.repeat(t.length - link.end);
    } else if ((x = /\[[^[\]]{0,120}\]?$/.exec(t))) {                                // [文字 / [文字]：可能是链接，扣住
      s = s.slice(0, x.index); t = t.slice(0, x.index);
    }
  }
  // 结尾的一串 * _ ~ 分不清是开是合还是半个闭合——扣住（下一批到了自然见分晓）
  const tail = /[*_~]+[ \t]*$/.exec(t);
  if (tail && !(open || link)) { s = s.slice(0, tail.index); t = t.slice(0, tail.index); }

  const stack = openEmphasis(t);
  let closers = '';
  for (let k = stack.length - 1; k >= 0; k--) {
    const o = stack[k];
    if (!/\S/.test(t.slice(o.pos + o.n))) {                     // 开头之后还没正文：连开头一起扣住
      s = s.slice(0, o.pos); t = t.slice(0, o.pos);
      if (link && link.at >= o.pos) link = null;
      if (open && open.pos >= o.pos) open = null;
      continue;
    }
    closers += o.ch.repeat(o.n);
  }
  if (link) s = s.slice(0, link.at) + '<a>' + s.slice(link.at + 1, link.end) + '</a>';   // 无 href：点不动、样式同链接
  if (open) s += '`'.repeat(open.n);
  else s = s.replace(/[ \t]+$/, '');                              // 闭合符要贴着正文，否则不算右侧定界
  return s + closers;
}

// 主入口：修补末块。src 是 streamBlocks 的最后一块（流式中、还在增长）。
export function repairTail(src) {
  if (!src) return src;
  const nl = src.lastIndexOf('\n');
  const head = nl < 0 ? '' : src.slice(0, nl + 1);       // 已完整的行（含结尾换行）
  let last = nl < 0 ? src : src.slice(nl + 1);            // 正在打的末行（可能为空）
  const lines = head ? head.slice(0, -1).split('\n') : [];

  // 围栏 / $$ 数学块状态
  let fence = null, math = -1, off = 0;
  for (const ln of lines) {
    const start = off;
    off += ln.length + 1;
    if (fence) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(ln);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.n) fence = null;
      continue;
    }
    if (math < 0) {
      const m = FENCE_OPEN.exec(ln);
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) { fence = { ch: m[1][0], n: m[1].length }; continue; }
    }
    if (((ln.match(/\$\$/g) || []).length) % 2 === 1) math = math < 0 ? start : -1;
  }
  if (fence) {
    const closer = fence.ch.repeat(fence.n);
    const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(last);
    if (m && m[1][0] === fence.ch) {
      if (m[1].length >= fence.n) return src;               // 闭合围栏已打完，只差换行
      last = '';                                             // 半截闭合围栏：扣住，免得在代码里闪两个反引号
    }
    return head + (last ? last + '\n' : '') + closer;        // 进行中的代码块：补闭合，立刻按代码块排版
  }
  if (math >= 0) return src.slice(0, math);                  // $$ 块没闭合：整块扣住（公式要整体渲染）

  // 表格：表头 + 分隔行 + 第一行数据到齐才出表（只有表头时列宽按表头排，首行一到列宽就大变，已显形的
  // 表头字会被挤得挪位；等首行一起排，第一次排版就接近最终列宽）；之后数据行整行到齐才放出来（半截行会
  // 一批顶一次列宽，已显形的列跟着左右挪）。
  let r = lines.length;
  while (r > 0 && isRow(lines[r - 1])) r--;
  const run = lines.slice(r);                                 // 末尾连续的「| 开头」行
  const before = r ? lines.slice(0, r).join('\n') + '\n' : '';
  const inTable = run.length >= 2 && isDelim(run[1]);
  if (inTable) {
    if (isRow(last) || !last) {
      const n = splitCells(run[0]).length;
      const done = !!last && endsWithPipe(last) && splitCells(last).length >= n;   // 整行到齐（只差换行）
      if (run.length === 2 && !done) return before;          // 首行还没到齐：整张表先扣住
      return head + (done ? last : '');
    }
  } else if (run.length === 1 && endsWithPipe(run[0]) && /^ {0,3}[|:\- \t]*$/.test(last)) {
    return before;                                            // 表头已完整、分隔行在打：扣住
  } else if (run.length === 0 && isRow(last)) {
    return head;                                              // 表头还在打：整行扣住
  }

  if (!last) return src;
  if (holdLine(last)) return head;
  const pm = BLOCK_PREFIX.exec(last);
  const prefix = pm ? pm[0] : '';
  const fixed = prefix + repairInline(last.slice(prefix.length));
  if (holdLine(fixed)) return head;                           // 修完只剩块标记（「- **」→「- 」）：扣住
  return head + fixed;
}
