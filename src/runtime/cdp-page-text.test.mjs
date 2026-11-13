import test from 'node:test';
import assert from 'node:assert/strict';
import { pageTextInPage, pageTextExpression, foldRepeatedLines } from './cdp-page-text.mjs';
import { CdpSession } from './cdp.mjs';
import { browserPageText } from './browser-extra.mjs';

// ── 手写的最小 DOM 桩：够 pageTextInPage 用（shadow root、slot 分配、计算样式继承、innerText 近似）──
// innerText 刻意按真浏览器的两个特性来：不进 shadow root；对不渲染的元素（display:none / contents）退回 textContent。
const BASE = 'https://example.com/page';
const DISPLAY = {
  DIV: 'block', P: 'block', PRE: 'block', SECTION: 'block', ARTICLE: 'block', MAIN: 'block', BODY: 'block', HTML: 'block',
  H1: 'block', H2: 'block', H3: 'block', UL: 'block', LI: 'list-item', TABLE: 'table', TR: 'table-row', TD: 'table-cell',
  SLOT: 'contents', SCRIPT: 'none', STYLE: 'none', TEMPLATE: 'none', NOSCRIPT: 'none', HEAD: 'none',
};

class Node_ {
  constructor() { this.childNodes = []; this.parentNode = null; }
  append(...kids) {
    for (const k of kids) { const n = typeof k === 'string' ? new Text_(k) : k; n.parentNode = this; this.childNodes.push(n); }
    return this;
  }
  get textContent() { return this.childNodes.map((c) => c.nodeType === 3 ? c.data : c.textContent).join(''); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class Text_ extends Node_ {
  constructor(data) { super(); this.nodeType = 3; this.data = data; }
}
class Shadow_ extends Node_ {
  constructor(host) { super(); this.host = host; }
}
class El extends Node_ {
  constructor(tag, attrs = {}, css = {}) {
    super();
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = attrs; this.css = css; this.shadowRoot = null;
  }
  get id() { return this.attrs.id || ''; }
  get href() { return this.tagName === 'A' && this.attrs.href != null ? new URL(this.attrs.href, BASE).href : ''; }
  getAttribute(n) { return n in this.attrs ? String(this.attrs[n]) : null; }
  shadow(...kids) { this.shadowRoot = new Shadow_(this); this.shadowRoot.append(...kids); return this; }
  matches(sel) {
    return sel.split(',').some((one) => {
      const m = /^([a-z0-9-]*|\*)(?:\[([a-z-]+)(?:=([^\]]+))?\])?$/i.exec(one.trim());
      if (!m) throw new Error('桩不支持的选择器：' + one);
      if (m[1] && m[1] !== '*' && m[1].toUpperCase() !== this.tagName) return false;
      if (m[2] && !(m[2] in this.attrs)) return false;
      return !(m[3] != null && String(this.attrs[m[2]]) !== m[3]);
    });
  }
  getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
  // 规范的 find flattened slottables：按 slot 名分配宿主的子节点；没分到就用后备子节点；嵌套 slot 展开
  assignedNodes({ flatten = false } = {}) {
    const root = this.getRootNode();
    if (!(root instanceof Shadow_)) return [];
    const name = this.attrs.name || '';
    let got = root.host.childNodes.filter((c) => (c.nodeType === 1 ? c.attrs.slot || '' : '') === name && (c.nodeType === 1 || name === ''));
    if (flatten && !got.length) got = this.childNodes;
    return flatten ? got.flatMap((c) => (c.tagName === 'SLOT' && c.getRootNode() instanceof Shadow_ ? c.assignedNodes({ flatten }) : [c])) : got;
  }
  checkVisibility() {
    if (style(this).display === 'contents' || style(this).visibility !== 'visible') return false;
    for (let n = this; n; n = flatParent(n)) {
      if (style(n).display === 'none') return false;
      if (n.parentNode && !(n.parentNode instanceof Shadow_) && n.parentNode.nodeType === 1 && !flatParent(n)) return false; // 宿主上没分到 slot
    }
    return true;
  }
  getClientRects() { return this.checkVisibility() ? [{}] : []; }
  getBoundingClientRect() { return { height: this.css.height || 0 }; }
  get innerText() {
    if ('innerTextOverride' in this) return this.innerTextOverride;
    if (!this.checkVisibility() && style(this).visibility === 'visible') return this.textContent;
    const toks = [];
    const walk = (el) => {
      const kids = el.shadowRoot ? el.childNodes.filter((c) => flatParent(c)) : el.childNodes; // 不进 shadow；没分到 slot 的不渲染
      for (const c of kids) {
        if (c.nodeType === 3) {
          const st = style(el);
          if (st.visibility === 'visible') toks.push(/^pre/.test(st.whiteSpace) ? c.data : c.data.replace(/[ \t\n]+/g, ' '));
          continue;
        }
        const d = style(c).display;
        if (d === 'none') continue;
        if (c.tagName === 'BR') { toks.push('\n'); continue; }
        const br = /^inline|^contents$|^table-cell$/.test(d) ? 0 : c.tagName === 'P' ? 2 : 1;
        if (br) toks.push(br);
        walk(c);
        if (d === 'table-cell') toks.push('\t');
        if (br) toks.push(br);
      }
    };
    walk(this);
    let s = '', pend = 0;
    for (const t of toks) {
      if (typeof t === 'number') { if (s) pend = Math.max(pend, t); continue; }
      if (pend) { s += '\n'.repeat(pend); pend = 0; }
      s += t;
    }
    return s;
  }
}
// 扁平树里的父节点：shadow root 的孩子 → 宿主；宿主的轻 DOM 孩子 → 它被分到的 slot（没分到 = null）
function flatParent(n) {
  const p = n.parentNode;
  if (!p) return null;
  if (p instanceof Shadow_) return p.host;
  if (p.nodeType === 1 && p.shadowRoot) return p.shadowRoot.querySelectorAll('slot').find((s) => s.assignedNodes().includes(n)) || null;
  return p;
}
function style(el) {
  const inherit = (key, own) => {
    if (own != null) return own;
    const p = flatParent(el);
    return p ? style(p)[key] : null;
  };
  return {
    display: el.css.display || DISPLAY[el.tagName] || 'inline',
    visibility: inherit('visibility', el.css.visibility) || 'visible',
    whiteSpace: inherit('whiteSpace', el.css.whiteSpace || (el.tagName === 'PRE' ? 'pre' : null)) || 'normal',
  };
}
const h = (tag, attrs, ...kids) => new El(tag, attrs || {}).append(...kids);
const hs = (tag, attrs, css, ...kids) => new El(tag, attrs || {}, css || {}).append(...kids);
function win(body, { defined = [] } = {}) {
  const html = h('html', {}, body);
  const document = {
    title: '测试页',
    body,
    querySelector: (sel) => html.querySelector(sel),
  };
  return { document, getComputedStyle: style, customElements: { get: (n) => defined.includes(n) || undefined } };
}

// ── 没有 shadow DOM：与改之前那段一行脚本逐字一致 ─────────────────────────────
const OLD = `(()=>{const pick=document.querySelector('article')||document.querySelector('main,[role=main]')||document.body;const t=(pick?.innerText||'').replace(/\\n{3,}/g,'\\n\\n').trim();return{from:pick?(pick.tagName.toLowerCase()+(pick.id?'#'+pick.id:'')):'',title:document.title,text:t}})()`;

test('no shadow root: text is exactly what the old innerText one-liner returned', () => {
  const main = h('main', { id: 'content' }, h('p', {}, 'Hello'));
  main.innerTextOverride = '  第一段\n\n\n\n第二段\t\n\n';
  const w = win(h('body', {}, h('nav', {}, 'menu'), main));
  const old = new Function('document', `return ${OLD}`)(w.document);
  const now = pageTextInPage({}, w);
  assert.equal(now.text, old.text);
  assert.equal(now.from, 'main#content');
  assert.equal(now.title, old.title);
  assert.equal(now.shadow, 0);
  assert.deepEqual(now.lazy, []);
  assert.equal('links' in now, false, '不要 links 就不收集');
});

// ── 有 shadow DOM：扁平树 ───────────────────────────────────────────────
test('MDN-style code example inside a shadow root is read, with indentation kept', () => {
  const code = '  .box {\n    view-transition-name: card;\n  }';
  const example = h('mdn-code-example', {}, h('span', {}, '轻 DOM 后备（不渲染）'))
    .shadow(h('style', {}, '.x{color:red}'), h('div', {}, 'CSS'), h('pre', {}, code));
  const w = win(h('body', {}, h('main', {}, h('h2', {}, '示例'), example, h('p', {}, '之后的段落'))), { defined: ['mdn-code-example'] });
  const r = pageTextInPage({}, w);
  assert.equal(r.text, `示例\nCSS\n${code}\n\n之后的段落`);
  assert.equal(r.shadow, 1);
  assert.doesNotMatch(r.text, /后备|color:red/);
});

test('GitHub relative-time: shadow text is read; empty one falls back to datetime', () => {
  const rel = (dt, shadowText) => h('relative-time', { datetime: dt }, 'Nov 5, 2026').shadow(...(shadowText ? [shadowText] : []));
  const w = win(h('body', {}, h('main', {},
    h('div', {}, h('span', {}, 'github-actions released this '), rel('2026-11-05T10:00:00Z', '3 days ago')),
    h('div', {}, h('span', {}, 'svelte@5.57.3 · '), rel('2026-11-01T00:00:00Z', '')),
  )), { defined: ['relative-time'] });
  const r = pageTextInPage({}, w);
  assert.equal(r.text, 'github-actions released this 3 days ago\nsvelte@5.57.3 · 2026-11-01T00:00:00Z');
  assert.doesNotMatch(r.text, /Nov 5/, '宿主上没分到 slot 的轻 DOM 子节点不渲染');
});

test('slots: named / default assignment, fallback content, nested hosts; unassigned children dropped', () => {
  const inner = h('inner-el').shadow(h('p', {}, '最里层的字'));
  const card = h('card-el', {}, h('h3', { slot: 'title' }, '卡片标题'), h('p', {}, '卡片正文'), h('span', { slot: 'nope' }, '没地方放'))
    .shadow(h('div', {}, h('slot', { name: 'title' })), h('div', {}, h('slot', {})), inner);
  const empty = h('box-el').shadow(h('div', {}, h('slot', {}, '后备内容')));
  const w = win(h('body', {}, h('main', {}, card, empty)), { defined: ['inner-el', 'card-el', 'box-el'] });
  const r = pageTextInPage({}, w);
  assert.equal(r.text, '卡片标题\n\n卡片正文\n\n最里层的字\n\n后备内容');
  assert.equal(r.shadow, 3);
  assert.doesNotMatch(r.text, /没地方放/);
});

test('hidden things stay hidden: display:none, visibility:hidden, script/style/template, display:contents never via innerText', () => {
  const host = h('x-panel').shadow(
    hs('div', {}, { display: 'none' }, '隐藏菜单一'),
    hs('div', {}, { visibility: 'hidden' }, '隐藏菜单二'),
    h('script', {}, 'var secret = 1'),
    h('template', {}, '模板里的字'),
    hs('span', {}, { display: 'contents' }, hs('div', {}, { display: 'none' }, 'SECRET'), '看得见'),
  );
  const w = win(h('body', {}, h('article', {}, host)), { defined: ['x-panel'] });
  const r = pageTextInPage({}, w);
  assert.equal(r.text, '看得见');
  assert.equal(r.from, 'article');
});

test('table rows on the path keep tab-separated cells', () => {
  const w = win(h('body', {}, h('main', {}, h('table', {}, h('tr', {}, h('td', {}, '浏览器'), h('td', {}, h('x-ver').shadow('版本 111'))), h('tr', {}, h('td', {}, 'Chrome'), h('td', {}, '是')))))
    , { defined: ['x-ver'] });
  assert.equal(pageTextInPage({}, w).text, '浏览器\t版本 111\nChrome\t是');
});

test('limit stops the flat walk early and says so', () => {
  const paras = Array.from({ length: 50 }, (_, i) => h('p', {}, `第 ${i} 段，有一些字`));
  const w = win(h('body', {}, h('main', {}, h('x-a').shadow('壳'), ...paras)), { defined: ['x-a'] });
  const r = pageTextInPage({ limit: 60 }, w);
  assert.equal(r.more, true);
  assert.ok(r.text.length < 120, r.text);
  assert.equal(pageTextInPage({}, w).more, false);
});

// ── 懒加载提示 ──────────────────────────────────────────────────────────
test('lazy placeholders are named (MDN compat table), small undefined icons are not', () => {
  const w = win(h('body', {}, h('main', {},
    h('h2', {}, 'Browser compatibility'), h('mdn-compat-table-lazy').shadow(), h('h2', {}, 'See also'),
  )), { defined: ['mdn-compat-table-lazy'] });
  assert.deepEqual(pageTextInPage({}, w).lazy, ['mdn-compat-table-lazy']);

  const big = hs('x-widget', {}, { height: 300 });
  const w2 = win(h('body', {}, h('main', {}, h('p', {}, '正文'), hs('x-icon', {}, { height: 16 }), big, h('chart-lazy', {}, '加载中…'))));
  assert.deepEqual(pageTextInPage({}, w2).lazy, ['chart-lazy', 'x-widget']);
  const done = win(h('body', {}, h('main', {}, h('table-lazy', {}, '已经渲染完的兼容性表格内容'.repeat(4)))));
  assert.deepEqual(pageTextInPage({}, done).lazy, []);
  // 图片 / 图表类本来就没字：名字像图片的、里面就是 img / canvas 的都不报
  const media = win(h('body', {}, h('main', {},
    hs('lazy-img', {}, { height: 200 }), hs('x-chart', {}, { height: 300 }, h('canvas')), hs('x-topic-list', {}, { height: 300 }),
  )));
  assert.deepEqual(pageTextInPage({}, media).lazy, ['x-topic-list']);
});

// ── links ───────────────────────────────────────────────────────────────
test('links: visible anchors in light DOM and shadow roots, deduped, labels from img alt / aria-label', () => {
  const host = h('site-card').shadow(h('a', { href: '/sites/bar' }, 'Bar 站点'));
  const w = win(h('body', {}, h('main', {},
    h('a', { href: '/sites/foo' }, h('img', { alt: 'Foo 站点' })),
    h('a', { href: '/sites/foo' }, 'Foo 重复'),
    h('a', { href: 'javascript:void 0' }, '脚本链接'),
    h('a', { href: 'https://other.com/x', 'aria-label': '外站' }),
    hs('a', { href: '/hidden' }, { display: 'none' }, '藏起来的'),
    host,
  )), { defined: ['site-card'] });
  const r = pageTextInPage({ links: true }, w);
  assert.deepEqual(r.links, [
    { text: 'Foo 站点', href: 'https://example.com/sites/foo' },
    { text: '外站', href: 'https://other.com/x' },
    { text: 'Bar 站点', href: 'https://example.com/sites/bar' },
  ]);
  const q = pageTextInPage({ links: true, query: 'SITES/' }, w);
  assert.deepEqual(q.links.map((l) => l.href), ['https://example.com/sites/foo', 'https://example.com/sites/bar']);
  assert.equal(pageTextInPage({ links: true, maxLinks: 1 }, w).links.length, 1);
});

test('injected expression is self-contained (toString round trip gives the same result)', () => {
  const w = win(h('body', {}, h('main', {}, h('p', {}, '段落'), h('x-b').shadow(h('a', { href: '/a' }, '链接')))), { defined: ['x-b'] });
  const viaPage = new Function('window', `return ${pageTextExpression({ links: true })}`)(w);
  assert.deepEqual(viaPage, pageTextInPage({ links: true }, w));
  assert.equal(viaPage.text, '段落\n\n链接');
});

// ── 重复行折叠 ──────────────────────────────────────────────────────────
test('foldRepeatedLines folds ≥3 consecutive long repeats (blank lines between allowed), leaves short / double lines', () => {
  const ad = 'The Creative Pass  Watch all courses for just $12/month';
  assert.equal(foldRepeatedLines(['标题', ad, ad, '', ad, ad, '下一节'].join('\n')), ['标题', `${ad}（×4）`, '下一节'].join('\n'));
  assert.equal(foldRepeatedLines('}\n}\n}\n}'), '}\n}\n}\n}', '短行不碰');
  assert.equal(foldRepeatedLines(`${ad}\n${ad}\n其它`), `${ad}\n${ad}\n其它`, '只重复两次不折叠');
  assert.equal(foldRepeatedLines(`${ad}\n${ad}\n${ad}\n\n尾`), `${ad}（×3）\n\n尾`);
});

// ── CdpSession.pageText 与 browserPageText 的拼装 ─────────────────────────────
function session(w) {
  const s = new CdpSession();
  s.eval = async (expr) => new Function('window', `return ${expr}`)(w);
  return s;
}

test('CdpSession.pageText folds repeats before the maxChars cap and passes shadow / lazy / links through', async () => {
  const ad = '一句很长的广告词，重复刷了好几遍的那种';
  const w = win(h('body', {}, h('main', {},
    ...Array.from({ length: 11 }, () => h('div', {}, ad)),
    h('x-c').shadow(h('p', {}, 'x'.repeat(3000))),
    h('mdn-compat-table-lazy').shadow(),
    h('a', { href: '/next' }, '下一页'),
  )), { defined: ['x-c', 'mdn-compat-table-lazy'] });
  const r = await session(w).pageText(1000, { links: true });
  assert.ok(r.text.startsWith(`${ad}（×11）\n`), r.text.slice(0, 80));
  assert.equal(r.text.length, 1000);
  assert.equal(r.truncated, true);
  assert.equal(r.shadow, 2);
  assert.deepEqual(r.lazy, ['mdn-compat-table-lazy']);
  assert.deepEqual(r.links, [{ text: '下一页', href: 'https://example.com/next' }]);
  const plain = await session(w).pageText(50_000);
  assert.equal(plain.links, null);
  assert.equal(plain.truncated, false);
});

test('browserPageText: shadow note, lazy hint, links list with query; older sessions without the new fields still work', async () => {
  const fake = (r) => ({ url: 'https://example.com/page', pageText: async (max, opts) => ({ ...r, opts }) });
  const base = { from: 'main', title: 'T', text: '正文', total: 2, truncated: false };
  const out = await browserPageText(fake({ ...base, shadow: 2, lazy: ['mdn-compat-table-lazy'], links: [{ text: 'Foo', href: 'https://example.com/sites/foo' }, { text: '', href: 'https://example.com/x' }] }), { links: true, query: 'sites' });
  const t = out.content[0].text;
  assert.match(t, /取自 <main>（含 2 个 shadow DOM 区块，已展平）/);
  assert.match(t, /<mdn-compat-table-lazy> 还没渲染出内容/);
  assert.match(t, /链接（2 个，文字或地址含「sites」）：\n- Foo → https:\/\/example\.com\/sites\/foo\n- https:\/\/example\.com\/x/);
  const none = (await browserPageText(fake({ ...base, links: [] }), { links: true })).content[0].text;
  assert.match(none, /链接：（没有看得见的链接）/);
  const old = (await browserPageText(fake(base), {})).content[0].text;
  assert.equal(old, 'url: https://example.com/page\ntitle: T\n取自 <main>\n\n正文');
  const more = (await browserPageText(fake({ ...base, truncated: true, more: true, total: 9000, text: 'x'.repeat(10) }), {})).content[0].text;
  assert.match(more, /共 9000\+ 字/);
});
