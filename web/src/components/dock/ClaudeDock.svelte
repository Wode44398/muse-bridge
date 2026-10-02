<script>
  // Claude 分页右侧工作台：四件套——任务 / 审阅 / 终端 / 文件。
  // 宽屏（侧列形态）= Claude 桌面版同款【圆角卡片】：这一格右上角标题栏带里的工具开关（TopBar tools）
  //   一颗管一张卡，开几张摆几张（终端 / 审阅 / 任务叠在一列，文件另起一列；放不下两列就
  //   全叠一列）；卡片自带标题行（放大铺满 / 关闭）；工作台顶上留一条和工具组同高的带，左缘拖拽调宽。
  //   宿主不许多卡时（分屏格 / 独立窗口 / 折叠屏）一次只放一张，开关就是切换。
  // 窄屏 = 移动端专属方案（dimensio 手机端同款）：底部 sheet（把手下拉/scrim 点击可关）
  //        + 常驻工具切换条（chip 直切四件套）。
  import { ui } from '../../lib/state.svelte.js';
  import { dock, closeDock, closeDockView, toggleDockView, toggleDockMax, setDockMulti, openDock, ensureDockMeta, dockToolOk, dockSnapMode } from '../../lib/dock.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { dragSheet } from '../../lib/dockTouch.js';
  import ReviewPanel from './ReviewPanel.svelte';
  import TermPanel from './TermPanel.svelte';
  import WorkspaceEmbed from './WorkspaceEmbed.svelte';
  import TasksPanel from './TasksPanel.svelte';
  import DockToolBar from './DockToolBar.svelte';
  import { dockIcon } from '../../lib/dockIcons.js';
  import { bgHoldNow } from '../../lib/chat.svelte.js';
  import MediaViewer from '../preview/MediaViewer.svelte';
  import { preview, closePreview } from '../../lib/preview.svelte.js';
  import { reportUi } from '../../lib/uiReport.js';
  import { untrack } from 'svelte';
  import { t, tc } from '../../lib/i18n.js';

  // wide = 以【侧列】形态摆（宿主按 layout.side 传入：expanded 与 medium 都是侧列）；
  // false = 手机底部 sheet。medium 档另给一套更窄的宽度区间（见 .dock.wide.mid）。
  // overlay = 侧列【盖】在正文上而不是挤开它（分屏时每一格都窄，挤一下正文就只剩一条缝；
  // 宿主按这一格的宽度决定，够宽时仍是原来的挤开式）。宿主须是 position:relative 的容器。
  // multi = 允许几张卡同时开（宿主定：主窗口单格、够宽才给；理由见 dock.svelte.js 的 multi 注释）。
  // toolsClose = 分屏格的「关掉这一格」：工作台展开时工具开关组挂在本组件顶上的带里，✕ 跟着过来。
  let { wide = false, overlay = false, multi = false, toolsClose = null } = $props();
  const mid = $derived(layout.medium);
  $effect(() => { const on = wide && multi; untrack(() => setDockMulti(on)); });

  const TITLES = { tasks: tc('claude', '任务'), review: t('审阅'), term: t('终端'), files: tc('claude', '文件') };
  // 卡片标题行的 ✕：整句一键（英文 “Close terminal” 要小写名词，不能拿标题拼）
  const CLOSE_LABEL = { tasks: tc('claude', '关闭任务'), review: t('关闭审阅'), term: t('关闭终端'), files: tc('claude', '关闭文件') };
  const snapMode = $derived(dockSnapMode());

  // 手机 sheet 的 chip 条：四件套按这个顺序（门禁藏掉的不出）
  const MENU = $derived(['tasks', 'review', 'term', 'files'].filter(dockToolOk)
    .map((key) => ({ key, label: TITLES[key] })));
  // 窄屏没有卡片：dock.view 被门禁藏掉（无 shell 用户的终端）就回落审阅。
  const mView = $derived(MENU.some((m) => m.key === dock.view) ? dock.view : 'review');
  function pickTool(key) { openDock(key); }

  // 此刻真正摆出来的卡：宽屏 = 开着的全部（门禁过滤），窄屏 = chip 选中的那一张。
  const shown = $derived(!dock.open ? [] : wide ? dock.views.filter(dockToolOk) : [mView]);

  // —— 工作区协同：dock 状态上报（agent 的 workspace.view 知道工作台开没开、开着哪几张）；
  // 终端卡摆出来就摘掉 termLive 提示点。——
  $effect(() => { if (shown.includes('term')) dock.termLive = false; });
  $effect(() => { reportUi({ dock: { open: dock.open, view: dock.open ? shown.join('+') : '' } }); });

  // —— 卡片排布 ——
  // 左列：终端 / 审阅 / 任务（窄长、叠着看）；右列：文件（要宽）。两列都有卡且这一格够宽
  // 才分两列，否则全叠进一列。卡片用绝对定位按比例摆，而不是分两个 flex 列：列数变化时
  // （拉窗口、开关一张卡）卡片不换父节点、不重挂——终端的连接、滚回缓冲都留着。
  const COL_A = ['term', 'review', 'tasks'];
  const COL_B = ['files'];
  const TWO_COL_HOST = 1020;       // 这一格至少这么宽才摆两列（两列各 ≥300、对话还剩 ≥360）
  let hostW = $state(0);
  const colA = $derived(COL_A.filter((v) => shown.includes(v)));
  const colB = $derived(COL_B.filter((v) => shown.includes(v)));
  const two = $derived(wide && !!colA.length && !!colB.length && hostW >= TWO_COL_HOST && !overlay);
  const maxed = $derived(wide && dock.max && shown.includes(dock.max) ? dock.max : '');
  const G = 8;
  const span = (i, n) => `calc((100% - ${G * (n - 1)}px) * ${i / n} + ${G * i}px)`;
  const size = (n) => `calc((100% - ${G * (n - 1)}px) / ${n})`;
  const cards = $derived.by(() => {
    const cols = two ? [colA, colB] : [[...colA, ...colB]];
    const at = {};
    cols.forEach((col, ci) => col.forEach((v, ri) => {
      at[v] = `left:${span(ci, cols.length)};width:${size(cols.length)};top:${span(ri, col.length)};height:${size(col.length)}`;
    }));
    // 渲染顺序固定（keyed each 不因列数变化而重排出新节点）
    return [...COL_A, ...COL_B].filter((v) => at[v]).map((v) => ({ v, box: maxed ? (maxed === v ? 'left:0;top:0;width:100%;height:100%' : '') : at[v] }));
  });

  // —— 分栏拖拽：左缘把手调工作台宽度（px 持久化；CSS min/max 兜底钳制）——
  // 一列、两列各记各的：两列时默认更宽，拖出来的宽度也不该回灌给一列。
  const DOCKW_LS = 'bridge-claude-dock-w';
  const DOCKW2_LS = 'bridge-claude-dock-w2';
  const readW = (k, lo) => { try { const n = +localStorage.getItem(k); return n >= lo ? n : null; } catch { return null; } };
  let dockW = $state(readW(DOCKW_LS, 300));
  let dockW2 = $state(readW(DOCKW2_LS, 560));
  const curW = $derived(maxed ? null : (two ? dockW2 : dockW));
  let dockEl = $state();
  let gripping = $state(false);
  $effect(() => {
    const host = dockEl?.parentElement;
    if (!host) return;
    const read = () => { hostW = host.clientWidth; };
    const ro = new ResizeObserver(read);
    ro.observe(host);
    read();
    return () => ro.disconnect();
  });
  function gripDown(e) {
    if (!wide || !dockEl || maxed) return;
    e.preventDefault();
    const rightEdge = dockEl.getBoundingClientRect().right;
    const isTwo = two;
    // 指针捕获：拖进卡片里的 iframe（文件卡的 HTML 预览）时，pointermove / pointerup 会被那份文档吞掉，
    // 本页收不到松手，宽度就一直黏在指针上。捕获后事件恒发给把手；.gripping 期间 iframe 再关掉命中兜一层。
    const grip = e.currentTarget, pid = e.pointerId;
    try { grip.setPointerCapture(pid); } catch {}
    gripping = true;
    document.body.style.userSelect = 'none';
    const move = (ev) => {
      // medium（折叠屏展开）横向本就紧张：下限放到 300、上限留 300px 给正文，
      // 免得一拖就把对话挤成一条缝。
      // 上限按【宿主容器】宽度算：分屏时工作台只属于那一格，别拿整窗宽度去钳。
      const hW = dockEl.parentElement?.clientWidth || window.innerWidth;
      const lo = isTwo ? 560 : mid && !overlay ? 300 : 360;
      const hi = overlay ? Math.max(lo, hW - 48) : mid ? Math.max(lo, hW - 300) : isTwo ? Math.max(lo, hW - 360) : hW * 0.78;
      const w = Math.round(Math.min(Math.max(rightEdge - ev.clientX, lo), hi));
      if (isTwo) dockW2 = w; else dockW = w;
    };
    const up = () => {
      if (!gripping) return;
      gripping = false;
      document.body.style.userSelect = '';
      try { grip.releasePointerCapture(pid); } catch {}
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      grip.removeEventListener('lostpointercapture', up);
      try {
        if (isTwo && dockW2) localStorage.setItem(DOCKW2_LS, String(dockW2));
        if (!isTwo && dockW) localStorage.setItem(DOCKW_LS, String(dockW));
      } catch {}
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    grip.addEventListener('lostpointercapture', up);
  }
  // 双击把手 = 恢复默认宽度
  function gripReset() {
    if (two) { dockW2 = null; try { localStorage.removeItem(DOCKW2_LS); } catch {} }
    else { dockW = null; try { localStorage.removeItem(DOCKW_LS); } catch {} }
  }

  // meta 由 ensureDockMeta 统一拉（归属状态栏芯片 / 标题栏工具组在工作台没展开时就已经拉过，这里直接复用）
  $effect(() => { if (dock.open && dock.ws && !dock.meta) ensureDockMeta(); });

  // 系统返回：收起工作台（预览层在 nav.js 里优先级更高、先被收掉）。
  // 侧列形态也注册——折叠屏展开仍是手机、返回手势该先收工作台；只有 expanded（桌面浏览器/
  // 大平板，通常没有系统返回键）不占这一层。
  $effect(() => { if (dock.open && !layout.expanded) return pushBackLayer(closeDock); });

  // 桌面快捷键（浏览器可拦截的组合；Ctrl+T/W 这类浏览器保留键拦不了，不用）：开关对应那张卡。
  const KEYS = [
    { view: 'review', match: (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyG' },
    { view: 'term', match: (e) => e.ctrlKey && !e.shiftKey && e.code === 'Backquote' },
    { view: 'files', match: (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyE' },
  ];
  $effect(() => {
    if (ui.screen !== 'claude') return;
    const onKey = (e) => {
      for (const k of KEYS) {
        if (k.match(e)) {
          e.preventDefault();
          if (dockToolOk(k.view)) toggleDockView(k.view);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 本轮挂起等后台任务 → 「任务」chip 亮提示点（与 termLive 同一语言）
  const bgLive = $derived(!!bgHoldNow());

  // —— 文件卡：把真·工作空间页原封不动挂进来（电脑走 Explorer 级 FilesDesktop、
  // 手机走 iOS 风 FilesPanel，二选一收在 WorkspaceEmbed 里）——
  // 缺省：挂载前先把 ui.filesPath 预置成工作空间目录（FilesPanel onMount 一次性消费），
  // 用 filesMount 门控挂载时序：effect 里先备好路径、下一轮渲染才 mount，读到的必是它。
  // 有定位目标（点了产物文件夹卡）：把 rel/ws 直接当 props 传下去，key 变化即重挂，
  // 同一次打开里连点不同文件夹也每次都落到对的目录。
  // .dk-embed 的 transform 让 FilesPanel 的 fixed 布局（根/浮层/菜单/弹层）全部圈进容器。
  let filesMount = $state(null);   // { key, ws, rel }（rel=null → 走 ui.filesPath 老路）
  const filesShown = $derived(shown.includes('files'));
  $effect(() => {
    if (!(filesShown && dock.meta)) { filesMount = null; return; }
    const ft = dock.filesTarget;
    if (ft) { filesMount = { key: 't' + ft.seq, ws: ft.ws || '', rel: ft.rel || '', open: ft.open || '' }; return; }
    // 工作空间在身份文件根之外（admin 常见：项目不在 vault 里）：以工作空间本身为根挂载，
    // 别再摆一句「打不开」——附件卡走的就是这条 ws 作用域，两边得一致。
    // 无 shell 的身份拿不到 ws 作用域（/api/files?ws= 一律 403），维持原来的说明文案。
    if (dock.meta.rel == null) {
      filesMount = dock.ws && !snapMode && dock.meta.shell !== false ? { key: 'wsroot', ws: dock.ws, rel: '' } : null;
      return;
    }
    ui.filesPath = dock.meta.rel;
    filesMount = { key: 'ws', ws: '', rel: null };
  });
  // ws 作用域下的根名（面包屑首段）：就用那个目录的名字。
  const filesRootName = $derived(filesMount?.ws ? (filesMount.ws.split(/[\\/]/).filter(Boolean).pop() || '') : '');
  // 内嵌区卸载（关卡片/切视图/切工作空间）时，若侧栏实例正开着预览，一并收掉——
  // 否则 preview.host='dock' 却没有实例在渲染，返回层还压着一层幽灵预览。
  $effect(() => {
    if (!filesMount) return;
    return () => { if (preview.open && preview.host === 'dock') closePreview(); };
  });
  // 文件卡的工作空间页【真的挂上了】——它自带工具栏（‹ 就是收起这张卡），卡片标题行让位，
  // 两条头叠在一起纯属重复。加载中 / 根外提示那两种占位态没有自己的头，仍要标题行兜住关闭。
  const filesFull = $derived(!!filesMount);
  const exitFiles = () => (wide ? closeDockView('files') : closeDock());

  let sheetHandle = $state();
  // 手机 sheet 里正开着文件预览：进「阅读形态」——sheet 升到顶（只让出状态栏）、chip 条收起、
  // 预览头收成 44px。这时要的是看文件，工具切换点返回退出预览就回来了。
  const sheetPv = $derived(!wide && preview.open && preview.host === 'dock');
</script>

{#snippet panelBody(view)}
  {#if view === 'tasks'}
    <!-- 任务视图读的是本会话的对话状态，不按工作空间作用域、也不用等 meta -->
    <TasksPanel {wide} />
  {:else if !dock.ws}
    <div class="dk-wait">{t('工作空间加载中…')}</div>
  {:else}
    {#key dock.ws}
      {#if view === 'review'}<ReviewPanel />
      {:else if view === 'term'}<TermPanel />
      {:else if view === 'files'}
        {#if filesMount}
          {#key filesMount.key}
            <div class="dk-embed">
              <WorkspaceEmbed {wide} guest={snapMode} ws={filesMount.ws} rootName={filesRootName} initialPath={filesMount.rel}
                initialOpen={filesMount.open || ''} onExit={exitFiles} />
              <MediaViewer host="dock" />
            </div>
          {/key}
        {:else if dock.meta && dock.meta.rel == null}
          <div class="dk-wait">{t('该工作空间在云端文件区之外，无法在侧栏打开工作空间页')}</div>
        {:else}
          <div class="dk-wait">{t('工作空间加载中…')}</div>
        {/if}
      {/if}
    {/key}
  {/if}
{/snippet}

{#if dock.open}
{#if wide}
<aside class="dock wide" class:mid class:overlay class:gripping class:two class:full={!!maxed} bind:this={dockEl}
  style={curW ? `width:${curW}px` : ''} aria-label={t('工作台')}>
  <!-- 工具开关组：工作台展开时就坐在卡片正上方这条带里（收起时由 TopBar 挂在这一格右上角） -->
  <DockToolBar docked onClose={toolsClose} />
  {#if !maxed}<div class="dk-grip" role="separator" aria-label={t('拖拽调整宽度')} onpointerdown={gripDown} ondblclick={gripReset}></div>{/if}
  <div class="dk-cards">
    {#each cards as c (c.v)}
      <section class="dk-card" class:hid={!c.box} style={c.box} aria-label={TITLES[c.v]}>
        {#if !(c.v === 'files' && filesFull)}
          <header class="dk-card-head">
            <span class="dk-card-t">{TITLES[c.v]}</span>
            <button class="dk-cbtn" aria-label={maxed === c.v ? t('还原') : t('放大')} title={maxed === c.v ? t('还原') : t('放大铺满')} onclick={() => toggleDockMax(c.v)}>{@html dockIcon(maxed === c.v ? 'shrink' : 'expand')}</button>
            <button class="dk-cbtn" aria-label={CLOSE_LABEL[c.v]} title={t('关闭')} onclick={() => closeDockView(c.v)}>{@html dockIcon('close')}</button>
          </header>
        {/if}
        {@render panelBody(c.v)}
      </section>
    {/each}
  </div>
</aside>
{:else}
<!-- 移动端：底部 sheet（dimensio 手机端同款交互）——scrim 点击关、把手下拉关、chip 直切工具 -->
<div class="sheetwrap">
  <button class="sheet-scrim" aria-label={t('关闭工作台')} onclick={closeDock}></button>
  <div class="dock sheet" class:pv={sheetPv} use:dragSheet={{ onClose: closeDock, handle: () => sheetHandle ?? null }}>
    <div class="grip-zone" bind:this={sheetHandle}>
      <span class="grip"></span>
      <div class="dk-chips">
        {#each MENU as m (m.key)}
          <button class="chip" class:on={mView === m.key} onclick={() => pickTool(m.key)}>
            <span class="chip-ic">{@html dockIcon(m.key)}</span>
            {m.label}
            {#if (m.key === 'term' && dock.termLive && mView !== 'term') || (m.key === 'tasks' && bgLive && mView !== 'tasks')}<span class="dk-live"></span>{/if}
          </button>
        {/each}
        <button class="chip-fold" aria-label={t('收起工作台')} onclick={closeDock}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10l6 6 6-6"/></svg>
        </button>
      </div>
    </div>
    {@render panelBody(mView)}
  </div>
</div>
{/if}
{/if}

<style>
  .dock { display: flex; flex-direction: column; background: var(--bg); }

  /* —— 宽屏：常驻右列，与对话分栏 ——
     顶上留一条带：这一格的工具开关组（TopBar tools，宿主挂在这一格右上角）就坐在里面，卡片从带下开始。
     带高 = 工具组（top 10 + 36）+ 8px 缝。
     子树里 --sat 归零：根部已经吃掉了顶部的安全区，里面的面板头、内嵌文件页、
     查看器头不必再各自避让（归零必须挂在子节点上——同一元素上引用自己刚声明的变量拿的是新值）。
     卡片色：比页面底略亮一档 + 一圈细线 + 12px 圆角 + 8px 缝（官方实测：底 #141414、卡 #191919）。 */
  .dock.wide {
    --dk-card: #262625; --dk-line: rgba(255, 255, 255, .085);
    position: relative; flex: none; width: clamp(400px, 44%, 760px); min-width: 360px; max-width: 78%;
    padding: calc(var(--sat) + 54px) 8px 8px 6px;
    /* 带里的工具开关组要读这一格的安全区，而子树里这个变量归零了——先在本元素上存一份
       （var 在声明处解析，子节点继承的是算好的值）。 */
    --dk-sat: var(--sat, 0px);
  }
  /* 入场动画只给卡片：工具开关组从这一格右上角交接到带里，位置不变，不该跟着滑一下 */
  .dock.wide > .dk-cards { animation: dockInW .22s ease; }
  @media (pointer: coarse) { .dock.wide { padding-top: calc(var(--sat) + 58px); } }
  :global(html[data-theme="light"]) .dock.wide { --dk-card: #ffffff; --dk-line: rgba(0, 0, 0, .09); }
  .dock.wide > * { --sat: 0px; }
  /* 两列：默认更宽（两列各自够用），给对话留 ≥360 */
  .dock.wide.two { width: clamp(640px, 62%, 1180px); min-width: 560px; max-width: calc(100% - 360px); }
  /* medium（折叠屏展开 ~750px / 竖屏平板）：默认占一半多一点，给正文留住 300px 下限。
     min-width 一并降到 300，否则 max-width 钳不动、面板会顶破视口。 */
  .dock.wide.mid { width: clamp(320px, 52%, 560px); min-width: 300px; max-width: calc(100% - 300px); }
  /* 盖在正文上（分屏的窄格）：贴这一格的右缘整高浮起，正文不让位；留 48px 给正文露个边，
     一眼看得出下面还是对话。宽度照旧吃拖拽持久值，钳到这一格之内。 */
  .dock.wide.overlay { position: absolute; top: 0; right: 0; bottom: 0; z-index: 32;
    width: clamp(360px, 62%, 640px); min-width: min(360px, calc(100% - 48px)); max-width: calc(100% - 48px);
    box-shadow: -14px 0 44px rgba(0, 0, 0, .28); animation: dockInOver .22s ease; }
  /* 放大：一张卡铺满这一格（对话暂时让出来），顶上的带和工具组照旧 */
  .dock.wide.full { position: absolute; inset: 0; z-index: 33; width: auto; min-width: 0; max-width: none; padding-left: 8px; box-shadow: none; animation: none; }
  @keyframes dockInOver { from { opacity: .4; transform: translateX(28px); } to { opacity: 1; transform: none; } }
  .dock.wide.gripping { animation: none; }
  .dock.gripping :global(iframe) { pointer-events: none; }
  @keyframes dockInW { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
  /* 左缘拖拽把手：8px 命中区，悬停/拖动时亮出 2px 指示线；双击复位默认宽 */
  .dk-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 9px; cursor: col-resize; z-index: 5; touch-action: none; }
  .dk-grip::after { content: ''; position: absolute; left: 3px; top: 0; bottom: 0; width: 2px; background: transparent; transition: background-color .15s ease; }
  @media (hover: hover) { .dk-grip:hover::after { background: color-mix(in srgb, var(--muted) 45%, transparent); } }
  .dock.gripping .dk-grip::after { background: var(--coral); }

  .dk-cards { position: relative; flex: 1; min-height: 0; }
  /* 卡片里 --bg 换成卡片色：终端（xterm 底色从所在元素现取）、面板里的吸顶条 / 渐隐带都画在卡片上 */
  .dk-card {
    position: absolute; display: flex; flex-direction: column; overflow: hidden;
    border-radius: 12px; border: 1px solid var(--dk-line); background: var(--dk-card); --bg: var(--dk-card);
    animation: dkCardIn .2s ease;
  }
  .dk-card.hid { display: none; }
  @keyframes dkCardIn { from { opacity: 0; transform: translateY(6px); } }
  .dk-card-head { flex: none; display: flex; align-items: center; gap: 2px; height: 38px; padding: 0 5px 0 13px; }
  .dk-card-t { font-size: 13.5px; color: var(--serif); white-space: nowrap; }
  .dk-cbtn { width: 28px; height: 28px; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none; }
  .dk-cbtn:first-of-type { margin-left: auto; }
  .dk-cbtn :global(svg) { width: 15px; height: 15px; }
  .dk-cbtn:active { background: var(--hover-strong); }
  @media (hover: hover) { .dk-cbtn:hover { background: var(--hover); color: var(--text); } }

  .dk-live { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: dkPulse 1.2s ease-in-out infinite; flex: none; }
  @keyframes dkPulse { 50% { opacity: .35; } }
  .dk-wait { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 14px; padding: 0 24px; text-align: center; line-height: 1.7; }
  /* 内嵌真·工作空间页：transform 造 containing block，FilesPanel 的 fixed 根/浮层全被圈进本容器 */
  .dk-embed { flex: 1; min-height: 0; position: relative; overflow: hidden; transform: translateZ(0); }

  /* —— 移动端底部 sheet（dimensio psheet 同款规格，Claude 皮）—— */
  .sheetwrap { position: fixed; inset: 0; z-index: 58; display: flex; align-items: flex-end; }
  .sheet-scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, .45); animation: scrimIn .24s ease; }
  @keyframes scrimIn { from { opacity: 0; } }
  .dock.sheet { position: relative; width: 100%; height: calc(100dvh - 52px - var(--sat)); border-radius: 20px 20px 0 0;
    padding-bottom: max(var(--sab), var(--kb, 0px));
    box-shadow: 0 -10px 44px rgba(0, 0, 0, .35); overflow: hidden;
    animation: sheetUp .36s cubic-bezier(.32, .9, .35, 1) both;
    transition: transform .3s cubic-bezier(.32, .9, .35, 1), height .3s cubic-bezier(.32, .9, .35, 1); }
  @keyframes sheetUp { from { transform: translateY(52%); opacity: .7; } }
  /* sheet 顶边本就在状态栏之下、底边已吃掉 sab/键盘：子树里安全区归零。否则内嵌工作空间页与
     预览头会在 sheet 里再让一遍状态栏，chip 条下凭空多出一条 ~40px 的空带。（同 .dock.wide > *） */
  .dock.sheet > * { --sat: 0px; --sab: 0px; }
  /* 阅读形态（sheet 内开着预览）：升到顶、chip 条收起、预览头压扁（变量由各查看器头读） */
  .dock.sheet.pv { height: calc(100dvh - var(--sat) - 6px); --pv-pad-y: 4px; --pv-bar-h: 44px; }
  .dock.sheet.pv .dk-chips { display: none; }
  .grip-zone { flex: none; touch-action: none; }
  .grip { display: block; width: 38px; height: 4.5px; border-radius: 3px; background: var(--divider); margin: 8px auto 2px; }
  .dock.sheet.pv .grip { margin: 6px auto 5px; }

  /* 工具切换条：chip 直切（移动端没有菜单层级） */
  .dk-chips { display: flex; align-items: center; gap: 5px; padding: 6px 10px 8px; overflow-x: auto; scrollbar-width: none; }
  .dk-chips::-webkit-scrollbar { display: none; }
  .chip { flex: none; display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 13px; border-radius: 11px;
    color: var(--muted); font-size: 13px; transition: background-color .14s ease, color .14s ease; }
  .chip:active { transform: scale(.97); }
  .chip.on { background: var(--card); color: var(--text); box-shadow: var(--card-shadow); }
  .chip-ic { width: 16px; height: 16px; display: flex; flex: none; }
  .chip-ic :global(svg) { width: 100%; height: 100%; }
  .chip-fold { margin-left: auto; width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none; }
  .chip-fold svg { width: 17px; height: 17px; }
  .chip-fold:active { background: var(--hover); }
</style>
