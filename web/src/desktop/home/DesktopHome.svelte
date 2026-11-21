<script>
  // 桌面主页（批4）：沉浸启动器——壁纸全景 + 底部玻璃 Dock + Ctrl+K 命令面板。
  // 玻璃策略（批2 双引擎按底材分工）：
  //   静态壁纸（多洛米蒂/上传图）→ GlassScene GL 引擎画 Dock 玻璃体（真折射）；
  //   动态底材（flux iframe / 空间视差 canvas）→ 每画完一帧同步拷给 FigmaGlassDock(live)；
  //   WebGPU 不可用或还没画出第一帧时 Dock 走 domGlass backdrop。
  // 入口点击行为与手机 Home 同一套契约：登录门、noEnterAnim 直切、claude/studio
  // 转场把 Dock 图标 rect 交给 ui.enterOrigin。壁纸机制（flux 调参轮询/交叉淡出）
  // 与手机端同源复刻，数据仍是 wp/fluxParams 单一真相。
  import { untrack } from 'svelte';
  import { ui, me, prefs, fluxParams, fluxProps } from '../../lib/state.svelte.js';
  import { wp, wpDef, spatial, wpHasDepth, wpDepthUrl } from '../../lib/wallpaper.svelte.js';
  import SpatialLayer from '../../components/SpatialLayer.svelte';
  import { settingsNav } from '../settings/settingsNav.svelte.js';
  import GlassScene from '../glass/GlassScene.svelte';
  import FigmaGlassDock from '../glass/figmaPort/FigmaGlassDock.svelte';
  import { dskGlass } from '../glass/domGlass.js';
  import { frameLevel, onFrameLevel } from '../glass/attention.js';
  import { GLASS } from '../glass/material.js';
  import { tooltip } from '../kit/tooltip.js';
  import CommandPalette from './CommandPalette.svelte';
  import { t } from '../../lib/i18n.js';
  // Claude 入口的小人（原版资源，web/src/visuals/）由 lib/homeLayout 的 builtinHomeIcon 给；其余入口图标是自有素材
  import { homeView, builtinHomeIcon } from '../../lib/homeLayout.svelte.js';   // Dock 入口 = 内置 + 插件应用，同手机主页
  import { openPage } from '../../lib/pageMorph.js';
  import { openApp, appIconUrl } from '../../lib/pluginApps.svelte.js';
  import { uiIcon } from '../../lib/pluginUi.svelte.js';
  import HomeMoreSheet from '../../components/apps/HomeMoreSheet.svelte';
  import HomeEntryMenu, { homeEntryMenuItems } from '../../components/apps/HomeEntryMenu.svelte';
  import PluginHomeCards from '../../components/PluginHomeCards.svelte';

  const BASE = import.meta.env.BASE_URL;

  // —— 入口（与手机 Home 同一份数据：lib/homeLayout 的 homeView().shown——内置入口按权限过滤 + 插件应用，
  //     用户排的顺序、去掉隐藏的，超过 8 个时第 8 格换成「更多」）。小人 = 任务状态指示器（举旗 = 有任务完成还没看）。
  // 主页切到其它分页时由 App.svelte 用 display:none 隐藏而不卸载：切明暗（尤其暗→明）若在隐藏态立刻换壁纸分支，
  // 会在分页 ViewTransition 期间同步重建 WebGL2/WebGPU 管线并编译着色器，阻塞主线程。锁定已渲染槽位，
  // 直到主页重新可见或 closePage 预热（homeWarm）再同步切换。
  const homeVisible = $derived(ui.screen === 'home' || ui.homeWarm || ui.claudeSliding || ui.studioSliding);
  const wantSlot = $derived(ui.glassMode === 'B' ? 'light' : 'dark');
  let renderedSlot = $state(ui.glassMode === 'B' ? 'light' : 'dark');
  $effect(() => {
    if (!homeVisible) return;
    const s = wantSlot;
    untrack(() => { if (renderedSlot !== s) renderedSlot = s; });
  });

  const view = $derived(homeView());
  const DOCK = $derived(view.shown);
  const lightIcons = $derived(renderedSlot === 'light');
  function iconOf(e) {
    if (e.kind === 'app') {
      const url = appIconUrl(e.app, lightIcons);
      return url ? { img: url } : { svg: uiIcon(e.app?.icon?.name) };
    }
    return { img: builtinHomeIcon(e.key, { light: lightIcons, taskDone: ui.taskDone }) };
  }
  const labelOf = (e) => (e.kind === 'more' ? t('更多') : e.label);
  const badgeOf = (e) => (e.kind === 'app' ? String(e.app?.badge || '') : e.kind === 'more' ? e.badge || '' : '');
  // 「更多」里收着的键：pageMorph 关页时这些应用没有自己的图标，就收回「更多」那一格
  const moreKeys = $derived(view.overflow.map((e) => e.key).join(' '));
  let moreOpen = $state(false), moreBtn = $state(null);

  // —— 壁纸（三形态；数据同手机端）——
  const homeSlot = $derived(renderedSlot);
  const curWpId = $derived(wp[homeSlot]);
  const curWp = $derived(wpDef(curWpId));
  const spatialOn = $derived(!curWp.dyn && spatial[homeSlot].on && wpHasDepth(curWpId));
  const glMode = $derived(!curWp.dyn && !spatialOn);   // 静态图 → GL 玻璃引擎

  // —— GPU 丢失自愈 ——
  // GPU 进程崩溃/重启（睡眠唤醒、驱动重置、客户端常开几天）会让壁纸画布的 WebGL 上下文和 Dock 的
  // WebGPU 设备一起丢掉；丢了的画布不会自己恢复，主页只剩一片白、Dock 玻璃也没了（10-13 实测：
  // 客户端从 10-11 开着，GPU 进程 10-12 夜里重启过）。任一层报丢失 → 等 GPU 进程起来，
  // 整组壁纸层换新画布重挂（gpuEpoch）。一分钟内丢到第 4 次 = GPU 起不来/WebGL 被拉黑，
  // 不再重试，退到 CSS 底图 + DOM 玻璃 Dock。
  let gpuEpoch = $state(0), gpuDead = $state(false);
  let lostTimer = 0, lostLog = [];
  function onGpuLost() {
    if (lostTimer || gpuDead) return;   // 几层同时报丢失只重建一次
    const now = Date.now();
    lostLog = lostLog.filter((ts) => now - ts < 60000);
    lostLog.push(now);
    if (lostLog.length > 3) { gpuDead = true; return; }
    lostTimer = setTimeout(() => { lostTimer = 0; gpuEpoch++; }, 800);
  }
  $effect(() => () => clearTimeout(lostTimer));
  // GPU 全挂时的底图：静态壁纸直接铺原图（与 GlassScene 同为 cover 居中），流光用缩略渐变
  const deadBg = $derived(curWp.url ? `#0a0a0a url("${curWp.url}") center / cover no-repeat` : curWp.css || '#0a0a0a');

  // flux 调参（同源复刻手机 Home：WASM 异步初始化，轮询直到套上预设再补打几轮）
  let wpEl = $state();
  function tuneWallpaper() {
    try {
      const w = wpEl?.contentWindow;
      if (w && w.wallpaperPropertyListener?.applyUserProperties) {
        w.wallpaperPropertyListener.applyUserProperties(fluxProps());
        return true;
      }
    } catch {}
    return false;
  }
  // 失焦 / 不可见超过 5 秒（attention.js）：流体壁纸降到 20fps / 1fps，回到焦点当场全速（T8）。
  // 只走 main.js 自带的 Wallpaper Engine 接口 applyGeneralProperties({fps}) 改帧间隔（fps=Infinity → 间隔 0＝原样）。
  // 不用它的 setPaused：暂停只置标志、恢复时无条件再挂一次 RAF，最小化 / 藏托盘期间 RAF 一次不跑，
  // 旧回调还挂在队列里，暂停→恢复一轮就多一条帧循环（每轮叠一条）。不可见时主窗口 backgroundThrottling
  // 本来就停了 RAF，'off' 只把帧间隔拉到 1 秒兜底。Dock 的 Figma 玻璃（live）跟着壁纸的帧走，一并降下来。
  // 壳没有这个接口时档位恒为 full，什么都不动。
  const WP_FPS = { full: Infinity, low: 20, off: 1 };
  let wpFps = Infinity;   // 已套到壁纸上的帧率；iframe 重载（换主题 / GPU 自愈）＝全新的帧循环，从全速起
  function throttleWallpaper(lv = frameLevel()) {
    // 主页被分页盖住（display:none）时同样把流光降到 1fps，避免后台持续占用 GPU 与排满 WebGPU 队列
    const fps = homeVisible ? (WP_FPS[lv] ?? Infinity) : 1;
    if (fps === wpFps) return;
    try {
      const L = wpEl?.contentWindow?.wallpaperPropertyListener;
      if (typeof L?.applyGeneralProperties !== 'function') return;
      L.applyGeneralProperties({ fps });
      wpFps = fps;
    } catch {}
  }
  $effect(() => { homeVisible; throttleWallpaper(); });
  $effect(() => onFrameLevel((lv) => throttleWallpaper(lv)));
  function onWpLoad() {
    hookFluxFrames();
    wpFps = Infinity;
    const retune = () => { tuneWallpaper(); throttleWallpaper(); };
    let tries = 0;
    const iv = setInterval(() => {
      if (tuneWallpaper() || ++tries > 80) {
        clearInterval(iv);
        throttleWallpaper();
        // 后面几轮补打预设时顺带把当前档位补上（档位没变就是空操作）
        [600, 1800, 4500].forEach((ms) => setTimeout(retune, ms));
      }
    }, 180);
  }
  $effect(() => { for (const k in fluxParams) fluxParams[k]; tuneWallpaper(); });
  $effect(() => {
    const f = () => { if (!document.hidden) setTimeout(tuneWallpaper, 300); };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  });

  // —— Dock 几何 → GL pane（GlassScene 画布铺满视口，rect 即视口 css px）——
  let dockEl = $state();
  let dockRect = $state(null);
  let lastDockKey = '';
  function measureDock() {
    if (!dockEl || !homeVisible) return;
    const r = dockEl.getBoundingClientRect();
    // display:none 下矩形为 0×0：忽略，避免把有效 dockRect 覆写成 0 触发后台 WebGPU 玻璃重画
    if (r.width < 2 || r.height < 2) return;
    const k = `${r.left},${r.top},${r.width},${r.height}`;
    if (k === lastDockKey) return;   // RO 与 resize 双触发，没变就别重画玻璃（非响应式变量，免得 $effect 依赖 dockRect）
    lastDockKey = k;
    dockRect = { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  $effect(() => {
    if (!dockEl || !homeVisible) return;
    measureDock();
    const ro = new ResizeObserver(measureDock);
    ro.observe(dockEl);
    window.addEventListener('resize', measureDock);
    return () => { ro.disconnect(); window.removeEventListener('resize', measureDock); };
  });
  // Dock 玻璃体优先走 Figma 源码移植（WebGPU，FigmaGlassDock）；它第一帧画出来才接管，
  // 期间及 WebGPU 不可用时仍由 GlassScene 画 GL 玻璃。?oldglass 强制旧引擎。
  const portWanted = !location.search.includes('oldglass');
  // ?figmaedge：恢复 Figma 原稿的 LINEAR_BURN 细描边（默认去掉，亮壁纸上是一圈细黑边）
  const figmaEdge = location.search.includes('figmaedge');
  let portOn = $state(false);
  let spatialLayer = $state(), fgdLive = $state();
  // 流体壁纸：main.js 每画完一帧（同一任务内，WebGPU/WebGL 缓冲还有效）调 __fluxFrame，
  // 把 iframe 里的画布连同 iframe 在本页的位置交给 FigmaGlassDock 拷走 Dock 那块
  function hookFluxFrames() {
    try {
      const w = wpEl?.contentWindow, c = w?.document.getElementById('canvas');
      if (!c) return;
      c.addEventListener('webglcontextlost', onGpuLost);   // flux 走 WebGL 时也接自愈（iframe 随 gpuEpoch 重载）
      // 主页隐藏时不再把流光帧拷进 WebGPU Dock 玻璃，避免后台持续提交纹理复制与 2× 离屏渲染
      w.__fluxFrame = () => { if (homeVisible && fgdLive && wpEl) fgdLive.onSourceDraw(c, wpEl.getBoundingClientRect()); };
    } catch {}
  }
  // 换壁纸形态时 FigmaGlassDock 会重挂，接管状态先归零，等新实例画出第一帧再报 true
  $effect(() => { glMode; spatialOn; curWp.dyn; gpuEpoch; portOn = false; });
  function panes() {
    if (!glMode || !dockRect || portOn) return [];
    return [{ ...GLASS.dock, radius: 30, x: dockRect.x, y: dockRect.y, w: dockRect.w, h: dockRect.h }];
  }

  // —— Dock 悬停放大（索引邻域法：hovered 1.3 / 邻位 1.12）——
  // 索引 = Dock 里的实际位置：入口 0…n-1、分隔线占 n、工作空间 n+1、设置 n+2（分隔线两侧互不连带放大）
  let hov = $state(-1);
  const scaleOf = (i) => (hov < 0 ? 1 : i === hov ? 1.3 : Math.abs(i - hov) === 1 ? 1.12 : 1);

  // —— 打开入口（契约与手机 Home 一致；唯一分叉：桌面没有登录胶囊，
  //     未登录一律送进设置→账户分区登录，登录状态也住在那里）——
  function openEntry(key, ev) {
    if (me.kind === 'none') { settingsNav.sec = 'account'; ui.settingsOpen = true; return; }
    if (key === 'settings') { ui.settingsOpen = true; return; }
    // 转场进行中不再开第二个（转场层已不吞点击，防连点的门在入口这边把）
    if (ui.morphing || ui.enterClaude || ui.enterStudio) return;
    if (prefs.noEnterAnim && (key === 'claude' || key === 'studio')) { ui.screen = key; return; }
    const icon = ev?.currentTarget?.querySelector('.dico');
    const r = icon?.getBoundingClientRect();
    if (key === 'claude') {
      ui.enterOrigin = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      // 桌面开场是「Dock 槽位里换人」：小人蹲身向下躲出栏 → 菊花从栏下弹出补位。
      // 转场层要知道栏下沿这条裁切线；命令面板进来（没有图标 rect）不摆这一出，传 null。
      const br = r ? dockEl?.getBoundingClientRect() : null;
      ui.enterBar = br ? { x: br.left, y: br.top, w: br.width, h: br.height } : null;
      ui.enterClaude = true;
      return;
    }
    if (key === 'studio') {
      ui.enterOrigin = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      ui.enterBar = r ? (dockEl?.getBoundingClientRect() || null) : null;
      ui.enterStudio = true;
      return;
    }
    openPage(key, { from: icon, radius: 12 });
  }
  // Dock 上的一格：内置走 openEntry；插件应用从 Dock 图标长成全屏分页（openApp，圆角 12 = Dock 图标）；「更多」在 Dock 上方弹出收着的那些
  function openItem(e, ev) {
    if (e.kind === 'builtin') { openEntry(e.key, ev); return; }
    if (me.kind === 'none') { settingsNav.sec = 'account'; ui.settingsOpen = true; return; }
    if (e.kind === 'more') { moreBtn = ev?.currentTarget || null; moreOpen = !moreOpen; return; }
    if (ui.enterClaude || ui.enterStudio || ui.morphing) return;
    openApp(e.app || e.key, { from: ev?.currentTarget?.querySelector?.('.dico') || ev?.from || null, radius: ev?.radius ?? 12 });
  }
  function pickMore(e, rect, radius) {
    moreOpen = false;
    if (e.kind === 'builtin') { openEntry(e.key, null); return; }
    openItem(e, { from: rect, radius });
  }

  // —— 右键 Dock 上的入口：与手机 / 网页主页同一份菜单（从主页隐藏；插件应用再多「插件详情」），从鼠标处弹出 ——
  // 桌面壳是鼠标 + 右键，不做长按计时（Windows 触屏按住不放，系统自己会补发 contextmenu，走的也是这里）。
  // 一律 preventDefault：图标是 <img>，不拦的话 nativeMenu 会弹系统的「复制图片」。
  // 没登录 / 转场中只拦不弹（同 openItem 的门）；「更多」那格没有菜单。
  let entryMenu = $state(null);   // { x, y, title, items }
  function onDockCtx(ev, e) {
    ev.preventDefault();
    if (entryMenu || me.kind === 'none' || ui.morphing || ui.enterClaude || ui.enterStudio) return;
    const items = homeEntryMenuItems(e);
    if (!items.length) return;
    entryMenu = { x: ev.clientX, y: ev.clientY, title: e.label, items };
  }
</script>

<!-- entering：claude 入场期间桌面主页轻轻暗下去（面板从 Dock 升起时它还看得见） -->
<div class="dh" class:dimbg={ui.settingsOpen} class:entering={ui.enterClaude} style:background={gpuDead ? deadBg : null}>
  {#if gpuDead}
    <!-- GPU 起不来：不挂任何画布（死画布会盖成一片白），底图走 .dh 的 CSS 背景 -->
  {:else}
  {#key gpuEpoch}
  {#if curWp.dyn}
    {#if ui.booted}
      <iframe class="wp" bind:this={wpEl} src={BASE + 'wallpaper/drift.html?v=6'} title={t('背景')} scrolling="no" tabindex="-1" onload={onWpLoad}></iframe>
      {#if portWanted && dockRect}
        <!-- 流体壁纸：玻璃背景每帧从 iframe 里的 flux 画布同步拷取（flux 一直在画，不用向它要帧） -->
        <FigmaGlassDock bind:this={fgdLive} live rect={dockRect} edgeLines={figmaEdge} onready={(ok) => (portOn = ok)} onlost={onGpuLost} />
      {/if}
    {/if}
  {:else if spatialOn}
    <SpatialLayer bind:this={spatialLayer} imgUrl={curWp.url} depthUrl={wpDepthUrl(curWpId)} amp={spatial[homeSlot].amp}
                  ondraw={(c) => fgdLive?.onSourceDraw(c)} onlost={onGpuLost} />
    {#if portWanted && dockRect}
      <!-- 视差壁纸：玻璃背景每帧从视差画布同步拷取，折射跟着视差走 -->
      <FigmaGlassDock bind:this={fgdLive} live rect={dockRect} edgeLines={figmaEdge} requestSource={() => spatialLayer?.redraw(true)}
                      onready={(ok) => (portOn = ok)} onlost={onGpuLost} />
    {/if}
  {:else}
    <!-- 静态壁纸：GL 统一合成——壁纸与 Dock 玻璃体同一场景真折射 -->
    <GlassScene src={curWp.url} getPanes={panes} onlost={onGpuLost} />
    {#if portWanted && dockRect}
      <FigmaGlassDock src={curWp.url} rect={dockRect} edgeLines={figmaEdge} onready={(ok) => (portOn = ok)} onlost={onGpuLost} />
    {/if}
  {/if}
  {/key}
  {/if}
  <div class="wp-veil"></div>

  <div class="dock-wrap">
    {#snippet dockItems()}
      {#each DOCK as e, i (e.key)}
        {@const badge = badgeOf(e)}
        <button class="ditem" style:--s={scaleOf(i)} use:tooltip={labelOf(e)}
                data-entry={e.kind === 'more' ? undefined : e.key} data-more={e.kind === 'more' ? moreKeys : undefined}
                aria-haspopup={e.kind === 'more' ? 'dialog' : undefined} aria-expanded={e.kind === 'more' ? moreOpen : undefined}
                onpointerenter={() => (hov = i)} onclick={(ev) => openItem(e, ev)} oncontextmenu={(ev) => onDockCtx(ev, e)}
                aria-label={badge ? t('{name}（{badge}）', { name: labelOf(e), badge }) : labelOf(e)}>
          {#if e.kind === 'more'}
            <!-- 「更多」：3×3 点阵 -->
            <span class="dico dglyph" data-r="12" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg></span>
          {:else}
            {@const ic = iconOf(e)}
            {#if ic.img}
              <!-- 转场期间 claude 那只交给转场层的同款副本演（蹲身/下潜），本尊让位免得两只重影 -->
              <img class="dico" class:handoff={e.key === 'claude' && ui.enterClaude && !!ui.enterBar}
                   src={ic.img} alt="" draggable="false" />
            {:else}
              <!-- 插件内置图标名：线稿画在一枚浅玻璃小方块里，和 logo 类图标一样有个轮廓 -->
              <span class="dico dglyph" data-r="12" aria-hidden="true">{@html ic.svg}</span>
            {/if}
          {/if}
          {#if badge}<span class="dbadge" aria-hidden="true">{badge}</span>{/if}
        </button>
      {/each}
      <span class="dsep"></span>
      <button class="ditem" data-entry="files" style:--s={scaleOf(DOCK.length + 1)} use:tooltip={t('工作空间')}
              onpointerenter={() => (hov = DOCK.length + 1)} onclick={(ev) => openEntry('files', ev)} aria-label={t('工作空间')}>
        <!-- 两层：带页签的后片半透 + 前片实白；前片上沿垫一道细暗边（前片上移 .9 的影）把两层分开 -->
        <svg class="dico dsvg" viewBox="0 0 44 44"><defs><linearGradient id="dkFolderG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#e6eaf1"/></linearGradient></defs>
          <path d="M5 12a3 3 0 0 1 3-3h7.2c.9 0 1.75.4 2.33 1.1l1.35 1.6c.57.7 1.43 1.1 2.33 1.1H36a3 3 0 0 1 3 3V32a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="#fff" fill-opacity=".62"/>
          <path d="M5 18.4a2.6 2.6 0 0 1 2.6-2.6h28.8a2.6 2.6 0 0 1 2.6 2.6V32a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" transform="translate(0 -.9)" fill="#000" fill-opacity=".14"/>
          <path d="M5 18.4a2.6 2.6 0 0 1 2.6-2.6h28.8a2.6 2.6 0 0 1 2.6 2.6V32a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="url(#dkFolderG)"/></svg>
      </button>
      <button class="ditem" style:--s={scaleOf(DOCK.length + 2)} use:tooltip={t('设置 · Ctrl+K 搜索')}
              onpointerenter={() => (hov = DOCK.length + 2)} onclick={() => openEntry('settings')} aria-label={t('设置')}>
        <!-- 8 齿梯形齿 + 齿顶/齿根解析圆角 + 中心孔（几何由 scripts/dock-gear.mjs 解析求切点生成，改齿形去那里调参重算，别手抠） -->
        <svg class="dico dsvg" viewBox="0 0 44 44"><defs><linearGradient id="dkGearG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#e6eaf1"/></linearGradient></defs>
          <path fill-rule="evenodd" fill="url(#dkGearG)" d="M17.7 9.52A1.2 1.2 0 0 0 18.49 8.62L19.09 5.66A1.5 1.5 0 0 1 20.43 4.47A17.6 17.6 0 0 1 23.57 4.47A1.5 1.5 0 0 1 24.91 5.66L25.51 8.62A1.2 1.2 0 0 0 26.3 9.52A13.2 13.2 0 0 1 27.79 10.14A1.2 1.2 0 0 0 28.98 10.06L31.5 8.39A1.5 1.5 0 0 1 33.29 8.49A17.6 17.6 0 0 1 35.51 10.71A1.5 1.5 0 0 1 35.61 12.5L33.94 15.02A1.2 1.2 0 0 0 33.86 16.21A13.2 13.2 0 0 1 34.48 17.7A1.2 1.2 0 0 0 35.38 18.49L38.34 19.09A1.5 1.5 0 0 1 39.53 20.43A17.6 17.6 0 0 1 39.53 23.57A1.5 1.5 0 0 1 38.34 24.91L35.38 25.51A1.2 1.2 0 0 0 34.48 26.3A13.2 13.2 0 0 1 33.86 27.79A1.2 1.2 0 0 0 33.94 28.98L35.61 31.5A1.5 1.5 0 0 1 35.51 33.29A17.6 17.6 0 0 1 33.29 35.51A1.5 1.5 0 0 1 31.5 35.61L28.98 33.94A1.2 1.2 0 0 0 27.79 33.86A13.2 13.2 0 0 1 26.3 34.48A1.2 1.2 0 0 0 25.51 35.38L24.91 38.34A1.5 1.5 0 0 1 23.57 39.53A17.6 17.6 0 0 1 20.43 39.53A1.5 1.5 0 0 1 19.09 38.34L18.49 35.38A1.2 1.2 0 0 0 17.7 34.48A13.2 13.2 0 0 1 16.21 33.86A1.2 1.2 0 0 0 15.02 33.94L12.5 35.61A1.5 1.5 0 0 1 10.71 35.51A17.6 17.6 0 0 1 8.49 33.29A1.5 1.5 0 0 1 8.39 31.5L10.06 28.98A1.2 1.2 0 0 0 10.14 27.79A13.2 13.2 0 0 1 9.52 26.3A1.2 1.2 0 0 0 8.62 25.51L5.66 24.91A1.5 1.5 0 0 1 4.47 23.57A17.6 17.6 0 0 1 4.47 20.43A1.5 1.5 0 0 1 5.66 19.09L8.62 18.49A1.2 1.2 0 0 0 9.52 17.7A13.2 13.2 0 0 1 10.14 16.21A1.2 1.2 0 0 0 10.06 15.02L8.39 12.5A1.5 1.5 0 0 1 8.49 10.71A17.6 17.6 0 0 1 10.71 8.49A1.5 1.5 0 0 1 12.5 8.39L15.02 10.06A1.2 1.2 0 0 0 16.21 10.14A13.2 13.2 0 0 1 17.7 9.52ZM27.4 22A5.4 5.4 0 1 0 16.6 22A5.4 5.4 0 1 0 27.4 22Z"/></svg>
      </button>
    {/snippet}
    {#if !gpuDead && (glMode || ((spatialOn || curWp.dyn) && portOn))}
      <!-- 玻璃体由 GL 场景 / Figma 玻璃（WebGPU）绘制，DOM 只承载图标 -->
      <div class="dock" bind:this={dockEl} onpointerleave={() => (hov = -1)} role="toolbar" tabindex="-1">{@render dockItems()}</div>
    {:else}
      <div class="dock domglass" bind:this={dockEl} use:dskGlass={{ ...GLASS.dock, radius: 30 }}
           onpointerleave={() => (hov = -1)} role="toolbar" tabindex="-1">{@render dockItems()}</div>
    {/if}
  </div>

  <!-- 插件的主页卡片：桌面上抬到 Dock 上方（Dock 底 22 + 高 68 + 悬停放大余量），别压住 Dock -->
  <PluginHomeCards bottom="112px" />

  <div class="hint">Ctrl + K</div>

  <!-- 右键菜单：挂在 .dh（整屏不透明底）直属层级，玻璃采得到底下的壁纸与 Dock（MorphMenu 的挂载要求） -->
  <HomeEntryMenu open={!!entryMenu} point={entryMenu} title={entryMenu?.title || ''} items={entryMenu?.items || []}
    dark={ui.theme !== 'light'} onclose={() => (entryMenu = null)} />
</div>

{#if moreOpen}
  <HomeMoreSheet items={view.overflow} anchor={moreBtn} onpick={pickMore} onclose={() => (moreOpen = false)} />
{/if}

<CommandPalette onOpenAgent={(k) => openEntry(k)} />

<style>
  .dh { position: fixed; inset: 0; background: #0a0a0a; overflow: hidden;
        transition: opacity var(--mo-quick) var(--ea-fade); }
  /* claude 入场：主页退到后面去。比转场本身快（200ms），否则前半段还亮着、纵深白让 */
  .dh.entering { opacity: .5; }
  /* 设置逻辑板全屏且不透明，盖住期间禁掉主页 backdrop（多 backdrop 互毁课，沿袭手机端） */
  .dh.dimbg :global(.lg), .dh.dimbg :global(.card), .dh.dimbg .dock.domglass {
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
  }
  .wp { position: fixed; top: 0; left: 0; width: 100vw; height: 100dvh; border: 0; z-index: 0; pointer-events: none; }
  .wp-veil { position: fixed; inset: 0; z-index: 1; pointer-events: none;
             background: radial-gradient(125% 95% at 50% 42%, rgba(0,0,0,0) 55%, rgba(0,0,0,.34) 100%); }

  .dock-wrap { position: fixed; left: 0; right: 0; bottom: 22px; z-index: 6; display: flex; justify-content: center; pointer-events: none; }
  .dock {
    pointer-events: auto;
    display: flex; align-items: center; gap: 10px;
    height: 68px; padding: 0 16px; border-radius: 30px;
  }
  .ditem {
    position: relative; width: 52px; height: 52px; display: grid; place-items: center;
    transform: scale(var(--s, 1)); transform-origin: 50% 100%;
    transition: transform .22s cubic-bezier(.32, 1.36, .4, 1);
  }
  .ditem:active { transform: scale(calc(var(--s, 1) * .9)); }
  .dico { width: 42px; height: 42px; object-fit: contain; filter: drop-shadow(0 3px 8px rgba(0, 0, 0, .38)); }
  .dico.handoff { visibility: hidden; }
  .dsvg { width: 40px; height: 40px; }
  /* 线稿图标（插件内置图标名 /「更多」点阵）：浅玻璃小方块 + 白色线稿，圆角 12 与转场起点一致 */
  .dglyph { display: grid; place-items: center; border-radius: 12px; color: #fff; box-sizing: border-box;
            background: rgba(255, 255, 255, .16); box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .28); }
  .dglyph :global(svg) { width: 24px; height: 24px; }
  /* 角标：功能性小红圆，压在图标右上角（跟着悬停放大，同 macOS Dock） */
  .dbadge { position: absolute; top: 0; right: 0; min-width: 17px; height: 17px; padding: 0 5px; box-sizing: border-box;
            border-radius: 9px; background: #ff3b30; color: #fff; font: 600 10.5px/17px var(--dsk-font, var(--sans));
            text-align: center; font-variant-numeric: tabular-nums; box-shadow: 0 1px 3px rgba(0, 0, 0, .25); pointer-events: none; }
  .dsep { width: 1px; height: 36px; background: rgba(255, 255, 255, .22); margin: 0 4px; flex: none; }

  .hint {
    position: fixed; right: 20px; bottom: 30px; z-index: 5; pointer-events: none;
    font-family: var(--dsk-font); font-size: 11.5px; letter-spacing: .05em;
    color: rgba(255, 255, 255, .5); text-shadow: 0 1px 5px rgba(0, 0, 0, .4);
  }
</style>
