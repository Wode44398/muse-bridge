<script>
  // 会话侧栏：收藏的会话在最上面一组；其余按工作空间文件夹分组、组内按时间倒序，每组默认展示最近 8 条，组头悬停可直接在该目录新建对话。
  // 搜索框：本地按标题 / 文件夹过滤立刻出；下面另有「对话内容」一段，防抖后到服务端按 agy 文字记录搜正文。
  // 底部仅在确有已隐藏会话时才显示恢复入口，保持界面克制干净。
  import { closePage } from '../../lib/pageMorph.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';
  import { rootScreen } from '../../lib/state.svelte.js';
  import { agy, newAgyChat, refreshHiddenSessions, openAgySession } from '../../lib/agy/store.svelte.js';
  import { groupSessionsByProjectAndTime } from '../../lib/agy/logic.js';
  import { agyApi } from '../../lib/agy/api.js';
  import { highlightParts, contentHitsOf, contentQueryOf } from '../../lib/agy/content-search.js';
  import { bindAgySessionManageBus } from '../../lib/agy/session-manage.js';
  import { t } from '../../lib/i18n.js';
  import SessionRow from './SessionRow.svelte';

  bindAgySessionManageBus();

  const { wide = false, onCollapse = null } = $props();

  const GROUP_PEEK = 8;
  const canExitToHome = $derived(rootScreen() !== 'agy');

  let query = $state('');
  let collapsedProjects = $state({});
  let expandedProjects = $state({});
  let moreProjectsOpen = $state(false);
  let menuSid = $state('');
  let favCollapsed = $state(false);

  // —— 对话内容（正文）搜索 ——
  const CONTENT_DEBOUNCE_MS = 300;
  const CONTENT_RETRY_MS = 1500;
  const CONTENT_RETRY_MAX = 6;
  let contentHits = $state([]);
  let contentFor = $state('');
  let contentLoading = $state(false);
  let contentIndexing = $state(false);
  let contentSeq = 0;
  let contentTimer = null;

  async function runContentSearch(q, seq, attempt) {
    try {
      const res = await agyApi.searchContent(q, { limit: 20 });
      if (seq !== contentSeq) return;
      contentHits = contentHitsOf(res);
      contentFor = q;
      contentIndexing = !!res?.indexing && attempt < CONTENT_RETRY_MAX;
      // 服务端索引还在建：先给已有的，过一会儿自动再问一次
      if (contentIndexing) contentTimer = setTimeout(() => runContentSearch(q, seq, attempt + 1), CONTENT_RETRY_MS);
    } catch {
      if (seq === contentSeq) { contentHits = []; contentIndexing = false; }
    } finally {
      if (seq === contentSeq) contentLoading = false;
    }
  }

  $effect(() => {
    const q = contentQueryOf(query);
    const seq = ++contentSeq;
    clearTimeout(contentTimer);
    if (!q) {
      contentHits = [];
      contentFor = '';
      contentLoading = false;
      contentIndexing = false;
      return;
    }
    contentLoading = true;
    contentTimer = setTimeout(() => runContentSearch(q, seq, 0), CONTENT_DEBOUNCE_MS);
    return () => clearTimeout(contentTimer);
  });

  function openContentHit(hit) {
    agy.drawerOpen = false;
    openAgySession(hit.sessionId);
  }

  const grouped = $derived(groupSessionsByProjectAndTime(agy.sessions, agy.projects, query));
  const activeSet = $derived(new Set(agy.activeSessionIds));
  const hasQuery = $derived(Boolean(query.trim()));
  const showContent = $derived(Boolean(contentQueryOf(query)));
  const favClosed = $derived(!hasQuery && favCollapsed);
  const currentInMore = $derived(Boolean(
    agy.sessionId && grouped.moreProjects.some((g) => groupHasCurrent(g))
  ));
  const showMoreList = $derived(moreProjectsOpen || currentInMore);

  function flatItems(pgrp) {
    return (pgrp.timeGroups || []).flatMap((tg) => tg.items);
  }

  function groupHasCurrent(pgrp) {
    return Boolean(agy.sessionId && flatItems(pgrp).some((s) => s.sessionId === agy.sessionId));
  }

  function isGroupCollapsed(pgrp) {
    if (hasQuery) return false;
    if (collapsedProjects[pgrp.key] !== undefined) return Boolean(collapsedProjects[pgrp.key]);
    if (groupHasCurrent(pgrp)) return false;
    return Boolean(pgrp.defaultCollapsed);
  }

  function toggleProjectGroup(pgrp) {
    collapsedProjects[pgrp.key] = !isGroupCollapsed(pgrp);
  }

  function startNewInGroup(pgrp, ev) {
    ev?.stopPropagation?.();
    if (pgrp.projectId) {
      newAgyChat({ projectId: pgrp.projectId, cwd: pgrp.path || '' });
    } else if (pgrp.path) {
      newAgyChat({ projectId: '', cwd: pgrp.path });
    } else {
      newAgyChat();
    }
    agy.drawerOpen = false;
  }

  function visibleItems(pgrp) {
    const all = flatItems(pgrp);
    if (hasQuery || expandedProjects[pgrp.key] || all.length <= GROUP_PEEK) return all;
    const head = all.slice(0, GROUP_PEEK);
    const cur = agy.sessionId && all.slice(GROUP_PEEK).find((s) => s.sessionId === agy.sessionId);
    return cur ? [...head, cur] : head;
  }

  async function openHiddenSheet() {
    await refreshHiddenSessions();
    agy.hiddenOpen = true;
  }

  function openAgySettings() {
    agy.drawerOpen = false;
    openSettings('ag-agy');
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="agy-sidebar" onclick={() => { if (menuSid) menuSid = ''; }}>
  <div class="sb-top" class:has-back={canExitToHome}>
    {#if canExitToHome}
      <button
        type="button"
        class="sb-icon-btn"
        onclick={() => { agy.drawerOpen = false; closePage('agy'); }}
        title={t('返回主页')}
        aria-label={t('返回主页')}
      >
        <span class="msr4">arrow_back</span>
      </button>
    {/if}
    <div class="sb-brand">
      <span class="sb-wordmark">Antigravity</span>
    </div>
    {#if wide && onCollapse}
      <button
        type="button"
        class="sb-icon-btn"
        onclick={onCollapse}
        title={t('收起侧栏')}
        aria-label={t('收起侧栏')}
      >
        <span class="msr4">left_panel_close</span>
      </button>
    {/if}
  </div>

  <div class="sb-actions">
    <button
      type="button"
      class="sb-row-btn"
      onclick={() => { newAgyChat(); agy.drawerOpen = false; }}
    >
      <span class="msr4">edit_square</span>
      <span>{t('新建对话')}</span>
    </button>
    <label class="sb-search">
      <span class="msr4">search</span>
      <input
        type="text"
        value={query}
        oninput={(e) => { query = e.currentTarget.value; }}
        placeholder={t('搜索对话')}
      />
      {#if query}
        <button type="button" class="search-clr" onclick={() => { query = ''; }} aria-label={t('清空')}>
          <span class="msr">close</span>
        </button>
      {/if}
    </label>
  </div>

  <div class="sb-list">
    {#snippet sessionRow(item)}
      <SessionRow
        {item}
        isCurrent={agy.sessionId === item.sessionId}
        isLive={activeSet.has(item.sessionId) || (agy.sessionId === item.sessionId && agy.busy)}
        pending={agy.pendingSessions[item.sessionId] || ''}
        menuOpen={menuSid === item.sessionId}
        onToggleMenu={() => { menuSid = menuSid === item.sessionId ? '' : item.sessionId; }}
        onCloseMenu={() => { menuSid = ''; }}
      />
    {/snippet}

    {#if agy.loadingList && grouped.total === 0 && !hasQuery}
      <div class="sb-skel" aria-hidden="true">
        <i style="width:62%"></i><i style="width:80%"></i><i style="width:54%"></i><i style="width:72%"></i>
      </div>
    {:else if grouped.total === 0}
      <div class="sb-empty" class:compact={showContent}>{query ? t('没有匹配的对话') : t('还没有对话')}</div>
    {:else}
      {#if grouped.favorites.length > 0}
        <section class="sb-group">
          <div class="sb-group-bar">
            <button
              type="button"
              class="sb-group-head"
              onclick={() => { favCollapsed = !favCollapsed; }}
              aria-expanded={!favClosed}
            >
              <span class="msr gchev" class:closed={favClosed}>expand_more</span>
              <span class="gname">{t('收藏')}</span>
            </button>
          </div>
          {#if !favClosed}
            {#each grouped.favorites as item (item.sessionId)}
              {@render sessionRow(item)}
            {/each}
          {/if}
        </section>
      {/if}

      {#snippet projectGroupBlock(pgrp)}
        {@const closed = isGroupCollapsed(pgrp)}
        {@const items = closed ? [] : visibleItems(pgrp)}
        {@const restCount = pgrp.count - items.length}
        <section class="sb-group">
          <div class="sb-group-bar">
            <button
              type="button"
              class="sb-group-head"
              onclick={() => toggleProjectGroup(pgrp)}
              title={pgrp.path || pgrp.name}
              aria-expanded={!closed}
            >
              <span class="msr gchev" class:closed>expand_more</span>
              <span class="gname">{pgrp.name}</span>
              {#if pgrp.parentHint}<span class="ghint">{pgrp.parentHint}</span>{/if}
            </button>
            {#if !pgrp.unassigned && (pgrp.path || pgrp.projectId)}
              <button
                type="button"
                class="sb-group-add"
                onclick={(ev) => startNewInGroup(pgrp, ev)}
                title={t('在此文件夹新建对话')}
                aria-label={t('在此文件夹新建对话')}
              >
                <span class="msr">add</span>
              </button>
            {/if}
          </div>

          {#if !closed}
            {#each items as item (item.sessionId)}
              {@render sessionRow(item)}
            {/each}
            {#if restCount > 0 && !hasQuery}
              <button type="button" class="sb-peek" onclick={() => { expandedProjects[pgrp.key] = true; }}>
                {t('再显示 {n} 条', { n: restCount })}
              </button>
            {:else if expandedProjects[pgrp.key] && pgrp.count > GROUP_PEEK && !hasQuery}
              <button type="button" class="sb-peek" onclick={() => { expandedProjects[pgrp.key] = false; }}>
                {t('收起')}
              </button>
            {/if}
          {/if}
        </section>
      {/snippet}

      {#if hasQuery}
        {#each grouped.byProject as pgrp (pgrp.key)}
          {@render projectGroupBlock(pgrp)}
        {/each}
      {:else}
        {#each grouped.primaryProjects as pgrp (pgrp.key)}
          {@render projectGroupBlock(pgrp)}
        {/each}

        {#if grouped.moreProjects.length > 0}
          <button
            type="button"
            class="sb-group-head sb-more"
            onclick={() => { moreProjectsOpen = !showMoreList; }}
            aria-expanded={showMoreList}
          >
            <span class="msr gchev" class:closed={!showMoreList}>expand_more</span>
            <span class="gname">{t('其它文件夹')}</span>
            <span class="ghint">{grouped.moreProjects.length}</span>
          </button>
          {#if showMoreList}
            <div class="sb-more-body">
              {#each grouped.moreProjects as pgrp (pgrp.key)}
                {@render projectGroupBlock(pgrp)}
              {/each}
            </div>
          {/if}
        {/if}

        {#each grouped.otherProjects as pgrp (pgrp.key)}
          {@render projectGroupBlock(pgrp)}
        {/each}
      {/if}
    {/if}

    {#if showContent}
      <section class="sb-group sb-content" aria-live="polite">
        <div class="sb-content-head">
          <span class="gname">{t('对话内容')}</span>
          {#if contentIndexing}
            <span class="ghint">{t('正在建立索引…')}</span>
          {:else if contentLoading}
            <span class="ghint">{t('搜索中…')}</span>
          {/if}
        </div>
        {#each contentHits as hit (hit.sessionId)}
          <button
            type="button"
            class="sb-hit"
            class:active={agy.sessionId === hit.sessionId}
            onclick={() => openContentHit(hit)}
            title={hit.cwd || hit.title}
          >
            <span class="hit-title">{hit.title || t('未命名对话')}</span>
            <span class="hit-snip">
              <span class="hit-role">{hit.role === 'user' ? t('你') : 'Antigravity'}</span>
              {#each highlightParts(hit.snippet, contentFor) as part, i (i)}
                {#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
              {/each}
            </span>
          </button>
        {:else}
          {#if !contentLoading && !contentIndexing}
            <div class="sb-hit-empty">{t('对话内容里没有找到')}</div>
          {/if}
        {/each}
      </section>
    {/if}
  </div>

  <div class="sb-foot">
    {#if agy.hiddenCount > 0}
      <button type="button" class="sb-foot-btn" onclick={openHiddenSheet}>
        <span class="msr">visibility_off</span>
        <span>{t('已隐藏')}</span>
        <span class="hcount">{agy.hiddenCount}</span>
      </button>
    {/if}
    <button
      type="button"
      class="sb-foot-btn sb-set-row"
      class:full={agy.hiddenCount === 0}
      onclick={openAgySettings}
      title={t('Antigravity 设置')}
      aria-label={t('Antigravity 设置')}
    >
      <span class="msr4">tune</span>
      {#if agy.hiddenCount === 0}
        <span>{t('设置')}</span>
      {/if}
    </button>
  </div>
</aside>

<style>
  .agy-sidebar {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--ag-side-bg);
    border-right: 1px solid var(--ag-divider);
    padding-top: var(--sat, 0px);
    padding-bottom: var(--sab, 0px);
    box-sizing: border-box;
    font-size: 13.5px;
  }

  .sb-top {
    height: var(--ag-top-h, 44px);
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 8px;
  }
  .sb-brand {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    padding: 0 10px;
    font-size: 16px;
    font-weight: 520;
    color: var(--ag-on);
    letter-spacing: -0.02em;
    user-select: none;
  }
  .sb-top.has-back .sb-brand {
    padding-left: 4px;
  }
  :global(html[data-wco="1"]) .sb-brand {
    -webkit-app-region: drag;
  }
  .sb-wordmark {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sb-icon-btn {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
    flex: none;
  }
  .sb-icon-btn:hover { background: var(--ag-hover); color: var(--ag-on); }
  .sb-icon-btn .msr4 { font-size: 20px; }

  .sb-actions {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 8px 8px;
  }
  .sb-row-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 10px;
    border-radius: 8px;
    color: var(--ag-on);
    font-size: 13.5px;
    text-align: left;
  }
  .sb-row-btn:hover { background: var(--ag-hover); }
  .sb-row-btn .msr4 { font-size: 18px; color: var(--ag-on-sub); }

  .sb-search {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 6px 0 10px;
    border-radius: 8px;
    color: var(--ag-on-dim);
    cursor: text;
  }
  .sb-search:hover,
  .sb-search:focus-within { background: var(--ag-hover); }
  .sb-search .msr4 { font-size: 18px; flex: none; }
  .sb-search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--ag-on);
    font: inherit;
    font-size: 13.5px;
  }
  .sb-search input::placeholder { color: var(--ag-on-dim); }
  .search-clr {
    width: 22px;
    height: 22px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-faint);
  }
  .search-clr:hover { color: var(--ag-on); }
  .search-clr .msr { font-size: 16px; }

  .sb-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 12px;
    scrollbar-width: thin;
  }

  .sb-group { margin-bottom: 6px; }
  .sb-group-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-top: 6px;
  }
  .sb-group-head {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding: 0 6px;
    border-radius: 7px;
    color: var(--ag-on-dim);
    font-size: 12px;
    font-weight: 500;
    text-align: left;
  }
  .sb-group-head:hover { color: var(--ag-on-sub); background: var(--ag-hover); }
  .gname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .ghint {
    flex: none;
    color: var(--ag-on-faint);
    font-weight: 400;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gchev {
    font-size: 16px;
    color: var(--ag-on-faint);
    transition: transform var(--ag-dur-quick) var(--ag-ease-std);
    flex: none;
  }
  .gchev.closed { transform: rotate(-90deg); }
  .sb-group-add {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-faint);
    opacity: 0;
    flex: none;
    transition: opacity var(--ag-dur-micro) var(--ag-ease-std), background var(--ag-dur-micro) var(--ag-ease-std);
  }
  .sb-group-bar:hover .sb-group-add { opacity: 1; }
  @media (pointer: coarse) {
    .sb-group-add { opacity: 0.72; }
  }
  .sb-group-add:hover { background: var(--ag-hover); color: var(--ag-on); }
  .sb-group-add .msr { font-size: 16px; }
  .sb-more { margin-top: 10px; width: 100%; }

  .sb-peek {
    display: block;
    width: 100%;
    height: 28px;
    padding: 0 10px 0 22px;
    border-radius: 8px;
    text-align: left;
    font-size: 12px;
    color: var(--ag-on-faint);
  }
  .sb-peek:hover { background: var(--ag-hover); color: var(--ag-on-sub); }

  .sb-empty {
    padding: 28px 12px;
    text-align: center;
    color: var(--ag-on-faint);
    font-size: 13px;
  }
  .sb-empty.compact { padding: 12px 10px 4px; text-align: left; font-size: 12.5px; }

  /* 对话内容（正文命中）：标题一行 + 片段两行，命中词只加粗不上色 */
  .sb-content { margin-top: 10px; }
  .sb-content-head {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 6px 0 10px;
    color: var(--ag-on-dim);
    font-size: 12px;
    font-weight: 500;
  }
  .sb-hit {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 6px 10px 7px;
    margin: 1px 0;
    border-radius: 8px;
    text-align: left;
    min-width: 0;
  }
  .sb-hit:hover { background: var(--ag-hover); }
  .sb-hit.active { background: var(--ag-active); }
  .hit-title {
    font-size: 13px;
    color: var(--ag-on-sub);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sb-hit.active .hit-title { color: var(--ag-on); }
  .hit-snip {
    font-size: 12px;
    line-height: 1.45;
    color: var(--ag-on-dim);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .hit-role {
    color: var(--ag-on-faint);
    margin-right: 6px;
  }
  .hit-snip mark {
    background: transparent;
    color: var(--ag-on);
    font-weight: 600;
  }
  .sb-hit-empty {
    padding: 6px 10px;
    font-size: 12px;
    color: var(--ag-on-faint);
  }
  .sb-skel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px 10px;
  }
  .sb-skel i {
    display: block;
    height: 10px;
    border-radius: 5px;
    background: var(--ag-surface-2);
    animation: agy-skel 1.4s ease-in-out infinite;
  }
  @keyframes agy-skel { 50% { opacity: 0.45; } }

  .sb-foot {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 6px 8px 8px;
    border-top: 1px solid var(--ag-divider);
  }
  .sb-foot-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 10px;
    border-radius: 8px;
    color: var(--ag-on-dim);
    font-size: 12.5px;
  }
  .sb-foot-btn:hover { background: var(--ag-hover); color: var(--ag-on); }
  .sb-foot-btn .msr,
  .sb-foot-btn .msr4 { font-size: 18px; }
  .sb-set-row:not(.full) {
    width: 32px;
    padding: 0;
    justify-content: center;
    margin-left: auto;
  }
  .sb-set-row.full {
    flex: 1;
  }
  .hcount {
    font-family: var(--ag-mono);
    font-size: 11px;
    color: var(--ag-on-faint);
  }
</style>
