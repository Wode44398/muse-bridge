<script>
  // 顶层路由。启动：加载 caps/auth/恢复活跃会话；ui.screen 切换 Home / ClaudePage / HarnessPage / 工作空间。
  //
  // 单 agent 模式（lib/state 的 rootScreen：只剩 Claude 或只剩 dimensio）：没有主页——打开即是那一页；
  // 登录是压在页上的登录框（LoginDialog），设置入口是侧栏底部账户卡。开机按上次的登录态快照判模式；
  // auth 回来名单变了（管理员加开 / 关掉 agent）由下面的 effect 随时切过去。
  import { onMount, untrack } from 'svelte';
  import { loadCaps } from './lib/caps.js';
  import { api } from './lib/api.js';
  import { caps, me, ui, applyMe, screenOn, rootScreen, applyFollowSys } from './lib/state.svelte.js';
  import { busStart, busStop, busOn } from './lib/bus.js';
  import { showToast } from './lib/toast.svelte.js';
  import { reportUi } from './lib/uiReport.js';
  import { restoreOnBoot } from './lib/chat.svelte.js';
  import Home from './components/Home.svelte';
  import ClaudePage from './components/ClaudePage.svelte';
  import FilesPanel from './components/FilesPanel.svelte';
  import HarnessPage from './components/HarnessPage.svelte';
  import { onReachabilityChange, startReachabilityWatch } from './lib/server.js';
  import ServerAdmin from './components/admin/ServerAdmin.svelte';
  import ExtensionsPage from './components/ExtensionsPage.svelte';
  import MediaViewer from './components/preview/MediaViewer.svelte';
  import DragLayer from './components/DragLayer.svelte';
  import { initNav } from './lib/nav.js';
  import PairScan from './components/PairScan.svelte';
  import { parsePairPayload } from './lib/pair.js';
  import Settings from './components/settings/Settings.svelte';
  import LoginDialog from './components/LoginDialog.svelte';
  import Toast from './components/Toast.svelte';
  import { t } from './lib/i18n.js';

  // —— 单 agent 模式 ——
  const root = $derived(rootScreen());
  const single = $derived(root !== 'home');
  // 开机就落在那一页（组件初始化时同步置，第一帧就不是主页）。
  if (rootScreen() !== 'home') ui.screen = rootScreen();
  // 模式随名单变：进单页模式时人还在主页 → 送到那一页；退出单页模式不动（侧栏会重新长出「主页」）
  $effect(() => {
    const r = root;
    untrack(() => { if (r !== 'home' && ui.screen === 'home') ui.screen = r; });
  });
  // 单页模式没有主页右上的登录胶囊：启动完还没登录就直接弹登录框
  let loginNudged = false;
  $effect(() => {
    if (!single || !ui.booted || loginNudged) return;
    if (me.kind === 'none') { loginNudged = true; ui.loginOpen = true; }
  });

  // 扫码登录的「系统相机」直达：登录二维码里是本站地址 ?pair=<id>.<key>，被系统相机（而非
  // 网页内的扫一扫）扫到会打开这个网页。已登录 → 直接进确认卡；未登录 → 弹一次登录卡，
  // 登录后再确认。参数读完即从地址栏擦掉（钥匙不留在历史/收藏里）。
  let pendingPair = $state(null), pairNudged = false;
  $effect(() => {
    if (!pendingPair || !ui.booted) return;
    if (me.kind !== 'none') { ui.pairScan = { mode: 'confirm', ...pendingPair }; pendingPair = null; return; }
    if (!pairNudged) { pairNudged = true; ui.loginOpen = true; }
  });

  // Claude 分页 keep-alive 挂载闩：进过一次就保持挂载（休眠/唤醒切换，见下方 .keep）。boot 完成后
  // 空闲时预挂载，首次点入口的转场也全程丝滑——挂载成本在 idle 期已付清，转场揭幕只翻可见性。
  let mountClaude = $state(false);
  $effect(() => { if (ui.screen === 'claude') mountClaude = true; });
  // 管理员的工作空间页可以换根：工作空间 / 主目录 / 「/」等，与新建项目选择器同一份
  // /api/project/locations。换根 = FilesPanel 以 ws 作用域重挂（{#key}）。
  let fileLocs = $state(null);
  let fileLoc = $state(null);   // 选中的位置；null = 身份工作空间
  $effect(() => {
    if (ui.screen !== 'files' || me.kind !== 'admin') return;
    untrack(() => { if (!fileLocs) api.projectLocations().then((r) => { fileLocs = r.locations || []; }).catch(() => {}); });
  });
  $effect(() => { me.kind; untrack(() => { fileLocs = null; fileLoc = null; }); });   // 换人就重拉
  const fileRoot = $derived(fileLoc && fileLoc.id !== 'ws' ? fileLoc : null);

  // 工作区协同：上报用户所在页面（agent 的 workspace.view 用）。没登录不报（接口要鉴权）；登录后补报一次。
  $effect(() => { if (me.kind !== 'none') reportUi({ page: ui.screen }); });
  $effect(() => {
    if (!ui.booted) return;
    // 预挂载只挂这个身份开着的分页（没开的 agent 连挂载成本都不付）。
    const tm = setTimeout(() => { if (screenOn('claude')) mountClaude = true; }, 1600);
    return () => clearTimeout(tm);
  });

  // agent 名单变了（管理员在设置「Agent」页开关、或在控制台改了这个人的授权）：服务端经总线推
  // agents.changed / me.changed，这里现拉 /api/auth 刷新。正开着的分页若刚被关掉，提示一句退回。
  async function refreshMe() {
    try { applyMe(await api.auth()); }
    catch (e) { if (e?.status === 401 && e?.body && typeof e.body === 'object') applyMe(e.body); }
  }
  $effect(() => {
    if (!ui.booted || me.kind === 'none') return;
    busStart();
    const off = busOn((ev) => { if (ev.type === 'agents.changed' || ev.type === 'me.changed') refreshMe(); });
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

  onMount(async () => {
    initNav();   // 垫 history 哨兵：系统侧滑逐级返回而非直接离开页面
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
    // innerHeight 随键盘收缩、--kb 恒 0（不双垫）；某些浏览器不缩 layout viewport
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
    // 离线态由可达性状态机【双向】维护（断网亮、恢复自动灭）。必须在 auth 之前订阅：
    // boot 那次 auth 若因断网失败，正是经这条链路把 ui.offline 置起来的。
    onReachabilityChange((down) => { ui.offline = down; });
    startReachabilityWatch();
    try { caps.data = await loadCaps(); caps.loaded = true; } catch {}
    try { applyMe(await api.auth()); }   // 同步写快照 → 下次进 app 启动瞬间即登录态，不闪
    catch (e) {
      // 没登录（401）也要拿到服务器形态与开着的 agent 名单（回包体里有），单 agent 的服务器据此直接落页。
      if (e?.status === 401 && e?.body && typeof e.body === 'object') applyMe(e.body);
    }
    applyFollowSys();
    ui.booted = true;
    // 恢复消息流：有在跑的轮 → 先补历史再接直播；否则自动加载上次会话。离线时自动回落本地缓存。
    if (me.kind !== 'none' && screenOn('claude')) { try { await restoreOnBoot(); } catch {} }
  });

  // 回到 claude 页（且页面在前台）= 用户看到了结果 → 清掉「有任务完成还没看」的未读态。
  $effect(() => { if (ui.screen === 'claude' && !document.hidden) ui.taskDone = false; });
  function onVisible() { if (!document.hidden && ui.screen === 'claude') ui.taskDone = false; }

  // 手机系统状态栏的背景由 <meta theme-color> 控制（Android Chrome / PWA 据此着色）。
  // 让它跟随当前页面：dimensio 分页用它自己的页面底色（它有独立的明暗档），其余用主题底色 --bg。
  $effect(() => {
    const screen = ui.screen, chrome = ui.pageChrome;
    ui.theme;   // 依赖：主题切换就重算
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    if (screen === 'harness' && chrome?.bg) { meta.content = chrome.bg; return; }
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    meta.content = bg || '#1f1f1e';
  });
</script>

<svelte:document onvisibilitychange={onVisible} />

<!-- 主页全程挂载、其他分页时 display:none；Claude 页左缘右滑（claudeSliding）时提前唤醒，露出底层主页。 -->
{#if !single}
  <div style:display={ui.screen !== 'home' && !ui.claudeSliding ? 'none' : 'contents'}>
    <Home />
  </div>
{/if}
<!-- claude 分页 keep-alive：首次进入才挂载，之后【休眠】保留——聊天滚动位置/输入草稿随 DOM 一起保住。
     休眠用 content-visibility:hidden + visibility:hidden + inert（app.css 的 .keep.dormant）而不是
     display:none：display:none 会把整页的样式与布局扔掉，每次进页都要重算；content-visibility:hidden
     保留渲染状态，重新显示 ≈1ms。不绘制、不命中、不可聚焦（inert）。 -->
{#if mountClaude && screenOn('claude')}
  <div class="keep" class:dormant={ui.screen !== 'claude'} inert={ui.screen !== 'claude'}><ClaudePage /></div>
{/if}
{#if ui.screen === 'files'}
  {#key fileRoot?.id || 'ws'}
    <FilesPanel workspaceRoot={fileRoot?.path || ''} rootName={fileRoot?.name || ''}
      locations={me.kind === 'admin' ? fileLocs : null} locationId={fileRoot?.id || 'ws'} onLocation={(l) => { fileLoc = l; }} />
  {/key}
{:else if ui.screen === 'harness' && screenOn('harness')}
  <!-- 无权者即便靠陈旧的 screen 状态走到这，也不渲染整页（上面的 effect 会把人送回根页）。
       真闸在服务端 /api/harness。 -->
  <HarnessPage />
{/if}

{#if single}
  <!-- 单页模式的登录：没登录时压在那一页上（启动自动打开 / 退出后 / 账户菜单「登录」） -->
  <LoginDialog />
{/if}

<!-- 离线模式提示条：连不上服务器、正浏览本地缓存时显示（pointer-events:none 不挡交互）。 -->
{#if ui.offline}
  <div class="offline-banner">{t('离线 · 连不上服务器；可浏览本地缓存，恢复网络后自动重连')}</div>
{/if}

<!-- 设置（宽屏对话框 / 手机整页），入口在侧栏账户卡或主页右上账户胶囊 -->
{#if ui.settingsOpen}<Settings />{/if}

<!-- 服务端控制台（设置页入口；磨砂借下层设置页的罩） -->
{#if ui.serverAdminOpen}<ServerAdmin />{/if}

<!-- 手机端「扫一扫」登录网页版：全屏取景/确认卡（账户卡入口，或系统相机扫到 ?pair= 直达） -->
{#if ui.pairScan}<PairScan />{/if}

<!-- 扩展中心（设置入口；同样盖在设置页之上、磨砂借下层罩） -->
{#if ui.extensionsOpen}<ExtensionsPage />{/if}

<Toast />

<!-- 统一沉浸式文件查看器（全程常驻，preview.open 时全屏接管） -->
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
</style>
