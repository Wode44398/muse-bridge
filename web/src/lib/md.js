// Markdown → safe HTML. marked for parsing, DOMPurify to sanitize (the stream can
// contain anything Claude emits). GFM + line breaks, like the reference chat.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { mdState } from './mdState.svelte.js';
import { t as tt } from './i18n.js';   // 本文件循环变量多叫 t（表格/列表节点），翻译函数用别名

marked.setOptions({ gfm: true, breaks: true });

// —— 数学公式（KaTeX）：按需加载 ——
// $...$ 行内、$$...$$ 块级 → KaTeX 渲染（AI 回复里的 \rightarrow、分式、上下标、矩阵…）。
// throwOnError:false：遇到不合法 LaTeX（或模型把普通文本误包进 $）时渲染成原式而非抛错
// 吞掉整段。nonStandard:false 用标准分隔符规则——要求 $ 紧贴非空格，天然避开「$5 到 $10」
// 这类货币写法被误当公式。output 默认 htmlAndMathml，MathML 供无障碍/选择复制。
//
// 【2026-08-15 改为懒加载】katex（JS+CSS ≈ 270KB）此前是静态 import，被打进启动即预载的
// chunk，于是每次启动都要解析一遍——而聊天里出现公式是少数情况。现在只有真的看见数学
// 分隔符才拉，拉完把扩展补注册到所有 marked 实例上，并 epoch++ 让已渲染的内容重跑一遍。
//
// 检测器要跟 KaTeX 自己的分隔符规则对齐——判宽了会把 katex 白拉起来（懒加载就白做），
// 判窄了公式永久停在原文（更糟）。两条实测踩到的假阳性都已封掉：
//   · 代码块里的 shell 变量：`grep "$TEMP/x.txt"`、$PATH、$(cmd)——本项目转写里 bash 片段
//     遍地都是，不剥代码的话几乎每个编程会话都会误拉 katex。故先剥围栏块与行内代码。
//   · 货币写法：`$5 到 $10`。KaTeX 的官方做法是【闭合 $ 后面不能紧跟数字】，这里照抄
//     （(?!\d) 是 lookahead，安全）。
// 不用 lookbehind：iOS Safari <16.4 解析含 lookbehind 的正则【字面量】时直接 SyntaxError，
// 那是模块级崩溃＝整页白屏（本文件的 cjkStrong 当年就是为此绕开的）。
const CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;
const MATH_RE = /\$\$[\s\S]*?\$\$|\$[^\s$][^\n$]*\$(?!\d)/;
export function hasMath(s) {
  if (!s || s.indexOf('$') < 0) return false;   // 绝大多数文本在这一行就返回，不做正则
  return MATH_RE.test(String(s).replace(CODE_RE, ' '));
}

let katexPhase = 0;            // 0=未加载 1=加载中 2=就绪
let katexFactory = null;
const katexTargets = new Set([marked]);   // 需要挂扩展的 marked 实例（obsmd 有自己的一只）
const applyKatex = (inst) => inst.use(katexFactory({ throwOnError: false, nonStandard: false }));

// obsmd.js 用独立的 Marked 实例，注册进来才能一起享受懒加载（并共用同一次网络请求）
export function registerKatexTarget(inst) {
  katexTargets.add(inst);
  if (katexPhase === 2) applyKatex(inst);
}

export function ensureKatex() {
  if (katexPhase) return;
  katexPhase = 1;
  // 经 katex-ext.js 走：CSS 必须是被懒加载模块【内部的静态 import】，否则 Vite 不会把
  // 样式表登记进 __vitePreload 依赖表，生产构建下公式加载出来却没样式（详见该文件注释）。
  import('./katex-ext.js')
    .then((mod) => {
      katexFactory = mod.default;
      for (const inst of katexTargets) applyKatex(inst);
      katexPhase = 2;
      mdState.epoch++;         // → 所有模板里的 renderMarkdown 重跑，公式补上
    })
    .catch(() => { katexPhase = 0; });   // 失败可重试（下一段含公式的文本会再触发）
}

// —— CJK 加粗修复 ——
// CommonMark 的 flanking 规则把紧贴中文标点的 ** 判为"非定界符"：
//   **“杀手锏”**。       → 字面 ** 残留（不加粗）
//   **“即梦”**和**“Pix”** → 中间字错误加粗、两边星号裸奔
// 中文回复里这类 pattern 海量出现，看起来就是"md 渲染失效"。
// 聊天场景里模型写成对 ** 的意图明确就是加粗，故用高优先级 inline 扩展放宽判定：
// 成对 **…**（内部非空、无裸 **、不跨行）一律按 strong 处理，内部继续走 inline 解析。
// inline 扩展不会进入 code block / `inline code`（block 阶段已切走、扫描指针在
// backtick 处由 codespan 接管），不会误伤代码里的 **。
export const cjkStrong = {   // obsmd.js（工作空间 md 阅读器）复用同一套 CJK 加粗修复
  name: 'cjkStrong',
  level: 'inline',
  start(src) { const i = src.indexOf('**'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    // 不用 (?<!\s) lookbehind——iOS Safari <16.4 / 旧内核 WebView 在解析正则
    // 字面量时直接 SyntaxError（模块级崩溃、整页白屏），改用捕获后判尾空白。
    // 内层以 * 开头（***粗斜体*** 场景）也放弃，回落内置 emStrong 正确处理嵌套。
    const m = /^\*\*(?!\s)((?:[^*\n]|\*(?!\*))+?)\*\*/.exec(src);
    if (!m || /^\*|\s$/.test(m[1])) return undefined;
    return { type: 'strong', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
  },
};
// —— 宽容本地路径链接 ——
// CommonMark 在链接目标的第一个 ) 或空格处截断：[x](笔记/文 (EN).md) 解析失败、
// 整段裸奔成纯文本（交付物文件名带括号/空格时模型常这么写）。只接管内置必失败的
// 形态：目标含空格或一层平衡括号、且无 scheme（本地路径）；其余一律还给内置解析。
// 尖括号目标 [x](<带 空格 的/路径.html>) 是 CommonMark 给「目标含空格」的正规写法（DELIVER_NUDGE
// 也这么教），尖括号只是定界符：以前原样留进 href，点开成「路径.html>」→ 对不上附件卡、文件也找不到，
// 预览按未知类型显示「即将到来」（例：模型写出 replay-300682.html> 这类尾巴）。
export const looseLink = {
  name: 'looseLink',
  level: 'inline',
  start(src) { const i = src.indexOf('['); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\[([^\[\]\n]+)\]\(((?:[^()\n]|\([^()\n]*\))+?)\)/.exec(src);
    if (!m) return undefined;
    let href = m[2].trim();
    let title = null;
    const pointy = /^<([^<>\n]*)>(?:\s+(?:"([^"\n]*)"|'([^'\n]*)'))?$/.exec(href);
    if (pointy) {
      href = pointy[1].trim();
      title = pointy[2] ?? pointy[3] ?? null;
    } else if (!/[ ()]/.test(href)) return undefined;          // 内置能正确解析，别抢
    if (/^[a-z][a-z0-9+.-]+:/i.test(href)) return undefined;   // http/data 等交给内置
    return { type: 'link', raw: m[0], href, title, text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
  },
};
// —— 单个 ~ 不当删除线 ——
// GFM 规范里「一个或两个 ~」都算删除线（marked 的 delLDelim 正是 /^~~?…/），于是中文写作
// 里当范围号用的波浪线会两两配对，把中间整段划掉：
//   合约价 26Q1 +93~98% → Q2 +58~63%   →  +93<del>98% → Q2 +58</del>63%
// 数值区间（90~95%）、日期区间在研报/笔记里成片出现，看起来就是"md 渲染错乱"。
// Obsidian / claude.ai 都只认 ~~，这里对齐：src 落在单个 ~ 上时抢先吐一个字面文本 token，
// 内置 del 就永远看不到落单的 ~；~~ 开头一律不接管，删除线照常。
// （inline 扩展在 marked 的 inlineTokens 里先于所有内置 tokenizer 试，故能抢到；
//   \~ 转义走 escape——那时 src[0] 是反斜杠，不进这里。）
export const soloTilde = {
  name: 'soloTilde',
  level: 'inline',
  start(src) { const i = src.indexOf('~'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    if (src[0] !== '~' || src[1] === '~') return undefined;
    return { type: 'text', raw: '~', text: '~' };
  },
};
// —— 行内 HTML 不配对就当字面文本 ——
// 笔记/回复里常把占位符写成尖括号：data/entities/<code>/facts.jsonl、<ENTITY>。GFM 照单
// 当行内 HTML 放行，而 <code>/<b>/<a> 这类是 HTML 解析器的「格式化元素」：不闭合时，
// 浏览器会在【之后每一段】文本前按「活动格式化元素表」自动重开它——于是从那一行起整篇
// 变等宽字体、块与块之间冒出一串空的 <code> 条（09-19 finance agent MEMORY.md 实锤）。
// 对齐作者意图：同一段行内 token 里配不上对的起止标签原样显示；void / 自闭合 / 注释不管；
// 块级 HTML（<details> 跨段包 markdown 是正当用法）也不管。parse / parseInline 都经
// processAllTokens，表格单元格的行内渲染（renderObsInline）同样生效。
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
function balanceInlineHtml(list) {
  const open = [], bad = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.type !== 'html' || t.block) continue;
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(t.raw);
    if (!m) continue;                                        // <!-- --> / <?…> / <![CDATA[…]]> 不是标签
    const name = m[2].toLowerCase();
    if (!m[1]) {
      if (!VOID_TAGS.has(name) && !/\/\s*>$/.test(t.raw)) open.push({ name, i });
      continue;
    }
    let j = open.length - 1;
    while (j >= 0 && open[j].name !== name) j--;
    if (j < 0) { bad.push(i); continue; }                    // 没有对应起始的孤立闭合
    for (let k = j + 1; k < open.length; k++) bad.push(open[k].i);   // 被跨过去的未闭合起始
    open.length = j;
  }
  for (const o of open) bad.push(o.i);
  for (const i of bad) list[i] = { type: 'text', raw: list[i].raw, text: list[i].raw };   // 无 escaped → 渲染时转义
}
function walkInlineHtml(list) {
  balanceInlineHtml(list);
  for (const t of list) {
    if (Array.isArray(t.tokens)) walkInlineHtml(t.tokens);
    if (Array.isArray(t.items)) walkInlineHtml(t.items);
    if (t.type === 'table') {
      for (const c of t.header || []) walkInlineHtml(c.tokens || []);
      for (const row of t.rows || []) for (const c of row) walkInlineHtml(c.tokens || []);
    }
  }
}
export const inlineHtmlGuard = { hooks: { processAllTokens(tokens) { walkInlineHtml(tokens); return tokens; } } };
marked.use({ extensions: [cjkStrong, looseLink, soloTilde] }, inlineHtmlGuard);

// 只有真外链才新开（防 tab-nabbing）。内部链接（模型写的产物路径 / 同源 API）不加
// target——由各渲染容器的 onMdClick 委托分流到应用内预览（lib/linkNav.js），加了 _blank
// 会新开一个标签页去打开一个应用内才认得的路径，正文点「原文」就跳走了。
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    const href = node.getAttribute('href');
    if (/^https?:\/\//i.test(href) && !href.toLowerCase().startsWith(location.origin.toLowerCase() + '/')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
});

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// —— 流式分块：找「安全切点」把已稳定前缀从流式尾巴里切出去 ——
// Thread 对 text 段按块渲染（每块一个 {@html renderMarkdown(块)}）：前缀块字符串不变、
// Svelte 细粒度直接跳过，流式期间只有末块随 delta 重 parse + 重建 DOM——几千字长回答
// 的打字机成本从每 tick O(全文) 降到 O(末块)，掉帧根源就此拔掉。
// 切点必须是「顶层块边界」，保证分块渲染与整段渲染逐字节同构：
//   · 只切在空行处，且不在 ``` / ~~~ 围栏或 $$ 数学块内部；
//   · 空行前一行不是列表/引用/表格/缩进行（松散列表项之间的空行不切——切了列表会
//     断成两个列表：编号重开、间距变化）；空行后的下一非空行也必须是全新顶层块开头。
// 返回切点（tail 内偏移，指向空行后下一行行首）；找不到返回 -1。
// min：切走的前缀至少这么长（避免碎块）；margin：末尾至少留这么长不切（写头附近
// 的内容还在渐入/变化，贴着切会让切块过于频繁）。
const CONT_RE = /^(\s|[-*+]\s|\d{1,3}[.)]\s|>|\|)/;   // 延续型行：缩进/列表/引用/表格
export function findSafeCut(tail, min = 800, margin = 400) {
  if (tail.length < min + margin) return -1;
  const lines = tail.split('\n');
  let pos = 0, fence = false, math = false, prev = '';   // prev = 上一个非空行
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    pos += line.length + 1;
    if (!math && /^[ \t]*(```|~~~)/.test(line)) { fence = !fence; prev = line; continue; }
    if (fence) { prev = line; continue; }
    const dd = (line.match(/\$\$/g) || []).length;
    if (dd % 2 === 1) { math = !math; prev = line; continue; }
    if (math) { prev = line; continue; }
    if (line.trim() !== '') { prev = line; continue; }
    // 空行：候选切点 = 下一行行首（pos）。校验前后行都是顶层块。
    if (pos < min || tail.length - pos < margin) continue;
    if (!prev || CONT_RE.test(prev)) continue;
    let next = '';
    for (let j = i + 1; j < lines.length; j++) { if (lines[j].trim() !== '') { next = lines[j]; break; } }
    if (!next || CONT_RE.test(next)) continue;
    return pos;
  }
  return -1;
}

// 通用流式分块 memo：obj 是承载这段文本的响应式对象（text 段），text 是
// 其当前全文。返回 [稳定块..., 流式尾巴]。consumed 单调推进、重放（变短）自动重置。
const _blkMemo = new WeakMap();
export function streamBlocks(obj, text) {
  let st = _blkMemo.get(obj);
  if (!st) { st = { consumed: 0, blocks: [] }; _blkMemo.set(obj, st); }
  if (text.length < st.consumed) { st.consumed = 0; st.blocks = []; }
  let tail = text.slice(st.consumed);
  for (;;) {
    const cut = findSafeCut(tail);
    if (cut < 0) break;
    st.blocks = [...st.blocks, tail.slice(0, cut)];
    st.consumed += cut;
    tail = text.slice(st.consumed);
  }
  return tail ? [...st.blocks, tail] : st.blocks;
}

export function renderMarkdown(src) {
  if (!src) return '';
  // 建立响应式依赖（勿删）：katex 异步到位后 epoch++，模板里的 {@html renderMarkdown(...)}
  // 才会重跑、把先前吐成原文的 $...$ 补渲成公式。见 mdState.svelte.js。
  void mdState.epoch;
  // 流式中途（或模型忘了闭合）的奇数个 ``` 会把后续内容全吞进 code block；
  // 渲染前补一个闭合 fence，让"代码块进行中"正确显示为代码块（claude.ai 同款行为）。
  // 只数行首 fence——正文行内提及 ``` 不算（否则误补出一个空代码块）。
  let text = String(src);
  if (((text.match(/^[ \t]*```/gm) || []).length) % 2 === 1) text += '\n```';
  if (!katexPhase && hasMath(text)) ensureKatex();   // 已在加载/已就绪就连扫描都省掉
  let html;
  try { html = marked.parse(text, { async: false }); }
  catch { return '<pre>' + escapeHtml(text) + '</pre>'; }   // 解析崩溃也别吞内容
  // KaTeX 的 MathML 部分（无障碍朗读 / 可复制 LaTeX 源）用 <semantics>/<annotation>，
  // 不在 DOMPurify 默认 MathML 白名单里——补上，否则被剥得只剩裸露的 LaTeX 文本节点。
  const clean = DOMPurify.sanitize(html, { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'], ALLOWED_URI_REGEXP: URI_OK });
  return clean.includes('<table') || clean.includes('<pre') ? decorate(clean) : clean;
}
// DOMPurify 默认的 URI 白名单 + Windows 盘符路径（C:/… 与 encodeURI 后的 C:%5C…）。默认表把「C:」当成
// 未知协议整个剥掉 href——模型交付产物最常写的就是绝对路径，于是正文链接成了点不动的死字
//（09-28 查实：以前能点开的只有尖括号那种，靠的是 href 以 %3C 开头躲过了协议判定）。单字母不是任何
// 可执行协议（javascript:/data:/vbscript: 都是多字母），点击本就由 onMdClick 拦进应用内预览。
const URI_OK = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[a-z]:(?:[\\/]|%5c)|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

// 净化后的树只走一趟 DOM，表格滚动壳与代码块复制按钮一起套。
function decorate(clean) {
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  wrapTables(tpl.content);
  wrapCode(tpl.content);
  return tpl.innerHTML;
}

// 宽表格必须【在自己身上】横滚，不能把整条正文顶宽（顶宽的后果是整个会话变成可左右拖的
// 画布，手机上尤其难受）。光靠 CSS 办不到：<table> 自己要么按内容排列宽然后撑破容器，
// 要么被 max-width 压回去把每列挤成一个字——两者都不对，必须有个真父级来吃 overflow-x。
// 故在渲染层套一层 .md-tablewrap（样式在 app.css，所有 md 渲染面共用）。
// 放在 sanitize 【之后】：只往净化过的树里塞一个自家的 div，不新增任何攻击面。
// 只有真含 <table> / <pre> 时才走这一趟 DOM，流式逐块渲染的常规路径零开销。
function wrapTables(root) {
  for (const t of root.querySelectorAll('table')) {
    if (t.parentElement?.classList.contains('md-tablewrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'md-tablewrap';
    t.replaceWith(wrap);
    wrap.appendChild(t);
  }
}

// —— 代码块右上角「复制」按钮（claude.ai 同款）——
// 同 wrapTables：sanitize 之后往树里塞自家节点。按钮是 <pre> 的兄弟而非子节点——<pre>
// 自己横滚，塞在里面会跟着代码一起滚走；壳 .md-codewrap 定位、样式在 app.css。
// 按钮里只有 SVG、没有文本节点：吐字渐入（claudeFade）按文本节点计数，不受影响。
// 点击走下面 document 级委托，所有 md 渲染面（Claude 对话 / 扩展中心 / 文档预览…）自动生效。
const ICON_COPY = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>';
const ICON_DONE = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';
function wrapCode(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement?.classList.contains('md-codewrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'md-codewrap';
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    wrap.insertAdjacentHTML('beforeend', '<button type="button" class="md-codecopy" aria-label="' + tt('复制代码') + '" title="' + tt('复制') + '">' + ICON_COPY + '</button>');
  }
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return; }
  catch {  // WebView/旧浏览器兜底
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
}
// 捕获阶段接：渲染容器上的 onclick（onMdClick 等）或中途 stopPropagation 都挡不住它。
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.md-codecopy');
    if (!btn) return;
    e.preventDefault();
    const code = btn.parentElement?.querySelector('pre');
    if (!code) return;
    copyText(code.textContent.replace(/\n$/, ''));   // marked 给代码尾巴留的换行不要
    btn.classList.add('done');
    btn.innerHTML = ICON_DONE;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = ICON_COPY; }, 1400);
  }, true);
}
