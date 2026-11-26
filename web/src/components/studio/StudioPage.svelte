<script>
  // Media Studio 外壳（v4「作品台」，方案 §12.1）：
  //   左 素材架（宽屏侧列：收 64 / 展开 300；手机是左缘抽屉，同一棵子树）｜
  //   中 顶栏一行（返回 · 宽屏时会动的「错拍」标 + 字标 · 四个种类 · 设置）+ 四个创作页（keep-alive）｜
  //   右 参数坞（宽屏且当前模型有参数才有；各创作页把参数面板挂进 .sd-dock-body，见 CreateFrame 的 toDock）。
  // 行为照旧：左缘右滑在手机归抽屉、平板 / 桌面是预测式返回；系统返回逐层关（浮层 → 焦点 → 挑选态 → 抽屉 → 回主页）；studioInbox。
  import { untrack } from 'svelte';
  import { ui, prefs, studioInbox } from '../../lib/state.svelte.js';
  import { isPageWindow } from '../../lib/windowPage.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { closePage, backPeek } from '../../lib/pageMorph.js';
  import { swipeDismiss, reduced } from '../../lib/motion.js';
  import { registerCloser } from '../../lib/nav.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';
  import { drag } from '../../lib/dragdrop.svelte.js';
  import { t } from '../../lib/i18n.js';
  import { studio, startStudio, onJobDone, isActive, saveSide, takeInbox, currentModel, closeFocus, endPick, ensureWall } from '../../modules/studio/media.svelte.js';
  import { usingFixture } from '../../modules/studio/api.js';
  import { PAGES, pageOf } from '../../modules/studio/kinds.js';
  import { closeTopLayer, layerCount } from '../../modules/studio/layers.js';
  import { icon } from '../../modules/studio/icons.js';
  import { motionStyle } from '../../modules/studio/motion.js';
  // 浮起来的层（菜单 / 浮层 / Sheet / 弹窗）用 bridge 的苹果材质（ios27 Liquid Glass 烘焙切图），见 studio.css「浮层」
  import alertLight from '../../visuals/ios27/alert-light.png';
  import alertDark from '../../visuals/ios27/alert-dark.png';
  import sheetLight from '../../visuals/ios27/sheet-light.png';
  import sheetDark from '../../visuals/ios27/sheet-dark.png';
  import Shelf from './Shelf.svelte';
  import StudioTabs from './StudioTabs.svelte';
  import Mark from './ui/Mark.svelte';
  import ImagePage from './pages/ImagePage.svelte';
  import VideoPage from './pages/VideoPage.svelte';
  import VoicePage from './pages/VoicePage.svelte';
  import MusicPage from './pages/MusicPage.svelte';
  import './studio.css';
  import './create.css';

  startStudio();

  const LABEL = { image: t('图像'), video: t('视频'), voice: t('配音'), music: t('音乐') };
  const PAGE_COMP = { image: ImagePage, video: VideoPage, voice: VoicePage, music: MusicPage };
  // motionStyle() 结尾不带分号：后面紧跟的变量会被吞（玻璃切图贴不上），这里补上
  const MOTION = motionStyle() + ';';

  const dark = $derived(ui.theme === 'dark');
  const glassVars = $derived(`--sd-glass-pop:url("${dark ? alertDark : alertLight}");`
    + `--sd-glass-sheet:url("${dark ? sheetDark : sheetLight}");`);
  const compact = $derived(layout.compact);
  const expanded = $derived(layout.expanded);
  const pageWin = isPageWindow();

  // —— 素材架：桌面展开记在本机（side.pinned）；平板 / 手机的开合是临时的（drawer，占返回层）；挑选态总是打开 ——
  const shelfOpen = $derived((expanded ? studio.side.pinned : studio.drawer) || !!studio.pick);
  function toggleShelf() {
    if (studio.pick) { endPick(); return; }
    if (expanded) { studio.side.pinned = !studio.side.pinned; saveSide(); }
    else studio.drawer = !studio.drawer;
  }
  function closeShelf() {
    studio.drawer = false;
    if (studio.pick) endPick();
  }
  // 换档（转屏、折叠屏开合）时临时开合作废，免得平板上推开的侧列变成手机上自己弹出来的抽屉
  $effect(() => { compact; expanded; untrack(() => { studio.drawer = false; }); });

  // —— 任务：顶栏标在跑；完成时合一拍；分段上的墨描到哪一页 ——
  const activeJobs = $derived(studio.jobs.filter(isActive));
  const busyBy = $derived(Object.fromEntries(PAGES.map((p) => [p, activeJobs.some((j) => pageOf(j.kind) === p)])));
  let beat = $state(0);
  let doneBy = $state({ image: 0, video: 0, voice: 0, music: 0 });
  $effect(() => onJobDone((job) => {
    beat++;
    const p = pageOf(job.kind);
    if (p) doneBy[p]++;
  }));

  // —— 参数坞：宽屏 + 记住的开关 + 当前页的模型有参数 ——
  const curModel = $derived(currentModel(studio.page));
  const hasParams = $derived(!!(curModel?.params?.length || curModel?.inputs?.negative));
  const dockOn = $derived(expanded && studio.side.dock && hasParams);
  function closeDock() { studio.side.dock = false; saveSide(); }

  // —— 顶栏：分段居中在左右两组之间，放不下（room 不够）时没选中的只留字形 ——
  let barW = $state(0), lW = $state(0), rW = $state(0), barEl = $state();
  const tabsRoom = $derived.by(() => {
    if (!barEl || !barW) return 0;
    const cs = getComputedStyle(barEl);
    const inner = barW - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    return Math.max(0, inner - 2 * Math.max(lW, rW) - 16);
  });

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
      leaveT = setTimeout(() => { leaving = ''; }, 150);
      enterT = setTimeout(() => { if (entering === p) entering = ''; }, 520);
    });
  });
  function go(p) { if (p !== studio.page) studio.page = p; }
  // 墙没拉过才拉（进 Studio 时其余三页由数据层空闲时预拉）
  $effect(() => { const p = studio.page; untrack(() => ensureWall(p)); });

  // 桌面 Ctrl/⌘ + 1…4 切页；Esc：浮层 → 挑选态（焦点的 Esc 归作品墙自己）
  function onKey(e) {
    if (ui.screen !== 'studio') return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); go(PAGES[Number(e.key) - 1]); return; }
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (layerCount()) { e.preventDefault(); closeTopLayer(); }
    else if (!studio.focus && studio.pick) { e.preventDefault(); endPick(); }
  }

  // 手机：左缘右滑跟手拉出抽屉；抽屉上左滑收起
  let drawerX = $state(0);
  let drawerDragging = $state(false);
  const drawerW = () => Math.min(innerWidth * 0.86, 340);
  const edgeOpen = (node) => swipeDismiss(node, {
    axis: 'x', dir: 1, edge: 24, threshold: 0.35, size: drawerW,
    guard: () => compact && !shelfOpen && !ui.morphing && !drag.on,
    onStart: () => { drawerDragging = true; },
    onMove: (x) => { drawerX = x; },
    onSettle: (goOpen) => { drawerDragging = false; drawerX = 0; if (goOpen) studio.drawer = true; },
  });
  const drawerClose = (node) => swipeDismiss(node, {
    axis: 'x', dir: -1, threshold: 0.3, size: drawerW,
    guard: () => compact && shelfOpen && !drag.on,
    onStart: () => { drawerDragging = true; },
    onMove: (x) => { drawerX = -x; },
    onSettle: (goClose) => { drawerDragging = false; drawerX = 0; if (goClose) closeShelf(); },
  });
  // 拎着东西真的挪动了，手机抽屉才让开（东西是从抽屉里拎出来要放进创作页的）；原地按住松手是要菜单，抽屉留着
  $effect(() => { if (drag.on && drag.moved && compact && shelfOpen) untrack(closeShelf); });

  // —— 平板 / 桌面：左缘右滑＝预测式返回（同 Claude 页）——
  let peekX = $state(0), peeking = $state(false);
  let slideEl = $state();
  const peek = $derived(backPeek(peekX));
  function resetSlide() { peekX = 0; peeking = false; ui.studioSliding = false; }
  const edgeBack = (node) => swipeDismiss(node, {
    axis: 'x', dir: 1, edge: 40, threshold: 0.32,
    guard: () => !pageWin && !compact && !ui.morphing && !drag.on,
    base: () => peekX, cur: () => peekX,
    onStart: () => { peeking = true; ui.studioSliding = true; },
    onMove: (x) => { peekX = x; },
    onSettle: (g) => { if (!g) { peeking = false; ui.studioSliding = false; } },
    onCommit: () => {
      const rect = () => { const r = slideEl?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };
      closePage('studio', { fromRect: rect, fromRadius: peek.r, onSwitch: resetSlide });
    },
  });
  function back() { if (!pageWin && ui.screen === 'studio') closePage('studio', { onSwitch: resetSlide }); }

  // 系统返回：浮层 → 焦点 → 挑选态 → 抽屉 / 平板侧列 → 回主页
  $effect(() => registerCloser('studio', () => {
    if (closeTopLayer()) return;
    if (studio.focus) { closeFocus(); return; }
    if (studio.pick) { endPick(); return; }
    if (studio.drawer && !expanded) { studio.drawer = false; return; }
    back();
  }));

  // —— 核心入口发来的素材（工作空间「发到 Media Studio」、agent 的 ui.cmd）——
  $effect(() => { if (studioInbox.items.length) untrack(() => takeInbox(studioInbox)); });

  const fixture = $derived(import.meta.env.DEV && usingFixture() && !!studio.catalog);
</script>

<svelte:window onkeydown={onKey} />

<div class="studio-slide" class:peeking bind:this={slideEl} style:transform={peek.transform} style:clip-path={peek.clip} use:edgeBack>
<div class="studio-root" class:dark class:compact class:medium={layout.medium} class:expanded class:shelf-open={shelfOpen} class:dock-on={dockOn}
  class:picking={!!studio.pick} class:sd-noanim={prefs.noEnterAnim} style="--sd-dir:{dir};{MOTION}{glassVars}" use:edgeOpen>

  <div class="sd-body">
    {#if compact}
      <button class="sd-scrim" class:open={shelfOpen || drawerDragging} aria-label={t('关闭')} tabindex="-1"
        style:opacity={drawerDragging ? (shelfOpen ? 1 + drawerX / drawerW() : drawerX / drawerW()) : null}
        onclick={closeShelf}></button>
    {/if}
    <!-- 素材架：同一棵子树在三档之间只换外形（侧列 / 抽屉），从不随创作页重挂 -->
    <aside class="sd-shelf" class:open={shelfOpen} class:dragging={drawerDragging} use:drawerClose
      style:transform={compact && drawerDragging ? `translateX(${(shelfOpen ? 0 : -drawerW()) + drawerX}px)` : null}
      aria-hidden={compact && !shelfOpen} inert={compact && !shelfOpen} aria-label={t('素材架')}>
      <Shelf open={shelfOpen} drawer={compact} ontoggle={toggleShelf} onclose={closeShelf} />
    </aside>

    <div class="sd-work">
      <section class="sd-center">
        <header class="sd-band sd-cbar" bind:this={barEl} bind:clientWidth={barW}>
          <div class="sd-cbar-l"><div class="sd-cbar-in" bind:clientWidth={lW}>
            {#if !pageWin}<button class="sd-ib" aria-label={t('返回')} onclick={back}>{@html icon('back')}</button>{/if}
            {#if expanded}
              <span class="sd-brand"><Mark state={activeJobs.length ? 'work' : 'idle'} {beat} size={26} small={false} /><b>Media Studio</b>
                {#if fixture}<span class="sd-fx" title={t('后端还没有 Media Studio 接口，正在用本地样例数据')}>{t('样例数据')}</span>{/if}</span>
            {/if}
          </div></div>
          <StudioTabs value={studio.page} onchange={go} labels={LABEL} busy={busyBy} done={doneBy} room={tabsRoom} />
          <div class="sd-cbar-r"><div class="sd-cbar-in" bind:clientWidth={rW}>
            <button class="sd-ib" aria-label={t('Media Studio 设置')} onclick={() => openSettings('studio')}>{@html icon('gear')}</button>
          </div></div>
        </header>

        <main class="sd-stage">
          {#each PAGES as p (p)}
            {#if mounted[p]}
              {@const Comp = PAGE_COMP[p]}
              <section class="sd-page" class:on={studio.page === p} class:leaving={leaving === p} class:st-in={entering === p}
                class:dormant={studio.page !== p && leaving !== p} inert={studio.page !== p} aria-label={LABEL[p]}>
                <Comp active={studio.page === p && ui.screen === 'studio'} sideOpen={shelfOpen && !compact} wide={dockOn} />
              </section>
            {/if}
          {/each}
          {#if !studio.catalog && studio.catalogErr}
            <div class="sd-cat-err"><span class="ic">{@html icon('warn')}</span><p>{studio.catalogErr}</p></div>
          {/if}
        </main>
      </section>

      <!-- 参数坞：常驻节点（各创作页把自己的参数面板挂进 .sd-dock-body，只显示当前页那一份；挂面板时它必须已经在）；
           开合是推开（宽度过渡，里层贴右不重排）；不到宽屏不显示 -->
      <aside class="sd-dock" class:on={dockOn} aria-label={t('参数')} aria-hidden={!dockOn} inert={!dockOn}>
          <div class="sd-dock-in">
            <header class="sd-band sd-dock-hd">
              <span class="sd-dock-t">{t('参数')}</span>
              <button class="sd-ib" aria-label={t('收起参数')} onclick={closeDock}>{@html icon('close')}</button>
            </header>
            <div class="sd-dock-body"></div>
          </div>
        </aside>
    </div>
  </div>
</div>
</div>
