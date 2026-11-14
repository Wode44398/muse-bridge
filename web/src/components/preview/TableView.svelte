<script>
  // CSV / TSV 表格视图（DocViewer 的「表格」态）：首行当表头冻结、行号列冻结、行列双向虚拟滚动、按内容估列宽、
  // 数字列右对齐；点格子选中（Shift 扩选、方向键移动），Ctrl+C 复制成 TSV（贴进表格软件即成格子）；
  // Ctrl+F 筛行（只留含关键字的行，命中格高亮）、Ctrl+G 跳到行。底栏显示当前格位置与完整内容。
  //
  // 接口（给 PDF/Office 线的 SheetGrid 或别处复用时看这里）：
  //   <TableView bind:this={tv} text name delim? maxRows? />
  //   tv.handleKey(e) → true＝处理了；tv.openFind() / tv.openGoto() / tv.copySelection()
  //   text 是整篇原文（已解码的字符串）；delim 不给就按扩展名 + 内容猜（, \t ; |）
  import { t } from '../../lib/i18n.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import { detectDelim, parseDelimited, colWidths, toTsv } from '../../lib/codeview/delimited.js';
  import { useViewer } from './kit/context.js';
  import { copyText } from './kit/actions.js';
  import { tip } from './kit/tooltip.js';
  import VIcon from './kit/VIcon.svelte';
  import { holdFocus } from './paged/FindBar.svelte';
  import { pushBackLayer } from '../../lib/nav.js';

  let { text = '', name = '', delim = '', maxRows = 500000 } = $props();
  const viewer = useViewer();
  const touch = $derived(!pointer.fine);
  const RH = $derived(touch ? 36 : 28);       // 行高
  const HH = $derived(touch ? 38 : 30);       // 表头高

  const ext = $derived((/\.([^.]+)$/.exec(name || '') || [])[1]?.toLowerCase() || '');
  const parsed = $derived.by(() => {
    const d = delim || detectDelim(text, ext);
    return { ...parseDelimited(text, { delim: d, maxRows: maxRows + 1 }), delim: d };
  });
  const head = $derived(parsed.rows[0] || []);
  const body = $derived(parsed.rows.length > 1 ? parsed.rows.slice(1) : []);
  const ncol = $derived(Math.max(1, parsed.cols));
  const widths = $derived.by(() => {
    const w = colWidths(parsed.rows, { ch: touch ? 8.2 : 7.6 });
    while (w.length < ncol) w.push(64);
    return w;
  });
  const xs = $derived.by(() => { const o = [0]; for (const w of widths) o.push(o[o.length - 1] + w); return o; });
  // 数字列：抽样里非空值八成以上是数，右对齐 + 等宽数字
  const numeric = $derived.by(() => {
    const out = [];
    const m = Math.min(body.length, 300);
    for (let c = 0; c < ncol; c++) {
      let n = 0, k = 0;
      for (let r = 0; r < m; r++) {
        const v = (body[r][c] ?? '').trim();
        if (!v) continue;
        n++;
        if (/^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?([eE][-+]?\d+)?%?$/.test(v)) k++;
      }
      out.push(n > 0 && k / n >= 0.8);
    }
    return out;
  });

  // —— 筛行 ——
  let q = $state(''), qd = $state('');      // 输入框 / 防抖后的关键字
  let qT = 0;
  const vis = $derived.by(() => {
    const k = qd.trim().toLowerCase();
    if (!k) return null;
    const hit = [];
    for (let r = 0; r < body.length; r++) {
      const row = body[r];
      for (let c = 0; c < row.length; c++) if (row[c].toLowerCase().includes(k)) { hit.push(r); break; }
    }
    return Int32Array.from(hit);
  });
  const nRows = $derived(vis ? vis.length : body.length);
  const rowAt = (i) => (vis ? vis[i] : i);
  const numW = $derived(Math.max(44, String(body.length).length * (touch ? 8.6 : 7.6) + 22));

  // —— 虚拟滚动 ——
  let sc = $state(null);
  let top = $state(0), left = $state(0), vw = $state(800), vh = $state(600);
  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (sc) { top = sc.scrollTop; left = sc.scrollLeft; } });
  }
  $effect(() => {
    const el = sc;
    if (!el) return;
    const ro = new ResizeObserver(() => { vw = el.clientWidth; vh = el.clientHeight; });
    ro.observe(el);
    vw = el.clientWidth; vh = el.clientHeight;
    if (pointer.fine) el.focus({ preventScroll: true });
    return () => { ro.disconnect(); cancelAnimationFrame(raf); raf = 0; };
  });
  const r0 = $derived(Math.max(0, Math.floor(top / RH) - 6));
  const r1 = $derived(Math.min(nRows, Math.ceil((top + vh) / RH) + 6));
  const c0 = $derived.by(() => {
    const x = left - 40;
    let lo = 0, hi = ncol - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m + 1] <= x) lo = m + 1; else hi = m; }
    return lo;
  });
  const c1 = $derived.by(() => {
    const x = left + vw - numW + 40;
    let c = c0;
    while (c < ncol && xs[c] < x) c++;
    return Math.max(c0 + 1, c);
  });
  const rowIdx = $derived.by(() => { const a = []; for (let i = r0; i < r1; i++) a.push(i); return a; });
  const colIdx = $derived.by(() => { const a = []; for (let c = c0; c < c1; c++) a.push(c); return a; });

  // —— 选区（显示行号 i，非原始行号）——
  let sel = $state(null);   // { ar, ac, r, c }：锚点 + 当前
  const box = $derived(sel ? { r0: Math.min(sel.ar, sel.r), r1: Math.max(sel.ar, sel.r), c0: Math.min(sel.ac, sel.c), c1: Math.max(sel.ac, sel.c) } : null);
  const inBox = (i, c) => box && i >= box.r0 && i <= box.r1 && c >= box.c0 && c <= box.c1;
  const curVal = $derived(sel ? (sel.r < 0 ? head[sel.c] : body[rowAt(sel.r)]?.[sel.c]) ?? '' : '');
  const colName = (c) => { let s = '', n = c + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };

  function pick(i, c, e) {
    if (e?.shiftKey && sel) sel = { ...sel, r: i, c };
    else sel = { ar: i, ac: c, r: i, c };
    if (pointer.fine) sc?.focus({ preventScroll: true });
  }
  function ensureVisible(i, c) {
    if (!sc) return;
    const y = i * RH, bodyH = sc.clientHeight - HH;
    if (y < sc.scrollTop) sc.scrollTop = y;
    else if (y + RH > sc.scrollTop + bodyH) sc.scrollTop = y + RH - bodyH;
    const x0 = xs[c], x1 = xs[c + 1], w = sc.clientWidth - numW;
    if (x0 < sc.scrollLeft) sc.scrollLeft = x0;
    else if (x1 > sc.scrollLeft + w) sc.scrollLeft = Math.min(x0, x1 - w);
  }
  function move(dr, dc, extend) {
    if (!nRows) return;
    const cur = sel || { ar: 0, ac: 0, r: 0, c: 0 };
    const r = Math.max(0, Math.min(nRows - 1, cur.r + dr)), c = Math.max(0, Math.min(ncol - 1, cur.c + dc));
    sel = extend && sel ? { ...sel, r, c } : { ar: r, ac: c, r, c };
    ensureVisible(r, c);
  }
  export function copySelection() {
    if (!box) return false;
    const src = box.r0 < 0 ? null : body;
    let txt;
    if (!src) txt = curVal;
    else {
      const rows = [];
      for (let i = box.r0; i <= box.r1; i++) rows.push(body[rowAt(i)] || []);
      txt = toTsv(rows, 0, box.c0, rows.length - 1, box.c1);
    }
    copyText(txt).then((ok) => viewer.toast(ok === false ? t('复制失败') : t('已复制'), { ms: 1200 }));
    return true;
  }

  // —— 查找条 / 跳到行 ——
  let bar = $state(null), gl = $state('');
  let qEl = $state(null), glEl = $state(null);
  function onQ() { clearTimeout(qT); qT = setTimeout(() => { qd = q; sel = null; if (sc) sc.scrollTop = 0; }, body.length > 50000 ? 220 : 60); }
  export function openFind() { bar = 'find'; requestAnimationFrame(() => { holdFocus(qEl); qEl?.select(); }); }
  export function openGoto() { gl = ''; bar = 'goto'; requestAnimationFrame(() => holdFocus(glEl)); }
  function closeBar() {
    bar = null;
    if (q || qd) { q = ''; qd = ''; sel = null; }
    if (pointer.fine) sc?.focus({ preventScroll: true });
  }
  // 筛选 / 跳到行条开着时挂一层系统返回：安卓侧滑 / 返回键先收条，不直接关掉查看器
  $effect(() => { if (bar) return pushBackLayer(closeBar); });
  function goRow() {
    const n = parseInt(gl, 10);
    if (!(n >= 1)) { viewer.toast(t('请输入行号')); return; }
    // 行号按原始数据行（表头不算），筛选中就找最近的那一行
    let i = n - 1;
    if (vis) { let lo = 0, hi = vis.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (vis[m] < i) lo = m + 1; else hi = m; } i = lo; }
    i = Math.max(0, Math.min(nRows - 1, i));
    bar = null;
    sel = { ar: i, ac: 0, r: i, c: 0 };
    if (sc) sc.scrollTop = Math.max(0, i * RH - (sc.clientHeight - HH) / 2);
    if (pointer.fine) sc?.focus({ preventScroll: true });
  }
  function onBarKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBar(); return; }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (bar === 'goto') goRow(); else { clearTimeout(qT); qd = q; sc?.focus({ preventScroll: true }); }
    }
  }

  // 选中格子时 Tab / Shift+Tab 左右移格（表格软件的习惯）；没选中格子时照常让焦点离开表格
  function onScKey(e) {
    if (e.key !== 'Tab' || !sel || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    e.preventDefault();   // 带着 defaultPrevented 冒上去，外框不再当焦点切换
    move(0, e.shiftKey ? -1 : 1, false);
  }

  /** 宿主把查看器的 keydown 交过来：true＝处理了 */
  export function handleKey(e) {
    if (e.isComposing) return false;
    const mod = e.ctrlKey || e.metaKey, k = e.code;
    if (mod && !e.altKey && !e.shiftKey && k === 'KeyF') { openFind(); return true; }
    if (mod && !e.altKey && !e.shiftKey && k === 'KeyG') { openGoto(); return true; }
    if (e.key === 'Escape' && bar) { closeBar(); return true; }
    const inTable = sc && document.activeElement === sc;
    if (!inTable) return false;
    if (mod && !e.altKey && k === 'KeyC' && box && !String(window.getSelection?.() || '')) return copySelection();
    if (mod && !e.altKey && k === 'KeyA') { if (nRows) { sel = { ar: 0, ac: 0, r: nRows - 1, c: ncol - 1 }; } return true; }
    const D = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (D && !e.altKey) {
      if (mod) move(D[0] * 1e9, D[1] * 1e9, e.shiftKey);
      else move(D[0], D[1], e.shiftKey);
      return true;
    }
    // Tab 在这里够不着：外框 onKey 先把 Tab 交给焦点圈（trapTab）。格子里的 Tab 由 .tv-sc 自己的 onkeydown 抢先处理（onScKey）
    if (e.key === 'Enter' && sel) { move(e.shiftKey ? -1 : 1, 0, false); return true; }
    return false;
  }
</script>

<div class="tv" class:tv-touch={touch} style:--rh={RH + 'px'} style:--hh={HH + 'px'} style:--nw={numW + 'px'}>
  {#if bar}
    <div class="tv-bar" role="search">
      <label class="tv-field">
        <VIcon name={bar === 'find' ? 'search' : 'gotoLine'} size={16} />
        {#if bar === 'find'}
          <input bind:this={qEl} class="tv-q" type="text" placeholder={t('筛选行')} aria-label={t('筛选行')} enterkeyhint="search" spellcheck="false" autocapitalize="off" autocomplete="off"
            bind:value={q} oninput={onQ} onkeydown={onBarKey} />
          {#if qd}<span class="tv-count" aria-live="polite">{t('{n} 行', { n: nRows.toLocaleString() })}</span>{/if}
        {:else}
          <input bind:this={glEl} class="tv-q" type="text" inputmode="numeric" enterkeyhint="go" autocomplete="off" aria-label={t('跳转')}
            placeholder={t('跳到行（1–{n}）', { n: body.length.toLocaleString() })} bind:value={gl} onkeydown={onBarKey} />
        {/if}
      </label>
      {#if bar === 'goto'}<button class="tv-btn tv-go" onclick={goRow}>{t('跳转')}</button>{/if}
      <button class="tv-btn" use:tip={{ label: t('关闭'), kbd: 'Esc' }} onclick={closeBar}><VIcon name="close" /></button>
    </div>
  {/if}

  <div class="tv-sc" bind:this={sc} onscroll={onScroll} onkeydown={onScKey} tabindex="0" role="grid" aria-label={name} aria-rowcount={nRows + 1} aria-colcount={ncol} data-pv-table data-hscroll>
    <div class="tv-sizer" style:width={numW + xs[ncol] + 'px'} style:height={HH + nRows * RH + 'px'}>
      <div class="tv-head" role="row">
        <div class="tv-corner"></div>
        {#if c0 > 0}<div class="tv-pad" style:width={xs[c0] + 'px'}></div>{/if}
        {#each colIdx as c (c)}
          <div class="tv-hc" class:num={numeric[c]} class:sel={box && c >= box.c0 && c <= box.c1} role="columnheader" style:width={widths[c] + 'px'}
            title={head[c] || colName(c)}>{head[c] ?? ''}</div>
        {/each}
      </div>
      <div class="tv-rows">
        {#each rowIdx as i (i)}
          {@const row = body[rowAt(i)] || []}
          <div class="tv-row" role="row" style:transform="translateY({i * RH}px)">
            <div class="tv-rn" class:sel={box && i >= box.r0 && i <= box.r1}>{(rowAt(i) + 1).toLocaleString()}</div>
            {#if c0 > 0}<div class="tv-pad" style:width={xs[c0] + 'px'}></div>{/if}
            {#each colIdx as c (c)}
              {@const v = row[c] ?? ''}
              <div class="tv-c" class:num={numeric[c]} class:in={inBox(i, c)} class:cur={sel && sel.r === i && sel.c === c}
                class:hit={qd && v && v.toLowerCase().includes(qd.trim().toLowerCase())}
                role="gridcell" style:width={widths[c] + 'px'} onpointerdown={(e) => { if (e.button === 0) pick(i, c, e); }}>{v}</div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
    {#if !nRows}
      <div class="tv-empty">{qd ? t('没有匹配的行') : t('没有数据行')}</div>
    {/if}
  </div>

  <div class="tv-foot">
    {#if sel}
      <span class="tv-ref">{colName(sel.c)}{rowAt(sel.r) + 1}</span>
      <span class="tv-val" title={curVal}>{curVal}</span>
      <button class="tv-btn tv-copy" use:tip={{ label: t('复制'), kbd: 'Ctrl+C' }} onclick={copySelection}><VIcon name="copy" /></button>
    {:else}
      <span class="tv-val tv-hint">{touch ? t('点格子查看完整内容') : t('点格子查看完整内容，Shift 扩选，Ctrl+C 复制')}</span>
    {/if}
    <span class="tv-dim">{t('{r} 行 × {c} 列', { r: body.length.toLocaleString(), c: ncol.toLocaleString() })}{parsed.truncated ? ' · ' + t('仅显示前 {n} 行', { n: maxRows.toLocaleString() }) : ''}</span>
  </div>
</div>

<style>
  .tv { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--md-bg); color: var(--md-fg); font-size: 13px; }
  .tv-touch { font-size: 14px; }
  .tv-sc { flex: 1; min-height: 0; overflow: auto; position: relative; outline: none; overscroll-behavior: contain; }
  .tv-sizer { position: relative; min-width: 100%; }
  .tv-head { position: sticky; top: 0; z-index: 2; display: flex; height: var(--hh); width: 100%;
    background: linear-gradient(var(--md-bg-2), var(--md-bg-2)), var(--md-bg); box-shadow: inset 0 -.5px 0 rgba(var(--md-ink), .22); }   /* 暗色的 --md-bg-2 是半透明：垫一层纸面色，冻结表头才盖得住底下滚过的行 */
  .tv-corner { position: sticky; left: 0; z-index: 3; flex: none; width: var(--nw); background: inherit; box-shadow: inset -.5px 0 0 rgba(var(--md-ink), .16); }
  .tv-pad { flex: none; }
  .tv-hc { flex: none; display: flex; align-items: center; padding: 0 10px; box-sizing: border-box; font-weight: 600; color: var(--md-fg);
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis; box-shadow: inset -.5px 0 0 rgba(var(--md-ink), .1); }
  .tv-hc.num { justify-content: flex-end; }
  .tv-hc.sel { background: rgba(var(--md-ink), .05); }
  .tv-rows { position: relative; }
  .tv-row { position: absolute; top: 0; left: 0; display: flex; height: var(--rh); min-width: 100%; will-change: transform; }
  .tv-rn { position: sticky; left: 0; z-index: 1; flex: none; width: var(--nw); box-sizing: border-box; padding: 0 10px; text-align: right;
    line-height: var(--rh); color: var(--md-fg-3); font-size: .85em; font-variant-numeric: tabular-nums; background: var(--md-bg);
    box-shadow: inset -.5px 0 0 rgba(var(--md-ink), .16), inset 0 -.5px 0 rgba(var(--md-ink), .07); }
  .tv-rn.sel { color: var(--md-fg-2); background: linear-gradient(rgba(var(--md-ink), .04), rgba(var(--md-ink), .04)), var(--md-bg); }   /* 行号列横向冻结：底色不能透 */
  .tv-c { flex: none; box-sizing: border-box; padding: 0 10px; line-height: var(--rh); overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    box-shadow: inset -.5px 0 0 rgba(var(--md-ink), .07), inset 0 -.5px 0 rgba(var(--md-ink), .07); cursor: cell; user-select: none; -webkit-user-select: none; }
  .tv-c.num { text-align: right; font-variant-numeric: tabular-nums; }
  .tv-c.hit { background: var(--md-mark); }
  .tv-c.in { background: var(--md-accent-tint); }
  .tv-c.cur { box-shadow: inset 0 0 0 1.5px var(--md-accent); }
  .tv-empty { position: absolute; left: 0; right: 0; top: calc(var(--hh) + 24px); text-align: center; color: var(--md-fg-3); font-size: 13px; }

  .tv-foot { flex: none; display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 0 6px 0 12px; font-size: 12px; color: var(--md-fg-3);
    box-shadow: inset 0 .5px 0 rgba(var(--md-ink), .14); }
  .tv-ref { flex: none; font-weight: 600; color: var(--md-fg-2); font-variant-numeric: tabular-nums; }
  .tv-val { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--md-fg); user-select: text; }
  .tv-hint { color: var(--md-fg-4); }
  .tv-dim { flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }

  .tv-bar { flex: none; display: flex; align-items: center; gap: 2px; padding: 6px 8px 6px 10px; box-shadow: inset 0 -.5px 0 rgba(var(--md-ink), .14);
    animation: tvbar var(--mo-quick, 200ms) var(--ea-decel, ease-out) both; }
  @keyframes tvbar { from { opacity: 0; transform: translateY(-4px); } }
  @media (prefers-reduced-motion: reduce) { .tv-bar { animation: none; } }
  .tv-field { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px; margin-right: 4px;
    border-radius: 8px; background: rgba(var(--md-ink), .055); color: var(--md-fg-3); }
  .tv-field:focus-within { background: var(--md-field); box-shadow: 0 0 0 1px rgba(var(--md-ink), .22); }   /* 与 paged/FindBar 同一聚焦样式 */
  .tv-q { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: none; color: var(--md-fg); font: inherit; font-size: 13px; }
  .tv-q::placeholder { color: var(--md-fg-4); }
  .tv-count { flex: none; font-size: 12px; color: var(--md-fg-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tv-btn { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; color: var(--md-fg-2); --vw-ic: 18px;
    transition: background var(--mo-tap, 90ms); }
  .tv-btn:hover { background: rgba(var(--md-ink), .06); color: var(--md-fg); }
  .tv-btn:active { background: rgba(var(--md-ink), .1); }
  .tv-go { width: auto; padding: 0 12px; font-size: 13px; font-weight: 600; color: var(--md-fg); }
  .tv-copy { width: 28px; height: 28px; --vw-ic: 16px; }
  .tv-touch .tv-bar { padding: 4px 4px 4px 10px; gap: 0; }
  .tv-touch .tv-field { height: 44px; border-radius: 10px; }
  .tv-touch .tv-q { font-size: 16px; }
  .tv-touch .tv-btn { width: 44px; height: 44px; border-radius: 12px; --vw-ic: 20px; }
  .tv-touch .tv-go { width: auto; padding: 0 14px; font-size: 15px; }
  /* 触屏底栏贴着屏幕下沿：让出系统手势条（--sab），字不压在横条上 */
  .tv-touch .tv-foot { min-height: 44px; font-size: 13px; padding-right: 0; padding-bottom: var(--sab, 0px); }
  .tv-touch .tv-copy { width: 44px; height: 44px; }
</style>
