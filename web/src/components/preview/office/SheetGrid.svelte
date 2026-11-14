<script>
  // 电子表格网格（xlsx / xls / ods / csv / tsv 共用；模型见 sheet.js）。对标 Excel / Numbers 的「只看」体验：
  //   · 行列头、冻结窗格（读文件；没写就由模型猜表头行）、列宽 / 行高 / 隐藏行列、合并单元格、字体与底色、数字右对齐、
  //     文字向右溢出到空邻格（Excel 同款）、超链接；
  //   · 虚拟滚动：一个原生滚动容器 + 四块粘性面板（左上角 / 顶部冻结行 / 左侧冻结列 / 主体），只画视口里的格子，
  //     窗口按 24 行 / 4 列一档量化，滚动跨档才重算（2 万行照样顺）；
  //   · 选择：单击 / 拖选 / Shift 扩选 / 点行列头选整行整列 / 左上角全选；方向键、Ctrl+方向键跳到数据边缘、Tab、Enter、
  //     Home、Ctrl+Home/End、PageUp/PageDown；Ctrl+C 复制成制表符文本；
  //   · 触屏：轻点选格、长按后拖动扩选、双指捏合缩放（以捏合中点为锚）；
  //   · 公式栏（地址 + 公式或值）、Ctrl+F 查找（全部高亮、Enter 逐个跳）、Ctrl+滚轮 / Ctrl+± 缩放、底部状态栏（标签 + 统计 + 缩放）。
  //
  // props
  //   book（sheet.js 的 buildBook 结果）· active（可绑定：当前表下标）· touch
  //   tabs（缺省 true：自己画工作表标签；触屏放进外框底栏时传 false）· formulaBar（缺省 true）
  //   freezeOn / gridOn / zoom / findOpen（都可绑定：外框菜单的开关直接绑进来）
  // 导出：keys(e) → bool（交给外框 declare.keys）· openFind() · closeFind() · copy() · selectAll() · zoomStep(±1) · zoomTo(z) · zoomItems()
  // 根节点带 of-root（取文档主题变量）与 data-sheet / data-rows / data-cols / data-freeze / data-sel / data-zoom（给测试读）。
  import { tick, untrack, onMount } from 'svelte';
  import VIcon from '../kit/VIcon.svelte';
  import { tip } from '../kit/tooltip.js';
  import { useViewer, isEditable } from '../kit/context.js';
  import { copyText } from '../kit/actions.js';
  import FindBar from '../paged/FindBar.svelte';
  import SheetTabs from './SheetTabs.svelte';
  import { attachGestures } from '../pdf/gestures.js';
  import { ui } from '../../../lib/state.svelte.js';
  import { t, tc, locale } from '../../../lib/i18n.js';
  import { DEF_COL_W, DEF_ROW_H, pack, colName, addr, decodeAddr, rangeLabel, fontPx, textUnits, prefix, indexAt, findCells, selectionTsv } from './sheet.js';

  let {
    book, active = $bindable(0), touch = false, tabs = true, formulaBar = true,
    freezeOn = $bindable(true), gridOn = $bindable(true), zoom = $bindable(1), findOpen = $bindable(false),
  } = $props();

  const viewer = useViewer();
  const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const ZMIN = 0.5, ZMAX = 2;
  const RQ = 24, CQ = 4;          // 虚拟窗口量化档：行 / 列
  const LOOKBACK = 8;             // 窗口左边往回看几列（溢出过来的文字）
  const OV_MAX = 32;              // 文字最多溢出几列
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  let rootEl = $state(null), scroller = $state(null), content = $state(null), findBar = $state(null), fxVal = $state(null);
  let vw = $state(0), vh = $state(0);
  let anc = $state.raw({ r: 0, c: 0 }), far = $state.raw({ r: 0, c: 0 });
  let win = $state.raw({ r0: 0, r1: -1, c0: 0, c1: -1 });
  let findQ = $state(''), hits = $state.raw([]), hitSet = $state.raw(new Set()), hitAt = $state(0);
  let fxOpen = $state(false), fxLong = $state(false);

  // —— 模型与布局 ——
  const sheets = $derived(book?.sheets || []);
  const sh = $derived(sheets[active] || null);
  const styles = $derived(book?.styles || []);
  const z = $derived(clamp(+zoom || 1, ZMIN, ZMAX));
  const light = $derived(ui.theme === 'light' || (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'));
  // 显示的行列数：数据之外再给几行几列空格子，且至少铺满视口（和 Excel 一样网格不在数据边上戛然而止）
  const nr = $derived(sh ? Math.max(sh.nRows + 10, Math.ceil(vh / (DEF_ROW_H * z)) + 2) : 0);
  const nc = $derived(sh ? Math.max(sh.nCols + 3, Math.ceil(vw / (DEF_COL_W * z)) + 2) : 0);
  // 前缀和逐项取整：所有格子、网格线、选框都落在整像素上，缩放后也不糊
  const roundAll = (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.round(a[i]); return a; };
  const cx = $derived(roundAll(prefix(sh?.colW, nc, DEF_COL_W, z)));
  const ry = $derived(roundAll(prefix(sh?.rowH, nr, DEF_ROW_H, z)));
  const hw = $derived(Math.round(Math.max(36, String(nr).length * 7.5 + 14) * z));
  const hh = $derived(Math.round(22 * z));
  // 冻结：冻住的部分最多占视口六成（手机竖屏上冻了 5 列的表也还能滚）
  const fr = $derived.by(() => {
    let n = freezeOn && sh?.freeze ? Math.min(sh.freeze.rows || 0, Math.max(0, nr - 1)) : 0;
    if (vh) while (n > 0 && hh + ry[n] > vh * 0.6) n--;
    return n;
  });
  const fc = $derived.by(() => {
    let n = freezeOn && sh?.freeze ? Math.min(sh.freeze.cols || 0, Math.max(0, nc - 1)) : 0;
    if (vw) while (n > 0 && hw + cx[n] > vw * 0.6) n--;
    return n;
  });
  const fx = $derived(cx[fc] || 0), fy = $derived(ry[fr] || 0);
  const Lw = $derived(hw + fx), Th = $derived(hh + fy);
  const W = $derived(hw + (cx[nc] || 0)), H = $derived(hh + (ry[nr] || 0));

  // —— 虚拟窗口：滚动事件里同步算（浏览器下一帧画之前 DOM 已经换好），只有跨档才换新对象 ——
  function computeWin() {
    if (!scroller || !sh) return;
    const sL = scroller.scrollLeft, sT = scroller.scrollTop;
    const a = indexAt(ry, fy + sT), b = indexAt(ry, fy + sT + Math.max(1, vh - Th));
    const c = indexAt(cx, fx + sL), d = indexAt(cx, fx + sL + Math.max(1, vw - Lw));
    const r0 = Math.max(fr, Math.floor(a / RQ) * RQ - RQ), r1 = Math.min(nr - 1, (Math.floor(b / RQ) + 2) * RQ - 1);
    const c0 = Math.max(fc, Math.floor(c / CQ) * CQ - CQ), c1 = Math.min(nc - 1, (Math.floor(d / CQ) + 2) * CQ - 1);
    const w = win;
    if (r0 !== w.r0 || r1 !== w.r1 || c0 !== w.c0 || c1 !== w.c1) win = { r0, r1, c0, c1 };
  }
  $effect(() => { void ry; void cx; void vw; void vh; void fr; void fc; untrack(computeWin); });
  function onScroll() { computeWin(); }

  // —— 样式 → 内联 CSS（按样式号缓存；主题 / 缩放一变整表重算）——
  const PAPER_DARK = [38, 38, 36];
  const rgbOf = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const hexOf = (c) => '#' + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
  const NO_STYLE = Object.freeze({ css: '', bg: '', wrap: false, h: '', v: '', ind: 0, sz: 0 });
  const cache = $derived.by(() => { void light; void z; void styles; return new Map(); });
  function sty(si) {
    if (si == null || si < 0) return NO_STYLE;
    let v = cache.get(si);
    if (v) return v;
    const st = styles[si];
    if (!st) { cache.set(si, NO_STYLE); return NO_STYLE; }
    let css = '', bg = '', fgDef = '';
    if (st.b) css += 'font-weight:700;';
    if (st.i) css += 'font-style:italic;';
    if (st.u || st.st) css += `text-decoration:${st.u ? 'underline' : ''}${st.st ? ' line-through' : ''};`;
    if (st.sz && st.sz !== 11) css += `font-size:${(fontPx(st.sz) * z).toFixed(1)}px;`;
    if (st.bg) {
      const c = rgbOf(st.bg);
      if (Math.min(...c) >= 245) { /* 近白底色 = 纸面，不铺 */ }
      else if (!light && lum(c) > 0.6) bg = hexOf(c.map((x, i) => x * 0.22 + PAPER_DARK[i] * 0.78));   // 深色主题：浅底色压暗成同色相的深底
      else { bg = st.bg; fgDef = '#000'; }                                                              // 深底色原样，字按 Excel 缺省黑
    }
    let fg = fgDef;
    if (st.fg) {
      const c = rgbOf(st.fg), L = lum(c);
      if (fgDef) fg = st.fg;                                   // 原样保留的底色上，字色也原样
      else if (L < 0.08) fg = '';                              // 近黑 = 跟主题墨色
      else if (L > 0.9) fg = bg ? st.fg : '';                  // 白字落在纸面上看不见 → 墨色
      else if (!light && L < 0.35) fg = hexOf(c.map((x) => x + (255 - x) * 0.55));   // 深色主题里深色字提亮
      else fg = st.fg;
    }
    if (bg) css += `background:${bg};`;
    if (fg) css += `color:${fg};`;
    v = { css, bg, wrap: !!st.wrap, h: st.h || '', v: st.v || '', ind: st.ind || 0, sz: st.sz || 0 };
    cache.set(si, v);
    return v;
  }

  // —— 合并单元格 ——
  function mergeAt(r, c) {
    const s = sh;
    if (!s?.merges?.length) return null;
    const k = pack(r, c);
    if (s.anchors.has(k)) return s.merges[s.anchors.get(k)];
    if (!s.covered.has(k)) return null;
    for (const m of s.merges) if (r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) return m;
    return null;
  }

  // —— 一块面板里要画的格子 ——
  function item(k, cell, r, c, x, y, w, h, kind, w0) {
    const st = sty(cell?.s);
    const ck = cell?.k || '';
    const ha = st.h || (ck === 'n' || ck === 'd' ? 'right' : ck === 'b' || ck === 'e' ? 'center' : 'left');
    let cls = 'h-' + ha[0] + ' v-' + (st.v ? st.v[0] : 'b');
    if (st.wrap) cls += ' wr';
    if (ck === 'n' || ck === 'd') cls += ' num';
    if (kind) cls += ' ' + kind;
    if (hitSet.size && hitSet.has(pack(r, c))) cls += ' hit';
    const ov = kind === 'ov';
    let css = `left:${x}px;top:${y}px;width:${ov ? w - 1 : w}px;height:${ov ? h - 1 : h}px;` + st.css;
    if (ov) css += st.bg ? `background:linear-gradient(90deg,${st.bg} ${w0}px,var(--sg-bg) ${w0}px);` : 'background:var(--sg-bg);';
    else if (kind === 'mg' && !st.bg) css += 'background:var(--sg-bg);';
    if (st.ind) css += `padding-${ha === 'right' ? 'right' : 'left'}:${Math.round((3 + st.ind * 9) * z)}px;`;
    let text = cell?.w || '';
    if (!st.wrap && text.includes('\n')) text = text.replace(/\r?\n/g, ' ');
    return { k, w: text, l: cell?.l || '', cls, css };
  }
  function buildCells(rA, rB, cA, cB, lo, hi, ox, oy) {
    const out = [];
    const s = sh;
    if (!s || rB < rA || cB < cA) return out;
    const { cells, anchors, covered, merges } = s;
    const hasM = merges.length > 0;
    for (let i = 0; i < merges.length; i++) {
      const m = merges[i];
      if (m.r1 < rA || m.r0 > rB || m.c1 < cA || m.c0 > cB) continue;
      const x = cx[m.c0] + ox, y = ry[m.r0] + oy, w = cx[m.c1 + 1] - cx[m.c0], h = ry[m.r1 + 1] - ry[m.r0];
      if (w > 0 && h > 0) out.push(item(-(i + 1), cells[m.r0]?.[m.c0], m.r0, m.c0, x, y, w, h, 'mg', w));
    }
    const from = Math.max(lo, cA - LOOKBACK);
    for (let r = rA; r <= rB; r++) {
      const row = cells[r];
      if (!row) continue;
      const y = ry[r] + oy, h = ry[r + 1] - ry[r];
      if (h <= 0) continue;
      const end = Math.min(cB, row.length - 1);
      for (let c = from; c <= end; c++) {
        const cell = row[c];
        if (!cell) continue;
        const k = pack(r, c);
        if (hasM && (covered.has(k) || anchors.has(k))) continue;
        const w0 = cx[c + 1] - cx[c];
        if (w0 <= 0) continue;
        const st = sty(cell.s);
        if (!cell.w && !st.bg) continue;
        // 左对齐、不换行的文字放不下时向右溢出到空格子（碰到有值 / 有底色 / 合并的格子、冻结线或 32 列为止）
        let e = c;
        if (cell.w && !st.wrap && (cell.k === 's' || cell.k === '') && (!st.h || st.h === 'left')) {
          const need = (textUnits(cell.w) * fontPx(st.sz) * 0.56 + 8 + st.ind * 9) * z;
          let acc = w0;
          while (acc < need && e + 1 <= hi && e - c < OV_MAX) {
            const n = row[e + 1], kn = k + (e + 1 - c);
            if ((n && (n.w || sty(n.s).bg)) || (hasM && (covered.has(kn) || anchors.has(kn)))) break;
            e++;
            acc += cx[e + 1] - cx[e];
          }
        }
        if (c < cA && e < cA) continue;   // 往回看的格子没溢出到窗口里
        out.push(item(k, cell, r, c, cx[c] + ox, y, cx[e + 1] - cx[c], h, e > c ? 'ov' : '', w0));
      }
    }
    return out;
  }
  function buildLines(rA, rB, cA, cB, ox, oy) {
    if (!gridOn || rB < rA || cB < cA) return null;
    const v = [], hz = [];
    for (let c = cA; c <= cB; c++) if (cx[c + 1] > cx[c]) v.push(cx[c + 1] + ox - 1);
    for (let r = rA; r <= rB; r++) if (ry[r + 1] > ry[r]) hz.push(ry[r + 1] + oy - 1);
    return { v, h: hz, x0: cx[cA] + ox, x1: cx[cB + 1] + ox, y0: ry[rA] + oy, y1: ry[rB + 1] + oy };
  }
  const pane = (rA, rB, cA, cB, lo, hi, ox, oy) => ({ cells: buildCells(rA, rB, cA, cB, lo, hi, ox, oy), gl: buildLines(rA, rB, cA, cB, ox, oy) });
  const EMPTY = { cells: [], gl: null };
  const pCorner = $derived(fr && fc ? pane(0, fr - 1, 0, fc - 1, 0, fc - 1, hw, hh) : EMPTY);
  const pTop = $derived(fr && win.c1 >= win.c0 ? pane(0, fr - 1, win.c0, win.c1, fc, nc - 1, -fx, hh) : EMPTY);
  const pLeft = $derived(fc && win.r1 >= win.r0 ? pane(win.r0, win.r1, 0, fc - 1, 0, fc - 1, hw, -fy) : EMPTY);
  const pBody = $derived(pane(win.r0, win.r1, win.c0, win.c1, fc, nc - 1, -fx, -fy));
  function visList(pre, a, b) { const o = []; for (let i = a; i <= b; i++) if (pre[i + 1] > pre[i]) o.push(i); return o; }
  const colsFrozen = $derived(visList(cx, 0, fc - 1));
  const colsTop = $derived(visList(cx, win.c0, win.c1));
  const rowsFrozen = $derived(visList(ry, 0, fr - 1));
  const rowsLeft = $derived(visList(ry, win.r0, win.r1));

  // —— 选区 ——
  function rangeOf(a, b) {
    let r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r), c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c);
    const ms = sh?.merges;
    if (ms?.length) {
      for (let changed = true; changed;) {
        changed = false;
        for (const m of ms) {
          if (m.r1 < r0 || m.r0 > r1 || m.c1 < c0 || m.c0 > c1) continue;
          if (m.r0 < r0) { r0 = m.r0; changed = true; }
          if (m.r1 > r1) { r1 = m.r1; changed = true; }
          if (m.c0 < c0) { c0 = m.c0; changed = true; }
          if (m.c1 > c1) { c1 = m.c1; changed = true; }
        }
      }
    }
    return { r0, r1, c0, c1 };
  }
  const sel = $derived(rangeOf(anc, far));
  const actBox = $derived.by(() => mergeAt(anc.r, anc.c) || { r0: anc.r, r1: anc.r, c0: anc.c, c1: anc.c });
  const multi = $derived(sel.r0 !== actBox.r0 || sel.r1 !== actBox.r1 || sel.c0 !== actBox.c0 || sel.c1 !== actBox.c1);
  const actCell = $derived(sh?.cells[anc.r]?.[anc.c] || null);
  function isDateFmt(f) {
    if (!f) return false;
    const s = String(f).replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
    return /[ymdhs]/i.test(s);
  }
  // 公式栏：有公式显示公式；日期显示格式化后的样子（序列号没人看得懂）；其余显示原始值（25% → 0.25、1,234 → 1234）
  const fxText = $derived(!actCell ? '' : actCell.f ? '=' + actCell.f : isDateFmt(actCell.z) ? actCell.w : (actCell.raw ?? actCell.w ?? ''));
  const nameText = $derived(addr(anc.r, anc.c));

  const lastRow = () => Math.max(0, nr - 1), lastCol = () => Math.max(0, nc - 1);
  const clampP = (p) => ({ r: clamp(p.r, 0, lastRow()), c: clamp(p.c, 0, lastCol()) });
  function firstVis(pre, n) { for (let i = 0; i < n; i++) if (pre[i + 1] > pre[i]) return i; return 0; }
  function setCell(p, extend = false, show = true) {
    p = clampP(p);
    if (extend) far = p;
    else {
      const m = mergeAt(p.r, p.c);
      anc = m ? { r: m.r0, c: m.c0 } : p;
      far = anc;
    }
    if (show) reveal(p.r, p.c);
  }
  /** 把 (r, c) 滚进主体可视区（冻结区里的不用滚） */
  function reveal(r, c) {
    if (!scroller) return;
    if (r >= fr) {
      const top = ry[r] - fy, bot = ry[r + 1] - fy, view = Math.max(1, vh - Th);
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (bot > scroller.scrollTop + view) scroller.scrollTop = Math.min(top, bot - view);
    }
    if (c >= fc) {
      const l = cx[c] - fx, rr = cx[c + 1] - fx, view = Math.max(1, vw - Lw);
      if (l < scroller.scrollLeft) scroller.scrollLeft = l;
      else if (rr > scroller.scrollLeft + view) scroller.scrollLeft = Math.min(l, rr - view);
    }
    computeWin();
  }
  /** 全选。whole=false（Ctrl+A、菜单）：先选已用区域（Excel 在数据区里按 Ctrl+A 也是先选当前区域），已经是它时再按一次才选整张；
   *  whole=true（点左上角）：直接整张。网格比数据多画了几行几列空白，整张会含这些空白 */
  export function selectAll(whole = false) {
    const r0 = firstVis(ry, nr), c0 = firstVis(cx, nc);
    const used = { r: Math.max(r0, (sh?.nRows || 1) - 1), c: Math.max(c0, (sh?.nCols || 1) - 1) };
    const atUsed = anc.r === r0 && anc.c === c0 && far.r === used.r && far.c === used.c;
    anc = { r: r0, c: c0 };
    far = whole || atUsed ? { r: lastRow(), c: lastCol() } : used;
  }

  // —— 键盘 ——
  function nextVis(pre, i, d, n) {
    if (!d) return i;
    let j = i + d;
    while (j >= 0 && j < n && pre[j + 1] === pre[j]) j += d;
    return j < 0 || j >= n ? i : j;
  }
  function step(dr, dc, extend) {
    const from = extend ? far : anc;
    let r = from.r, c = from.c;
    const m = !extend && mergeAt(r, c);
    if (m) { if (dr > 0) r = m.r1; if (dr < 0) r = m.r0; if (dc > 0) c = m.c1; if (dc < 0) c = m.c0; }
    setCell({ r: nextVis(ry, r, dr, nr), c: nextVis(cx, c, dc, nc) }, extend);
  }
  const filled = (r, c) => { const x = sh.cells[r]?.[c]; return !!(x && x.w !== ''); };
  /** Ctrl+方向键：在数据块里跳到块边；在空白里跳到下一个有值的格子；都没有就到数据边界 */
  function edge(from, dr, dc) {
    const limR = Math.max(0, sh.nRows - 1), limC = Math.max(0, sh.nCols - 1);
    const inb = (r, c) => r >= 0 && c >= 0 && r <= limR && c <= limC;
    const bound = () => ({ r: dr ? (dr > 0 ? Math.max(from.r, limR) : 0) : from.r, c: dc ? (dc > 0 ? Math.max(from.c, limC) : 0) : from.c });
    let r = from.r, c = from.c;
    if (!inb(r + dr, c + dc)) return bound();
    if (filled(r, c) && filled(r + dr, c + dc)) {
      while (inb(r + dr, c + dc) && filled(r + dr, c + dc)) { r += dr; c += dc; }
      return { r, c };
    }
    r += dr; c += dc;
    while (inb(r, c) && !filled(r, c)) { r += dr; c += dc; }
    return inb(r, c) ? { r, c } : bound();
  }
  function page(dir, extend) {
    if (!scroller) return;
    const st = scroller.scrollTop, view = Math.max(1, vh - Th);
    const rows = Math.max(1, indexAt(ry, fy + st + view) - indexAt(ry, fy + st));
    const from = extend ? far : anc;
    scroller.scrollTop = st + dir * view;
    setCell({ r: from.r + dir * rows, c: from.c }, extend);
  }
  function nav(e) {
    if (!sh) return false;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && !e.altKey && (k === 'a' || k === 'A')) { selectAll(); return true; }
    if (mod && !e.altKey && !e.shiftKey && (k === 'c' || k === 'C')) {
      const s = window.getSelection?.();
      if (s && !s.isCollapsed && String(s)) return false;   // 选了公式栏里的字：让浏览器原生复制
      copy();
      return true;
    }
    if (e.altKey) return false;
    let dr = 0, dc = 0;
    switch (k) {
      case 'ArrowUp': dr = -1; break;
      case 'ArrowDown': dr = 1; break;
      case 'ArrowLeft': dc = -1; break;
      case 'ArrowRight': dc = 1; break;
      case 'Tab': if (mod) return false; step(0, e.shiftKey ? -1 : 1, false); return true;
      case 'Enter': if (mod) return false; step(e.shiftKey ? -1 : 1, 0, false); return true;
      case 'Home': setCell(mod ? { r: firstVis(ry, nr), c: firstVis(cx, nc) } : { r: (e.shiftKey ? far : anc).r, c: firstVis(cx, nc) }, e.shiftKey); return true;
      case 'End': if (!mod) return false; setCell({ r: Math.max(0, sh.nRows - 1), c: Math.max(0, sh.nCols - 1) }, e.shiftKey); return true;
      case 'PageDown': case 'PageUp': if (mod) return false; page(k === 'PageDown' ? 1 : -1, e.shiftKey); return true;
      default: return false;
    }
    if (mod) setCell(edge(e.shiftKey ? far : anc, dr, dc), e.shiftKey);
    else step(dr, dc, e.shiftKey);
    return true;
  }
  function onGridKey(e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (nav(e)) e.preventDefault();
  }
  /** 外框 declare.keys：全局快捷键 + 焦点不在网格里时的方向键（打开就能用方向键走格子） */
  export function keys(e) {
    if (!sh || e.isComposing) return false;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && !e.altKey && (k === 'f' || k === 'F')) { openFind(); return true; }
    if (findOpen && hits.length && (k === 'F3' || (mod && (k === 'g' || k === 'G')))) { stepHit(e.shiftKey ? -1 : 1); return true; }
    if (k === 'Escape' && findOpen) { closeFind(); return true; }
    if (mod && !e.altKey && (k === '=' || k === '+')) { zoomStep(1); return true; }
    if (mod && !e.altKey && (k === '-' || k === '_')) { zoomStep(-1); return true; }
    if (mod && !e.altKey && k === '0') { zoomTo(1); return true; }
    if (mod && (k === 'PageDown' || k === 'PageUp')) { switchSheet(k === 'PageDown' ? 1 : -1); return true; }
    // Ctrl+PgDn / PgUp 在浏览器里多半被「切换标签页」抢走、到不了页面：另给一组浏览器不占的 Alt+↓ / ↑（Google 表格同款）
    if (e.altKey && !mod && !e.shiftKey && (k === 'ArrowDown' || k === 'ArrowUp') && !isEditable(e.target)) { switchSheet(k === 'ArrowDown' ? 1 : -1); return true; }
    if (isEditable(e.target) || (scroller && scroller.contains(e.target))) return false;
    if (rootEl && rootEl.contains(e.target) && e.target !== rootEl && e.target.closest?.('button, a, [role="tab"]')) return false;
    return nav(e);
  }
  function switchSheet(d) {
    for (let i = active + d; i >= 0 && i < sheets.length; i += d) if (!sheets[i].hidden) { active = i; return; }
  }
  // 鼠标点标签换表后键盘回到格子上（同 Excel：方向键 / Ctrl+End 走单元格）；键盘在标签间移动时焦点留在标签上
  function pickTab(i, via) {
    active = i;
    if (via === 'pointer' && !touch) queueMicrotask(() => { try { scroller?.focus({ preventScroll: true }); } catch {} });
  }

  // —— 复制 / 统计 ——
  export async function copy() {
    if (!sh) return;
    const r1 = Math.min(sel.r1, sh.nRows - 1), c1 = Math.min(sel.c1, sh.nCols - 1);
    const n = Math.max(0, r1 - sel.r0 + 1) * Math.max(0, c1 - sel.c0 + 1);
    if (n > 2_000_000) { viewer.toast(t('选区太大，无法复制'), { kind: 'err' }); return; }
    const text = n ? selectionTsv(sh, sel) : '';
    if (!text.replace(/[\t\n]/g, '')) { viewer.toast(t('选中的单元格是空的')); return; }
    const ok = await copyText(text);
    viewer.toast(ok ? t('已复制 {n} 个单元格', { n }) : t('复制失败'), { kind: ok ? 'ok' : 'err' });
  }
  const stats = $derived.by(() => {
    if (!sh || !multi) return null;
    const r1 = Math.min(sel.r1, sh.nRows - 1), c1 = Math.min(sel.c1, sh.nCols - 1);
    if (r1 < sel.r0 || c1 < sel.c0 || (r1 - sel.r0 + 1) * (c1 - sel.c0 + 1) > 1_000_000) return null;
    let cnt = 0, num = 0, sum = 0;
    for (let r = sel.r0; r <= r1; r++) {
      const row = sh.cells[r];
      if (!row) continue;
      const e = Math.min(c1, row.length - 1);
      for (let c = sel.c0; c <= e; c++) {
        const x = row[c];
        if (!x || x.w === '') continue;
        cnt++;
        if (x.k === 'n') { const v = Number(x.raw ?? x.w); if (Number.isFinite(v)) { num++; sum += v; } }
      }
    }
    return cnt < 2 ? null : { cnt, num, sum, avg: num ? sum / num : 0 };
  });
  function fmtNum(v) {
    if (!Number.isFinite(v)) return '—';
    if (v !== 0 && (Math.abs(v) >= 1e15 || Math.abs(v) < 1e-6)) return v.toPrecision(6);
    return (+v.toPrecision(12)).toLocaleString(locale(), { maximumFractionDigits: 10 });
  }

  // —— 查找 ——
  export async function openFind() {
    const was = findOpen;
    findOpen = true;
    if (findQ) runFind(findQ, false);
    await tick();
    if (was) findBar?.focus();
  }
  export function closeFind() {
    findOpen = false;
    hits = []; hitSet = new Set(); hitAt = 0;
    try { scroller?.focus({ preventScroll: true }); } catch {}
  }
  function runFind(q, jump = true) {
    findQ = q;
    if (!q || !sh) { hits = []; hitSet = new Set(); hitAt = 0; return; }
    const list = findCells(sh, q);
    hits = list;
    hitSet = new Set(list.map((h) => pack(h.r, h.c)));
    const i = list.findIndex((h) => h.r > anc.r || (h.r === anc.r && h.c >= anc.c));
    hitAt = i < 0 ? 0 : i;
    if (jump && list.length) goHit(hitAt);
  }
  function goHit(i) { const h = hits[i]; if (h) setCell(h); }
  function stepHit(d) {
    if (!hits.length) return;
    hitAt = (hitAt + d + hits.length) % hits.length;
    goHit(hitAt);
  }

  // —— 缩放（以指针 / 捏合中点为锚）——
  async function zoomAt(nz, x, y, fromX = x, fromY = y) {
    nz = clamp(Math.round(nz * 100) / 100, ZMIN, ZMAX);
    const old = z;
    if (Math.abs(nz - old) < 0.001) return;
    if (!scroller) { zoom = nz; return; }
    const r = scroller.getBoundingClientRect();
    const vx0 = fromX == null ? scroller.clientWidth / 2 : fromX - r.left, vy0 = fromY == null ? scroller.clientHeight / 2 : fromY - r.top;
    const vx1 = x == null ? vx0 : x - r.left, vy1 = y == null ? vy0 : y - r.top;
    const sL = scroller.scrollLeft, sT = scroller.scrollTop, f = nz / old;
    zoom = nz;
    await tick();
    scroller.scrollLeft = Math.max(0, (sL + vx0) * f - vx1);
    scroller.scrollTop = Math.max(0, (sT + vy0) * f - vy1);
    computeWin();
  }
  export function zoomTo(v) { zoomAt(v); }
  export function zoomStep(d) {
    const next = d > 0 ? ZOOMS.find((v) => v > z * 1.01) ?? ZMAX : [...ZOOMS].reverse().find((v) => v < z / 1.01) ?? ZMIN;
    zoomAt(next);
  }
  export function zoomItems() {
    return ZOOMS.map((v) => ({ label: `${Math.round(v * 100)}%`, checked: Math.abs(z - v) < 0.005, onSelect: () => zoomAt(v) }));
  }
  let wheelGoal = 0, wheelT = 0;
  function onWheelZoom({ factor, cx: px, cy: py }) {
    wheelGoal = clamp((wheelGoal || z) * factor, ZMIN, ZMAX);
    clearTimeout(wheelT);
    wheelT = setTimeout(() => (wheelGoal = 0), 400);
    if (Math.abs(wheelGoal - z) >= 0.01) zoomAt(wheelGoal, px, py);
  }
  function onPinchEnd({ factor, x0, y0, cx: px, cy: py }) {
    if (Math.abs(factor - 1) >= 0.01) zoomAt(z * factor, px, py, x0, y0);
  }
  function openZoomMenu(e) {
    viewer.openMenu({ anchor: e.currentTarget, items: zoomItems, title: t('缩放'), place: 'top' });
  }

  // —— 指针：视口坐标 → 格子 ——
  /** @returns {{ r, c, rowHead, colHead } | null}；clampIn：拖选时把视口外的点夹回视口（还要越过表头算成第一格） */
  function hit(x, y, clampIn = false) {
    if (!scroller || !sh) return null;
    const rect = scroller.getBoundingClientRect();
    let vx = x - rect.left, vy = y - rect.top;
    const cw = scroller.clientWidth, ch = scroller.clientHeight;
    if (clampIn) { vx = clamp(vx, hw, cw - 1); vy = clamp(vy, hh, ch - 1); }
    else if (vx < 0 || vy < 0 || vx >= cw || vy >= ch) return null;   // 滚动条上
    const rowHead = vx < hw, colHead = vy < hh;
    const px = vx < Lw ? vx - hw : vx - hw + scroller.scrollLeft;
    const py = vy < Th ? vy - hh : vy - hh + scroller.scrollTop;
    return { r: indexAt(ry, Math.max(0, py)), c: indexAt(cx, Math.max(0, px)), rowHead, colHead };
  }

  // 鼠标：按下选格 / 行列头 / 全选，拖动扩选，拖出视口自动滚
  let drag = null, dragMoved = false;
  function onPointerDown(e) {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const h = hit(e.clientX, e.clientY);
    if (!h) return;
    e.preventDefault();
    try { scroller.focus({ preventScroll: true }); } catch {}
    dragMoved = false;
    if (h.rowHead && h.colHead) { selectAll(true); return; }
    const mode = h.rowHead ? 'rows' : h.colHead ? 'cols' : 'cell';
    pointAt(h, mode, e.shiftKey, true);
    drag = { mode, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, raf: 0 };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }
  /** start：按下（定锚点）；否则是拖动 / Shift 扩到这里 */
  function pointAt(h, mode, extend, start) {
    if (mode === 'rows') {
      if (start && !extend) anc = { r: h.r, c: firstVis(cx, nc) };
      far = { r: h.r, c: lastCol() };
      if (start && !extend) return;
      anc = { r: anc.r, c: firstVis(cx, nc) };
    } else if (mode === 'cols') {
      if (start && !extend) anc = { r: firstVis(ry, nr), c: h.c };
      far = { r: lastRow(), c: h.c };
      if (start && !extend) return;
      anc = { r: firstVis(ry, nr), c: anc.c };
    } else if (start && !extend) setCell(h, false, false);
    else far = { r: h.r, c: h.c };
  }
  function onDragMove(e) {
    if (!drag) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!dragMoved && Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 4) dragMoved = true;
    dragUpdate();
    if (!drag.raf) drag.raf = requestAnimationFrame(autoScroll);
  }
  function dragUpdate() {
    const h = hit(drag.x, drag.y, true);
    if (!h) return;
    if (drag.mode === 'rows') pointAt({ r: h.r, c: 0 }, 'rows', true, false);
    else if (drag.mode === 'cols') pointAt({ r: 0, c: h.c }, 'cols', true, false);
    else far = { r: h.r, c: h.c };
  }
  function autoScroll() {
    if (!drag) return;
    drag.raf = 0;
    const rect = scroller.getBoundingClientRect();
    const vx = drag.x - rect.left, vy = drag.y - rect.top, cw = scroller.clientWidth, ch = scroller.clientHeight;
    const sp = (d) => Math.sign(d) * Math.min(48, 4 + Math.abs(d) * 0.4);
    const left = fc ? 0 : hw, top = fr ? 0 : hh;
    const dx = drag.mode === 'rows' ? 0 : vx > cw ? sp(vx - cw) : vx < left ? sp(vx - left) : 0;
    const dy = drag.mode === 'cols' ? 0 : vy > ch ? sp(vy - ch) : vy < top ? sp(vy - top) : 0;
    if (!dx && !dy) return;
    scroller.scrollLeft += dx; scroller.scrollTop += dy;
    computeWin();
    dragUpdate();
    drag.raf = requestAnimationFrame(autoScroll);
  }
  function onDragEnd() {
    if (drag?.raf) cancelAnimationFrame(drag.raf);
    drag = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    setTimeout(() => (dragMoved = false), 0);
  }
  // 链接：电脑单击直接开（拖选过就不开）；触屏要先点选这一格、再点一次才开（不然滑一下就跳走了）
  let linkOk = false;
  function onClickCapture(e) {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    if (touch ? !linkOk : dragMoved) e.preventDefault();
  }
  function onContextMenu(e) {
    if (touch || e.pointerType === 'touch') { e.preventDefault(); return; }
    const h = hit(e.clientX, e.clientY);
    if (!h || !viewer.inShell) return;
    e.preventDefault();
    if (h.rowHead || h.colHead) { /* 表头上右键保持当前选区 */ }
    else if (h.r < sel.r0 || h.r > sel.r1 || h.c < sel.c0 || h.c > sel.c1) setCell(h, false, false);
    const x = e.clientX, y = e.clientY;
    const anchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0, x, y }), contains: () => false };
    viewer.openMenu({ anchor, items: () => [
      { label: t('复制'), icon: 'copy', kbd: 'Ctrl+C', onSelect: copy },
      { label: t('全选'), kbd: 'Ctrl+A', onSelect: () => selectAll() },
      { sep: true },
      { label: t('查找'), icon: 'search', kbd: 'Ctrl+F', onSelect: openFind },
    ] });
  }

  // 触屏：轻点选格；长按 450ms 进入扩选，接着拖动扩到手指下（这时拦住原生滚动）
  let tp = null;
  function onTouchStart(e) {
    if (e.touches.length !== 1) { cancelTouch(); return; }
    const p = e.touches[0];
    tp = { x: p.clientX, y: p.clientY, t: e.timeStamp, moved: false, extend: false, timer: setTimeout(longPress, 450) };
  }
  function cancelTouch() { if (tp) clearTimeout(tp.timer); tp = null; }
  function longPress() {
    if (!tp || tp.moved) return;
    const h = hit(tp.x, tp.y);
    if (!h) return;
    tp.extend = true;
    if (h.rowHead && h.colHead) selectAll(true);
    else { tp.mode = h.rowHead ? 'rows' : h.colHead ? 'cols' : 'cell'; pointAt(h, tp.mode, false, true); }
    try { navigator.vibrate?.(8); } catch {}
  }
  function onTouchMove(e) {
    if (!tp) return;
    const p = e.touches[0];
    if (!p) return;
    if (tp.extend) {
      if (e.cancelable) e.preventDefault();
      const h = hit(p.clientX, p.clientY, true);
      if (!h || !tp.mode) return;
      if (tp.mode === 'rows') pointAt({ r: h.r, c: 0 }, 'rows', true, false);
      else if (tp.mode === 'cols') pointAt({ r: 0, c: h.c }, 'cols', true, false);
      else far = { r: h.r, c: h.c };
      return;
    }
    if (Math.hypot(p.clientX - tp.x, p.clientY - tp.y) > 10) { tp.moved = true; clearTimeout(tp.timer); }
  }
  function onTouchEnd(e) {
    if (!tp) return;
    clearTimeout(tp.timer);
    const s = tp;
    tp = null;
    linkOk = false;
    if (e.type === 'touchcancel' || s.moved || e.touches.length) return;
    if (s.extend) { if (e.cancelable) e.preventDefault(); return; }
    if (e.timeStamp - s.t > 500) return;
    const h = hit(s.x, s.y);
    if (!h) return;
    if (h.rowHead && h.colHead) { selectAll(true); return; }
    if (h.rowHead) { pointAt(h, 'rows', false, true); return; }
    if (h.colHead) { pointAt(h, 'cols', false, true); return; }
    const m = mergeAt(h.r, h.c);
    const at = m ? { r: m.r0, c: m.c0 } : h;
    linkOk = !multi && at.r === anc.r && at.c === anc.c;
    setCell(h, false, false);
  }

  // —— 名称框（电脑）：输入 B3 或 B3:D10 回车跳过去 ——
  function onNameKey(e) {
    const el = e.currentTarget;
    if (e.key === 'Enter') {
      e.preventDefault();
      const [p, q] = el.value.trim().split(':');
      const a = decodeAddr(p), b = q ? decodeAddr(q) : a;
      if (!a || !b) { viewer.toast(t('无效的单元格地址'), { kind: 'err' }); el.value = nameText; el.select(); return; }
      setCell(a);
      if (q) far = clampP(b);
      el.value = addr(anc.r, anc.c);
      try { scroller?.focus({ preventScroll: true }); } catch {}
    } else if (e.key === 'Escape') {
      e.preventDefault();
      el.value = nameText;
      try { scroller?.focus({ preventScroll: true }); } catch {}
    }
  }
  // 公式栏内容放不下（或有换行）才出展开钮
  $effect(() => {
    void fxText; void vw;
    if (!fxVal) return;
    untrack(() => {
      if (fxOpen) return;
      fxLong = fxText.includes('\n') || fxVal.scrollWidth > fxVal.clientWidth + 1;
    });
  });
  $effect(() => { void anc; untrack(() => { if (fxOpen && !touch) fxOpen = false; }); });

  // —— 换表：存 / 取每张表的选区、滚动位置、网格线开关；第一次打开按文件存盘时的活动格与左上角 ——
  const saved = new Map();
  let shownSheet = -1, shownBook = null;
  $effect.pre(() => {
    const i = active, s = sh, b = book;
    untrack(() => {
      if (b !== shownBook) { saved.clear(); shownSheet = -1; shownBook = b; }
      if (shownSheet === i || !s) return;
      if (shownSheet >= 0 && scroller) saved.set(shownSheet, { anc, far, sl: scroller.scrollLeft, st: scroller.scrollTop, grid: gridOn });
      shownSheet = i;
      const v = saved.get(i);
      let sl = 0, st = 0, top = null;
      if (v) { anc = v.anc; far = v.far; gridOn = v.grid; sl = v.sl; st = v.st; }
      else {
        const a = decodeAddr(s.view?.act);
        const p = a && a.r < s.nRows + 10 && a.c < s.nCols + 3 ? a : { r: 0, c: 0 };
        const m = mergeAt(p.r, p.c);
        anc = m ? { r: m.r0, c: m.c0 } : p;
        far = anc;
        gridOn = s.grid !== false;
        top = decodeAddr(s.view?.top);
      }
      fxOpen = false;
      tick().then(() => {
        if (!scroller) return;
        if (top) { st = Math.max(0, ry[top.r] - fy); sl = Math.max(0, cx[top.c] - fx); }
        scroller.scrollLeft = sl; scroller.scrollTop = st;
        computeWin();
      });
      if (findOpen && findQ) runFind(findQ, false);
    });
  });

  // —— 生命周期 ——
  onMount(() => {
    const ro = new ResizeObserver(() => { if (scroller) { vw = scroller.clientWidth; vh = scroller.clientHeight; } });
    ro.observe(scroller);
    vw = scroller.clientWidth; vh = scroller.clientHeight;
    const detach = attachGestures(scroller, {
      pinchTarget: () => content,
      clampFactor: (f) => clamp(z * f, ZMIN, ZMAX) / z,
      onPinchStart: cancelTouch,
      onPinchEnd,
      onWheelZoom,
    });
    const ac = new AbortController();
    const o = { passive: false, signal: ac.signal };
    scroller.addEventListener('touchstart', onTouchStart, { passive: true, signal: ac.signal });
    scroller.addEventListener('touchmove', onTouchMove, o);
    scroller.addEventListener('touchend', onTouchEnd, o);
    scroller.addEventListener('touchcancel', onTouchEnd, o);
    // 不在查看器外框里（单独挂载）时自己接键盘
    if (!viewer.inShell) window.addEventListener('keydown', (e) => { if (!e.defaultPrevented && keys(e)) e.preventDefault(); }, { signal: ac.signal });
    if (!touch) try { scroller.focus({ preventScroll: true }); } catch {}
    return () => { ro.disconnect(); detach(); ac.abort(); cancelTouch(); onDragEnd(); clearTimeout(wheelT); };
  });

  const pct = $derived(Math.round(z * 100));
  const shownTabs = $derived(sheets.filter((s) => !s.hidden).length);
  const live = $derived(sh ? `${nameText} ${actCell?.w ?? ''}`.trim() : '');
</script>

{#snippet colHeads(list, ox)}
  <div class="sg-ch" style:height="{hh}px" aria-hidden="true">
    {#each list as c (c)}
      <div class="hd" class:on={c >= sel.c0 && c <= sel.c1} style="left:{cx[c] + ox}px;width:{cx[c + 1] - cx[c]}px;height:{hh}px">{colName(c)}</div>
    {/each}
  </div>
{/snippet}
{#snippet rowHeads(list, oy)}
  <div class="sg-rh" style:width="{hw}px" aria-hidden="true">
    {#each list as r (r)}
      <div class="hd" class:on={r >= sel.r0 && r <= sel.r1} style="top:{ry[r] + oy}px;height:{ry[r + 1] - ry[r]}px;width:{hw}px">{r + 1}</div>
    {/each}
  </div>
{/snippet}
{#snippet layer(p, ox, oy)}
  {#if p.gl}
    <div class="sg-gl" aria-hidden="true">
      {#each p.gl.v as x}<i class="v" style="left:{x}px;top:{p.gl.y0}px;height:{p.gl.y1 - p.gl.y0}px"></i>{/each}
      {#each p.gl.h as y}<i class="h" style="top:{y}px;left:{p.gl.x0}px;width:{p.gl.x1 - p.gl.x0}px"></i>{/each}
    </div>
  {/if}
  <table class="sg-cells" role="presentation"><tbody><tr>
    {#each p.cells as it (it.k)}
      <td class={it.cls} style={it.css}>{#if it.l}<a href={it.l} target="_blank" rel="noopener noreferrer">{it.w}</a>{:else}{it.w}{/if}</td>
    {/each}
  </tr></tbody></table>
  <div class="sg-sel" aria-hidden="true">
    {#if multi}
      <div class="rg" style="left:{cx[sel.c0] + ox}px;top:{ry[sel.r0] + oy}px;width:{cx[sel.c1 + 1] - cx[sel.c0]}px;height:{ry[sel.r1 + 1] - ry[sel.r0]}px"></div>
    {/if}
    <div class="ac" style="left:{cx[actBox.c0] + ox - 1}px;top:{ry[actBox.r0] + oy - 1}px;width:{cx[actBox.c1 + 1] - cx[actBox.c0] + 1}px;height:{ry[actBox.r1 + 1] - ry[actBox.r0] + 1}px"></div>
  </div>
{/snippet}

<div class="sg of-root" class:touch bind:this={rootEl}
  data-sheet={sh?.name ?? ''} data-rows={sh?.nRows ?? 0} data-cols={sh?.nCols ?? 0}
  data-freeze={fr || fc ? addr(fr, fc) : ''} data-sel={rangeLabel(sel)} data-zoom={z}>
  {#if touch && findOpen}
    <FindBar bind:this={findBar} open={findOpen} bind:query={findQ} current={hitAt + 1} total={hits.length} touch showCase={false}
      onquery={(q) => runFind(q)} onstep={stepHit} onclose={closeFind} />
  {/if}
  {#if formulaBar && sh}
    {#if touch}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="sg-fx t" class:open={fxOpen} role="button" tabindex="-1" aria-expanded={fxOpen} aria-label={t('公式栏')} onclick={() => (fxOpen = !fxOpen)}>
        <span class="sg-addr">{nameText}</span>
        <span class="sg-fx-sep" aria-hidden="true"></span>
        <span class="sg-fx-v" bind:this={fxVal}>{fxText}</span>
      </div>
    {:else}
      <div class="sg-fx" class:open={fxOpen}>
        <input class="sg-name" value={nameText} spellcheck="false" autocomplete="off" aria-label={t('名称框')}
          use:tip={{ label: t('名称框'), kbd: 'Enter' }} onkeydown={onNameKey} onfocus={(e) => e.currentTarget.select()} />
        <span class="sg-fx-sep" aria-hidden="true"></span>
        <span class="sg-fx-l" aria-hidden="true">fx</span>
        <span class="sg-fx-v" bind:this={fxVal} title={fxText.length > 40 ? fxText : null}>{fxText}</span>
        {#if fxLong || fxOpen}
          <button type="button" class="vw-btn sg-fx-x" aria-expanded={fxOpen} onclick={() => (fxOpen = !fxOpen)}
            use:tip={fxOpen ? t('收起') : t('展开')}><VIcon name={fxOpen ? 'up' : 'down'} size={16} /></button>
        {/if}
      </div>
    {/if}
  {/if}
  <div class="sg-main">
    {#if !touch}
      <FindBar bind:this={findBar} open={findOpen} bind:query={findQ} current={hitAt + 1} total={hits.length} showCase={false}
        onquery={(q) => runFind(q)} onstep={stepHit} onclose={closeFind} />
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="sg-scroll" bind:this={scroller} tabindex="0" role="grid" aria-readonly="true" aria-label={sh?.name || t('表格')}
      aria-rowcount={sh?.nRows ?? 0} aria-colcount={sh?.nCols ?? 0}
      onscroll={onScroll} onkeydown={onGridKey} onpointerdown={onPointerDown} onclickcapture={onClickCapture} oncontextmenu={onContextMenu}>
      <div class="sg-content" bind:this={content} style="width:{W}px;height:{H}px;--z:{z}">
        <div class="sg-r1" style:height="{Th}px">
          <div class="sg-pane sg-corner" style="width:{Lw}px;height:{Th}px">
            {#if fr && fc}{@render layer(pCorner, hw, hh)}{/if}
            {#if fr}{@render rowHeads(rowsFrozen, hh)}{/if}
            {@render colHeads(colsFrozen, hw)}
            <div class="sg-all" style="width:{hw}px;height:{hh}px" aria-hidden="true"></div>
            {#if fc}<i class="sg-split v" style:top="{hh}px" aria-hidden="true"></i>{/if}
            {#if fr}<i class="sg-split h" style:left="{hw}px" aria-hidden="true"></i>{/if}
          </div>
          <div class="sg-pane sg-top" style="width:{W - Lw}px;height:{Th}px">
            {#if fr}{@render layer(pTop, -fx, hh)}{/if}
            {@render colHeads(colsTop, -fx)}
            {#if fr}<i class="sg-split h" style:left="0px" aria-hidden="true"></i>{/if}
          </div>
        </div>
        <div class="sg-r2" style:height="{H - Th}px">
          <div class="sg-pane sg-left" style="width:{Lw}px;height:{H - Th}px">
            {#if fc}{@render layer(pLeft, hw, -fy)}{/if}
            {@render rowHeads(rowsLeft, -fy)}
            {#if fc}<i class="sg-split v" style:top="0px" aria-hidden="true"></i>{/if}
          </div>
          <div class="sg-pane sg-body" style="width:{W - Lw}px;height:{H - Th}px">
            {@render layer(pBody, -fx, -fy)}
          </div>
        </div>
      </div>
    </div>
    <div class="vw-sr" aria-live="polite">{live}</div>
  </div>
  {#if !touch}
    <div class="sg-status">
      {#if tabs && sheets.length}
        <div class="sg-tabs"><SheetTabs {sheets} {active} onpick={pickTab} /></div>
      {/if}
      <span class="sg-grow"></span>
      {#if stats}
        <span class="sg-stats">
          {#if stats.num}<span><b>{t('平均值')}</b>{fmtNum(stats.avg)}</span>{/if}
          <span><b>{t('计数')}</b>{stats.cnt}</span>
          {#if stats.num}<span><b>{t('求和')}</b>{fmtNum(stats.sum)}</span>{/if}
        </span>
      {/if}
      <div class="sg-zoom">
        <button type="button" class="vw-btn" disabled={z <= ZMIN} onclick={() => zoomStep(-1)} use:tip={{ label: tc('files', '缩小'), kbd: 'Ctrl+-' }}><VIcon name="minus" /></button>
        <button type="button" class="vw-btn vw-txt sg-pct" onclick={openZoomMenu} use:tip={{ label: t('缩放'), kbd: 'Ctrl+0' }}>{pct}%</button>
        <button type="button" class="vw-btn" disabled={z >= ZMAX} onclick={() => zoomStep(1)} use:tip={{ label: tc('files', '放大'), kbd: 'Ctrl+=' }}><VIcon name="plus" /></button>
      </div>
    </div>
  {:else if tabs && shownTabs > 1}
    <div class="sg-tabsbar"><SheetTabs {sheets} {active} touch onpick={(i) => (active = i)} /></div>
  {/if}
</div>

<style>
  .sg {
    --sg-bg: var(--md-bg);
    --sg-head: linear-gradient(var(--md-bg-2), var(--md-bg-2)), var(--md-bg);
    position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; min-width: 0;
    background: var(--md-bg); color: var(--md-fg); font-size: 13px;
  }

  /* —— 公式栏 —— */
  .sg-fx { flex: none; display: flex; align-items: center; height: 36px; padding: 0 6px 0 8px; background: var(--md-bg);
    box-shadow: inset 0 -1px 0 var(--md-line); font-size: 13px; min-width: 0; }
  .sg-name { flex: none; width: 96px; height: 26px; padding: 0 8px; border: 0; border-radius: 6px; background: var(--md-field);
    color: var(--md-fg); font: inherit; font-size: 12.5px; font-variant-numeric: tabular-nums; outline: none; }
  .sg-name:focus { box-shadow: inset 0 0 0 1.5px var(--md-accent); }
  .sg-fx-sep { flex: none; width: 1px; height: 16px; margin: 0 10px; background: var(--md-line-2); }
  .sg-fx-l { flex: none; margin-right: 10px; font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 14px; color: var(--md-fg-3); }
  .sg-fx-v { flex: 1; min-width: 0; white-space: pre; overflow: hidden; text-overflow: ellipsis; user-select: text; -webkit-user-select: text;
    font-variant-numeric: tabular-nums; }
  .sg-fx-x { --vw-btn: 28px; margin-left: 4px; }
  .sg-fx.open { height: auto; min-height: 36px; align-items: flex-start; padding-top: 5px; padding-bottom: 5px; }
  .sg-fx.open .sg-name, .sg-fx.open .sg-fx-x { margin-top: 0; }
  .sg-fx.open .sg-fx-sep, .sg-fx.open .sg-fx-l { margin-top: 5px; }
  .sg-fx.open .sg-fx-v { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 30vh; overflow: auto; padding-top: 4px; line-height: 1.45; }
  /* 触屏：一行地址 + 值，点一下展开看全文（长按可以选字） */
  .sg-fx.t { height: 44px; padding: 0 14px; font-size: 14px; -webkit-tap-highlight-color: transparent; cursor: pointer; }
  .sg-fx.t.open { height: auto; min-height: 44px; padding-top: 12px; padding-bottom: 12px; }
  .sg-fx.t.open .sg-fx-sep { margin-top: 2px; }
  .sg-fx.t.open .sg-fx-v { padding-top: 0; }
  .sg-addr { flex: none; min-width: 44px; font-weight: 600; color: var(--md-fg-2); font-variant-numeric: tabular-nums; }

  /* —— 网格 —— */
  .sg-main { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .sg-scroll { position: relative; flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; outline: none;
    touch-action: pan-x pan-y; overscroll-behavior: contain; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    scrollbar-width: thin; scrollbar-color: rgba(var(--md-ink), .28) transparent; background: var(--sg-bg); }
  .sg-content { position: relative; }
  .sg-r1 { position: sticky; top: 0; z-index: 3; display: flex; }
  .sg-r2 { display: flex; }
  .sg-pane { position: relative; flex: none; overflow: hidden; background: var(--sg-bg); }
  .sg-corner { position: sticky; left: 0; z-index: 2; }
  .sg-left { position: sticky; left: 0; z-index: 1; }
  /* 滚动面自成层叠上下文：里面的格子 / 溢出文字 / 列头（z 1~5）只在本面里比高低，不会盖到冻结面上 */
  .sg-top, .sg-body { z-index: 0; }

  .sg-gl { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
  .sg-gl i { position: absolute; display: block; background: var(--md-line); }
  .sg-gl i.v { width: 1px; }
  .sg-gl i.h { height: 1px; }

  .sg-cells, .sg-cells > tbody, .sg-cells tr { display: contents; }
  .sg-cells td { position: absolute; z-index: 1; display: flex; box-sizing: border-box; margin: 0; border: 0;
    padding: calc(1px * var(--z)) calc(4px * var(--z)); overflow: hidden; white-space: pre; line-height: 1.25;
    font-size: calc(13px * var(--z)); color: inherit; }
  .sg-cells td.h-l { justify-content: flex-start; text-align: left; }
  .sg-cells td.h-c { justify-content: center; text-align: center; }
  .sg-cells td.h-r { justify-content: flex-end; text-align: right; }
  .sg-cells td.v-t { align-items: flex-start; }
  .sg-cells td.v-c { align-items: center; }
  .sg-cells td.v-b { align-items: flex-end; }
  .sg-cells td.wr { white-space: pre-wrap; overflow-wrap: anywhere; }
  .sg-cells td.num { font-variant-numeric: tabular-nums; }
  .sg-cells td.ov { z-index: 2; }
  .sg-cells td.hit { box-shadow: inset 0 0 0 100vmax var(--md-mark); }
  .sg-cells td a { color: var(--md-link); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }

  .sg-sel { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
  .sg-sel .rg { position: absolute; background: var(--md-accent-tint); box-shadow: inset 0 0 0 1px var(--md-accent); }
  .sg-sel .ac { position: absolute; box-shadow: inset 0 0 0 2px var(--md-accent); }

  /* 行列头：实底（深色主题的 --md-bg-2 是半透明，叠在纸色上） */
  .sg-ch { position: absolute; left: 0; top: 0; right: 0; z-index: 5; background: var(--sg-head); box-shadow: inset 0 -1px 0 var(--md-line-2); }
  .sg-rh { position: absolute; left: 0; top: 0; bottom: 0; z-index: 5; background: var(--sg-head); box-shadow: inset -1px 0 0 var(--md-line-2); }
  .hd { position: absolute; display: flex; align-items: center; justify-content: center; overflow: hidden; white-space: nowrap;
    font-size: calc(11.5px * var(--z)); color: var(--md-fg-3); font-variant-numeric: tabular-nums; cursor: default; }
  .sg-ch .hd { top: 0; box-shadow: inset -1px 0 0 var(--md-line), inset 0 -1px 0 var(--md-line-2); }
  .sg-rh .hd { left: 0; box-shadow: inset 0 -1px 0 var(--md-line), inset -1px 0 0 var(--md-line-2); }
  .hd.on { background: var(--md-accent-tint); color: var(--md-accent-deep); font-weight: 600; }
  .sg-all { position: absolute; left: 0; top: 0; z-index: 6; background: var(--sg-head);
    box-shadow: inset -1px 0 0 var(--md-line-2), inset 0 -1px 0 var(--md-line-2); }
  .sg-split { position: absolute; z-index: 7; display: block; background: rgba(var(--md-ink), .3); pointer-events: none; }
  .sg-split.v { right: 0; bottom: 0; width: 1px; }
  .sg-split.h { right: 0; bottom: 0; height: 1px; }
  @media (hover: hover) and (pointer: fine) { .sg-ch .hd, .sg-rh .hd, .sg-all { cursor: pointer; } }

  /* —— 状态栏（电脑）—— */
  .sg-status { flex: none; display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 6px 0 8px; min-width: 0;
    background: var(--md-bg); box-shadow: inset 0 1px 0 var(--md-line); }
  .sg-tabs { flex: 0 1 auto; min-width: 0; display: flex; }
  .sg-grow { flex: 1 1 0; min-width: 0; }
  .sg-stats { flex: none; display: flex; gap: 16px; font-size: 12.5px; color: var(--md-fg-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sg-stats b { margin-right: 5px; font-weight: 400; color: var(--md-fg-3); }
  .sg-zoom { flex: none; display: flex; align-items: center; gap: 2px; }
  .sg-pct { min-width: 54px; padding: 0 6px; border-radius: 8px; font-size: 12.5px; font-weight: 500; font-variant-numeric: tabular-nums; }

  /* —— 触屏单独挂载时的标签底栏 —— */
  .sg-tabsbar { flex: none; padding: 5px 8px max(5px, var(--sab, 0px)); background: var(--md-bg); box-shadow: inset 0 .5px 0 rgba(var(--md-ink), .12); }
</style>
