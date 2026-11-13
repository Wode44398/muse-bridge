// 页面里跑的自动溢出检测（注入后调用 window.__qaDetect(opts)）。每一类问题都只报「根因」那一个元素，
// 不把它的祖先 / 后代一起刷屏。规则（与 README 对应）：
//   viewport   a) 可见元素超出视口左右边界（已按祖先的 overflow 裁剪算过真正露出来的部分）
//   layer      b1) 浮层 / 菜单 / sheet / 抽屉超出视口
//   spill      b2) 子元素顶出所属的卡片 / 容器（「菜单顶出卡片」）：有底色或描边的圆角容器、按钮、浮层里的内容越过容器边
//   clip       c) 文字被裁掉却没有省略号（祖先 overflow 裁掉了一截，且不是可以滚到的滚动区、不是 line-clamp / ellipsis）
//   textspill  c2) 文字溢出所在的块（overflow 可见、但字比框宽 / 高，压到别人身上）
//   cover      d1) 可点控件被别的元素盖住（中心点 elementFromPoint 打到的不是它）
//   tap        d2) 触屏点按区 < 32px（算上 ::before / ::after 的命中扩展）
//   hscroll    e) 出现横向滚动（整页，或者没标 data-hscroll / 白名单的元素自己横向能滚）
//   safe       f) 底部可点控件压在手势条（--sab）里 / 顶部压在状态栏（--sat）下；滚动区滚到底最后一项仍被裁
//   squeeze    g) 画布被挤扁（创作页滚动区不到视口的 22%）、输入框比视口的 45% 还高
//   overlap    h) 两段不相干的文字互相压住
export const DETECT_SRC = String.raw`
window.__qaDetect = function (opts = {}) {
  const VW = innerWidth, VH = innerHeight;
  const touch = !!opts.touch;
  const root = document.documentElement;
  const rs = getComputedStyle(root);
  const SAT = parseFloat(rs.getPropertyValue('--sat')) || 0;
  const SAB = parseFloat(rs.getPropertyValue('--sab')) || 0;
  const scope = opts.scope ? [...document.querySelectorAll(opts.scope)] : [document.body];
  const HSCROLL_OK = ['.cf-chips', '.cp-chips', '.sb-chips', '[data-hscroll]', '.seg', '.cm-scroller', 'pre', 'code', '.md-table', 'table'];
  const issues = [];
  const csCache = new Map();
  const cs = (el) => { let s = csCache.get(el); if (!s) { s = getComputedStyle(el); csCache.set(el, s); } return s; };
  const R = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  function sel(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    for (let e = el, i = 0; e && e.nodeType === 1 && i < 4; e = e.parentElement, i++) {
      let s = e.tagName.toLowerCase();
      const cls = [...e.classList].filter((c) => !/^svelte-/.test(c)).slice(0, 3);
      if (cls.length) s += '.' + cls.join('.');
      if (e.getAttribute('role') && !cls.length) s += '[role=' + e.getAttribute('role') + ']';
      parts.unshift(s);
      if (e.classList.contains('studio-root') || e.id) break;
    }
    return parts.join(' > ');
  }
  const label = (el) => (el.getAttribute?.('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  function hidden(el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.hasAttribute('inert') || e.getAttribute('aria-hidden') === 'true' || e.hidden) return true;
      const s = cs(e);
      if (s.display === 'none' || s.visibility === 'hidden' || s.contentVisibility === 'hidden') return true;
      if (parseFloat(s.opacity) < 0.05) return true;
    }
    return false;
  }
  const clips = (s, axis) => { const v = axis === 'x' ? s.overflowX : s.overflowY; return v !== 'visible'; };
  const isScroll = (s, axis) => { const v = axis === 'x' ? s.overflowX : s.overflowY; return v === 'auto' || v === 'scroll'; };
  const makesCB = (s) => s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none' || /paint|layout|strict|content/.test(s.contain) || /transform|filter/.test(s.willChange) || (s.backdropFilter && s.backdropFilter !== 'none') || s.containerType !== 'normal' && s.containerType;
  /** 元素被祖先 overflow 裁剪后的可见矩形（按包含块链走：absolute 跳过未定位的祖先，fixed 跳到建立包含块的祖先），
   *  返回 { l, t, r, b, by: { x: 裁它的元素, y: … } } */
  function clipOf(el, includeSelf) {
    let l = -1e9, t = -1e9, r = 1e9, b = 1e9; const by = { l: null, r: null, t: null, b: null };
    const modeOf = (s) => (s.position === 'absolute' || s.position === 'fixed' ? s.position : 'flow');
    function cut(a, s) {
      if (!clips(s, 'x') && !clips(s, 'y')) return;
      const ar = a.getBoundingClientRect();
      const pl = ar.left + a.clientLeft, pt = ar.top + a.clientTop;
      if (clips(s, 'x')) { if (pl > l) { l = pl; by.l = a; } if (pl + a.clientWidth < r) { r = pl + a.clientWidth; by.r = a; } }
      if (clips(s, 'y')) { if (pt > t) { t = pt; by.t = a; } if (pt + a.clientHeight < b) { b = pt + a.clientHeight; by.b = a; } }
    }
    if (includeSelf) cut(el, cs(el));
    let mode = modeOf(cs(el));
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = cs(a);
      // absolute 只被它的包含块（定位过的祖先）及更外层裁；fixed 只被建立包含块的祖先（transform / contain …）裁
      const applies = mode === 'flow' ? true : mode === 'absolute' ? s.position !== 'static' || !!makesCB(s) : !!makesCB(s);
      if (applies) { cut(a, s); mode = modeOf(s); }
    }
    return { l, t, r, b, by };
  }
  const inter = (r, c) => ({ left: Math.max(r.left, c.l), top: Math.max(r.top, c.t), right: Math.min(r.right, c.r), bottom: Math.min(r.bottom, c.b) });

  // —— 最上面那一层：视口中心往上找第一个铺满视口的 fixed 容器（设置页、sheet、菜单、浮层的接点层、Studio 外壳本身）。
  // 被整层盖住的背景不检查（设置页盖着 Studio 时，Studio 的按钮「被盖住」是对的）。
  function fullFixed(e) {
    for (; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      const s = cs(e);
      if (s.position !== 'fixed') continue;
      const r = e.getBoundingClientRect();
      if (r.width >= VW * 0.95 && r.height >= VH * 0.9) return e;
    }
    return null;
  }
  let topRoot = null;
  for (const [x, y] of [[VW / 2, VH / 2], [VW / 2, VH * 0.3], [VW / 2, VH * 0.75]]) {
    const r = fullFixed(document.elementFromPoint(x, y));
    if (r) { topRoot = r; break; }
  }
  const inTop = (el) => !topRoot || topRoot.contains(el);
  // —— 收集元素 ——
  const all = [];
  for (const sc of scope) { all.push(sc); for (const el of sc.querySelectorAll('*')) if (inTop(el)) all.push(el); }
  const vis = all.filter((el) => {
    if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !hidden(el);
  });
  const visSet = new Set(vis);
  const reported = new Map();   // type → Set(el)
  function add(type, el, msg, extra = {}) {
    if (!reported.has(type)) reported.set(type, new Set());
    const set = reported.get(type);
    for (let a = el.parentElement; a; a = a.parentElement) if (set.has(a)) return;   // 祖先已报
    set.add(el);
    issues.push({ type, sel: sel(el), text: label(el), rect: R(el.getBoundingClientRect()), msg, ...extra });
  }

  // a) 超出视口左右
  for (const el of vis) {
    const r = el.getBoundingClientRect();
    if (r.left >= -1 && r.right <= VW + 1) continue;
    const c = clipOf(el, false);
    const v = inter(r, { l: Math.max(c.l, -1e9), t: c.t, r: c.r, b: c.b });
    if (v.right - v.left <= 0.5 || v.bottom - v.top <= 0.5) continue;
    if (v.left < -1 || v.right > VW + 1) add('viewport', el, '超出视口左右（露出部分 ' + Math.round(v.left) + '…' + Math.round(v.right) + '，视口宽 ' + VW + '）');
  }

  // b1) 浮层 / 菜单 / sheet 超出视口（含安全区：sheet / 菜单不该伸进状态栏和手势条）
  const LAYERS = '.ly-pop, .pv, .sh-panel, .sh, .mn, [role=dialog], [role=menu], [role=listbox], .studio-root.compact .sd-side.open, .studio-root.compact .sd-rail.open, .toast, .tt-pop';
  for (const el of vis) {
    if (!el.matches(LAYERS)) continue;
    // 浮层里面套的 listbox / menu（Sheet 正文里的选项列表）跟着外层滚，量外层那一个就够
    if (!el.matches('.ly-pop, .pv, .sh-panel, .sh, .mn, .tt-pop, .toast') && el.parentElement?.closest(LAYERS)) continue;
    const r = el.getBoundingClientRect();
    const out = [];
    if (r.left < -0.5) out.push('左 ' + Math.round(r.left));
    if (r.right > VW + 0.5) out.push('右 ' + Math.round(r.right - VW));
    if (r.top < -0.5) out.push('上 ' + Math.round(r.top));
    if (r.bottom > VH + 0.5) out.push('下 ' + Math.round(r.bottom - VH));
    if (out.length) add('layer', el, '浮层超出视口：' + out.join('，'));
    else if (touch && SAB && r.bottom > VH - SAB + 0.5 && !el.matches('.sd-side, .sd-rail')) {
      // 底边贴在手势条里没关系（iOS 式 sheet），但它最底下的可点内容不能压在手势条里——这一条交给 safe
    }
  }

  // b2) 内容顶出容器：最近的「看得见边界」的祖先（圆角且有底色 / 描边 / 阴影，或者按钮 / 浮层）
  function boxy(a) {
    const s = cs(a);
    if (a.matches('button, [role=button], [role=menuitem], .ly-pop, .pv, .sh-panel, .sh, .mn, .cp, .pl-card, .pl-panel, .pl-model, .op-card, .cp-att, .pc, .chip, .pl-cell, .pl-ac, .pl-sel, .dt-slot, .cv-thumb, .fc-audio, .cv-row, .busy, .cv-err, .ch-bubble, .tt-r')) return true;
    if (parseFloat(s.borderTopLeftRadius) < 4) return false;
    const bg = s.backgroundColor; const bgOn = bg && !/rgba\(.*,\s*0\)$/.test(bg) && bg !== 'transparent';
    return bgOn || s.boxShadow !== 'none' || parseFloat(s.borderTopWidth) > 0;
  }
  for (const el of vis) {
    if (el === document.body) continue;
    const s = cs(el);
    if (s.position === 'fixed') continue;
    let a = el.parentElement;
    while (a && !boxy(a)) { if (cs(a).position === 'fixed') { a = null; break; } a = a.parentElement; }
    if (!a || !visSet.has(a)) continue;
    const as = cs(a);
    const r = el.getBoundingClientRect(), ar = a.getBoundingClientRect();
    const c = clipOf(el, false);
    const v = inter(r, c);
    if (v.right - v.left <= 0.5 || v.bottom - v.top <= 0.5) continue;
    const tol = 1.5;
    const o = [];
    if (v.left < ar.left - tol) o.push('左 ' + Math.round(ar.left - v.left));
    if (v.right > ar.right + tol) o.push('右 ' + Math.round(v.right - ar.right));
    if (v.top < ar.top - tol) o.push('上 ' + Math.round(ar.top - v.top));
    if (v.bottom > ar.bottom + tol) o.push('下 ' + Math.round(v.bottom - ar.bottom));
    if (o.length && !(el.matches('.cp-x, .cp-link, .sd-pip, .sd-dot, .wr-g, .wr-g *, .sd-resize, .sh-grip, .ms, .ms *'))) add('spill', el, '顶出所属容器 ' + sel(a).split(' > ').pop() + '：' + o.join('，'));
  }

  // c / c2 / h) 文字
  const texts = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const p = n.parentElement;
    if (!p || !visSet.has(p) || p.closest('svg, style, script')) continue;
    if (opts.scope && !p.closest(opts.scope)) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    const c = clipOf(p, true);
    let block = p; while (block && cs(block).display === 'inline' && block.parentElement) block = block.parentElement;
    for (const tr of rects) {
      texts.push({ n, p, r: tr });
      // c) 被祖先裁掉
      const cutX = tr.left < c.l - 1 ? c.by.l : tr.right > c.r + 1 ? c.by.r : null;
      const cutY = tr.top < c.t - 1 ? c.by.t : tr.bottom > c.b + 1 ? c.by.b : null;
      const v = inter(tr, c);
      const fullyOut = v.right - v.left <= 0.5 || v.bottom - v.top <= 0.5;
      for (const [cut, axis] of [[cutX, 'x'], [cutY, 'y']]) {
        if (!cut || fullyOut) continue;
        const s = cs(cut);
        if (isScroll(s, axis) && (axis === 'x' ? cut.scrollWidth > cut.clientWidth + 1 : cut.scrollHeight > cut.clientHeight + 1)) continue;   // 可以滚到
        // 裁它的是外层（浮层外框），但里面贴着同一条边的那个滚动区还能滚：一样能滚到
        let scrollable = false;
        for (let e = p.parentElement; e && e !== cut && !scrollable; e = e.parentElement) {
          const es = cs(e);
          if (!isScroll(es, axis)) continue;
          if (axis === 'x' ? e.scrollWidth <= e.clientWidth + 1 : e.scrollHeight <= e.clientHeight + 1) continue;
          const er = e.getBoundingClientRect(), cr = cut.getBoundingClientRect();
          const near = axis === 'x' ? Math.abs(er.right - cr.right) < 3 || Math.abs(er.left - cr.left) < 3 : Math.abs(er.bottom - cr.bottom) < 3 || Math.abs(er.top - cr.top) < 3;
          if (near) scrollable = true;
        }
        if (scrollable) continue;
        let ok = false;
        for (let e = p; e && !ok; e = e.parentElement) {
          const es = cs(e);
          if (axis === 'x' && es.textOverflow === 'ellipsis') ok = true;
          if (axis === 'y' && (es.webkitLineClamp && es.webkitLineClamp !== 'none')) ok = true;
          if (e === cut) break;
        }
        if (!ok && (cs(cut).maskImage || 'none') !== 'none' && axis === 'x') ok = true;   // 横滑渐隐（有意的）
        // 露出来的那截得真的在最上层（推页动画停在屏外 / 被上层整块盖住的那份文字看不见，不算）
        if (!ok) {
          const hx = (v.left + v.right) / 2, hy = (v.top + v.bottom) / 2;
          const h = document.elementFromPoint(hx, hy);
          if (h && !(p === h || p.contains(h) || h.contains(p))) ok = true;
        }
        if (!ok) add('clip', p, '文字被' + sel(cut).split(' > ').pop() + '裁掉（' + (axis === 'x' ? '横向' : '纵向') + '）且没有省略号');
      }
      // c2) 溢出所在块（overflow 可见）
      if (block && block !== document.body) {
        const br = block.getBoundingClientRect(), bs = cs(block);
        if (!clips(bs, 'x') && (tr.right > br.right + 2 || tr.left < br.left - 2)) add('textspill', p, '文字比所在的 ' + sel(block).split(' > ').pop() + ' 宽（' + Math.round(Math.max(tr.right - br.right, br.left - tr.left)) + 'px）');
        else if (!clips(bs, 'y') && tr.bottom > br.bottom + 3 && block.matches('button, [role=button], .pc, .chip, .pl-cell, .pl-ac, .pl-sel, .cp-role, .sd-tab, .tbtn')) add('textspill', p, '文字比所在的 ' + sel(block).split(' > ').pop() + ' 高');
      }
    }
  }
  // h) 文字互相压住（不相干的两段字）
  // 用裁剪后真正露出来的那块（省略号截掉的后半截、滚出可视区的部分不算）
  const vt = texts.map((x) => { const c = clipOf(x.p, true); const v = inter(x.r, c); return { ...x, r: { left: v.left, right: v.right, top: v.top, bottom: v.bottom, width: v.right - v.left, height: v.bottom - v.top } }; })
    .filter((x) => x.r.width > 2 && x.r.height > 2);
  // 判遮挡时让 pointer-events:none 的遮罩层（设置页顶栏的滚动边缘、渐隐层）也参与命中测试，否则盖住字的那层看不见
  const peAll = document.createElement('style');
  peAll.textContent = '*{pointer-events:auto!important}';
  (document.head || document.documentElement).appendChild(peAll);
  for (let i = 0; i < vt.length; i++) {
    for (let j = i + 1; j < vt.length; j++) {
      const A = vt[i], B = vt[j];
      if (A.p === B.p || A.p.contains(B.p) || B.p.contains(A.p)) continue;
      const ix = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
      const iy = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
      if (ix > 3 && iy > Math.min(A.r.height, B.r.height) * 0.4) {
        // 两段字都看得见才算压在一起：交点处从上往下数，先碰到的那段字和另一段之间不能隔着一层不透明的底（抽屉、卡片盖住背景不算）
        const x = (Math.max(A.r.left, B.r.left) + Math.min(A.r.right, B.r.right)) / 2, y = (Math.max(A.r.top, B.r.top) + Math.min(A.r.bottom, B.r.bottom)) / 2;
        const stack = document.elementsFromPoint(x, y);
        const ia = stack.findIndex((e) => A.p === e || A.p.contains(e) || e.contains(A.p));
        const ib = stack.findIndex((e) => B.p === e || B.p.contains(e) || e.contains(B.p));
        if (ia < 0 || ib < 0) continue;
        const [hi, lo] = ia < ib ? [ia, ib] : [ib, ia];
        const upper = hi === ia ? A.p : B.p, lower = hi === ia ? B.p : A.p;
        let hidden = false;
        for (let k = hi; k < lo && !hidden; k++) {
          const e = stack[k];
          if (e.contains(lower)) continue;   // 下面那段的祖先（共同容器）不算隔层
          const bg = cs(e).backgroundColor;
          const m = /rgba?\(([^)]+)\)/.exec(bg || '');
          const alpha = m ? (m[1].split(',')[3] != null ? parseFloat(m[1].split(',')[3]) : 1) : 0;
          // 不透明的底、图片、毛玻璃（iOS 式半透明顶栏：下面的字被模糊掉，不算压字）都把下面那段字盖住了
          const bf = cs(e).backdropFilter || cs(e).webkitBackdropFilter || 'none';
          // ios27 苹果材质：玻璃画在 ::before 的 border-image 烘焙切图上，元素本身透明——也算毛玻璃
          const glass = bf !== 'none' && (getComputedStyle(e, '::before').borderImageSource || 'none') !== 'none';
          if (alpha >= 0.85 || e.tagName === 'IMG' || glass || (bf !== 'none' && (alpha >= 0.3 || /gradient/.test(cs(e).backgroundImage)))) hidden = true;
        }
        if (hidden) continue;
        add('overlap', upper, '文字和「' + (upper === A.p ? B : A).n.nodeValue.trim().slice(0, 16) + '」(' + sel(lower).split(' > ').pop() + ') 压在一起');
      }
    }
  }
  peAll.remove();

  // d) 可点控件：遮挡 + 点按区
  const MODALS = [...document.querySelectorAll('.sh-root, .mn-root, .ly-root, .studio-root > .sh')].filter((m) => !hidden(m));
  const top = MODALS.length ? MODALS[MODALS.length - 1] : null;
  const drawerOpen = document.querySelector('.studio-root.compact .sd-side.open, .studio-root.compact .sd-rail.open');
  const INTER = 'button, a[href], input:not([type=hidden]):not([type=file]), textarea, select, [role=button], [role=tab], [role=radio], [role=menuitem], [role=switch], [contenteditable=true], [role=separator][tabindex]';
  function hitExt(el, r) {
    let w = r.width, h = r.height;
    for (const pe of ['::before', '::after']) {
      const s = getComputedStyle(el, pe);
      if (!s || s.content === 'none' || s.position !== 'absolute' || s.pointerEvents === 'none') continue;
      const L = parseFloat(s.left), Rt = parseFloat(s.right), T = parseFloat(s.top), B = parseFloat(s.bottom);
      const pw = (isFinite(L) ? -L : 0) + (isFinite(Rt) ? -Rt : 0) + (isFinite(L) && isFinite(Rt) ? r.width : parseFloat(s.width) || 0);
      const ph = (isFinite(T) ? -T : 0) + (isFinite(B) ? -B : 0) + (isFinite(T) && isFinite(B) ? r.height : parseFloat(s.height) || 0);
      w = Math.max(w, pw); h = Math.max(h, ph);
    }
    return { w, h };
  }
  for (const el of vis) {
    if (!el.matches(INTER)) continue;
    if (top && !top.contains(el)) continue;
    if (!top && drawerOpen && !drawerOpen.contains(el)) continue;
    if (el.closest('.sh-dim, .mn-dim, .ly-catch, .sd-scrim, .sh-scrim')) continue;
    if (el.matches('.sh-dim, .mn-dim, .ly-catch, .sd-scrim, .sh-scrim')) continue;
    const r = el.getBoundingClientRect();
    const c = clipOf(el, false);
    const v = inter(r, { l: Math.max(c.l, 0), t: Math.max(c.t, 0), r: Math.min(c.r, VW), b: Math.min(c.b, VH) });
    const vw = v.right - v.left, vh = v.bottom - v.top;
    if (vw < 2 || vh < 2) continue;
    if (vw * vh < r.width * r.height * 0.5) continue;   // 大半在滚动区外：滚过去就能点
    // 遮挡：可见部分中心
    const x = (v.left + v.right) / 2, y = (v.top + v.bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    // 展开着的下拉列表 / 菜单 / 浮层盖住下面的行是它的本分，不算遮挡
    // 浮层里再弹出的菜单（参数浮层里的选项菜单）盖住外层浮层的行同理：盖住它的浮层和它自己所在的不是同一个就算本分
    const POPS = '[role=listbox], [role=menu], .ly-pop, .pv, .mn, .pop';
    const hp = hit && hit.closest(POPS), ep = el.closest(POPS);
    const byPopover = !!hp && hp !== ep && !(ep && hp.contains(ep));
    // 同一滚动区里的吸顶头（参数坞顶上的模型头）盖住滚到它底下的行：往回滚就露出来，同「大半在滚动区外」
    let sticky = null;
    for (let a = hit; a && a !== document.body; a = a.parentElement) if (cs(a).position === 'sticky') { sticky = a; break; }
    const bySticky = !!sticky && !sticky.contains(el) && !!sticky.parentElement?.contains(el);
    if (hit && !byPopover && !bySticky && hit !== el && !el.contains(hit) && !hit.contains(el) && !(hit.closest('label') && hit.closest('label').contains(el))) {
      add('cover', el, '被 ' + sel(hit).split(' > ').slice(-2).join(' > ') + ' 盖住');
    }
    // 点按区
    if (touch && !el.matches('[contenteditable=true], textarea, input[type=range]')) {
      // label 包着的输入框：点 label 任何地方都会聚焦它，按 label 算
      const lab = el.matches('input, select') ? el.closest('label') : null;
      const e = lab ? hitExt(lab, lab.getBoundingClientRect()) : hitExt(el, r);
      const min = Math.min(e.w, e.h);
      if (min < 31.5 && !el.closest('.cm-editor')) add('tap', el, '点按区 ' + Math.round(e.w) + '×' + Math.round(e.h) + '（< 32）');
    }
    // f) 安全区：控件压在手势条 / 状态栏里（它所在的滚动区还能往那个方向滚的不算）
    if (touch) {
      let sc = null;
      for (let a = el.parentElement; a; a = a.parentElement) { const s = cs(a); if (isScroll(s, 'y') && a.scrollHeight > a.clientHeight + 1) { sc = a; break; } }
      const canDown = sc && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1;
      const canUp = sc && sc.scrollTop > 1;
      if (SAB && v.bottom > VH - SAB + 0.5 && !canDown) add('safe', el, '压在底部手势条里（离底 ' + Math.round(VH - v.bottom) + 'px，--sab ' + SAB + '）');
      if (SAT && v.top < SAT - 0.5 && !canUp) add('safe', el, '压在顶部状态栏下（top ' + Math.round(v.top) + '，--sat ' + SAT + '）');
    }
  }

  // e) 横向滚动
  const se = document.scrollingElement;
  if (se.scrollWidth > VW + 1) issues.push({ type: 'hscroll', sel: 'html', text: '', rect: { x: 0, y: 0, w: se.scrollWidth, h: 0 }, msg: '整页能横向滚动（scrollWidth ' + se.scrollWidth + ' > ' + VW + '）' });
  for (const el of vis) {
    const s = cs(el);
    if (!isScroll(s, 'x') || el.scrollWidth <= el.clientWidth + 1) continue;
    if (HSCROLL_OK.some((q) => el.matches(q))) continue;
    add('hscroll', el, '自己能横向滚动（' + el.scrollWidth + ' > ' + el.clientWidth + '）');
  }

  // f2) 滚动区滚到底：最后一个可见后代要完整露出来（不被裁、不压手势条）
  for (const el of vis) {
    const s = cs(el);
    if (!isScroll(s, 'y') || el.scrollHeight <= el.clientHeight + 1) continue;
    if (top && !top.contains(el)) continue;
    const prev = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    const er = el.getBoundingClientRect();
    const bottomLimit = Math.min(er.top + el.clientTop + el.clientHeight, touch && SAB ? VH - SAB : VH);
    let lastB = -1e9, lastEl = null;
    for (const d of el.querySelectorAll('*')) {
      if (!visSet.has(d) || d.children.length) continue;
      // 只按滚动区里面的祖先裁一遍（缩略框把竖图裁成方块，露出来的才算），滚动区自己的裁切正是要查的
      let b = d.getBoundingClientRect().bottom;
      for (let a = d.parentElement; a && a !== el; a = a.parentElement) {
        if (clips(cs(a), 'y')) b = Math.min(b, a.getBoundingClientRect().top + a.clientTop + a.clientHeight);
      }
      if (b > lastB) { lastB = b; lastEl = d; }
    }
    if (lastEl && lastB > bottomLimit + 1) add('safe', el, '滚到底最后一项（' + (label(lastEl) || sel(lastEl).split(' > ').pop()) + '）仍有 ' + Math.round(lastB - bottomLimit) + 'px 被裁或压在手势条里');
    el.scrollTop = prev;
  }

  // g) 画布被挤扁 / 输入框太高（只看当前创作页）
  const pg = document.querySelector('.studio-root .sd-page.on');
  if (pg && !top) {
    const sc = pg.querySelector('.cf-scroll'), cp = pg.querySelector('.cp');
    if (sc && sc.clientHeight < VH * 0.22) add('squeeze', sc, '画布只剩 ' + sc.clientHeight + 'px（视口高 ' + VH + '）');
    if (cp && cp.getBoundingClientRect().height > VH * 0.45) add('squeeze', cp, '输入框 ' + Math.round(cp.getBoundingClientRect().height) + 'px，超过视口的 45%');
  }
  return issues;
};

// 把问题框在页面上（截「带标注」的那一张），再调一次 __qaMark(null) 清掉
window.__qaMark = function (issues) {
  document.getElementById('__qa_marks')?.remove();
  if (!issues || !issues.length) return;
  const box = document.createElement('div');
  box.id = '__qa_marks';
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const COLORS = { viewport: '#e11', layer: '#e11', spill: '#f0a', clip: '#f60', textspill: '#f60', cover: '#90f', tap: '#06f', hscroll: '#e11', safe: '#0a8', squeeze: '#e11', overlap: '#f0a' };
  issues.forEach((it, i) => {
    const d = document.createElement('div');
    const c = COLORS[it.type] || '#e11';
    d.style.cssText = 'position:absolute;box-sizing:border-box;border:1.5px solid ' + c + ';left:' + it.rect.x + 'px;top:' + it.rect.y + 'px;width:' + Math.max(4, it.rect.w) + 'px;height:' + Math.max(4, it.rect.h) + 'px';
    const tag = document.createElement('span');
    tag.textContent = (i + 1) + ' ' + it.type;
    tag.style.cssText = 'position:absolute;left:-1px;top:-14px;font:10px/12px monospace;color:#fff;background:' + c + ';padding:0 3px;white-space:nowrap';
    d.appendChild(tag);
    box.appendChild(d);
  });
  document.body.appendChild(box);
};
`;
