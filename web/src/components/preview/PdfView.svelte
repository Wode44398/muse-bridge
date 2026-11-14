<script>
  // PDF 阅读器（对标 Acrobat / Chrome PDF）：PDF.js 的 PDFViewer 负责排版、按页虚拟化、文本层、链接层、查找高亮，
  // 外面的一切我们自己做——缩放档位与锚点、页码、侧栏（缩略图 / 书签）、查找条、密码、放映、打印。
  //   · 渲染：只画视口附近的页，离远了的画布由 PDF.js 的页缓存回收；页尺寸先按第 1 页排、后台补齐；
  //     DPR 封顶 + 单张画布像素上限（pdf/pdfjs.js）；cmaps / 标准字体 / wasm 随包，中文不丢字，离线 apk 也能用。
  //   · 缩放：Ctrl + 滚轮 / 触控板捏合以光标为锚；手机双指以中点为锚，捏的过程只做 CSS 变换，松手按新比例重排，
  //     并把同一个内容点放回指下；重画期间旧画布按 CSS 拉伸垫着，不白闪。触屏双击在「自动」与 2 倍之间切换。
  //     档位：自动（电脑封顶 125%，宽屏不再大得离谱）/ 适应宽度（电脑封顶 1280 宽）/ 适应页面 / 实际大小 / 自定义。
  //   · 页码跟着滚动：视口里露得最多的那页；滚到底算最后一页。
  //   · mode：'doc' 普通 PDF；'word' Word 转出来的 PDF（侧栏叫「导航」，两页是「标题 / 页面」）；
  //     'slides' PPT 转出来的 PDF（一页一屏、左右翻、缩略图条、F5 全屏放映）。
  //   · 顶栏交给外框（kit/context.js）：主工具 侧栏 / 查找（/ 放映），⋮ 里是缩放档、旋转、双页、深色页面、打印；
  //     电脑端底部居中浮条放翻页与缩放，触屏是底栏。外框的声明是整份替换，所以浮条 / 底栏等就绪后整份重新声明。
  import { onMount, onDestroy, untrack } from 'svelte';
  import { setPreviewDetail } from '../../lib/preview.svelte.js';
  import { registerCapture } from '../../lib/uiReport.js';
  import { ui } from '../../lib/state.svelte.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import { t, tc } from '../../lib/i18n.js';
  import { useViewer, isEditable } from './kit/context.js';
  import ViewerState from './kit/ViewerState.svelte';
  import VIcon from './kit/VIcon.svelte';
  import { tip } from './kit/tooltip.js';
  import FindBar from './paged/FindBar.svelte';
  import ThumbStrip from './paged/ThumbStrip.svelte';
  import SlideShow from './paged/SlideShow.svelte';
  import PdfSidebar from './pdf/PdfSidebar.svelte';
  import PdfPassword from './pdf/PdfPassword.svelte';
  import PdfPageCanvas from './pdf/PdfPageCanvas.svelte';
  import { loadPdfjs, docParams, quietL10n, maxCanvasPixels, classifyPdfError } from './pdf/pdfjs.js';
  import { attachGestures } from './pdf/gestures.js';
  import { PdfThumbs } from './pdf/thumbs.svelte.js';
  import { loadOutline, activeOutline } from './pdf/outline.js';
  import { printPdf } from './pdf/print.js';
  import './pdf/pdf-layers.css';
  import '../../lib/doctheme.css';

  /** onfail(kind, err) → true 表示调用方接手（OfficeView：转出来的 PDF 打不开就回落客户端渲染）
   *  menuExtra() → 菜单项数组：调用方放在 ⋮ 最前面的项（OfficeView 的「阅读视图」切换） */
  let { item, mode = 'doc', onfail = null, menuExtra = null } = $props();
  const viewer = useViewer();
  const slides = untrack(() => mode === 'slides');
  const word = untrack(() => mode === 'word');
  const touch = $derived(viewer.inShell ? viewer.touch : !pointer.fine);
  const fine = $derived(!touch);
  const lightTheme = () => ui.theme === 'light' || document.documentElement.dataset.theme === 'light';

  const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
  const MIN_SCALE = 0.1, MAX_SCALE = 8;
  const DEFAULT_MODE = slides ? 'page-fit' : 'auto';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const pref = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  // —— 状态 ——
  let phase = $state('loading');        // loading | password | ready | error
  let errKind = $state('');             // password | corrupt | missing | network | other
  let progress = $state(0);
  let numPages = $state(0), curPage = $state(1);
  let scale = $state(1);
  let scaleMode = $state(DEFAULT_MODE); // auto | page-width | page-fit | actual | custom
  let rotation = $state(0);
  let spread = $state(!slides && pref('bridge.pdf.spread') === '1');
  let aspects = $state.raw([]);         // 每页 宽 / 高（含旋转）
  let outline = $state.raw([]);
  let outlineDone = false, pageMode = '';
  let infoRows = $state.raw([]);
  let pwWrong = $state(0);
  let show = $state(0);                 // 放映起始页（0 = 没在放映）
  let rootW = $state(0);

  const NIGHT_KEY = 'bridge.pdf.night';
  let night = $state(pref(NIGHT_KEY) === '1');
  function toggleNight() { night = !night; setPref(NIGHT_KEY, night ? '1' : '0'); }

  // 侧栏：电脑宽窗推开内容、窄窗盖在上面；触屏是 Sheet
  const SIDE_KEY = slides ? 'bridge.ppt.side' : word ? 'bridge.word.side' : 'bridge.pdf.side';
  let sideOpen = $state(false);
  let sideTab = $state('thumbs');
  const sideOverlay = $derived(fine && rootW > 0 && rootW < 760);
  const sideLabels = word ? { thumbs: t('页面'), outline: t('标题') } : null;
  const sideTitle = slides ? t('幻灯片') : word ? t('导航') : t('侧栏');
  function toggleSide() {
    sideOpen = !sideOpen;
    if (fine && !sideOverlay) setPref(SIDE_KEY, sideOpen ? '1' : '0');
  }

  // 查找
  let fOpen = $state(false), fQuery = $state(''), fCur = $state(0), fTotal = $state(0), fPending = $state(false), fCase = $state(false), fHint = $state('');
  let findBar = $state(null);
  let textless = null;                  // 前几页都抽不出文字（扫描件）：没命中时提示一句

  // —— DOM 与 PDF.js 对象 ——
  let rootEl = $state(null), scroller = $state(null), viewerEl = $state(null);
  let P = null;                          // { lib, viewer }
  let pdfViewer = null, eventBus = null, linkService = null, findController = null;
  let pdf = $state.raw(null), task = null, pwUpdate = null;
  let thumbs = $state.raw(null);
  let ac = null, gen = 0, dead = false;

  const activeId = $derived(outline.length ? activeOutline(outline, curPage) : -1);
  const pct = $derived(Math.round(scale * 100));

  // —— 外框声明（整份替换：就绪前后各声明一次，浮条 / 底栏只在就绪后出现）——
  $effect(() => {
    const ready = phase === 'ready', tch = touch, off = phase === 'password' || phase === 'error';
    return untrack(() => viewer.declare({
      tools: () => [
        // 载入中先占位（灰掉，就绪时不跳）；要密码 / 出错时这几样都用不上，直接收起
        // 触屏的侧栏入口挪到底栏左端（拇指够得着，也和右端的缩放百分比对称）；幻灯片底栏是胶片条，仍留在顶栏
        { id: 'side', icon: 'sidebar', label: sideTitle, onClick: toggleSide, active: sideOpen, disabled: phase !== 'ready', hidden: off || (tch && !slides) },
        { id: 'find', icon: 'search', label: t('查找'), kbd: 'Ctrl+F', onClick: openFind, active: fOpen, disabled: phase !== 'ready', hidden: off },
        ...(slides ? [{ id: 'play', icon: 'play', label: t('放映'), kbd: 'F5', onClick: () => startShow(1), disabled: phase !== 'ready', hidden: off }] : []),
      ],
      menu: () => (phase === 'ready' ? menuItems() : []),
      info: () => infoRows,
      arrows: false,
      keys: onKeys,
      float: ready ? floatBar : undefined,
      bottom: ready && tch ? bottomBar : undefined,
    }));
  });

  function zoomItems() {
    const custom = scaleMode === 'custom';
    return [
      { label: t('自动缩放'), checked: scaleMode === 'auto', onSelect: () => applyMode('auto') },
      { label: t('适应宽度'), checked: scaleMode === 'page-width', onSelect: () => applyMode('page-width') },
      { label: t('适应页面'), checked: scaleMode === 'page-fit', onSelect: () => applyMode('page-fit') },
      // 「实际大小」就是 100%：档位里不再另列一个 100%，手动缩放正好停在 100% 时也勾它
      { label: t('实际大小'), checked: scaleMode === 'actual' || (custom && Math.abs(scale - 1) < 0.005), onSelect: () => applyMode('actual') },
      { sep: true },
      ...[0.5, 0.75, 1.25, 1.5, 2, 3, 4].map((z) => ({ label: `${Math.round(z * 100)}%`, checked: custom && Math.abs(scale - z) < 0.005, onSelect: () => zoomTo(z) })),
    ];
  }
  function menuItems() {
    const extra = menuExtra?.() || [];
    return [
      ...(extra.length ? [...extra, { sep: true }] : []),
      { label: t('缩放'), icon: 'fit', detail: `${pct}%`, submenu: { title: t('缩放'), items: zoomItems } },
      { label: t('向左旋转'), icon: 'rotateLeft', kbd: fine ? 'Shift+R' : undefined, onSelect: () => rotate(-90) },
      { label: t('向右旋转'), icon: 'rotate', kbd: fine ? 'R' : undefined, onSelect: () => rotate(90) },
      ...(fine && !slides ? [{ label: t('双页视图'), icon: 'twoPage', checked: spread, keepOpen: true, onSelect: toggleSpread }] : []),
      { label: t('深色页面'), icon: 'night', checked: night, keepOpen: true, hidden: lightTheme(), onSelect: toggleNight },
      ...(fine ? [{ sep: true }, { label: t('打印'), icon: 'print', kbd: 'Ctrl+P', onSelect: print }] : []),
    ];
  }

  // —— 工作区协同：页码上抛 + 网页端截图兜底（当前页画布）——
  $effect(() => { if (numPages) setPreviewDetail({ page: curPage, pages: numPages }); });
  $effect(() => registerCapture(() => {
    const c = pdfViewer?.getPageView(curPage - 1)?.canvas;
    if (!c || !c.width || !c.toDataURL) return null;
    try { return { image: c.toDataURL('image/jpeg', 0.85), note: `PDF 第 ${curPage}/${numPages} 页` }; } catch { return null; }   // i18n-ignore 截图附注是给 agent 看的上下文，不上屏
  }));

  // —— 打开 ——
  function ensureViewer() {
    if (pdfViewer) return;
    const { lib, viewer: V } = P;
    ac = new AbortController();
    eventBus = new V.EventBus();
    linkService = new V.PDFLinkService({ eventBus, externalLinkTarget: V.LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer nofollow', ignoreDestinationZoom: true });
    findController = new V.PDFFindController({ linkService, eventBus, updateMatchesCountOnProgress: true });
    pdfViewer = new V.PDFViewer({
      container: scroller, viewer: viewerEl, eventBus, linkService, findController,
      textLayerMode: 1,
      annotationMode: lib.AnnotationMode.ENABLE,
      annotationEditorMode: lib.AnnotationEditorType.DISABLE,
      removePageBorders: true,
      maxCanvasPixels: maxCanvasPixels(),
      enableSelectionRendering: false,
      l10n: quietL10n,
      abortSignal: ac.signal,
    });
    linkService.setViewer(pdfViewer);
    const on = (name, fn) => eventBus.on(name, fn, { signal: ac.signal });
    on('pagesinit', onPagesInit);
    on('pagesloaded', () => { aspects = computeAspects(); });
    on('scalechanging', (e) => { scale = e.scale; });
    on('rotationchanging', (e) => { rotation = e.pagesRotation; aspects = computeAspects(); });
    on('updateviewarea', trackPage);
    on('pagerendered', (e) => {
      if (e.cssTransform || e.isDetailView) return;
      const pv = pdfViewer.getPageView(e.pageNumber - 1);
      thumbs?.fromCanvas(e.pageNumber, pv?.canvas, pdfViewer.pagesRotation);
    });
    // pdf.js 给每页的 textLayer 设了 tabIndex=0：Tab 会逐页停在整页文字层上、套一个整页大的焦点框。
    // 页面不当 Tab 停靠点（Acrobat 同款：Tab 只走链接），翻页交给 PgUp / PgDn
    on('textlayerrendered', (e) => {
      const d = e.source?.textLayer?.div || pdfViewer.getPageView(e.pageNumber - 1)?.div?.querySelector('.textLayer');
      if (d) d.tabIndex = -1;
    });
    on('updatefindmatchescount', (e) => { fCur = e.matchesCount?.current || 0; fTotal = e.matchesCount?.total || 0; });
    on('updatefindcontrolstate', onFindState);
  }

  async function open() {
    const my = ++gen;
    phase = 'loading'; errKind = ''; progress = 0; pwUpdate = null; pwWrong = 0;
    await closeDoc();
    try {
      P ||= await loadPdfjs();
      if (my !== gen || dead) return;
      ensureViewer();
      const { lib, viewer: V } = P;
      pdfViewer.scrollMode = slides ? V.ScrollMode.PAGE : V.ScrollMode.VERTICAL;
      pdfViewer.spreadMode = spread && fine ? V.SpreadMode.ODD : V.SpreadMode.NONE;
      const tk = (task = lib.getDocument(docParams(lib, item.url)));
      tk.onPassword = (update, reason) => {
        if (my !== gen) return;
        pwUpdate = update;
        if (reason === lib.PasswordResponses.INCORRECT_PASSWORD) pwWrong++;
        phase = 'password';
      };
      tk.onProgress = ({ loaded, total }) => { if (my === gen && total > 0) progress = Math.min(1, loaded / total); };
      const doc = await tk.promise;
      if (my !== gen || dead) return;
      pdf = doc;
      numPages = doc.numPages;
      curPage = 1;
      phase = 'loading';
      thumbs = new PdfThumbs(doc, { width: slides ? 176 : 120 });
      linkService.setDocument(doc, null);
      pdfViewer.setDocument(doc);
      loadMeta(doc, my);
    } catch (e) {
      if (my !== gen || dead) return;
      const k = classifyPdfError(e);
      if (onfail?.(k, e)) return;
      errKind = k; phase = 'error';
    }
  }

  async function closeDoc() {
    try { pdfViewer?.setDocument(null); } catch {}
    try { linkService?.setDocument(null); } catch {}
    thumbs?.destroy(); thumbs = null;
    outline = []; infoRows = []; textless = null; outlineDone = false;
    const tk = task; task = null; pdf = null;
    try { await tk?.destroy(); } catch {}
  }

  function submitPassword(pw) { try { pwUpdate?.(pw); } catch {} }
  function cancelPassword() {
    gen++;
    const tk = task; task = null; pwUpdate = null;
    try { tk?.destroy(); } catch {}
    errKind = 'password'; phase = 'error';
  }

  function onPagesInit() {
    aspects = computeAspects();
    applyMode(scaleMode);
    phase = 'ready';
    initSide();
    requestAnimationFrame(() => trackPage());
  }

  async function loadMeta(doc, my) {
    try {
      const [meta, p1, pm] = await Promise.all([doc.getMetadata().catch(() => ({})), doc.getPage(1), doc.getPageMode().catch(() => '')]);
      if (my !== gen) return;
      const info = meta?.info || {};
      pageMode = pm || '';
      const [x0, y0, x1, y1] = p1.view;
      let wmm = Math.abs(x1 - x0) * 25.4 / 72, hmm = Math.abs(y1 - y0) * 25.4 / 72;
      if ((p1.rotate || 0) % 180 !== 0) [wmm, hmm] = [hmm, wmm];
      const rows = [{ label: t('页数'), value: String(doc.numPages) }, { label: t('页面大小'), value: paperName(wmm, hmm) }];
      const s = (v) => (typeof v === 'string' ? v.trim() : '');
      if (s(info.Title)) rows.push({ label: t('标题'), value: s(info.Title) });
      if (s(info.Author)) rows.push({ label: t('作者'), value: s(info.Author) });
      const tool = s(info.Creator) || s(info.Producer);
      if (tool) rows.push({ label: t('生成工具'), value: tool });
      if (s(info.PDFFormatVersion)) rows.push({ label: t('PDF 版本'), value: s(info.PDFFormatVersion) });
      if (info.IsAcroFormPresent) rows.push({ label: t('表单'), value: t('含表单（只读显示）') });
      infoRows = rows;
    } catch {}
    try {
      const o = await loadOutline(doc);
      if (my !== gen) return;
      outline = o.items;
      outlineDone = true;
      initSide();
      await o.resolve;
      if (my !== gen) return;
      outline = [...o.items];      // 页码是原地补上的，换一份数组让侧栏与「当前章节」重算
    } catch {
      if (my === gen) { outlineDone = true; initSide(); }
    }
  }

  function paperName(w, h) {
    const sizes = [['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['B5', 176, 250], ['B5 (JIS)', 182, 257], ['Letter', 215.9, 279.4], ['Legal', 215.9, 355.6]];
    const a = Math.min(w, h), b = Math.max(w, h);
    const hit = sizes.find(([, sw, sh]) => Math.abs(a - sw) < 3 && Math.abs(b - sh) < 3);
    const dim = `${Math.round(w)} × ${Math.round(h)} mm`;
    return hit ? `${hit[0]}${w > h ? ' ' + t('横向') : ''} · ${dim}` : dim;
  }

  // 侧栏初始开合：用户在电脑宽窗里手动开关过就记住；没记过按文档自己的意思（PageMode）与窗宽决定。触屏从不自动弹出。
  let sideInited = false;
  function initSide() {
    if (sideInited || phase !== 'ready' || !outlineDone) return;
    sideInited = true;
    const hasOutline = outline.length > 0 && !slides;
    if (touch) { sideTab = hasOutline && (word || pageMode === 'UseOutlines') ? 'outline' : 'thumbs'; return; }
    const p = pref(SIDE_KEY);
    const wide = (rootEl?.clientWidth || 0) >= (slides ? 900 : 1000);
    if (slides) { sideTab = 'thumbs'; sideOpen = p ? p === '1' : wide; return; }
    if (word) { sideTab = hasOutline ? 'outline' : 'thumbs'; sideOpen = p ? p === '1' : wide && hasOutline; return; }
    // 同 Acrobat / Chrome：默认缩略图；文件自己声明「打开时显示书签」才先给书签
    sideTab = pageMode === 'UseOutlines' && hasOutline ? 'outline' : 'thumbs';
    sideOpen = p ? p === '1' : wide && (pageMode === 'UseOutlines' || pageMode === 'UseThumbs');
  }

  function computeAspects() {
    const n = pdfViewer?.pagesCount || 0;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = pdfViewer.getPageView(i)?.viewport;
      out[i] = v && v.height ? v.width / v.height : 0.75;
    }
    return out;
  }
  const aspectOf = (n) => aspects[n - 1] || aspects[0] || 0.75;

  // —— 页码：视口里露得最多的那页（面积相同取靠前的）；滚到底算最后一页 ——
  function trackPage() {
    if (!pdfViewer?.pagesCount || !scroller) return;
    const vis = pdfViewer._getVisiblePages?.();
    if (!vis?.views?.length) return;
    let best = 0, bestA = -1;
    for (const v of vis.views) {
      const a = (v.percent || 0) * (v.view.width || 1) * (v.view.height || 1);
      if (a > bestA + 1 || (Math.abs(a - bestA) <= 1 && v.id < best)) { best = v.id; bestA = Math.max(a, bestA); }
    }
    if (!slides && scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) best = vis.last?.id || best;
    if (best && best !== curPage) curPage = best;
  }

  function goPage(n) {
    if (!pdfViewer?.pagesCount) return;
    n = clamp(Math.round(n) || 1, 1, numPages);
    pdfViewer.currentPageNumber = n;
    curPage = n;
  }
  const pageStep = () => (pdfViewer && pdfViewer.spreadMode !== 0 ? 2 : 1);
  function nextPage() { goPage(curPage + pageStep()); }
  function prevPage() { goPage(curPage - pageStep()); }

  // —— 缩放 ——
  function fitInfo() {
    const pv = pdfViewer?.getPageView(Math.max(0, curPage - 1)) || pdfViewer?.getPageView(0);
    if (!pv || !scroller || !viewerEl || !pv.scale) return null;
    const w1 = pv.width / pv.scale, h1 = pv.height / pv.scale;
    if (!w1 || !h1) return null;
    const cs = getComputedStyle(viewerEl);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const gap = parseFloat(getComputedStyle(rootEl).getPropertyValue('--pdf-gap')) || 0;
    const two = pdfViewer.spreadMode !== 0 ? 2 : 1;
    const cw = scroller.clientWidth - padX - (two === 2 ? 2 * gap : 0) - 1;
    const ch = scroller.clientHeight - padY - (slides ? 0 : gap) - 1;
    return { fw: cw / (w1 * two), fh: ch / h1, w1, h1, two };
  }
  function modeScale(m) {
    const f = fitInfo();
    if (!f) return null;
    const { fw, fh, w1, h1, two } = f;
    let s;
    if (m === 'actual') s = 1;
    else if (m === 'page-fit') s = Math.min(fw, fh);
    else if (m === 'page-width') s = touch ? fw : Math.min(fw, (two === 2 ? 2400 : 1280) / (w1 * two));
    else s = touch ? fw : Math.min(1.25, w1 > h1 ? Math.min(fw, fh) : fw);   // auto：横版页整页放进来，竖版按宽，电脑封顶 125%
    return clamp(s, MIN_SCALE, MAX_SCALE);
  }
  function applyMode(m) {
    const s = modeScale(m);
    if (s == null) return;
    scaleMode = m;
    if (Math.abs(pdfViewer.currentScale - s) > 1e-4) pdfViewer.currentScale = s;
    scale = pdfViewer.currentScale;
  }

  // 锚点：屏幕上 (cx, cy) 落在哪一页的什么位置（页框内的比例）；缩放后把同一点放回 (tx, ty)
  function anchorAt(cx, cy) {
    if (!scroller) return null;
    const sr = scroller.getBoundingClientRect();
    if (cx == null) { cx = sr.left + sr.width / 2; cy = sr.top + sr.height / 2; }
    let div = null;
    try { div = document.elementFromPoint(cx, cy)?.closest?.('.page'); } catch {}
    if (!div || !viewerEl?.contains(div)) {
      div = null;
      let bd = Infinity;
      for (const v of pdfViewer?._getVisiblePages?.().views || []) {
        const r = v.view.div.getBoundingClientRect();
        const d = Math.abs(cx - clamp(cx, r.left, r.right)) + Math.abs(cy - clamp(cy, r.top, r.bottom));
        if (d < bd) { bd = d; div = v.view.div; }
      }
    }
    if (!div) return null;
    const r = div.getBoundingClientRect();
    return { div, fx: (cx - r.left) / (r.width || 1), fy: (cy - r.top) / (r.height || 1), cx, cy };
  }
  function restoreAnchor(a, tx = a?.cx, ty = a?.cy) {
    if (!a || !a.div.isConnected || !scroller) return;
    const r = a.div.getBoundingClientRect();
    scroller.scrollLeft += r.left + a.fx * r.width - tx;
    scroller.scrollTop += r.top + a.fy * r.height - ty;
  }
  /** 缩放到 s，以 (cx, cy) 为锚（缺省视口中心）；delay ≥ 0 时先 CSS 拉伸、停手 delay 毫秒后再重画 */
  function zoomTo(s, { cx, cy, delay = -1 } = {}) {
    if (!pdfViewer?.pagesCount) return;
    s = clamp(s, MIN_SCALE, MAX_SCALE);
    const a = anchorAt(cx, cy);
    scaleMode = 'custom';
    if (delay >= 0) pdfViewer.updateScale({ scaleFactor: s / pdfViewer.currentScale, drawingDelay: delay });
    else pdfViewer.currentScale = s;
    scale = pdfViewer.currentScale;
    restoreAnchor(a);
  }
  function zoomIn() { const c = pdfViewer?.currentScale || scale; zoomTo(ZOOMS.find((z) => z > c * 1.01) ?? MAX_SCALE); }
  function zoomOut() { const c = pdfViewer?.currentScale || scale; zoomTo([...ZOOMS].reverse().find((z) => z < c / 1.01) ?? MIN_SCALE); }
  function resetZoom() { applyMode(DEFAULT_MODE); }

  // 滚轮 / 触控板：累计一个浮点目标（触控板一帧只有 1% 上下，PDF.js 按 0.01 取整会把它吃掉）
  let wheelGoal = 0, wheelT = 0;
  function onWheelZoom({ factor, cx, cy }) {
    if (!pdfViewer?.pagesCount) return;
    const cur = pdfViewer.currentScale;
    wheelGoal = clamp((wheelGoal || cur) * factor, MIN_SCALE, MAX_SCALE);
    clearTimeout(wheelT); wheelT = setTimeout(() => (wheelGoal = 0), 400);
    if (Math.abs(wheelGoal - cur) < 0.005) return;
    zoomTo(wheelGoal, { cx, cy, delay: 400 });
  }
  function onPinchEnd({ factor, x0, y0, cx, cy }) {
    if (!pdfViewer?.pagesCount || Math.abs(factor - 1) < 0.01) return;
    const a = anchorAt(x0, y0);
    scaleMode = 'custom';
    pdfViewer.updateScale({ scaleFactor: factor, drawingDelay: 120 });
    scale = pdfViewer.currentScale;
    restoreAnchor(a, cx, cy);
  }
  function onDoubleTap({ cx, cy }) {
    if (!pdfViewer?.pagesCount) return;
    const fit = modeScale(DEFAULT_MODE);
    if (fit == null) return;
    if (pdfViewer.currentScale > fit * 1.15) {
      const a = anchorAt(cx, cy);
      applyMode(DEFAULT_MODE);
      restoreAnchor(a);
    } else zoomTo(fit * 2, { cx, cy });
  }

  function rotate(d) {
    if (!pdfViewer?.pagesCount) return;
    const r = (((pdfViewer.pagesRotation + d) % 360) + 360) % 360;
    const page = curPage;
    pdfViewer.pagesRotation = r;
    rotation = r;
    if (thumbs) thumbs.rotation = r;
    if (scaleMode !== 'custom') applyMode(scaleMode);
    goPage(page);
  }
  function toggleSpread() {
    if (!P || slides) return;
    spread = !spread;
    setPref('bridge.pdf.spread', spread ? '1' : '0');
    const page = curPage;
    pdfViewer.spreadMode = spread ? P.viewer.SpreadMode.ODD : P.viewer.SpreadMode.NONE;
    if (scaleMode !== 'custom') applyMode(scaleMode);
    goPage(page);
  }

  // —— 查找 ——
  const findSrc = {};
  let findReturn = null;                 // 打开查找前的焦点：关掉时还回去（不丢到 BODY）
  function openFind() {
    if (phase !== 'ready') return;
    if (fOpen) { findBar?.focus(); return; }
    findReturn = document.activeElement;
    // 有选中文字时拿来当查找词（Acrobat / Chrome 同款）
    const sel = String(globalThis.getSelection?.() || '').trim();
    if (sel && sel.length < 80 && !sel.includes('\n')) fQuery = sel;
    fOpen = true;
    if (fQuery) { fPending = true; dispatchFind(''); }
  }
  function dispatchFind(type, prev = false) {
    if (!eventBus) return;
    fHint = '';
    eventBus.dispatch('find', { source: findSrc, type, query: fQuery, caseSensitive: fCase, entireWord: false, highlightAll: true, findPrevious: prev, matchDiacritics: false });
  }
  function onQuery(q) {
    fQuery = q;
    if (!q) { eventBus?.dispatch('findbarclose', { source: findSrc }); fCur = 0; fTotal = 0; fPending = false; fHint = ''; return; }
    fPending = true;
    dispatchFind('');
  }
  function onStep(dir) { if (fQuery) dispatchFind('again', dir < 0); }
  function onCase(on) { fCase = on; if (fQuery) dispatchFind('casesensitivitychange'); }
  function closeFind() {
    // 焦点还在查找条里（或已经掉到 BODY）才交还；用户已经点去别处就不抢
    const a = document.activeElement;
    const back = !a || a === document.body || !!a.closest?.('.fb');
    fOpen = false; fCur = 0; fTotal = 0; fPending = false; fHint = '';
    eventBus?.dispatch('findbarclose', { source: findSrc });
    if (back) restoreFocus(findReturn);
    findReturn = null;
  }
  /** 把焦点还给 el（还在本查看器里、不是查找条 / 页码框本身），否则给 PDF 滚动容器；不滚动 */
  function restoreFocus(el) {
    const ok = el && el !== document.body && el.isConnected && !el.closest?.('.fb, .pg') && !el.disabled;
    try { (ok ? el : scroller)?.focus({ preventScroll: true }); } catch {}
  }
  function onFindState(e) {
    const FS = P?.viewer?.FindState || { FOUND: 0, NOT_FOUND: 1, WRAPPED: 2, PENDING: 3 };
    fPending = e.state === FS.PENDING;
    if (e.matchesCount) { fCur = e.matchesCount.current || 0; fTotal = e.matchesCount.total || 0; }
    if (e.state === FS.NOT_FOUND && fQuery) checkTextless();
  }
  async function checkTextless() {
    if (textless === null && pdf) {
      const doc = pdf;
      try {
        let chars = 0;
        for (let i = 1; i <= Math.min(5, doc.numPages) && !chars; i++) {
          const content = await (await doc.getPage(i)).getTextContent();
          for (const it of content.items) chars += (it.str || '').trim().length;
        }
        if (doc !== pdf) return;
        textless = chars === 0;
      } catch { textless = false; }
    }
    if (textless && fOpen && fQuery && !fTotal) fHint = t('没有可搜索的文字（可能是扫描件）');
  }

  // —— 放映 / 打印 ——
  function startShow(n) { if (phase === 'ready' && numPages) show = clamp(n || 1, 1, numPages); }
  function endShow(n) { show = 0; requestAnimationFrame(() => goPage(n)); }

  let printing = null;
  async function print() {
    if (!pdf || printing || touch) return;
    const ctl = new AbortController();
    printing = ctl;
    const note = viewer.toast(t('正在准备打印…'), { ms: 0, action: { label: t('取消'), onClick: () => ctl.abort() } });
    try { await printPdf(pdf, { rotation, signal: ctl.signal }); }
    catch { if (!ctl.signal.aborted) viewer.toast(t('打印失败'), { kind: 'err' }); }
    finally { note?.close?.(); printing = null; }
  }

  // —— 键盘（外框在 window 冒泡阶段先问这里）——
  function onKeys(e) {
    if (phase !== 'ready' || show) return false;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && (k === 'f' || k === 'F')) { openFind(); return true; }
    if (k === 'F3' || (mod && (k === 'g' || k === 'G'))) { if (fOpen && fQuery) onStep(e.shiftKey ? -1 : 1); else openFind(); return true; }
    if (k === 'Escape') {
      if (fOpen) { closeFind(); return true; }
      // 盖在页面上的侧栏（电脑窄窗）和触屏的 Sheet：Esc 先收它，不直接关掉查看器（接键盘的平板 / 折叠屏）
      if (sideOpen && (sideOverlay || touch)) { sideOpen = false; return true; }
      return false;
    }
    if (mod && !e.altKey && (k === '=' || k === '+')) { zoomIn(); return true; }
    if (mod && !e.altKey && (k === '-' || k === '_')) { zoomOut(); return true; }
    if (mod && !e.altKey && k === '0') { resetZoom(); return true; }
    if (mod && !e.altKey && (k === 'p' || k === 'P') && fine) { print(); return true; }
    if (k === 'F5' && slides) { startShow(e.shiftKey ? curPage : 1); return true; }
    if (isEditable(e.target)) return false;
    if (mod || e.altKey || !scroller) return false;
    // 不带修饰键的 + / − 缩放、R / Shift+R 旋转（与图片画廊一致）
    if (k === '+' || k === '=' || e.code === 'NumpadAdd') { zoomIn(); return true; }
    if (k === '-' || k === '_' || e.code === 'NumpadSubtract') { zoomOut(); return true; }
    if (e.code === 'KeyR') { rotate(e.shiftKey ? -90 : 90); return true; }
    const onButton = !!e.target?.closest?.('button, a, [role="tab"], [role="treeitem"]');
    const inList = !!e.target?.closest?.('.ts, .po');
    const vOver = scroller.scrollHeight > scroller.clientHeight + 1;
    const hOver = scroller.scrollWidth > scroller.clientWidth + 1;
    switch (k) {
      case 'PageDown': nextPage(); return true;
      case 'PageUp': prevPage(); return true;
      case 'Home': if (inList) return false; goPage(1); return true;
      case 'End': if (inList) return false; goPage(numPages); return true;
      case ' ':
        if (onButton) return false;
        if (slides && !vOver) { if (e.shiftKey) prevPage(); else nextPage(); return true; }
        scroller.scrollBy({ top: (e.shiftKey ? -1 : 1) * Math.max(40, scroller.clientHeight - 48), behavior: reduced() ? 'auto' : 'smooth' });
        return true;
      case 'ArrowDown': case 'ArrowUp': {
        if (inList) return false;
        const d = k === 'ArrowDown' ? 1 : -1;
        if (slides && !vOver) { if (d > 0) nextPage(); else prevPage(); return true; }
        scroller.scrollBy({ top: d * 48 });
        return true;
      }
      case 'ArrowRight': case 'ArrowLeft': {
        if (inList) return false;
        const d = k === 'ArrowRight' ? 1 : -1;
        if (hOver) { scroller.scrollBy({ left: d * 48 }); return true; }
        if (d > 0) nextPage(); else prevPage();
        return true;
      }
    }
    return false;
  }

  // 幻灯片：内容放得下时普通滚轮翻页（累计 50 像素、两次翻页至少隔 250ms，触控板惯性不会一下翻过头）
  let wheelAcc = 0, wheelLast = 0;
  function onPlainWheel(e) {
    if (!slides || e.ctrlKey || e.metaKey || !scroller || phase !== 'ready') return;
    if (scroller.scrollHeight > scroller.clientHeight + 1) return;
    e.preventDefault();
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (Math.abs(wheelAcc) < 50 || e.timeStamp - wheelLast < 250) return;
    wheelLast = e.timeStamp;
    if (wheelAcc > 0) nextPage(); else prevPage();
    wheelAcc = 0;
  }

  // —— 页码输入框 ——
  let pageFocus = $state(false), pageDraft = $state('');
  function pageKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const n = parseInt(pageDraft, 10);
      if (n >= 1 && n <= numPages) goPage(n);
      leavePageBox();
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); leavePageBox(); }
  }
  // 退出页码框：焦点交给 PDF 滚动容器（键盘翻页接着可用，Tab 也不从文档开头重走）；触屏这一下同时收起键盘
  function leavePageBox() {
    pageFocus = false;
    try { scroller?.focus({ preventScroll: true }); } catch {}
  }
  function pageFocusIn(e) {
    const el = e.currentTarget;
    pageFocus = true; pageDraft = String(curPage);
    requestAnimationFrame(() => { try { el.select(); } catch {} });
  }

  function openZoomMenu(e) {
    viewer.openMenu({ anchor: e.currentTarget, items: zoomItems, title: t('缩放'), place: 'top' });
  }

  // —— 生命周期 ——
  let detach = null, ro = null, roRaf = 0;
  onMount(() => {
    rootW = rootEl?.clientWidth || 0;
    detach = attachGestures(scroller, {
      pinchTarget: () => (phase === 'ready' ? viewerEl : null),
      clampFactor: (f) => { const c = pdfViewer?.currentScale || 1; return clamp(c * f, MIN_SCALE, MAX_SCALE) / c; },
      onPinchEnd,
      onWheelZoom,
      onDoubleTap: (p) => { if (touch) onDoubleTap(p); },
      canSwipe: () => slides && !!scroller && scroller.scrollWidth <= scroller.clientWidth + 1,
      onSwipe: (d) => (d > 0 ? nextPage() : prevPage()),
    });
    scroller.addEventListener('wheel', onPlainWheel, { passive: false });
    ro = new ResizeObserver(() => {
      cancelAnimationFrame(roRaf);
      roRaf = requestAnimationFrame(() => {
        rootW = rootEl?.clientWidth || 0;
        if (phase === 'ready' && scaleMode !== 'custom') applyMode(scaleMode);
      });
    });
    ro.observe(scroller);
    open();
  });
  onDestroy(() => {
    dead = true; gen++;
    detach?.(); ro?.disconnect(); cancelAnimationFrame(roRaf); clearTimeout(wheelT);
    scroller?.removeEventListener('wheel', onPlainWheel);
    printing?.abort();
    try { pdfViewer?.setDocument(null); } catch {}
    try { linkService?.setDocument(null); } catch {}
    thumbs?.destroy();
    ac?.abort();
    const tk = task; task = null;
    try { tk?.destroy(); } catch {}
  });

  const errTitle = $derived(
    errKind === 'password' ? t('此文档受密码保护')
      : errKind === 'corrupt' ? t('文件已损坏或不是有效的 PDF')
      : errKind === 'missing' ? t('文件不存在或已被移动')
      : errKind === 'network' ? t('网络中断，PDF 没有下载完')
      : t('PDF 加载失败'),
  );
  const loadLabel = $derived(progress > 0.02 && progress < 1 ? t('正在载入 {p}%', { p: Math.round(progress * 100) }) : '');
  const prevIcon = slides ? 'prev' : 'up';
  const nextIcon = slides ? 'next' : 'down';
  function onOutlineGo(it) {
    if (it.dest) linkService?.goToDestination(it.dest).catch(() => { if (it.page) goPage(it.page); });
    else if (it.url) window.open(it.url, '_blank', 'noopener,noreferrer');
    else if (it.page) goPage(it.page);
  }
</script>

{#snippet pageBox(big)}
  <span class="pg" class:big>
    <span class="pg-box"><input class="pg-in" type="text" inputmode="numeric" enterkeyhint="go" autocomplete="off" aria-label={t('页码')}
      style:width="{String(numPages).length + 1}ch"
      value={pageFocus ? pageDraft : String(curPage)}
      onfocus={pageFocusIn} onblur={() => (pageFocus = false)}
      oninput={(e) => (pageDraft = e.currentTarget.value.replace(/[^\d]/g, ''))} onkeydown={pageKey} /></span>
    <span class="pg-of">/ {numPages}</span>
  </span>
{/snippet}

{#snippet floatBar()}
  <button type="button" class="vw-btn" disabled={curPage <= 1} onclick={prevPage} use:tip={{ label: slides ? t('上一张') : t('上一页'), kbd: 'PageUp' }}><VIcon name={prevIcon} /></button>
  {@render pageBox(false)}
  <button type="button" class="vw-btn" disabled={curPage >= numPages} onclick={nextPage} use:tip={{ label: slides ? t('下一张') : t('下一页'), kbd: 'PageDown' }}><VIcon name={nextIcon} /></button>
  <span class="vw-float-sep" aria-hidden="true"></span>
  <button type="button" class="vw-btn" disabled={scale <= MIN_SCALE + 1e-3} onclick={zoomOut} use:tip={{ label: tc('files', '缩小'), kbd: 'Ctrl+-' }}><VIcon name="zoomOut" /></button>
  <button type="button" class="vw-btn vw-txt pdf-pct" onclick={openZoomMenu} use:tip={{ label: t('缩放'), kbd: 'Ctrl+0' }}>{pct}%</button>
  <button type="button" class="vw-btn" disabled={scale >= MAX_SCALE - 1e-3} onclick={zoomIn} use:tip={{ label: tc('files', '放大'), kbd: 'Ctrl+=' }}><VIcon name="zoomIn" /></button>
{/snippet}

{#snippet bottomBar()}
  {#if slides}
    <div class="pb pb-slides">
      <ThumbStrip layout="row" size={46} count={numPages} current={curPage} onpick={goPage} aspect={aspectOf} {night}
        src={(n) => thumbs?.urls.get(n) || ''} want={(n) => thumbs?.want(n)} unwant={(n) => thumbs?.unwant(n)} />
      <span class="pb-count">{curPage} / {numPages}</span>
    </div>
  {:else}
    <div class="pb">
      <button type="button" class="vw-btn pb-side" class:on={sideOpen} aria-pressed={sideOpen} onclick={toggleSide} aria-label={sideTitle}><VIcon name="sidebar" /></button>
      <div class="pb-mid">
        <button type="button" class="vw-btn" disabled={curPage <= 1} onclick={prevPage} aria-label={t('上一页')}><VIcon name="up" /></button>
        {@render pageBox(true)}
        <button type="button" class="vw-btn" disabled={curPage >= numPages} onclick={nextPage} aria-label={t('下一页')}><VIcon name="down" /></button>
      </div>
      <button type="button" class="vw-btn vw-txt pdf-pct pb-pct" onclick={openZoomMenu} aria-label={t('缩放')}>{pct}%</button>
    </div>
  {/if}
{/snippet}

<div class="pdf-root" class:touch class:fine class:slides class:word class:night bind:this={rootEl}
  data-phase={phase} data-page={curPage} data-pages={numPages} data-scale={scale.toFixed(3)} data-mode={scaleMode} data-rotation={rotation}>
  {#if touch}
    <FindBar bind:this={findBar} open={fOpen} bind:query={fQuery} current={fCur} total={fTotal} pending={fPending} caseSensitive={fCase} hint={fHint} touch
      onquery={onQuery} onstep={onStep} oncase={onCase} onclose={closeFind} />
  {/if}
  <div class="pdf-body">
    {#if phase === 'ready'}
      <PdfSidebar open={sideOpen} {touch} overlay={sideOverlay} title={sideTitle} bind:tab={sideTab} labels={sideLabels}
        count={numPages} current={curPage} onpick={goPage} aspect={aspectOf} {thumbs} {night} thumbSize={slides ? 176 : 120}
        outline={slides ? [] : outline} {activeId} ongo={onOutlineGo} onclose={() => (sideOpen = false)} />
    {/if}
    <div class="pdf-main">
      {#if !touch}
        <FindBar bind:this={findBar} open={fOpen} bind:query={fQuery} current={fCur} total={fTotal} pending={fPending} caseSensitive={fCase} hint={fHint}
          onquery={onQuery} onstep={onStep} oncase={onCase} onclose={closeFind} />
      {/if}
      <!-- PDF.js 要求：容器绝对定位、里面一层 .pdfViewer，内容由它管 -->
      <div class="pdf-scroll" bind:this={scroller} class:hidden={phase !== 'ready'} tabindex="-1">
        <div class="pdfViewer" bind:this={viewerEl}></div>
      </div>
      {#if phase === 'loading'}
        <ViewerState kind="loading" label={loadLabel} />
      {:else if phase === 'error'}
        <ViewerState kind="error" icon={errKind === 'password' ? 'lock' : 'page'} title={errTitle}
          onRetry={open} retryLabel={errKind === 'password' ? t('输入密码') : ''} />
      {:else if phase === 'password'}
        <PdfPassword {touch} wrong={pwWrong} name={item?.name || ''} onsubmit={submitPassword} oncancel={cancelPassword} />
      {/if}
    </div>
  </div>
  {#if show && pdf}
    <SlideShow count={numPages} start={show} aspect={aspectOf} onexit={endShow}>
      {#snippet slide(n, w, h)}<PdfPageCanvas {pdf} {n} {w} {h} {rotation} />{/snippet}
    </SlideShow>
  {/if}
</div>

<style>
  /* 配色走 lib/doctheme.css 的 --md-* 纸面令牌：台面与栏随主题，页面本身是文档原样（白纸）；暗主题下可开「深色页面」反色。 */
  .pdf-root { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--md-stage); color: var(--md-fg); --pdf-gap: 12px; }
  .pdf-root.touch { --pdf-gap: 8px; }
  .pdf-body { position: relative; flex: 1; min-height: 0; display: flex; }
  .pdf-main { position: relative; flex: 1; min-width: 0; }
  .pdf-scroll { position: absolute; inset: 0; overflow: auto; overscroll-behavior: contain; touch-action: pan-x pan-y; outline: none; }
  .pdf-root.fine .pdf-scroll { scrollbar-gutter: stable; }
  .pdf-scroll.hidden { visibility: hidden; }

  /* 页边距：电脑底部多留 72 给浮条，最后一页不被盖住 */
  .pdf-root :global(.pdfViewer) { box-sizing: border-box; padding: 16px 24px 72px; }
  .pdf-root.touch :global(.pdfViewer) { padding: 8px 8px 16px; }
  /* 幻灯片：一页一屏、居中（margin:auto 居中，放大超出时左上角仍够得着） */
  .pdf-root.slides :global(.pdfViewer) { display: flex; min-height: 100%; padding: 24px 32px 72px; }
  .pdf-root.slides.touch :global(.pdfViewer) { padding: 12px; }
  .pdf-root.slides :global(.pdfViewer > .page), .pdf-root.slides :global(.pdfViewer > .spread) { margin: auto; flex: none; }

  .pdf-root :global(.pdfViewer .page) { box-shadow: 0 2px 12px rgba(0, 0, 0, .14); }
  :global(html:not([data-theme="light"])) .pdf-root :global(.pdfViewer .page) { box-shadow: 0 2px 14px rgba(0, 0, 0, .45), 0 0 0 .5px rgba(255, 255, 255, .06); }
  /* 还没画出来的页：浅流光占位；暗主题先是深灰，不先闪一块白 */
  .pdf-root :global(.page.loadingIcon:not(:has(canvas:not([hidden]))))::before {
    content: ''; position: absolute; inset: 0; pointer-events: none; --ph-a: #fafafa; --ph-b: #f0f0f2;
    background: linear-gradient(100deg, var(--ph-a) 30%, var(--ph-b) 50%, var(--ph-a) 70%); background-size: 200% 100%; animation: pdf-shimmer 1.3s linear infinite;
  }
  :global(html:not([data-theme="light"])) .pdf-root :global(.page:not(:has(canvas:not([hidden])))) { background-color: #2c2c2a; }
  :global(html:not([data-theme="light"])) .pdf-root :global(.page.loadingIcon:not(:has(canvas:not([hidden]))))::before { --ph-a: #2c2c2a; --ph-b: #363633; }
  @keyframes pdf-shimmer { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .pdf-root :global(.page.loadingIcon)::before { animation: none !important; } }
  /* 深色页面：invert .88 让白纸落在 #1f 而不是纯黑、黑字落在 #e0；hue-rotate 把彩色转回原色相 */
  :global(html:not([data-theme="light"])) .pdf-root.night :global(.pdfViewer .page) { background-color: #1f1f1f; }
  :global(html:not([data-theme="light"])) .pdf-root.night :global(.pdfViewer .canvasWrapper canvas) { filter: invert(.88) hue-rotate(180deg); }

  /* —— 页码框（浮条 / 底栏共用）—— */
  .pg { display: inline-flex; align-items: center; gap: 5px; padding: 0 4px; font-size: 13px; color: var(--vw-fg-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pg-in { box-sizing: content-box; min-width: 2ch; height: 24px; padding: 0 5px; border: 0; border-radius: 6px; outline: none; text-align: center;
    font: inherit; color: var(--md-fg); background: rgba(var(--md-ink), .07); caret-color: var(--md-accent); }
  .pg-in:focus { background: var(--md-field, rgba(var(--md-ink), .04)); box-shadow: 0 0 0 1px rgba(var(--md-ink), .25); }
  .pg-of { color: var(--vw-fg-3); }
  .pg.big { font-size: 14px; }   /* 触屏底栏统一 14（输入框本身仍 16，防 iOS 聚焦放大） */
  .pg-box { position: relative; display: inline-flex; }
  /* 触屏：看得见的胶囊 32 高（画在 .pg-box 上），输入框本身上下各探出 6px，命中区 44 */
  .pg.big .pg-box::before { content: ''; position: absolute; inset: 0; border-radius: 8px; background: rgba(var(--md-ink), .07); pointer-events: none; }
  .pg.big .pg-box:focus-within::before { background: var(--md-field, rgba(var(--md-ink), .04)); box-shadow: 0 0 0 1px rgba(var(--md-ink), .25); }
  .pg.big .pg-in { position: relative; height: 44px; margin: -6px 0; padding: 0 8px; min-width: 28px; font-size: 16px; background: none; }
  .pg.big .pg-in:focus { background: none; box-shadow: none; }
  .pdf-pct { min-width: 56px; justify-content: center; font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }

  /* —— 触屏底栏 —— */
  .pb { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; min-height: 44px; }
  .pb-mid { display: flex; align-items: center; gap: 4px; }
  .pb-pct { justify-self: end; font-size: 14px; }
  .pb-side { justify-self: start; }
  .pb-slides { display: flex; gap: 4px; min-height: 58px; margin: 0 -8px; }
  .pb-slides :global(.ts-row) { flex: 1; min-width: 0; }
  .pb-count { flex: none; padding-right: 14px; font-size: 14px; color: var(--vw-fg-3); font-variant-numeric: tabular-nums; }
</style>
