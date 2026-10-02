// complete.js —— 编辑器补全（Obsidian editorSuggest 式），index.js 里 ...wikiCompletion(opts) 接上：
//   [[名字     → 笔记所在目录树里的笔记 + 附件（opts.linkNames 供名单，云端=服务端 /api/file/mdnames）
//   ![[名字    → 同一份名单，附件（图片 / PDF / 音视频）排前
//   [[#标题    → 当前文档的标题；[[笔记#标题 → 那篇笔记的标题（opts.readNote 取原文，不给就不弹）
//   #标签      → 当前文档里出现过的标签（正文 + frontmatter 的 tags）
// 几条取舍：
//   · 自己打分排序（filter:false + getMatch 高亮）：CM 自带的模糊匹配对中文不友好——单字只认开头、
//     两字不相邻直接判不中，「笔」搜不到「读书笔记」。这里是 全等 > 前缀 > 词首 > 子串 > 路径 > 跳字。
//   · 只读不弹；输入法组字中不弹（候选框和补全框会叠在光标下同一处），上屏后再补一次激活。
//   · 选中后自己收尾 "]]"：keys 那路装了 closeBrackets，打 [[ 时可能已经补出 "]]"，此时跳过去不再补；
//     光标落在已闭合的旧链接中间改名时，名字后半截一起换掉，|别名 / #标题 原样保留；别的情况一个字不删。
//   · 浮层 position:absolute 挂在 .cm-editor 内，活动范围夹在编辑器可见矩形里：工作台侧栏的
//     transform 会让 fixed 定位的视口数学失效（同 menu.js 的说明），窄栏里也不会冲出编辑器被裁。
//
// opts:
//   linkNames()   → Promise<[{ name, md, path?, rel? }]>（可带 .truncated）。name：md 去扩展名、附件带扩展名；
//                   rel：相对当前笔记目录的路径（用于显示所在目录、重名时插相对路径），缺省退用 path
//   readNote(name) → Promise<string|null>   [[笔记#标题 用：取那篇笔记的原文（可缺省）
import {
  autocompletion, acceptCompletion, closeCompletion, completionStatus, pickedCompletion, startCompletion,
} from '@codemirror/autocomplete';
import { ViewPlugin, keymap, tooltips } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { t } from '../i18n.js';
import './complete.css';

const MAX_OPTIONS = 120;
// 这些节点里的 [[ / # 是字面量（代码、公式、注释、网址），不弹
const LITERAL_NODES = new Set([
  'FencedCode', 'CodeBlock', 'InlineCode', 'CodeText', 'HTMLBlock', 'CommentBlock',
  'InlineMath', 'BlockMath', 'ObsComment', 'URL', 'Autolink',
]);
// 标签字符集与前导字符：跟 mdext.js 的 ObsTag 解析一致（解析认不出的标签，补出来也不会高亮成标签）
const TAG_CHARS = '\\w/\\-À-ɏ぀-ヿ㐀-䶿一-鿿가-힯';   // i18n-ignore 正则字符集，不是文案
const TAG_BEFORE = /[\s(（【"'>《，。；：、]/;
const TAG_TAIL = new RegExp('#([' + TAG_CHARS + ']+)$');
const TAG_REST = new RegExp('^[' + TAG_CHARS + ']*');
const TAG_ALL = new RegExp('(^|[\\s(（【"\'>《，。；：、])#([' + TAG_CHARS + ']+)', 'g');
const SEP = /[\s\-_./()（）【】\[\]·、，,：:]/;

const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|ico)$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|mkv|ogv|m4v)$/i;
const fileKind = (name) => (IMG_RE.test(name) ? 'image' : AUDIO_RE.test(name) ? 'audio' : VIDEO_RE.test(name) ? 'video' : 'file');

// 与 menu.js 同一套线稿（1.75 描边、圆头）
const SVG = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const P = (...ds) => ds.map((d) => `<path d="${d}"/>`).join('');
const ICONS = {
  note: SVG(P('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4')),
  file: SVG(P('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5')),
  image: SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/>' + P('m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21')),
  audio: SVG('<circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' + P('M9 18V5l12-2v13')),
  video: SVG('<rect x="2" y="6" width="14" height="12" rx="2"/>' + P('m22 8-6 4 6 4V8Z')),
  heading: SVG(P('M6 12h12', 'M6 20V4', 'M18 20V4')),
  tag: SVG(P('M4 9h16', 'M4 15h16', 'M10 3 8 21', 'M16 3l-2 18')),
};

const dirOf = (rel) => { const i = String(rel).lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
// 所在目录太长只留最后两级：「…/2024/周报」比「项目/归档/2024/周…」有用
const shortDir = (dir) => { const segs = dir ? dir.split('/') : []; return segs.length > 2 ? '…/' + segs.slice(-2).join('/') : dir; };

function mergeRanges(ranges) {
  const pairs = [];
  for (let i = 0; i < ranges.length; i += 2) pairs.push([ranges[i], ranges[i + 1]]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of pairs) {
    if (out.length && a <= out[out.length - 1]) out[out.length - 1] = Math.max(out[out.length - 1], b);
    else out.push(a, b);
  }
  return out;
}
// q 的字符是否按序出现在 s 里；返回 { ranges, gaps } 或 null（空格不参与）
function subsequence(q, s) {
  const ranges = [];
  let j = 0, gaps = 0, last = -1;
  for (const ch of q) {
    if (/\s/.test(ch)) continue;
    const k = s.indexOf(ch, j);
    if (k < 0) return null;
    if (last >= 0 && k > last + 1) gaps += k - last - 1;
    if (ranges.length && ranges[ranges.length - 1] === k) ranges[ranges.length - 1] = k + ch.length;
    else ranges.push(k, k + ch.length);
    last = k + ch.length - 1;
    j = k + ch.length;
  }
  return { ranges, gaps };
}
// 候选打分：q 已小写、非空；label=显示文本；hay=额外可搜的文本（相对路径），命中只加分不高亮。
// 返回 { score, match }（match=label 上的命中区间，CM 加粗），不中 null
function scoreText(q, label, hay = '') {
  const low = label.toLowerCase();
  const hi = (r) => (low.length === label.length ? r : []);   // toLowerCase 改了长度（极少数字符）就不高亮，免得错位
  if (low === q) return { score: 1000, match: hi([0, label.length]) };
  const i = low.indexOf(q);
  if (i === 0) return { score: 900 - Math.min(90, low.length - q.length), match: hi([0, q.length]) };
  if (i > 0) return { score: (SEP.test(low[i - 1]) ? 800 : 700) - Math.min(90, i), match: hi([i, i + q.length]) };
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1) {   // 多个关键词：每个都在名字或路径里就算中
    const ranges = [];
    if (words.every((w) => { const k = low.indexOf(w); if (k >= 0) { ranges.push(k, k + w.length); return true; } return hay.includes(w); })) {
      return { score: 500, match: hi(mergeRanges(ranges)) };
    }
  }
  if (hay.includes(q)) return { score: 450, match: [] };
  const sub = subsequence(q, low);
  if (sub) return { score: 300 - Math.min(150, sub.gaps * 4), match: hi(sub.ranges) };
  if (hay && subsequence(q, hay)) return { score: 100, match: [] };
  return null;
}

// 光标前的 [[… 上下文：{ embed, from, query, note }。note 为 null=在名字段；字符串=在标题段（[[笔记#…）。
// 打到 | 就是别名段，不弹。
function wikiContext(state, pos) {
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(Math.max(line.from, pos - 300), pos);
  const m = /(!?)\[\[([^[\]|\n]*)$/.exec(before);
  if (!m) return null;
  const inner = m[2], hash = inner.indexOf('#');
  if (hash < 0) return { embed: !!m[1], from: pos - inner.length, query: inner, note: null };
  const head = inner.slice(hash + 1);
  return { embed: !!m[1], from: pos - head.length, query: head, note: inner.slice(0, hash).trim() };
}
// 光标前的 #标签（至少一个标签字符：行首「# 」标题、光秃秃的「#」都不弹）
function tagContext(state, pos) {
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(Math.max(line.from, pos - 120), pos);
  const m = TAG_TAIL.exec(before);
  if (!m) return null;
  const hashAt = pos - m[0].length;
  const prev = hashAt > line.from ? state.sliceDoc(hashAt - 1, hashAt) : '';
  if (prev && !TAG_BEFORE.test(prev)) return null;
  return { from: hashAt + 1, query: m[1] };
}
function literalAt(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (LITERAL_NODES.has(node.name)) return true;
  }
  return false;
}

// 文档里的标题（跳过 frontmatter 与围栏代码）
function headingsOf(text) {
  const out = [];
  const lines = String(text).split('\n');
  let i = 0, fence = '';
  if (/^---\s*$/.test(lines[0] || '')) {
    for (i = 1; i < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[i]); i++);
    i++;
  }
  const seen = new Set();
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = ''; continue; }
    if (fence) continue;
    const h = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(l);
    if (!h) continue;
    const text2 = h[2].trim();
    if (!text2 || seen.has(text2.toLowerCase())) continue;
    seen.add(text2.toLowerCase());
    out.push({ level: h[1].length, text: text2 });
  }
  return out;
}

// 文档里出现过的标签：[{ tag, n, at }]；skip=[from,to] 是正在打的那个，不算
function docTags(state, skipFrom, skipTo) {
  const counts = new Map();
  const add = (tag, at) => {
    tag = String(tag).replace(/^#/, '').trim();
    if (!tag || !/[^\d/_-]/.test(tag)) return;   // 纯数字不算标签（同 mdext）
    const k = tag.toLowerCase(), e = counts.get(k);
    if (e) e.n++; else counts.set(k, { tag, n: 1, at });
  };
  const text = state.doc.toString();
  let start = 0;
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (fm) {
    start = fm[0].length;
    // frontmatter 的 tags：行内 [a, b] / a, b，或下一行起的 - a 列表
    const tm = /^(?:tags?|标签)[ \t]*:[ \t]*(.*)$/im.exec(fm[1]);
    if (tm) {
      if (tm[1].trim()) tm[1].replace(/^\[|\]$/g, '').split(/[,，\s]+/).forEach((x) => add(x.replace(/^['"]|['"]$/g, ''), -1));
      else {
        for (const l of fm[1].slice(tm.index + tm[0].length).split('\n').slice(1)) {
          const li = /^\s+-\s*(.+?)\s*$/.exec(l);
          if (!li) break;
          add(li[1].replace(/^['"]|['"]$/g, ''), -1);
        }
      }
    }
  }
  let off = start, fence = '';
  for (const line of text.slice(start).split('\n')) {
    const lineFrom = off;
    off += line.length + 1;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = ''; continue; }
    if (fence || line.indexOf('#') < 0) continue;
    for (const m of line.matchAll(TAG_ALL)) {
      const at = lineFrom + m.index + m[1].length;
      if (at <= skipTo && at + 1 + m[2].length >= skipFrom) continue;
      add(m[2], at);
    }
  }
  return [...counts.values()];
}

// 选中名字/标题后收尾：光标后已有 "]]"（closeBrackets 补的）或正处在一条已闭合的旧链接中间 → 替换到
// 名字末尾、保留后面的 |别名 / #标题 / ]]；否则只在光标处插「名字]]」，一个字都不删。
// 光标落在 "]]" 之后（有别名/标题段时落在名字末尾）。
function insertLink(view, completion, from, to, text, stops) {
  const { state } = view;
  const lineTo = state.doc.lineAt(to).to;
  const after = state.sliceDoc(to, Math.min(lineTo, to + 300));
  const m = stops.exec(after);
  let insert = text, end = to, cursor;
  if (m) {
    end = to + m[1].length;
    if (m[2][0] === '|' && m[1].endsWith('\\')) end--;   // 表格里的 [[名\|别名]]：\ 是给表格的转义，不算名字，留着
    cursor = from + text.length + (m[2] === ']]' ? 2 : 0);
  } else {
    insert = text + ']]';
    cursor = from + insert.length;
  }
  view.dispatch({
    changes: { from, to: end, insert },
    selection: { anchor: cursor },
    scrollIntoView: true,
    userEvent: 'input.complete',
    annotations: pickedCompletion.of(completion),
  });
}
// 「在旧链接中间」的判定：光标后同一行、中间不隔 [ ]，能接上本链接的 "]]"（名字段可隔着 #标题 / |别名，
// 标题段可隔着 |别名）。光碰到 # 或 | 不算——中文句中手打 [[ 时后面紧挨正文（closeBrackets 不配对），
// 同行再有个 #标签、C#、表格的 |，都会被误当成旧链接，中间的正文整段被换掉、还不补 ]]。
const NAME_STOPS = /^([^[\]|#\n]*?)(\]\]|[|#][^[\]\n]*\]\])/;
const HEAD_STOPS = /^([^[\]|\n]*?)(\]\]|\|[^[\]\n]*\]\])/;
const applyName = (view, c, from, to) => insertLink(view, c, from, to, c.link, NAME_STOPS);
const applyHeading = (view, c, from, to) => insertLink(view, c, from, to, c.link, HEAD_STOPS);
function applyTag(view, completion, from, to) {
  const { state } = view;
  const lineTo = state.doc.lineAt(to).to;
  const end = to + TAG_REST.exec(state.sliceDoc(to, lineTo))[0].length;   // 在旧标签中间改写：残余字符一并换掉
  const next = state.sliceDoc(end, end + 1);
  const spaced = next === ' ' || next === '\t';
  const insert = completion.label + (spaced ? '' : ' ');                  // 同 Obsidian：补完带一个空格，接着就能打字
  view.dispatch({
    changes: { from, to: end, insert },
    selection: { anchor: from + completion.label.length + 1 },
    scrollIntoView: true,
    userEvent: 'input.complete',
    annotations: pickedCompletion.of(completion),
  });
}

function renderIcon(completion) {
  const el = document.createElement('span');
  el.className = 'mde-ac-ic';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICONS[completion.kind] || ICONS.file;
  return el;
}

// 浮层活动范围：编辑器可见矩形（再夹一层 visualViewport，手机键盘弹起时不往键盘底下放）
function editorSpace(view) {
  const r = view.dom.getBoundingClientRect();
  const vv = window.visualViewport;
  const top = Math.max(r.top, vv ? vv.offsetTop : 0);
  const bottom = Math.min(r.bottom, vv ? vv.offsetTop + vv.height : window.innerHeight);
  return { left: r.left + 6, right: r.right - 6, top: top + 6, bottom: bottom - 6 };
}

export function wikiCompletion(opts = {}) {
  // 每个编辑器实例一份：名单 / 标题 / 标签缓存 + 视图句柄（update 回调拿不到 view，组字判定靠它）
  const st = { view: null, names: null, trunc: false, heads: new Map(), tags: null };
  const blocked = (state) => state.readOnly || !!st.view?.composing;

  async function loadNames() {
    if (!opts.linkNames) return [];
    try {
      const list = await opts.linkNames();
      st.names = Array.isArray(list) ? list : [];
    } catch { st.names ||= []; }
    return st.names;
  }

  // —— [[名字 / ![[名字 ——
  function nameOptions(names, rawQuery, embed) {
    const q = rawQuery.trim().toLowerCase();
    const total = new Map();
    for (const n of names) { const k = (n.md ? 'm:' : 'f:') + String(n.name).toLowerCase(); total.set(k, (total.get(k) || 0) + 1); }
    const taken = new Set();
    const scored = [];
    names.forEach((n, idx) => {
      if (!n || !n.name) return;
      const k = (n.md ? 'm:' : 'f:') + String(n.name).toLowerCase();
      const first = !taken.has(k);
      taken.add(k);
      const rel = String(n.rel ?? n.path ?? n.name);
      const stem = n.md ? rel.replace(/\.[^./]+$/, '') : rel;
      const r = q ? scoreText(q, n.name, stem.toLowerCase()) : { score: 0, match: [] };
      if (!r) return;
      // 重名：同名里排最前（最浅）的那个用裸名——mdlinks 的解析就按「同名取最浅」认；其余插相对路径
      const link = total.get(k) > 1 && !first ? stem : n.name;
      const prefer = embed ? !n.md : n.md;   // ![[ 附件优先，[[ 笔记优先
      scored.push({ n, r, link, rel, idx, rank: r.score + (prefer ? 150 : 0) });
    });
    scored.sort((a, b) => b.rank - a.rank || a.idx - b.idx);   // idx：名单已按离当前笔记的远近排好
    return scored.slice(0, MAX_OPTIONS).map(({ n, r, link, rel }) => ({
      label: n.name,
      detail: shortDir(dirOf(rel)),
      kind: n.md ? 'note' : fileKind(n.name),
      link,
      match: r.match,
      apply: applyName,
    }));
  }
  function buildWiki(state, pos) {
    if (blocked(state) || !st.names?.length) return null;
    const w = wikiContext(state, pos);
    if (!w || w.note != null) return null;
    const options = nameOptions(st.names, w.query, w.embed);
    if (!options.length) return null;
    st.trunc = !!st.names.truncated;
    return {
      from: w.from, to: pos, options, filter: false,
      getMatch: (c) => c.match || [],
      update: (_r, _f, _t, ctx) => buildWiki(ctx.state, ctx.pos),
    };
  }
  async function wikiSource(ctx) {
    if (blocked(ctx.state)) return null;
    const w = wikiContext(ctx.state, ctx.pos);
    if (!w || w.note != null || literalAt(ctx.state, ctx.pos)) return null;
    await loadNames();
    if (ctx.aborted) return null;
    return buildWiki(ctx.state, ctx.pos);
  }

  // —— [[#标题 / [[笔记#标题 ——
  async function headsFor(note, state) {
    if (!note) return headingsOf(state.doc.toString());   // 本文档：现算，改了标题立刻反映
    const key = note.toLowerCase();
    if (st.heads.has(key)) return st.heads.get(key).list;
    if (!opts.readNote) return [];
    let list = [];
    try { const text = await opts.readNote(note); list = text == null ? [] : headingsOf(text); } catch {}
    st.heads.set(key, { list });
    setTimeout(() => st.heads.delete(key), 30_000);   // 别的笔记的标题缓存 30s，够一次连续编辑
    return list;
  }
  function headingOptions(list, rawQuery) {
    const q = rawQuery.trim().toLowerCase();
    const scored = [];
    list.forEach((h, idx) => {
      const r = q ? scoreText(q, h.text) : { score: 0, match: [] };
      if (r) scored.push({ h, r, idx });
    });
    scored.sort((a, b) => b.r.score - a.r.score || a.idx - b.idx);
    return scored.slice(0, MAX_OPTIONS).map(({ h, r }) => ({
      label: h.text,
      detail: 'H' + h.level,
      kind: 'heading',
      cls: 'mde-ac-head',
      // 链接文本里 [ ] | 会截断双链，换成空格（其余原样：阅读态/编辑态跳标题都按原文比对）
      link: h.text.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim(),
      match: r.match,
      apply: applyHeading,
    }));
  }
  function buildHeads(state, pos, list, note) {
    if (blocked(state)) return null;
    const w = wikiContext(state, pos);
    if (!w || w.note == null || w.note !== note) return null;
    const options = headingOptions(note ? list : headingsOf(state.doc.toString()), w.query);
    if (!options.length) return null;
    st.trunc = false;
    return {
      from: w.from, to: pos, options, filter: false,
      getMatch: (c) => c.match || [],
      update: (_r, _f, _t, ctx) => buildHeads(ctx.state, ctx.pos, list, note),
    };
  }
  async function headingSource(ctx) {
    if (blocked(ctx.state)) return null;
    const w = wikiContext(ctx.state, ctx.pos);
    if (!w || w.note == null || literalAt(ctx.state, ctx.pos)) return null;
    const list = await headsFor(w.note, ctx.state);
    if (ctx.aborted) return null;
    return buildHeads(ctx.state, ctx.pos, list, w.note);
  }

  // —— #标签 ——
  function buildTags(state, pos, tags) {
    if (blocked(state)) return null;
    const tc = tagContext(state, pos);
    if (!tc) return null;
    const q = tc.query.toLowerCase();
    const scored = [];
    for (const it of tags) {
      const r = scoreText(q, it.tag);
      if (r && it.tag.toLowerCase() !== q) scored.push({ it, r });   // 已经打全了就不必再弹
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.r.score - a.r.score || b.it.n - a.it.n || a.it.at - b.it.at);
    st.trunc = false;
    return {
      from: tc.from, to: pos, filter: false,
      options: scored.slice(0, MAX_OPTIONS).map(({ it, r }) => ({
        label: it.tag,
        displayLabel: '#' + it.tag,
        kind: 'tag',
        cls: 'mde-ac-tag',
        match: r.match.map((x) => x + 1),   // displayLabel 多了个 #
        apply: applyTag,
      })),
      getMatch: (c) => c.match || [],
      update: (_r, _f, _t, ctx) => buildTags(ctx.state, ctx.pos, tags),
    };
  }
  function tagSource(ctx) {
    if (blocked(ctx.state)) return null;
    const tc = tagContext(ctx.state, ctx.pos);
    if (!tc || literalAt(ctx.state, ctx.pos)) return null;
    // 标签表在弹出时扫一次，之后的逐键过滤复用（正在打的那个已排除，继续打不影响）
    return buildTags(ctx.state, ctx.pos, docTags(ctx.state, tc.from - 1, ctx.pos));
  }

  const canComplete = (state) => {
    if (blocked(state)) return false;
    const pos = state.selection.main.head;
    return !!(wikiContext(state, pos) || tagContext(state, pos)) && !literalAt(state, pos);
  };
  const kick = (view) => setTimeout(() => {
    if (st.view === view && !completionStatus(view.state) && canComplete(view.state)) startCompletion(view);
  }, 30);

  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      st.view = view;
      // 截断提示文案给 CSS ::after 用（名单超出遍历上限时显示在列表底部）
      view.dom.style.setProperty('--mde-ac-trunc', JSON.stringify(t('目录太大，只列出了一部分笔记')));
    }
    update(u) {
      if (!u.docChanged || u.view.composing || completionStatus(u.state)) return;
      // CM 只在 input.type 时自动激活。另外两种也该弹：删回到 [[ 里（Obsidian 删字时列表跟着回来）；
      // 别的扩展用非 input.type 事件落出来的 [[（例如 【【 自动转 [[）
      const hit = u.transactions.some((tr) => tr.isUserEvent('delete.backward')
        || (tr.isUserEvent('input') && !tr.isUserEvent('input.type') && !tr.isUserEvent('input.paste')
          && !tr.isUserEvent('input.drop') && !tr.isUserEvent('input.complete')));
      if (hit) kick(u.view);
    }
    destroy() { st.view = null; }
  }, {
    eventHandlers: {
      // 组字开始即收起（候选框要出在光标下），上屏后按上屏的字重新弹
      compositionstart(e, view) { if (completionStatus(view.state)) closeCompletion(view); },
      compositionend(e, view) { kick(view); },
    },
  });

  return [
    autocompletion({
      override: [wikiSource, headingSource, tagSource],
      icons: false,
      activateOnTyping: true,
      maxRenderedOptions: 80,
      addToOptions: [{ render: renderIcon, position: 20 }],
      optionClass: (c) => c.cls || '',
      tooltipClass: () => 'mde-ac' + (st.trunc ? ' mde-ac-trunc' : ''),
    }),
    tooltips({ position: 'absolute', tooltipSpace: editorSpace }),
    Prec.highest(keymap.of([
      { key: 'Tab', run: acceptCompletion },   // Tab 也能选中（没弹时落空，交给缩进）
      // Esc 收起浮层就到此为止：CM 自带 completionKeymap 的 Esc 只 preventDefault 不 stopPropagation，
      // 冒泡到 window 会被查看器（MediaViewer 的 Esc=关闭）一并吃掉，整篇被关、停笔 1.2s 内的字没落盘。
      // 没弹时 closeCompletion 落空，Esc 照常外传。注意 CM 把同键绑定合并成一条、stop 标记共用：
      // defaultKeymap 的 simplifySelection 收起选区时也会拦下（有选区按 Esc 只收选区，同 Obsidian）
      { key: 'Escape', run: closeCompletion, stopPropagation: true },
    ])),
    plugin,
  ];
}
