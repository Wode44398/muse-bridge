<script>
  // Codex 分页外壳（只做编排）：窄栏 + 一张圆角面板（线程列表 / 对话 / 工作区）+ 页面级弹层。
  // 数据在 lib/codex/store.svelte.js；各块组件在本目录。设计依据《Codex分页重做方案》与 demo 第二版。
  import './theme.css';
  import { onMount, untrack } from 'svelte';
  import { ui, me } from '../../lib/state.svelte.js';
  import { layout, makeSideYield } from '../../lib/layout.svelte.js';
  import { registerCloser } from '../../lib/nav.js';
  import { reportUi } from '../../lib/uiReport.js';
  import { codexDock, dock as claudeDock, openCodexDock, closeCodexDock, setCodexDockWs, setCodexDockSession } from '../../lib/dock.svelte.js';
  import { drag, dropZone } from '../../lib/dragdrop.svelte.js';
  import { hasNativePickDirectory, nativePickDirectory } from '../../lib/nativeDesktop.js';
  import { t } from '../../lib/i18n.js';
  import { codex, current, bootCodex, refreshAll, newThread, createProjectAt, projectOf, leadOf, loadUsage } from '../../lib/codex/store.svelte.js';
  import { codexPrefs } from '../../lib/codex/prefs.svelte.js';
  import { closePop } from '../../lib/codex/ui.svelte.js';
  import { codexDrop, onWsDragOver, onWsDrop } from '../../lib/codex/page/drop.js';
  import { wireLaunch } from '../../lib/codex/page/launch.js';
  import CodexWorkspace from '../dock/CodexWorkspace.svelte';
  import ProjectPicker from '../ProjectPicker.svelte';
  import TitleBar from './TitleBar.svelte';
  import Rail from './Rail.svelte';
  import Sidebar from './Sidebar.svelte';
  import TopBar from './TopBar.svelte';
  import Home from './Home.svelte';
  import Thread from './Thread.svelte';
  import Composer from './Composer.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import UsageCard from './UsageCard.svelte';
  import PermMenu from './PermMenu.svelte';
  import ProjectMenu from './ProjectMenu.svelte';
  import AccountMenu from './AccountMenu.svelte';
  import TasksPage from './pages/TasksPage.svelte';
  import PluginsPage from './pages/PluginsPage.svelte';
  import LibraryPage from './pages/LibraryPage.svelte';

  const isActive = $derived(ui.screen === 'chatgpt');
  const thread = $derived(current());
  // 首页发出第一句后、服务端给出线程 id 之前，新线程那份里已经有这一轮：这时就该是线程视图了
  const home = $derived(!codex.sessionId && !thread.turns.length);
  const theme = $derived(ui.theme === 'light' ? 'light' : 'dark');
  // 手机宽度（容器查询 ≤640 那一档）抽屉化；工作区以侧列摆的门槛与其它分页一致
  const wide = $derived(layout.side);
  let wco = $state(false);
  let pickOpen = $state(false);
  let rootEl = $state(null);

  const attn = $derived(codex.sessions.some((s) => {
    const l = leadOf(s.id);
    return l === 'ask' || l === 'unread' || l === 'error';
  }));

  onMount(() => {
    bootCodex();
    const html = document.documentElement;
    const sync = () => { wco = html.dataset.wco === '1'; };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(html, { attributes: true, attributeFilter: ['data-wco'] });
    const offLaunch = wireLaunch(rootEl);
    return () => {
      offLaunch();
      mo.disconnect();
      closeCodexDock();
    };
  });

  // 状态栏 / 窗框跟页面底色走（暗 #0e0e0e、亮 #f1f1f1 = 官方窗框色的网页近似）
  $effect(() => {
    if (!isActive) return;
    const dark = theme === 'dark';
    untrack(() => { ui.pageChrome = { dark, bg: dark ? '#0e0e0e' : '#f1f1f1' }; });
    return () => { ui.pageChrome = null; };
  });

  // 工作区作用域 = 正在看的线程的项目（新线程 = 首页选中的项目）
  $effect(() => {
    const pid = thread.projectId || codex.projectId;
    const path = projectOf(pid)?.path || '';
    setCodexDockWs(path);
    setCodexDockSession(codex.sessionId || '');
  });

  // 工作区协同：agent 读的「工作台」状态在这一页时报这一页的
  const dockOf = (d) => ({ open: !!d.open, view: d.open ? (Array.isArray(d.views) && d.views.length ? d.views.join('+') : (d.view || '')) : '' });
  $effect(() => {
    if (!isActive) return;
    reportUi({ dock: dockOf(codexDock) });
    return () => { if (ui.screen !== 'chatgpt') reportUi({ dock: dockOf(claudeDock) }); };
  });

  // 从设置回来（那边可能切了号、恢复了归档、改了默认档）：重拉
  let settingsWasOpen = false;
  $effect(() => {
    const open = ui.settingsOpen;
    if (settingsWasOpen && !open) untrack(() => refreshAll());
    settingsWasOpen = open;
  });

  // 回到这一页 / 切回前台：额度刷新一次；每分钟一次（只在前台、在这一页时）
  $effect(() => {
    if (!isActive) return;
    untrack(() => loadUsage());
    const tid = setInterval(() => { if (!document.hidden && ui.screen === 'chatgpt') loadUsage(); }, 60_000);
    return () => clearInterval(tid);
  });

  // 侧列让位（与 Claude / Antigravity 同一套）：medium 档（折叠屏展开 / 竖屏平板）只塞得下一根侧列——
  // 工作区一开，线程列表自己收起并记账，工作区一关它自己回来；工作区开着时用户亲手点开列表 = 要列表，工作区让开。
  const yielder = makeSideYield(() => codex.sideOpen, (v) => { codex.sideOpen = v; });
  $effect(() => { const open = codexDock.open; void layout.medium; untrack(() => yielder.apply(open)); });   // 窗口缩进平板档（转屏 / 折叠屏展开）时也让一次
  let sideWas = untrack(() => codex.sideOpen);
  $effect(() => {
    const on = codex.sideOpen;
    untrack(() => {
      if (on && !sideWas && layout.medium && codexDock.open) { yielder.forget(); closeCodexDock(); }
      sideWas = on;
    });
  });
  // 线程列表和工作区同在一行（.cx-sheet）：开着时报给外壳，它给对话留宽、判两列都要扣掉这一截
  const dockAside = $derived(codex.sideOpen ? 272 : 0);

  // 返回键 / Esc 先收抽屉、再收工作区
  $effect(() => registerCloser('codexLayer', () => {
    if (codex.drawer) { codex.drawer = false; return true; }
    if (codexDock.open) { closeCodexDock(); return true; }
    return false;
  }));

  function onKey(e) {
    if (!isActive || ui.settingsOpen) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); closePop(); newThread(); }
    else if (mod && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      if (wide) codex.sideOpen = !codex.sideOpen; else codex.drawer = !codex.drawer;
    }
  }

  async function addProject() {
    closePop();
    if (hasNativePickDirectory()) {
      const dir = await nativePickDirectory(codexDock.ws || '');
      if (dir) await createProjectAt(dir).catch(() => {});
    } else {
      pickOpen = true;
    }
  }

  function scrim() {
    if (codex.drawer) codex.drawer = false;
    else if (codexDock.open && !wide) closeCodexDock();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="cx-host" class:light={theme === 'light'} class:dnd-on={drag.overKey === 'chat:codex'}
  use:dropZone={codexDrop} ondragover={onWsDragOver} ondrop={onWsDrop}>
  <div class="cx" bind:this={rootEl}
    data-theme={theme}
    data-layout={wco ? 'wco' : 'desktop'}
    data-side={codex.sideOpen ? 'open' : 'closed'}
    data-dock={codexDock.open && wide ? 'open' : 'closed'}
    data-pet={codexPrefs.pet ? 'on' : 'off'}
    data-view={codex.view}
    data-home={home ? '1' : '0'}
    data-drawer={codex.drawer ? 'open' : 'closed'}
    data-attn={attn ? '1' : '0'}
    data-admin={me.kind === 'admin' ? '1' : '0'}>
    <TitleBar />
    <Rail />
    <div class="cx-sheet">
      <Sidebar onAddProject={addProject} />
      <main class="cx-main">
        <TopBar />
        <div class="cx-body">
          <div class="cx-scroll">
            {#if home}
              <Home onAddProject={addProject} />
            {:else}
              <Thread />
            {/if}
          </div>
          <Composer onAddProject={addProject} />
        </div>
        {#if codex.view !== 'threads'}
          <div class="pg">
            {#if codex.view === 'tasks'}<TasksPage />
            {:else if codex.view === 'plugins'}<PluginsPage />
            {:else if codex.view === 'library'}<LibraryPage />{/if}
          </div>
        {/if}
      </main>
      {#if wide}
        <aside class="cx-work" class:on={codexDock.open}>
          <CodexWorkspace wide={true} aside={dockAside} />
        </aside>
      {/if}
    </div>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="cx-scrim" onclick={scrim}></div>

    <ModelPicker />
    <UsageCard />
    <PermMenu />
    <ProjectMenu onAdd={addProject} />
    <AccountMenu />
  </div>
  {#if !wide}
    <CodexWorkspace wide={false} />
  {/if}
  {#if pickOpen}
    <ProjectPicker preferPath={codexDock.ws || ''} onPick={async (dir) => { pickOpen = false; await createProjectAt(dir).catch(() => {}); }} onClose={() => (pickOpen = false)} />
  {/if}
</div>

<style>
  /* 拎着工作空间的文件悬在 Codex 上：整页亮一圈，松手 = 挂进输入栏 */
  .cx-host.dnd-on::after { content: ''; position: absolute; inset: 6px; border-radius: 16px; pointer-events: none; z-index: 80;
    box-shadow: inset 0 0 0 2px var(--fg, #0d0d0d); background: rgb(127 127 127 / .06); }
  .cx-work:not(.on) { display: none; }
  /* 窄格（容器 ≤640）里工作区是底部抽屉、竖排的唯一一块：撑满高度。桌面上 .cx-work 无盒，工作台按自己的宽度坐进这一行 */
  @container cx (max-width: 640px) { .cx-work > :global(.wb) { flex: 1; min-height: 0; } }
</style>
