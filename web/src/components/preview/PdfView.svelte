<script>
  // PDF 只读查看器（PDF.js 打包，worker 走 ?url 本地资源不依赖 CDN，离线壳可用）。
  //   · 连续纵向滚动 + 懒渲染（IntersectionObserver，只渲染进视口的页，省内存）
  //   · 缩放：−/＋ 按钮 + 双指捏合（捏合时 CSS transform 即时反馈，松手按新比例重渲清晰）
  //   · 页码指示、自带头部（返回/标题/页码/缩放/深色页面/下载），配色走 doctheme.css 纸面令牌、跟随全站明暗
  //   · 暗主题下可把页面反色成深底浅字（「深色页面」，记在本机）；默认保持原色，亮主题下按钮不出
  import { onMount, onDestroy } from 'svelte';
  import { setPreviewDetail } from '../../lib/preview.svelte.js';
  import { registerCapture } from '../../lib/uiReport.js';
  import { t, tc } from '../../lib/i18n.js';
  import { interceptAppDownload } from '../../lib/save.js';
  import '../../lib/doctheme.css';

  // PDF.js 按需加载（~350KB）：此前是静态 import，被打进主 chunk，于是每次启动都要
  // 解析一遍——而 PDF 只有真的去预览一个 pdf 时才用得上。worker 仍走 ?url 本地资源
  // （不依赖 CDN，离线壳可用），只是推迟到首次 load() 才解析。
  let getDocument = null;
  async function ensurePdfjs() {
    if (getDocument) return;
    const [core, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    core.GlobalWorkerOptions.workerSrc = worker.default;
    getDocument = core.getDocument;
  }

  let { item, onClose } = $props();

  // —— 工作区协同：页码上抛（agent 知道用户在看第几页）+ 网页端截图兜底
  //（当前页 canvas → JPEG；桌面壳/apk 有原生整窗截图时轮不到这里）。——
  $effect(() => { if (numPages) setPreviewDetail({ page: curPage, pages: numPages }); });
  $effect(() => registerCapture(() => {
    const c = rendered.get(curPage);
    if (!c || !c.toDataURL) return null;
    try { return { image: c.toDataURL('image/jpeg', 0.85), note: `PDF 第 ${curPage}/${numPages} 页` }; } catch { return null; }   // i18n-ignore 截图附注是给 agent 看的上下文，不上屏
  }));

  let scroller = $state(), pagesWrap = $state();
  let pdf = null;
  let pages = $state([]);     // [{num, w, h}]（scale=1 尺寸）
  let loading = $state(true), error = $state(false);
  let zoom = $state(1);       // 用户缩放（在 fit-width 基础上）
  // fit-width 比例（容器宽 / 页宽）。必须是 $state：以前是普通变量，scale 这个 $derived
  // 追踪不到它，页框一直按 1:1（A4≈595px）排，窄面板里再被 max-width 横向压扁。
  let baseScale = $state(1);
  let curPage = $state(1), numPages = $state(0);
  const slotEls = new Map();  // num -> slot div
  const rendered = new Map(); // num -> canvas（已渲染）
  let io = null;

  const DPR = Math.min(3, window.devicePixelRatio || 1);

  // 深色页面（只在暗主题下生效，CSS 判）：页面画布反色 + 色相转回 180°，白纸成深灰、黑字成浅灰、彩色大体保持色相
  const NIGHT_KEY = 'bridge.pdf.night';
  let night = $state((() => { try { return localStorage.getItem(NIGHT_KEY) === '1'; } catch { return false; } })());
  function toggleNight() { night = !night; try { localStorage.setItem(NIGHT_KEY, night ? '1' : '0'); } catch {} }
  const scale = $derived(baseScale * zoom);

  async function load() {
    loading = true; error = false;
    try {
      await ensurePdfjs();
      const task = getDocument({ url: item.url });
      pdf = await task.promise;
      numPages = pdf.numPages;
      const arr = [];
      for (let i = 1; i <= numPages; i++) {
        const p = await pdf.getPage(i);
        const vp = p.getViewport({ scale: 1 });
        arr.push({ num: i, w: vp.width, h: vp.height });
      }
      pages = arr;
      loading = false;
      requestAnimationFrame(() => { fitWidth(); setupIO(); });
    } catch (e) { error = true; loading = false; }
  }

  // 按容器宽算 fit-width；比例真变了才返回 true（调用方据此重渲）
  function fitWidth() {
    if (!scroller || !pages.length) return false;
    // 24 = .pdf-pages 左右 padding；再留 2px：DPR 1.5 等非整数倍下设备像素取整会溢出零点几 px，顶出横向滚动条
    const cw = scroller.clientWidth - 26;
    if (cw <= 0) return false;
    const next = Math.max(0.1, cw / pages[0].w);
    if (Math.abs(next - baseScale) < 1e-3) return false;
    baseScale = next;
    return true;
  }

  function setupIO() {
    io?.disconnect();
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const num = +e.target.dataset.num;
        if (e.isIntersecting) { renderPage(num); if (e.intersectionRatio > 0.5) curPage = num; }
      }
    }, { root: scroller, rootMargin: '300px 0px', threshold: [0, 0.5, 1] });
    for (const el of slotEls.values()) io.observe(el);
  }

  async function renderPage(num) {
    if (!pdf || rendered.has(num)) return;
    const slot = slotEls.get(num); if (!slot) return;
    rendered.set(num, true);   // 占位防重入
    try {
      const page = await pdf.getPage(num);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * DPR); canvas.height = Math.floor(vp.height * DPR);
      canvas.style.width = '100%'; canvas.style.height = '100%';
      const ctx = canvas.getContext('2d');
      ctx.scale(DPR, DPR);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      slot.querySelector('.pdf-ph')?.remove();
      slot.appendChild(canvas);
      rendered.set(num, canvas);
    } catch { rendered.delete(num); }
  }

  // 缩放：清掉已渲染的，按新比例重渲可见页（滚动时其余页再懒渲）
  let rerenderT = null;
  function applyZoom(z) {
    zoom = Math.min(4, Math.max(0.5, z));
    clearTimeout(rerenderT);
    rerenderT = setTimeout(() => {
      for (const [num, c] of rendered) { if (c && c.remove) c.remove(); }
      rendered.clear();
      // 重新渲染当前视口附近
      for (const [num, el] of slotEls) {
        const r = el.getBoundingClientRect(); const sr = scroller.getBoundingClientRect();
        if (r.bottom > sr.top - 300 && r.top < sr.bottom + 300) renderPage(num);
      }
    }, 60);
  }
  function zoomIn() { applyZoom(zoom * 1.25); }
  function zoomOut() { applyZoom(zoom / 1.25); }

  // 捏合缩放（在滚动区，2 指）：捏时 CSS transform 即时反馈，松手按倍率重渲
  let pinch = null;
  function pd(e) {
    if (e.pointerType !== 'touch') return;
    pinchPts.set(e.pointerId, e);
    if (pinchPts.size === 2) { const [a, b] = [...pinchPts.values()]; pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z0: zoom }; }
  }
  function pm(e) {
    if (!pinchPts.has(e.pointerId)) return;
    pinchPts.set(e.pointerId, e);
    if (pinch && pinchPts.size === 2) {
      const [a, b] = [...pinchPts.values()];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const f = d / (pinch.d0 || 1);
      if (pagesWrap) { pagesWrap.style.transform = `scale(${f})`; pagesWrap.style.transformOrigin = 'center top'; }
      pinch.f = f;
    }
  }
  function pu(e) {
    pinchPts.delete(e.pointerId);
    if (pinch && pinchPts.size < 2) {
      const f = pinch.f || 1;
      if (pagesWrap) pagesWrap.style.transform = '';
      applyZoom(pinch.z0 * f);
      pinch = null;
    }
  }
  const pinchPts = new Map();

  // 看容器而不是 window：Dock 拖宽窄、分屏、侧栏开合都不触发 window resize
  let ro = null;
  onMount(() => {
    load();
    ro = new ResizeObserver(() => { if (fitWidth()) applyZoom(zoom); });
    ro.observe(scroller);
  });
  onDestroy(() => { io?.disconnect(); ro?.disconnect(); clearTimeout(rerenderT); try { pdf?.destroy?.(); } catch {} });

  // slot 注册 action
  function slot(node, num) { slotEls.set(num, node); node.dataset.num = num; if (io) io.observe(node); return { destroy() { slotEls.delete(num); } }; }
</script>

<div class="pdf-root" class:night>
  <header class="pdf-head">
    <button class="pdf-btn" aria-label={t('返回')} onclick={() => onClose?.()}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
    </button>
    <span class="pdf-title">{item.name}</span>
    {#if numPages}<span class="pdf-pageno">{curPage} / {numPages}</span>{/if}
    <button class="pdf-btn" aria-label={tc('files', '缩小')} onclick={zoomOut}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
    <button class="pdf-btn" aria-label={tc('files', '放大')} onclick={zoomIn}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
    <button class="pdf-btn pdf-night" class:on={night} aria-label={t('深色页面')} title={t('深色页面')} aria-pressed={night} onclick={toggleNight}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3.75" width="14" height="16.5" rx="2.25"/><path d="M12 3.75v16.5" /><path d="M12 3.75h4.75A2.25 2.25 0 0 1 19 6v12a2.25 2.25 0 0 1-2.25 2.25H12z" fill="currentColor" stroke="none"/></svg></button>
    {#if item.downloadHref}<a class="pdf-btn" href={item.downloadHref} download={item.name} onclick={(e) => interceptAppDownload(e, { url: item.downloadHref, name: item.name })} aria-label={t('下载')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M12 16l-5-5M12 16l5-5"/><path d="M5 20h14"/></svg></a>{/if}
  </header>

  <div class="pdf-scroll" bind:this={scroller} role="presentation" onpointerdown={pd} onpointermove={pm} onpointerup={pu} onpointercancel={pu}>
    {#if loading}
      <div class="pdf-center"><span class="pdf-spin"></span></div>
    {:else if error}
      <div class="pdf-center pdf-err"><p>{t('PDF 加载失败')}</p><button onclick={load}>{t('重试')}</button>{#if item.downloadHref}<a class="pdf-dl" href={item.downloadHref} download={item.name} onclick={(e) => interceptAppDownload(e, { url: item.downloadHref, name: item.name })}>{t('下载')}</a>{/if}</div>
    {:else}
      <div class="pdf-pages" bind:this={pagesWrap}>
        {#each pages as p (p.num)}
          <div class="pdf-slot" use:slot={p.num} style:width="{Math.floor(p.w * scale)}px" style:height="{Math.floor(p.h * scale)}px">
            <div class="pdf-ph"></div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  /* 配色走 lib/doctheme.css 的 --md-* 纸面令牌（亮象牙白 / 暗暖墨，与 md 阅读器、Office 同一套）。
     页面本身是文档原样（白纸），只有台面与顶栏随主题；暗主题下可开「深色页面」把画布反色。 */
  .pdf-root { position: absolute; inset: 0; background: var(--md-stage); color: var(--md-fg); display: flex; flex-direction: column; }
  .pdf-head { flex: none; display: flex; align-items: center; gap: 4px; padding: max(var(--pv-pad-y, 8px), var(--sat)) 8px var(--pv-pad-y, 8px);
    background: var(--md-bg); box-shadow: inset 0 -.5px 0 rgba(var(--md-ink), .12); }
  .pdf-btn { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--md-fg); flex: none;
    transition: background var(--mo-tap, 90ms), color var(--mo-micro, 140ms); }
  .pdf-btn svg { width: 21px; height: 21px; }
  @media (hover: hover) { .pdf-btn:hover { background: rgba(var(--md-ink), .06); } }
  .pdf-btn:active { background: rgba(var(--md-ink), .1); }
  .pdf-title { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding: 0 4px; }
  .pdf-pageno { flex: none; font-size: 12.5px; color: var(--md-fg-3); font-variant-numeric: tabular-nums; padding: 0 6px; }
  /* 深色页面开关：亮主题下没有意义（不反色），不出 */
  .pdf-night { color: var(--md-fg-3); }
  .pdf-night svg { width: 19px; height: 19px; }
  .pdf-night.on { color: var(--md-accent); }
  :global(html[data-theme="light"]) .pdf-night { display: none; }

  .pdf-scroll { flex: 1; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; touch-action: pan-x pan-y pinch-zoom; }
  /* 放大后页比容器宽：外包随最宽页撑开、滚动区横滚；不能给页框 max-width——宽被夹、高不变 = 压扁 */
  .pdf-pages { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px; box-sizing: border-box; width: max-content; min-width: 100%; will-change: transform; }
  .pdf-slot { position: relative; flex: none; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.14); border-radius: 2px; overflow: hidden; }
  :global(html:not([data-theme="light"])) .pdf-slot { box-shadow: 0 2px 14px rgba(0,0,0,.45), 0 0 0 .5px rgba(255,255,255,.06); }
  /* 占位：亮纸上是浅灰流光；暗主题里不先闪一块白（页框底色同占位，画布出来再盖上） */
  .pdf-ph { position: absolute; inset: 0; --ph-a: #fafafa; --ph-b: #f0f0f2;
    background: linear-gradient(100deg, var(--ph-a) 30%, var(--ph-b) 50%, var(--ph-a) 70%); background-size: 200% 100%; animation: pdfShimmer 1.3s infinite; }
  :global(html:not([data-theme="light"])) .pdf-ph { --ph-a: #2c2c2a; --ph-b: #363633; }
  :global(html:not([data-theme="light"])) .pdf-slot:has(.pdf-ph) { background: #2c2c2a; }
  @keyframes pdfShimmer { to { background-position: -200% 0; } }
  .pdf-slot :global(canvas) { display: block; }
  /* 深色页面：invert .88 让白纸落在 #1f 而不是纯黑、黑字落在 #e0 而不刺眼；hue-rotate 把彩色转回原色相 */
  :global(html:not([data-theme="light"])) .pdf-root.night .pdf-slot { background: #1f1f1f; }
  :global(html:not([data-theme="light"])) .pdf-root.night .pdf-slot :global(canvas) { filter: invert(.88) hue-rotate(180deg); }

  .pdf-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--md-fg-2); }
  .pdf-spin { width: 30px; height: 30px; border-radius: 50%; border: 3px solid rgba(var(--md-ink), .1); border-top-color: var(--md-accent); animation: pdfspin .8s linear infinite; }
  @keyframes pdfspin { to { transform: rotate(360deg); } }
  .pdf-err button, .pdf-dl { padding: 7px 20px; border-radius: 999px; background: var(--md-accent); color: #fff; font-size: 14px; }
</style>
