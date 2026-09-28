// Obsidian 风格 Markdown —— DocViewer（工作空间 md 阅读器）专用，聊天渲染(md.js)不受影响。
// 与 md.js 共享 cjkStrong / KaTeX 配置，但用独立 Marked 实例挂笔记语法扩展，
// 聊天消息不会被 [[双链]] / #标签 这类语法误伤。
// 覆盖：
//   · parseNote()：YAML frontmatter → 属性表（「笔记属性」面板）+ 正文
//   · renderObsMarkdown()：[[双链]] / ![[嵌入]] / #标签 / ==高亮== / %%注释%% / > [!note] callout
//   · noteStats()：词数/字符数（CJK 每字记一词，对齐 Obsidian 状态栏口径）
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { cjkStrong, soloTilde, inlineHtmlGuard, hasMath, ensureKatex, registerKatexTarget } from './md.js';
import { mdState } from './mdState.svelte.js';

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
      if (u) return `<img class="wk-embed" src="${escAttr(u)}" alt="${escAttr(t.target)}">`;
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

const mk = new Marked({ gfm: true, breaks: true });
// KaTeX 与 md.js 共享同一次按需加载：本实例登记为目标，katex 到货时一并挂上扩展。
// （此前这里是静态 import，DocViewer→MediaViewer 常驻挂载，等于把 katex 拽进了启动包。）
registerKatexTarget(mk);
// soloTilde：单个 ~ 只当字面波浪线（数值区间 90~95% 不再被当删除线划掉），与 Obsidian 一致
mk.use({ extensions: [cjkStrong, soloTilde, wikilink, obsTag, obsMark, obsComment] }, inlineHtmlGuard);   // 不配对的行内标签当字面文本（见 md.js）

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
  co.className = 'callout';
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
  const bqs = [...root.querySelectorAll('blockquote')];
  for (let i = bqs.length - 1; i >= 0; i--) tryCallout(bqs[i]);   // 深层优先，嵌套先变
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
export function renderObsMarkdown(src, { embedUrl = null } = {}) {
  void mdState.epoch;                       // 建立响应式依赖（勿删）：katex 到位后重渲，见 mdState.svelte.js
  if (!src) return '';
  let text = String(src);
  if (((text.match(/^[ \t]*```/gm) || []).length) % 2 === 1) text += '\n```';   // 未闭合围栏补齐（同 md.js）
  if (hasMath(text)) ensureKatex();                                             // 见到公式才拉 katex（hasMath 内部已短路，同 md.js）
  _embedUrl = embedUrl;
  let html;
  try { html = mk.parse(text, { async: false }); }
  catch { _embedUrl = null; return '<pre>' + escapeHtml(text) + '</pre>'; }
  html = DOMPurify.sanitize(html, { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'] });
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  try { transformDoc(tpl.content); } catch {}
  _embedUrl = null;
  return tpl.innerHTML;
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
