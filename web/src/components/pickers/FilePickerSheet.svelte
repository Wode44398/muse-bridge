<script module>
  // 记住上次停在的文件夹（同一页面生命周期内）：连着给插件选几次文件，不用每次都从根往下点
  let memoDir = '';
</script>

<script>
  // 插件页面的文件选择器（界面层；数据与入口在 lib/filePicker.svelte.js 的 pickFiles）。
  //
  // 新做的轻量选择器，不复用 FilesPanel（那是整页文件管理，带上传 / 多端位置 / 拖放，嵌不进一个弹层）：
  // 只浏览这个身份的文件根（GET /api/files，不带 ws——直接走 HTTP，不走桌面壳的原生目录通道，rel 口径与服务端签句柄一致），
  // 面包屑逐级返回；文件夹可进不可选；不符合 accept 的文件变灰不可点；显示大小；多选时跨文件夹记住已选，最多 20 个。
  // 两种出场：触屏 / 窄屏 → ios27 表单页（Sheet）；宽屏鼠标 → 屏幕正中的扁平面板（墨与象牙，同应用内弹窗）。
  // 层级 3400：盖过插件应用页、设置与菜单，低于应用内弹窗 3500 与授权框 3600。
  // 取消：✕ / 点遮罩 / 下滑 / Esc / 系统返回 → null。
  import { onDestroy, setContext, untrack, tick } from 'svelte';
  import Sheet from '../ios27/Sheet.svelte';
  import '../ios27/ink.css';
  import { filePickHost, activeFilePick, settleFilePick, FILE_PICK_MAX } from '../../lib/filePicker.svelte.js';
  import { aboveOpen, OTHER_LAYERS } from '../../lib/pickerLane.svelte.js';
  import { acceptMatcher, mimeOfName, fmtBytes, crumbsOf, joinRel, parentRel } from '../../lib/pickerCore.js';
  import { api } from '../../lib/api.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { pushNativeOverlay } from '../../lib/nativeDesktop.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  // —— 认领：只有第一个实例干活 ——
  const self = {};
  const owner = !filePickHost.owner;
  if (owner) { filePickHost.owner = self; filePickHost.ready = true; }
  onDestroy(() => {
    if (filePickHost.owner !== self) return;
    filePickHost.owner = null;
    filePickHost.ready = false;
  });

  // —— 环境：触屏与否、窗口宽度、明暗（读 <html data-theme>，SoloPage 这类入口没有完整的 ui 状态）——
  const mqCoarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
  let coarse = $state(!!mqCoarse?.matches);
  let vw = $state(typeof innerWidth === 'number' ? innerWidth : 390);
  const readDark = () => typeof document === 'undefined' || document.documentElement.dataset.theme !== 'light';
  let dark = $state(readDark());
  $effect(() => {
    const onMq = () => { coarse = !!mqCoarse?.matches; };
    const onR = () => { vw = innerWidth; };
    mqCoarse?.addEventListener?.('change', onMq);
    window.addEventListener('resize', onR);
    let mo = null;
    try {
      mo = new MutationObserver(() => { dark = readDark(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch {}
    return () => { mqCoarse?.removeEventListener?.('change', onMq); window.removeEventListener('resize', onR); mo?.disconnect(); };
  });
  setContext('ios27', { get dark() { return dark; }, ink: true });

  const cur = $derived(owner ? activeFilePick() : null);
  const mode = $derived(coarse || vw < 700 ? 'sheet' : 'panel');
  const heading = $derived(cur ? cur.title || (cur.multiple ? t('选择文件（可多选）') : t('选择一个文件')) : '');
  const match = $derived(cur ? acceptMatcher(cur.accept) : () => true);

  // —— 目录状态 ——
  let dir = $state('');
  let items = $state([]);
  let loading = $state(false);
  let error = $state('');
  let truncated = $state(false);
  let total = $state(0);
  let picked = $state({});   // rel → { rel, name, size }（多选，跨文件夹保留）
  let showHidden = false;
  let loadSeq = 0;
  let listEl = $state(null);
  const count = $derived(Object.keys(picked).length);
  const crumbs = $derived(crumbsOf(dir));

  // 隐藏项（. 开头）默认收起，口径同文件分页（它的开关存在 bridge.files.showHidden）；整个目录全是隐藏项时照常列出
  const visible = $derived.by(() => {
    if (showHidden) return items;
    const plain = items.filter((it) => !String(it.name).startsWith('.'));
    return plain.length ? plain : items;
  });

  async function load(to, { fallback = false } = {}) {
    const my = ++loadSeq;
    loading = true;
    error = '';
    try {
      const r = await api.get('/api/files?path=' + encodeURIComponent(to));
      if (my !== loadSeq) return;
      if (r && typeof r === 'object' && r.error) throw Object.assign(new Error('list'), { body: r });
      items = Array.isArray(r?.items) ? r.items.filter((it) => it && typeof it.name === 'string' && it.name) : [];
      truncated = !!r?.truncated;
      total = Number(r?.total) || items.length;
      dir = typeof r?.path === 'string' ? r.path : to;
      await tick();
      if (listEl) listEl.scrollTop = 0;
      refocus();
    } catch (e) {
      if (my !== loadSeq) return;
      // 记住的那个文件夹没了（被删 / 改名）：回到根，别让人对着一句报错
      if (fallback && to) { loading = false; return load(''); }
      const raw = e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '';
      error = tr(String(raw || '')).slice(0, 200) || (e?.status ? t('服务器返回 {code}', { code: e.status }) : t('网络连接失败'));
      items = []; truncated = false; total = 0;
      dir = to;
    } finally {
      if (my === loadSeq) loading = false;
    }
    if (my === loadSeq && error) { await tick(); refocus(); }
  }

  // 每来一个新请求：清掉上一次的勾选，从记住的文件夹开始
  $effect(() => {
    const r = cur;
    if (!r) return;
    untrack(() => {
      picked = {};
      shownAt = performance.now();
      try { showHidden = localStorage.getItem('bridge.files.showHidden') === '1'; } catch { showHidden = false; }
      load(memoDir, { fallback: true });
    });
  });

  // —— 动作 ——
  const relOf = (it) => joinRel(dir, it.name);
  function go(to) { if (!loading || to !== dir) load(to); }
  function cancel(id) { memoDir = dir; settleFilePick(id, null); }
  function choose(it) {
    const r = cur;
    if (!r || it.isDir || !match(it.name)) return;
    const rel = relOf(it);
    const item = { rel, name: it.name, size: Number(it.size) || 0 };
    if (!r.multiple) { memoDir = dir; settleFilePick(r.id, [item]); return; }
    if (picked[rel]) { const { [rel]: _drop, ...rest } = picked; picked = rest; return; }
    if (count >= FILE_PICK_MAX) { showToast(t('一次最多选 {n} 个文件', { n: FILE_PICK_MAX }), 'err'); return; }
    picked = { ...picked, [rel]: item };
  }
  function confirm() {
    const r = cur;
    if (!r || !count) return;
    memoDir = dir;
    settleFilePick(r.id, Object.values(picked));
  }
  function rowClick(it) { if (it.isDir) go(relOf(it)); else choose(it); }

  // 系统返回 = 取消（返回键＝取消，不做逐级返回——逐级走面包屑）
  $effect(() => {
    const r = cur;
    if (!r) return;
    const id = r.id;
    return pushBackLayer(() => { cancel(id); });
  });
  $effect(() => { if (cur) return pushNativeOverlay(); });

  // —— 焦点：开出来落到第一行；被挪到框外时拉回（应用内弹窗、授权框开着时让给它们）——
  let rootEl = $state(null);
  function focusFirst() {
    // 表单页（触屏）只聚焦整层本身（tabindex=-1、不画框）：触屏上程序化聚焦按钮 / 行会亮起 :focus-visible 的橙圈，
    // 而焦点仍得在层里，否则返回键之外的键盘 / 读屏会走进底下的页面。
    // 宽屏面板落到第一行；列表还没到时先落在面板本身（tabindex=-1），别让焦点留在 body——那样 Tab 会走进底下的页面
    const b = mode === 'sheet' ? rootEl
      : (rootEl?.querySelector('.fp-row:not(:disabled)') || rootEl?.querySelector('[data-fp-focus]') || rootEl?.querySelector('.fp-box'));
    try { b?.focus({ preventScroll: true }); } catch {}
  }
  // 列表换完：焦点若还停在占位处（面板本身），或点中的那一行随旧列表被换掉、焦点掉回了 body，落到新列表第一行
  function refocus() {
    if (!cur || !rootEl || aboveOpen()) return;
    const a = document.activeElement;
    if (!a || a === document.body || a === rootEl.querySelector('.fp-box')) focusFirst();
  }
  $effect(() => {
    const r = cur;
    void mode;
    if (!r) return;
    requestAnimationFrame(() => { if (cur === r && !aboveOpen()) untrack(focusFirst); });
  });
  // 陷阱只往上让：层级 选择器 3400 < 应用内弹窗 3500 < 授权框 3600。上面的层开着、或焦点落进了别的弹层，都不拉——
  // 应用内弹窗自己的陷阱谁都不让，这边再拉回来就会在 focusin 里同步嵌套着互相抢，直到栈溢出。
  // pulling 防重入：拉回那一下的 focus() 会同步嵌套触发 focusin
  $effect(() => {
    if (!cur) return;
    let pulling = false;
    const onIn = (e) => {
      if (pulling || !rootEl || aboveOpen()) return;
      const el = e.target instanceof Node ? e.target : null;
      if (el && rootEl.contains(el)) return;
      if (el instanceof Element && el.closest(OTHER_LAYERS)) return;
      pulling = true;
      try { focusFirst(); } finally { pulling = false; }
    };
    document.addEventListener('focusin', onIn, true);
    return () => document.removeEventListener('focusin', onIn, true);
  });

  // 面板里的键盘：上下键在行间移动，退格回上一级（焦点不在输入框里时）
  function onPanelKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = [...(rootEl?.querySelectorAll('.fp-row:not(:disabled)') || [])];
      if (!rows.length) return;
      e.preventDefault();
      const at = rows.indexOf(document.activeElement);
      const next = at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      rows[next].focus({ preventScroll: false });
      return;
    }
    if (e.key === 'Backspace' && dir && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      go(parentRel(dir));
    }
  }

  // —— 指针防误触：刚弹出来的一小段时间里的按下不算（触屏补发的兼容 click 落在新画的行上会替人选中）——
  const GUARD_MS = 300;
  let shownAt = -Infinity;
  let swallow = false;
  let downOnDim = false;
  function onRootDown(e) {
    swallow = performance.now() - shownAt < GUARD_MS;
    if (swallow) { e.stopPropagation(); return; }
    downOnDim = e.target instanceof Element && e.target.classList.contains('fp-dim');
  }
  function onRootClick(e) {
    if (!swallow || !(e.detail > 0)) return;
    swallow = false;
    e.preventDefault();
    e.stopPropagation();
  }
  function dimClick(id) { const ok = downOnDim; downOnDim = false; if (ok) cancel(id); }

  function kindOf(name) {
    const m = mimeOfName(name);
    if (m.startsWith('image/')) return 'img';
    if (m.startsWith('audio/') || m.startsWith('video/')) return 'media';
    return 'doc';
  }
</script>

{#snippet glyph(kind)}
  {#if kind === 'dir'}
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.2 7.4c0-1.1.9-1.9 1.9-1.9h3.7c.5 0 1 .2 1.4.6l1.3 1.4h7.4c1.1 0 1.9.9 1.9 1.9v8.4c0 1.1-.9 1.9-1.9 1.9H5.1c-1.1 0-1.9-.9-1.9-1.9V7.4Z" opacity=".9" /></svg>
  {:else if kind === 'img'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="3.8" y="4.8" width="16.4" height="14.4" rx="2.4" /><circle cx="9" cy="10" r="1.5" /><path d="m4.4 17.2 4.6-4.4 3.4 3 2.6-2.2 4.6 4" /></svg>
  {:else if kind === 'media'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="3.8" y="4.8" width="16.4" height="14.4" rx="2.4" /><path d="M10.2 9.2v5.6l4.6-2.8-4.6-2.8Z" /></svg>
  {:else}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M7 3.6h6.4l4.6 4.6v11.2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V4.6c0-.6.4-1 1-1Z" /><path d="M13.2 3.8v4.6h4.6" /></svg>
  {/if}
{/snippet}

{#snippet browser(r)}
  <nav class="fp-crumbs" aria-label={t('位置')}>
    {#if crumbs.length}
      <button type="button" class="fp-crumb" onclick={() => go('')}>{t('工作空间')}</button>
    {:else}
      <span class="fp-crumb here" aria-current="page">{t('工作空间')}</span>
    {/if}
    {#each crumbs as c, i (c.rel)}
      <span class="fp-sep" aria-hidden="true">›</span>
      {#if i < crumbs.length - 1}
        <button type="button" class="fp-crumb" onclick={() => go(c.rel)}>{c.name}</button>
      {:else}
        <span class="fp-crumb here" aria-current="page">{c.name}</span>
      {/if}
    {/each}
  </nav>
  {#if r.multiple}
    <div class="fp-count" aria-live="polite">{count ? t('已选 {n} 个', { n: count }) : t('最多选 {n} 个', { n: FILE_PICK_MAX })}</div>
  {/if}
  <div class="fp-list" class:busy={loading && items.length} bind:this={listEl}>
    {#if error}
      <div class="fp-state">
        <p>{error}</p>
        <button type="button" class="fp-retry" data-fp-focus onclick={() => load(dir)}>{t('重试')}</button>
      </div>
    {:else if loading && !items.length}
      <div class="fp-state"><p>{t('加载中…')}</p></div>
    {:else if !visible.length}
      <div class="fp-state"><p>{crumbs.length ? t('这个文件夹是空的') : t('这里还没有文件')}</p></div>
    {:else}
      {#each visible as it (it.name)}
        {#if it.isDir}
          <button type="button" class="fp-row" onclick={() => rowClick(it)}>
            <span class="fp-ic dir">{@render glyph('dir')}</span>
            <span class="fp-nm">{it.name}</span>
            <svg class="fp-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6" /></svg>
          </button>
        {:else}
          {@const ok = match(it.name)}
          {@const on = !!picked[relOf(it)]}
          <button type="button" class="fp-row" class:on disabled={!ok} aria-pressed={r.multiple ? on : undefined}
            title={ok ? undefined : t('这个应用不接受这种文件')} onclick={() => rowClick(it)}>
            <span class="fp-ic">{@render glyph(kindOf(it.name))}</span>
            <span class="fp-nm">{it.name}</span>
            <span class="fp-size">{fmtBytes(it.size)}</span>
            {#if r.multiple}
              <!-- 不接受的文件不画空圈：空圈读作「可以勾」，灰掉的行再带一个会让人以为点不中是手滑 -->
              <span class="fp-check" class:on class:off={!ok} aria-hidden="true">
                {#if on}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m7.5 12.4 3 3 6-6.4" /></svg>{/if}
              </span>
            {/if}
          </button>
        {/if}
      {/each}
      {#if truncated}
        <p class="fp-more">{t('这个文件夹有 {n} 项，只列出了前 {m} 项', { n: total, m: items.length })}</p>
      {/if}
    {/if}
  </div>
{/snippet}

{#if cur}
  {@const r = cur}
  {#key r.id}
    {#if mode === 'sheet'}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="fp-layer i27ink fp-sheet" class:dark data-picker-host role="presentation" tabindex="-1" bind:this={rootEl}
        onpointerdowncapture={onRootDown} onclickcapture={onRootClick}>
        <Sheet title={heading} closeLabel={t('取消')} onclose={() => cancel(r.id)}
          onconfirm={r.multiple ? confirm : null} confirmDisabled={!count} confirmLabel={t('选择')}>
          {@render browser(r)}
        </Sheet>
      </div>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="fp-layer i27ink fp-panel" class:dark data-picker-host role="presentation" bind:this={rootEl}
        onpointerdowncapture={onRootDown} onclickcapture={onRootClick}>
        <button class="fp-dim" type="button" tabindex="-1" aria-label={t('取消')} onclick={() => dimClick(r.id)}></button>
        <div class="fp-box" role="dialog" aria-modal="true" aria-label={heading} tabindex="-1" onkeydown={onPanelKey}>
          <header class="fp-head">
            <span class="fp-title">{heading}</span>
            <button type="button" class="fp-x" aria-label={t('取消')} onclick={() => cancel(r.id)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
            </button>
          </header>
          {@render browser(r)}
          <footer class="fp-foot">
            <button type="button" class="fp-btn" onclick={() => cancel(r.id)}>{t('取消')}</button>
            {#if r.multiple}
              <button type="button" class="fp-btn primary" disabled={!count} onclick={confirm}>{count ? t('选择（{n}）', { n: count }) : t('选择')}</button>
            {/if}
          </footer>
        </div>
      </div>
    {/if}
  {/key}
{/if}

<style>
  .fp-layer { position: fixed; inset: 0; z-index: 3400; outline: none; font-family: var(--sans, system-ui, sans-serif); -webkit-tap-highlight-color: transparent; }

  /* —— 共用：面包屑、列表、状态 —— */
  .fp-crumbs {
    display: flex; align-items: center; gap: 2px; min-height: 32px; overflow-x: auto; scrollbar-width: none;
    white-space: nowrap; font-size: 14px; line-height: 20px;
  }
  .fp-crumbs::-webkit-scrollbar { display: none; }
  .fp-crumb {
    flex: none; max-width: 14em; overflow: hidden; text-overflow: ellipsis; padding: 4px 6px; border: 0; border-radius: 8px;
    background: none; font: inherit; color: var(--i-label2); cursor: pointer;
  }
  .fp-crumb.here { color: var(--i-label); font-weight: 600; cursor: default; }
  .fp-sep { flex: none; color: var(--i-label3); }
  .fp-count { padding: 0 6px 6px; font-size: 12.5px; line-height: 17px; color: var(--i-label2); font-variant-numeric: tabular-nums; }
  .fp-list { transition: opacity var(--mo-quick, 200ms) var(--ea-fade, ease); }
  .fp-list.busy { opacity: .55; }
  .fp-row {
    display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 6px 10px; box-sizing: border-box;
    border: 0; border-radius: 12px; background: none; color: var(--i-label); font: inherit; text-align: left; cursor: pointer;
    -webkit-touch-callout: none; user-select: none; -webkit-user-select: none;
  }
  .fp-row:disabled { cursor: default; opacity: .38; }
  .fp-row.on { background: var(--i-fill4); }
  .fp-row:focus-visible { outline: 2px solid var(--i-label3); outline-offset: -2px; }
  .fp-ic { flex: none; width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; background: var(--i-tile); color: var(--i-tile-ink); }
  .fp-ic svg { width: 19px; height: 19px; }
  .fp-ic.dir { color: var(--i-label); }
  .fp-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; line-height: 20px; }
  .fp-size { flex: none; font-size: 13px; line-height: 18px; color: var(--i-label2); font-variant-numeric: tabular-nums; }
  .fp-chev { flex: none; width: 16px; height: 16px; color: var(--i-label3); }
  .fp-check {
    flex: none; width: 22px; height: 22px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid var(--i-label3);
    display: grid; place-items: center; color: var(--i-on-accent);
  }
  .fp-check.on { border-color: var(--i-accent); background: var(--i-accent); }
  .fp-check.off { visibility: hidden; }
  .fp-check svg { width: 15px; height: 15px; }
  .fp-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 16px; text-align: center; }
  .fp-state p { margin: 0; font-size: 14px; line-height: 20px; color: var(--i-label2); overflow-wrap: anywhere; }
  .fp-retry { height: 32px; padding: 0 16px; border: 0; border-radius: 10px; background: var(--i-fill3); color: var(--i-label); font: inherit; font-size: 14px; cursor: pointer; }
  .fp-more { margin: 8px 10px 4px; font-size: 12.5px; line-height: 17px; color: var(--i-label2); }

  /* —— 表单页（触屏 / 窄屏）：高度固定一截，换文件夹时表单页不跟着内容忽高忽低 —— */
  .fp-sheet .fp-list { min-height: min(56vh, 520px); }
  .fp-sheet .fp-row { min-height: 52px; }
  @media (hover: hover) {
    .fp-row:not(:disabled):hover { background: var(--i-fill4); }
    .fp-row.on:hover { background: var(--i-fill3); }
    .fp-crumb:not(.here):hover { color: var(--i-label); background: var(--i-fill4); }
  }

  /* —— 居中面板（宽屏鼠标）：墨与象牙扁平卡片，同应用内弹窗 —— */
  .fp-panel {
    --fp-surface: #fcfbf8; --fp-line: rgba(29, 27, 24, .1);
    --fp-shadow: 0 24px 70px rgba(24, 21, 17, .2), 0 2px 8px rgba(24, 21, 17, .08);
  }
  .fp-panel.dark {
    --fp-surface: #1a1917; --fp-line: rgba(241, 236, 226, .1);
    --fp-shadow: 0 24px 70px rgba(0, 0, 0, .45), 0 2px 8px rgba(0, 0, 0, .25);
  }
  .fp-dim {
    position: absolute; inset: 0; border: 0; padding: 0; cursor: default; background: rgba(0, 0, 0, .32);
    animation: fp-fade var(--mo-quick, 200ms) var(--ea-fade, ease) both;
  }
  .fp-box {
    position: absolute; left: 50%; top: 50%; width: min(560px, calc(100vw - 48px)); height: min(70vh, 600px);
    transform: translate(-50%, -50%); box-sizing: border-box; display: flex; flex-direction: column;
    background: var(--fp-surface); border: 1px solid var(--fp-line); border-radius: 16px; box-shadow: var(--fp-shadow);
    color: var(--i-label); outline: none;
    animation: fp-pop var(--mo-base, 280ms) var(--ea-decel, cubic-bezier(.2, .8, .2, 1)) both;
  }
  .fp-head { flex: none; display: flex; align-items: center; gap: 12px; padding: 14px 14px 6px 22px; }
  .fp-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; line-height: 22px; font-weight: 600; }
  .fp-x { flex: none; width: 30px; height: 30px; border: 0; border-radius: 8px; display: grid; place-items: center; background: none; color: var(--i-label2); cursor: pointer; }
  .fp-x svg { width: 18px; height: 18px; }
  .fp-x:hover { background: var(--i-fill4); color: var(--i-label); }
  .fp-panel .fp-crumbs { flex: none; padding: 0 16px; }
  .fp-panel .fp-count { flex: none; padding: 0 22px 6px; }
  .fp-panel .fp-list {
    flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 12px;
    border-top: 1px solid var(--fp-line); border-bottom: 1px solid var(--fp-line);
  }
  .fp-panel .fp-row { min-height: 44px; border-radius: 10px; }
  .fp-panel .fp-ic { width: 28px; height: 28px; border-radius: 8px; }
  .fp-panel .fp-ic svg { width: 17px; height: 17px; }
  .fp-panel .fp-nm { font-size: 14px; }
  .fp-foot { flex: none; display: flex; justify-content: flex-end; gap: 8px; padding: 14px 18px 16px; }
  .fp-btn {
    min-width: 76px; height: 34px; padding: 0 16px; border: 0; border-radius: 10px; cursor: pointer;
    font: inherit; font-size: 14px; line-height: 20px; font-weight: 500; white-space: nowrap;
    color: var(--i-label); background: var(--i-fill3);
  }
  .fp-btn:hover { background: var(--i-fill2); }
  .fp-btn.primary { color: var(--i-on-accent); background: var(--i-accent); }
  .fp-btn.primary:hover { opacity: .9; }
  .fp-btn:disabled { opacity: .45; cursor: default; }
  .fp-btn:focus-visible, .fp-x:focus-visible, .fp-crumb:focus-visible { outline: 2px solid var(--i-label3); outline-offset: 2px; }

  @keyframes fp-fade { from { opacity: 0; } }
  @keyframes fp-pop { from { opacity: 0; transform: translate(-50%, -50%) scale(.97); } }
</style>
