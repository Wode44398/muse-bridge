<script>
  // Word 客户端回落（没装 LibreOffice / 转换失败时）：mammoth 转出的 HTML 排在一张「纸」上。
  //   电脑：台面上一张 A4（96dpi 下 794 宽、页边距上下 96 左右 120，Word 中文默认版心），可缩放（CSS zoom，
  //         文字始终清晰），默认适应窗口宽度；左侧「导航」= 标题树（PdfSidebar only='outline'），当前章节跟着滚动高亮。
  //   触屏：纸铺满全宽、边距 20，捏合改字号（按宽度重排，不横向溢出）；导航在 Sheet 里。
  //   查找：FindBar + CSS 自定义高亮（::highlight），不改 DOM、不打断选区；不支持的内核退化成选中当前命中。
  // props
  //   html：已经过 DOMPurify 的正文 HTML
  //   note：纸下方的一行说明（「快速预览」之类，空 = 不显示）· info：追加到文件信息面板的行
  //   menuExtra() → 菜单项数组：放在 ⋮ 最前面（OfficeView 的「打印版式」切换）
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { pointer } from '../../../lib/layout.svelte.js';
  import { t, tc } from '../../../lib/i18n.js';
  import { useViewer, isEditable } from '../kit/context.js';
  import VIcon from '../kit/VIcon.svelte';
  import { tip } from '../kit/tooltip.js';
  import FindBar from '../paged/FindBar.svelte';
  import PdfSidebar from '../pdf/PdfSidebar.svelte';
  import { attachGestures } from '../pdf/gestures.js';

  let { html = '', note = '', info = [], menuExtra = null } = $props();

  const viewer = useViewer();
  const touch = $derived(viewer.inShell ? viewer.touch : !pointer.fine);
  const fine = $derived(!touch);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pref = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

  const PAPER_W = 794;               // A4 宽 @96dpi
  const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const zmin = $derived(touch ? 0.8 : 0.5);
  const zmax = $derived(touch ? 2 : 3);

  let rootEl = $state(null), scroller = $state(null), paper = $state(null), docEl = $state(null);
  let mainW = $state(0), rootW = $state(0);
  let zoom = $state(1);
  // 电脑缩放模式（同 PDF.js）：auto = 放得下按 100%、窗口窄了缩到刚好放下；width = 纸宽贴满窗口；custom = 手动
  let mode = $state('auto');
  const fitW = $derived(mainW ? (mainW - 64) / PAPER_W : 1);
  const modeZoom = (m) => (m === 'width' ? clamp(fitW, 0.5, 3) : clamp(fitW, 0.5, 1));
  $effect(() => {
    const z = { auto: clamp(fitW, 0.5, 1), width: clamp(fitW, 0.5, 3) }[mode];
    if (fine && z) untrack(() => { zoom = z; });
  });
  const pct = $derived(Math.round(zoom * 100));

  // —— 导航（标题树）——
  const SIDE_KEY = 'bridge.word.side';   // 与 PdfView 的 Word 模式共用
  let sideOpen = $state(false);
  let sideTab = $state('outline');
  const sideOverlay = $derived(fine && rootW > 0 && rootW < 760);
  let outline = $state.raw([]);
  let heads = [];
  let activeId = $state(-1);
  let words = $state(0);
  function toggleSide() {
    sideOpen = !sideOpen;
    if (fine && !sideOverlay) setPref(SIDE_KEY, sideOpen ? '1' : '0');
  }

  function scan() {
    if (!docEl) return;
    heads = [...docEl.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((h) => h.textContent.trim());
    const lv = heads.map((h) => +h.tagName[1]);
    const top = lv.length ? Math.min(...lv) : 1;
    const items = [];
    const stack = [];                // [{ id, lv }]
    heads.forEach((h, i) => {
      while (stack.length && stack[stack.length - 1].lv >= lv[i]) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].id : -1;
      if (parent >= 0) items[parent].kids = true;
      items.push({ id: i, title: h.textContent.replace(/\s+/g, ' ').trim(), depth: Math.min(stack.length, lv[i] - top), parent, kids: false, page: 0 });
      stack.push({ id: i, lv: lv[i] });
    });
    outline = items;
    // 字数：汉字 / 假名 / 韩文按字算，其余按词（与 Word「字数」口径接近）
    const text = docEl.textContent || '';
    const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯豈-﫿]/g) || []).length;
    const latin = (text.replace(/[぀-ヿ㐀-鿿가-힯豈-﫿]/g, ' ').match(/[A-Za-z0-9À-ɏ]+(?:['’-][A-Za-z0-9À-ɏ]+)*/g) || []).length;
    words = cjk + latin;
    onScroll();
  }

  function headTop(el) {
    const sr = scroller.getBoundingClientRect();
    return el.getBoundingClientRect().top - sr.top + scroller.scrollTop;
  }
  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!scroller || !heads.length) { activeId = -1; return; }
      const line = scroller.getBoundingClientRect().top + Math.min(120, scroller.clientHeight / 3);
      let a = -1;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i].getBoundingClientRect().top <= line) a = i; else break;
      }
      activeId = a;
    });
  }
  function goHead(it) {
    const el = heads[it.id];
    if (!el || !scroller) return;
    scroller.scrollTo({ top: Math.max(0, headTop(el) - 16), behavior: reduced() ? 'auto' : 'smooth' });
  }

  // —— 缩放 ——
  // 电脑：纸宽按比例变，锚点按纸上的相对位置放回原处（精确）；触屏：宽度不变只重排，锚在锚点下那一段的同一高度比例上。
  async function zoomTo(z, anchor = null, m = 'custom') {
    z = clamp(z, zmin, zmax);
    if (Math.abs(z - zoom) < 0.002 || !scroller || !paper) { zoom = z; mode = m; return; }
    const sr = scroller.getBoundingClientRect();
    const cx = anchor ? anchor.cx : sr.left + sr.width / 2, cy = anchor ? anchor.cy : sr.top + Math.min(sr.height / 2, 160);
    const tx = anchor?.tx ?? cx, ty = anchor?.ty ?? cy;
    let restore;
    if (touch) {
      const block = blockAt(cx, cy);
      if (block) {
        const r = block.getBoundingClientRect();
        const f = r.height ? (cy - r.top) / r.height : 0;
        restore = () => { const r2 = block.getBoundingClientRect(); scroller.scrollTop += r2.top + f * r2.height - ty; };
      }
    } else {
      const r = paper.getBoundingClientRect();
      const fx = r.width ? (cx - r.left) / r.width : 0.5, fy = r.height ? (cy - r.top) / r.height : 0;
      restore = () => {
        const r2 = paper.getBoundingClientRect();
        scroller.scrollLeft += r2.left + fx * r2.width - tx;
        scroller.scrollTop += r2.top + fy * r2.height - ty;
      };
    }
    zoom = z; mode = m;
    await tick();
    restore?.();
    onScroll();
  }
  function blockAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.parentElement && el.parentElement !== docEl) el = el.parentElement;
    return el && el.parentElement === docEl ? el : null;
  }
  function stepZoom(dir) {
    const cur = zoom;
    const z = dir > 0 ? ZOOMS.find((v) => v > cur + 0.005) : [...ZOOMS].reverse().find((v) => v < cur - 0.005);
    zoomTo(z ?? (dir > 0 ? zmax : zmin));
  }
  const zoomIn = () => stepZoom(1);
  const zoomOut = () => stepZoom(-1);
  const setMode = (m) => zoomTo(modeZoom(m), null, m);
  const resetZoom = () => (fine ? setMode('auto') : zoomTo(1));
  function zoomItems() {
    const list = touch ? [0.8, 0.9, 1, 1.25, 1.5, 1.75, 2] : [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    return [
      ...(fine ? [
        { label: t('自动缩放'), checked: mode === 'auto', onSelect: () => setMode('auto') },
        { label: t('适应宽度'), checked: mode === 'width', onSelect: () => setMode('width') },
        { sep: true },
      ] : []),
      ...list.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: (touch || mode === 'custom') && Math.abs(zoom - z) < 0.005, onSelect: () => zoomTo(z) })),
    ];
  }
  function openZoomMenu(e) { viewer.openMenu({ anchor: e.currentTarget, items: zoomItems, title: t('缩放'), place: 'top' }); }

  // —— 查找 ——
  const HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';
  let fOpen = $state(false), fQuery = $state(''), fCur = $state(0), fTotal = $state(0), fCase = $state(false);
  let findBar = $state(null);
  let hits = [];
  const MAX_HITS = 5000;
  function clearHl() {
    if (HL) { CSS.highlights.delete('wd-hit'); CSS.highlights.delete('wd-cur'); }
  }
  function search(q) {
    clearHl();
    hits = []; fCur = 0; fTotal = 0;
    if (!q || !docEl) return;
    const needle = fCase ? q : q.toLowerCase();
    const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && hits.length < MAX_HITS; n = walker.nextNode()) {
      const raw = n.data;
      // 不区分大小写：整段转小写再找；大小写折叠改了长度的极少数字符（İ 之类）就按原文、原样的查询词找，免得区间错位
      // （旧写法拿 s === raw 判断，整段本来就是小写时会误用原样的查询词，「Hello」找不到「hello」）
      const low = fCase ? raw : raw.toLowerCase();
      const fold = !fCase && low.length === raw.length;
      const s = fold ? low : raw;
      const nd = fCase || fold ? needle : q;
      for (let i = s.indexOf(nd); i >= 0 && hits.length < MAX_HITS; i = s.indexOf(nd, i + nd.length)) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + nd.length);
        hits.push(r);
      }
    }
    fTotal = hits.length;
    if (!hits.length) return;
    // 从当前看到的位置往后找第一个
    const top = scroller.getBoundingClientRect().top;
    const k = hits.findIndex((r) => r.getBoundingClientRect().bottom >= top);
    fCur = (k < 0 ? 0 : k) + 1;
    paint(); reveal();
  }
  function paint() {
    const cur = hits[fCur - 1];
    if (HL) {
      const all = new Highlight(...hits);
      CSS.highlights.set('wd-hit', all);
      if (cur) { const one = new Highlight(cur); one.priority = 1; CSS.highlights.set('wd-cur', one); }
    } else if (cur) {
      try { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(cur); } catch {}
    }
  }
  function reveal() {
    const cur = hits[fCur - 1];
    if (!cur || !scroller) return;
    const r = cur.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    const topGap = fine ? 64 : 16;   // 电脑查找卡浮在右上角，命中别藏在它下面
    if (r.top < sr.top + topGap || r.bottom > sr.bottom - 40) scroller.scrollTop += r.top - sr.top - Math.round(sr.height / 3);
    if (r.left < sr.left + 8 || r.right > sr.right - 8) scroller.scrollLeft += r.left - sr.left - Math.round(sr.width / 2);
  }
  function onStep(dir) {
    if (!hits.length) return;
    fCur = ((fCur - 1 + dir + hits.length) % hits.length) + 1;
    paint(); reveal();
  }
  function onCase(on) { fCase = on; search(fQuery); }
  function openFind() {
    if (fOpen) { findBar?.focus(); return; }
    fOpen = true;
  }
  function closeFind() {
    // 焦点还在查找条里就交回滚动区（查找条一卸载焦点会掉到 body，Tab 从头走、键盘滚动也断了）
    const a = document.activeElement;
    if (fOpen && scroller && (!a || a === document.body || a.closest?.('.fb'))) try { scroller.focus({ preventScroll: true }); } catch {}
    fOpen = false; fQuery = ''; hits = []; fCur = 0; fTotal = 0; clearHl();
  }

  // —— 外框声明 ——
  $effect(() => {
    const tch = touch;
    return untrack(() => viewer.declare({
      tools: () => [
        { id: 'side', icon: 'sidebar', label: t('导航'), onClick: toggleSide, active: sideOpen },
        { id: 'find', icon: 'search', label: t('查找'), kbd: 'Ctrl+F', onClick: openFind, active: fOpen },
      ],
      menu: () => {
        const extra = menuExtra?.() || [];
        return [...(extra.length ? [...extra, { sep: true }] : []), { label: t('缩放'), icon: 'fit', detail: `${pct}%`, submenu: { title: t('缩放'), items: zoomItems } }];
      },
      info: () => [...(words ? [{ label: t('字数'), value: words.toLocaleString() }] : []), ...info],
      keys: onKeys,
      float: tch ? undefined : floatBar,
    }));
  });

  function onKeys(e) {
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && (k === 'f' || k === 'F')) { openFind(); return true; }
    if (k === 'F3' || (mod && (k === 'g' || k === 'G'))) { if (fOpen && fQuery) onStep(e.shiftKey ? -1 : 1); else openFind(); return true; }
    if (k === 'Escape') {
      if (fOpen) { closeFind(); return true; }
      if (sideOpen && sideOverlay) { sideOpen = false; return true; }
      return false;
    }
    if (mod && !e.altKey && (k === '=' || k === '+')) { zoomIn(); return true; }
    if (mod && !e.altKey && (k === '-' || k === '_')) { zoomOut(); return true; }
    if (mod && !e.altKey && k === '0') { resetZoom(); return true; }
    if (isEditable(e.target) || mod || e.altKey || !scroller) return false;
    if (e.target?.closest?.('[role="tree"]')) return false;
    const onButton = !!e.target?.closest?.('button, a');
    const page = Math.max(40, scroller.clientHeight - 48);
    switch (k) {
      case 'ArrowDown': scroller.scrollBy({ top: 48 }); return true;
      case 'ArrowUp': scroller.scrollBy({ top: -48 }); return true;
      case 'PageDown': scroller.scrollBy({ top: page }); return true;
      case 'PageUp': scroller.scrollBy({ top: -page }); return true;
      case ' ': if (onButton) return false; scroller.scrollBy({ top: e.shiftKey ? -page : page }); return true;
      case 'Home': scroller.scrollTo({ top: 0 }); return true;
      case 'End': scroller.scrollTo({ top: scroller.scrollHeight }); return true;
      case 'ArrowRight': case 'ArrowLeft':
        // 横向放大溢出时左右滚；放得下就交给外框翻到上 / 下一个文件
        if (scroller.scrollWidth > scroller.clientWidth + 1) { scroller.scrollBy({ left: (k === 'ArrowRight' ? 1 : -1) * 48 }); return true; }
        return false;
    }
    return false;
  }

  // 文内链接：书签 / 脚注（#id）在纸内滚过去；外链新标签页打开（mammoth 不带 target）
  function onDocClick(e) {
    const a = e.target?.closest?.('a[href]');
    if (!a || !docEl?.contains(a)) return;
    const href = a.getAttribute('href') || '';
    e.preventDefault();
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      const el = id && [...docEl.querySelectorAll('[id], a[name]')].find((x) => x.id === id || x.getAttribute('name') === id);
      if (el) scroller.scrollTo({ top: Math.max(0, headTop(el) - 16), behavior: reduced() ? 'auto' : 'smooth' });
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
  }

  // 正文换了就重扫标题、清掉旧命中
  $effect(() => {
    void html;
    const el = docEl;
    if (!el) return;
    untrack(async () => {
      await tick();
      scan();
      if (fOpen && fQuery) search(fQuery);
    });
  });

  let detach = null, ro = null;
  onMount(() => {
    rootW = rootEl?.clientWidth || 0;
    mainW = scroller?.clientWidth || 0;
    if (fine) zoom = modeZoom(mode);
    ro = new ResizeObserver(() => { rootW = rootEl?.clientWidth || 0; mainW = scroller?.clientWidth || 0; });
    ro.observe(rootEl); ro.observe(scroller);
    detach = attachGestures(scroller, {
      pinchTarget: () => paper,
      clampFactor: (f) => clamp(zoom * f, zmin, zmax) / zoom,
      onPinchEnd: ({ factor, x0, y0, cx, cy }) => { if (Math.abs(factor - 1) >= 0.02) zoomTo(zoom * factor, { cx: x0, cy: y0, tx: cx, ty: cy }); },
      onWheelZoom: ({ factor, cx, cy }) => zoomTo(zoom * factor, { cx, cy }),
    });
    // 侧栏：有标题时按偏好 / 宽窗默认打开（与 PdfView 的 Word 模式同一口径）
    tick().then(() => {
      if (!fine) return;
      const p = pref(SIDE_KEY);
      sideOpen = p ? p === '1' : rootW >= 1000 && outline.length > 0;
    });
  });
  onDestroy(() => {
    detach?.(); ro?.disconnect();
    if (raf) cancelAnimationFrame(raf);
    clearHl();
  });
</script>

{#snippet floatBar()}
  <button type="button" class="vw-btn" disabled={zoom <= zmin + 1e-3} onclick={zoomOut} use:tip={{ label: tc('files', '缩小'), kbd: 'Ctrl+-' }}><VIcon name="zoomOut" /></button>
  <button type="button" class="vw-btn vw-txt wd-pct" onclick={openZoomMenu} use:tip={{ label: t('缩放'), kbd: 'Ctrl+0' }}>{pct}%</button>
  <button type="button" class="vw-btn" disabled={zoom >= zmax - 1e-3} onclick={zoomIn} use:tip={{ label: tc('files', '放大'), kbd: 'Ctrl+=' }}><VIcon name="zoomIn" /></button>
{/snippet}

<div class="wd" class:touch class:fine bind:this={rootEl} data-zoom={zoom.toFixed(3)} data-heads={outline.length} data-active={activeId} data-hits={fTotal}>
  {#if touch}
    <FindBar bind:this={findBar} open={fOpen} bind:query={fQuery} current={fCur} total={fTotal} caseSensitive={fCase} touch
      onquery={search} onstep={onStep} oncase={onCase} onclose={closeFind} />
  {/if}
  <div class="wd-body">
    <PdfSidebar open={sideOpen} {touch} overlay={sideOverlay} title={t('导航')} bind:tab={sideTab} only="outline"
      {outline} {activeId} ongo={goHead} onclose={() => (sideOpen = false)} />
    <div class="wd-main">
      {#if !touch}
        <FindBar bind:this={findBar} open={fOpen} bind:query={fQuery} current={fCur} total={fTotal} caseSensitive={fCase}
          onquery={search} onstep={onStep} oncase={onCase} onclose={closeFind} />
      {/if}
      <div class="wd-scroll" bind:this={scroller} onscroll={onScroll} tabindex="-1">
        <div class="wd-paper" bind:this={paper} style:zoom={zoom} style:--z={zoom}>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="wd-doc sel-text" bind:this={docEl} onclick={onDocClick}>{@html html}</div>
        </div>
        {#if note}<p class="wd-note">{note}</p>{/if}
      </div>
    </div>
  </div>
</div>

<style>
  /* 纸面：亮色是近白纸（与 PDF 白页同一观感）、暗色是暖墨纸；台面是 --md-stage。正文没有原文件配色可保（mammoth 只出结构），整页跟主题走 */
  .wd { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--md-stage); color: var(--md-fg); --wd-paper: var(--md-panel); }
  :global(html:not([data-theme="light"])) .wd { --wd-paper: var(--md-bg); }
  .wd-body { position: relative; flex: 1; min-height: 0; display: flex; }
  .wd-main { position: relative; flex: 1; min-width: 0; }
  .wd-scroll { position: absolute; inset: 0; overflow: auto; overscroll-behavior: contain; touch-action: pan-x pan-y; outline: none;
    padding: 24px 32px 80px; box-sizing: border-box; }
  .wd.fine .wd-scroll { scrollbar-gutter: stable; }
  .wd-paper { box-sizing: border-box; width: 794px; min-height: 1123px; margin: 0 auto; padding: 96px 120px; background: var(--wd-paper);
    box-shadow: var(--md-shadow-thumb); }
  :global(html:not([data-theme="light"])) .wd-paper { box-shadow: 0 2px 14px rgba(0, 0, 0, .45), 0 0 0 .5px rgba(255, 255, 255, .06); }
  /* 触屏：没有台面，纸就是整屏；zoom 只放大字（百分比宽度不随 zoom 变），边距按倍数折回去保持 20 */
  .wd.touch { background: var(--wd-paper); }
  .wd.touch .wd-scroll { padding: 0 0 calc(24px + var(--sab, 0px)); }
  .wd.touch .wd-paper { width: 100%; min-height: 0; padding: calc(20px / var(--z)) calc(20px / var(--z)) calc(28px / var(--z)); box-shadow: none; background: none; }
  .wd-note { margin: 14px auto 0; max-width: 794px; font-size: 12px; line-height: 1.5; color: var(--md-fg-3); text-align: center; }
  .wd.touch .wd-note { margin: 0; padding: 0 20px; }

  /* 正文（mammoth HTML）：Word 默认的五号 / 小四观感，行距 1.6 */
  .wd-doc { font-size: 15px; line-height: 1.65; overflow-wrap: anywhere; }
  .wd.touch .wd-doc { font-size: 16px; }
  .wd-doc > :global(:first-child) { margin-top: 0; }
  .wd-doc :global(h1) { font-size: 1.6em; font-weight: 700; line-height: 1.3; margin: 1em 0 .5em; }
  .wd-doc :global(h2) { font-size: 1.32em; font-weight: 700; line-height: 1.35; margin: .9em 0 .45em; }
  .wd-doc :global(h3) { font-size: 1.14em; font-weight: 650; margin: .8em 0 .4em; }
  .wd-doc :global(:is(h4, h5, h6)) { font-size: 1em; font-weight: 650; margin: .7em 0 .35em; }
  .wd-doc :global(p) { margin: .45em 0; }
  .wd-doc :global(a) { color: var(--md-link); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; cursor: pointer; }
  .wd-doc :global(:is(ul, ol)) { margin: .45em 0; padding-left: 1.7em; }
  .wd-doc :global(li) { margin: .15em 0; }
  .wd-doc :global(img) { max-width: 100%; height: auto; vertical-align: middle; }
  /* 透明底的图（图表、线稿）是按白纸画的：暗纸上垫一块浅底板 */
  :global(html:not([data-theme="light"])) .wd-doc :global(img) { background: #f4f3ee; }
  .wd-doc :global(table) { border-collapse: collapse; margin: .8em 0; width: 100%; }
  .wd-doc :global(:is(td, th)) { border: 1px solid var(--md-line-2); padding: 5px 9px; font-size: .94em; vertical-align: top; }
  .wd-doc :global(th) { background: var(--md-bg-2); font-weight: 600; text-align: left; }
  .wd-doc :global(:is(td, th) > p) { margin: 0; }
  .wd-doc :global(blockquote) { margin: .6em 0; padding: 0 0 0 1em; box-shadow: inset 2px 0 0 var(--md-line-2); color: var(--md-fg-2); }
  .wd-doc :global(sup) { font-size: .75em; }
  .wd-doc :global(:is(pre, code)) { font-family: var(--md-mono); font-size: .9em; }
  /* 脚注 / 尾注：mammoth 把它们排成文末的有序列表 */
  .wd-doc :global(ol:last-child li[id^="footnote"]), .wd-doc :global(ol:last-child li[id^="endnote"]) { font-size: .88em; color: var(--md-fg-2); }

  .wd-pct { min-width: 56px; justify-content: center; font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }

  /* 查找命中：::highlight 只认少数属性，变量取不到原元素上的值，写死两档（暖黄 / 珊瑚，与 PDF 文本层命中一致） */
  :global(::highlight(wd-hit)) { background-color: rgba(235, 196, 98, .45); color: inherit; }
  :global(::highlight(wd-cur)) { background-color: rgba(217, 119, 87, .55); color: inherit; }
</style>
