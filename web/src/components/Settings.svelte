<script>
  // 设置页（iOS 27 设置 App）。从登录 pill 菜单「设置」进入，左缘右滑 / 返回钮回主页。
  // v4（2026-09-30）按 Apple「iOS and iPadOS 27」官方 UI Kit 重做（取样与数据：bridge build/design/ios27-settings/）：
  //  · 结构 = 设置 App：根列表（彩色图标方块 + 分组）→ 推入式子页；每页大标题，滚上去收成顶栏居中小标题；
  //    子页左缘右滑跟手返回，根页右滑回主页。
  //  · 尺寸/字号/颜色全部取自 kit：组圆角 26（Figma 平滑 60%）、行高 52、分隔线 1pt 内缩两侧、17/22 正文、
  //    15/20 副文、13/18 脚注、34/41 大标题；Light/Dark 两套颜色变量（Backgrounds (Grouped)、Labels、Fills、Accents）。
  //  · 控件：开关 64×28、分段 50 高、滑块 6 高轨道 + 38×24 旋钮——按下时的玻璃透镜、返回钮/胶囊的液态玻璃、
  //    警告框/表单页/菜单的玻璃面板，都是 Figma 原版着色器渲染或解出的图层（components/ios27/）。
  //  · 顶栏下的滚动边缘效果对应 kit「Scroll Edge Effect - Soft」：一层 backdrop 模糊 + 渐隐遮罩。同屏只有这一层
  //    backdrop（弹窗/表单页打开时另加它们自己那层），不叠折射——多层 backdrop 互毁，见 dev_verify 记忆。
  // 2026-10-19 v5「墨与象牙」：维护者嫌 v4「AI 味太浓、粗糙」——彩虹色图标方块 + 自绘的假 agent 字形 + 冷黑底配 iOS 蓝绿。
  //  · 配色取自应用图标（墨色渐变、月桥象牙白）：暖灰中性色 + 单一墨色强调（开关、勾选、主按钮），红 / 琥珀 / 绿只表达状态。
  //  · 图标：去掉色块，统一成一套线稿（lib/settingsIcons.js）放在中性底的方格里；agent 用各自的真品牌标。
  //  · 结构：账户卡在顶；应用卡并进末组「关于」；单项孤组合并（通知进「通用」）；agent 页 / 账户 / 关于用头图代替大标题。
  //  · 交互：号池行「使用中」标签取代勾 + 箭头并存；刷新用量改图标钮（转圈）；上移 / 下移合成一行「顺序」。
  // 改皮不改骨：业务逻辑（偏好开关、手机操控、本机 Agent、远程控制、流体壁纸滑柱透视主页、壁纸舞台、
  // 反馈/服务器地址、更新下载）与 v3 一致。
  // 2026-10-18 按 agent 重排：根页 = 账户 / 关于 → 「Agent」分组（Claude、Gemini、Codex、dimensio 各一页）
  // →「服务器」分组（扩展、额度与注册、服务端控制台）→ 通用 / 外观 / 壁纸 →「这台设备」→ 反馈 / 更新。
  // 每个 agent 页堆它自己的设置：开关与认证；Claude 另有订阅号池（逐号用量、切号、增删改、排序）、智能换号、对话偏好
  // （输入建议 / 思考动画 / 自动压缩点，原在「通用」）。号池等原本只在控制台的配置，
  // 服务端开了 settingsGate 才能远程改——只放「改了也断不了连接」的，见 lib/agentSettings.svelte.js。
  // 2026-10-21 设置外壳合一（维护者：只要两套）：单页模式（只开着 Claude）也用这一套，原 claude.ai 风那套
  // （components/settings/Sec*）下线；它独有的东西并进来——「关于」页的软件更新 / 自动检查更新 / 安装权限 / 新版本说明 /
  // 版本历史 / 这台手机信息与服务器公网地址、后端状态，「通用」的后台运行，端口转发的「打开」。
  // 直达分区（lib/settingsNav 的 openSettings('xxx')）两套外壳共用一套名字，见下面的 deepStack。
  import { setContext, untrack } from 'svelte';
  import { ui, me, rootScreen } from '../lib/state.svelte.js';
  import { devices, loadDevices, loadForwards } from '../lib/devices.svelte.js';
  import { registerCloser } from '../lib/nav.js';
  import { swipeDismiss, spring, NAV_SPRING } from '../lib/motion.js';
  import { layout } from '../lib/layout.svelte.js';
  import { platform } from '../lib/appUpdate.js';
  import { settingsNav } from '../lib/settingsNav.svelte.js';
  import { t, tr } from '../lib/i18n.js';
  import { agentById, accLabel } from '../lib/agentSettings.svelte.js';
  import { cs } from '../lib/claudeSettings.svelte.js';
  import { hubUi, closeHubSheet } from '../lib/modelHub.svelte.js';
  import { label as csLabel } from '../lib/claudeSettingsView.js';
  // 子 agent 调用策略子页的「离开前确认」登记处（不带依赖的小文件；子页正文与状态模块都是懒加载的，见 settings/ios/dispatch.svelte.js）
  import { dispatchHasUnsaved } from './claude/dispatch/leaveGuard.js';
  import { extensionsNav } from '../lib/extensionsNav.svelte.js';
  import { ds, prefLabel } from '../lib/dimensioSettings.svelte.js';
  import { goto } from '../lib/pageMorph.js';
  import GlassButton from './ios27/GlassButton.svelte';
  import Customize from './ext/Customize.svelte';
  import HomeLayoutPanel from './settings/HomeLayoutPanel.svelte';   // 「主页」分区：主页入口的顺序与显隐
  import PageGrantsPanel from './settings/PageGrantsPanel.svelte';   // 「页面权限」分区：插件页面拿到的权限，逐项撤销
  import PluginFrame from './ext/PluginFrame.svelte';
  import { pluginPanels, watchPluginPanels, openPluginStandalone, inAndroidApp, panelTitle } from '../lib/pluginPanels.svelte.js';
  import { showToast } from '../lib/toast.svelte.js';
  // 玻璃图层 / 平滑圆角遮罩：原版资源（web/src/visuals/）
  import sq26 from '../visuals/ios27/squircle26.svg';
  // 各分区：控制器（状态与动作，外壳按原来的先后创建）与页组件（只画），都在 settings/ios/；两套外壳共用的在 lib/settings/
  import { provideSettings } from './settings/ios/ctx.js';
  import { createGeneral } from './settings/ios/general.svelte.js';
  import { createClaudePrefs, createClaudePool, CL_CHOICE, CL_GROUP } from './settings/ios/claude.svelte.js';
  import { createDispatch, DISPATCH_PAGES } from './settings/ios/dispatch.svelte.js';
  import { createDimensio, DM_TITLE } from './settings/ios/dimensio.svelte.js';
  import { createPhone } from './settings/ios/phone.svelte.js';
  import { createDevices, createAgentKeys } from './settings/ios/devices.svelte.js';
  import { createAgents, createPolicy, createStudio, createAgy } from './settings/ios/agents.svelte.js';
  import { createAccount } from './settings/ios/account.svelte.js';
  import { createWallpaper } from './settings/ios/wallpaper.svelte.js';
  import { createUpdate, createAbout, createFeedback } from './settings/ios/about.svelte.js';
  import { createSrvAdminProbe, createExtProbe, createHubPresence } from '../lib/settings/common.svelte.js';
  import RootPages from './settings/ios/RootPages.svelte';
  import PrefsPages from './settings/ios/PrefsPages.svelte';
  import AgentPages from './settings/ios/AgentPages.svelte';
  import WallpaperPages from './settings/ios/WallpaperPages.svelte';
  import DevicePages from './settings/ios/DevicePages.svelte';
  import WallpaperStage from './settings/ios/WallpaperStage.svelte';
  import SettingsDialogs from './settings/ios/SettingsDialogs.svelte';

  // —— 外观：跟全局界面主题（全局统一：主页与 Claude 等分页同一份明暗）——
  const dark = $derived(ui.theme !== 'light');
  setContext('ios27', { get dark() { return dark; }, ink: true });
  // 单页模式（只开着一个 agent，App 直接落在那一页、没有主页）也用这一套设置（2026-10-21 起，原 claude.ai 风那套下线）：
  // 跟主页 / 跨分页的东西在这里没意义——壁纸与流体壁纸——藏掉。
  const single = $derived(rootScreen() !== 'home');
  const plat = platform();   // 'android' | 'web'（桌面壳走 SettingsDesktop，到不了这里）

  let closing = $state(false);
  let sliding = $state(null);

  // —— 各分区的控制器：按原来在这个文件里的先后创建（里面的 $effect、开设置就发的请求次序不变），挂进 S 给各页组件 ——
  const S = {
    get dark() { return dark; }, get single() { return single; }, plat,
    get sliding() { return sliding; }, set sliding(v) { sliding = v; },
    nav: {
      get stack() { return stack; }, push, pop, go, get cur() { return cur; }, get split() { return split; },
      openExtType, openRoutinesPage, titleOf, openPlg,
      get dpSlot() { return dpSlot; }, set dpSlot(v) { dpSlot = v; },
    },
  };
  provideSettings(S);
  S.gen = createGeneral();
  S.cl = createClaudePrefs();
  S.dp = createDispatch(S);
  S.dm = createDimensio(S);
  // 扩展与记忆：落到现有扩展中心（直达某个类型）/ Claude 分页的定时任务
  function openExtType(type) { extensionsNav.type = type; push('extensions'); }
  function openRoutinesPage() { ui.settingsOpen = false; goto('claude'); ui.routinesOpen = true; }
  S.phone = createPhone(S);
  S.dev = createDevices(S);
  // —— 服务端设置入口：仅桌面服务端形态（含附着主机）显示 ——
  // 条件：服务端就在这台电脑上（桌面客户端连本机）或开着远程管理，且后端探针通过；服务端形态（features.remoteAdmin）的管理员在手机 / 网页上也能进
  S.srvAdmin = createSrvAdminProbe();
  // —— 扩展中心入口：admin 探针通过才显示（成员探的是自己的技能接口）——
  S.ext = createExtProbe();
  S.ag = createAgents();
  S.pool = createClaudePool(S);
  S.pol = createPolicy();
  S.st = createStudio(S);
  S.agy = createAgy(S);
  // —— 模型中心（2026-11-10 起是根页 agent 组里的一页 'model-hub'，正文 components/modelhub/HubHome 懒加载）——
  // 出不出现看 hub.ok（管理员的总览）|| cp.ok（能自定义 API 的成员自己的 Claude 服务），两样都是开设置才拉。
  // 直达这一页时数据多半还在路上：落定前先停在这页等，落定了确实两边都没有再退回去（见下面 deepStack 与退回的 effect）
  S.hub = createHubPresence();
  // 弹层总闸（左缘右滑 guard / 外壳 class:modal 都读它）：Claude 页的绕过权限确认、分支前缀编辑也登记在这里。
  // 模型中心的浮层（添加 / 服务详情，挂在 App 根上）开着也算弹层：设置别响应左缘右滑、顶栏去掉磨砂；调用策略子页里的浮层（dpModal）同理
  const anyAgModal = $derived(!!S.pool.acctForm || !!S.pool.acctDel || !!S.pol.numEdit || !!S.ag.agLast || S.cl.bypassAsk || !!S.cl.prefixEdit || !!hubUi.sheet || !!S.dm.dmEdit || S.dm.dmPicking || S.st.stModal || S.agy.agyModal || S.dp.dpModal);
  S.acc = createAccount(S);
  S.wpc = createWallpaper(S);
  S.up = createUpdate();
  S.about = createAbout(S);
  S.fb = createFeedback();

  // —— 导航栈（设置 App 的推入 / 返回）——
  // 页面层叠渲染：顶层页 x = navX（px，0＝就位，W＝移出右侧），下一层随之在 −30%·W…0 之间视差平移并压暗；
  // 推入 / 返回都用弹簧驱动 navX（NAV_SPRING），左缘右滑直接跟手改 navX，松手由 swipeDismiss 的弹簧续写。
  const TITLES = {
    root: () => t('设置'), general: () => t('通用'), notify: () => t('通知'), 'notify-tone': () => t('提示音'), 'notify-vibe': () => t('振动方式'), language: () => t('语言'), thinkmark: () => t('思考动画'), appearance: () => t('外观'),
    home: () => t('主页'), 'page-grants': () => t('页面权限'), wallpaper: () => t('壁纸'), flux: () => t('流体壁纸'), agentapi: () => t('Agent 接入'), 'model-hub': () => t('模型中心'),
    phone: () => t('手机操控'), devices: () => t('设备'), 'fwd-new': () => t('新的转发'), about: () => t('关于'), history: () => t('版本历史'),
    account: () => (me.kind === 'none' ? t('登录') : t('账户')), policy: () => t('额度与注册'), extensions: () => t('扩展'),
    studio: () => 'Media Studio', 'cl-dispatch': () => t('子 agent 调用策略'), 'dm-dispatch': () => t('子 agent 调用策略'),
    ...CL_GROUP,
    ...Object.fromEntries(Object.entries(CL_CHOICE).map(([pid, key]) => [pid, () => csLabel(key)])),
  };
  // agent 页 'ag-<id>'、号池里某个账号 'acct:<id>' 的标题跟着数据走
  // 第三方插件的控制面板（清单 ui.panel）：根页「插件」组一行一个。网页里推入一页嵌插件页面（PluginFrame）；
  // 手机 App 交给原生另起的干净 WebView——App 的原生桥会注入所有帧，插件页面不能嵌在主页面里。
  watchPluginPanels();
  function openPlg(pp) {
    if (inAndroidApp()) { openPluginStandalone(pp.id, { title: panelTitle(pp) }).catch((e) => showToast(tr(e?.body?.error || e?.message || String(e)), 'err')); return; }
    go('plg-' + pp.id);
  }
  function titleOf(pid) {
    if (TITLES[pid]) return TITLES[pid]();
    if (pid.startsWith('plg-')) return panelTitle(pluginPanels.list.find((x) => 'plg-' + x.id === pid));
    if (pid.startsWith('ag-')) { const id = pid.slice(3); return agentById(id)?.label || (id === 'claude' ? 'Claude' : id); }
    if (pid.startsWith('st:')) return S.st.stTitles[pid] || '';
    if (pid.startsWith('agy:')) return S.agy.agyTitles[pid] || '';
    if (pid.startsWith('dm:')) return DM_TITLE[pid.slice(3)]?.() || '';
    if (pid.startsWith('dp:')) { const p = ds.prefs?.items?.find((x) => x.key === pid.slice(3)); return p ? prefLabel(p) : ''; }
    if (pid.startsWith('acct:')) return accLabel(S.pool.acctById(pid.slice(5))?.label || '') || t('账号');
    if (pid.startsWith('device:')) return devices.list.find((d) => d.id === pid.slice(7))?.name || t('设备');
    return '';
  }
  // 外部入口直达某页（侧栏菜单「设置 / 关于与更新」、主页账户卡「账户」、输入框电脑芯片「管理设备…」、
  // 安全栅门横条「打开设置」、分屏格转来的…）：开页时直接叠好，读完即清。
  // 分区名是两套外壳共用的那一套（见 lib/settingsNav 的 openSettings），这里映射成本外壳的页；不认识的落根页。
  function deepStack(sec) {
    const s = String(sec || '');
    if (!s || s === 'root') return ['root'];
    if (s === 'claude' || s === 'agents' || s === 'ag-claude') return ['root', 'ag-claude'];
    // 子 agent 调用策略：Claude 页里推入的一页（没有这一行的身份落在 Claude 页）
    if (s === 'dispatch' || s === 'cl-dispatch') return cs.shell || cs.admin ? ['root', 'ag-claude', 'cl-dispatch'] : ['root', 'ag-claude'];
    // dimensio 那份调用策略：dimensio 页里推入的一页
    if (s === 'dm-dispatch' || s === 'dimensio-dispatch') return ['root', 'ag-dimensio', 'dm-dispatch'];
    // Media Studio；Gemini 设置页 11-04 删了，指向它的老入口（gemini / vertex）一并落到这里
    if (s === 'studio' || s === 'ag-studio' || s === 'media' || s === 'gemini' || s === 'ag-gemini' || s === 'vertex') return S.ag.studioOn ? ['root', 'studio'] : ['root'];
    if (s === 'agy') return ['root', 'ag-agy'];
    if (s.startsWith('ag-')) return ['root', s];
    if (s === 'connection' || s === 'connect') return ['root', 'about'];   // 服务器地址、线路、公网地址都在「关于」
    if (s === 'devices' || s === 'localpc') return S.dev.hasDevices ? ['root', 'devices'] : ['root'];
    if (s === 'phone') return S.phone.hasPhoneCtrl ? ['root', 'phone'] : ['root'];
    if (s === 'wallpaper') return single ? ['root'] : ['root', s];
    // 主页入口的排序 / 显隐：单页模式没有主页，落根页（同壁纸）
    if (s === 'home' || s === 'home-layout') return single ? ['root'] : ['root', 'home'];
    // 页面权限：授权跟人走，单页模式也有；没登录没有授权可看
    if (s === 'page-grants' || s === 'grants') return me.kind === 'none' ? ['root'] : ['root', 'page-grants'];
    // 扩展：「插件详情」直达（lib/extensionsNav 的 openPluginDetail）走这里。冷开时 extOk 探针还没回来，按它判就落回根页了：
    // 已登录就先当它在（跳得过来的只有已登录的人，插件详情只有主机），探针落定了确实没过再由下面的收尾 effect 撤掉。
    // 桌面设置同一个思路（探针落定前「分区被收走就回通用」不判扩展）
    if (s === 'extensions') return me.kind === 'none' ? ['root'] : ['root', 'extensions'];
    if (s === 'agentapi' || s === 'agent-api') return S.dev.hasDevices ? ['root', 'agentapi'] : ['root'];
    // 模型中心：老入口名（模型服务 / 自定义 API 的 providers、cproviders）一并指过来。数据还没拉到时先当它在
    // （mhMaybe），拉到了确实没有再由下面的收尾 effect 退回去——不然冷开设置直达这一页会先被打回首页
    if (s === 'model-hub' || s === 'modelhub' || s === 'models' || s === 'providers' || s === 'cproviders') return S.hub.maybe() ? ['root', 'model-hub'] : ['root'];
    if (s === 'account' || s === 'about' || s === 'general' || s === 'appearance' || s === 'language') return ['root', s];
    if (s === 'notify' || s === 'notifications') return ['root', 'general', 'notify'];
    if (s.startsWith('plg-')) return ['root', s];   // 插件面板（手机 App 里不进这里：交给原生页面，见 openPlg）
    return ['root'];
  }
  // 反馈是根页上弹出的表单页（Sheet），不是推入页：直达 = 叠在根页上把它弹出来
  const isFeedbackSec = (s) => s === 'feedback' || s === 'help';
  // 宽屏双栏（2026-11-08 维护者：折叠屏展开后的设置要像电脑端那样）：视口 ≥700（折叠屏展开、平板、电脑浏览器，
  // 断点同 lib/layout 的 side）时不再是靠右 440 的一条，而是满屏两栏——左列常驻根页当导航（样子照桌面设置的侧栏：
  // 无卡片底、无箭头、选中＝中性底加粗），右侧是选中分区的页面栈。栈的结构不变：stack[0] 恒为根页，
  // 双栏时它画在左列，stack[1] 是右侧当前分区（左列高亮它），再往里的子页照旧在右侧推入 / 返回。
  // 双栏下栈至少两层（没指定分区时落「通用」，同桌面设置）；折回手机宽度时同一份栈照旧逐页显示。
  const split = $derived(layout.side);
  const SPLIT_HOME = 'general';
  const deep = settingsNav.sec;
  settingsNav.sec = null;
  let stack = $state(withHome(deepStack(deep)));
  function withHome(s) { return layout.side && s.length < 2 ? [...s, SPLIT_HOME] : s; }
  if (isFeedbackSec(deep)) S.fb.openFeedback();
  let navX = $state(0);
  let navBusy = $state(false);
  let navSp = null;
  // 推入 / 返回的位移量程：手机＝整块面板宽；双栏＝右侧那一栏宽（子页只在右栏里推）
  let panelBoxW = $state(400), detailW = $state(400);
  const panelW = $derived(split ? detailW : panelBoxW);
  const depth = $derived(stack.length);
  // 设置开着时展开 / 合上折叠屏（或拉宽 / 拉窄窗口）：两种形态的页面是各自重挂的——
  // 掐掉跑到一半的推入 / 返回弹簧（不然手机形态的「返回」在双栏里落地，会把右栏那页弹掉、右侧变空），
  // 滚动状态归零（新挂的页都在顶上），双栏缺右侧分区就补上。只跟 split 走，其余在 untrack 里读写（读写同一 state 的 effect 会自激）。
  // 唯一不跟着重挂的是调用策略子页的正文（它有没保存的草稿，见下面 dpHost 那段）：它落座后滚回原处，滚动事件会把那一页的滚动状态补回来
  $effect(() => {
    const s = split;
    untrack(() => {
      navSp?.cancel(); navSp = null; navX = 0; navBusy = false; dragX = 0;
      scrolled = {};
      if (s && stack.length < 2) stack = withHome(stack);
    });
  });
  // 根页上的行：手机上推入一页；双栏时换右侧分区（点当前分区＝退回它的第一页，iPad 设置同款），不做推入动画
  function go(pid) {
    if (!split) { push(pid); return; }
    if (closing) return;
    navSp?.cancel(); navX = 0; navBusy = false;
    if (stack.length === 2 && stack[1] === pid) return;
    // 右栏正开着调用策略子页、里面有没保存的改动：先由它问一句（dpLeave），答应了才换分区
    S.dp.dpLeave(() => {
      if (stack[1] !== pid) scrolled[pid] = 0;
      stack = ['root', pid];
    });
  }
  // 左列高亮的分区（手机上没有）
  const cur = $derived(split ? stack[1] || '' : '');
  function push(pid) {
    if (navBusy || closing) return;
    navSp?.cancel();
    navBusy = true;
    navX = panelW;
    scrolled[pid] = 0;
    stack.push(pid);
    requestAnimationFrame(() => {
      // 带一点初速度起步（系统的推入是「一按就走」，从静止起步的弹簧前 100ms 看着发黏）
      navSp = spring({ from: panelW, to: 0, velocity: -2.2 * panelW, ...NAV_SPRING.open, restDist: 0.4, restVel: 4,
        onUpdate: (x) => (navX = x), onDone: () => { navX = 0; navBusy = false; } });
    });
  }
  function pop(velocity = 0) {
    if (stack.length < (split ? 3 : 2)) return;   // 双栏时右侧分区的第一页不再往回退（根页一直在左列）
    // 顶上是调用策略子页、里面有没保存的改动：先由它问一句，答应了才退（别的页 dpLeave 直接放行）
    S.dp.dpLeave(() => {
      navSp?.cancel();
      navBusy = true;
      navSp = spring({ from: navX, to: panelW, velocity, ...NAV_SPRING.close, restDist: 0.4, restVel: 4,
        onUpdate: (x) => (navX = x), onDone: () => { stack.pop(); navX = 0; navBusy = false; } });
    });
  }
  // 开着时外部又点了「直达某分区」（分屏格里的「打开设置」等）：直接换到那一页
  $effect(() => {
    const s = settingsNav.sec;
    if (!s) return;
    untrack(() => {
      settingsNav.sec = null;
      if (isFeedbackSec(s)) { S.fb.openFeedback(); return; }
      const want = deepStack(s);
      // 已经在要去的那一页上就不动（比的是目标栈的最后一页：直达「Claude › 子 agent 调用策略」这种三层的，人在 Claude 页上也要推过去）
      if (want.length > 1 && stack[stack.length - 1] !== want[want.length - 1]) S.dp.dpLeave(() => { navSp?.cancel(); navX = 0; navBusy = false; stack = want; });
    });
  });
  // 冷开直达「模型中心」时数据还没到，deepStack 先让它停在那一页等（mhMaybe）；两边都拉完了确实没有这一页
  // （成员没开自定义 API、服务端没装 dimensio），或者开着时它没了——把它连同叠在上面的子页一起撤掉，退回下面那一层。
  // 只跟 mhSettled / mhOn 走，栈在 untrack 里读写（读写同一 state 的 effect 会自激）
  $effect(() => {
    if (!S.hub.settled || S.hub.on) return;
    untrack(() => {
      const i = stack.indexOf('model-hub');
      if (i < 1) return;
      navSp?.cancel(); navSp = null; navX = 0; navBusy = false;
      stack = withHome(stack.slice(0, i));
    });
  });
  // 扩展同理：探针落定了确实没过（不是主机 / 令牌失效），冷开直达的「扩展」页连同上面的子页撤掉；
  // 没被消费的插件详情直达一并清掉——残留的 id 会在以后进「功能扩展」、PluginsPanel 一挂上时被消费，把人突然拽进那个插件
  $effect(() => {
    if (!S.ext.settled || S.ext.ok) return;
    untrack(() => {
      extensionsNav.id = null; extensionsNav.type = null;
      const i = stack.indexOf('extensions');
      if (i < 1) return;
      navSp?.cancel(); navSp = null; navX = 0; navBusy = false;
      stack = withHome(stack.slice(0, i));
    });
  });
  // 「设备」页一露面就拉设备与端口转发：根页那一行点进来、外部直达（输入框电脑芯片「管理设备…」）、
  // 从单台设备 / 新的转发页退回来都走这里（10-21 回归 R3：以前只有点根页那一行才拉，直达时端口转发列表是空的）
  $effect(() => { if (stack[stack.length - 1] === 'devices' && S.dev.hasDevices) untrack(() => { loadDevices(true); loadForwards(); }); });
  // Claude 页一露面（点进来、外部直达）就取调用策略：入口行的副标题要读它。子页不在栈里了，它报过的浮层状态一并清掉
  const clOpen = $derived(stack.includes('ag-claude'));
  $effect(() => { if (clOpen && S.dp.dpShown) untrack(S.dp.dpLoad); });
  // 栈里是哪一份调用策略的子页：'cl-dispatch'（Claude）/ 'dm-dispatch'（dimensio）/ ''。两份不会同时在栈里（从 dimensio 那页去 Claude 那页走的是直达，整栈换掉）
  const dpPage = $derived(DISPATCH_PAGES.find((p) => stack.includes(p)) || '');
  const dpOpen = $derived(!!dpPage);
  $effect(() => { if (!dpOpen) S.dp.dpModal = false; });
  // 子页正文不挂在页面里。单栏 / 双栏一切换（视口跨过 700：手机转屏、折叠屏开合、拉窗口），页面是整组重挂的（见上面跟 split 走的
  // 那个 effect）；正文要是跟着重挂，没保存的草稿和正在看的那一套都回到服务端那份，它还会把这当成「没问就离开了」、补弹一次
  // 保存确认——人其实还在这一页。所以正文挂在模板里两种布局的分支之外（.dp-host，只跟「栈里有没有这一页」走），页面里只留一个
  // 空位（pDispatch 的 .dp-slot）：页面每次挂出来，就把同一个节点挪进新的空位，组件实例从头到尾是那一个。
  // 别的页没有草稿，照旧整组重挂——通用机制不动，只为这一页兜住。
  // 节点离开文档再回来，有三样不会自己跟回来，重挂前记下（dpKeep）、落座后补上：页面滚到哪了（滚动容器是页面的，新挂的在顶上）、
  // 正文里各处自己的滚动（策略签条横着滚到哪了）、焦点（正在写的备注框）。
  let dpHost = $state(), dpSlot = $state();
  let dpKeep = null;
  // $effect.pre 先于模板更新：这时旧页面还在文档里，量得到，焦点也还在
  $effect.pre(() => {
    split;
    untrack(() => {
      const host = dpHost, sc = host?.isConnected ? host.closest('.pg-scroll') : null;
      if (!sc) return;   // 这一页没开着；或者上一次重挂的落座还在路上——那就留着上一次记下的
      const a = document.activeElement;
      dpKeep = { host, y: sc.scrollTop, focus: a && host.contains(a) ? a : null,
        inner: [...host.querySelectorAll('*')].filter((el) => el.scrollLeft || el.scrollTop).map((el) => [el, el.scrollLeft, el.scrollTop]) };
    });
  });
  $effect(() => {
    const host = dpHost, slot = dpSlot;
    if (!host || !slot || host.parentNode === slot) return;
    const keep = dpKeep && dpKeep.host === host ? dpKeep : null;   // 刚进这一页的头一次落座，没有要补的
    dpKeep = null;
    slot.appendChild(host);
    if (!keep) return;
    for (const [el, x, y] of keep.inner) { el.scrollLeft = x; el.scrollTop = y; }
    const sc = slot.closest('.pg-scroll');
    if (sc && keep.y > 0) sc.scrollTop = keep.y;
    const f = keep.focus;
    if (f && host.contains(f) && document.activeElement !== f) { try { f.focus({ preventScroll: true }); } catch {} }
  });
  // 「Agent 接入」页露面期间拉密钥列表、听总线 agent.keys；退出这一页就丢掉没看完的明文密钥
  S.ak = createAgentKeys(S);
  // 「关于」进页才拉：服务器上的版本与历史、服务器状态（要登录）、这一份 apk 的信息；服务端更新（管理员）
  S.about.watchOpen();

  // 每页的滚动状态：大标题滚到顶栏下 → 顶栏小标题出现；有内容滚到顶栏下 → 滚动边缘效果显形
  let scrolled = $state({});
  const hasHero = (pid) => pid === 'about' || pid === 'account' || pid === 'studio' || pid === 'model-hub' || pid.startsWith('ag-') || pid.startsWith('acct:') || pid.startsWith('agy:acct:') || pid.startsWith('device:');
  function onPageScroll(pid, e) {
    const y = e.currentTarget.scrollTop;
    const s = y > 4 ? (y > (hasHero(pid) ? 120 : 44) ? 2 : 1) : 0;
    if (scrolled[pid] !== s) scrolled[pid] = s;
  }

  // 系统返回（安卓返回键 / 浏览器边缘返回 → nav.js → 这里）与本页左缘右滑手势可能被同一次划动各触发一次
  // （无头 Edge 实测：从最边缘划，浏览器自己的边缘返回 popstate + 本页手势 → 一次退两页、直接关掉设置）。
  // 手势进行中或刚结束 600ms 内的系统返回一律忽略。
  let swipeOn = false, swipeEndAt = 0;
  function back() {
    if (swipeOn || performance.now() - swipeEndAt < 600) return;
    // 模型中心的浮层（添加服务 / 编辑 / 迁移）盖在设置上：正常由它自己挂的返回层先接住；万一没接住，
    // 这一下也只关浮层，不能连设置的页一起退掉
    if (hubUi.sheet) { closeHubSheet(); return; }
    const { about, fb, acc, pool, pol, ag, cl, dm, wpc } = S;
    if (about.addrOpen) { about.addrOpen = false; return; }
    if (fb.fbOpen) { fb.fbOpen = false; return; }
    if (acc.acctAsk) { if (!acc.acctBusy) acc.acctAsk = null; return; }
    if (acc.pw) { acc.pw = null; return; }
    if (pool.acctForm) { if (!pool.acctForm.busy) pool.acctForm = null; return; }
    if (pool.acctDel) { pool.acctDel = null; return; }
    if (pol.numEdit) { if (!pol.numEdit.busy) pol.numEdit = null; return; }
    if (ag.agLast) { ag.agLast = false; return; }
    if (cl.bypassAsk) { cl.bypassAsk = false; return; }
    if (cl.prefixEdit) { if (!cl.prefixEdit.busy) cl.prefixEdit = null; return; }
    if (dm.dmEdit) { if (!dm.dmEdit.busy) dm.dmEdit = null; return; }
    if (wpc.wpMenu) { wpc.wpMenu = null; return; }
    if (wpc.stage) { wpc.exitStage(); return; }                  // 舞台中：先退回设置
    if (stack.length > (split ? 2 : 1)) { pop(); return; }   // 双栏：右侧分区第一页再返回＝关设置
    close();
  }
  // 关掉设置（根页返回钮、双栏左列的返回钮——那里右栏推到几层都直接关；右栏是调用策略子页且有没保存的改动时先由它问一句）
  function close() { if (closing) return; S.dp.dpLeave(() => { ui.homePop++; closing = true; setTimeout(() => { ui.settingsOpen = false; }, 360); }); }
  $effect(() => registerCloser('settings', back));
  // 键盘 Esc = 一次「返回」（电脑浏览器上用；原单页设置按 Esc 就关，合一后补回来）：先关弹层，子页退一页，根页关设置。
  // 让路：别人已经接住（扩展页的弹层在捕获阶段先 preventDefault）、供应商管理与服务端控制台自带 Esc、正在输入法组字。
  // 输入框里写着字（反馈正文、登录表单）时第一下只让它失焦，免得一按把写了一半的东西关掉；警告框里的输入框除外——
  // 那是「改一个值」的对话框，Esc 就该取消。开关、滑块这类 input 不算「输入框」。
  const TEXT_FIELD = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="password"], input[type="tel"], input[type="number"], [contenteditable="true"]';
  function onKey(e) {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || closing) return;
    if (hubUi.sheet || S.st.stModal || S.agy.agyModal || S.dp.dpModal || ui.serverAdminOpen) return;   // 浮层（模型中心的添加 / 编辑、调用策略子页里的选择器、服务端控制台等）自己接 Esc
    const a = document.activeElement;
    if (a && a.matches?.(TEXT_FIELD) && String(a.value ?? a.textContent ?? '').trim() && !a.closest('[role="alertdialog"]')) {
      e.preventDefault(); a.blur(); return;
    }
    e.preventDefault();
    back();
  }

  // —— 左缘右滑（跟手）：子页 = 返回上一页；根页 = 回主页 ——
  let dragX = $state(0);
  let dragging = $state(false);   // 手势/弹簧驱动位移期间关掉 CSS 过渡
  function closeByDrag() { ui.homePop++; closing = true; setTimeout(() => { ui.settingsOpen = false; }, 200); }
  const edgeSwipe = (node) => swipeDismiss(node, {
    axis: 'x', dir: 1, edge: 40, threshold: 0.32,
    size: () => panelW,
    // 舞台态、拖滑块中、弹层开着、正在转场时不接管；双栏时屏幕左缘是导航列，不接管（返回走顶栏钮与系统返回）。
    // 调用策略子页：拖判定线期间（dpDrag / 按在手柄上）不接管；有没保存的改动时也不接管——右滑没法停下来问，改走返回钮
    guard: (e) => !(split || S.wpc.stage || sliding || S.about.addrOpen || S.fb.fbOpen || S.wpc.wpMenu || S.acc.acctAsk || S.acc.pw || anyAgModal || closing || navBusy || S.dp.dpDrag || S.dp.dpOwnsTouch(e) || dispatchHasUnsaved()),
    base: () => (stack.length > 1 ? navX : dragX), cur: () => (stack.length > 1 ? navX : dragX),
    onStart: () => { navSp?.cancel(); swipeOn = true; dragging = true; if (stack.length > 1) navBusy = true; },
    onMove: (x) => { if (stack.length > 1) navX = x; else dragX = x; },
    onEnd: () => { swipeEndAt = performance.now(); },
    onSettle: (go) => { swipeOn = false; swipeEndAt = performance.now(); dragging = false; if (!go) { if (stack.length > 1) { navX = 0; navBusy = false; } else dragX = 0; } },
    onDismiss: () => { if (stack.length > 1) { stack.pop(); navX = 0; navBusy = false; } else closeByDrag(); },
  });
  $effect(() => () => { S.up.stopPoll(); navSp?.cancel(); });
  // 服务器换了地址、App 自动跟过去时（lib/server.js 地址簿）「关于」里的服务器地址那一行要跟着刷新
  S.about.watchBase();
</script>

<!-- 一页的内容按 pid 交给各分区的页组件（settings/ios/*Pages.svelte）；插件面板、扩展中心直接挂在这里 -->
{#snippet page(pid)}
  {#if pid === 'root' || pid === 'account'}<RootPages {pid} />
  {:else if pid === 'general' || pid === 'language' || pid === 'notify' || pid === 'notify-tone' || pid === 'notify-vibe'}<PrefsPages {pid} />
  {:else if pid === 'thinkmark'}<AgentPages {pid} />
  {:else if pid === 'appearance'}<PrefsPages {pid} />
  {:else if pid === 'home'}<HomeLayoutPanel variant="touch" />
  {:else if pid === 'page-grants'}<PageGrantsPanel variant="touch" />
  {:else if pid === 'wallpaper' || pid === 'flux'}<WallpaperPages {pid} />
  {:else if pid === 'agentapi'}<DevicePages {pid} />
  {:else if pid === 'model-hub'}<AgentPages {pid} />
  {:else if pid === 'phone' || pid === 'devices' || pid === 'fwd-new' || pid.startsWith('device:')}<DevicePages {pid} />
  {:else if pid === 'about' || pid === 'history'}<RootPages {pid} />
  {:else if pid === 'policy'}<AgentPages {pid} />
  {:else if pid === 'extensions'}
    <!-- seq：openPluginDetail 每次自增。设置已经开在「扩展」上时 Customize 不会重挂、只在挂载时读一次 extensionsNav.type，
         换 key 让它重挂一次，才会切到「功能扩展」、由 PluginsPanel 选中那个插件 -->
    {#key extensionsNav.seq}<Customize title={false} />{/key}
  {:else if pid.startsWith('plg-')}
    {@const pp = pluginPanels.list.find((x) => 'plg-' + x.id === pid)}
    {#if pp}<div class="plg-host">{#key pp.id}<PluginFrame id={pp.id} page={pp.page} mode="panel" onBack={pop} />{/key}</div>
    {:else}<p class="plg-gone">{t('这个插件面板不在了（插件被关掉或卸载了）')}</p>{/if}
  {:else if pid === 'studio' || pid.startsWith('st:') || pid.startsWith('agy:') || pid === 'ag-claude' || DISPATCH_PAGES.includes(pid) || pid.startsWith('ag-') || pid.startsWith('dm:')
    || pid.startsWith('dp:') || pid.startsWith('acct:') || CL_CHOICE[pid] || CL_GROUP[pid]}<AgentPages {pid} />
  {/if}
{/snippet}

<!-- 一页：页面层叠里的一层（手机），或双栏的左列 / 右栏里的一层。
     nav＝双栏左列的根页：常驻、不参与推入层叠；右栏的层叠从 stack[1] 起算（base），它是右栏底层、没有返回钮 -->
{#snippet pgSec(pid, i)}
  {@const nav = split && i === 0}
  {@const base = split ? 1 : 0}
  {@const top = nav || i === depth - 1}
  {@const under = !nav && i >= base && i === depth - 2}
  <section class="pg" class:top class:under class:hidden={!top && !under} class:wide={DISPATCH_PAGES.includes(pid)}
    style:transform={!nav && top && i > base ? `translate3d(${navX}px,0,0)` : under ? `translate3d(${-0.3 * (panelW - navX) * (navX < panelW ? 1 : 0)}px,0,0)` : null}
    style:--dim={under ? 0.1 * (1 - navX / Math.max(1, panelW)) : 0}
    aria-hidden={!top}>
    <div class="pg-scroll" onscroll={(e) => onPageScroll(pid, e)}>
      {#if !hasHero(pid)}<h1 class="lt">{titleOf(pid)}</h1>{/if}
      <div class="pg-body">{@render page(pid)}</div>
    </div>
    <div class="edge" class:on={(scrolled[pid] || 0) > 0}></div>
    <div class="bar">
      {#if split && i === base}<span class="bar-trail"></span>
      {:else}<GlassButton symbol="chevron.backward" weight={600} aria={t('返回')} onclick={() => (nav ? close() : i === 0 ? back() : pop())} />{/if}
      <span class="bar-title" class:on={(scrolled[pid] || 0) > 1}>{titleOf(pid)}</span>
      <span class="bar-trail"></span>
    </div>
  </section>
{/snippet}

<!-- ─────────────── 外壳 ─────────────── -->
<svelte:window onkeydown={onKey} />
<div class="settings ios" class:dark class:split class:closing class:previewing={!!sliding} class:staged={!!S.wpc.stage} class:modal={S.about.addrOpen || S.fb.fbOpen || !!S.wpc.wpMenu || !!S.acc.acctAsk || !!S.acc.pw || anyAgModal}
  class:covered={ui.serverAdminOpen || ui.agentsOpen} class:solid-cover={ui.serverAdminOpen && !ui.agentsOpen} style:--sq={`url("${sq26}")`} use:edgeSwipe>
  <div class="panel" class:dragging bind:clientWidth={panelBoxW} style:transform={dragX > 0 ? `translateX(${dragX}px)` : null}>
    {#if split}
      <!-- 双栏：左列＝根页（常驻导航），右栏＝stack[1…]（选中分区 + 它里面推入的子页） -->
      <div class="side">{@render pgSec('root', 0)}</div>
      <div class="detail" bind:clientWidth={detailW}>
        {#each stack as pid, i (pid + ':' + i)}{#if i > 0}{@render pgSec(pid, i)}{/if}{/each}
      </div>
    {:else}
      {#each stack as pid, i (pid + ':' + i)}{@render pgSec(pid, i)}{/each}
    {/if}
    <!-- 子 agent 调用策略子页的正文：挂在上面两种布局的分支之外，栈里有这一页就一直是同一个实例（单栏 / 双栏切换不重挂）；
         落座到那一页的空位（pDispatch 的 .dp-slot）里显示。它的浮层开着时经 onModal 告诉外壳（dpModal） -->
    {#if dpOpen}
      <!-- 哪一份调用策略跟着那一页走（dm-dispatch = dimensio 那份）；换了就整个重挂 -->
      {#key dpPage}
        <div class="dp-host" bind:this={dpHost}>
          {#await Promise.all([import('./claude/dispatch/DispatchPolicy.svelte'), import('../lib/dispatchPolicy.svelte.js')]) then [m, st]}
            <m.default shell="ios" store={dpPage === 'dm-dispatch' ? st.dimDispatch : st.claudeDispatch} onModal={(v) => { S.dp.dpModal = !!v; }} />
          {:catch}
            <p class="gfoot">{t('调用策略没加载出来：关掉设置再打开试试。')}</p>
          {/await}
        </div>
      {/key}
    {/if}
  </div>

  <!-- ── 壁纸实景舞台：设置页退开、主页即预览；上传壁纸的长按菜单（平铺在外壳里，玻璃要采得到底下的设置页） ── -->
  <WallpaperStage />

  <!-- 弹层：警告框与表单页 -->
  <SettingsDialogs />
</div>

<style>
  /* 整套样式在 settings/ios/kit.css（各页组件也 @import 同一份，各自带作用域）；这里只多一条整页的全局规则 */
  @import './settings/ios/kit.css';
  /* 舞台右上的「完成」正好压在主页账户胶囊上：舞台期间把胶囊收起（预览的是壁纸与入口，不是账户） */
  :global(body:has(.settings.staged) .lc-fade) { opacity: 0 !important; pointer-events: none; transition: opacity 200ms linear; }
</style>
