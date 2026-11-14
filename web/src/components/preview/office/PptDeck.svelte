<script>
  // PPT 客户端回落（没装 LibreOffice / 转换失败 / 离线 / 本地文件）：pptx.js 解析 → PptSlide 绘制，手感与「PPT 转 PDF」那条路一致——
  //   一页一屏、按比例居中；←/→/↑/↓/PageUp/PageDown/空格 翻页，Home / End 首尾；普通滚轮翻页（内容放得下时）；触屏横滑翻页。
  //   电脑：左侧「幻灯片」缩略图栏（宽窗推开、窄窗盖上），底部居中浮条：上一张 / 页码 / 下一张 · 缩小 / 比例 / 放大。
  //   触屏：底栏是横向缩略图条 + 「当前 / 总数」；双指捏合放大、双击在适应与 2 倍之间切换。
  //   F5 从头放映、Shift+F5 从当前页放映（SlideShow：黑底、单击 / → 下一张、Esc 退出）；有演讲者备注时 ⋮ 里可开「备注」栏。
  // props：deck（parsePptx 的结果）· info（追加到文件信息面板的行，OfficeView 用来标「快速预览」）
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { pointer } from '../../../lib/layout.svelte.js';
  import { setPreviewDetail } from '../../../lib/preview.svelte.js';
  import { t, tc } from '../../../lib/i18n.js';
  import { useViewer, isEditable } from '../kit/context.js';
  import VIcon from '../kit/VIcon.svelte';
  import { tip } from '../kit/tooltip.js';
  import ThumbStrip from '../paged/ThumbStrip.svelte';
  import SlideShow from '../paged/SlideShow.svelte';
  import PdfSidebar from '../pdf/PdfSidebar.svelte';
  import { attachGestures } from '../pdf/gestures.js';
  import PptSlide from './PptSlide.svelte';

  let { deck, info = [] } = $props();
  const viewer = useViewer();
  const touch = $derived(viewer.inShell ? viewer.touch : !pointer.fine);
  const fine = $derived(!touch);
  const count = $derived(deck?.slides?.length || 0);
  const aspect = $derived(deck ? deck.w / deck.h : 16 / 9);
  const hasNotes = $derived(!!deck?.slides?.some((s) => s.notes));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pref = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

  let cur = $state(1);
  let show = $state(0);
  let zoom = $state(1);                   // 相对「适应页面」的倍数；显示的百分比按 PDF 的口径（1 磅 = 4/3 像素，与转 PDF 那条路一致）
  let rootEl = $state(null), stage = $state(null), canvas = $state(null);
  let SW = $state(0), SH = $state(0), rootW = $state(0);

  // 侧栏（与 PdfView 幻灯片模式共用偏好键）
  const SIDE_KEY = 'bridge.ppt.side';
  let sideOpen = $state(false);
  let sideTab = $state('thumbs');
  const sideOverlay = $derived(fine && rootW > 0 && rootW < 760);
  function toggleSide() {
    sideOpen = !sideOpen;
    if (fine && !sideOverlay) setPref(SIDE_KEY, sideOpen ? '1' : '0');
  }

  const NOTES_KEY = 'bridge.ppt.notes';
  let notesOn = $state(pref(NOTES_KEY) === '1');
  function toggleNotes() { notesOn = !notesOn; setPref(NOTES_KEY, notesOn ? '1' : '0'); }
  const notes = $derived(deck?.slides?.[cur - 1]?.notes || '');

  // —— 适应页面的尺寸 ——
  const PAD = $derived(touch ? { x: 12, top: 12, bottom: 12 } : { x: 32, top: 24, bottom: 72 });
  const fitW = $derived.by(() => {
    if (!SW || !SH) return 0;
    const aw = Math.max(40, SW - PAD.x * 2), ah = Math.max(40, SH - PAD.top - PAD.bottom);
    return Math.floor(Math.min(aw, ah * aspect));
  });
  const slideW = $derived(Math.round(fitW * zoom));
  const slideH = $derived(Math.round(slideW / aspect));
  const base = $derived(deck ? (deck.w * 4) / 3 : 1);   // 100% 时的幻灯片宽
  const pct = $derived(fitW ? Math.round(((fitW * zoom) / base) * 100) : 100);
  // 缩放范围按绝对比例 25% ~ 500%，「适应页面」总在范围里
  const zmin = $derived(fitW ? Math.min(1, (0.25 * base) / fitW) : 1);
  const zmax = $derived(fitW ? Math.max(1, (5 * base) / fitW) : 1);

  // 缩略图：进过视口的才画（画过的留着，来回滚不闪）
  const seen = new SvelteSet();
  const vis = { urls: new Map(), want: (n) => seen.add(n), unwant: () => {} };

  // —— 外框声明 ——
  $effect(() => {
    const tch = touch;
    return untrack(() => viewer.declare({
      tools: () => [
        { id: 'side', icon: 'sidebar', label: t('幻灯片'), onClick: toggleSide, active: sideOpen },
        { id: 'play', icon: 'play', label: t('放映'), kbd: 'F5', onClick: () => startShow(1) },
      ],
      menu: () => [
        { label: t('从当前页放映'), icon: 'play', kbd: 'Shift+F5', onSelect: () => startShow(cur) },
        ...(hasNotes ? [{ label: t('演讲者备注'), icon: 'page', checked: notesOn, keepOpen: true, onSelect: toggleNotes }] : []),
        { label: t('缩放'), icon: 'fit', detail: `${pct}%`, submenu: { title: t('缩放'), items: zoomItems } },
      ],
      info: () => [{ label: t('幻灯片'), value: String(count) }, ...info],
      arrows: false,
      keys: onKeys,
      float: floatBar,
      bottom: tch ? bottomBar : undefined,
    }));
  });

  $effect(() => { if (count) setPreviewDetail({ page: cur, pages: count }); });

  // —— 翻页 ——
  function go(n) {
    const to = clamp(Math.round(n) || 1, 1, count || 1);
    if (to === cur) return;
    cur = to;
    if (stage) { stage.scrollTop = 0; stage.scrollLeft = 0; }
  }
  const next = () => go(cur + 1);
  const prev = () => go(cur - 1);

  // —— 缩放 ——
  function zoomItems() {
    return [
      { label: t('适应页面'), checked: zoom === 1, onSelect: () => zoomTo(1) },
      { sep: true },
      ...[0.5, 0.75, 1, 1.5, 2, 3, 4].map((z) => ({ label: `${Math.round(z * 100)}%`, checked: zoom !== 1 && Math.abs((fitW * zoom) / base - z) < 0.005, onSelect: () => zoomTo((z * base) / (fitW || 1)) })),
    ];
  }
  async function zoomTo(z, anchor = null) {
    z = clamp(z, zmin, zmax);
    if (Math.abs(z - 1) < 0.004) z = 1;
    if (!stage || !canvas) { zoom = z; return; }
    const r = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const ax = anchor ? anchor.cx : sr.left + sr.width / 2, ay = anchor ? anchor.cy : sr.top + sr.height / 2;
    const fx = r.width ? (ax - r.left) / r.width : 0.5, fy = r.height ? (ay - r.top) / r.height : 0.5;
    const tx = anchor?.tx ?? ax, ty = anchor?.ty ?? ay;
    zoom = z;
    await tick();
    const r2 = canvas.getBoundingClientRect();
    stage.scrollLeft += r2.left + fx * r2.width - tx;
    stage.scrollTop += r2.top + fy * r2.height - ty;
  }
  const zoomIn = () => zoomTo(zoom * 1.25);
  const zoomOut = () => zoomTo(zoom / 1.25);
  function openZoomMenu(e) { viewer.openMenu({ anchor: e.currentTarget, items: zoomItems, title: t('缩放'), place: 'top' }); }

  // —— 放映 ——
  function startShow(n) { if (count) show = clamp(n || 1, 1, count); }
  function endShow(n) { show = 0; go(n); }

  // —— 键盘 ——
  function onKeys(e) {
    if (show) return false;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (k === 'F5') { startShow(e.shiftKey ? cur : 1); return true; }
    if (mod && !e.altKey && (k === '=' || k === '+')) { zoomIn(); return true; }
    if (mod && !e.altKey && (k === '-' || k === '_')) { zoomOut(); return true; }
    if (mod && !e.altKey && k === '0') { zoomTo(1); return true; }
    if (k === 'Escape') {
      if (sideOpen && sideOverlay) { sideOpen = false; return true; }
      return false;
    }
    if (isEditable(e.target) || mod || e.altKey || !stage) return false;
    const onButton = !!e.target?.closest?.('button, a, [role="tab"]');
    const inList = !!e.target?.closest?.('.ts');
    const vOver = stage.scrollHeight > stage.clientHeight + 1;
    const hOver = stage.scrollWidth > stage.clientWidth + 1;
    switch (k) {
      case 'PageDown': next(); return true;
      case 'PageUp': prev(); return true;
      case 'Home': if (inList) return false; go(1); return true;
      case 'End': if (inList) return false; go(count); return true;
      case ' ': if (onButton) return false; if (e.shiftKey) prev(); else next(); return true;
      case 'Enter': if (onButton) return false; next(); return true;
      case 'ArrowDown': case 'ArrowUp':
        if (inList) return false;
        if (vOver) { stage.scrollBy({ top: (k === 'ArrowDown' ? 1 : -1) * 48 }); return true; }
        if (k === 'ArrowDown') next(); else prev();
        return true;
      case 'ArrowRight': case 'ArrowLeft':
        if (inList) return false;
        if (hOver) { stage.scrollBy({ left: (k === 'ArrowRight' ? 1 : -1) * 48 }); return true; }
        if (k === 'ArrowRight') next(); else prev();
        return true;
    }
    return false;
  }

  // 普通滚轮：放得下时翻页（累计 50 像素、两次至少隔 250ms，触控板惯性不会一下翻过头）
  let wheelAcc = 0, wheelLast = 0;
  function onWheel(e) {
    if (e.ctrlKey || e.metaKey || !stage) return;
    if (stage.scrollHeight > stage.clientHeight + 1) return;
    e.preventDefault();
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (Math.abs(wheelAcc) < 50 || e.timeStamp - wheelLast < 250) return;
    wheelLast = e.timeStamp;
    if (wheelAcc > 0) next(); else prev();
    wheelAcc = 0;
  }

  // —— 页码框 ——
  let pageFocus = $state(false), pageDraft = $state('');
  function pageKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = parseInt(pageDraft, 10);
      if (v >= 1 && v <= count) go(v);
      e.currentTarget.blur();
    } else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); }
  }
  function pageFocusIn(e) {
    const el = e.currentTarget;
    pageFocus = true; pageDraft = String(cur);
    requestAnimationFrame(() => { try { el.select(); } catch {} });
  }

  // —— 生命周期 ——
  let detach = null, ro = null;
  onMount(() => {
    rootW = rootEl?.clientWidth || 0;
    const p = pref(SIDE_KEY);
    if (fine) sideOpen = p ? p === '1' && rootW >= 760 : rootW >= 900;
    detach = attachGestures(stage, {
      pinchTarget: () => canvas,
      clampFactor: (f) => clamp(zoom * f, zmin, zmax) / zoom,
      onPinchEnd: ({ factor, x0, y0, cx, cy }) => { if (Math.abs(factor - 1) >= 0.01) zoomTo(zoom * factor, { cx: x0, cy: y0, tx: cx, ty: cy }); },
      onWheelZoom: ({ factor, cx, cy }) => zoomTo(zoom * factor, { cx, cy }),
      onDoubleTap: ({ cx, cy }) => { if (touch) zoomTo(zoom > 1.15 ? 1 : 2, { cx, cy }); },
      canSwipe: () => !!stage && stage.scrollWidth <= stage.clientWidth + 1,
      onSwipe: (d) => (d > 0 ? next() : prev()),
    });
    stage.addEventListener('wheel', onWheel, { passive: false });
    ro = new ResizeObserver(() => { rootW = rootEl?.clientWidth || 0; });
    ro.observe(rootEl);
  });
  onDestroy(() => {
    detach?.(); ro?.disconnect();
    stage?.removeEventListener('wheel', onWheel);
  });
</script>

{#snippet thumb(n)}
  {#if seen.has(n)}<span class="pd-th"><PptSlide {deck} {n} w={0} /></span>{/if}
{/snippet}

{#snippet pageBox(big)}
  <span class="pg" class:big>
    <span class="pg-box"><input class="pg-in" type="text" inputmode="numeric" enterkeyhint="go" autocomplete="off" aria-label={t('页码')}
      style:width="{String(count).length + 1}ch"
      value={pageFocus ? pageDraft : String(cur)}
      onfocus={pageFocusIn} onblur={() => (pageFocus = false)}
      oninput={(e) => (pageDraft = e.currentTarget.value.replace(/[^\d]/g, ''))} onkeydown={pageKey} /></span>
    <span class="pg-of">/ {count}</span>
  </span>
{/snippet}

{#snippet floatBar()}
  <button type="button" class="vw-btn" disabled={cur <= 1} onclick={prev} use:tip={{ label: t('上一张'), kbd: 'PageUp' }}><VIcon name="prev" /></button>
  {@render pageBox(false)}
  <button type="button" class="vw-btn" disabled={cur >= count} onclick={next} use:tip={{ label: t('下一张'), kbd: 'PageDown' }}><VIcon name="next" /></button>
  <span class="vw-float-sep" aria-hidden="true"></span>
  <button type="button" class="vw-btn" disabled={zoom <= zmin + 1e-3} onclick={zoomOut} use:tip={{ label: tc('files', '缩小'), kbd: 'Ctrl+-' }}><VIcon name="zoomOut" /></button>
  <button type="button" class="vw-btn vw-txt pd-pct" onclick={openZoomMenu} use:tip={{ label: t('缩放'), kbd: 'Ctrl+0' }}>{pct}%</button>
  <button type="button" class="vw-btn" disabled={zoom >= zmax - 1e-3} onclick={zoomIn} use:tip={{ label: tc('files', '放大'), kbd: 'Ctrl+=' }}><VIcon name="zoomIn" /></button>
{/snippet}

{#snippet bottomBar()}
  <div class="pd-bar">
    <ThumbStrip layout="row" size={46} {count} current={cur} onpick={go} aspect={() => aspect} {thumb} want={vis.want} />
    <span class="pd-count">{cur} / {count}</span>
  </div>
{/snippet}

<div class="pd" class:touch class:fine bind:this={rootEl} data-slide={cur} data-slides={count} data-zoom={zoom.toFixed(3)}>
  <div class="pd-body">
    <PdfSidebar open={sideOpen} {touch} overlay={sideOverlay} title={t('幻灯片')} bind:tab={sideTab}
      {count} current={cur} onpick={go} aspect={() => aspect} thumbs={vis} {thumb} thumbSize={176}
      onclose={() => (sideOpen = false)} />
    <div class="pd-main">
      <div class="pd-stage" bind:this={stage} bind:clientWidth={SW} bind:clientHeight={SH} class:zoomed={zoom > 1}>
        <div class="pd-pad" style:padding="{PAD.top}px {PAD.x}px {PAD.bottom}px">
          {#if slideW > 0}
            <div class="pd-slide" bind:this={canvas} style:width="{slideW}px" style:height="{slideH}px">
              <PptSlide {deck} n={cur} w={slideW} links />
            </div>
          {/if}
        </div>
      </div>
      {#if notesOn && hasNotes}
        <section class="pd-notes" aria-label={t('演讲者备注')}>
          <h3 class="pd-notes-t">{t('备注')}</h3>
          <p class="pd-notes-x" class:empty={!notes}>{notes || t('这一页没有备注')}</p>
        </section>
      {/if}
    </div>
  </div>
  {#if show}
    <SlideShow {count} start={show} aspect={() => aspect} onexit={endShow}>
      {#snippet slide(n, w)}<PptSlide {deck} {n} {w} />{/snippet}
    </SlideShow>
  {/if}
</div>

<style>
  .pd { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--md-stage); color: var(--md-fg); }
  .pd-body { position: relative; flex: 1; min-height: 0; display: flex; }
  .pd-main { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .pd-stage { position: relative; flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; touch-action: pan-x pan-y; outline: none; }
  .pd.fine .pd-stage.zoomed { scrollbar-gutter: stable; }
  .pd-pad { box-sizing: border-box; display: flex; min-width: 100%; min-height: 100%; width: max-content; }
  .pd-slide { position: relative; flex: none; margin: auto; background: #fff; box-shadow: 0 2px 12px rgba(0, 0, 0, .14); }
  :global(html:not([data-theme="light"])) .pd-slide { box-shadow: 0 2px 14px rgba(0, 0, 0, .45), 0 0 0 .5px rgba(255, 255, 255, .06); }

  /* 演讲者备注：舞台下面一栏，最多占三成高 */
  .pd-notes { flex: none; max-height: 30%; overflow: auto; box-sizing: border-box; padding: 10px 20px 14px; background: var(--md-bg);
    box-shadow: inset 0 .5px 0 rgba(var(--md-ink), .12); }
  .pd.fine .pd-notes { padding-bottom: 64px; }
  .pd-notes-t { margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--md-fg-3); }
  .pd-notes-x { margin: 0; font-size: 14px; line-height: 1.6; white-space: pre-wrap; color: var(--md-fg); user-select: text; -webkit-user-select: text; }
  .pd-notes-x.empty { color: var(--md-fg-3); }
  .pd.touch .pd-notes-x { font-size: 15px; }

  .pd-th { position: absolute; inset: 0; display: block; }
  .pd-th :global(.psl) { pointer-events: none; }

  /* —— 页码框（与 PdfView 一致）—— */
  .pg { display: inline-flex; align-items: center; gap: 5px; padding: 0 4px; font-size: 13px; color: var(--vw-fg-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pg-in { box-sizing: content-box; min-width: 2ch; height: 24px; padding: 0 5px; border: 0; border-radius: 6px; outline: none; text-align: center;
    font: inherit; color: var(--md-fg); background: rgba(var(--md-ink), .07); caret-color: var(--md-accent); }
  .pg-in:focus { background: var(--md-field, rgba(var(--md-ink), .04)); box-shadow: 0 0 0 1px rgba(var(--md-ink), .25); }
  .pg-of { color: var(--vw-fg-3); }
  .pg-box { position: relative; display: inline-flex; }
  .pd-pct { min-width: 56px; justify-content: center; font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }

  .pd-bar { display: flex; gap: 4px; min-height: 58px; margin: 0 -8px; }
  .pd-bar :global(.ts-row) { flex: 1; min-width: 0; }
  .pd-count { flex: none; align-self: center; padding-right: 14px; font-size: 13px; color: var(--vw-fg-3); font-variant-numeric: tabular-nums; }
</style>
