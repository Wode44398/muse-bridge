<script>
  // §1 主页面。深色 flux 流体壁纸（iframe）+ 左上品牌字（接住预载页末态）+
  // 右上账户 pill（LoginCard，含工作空间入口）+ 中央三入口液态玻璃网格。
  // 未登录点任意入口 = 唤起登录。复杂入场动效（玻璃扩散/小人行走/菊花旋转）下一轮做。
  import { onMount, untrack } from 'svelte';
  import { ui, me, quality, fluxParams, fluxProps, bareGlass, screenOn } from '../lib/state.svelte.js';
  import { wp, wpDef, spatial, wpHasDepth, wpDepthUrl } from '../lib/wallpaper.svelte.js';
  import { liquidGlass, NO_SVG_BACKDROP } from '../lib/liquidGlass.js';
  import { pressable, stagger, DUR, EASE } from '../lib/motion.js';
  import { openPage } from '../lib/pageMorph.js';
  import { drag, dropZone } from '../lib/dragdrop.svelte.js';
  import { WS_FILE, attachToAgent } from '../lib/fileDrag.js';
  import LoginCard from './LoginCard.svelte';
  import RefractionLayer from './RefractionLayer.svelte';
  import SpatialLayer from './SpatialLayer.svelte';
  import FigmaGlass from './FigmaGlass.svelte';
  import { homeGlass } from '../lib/figmaHomeGlass.svelte.js';
  import { t } from '../lib/i18n.js';
  import { ovUrl } from '../lib/overlay.svelte.js';   // 入口图标：私有 overlay 有同名原版（如小人）就换成它

  const BASE = import.meta.env.BASE_URL;

  // claude 入口小人是状态指示器（这套素材当初就是为此预留的）：
  //   正面站立 = 默认；举旗 = 有任务完成还没看（ui.taskDone，回 claude 页清除）。
  const claudeMascot = $derived(ui.taskDone ? '举旗' : '正面站立');   // i18n-ignore 素材文件名
  const ENTRIES = $derived([
    { key: 'claude',      label: 'Claude',      img: `assets/mascot/claude-小人-${claudeMascot}.svg` },   // i18n-ignore 素材路径
    { key: 'chatgpt',     label: 'ChatGPT',     img: `assets/icons/chatgpt-${ui.glassMode === 'B' ? 'dark' : 'light'}.svg` },
    { key: 'harness', label: 'dimensio', img: `assets/icons/dimensio-${ui.glassMode === 'B' ? 'dark' : 'light'}.svg` },
    { key: 'vertex',      label: 'Vertex',      img: 'assets/icons/gemini.svg' },
  // 只摆这个身份开着的 agent（服务端下发的 me.agents：全局开关 ∩ 按人授权）；服务端各路由另有真闸。
  ].filter((e) => screenOn(e.key)));
  // 玻璃折射参数全部由全局画质驱动（设置页 4 档 + 3 滑块）；改 quality 即所有 tile 实时变。
  const glassBare = $derived(bareGlass(30));   // 与右上登录胶囊共用材质内核（state.bareGlass）
  // 入场「鼓包」进度 0→1（quality.ramp，模块级——组件级 $state 到 action 参数的响应
  // 链路实测不可靠，quality 路径已被滑块预览验证可达）：折射/色散从 0 拉到预设，仅明亮主题(B)。
  const glassReveal = $derived({ ...glassBare, scale: quality.refraction * quality.ramp, aberration: quality.dispersion * quality.ramp });

  // 主页玻璃不分平台，一律按下面顺序挑：
  //   ① 有 WebGPU → Figma 玻璃（FigmaGlass：桌面 Dock 同款原件，入口方块 + 右上胶囊）；
  //      静态壁纸取 <img>，空间视差取视差层每帧，流光取 flux iframe 每帧（__fluxFrame）
  //   ② 没有 WebGPU 的退路：iOS（WebKit 不支持 SVG backdrop 折射）静态壁纸走 WebGL 折射层
  //      （RefractionLayer）、空间壁纸走毛玻璃；其余浏览器走 SVG 液态玻璃
  // 调试：?glass=webgl 强制 iOS 退路，?glass=svg 强制 SVG 退路。
  const _ov = new URLSearchParams(location.search).get('glass');
  const isIOS = _ov === 'webgl' ? true : _ov === 'svg' ? false : NO_SVG_BACKDROP;
  const wantFigma = _ov !== 'webgl' && _ov !== 'svg' && typeof navigator !== 'undefined' && !!navigator.gpu;
  const useFigma = $derived(wantFigma && !homeGlass.failed);
  const useWebGL = $derived(isIOS && !curWp.dyn && !useFigma);
  const frostHigh = { blur: 9, saturate: 1.25, tint: 0.05 };    // 退路：极高透光毛玻璃
  let glassRects = $state([]);
  let gridEl = $state();
  function measureRects() {
    if (!gridEl) return;
    glassRects = [...gridEl.querySelectorAll('.tile')].map((tile) => {
      const r = tile.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, r: 30 };
    });
  }
  onMount(() => {
    const onR = () => measureRects();
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  });
  // 方案 B 激活时测量入口位置喂给 WebGL（切换/挂载/字体稳定后都重测）
  $effect(() => {
    if (!useWebGL) return;
    measureRects();
    requestAnimationFrame(measureRects);
    [120, 360].forEach((ms) => setTimeout(measureRects, ms));
  });
  // 明亮主页露出后（预载/转场覆盖层已撤）才触发框内 logo 原地浮现——玻璃框带折射全程在、不淡入，
  // 折射不被 opacity 破坏(全程可见)，浮现也发生在主页可见处（不再幕后跑完、0 帧出现）。
  $effect(() => {
    if (ui.booted && ui.glassMode === 'B' && !ui.themeTransition) {
      requestAnimationFrame(() => { ui.revealIcons = true; });
    }
  });
  // 折射「鼓包」：折射/色散从 0 ease-out 拉到预设(quality.ramp 0→1)；SVG 与 WebGL 共用。
  // 抽成函数供两处触发：① 图标首次浮现（下方 effect）② 设置页返回（弹跳 effect 顺带调用，
  // 与图标 scale 弹性同步——折射不再满值瞬现）。拖滑块实时预览走 settingsPreview（不经
  // 这两条路径），ramp 保持 1、折射跟手直出，预览功能不受影响。
  let rampRaf = null;
  // 预热值：ramp 恒为 0 时浏览器把玻璃的 SVG 滤镜 / backdrop 整个优化掉，等图标浮现那一刻
  // 才首次解码 feImage、取 backdrop 快照——手机上是几十毫秒的同步开销，且正好和「整层淡出 +
  // 图标 opacity + 粒子层还在渲染」撞在同一帧（真机录屏实测：那一刻冻结整整 2 帧后突跳，
  // 观感就是图标「生硬地蹦出来」；电脑 GPU 富余所以看不出）。给一个肉眼不可见的极小值让
  // 滤镜链路全程活着，把这笔开销摊到被白幕遮住的预载期间。
  const RAMP_WARM = 0.015;
  function playGlassRamp() {
    if (ui.glassMode !== 'B') return;                  // 暗主题(flux)桌面用 glassBare 固定预设，不鼓包
    if (rampRaf) cancelAnimationFrame(rampRaf);
    quality.ramp = RAMP_WARM;
    let t0 = null;
    const DUR = 720, ease = (x) => 1 - Math.pow(1 - x, 3);
    const tick = (now) => {
      if (t0 == null) t0 = now;
      const p = Math.min(1, (now - t0) / DUR);
      quality.ramp = RAMP_WARM + (1 - RAMP_WARM) * ease(p);
      rampRaf = p < 1 ? requestAnimationFrame(tick) : null;
    };
    rampRaf = requestAnimationFrame(tick);
  }
  $effect(() => {
    if (ui.glassMode !== 'B') return;
    if (!ui.revealIcons) { quality.ramp = RAMP_WARM; return; }   // 未浮现：保持预热（不是 0）
    // 主题换场里不鼓包：换场本身就是过渡，720ms 里逐帧改 4 块玻璃的 SVG 滤镜参数会跟揭幕抢帧
    if (untrack(() => ui.themeTransition)) { quality.ramp = 1; return; }
    playGlassRamp();
    return () => { if (rampRaf) cancelAnimationFrame(rampRaf); rampRaf = null; quality.ramp = 1; };
  });

  // —— 明暗双系统壁纸（设置页·壁纸分区选定，wp.light/wp.dark 槽）——
  // 当前系统（glassMode B=明/A=暗）的槽 → 壁纸定义；动态(flux)走 iframe、静态走 img/WebGL。
  const curWp = $derived(wpDef(wp[ui.glassMode === 'B' ? 'light' : 'dark']));
  // —— 空间壁纸（景深视差）——当前系统槽启用 + 该壁纸有深度图（内置默认 / 上传时附了深度图）时，
  // 用视差 canvas 替代静态 <img>/折射层；玻璃 UI 的 SVG backdrop 照常折射这块 canvas。动态(flux)不参与。
  const homeSlot = $derived(ui.glassMode === 'B' ? 'light' : 'dark');
  const curWpId = $derived(wp[homeSlot]);
  const spatialOn = $derived(!curWp.dyn && spatial[homeSlot].on && wpHasDepth(curWpId));
  const spatialDepth = $derived(spatialOn ? wpDepthUrl(curWpId) : null);
  const spatialAmp = $derived(spatial[homeSlot].amp);
  const useRefraction = $derived(useWebGL && !spatialOn);   // 空间壁纸激活时让位给视差层

  // Figma 玻璃的背景：静态壁纸 = 那张 <img>（按它的实际矩形做 cover 映射）；
  // 空间视差 = 视差层每画完一帧同步分发给各块玻璃（回调里拷走，WebGL 缓冲只在那个任务有效）；
  // 流光 = flux iframe 每画完一帧调 __fluxFrame（同样同一任务内拷走，见 hookFluxFrames）。
  let wpImgEl = $state();
  let spatialRef = $state();
  const liveSubs = new Set();
  function onSpatialDraw(cv) { for (const f of liveSubs) f(cv); }
  const fluxSubs = new Set();
  const figBg = $derived(curWp.dyn
    ? { kind: 'live', subscribe(fn) { fluxSubs.add(fn); return () => fluxSubs.delete(fn); } }
    : spatialOn
    ? { kind: 'live', subscribe(fn) { liveSubs.add(fn); spatialRef?.redraw(); return () => liveSubs.delete(fn); }, request() { spatialRef?.redraw(); } }
    : { kind: 'image', url: curWp.url, box: () => wpImgEl?.getBoundingClientRect() });
  // 右上胶囊（LoginCard）跟着用同一套
  $effect(() => { homeGlass.on = useFigma; homeGlass.bg = figBg; });
  // 静态壁纸切换交叉淡出：旧图盖上层 .55s 淡出（涉及 flux 的切换直接切，flux 自带从黑浮现）
  let fxUrl = $state(null);
  let _prevWpUrl = null;
  $effect(() => {
    const u = curWp.url || null;
    if (_prevWpUrl && u && _prevWpUrl !== u) fxUrl = _prevWpUrl;
    _prevWpUrl = u;
  });

  let wpEl = $state();
  // flux iframe 的挂载闩：开机结束且不在主题换场中才挂；挂上之后换场开始也不许卸（旧快照要拍它），
  // 离开暗主题（curWp 不再是动态壁纸）才放下。
  let fluxOk = $state(false);
  $effect(() => {
    if (!curWp.dyn) { fluxOk = false; return; }
    if (ui.booted && !ui.themeTransition && !ui.morphing) fluxOk = true;   // 开机揭幕 / 换场的快照动画跑完再挂
  });
  // 维护者的「Orange set」预设（Steam 3670899003，深蓝近黑流体）——colormode Poolside +
  // 流体参数，套在依赖引擎(3562672741)上才是要的那个背景。之前漏套预设、错用了引擎默认
  // 的 Original 彩虹色，故现在直接复刻 project.json 的 preset。
  // 壁纸参数取自 fluxParams（设置页个性化栏可调，默认 = 维护者的 Orange set 预设），格式与钳位见
  // state.fluxProps；改了参数下面的 $effect 会实时重套。
  // gridspacing(线条间距) 现为可调固定值：跟 WE 一样【固定颗粒间距】铺满屏幕——大屏线条多、小屏少，
  // 但密度一致。小=密。（之前按画布宽算「列数恒定」是误解，会让高分屏 gridSpacing 反而变大、更稀疏，已撤。）
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
  // 流光上的 Figma 玻璃：main.js 每画完一帧（同一任务内，WebGPU/WebGL 缓冲还有效）调 __fluxFrame，
  // 把 iframe 里的画布连同 iframe 在本页的位置分发给各块玻璃（同桌面 Dock，DesktopHome.hookFluxFrames）。
  // 流体流得慢，拷背景封顶约 30 帧/秒：5 块玻璃每帧各拷一次再合成，手机上省一半 GPU 与电。
  let fluxLast = 0;
  function hookFluxFrames() {
    try {
      const w = wpEl?.contentWindow, c = w?.document.getElementById('canvas');
      if (!c) return;
      w.__fluxFrame = () => {
        if (!fluxSubs.size || !wpEl) return;
        const now = performance.now();
        if (now - fluxLast < 30) return;
        fluxLast = now;
        const box = wpEl.getBoundingClientRect();
        for (const f of fluxSubs) f(c, box);
      };
    } catch {}
  }
  // flux iframe 在预载结束(booted)后才挂载——让流体在主页里「从黑浮现」，开场完整可见，
  // 不在预载/转场覆盖层底下被提前播掉。WASM 初始化较慢，固定延迟可能赶在 listener ready
  // 之前、套不上预设(停在引擎原版彩虹)，故轮询：直到套上 Poolside 预设才停。
  function onWpLoad() {
    hookFluxFrames();
    let tries = 0;
    const iv = setInterval(() => {
      if (tuneWallpaper() || ++tries > 80) {
        clearInterval(iv);
        // 命中后再补打几轮：applyUserProperties「调用成功 ≠ 引擎已消化」——WASM 流体
        // 引擎异步初始化，listener 先于引擎就绪时首次设置会被默认 Original 彩虹预设
        // 冲掉（主页小概率彩虹背景的根因）。补打幂等，无副作用。
        [600, 1800, 4500].forEach((ms) => setTimeout(tuneWallpaper, ms));
      }
    }, 180);
  }
  // 回前台补打一次：iframe 在后台可能被系统回收重建，恢复时预设丢失。
  $effect(() => {
    const f = () => { if (!document.hidden) setTimeout(tuneWallpaper, 300); };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  });
  // 设置页个性化栏调壁纸参数 → 实时套用（读全部字段建依赖；iframe 未就绪时 tuneWallpaper 安全返回 false，
  // 由 onWpLoad 轮询补上）。
  $effect(() => { for (const k in fluxParams) fluxParams[k]; tuneWallpaper(); });

  // 四个入口同一种打开方式：被点的方块长成这一页，主页以它为原点往后退（lib/pageMorph.js）。
  // Gemini 额外带一个共享元素：方块里的十字星单独飞到分页问候语上方那颗星上。
  // 转场进行中不再开第二个（快照层本身也不吃点击，这里只是把门）；关了转场的走引擎里的直切兜底。
  function openEntry(e, ev) {
    if (me.kind === 'none') { ui.loginOpen = true; return; } // 未登录 → 唤起登录
    if (ui.morphing || ui.enterClaude || ui.enterVertex) return;
    const tile = ev?.currentTarget?.querySelector('.tile');
    const hero = e.key === 'vertex' ? ev?.currentTarget?.querySelector('.ico') : null;
    openPage(e.key, { from: tile, radius: 30, hero, heroTo: '.v-land-star' });
  }

  // 主页入口也是落点：从工作空间拎一份文件、另一根手指退回主页，直接丢在 Claude / Gemini 的
  // 方块上＝打开那个分页并挂进它的输入栏（省掉「先进分页再找输入栏」那一步）。
  // ChatGPT（iframe 里的克隆页）与 dimensio（附件契约不同，落法在各自分页里）不接。
  const DROP_TARGET = { claude: 'claude', vertex: 'gemini' };
  function entryDrop(node, e) {
    const optsFor = (en) => {
      const target = DROP_TARGET[en.key];
      return {
        key: 'home:' + en.key, effect: 'send', disabled: !target,
        label: (p) => (p?.count > 1 ? t('把 {n} 项发给 {name}', { n: p.count, name: en.label }) : t('发给 {name}', { name: en.label })),
        accept: (p) => !!target && p?.type === WS_FILE && !!p.materials && me.kind !== 'none',
        drop: async (p) => {
          if (!(await attachToAgent(p, target))) return;
          openEntry(en, { currentTarget: node });
        },
      };
    };
    const zone = dropZone(node, optsFor(e));
    // ENTRIES 是 $derived，重算就会带着新的 entry 对象来 update——必须重新包成落点参数，
    // 直接透传会把 { key:'claude', label:'Claude' } 当成落点定义（key 撞名、没有 accept/drop）。
    return { update: (next) => zone.update(optsFor(next)), destroy: zone.destroy };
  }

  // 设置页返回主页时（ui.homePop bump）：主页入口图标复用预载「鼓包」弹性 scale（同款 overshoot 缓动），
  // 并同步重播折射/色散 0→预设的渐变（playGlassRamp）——之前折射是满值瞬现，与弹性不搭。
  let _lastPop = 0;
  $effect(() => {
    const p = ui.homePop;
    if (p === _lastPop) return;
    _lastPop = p;
    if (p > 0) untrack(() => {
      playGlassRamp();
      // 错峰用 stagger()（总尾巴封顶）而不是 i*固定值：入口数量变化时整体节奏不跑偏，
      // 且最后一个也在 ~500ms 内落定，不拖出一条长尾。
      const tiles = [...(gridEl?.querySelectorAll('.tile') || [])];
      tiles.forEach((tile, i) => {
        tile.animate(
          [{ transform: 'scale(.84)' }, { transform: 'scale(1.04)', offset: .58 }, { transform: 'scale(1)' }],
          { duration: DUR.page, delay: stagger(i, tiles.length, 120, 34), easing: EASE.settle }
        );
      });
    });
  });
</script>

<!-- 入场时主页的退后/压暗在转场快照上做（lib/pageMorph.js），主页本身的 DOM 一动不动 -->
<div class="home" class:dimbg={ui.settingsOpen && !ui.settingsPreview && !ui.wpStage}>
  {#if curWp.dyn}
    {#if fluxOk}
      <!-- 流光(flux)：预载结束(booted)才挂载，让流体在主页里「从黑浮现」开场完整可见，不在预载/转场覆盖层下被提前播掉。
           主题换场（明→暗）期间也先不挂：WASM 初始化压在揭幕动画上会整段掉帧；夜色铺满后再挂，流体照旧从黑浮现 -->
      <iframe class="wp" bind:this={wpEl} src={BASE + 'wallpaper/index.html?v=pow2'} title={t('背景')} scrolling="no" tabindex="-1" onload={onWpLoad}></iframe>
    {/if}
  {:else if spatialOn}
    <!-- 空间壁纸：深度视差 canvas 替代静态图（电脑指针 / 手机重力跟随），玻璃仍折射它 -->
    <SpatialLayer bind:this={spatialRef} imgUrl={curWp.url} depthUrl={spatialDepth} amp={spatialAmp} ondraw={useFigma ? onSpatialDraw : null} />
  {:else if useRefraction}
    <RefractionLayer bgUrl={curWp.url} rects={glassRects} strength={quality.ramp} />
  {:else}
    <!-- 静态壁纸：玻璃用 Figma 玻璃（没 WebGPU 时 SVG 液态玻璃）折射它 -->
    <img class="wp wp-img" bind:this={wpImgEl} src={curWp.url} alt="" draggable="false" />
  {/if}
  {#if fxUrl}
    <!-- 壁纸交叉淡出：旧图盖上层渐隐（设计稿 .55s ease） -->
    <img class="wp wp-img wp-fx" src={fxUrl} alt="" draggable="false" onanimationend={() => (fxUrl = null)} />
  {/if}
  <div class="wp-veil"></div>

  <LoginCard />

  <div class="grid" class:fade={ui.glassMode === 'B'} class:revealed={ui.revealIcons} bind:this={gridEl}>
    {#each ENTRIES as e, i (e.key)}
      <button class="entry" data-entry={e.key} class:dnd-on={drag.overKey === 'home:' + e.key} style:--i={i} use:entryDrop={e} onclick={(ev) => openEntry(e, ev)} aria-label={e.label}>
        <!-- use:pressable —— 按下 90ms 干脆压下、松手弹簧回弹（见 lib/motion.js）。
             此前是 .16s 弹性曲线做【按下】，按下去像踩进棉花，正是"不跟手"的观感来源。 -->
        {#if useFigma}
          <span class="tile fg" use:pressable={{ scale: 0.93 }}>
            <FigmaGlass bg={figBg} radius={30} strength={ui.glassMode === 'B' ? quality.ramp : 1} remeasure={ENTRIES.length} />
            <img class="ico" src={ovUrl(e.img)} alt="" draggable="false" />
          </span>
        {:else if useRefraction}
          <span class="tile" use:pressable={{ scale: 0.93 }}><img class="ico" src={ovUrl(e.img)} alt="" draggable="false" /></span>
        {:else}
          <span class="tile" class:frost={isIOS} use:pressable={{ scale: 0.93 }}
                use:liquidGlass={isIOS ? frostHigh : (ui.glassMode === 'B' ? glassReveal : glassBare)}>
            <img class="lg-content ico" src={ovUrl(e.img)} alt="" draggable="false" />
          </span>
        {/if}
      </button>
    {/each}
  </div>
</div>

<style>
  .home { position: fixed; inset: 0; background: #0a0a0a; overflow: hidden; }  /* 纯黑兜底：flux 未出画面时露此黑，与预载黑屏一致，flux「从黑浮现」无缝、不闪蓝板 */
  /* 设置页静止打开时，禁用主页全部 backdrop-filter（液态玻璃折射 + 登录胶囊）。Chromium 下多个
     backdrop-filter 元素共存会互扰：主页这些玻璃绘制在设置页下层，会破坏设置页那层 backdrop-filter
     的合成，令其 computed 是 blur(22px) 却完全不渲染模糊（桌面/移动端皆然，也是 screenshot 卡死之源）。
     设置页盖住主页、这些玻璃本就不可见，禁用无损；拖滑块预览(settingsPreview)时设置页透明露主页，恢复折射。 */
  .home.dimbg :global(.lg),
  .home.dimbg :global(.card) { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
  /* 壁纸铺满整屏含状态栏区（iOS safe-area）：top:0 + 100dvh，别在刘海/状态栏处留黑边。
     原色（深蓝近黑 Orange set 预设），只叠一层很淡暗角衬托玻璃。 */
  .wp { position: fixed; top: 0; left: 0; width: 100vw; height: 100dvh; border: 0; z-index: 0; pointer-events: none; }
  .wp-img { object-fit: cover; }   /* 静态壁纸 cover 铺满 */
  .wp-fx { z-index: 1; animation: wp-fade .55s ease forwards; }   /* 壁纸切换：旧图盖上层交叉淡出 */
  @keyframes wp-fade { from { opacity: 1; } to { opacity: 0; } }
  .wp-veil { position: fixed; inset: 0; z-index: 1; pointer-events: none;
             background: radial-gradient(125% 95% at 50% 42%, rgba(0,0,0,0) 52%, rgba(0,0,0,.38) 100%); }

  /* 左上品牌字：与预载页末态同位同款，硬接无缝 */
  .brand {
    position: fixed; top: max(16px, var(--sat)); left: 18px; z-index: 10; pointer-events: none;
    display: flex; flex-direction: column; gap: 0;
    color: #fff; font-family: var(--serif-stack); font-weight: 300; font-size: 14px; line-height: 1.16; letter-spacing: .14em;
    text-shadow: 0 1px 8px rgba(0,0,0,.4);
  }

  /* 中央入口：四个时 2×2；普通账号隐藏 ChatGPT 后，第三个自动居中。 */
  .grid {
    position: fixed; left: 0; right: 0; top: 50%; transform: translateY(-50%); z-index: 5;
    display: grid; grid-template-columns: repeat(2, auto); justify-content: center; gap: 26px 22px; padding: 0 24px;
  }
  /* 浮现入场：仅明亮主题(多洛米蒂 B)。玻璃框(.tile)带折射全程在、不淡入；只让框里的 logo(.ico)
     原地纯透明度 0→1 浮现——折射在 .tile 上、不被 opacity 破坏(全程可见)，logo 柔和浮现。轻微 stagger。
     暗主题(flux)logo 直接显示。触发见 Home $effect：明亮主页露出后才浮现，确保可见。 */
  /* 折叠屏展开 / 平板（≥700）：2×2 的方块簇在这么宽的屏上缩成中间一小坨，摊成一行更像
     大屏启动器。奇数个时的「末项跨列居中」规则要一并撤——一行摆得下就不需要它了。 */
  @media (min-width: 700px) {
    .grid { grid-template-columns: repeat(4, auto); gap: 0 30px; }
    .entry:last-child:nth-child(odd) { grid-column: auto; justify-self: auto; }
  }
  .entry { display: flex; flex-direction: column; align-items: center; gap: 11px; }
  .entry:last-child:nth-child(odd) { grid-column: 1 / -1; justify-self: center; }
  .grid.fade .ico {
    opacity: 0;
    transition: opacity var(--mo-base) var(--ea-fade);
    transition-delay: calc(var(--i, 0) * 34ms);   /* 4 个入口 → 尾巴封在 ~100ms 内 */
  }
  .grid.fade.revealed .ico { opacity: 1; }
  /* transform 由 use:pressable 经 --press-s 驱动（按下 CSS 过渡、松手 JS 弹簧），
     故此处不再写 transition——写了会跟弹簧每帧打架，回弹变成一截一截的。 */
  .tile { width: 124px; height: 124px; display: flex; align-items: center; justify-content: center;
          transform: scale(var(--press-s, 1)); }
  /* 拎着文件悬停在入口上：方块微微鼓起 + 描一圈，说明「丢这儿就发给它」 */
  .entry.dnd-on .tile { transform: scale(1.06); transition: transform .14s ease; }
  .entry.dnd-on .ico { filter: drop-shadow(0 0 14px rgba(255, 255, 255, .55)); }
  /* Figma 玻璃：画布垫在方块里（z-index:-1），方块自身定位、自成层叠上下文 */
  .tile.fg { position: relative; isolation: isolate; }
  /* 方案 A 极高透光毛玻璃：玻璃边框 + 高光（blur 由 liquidGlass 注入，很透，流体能透过来） */
  .tile.frost { border-radius: 30px; border: 1px solid rgba(255,255,255,.22);
    box-shadow: inset 0 1px 1px rgba(255,255,255,.32), inset 0 -2px 3px rgba(0,0,0,.12), 0 6px 18px rgba(0,0,0,.18); }
  .ico { width: 62px; height: 62px; object-fit: contain; filter: drop-shadow(0 2px 6px rgba(0,0,0,.35)); }
</style>
