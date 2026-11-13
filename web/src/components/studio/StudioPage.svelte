<script>
  // Media Studio 外壳（v3「纸墨工作台」，方案 §9.2）：dimensio 三栏 + 44px 栏头带——
  //   左 作品栏（深半档的纸，272 可拖可收；栏头 ‹ · 错拍标 + 宋体字标 · 收起）｜
  //   中 画布（栏头带：四个创作页的分段（spring-snap 滑块）、任务钮、参数坞开关、设置）｜
  //   右 参数坞（宽屏才有、可开关；各创作页把自己的参数面板挂进来，见 CreateFrame 的 toDock）。
  // 手机：作品栏是左缘抽屉，栏头一行 + 分段贴顶一行。
  //
  // 行为照旧（§5 / P3 验过的）：作品栏只挂在外壳上，切创作页不重挂；四个创作页 keep-alive；左缘右滑在手机归抽屉、
  // 平板 / 桌面是预测式返回；系统返回逐层关（浮层 → 抽屉 → 回主页）；studioInbox；任务完成作品飞进作品栏。
  import { untrack } from 'svelte';
  import { ui, prefs, studioInbox } from '../../lib/state.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { closePage, backPeek } from '../../lib/pageMorph.js';
  import { swipeDismiss, reduced } from '../../lib/motion.js';
  import { registerCloser } from '../../lib/nav.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';
  import { drag, dropZone } from '../../lib/dragdrop.svelte.js';
  import { t } from '../../lib/i18n.js';
  import { studio, startStudio, onJobDone, isActive, saveSide, mediaSrc, takeInbox } from '../../modules/studio/media.svelte.js';
  import { usingFixture } from '../../modules/studio/api.js';
  import { PAGES, visual, pageOf } from '../../modules/studio/kinds.js';
  import { closeTopLayer, layerCount } from '../../modules/studio/layers.js';
  import { icon, MARK } from '../../modules/studio/icons.js';
  import { motionStyle, springEasing, SPRING } from '../../modules/studio/motion.js';
  import { ovUrl } from '../../lib/overlay.svelte.js';
  // 浮起来的层（菜单 / 浮层 / 手机 Sheet / 弹窗）用 bridge 的苹果材质（ios27 Liquid Glass 烘焙切图，与设置页、文件面板的菜单同一张）——
  // 维护者 11-06：「菜单之类的可以用苹果材质，没必要改扁平材质」。底下的纸（作品栏、画布、参数坞、输入框）仍是纸墨。
  import { slotDropFor } from '../../modules/studio/drag.js';
  import StudioSidebar from './StudioSidebar.svelte';
  import TaskTray from './TaskTray.svelte';
  import Segmented from './ui/Segmented.svelte';
  import ImagePage from './pages/ImagePage.svelte';
  import VideoPage from './pages/VideoPage.svelte';
  import VoicePage from './pages/VoicePage.svelte';
  import MusicPage from './pages/MusicPage.svelte';
  import './studio.css';
  import './create.css';

  startStudio();

  const LABEL = { image: t('图像'), video: t('视频'), voice: t('配音'), music: t('音乐') };
  const PAGE_COMP = { image: ImagePage, video: VideoPage, voice: VoicePage, music: MusicPage };
  const MOTION = motionStyle();

  const dark = $derived(ui.theme === 'dark');
  const glassVars = $derived(`;--sd-glass-pop:url("${dark ? ovUrl('ios27/alert-dark.png') : ovUrl('ios27/alert-light.png')}");`
    + `--sd-glass-sheet:url("${dark ? ovUrl('ios27/sheet-dark.png') : ovUrl('ios27/sheet-light.png')}");`);
  const compact = $derived(layout.compact);
  const expanded = $derived(layout.expanded);
  // 作品栏此刻是不是一根侧列（占宽度）：桌面常驻开着 / 平板推入了；手机是抽屉
  const railCol = $derived(!compact && (expanded ? studio.side.pinned : studio.drawer));
  const railVisible = $derived(railCol || (compact && studio.drawer));
  const activeJobs = $derived(studio.jobs.filter(isActive));
  const activeBy = $derived(Object.fromEntries(PAGES.map((p) => [p, activeJobs.some((j) => pageOf(j.kind) === p)])));
  const tabs = $derived(PAGES.map((p) => ({ value: p, label: LABEL[p], dot: activeBy[p] ? 'live' : '' })));

  // 参数坞：中栏 + 坞的总宽够 980 才有（作品栏开着时窗口再宽也可能不够），用户可以关
  let workW = $state(typeof innerWidth === 'number' ? innerWidth : 390);
  const dockAvail = $derived(!compact && workW >= 980);
  const dockOn = $derived(dockAvail && studio.side.dock);
  function toggleDock() { studio.side.dock = !studio.side.dock; saveSide(); }

  // —— 创作页 keep-alive：首次进入才挂载，之后休眠保留（草稿、滚动、播放器都在）——
  let mounted = $state({ [studio.page]: true });
  let leaving = $state('');
  let entering = $state('');
  let dir = $state(1);
  let prevPage = untrack(() => studio.page);
  let leaveT = 0, enterT = 0;
  $effect(() => {
    const p = studio.page;
    untrack(() => {
      mounted[p] = true;
      if (p === prevPage) return;
      dir = PAGES.indexOf(p) >= PAGES.indexOf(prevPage) ? 1 : -1;
      const anim = !prefs.noEnterAnim && !reduced();
      leaving = anim ? prevPage : '';
      prevPage = p;
      entering = '';
      clearTimeout(leaveT); clearTimeout(enterT);
      if (!anim) return;
      // 先摘掉再挂上：keep-alive 页的入场动画靠重新挂类重播（同一帧摘挂浏览器不会重启动画）
      requestAnimationFrame(() => { entering = p; });
      leaveT = setTimeout(() => { leaving = ''; }, 130);
      enterT = setTimeout(() => { if (entering === p) entering = ''; }, 460);
    });
  });
  function go(p) { if (p !== studio.page) studio.page = p; }

  function tabKey(e) {
    const i = PAGES.indexOf(studio.page);
    const n = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? 3 : 0;
    if (!n) return;
    e.preventDefault();
    const p = PAGES[(i + n) % 4];
    go(p);
    requestAnimationFrame(() => document.querySelector(`.studio-root .sd-cbar [data-v="${p}"], .studio-root .sd-tabs-row [data-v="${p}"]`)?.focus());
  }
  // 桌面 Ctrl/⌘ + 1…4 切页；Esc 关最上面那层浮层（焦点不在浮层里时也认）
  function onKey(e) {
    if (ui.screen !== 'studio') return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); go(PAGES[Number(e.key) - 1]); }
    else if (e.key === 'Escape' && layerCount() && !e.defaultPrevented) { e.preventDefault(); closeTopLayer(); }
  }
  // 分段的每一项也是落点：拖着素材悬停 600ms 切到那一页（spring folder 同款），直接松在上面＝切页并按默认角色挂上
  function tabDrop(node, p) {
    const opts = (pp) => ({
      key: 'studio-seg:' + pp, effect: 'send',
      label: () => t('切到{page}', { page: LABEL[pp] }),
      accept: (pl) => !!slotDropFor(pp, pl, null),
      spring: () => go(pp),
      drop: (pl) => { go(pp); return slotDropFor(pp, pl, null)?.(); },
    });
    const z = dropZone(node, opts(p));
    return { update: (n) => z.update(opts(n)), destroy: z.destroy };
  }

  // —— 作品栏：桌面常驻 / 平板推入 / 手机抽屉 ——
  function toggleRail() {
    if (expanded) { studio.side.pinned = !studio.side.pinned; saveSide(); }
    else studio.drawer = !studio.drawer;
  }
  $effect(() => { if (expanded) untrack(() => { studio.drawer = false; }); });
  // 拖右缘调宽（240–400），键盘 ←/→ 也能调；双击复位 272
  let resizing = $state(false);
  function resizeDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = true;
    const x0 = e.clientX, w0 = studio.side.width;
    const mv = (ev) => { studio.side.width = Math.min(400, Math.max(240, Math.round(w0 + ev.clientX - x0))); };
    const up = () => { resizing = false; saveSide(); removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  }
  function resizeKey(e) {
    const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (!d) return;
    e.preventDefault();
    studio.side.width = Math.min(400, Math.max(240, studio.side.width + d));
    saveSide();
  }

  // 手机：左缘右滑跟手拉出抽屉；抽屉上左滑收起
  let drawerX = $state(0);
  let drawerDragging = $state(false);
  const drawerW = () => Math.min(innerWidth * 0.86, 340);
  const edgeOpen = (node) => swipeDismiss(node, {
    axis: 'x', dir: 1, edge: 24, threshold: 0.35, size: drawerW,
    guard: () => compact && !studio.drawer && !ui.morphing && !drag.on,
    onStart: () => { drawerDragging = true; },
    onMove: (x) => { drawerX = x; },
    onSettle: (goOpen) => { drawerDragging = false; drawerX = 0; if (goOpen) studio.drawer = true; },
  });
  const drawerClose = (node) => swipeDismiss(node, {
    axis: 'x', dir: -1, threshold: 0.3, size: drawerW,
    guard: () => compact && studio.drawer && !drag.on,
    onStart: () => { drawerDragging = true; },
    onMove: (x) => { drawerX = -x; },
    onSettle: (goClose) => { drawerDragging = false; drawerX = 0; if (goClose) studio.drawer = false; },
  });
  // 拎着东西真的挪动了，手机抽屉才让开（东西是从抽屉里拎出来要放进创作页的）；原地按住松手是要菜单，抽屉留着
  $effect(() => { if (drag.on && drag.moved && compact && studio.drawer) untrack(() => { studio.drawer = false; }); });

  // —— 平板 / 桌面：左缘右滑＝预测式返回（同 Claude 页）——
  let peekX = $state(0), peeking = $state(false);
  let slideEl = $state();
  const peek = $derived(backPeek(peekX));
  function resetSlide() { peekX = 0; peeking = false; ui.studioSliding = false; }
  const edgeBack = (node) => swipeDismiss(node, {
    axis: 'x', dir: 1, edge: 40, threshold: 0.32,
    guard: () => !compact && !ui.morphing && !drag.on,
    base: () => peekX, cur: () => peekX,
    onStart: () => { peeking = true; ui.studioSliding = true; },
    onMove: (x) => { peekX = x; },
    onSettle: (g) => { if (!g) { peeking = false; ui.studioSliding = false; } },
    onCommit: () => {
      const rect = () => { const r = slideEl?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };
      closePage('studio', { fromRect: rect, fromRadius: peek.r, onSwitch: resetSlide });
    },
  });
  function back() { if (ui.screen === 'studio') closePage('studio', { onSwitch: resetSlide }); }

  // —— 任务托盘 ——
  let trayOpen = $state(false);
  let capsuleEl = $state();
  function toggleTray() { trayOpen = !trayOpen; if (trayOpen) studio.unseen = 0; }

  // 系统返回：浮层（含托盘、菜单）→ 抽屉 → 回主页
  $effect(() => registerCloser('studio', () => {
    if (closeTopLayer()) return;
    if (studio.drawer && !expanded) { studio.drawer = false; return; }
    back();
  }));

  // —— 核心入口发来的素材（工作空间「发到 Media Studio」、agent 的 ui.cmd）——
  $effect(() => { if (studioInbox.items.length) untrack(() => takeInbox(studioInbox)); });

  // —— 任务完成：作品从画布飞进作品栏（作品栏没开就让栏钮冒一粒墨点）——
  let pip = $state(0);
  $effect(() => onJobDone((job) => {
    const a = job.result?.[0];
    if (!a) return;
    requestAnimationFrame(() => requestAnimationFrame(() => flyIn(a)));
  }));
  function flyIn(a) {
    const target = railVisible && studio.side.tab === 'works' ? document.querySelector(`.studio-root [data-work="${CSS.escape(a.id)}"] .wr-thumb`) : null;
    studio.flash = a.id;
    setTimeout(() => { if (studio.flash === a.id) studio.flash = ''; }, 1200);
    if (!target) { pip++; return; }
    const src = document.querySelector(`.studio-root .sd-page.on [data-asset="${CSS.escape(a.id)}"]`);
    if (!src || prefs.noEnterAnim || reduced() || !visual(a.kind)) return;
    const r0 = src.getBoundingClientRect(), r1 = target.getBoundingClientRect();
    if (!r0.width || !r1.width) return;
    const ghost = document.createElement('img');
    ghost.src = mediaSrc(a, 'thumb');
    ghost.className = 'sd-fly';
    Object.assign(ghost.style, { left: r1.left + 'px', top: r1.top + 'px', width: r1.width + 'px', height: r1.height + 'px' });
    document.body.appendChild(ghost);
    const sx = r0.width / r1.width, sy = r0.height / r1.height;
    const anim = ghost.animate([
      { transform: `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px) scale(${sx}, ${sy})`, opacity: 0.92, borderRadius: '12px' },
      { transform: 'none', opacity: 1, borderRadius: '8px' },
    ], { duration: SPRING.ms + 80, easing: springEasing(SPRING), fill: 'forwards' });
    anim.onfinish = anim.oncancel = () => ghost.remove();
  }

  const fixture = $derived(import.meta.env.DEV && usingFixture() && !!studio.catalog);
</script>

<svelte:window onkeydown={onKey} />

{#snippet brand()}
  <span class="sd-brand"><span class="sd-mark" aria-hidden="true">{@html MARK}</span><span class="sd-word">Media Studio</span>
    {#if fixture}<span class="sd-fx" title={t('后端还没有 Media Studio 接口，正在用本地样例数据')}>{t('样例数据')}</span>{/if}</span>
{/snippet}

<div class="studio-slide" class:peeking bind:this={slideEl} style:transform={peek.transform} style:clip-path={peek.clip} use:edgeBack>
<div class="studio-root" class:dark class:compact class:medium={layout.medium} class:expanded class:rail-col={railCol} class:dock-on={dockOn} class:sd-noanim={prefs.noEnterAnim}
  class:resizing style="--sd-rail-w:{studio.side.width}px;--sd-dir:{dir};{MOTION}{glassVars}" use:edgeOpen>

  <div class="sd-body">
    <!-- 作品栏：同一棵子树在三档之间只换外形（侧列 / 抽屉），从不随创作页重挂 -->
    {#if compact}
      <button class="sd-scrim" class:open={studio.drawer || drawerDragging} aria-label={t('关闭')} tabindex="-1"
        style:opacity={drawerDragging ? (studio.drawer ? 1 + drawerX / drawerW() : drawerX / drawerW()) : null}
        onclick={() => (studio.drawer = false)}></button>
    {/if}
    <aside class="sd-rail" class:open={railVisible} class:dragging={drawerDragging} use:drawerClose
      style:transform={compact && drawerDragging ? `translateX(${(studio.drawer ? 0 : -drawerW()) + drawerX}px)` : null}
      aria-hidden={!railVisible} inert={!railVisible} aria-label={t('作品')}>
      <div class="sd-rail-in">
        <header class="sd-band sd-rail-hd">
          {#if !compact}<button class="sd-ib" aria-label={t('返回')} onclick={back}>{@html icon('back')}</button>{/if}
          {@render brand()}
          <button class="sd-ib" aria-label={compact ? t('关闭') : t('收起作品栏')} onclick={toggleRail}>{@html icon(compact ? 'close' : 'side')}</button>
        </header>
        <StudioSidebar visible={railVisible} />
      </div>
      {#if expanded}
        <div class="sd-resize" role="separator" aria-orientation="vertical" aria-label={t('调整作品栏宽度')} aria-valuenow={studio.side.width}
          aria-valuemin="240" aria-valuemax="400" tabindex="0" onpointerdown={resizeDown} onkeydown={resizeKey}
          ondblclick={() => { studio.side.width = 272; saveSide(); }}></div>
      {/if}
    </aside>

    <div class="sd-work" bind:clientWidth={workW}>
      <section class="sd-center">
        <header class="sd-band sd-cbar">
          <div class="sd-cbar-l">
            {#if !railVisible || compact}
              <button class="sd-ib" aria-label={t('返回')} onclick={back}>{@html icon('back')}</button>
              <button class="sd-ib sd-rail-btn" aria-label={t('打开作品栏')} aria-expanded={railVisible} onclick={toggleRail}>
                {@html icon(compact ? 'menu' : 'side')}
                {#key pip}{#if pip && !railVisible}<span class="sd-dot" style="background:var(--sd-accent)"></span>{/if}{/key}
              </button>
            {/if}
            {#if compact}{@render brand()}{/if}
          </div>
          {#if !compact}
            <div class="sd-tabs">
              <Segmented options={tabs} value={studio.page} onchange={go} label={t('创作页')} item={tabDrop}
                overKey={drag.on ? drag.overKey : ''} keyOf={(p) => 'studio-seg:' + p} onkeydown={tabKey} />
            </div>
          {/if}
          <div class="sd-cbar-r">
            <button class="sd-ib sd-cap" class:live={activeJobs.length > 0} class:seen={!activeJobs.length && studio.unseen > 0} bind:this={capsuleEl}
              aria-label={activeJobs.length ? t('{n} 个任务进行中', { n: activeJobs.length }) : t('任务')} aria-expanded={trayOpen} onclick={toggleTray}>
              <!-- 在跑的朱已经在分段（哪一页）和作品栏（哪一件）上，任务钮只写个数（同一件任务三处红，复核 11-06 第二轮） -->
              {@html icon('tray')}{#if activeJobs.length}<b>{activeJobs.length}</b>{/if}
            </button>
            {#if dockAvail}
              <button class="sd-ib" class:on={dockOn} aria-label={dockOn ? t('收起参数') : t('展开参数')} aria-pressed={dockOn} onclick={toggleDock}>{@html icon('sliders')}</button>
            {/if}
            <button class="sd-ib" aria-label={t('Media Studio 设置')} onclick={() => openSettings('studio')}>{@html icon('gear')}</button>
          </div>
        </header>
        {#if compact}
          <div class="sd-segrow sd-tabs-row">
            <Segmented options={tabs} value={studio.page} onchange={go} full label={t('创作页')} item={tabDrop}
              overKey={drag.on ? drag.overKey : ''} keyOf={(p) => 'studio-seg:' + p} onkeydown={tabKey} />
          </div>
        {/if}

        <main class="sd-stage">
          {#each PAGES as p (p)}
            {#if mounted[p]}
              {@const Comp = PAGE_COMP[p]}
              <section class="sd-page" class:on={studio.page === p} class:leaving={leaving === p} class:st-in={entering === p}
                class:dormant={studio.page !== p && leaving !== p} inert={studio.page !== p} aria-label={LABEL[p]}>
                <Comp active={studio.page === p && ui.screen === 'studio'} sideOpen={railVisible} wide={dockOn} />
              </section>
            {/if}
          {/each}
          {#if !studio.catalog && studio.catalogErr}
            <div class="sd-cat-err"><span class="ic">{@html icon('warn')}</span><p>{studio.catalogErr}</p></div>
          {/if}
        </main>
      </section>

      <!-- 参数坞：常驻节点（各创作页把自己的参数面板挂进 .sd-dock-body，只显示当前页那一份），宽屏且开着才显示 -->
      <aside class="sd-dock" class:on={dockOn} aria-label={t('参数')} aria-hidden={!dockOn} inert={!dockOn}>
        <header class="sd-band sd-dock-hd">
          <span class="sd-dock-t">{t('参数')}</span>
          <button class="sd-ib" aria-label={t('收起参数')} onclick={toggleDock}>{@html icon('close')}</button>
        </header>
        <div class="sd-dock-body"></div>
      </aside>
    </div>
  </div>

  {#if trayOpen}
    <TaskTray anchor={capsuleEl} onclose={() => (trayOpen = false)} />
  {/if}
</div>
</div>
