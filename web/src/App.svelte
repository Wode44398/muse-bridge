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
  import { caps, me, ui, applyMe, agentOn, screenOn, rootScreen, applyFollowSys, hostIsServer } from './lib/state.svelte.js';
  import { openPage } from './lib/pageMorph.js';
  import { busStart, busStop, busOn } from './lib/bus.js';
  import { showToast, setErrorToastAction } from './lib/toast.svelte.js';
  import { handleUiCmd, askClaudeAboutError } from './lib/agentUi.js';
  import { warmThemeWallpapers } from './lib/homeTheme.js';
  import { reportUi } from './lib/uiReport.js';
  import { restoreOnBoot, openSession, newConversation } from './lib/chat.svelte.js';
  import Preload from './components/Preload.svelte';
  import Home from './components/Home.svelte';
  import ClaudePage from './components/ClaudePage.svelte';
  import ComingSoon from './components/ComingSoon.svelte';
  import FilesPanel from './components/FilesPanel.svelte';
  import FilesDesktop from './components/FilesDesktop.svelte';
  import { isNativeDesktop, hasNativeWorkspaceOps } from './lib/nativeDesktop.js';
  // Gemini / Codex / dimensio 的页面属于功能扩展：一律懒加载（modules/pages.js），基础版主包里没有它们。
  import { loadPage } from './modules/pages.js';
  import BrandTitle from './components/BrandTitle.svelte';
  import ServerConfig from './components/ServerConfig.svelte';
  import { isOffline, getServerBase, startLanAutoSwitch, onConnModeChange, initRoute, onReachabilityChange, startReachabilityWatch, offlineSince } from './lib/server.js';
  import { cacheMe, getCachedMe } from './lib/cache.js';
  import Settings from './components/Settings.svelte';
  import SettingsDesktop from './desktop/settings/SettingsDesktop.svelte';
  import DesktopHome from './desktop/home/DesktopHome.svelte';
  import ServerAdmin from './components/admin/ServerAdmin.svelte';
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
  import { t } from './lib/i18n.js';

  // —— 单 agent 模式 ——
  const root = $derived(rootScreen());
  const single = $derived(root !== 'home');
  // 开机就落在那一页（组件初始化时同步置，第一帧就不是主页）。以单页模式起步的这次启动永远不放
  // 预载演出——哪怕 auth 回来发现已经不是单页了，也不能在 Claude 页上半路补播一段开机动画。
  const startedSingle = rootScreen() !== 'home';
  if (startedSingle) ui.screen = rootScreen();
  // 模式随名单变：进单页模式时人还在主页 → 送到那一页；退出单页模式不动（侧栏会重新长出「主页」）
  $effect(() => {
    const r = root;
    untrack(() => { if (r !== 'home' && ui.screen === 'home') ui.screen = r; });
  });
  // 红字报错提示的「问 Claude」：Claude 分页对这个人开着才出按钮（lib/toast.svelte.js）
  $effect(() => { setErrorToastAction((me.kind === 'admin' || me.kind === 'user') && screenOn('claude') ? askClaudeAboutError : null); });
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
  let mountClaude = $state(false), mountVertex = $state(false), mountChatGPT = $state(false);
  $effect(() => { if (ui.screen === 'claude' || ui.enterClaude) mountClaude = true; });
  $effect(() => { if (ui.screen === 'vertex' || ui.enterVertex) mountVertex = true; });
  $effect(() => { if (ui.screen === 'chatgpt') mountChatGPT = true; });
  // 工作区协同：上报用户所在页面（agent 的 workspace.view 用）。没登录不报（接口要鉴权）；登录后补报一次。
  $effect(() => { if (me.kind !== 'none') reportUi({ page: ui.screen }); });
  // 地址自愈（S1-1）：登录后学这台服务器的身份 / 公网地址 / 候选地址，地址变了自动跟（见 lib/serverAddress.js）
  $effect(() => { if (me.kind && me.kind !== 'none') untrack(() => startAddressHeal()); });
  $effect(() => {
    if (!ui.booted || needConfig) return;
    // 预挂载只挂这个身份开着的分页（没开的 agent 连挂载成本都不付）。
    const t1 = setTimeout(() => { if (screenOn('claude')) mountClaude = true; }, 1600);
    const t2 = setTimeout(() => { if (screenOn('vertex')) mountVertex = true; }, 3400);
    warmThemeWallpapers();   // 另一套主题的壁纸空闲时先解码：第一次点 THE BRIDGE 也不用等图
    return () => { clearTimeout(t1); clearTimeout(t2); };
  });

  // agent 名单变了（管理员在设置「Agent」页开关、或在控制台改了这个人的授权）：服务端经总线推
  // agents.changed / me.changed，这里现拉 /api/auth 刷新。正开着的分页若刚被关掉，提示一句退回主页。
  async function refreshMe() {
    try { const a = await api.auth(); applyMe(a); cacheMe(a); }
    catch (e) { if (e?.status === 401 && e?.body && typeof e.body === 'object') applyMe(e.body); }
  }
  $effect(() => {
    if (!ui.booted || needConfig || me.kind === 'none') return;
    busStart();
    // ui.cmd：agent 经接口让用户的界面换页 / 打开会话 / 预览文件 / 弹提示（lib/agentUi.js）
    const off = busOn((ev) => {
      if (ev.type === 'agents.changed' || ev.type === 'me.changed' || ev.type === 'plugins.changed' || ev.type === 'plugins.market') refreshMe();
      else if (ev.type === 'ui.cmd') handleUiCmd(ev);
    });
    return () => { off(); busStop(); };
  });
  $effect(() => {
    const s = ui.screen;
    if (!ui.booted || s === 'home' || s === 'files') return;
    if (screenOn(s)) return;
    untrack(() => {
      showToast(t('这个分页已被管理员关闭'), 'err');
      ui.screen = rootScreen();
    });
  });

  // 桌面 Dock / 命令面板仍用旧契约「置 ui.enterClaude / enterVertex + 起点 rect」要一次入场：
  // 这里接住，交给统一的转场引擎（入口长成分页），跑完把旗子放下。手机四宫格直接调 openPage。
  // 同一次微任务里执行：旧快照要到下一帧才拍，旗子引起的 DOM 变化（Dock 图标 handoff 隐藏）
  // 先被 enterBar=null 撤回，不会拍进去。
  $effect(() => {
    const key = ui.enterClaude ? 'claude' : ui.enterVertex ? 'vertex' : null;
    if (!key) return;
    untrack(() => {
      const from = (key === 'vertex' && ui.enterOriginTile) || ui.enterOrigin || null;
      const radius = ui.enterBar ? 12 : 30;
      ui.enterBar = null;
      openPage(key, { from, radius }).finally(() => { ui.enterClaude = false; ui.enterVertex = false; });
    });
  });

  onMount(async () => {
    initNav();   // 垫 history 哨兵：系统侧滑逐级返回而非直接退 app
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
    // 单页模式没有预载演出来置 booted：auth 有结果（或确定要先配服务器地址）就算启动完
    const bootSingle = () => {
      if (ui.booted || !(startedSingle || rootScreen() !== 'home')) return;
      if (rootScreen() !== 'home') applyFollowSys();
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
    startLanAutoSwitch(() => api.get('/api/lan'));
    try { caps.data = await loadCaps(); caps.loaded = true; } catch {}
    try {
      const a = await api.auth(); applyMe(a);   // 同步写快照 → 下次进 app 启动瞬间即登录态，不闪
      cacheMe(a);   // 缓存登录态（整份，含 agents / hosting），供离线进 app 看历史聊天
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
    bootSingle();
    // 恢复消息流：有在跑的轮 → 先补历史再接直播；否则自动加载上次会话（含杀后台
    // 期间完成的结果）。离线时自动回落本地缓存。
    try { await restoreOnBoot(); } catch {}
    autoCheckUpdate();   // apk 壳：发现新版即后台静默下载（fire-and-forget，不阻塞 boot）
    // 桌面壳：点了「跑完了 / 在等你回答」的系统通知 → 直接跳到那一轮。
    // 手机/网页没有 window.BridgeDesktop，这里恒不挂载，行为完全不变。
    try {
      window.BridgeDesktop?.agent?.onOpenSession?.(({ func, sessionId } = {}) => {
        if (func === 'codex') { if (screenOn('chatgpt')) ui.screen = 'chatgpt'; return; }
        if (!screenOn('claude')) return;
        ui.screen = 'claude';
        ui.taskDone = false;
        if (sessionId) openSession(sessionId).catch(() => {});
      });
    } catch {}
    // 桌面壳：需要前端配合的全局快捷键动作（纯窗口层面的由主进程自己做完了）。
    try {
      window.BridgeDesktop?.shortcuts?.onAction?.(({ action } = {}) => {
        if (action !== 'new-session' || !screenOn('claude')) return;
        ui.screen = 'claude';
        ui.taskDone = false;
        // Claude 页挂着就交给它（和侧栏「新对话」同一套落点规则）；还没挂上时照旧开在默认工作空间
        const handled = !window.dispatchEvent(new CustomEvent('bridge:newchat', { cancelable: true }));
        if (!handled) newConversation();
      });
    } catch {}
  });

  // 开机底色（index.html 的 data-booting）在预载结束时撤掉，之后由各页自己的底色接管
  $effect(() => { if (ui.booted) delete document.documentElement.dataset.booting; });

  // 回到 claude 页（且 app 在前台）= 用户看到了结果 → 清掉主页小人的「举旗」未读态。
  $effect(() => { if (ui.screen === 'claude' && !document.hidden) ui.taskDone = false; });
  function onVisible() { if (!document.hidden && ui.screen === 'claude') ui.taskDone = false; }

  // 手机系统状态栏（顶部那条"黑边"）的背景由 <meta theme-color> 控制（Android Chrome / PWA 据此着色）。
  // 让它跟随当前页面：claude 分页用其主题底色(--bg：明=浅/暗=深)，主页用深色兜底，不再固定深色顶出黑边。
  $effect(() => {
    ui.screen; ui.theme; ui.glassMode;   // 依赖：页面/主题切换就重算
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      meta.content = ui.screen === 'home' ? '#0a0a0a' : (bg || '#1f1f1e');
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
     侧滑返回（claudeSliding/vertexSliding）时提前唤醒，露出底层主页。 -->
{#if !single}
  <div style:display={ui.screen !== 'home' && !ui.claudeSliding && !ui.vertexSliding ? 'none' : 'contents'}>
    <!-- 桌面壳走沉浸启动器（批4：Dock + Ctrl+K），手机/网页仍是四宫格 Home -->
    {#if isNativeDesktop()}<DesktopHome />{:else}<Home />{/if}
  </div>
{/if}
<!-- claude / chatgpt / vertex 分页 keep-alive：首次进入才挂载，之后【休眠】保留——
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
{#if mountChatGPT && screenOn('chatgpt')}
  <div class="keep" class:dormant={ui.screen !== 'chatgpt'} inert={ui.screen !== 'chatgpt'}>
    {#await loadPage.chatgpt() then m}<m.default />{/await}
  </div>
{/if}
{#if mountVertex && screenOn('vertex')}
  <div class="keep" class:dormant={ui.screen !== 'vertex'} inert={ui.screen !== 'vertex'}>
    {#await loadPage.vertex() then m}<m.default />{/await}
  </div>
{/if}
{#if ui.screen === 'files'}
  <!-- 桌面壳（Electron）独占的原生工作空间：Explorer 级信息密度 + 右键/键盘/拖拽；
       网页 / 安卓 / 手机浏览器仍走手机版 FilesPanel。
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
  {:else if isNativeDesktop() && hasNativeWorkspaceOps() && !(import.meta.env.DEV && typeof window !== 'undefined' && window.__FD_MOCK_PANEL)}
    <FilesDesktop />
  {:else}
    <!-- 位置（工作空间 / 主目录 / 各盘符）由 FilesPanel 自己管：顶栏位置胶囊 -->
    <FilesPanel />
  {/if}
{:else if ui.screen === 'harness' || ui.screen === 'antigravity'}
  <!-- 无权者即便靠陈旧的 screen 状态/深链走到这，也不渲染整页（否则页内每个请求 403，
       变成一屏「加载失败」）。真闸在服务端 /api/harness。 -->
  {#if screenOn('harness')}
    {#await loadPage.harness() then m}<m.default />{/await}
  {:else}
    <ComingSoon name="dimensio" />
  {/if}
{:else if ui.screen !== 'home' && ui.screen !== 'claude' && ui.screen !== 'chatgpt' && ui.screen !== 'vertex'}
  <ComingSoon name={ui.screen} />
{/if}

{#if !single}
  {#if !ui.booted && !startedSingle}
    <Preload onDone={() => { ui.booted = true; }} />
  {/if}

  <!-- 持久品牌标题（全程唯一）：预载中央→左上，之后留在主页左上 -->
  <BrandTitle />
{:else if !needConfig}
  <!-- 单页模式的登录：没登录时压在那一页上（启动自动打开 / 退出后 / 账户菜单「登录」） -->
  <LoginDialog />
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

<!-- 手机端「扫一扫」登录网页版：全屏取景/确认卡（账户卡入口，或系统相机扫到 ?pair= 直达） -->
{#if ui.pairScan}<PairScan />{/if}

<!-- 设置「Agent」页（admin：各 agent 开关 / 能否运行 / 认证；同样盖在设置页之上） -->
{#if ui.agentsOpen}<AgentsPage />{/if}

<!-- 轻量 toast（lib/toast.svelte.js）：全程常驻，底部居中一条，不拦点击 -->
<Toast />

<!-- 统一沉浸式文件查看器（全程常驻，preview.open 时全屏接管；Vertex 与工作空间共用） -->
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
</style>
