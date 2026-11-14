<script>
  // Office 查看器（调度）。
  //   · 表格（xlsx / xlsm / xls / ods）→ 一律客户端 SheetGrid：真网格、冻结窗格、合并、数字格式、虚拟滚动、
  //     工作表标签、公式栏、查找（比转 PDF 强：能选能复制、2 万行照样顺）。解析放 Worker（loadBook）。
  //     csv / tsv 不走这里：外框把它们当文本交给 DocViewer 的 TableView（唯一的 csv 渲染器；sheet.js 的 csv 解析只留作解析能力）。
  //   · 文档 / 演示（doc docx odt rtf / ppt pptx odp）→ 先等服务端 LibreOffice 转 PDF（像素级）：轮询 office-pdf?status=1，
  //     冷转换时显示「正在转换 · 已用 x 秒」/「排队中 · 前面还有 n 个」，等久了可「先看快速预览」（服务端照转，转好了提示切换）；
  //     转好交给 PdfView（Word = word 模式带「导航」，PPT = slides 模式一页一屏 + 放映）。
  //   · 手机窄屏（触屏且宽 < 640）的 docx 系默认「阅读视图」：直接 mammoth → WordDoc 按屏宽重排（Word 手机版的默认），
  //     不先转 PDF——A4 分页版式在 393 宽上只剩 46%、正文 5px 读不了。⋮ 里「打印版式」↔「阅读视图」互切，选择记住（bridge.docx.layout）。
  //   · 服务端转不了（没装 / 失败 / 超时 / 离线 / 本机文件）→ 客户端快速预览：Word = mammoth → WordDoc（纸张 + 导航 + 查找），
  //     PPT = pptx.js → PptDeck（按原版式画幻灯片 + 缩略图 + 放映）；doc / odt / rtf / ppt / odp 客户端画不了，给明确的错误态。
  // 重库（mammoth / xlsx / fflate / dompurify）动态 import，只在打开 Office 时加载。
  // 外框声明：表格页由这里声明；PDF / 快速预览各自的子组件自己声明（后声明的整份盖过先声明的，这里在那些阶段不声明，免得回头盖住它们）。
  import { onDestroy, untrack } from 'svelte';
  import PdfView from './PdfView.svelte';
  import ViewerState from './kit/ViewerState.svelte';
  import { useViewer } from './kit/context.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import { recoverStaleChunk } from '../../lib/staleGuard.js';
  import { officeCat, extOf } from '../../lib/fileKinds.js';
  import { t, tr } from '../../lib/i18n.js';
  import { waitOfficePdf } from './office/officePdf.js';
  import { loadBook } from './office/loadBook.js';
  import SheetGrid from './office/SheetGrid.svelte';
  import SheetTabs from './office/SheetTabs.svelte';
  import WordDoc from './office/WordDoc.svelte';
  import PptDeck from './office/PptDeck.svelte';
  import '../../lib/doctheme.css';

  let { item } = $props();

  const viewer = useViewer();
  const touch = $derived(viewer.inShell ? viewer.touch : !pointer.fine);
  const name = untrack(() => item.name || '');
  const ext = extOf(name);
  const cat = officeCat(name) || 'word';   // 子类出自唯一词表 lib/fileKinds.js（tsv / xlsm / ppsx 也认得）
  const EXT = ext.toUpperCase();
  // 客户端能画的：docx 系（mammoth）、pptx 系（pptx.js）；doc / odt / rtf / ppt / odp 只能靠服务端
  const clientWord = /^(docx|docm|dotx)$/.test(ext);
  const clientSlides = /^(pptx|pptm|ppsx|potx)$/.test(ext);
  const canQuick = cat === 'word' ? clientWord : cat === 'slides' ? clientSlides : false;
  const QUICK_AFTER = 6;                   // 转换等了几秒后出「先看快速预览」
  // 手机窄屏 docx：阅读视图（重排）/ 打印版式（服务端 PDF）。只在打开时按当时的宽度定一次，转屏不来回切
  const LAYOUT_KEY = 'bridge.docx.layout';
  const reflowable = clientWord && untrack(() => touch) && typeof innerWidth === 'number' && innerWidth < 640;
  let layout = $state(reflowable && (() => { try { return localStorage.getItem(LAYOUT_KEY); } catch { return null; } })() !== 'print' ? 'reflow' : 'print');
  function setLayout(v) {
    if (!reflowable || v === layout) return;
    layout = v;
    try { localStorage.setItem(LAYOUT_KEY, v); } catch {}
    start();
  }
  const layoutItems = () => !reflowable ? []
    : layout === 'reflow'
      ? (item.officePdfUrl ? [{ label: t('打印版式'), icon: 'page', onSelect: () => setLayout('print') }] : [])
      : [{ label: t('阅读视图'), icon: 'wrap', onSelect: () => setLayout('reflow') }];

  let phase = $state('loading');           // loading | convert | pdf | sheet | word | slides | error
  let err = $state.raw(null);              // { title, detail, icon, retry?: () => void, retryLabel? }
  let conv = $state.raw(null);             // { state: 'queued'|'converting', ms, ahead, at }
  let convT0 = 0;
  let now = $state(Date.now());
  let quick = false;                       // 用户点了「先看快速预览」（服务端还在转）
  let ac = null, gen = 0, dead = false;

  // 各形态产物
  let book = $state.raw(null);
  let active = $state(0), freezeOn = $state(true), gridOn = $state(true), zoom = $state(1), findOpen = $state(false);
  let grid = $state(null);
  let wordHtml = $state('');
  let deck = $state.raw(null);
  const quickInfo = [{ label: t('预览方式'), value: t('快速预览（未经服务端转换）') }];
  const reflowInfo = [{ label: t('预览方式'), value: t('阅读视图（按屏幕宽度重排）') }];
  const isReflow = $derived(reflowable && layout === 'reflow');

  async function fetchBuf() {
    // 只把「取文件」这一步的失败标成读取失败（解析代码里的 TypeError 不算，那是文件内容的问题）
    let r;
    try { r = await fetch(item.url, { credentials: 'same-origin' }); }
    catch (e) { throw Object.assign(new Error(String(e?.message || e)), { http: 0 }); }
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { http: r.status });
    try { return await r.arrayBuffer(); }
    catch (e) { throw Object.assign(new Error(String(e?.message || e)), { http: 0 }); }
  }

  function fail(e, retry = start) {
    // 新构建部署后旧页面拉不到懒加载 chunk（xlsx / mammoth / dompurify）→ 整页自愈刷新，不画错误态
    if (recoverStaleChunk(e)) return;
    if (e?.code === 'password') {
      err = { title: t('表格受密码保护'), detail: t('网页里打不开加密的表格，请下载后用 Excel 或 WPS 打开。'), icon: 'lock' };
    } else if (e?.http != null) {
      err = { title: t('文件读取失败'), detail: tr(String(e?.message || e)), icon: 'error', retry };
    } else {
      err = { title: t('无法预览此文档'), detail: tr(String(e?.message || e)), icon: cat === 'sheet' ? 'table' : cat === 'slides' ? 'slides' : 'page', retry };
    }
    phase = 'error';
  }

  function start() {
    gen++;
    ac?.abort(); ac = null;
    phase = 'loading'; err = null; conv = null; quick = false;
    if (cat === 'sheet') return renderSheet(gen);
    if (reflowable && layout === 'reflow') return renderWord(gen);
    if (item.officePdfUrl) return viaServer(gen, false);
    return clientOrExplain(gen, 'local');
  }

  // —— 服务端转 PDF ——
  async function viaServer(my, retry) {
    ac = new AbortController();
    convT0 = Date.now();
    let res;
    try {
      res = await waitOfficePdf(item.officePdfUrl, {
        signal: ac.signal, retry,
        onstate: (s) => {
          if (my !== gen || dead) return;
          conv = s;
          if (phase === 'loading') { phase = 'convert'; now = Date.now(); }
        },
      });
    } catch (e) {
      if (my !== gen || dead || ac?.signal.aborted) return;
      res = { ok: false, state: 'network', error: String(e?.message || e) };
    }
    if (my !== gen || dead) return;
    conv = null;
    if (res.ok) {
      if (quick) {
        // 快速预览已经在看：不打断，提示可以换成精确版
        viewer.toast(t('原版式 PDF 已转换好'), { ms: 8000, action: { label: t('切换'), onClick: () => { if (my === gen) { quick = false; phase = 'pdf'; } } } });
        return;
      }
      phase = 'pdf';
      return;
    }
    if (quick) return;   // 快速预览已经显示着，服务端失败不用再说
    clientOrExplain(my, res.state, res.error);
  }

  // 服务端走不通：能客户端画的就回落，画不了的说清楚为什么
  function clientOrExplain(my, why, detail = '') {
    if (canQuick) {
      if (why === 'failed' || why === 'timeout') viewer.toast(t('服务端转换没成功，先用快速预览显示'));
      return cat === 'slides' ? renderSlides(my) : renderWord(my);
    }
    const again = () => { gen++; phase = 'loading'; err = null; viaServer(gen, true); };
    if (why === 'local') {
      err = { title: t('这里打不开 {ext} 文件', { ext: EXT }), detail: t('{ext} 要在服务端转换后才能预览。可以用其它应用打开，或放进工作空间再看。', { ext: EXT }), icon: cat === 'slides' ? 'slides' : 'page' };
    } else if (why === 'unavailable') {
      err = { title: t('服务端没有安装 LibreOffice'), detail: t('{ext} 文件需要 LibreOffice 转换后才能预览。装好后重新打开即可。', { ext: EXT }), icon: 'unsupported', retry: start };
    } else if (why === 'failed') {
      err = { title: t('转换失败'), detail: t('LibreOffice 没能转换这个文件，它可能已损坏或设置了密码。'), icon: 'error', retry: again, retryLabel: t('重新转换') };
    } else if (why === 'timeout') {
      err = { title: t('转换超时'), detail: t('文件较大或服务端繁忙，稍后再试一次。'), icon: 'error', retry: again, retryLabel: t('重新转换') };
    } else {
      err = { title: t('无法连接服务端'), detail: tr(detail), icon: 'error', retry: start };
    }
    phase = 'error';
  }

  function quickView() {
    if (!canQuick || phase !== 'convert') return;
    quick = true;
    const my = gen;
    if (cat === 'slides') renderSlides(my); else renderWord(my);
  }

  // PdfView 打不开转出来的 PDF（坏文件 / 拉取失败）：能回落就接手
  function onPdfFail() {
    if (!canQuick) return false;
    const my = ++gen;
    phase = 'loading';
    viewer.toast(t('转换出的 PDF 打不开，先用快速预览显示'));
    if (cat === 'slides') renderSlides(my); else renderWord(my);
    return true;
  }

  // —— 客户端渲染 ——
  async function renderWord(my) {
    try {
      const [mammoth, DOMPurify] = await Promise.all([import('mammoth'), import('dompurify').then((m) => m.default)]);
      const buf = await fetchBuf();
      if (my !== gen || dead) return;
      const { value } = await mammoth.convertToHtml({ arrayBuffer: buf }, {
        // Word 的「标题 / 副标题」样式默认会被当成普通段落；映射成 h1 / 副标题段，导航里才有文档题目
        styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => p.wd-sub:fresh"],   // i18n-ignore
      });
      if (my !== gen || dead) return;
      wordHtml = DOMPurify.sanitize(value || '<p>' + t('（空文档）') + '</p>');
      phase = 'word';
    } catch (e) { if (my === gen && !dead) fail(e); }
  }

  async function renderSlides(my) {
    try {
      const [fflate, { parsePptx }] = await Promise.all([import('fflate'), import('./office/pptx.js')]);
      const buf = await fetchBuf();
      if (my !== gen || dead) return;
      const d = parsePptx(buf, fflate);
      if (my !== gen || dead) { d.dispose(); return; }
      if (!d.slides.length) { d.dispose(); throw new Error(t('这个演示文稿里没有幻灯片')); }
      deck?.dispose(); deck = d;
      phase = 'slides';
    } catch (e) { if (my === gen && !dead) fail(e); }
  }

  async function renderSheet(my) {
    try {
      const buf = await fetchBuf();
      if (my !== gen || dead) return;
      const b = await loadBook(buf, ext);
      if (my !== gen || dead) return;
      if (!b?.sheets?.length) throw new Error(t('空表格'));
      book = b;
      active = b.activeTab || 0;
      phase = 'sheet';
      const big = b.sheets.find((s) => s.clipped);
      if (big) viewer.toast(t('表格太大，只显示前 {r} 行 × {c} 列', { r: big.nRows.toLocaleString(), c: big.nCols.toLocaleString() }), { ms: 4000 });
    } catch (e) { if (my === gen && !dead) fail(e); }
  }

  // —— 转换进度：每秒走一下秒数 ——
  $effect(() => {
    if (phase !== 'convert') return;
    const id = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(id);
  });
  const elapsed = $derived(conv ? Math.max(0, Math.floor((conv.ms + (now - conv.at)) / 1000)) : 0);
  const waited = $derived(phase === 'convert' ? Math.floor((now - convT0) / 1000) : 0);
  const convText = $derived(
    conv?.state === 'queued'
      ? (conv.ahead > 0 ? t('排队中 · 前面还有 {n} 个', { n: conv.ahead }) : t('排队中'))
      : t('正在转换 · 已用 {n} 秒', { n: elapsed }),
  );
  const convLive = $derived(conv?.state === 'queued' ? t('排队中') : t('正在转换'));

  // —— 表格页：外框声明 ——
  const sheets = $derived(book?.sheets || []);
  const sh = $derived(sheets[active] || null);
  const shownSheets = $derived(sheets.filter((s) => !s.hidden).length);
  $effect(() => {
    if (phase !== 'sheet' || !book) return;
    const tabsBottom = touch && shownSheets > 1;
    return untrack(() => viewer.declare({
      tools: () => [{ id: 'find', icon: 'search', label: t('查找'), kbd: 'Ctrl+F', onClick: () => grid?.openFind(), active: findOpen }],
      menu: sheetMenu,
      info: sheetInfo,
      arrows: false,
      keys: (e) => !!grid?.keys(e),
      bottom: tabsBottom ? tabsBar : undefined,
    }));
  });
  function sheetMenu() {
    const fz = !!(sh?.freeze && (sh.freeze.rows || sh.freeze.cols));
    return [
      ...(sheets.length > 1 ? [{
        label: t('工作表'), icon: 'table', detail: sh?.name || '',
        submenu: { title: t('工作表'), items: () => sheets.map((s, i) => ({ label: s.hidden ? t('{name}（隐藏）', { name: s.name }) : s.name, checked: i === active, onSelect: () => (active = i) })) },
      }] : []),
      { label: t('冻结窗格'), checked: freezeOn, keepOpen: true, hidden: !fz, onSelect: () => (freezeOn = !freezeOn) },
      { label: t('网格线'), checked: gridOn, keepOpen: true, onSelect: () => (gridOn = !gridOn) },
      { label: t('缩放'), icon: 'fit', detail: `${Math.round(zoom * 100)}%`, submenu: { title: t('缩放'), items: () => grid?.zoomItems() || [] } },
      ...(touch ? [
        { sep: true },
        { label: t('全选'), icon: 'check', onSelect: () => grid?.selectAll() },
        { label: t('复制所选单元格'), icon: 'copy', onSelect: () => grid?.copy() },
      ] : []),
    ];
  }
  function sheetInfo() {
    if (!sh) return [];
    const rows = [];
    if (sheets.length > 1) rows.push({ label: t('工作表'), value: t('{n} 个工作表', { n: sheets.length }) });
    rows.push({ label: t('当前工作表'), value: sh.name });
    rows.push({ label: t('数据范围'), value: t('{r} 行 × {c} 列', { r: sh.nRows.toLocaleString(), c: sh.nCols.toLocaleString() }) });
    if (sh.clipped) rows.push({ label: t('完整大小'), value: t('{r} 行 × {c} 列', { r: sh.clipped.rows.toLocaleString(), c: sh.clipped.cols.toLocaleString() }) });
    return rows;
  }

  start();
  onDestroy(() => {
    dead = true; gen++;
    ac?.abort();
    deck?.dispose();
  });
</script>

{#snippet tabsBar()}
  <div class="of-tabsbar"><SheetTabs {sheets} {active} touch onpick={(i) => (active = i)} /></div>
{/snippet}

{#if phase === 'pdf'}
  <!-- 服务端转好的 PDF：交给 PdfView（像素级还原，自带导航 / 缩略图 / 查找 / 放映）；打不开时 onfail 回落快速预览 -->
  <PdfView item={{ ...item, url: item.officePdfUrl }} mode={cat === 'slides' ? 'slides' : 'word'} onfail={onPdfFail} menuExtra={layoutItems} />
{:else}
  <div class="of-root" data-phase={phase} data-conv={conv?.state || ''}>
    {#if phase === 'sheet' && book}
      <SheetGrid bind:this={grid} {book} bind:active bind:freezeOn bind:gridOn bind:zoom bind:findOpen {touch} tabs={!touch} />
    {:else if phase === 'word'}
      <WordDoc html={wordHtml} info={isReflow ? reflowInfo : quickInfo} menuExtra={layoutItems}
        note={!isReflow ? t('快速预览：由浏览器直接排版，字体、分页与原文件可能不同。')
          : item.officePdfUrl ? t('阅读视图：按屏幕宽度重排，字体与分页和原文件可能不同；要看原版式可在 ⋮ 里切到「打印版式」。')
          : t('阅读视图：按屏幕宽度重排，字体与分页和原文件可能不同。')} />
    {:else if phase === 'slides' && deck}
      <PptDeck {deck} info={quickInfo} />
    {:else if phase === 'convert'}
      <div class="vw-state vw-state-overlay of-conv" role="group" aria-label={convLive}>
        <span class="vw-spin" style:--s="28px" aria-hidden="true"></span>
        <p class="vw-state-t of-conv-t">{convText}</p>
        <p class="vw-state-d">{cat === 'slides' ? t('第一次打开要先把演示文稿转成 PDF，转好后再打开会直接显示。') : t('第一次打开要先把文档转成 PDF，转好后再打开会直接显示。')}</p>
        {#if canQuick && waited >= QUICK_AFTER}
          <div class="vw-state-acts of-conv-acts"><button type="button" class="vw-pbtn" onclick={quickView}>{t('先看快速预览')}</button></div>
        {/if}
        <span class="vw-sr" aria-live="polite">{convLive}</span>
      </div>
    {:else if phase === 'error' && err}
      <ViewerState kind="error" icon={err.icon} title={err.title} detail={err.detail} onRetry={err.retry || null} retryLabel={err.retryLabel || ''} />
    {:else}
      <ViewerState kind="loading" label={cat === 'sheet' ? t('正在读取表格…') : ''} />
    {/if}
  </div>
{/if}

<style>
  /* 配色走 lib/doctheme.css 的 --md-* 纸面令牌（亮象牙白 / 暗暖墨，跟随全站明暗；与 md 阅读器、PDF 同一套） */
  .of-root { position: absolute; inset: 0; background: var(--md-bg); color: var(--md-fg); display: flex; flex-direction: column; }
  .of-conv-t { font-variant-numeric: tabular-nums; }
  .of-conv-acts { animation: of-fade var(--mo-quick) var(--ea-fade) both; }
  @keyframes of-fade { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .of-conv-acts { animation: none; } }
  /* 触屏外框底栏里的工作表标签：高 44，左右贴边（外框底栏自带安全区内边距） */
  .of-tabsbar { display: flex; min-height: 44px; margin: 0 -8px; }
  .of-tabsbar :global(.st) { flex: 1; min-width: 0; }
</style>
