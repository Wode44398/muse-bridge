<script>
  // 插件页面的会话选择器（界面层；数据与入口在 lib/sessionPicker.svelte.js 的 pickSession）。
  //
  // 列使用者自己的 Claude 会话：本地缓存（IndexedDB 快照）先出、网络刷新殿后——同文件分页「选择对话」那份，
  // 复用 files-business.js 的 loadAiSessions / filterAiSessions；标题走 library 的改名表（titleFor），服务端占位标题走 tr。
  // 搜索框过滤；每行：状态点（在跑 / 等你批）、标题、相对时间。点一行即选中关闭。
  // 两种出场同文件选择器：触屏 / 窄屏 → ios27 表单页；宽屏鼠标 → 居中扁平面板。层级 3400。
  import { onDestroy, setContext, untrack } from 'svelte';
  import Sheet from '../ios27/Sheet.svelte';
  import '../ios27/ink.css';
  import { sessionPickHost, activeSessionPick, settleSessionPick } from '../../lib/sessionPicker.svelte.js';
  import { aboveOpen, OTHER_LAYERS } from '../../lib/pickerLane.svelte.js';
  import { loadAiSessions, filterAiSessions } from '../../lib/files-business.js';
  import { getCachedSessions } from '../../lib/cache.js';
  import { titleFor } from '../../lib/library.svelte.js';
  import { relTime } from '../../lib/format.js';
  import { api } from '../../lib/api.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { pushNativeOverlay } from '../../lib/nativeDesktop.js';
  import { t, tr } from '../../lib/i18n.js';

  const self = {};
  const owner = !sessionPickHost.owner;
  if (owner) { sessionPickHost.owner = self; sessionPickHost.ready = true; }
  onDestroy(() => {
    if (sessionPickHost.owner !== self) return;
    sessionPickHost.owner = null;
    sessionPickHost.ready = false;
  });

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

  const cur = $derived(owner ? activeSessionPick() : null);
  const mode = $derived(coarse || vw < 700 ? 'sheet' : 'panel');
  const heading = $derived(cur ? cur.title || t('选择一个对话') : '');

  // —— 列表 ——
  // 一次最多画这么多行：会话上千个时搜索框照样能找到，但不一次塞几千个按钮进 DOM
  const RENDER_MAX = 300;
  let sessions = $state([]);
  let loading = $state(false);
  let failed = $state(false);
  let q = $state('');
  let token = 0;
  const titleOf = (s) => tr(titleFor(s.id, s.title)) || t('（无标题）');   // 服务端占位标题（「（进行中…）」「(无标题)」）走 tr
  const filtered = $derived(filterAiSessions(sessions, q, titleOf));
  const rows = $derived(filtered.slice(0, RENDER_MAX));

  $effect(() => {
    const r = cur;
    if (!r) return;
    untrack(() => {
      const my = ++token;
      sessions = []; q = ''; failed = false; loading = true;
      shownAt = performance.now();
      loadAiSessions('claude', {
        cached: () => getCachedSessions(),
        remote: () => api.sessions(),
        current: () => token === my,
        onCached: (list) => { if (Array.isArray(list)) sessions = list.filter(okSession); },
        onDone: (list) => {
          if (Array.isArray(list)) sessions = list.filter(okSession);
          else if (!sessions.length) failed = true;
          loading = false;
        },
      });
    });
  });
  const okSession = (s) => s && typeof s.id === 'string' && s.id;

  function pick(s) {
    const r = cur;
    if (!r) return;
    settleSessionPick(r.id, { sessionId: s.id, title: titleOf(s) });
  }
  function cancel(id) { settleSessionPick(id, null); }
  function retry() {
    const r = cur;
    if (!r) return;
    const my = ++token;
    failed = false; loading = true;
    api.sessions().then((res) => {
      if (token !== my) return;
      sessions = (res?.sessions || []).filter(okSession);
    }).catch(() => { if (token === my) failed = !sessions.length; }).finally(() => { if (token === my) loading = false; });
  }

  $effect(() => {
    const r = cur;
    if (!r) return;
    const id = r.id;
    return pushBackLayer(() => { cancel(id); });
  });
  $effect(() => { if (cur) return pushNativeOverlay(); });

  // —— 焦点：宽屏面板开出来落到搜索框（键盘用户直接打字筛）；触屏不自动聚焦（免得一开就弹出软键盘）——
  let rootEl = $state(null);
  let searchEl = $state(null);
  function focusStart() {
    // 表单页（触屏）只聚焦整层本身（tabindex=-1、不画框）：聚焦搜索框手机会弹软键盘，聚焦行 / 关闭钮会亮起 :focus-visible 的橙圈
    const el = mode === 'panel' ? searchEl : rootEl;
    try { el?.focus({ preventScroll: true }); } catch {}
  }
  $effect(() => {
    const r = cur;
    void mode;
    if (!r) return;
    requestAnimationFrame(() => { if (cur === r && !aboveOpen()) untrack(focusStart); });
  });
  // 陷阱只往上让（选择器 < 应用内弹窗 < 授权框，理由同文件选择器）；pulling 防 focus() 同步嵌套触发的 focusin 重入
  $effect(() => {
    if (!cur) return;
    let pulling = false;
    const onIn = (e) => {
      if (pulling || !rootEl || aboveOpen()) return;
      const el = e.target instanceof Node ? e.target : null;
      if (el && rootEl.contains(el)) return;
      if (el instanceof Element && el.closest(OTHER_LAYERS)) return;
      pulling = true;
      try { focusStart(); } finally { pulling = false; }
    };
    document.addEventListener('focusin', onIn, true);
    return () => document.removeEventListener('focusin', onIn, true);
  });

  // 搜索框里按上下键 / 回车：在结果间移动、回车选第一条（键盘用户不用摸鼠标）
  function onPanelKey(e) {
    const list = [...(rootEl?.querySelectorAll('.sp-row') || [])];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!list.length) return;
      e.preventDefault();
      const at = list.indexOf(document.activeElement);
      if (at < 0 && e.key === 'ArrowUp') return;
      const next = at < 0 ? 0 : at + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) { searchEl?.focus(); return; }
      list[Math.min(list.length - 1, next)].focus();
      return;
    }
    if (e.key === 'Enter' && e.target === searchEl && !e.isComposing && rows.length) {
      e.preventDefault();
      pick(rows[0]);
    }
  }

  // 指针防误触：刚弹出来的一小段时间里的按下不算
  const GUARD_MS = 300;
  let shownAt = -Infinity;
  let swallow = false;
  let downOnDim = false;
  function onRootDown(e) {
    swallow = performance.now() - shownAt < GUARD_MS;
    if (swallow) { e.stopPropagation(); return; }
    downOnDim = e.target instanceof Element && e.target.classList.contains('sp-dim');
  }
  function onRootClick(e) {
    if (!swallow || !(e.detail > 0)) return;
    swallow = false;
    e.preventDefault();
    e.stopPropagation();
  }
  function dimClick(id) { const ok = downOnDim; downOnDim = false; if (ok) cancel(id); }
</script>

{#snippet listing()}
  <label class="sp-search">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6" /><path d="m15.4 15.4 4.4 4.4" /></svg>
    <input type="search" placeholder={t('搜索对话')} aria-label={t('搜索对话')} bind:value={q} bind:this={searchEl}
      autocomplete="off" spellcheck="false" />
  </label>
  <div class="sp-list">
    {#each rows as s (s.id)}
      <button type="button" class="sp-row" onclick={() => pick(s)}>
        <span class="sp-dot {s.thinking ? 'work' : s.pending ? 'ask' : ''}" aria-hidden="true"></span>
        <span class="sp-tx">{titleOf(s)}</span>
        {#if s.mtime}<span class="sp-time">{relTime(s.mtime)}</span>{/if}
      </button>
    {:else}
      <div class="sp-state">
        {#if loading}
          <p>{t('加载中…')}</p>
        {:else if failed}
          <p>{t('对话列表没能加载')}</p>
          <button type="button" class="sp-retry" onclick={retry}>{t('重试')}</button>
        {:else}
          <p>{q ? t('没有匹配的对话') : t('还没有历史对话')}</p>
        {/if}
      </div>
    {/each}
    {#if filtered.length > rows.length}
      <p class="sp-more">{t('还有 {n} 个对话没列出来，搜一下能找到', { n: filtered.length - rows.length })}</p>
    {/if}
  </div>
{/snippet}

{#if cur}
  {@const r = cur}
  {#key r.id}
    {#if mode === 'sheet'}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="sp-layer i27ink sp-sheet" class:dark data-picker-host role="presentation" tabindex="-1" bind:this={rootEl}
        onpointerdowncapture={onRootDown} onclickcapture={onRootClick}>
        <Sheet title={heading} closeLabel={t('取消')} onclose={() => cancel(r.id)}>
          {@render listing()}
        </Sheet>
      </div>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="sp-layer i27ink sp-panel" class:dark data-picker-host role="presentation" bind:this={rootEl}
        onpointerdowncapture={onRootDown} onclickcapture={onRootClick}>
        <button class="sp-dim" type="button" tabindex="-1" aria-label={t('取消')} onclick={() => dimClick(r.id)}></button>
        <div class="sp-box" role="dialog" aria-modal="true" aria-label={heading} tabindex="-1" onkeydown={onPanelKey}>
          <header class="sp-head">
            <span class="sp-title">{heading}</span>
            <button type="button" class="sp-x" aria-label={t('取消')} onclick={() => cancel(r.id)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
            </button>
          </header>
          {@render listing()}
        </div>
      </div>
    {/if}
  {/key}
{/if}

<style>
  .sp-layer { position: fixed; inset: 0; z-index: 3400; outline: none; font-family: var(--sans, system-ui, sans-serif); -webkit-tap-highlight-color: transparent; }

  .sp-search {
    display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border-radius: 12px;
    background: var(--i-field); color: var(--i-label2);
  }
  .sp-search svg { flex: none; width: 17px; height: 17px; }
  .sp-search input {
    flex: 1; min-width: 0; height: 100%; border: 0; padding: 0; background: none; outline: none;
    font: inherit; font-size: 15px; color: var(--i-label);
  }
  .sp-search input::placeholder { color: var(--i-label3); }
  .sp-search input::-webkit-search-cancel-button { filter: grayscale(1); opacity: .5; }
  .sp-search:focus-within { box-shadow: 0 0 0 1.5px var(--i-label3); }
  .sp-list { padding-top: 6px; }
  .sp-row {
    display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 6px 10px; box-sizing: border-box;
    border: 0; border-radius: 12px; background: none; color: var(--i-label); font: inherit; text-align: left; cursor: pointer;
    -webkit-touch-callout: none; user-select: none; -webkit-user-select: none;
  }
  .sp-row:focus-visible { outline: 2px solid var(--i-label3); outline-offset: -2px; }
  .sp-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--i-label4); }
  .sp-dot.work { background: #d97757; animation: sp-pulse 1.2s ease-in-out infinite; }
  .sp-dot.ask { background: var(--i-warn); animation: sp-pulse 1.2s ease-in-out infinite; }
  .sp-tx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; line-height: 20px; }
  .sp-time { flex: none; font-size: 13px; line-height: 18px; color: var(--i-label2); font-variant-numeric: tabular-nums; }
  .sp-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 16px; text-align: center; }
  .sp-state p { margin: 0; font-size: 14px; line-height: 20px; color: var(--i-label2); }
  .sp-retry { height: 32px; padding: 0 16px; border: 0; border-radius: 10px; background: var(--i-fill3); color: var(--i-label); font: inherit; font-size: 14px; cursor: pointer; }
  .sp-more { margin: 8px 10px 4px; font-size: 12.5px; line-height: 17px; color: var(--i-label2); }
  @media (hover: hover) { .sp-row:hover { background: var(--i-fill4); } }
  @media (prefers-reduced-motion: reduce) { .sp-dot.work, .sp-dot.ask { animation: none; } }
  @keyframes sp-pulse { 50% { opacity: .35; } }

  /* —— 表单页：高度固定一截，搜索时表单页不跟着结果条数忽高忽低 —— */
  .sp-sheet .sp-list { min-height: min(56vh, 520px); }
  .sp-sheet .sp-row { min-height: 52px; }

  /* —— 居中面板 —— */
  .sp-panel {
    --sp-surface: #fcfbf8; --sp-line: rgba(29, 27, 24, .1);
    --sp-shadow: 0 24px 70px rgba(24, 21, 17, .2), 0 2px 8px rgba(24, 21, 17, .08);
  }
  .sp-panel.dark {
    --sp-surface: #1a1917; --sp-line: rgba(241, 236, 226, .1);
    --sp-shadow: 0 24px 70px rgba(0, 0, 0, .45), 0 2px 8px rgba(0, 0, 0, .25);
  }
  .sp-dim {
    position: absolute; inset: 0; border: 0; padding: 0; cursor: default; background: rgba(0, 0, 0, .32);
    animation: sp-fade var(--mo-quick, 200ms) var(--ea-fade, ease) both;
  }
  .sp-box {
    position: absolute; left: 50%; top: 50%; width: min(520px, calc(100vw - 48px)); height: min(70vh, 600px);
    transform: translate(-50%, -50%); box-sizing: border-box; display: flex; flex-direction: column;
    background: var(--sp-surface); border: 1px solid var(--sp-line); border-radius: 16px; box-shadow: var(--sp-shadow);
    color: var(--i-label); outline: none;
    animation: sp-pop var(--mo-base, 280ms) var(--ea-decel, cubic-bezier(.2, .8, .2, 1)) both;
  }
  .sp-head { flex: none; display: flex; align-items: center; gap: 12px; padding: 14px 14px 10px 22px; }
  .sp-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; line-height: 22px; font-weight: 600; }
  .sp-x { flex: none; width: 30px; height: 30px; border: 0; border-radius: 8px; display: grid; place-items: center; background: none; color: var(--i-label2); cursor: pointer; }
  .sp-x svg { width: 18px; height: 18px; }
  .sp-x:hover { background: var(--i-fill4); color: var(--i-label); }
  .sp-x:focus-visible { outline: 2px solid var(--i-label3); outline-offset: 2px; }
  .sp-panel .sp-search { flex: none; margin: 0 16px 8px; height: 34px; border-radius: 10px; }
  .sp-panel .sp-search input { font-size: 14px; }
  .sp-panel .sp-list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 12px 12px; border-top: 1px solid var(--sp-line); }
  .sp-panel .sp-row { min-height: 42px; border-radius: 10px; }
  .sp-panel .sp-tx { font-size: 14px; }

  @keyframes sp-fade { from { opacity: 0; } }
  @keyframes sp-pop { from { opacity: 0; transform: translate(-50%, -50%) scale(.97); } }
</style>
