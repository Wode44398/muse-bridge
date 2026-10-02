<script>
  // 「单开一个对话」页（?solo=<会话 id>，见 lib/solo.js）——两种身份：
  //   · 分屏的另一格（&pane=1）：Claude 分页把侧栏里的会话拖到正文区左/右半边，旁边就挂一个
  //     本页的 iframe。聊天内核是模块单例（一页只看一个会话），同屏两个会话最稳的办法就是
  //     两份独立的页面实例：各自的内核、各自的直播、各自的工作台，谁也不碰谁。
  //   · 拖出的独立窗口：会话拖到 app 外面松手，新窗口里就是本页（像把浏览器标签页拖出去，
  //     只是侧栏那一条原地不动）。
  //
  // 与 SnapPage 同一套路：不复用 ClaudePage（那 1000 行大半是侧栏），对话本体
  // （Thread / Composer / 附件卡 / 问答卡 / 工作台）都是独立组件，直接拿来。
  // 分屏格和宿主页之间只走同源 postMessage（信封见 lib/solo.js）：点进这一格 → 告诉宿主「焦点在我」；
  // 换了会话 → 告诉宿主（侧栏据此高亮）；宿主侧栏点会话 / 拖进这一格 → 让这一格去开。
  import { onMount, untrack } from 'svelte';
  import TopBar from './TopBar.svelte';
  import Composer from './Composer.svelte';
  import Thread from './Thread.svelte';
  import ClaudeLogo from './ClaudeLogo.svelte';
  import WorkspaceChips from './WorkspaceChips.svelte';
  import RefusalBand from './claude/RefusalBand.svelte';
  import ClaudeDock from './dock/ClaudeDock.svelte';
  import MediaViewer from './preview/MediaViewer.svelte';
  import DragLayer from './DragLayer.svelte';
  import { api } from '../lib/api.js';
  import { loadCaps } from '../lib/caps.js';
  import { caps, me, ui, session, applyMe, setTheme } from '../lib/state.svelte.js';
  import { chat, openSession, newConversation, requestSync, onBusEvent } from '../lib/chat.svelte.js';
  import { busStart, busStop, busOn, busConnected } from '../lib/bus.js';
  import { dock, openDock, closeDock, setDockWs } from '../lib/dock.svelte.js';
  import { layout, pointer } from '../lib/layout.svelte.js';
  import { onReachabilityChange, startReachabilityWatch } from '../lib/server.js';
  import { titleFor } from '../lib/library.svelte.js';
  import { dtHasWsFiles, wsDescriptorFrom, attachDescriptorToAgent } from '../lib/fileDrag.js';
  import { IS_PANE, SOLO_ID, PANE_MSG, isPaneMsg } from '../lib/solo.js';
  import { quoteSession } from '../lib/chatQuote.js';
  import { dockOverlayFor } from '../lib/claudeSplit.js';
  import { t, tc } from '../lib/i18n.js';

  // 'boot' 加载中 | 'login' 没登录（本页不带登录卡：主窗口登录后再拖一次即可）| 'ready'
  let state = $state('boot');
  let projects = $state([]);
  let rootW = $state(0);

  // 共享控制器（chat 内核的直播挂载、工作台快捷键）都按 ui.screen 判活——本页恒等于 claude 分页。
  ui.screen = 'claude';
  ui.booted = true;

  // —— 工作台：作用域 = 本会话的工作空间目录（同 ClaudePage 的 dockProject 推导）——
  // 分屏格 / 独立窗口都是电脑上的形态：一律侧列；这一格不够宽就盖在正文上（不挤），够宽照旧挤开。
  const sideDock = $derived(IS_PANE || layout.side || pointer.fine);
  const overlay = $derived(sideDock && rootW > 0 && dockOverlayFor(rootW));
  const proj = $derived(projects.find((p) => p.id === session.projectId) || null);
  const dockWs = $derived(proj ? proj.path : '');
  $effect(() => setDockWs(dockWs));
  const showChips = $derived(!!proj && !proj.quick);
  // 分屏格默认收着工作台、agent 动了浏览器/终端也只亮点不自己拉开（两格都窄，自己弹出来会盖住正文）
  dock.noAuto = IS_PANE;
  function toggleDock() { if (dock.open) closeDock(); else openDock(dock.view === 'menu' ? 'menu' : dock.view); }

  // —— 窗口标题 = 对话标题（独立窗口在任务栏里认得出是哪一个）：自定义名优先，否则取首条提问 ——
  const firstAsk = $derived((chat.messages.find((m) => m.role === 'user')?.text || '').replace(/\s+/g, ' ').trim().slice(0, 60));
  const title = $derived(session.id ? (titleFor(session.id, firstAsk) || tc('claude', '对话')) : tc('claude', '新对话'));
  $effect(() => { document.title = title + ' · Claude'; });

  // 这一格的宽度（决定工作台盖着还是挤开）。同 ClaudePage：自己挂 ResizeObserver，不靠 bind:clientWidth。
  function measureW(node) {
    const ro = new ResizeObserver(() => { rootW = node.clientWidth; });
    ro.observe(node);
    rootW = node.clientWidth;
    return { destroy() { ro.disconnect(); } };
  }

  // —— 分屏格 ⇄ 宿主 ——
  const toHost = (msg) => { if (!IS_PANE) return; try { window.parent.postMessage({ [PANE_MSG]: 1, ...msg }, location.origin); } catch {} };
  const claimFocus = () => toHost({ t: 'focus' });
  $effect(() => { const id = session.id; untrack(() => toHost({ t: 'session', id: id || null, projectId: session.projectId || null })); });
  $effect(() => { const open = dock.open; untrack(() => toHost({ t: 'dock', open })); });
  function onHostMsg(e) {
    if (!IS_PANE || e.source !== window.parent || !isPaneMsg(e)) return;
    const d = e.data;
    if (d.t === 'open' && d.id) {
      if (d.id !== session.id) openSession(d.id).catch(() => {});
    } else if (d.t === 'quote' && d.id) {
      quoteSession({ id: d.id, title: d.title || '' });   // 宿主侧栏把一条会话拖到了这一格的输入栏上
    } else if (d.t === 'away') {
      window.dispatchEvent(new Event('bridge-pane-away'));   // 宿主那边被按下了：收起本格的弹层
    } else if (d.t === 'new') {
      newConversation(d.projectId || undefined);   // 分屏时焦点在这一格、侧栏点了项目行
    }
  }

  // 主题跟着宿主 / 其它窗口走：别处一切换，localStorage 的 storage 事件就到这儿
  function onStorage(e) {
    if (e.key === 'bridge-theme' && e.newValue && e.newValue !== ui.theme) setTheme(e.newValue);
  }

  // —— 从工作空间拖文件进这一格＝挂进这一格的输入栏（同 ClaudePage 的正文列落点）——
  let wsDragOver = $state(false);
  function onWsDragOver(e) { if (!dtHasWsFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch {} wsDragOver = true; }
  function onWsDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) wsDragOver = false; }
  function onWsDrop(e) {
    if (!dtHasWsFiles(e)) return;
    e.preventDefault(); wsDragOver = false;
    const desc = wsDescriptorFrom(e.dataTransfer);
    if (desc) attachDescriptorToAgent(desc, 'claude');
  }

  // —— 输入卡悬浮 + 贴底滚动（与 ClaudePage 同款）——
  let scrollEl = $state();
  let composerWrapEl = $state();
  let composerInnerEl = $state();
  $effect(() => {
    if (!composerWrapEl || !scrollEl) return;
    const measure = () => {
      const wrapH = composerWrapEl.offsetHeight;
      scrollEl?.style.setProperty('--composer-h', wrapH + 'px');
      const cardTop = composerInnerEl ? wrapH - composerInnerEl.offsetTop : wrapH;
      scrollEl?.style.setProperty('--composer-card-top', cardTop + 'px');
      // 滚动条那一列让出来：wrap 的遮罩（芯片上缘渐隐罩、卡片下方垫底色）若横跨整宽，
      // 滚到底时拇指下半截被盖住、只剩卡片旁边一截——看起来被渐变截成两半。
      composerWrapEl.style.setProperty('--sb-w', Math.max(0, scrollEl.offsetWidth - scrollEl.clientWidth) + 'px');
    };
    const ro = new ResizeObserver(measure);
    ro.observe(composerWrapEl, { box: 'border-box' });
    if (composerInnerEl) ro.observe(composerInnerEl, { box: 'border-box' });
    ro.observe(scrollEl);   // 滚动条出现/消失会改 content-box 宽度 → 重量 --sb-w
    measure();
    return () => ro.disconnect();
  });
  let atBottom = $state(true);
  let lastCount = 0;
  let lastArrRef = chat.messages;
  function toBottom() { if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight; }
  function onScroll() { if (scrollEl) atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 120; }
  $effect(() => {
    const arr = chat.messages;
    const n = arr.length;
    const m = arr[n - 1];
    let _ = 0;
    if (m && m.role === 'assistant') { _ = m.thinking.length + m.segments.length; const last = m.segments[m.segments.length - 1]; if (last && last.kind === 'text') _ = last.md.length; }
    const swapped = arr !== lastArrRef; lastArrRef = arr;
    if (swapped) atBottom = true;
    const newMsg = n > lastCount || swapped; lastCount = n;
    if (scrollEl && (newMsg || atBottom)) requestAnimationFrame(() => { toBottom(); if (newMsg) requestAnimationFrame(toBottom); });
  });

  // —— 多端同步：总线（同源实例共用一条连接，见 lib/bus.js）+ 断线时 4s 兜底对账 ——
  $effect(() => {
    if (state !== 'ready') return;
    busStart();
    const off = busOn(onBusEvent);
    const iv = setInterval(() => { if (!document.hidden && !busConnected()) requestSync('poll'); }, 4000);
    return () => { clearInterval(iv); off(); busStop(); };
  });

  onMount(() => {
    window.addEventListener('message', onHostMsg);
    window.addEventListener('storage', onStorage);
    toHost({ t: 'ready' });
    (async () => {
      onReachabilityChange((down) => { ui.offline = down; });
      startReachabilityWatch();
      try { caps.data = await loadCaps(); caps.loaded = true; } catch {}
      try { applyMe(await api.auth()); } catch { applyMe(null); }
      if (me.kind === 'none') { state = 'login'; return; }
      try { projects = (await api.claudeProjects())?.projects || []; } catch {}
      try { await openSession(SOLO_ID); } catch {}
      state = 'ready';
    })();
    return () => { window.removeEventListener('message', onHostMsg); window.removeEventListener('storage', onStorage); };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="solo-root" class:pane={IS_PANE} class:row={sideDock && dock.open && !overlay} use:measureW
  onpointerdowncapture={claimFocus} onfocusincapture={claimFocus}>
  {#if state === 'ready'}
    <!-- 顶栏挂在根上（这一格 / 这扇窗的右上角），同 ClaudePage：工作台展开时工具开关就在卡片上方那条带里 -->
    <TopBar hideMenu sat={!IS_PANE} tools={sideDock} split={IS_PANE} onDock={toggleDock}
      onClose={IS_PANE ? () => toHost({ t: 'close' }) : null} />
    <div class="main-col" class:dnd-on={wsDragOver} role="presentation"
      ondragover={onWsDragOver} ondragleave={onWsDragLeave} ondrop={onWsDrop}>
      <div class="stage">
        {#if ui.view === 'greeting'}
          <main class="hero">
            <div class="greeting">
              <span class="logo"><ClaudeLogo anim="static" size={30} interactive /></span>
              <h1>{me.user ? `Hey there, ${me.user}` : 'Hey there'}</h1>
            </div>
            {#if showChips}<div class="hero-chips"><WorkspaceChips name={proj.name} /></div>{/if}
            <div class="hero-composer"><Composer /></div>
          </main>
        {:else}
          <div class="scroll" bind:this={scrollEl} onscroll={onScroll}>
            <div class="scroll-fade-strip-top" aria-hidden="true"></div>
            <Thread />
            <div class="scroll-fade-strip-bottom" aria-hidden="true"></div>
          </div>
          <div class="composer-wrap" bind:this={composerWrapEl}>
            {#if showChips}<div class="chips-slot" class:foot={atBottom}><WorkspaceChips name={proj.name} /></div>{/if}
            <div class="band-slot"><RefusalBand sessionId={session.id} /></div>
            <div class="composer-inner" bind:this={composerInnerEl}><Composer placeholder={tc('claude', '发消息…')} /></div>
          </div>
        {/if}
      </div>
    </div>
    <ClaudeDock wide={sideDock} {overlay} toolsClose={IS_PANE ? () => toHost({ t: 'close' }) : null} />
  {:else if state === 'login'}
    <div class="mid"><p>{tc('claude', '先在主窗口登录 bridge，再把对话拖出来。')}</p></div>
  {:else}
    <div class="mid"><p>{t('加载中…')}</p></div>
  {/if}
</div>
<MediaViewer />
<DragLayer />

<style>
  .solo-root { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--text);
    padding-bottom: var(--kb, 0px); overflow: hidden; }
  .solo-root.row { flex-direction: row; }
  .main-col { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .main-col.dnd-on::after { content: ''; position: absolute; inset: 6px; border-radius: 16px; pointer-events: none;
    box-shadow: inset 0 0 0 2px var(--coral); background: color-mix(in srgb, var(--coral) 7%, transparent); z-index: 3; }
  .stage { flex: 1; position: relative; min-height: 0; display: flex; flex-direction: column; }
  .hero { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; padding: calc(13vh + var(--sat, 0px)) 16px 24px; }
  .greeting { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
  .logo { display: inline-flex; flex: none; }
  .greeting h1 { font-family: var(--serif-stack); font-weight: 290; font-size: 27px; line-height: 1.12; color: var(--serif); text-align: center; }
  .hero-composer, .hero-chips { width: 100%; max-width: 760px; }

  /* 滚动区 + 首尾渐隐带 + 悬浮输入卡：规格同 ClaudePage（注释见那边） */
  .scroll { flex: 1; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; padding-bottom: calc(var(--composer-h, 84px) + 8px);
    --sf-top: 52px; --sf-lead: 12px; --sf-bottom: 48px; --scroll-fade-color: var(--bg); }
  .scroll > .scroll-fade-strip-top { --scroll-fade-size: var(--sf-top);
    background: linear-gradient(to bottom,
      var(--scroll-fade-color) var(--sf-lead),
      color-mix(in srgb, var(--scroll-fade-color) 85%, transparent) calc(var(--sf-lead) + (100% - var(--sf-lead)) * .13),
      color-mix(in srgb, var(--scroll-fade-color) 50%, transparent) calc(var(--sf-lead) + (100% - var(--sf-lead)) * .40),
      color-mix(in srgb, var(--scroll-fade-color) 15%, transparent) calc(var(--sf-lead) + (100% - var(--sf-lead)) * .70),
      transparent); }
  .scroll > .scroll-fade-strip-bottom { --scroll-fade-size: var(--sf-bottom); bottom: calc(var(--composer-card-top, var(--composer-h, 84px)) - var(--composer-h, 84px) - 10px); }
  .scroll::-webkit-scrollbar { width: 6px; }
  .scroll::-webkit-scrollbar-track { background: transparent; }
  .scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 38%, transparent); border-radius: 999px; }
  @media (hover: hover) { .scroll::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--muted) 62%, transparent); } }
  .composer-wrap { position: absolute; left: 0; right: var(--sb-w, 0px); bottom: 0; z-index: 5;
    padding: 6px 8px max(10px, var(--sab, 0px)); background: transparent; pointer-events: none; }
  .composer-wrap::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0;
    height: calc(max(10px, var(--sab, 0px)) + 28px); background: var(--bg); pointer-events: none; z-index: -1; }
  .composer-inner { max-width: 760px; margin: 0 auto; pointer-events: auto; }
  .chips-slot { position: relative; max-width: 760px; margin: 0 auto; opacity: 0; transform: translateY(6px); pointer-events: none;
    transition: opacity var(--mo-quick) var(--ea-fade), transform var(--mo-quick) var(--ea-std); }
  .chips-slot.foot { opacity: 1; transform: translateY(0); pointer-events: auto; }
  .chips-slot::before { content: ''; position: absolute; left: -8px; right: -8px; top: -26px; bottom: -4px;
    background: linear-gradient(to bottom, transparent 0, var(--bg) 26px); pointer-events: none; z-index: -1; }
  .band-slot { position: relative; max-width: 760px; margin: 0 auto; pointer-events: auto; background: var(--bg); border-radius: 10px; }
  .band-slot:not(:has(:global(*))) { display: none; }
  .chips-slot + .band-slot { margin-top: 6px; }
  .mid { flex: 1; display: grid; place-items: center; padding: 24px; color: var(--muted); font-size: 14px; }
</style>
