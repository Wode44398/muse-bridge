<script>
  // Antigravity 顶层分页外壳：侧栏 / 对话列 / 右侧工作区三栏编排与弹层挂载。
  // 遵循单一职责入口原则：模型/思考/模式/新对话文件夹只在输入框底栏控制，顶栏只承担导航与会话状态。
  import '../../components/agy/theme.css';
  import { untrack, onMount } from 'svelte';
  import { ui, rootScreen } from '../../lib/state.svelte.js';
  import { closePage } from '../../lib/pageMorph.js';
  import { registerCloser } from '../../lib/nav.js';
  import { layout, makeSideYield } from '../../lib/layout.svelte.js';
  import { agyDock, dock as claudeDock, openAgyDock, closeAgyDock } from '../../lib/dock.svelte.js';
  import { reportUi } from '../../lib/uiReport.js';
  import { agy, bootAgy, newAgyChat, createAgyProjectAt, refreshAgySessions, checkAgyForegroundSync } from '../../lib/agy/store.svelte.js';
  import { agySubagents, refreshAgySubagents } from '../../lib/agy/subagents.svelte.js';
  import { agySwarm, refreshAgySwarm } from '../../lib/agy/swarm.svelte.js';
  import { agyPrefs } from '../../lib/agy/settings.svelte.js';
  import { t } from '../../lib/i18n.js';
  import { captureHeroTransition } from '../../lib/agy/hero.js';
  import { agyRipple } from '../../lib/agy/ripple.js';
  import { noticeSessionSeen } from '../../lib/notices.svelte.js';
  import ProjectPicker from '../ProjectPicker.svelte';
  import Sidebar from './Sidebar.svelte';
  import Welcome from './Welcome.svelte';
  import Thread from './Thread.svelte';
  import Composer from './Composer.svelte';
  import ModelSheet from './ModelSheet.svelte';
  import ProjectSheet from './ProjectSheet.svelte';
  import AgyWorkspace from './AgyWorkspace.svelte';

  const SB_KEY = 'bridge-agy-sidebar';
  const SB_W_KEY = 'bridge-agy-sidebar-w';
  const DEFAULT_SB_W = 264;
  const readSb = () => { try { return localStorage.getItem(SB_KEY) !== '0'; } catch { return true; } };
  const readSbW = () => {
    try {
      const n = Number(localStorage.getItem(SB_W_KEY));
      if (Number.isFinite(n) && n >= 220 && n <= 380) return n;
    } catch {}
    return DEFAULT_SB_W;
  };

  const innerW = $derived(layout.w);
  let sidebarOpenWide = $state(readSb());
  let sidebarWidth = $state(readSbW());
  let resizing = $state(false);

  const wide = $derived(layout.side);
  const effectiveSidebarW = $derived(
    wide && agyDock.open
      ? Math.min(sidebarWidth, Math.max(210, innerW - 340 - 380))
      : sidebarWidth
  );
  const subActive = $derived(Boolean(
    (agySubagents.sessionId === agy.sessionId && agySubagents.tree?.hasActive)
    || (agySwarm.sessionId === agy.sessionId && agySwarm.data?.hasActive)
  ));
  const wsLiveDot = $derived(Boolean(agyDock.termLive || agyDock.browserLive || subActive));
  const isActiveScreen = $derived(ui.screen === 'agy');

  // 工作区协同：agent 的 workspace view 读的「工作台」状态以前只有 Claude 页在报——在这一页时报这一页的卡片；
  // 离开时把 Claude 页那份报回去（Claude 页常驻挂载，它自己的上报不会因为切回去而重跑）。
  const dockOf = (d) => ({ open: !!d.open, view: d.open ? (Array.isArray(d.views) && d.views.length ? d.views.join('+') : (d.view || '')) : '' });
  $effect(() => {
    if (!isActiveScreen) return;
    reportUi({ dock: dockOf(agyDock) });
    return () => { if (ui.screen !== 'agy') reportUi({ dock: dockOf(claudeDock) }); };
  });
  const agyTheme = $derived.by(() => {
    const pref = agyPrefs.settings.theme;
    if (pref === 'azure') return 'dark';
    if (pref === 'daylight') return 'light';
    return ui.theme === 'light' ? 'light' : 'dark';
  });
  const fontSizeMode = $derived(agyPrefs.settings.fontSize || 'md');
  const chatMode = $derived(Boolean(agy.sessionId || agy.messages.length > 0));

  // 欢迎页 ⇄ 对话的接力（lib/agy/hero.js）：DOM 换掉之前量好旧 logo 与输入框的位置，
  // 新位置的组件挂载时从这里接过去飞 / 滑到位。$effect.pre 在本组件的 DOM 更新之前跑。
  let pageEl = $state(null);
  let prevChat = untrack(() => chatMode);
  $effect.pre(() => {
    const c = chatMode;
    untrack(() => {
      if (c === prevChat) return;
      prevChat = c;
      if (ui.screen === 'agy' && pageEl) captureHeroTransition(c ? 'toChat' : 'toWelcome', pageEl);
    });
  });
  // 液态标记引擎 120KB：分页一打开就在后台拉好，欢迎页 logo 与底部状态栏都不用等
  onMount(() => {
    const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 300));
    idle(() => { import('../../lib/agy/antigravity-logo.js').catch(() => {}); });
  });
  const sidebarShown = $derived(wide ? sidebarOpenWide : false);

  const folderName = $derived(
    agy.cwd ? (agy.cwd.split(/[\\/]/).filter(Boolean).pop() || agy.cwd) : ''
  );

  const yielder = makeSideYield(() => sidebarOpenWide, (v) => { sidebarOpenWide = v; });
  $effect(() => {
    const open = agyDock.open;
    void layout.medium;
    untrack(() => yielder.apply(open));
  });

  function setSidebar(open) {
    sidebarOpenWide = open;
    if (agyDock.open) yielder.forget();
    try { localStorage.setItem(SB_KEY, open ? '1' : '0'); } catch {}
  }

  function toggleWorkspace() {
    if (agyDock.open) closeAgyDock();
    else openAgyDock();
  }

  // 新对话（还没建会话）时才可换文件夹；建立后目录固定
  const canPickFolder = $derived(!agy.sessionId && agy.messages.length === 0);
  const pickLabel = $derived.by(() => {
    const proj = agy.projects.find((p) => p.id === agy.projectId);
    if (proj?.name) return proj.name;
    const dir = agy.cwd || agy.defaultCwd;
    if (dir) return dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    return t('选择文件夹');
  });
  function openFolderPicker(e) {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    agy.popAnchor = { left: r.left, top: r.top, bottom: r.bottom, width: r.width };
    agy.popAnchorEl = el;
    agy.sheetKind = '';
    agy.projectSheetOpen = !agy.projectSheetOpen;
  }

  function openSessionFiles() {
    openAgyDock('files');
  }

  // 进页刷新与窗控配色分开追踪：切主题时只更新 pageChrome，避免误重拉会话列表或先清 null 触发双次 WCO 刷新
  $effect(() => {
    if (!isActiveScreen) return;
    untrack(() => {
      if (agy.booted) refreshAgySessions();
      ui.taskDone = false;
    });
    bootAgy();
    return () => {
      ui.pageChrome = null;
    };
  });

  $effect(() => {
    if (!isActiveScreen) return;
    const dark = agyTheme === 'dark';
    untrack(() => {
      ui.pageChrome = { dark, bg: dark ? '#131313' : '#fafafa' };
    });
  });

  // 正看着某个会话（回到这一页、切回前台、换了会话）：收掉通知横幅，并同步后台子代理与自动唤醒状态
  $effect(() => {
    if (!isActiveScreen) return;
    const sid = agy.sessionId;
    const seen = () => {
      if (sid && !document.hidden) {
        untrack(() => {
          noticeSessionSeen(sid);
          checkAgyForegroundSync();
        });
      }
    };
    seen();
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  });

  // 有活跃子代理或协作群且右侧代理面板未打开时，在当前会话页保持轻量轮询以更新对话里的卡片与顶栏状态点
  $effect(() => {
    if (!isActiveScreen) return;
    const sid = agy.sessionId;
    const watchingPanel = agyDock.open && agyDock.views.includes('agents');
    if (!sid || !subActive || watchingPanel) return;
    const tid = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) {
        refreshAgySubagents(sid, { silent: true });
        refreshAgySwarm(sid, { silent: true });
      }
    }, 3000);
    return () => clearInterval(tid);
  });

  $effect(() => registerCloser('agyLayer', () => {
    if (!wide && agy.drawerOpen) { agy.drawerOpen = false; return true; }
    if (agyDock.open) { closeAgyDock(); return true; }
    return false;
  }));

  function startResize(ev) {
    ev.preventDefault();
    const sash = ev.currentTarget;
    const pid = ev.pointerId;
    try { sash?.setPointerCapture?.(pid); } catch {}
    resizing = true;
    const startX = ev.clientX;
    const startW = sidebarWidth;
    const onMove = (mev) => {
      sidebarWidth = Math.min(380, Math.max(220, Math.round(startW + (mev.clientX - startX))));
    };
    const onUp = () => {
      if (!resizing) return;
      resizing = false;
      try { sash?.releasePointerCapture?.(pid); } catch {}
      try { localStorage.setItem(SB_W_KEY, String(sidebarWidth)); } catch {}
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      sash?.removeEventListener?.('lostpointercapture', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    sash?.addEventListener?.('lostpointercapture', onUp);
  }

  function resetSidebarWidth() {
    sidebarWidth = DEFAULT_SB_W;
    try { localStorage.removeItem(SB_W_KEY); } catch {}
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={pageEl}
  use:agyRipple
  class="agy-page agy-root"
  class:light={agyTheme === 'light'}
  class:has-offline-bar={ui.offline}
  class:ws-open={wide && agyDock.open}
  class:resizing
  class:ag-compact={!wide}
  data-ag-font={fontSizeMode}
>
  <div class="agy-layout">
    {#if wide}
      {#if sidebarShown}
        <div class="agy-side-dock" style:width="{effectiveSidebarW}px">
          <Sidebar wide={true} onCollapse={() => setSidebar(false)} />
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="agy-side-sash"
            onpointerdown={startResize}
            ondblclick={resetSidebarWidth}
            role="separator"
            aria-orientation="vertical"
            aria-label={t('调整侧栏宽度')}
          ></div>
        </div>
      {/if}
    {:else if agy.drawerOpen}
      <div class="agy-drawer-layer">
        <button
          type="button"
          class="agy-drawer-scrim"
          aria-label={t('关闭侧栏')}
          onclick={() => { agy.drawerOpen = false; }}
        ></button>
        <div class="agy-drawer-panel">
          <Sidebar wide={false} />
        </div>
      </div>
    {/if}

    <main class="agy-main" class:welcome={!chatMode}>
      <header class="agy-topbar">
        <div class="tb-left">
          {#if !wide}
            <button
              type="button"
              class="tb-icon-btn"
              onclick={() => { agy.drawerOpen = true; }}
              aria-label={t('打开侧栏')}
              title={t('打开侧栏')}
            >
              <span class="msr4">menu</span>
            </button>
          {:else if !sidebarShown}
            {#if rootScreen() !== 'agy'}
              <button
                type="button"
                class="tb-icon-btn"
                onclick={() => closePage('agy')}
                title={t('返回主页')}
                aria-label={t('返回主页')}
              >
                <span class="msr4">arrow_back</span>
              </button>
            {/if}
            <button
              type="button"
              class="tb-icon-btn"
              onclick={() => setSidebar(true)}
              title={t('展开侧栏')}
              aria-label={t('展开侧栏')}
            >
              <span class="msr4">left_panel_open</span>
            </button>
            <button
              type="button"
              class="tb-icon-btn"
              onclick={() => newAgyChat()}
              title={t('新建对话')}
              aria-label={t('新建对话')}
            >
              <span class="msr4">edit_square</span>
            </button>
          {/if}

          <!-- 工作空间文件夹紧挨侧栏按钮：新对话时是选择器（向下弹列表），进了对话就固定、点它开文件面板；对话标题跟在后面成面包屑 -->
          <div class="tb-title-wrap">
            {#if canPickFolder}
              <button
                type="button"
                class="tb-folder-btn pick"
                class:on={agy.projectSheetOpen}
                onclick={openFolderPicker}
                title={agy.cwd || agy.defaultCwd || t('选择这次对话的工作空间文件夹')}
              >
                <span class="msr">folder</span>
                <span class="tb-folder">{pickLabel}</span>
                <span class="msr tb-chev" aria-hidden="true">expand_more</span>
              </button>
            {:else if folderName}
              <button
                type="button"
                class="tb-folder-btn"
                onclick={openSessionFiles}
                title={agy.cwd || folderName}
              >
                <span class="msr">folder</span>
                <span class="tb-folder">{folderName}</span>
              </button>
            {/if}
            {#if chatMode}
              {#if canPickFolder || folderName}<span class="tb-sep" aria-hidden="true">/</span>{/if}
              <span class="tb-title" title={agy.title || t('新对话')}>{agy.title || t('新对话')}</span>
            {/if}
          </div>
        </div>

        <div class="tb-right">
          {#if !wide}
            <button
              type="button"
              class="tb-icon-btn"
              onclick={() => newAgyChat()}
              aria-label={t('新建对话')}
              title={t('新建对话')}
            >
              <span class="msr4">edit_square</span>
            </button>
          {/if}
          {#if !(wide && agyDock.open)}
            <button
              type="button"
              class="tb-icon-btn ws-btn"
              onclick={toggleWorkspace}
              title={t('侧边工作区')}
              aria-label={t('侧边工作区')}
            >
              <span class="msr4">dock_to_right</span>
              {#if wsLiveDot}
                <i class="tb-ws-dot"></i>
              {/if}
            </button>
          {/if}
        </div>
      </header>

      {#if chatMode}
        <Thread />
        <Composer />
      {:else}
        <div class="agy-stage" class:docked={!wide}>
          <Welcome compact={!wide} />
          <Composer centered docked={!wide} />
        </div>
      {/if}
    </main>

    <AgyWorkspace
      {wide}
      leftSidebarWidth={sidebarShown ? effectiveSidebarW : 0}
    />
  </div>

  {#if agy.sheetKind}
    {#key agy.sheetKind}
      <ModelSheet kind={agy.sheetKind} onClose={() => { agy.sheetKind = ''; }} />
    {/key}
  {/if}

  {#if agy.projectSheetOpen}
    <ProjectSheet mode="project" onClose={() => { agy.projectSheetOpen = false; }} />
  {/if}

  {#if agy.hiddenOpen}
    <ProjectSheet mode="hidden" onClose={() => { agy.hiddenOpen = false; }} />
  {/if}

  {#if agy.pickerOpen}
    <ProjectPicker
      title={t('选择工作空间文件夹')}
      hint={t('把文件夹拖进底栏，作为 Antigravity 会话的工作目录')}
      preferPath={agy.cwd || ''}
      onPick={createAgyProjectAt}
      onClose={() => { agy.pickerOpen = false; }}
    />
  {/if}
</div>

<style>
  .agy-page {
    position: fixed;
    inset: 0;
    background: var(--ag-bg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .agy-page.has-offline-bar {
    padding-top: 26px;
    box-sizing: border-box;
  }
  .agy-page.resizing {
    user-select: none;
    cursor: col-resize;
  }
  .agy-page.resizing :global(iframe) {
    pointer-events: none;
  }

  .agy-layout {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .agy-side-dock {
    position: relative;
    height: 100%;
    flex: none;
  }
  .agy-side-sash {
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 8px;
    cursor: col-resize;
    touch-action: none;
    -webkit-app-region: no-drag;
    z-index: 10;
  }
  .agy-side-sash::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: transparent;
    transition: background var(--ag-dur-micro) var(--ag-ease-std);
  }
  .agy-side-sash:hover::after,
  .agy-page.resizing .agy-side-sash::after {
    background: var(--ag-accent-bd);
  }

  .agy-drawer-layer {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
  }
  .agy-drawer-scrim {
    position: absolute;
    inset: 0;
    background: var(--ag-scrim);
    animation: agy-scrim-fade var(--ag-dur-quick) var(--ag-ease-fade) both;
  }
  .agy-drawer-panel {
    position: relative;
    width: min(304px, 84vw);
    height: 100%;
    box-shadow: var(--ag-elev-shadow);
    animation: agy-slide-in var(--ag-dur-base) var(--ag-ease-decel) both;
  }
  @keyframes agy-scrim-fade {
    from { opacity: 0; }
  }
  @keyframes agy-slide-in {
    from { transform: translateX(-100%); }
  }

  .agy-main {
    position: relative;
    flex: 1;
    min-width: min(360px, 100%);
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .agy-topbar {
    height: calc(var(--ag-top-h, 44px) + var(--sat, 0px));
    padding: var(--sat, 0px) 10px 0;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: none;
  }
  /* 桌面壳无边框窗口：仅当对话列真的贴着窗口右缘（工作区未开）时避让系统窗控 */
  :global(html[data-wco="1"]) .agy-page:not(.ws-open) .agy-topbar {
    padding-right: calc(8px + var(--wco-right, 0px));
  }
  .tb-left,
  .tb-right {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  .tb-left { flex: 1; }
  .tb-icon-btn {
    position: relative;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
    flex: none;
    transition: background var(--ag-dur-micro) var(--ag-ease-std), color var(--ag-dur-micro) var(--ag-ease-std);
  }
  .tb-icon-btn:hover {
    background: var(--ag-hover);
    color: var(--ag-on);
  }
  .tb-icon-btn .msr4 { font-size: 20px; }

  .tb-title-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0 6px;
  }
  .tb-title {
    font-size: 13.5px;
    font-weight: 520;
    color: var(--ag-on);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .tb-folder-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    max-width: 170px;
    padding: 0 7px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--ag-on-faint);
    transition: background var(--ag-dur-micro) var(--ag-ease-std), color var(--ag-dur-micro) var(--ag-ease-std);
  }
  .tb-folder-btn.pick { color: var(--ag-on-dim); }
  .tb-folder-btn.on { background: var(--ag-hover); color: var(--ag-on); }
  .tb-chev { font-size: 14px; margin-left: -2px; opacity: 0.7; transition: transform var(--ag-dur-micro) var(--ag-ease-std); }
  .tb-folder-btn.on .tb-chev { transform: rotate(180deg); }
  .tb-sep { flex: none; color: var(--ag-on-low); font-size: 13px; margin: 0 0 0 -5px; }
  .tb-folder-btn:hover {
    background: var(--ag-hover);
    color: var(--ag-on-sub);
  }
  .tb-folder-btn .msr { font-size: 14px; }
  .tb-folder {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tb-ws-dot {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ag-accent);
  }

  .agy-stage {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding-bottom: 11vh;
    overflow-y: auto;
  }
  @media (max-width: 899px) {
    .agy-stage { padding-bottom: 6vh; }
  }
  /* 手机档（layout.compact）：欢迎页输入框贴底、与对话态同一位置（发第一条消息时它不动，只有图标飞走）；
     图标独占上方空白，落在视觉中心——几何中心略偏上 */
  .agy-stage.docked {
    justify-content: flex-start;
    padding-bottom: 0;
    overflow: hidden;
  }
  .agy-stage.docked :global(.agy-welcome) {
    flex: 1;
    min-height: 0;
    justify-content: center;
    padding-bottom: 9vh;
  }

  /* 手机档整体放大一档：顶栏 52、按钮 40（图标 23）、文件夹与标题 14.5 / 15.5 */
  .agy-page.ag-compact .agy-topbar { padding-left: 8px; padding-right: 8px; }
  .agy-page.ag-compact .tb-icon-btn { width: 40px; height: 40px; border-radius: 10px; }
  .agy-page.ag-compact .tb-icon-btn .msr4 { font-size: 24px; }
  .agy-page.ag-compact .tb-title-wrap { padding: 0 2px; gap: 5px; }
  .agy-page.ag-compact .tb-folder-btn { height: 32px; max-width: 136px; padding: 0 8px; gap: 5px; border-radius: 8px; font-size: 14.5px; }
  .agy-page.ag-compact .tb-folder-btn .msr { font-size: 18px; }
  .agy-page.ag-compact .tb-folder-btn .tb-chev { font-size: 18px; }
  .agy-page.ag-compact .tb-title { font-size: 15.5px; }
  .agy-page.ag-compact .tb-sep { font-size: 15px; }
  .agy-page.ag-compact .tb-ws-dot { top: 9px; right: 9px; }
  @media (max-width: 560px) {
    .tb-folder-btn { max-width: 104px; padding: 0 5px; }
    .tb-title-wrap { padding: 0 2px; gap: 4px; }
  }
</style>
