// Obsidian 风格 Markdown —— DocViewer（工作空间 md 阅读器）专用，聊天渲染(md.js)不受影响。
// 与 md.js 共享 cjkStrong / KaTeX 配置，但用独立 Marked 实例挂笔记语法扩展，
// 聊天消息不会被 [[双链]] / #标签 这类语法误伤。
// 覆盖：
//   · parseNote()：YAML frontmatter → 属性表（「笔记属性」面板）+ 正文
//   · renderObsMarkdown()：[[双链]] / ![[嵌入]] / #标签 / ==高亮== / %%注释%% / > [!note] callout / [^脚注]
//   · noteStats()：词数/字符数（CJK 每字记一词，对齐 Obsidian 状态栏口径）
// 渲染结果的排版在 mdrender.css（阅读态 .doc-md 与编辑态 callout 卡共用一份），随本模块注入。
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { cjkStrong, soloTilde, inlineHtmlGuard, hasMath, ensureKatex, registerKatexTarget } from './md.js';
import { mdState } from './mdState.svelte.js';
import { t as tt } from './i18n.js';   // 本文件局部变量大量叫 t（token/目标名），翻译函数用别名
import './mdrender.css';

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

// ============================== frontmatter ==============================
// 手写 YAML 子集（标量/行内数组/块列表/嵌套 map/| > 多行文本）——Obsidian 属性面板自己
// 也只产出这些形态；解析是"总能返回"的：认不出的行并进上一个 key 当续行，绝不抛错吞文。
function parseScalar(t) {
  t = String(t).trim();
  if (!t) return '';
  if ((t[0] === '"' || t[0] === "'") && t.length >= 2 && t.endsWith(t[0])) {
    const body = t.slice(1, -1);
    return t[0] === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body.replace(/''/g, "'");
  }
  if (t === 'null' || t === '~') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t) && t.length < 16) return Number(t);
  if (t[0] === '{' || (t[0] === '[' && !t.startsWith('[['))) {
    try { return JSON.parse(t); } catch {}
    if (t[0] === '[' && t.endsWith(']')) return t.slice(1, -1).split(',').map(parseScalar).filter((x) => x !== '');
  }
  return t;
}
const indentOf = (line) => line.match(/^ */)[0].length;
const joinStr = (a, b) => (typeof a === 'string' && a ? a + ' ' : '') + b;

function parseList(lines, i, indent) {
  const out = [];
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const t = line.trim();
    if (indentOf(line) !== indent || !(t === '-' || t.startsWith('- '))) break;
    out.push(parseScalar(t.slice(1)));
    i++;
  }
  return [out, i];
}

function parseMap(lines, i, indent) {
  const out = {};
  let lastKey = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;
    const t = line.trim();
    if (ind > indent) { if (lastKey != null) out[lastKey] = joinStr(out[lastKey], t); i++; continue; }
    if (t === '-' || t.startsWith('- ')) break;   // 本层冒出列表项 → 交回上层
    const c = t.indexOf(':');
    if (c < 0) { if (lastKey != null) out[lastKey] = joinStr(out[lastKey], t); i++; continue; }
    const key = t.slice(0, c).trim().replace(/^["']|["']$/g, '');
    const rest = t.slice(c + 1).trim();
    lastKey = key;
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {   // 多行标量
      const buf = [];
      i++;
      while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > indent)) { buf.push(lines[i].trim()); i++; }
      out[key] = buf.join(rest[0] === '|' ? '\n' : ' ').trim();
      continue;
    }
    if (rest) { out[key] = parseScalar(rest); i++; continue; }
    // key: 空值 → 看下一个非空行是嵌套列表 / 嵌套 map / 还是真空
    i++;
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length) {
      const nInd = indentOf(lines[j]);
      const nT = lines[j].trim();
      if (nInd >= indent && (nT === '-' || nT.startsWith('- '))) { const [arr, ni] = parseList(lines, j, nInd); out[key] = arr; i = ni; continue; }
      if (nInd > indent && nT.indexOf(':') >= 0) { const [sub, ni] = parseMap(lines, j, nInd); out[key] = sub; i = ni; continue; }
    }
    out[key] = '';
  }
  return [out, i];
}

// 解析一段 YAML（不含 --- 围栏）→ 普通对象。属性面板逐条重解析也走这条。
export function parseYamlProps(yaml) {
  const [obj] = parseMap(String(yaml || '').replace(/\r/g, '').split('\n'), 0, 0);
  return obj;
}

// 拆 frontmatter：返回 { props: [{key,value}]|null, body }。没有 frontmatter 时 props=null。
export function parseNote(src) {
  const text = String(src || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return { props: null, body: text };
  const obj = parseYamlProps(m[1]);
  return { props: Object.entries(obj).map(([key, value]) => ({ key, value })), body: text.slice(m[0].length) };
}

// 属性类型（YAML 无类型声明，一律从值反推；面板另有显式类型记忆兜空值）
export function propKind(p) {
  const v = p.value;
  if (Array.isArray(v)) return String(p.key).toLowerCase() === 'tags' ? 'tags' : 'list';
  if (v && typeof v === 'object') return 'json';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'num';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return 'datetime';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date';
  return 'text';
}

// ============================== 行内扩展 ==============================
let _embedUrl = null;   // 渲染期临时注入：(相对名) => 可加载 URL（图片嵌入/相对资源改写用）

// 图片尺寸（Obsidian 语法）：![[x.png|300]] / ![[x.png|说明|300x200]] / ![说明|300](x.png)——
// 「|」分隔的最后一段是 宽 或 宽x高 就当尺寸，其余仍是说明文字。编辑器（livePreview / 拖动缩放）共用。
export const IMG_SIZE_RE = /^(\d{1,5})(?:x(\d{1,5}))?$/;
export function splitImgSize(text) {
  const parts = String(text ?? '').split('|');
  const m = parts.length > 1 ? IMG_SIZE_RE.exec(parts[parts.length - 1].trim()) : null;
  if (!m) return { alt: String(text ?? ''), w: 0, h: 0 };
  parts.pop();
  return { alt: parts.join('|').trim(), w: +m[1], h: m[2] ? +m[2] : 0 };
}
const sizeAttrs = (w, h) => (w ? ` width="${w}"` : '') + (h ? ` height="${h}"` : '');

// [[目标#标题|别名]] / ![[嵌入]]
const wikilink = {
  name: 'wikilink',
  level: 'inline',
  start(src) { const i = src.indexOf('[['); return i < 0 ? undefined : (src[i - 1] === '!' ? i - 1 : i); },
  tokenizer(src) {
    const m = /^(!?)\[\[([^[\]\n]+?)\]\]/.exec(src);
    if (!m) return undefined;
    let target = m[2], alias = '', head = '';
    const p = target.indexOf('|');
    if (p >= 0) { alias = target.slice(p + 1).trim(); target = target.slice(0, p); }
    const h = target.indexOf('#');
    if (h >= 0) { head = target.slice(h + 1).trim(); target = target.slice(0, h); }
    return { type: 'wikilink', raw: m[0], target: target.trim(), head, alias, embed: !!m[1] };
  },
  renderer(t) {
    const disp = t.alias || (t.target ? t.target + (t.head ? ' › ' + t.head : '') : t.head);
    if (t.embed && t.target && IMG_EXT_RE.test(t.target)) {
      const u = _embedUrl && _embedUrl(t.target);
      const sz = splitImgSize('x|' + t.alias);   // 别名里只有尺寸 / 说明|尺寸 两种都认
      if (u) return `<img class="wk-embed" src="${escAttr(u)}" alt="${escAttr(sz.alt.slice(2) || t.target)}"${sizeAttrs(sz.w, sz.h)}>`;
    }
    return `<a class="wk${t.embed ? ' wk-file' : ''}" data-wk="${escAttr(t.target)}"${t.head ? ` data-head="${escAttr(t.head)}"` : ''}>${escapeHtml(disp)}</a>`;
  },
};

// #标签：前面必须是行首/空白/开括号（对齐 Obsidian，`a#b`、url#anchor 不算）；纯数字不算。
const obsTag = {
  name: 'obsTag',
  level: 'inline',
  start(src) { const i = src.indexOf('#'); return i < 0 ? undefined : i; },
  tokenizer(src, tokens) {
    // tag 字符集：\w - / + 中日韩/谚文/扩展拉丁（CJK 标点自然断尾）；纯数字/符号不算 tag
    const m = /^#((?:[\w/-]|[À-ɏ぀-ヿ㐀-䶿一-鿿가-힯])+)/.exec(src);
    if (!m) return undefined;
    if (!/[^\d/_-]/.test(m[1])) return undefined;
    const prevRaw = tokens.length ? tokens[tokens.length - 1].raw : '';
    const prev = prevRaw ? prevRaw[prevRaw.length - 1] : '';
    if (prev && !/[\s(（【"'>《，。；：、]/.test(prev)) return undefined;
    return { type: 'obsTag', raw: m[0], text: m[1] };
  },
  renderer(t) { return `<span class="ob-tag">#${escapeHtml(t.text)}</span>`; },
};

// ==高亮== → <mark>（内部继续走行内解析；不用 lookbehind，兼容旧内核 WebView，见 md.js 注）
const obsMark = {
  name: 'obsMark',
  level: 'inline',
  start(src) { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^==([^\n]+?)==/.exec(src);
    if (!m || /^\s|\s$/.test(m[1]) || !m[1].trim()) return undefined;
    return { type: 'obsMark', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
};

// %%注释%%：Obsidian 预览里隐藏（仅同段内闭合；未闭合原样显示）
const obsComment = {
  name: 'obsComment',
  level: 'inline',
  start(src) { const i = src.indexOf('%%'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^%%[^]*?%%/.exec(src);
    return m ? { type: 'obsComment', raw: m[0] } : undefined;
  },
  renderer() { return ''; },
};

// ============================== 脚注 ==============================
// [^id] 引用 → 上标序号，文末 [^id]: 定义 → 汇总成脚注区。编号按引用在正文里**首次出现**的顺序
// （GitHub/Obsidian 同口径），在渲染器里现场分配——渲染顺序就是文档顺序，代码块/行内代码里的
// [^x] 根本不会走到渲染器，天然不算。定义必须预扫全文：DocViewer 是分块渲染（mdBlocks），
// 引用所在的块常常看不到后面块里的定义；整篇共用一个上下文，编号全篇一致、脚注区只在文末出一次。
// 只认顶层（行首缩进 ≤3）的定义，续行=紧随其后、缩进 ≥2 格的非空行（与编辑器 mdext.js 的
// FootnoteDef 同一口径）；没有定义的 [^id] 保持字面。
let _fn = null;   // 渲染期临时注入的脚注上下文（同 _embedUrl）
const FN_DEF_RE = /^ {0,3}\[\^([^\]\s[]+)\]:[ \t]*(.*)$/;
const FN_DEF_BLOCK_RE = /^ {0,3}\[\^([^\]\s[]+)\]:[^\n]*(?:\n(?: {2,}|\t)[^\n]*\S[^\n]*)*(?:\n|$)/;

// 预扫全文定义 → 脚注上下文 { defs: Map(id → 定义原文), num: Map(id → 序号), order: [id…] }。
// 跳过围栏代码块；同一 id 重复定义以第一条为准（同 CommonMark 链接引用定义）。
export function scanFootnotes(src) {
  const defs = new Map();
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.slice(f[0].length).trim()) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const m = FN_DEF_RE.exec(l);
    if (!m) continue;
    const body = [m[2]];
    while (i + 1 < lines.length && /^(?: {2,}|\t)/.test(lines[i + 1]) && lines[i + 1].trim()) body.push(lines[++i].trim());
    if (!defs.has(m[1])) defs.set(m[1], body.join('\n').trim());
  }
  return { defs, num: new Map(), order: [] };
}

const fnNumber = (id) => {
  let n = _fn.num.get(id);
  if (n == null) { _fn.order.push(id); n = _fn.order.length; _fn.num.set(id, n); }
  return n;
};

// 块级：定义行（含续行）从正文里剥掉，内容由 renderFootnoteSection 汇总到文末
const footnoteDef = {
  name: 'footnoteDef',
  level: 'block',
  // 只给已知定义报起点：marked 按 start 截断段落，「正文\n[^1]: 定义」这种紧贴的定义行也能断开
  start(src) {
    if (!_fn?.defs.size) return undefined;
    const re = /^ {0,3}\[\^([^\]\s[]+)\]:/gm;
    let m;
    while ((m = re.exec(src))) if (_fn.defs.has(m[1])) return m.index;
    return undefined;
  },
  tokenizer(src) {
    const m = FN_DEF_BLOCK_RE.exec(src);
    if (!m || !_fn?.defs.has(m[1])) return undefined;
    return { type: 'footnoteDef', raw: m[0] };
  },
  renderer() { return ''; },
};

// 行内：[^id] → 上标序号（title 带定义原文，悬停即可预览）；[^x](url) / [^x][ref] 仍按普通链接
const footnoteRef = {
  name: 'footnoteRef',
  level: 'inline',
  start(src) { const i = src.indexOf('[^'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\[\^([^\]\s[]+)\](?![([])/.exec(src);
    if (!m || !_fn?.defs.has(m[1])) return undefined;
    return { type: 'footnoteRef', raw: m[0], id: m[1] };
  },
  renderer(tk) {
    const def = _fn.defs.get(tk.id) || '';
    const tip = def.length > 200 ? def.slice(0, 200) + '…' : def;
    return `<sup class="fn-ref"><a data-fn="${escAttr(tk.id)}" title="${escAttr(tip)}">${fnNumber(tk.id)}</a></sup>`;
  },
};

// ============================== 渲染器覆盖 ==============================
const renderer = {
  // 任务框：带 class（样式与编辑态勾选框对齐），去掉 marked 默认的尾随空格（间距交给 CSS 的 margin）
  checkbox({ checked }) { return `<input class="task-cb" type="checkbox" disabled${checked ? ' checked' : ''}>`; },
  // 任务项：li 带 task-list-item / is-checked / data-task（同 Obsidian 的钩子；未完成是空串——
  // Obsidian 写的是空格，但 DOMPurify 会把属性值修剪成空串，干脆直接给空），本项自身内容包进
  // .task-body、嵌套子列表留在外面——「已完成」的划线只划本项正文，不连带子项
  //（text-decoration 会传给所有后代，子元素撤销不了，所以不能直接挂在 li 上）。
  listitem(item) {
    if (!item.task) return false;
    const i = item.tokens.findIndex((tk) => tk.type === 'list');
    let own = i < 0 ? item.tokens : item.tokens.slice(0, i);
    // 松散列表里的任务项：marked 只在「已经知道列表松散」时才把勾选框并进首段，列表若是被这一项
    // （或后面某项）里的空行弄松的，勾选框会成为独立 token 排在 <p> 前面——<input> 自成一行、
    // 正文掉到下一行。这里补并进首段（不改原 token），输出与 marked 自己并好的 <p><input>正文</p> 相同
    if (own[0]?.type === 'checkbox' && own[1]?.type === 'paragraph') own = [{ ...own[1], tokens: [own[0], ...(own[1].tokens || [])] }, ...own.slice(2)];
    const sub = i < 0 ? [] : item.tokens.slice(i);
    return `<li class="task-list-item${item.checked ? ' is-checked' : ''}" data-task="${item.checked ? 'x' : ''}">`
      + `<div class="task-body">${this.parser.parse(own)}</div>${this.parser.parse(sub)}</li>\n`;
  },
  // 四空格缩进式代码块：pre.indented（DocViewer 不给它补围栏头，编辑态这种块也没有语言/复制头）
  code(tk) {
    if (tk.codeBlockStyle !== 'indented') return false;
    return `<pre class="indented"><code>${escapeHtml(String(tk.text).replace(/\n$/, '') + '\n')}</code></pre>\n`;   // 尾换行同 marked 默认
  },
};

// ============================== 源码里紧挨着的块 ==============================
// 编辑态只有源码真有空行的地方才隔一整行，「标题下直接写正文」「段落下直接接列表/代码/引用」
// 这类没有空行的相邻块是紧贴的（只隔各自行的内边距）；阅读态的块外边距却一律按「一行空行」给，
// 同一篇切模式每处都跳 20px 上下。marked 在空行处会产出 space token，据此给「前面没有空行」的块
// 插一个占位 token，渲染成 <i class="nb-mk">，净化后在 transformDoc 里换成下一个元素上的 .nb 类
//（不用逐个改写块渲染器），间距由 mdrender.css 的 .nb 规则按编辑态的实际间距给。
// 只认渲染成单个块元素的类型（紧凑列表项里的 text token 是裸文本，标不上）；任务框 token 不算
// 前一块（越过它往前看）；前一块是链接定义/脚注定义/HTML（注释）时不标——阅读态把那几行整个
// 拿掉，编辑态照样占着行，留着外边距顶上那一行正合适；列表项里的嵌套列表本来就贴着上一行
//（li > ul 外边距为 0），不标。DocViewer 分块渲染只在空行处切块，块首永远不会被误标。
const NB_TYPES = new Set(['heading', 'paragraph', 'list', 'code', 'blockquote', 'table', 'hr']);
const NB_GAP = new Set(['space', 'def', 'footnoteDef', 'html']);
const nbMark = { name: 'nbMark', renderer: () => '<i class="nb-mk"></i>' };
function markTight(tokens, inItem) {
  for (let i = tokens.length - 1; i > 0; i--) {
    const t = tokens[i];
    if (!NB_TYPES.has(t.type) || (inItem && t.type === 'list')) continue;
    let j = i - 1;
    while (j >= 0 && tokens[j].type === 'checkbox') j--;
    const p = tokens[j];
    if (p && !NB_GAP.has(p.type) && !/\n[ \t]*\n$/.test(p.raw || '')) tokens.splice(i, 0, { type: 'nbMark', raw: '' });
  }
  for (const t of tokens) {
    if (t.type === 'blockquote' && t.tokens) markTight(t.tokens, false);
    else if (t.type === 'list') for (const it of t.items || []) markTight(it.tokens || [], true);
  }
}

const mk = new Marked({ gfm: true, breaks: true });
// KaTeX 与 md.js 共享同一次按需加载：本实例登记为目标，katex 到货时一并挂上扩展。
// （此前这里是静态 import，DocViewer→MediaViewer 常驻挂载，等于把 katex 拽进了启动包。）
registerKatexTarget(mk);
// soloTilde：单个 ~ 只当字面波浪线（数值区间 90~95% 不再被当删除线划掉），与 Obsidian 一致
mk.use({
  extensions: [cjkStrong, soloTilde, wikilink, obsTag, obsMark, obsComment, footnoteDef, footnoteRef, nbMark], renderer,
  hooks: { processAllTokens(tokens) { markTight(tokens, false); return tokens; } },
}, inlineHtmlGuard);   // 不配对的行内标签当字面文本（见 md.js）

// ============================== callout ==============================
const SI = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CO_ICON = {
  pencil: SI('<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
  info: SI('<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1.2"/>'),
  clipboard: SI('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 2h6v4H9zM9 12h6M9 16h4"/>'),
  flame: SI('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>'),
  check: SI('<path d="M20 6 9 17l-5-5"/>'),
  help: SI('<circle cx="12" cy="12" r="9"/><path d="M9.4 9a2.6 2.6 0 1 1 3.6 2.4c-.8.3-1 1-1 1.6M12 17h.01"/>'),
  warn: SI('<path d="m10.3 3.8-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.2l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>'),
  x: SI('<path d="M18 6 6 18M6 6l12 12"/>'),
  zap: SI('<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>'),
  bug: SI('<path d="M9 9h6v5a3 3 0 1 1-6 0Z"/><path d="M12 9V7M10 7a2 2 0 1 1 4 0M8 11 5 10M8 14H5M8.7 16.5 6 18.5M16 11l3-1M16 14h3M15.3 16.5 18 18.5"/>'),
  list: SI('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  quote: SI('<path d="M8 11c-1.7 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3c0 4-2 6-5 7M19 11c-1.7 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3c0 4-2 6-5 7"/>'),
};
// Obsidian 默认 12 类（含别名）：颜色 rgb 三元组 + 图标
const CO_META = {
  note: { c: '8,109,221', i: 'pencil' }, info: { c: '8,109,221', i: 'info' }, todo: { c: '8,109,221', i: 'check' },
  abstract: { c: '0,176,177', i: 'clipboard' }, summary: { c: '0,176,177', i: 'clipboard' }, tldr: { c: '0,176,177', i: 'clipboard' },
  tip: { c: '0,176,177', i: 'flame' }, hint: { c: '0,176,177', i: 'flame' }, important: { c: '0,176,177', i: 'flame' },
  success: { c: '8,185,78', i: 'check' }, check: { c: '8,185,78', i: 'check' }, done: { c: '8,185,78', i: 'check' },
  question: { c: '236,117,0', i: 'help' }, help: { c: '236,117,0', i: 'help' }, faq: { c: '236,117,0', i: 'help' },
  warning: { c: '236,117,0', i: 'warn' }, caution: { c: '236,117,0', i: 'warn' }, attention: { c: '236,117,0', i: 'warn' },
  failure: { c: '233,49,71', i: 'x' }, fail: { c: '233,49,71', i: 'x' }, missing: { c: '233,49,71', i: 'x' },
  danger: { c: '233,49,71', i: 'zap' }, error: { c: '233,49,71', i: 'zap' },
  bug: { c: '233,49,71', i: 'bug' },
  example: { c: '120,82,238', i: 'list' },
  quote: { c: '158,158,158', i: 'quote' }, cite: { c: '158,158,158', i: 'quote' },
};

// callout 类型色（'r, g, b'，给 rgb()/rgba() 用）：编辑态源码行按类型上色与卡片同色；未知类型回退 note
export function calloutColor(type) {
  return (CO_META[String(type || '').toLowerCase()] || CO_META.note).c.split(',').join(', ');
}

// > [!type] 标题 → callout 卡（净化后做 DOM 变换；深层优先，嵌套 callout 也认）
function tryCallout(bq) {
  const p = bq.firstElementChild;
  if (!p || p.tagName !== 'P') return;
  const first = p.firstChild;
  if (!first || first.nodeType !== 3) return;
  const m = /^\[!([a-zA-Z-]+)\][+-]?[ \t]?/.exec(first.nodeValue || '');
  if (!m) return;
  const meta = CO_META[m[1].toLowerCase()] || CO_META.note;
  first.nodeValue = first.nodeValue.slice(m[0].length);
  const co = document.createElement('div');
  co.className = bq.classList.contains('nb') ? 'callout nb' : 'callout';   // 「源码无空行」标记（见 markTight）跟着换过去
  co.style.setProperty('--co', meta.c);
  const title = document.createElement('div');
  title.className = 'co-title';
  title.innerHTML = CO_ICON[meta.i];
  const tSpan = document.createElement('span');
  let node = p.firstChild;   // 首行（到第一个 <br>）搬进标题
  while (node && node.tagName !== 'BR') { const nx = node.nextSibling; tSpan.appendChild(node); node = nx; }
  if (node) p.removeChild(node);
  if (!tSpan.textContent.trim() && !tSpan.querySelector('img')) tSpan.textContent = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  title.appendChild(tSpan);
  co.appendChild(title);
  const body = document.createElement('div');
  body.className = 'co-body';
  if (p.childNodes.length) body.appendChild(p); else p.remove();
  while (bq.firstChild) body.appendChild(bq.firstChild);
  if (body.childNodes.length) co.appendChild(body);
  bq.replaceWith(co);
}

function transformDoc(root) {
  for (const m of root.querySelectorAll('i.nb-mk')) { m.nextElementSibling?.classList.add('nb'); m.remove(); }   // 见 markTight
  const bqs = [...root.querySelectorAll('blockquote')];
  for (let i = bqs.length - 1; i >= 0; i--) tryCallout(bqs[i]);   // 深层优先，嵌套先变
  for (const img of root.querySelectorAll('img[alt*="|"]')) {   // ![说明|300](x.png)
    const sz = splitImgSize(img.getAttribute('alt'));
    if (!sz.w) continue;
    img.setAttribute('alt', sz.alt);
    img.setAttribute('width', sz.w);
    if (sz.h) img.setAttribute('height', sz.h);
  }
  if (!_embedUrl) return;
  // 相对资源改写：![](pic.png) / <a href="附件"> 指向工作空间同目录 → 换成可加载 URL
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (src && !/^(https?:|data:|blob:|\/)/i.test(src)) {
      let t = src; try { t = decodeURIComponent(src); } catch {}
      const u = _embedUrl(t);
      if (u) img.setAttribute('src', u);
    }
  }
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!href || /^(https?:|mailto:|data:|blob:|#|\/)/i.test(href)) continue;
    const clean = href.split('#')[0];
    if (MD_EXT_RE.test(clean)) continue;   // 相对 md 链接留给 DocViewer 点击接管（站内跳转）
    let t = clean; try { t = decodeURIComponent(clean); } catch {}
    const u = _embedUrl(t);
    if (u) a.setAttribute('href', u);
  }
}

// ============================== 主渲染 ==============================
const PURIFY = { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'] };
function finish(html) {
  html = DOMPurify.sanitize(html, PURIFY);
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  try { transformDoc(tpl.content); } catch {}
  return tpl.innerHTML;
}

// footnotes：分块渲染时传同一个 scanFootnotes(全文) 的上下文，各块共用编号、不各自出脚注区，
// 全部块渲完再调 renderFootnoteSection 补在文末。不传 = 整篇一次渲染，脚注区直接接在结果末尾。
export function renderObsMarkdown(src, { embedUrl = null, footnotes = null } = {}) {
  void mdState.epoch;                       // 建立响应式依赖（勿删）：katex 到位后重渲，见 mdState.svelte.js
  if (!src) return '';
  let text = String(src);
  if (((text.match(/^[ \t]*```/gm) || []).length) % 2 === 1) text += '\n```';   // 未闭合围栏补齐（同 md.js）
  if (hasMath(text)) ensureKatex();                                             // 见到公式才拉 katex（hasMath 内部已短路，同 md.js）
  const whole = !footnotes;
  const fn = footnotes || scanFootnotes(text);
  _embedUrl = embedUrl;
  _fn = fn;
  let html;
  try { html = mk.parse(text, { async: false }); }
  catch { _embedUrl = null; _fn = null; return '<pre>' + escapeHtml(text) + '</pre>'; }
  try { html = finish(html); } finally { _embedUrl = null; _fn = null; }
  return whole ? html + renderFootnoteSection(fn, { embedUrl }) : html;
}

// 一段正文的顶层 token（DocViewer 模式切换按块对齐进度用，见 lib/mdanchors.js）：与 renderObsMarkdown
// 同一只 Marked 实例、同样补齐未闭合围栏、同一份脚注上下文（定义行才会被认成 footnoteDef、不占版面），
// 这样 token 序列与阅读态渲染出的顶层元素一一对得上。只做词法分析，不渲染、不动脚注编号。
export function lexObsBlocks(src, { footnotes = null } = {}) {
  let text = String(src || '');
  if (((text.match(/^[ \t]*```/gm) || []).length) % 2 === 1) text += '\n```';
  _fn = footnotes || scanFootnotes(text);
  try { return mk.lexer(text); } catch { return []; } finally { _fn = null; }
}

// 文末脚注区：按编号列出被引用的定义（带返回箭头），再接上写了定义却没被引用的
//（阅读态不至于凭空吞掉一段字，编号顺延、不带返回箭头）。没有任何脚注时返回 ''。
export function renderFootnoteSection(fn, { embedUrl = null } = {}) {
  void mdState.epoch;
  if (!fn || !fn.defs.size) return '';
  const back = escAttr(tt('返回引用处'));
  _embedUrl = embedUrl;
  _fn = fn;
  try {
    let items = '';
    const item = (id, ref) => {
      let body;
      try { body = mk.parseInline(fn.defs.get(id) || '', { async: false }); } catch { body = escapeHtml(fn.defs.get(id) || ''); }
      items += `<li data-fn="${escAttr(id)}">${body}`
        + (ref ? ` <a class="fn-back" data-fn="${escAttr(id)}" role="button" aria-label="${back}" title="${back}">↩&#xFE0E;</a>` : '') + '</li>';
    };
    for (let i = 0; i < fn.order.length; i++) item(fn.order[i], true);   // 定义里再引用别的脚注会追加进 order，边走边长
    for (const id of fn.defs.keys()) if (!fn.num.has(id)) { fnNumber(id); item(id, false); }
    return finish(`<section class="footnotes"><ol>${items}</ol></section>`);
  } finally { _embedUrl = null; _fn = null; }
}

// 行内渲染（mdeditor 表格单元格的渲染态用）：只走 inline 语法，净化后返回
export function renderObsInline(src) {
  const s = String(src ?? '');
  if (!s) return '';
  let html;
  try { html = mk.parseInline(s, { async: false }); } catch { return escapeHtml(s); }
  return DOMPurify.sanitize(html, { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'] });
}

// 属性值里的 [[双链]] → 可点链接（属性面板用；其余文本转义）
export function renderPropWikilinks(str) {
  const s = String(str);
  let out = '', last = 0, m;
  const re = /\[\[([^[\]\n]+?)\]\]/g;
  while ((m = re.exec(s))) {
    out += escapeHtml(s.slice(last, m.index));
    let t = m[1], alias = '';
    const p = t.indexOf('|');
    if (p >= 0) { alias = t.slice(p + 1); t = t.slice(0, p); }
    out += `<a class="wk" data-wk="${escAttr(t.trim())}">${escapeHtml((alias || t).trim())}</a>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(s.slice(last));
}

// 词数/字符数（CJK 每字一词 + 拉丁词；字符数不含空白）——对齐 Obsidian 状态栏口径
export function noteStats(text) {
  const s = String(text || '');
  const cjk = (s.match(/[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g) || []).length;
  const words = cjk + (s.match(/[A-Za-z0-9_$'-]+/g) || []).length;
  return { words, chars: s.replace(/\s/g, '').length };
}

// ============================== 属性面板图标 ==============================
export const PROP_ICONS = {
  text: SI('<path d="M4 7V5h16v2M12 5v14M9 19h6"/>'),
  list: SI('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  num: SI('<path d="M9 4 7 20M17 4l-2 16M5 9h15M4 15h15"/>'),
  date: SI('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>'),
  datetime: SI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>'),
  bool: SI('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8.5 12 2.4 2.4 4.6-4.8"/>'),
  json: SI('<path d="M9 4c-2 0-2 2-2 3.2S7.4 10.4 5 11.5c2.4 1.1 2 3.1 2 4.3S7 19 9 19M15 4c2 0 2 2 2 3.2s-.4 3.2 2 4.3c-2.4 1.1-2 3.1-2 4.3s0 3.2-2 3.2"/>'),
  tags: SI('<path d="M4 11V5a1 1 0 0 1 1-1h6l9 9-7 7-9-9Z"/><circle cx="8.5" cy="8.5" r="1.3"/>'),
};
