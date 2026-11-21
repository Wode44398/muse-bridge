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
  import { homeView, builtinHomeIcon, builtinIconFit } from '../lib/homeLayout.svelte.js';   // 主页入口 = 内置 + 插件应用，排序 / 隐藏只存本机
  import { openApp, appIconUrl } from '../lib/pluginApps.svelte.js';
  import HomeMoreSheet from './apps/HomeMoreSheet.svelte';
  import HomeEntryMenu, { homeEntryMenuItems } from './apps/HomeEntryMenu.svelte';
  import { drag, dropZone } from '../lib/dragdrop.svelte.js';
  import { WS_FILE, attachToAgent, filesToStudio } from '../lib/fileDrag.js';
  import LoginCard from './LoginCard.svelte';
  import RefractionLayer from './RefractionLayer.svelte';
  import SpatialLayer from './SpatialLayer.svelte';
  import FigmaGlass from './FigmaGlass.svelte';
  import { homeGlass } from '../lib/figmaHomeGlass.svelte.js';
  import { t } from '../lib/i18n.js';
  // Claude 入口的小人（原版资源，web/src/visuals/）由 lib/homeLayout 的 builtinHomeIcon 给；其余入口图标是自有素材
  import PluginHomeCards from './PluginHomeCards.svelte';   // 插件的主页卡片（ctx.ui.homeCard）：贴在底部的一排玻璃卡
  import { pluginUi, uiIcon } from '../lib/pluginUi.svelte.js';

  const BASE = import.meta.env.BASE_URL;

  // —— 入口：lib/homeLayout 的 homeView().shown（内置入口按 screenOn 过滤 + 插件应用，用户排的顺序、去掉隐藏的；
  // 超过 8 个时第 8 格换成「更多」）。只有内置入口、没有应用时，排法和图标与没装插件时一样（无文字）。
  // claude 入口小人是状态指示器：正面站立 = 默认；举旗 = 有任务完成还没看（ui.taskDone，回 claude 页清除）。
  // 主页切到其它分页时由 App.svelte 用 display:none 隐藏而不卸载：分页内切明暗（尤其暗→明）若在隐藏态立刻
  // 切换壁纸与玻璃鼓包，会把纹理重建与 720ms 逐帧 rAF 压进分页的 ViewTransition。锁定已渲染槽位直到主页露面或预热。
  const homeVisible = $derived(ui.screen === 'home' || ui.homeWarm || ui.claudeSliding || ui.studioSliding);
  const wantSlot = $derived(ui.glassMode === 'B' ? 'light' : 'dark');
  let renderedSlot = $state(ui.glassMode === 'B' ? 'light' : 'dark');
  $effect(() => {
    if (!homeVisible) return;
    const s = wantSlot;
    untrack(() => { if (renderedSlot !== s) renderedSlot = s; });
  });

  const view = $derived(homeView());
  const shown = $derived(view.shown);
  const lightIcons = $derived(renderedSlot === 'light');   // 明亮主页用深色图标（素材按「图标本身的颜色」命名）
  function iconOf(e) {
    if (e.kind === 'app') {
      const url = appIconUrl(e.app, lightIcons);
      return url ? { img: url } : { svg: uiIcon(e.app?.icon?.name) };
    }
    return { img: builtinHomeIcon(e.key, { light: lightIcons, taskDone: ui.taskDone }) };
  }
  // 内置图标逐枚光学校正过（大小与位置，见 lib/homeLayout 的 builtinIconFit）；插件应用的图标用默认大小、居中
  const fitOf = (e) => (e.kind === 'builtin' ? builtinIconFit(e.key, { taskDone: ui.taskDone }) : {});
  const labelOf = (e) => (e.kind === 'more' ? t('更多') : e.label);
  const badgeOf = (e) => (e.kind === 'app' ? String(e.app?.badge || '') : e.kind === 'more' ? e.badge || '' : '');
  // 「更多」里收着的键（空格分隔）：pageMorph 关页时找不到入口方块就收回「更多」那一格
  const moreKeys = $derived(view.overflow.map((e) => e.key).join(' '));

  // 宽屏（≥ 700）：不超过 5 个时摆成一行（列数 = 个数，方块按屏宽收，尺寸在 CSS 里算），更多时 4 列折行。
  // 窄屏：有插件应用且超过 4 格时密排成 4 列小方块（同手机桌面），方块按视口夹紧、圆角跟着尺寸走；
  // 只有内置入口时维持两列（恰好三个时一行，见 .grid.trio）——内置入口的排法不因插件功能而变。
  // 文字标签：密排或有插件应用时在方块下写名字（光看图标认不出是哪个插件）；只有内置入口时不写。
  let vw = $state(typeof innerWidth === 'number' ? innerWidth : 390);
  const hasApps = $derived(shown.some((e) => e.kind !== 'builtin'));
  const dense = $derived(vw < 700 && shown.length > 4 && hasApps);
  const trio = $derived(shown.length === 3);
  const cols = $derived(shown.length <= 5 ? Math.max(1, shown.length) : 4);
  const labels = $derived(dense || shown.some((e) => e.kind === 'app'));
  const tileSize = $derived(dense ? Math.max(52, Math.min(74, Math.floor((vw - 32 - 42) / 4))) : 124);
  const tileR = $derived(dense ? Math.round(tileSize * 0.27) : 30);
  // FigmaGlass 每块自己量方块：格数 / 顺序 / 密排 / 列数 / 屏宽（宽屏与三个一行时方块随屏宽变）/ 上移，任何一样变了都要重量
  const glassSig = $derived(shown.map((e) => e.key).join(',') + '|' + (dense ? tileSize : 0) + '|' + cols + '|' + vw + '|' + (lift ? 1 : 0));

  // 玻璃折射参数全部由全局画质驱动（设置页 4 档 + 3 滑块）；改 quality 即所有 tile 实时变。
  const glassBare = $derived(bareGlass(tileR));   // 与右上登录胶囊共用材质内核（state.bareGlass）
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
  const frostHigh = $derived({ blur: 9, saturate: 1.25, tint: 0.05, radius: tileR });    // 退路：极高透光毛玻璃
  let glassRects = $state([]);
  let gridEl = $state();
  // 底部有插件卡片时入口整体上移一截，别和卡片叠在一起（矮屏照样放得下）；挪完重新量玻璃位置
  const lift = $derived(me.kind !== 'none' && pluginUi.homeCards.length > 0);
  $effect(() => { glassSig; if (useWebGL) requestAnimationFrame(measureRects); });
  function measureRects() {
    if (!gridEl) return;
    glassRects = [...gridEl.querySelectorAll('.tile')].map((tile) => {
      const r = tile.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, r: Number(tile.dataset.r) || 30 };
    });
  }
  onMount(() => {
    const onR = () => { vw = innerWidth; measureRects(); };
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
    if (homeVisible && ui.booted && renderedSlot === 'light' && !ui.themeTransition) {
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
    if (renderedSlot !== 'light') return;               // 暗主题(flux)桌面用 glassBare 固定预设，不鼓包
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
    if (!homeVisible || renderedSlot !== 'light') return;
    if (!ui.revealIcons) { quality.ramp = RAMP_WARM; return; }   // 未浮现：保持预热（不是 0）
    // 主题换场或收回主页预热里不鼓包：720ms 逐帧改玻璃参数会跟转场抢帧
    if (untrack(() => ui.themeTransition || ui.homeWarm)) { quality.ramp = 1; return; }
    playGlassRamp();
    return () => { if (rampRaf) cancelAnimationFrame(rampRaf); rampRaf = null; quality.ramp = 1; };
  });

  // —— 明暗双系统壁纸（设置页·壁纸分区选定，wp.light/wp.dark 槽）——
  // 当前已渲染槽位（renderedSlot）的壁纸定义；动态(flux)走 iframe、静态走 img/WebGL。
  const homeSlot = $derived(renderedSlot);
  const curWpId = $derived(wp[homeSlot]);
  const curWp = $derived(wpDef(curWpId));
  // —— 空间壁纸（景深视差）——当前系统槽启用 + 该壁纸有深度图（内置默认 / 上传时附了深度图）时，
  // 用视差 canvas 替代静态 <img>/折射层；玻璃 UI 的 SVG backdrop 照常折射这块 canvas。动态(flux)不参与。
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
        if (!fluxSubs.size || !wpEl || !wpShown) return;
        const now = performance.now();
        if (now - fluxLast < 30) return;
        fluxLast = now;
        const box = wpEl.getBoundingClientRect();
        for (const f of fluxSubs) f(c, box);
      };
    } catch {}
  }
  // 主页被别的分页盖住（整页 display:none，不卸载）时流光照样按原生分辨率每帧解算：降到 1fps、
  // 也不再把帧分给玻璃（玻璃自己也会停，见 FigmaGlass）；露面当场恢复全速。
  // 走 main.js 自带的 applyGeneralProperties({fps})，同桌面 DesktopHome.throttleWallpaper（setPaused 有叠帧循环的坑）。
  let wpShown = true;
  function throttleFlux() {
    try { wpEl?.contentWindow?.wallpaperPropertyListener?.applyGeneralProperties?.({ fps: wpShown ? Infinity : 1 }); } catch {}
  }
  $effect(() => {
    if (!wpEl) return;
    const io = new IntersectionObserver((es) => {
      const v = es[es.length - 1]?.isIntersecting ?? true;
      if (v === wpShown) return;
      wpShown = v;
      throttleFlux();
    });
    io.observe(wpEl);
    return () => { io.disconnect(); wpShown = true; };
  });
  // flux iframe 在预载结束(booted)后才挂载——让流体在主页里「从黑浮现」，开场完整可见，
  // 不在预载/转场覆盖层底下被提前播掉。WASM 初始化较慢，固定延迟可能赶在 listener ready
  // 之前、套不上预设(停在引擎原版彩虹)，故轮询：直到套上 Poolside 预设才停。
  function onWpLoad() {
    hookFluxFrames();
    let tries = 0;
    const iv = setInterval(() => {
      if (tuneWallpaper() || ++tries > 80) {
        clearInterval(iv);
        throttleFlux();   // iframe 重载＝全新帧循环、帧间隔归零：挂上时主页已被盖住就当场降下来
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

  // 所有入口同一种打开方式：被点的方块长成这一页，主页以它为原点往后退（lib/pageMorph.js）。
  // 内置走 openPage，插件应用走 openApp（手机 App 里它交给原生干净页），「更多」弹出收着的那些。
  // 转场进行中不再开第二个（快照层本身也不吃点击，这里只是把门）；关了转场的走引擎里的直切兜底。
  let moreOpen = $state(false);
  // 方块的 click：先吞掉长按出菜单后补发的那下（只认指针点的；键盘 Enter / 空格合成的 click detail 为 0，照常打开）
  function onEntryClick(e, ev) {
    if (ev.detail !== 0 && consumeLongPress()) return;
    openEntry(e, ev);
  }
  // 真正打开：落点丢文件、「更多」里挑一项这类程序化调用直接走这里，不做长按判断——
  // 否则上一次长按留下的吞点击标记会把它们白白吞掉（文件已挂进输入栏、分页却没开）。
  function openEntry(e, ev) {
    if (me.kind === 'none') { ui.loginOpen = true; return; } // 未登录 → 唤起登录
    if (ui.morphing || ui.enterClaude || ui.enterStudio) return;
    const tile = ev?.currentTarget?.querySelector?.('.tile') || ev?.from || null;
    const radius = ev?.radius ?? tileR;
    if (e.kind === 'more') { moreOpen = true; return; }
    if (e.kind === 'app') { openApp(e.app || e.key, { from: tile, radius }); return; }
    openPage(e.key, { from: tile, radius });
  }
  function pickMore(e, rect, radius) {
    moreOpen = false;
    openEntry(e, { from: rect, radius });
  }

  // —— 长按（触屏）/ 右键（鼠标）入口弹菜单：从主页隐藏；插件应用再多一项「插件详情」（只有能进扩展设置的人看得到）——
  // 照设置页壁纸卡的长按：450ms、手指挪开 9px 作废、轻震一下；出了菜单就吞掉随后那下 click，长按不会顺带打开。
  let entryMenu = $state(null);   // { x, y, title, items }
  let pressT = 0, pressXY = null, suppressClick = false;
  function pressDown(ev, e) {
    suppressClick = false;                                   // 新的一次按压：上一次长按留下的吞点击作废
    if (e.kind === 'more' || ev.pointerType === 'mouse' || ev.button > 0) return;
    clearTimeout(pressT);
    pressXY = { x: ev.clientX, y: ev.clientY };
    pressT = setTimeout(() => {
      pressT = 0;
      // 只有菜单真弹出来才吞随后那下 click（没登录 / 转场中不弹菜单，那下点击照常走 openEntry 的判断）
      if (!showEntryMenu(e, pressXY.x, pressXY.y)) return;
      suppressClick = true;
      // 第一次触屏就是长按时页面还没有「用户激活」（要等手指抬起），这时调 vibrate 会被浏览器拦下并在控制台记一条错误
      if (navigator.userActivation?.hasBeenActive !== false) { try { navigator.vibrate?.(8); } catch {} }
    }, 450);
  }
  function pressMove(ev) {
    if (!pressT || !pressXY) return;
    if (Math.hypot(ev.clientX - pressXY.x, ev.clientY - pressXY.y) > 9) { clearTimeout(pressT); pressT = 0; }
  }
  function pressUp() { if (pressT) { clearTimeout(pressT); pressT = 0; } }
  function onEntryCtx(ev, e) {
    ev.preventDefault();
    if (e.kind === 'more' || entryMenu) return;              // 手指长按时浏览器自己也补一发 contextmenu：菜单已经开了
    const touch = !!pressT;
    pressUp();
    if (showEntryMenu(e, ev.clientX, ev.clientY) && touch) suppressClick = true;
  }
  function consumeLongPress() { if (suppressClick) { suppressClick = false; return true; } return false; }
  // 菜单关了，吞点击标记就作废：长按抬手补发的 click 多半被 MorphMenu 当场挡上的压暗层接住、落不到方块上
  // （安卓长按后干脆不补 click），标记没人消费；留着会吞掉之后不经 pointerdown 的那次键盘打开。
  function closeEntryMenu() { entryMenu = null; suppressClick = false; }
  function showEntryMenu(e, x, y) {
    if (me.kind === 'none' || ui.morphing) return false;
    // 菜单项（从主页隐藏 / 插件详情）与桌面 Dock 共用 HomeEntryMenu 里的同一份
    const items = homeEntryMenuItems(e);
    if (!items.length) return false;
    entryMenu = { x, y, title: e.label, items };
    return true;
  }

  // 主页入口也是落点：从工作空间拎一份文件、另一根手指退回主页，直接丢在 Claude / Media Studio 的
  // 方块上＝打开那个分页并挂进它的输入栏（省掉「先进分页再找输入栏」那一步）。Studio 按文件类型挑创作页。
  // ChatGPT（iframe 里的克隆页）与 dimensio（附件契约不同，落法在各自分页里）不接。
  // 应用格和「更多」格不接（disabled）。
  const DROP_TARGET = { claude: 'claude', agy: 'agy', studio: 'studio' };
  function entryDrop(node, e) {
    const optsFor = (en) => {
      const target = en.kind === 'builtin' ? DROP_TARGET[en.key] : null;
      return {
        key: 'home:' + en.key, effect: 'send', disabled: !target,
        label: (p) => (p?.count > 1 ? t('把 {n} 项发给 {name}', { n: p.count, name: en.label }) : t('发给 {name}', { name: en.label })),
        accept: (p) => !!target && p?.type === WS_FILE && !!p.materials && me.kind !== 'none',
        drop: async (p) => {
          const ok = target === 'studio' ? await filesToStudio(p) : await attachToAgent(p, target);
          if (!ok) return;
          openEntry(en, { currentTarget: node });
        },
      };
    };
    const zone = dropZone(node, optsFor(e));
    // shown 是 $derived，重算就会带着新的 entry 对象来 update——必须重新包成落点参数，
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
      <iframe class="wp" bind:this={wpEl} src={BASE + 'wallpaper/drift.html?v=6'} title={t('背景')} scrolling="no" tabindex="-1" onload={onWpLoad}></iframe>
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

  <div class="grid" class:fade={renderedSlot === 'light'} class:revealed={ui.revealIcons} class:lift class:dense class:trio class:labels
       class:rows={!dense && shown.length > 5} class:light={lightIcons} style:--cols={cols}
       style:--ts={dense ? tileSize + 'px' : null} style:--tr={dense ? tileR + 'px' : null} bind:this={gridEl}>
    {#each shown as e, i (e.key)}
      {@const ic = e.kind === 'more' ? null : iconOf(e)}
      {@const badge = badgeOf(e)}
      {@const fit = fitOf(e)}
      <button class="entry" class:more={e.kind === 'more'} data-entry={e.kind === 'more' ? undefined : e.key} data-more={e.kind === 'more' ? moreKeys : undefined}
        class:dnd-on={drag.overKey === 'home:' + e.key} style:--i={i} use:entryDrop={e}
        style:--k={fit.k ?? null} style:--dx={fit.x ?? null} style:--dy={fit.y ?? null}
        onclick={(ev) => onEntryClick(e, ev)} oncontextmenu={(ev) => onEntryCtx(ev, e)}
        onpointerdown={(ev) => pressDown(ev, e)} onpointermove={pressMove} onpointerup={pressUp} onpointercancel={pressUp}
        aria-label={badge ? t('{name}（{badge}）', { name: labelOf(e), badge }) : labelOf(e)}
        aria-haspopup={e.kind === 'more' ? 'dialog' : undefined}>
        <!-- use:pressable —— 按下 90ms 干脆压下、松手弹簧回弹（见 lib/motion.js）。
             此前是 .16s 弹性曲线做【按下】，按下去像踩进棉花，正是"不跟手"的观感来源。
             .tw 包住方块与角标：角标不跟着按压缩放，也不被玻璃盖住 -->
        <span class="tw">
          {#if useFigma}
            <span class="tile fg" data-r={tileR} use:pressable={{ scale: 0.93 }}>
              <FigmaGlass bg={figBg} radius={tileR} strength={renderedSlot === 'light' ? quality.ramp : 1} remeasure={glassSig} />
              {@render glyph(e, ic, '')}
            </span>
          {:else if useRefraction}
            <span class="tile" data-r={tileR} use:pressable={{ scale: 0.93 }}>{@render glyph(e, ic, '')}</span>
          {:else}
            <span class="tile" class:frost={isIOS} data-r={tileR} use:pressable={{ scale: 0.93 }}
                  use:liquidGlass={isIOS ? frostHigh : (renderedSlot === 'light' ? glassReveal : glassBare)}>
              {@render glyph(e, ic, 'lg-content')}
            </span>
          {/if}
          {#if badge}<span class="badge" aria-hidden="true">{badge}</span>{/if}
        </span>
        {#if labels}<span class="lbl" aria-hidden="true">{labelOf(e)}</span>{/if}
      </button>
    {/each}
  </div>

  {#snippet glyph(e, ic, cls)}
    {#if e.kind === 'more'}
      <!-- 「更多」：3×3 点阵 -->
      <span class="{cls} ico svg" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg></span>
    {:else if ic.img}
      <img class="{cls} ico" src={ic.img} alt="" draggable="false" />
    {:else}
      <span class="{cls} ico svg" aria-hidden="true">{@html ic.svg}</span>
    {/if}
  {/snippet}

  <!-- 长按 / 右键菜单、「更多」：挂在 .home（整屏不透明底）直属层级，玻璃采得到底下的主页 -->
  <HomeEntryMenu open={!!entryMenu} point={entryMenu} title={entryMenu?.title || ''} items={entryMenu?.items || []}
    dark={ui.theme !== 'light'} onclose={closeEntryMenu} />
  {#if moreOpen}
    <HomeMoreSheet items={view.overflow} onpick={pickMore} onclose={() => (moreOpen = false)} />
  {/if}

  <PluginHomeCards />
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

  /* 中央入口：四个时 2×2（宽屏一行）；三个时一律一行（见下方 .trio）。 */
  .grid {
    position: fixed; left: 0; right: 0; top: 50%; transform: translateY(-50%); z-index: 5;
    display: grid; grid-template-columns: repeat(2, auto); justify-content: center; gap: 22px; padding: 0 24px;   /* 行距同列距：方块簇四边等距才成一块 */
  }
  .grid.lift { top: calc(50% - min(110px, 13vh)); }
  /* 浮现入场：仅明亮主题(多洛米蒂 B)。玻璃框(.tile)带折射全程在、不淡入；只让框里的 logo(.ico)
     原地纯透明度 0→1 浮现——折射在 .tile 上、不被 opacity 破坏(全程可见)，logo 柔和浮现。轻微 stagger。
     暗主题(flux)logo 直接显示。触发见 Home $effect：明亮主页露出后才浮现，确保可见。 */
  /* 折叠屏展开 / 平板（≥700）：2×2 的方块簇在这么宽的屏上缩成中间一小坨，摊成一行更像
     大屏启动器。奇数个时的「末项跨列居中」规则要一并撤——一行摆得下就不需要它了。 */
  /* 注意顺序：基础规则必须写在媒体查询【前面】——同优先级后写的赢，之前写反了，宽屏上
     「末项跨列」撤不掉，三个图标时第三个被挤到第二行、还因空着第四列而偏心。 */
  .entry { display: flex; flex-direction: column; align-items: center; gap: 11px;
           -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; }
  .entry:last-child:nth-child(odd) { grid-column: 1 / -1; justify-self: center; }
  @media (min-width: 700px) {
    .grid {
      grid-template-columns: repeat(var(--cols, 4), auto);
      gap: 0 clamp(18px, 2.4vw, 30px);
      --ts: min(124px, calc((100vw - 48px - (var(--cols, 4) - 1) * 24px) / var(--cols, 4)));
    }
    .entry:last-child:nth-child(odd) { grid-column: auto; justify-self: auto; }
    .grid.rows { row-gap: 30px; }   /* 超过 5 个折成两行 */
  }
  /* 恰好三个：任何宽度都摆成一行（2+1 金字塔在手机上像少了一块）。窄屏摆不下 3×124 时
     方块按屏宽等比缩小，logo 跟着缩，间距也收一点。方块尺寸统一走 --ts（密排由脚本写进行内样式）。 */
  .grid.trio { grid-template-columns: repeat(3, auto); gap: 0 var(--trio-gap); padding: 0 20px;
               --trio-gap: clamp(14px, 4vw, 30px);
               --ts: min(124px, calc((100vw - 40px - 2 * var(--trio-gap)) / 3)); }
  .grid.trio .entry:last-child:nth-child(odd) { grid-column: auto; justify-self: auto; }
  /* 密排（窄屏超过 4 个）：4 列小方块，最后一行靠左（同手机桌面），不再末项居中 */
  .grid.dense { grid-template-columns: repeat(4, auto); gap: 16px 14px; padding: 0 16px; }
  .grid.dense .entry:last-child:nth-child(odd) { grid-column: auto; justify-self: auto; }
  .grid.labels .entry { gap: 7px; }
  .grid.labels:not(.dense) { row-gap: 22px; }
  @media (min-width: 700px) { .grid.labels.rows { row-gap: 26px; } }
  .tw { position: relative; display: block; }
  /* 文字标签：12px 白字带一层淡阴影，一行省略；宽度对齐方块，略微探进两侧间距 */
  .lbl { box-sizing: border-box; width: calc(var(--ts, 124px) + 12px); margin: 0 -6px; padding: 0 2px; text-align: center;
         color: #fff; font-size: 12px; line-height: 15px; font-weight: 500; letter-spacing: .01em;
         text-shadow: 0 1px 3px rgba(0, 0, 0, .38); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* 角标：功能性的小红圆，压在方块右上角外沿；不随按压缩放，层级高于玻璃 */
  .badge { position: absolute; z-index: 2; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 6px; box-sizing: border-box;
           border-radius: 10px; background: #ff3b30; color: #fff; font-size: 12px; line-height: 20px; font-weight: 600; text-align: center;
           font-variant-numeric: tabular-nums; box-shadow: 0 1px 3px rgba(0, 0, 0, .22); pointer-events: none; }
  .grid.dense .badge { top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; font-size: 11px; line-height: 18px; }
  .grid.fade .ico, .grid.fade .lbl, .grid.fade .badge {
    opacity: 0;
    transition: opacity var(--mo-base) var(--ea-fade);
    transition-delay: calc(var(--i, 0) * 34ms);   /* 4 个入口 → 尾巴封在 ~100ms 内 */
  }
  .grid.fade.revealed .ico, .grid.fade.revealed .lbl, .grid.fade.revealed .badge { opacity: 1; }
  /* transform 由 use:pressable 经 --press-s 驱动（按下 CSS 过渡、松手 JS 弹簧），
     故此处不再写 transition——写了会跟弹簧每帧打架，回弹变成一截一截的。 */
  .tile { width: var(--ts, 124px); height: var(--ts, 124px); display: flex; align-items: center; justify-content: center;
          transform: scale(var(--press-s, 1)); }
  /* 拎着文件悬停在入口上：方块微微鼓起 + 描一圈，说明「丢这儿就发给它」 */
  .entry.dnd-on .tile { transform: scale(1.06); transition: transform .14s ease; }
  .entry.dnd-on .ico { filter: drop-shadow(0 0 14px rgba(255, 255, 255, .55)); }
  /* Figma 玻璃：画布垫在方块里（z-index:-1），方块自身定位、自成层叠上下文 */
  .tile.fg { position: relative; isolation: isolate; }
  /* 方案 A 极高透光毛玻璃：玻璃边框 + 高光（blur 由 liquidGlass 注入，很透，流体能透过来） */
  .tile.frost { border-radius: var(--tr, 30px); border: 1px solid rgba(255,255,255,.22);
    box-shadow: inset 0 1px 1px rgba(255,255,255,.32), inset 0 -2px 3px rgba(0,0,0,.12), 0 6px 18px rgba(0,0,0,.18); }
  /* 大小与位置逐枚给（--k / --dx / --dy，见 lib/homeLayout 的 builtinIconFit；没给的用方块一半、居中）。
     位移用独立的 translate 属性：transform 留给转场的浮现动画（pageMorph bloom 写 transform: scale），两者叠加、互不覆盖。 */
  .ico { width: calc(var(--ts, 124px) * var(--k, .5)); height: calc(var(--ts, 124px) * var(--k, .5)); flex: none; object-fit: contain;
         translate: calc(var(--ts, 124px) * var(--dx, 0)) calc(var(--ts, 124px) * var(--dy, 0));
         filter: drop-shadow(0 2px 6px rgba(0,0,0,.35)); }
  .grid.dense .ico { width: calc(var(--ts) * var(--k, .54)); height: calc(var(--ts) * var(--k, .54)); }
  /* 线稿图标（插件内置图标名、「更多」点阵）：画在图标框正中，明亮主页用深色 */
  .ico.svg { display: grid; place-items: center; color: #fff; }
  .grid.light .ico.svg { color: rgba(29, 27, 24, .86); filter: drop-shadow(0 1px 3px rgba(255, 255, 255, .25)); }
  .ico.svg :global(svg) { width: 62%; height: 62%; }
  .entry.more .ico.svg :global(svg) { width: 44%; height: 44%; }
</style>
