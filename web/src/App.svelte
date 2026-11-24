<script>
  // 顶层路由。启动：加载 caps/auth/恢复活跃会话；预载页作为 booting 覆盖层，
  // 淡出后露出背后已渲染的主页。ui.screen 切换 Home / ClaudePage / 占位分页。
  //
  // 单 agent 模式（lib/state 的 rootScreen：只开了 Claude 或只开了 dimensio，判定见 lib/rootScreen.js）：
  // 没有主页、没有预载演出、没有「THE BRIDGE」标题——打开即是那一页；登录是压在页上的登录框（LoginDialog），
  // 入口是侧栏底部账户行（Claude 页 .d-foot；dimensio 页经 harness 的 sidebarFoot 挂进它的侧栏）。
  // 设置与常规模式同一套（2026-10-21 维护者：只要两套设置外观）：桌面壳 SettingsDesktop，其余 iOS 风 Settings；
  // 外壳自己按 rootScreen 藏掉单页模式下没意义的项（壁纸等）。原先单页模式专用的 claude.ai 风设置
  // （components/settings/Settings 与 Sec*）已下线。开机按上次的登录态快照判模式；auth 回来名单变了
  // （管理员加开 / 关掉 agent）由下面的 effect 随时切过去。
  import { onMount, untrack } from 'svelte';
  import { loadCaps } from './lib/caps.js';
  import { api } from './lib/api.js';
  import { caps, me, ui, prefs, compose, studioInbox, applyMe, agentOn, screenOn, rootScreen, applyFollowSys, hostIsServer } from './lib/state.svelte.js';
  import { openPage } from './lib/pageMorph.js';
  import { busStart, busStop, busOn } from './lib/bus.js';
  import { showToast, setErrorToastAction } from './lib/toast.svelte.js';
  import { handleUiCmd, askClaudeAboutError } from './lib/agentUi.js';
  import { warmThemeWallpapers } from './lib/homeTheme.js';
  import { reportUi } from './lib/uiReport.js';
  import { restoreOnBoot, openSession, newConversation } from './lib/chat.svelte.js';
  import BootGate from './components/BootGate.svelte';
  import { setBootAttr, dropFirstFrame } from './lib/boot/intro.js';
  import Home from './components/Home.svelte';
  import ClaudePage from './components/ClaudePage.svelte';
  import ComingSoon from './components/ComingSoon.svelte';
  import FilesPanel from './components/FilesPanel.svelte';
  import FilesDesktop from './components/FilesDesktop.svelte';
  import { isNativeDesktop, hasNativeWorkspaceOps, pushNativeOverlay } from './lib/nativeDesktop.js';
  import { pointer, layout } from './lib/layout.svelte.js';
  // Gemini / Codex / dimensio 的页面属于功能扩展：一律懒加载（modules/pages.js），基础版主包里没有它们。
  import { loadPage, resolvedPage } from './modules/pages.js';
  import BrandTitle from './components/BrandTitle.svelte';
  import ServerConfig from './components/ServerConfig.svelte';
  import { isOffline, getServerBase, startLanAutoSwitch, onConnModeChange, initRoute, onReachabilityChange, startReachabilityWatch, offlineSince, apiUrl, onServerBaseChange } from './lib/server.js';
  import { syncActiveProfile, canSwitchServers, listProfiles } from './lib/serverProfiles.js';
  import { arrival, finishArrival } from './lib/serverSwitch.js';
  import ServerSwitcher from './components/ServerSwitcher.svelte';
  import { syncDistro } from './lib/distro.js';
  import { cacheMe, getCachedMe } from './lib/cache.js';
  import { rememberCurrent, syncDeviceOwner } from './lib/account.js';   // 本机账号保险箱：启动认到的身份连同令牌收进去，之后能一键切回
  import Settings from './components/Settings.svelte';
  import SettingsDesktop from './desktop/settings/SettingsDesktop.svelte';
  import DesktopHome from './desktop/home/DesktopHome.svelte';
  import ServerAdmin from './components/admin/ServerAdmin.svelte';
  import { hubUi } from './lib/modelHub.svelte.js';
  // 模型中心的浮层（添加 / 服务详情 / 老编辑器）：第一次有浮层要开时才加载，之后常驻——开合与退场动画由它自己按 hubUi.sheet 管
  let HubOverlays = $state(null);
  $effect(() => {
    if (hubUi.sheet && !HubOverlays) import('./components/modelhub/HubOverlays.svelte').then((m) => { HubOverlays = m.default; }).catch((e) => console.error('[model-hub] overlays failed to load:', e));
  });
  import AgentsPage from './components/AgentsPage.svelte';
  import DesktopChrome from './desktop/chrome/DesktopChrome.svelte';
  import MediaViewer from './components/preview/MediaViewer.svelte';
  import DragLayer from './components/DragLayer.svelte';
  import { initNav } from './lib/nav.js';
  import { autoCheckUpdate } from './lib/appUpdate.js';
  import { updateInfo } from './lib/updateStore.svelte.js';   // serverRestart：服务器为重启 / 装更新正在下线（S1-5），离线条据此不报「电脑没应答」
  import { startAddressHeal } from './lib/serverAddress.js';
  import PairScan from './components/PairScan.svelte';
  import { parsePairPayload } from './lib/pair.js';
  import LoginDialog from './components/LoginDialog.svelte';
  import Toast from './components/Toast.svelte';
  import NoticeBanner from './components/NoticeBanner.svelte';
  import { initNotices } from './lib/notices.svelte.js';
  import { registerPluginHostRelay, pluginHostReady, pluginHostIdle } from './lib/pluginHostRelay.js';   // 手机 App 插件页面的宿主中转（授权框 / 选择器 / 跳转）
  import { t } from './lib/i18n.js';
  import { syncPluginUi, pluginUi } from './lib/pluginUi.svelte.js';   // 插件界面扩展（主页卡片、工作台标签、各处菜单、主题变量）
  import { isAppKey, appByKey } from './lib/pluginApps.svelte.js';   // 插件应用：应用键 'app:<插件>:<应用>' 也是 ui.screen 的取值
  import PluginAppPage from './components/apps/PluginAppPage.svelte';
  import { WINDOW_PAGE, isPageWindow, onRouteToPage, pageTitleFor } from './lib/windowPage.svelte.js';

  // —— 单 agent 模式 / 独立分页窗口（?page=<key>）——
  const lockedPage = isPageWindow();
  let pageUnavailable = $state(false);
  const root = $derived(lockedPage ? WINDOW_PAGE : rootScreen());
  const single = $derived(root !== 'home');
  // 开机就落在那一页（组件初始化时同步置，第一帧就不是主页）。以单页模式起步的这次启动永远不放
  // 预载演出——哪怕 auth 回来发现已经不是单页了，也不能在 Claude 页上半路补播一段开机动画。
  const startedSingle = lockedPage || rootScreen() !== 'home';
  if (startedSingle) ui.screen = lockedPage ? WINDOW_PAGE : rootScreen();
  // 单页模式没有开机入场：index.html 的首帧封面（它不知道这次会落在哪一页）当场撤掉，让那一页自己出来
  if (startedSingle) { setBootAttr(null); dropFirstFrame(); }
  // 模式随名单变：进单页模式时人还在主页 → 送到那一页；退出单页模式不动（侧栏会重新长出「主页」）
  $effect(() => {
    const r = root;
    untrack(() => { if (r !== 'home' && ui.screen === 'home') ui.screen = r; });
  });
  // 独立分页窗口：任务栏与 Alt+Tab 标题跟当前分页走
  $effect(() => {
    if (!lockedPage) return;
    const appTitle = isAppKey(WINDOW_PAGE) ? (appByKey(WINDOW_PAGE)?.title || '') : '';
    document.title = pageTitleFor(WINDOW_PAGE, appTitle);
  });
  // 设置页是整窗浮层：桌面壳的原生浏览器视图恒在 DOM 之上，开着时必须让位（关掉后各面板经 onNativeOverlayChange 自行挂回）
  // 模型中心浮层（hubUi.sheet）同理：可以从 dimensio 页的型号菜单直接打开，不经设置页
  // 先归成一个布尔：两者交替开合时 effect 不重跑，免得中途松开一帧让面板把网页挂回来又收走
  const coverNative = $derived(Boolean(ui.settingsOpen || hubUi.sheet));
  $effect(() => { if (coverNative) return pushNativeOverlay(); });
  // 红字报错提示的「问 Claude」：Claude 分页对这个人开着才出按钮（lib/toast.svelte.js）
  $effect(() => { setErrorToastAction((me.kind === 'admin' || me.kind === 'user') && screenOn('claude') ? askClaudeAboutError : null); });
  // 切换服务器重载来的：没有预载接手封面时（单页模式、首屏连接页）启动完由这里收场；预载接手过的这里是空操作
  $effect(() => { if (arrival && ui.booted) finishArrival(); });
  // 单页模式没有主页右上的登录胶囊：启动完还没登录就直接弹登录框
  let loginNudged = false;
  $effect(() => {
    if (!single || !ui.booted || needConfig || loginNudged) return;
    if (me.kind === 'none') { loginNudged = true; ui.loginOpen = true; }
  });

  // 扫码登录的「系统相机」直达：登录二维码里是本站地址 ?pair=<id>.<key>，被系统相机（而非
  // apk 内的扫一扫）扫到会打开这个网页。已登录 → 直接进确认卡；未登录 → 弹一次登录卡，
  // 登录后再确认。参数读完即从地址栏擦掉（钥匙不留在历史/收藏里）。
  let pendingPair = $state(null), pairNudged = false;
  $effect(() => {
    if (!pendingPair || !ui.booted || needConfig) return;
    if (me.kind !== 'none') { ui.pairScan = { mode: 'confirm', ...pendingPair }; pendingPair = null; return; }
    if (!pairNudged) { pairNudged = true; ui.loginOpen = true; }
  });

  // 离线壳（apk）首次启动或地址失效时，先让用户填电脑地址，再加载数据。
  // 在线壳 / dev 下 isOffline() 恒为 false，needConfig 恒 false，行为完全不变。
  let needConfig = $state(isOffline() && !getServerBase());
  // 桌面壳的服务进程桥（新壳才有）：离线条上的「服务控制台」按钮据此显隐。
  const srvProcCtl = typeof window !== 'undefined' ? window.BridgeDesktop?.serverProcess : null;
  // 这次掉线前最后一次连上电脑的时刻（0 = 冷启动就没连上过）：离线条写「从 HH:MM 起」，不一律归因于网络
  let offlineAt = $state(0);
  const offSrv = $derived(hostIsServer());   // 离线条说「服务器」还是「电脑」（部署形态，/api/auth 的 hosting）
  const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // 分页 keep-alive 挂载闩：进过一次就保持挂载（休眠/唤醒切换，见下方 .keep）。boot 完成后错峰
  // 预挂载两个分页（各让一帧再排下一个），首次点入口的转场也全程丝滑——挂载
  // 成本在 idle 期已付清，转场揭幕只翻 display。
  let mountClaude = $state(false), mountStudio = $state(false), mountChatGPT = $state(false), mountAgy = $state(false);
  $effect(() => { if (ui.screen === 'claude' || ui.enterClaude) mountClaude = true; });
  $effect(() => { if (ui.screen === 'studio' || ui.enterStudio) mountStudio = true; });
  $effect(() => { if (ui.screen === 'chatgpt') mountChatGPT = true; });
  $effect(() => { if (ui.screen === 'agy') mountAgy = true; });
  // 工作区协同：上报用户所在页面（agent 的 workspace.view 用）。没登录不报（接口要鉴权）；登录后补报一次。
  $effect(() => { if (me.kind !== 'none') reportUi({ page: ui.screen }); });
  // 地址自愈（S1-1）：登录后学这台服务器的身份 / 公网地址 / 候选地址，地址变了自动跟（见 lib/serverAddress.js）
  $effect(() => { if (me.kind && me.kind !== 'none') untrack(() => startAddressHeal()); });
  // 插件界面扩展：登录 / 换人就重拉 /api/plugins/ui，退出登录清空（连同插件设的主题变量）
  $effect(() => { const k = me.kind && me.kind !== 'none' ? me.kind + ':' + (me.user || '') : ''; untrack(() => syncPluginUi(k)); });
  // dimensio 同步底板色（对齐 @hx/lib/theme.ts 的纸 #F4F1EA / 夜 #131210）：首次点开分块尚未返回时，
  // 外层 .hx-stage 同帧落入 DOM 参与 openPage 卡片展开，避免第 0 帧无根盒直切。
  const hxStageBg = $derived((prefs.followSys && typeof matchMedia === 'function'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : ui.theme) === 'light' ? '#F4F1EA' : '#131210');

  $effect(() => {
    if (!ui.booted || needConfig || lockedPage) return;
    // 预挂载只挂这个身份开着的分页（没开的 agent 连挂载成本都不付）；独立分页窗只挂自己，不预挂载其他分页。
    const t1 = setTimeout(() => { if (screenOn('claude')) mountClaude = true; }, 1600);
    const t2 = setTimeout(() => { if (screenOn('studio')) mountStudio = true; }, 3400);
    // 其余已开放扩展只预热脚本分块（不挂 DOM、不打接口），首次点击即同步就位；
    // 仅在服务端已下发 me.agents 后拉取，基础版绝不请求不存在的 chunk。
    const t3 = setTimeout(() => {
      if (!untrack(() => Array.isArray(me.agents))) return;
      if (screenOn('harness')) loadPage.harness().catch(() => {});
      if (screenOn('agy')) loadPage.agy().catch(() => {});
      if (screenOn('chatgpt')) loadPage.chatgpt().catch(() => {});
    }, 2400);
    warmThemeWallpapers();   // 另一套主题的壁纸空闲时先解码：第一次点 THE BRIDGE 也不用等图
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  });

  // agent 名单变了（管理员在设置「Agent」页开关、或在控制台改了这个人的授权）：服务端经总线推
  // agents.changed / me.changed，这里现拉 /api/auth 刷新。正开着的分页若刚被关掉，提示一句退回主页。
  async function refreshMe() {
    try { const a = await api.auth(); applyMe(a); cacheMe(a); rememberCurrent(); }
    catch (e) { if (e?.status === 401 && e?.body && typeof e.body === 'object') applyMe(e.body); }
  }
  $effect(() => {
    if (!ui.booted || needConfig || me.kind === 'none') return;
    busStart();
    initNotices();   // 会话消息通知（横幅 / 系统通知 / 铃声震动），只挂一次
    untrack(pluginHostReady);   // 登录 + 总线就绪：取冷启动时原生记下的插件页面请求，处理排着的（只读写模块内变量，不进依赖）
    // ui.cmd：agent 经接口让用户的界面换页 / 打开会话 / 预览文件 / 弹提示（lib/agentUi.js）
    const off = busOn((ev) => {
      if (ev.type === 'agents.changed' || ev.type === 'me.changed' || ev.type === 'plugins.changed' || ev.type === 'plugins.market') refreshMe();
      else if (ev.type === 'ui.cmd') handleUiCmd(ev);
    });
    return () => { off(); busStop(); pluginHostIdle(); };
  });
  $effect(() => {
    const s = ui.screen;
    // 2026-11-04 Gemini 分页下线：旧代码路径 / 旧客户端还可能把人送到 'vertex'（或 'gemini'）。
    // 没有任何 agent 再认领这个页名，screenOn 会放行、落进 ComingSoon——这里改送 Media Studio（没开就回根页）。
    if (s === 'vertex' || s === 'gemini') {
      untrack(() => { ui.screen = screenOn('studio') ? 'studio' : rootScreen(); });
      return;
    }
    if (!ui.booted || s === 'home' || s === 'files') return;
    if (screenOn(s)) { if (lockedPage && pageUnavailable) pageUnavailable = false; return; }
    untrack(() => {
      showToast(t('这个分页已被管理员关闭'), 'err');
      if (lockedPage) { pageUnavailable = true; return; }
      ui.screen = rootScreen();
    });
  });

  // —— 插件应用分页——
  // 保活最近用过的两个：切走只休眠，切回来插件页的状态还在；第三个进来时最久没用的卸掉
  // （每个都是一整个 iframe 页面，常驻太多吃内存）。
  // 挂载列表 appKeep 和「谁最近用过」appRecent 必须分开存：appKeep 就是下面带键 {#each} 的渲染顺序，
  // 只许往末尾追加、淘汰时只删不重排——顺序一变，Svelte 就用 before() 把某个 .keep 挪位置，
  // iframe 一离开文档浏览上下文就被丢掉、整页重载（两个应用来回切时每次都有一个丢状态）。
  // appRecent 不参与渲染，用普通数组（最近的在前），不进响应式，免得 effect / derived 被它带着重跑。
  const APP_KEEP_MAX = 2;
  let appKeep = $state([]);
  let appRecent = [];
  // 纯函数：s 已挂着就原样返回（同一个数组，不触发重排）；没挂着就按 appRecent 删掉最久没用的，再把 s 追加到末尾
  function keepWith(keep, s) {
    if (keep.includes(s)) return keep;
    const rank = (k) => { const i = appRecent.indexOf(k); return i < 0 ? Infinity : i; };
    let next = keep;
    while (next.length >= APP_KEEP_MAX) {
      const victim = next.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      next = next.filter((k) => k !== victim);
    }
    return [...next, s];
  }
  // 只读 ui.screen；appKeep 只在 untrack 里读写、且只在真变了时写，免得 effect 自己触发自己
  $effect(() => {
    const s = ui.screen;
    if (!isAppKey(s)) return;
    untrack(() => {
      const next = keepWith(appKeep, s);
      if (next !== appKeep) appKeep = next;
      appRecent = [s, ...appRecent.filter((k) => k !== s && next.includes(k))];
    });
  });
  // 渲染用：当前屏是应用键就立刻算进来（不等上面的 effect 下一拍），pageMorph 的 afterUpdate 在同一拍里就量得到分页根盒。
  // 和 effect 用同一个 keepWith、同一份 appRecent（effect 还没跑，appRecent 仍是进来前的），两边算出的顺序一致，不会来回挪节点。
  const appMounted = $derived(isAppKey(ui.screen) ? keepWith(appKeep, ui.screen) : appKeep);
  // 撤销守卫：应用被关掉 / 插件被停用 / 换了看不到它的身份——还停在它的分页上就送回根页，并从保活里剔掉。
  // 要分清「还没加载」（pluginUi.loaded 为假：冷启动、刚换身份，先别动）和「真的没有」。
  // 只跟踪 ui.screen 和 pluginUi（apps 一变就重跑）；appKeep 只在 untrack 里读写、且先比较——不读写同一份被跟踪的 state。
  $effect(() => {
    const s = ui.screen;
    if (!pluginUi.loaded) return;
    const here = isAppKey(s) && !appByKey(s);
    void pluginUi.apps;
    untrack(() => {
      const keep = appKeep.filter((k) => appByKey(k));   // filter 只删不重排，留下的节点不会被挪
      if (keep.length !== appKeep.length) appKeep = keep;
      appRecent = appRecent.filter((k) => keep.includes(k));
      if (!here) { if (lockedPage && isAppKey(s) && pageUnavailable) pageUnavailable = false; return; }
      // 普通提示，不用 'err'：这是告知（插件停用 / 应用撤了），没有能拿去「问 Claude」诊断的报错
      showToast(t('这个应用已经不可用了'));
      if (lockedPage) { pageUnavailable = true; return; }
      ui.screen = rootScreen();
    });
  });

  // 桌面 Dock / 命令面板仍用旧契约「置 ui.enterClaude / enterStudio + 起点 rect」要一次入场：
  // 这里接住，交给统一的转场引擎（入口长成分页），跑完把旗子放下。手机四宫格直接调 openPage。
  // 同一次微任务里执行：旧快照要到下一帧才拍，旗子引起的 DOM 变化（Dock 图标 handoff 隐藏）
  // 先被 enterBar=null 撤回，不会拍进去。
  $effect(() => {
    const key = ui.enterClaude ? 'claude' : ui.enterStudio ? 'studio' : null;
    if (!key) return;
    untrack(() => {
      const from = ui.enterOrigin || null;
      const radius = ui.enterBar ? 12 : 30;
      ui.enterBar = null;
      openPage(key, { from, radius }).finally(() => { ui.enterClaude = false; ui.enterStudio = false; });
    });
  });

  onMount(async () => {
    initNav();   // 垫 history 哨兵：系统侧滑逐级返回而非直接退 app
    registerPluginHostRelay();   // 尽早挂 window.__bridgePluginHost：原生 onResume 派发时接得住，没登录就先收着
    try {
      const u = new URL(location.href);
      const pp = u.searchParams.get('pair');
      if (pp) {
        u.searchParams.delete('pair');
        history.replaceState(history.state, '', u.pathname + u.search + u.hash);
        pendingPair = parsePairPayload('?pair=' + pp);
      }
    } catch {}
    // 键盘高度兜底（--kb）：viewport meta 的 interactive-widget=resizes-content 生效时
    // innerHeight 随键盘收缩、--kb 恒 0（不双垫）；某些 WebView/ROM 不缩 layout viewport
    // 时，visualViewport 仍如实变小——差值垫到分页滑动层底部，钉底输入条不被键盘盖住。
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const updKb = () => {
        const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
        document.documentElement.style.setProperty('--kb', kb + 'px');
      };
      vv.addEventListener('resize', updKb);
      vv.addEventListener('scroll', updKb);
      updKb();
    }
    // 单页模式 / 独立分页窗口没有预载演出来置 booted：auth 有结果（或确定要先配服务器地址）就算启动完
    const bootSingle = () => {
      if (ui.booted || !(startedSingle || rootScreen() !== 'home')) return;
      if (lockedPage || rootScreen() !== 'home') applyFollowSys();
      ui.booted = true;
    };
    if (needConfig) { bootSingle(); return; }
    // 局域网自动直连（仅离线 apk 壳生效）：学习 PC 的 LAN 地址并探活，在家自动走
    // 局域网、出门请求失败自动回隧道。设置页显示当前线路。
    onConnModeChange((m) => { ui.connMode = m; });
    // 离线态由可达性状态机【双向】维护（断网亮、恢复自动灭）。必须在 auth 之前订阅：
    // boot 那次 auth 若因断网失败，正是经这条链路把 ui.offline 置起来的。
    onReachabilityChange((down, why) => { ui.offline = down; ui.offlineWhy = why || ''; offlineAt = down ? offlineSince() : 0; });
    startReachabilityWatch();
    // 先用已知 LAN 解析路由（在家免隧道；隧道换域名/挂了也不掉线），再开后台学习/周期重探。
    try { await initRoute(); } catch {}
    // 离线 apk：取所连服务器的发行版声明（品牌 / 默认语言）缓存起来，跟这次启动用的不一样就刷新一次（见 lib/distro.js）
    syncDistro(apiUrl('/api/app/caps'));
    startLanAutoSwitch(() => api.get('/api/lan'));
    try { caps.data = await loadCaps(); caps.loaded = true; } catch {}
    try {
      const a = await api.auth(); applyMe(a);   // 同步写快照 → 下次进 app 启动瞬间即登录态，不闪
      cacheMe(a);   // 缓存登录态（整份，含 agents / hosting），供离线进 app 看历史聊天
      rememberCurrent();
      syncDeviceOwner();   // 桌面客户端：这台电脑的设备登记跟着此刻的账号走（多账号切换后 cookie 可能还是另一个号）
    }
    catch (e) {
      // 没登录（401）也要拿到服务器形态与开着的 agent 名单（回包体里有），单 agent 的服务器据此直接落页。
      if (e?.status === 401 && e?.body && typeof e.body === 'object') applyMe(e.body);
      if (isOffline() && e?.status == null) {     // 连不上 PC（无 HTTP 状态=网络层失败）
        // 从没配过 PC 地址 → 仍需配置；已配过、只是 PC 离线 → 用缓存登录态进 app 看本地缓存聊天。
        const cm = getServerBase() ? await getCachedMe() : null;
        // ui.offline 此刻已由可达性状态机置起（auth 的网络失败经 noteServerUnreachable
        // 走的同一条链路），这里只负责套用缓存登录态；恢复由状态机自动灭灯。
        if (cm) { applyMe(cm); }
        else { needConfig = true; bootSingle(); return; }
      }
    }
    // 手机 App 多服务器档案：把这台连着的服务器（地址、登录、品牌）记进档案；服务器自己换了地址时跟着记
    syncActiveProfile();
    onServerBaseChange(() => syncActiveProfile());
    bootSingle();
    // 恢复消息流：有在跑的轮 → 先补历史再接直播；否则自动加载上次会话（含杀后台
    // 期间完成的结果）。离线时自动回落本地缓存。
    try { await restoreOnBoot(); } catch {}
    autoCheckUpdate();   // apk 壳：发现新版即后台静默下载（fire-and-forget，不阻塞 boot）
    // 桌面壳：点了「跑完了 / 在等你回答」的系统通知 → 直接跳到那一轮。
    // 手机/网页没有 window.BridgeDesktop，这里恒不挂载，行为完全不变。
    try {
      window.BridgeDesktop?.agent?.onOpenSession?.(({ func, sessionId } = {}) => {
        if (func === 'codex') { if ((!lockedPage || WINDOW_PAGE === 'chatgpt') && screenOn('chatgpt')) ui.screen = 'chatgpt'; return; }
        // Antigravity：新壳带 func:'agy'；老壳把它的通知当 Claude 的报过来（只认会话 id）——openNoticeTarget 自己认回是哪一页
        if (func === 'agy') {
          if (lockedPage && WINDOW_PAGE !== 'agy') return;
          if (sessionId) import('./lib/notices.svelte.js').then((m) => m.openNoticeTarget(sessionId, '', 'agy')).catch(() => {});
          else if (screenOn('agy')) ui.screen = 'agy';
          return;
        }
        if (lockedPage && WINDOW_PAGE !== 'claude') return;
        if (sessionId) {
          ui.taskDone = false;
          import('./lib/notices.svelte.js').then((m) => m.openNoticeTarget(sessionId, '')).catch(() => {});
          return;
        }
        if (!screenOn('claude')) return;
        ui.screen = 'claude';
        ui.taskDone = false;
      });
    } catch {}
    // 桌面壳：跨窗口投递动作（从独立工作空间发给 Claude / Media Studio，或在独立窗口点其它分页的通知横幅）
    try {
      onRouteToPage(async (ev = {}) => {
        const act = String(ev.action || '');
        if (act === 'open-session') {
          const ag = String(ev.func || '');
          const want = ag === 'agy' ? 'agy' : ag === 'codex' ? 'chatgpt' : 'claude';
          if (lockedPage && WINDOW_PAGE !== want) return;
          if (ev.sessionId) {
            const m = await import('./lib/notices.svelte.js');
            await m.openNoticeTarget(String(ev.sessionId), '', ag);
          } else if (screenOn(want)) {
            ui.screen = want;
          }
        } else if (act === 'open-routines') {
          if (lockedPage && WINDOW_PAGE !== 'claude') return;
          if (!screenOn('claude')) return;
          ui.screen = 'claude';
          ui.routinesOpen = true;
        } else if (act === 'studio-inbox' && ev.item) {
          if (lockedPage && WINDOW_PAGE !== 'studio') return;
          if (!screenOn('studio')) return;
          studioInbox.items.push(ev.item);
          ui.screen = 'studio';
        } else if (act === 'claude-attach' && ev.attachment) {
          if (lockedPage && WINDOW_PAGE !== 'claude') return;
          if (!screenOn('claude')) return;
          ui.screen = 'claude';
          if (ev.sessionId === 'new') newConversation();
          else if (ev.sessionId && ev.sessionId !== '__keep__') await openSession(String(ev.sessionId)).catch(() => {});
          compose.attachments.push(ev.attachment);
        } else if (act === 'agy-attach' && ev.attachment) {
          if (lockedPage && WINDOW_PAGE !== 'agy') return;
          if (!screenOn('agy')) return;
          ui.screen = 'agy';
          const { ensureModule } = await import('./modules/services.svelte.js');
          const mod = await ensureModule('agy');
          const tg = mod?.agyFileTarget;
          if (tg) {
            if (ev.sessionId === 'new') tg.newChat?.();
            else if (ev.sessionId && ev.sessionId !== '__keep__') await tg.load?.(String(ev.sessionId));
            tg.attach?.(ev.attachment);
          }
        } else if (act === 'claude-prefill' && ev.text) {
          if (lockedPage && WINDOW_PAGE !== 'claude') return;
          if (!screenOn('claude')) return;
          ui.screen = 'claude';
          ui.taskDone = false;
          const handled = !window.dispatchEvent(new CustomEvent('bridge:newchat', { cancelable: true }));
          if (!handled) newConversation();
          const { prefillComposer } = await import('./lib/composerBridge.svelte.js');
          setTimeout(() => prefillComposer(String(ev.text)), 80);
        } else if (act === 'open-page' && ev.page && !lockedPage) {
          const target = String(ev.page);
          if (target === 'files' || screenOn(target)) ui.screen = target;
        }
      });
    } catch {}
    // 桌面壳：需要前端配合的全局快捷键动作（纯窗口层面的由主进程自己做完了）。
    try {
      window.BridgeDesktop?.shortcuts?.onAction?.(({ action } = {}) => {
        if (action !== 'new-session' || !screenOn('claude')) return;
        if (lockedPage && WINDOW_PAGE !== 'claude') return;
        ui.screen = 'claude';
        ui.taskDone = false;
        // Claude 页挂着就交给它（和侧栏「新对话」同一套落点规则）；还没挂上时照旧开在默认工作空间
        const handled = !window.dispatchEvent(new CustomEvent('bridge:newchat', { cancelable: true }));
        if (!handled) newConversation();
      });
    } catch {}
  });

  // 开机首帧（index.html 的暖墨底 + 标记）：入场演出自己会撤；没有演出的启动（单页模式、先配服务器）在这里撤
  $effect(() => { if (ui.booted && !ui.bootStage) { setBootAttr(null); dropFirstFrame(); } });

  // 回到 claude 页（且 app 在前台）= 用户看到了结果 → 清掉主页小人的「举旗」未读态。
  $effect(() => { if (ui.screen === 'claude' && !document.hidden) ui.taskDone = false; });
  function onVisible() { if (!document.hidden && ui.screen === 'claude') ui.taskDone = false; }

  // 手机系统状态栏（顶部那条"黑边"）的背景由 <meta theme-color> 控制（Android Chrome / PWA 据此着色）。
  // 让它跟随当前页面：claude 分页用其主题底色(--bg：明=浅/暗=深)，主页用深色兜底，不再固定深色顶出黑边。
  $effect(() => {
    ui.screen; ui.theme; ui.glassMode;   // 依赖：页面/主题切换就重算
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const agyBg = ui.screen === 'agy' ? (ui.theme === 'light' ? '#edf1f8' : '#06080f') : '';
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      meta.content = ui.screen === 'home' ? '#0a0a0a' : (agyBg || bg || '#1f1f1e');
    }
    // apk edge-to-edge：系统栏图标明暗跟随主题（主页恒深底→白图标；亮主题 claude 页→深图标）。
    try {
      if (window.AndroidStore && window.AndroidStore.setLightSystemBars) {
        window.AndroidStore.setLightSystemBars(ui.screen !== 'home' && ui.theme === 'light');
      }
    } catch {}
  });
</script>

<svelte:document onvisibilitychange={onVisible} />

<!-- 桌面壳窗口 chrome：拖拽条必须【最先绘制】——Chromium 按绘制顺序对 app-region
     做并集/挖洞序列运算，条若晚于分页绘制会把按钮的 no-drag 洞整条盖回去
     （症状=顶栏按钮全点不动）。DOM 提前 + z-index 低，两种序都保证洞后算。 -->
<DesktopChrome />

<!-- 主页全程挂载、其他分页时 display:none：
     ① 性能——display:none 让主页那几个 backdrop-filter 折射层退出合成（否则连纯静态的分页都被拖累，帧率元凶）；
     ② 视觉正确性——液态玻璃的 SVG 滤镜（feImage 位移贴图）只能靠「保持挂载」复用已解码贴图。
        此前 files/antigravity 分支会卸载 Home，返回时重挂重建滤镜，真机上 feImage 解码赶不上
        backdrop 合成 → 折射断层撕裂且不自愈（claude/vertex 走 display 切换路径就没事）。
     侧滑返回（claudeSliding/studioSliding）时提前唤醒，露出底层主页。 -->
{#if !single}
  <div style:display={ui.screen !== 'home' && !ui.claudeSliding && !ui.studioSliding && !ui.homeWarm ? 'none' : 'contents'}>
    <!-- 桌面壳走沉浸启动器（批4：Dock + Ctrl+K），手机/网页仍是四宫格 Home -->
    {#if isNativeDesktop()}<DesktopHome />{:else}<Home />{/if}
  </div>
{/if}
<!-- claude / chatgpt / studio 分页 keep-alive：首次进入才挂载，之后【休眠】保留——
     聊天滚动位置/输入草稿随 DOM 一起保住。
     【2026-09-26】休眠从 display:none 改成 content-visibility:hidden + visibility:hidden + inert
     （app.css 的 .keep.dormant）：display:none 会把整页的样式与布局扔掉，每次进页都要重算——
     实测 4 倍降速（≈手机）下 Claude 页首次显示 185ms、Gemini 85ms，正好卡在转场第一帧前，
     就是「点完先愣一下」；content-visibility:hidden 保留渲染状态，重新显示 ≈1ms。不绘制、
     不命中、不可聚焦（inert），backdrop-filter 层同样退出合成。
     主页仍用 display:none：flux 流体 iframe 在 display:none 下才会被浏览器节流，省电优先。 -->
{#if mountClaude && screenOn('claude')}
  <div class="keep" class:dormant={ui.screen !== 'claude'} inert={ui.screen !== 'claude'}><ClaudePage /></div>
{/if}
{#if (mountChatGPT || ui.screen === 'chatgpt') && screenOn('chatgpt')}
  <div class="keep" class:dormant={ui.screen !== 'chatgpt'} inert={ui.screen !== 'chatgpt'}>
    {#if resolvedPage.chatgpt}{@const Page = resolvedPage.chatgpt.default}<Page />{:else}{#await loadPage.chatgpt() then m}<m.default />{/await}{/if}
  </div>
{/if}
{#if (mountAgy || ui.screen === 'agy') && screenOn('agy')}
  <div class="keep" class:dormant={ui.screen !== 'agy'} inert={ui.screen !== 'agy'}>
    {#if resolvedPage.agy}{@const Page = resolvedPage.agy.default}<Page />{:else}{#await loadPage.agy() then m}<m.default />{/await}{/if}
  </div>
{/if}
{#if (mountStudio || ui.screen === 'studio') && screenOn('studio')}
  <div class="keep" class:dormant={ui.screen !== 'studio'} inert={ui.screen !== 'studio'}>
    {#if resolvedPage.studio}{@const Page = resolvedPage.studio.default}<Page />{:else}{#await loadPage.studio() then m}<m.default />{/await}{/if}
  </div>
{/if}
<!-- 插件应用分页：最近用过的两个保活，同上面的 .keep / dormant / inert -->
{#each appMounted as k (k)}
  <div class="keep" class:dormant={ui.screen !== k} inert={ui.screen !== k}><PluginAppPage appKey={k} /></div>
{/each}
{#if ui.screen === 'files'}
  <!-- 电脑版工作空间 FilesDesktop：Explorer 级信息密度 + 右键/键盘/拖拽。桌面壳（Electron）恒走它；
       网页上「精确指针（鼠标 / 触控板）且窗口够宽（≥1024）」也走它（云端通道，判据同工作台侧栏 WorkspaceEmbed：
       宽 + 指针精度缺一不可——折叠屏展开、平板宽度够但仍是手指）；安卓 / 手机 / 触屏仍走手机版 FilesPanel。
       dev `?fdmock=panel` 强制走 FilesPanel（它在桌面壳里同样带 desktopNative 跑：
       Claude 工作台的「文件」工具、Codex 侧边工作区都是这条路），prod 里整个条件被
       import.meta.env.DEV 消掉。 -->
  {#if import.meta.env.DEV && typeof window !== 'undefined' && window.__FD_MOCK_EMBED}
    <!-- dev `?fdmock=embed&w=420`：模拟 Claude 工作台右列（含顶栏胶囊占位）里的内嵌工作空间 -->
    {@const mockW = Number(new URLSearchParams(location.search).get('w')) || 420}
    <!-- &ws=D:\Projects\media：模拟会话工作目录在库外（按绝对路径落进 D:\ 那个位置；哪个位置都不含就走临时位置） -->
    {@const mockWs = new URLSearchParams(location.search).get('ws') || ''}
    <div style="position:fixed;inset:0;display:flex;background:var(--bg)">
      <div style="flex:1"></div>
      <aside style="position:relative;flex:none;width:{mockW}px;border-left:1px solid var(--divider);overflow:hidden;transform:translateZ(0)">
        {#if new URLSearchParams(location.search).has('panel')}
          <!-- &panel&ws=…：手机形态侧栏按库外会话目录挂载（起点落进最深的电脑位置） -->
          <FilesPanel onExit={() => {}} previewHost="dock" workspaceRoot={mockWs} />
        {:else}
          <FilesDesktop embedded workspaceRoot={mockWs} home={mockWs} onExit={() => {}} />
        {/if}
      </aside>
      <div style="position:absolute;right:10px;top:10px;width:92px;height:44px;border-radius:22px;background:rgba(32,32,30,.42);backdrop-filter:blur(18px) saturate(1.5);pointer-events:none"></div>
    </div>
  {:else if ((isNativeDesktop() && hasNativeWorkspaceOps()) || (pointer.fine && layout.w >= 1024)) && !(import.meta.env.DEV && typeof window !== 'undefined' && window.__FD_MOCK_PANEL)}
    <FilesDesktop />
  {:else}
    <!-- 位置（工作空间 / 主目录 / 各盘符）由 FilesPanel 自己管：顶栏位置胶囊 -->
    <FilesPanel />
  {/if}
{:else if ui.screen === 'harness' || ui.screen === 'antigravity'}
  <!-- 无权者即便靠陈旧的 screen 状态/深链走到这，也不渲染整页（否则页内每个请求 403，
       变成一屏「加载失败」）。真闸在服务端 /api/harness。 -->
  {#if screenOn('harness')}
    <div class="hx-stage" style:background={hxStageBg}>
      {#if resolvedPage.harness}{@const Page = resolvedPage.harness.default}<Page />{:else}{#await loadPage.harness() then m}<m.default />{/await}{/if}
    </div>
  {:else}
    <ComingSoon name="dimensio" />
  {/if}
{:else if ui.screen !== 'home' && ui.screen !== 'claude' && ui.screen !== 'chatgpt' && ui.screen !== 'agy' && ui.screen !== 'studio' && !isAppKey(ui.screen)}
  <ComingSoon name={ui.screen} />
{/if}

{#if !single}
  {#if !ui.booted && !startedSingle}
    <BootGate onDone={() => { ui.booted = true; }} />
  {/if}

  <!-- 持久品牌标题（全程唯一）：固定在主页左上，开机时等门出画才落位 -->
  <BrandTitle />
{:else if !needConfig}
  <!-- 单页模式的登录：没登录时压在那一页上（启动自动打开 / 退出后 / 账户菜单「登录」） -->
  <LoginDialog />
{/if}

{#if lockedPage && pageUnavailable}
  <div class="page-gone" role="status">
    <p>{t('这个分页已不可用')}</p>
    <button type="button" onclick={() => window.close()}>{t('关闭窗口')}</button>
  </div>
{/if}

<!-- 离线模式提示条：连不上 PC、正浏览本地缓存时显示（pointer-events:none 不挡交互）。
     桌面壳里多一颗按钮：这台电脑就是主机，"连不上"往往是服务停了——控制台走 IPC 不走
     bridge，是此刻唯一还能把服务拉起来的入口。 -->
{#if ui.offline}
  <div class="offline-banner">
    <!-- 原因见 lib/server.js offlineWhy()：断网 / 临时地址换了（Cloudflare 回 530）/ 电脑那头没应答 / 说不清。
         -manual：这台设备回家连 Wi-Fi 也不会自己找回来（网页、桌面页、没有局域网候选的 App），只能去电脑上看新地址。
         offSrv：服务端跑在服务器上（/api/auth 的 hosting，lib/deployFlags.js serverHosted），「电脑」换成「服务器」、不说睡眠和客户端 -->
    {#if ui.offlineWhy === 'network'}{t('离线 · 这台设备没有网络；可浏览本地缓存，联网后自动重连')}
    {:else if updateInfo.serverRestart?.phase === 'going'}{updateInfo.serverRestart.reason === 'update' ? t('服务器正在更新，一两分钟后自动重连') : t('服务器正在重启，几秒后自动重连')}
    {:else if ui.offlineWhy === 'address'}{offSrv ? t('连不上 · 服务器的临时地址可能已经变了：回家连上同一个 Wi-Fi 会自动更新，或到服务器上查看新地址') : t('连不上 · 服务器的临时地址可能已经变了：回家连上同一个 Wi-Fi 会自动更新，或在电脑上查看新地址')}
    {:else if ui.offlineWhy === 'address-manual'}{offSrv ? t('连不上 · 服务器的临时地址可能已经变了：到服务器上查看新地址，用新地址重新打开，或在设置里填新地址') : t('连不上 · 服务器的临时地址可能已经变了：到电脑上查看新地址，用新地址重新打开，或在设置里填新地址')}
    {:else if ui.offlineWhy === 'computer' && offlineAt}{offSrv ? t('离线 · 服务器从 {time} 起没有应答：可能在重启、关机或出了故障；恢复后自动重连', { time: hhmm(offlineAt) }) : t('离线 · 电脑从 {time} 起没有应答：可能睡眠、关机或退出了客户端；恢复后自动重连', { time: hhmm(offlineAt) })}
    {:else if ui.offlineWhy === 'computer'}{offSrv ? t('离线 · 服务器那头没应答：可能在重启、关机或出了故障；恢复后自动重连') : t('离线 · 电脑那头没应答：可能睡眠、关机或退出了客户端；恢复后自动重连')}
    {:else if ui.offlineWhy === 'unreachable-temp'}{offSrv ? t('离线 · 连不上服务器：网络不通，或服务器的临时地址变了；可浏览本地缓存，恢复后自动重连') : t('离线 · 连不上电脑：网络不通，或服务器的临时地址变了；可浏览本地缓存，恢复后自动重连')}
    {:else if ui.offlineWhy === 'unreachable-temp-manual'}{offSrv ? t('离线 · 连不上服务器：网络不通，或服务器的临时地址变了（变了要到服务器上查看新地址）；可浏览本地缓存') : t('离线 · 连不上电脑：网络不通，或服务器的临时地址变了（变了要到电脑上查看新地址）；可浏览本地缓存')}
    {:else if offlineAt}{offSrv ? t('离线 · {time} 起连不上服务器：可能在重启、关机或出了故障，也可能是网络不通；可浏览本地缓存，恢复后自动重连', { time: hhmm(offlineAt) }) : t('离线 · {time} 起连不上电脑：可能睡眠、关机或退出了客户端，也可能是网络不通；可浏览本地缓存，恢复后自动重连', { time: hhmm(offlineAt) })}
    {:else}{offSrv ? t('离线 · 连不上服务器；可浏览本地缓存，恢复网络后自动重连') : t('离线 · 连不上电脑；可浏览本地缓存，恢复网络后自动重连')}{/if}
    {#if srvProcCtl}
      <button class="ob-btn" onclick={() => srvProcCtl.open()}>{t('服务控制台')}</button>
    {/if}
    {#if canSwitchServers() && listProfiles().filter((p) => !p.pending).length > 1}
      <button class="ob-btn" onclick={() => { ui.serverSwitcherOpen = true; }}>{t('切换服务器')}</button>
    {/if}
  </div>
{/if}

<!-- 离线 apk：未配置/连不上电脑时的全屏「连接电脑」层（盖住一切；在线壳永不出现） -->
{#if needConfig}<ServerConfig />{/if}

<!-- 设置页：桌面壳走双栏逻辑板（批3 重构），手机/网页是 iOS 风 sheet。单页模式也是这两套
     （入口在侧栏账户卡；直达分区走 lib/settingsNav，两套外壳各自认全部分区名） -->
{#if ui.settingsOpen}
  {#if isNativeDesktop()}<SettingsDesktop />{:else}<Settings />{/if}
{/if}

<!-- 服务端控制台（桌面服务端形态，设置页右上角进入；磨砂借下层设置页的罩） -->
{#if ui.serverAdminOpen}<ServerAdmin />{/if}

<!-- 模型中心的浮层：首页在 设置 › 模型中心；添加 / 服务详情 / 老编辑器是全局浮层（设置页、dimensio 的「模型服务」都经 lib/modelHub 唤起） -->
{#if HubOverlays}<HubOverlays />{/if}

<!-- 手机端「扫一扫」登录网页版：全屏取景/确认卡（账户卡入口，或系统相机扫到 ?pair= 直达） -->
{#if ui.pairScan}<PairScan />{/if}

<!-- 切换服务器面板（手机 App 多服务器档案）：主页标题胶囊 / 长按标题 / 设置「关于」/ 离线提示条 / 首屏都能打开 -->
{#if ui.serverSwitcherOpen}<ServerSwitcher />{/if}

<!-- 设置「Agent」页（admin：各 agent 开关 / 能否运行 / 认证；同样盖在设置页之上） -->
{#if ui.agentsOpen}<AgentsPage />{/if}

<!-- 轻量 toast（lib/toast.svelte.js）：全程常驻，底部居中一条，不拦点击 -->
<Toast />

<!-- 会话消息通知的前台横幅（lib/notices.svelte.js）：别的会话在问你 / 跑完了 / 出错了，从顶部滑下一张卡 -->
<NoticeBanner />

<!-- 统一沉浸式文件查看器（全程常驻，preview.open 时全屏接管；Media Studio 与工作空间共用） -->
<MediaViewer />

<!-- 全域拖拽的那一份「跟手卡片」：必须挂在这里（App 根、任何 transform 容器之外），
     它的 fixed 才恒以视口为准——拖着走过工作空间/工作台侧栏/Claude 会话页都不换坐标系。 -->
<DragLayer />

<style>
  .offline-banner {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    padding: calc(var(--sat) + 3px) 10px 4px;
    background: rgba(24,24,27,.92); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    color: #e8c07a; font-size: 12.5px; text-align: center; pointer-events: none;
  }
  /* 条本身不吃点击（免得挡住下面的界面），只有这颗按钮收回指针事件。 */
  .ob-btn {
    pointer-events: auto; margin-left: 10px; padding: 2px 10px; border-radius: 999px;
    border: 1px solid rgba(232,192,122,.5); background: rgba(232,192,122,.12);
    color: #f0d8a8; font: inherit; font-size: 12px; cursor: pointer;
  }
  .ob-btn:hover { background: rgba(232,192,122,.22); }
  .hx-stage { position: fixed; inset: 0; z-index: 30; }
  .page-gone { position: fixed; inset: 0; z-index: 95; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; }
  .page-gone p { margin: 0; color: var(--muted); }
  .page-gone button { padding: 7px 18px; border-radius: 999px; border: 1px solid var(--divider); background: transparent;
    color: var(--text); font: inherit; cursor: pointer; }
  .page-gone button:hover { background: var(--hover); }
</style>
