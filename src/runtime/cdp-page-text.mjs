// page_text 的页面内脚本与结果后处理（CdpSession.pageText 用；单测 cdp-page-text.test.mjs 用手写 DOM 桩跑）。
//
// 原先只取 article / main / body 的 innerText。innerText 进不了 shadow root，宿主上没分配到 slot 的
// 子节点也不算渲染内容，Web Components 渲染的正文就被静默丢掉（11-07 反馈 6 / 42 / 46：MDN 的代码示例在
// <mdn-code-example> 的 shadow 里，GitHub releases 的日期在 <relative-time> 的 shadow 里）。现在：
// - 正文里一个 open shadow root 都没有：照旧 innerText，输出与原来逐字一致；
// - 有：按扁平树自己走（shadow root + slot 分配）。只有通往宿主 / slot 的那条祖先链逐个节点拼，
//   子树里既没有宿主也没有 slot 的元素仍交给 innerText，保住 <pre> 缩进和表格制表符。
//   两个坑：innerText 对不渲染的元素（display:none、display:contents）会退回 textContent，把隐藏菜单、
//   模板全倒出来——所以 none 先跳过、contents 自己往下走，绝不对它们取 innerText。
// closed shadow root 读不到，属正常限制。

// 在页面里跑：pageTextExpression 把它 toString() 后注入，所以函数体只能用自己的局部变量。w = window（单测传桩）。
// opts：links 收集链接、query 过滤链接、maxLinks 链接上限、limit 扁平遍历攒够多少字就停（大页面别走到底）。
export function pageTextInPage(opts = {}, w = window) {
  const doc = w.document;
  const pick = doc.querySelector('article') || doc.querySelector('main,[role=main]') || doc.body;
  const res = { from: pick ? pick.tagName.toLowerCase() + (pick.id ? '#' + pick.id : '') : '', title: doc.title, text: '', shadow: 0, lazy: [], more: false };
  if (!pick) return res;

  // 一遍扫出 open shadow root（含嵌套）、宿主、shadow 里的 slot，以及疑似懒加载占位的自定义元素
  // （名字带 lazy 的，如 MDN 的 <mdn-compat-table-lazy>；或还没定义的自定义元素）
  const roots = [], hosts = [], slots = [], lazyEls = new Set();
  const scan = (root, inShadow) => {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i], tag = String(el.tagName || '').toUpperCase();
      if (inShadow && tag === 'SLOT') slots.push(el);
      if (tag.includes('-') && (tag.includes('LAZY') || (w.customElements && !w.customElements.get(tag.toLowerCase())))) lazyEls.add(el);
      if (el.shadowRoot) { hosts.push(el); roots.push(el.shadowRoot); scan(el.shadowRoot, true); }
    }
  };
  if (pick.shadowRoot) { hosts.push(pick); roots.push(pick.shadowRoot); scan(pick.shadowRoot, true); }
  scan(pick, false);
  res.shadow = hosts.length;

  const shown = (el) => { try { return el.checkVisibility({ visibilityProperty: true }); } catch { return el.getClientRects().length > 0; } };
  // 懒加载提示：名字带 lazy 的只要几乎没内容就报；没定义的自定义元素要占着块地方（≥40px 高）才报，免得把小图标算进去。
  // 图片 / 图表类（名字像、或里面就是 img / canvas / svg…）本来就没字，不报
  const MEDIA = 'img,picture,video,canvas,svg,iframe';
  const lazy = (el, said) => {
    const t = el.tagName.toLowerCase();
    if (res.lazy.length >= 3 || res.lazy.includes(t) || said.length >= 40 || /(^|-)(img|image|pic|picture|photo|video|icon|avatar)s?(-|$)/.test(t)) return;
    if (el.querySelector(MEDIA) || (el.shadowRoot && el.shadowRoot.querySelector(MEDIA))) return;
    if (t.includes('lazy') || (!said && el.getBoundingClientRect().height >= 40)) res.lazy.push(t);
  };

  if (!hosts.length) {
    res.text = (pick.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    // 名字带 lazy 的先看；最多查 30 个（没定义的自定义元素在有些站上成百上千）
    const named = (el) => String(el.tagName).toUpperCase().includes('LAZY');
    const cands = [...lazyEls].filter(named).concat([...lazyEls].filter((el) => !named(el))).slice(0, 30);
    for (const el of cands) { if (res.lazy.length >= 3) break; if (shown(el)) lazy(el, (el.innerText || '').trim()); }
  } else {
    // 宿主、shadow 里的 slot 往上到 pick 的整条链（n.host 跨过 shadow 边界）：链上的节点要逐个子节点走
    const path = new Set();
    for (const n0 of hosts.concat(slots)) {
      for (let n = n0; n && !path.has(n); n = n.parentNode || n.host) { path.add(n); if (n === pick) break; }
    }
    // 记号流：字符串 = 原样文本；{s} = 可折叠空白的文本；数字 = 此处至少几个换行（同 innerText 的 required line break）
    const toks = [];
    let size = 0;
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 400000;
    const raw = (s) => { if (s) { toks.push(s); size += s.length; } };
    // 某元素名下拼出了哪些字（判 time 回退、懒加载占位用；攒够几百字就不必再往下看）
    const said = (from) => {
      let s = '';
      for (let i = from; i < toks.length && s.length < 400; i++) if (typeof toks[i] !== 'number') s += typeof toks[i] === 'string' ? toks[i] : toks[i].s;
      return s.trim();
    };
    const PRE = { pre: 'preserve', 'pre-wrap': 'preserve', 'break-spaces': 'preserve', 'pre-line': 'preserve-breaks' };
    const list = (nodes, ws, vis) => {
      for (let i = 0; i < nodes.length && size < limit; i++) {
        const n = nodes[i];
        if (n.nodeType === 3) {
          if (!vis) continue;
          if (ws === 'preserve' || ws === 'break-spaces') raw(n.data);
          else if (ws === 'preserve-breaks') raw(n.data.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n'));
          else { const s = n.data.replace(/[ \t\n\r\f]+/g, ' '); if (s) { toks.push({ s }); size += s.length; } }
        } else if (n.nodeType === 1) visit(n);
      }
    };
    const visit = (el) => {
      const tag = String(el.tagName || '').toUpperCase();
      if (size >= limit || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(tag)) return;
      if (tag === 'BR') return raw('\n');
      const cs = w.getComputedStyle(el), d = String(cs.display || 'inline');
      if (d === 'none') return;
      const start = toks.length;
      const br = /^(inline|ruby)|^contents$|^table-cell$/.test(d) ? 0 : tag === 'P' ? 2 : 1;
      if (br) toks.push(br);
      const ws = cs.whiteSpaceCollapse || PRE[cs.whiteSpace] || 'collapse';
      const vis = !cs.visibility || cs.visibility === 'visible';
      if (el.shadowRoot) list(el.shadowRoot.childNodes, ws, vis);
      else if (tag === 'SLOT') { const a = el.assignedNodes({ flatten: true }); list(a.length ? a : el.childNodes, ws, vis); }
      else if (d === 'contents' || path.has(el)) list(el.childNodes, ws, vis);
      else raw(el.innerText || '');
      // <time> / <relative-time> 之类没渲染出字：退回 datetime / title
      if ((tag === 'TIME' || /-TIME$|^TIME-/.test(tag)) && !said(start)) raw(el.getAttribute('datetime') || el.getAttribute('title') || '');
      if (lazyEls.has(el) && res.lazy.length < 3) lazy(el, said(start));
      if (d === 'table-cell') raw('\t');
      if (br) toks.push(br);
    };
    visit(pick);
    res.more = size >= limit;
    // 拼接：换行按需要的最多那个补（末尾已有的不重复补）；可折叠文本在行首 / 空白后去掉开头空格。
    // 只看末尾十几个字符判断，避免每补一次换行就在整段大字符串上跑正则。
    const parts = [];
    let tail = '', pend = 0;
    for (const t of toks) {
      if (typeof t === 'number') { if (tail) pend = Math.max(pend, t); continue; }
      let v = typeof t === 'string' ? t : t.s;
      if (typeof t !== 'string' && (pend || !tail || /[ \t\n]$/.test(tail))) v = v.replace(/^ /, '');
      if (!v) continue;
      if (pend) { const have = /\n*$/.exec(tail.replace(/[ \t]+$/, ''))[0].length; if (pend > have) parts.push('\n'.repeat(pend - have)); pend = 0; }
      parts.push(v);
      tail = (tail + v).slice(-16);
    }
    // 只去行尾空白再压空行——行首空白不能动，那是代码缩进
    res.text = parts.join('').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // links：正文里（含各 shadow root 里）看得见的 <a href>，按地址去重，跳过 javascript:，最多 maxLinks 条
  if (opts.links) {
    const q = String(opts.query || '').toLowerCase(), max = Number(opts.maxLinks) > 0 ? Number(opts.maxLinks) : 300, seen = new Map(), out = [];
    for (const r of [pick].concat(roots)) {
      const as = r.querySelectorAll('a[href]');
      for (let i = 0; i < as.length && out.length < max; i++) {
        const a = as[i], href = typeof a.href === 'string' ? a.href : '';
        if (!href || /^javascript:/i.test(href) || !shown(a)) continue;
        const img = a.querySelector('img[alt]');
        const label = String(a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || (img && img.getAttribute('alt')) || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        const had = seen.get(href);
        if (had) { if (!had.text && label) had.text = label; continue; }
        if (q && !(label + ' ' + href).toLowerCase().includes(q)) continue;
        const x = { text: label, href };
        seen.set(href, x);
        out.push(x);
      }
    }
    res.links = out;
  }
  return res;
}

// page_text(links) 最多列几条链接
export const PAGE_TEXT_LINKS_MAX = 300;

/** 注入页面的表达式（CdpSession.eval 求值）。 */
export function pageTextExpression(opts = {}) {
  return `(${pageTextInPage.toString()})(${JSON.stringify(opts)})`;
}

// 连续重复的长行折叠成「行（×N）」：轮播 / 跑马灯把同一句广告刷十几遍（11-07 反馈 39：awwwards 一句
// 「The Creative Pass…」连出 11 行）。中间夹空行也算连着；只折叠 ≥3 次、去空白后 ≥12 字的行，
// 短行（代码里的 `}`、表格里的「是」）不碰。
export function foldRepeatedLines(text) {
  const lines = String(text).split('\n'), out = [];
  for (let i = 0; i < lines.length;) {
    const key = lines[i].trim();
    let n = 1, end = i + 1;
    if (key.length >= 12) {
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (lines[j].trim() !== key) break;
        n++;
        end = j + 1;
      }
    }
    if (n >= 3) { out.push(`${lines[i].replace(/\s+$/, '')}（×${n}）`); i = end; }
    else { out.push(lines[i]); i++; }
  }
  return out.join('\n');
}
