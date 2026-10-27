<script>
  // 桌面主页（批4）：沉浸启动器——壁纸全景 + 底部玻璃 Dock + Ctrl+K 命令面板。
  // 玻璃策略（批2 双引擎按底材分工）：
  //   静态壁纸（多洛米蒂/上传图）→ GlassScene GL 引擎画 Dock 玻璃体（真折射）；
  //   动态底材（flux iframe / 空间视差 canvas）→ 每画完一帧同步拷给 FigmaGlassDock(live)；
  //   WebGPU 不可用或还没画出第一帧时 Dock 走 domGlass backdrop。
  // 入口点击行为与手机 Home 同一套契约：登录门、noEnterAnim 直切、claude/vertex
  // 转场把 Dock 图标 rect 交给 ui.enterOrigin。壁纸机制（flux 调参轮询/交叉淡出）
  // 与手机端同源复刻，数据仍是 wp/fluxParams 单一真相。
  import { ui, me, prefs, fluxParams, fluxProps, screenOn } from '../../lib/state.svelte.js';
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
  import { ovUrl } from '../../lib/overlay.svelte.js';   // 入口图标：私有 overlay 有同名原版（如小人）就换成它

  const BASE = import.meta.env.BASE_URL;

  // —— 入口（与手机 Home 同一套语义：小人=任务状态指示器、ChatGPT 按权限隐藏）——
  const claudeMascot = $derived(ui.taskDone ? '举旗' : '正面站立');   // i18n-ignore 素材文件名
  const AGENTS = $derived([
    { key: 'claude', label: 'Claude', img: `assets/mascot/claude-小人-${claudeMascot}.svg` },   // i18n-ignore 素材路径
    { key: 'chatgpt', label: 'ChatGPT', img: `assets/icons/chatgpt-${ui.glassMode === 'B' ? 'dark' : 'light'}.svg` },
    { key: 'harness', label: 'dimensio', img: `assets/icons/dimensio-${ui.glassMode === 'B' ? 'dark' : 'light'}.svg` },
    { key: 'vertex', label: 'Vertex', img: 'assets/icons/gemini.svg' },
  // 只摆这个身份开着的 agent（服务端下发的 me.agents：全局开关 ∩ 按人授权）；服务端各路由另有真闸。
  ].filter((e) => screenOn(e.key)));

  // —— 壁纸（三形态；数据同手机端）——
  const homeSlot = $derived(ui.glassMode === 'B' ? 'light' : 'dark');
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
    const fps = WP_FPS[lv] ?? Infinity;
    if (fps === wpFps) return;
    try {
      const L = wpEl?.contentWindow?.wallpaperPropertyListener;
      if (typeof L?.applyGeneralProperties !== 'function') return;
      L.applyGeneralProperties({ fps });
      wpFps = fps;
    } catch {}
  }
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
    if (!dockEl) return;
    const r = dockEl.getBoundingClientRect();
    const k = `${r.left},${r.top},${r.width},${r.height}`;
    if (k === lastDockKey) return;   // RO 与 resize 双触发，没变就别重画玻璃（非响应式变量，免得 $effect 依赖 dockRect）
    lastDockKey = k;
    dockRect = { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  $effect(() => {
    if (!dockEl) return;
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
      w.__fluxFrame = () => { if (fgdLive && wpEl) fgdLive.onSourceDraw(c, wpEl.getBoundingClientRect()); };
    } catch {}
  }
  // 换壁纸形态时 FigmaGlassDock 会重挂，接管状态先归零，等新实例画出第一帧再报 true
  $effect(() => { glMode; spatialOn; curWp.dyn; gpuEpoch; portOn = false; });
  function panes() {
    if (!glMode || !dockRect || portOn) return [];
    return [{ ...GLASS.dock, radius: 30, x: dockRect.x, y: dockRect.y, w: dockRect.w, h: dockRect.h }];
  }

  // —— Dock 悬停放大（索引邻域法：hovered 1.3 / 邻位 1.12）——
  let hov = $state(-1);
  const scaleOf = (i) => (hov < 0 ? 1 : i === hov ? 1.3 : Math.abs(i - hov) === 1 ? 1.12 : 1);

  // —— 打开入口（契约与手机 Home 一致；唯一分叉：桌面没有登录胶囊，
  //     未登录一律送进设置→账户分区登录，登录状态也住在那里）——
  function openEntry(key, ev) {
    if (me.kind === 'none') { settingsNav.sec = 'account'; ui.settingsOpen = true; return; }
    if (key === 'files' || key === 'settings') {
      if (key === 'settings') ui.settingsOpen = true; else ui.screen = 'files';
      return;
    }
    // 转场进行中不再开第二个（转场层已不吞点击，防连点的门在入口这边把）
    if (ui.enterClaude || ui.enterVertex) return;
    if (prefs.noEnterAnim && (key === 'claude' || key === 'vertex')) { ui.screen = key; return; }
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
    if (key === 'vertex') {
      ui.enterOrigin = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      ui.enterOriginTile = ui.enterOrigin;
      ui.enterVertex = true;
      return;
    }
    ui.screen = key;
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
      <iframe class="wp" bind:this={wpEl} src={BASE + 'wallpaper/index.html?v=pow2'} title={t('背景')} scrolling="no" tabindex="-1" onload={onWpLoad}></iframe>
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
      {#each AGENTS as a, i (a.key)}
        <button class="ditem" style:--s={scaleOf(i)} use:tooltip={a.label}
                onpointerenter={() => (hov = i)} onclick={(ev) => openEntry(a.key, ev)} aria-label={a.label}>
          <!-- 转场期间 claude 那只交给转场层的同款副本演（蹲身/下潜），本尊让位免得两只重影 -->
          <img class="dico" class:handoff={a.key === 'claude' && ui.enterClaude && !!ui.enterBar}
               src={ovUrl(a.img)} alt="" draggable="false" />
        </button>
      {/each}
      <span class="dsep"></span>
      <button class="ditem" style:--s={scaleOf(AGENTS.length + 1)} use:tooltip={t('工作空间')}
              onpointerenter={() => (hov = AGENTS.length + 1)} onclick={() => openEntry('files')} aria-label={t('工作空间')}>
        <!-- 两层：带页签的后片半透 + 前片实白；前片上沿垫一道细暗边（前片上移 .9 的影）把两层分开 -->
        <svg class="dico dsvg" viewBox="0 0 44 44"><defs><linearGradient id="dkFolderG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#e6eaf1"/></linearGradient></defs>
          <path d="M5 12a3 3 0 0 1 3-3h7.2c.9 0 1.75.4 2.33 1.1l1.35 1.6c.57.7 1.43 1.1 2.33 1.1H36a3 3 0 0 1 3 3V32a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="#fff" fill-opacity=".62"/>
          <path d="M5 18.4a2.6 2.6 0 0 1 2.6-2.6h28.8a2.6 2.6 0 0 1 2.6 2.6V32a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" transform="translate(0 -.9)" fill="#000" fill-opacity=".14"/>
          <path d="M5 18.4a2.6 2.6 0 0 1 2.6-2.6h28.8a2.6 2.6 0 0 1 2.6 2.6V32a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="url(#dkFolderG)"/></svg>
      </button>
      <button class="ditem" style:--s={scaleOf(AGENTS.length + 2)} use:tooltip={t('设置 · Ctrl+K 搜索')}
              onpointerenter={() => (hov = AGENTS.length + 2)} onclick={() => openEntry('settings')} aria-label={t('设置')}>
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

  <div class="hint">Ctrl + K</div>
</div>

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
    width: 52px; height: 52px; display: grid; place-items: center;
    transform: scale(var(--s, 1)); transform-origin: 50% 100%;
    transition: transform .22s cubic-bezier(.32, 1.36, .4, 1);
  }
  .ditem:active { transform: scale(calc(var(--s, 1) * .9)); }
  .dico { width: 42px; height: 42px; object-fit: contain; filter: drop-shadow(0 3px 8px rgba(0, 0, 0, .38)); }
  .dico.handoff { visibility: hidden; }
  .dsvg { width: 40px; height: 40px; }
  .dsep { width: 1px; height: 36px; background: rgba(255, 255, 255, .22); margin: 0 4px; flex: none; }

  .hint {
    position: fixed; right: 20px; bottom: 30px; z-index: 5; pointer-events: none;
    font-family: var(--dsk-font); font-size: 11.5px; letter-spacing: .05em;
    color: rgba(255, 255, 255, .5); text-shadow: 0 1px 5px rgba(0, 0, 0, .4);
  }
</style>
