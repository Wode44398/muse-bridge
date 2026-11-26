<script>
  // 会话侧栏：收藏的会话在最上面一组；其余按工作空间文件夹分组、组内按时间倒序，每组默认展示最近 8 条，组头悬停可直接在该目录新建对话。
  // 工作空间组头支持拖动排序（鼠标 HTML5 拖拽 / 触屏长按拿起）与拖入输入栏直接引用文件夹；
  // 会话行支持拖入输入栏或另一条会话来引用对话；窄屏抽屉拖出右缘自动收起。
  // 搜索框：本地按标题 / 文件夹过滤立刻出；下面另有「对话内容」一段，防抖后到服务端按 agy 文字记录搜正文。
  // 底部仅在确有已隐藏会话时才显示恢复入口，保持界面克制干净。
  // 插件工作区外观（共用文件夹）：有外观的组整组收进底板，标题右端头像组（悬停 / 长按出共用卡）、标题下状态行、底部 footer、
  // 会话行首「谁开的」；文件夹菜单接插件项。画法在各自组件里，进场 / 退场 / 飞行编排在 lib/agy/decor-flight.svelte.js。
  import { untrack } from 'svelte';
  import { closePage } from '../../lib/pageMorph.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';
  import { rootScreen } from '../../lib/state.svelte.js';
  import { isPageWindow } from '../../lib/windowPage.svelte.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import {
    agy,
    newAgyChat,
    pinAgyProject,
    renameAgyProject,
    deleteAgyProject,
    hideAgyWorkspaceSessions,
    reorderAgyProjects,
    refreshHiddenSessions,
    openAgySession,
  } from '../../lib/agy/store.svelte.js';
  import { groupSessionsByProjectAndTime, moveOrderPath, normCmpDir } from '../../lib/agy/logic.js';
  import { agyApi } from '../../lib/agy/api.js';
  import { highlightParts, contentHitsOf, contentQueryOf } from '../../lib/agy/content-search.js';
  import { bindAgySessionManageBus } from '../../lib/agy/session-manage.js';
  import { buildSidebarWorkspaceMenu } from '../../lib/agy/workspace-menu.js';
  import {
    AGY_PROJ_REF,
    AGY_SIDE_DT,
    agySideDrag,
    getRawAgySideDrag,
    beginAgyMouseDrag,
    endAgyMouseDrag,
    isAgyChatRef,
    isAgyProjRef,
    makeAgyDragGhost,
  } from '../../lib/agy/chat-quote.svelte.js';
  import { drag, dragPayload, beginDrag, makeHold, dropZone, dragScrollGuard } from '../../lib/dragdrop.svelte.js';
  import { t } from '../../lib/i18n.js';
  import { agySubagents } from '../../lib/agy/subagents.svelte.js';
  import { computeBgWait } from '../../lib/agy/run-status.js';
  import SessionRow from './SessionRow.svelte';
  import AgyContextMenu from './AgyContextMenu.svelte';
  import AgyPinIcon from './AgyPinIcon.svelte';
  import AgyPeerDuo from './AgyPeerDuo.svelte';
  import AgyDecorStatus from './AgyDecorStatus.svelte';
  import AgyDecorFooter from './AgyDecorFooter.svelte';
  import AgyDecorCard from './AgyDecorCard.svelte';
  import { workspaceUi, decorOf, decorFor, sessionMark, workspaceMenuItems, runWorkspaceAction, openTarget } from '../../lib/pluginUi.svelte.js';
  import { pluginIcon } from '../../lib/pluginIcons.js';
  import { tr } from '../../lib/i18n.js';
  import { longPress } from '../../lib/agy/long-press.js';
  import { decorFx, trackDecor, shownDecor } from '../../lib/agy/decor-flight.svelte.js';
  import { cardHoverIn, cardHoverOut, cardPin, closeCard } from '../../lib/agy/decor-card.svelte.js';
  import { decorKey, duoPeers, pluginMenuEntries } from '../../lib/agy/decor-view.js';

  bindAgySessionManageBus();

  const { wide = false, onCollapse = null } = $props();

  const GROUP_PEEK = 8;
  const canExitToHome = $derived(rootScreen() !== 'agy' && !isPageWindow());

  let asideEl = $state(null);
  let query = $state('');
  let collapsedProjects = $state({});
  let expandedProjects = $state({});
  let moreProjectsOpen = $state(false);
  let menuSid = $state('');
  let favCollapsed = $state(false);
  let wsMenu = $state(null);

  // —— 工作空间拖动排序 + 拖出抽屉引用文件夹 ——
  const mouseDnd = $derived(pointer.fine);
  let insAt = $state(-1);
  let touchProjPath = $state('');
  const projHold = makeHold();

  $effect(() => { if (!drag.on && touchProjPath) touchProjPath = ''; });

  // 窄屏抽屉：手指拎着会话或工作空间往右拖出抽屉边缘时自动收起抽屉，露出后方的输入框以便直接松手引用
  $effect(() => {
    if (wide || !agy.drawerOpen || !asideEl || !drag.on) return;
    const pl = untrack(() => dragPayload());
    if (!isAgyChatRef(pl) && !isAgyProjRef(pl)) return;
    const x = drag.x;
    const r = untrack(() => asideEl.getBoundingClientRect());
    if (x > r.right + 6) untrack(() => { agy.drawerOpen = false; });
  });

  function sameDirPath(a = '', b = '') {
    const ka = normCmpDir(a);
    const kb = normCmpDir(b);
    return Boolean(ka && kb && ka === kb);
  }
  function openGroupMenu(ev, pgrp) {
    if (!pgrp || pgrp.unassigned || (!pgrp.path && !pgrp.projectId)) return;
    menuSid = '';
    wsMenu = {
      key: pgrp.key,
      pgrp,
      point: ev?.x != null && ev?.y != null ? { x: ev.x, y: ev.y } : null,
      anchorEl: ev?.el || null,
      pointerId: ev?.via === 'hold' ? ev.pointerId : null,
    };
  }

  const wsMenuItems = $derived.by(() => {
    if (!wsMenu) return [];
    const pgrp = wsMenu.pgrp;
    const pluginItems = pgrp.path ? pluginMenuEntries(workspaceMenuItems('agy', { path: pgrp.path }), {
      label: (s) => tr(s),
      iconSvg: (n) => pluginIcon(n),
      onRun: (it) => runWorkspaceAction('agy', { plugin: it.plugin, id: it.id, path: pgrp.path, projectId: pgrp.projectId || null }),
    }) : [];
    return buildSidebarWorkspaceMenu({
      pgrp,
      projects: agy.projects,
      recentDirs: agy.recentDirs,
      defaultCwd: agy.defaultCwd,
      sessionIds: flatItems(pgrp).map((s) => s.sessionId),
      pluginItems,
      onPin: (arg) => pinAgyProject(arg),
      onRename: (arg) => renameAgyProject(arg),
      onHideAll: (ids, name) => hideAgyWorkspaceSessions(ids, name),
      onRemove: (arg) => deleteAgyProject(arg),
    });
  });

  // —— 插件工作区外观 ——
  $effect(() => {
    const list = decorOf('agy');
    trackDecor(list.flatMap((d) => d.items), workspaceUi.loaded.agy);
  });
  const decorOfGroup = (pgrp) => (pgrp?.path ? shownDecor(decorFor('agy', pgrp.path), pgrp.path) : null);
  const decorCtx = (decor, pgrp) => ({ plugin: decor.plugin, path: pgrp.path, agent: 'agy', projectId: pgrp.projectId || null });
  const wsMenuDecor = $derived(wsMenu ? decorOfGroup(wsMenu.pgrp) : null);
  const wsMenuSub = $derived.by(() => {
    if (!wsMenu) return '';
    const head = wsMenuDecor?.card?.title ? tr(wsMenuDecor.card.title) : '';
    return head ? `${head} · ${wsMenu.pgrp.path || ''}` : wsMenu.pgrp.path;
  });
  const projectIdOfPath = (p) => allRealProjects.find((g) => g.path && sameDirPath(g.path, p))?.projectId || null;
  // 点头像组：按插件给的去向走（openTarget 认 folder / session / action…）
  function openDuo(path) {
    const it = decorFor('agy', path);
    if (it?.open) openTarget(it.open, { plugin: it.plugin, path, agent: 'agy' });
  }
  function onDuoHold(ev, pgrp) {
    if (ev.via === 'contextmenu') { closeCard(); openGroupMenu({ x: ev.x, y: ev.y, el: ev.el }, pgrp); return; }
    cardPin(ev.el, pgrp.path);
  }

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

  const grouped = $derived(groupSessionsByProjectAndTime(agy.sessions, agy.projects, query, undefined, { order: agy.projectOrder }));
  const activeSet = $derived(new Set(agy.activeSessionIds));
  // 说完了、后台还在跑的会话：正看着的那个以它自己的子代理树为准（更及时），其余看服务端报的名单
  const bgSet = $derived.by(() => {
    const set = new Set(agy.bgSessionIds);
    const cur = agy.sessionId;
    if (cur && agySubagents.sessionId === cur && agySubagents.tree) {
      if (computeBgWait(agySubagents.tree)) set.add(cur); else set.delete(cur);
    }
    return set;
  });
  const hasQuery = $derived(Boolean(query.trim()));
  const showContent = $derived(Boolean(contentQueryOf(query)));
  const favClosed = $derived(!hasQuery && favCollapsed);
  const currentInMore = $derived(Boolean(
    agy.sessionId && grouped.moreProjects.some((g) => groupHasCurrent(g))
  ));
  const projDragging = $derived((agySideDrag.kind === 'project' || !!touchProjPath) && !hasQuery);
  const showMoreList = $derived(moreProjectsOpen || currentInMore || projDragging);
  const allRealProjects = $derived([...grouped.primaryProjects, ...grouped.moreProjects]);
  const visibleRealCount = $derived(grouped.primaryProjects.length + (showMoreList ? grouped.moreProjects.length : 0));

  function insIndexAt(listEl, y) {
    if (!listEl) return -1;
    const blocks = listEl.querySelectorAll('.sb-group[data-proj-path]');
    for (let i = 0; i < blocks.length; i++) {
      const r = blocks[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return blocks.length;
  }

  function applyProjReorder(targetPath, toIndex) {
    const paths = allRealProjects.map((g) => g.path).filter(Boolean);
    const next = moveOrderPath(paths, targetPath, toIndex);
    if (next) reorderAgyProjects(next);
  }

  function onProjDragStart(ev, pgrp) {
    if (!mouseDnd || pgrp.unassigned || !pgrp.path) { ev.preventDefault(); return; }
    ev.stopPropagation();
    const rec = { kind: 'project', id: pgrp.key, path: pgrp.path, title: pgrp.name, cwd: pgrp.path };
    try {
      ev.dataTransfer.setData(AGY_SIDE_DT, JSON.stringify({ kind: 'project', path: pgrp.path, name: pgrp.name }));
      ev.dataTransfer.effectAllowed = 'copyMove';
    } catch {}
    makeAgyDragGhost(ev, pgrp.name, 'project');
    beginAgyMouseDrag(rec);
  }

  function onProjDragEnd() {
    endAgyMouseDrag();
    insAt = -1;
  }

  function onProjListDragOver(ev) {
    const rec = getRawAgySideDrag();
    if (!rec || rec.kind !== 'project' || hasQuery) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = 'move'; } catch {}
    insAt = insIndexAt(ev.currentTarget, ev.clientY);
  }

  function onProjListDragLeave(ev) {
    if (!ev.currentTarget.contains(ev.relatedTarget)) insAt = -1;
  }

  function onProjListDrop(ev) {
    const rec = getRawAgySideDrag();
    if (!rec || rec.kind !== 'project' || hasQuery) return;
    ev.preventDefault();
    const at = insIndexAt(ev.currentTarget, ev.clientY);
    insAt = -1;
    applyProjReorder(rec.path, at);
  }

  function onProjPointerDown(ev, pgrp) {
    if (ev.pointerType === 'mouse' || pgrp.unassigned || !pgrp.path) return;
    projHold.arm(ev, (f) => {
      const ok = beginDrag(
        { type: AGY_PROJ_REF, id: pgrp.key, path: pgrp.path, name: pgrp.name, isDir: true },
        {
          x: f.x,
          y: f.y,
          pointerId: f.pointerId,
          pointerType: f.pointerType,
          sourceEl: f.el,
          ghost: { name: pgrp.name, isDir: true },
          onStay: (pt) => openGroupMenu({ x: pt.clientX, y: pt.clientY, el: f.el, via: 'hold', pointerId: f.pointerId }, pgrp),
        },
      );
      if (ok) touchProjPath = pgrp.path;
    });
  }
  const onProjPointerMove = (ev) => projHold.track(ev);
  const onProjPointerUp = () => projHold.disarm();

  function onProjContextMenu(ev, pgrp) {
    if (pgrp.unassigned || (!pgrp.path && !pgrp.projectId)) return;
    ev.preventDefault();
    openGroupMenu({ x: ev.clientX, y: ev.clientY, el: ev.currentTarget }, pgrp);
  }

  const listAt = (x, y) => { try { return document.elementFromPoint(x, y)?.closest('.sb-projs') || null; } catch { return null; } };
  const projListZone = {
    key: 'agy-proj-order',
    label: t('放在这里'),
    effect: 'move',
    accept: (pl) => isAgyProjRef(pl) && !hasQuery,
    drop: (pl, pt) => applyProjReorder(pl.path, insIndexAt(listAt(pt.x, pt.y), pt.y)),
  };
  const touchIns = $derived(touchProjPath && drag.overKey === 'agy-proj-order' ? insIndexAt(listAt(drag.x, drag.y), drag.y) : -1);
  const insShown = $derived(touchProjPath ? touchIns : insAt);
  const liftedProjPath = $derived(agySideDrag.kind === 'project' ? agySideDrag.path : touchProjPath);

  function flatItems(pgrp) {
    return (pgrp.timeGroups || []).flatMap((tg) => tg.items);
  }

  function groupHasCurrent(pgrp) {
    return Boolean(agy.sessionId && flatItems(pgrp).some((s) => s.sessionId === agy.sessionId));
  }

  function isGroupCollapsed(pgrp) {
    if (projDragging) return true;
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
<aside bind:this={asideEl} class="agy-sidebar" onclick={() => { if (menuSid) menuSid = ''; }}>
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

  <div class="sb-list" use:dragScrollGuard>
    {#snippet sessionRow(item, decor = null)}
      <SessionRow
        {item}
        gutter={!!decor}
        by={decor ? sessionMark('agy', item.sessionId)?.by || '' : ''}
        isCurrent={agy.sessionId === item.sessionId}
        isLive={activeSet.has(item.sessionId) || (agy.sessionId === item.sessionId && agy.busy)}
        pending={agy.pendingSessions[item.sessionId] || ''}
        bgWait={bgSet.has(item.sessionId)}
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
      {#if grouped.favorites.length > 0 && !projDragging}
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

      {#snippet projectGroupBlock(pgrp, orderIdx)}
        {@const closed = isGroupCollapsed(pgrp)}
        {@const items = closed ? [] : visibleItems(pgrp)}
        {@const restCount = pgrp.count - items.length}
        {@const canDragProj = !pgrp.unassigned && !!pgrp.path}
        {@const isLifted = canDragProj && liftedProjPath && sameDirPath(liftedProjPath, pgrp.path)}
        {@const decor = decorOfGroup(pgrp)}
        {@const dkey = decor ? decorKey(pgrp.path) : ''}
        <section
          class="sb-group"
          class:decor={!!decor}
          class:collab={!!decor?.panel}
          class:entering={!!dkey && !!decorFx.entering[dkey]}
          class:leaving={!!dkey && !!decorFx.leaving[dkey]}
          class:flying={!!dkey && !!decorFx.flying[dkey]}
          data-decor-key={dkey || undefined}
          data-proj-path={canDragProj && orderIdx >= 0 ? pgrp.path : undefined}
          class:lifted={isLifted}
          class:ins={orderIdx >= 0 && insShown === orderIdx}
          class:ins-end={orderIdx >= 0 && orderIdx === visibleRealCount - 1 && insShown === visibleRealCount}
        >
          {#if decor?.panel}<span class="sb-box" aria-hidden="true"></span>{/if}
          <div class="sb-group-bar">
            <button
              type="button"
              class="sb-group-head"
              class:draggable-proj={canDragProj}
              class:menu-target={wsMenu?.key === pgrp.key}
              draggable={mouseDnd && canDragProj}
              ondragstart={(ev) => onProjDragStart(ev, pgrp)}
              ondragend={onProjDragEnd}
              onpointerdown={(ev) => onProjPointerDown(ev, pgrp)}
              onpointermove={onProjPointerMove}
              onpointerup={onProjPointerUp}
              onpointercancel={onProjPointerUp}
              oncontextmenu={(ev) => onProjContextMenu(ev, pgrp)}
              onclick={() => toggleProjectGroup(pgrp)}
              title={pgrp.path || pgrp.name}
              aria-expanded={!closed}
            >
              <span class="msr gchev" class:closed>expand_more</span>
              <span class="gname">{pgrp.name}</span>
              {#if pgrp.pinned}
                <span class="gpin" title={t('已置顶')} aria-label={t('已置顶')}>
                  <AgyPinIcon filled size={11} />
                </span>
              {/if}
              {#if pgrp.parentHint}<span class="ghint">{pgrp.parentHint}</span>{/if}
            </button>
            {#if decor}
              {@const dOpen = decorFor('agy', pgrp.path)?.open}
              <!-- 点一下去哪由插件定（外观条目的 open，如 { folder } = 到 Claude 的这个项目）；没给就不跳。悬停出共用卡、长按 / 右键照旧；点文件夹名仍是展开收起 -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <span
                class="sb-duo"
                class:jumps={!!dOpen}
                role={dOpen ? 'button' : undefined}
                tabindex={dOpen ? 0 : undefined}
                aria-label={dOpen ? t('到 Claude 的这个项目') : undefined}
                onclick={(e) => { if (!dOpen) return; e.stopPropagation(); closeCard(); openDuo(pgrp.path); }}
                onkeydown={(e) => { if (dOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDuo(pgrp.path); } }}
                onpointerenter={(e) => { if (e.pointerType === 'mouse') cardHoverIn(e.currentTarget, pgrp.path); }}
                onpointerleave={(e) => { if (e.pointerType === 'mouse') cardHoverOut(); }}
                use:longPress={{ onTrigger: (ev) => onDuoHold(ev, pgrp) }}
              >
                <AgyPeerDuo peers={duoPeers(decor)} busy={decor.busy} size={20} cut={decor.panel ? 'var(--ag-box)' : 'var(--ag-side-bg)'} />
              </span>
            {/if}
            {#if !pgrp.unassigned && (pgrp.path || pgrp.projectId) && !projDragging}
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

          {#if decor}
            <AgyDecorStatus status={decor.status || null} ctx={decorCtx(decor, pgrp)} />
          {/if}

          {#if !closed}
            {#each items as item (item.sessionId)}
              {@render sessionRow(item, decor)}
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
            {#if decor?.footer}
              <AgyDecorFooter footer={decor.footer} ctx={decorCtx(decor, pgrp)} />
            {/if}
          {/if}
        </section>
      {/snippet}

      {#if hasQuery}
        {#each grouped.byProject as pgrp (pgrp.key)}
          {@render projectGroupBlock(pgrp, -1)}
        {/each}
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="sb-projs"
          class:reordering={projDragging}
          ondragover={onProjListDragOver}
          ondragleave={onProjListDragLeave}
          ondrop={onProjListDrop}
          use:dropZone={projListZone}
        >
          {#each grouped.primaryProjects as pgrp, pi (pgrp.key)}
            {@render projectGroupBlock(pgrp, pi)}
          {/each}

          {#if grouped.moreProjects.length > 0}
            {#if !projDragging}
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
            {/if}
            {#if showMoreList}
              <div class="sb-more-body">
                {#each grouped.moreProjects as pgrp, mi (pgrp.key)}
                  {@render projectGroupBlock(pgrp, grouped.primaryProjects.length + mi)}
                {/each}
              </div>
            {/if}
          {/if}
        </div>

        {#if !projDragging}
          {#each grouped.otherProjects as pgrp (pgrp.key)}
            {@render projectGroupBlock(pgrp, -1)}
          {/each}
        {/if}
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

  {#if wsMenu}
    <AgyContextMenu
      point={wsMenu.point}
      anchorEl={wsMenu.anchorEl}
      pointerId={wsMenu.pointerId}
      title={wsMenu.pgrp.name}
      subtitle={wsMenuSub}
      headPeers={wsMenuDecor ? duoPeers(wsMenuDecor) : null}
      headBusy={wsMenuDecor?.busy || []}
      items={wsMenuItems}
      onClose={() => { wsMenu = null; }}
    />
  {/if}

  <AgyDecorCard projectIdOf={projectIdOfPath} />
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
    scrollbar-gutter: stable;
    padding: 0 8px 12px;
  }
  @supports not (selector(::-webkit-scrollbar)) {
    .sb-list {
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
    }
    .sb-list:hover {
      scrollbar-color: var(--ag-sb-thumb) transparent;
    }
  }

  .sb-projs {
    position: relative;
  }
  .sb-projs.reordering .sb-group {
    margin-bottom: 2px;
  }
  .sb-group {
    position: relative;
    margin-bottom: 6px;
    transition: opacity 0.14s;
  }
  .sb-group.lifted {
    opacity: 0.35;
  }
  /* 工作空间拖动排序的插入线 */
  .sb-group.ins::before,
  .sb-group.ins-end::after {
    content: '';
    position: absolute;
    left: 6px;
    right: 6px;
    height: 2px;
    border-radius: 2px;
    background: var(--ag-accent);
    pointer-events: none;
    z-index: 4;
  }
  .sb-group.ins::before { top: -1px; }
  .sb-group.ins-end::after { bottom: -1px; }

  /* 共用文件夹：整组收进一块圆角底板（比侧栏底色亮一档 + 发丝边），左右各探出 3px；其余文件夹仍平铺 */
  .sb-group.collab { margin: 10px 0; padding: 3px 0 4px; }
  .sb-group.decor > :global(*:not(.sb-box)) { position: relative; }
  .sb-box {
    position: absolute;
    inset: 0 -3px;
    border-radius: 14px;
    background: var(--ag-box);
    box-shadow: inset 0 0 0 1px var(--ag-box-bd), var(--ag-box-sh);
    pointer-events: none;
  }
  .sb-group.collab > .sb-group-bar { margin-top: 0; }
  .sb-group.decor .sb-group-head { color: var(--ag-on-sub); }
  .sb-group.decor .sb-group-head:hover { color: var(--ag-on); }
  .sb-duo { display: inline-flex; flex: none; margin: 0 3px 0 4px; padding: 2px; border-radius: 999px; cursor: default; -webkit-touch-callout: none; user-select: none; outline: none; transition: background var(--ag-dur-micro) var(--ag-ease-std); }
  .sb-duo.jumps { cursor: pointer; }
  .sb-duo.jumps:hover { background: var(--ag-hover); }
  .sb-duo:focus-visible { box-shadow: 0 0 0 2px var(--ag-accent-bd); }
  .sb-group.flying .sb-duo { visibility: hidden; }
  .sb-group.decor .sb-peek { padding-left: 26px; }

  .sb-group-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-top: 6px;
  }
  .sb-projs.reordering .sb-group-bar {
    margin-top: 2px;
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
    -webkit-touch-callout: none;
    user-select: none;
    transition: transform 160ms var(--ag-ease-std), background var(--ag-dur-micro) var(--ag-ease-std), color var(--ag-dur-micro) var(--ag-ease-std);
  }
  .sb-group-head:hover { color: var(--ag-on-sub); background: var(--ag-hover); }
  .sb-group-head.menu-target { color: var(--ag-on); background: var(--ag-active); }
  .gpin {
    flex: none;
    display: inline-flex;
    align-items: center;
    color: var(--ag-on-faint);
    opacity: 0.85;
  }
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
