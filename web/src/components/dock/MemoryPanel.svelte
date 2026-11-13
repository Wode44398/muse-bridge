<script>
  // 工作台「记忆」卡：这个项目里 Claude 记下的东西。
  //
  // 图由服务端按【链接】长出来（runtime/memory-graph.mjs），不认固定格式：根＝MEMORY.md，树边＝索引里的
  // [标题](x.md)，索引分了 ## 小节就多一层分组；Claude Code 默认的两层、bridge 的三层索引都照样长对。
  // 两种看法（同一棵树、同一套配色，见 lib/memoryTree.js）：
  //   · 逐层（MemoryOutline）：手机 / 窄卡片默认。一次看一层，大行好点，面包屑和返回键退回上一层；
  //   · 导图（MemoryMap）：宽卡片默认。左右分枝的思维导图，可拖、可缩放、可展开收起。
  // 右上角可以切换，选择按「触屏 / 鼠标」各记一份。
  // 点一篇 = 卡片里打开现成的 md 查看器（阅读 / 编辑 / 源码，保存走 /api/file/save 带冲突校验；
  // 记忆目录当 ws 根，所以 [[双链]] 照样能跳）。预览实例 host='memory'，被 .mm-pv 的 transform 圈在卡片里。
  // Claude 写了记忆（fs 事件落在目录里）或关掉预览后，静默重读一遍。
  //
  // 记忆来源可切：Claude（上面这套，md 文件）/ dimensio（结构化记忆，lib/dimensioMemory.js 映射成同一张图：根 = 项目，
  // 第一层 = 待确认 / 被隔离 / 生效 / 已退场）。dimensio 的一条点开是 DimensioMemoryNote：确认 / 驳回 / 编辑都走 dimensio
  // 自己的接口与治理规则，不直接改它的文件。agent = 初始来源（dimensio 分页的工作区里挂这张卡时给 'dimensio'）；
  // theme = 嵌在 dimensio 里时跟它的明暗档（枝色亮度），不跟 bridge 全站主题。
  import { untrack } from 'svelte';
  import { api } from '../../lib/api.js';
  import { openPreview, closePreview, preview } from '../../lib/preview.svelte.js';
  import { fsChange } from '../../lib/fsSync.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { relTime } from '../../lib/format.js';
  import { buildIndex, searchNotes, pathText, nodeSub, typeLabel, branchMtime } from '../../lib/memoryTree.js';
  import MediaViewer from '../preview/MediaViewer.svelte';
  import MemoryOutline from './MemoryOutline.svelte';
  import MemoryMap from './MemoryMap.svelte';
  import { t, tc, tr } from '../../lib/i18n.js';
  import { screenOn } from '../../lib/state.svelte.js';
  import { dimensioGraph, dimensioRoots, bucketFor } from '../../lib/dimensioMemory.js';
  import { loadPage } from '../../modules/pages.js';   // DimensioMemoryNote 归 dimensio 扩展，经懒加载入口进来

  let { ws = '', agent = 'claude', theme = '' } = $props();

  // —— 来源：Claude / dimensio（两边都对这个身份开着才给切）——
  const canClaude = screenOn('claude');
  const canDim = screenOn('harness');
  let src = $state(agent === 'dimensio' && canDim ? 'dimensio' : canClaude ? 'claude' : canDim ? 'dimensio' : 'claude');
  const isDim = $derived(src === 'dimensio');
  let dnote = $state(null);      // 点开的那条 dimensio 记忆 { ws, id }
  let dimRoots = null;
  function setSrc(v) { menu = ''; if (v === src) return; src = v; pick = ''; data = null; roots = null; dimRoots = null; dnote = null; }
  const LANE = () => ({ proposed: t('待确认'), held: t('被隔离'), active: t('生效'), retired: t('已退场') });
  const TYPEL = () => ({ user: t('偏好'), feedback: t('做法'), project: t('项目'), reference: t('参考') });
  async function loadDim() {
    const ov = await api.get('/api/harness/api/memory/overview');
    dimRoots = dimensioRoots(ov);
    const b = pick ? (ov.buckets || []).find((x) => norm(x.ws) === norm(pick)) || null : bucketFor(ov, ws);
    const name = !b ? '' : b.kind === 'global' ? t('全局记忆') : b.name || '';
    return {
      dir: b?.ws || pick || ws, base: b?.kind === 'global' ? '' : b?.ws || ws, source: 'dimensio', name,
      exists: !!b?.items?.length, graph: b?.items?.length ? dimensioGraph(b.items, { root: name || tail(ws), lane: LANE(), type: TYPEL() }) : null,
    };
  }

  // —— 数据 ——
  let pick = $state('');         // '' = 跟当前会话的项目；否则 = 切换列表里点的那个记忆目录
  let data = $state(null);       // { dir, source, base, exists, graph }
  let loading = $state(true);
  let err = $state('');
  let seq = 0;
  async function load(quiet = false) {
    const my = ++seq;
    if (!quiet) { loading = true; err = ''; }
    try {
      const q = pick ? `dir=${encodeURIComponent(pick)}` : `ws=${encodeURIComponent(ws)}`;
      const d = isDim ? await loadDim() : await api.get(`/api/claude/memory?${q}`);
      if (my !== seq) return;
      data = d; err = '';
    } catch (e) {
      if (my !== seq) return;
      if (!quiet) { err = tr(e?.body?.error) || t('加载失败'); data = null; }
    }
    if (my === seq) loading = false;
  }
  $effect(() => { pick; ws; src; untrack(() => load()); });

  const graph = $derived(data?.graph || null);
  const dir = $derived(data?.dir || '');
  const files = $derived(graph?.files || {});
  const index = $derived(buildIndex(graph));

  // Claude 写了记忆：目录下有文件变了就静默重读（连着几次 Edit 只读最后一拍）
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  let fsSeen = fsChange.seq, fsT = 0;
  $effect(() => {
    const s = fsChange.seq;
    if (s === fsSeen) return;
    fsSeen = s;
    const d = norm(untrack(() => dir));
    if (untrack(() => isDim) || !d || !norm(fsChange.path).startsWith(d + '/')) return;
    clearTimeout(fsT);
    fsT = setTimeout(() => load(true), 600);
  });
  const pvOn = $derived(preview.open && preview.host === 'memory');
  let pvWas = false;
  $effect(() => { const on = pvOn; if (pvWas && !on) untrack(() => load(true)); pvWas = on; });
  $effect(() => () => { clearTimeout(fsT); if (preview.open && preview.host === 'memory') closePreview(); });
  // 返回键先关卡片里的预览（预览层登记得最晚，压在逐层视图的「退一层」与工作台 sheet 之上）
  $effect(() => { if (pvOn) return pushBackLayer(closePreview); });
  $effect(() => { if (dnote) return pushBackLayer(() => { dnote = null; }); });
  const pvRel = $derived.by(() => {
    if (!pvOn) return '';
    const cur = preview.items[preview.index];
    return cur?.saveTarget?.ws && norm(cur.saveTarget.ws) === norm(dir) ? cur.saveTarget.rel : '';
  });

  // —— 名字：项目名（切换列表里点进来的用列表里的名字）——
  const tail = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const parentOf = (p) => { const parts = String(p || '').split(/[\\/]/).filter(Boolean); parts.pop(); return parts.join('/') || '/'; };
  let roots = $state(null);
  const rootName = (r) => r.name || (r.quick ? t('临时对话') : r.key ? r.key.replace(/^([A-Za-z])--/, '$1:/').replace(/-/g, ' ').trim() : tail(r.dir));
  const projName = $derived.by(() => {
    if (isDim) return data?.name || tail(pick || ws) || 'dimensio';
    if (pick) { const r = roots?.find((x) => norm(x.dir) === norm(pick)); return r ? rootName(r) : tail(tail(pick) === 'memory' ? pick.replace(/[\\/]memory[\\/]?$/i, '') : pick); }
    const base = data?.base || ws;
    if (/[\\/]\.bridge-quickchat[\\/]/i.test(base)) return t('临时对话');
    return tail(base) || tc('claude', '记忆');
  });

  // —— 视图：逐层 / 导图（按触屏、鼠标各记一份；没选过就按卡片宽度定）——
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const VIEW_LS = 'bridge.memory.view.' + (coarse ? 'touch' : 'mouse');
  let rootEl = $state();
  let cardW = $state(0);
  $effect(() => {
    if (!rootEl) return;
    const ro = new ResizeObserver(() => { cardW = rootEl.clientWidth; });
    ro.observe(rootEl);
    cardW = rootEl.clientWidth;
    return () => ro.disconnect();
  });
  let viewPref = $state((() => { try { return localStorage.getItem(VIEW_LS) || ''; } catch { return ''; } })());
  const view = $derived(viewPref || (!coarse && cardW >= 560 ? 'map' : 'outline'));
  function setView(v) { viewPref = v; try { localStorage.setItem(VIEW_LS, v); } catch {} }
  let level = $state('');
  let mapRef = $state();
  $effect(() => { dir; untrack(() => { level = ''; }); });

  // —— 打开一篇（画廊顺序 = 导图顺序，查看器里能左右翻）——
  function openNote(n) {
    if (!n || n.kind !== 'file') return;
    if (isDim) { dnote = { ws: dir, id: n.ref }; return; }
    const list = index.order;
    const i = Math.max(0, list.findIndex((x) => x.id === n.id));
    openPreview(list.map((x) => ({ origin: 'cloud', rel: x.ref, ws: dir, name: x.ref.split('/').pop(), mt: files[x.ref]?.mtime || 0 })), i, { host: 'memory' });
  }

  // —— 搜索层 ——
  let searching = $state(false);
  let q = $state('');
  let filter = $state('');
  let qEl = $state();
  const results = $derived(searching && graph ? searchNotes(q, index, files, filter) : []);
  function openSearch(f = '') { filter = f; searching = true; queueMicrotask(() => { if (!coarse || !f) qEl?.focus(); }); }
  function closeSearch() { searching = false; q = ''; filter = ''; }
  $effect(() => { if (searching) return pushBackLayer(closeSearch); });

  // —— 菜单（切换记忆目录 / ⋯）——
  let menu = $state('');           // '' | 'roots' | 'more'
  let rootsErr = $state('');
  async function openRoots() {
    menu = menu === 'roots' ? '' : 'roots';
    if (menu !== 'roots' || roots) return;
    try {
      if (isDim) roots = dimRoots || dimensioRoots(await api.get('/api/harness/api/memory/overview'));
      else roots = (await api.get('/api/claude/memory/roots')).roots || [];
    }
    catch (e) { rootsErr = tr(e?.body?.error) || t('加载失败'); }
  }
  function choose(d) { menu = ''; if ((d || '') !== pick) { pick = d || ''; data = null; } }
  let headEl = $state();
  $effect(() => {
    if (!menu) return;
    const down = (e) => { if (headEl && !headEl.contains(e.target)) menu = ''; };
    window.addEventListener('pointerdown', down, true);
    const off = pushBackLayer(() => { menu = ''; });
    return () => { window.removeEventListener('pointerdown', down, true); off(); };
  });
  let copied = $state(false);
  async function copyDir() {
    menu = '';
    try { await navigator.clipboard.writeText(dir); copied = true; setTimeout(() => { copied = false; }, 1600); } catch {}
  }
  const SOURCE = { local: '.claude/settings.local.json', project: '.claude/settings.json', user: tc('claude', '用户设置') };

  const stats = $derived(graph?.stats || {});
  const noteCount = $derived(index.info.get(index.rootId)?.count || 0);   // 不含总索引自己，两种看法一致
  const latest = $derived(graph ? branchMtime(graph.tree, files) : 0);
  const rootIsFile = $derived(graph?.tree.kind === 'file');
</script>

<div class="mm" class:th-light={theme === 'light'} class:th-dark={theme === 'dark'} bind:this={rootEl}>
  <header class="mm-head" bind:this={headEl}>
    <button class="mm-name" class:on={menu === 'roots'} aria-haspopup="menu" aria-expanded={menu === 'roots'} title={dir} onclick={openRoots}>
      <span class="mm-name-t">{projName}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5"/></svg>
      {#if graph && view === 'map'}<span class="mm-name-s">{t('{n} 篇', { n: noteCount }) + (latest ? ' · ' + relTime(latest) : '')}</span>{/if}
    </button>
    <span class="mm-sp"></span>
    {#if graph}
      <button class="mm-ib" aria-label={tc('claude', '搜索记忆')} title={tc('claude', '搜索记忆')} onclick={() => openSearch()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>
      </button>
      <div class="mm-seg" role="radiogroup" aria-label={tc('claude', '看法')}>
        <button role="radio" aria-checked={view === 'outline'} class:on={view === 'outline'} title={tc('claude', '逐层')} aria-label={tc('claude', '逐层')} onclick={() => setView('outline')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5v14M5 8h3M5 13h3M5 18h3"/><path d="M11 8h8M11 13h8M11 18h6"/></svg>
        </button>
        <button role="radio" aria-checked={view === 'map'} class:on={view === 'map'} title={tc('claude', '导图')} aria-label={tc('claude', '导图')} onclick={() => setView('map')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="10" width="6" height="4" rx="2"/><path d="M15 12c2 0 2-5 4-5h1M15 12c2 0 2 5 4 5h1M9 12c-2 0-2-5-4-5H4M9 12c-2 0-2 5-4 5H4"/></svg>
        </button>
      </div>
    {/if}
    <button class="mm-ib" class:on={menu === 'more'} aria-label={t('更多')} title={t('更多')} aria-haspopup="menu" aria-expanded={menu === 'more'} onclick={() => { menu = menu === 'more' ? '' : 'more'; }}>
      <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>
    </button>

    {#if menu === 'roots'}
      <div class="mm-menu left" role="menu">
        {#if canClaude && canDim}
          <div class="mm-menu-h">{t('记忆来自')}</div>
          <div class="mm-src" role="radiogroup" aria-label={t('记忆来自')}>
            <button role="radio" aria-checked={!isDim} class:on={!isDim} onclick={() => setSrc('claude')}>Claude</button>
            <button role="radio" aria-checked={isDim} class:on={isDim} onclick={() => setSrc('dimensio')}>dimensio</button>
          </div>
          <div class="mm-sep"></div>
        {/if}
        <div class="mm-menu-h">{tc('claude', '看哪个项目的记忆')}</div>
        <button class="mm-mi" role="menuitemradio" aria-checked={!pick} onclick={() => choose('')}>
          <span class="mm-mi-t">{tc('claude', '当前对话所在项目')}</span>
          <span class="mm-mi-s">{isDim ? t('dimensio 在这个项目里记下的（按项目隔离）') : tc('claude', '与 Claude Code 读写的是同一个目录')}</span>
          {#if !pick}<svg class="mm-ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>{/if}
        </button>
        <div class="mm-sep"></div>
        {#if roots}
          {#each roots as r (r.dir)}
            <button class="mm-mi" role="menuitemradio" aria-checked={norm(pick) === norm(r.dir)} title={r.dir} onclick={() => choose(r.dir)}>
              <span class="mm-mi-t">{r.kind === 'global' ? t('全局记忆') : rootName(r)}</span>
              <span class="mm-mi-s">{#if r.project}{parentOf(r.project) + ' · '}{/if}{t('{n} 篇', { n: r.count })} · {relTime(r.mtime)}{r.source ? ' · ' + (SOURCE[r.source] || r.source) : ''}</span>
              {#if norm(pick) === norm(r.dir)}<svg class="mm-ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>{/if}
            </button>
          {:else}
            <div class="mm-mi-empty">{tc('claude', '这台机器上还没有别的记忆')}</div>
          {/each}
        {:else}
          <div class="mm-mi-empty">{rootsErr || t('加载中…')}</div>
        {/if}
      </div>
    {:else if menu === 'more'}
      <div class="mm-menu right" role="menu">
        {#if rootIsFile}
          <button class="mm-mi row" role="menuitem" onclick={() => { menu = ''; openNote(graph.tree); }}>{tc('claude', '打开总索引')}</button>
        {/if}
        {#if graph && view === 'map'}
          <button class="mm-mi row" role="menuitem" onclick={() => { menu = ''; mapRef?.setAll(true); }}>{t('全部展开')}</button>
          <button class="mm-mi row" role="menuitem" onclick={() => { menu = ''; mapRef?.setAll(false); }}>{t('全部收起')}</button>
        {/if}
        {#if graph && (stats.dead || stats.unindexed)}
          <button class="mm-mi row" role="menuitem" onclick={() => { menu = ''; openSearch(stats.dead ? 'dead' : 'loose'); }}>{tc('claude', '检查死链与未索引')}</button>
        {/if}
        <button class="mm-mi row" role="menuitem" onclick={() => { menu = ''; load(!!data); }}>{t('刷新')}</button>
        {#if dir && !isDim}
          <div class="mm-sep"></div>
          <button class="mm-mi" role="menuitem" onclick={copyDir}>
            <span class="mm-mi-t">{tc('claude', '复制记忆目录路径')}</span>
            <span class="mm-mi-s mono">{dir}</span>
            {#if data?.source && SOURCE[data.source]}<span class="mm-mi-s">{tc('claude', '由 {src} 指定', { src: SOURCE[data.source] })}</span>{/if}
          </button>
        {/if}
      </div>
    {/if}
  </header>

  <div class="mm-body">
    {#if graph}
      {#if view === 'map'}
        <MemoryMap bind:this={mapRef} {graph} {index} {files} rootName={projName} storeKey={dir.toLowerCase()} current={pvRel} onopen={openNote} />
      {:else}
        <MemoryOutline {graph} {index} {files} rootName={projName} bind:level onopen={openNote} onissues={(f) => openSearch(f)} />
      {/if}
    {:else if loading}
      <div class="mm-msg"><span class="mm-spin"></span></div>
    {:else if err}
      <div class="mm-msg">
        <span>{err}</span>
        <button class="mm-pill" onclick={() => load()}>{t('重试')}</button>
      </div>
    {:else if data && !data.exists}
      <div class="mm-msg">
        <svg class="mm-glyph" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="13" cy="24" r="5"/><circle cx="36" cy="12" r="4"/><circle cx="36" cy="24" r="4"/><circle cx="36" cy="36" r="4" stroke-dasharray="2.5 3"/><path d="M18 24h14M17 21c5-1 7-9 15-9M17 27c5 1 7 9 15 9"/></svg>
        {#if isDim}
          <b>{t('这个项目还没有 dimensio 记忆')}</b>
          <span>{t('dimensio 记下第一条后，这里会出现')}</span>
        {:else}
          <b>{tc('claude', '这个项目还没有 Claude 记忆')}</b>
          <span>{tc('claude', 'Claude 记下第一条后，这里会自动出现')}</span>
          <span class="mm-path">{data.dir}</span>
        {/if}
      </div>
    {/if}
  </div>

  {#if searching}
    <div class="mm-search">
      <div class="mm-sbar">
        <button class="mm-ib" aria-label={t('返回')} onclick={closeSearch}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
        </button>
        <label class="mm-q">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>
          <input bind:this={qEl} type="search" enterkeyhint="search" placeholder={tc('claude', '搜索记忆')} bind:value={q}
            onkeydown={(e) => { if (e.key === 'Escape') closeSearch(); else if (e.key === 'Enter' && results[0]) openNote(results[0]); }} />
        </label>
      </div>
      <div class="mm-chips">
        <button class:on={!filter} onclick={() => { filter = ''; }}>{t('全部')}</button>
        {#if stats.dead}<button class:on={filter === 'dead'} class="bad" onclick={() => { filter = filter === 'dead' ? '' : 'dead'; }}>{tc('claude', '死链 {n}', { n: stats.dead })}</button>{/if}
        {#if stats.unindexed}<button class:on={filter === 'loose'} onclick={() => { filter = filter === 'loose' ? '' : 'loose'; }}>{tc('claude', '未索引 {n}', { n: stats.unindexed })}</button>{/if}
      </div>
      <div class="mm-res">
        {#if !q.trim() && !filter}<div class="mm-res-h">{tc('claude', '最近更新')}</div>{/if}
        {#each results as n (n.id)}
          {@const m = files[n.ref]}
          {@const h = index.info.get(n.id)?.hue}
          <button class="mm-r" style={h != null ? `--h:${h}` : ''} class:neutral={h == null} onclick={() => openNote(n)}>
            <span class="mm-r-dot"></span>
            <span class="mm-r-main">
              <span class="mm-r-t">{m.label}</span>
              {#if pathText(index, n.id, files, projName)}<span class="mm-r-p">{pathText(index, n.id, files, projName)}</span>{/if}
              {#if nodeSub(n, files)}<span class="mm-r-s">{nodeSub(n, files)}</span>{/if}
              {#if filter === 'dead' && m.dead.length}<span class="mm-r-bad">{t('死链：{list}', { list: m.dead.join('、') })}</span>{/if}
            </span>
            <span class="mm-r-side">
              <span>{relTime(m.mtime)}</span>
              {#if m.type}<span class="mm-r-type">{typeLabel(m.type)}</span>{/if}
            </span>
          </button>
        {:else}
          <div class="mm-msg small">{tc('claude', '没有找到相关的记忆')}</div>
        {/each}
      </div>
    </div>
  {/if}

  {#if copied}<div class="mm-toast">{t('已复制')}</div>{/if}

  <!-- 卡片内的预览实例：transform 把 MediaViewer 的 fixed 根圈进来 -->
  <div class="mm-pv" class:on={pvOn}><MediaViewer host="memory" /></div>
  {#if dnote}
    {#await loadPage.dimensioMemoryNote() then mod}
      {@const DimensioMemoryNote = mod.default}
      <div class="mm-dn"><DimensioMemoryNote ws={dnote.ws} id={dnote.id} onclose={() => { dnote = null; }} onchanged={() => load(true)} /></div>
    {/await}
  {/if}
</div>

<style>
  /* 枝色：OKLCH 同亮度同饱和度、只换色相，深浅主题各一组（见 lib/memoryTree.js HUES） */
  .mm { --mm-l: .76; --mm-c: .105; --mm-neutral: color-mix(in srgb, var(--muted) 75%, transparent);
    position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  :global(html[data-theme="light"]) .mm, .mm.th-light { --mm-l: .57; --mm-c: .12; }
  .mm.th-dark { --mm-l: .76; --mm-c: .105; }

  /* —— 顶栏：项目名（点开切换）+ 篇数；右边搜索、看法切换、⋯ —— */
  .mm-head { position: relative; flex: none; display: flex; align-items: center; gap: 2px; padding: 0 8px 8px 6px; z-index: 20; }
  .mm-name { min-width: 0; display: grid; grid-template-columns: auto auto; grid-template-rows: auto auto; align-items: center; column-gap: 3px;
    padding: 3px 8px 4px 8px; border-radius: 10px; text-align: left; color: var(--text); }
  .mm-name.on, .mm-name:active { background: var(--hover-strong); }
  @media (hover: hover) { .mm-name:hover { background: var(--hover); } }
  .mm-name-t { font-size: 14.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .mm-name svg { width: 15px; height: 15px; color: var(--muted); }
  .mm-name-s { grid-column: 1 / -1; font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mm-sp { flex: 1; }
  .mm-ib { flex: none; width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: var(--serif); }
  .mm-ib svg { width: 18px; height: 18px; }
  .mm-ib.on, .mm-ib:active { background: var(--hover-strong); color: var(--text); }
  @media (hover: hover) { .mm-ib:hover { background: var(--hover); color: var(--text); } }
  .mm-seg { flex: none; display: flex; padding: 2px; margin: 0 2px; border-radius: 10px; background: color-mix(in srgb, var(--text) 6%, transparent); }
  .mm-seg button { width: 32px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--muted); }
  .mm-seg button svg { width: 17px; height: 17px; }
  .mm-seg button.on { color: var(--text); background: var(--bg); box-shadow: 0 1px 3px rgba(0, 0, 0, .14), inset 0 0 0 .5px var(--divider); }
  @media (pointer: coarse) {
    .mm-ib { width: 38px; height: 38px; }
    .mm-seg button { width: 36px; height: 32px; }
    .mm-name-t { font-size: 15.5px; }
  }

  .mm-menu { position: absolute; top: calc(100% - 4px); z-index: 30; width: min(320px, calc(100% - 16px)); max-height: min(440px, 70vh); overflow-y: auto;
    padding: 5px; border-radius: 13px; background: var(--q-card); box-shadow: 0 12px 34px rgba(0, 0, 0, .24), var(--q-shadow, 0 0 0 .5px var(--divider)); animation: mmIn .14s ease; }
  .mm-menu.left { left: 6px; } .mm-menu.right { right: 8px; width: min(280px, calc(100% - 16px)); }
  @keyframes mmIn { from { opacity: 0; transform: translateY(-4px); } }
  .mm-menu-h { padding: 6px 10px 4px; font-size: 11.5px; color: var(--muted); }
  .mm-mi { position: relative; width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 30px 7px 10px; border-radius: 9px; text-align: left; color: var(--text); }
  .mm-mi.row { min-height: 36px; justify-content: center; font-size: 13.5px; }
  .mm-mi:active { background: var(--hover-strong); }
  @media (hover: hover) { .mm-mi:hover { background: var(--hover); } }
  @media (pointer: coarse) { .mm-mi { padding-top: 10px; padding-bottom: 10px; } .mm-mi.row { min-height: 44px; } }
  .mm-mi-t { font-size: 13.5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mm-mi-s { font-size: 11.5px; color: var(--muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mm-mi-s.mono { font-family: Consolas, 'Cascadia Mono', Menlo, monospace; font-size: 11px; white-space: normal; word-break: break-all; }
  .mm-ck { position: absolute; right: 10px; top: 50%; width: 16px; height: 16px; transform: translateY(-50%); color: var(--text); }
  .mm-sep { height: 1px; margin: 4px 8px; background: var(--divider); }
  .mm-mi-empty { padding: 10px; font-size: 12.5px; color: var(--muted); }

  .mm-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--dk-line, var(--divider)); }

  .mm-msg { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 0 28px;
    color: var(--muted); font-size: 13.5px; text-align: center; line-height: 1.6; }
  .mm-msg.small { position: static; padding: 36px 16px; }
  .mm-msg b { color: var(--text); font-weight: 600; font-size: 15px; }
  .mm-glyph { width: 52px; height: 52px; color: var(--muted); opacity: .8; margin-bottom: 4px; }
  .mm-path { margin-top: 6px; font-family: Consolas, 'Cascadia Mono', Menlo, monospace; font-size: 11px; word-break: break-all; opacity: .8; user-select: text; }
  .mm-pill { margin-top: 2px; height: 32px; padding: 0 16px; border-radius: 999px; color: var(--text); background: var(--hover-strong); }
  .mm-spin { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--divider); border-top-color: var(--muted); animation: mmSpin .8s linear infinite; }
  @keyframes mmSpin { to { transform: rotate(360deg); } }

  /* —— 搜索层：盖住整张卡（顶栏换成搜索条）—— */
  .mm-search { position: absolute; inset: 0; z-index: 25; display: flex; flex-direction: column; background: var(--bg); animation: mmFade .16s ease; }
  @keyframes mmFade { from { opacity: 0; } }
  .mm-sbar { flex: none; display: flex; align-items: center; gap: 4px; padding: 0 10px 8px 4px; }
  .mm-q { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; height: 36px; padding: 0 11px; border-radius: 11px;
    background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--muted); }
  .mm-q svg { width: 15px; height: 15px; flex: none; }
  .mm-q input { flex: 1; min-width: 0; width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 14px; }
  .mm-chips { flex: none; display: flex; gap: 6px; padding: 0 12px 8px; overflow-x: auto; scrollbar-width: none; }
  .mm-chips button { flex: none; height: 28px; padding: 0 12px; border-radius: 999px; font-size: 12.5px; color: var(--serif); box-shadow: inset 0 0 0 1px var(--divider); }
  .mm-chips button.on { color: var(--bg); background: var(--text); box-shadow: none; }
  .mm-chips button.bad:not(.on) { color: var(--crit); }
  .mm-res { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 20px; border-top: 1px solid var(--dk-line, var(--divider)); overscroll-behavior: contain; }
  .mm-res-h { padding: 12px 8px 4px; font-size: 11.5px; color: var(--muted); }
  .mm-r { --c: oklch(var(--mm-l) var(--mm-c) var(--h, 60)); width: 100%; display: flex; align-items: flex-start; gap: 10px; padding: 10px 8px; border-radius: 11px; text-align: left; color: var(--text); }
  .mm-r.neutral { --c: var(--mm-neutral); }
  .mm-r:active { background: var(--hover-strong); }
  @media (hover: hover) { .mm-r:hover { background: var(--hover); } }
  .mm-r-dot { flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--c); }
  .mm-r-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .mm-r-t { font-size: 14px; font-weight: 500; line-height: 1.35; }
  .mm-r-p { font-size: 11.5px; color: var(--c); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mm-r-s { font-size: 12.5px; color: var(--muted); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .mm-r-bad { font-size: 12px; color: var(--crit); }
  .mm-r-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; font-size: 11.5px; color: var(--muted); padding-top: 1px; }
  .mm-r-type { font-size: 10.5px; padding: 1px 6px; border-radius: 5px; box-shadow: inset 0 0 0 1px var(--divider); }

  .mm-toast { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 40; padding: 7px 14px; border-radius: 999px;
    font-size: 12.5px; color: var(--bg); background: var(--text); animation: mmIn .14s ease; }

  /* 预览：盖满整张卡（transform 造 containing block，查看器的 fixed 根被圈在这里） */
  .mm-pv { position: absolute; inset: 0; transform: translateZ(0); pointer-events: none; z-index: 50; }
  .mm-pv.on { pointer-events: auto; }
  .mm-dn { position: absolute; inset: 0; z-index: 50; }
  /* 来源切换：菜单里的第一节，两段 */
  .mm-src { display: flex; gap: 2px; margin: 2px 6px 4px; padding: 2px; border-radius: 10px; background: color-mix(in srgb, var(--text) 6%, transparent); }
  .mm-src button { flex: 1; height: 30px; border-radius: 8px; font-size: 13px; color: var(--muted); }
  .mm-src button.on { color: var(--text); background: var(--bg); box-shadow: 0 1px 3px rgba(0, 0, 0, .14), inset 0 0 0 .5px var(--divider); }
  @media (pointer: coarse) { .mm-src button { height: 36px; } }
</style>
