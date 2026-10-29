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
  import { ui, me, status, prefs, savePrefs, setHomeMode, applyFollowSys, setTheme, fluxParams, saveFlux, resetFlux, FLUX_SLIDERS, FLUX_COLORMODES, agentOn, rootScreen, pluginOn } from '../lib/state.svelte.js';
  import {
    devices, loadDevices, thisDeviceId, renameDevice, revokeDevice, deleteDevice, stopDevice,
    deviceStatusLine, forwards, loadForwards, addForward, dropForward, forwardShareUrl,
    thisComputer, setThisComputerMode, stopThisComputer,
  } from '../lib/devices.svelte.js';
  import { agentKeys, watchAgentKeys, createAgentKey, revokeAgentKey, dismissFresh, fmtKeyDay, copyText } from '../lib/agentKeys.svelte.js';
  import { relTime } from '../lib/format.js';
  import { serverOnThisMachine } from '../lib/nativeDesktop.js';
  import { signIn, signUp, signInToken, signOut, recentUsers, forgetUser } from '../lib/account.js';
  import { fetchMyUsage, changeMyPassword, quotaRows, hasLimits, costNote } from '../lib/me.js';
  import { fetchAdminAccess, saveAdminAccess, accessItems, accessDisclosure, logLine, onAdminAccess } from '../lib/adminAccess.js';
  import { startPairLogin } from '../lib/pair.js';
  import { normalizeServerAddress } from '../lib/connectPair.js';
  import ConnectQr from './pairing/ConnectQr.svelte';
  import { settingsNav } from '../lib/settingsNav.svelte.js';
  import { t, tc, tr, lang, setLang, LANGS } from '../lib/i18n.js';
  import { DISTRO, stripBrand, feedbackDest } from '../lib/distro.js';
  import { wp, wpDef, setWp, addUpload, deleteUpload, splitWpFiles, LIGHT_IDS, DARK_IDS, spatial, setSpatialOn, setSpatialAmp, wpHasDepth, wpIsUpload } from '../lib/wallpaper.svelte.js';
  import { registerCloser } from '../lib/nav.js';
  import { swipeDismiss, spring, NAV_SPRING } from '../lib/motion.js';
  import { setServerBase, getServerBase, isOffline, onServerBaseChange } from '../lib/server.js';
  import { updateState, installPending, hasSilentUpdate, checkForUpdate, startUpdate, appVersionLine,
    platform, nativeInfo, fetchLatest, fetchServerInfo, cancelUpdate, openInstallPermission, autoUpdateEnabled, setAutoUpdateEnabled, waitingLine } from '../lib/appUpdate.js';
  import { updateInfo } from '../lib/updateStore.svelte.js';
  import { createServerUpdate } from '../lib/serverUpdate.svelte.js';
  import { api, getToken } from '../lib/api.js';
  import { saPing } from '../lib/serverAdmin.svelte.js';
  import { ags, loadAgents, setAgentOn, agentById, loadPool, loadUsage, setRouter, activateAccount, moveAccount, addAccount, updateAccount, deleteAccount,
    accLabel, whyText, hhmm, poolResetIn, poolResetAt, usageTone, loadPolicy, savePolicy, apiKeyNote } from '../lib/agentSettings.svelte.js';
  import { filesFromInput, removeAttachment, uploadAttachment } from '../lib/attachments.js';
  import { cs, loadClaudeSettings } from '../lib/claudeSettings.svelte.js';
  // 模型服务（自定义 API）：管理面板盖在设置上，两套设置外壳共用（components/claude/providers）
  import ProviderManager from './claude/providers/ProviderManager.svelte';
  import { cp, loadProviders, cpSummaryText, canUseCustomApi } from '../lib/claudeProviders.svelte.js';
  // Claude Code 运行组件的下载进度 / 失败重试（安装包不再内嵌，首启服务端去拿；就绪时不显示）
  import ClaudeCliStatus from './ClaudeCliStatus.svelte';
  import VertexCredentials from './VertexCredentials.svelte';
  import { vx, VX, VERTEX_SETTING_GROUPS, loadVertexSettings, setVertexSetting, vxChanged, vxLabel, vxDesc, vxOptions, vxValueLabel, vxGroupLabel, vxGroupFoot, vxGroupKeys } from '../lib/vertexSettings.svelte.js';
  import { S as CS, val, visible, setVal, resetVal, changed, label as csLabel, options as csOptions, valueLabel, errText } from '../lib/claudeSettingsView.js';
  import { branchPrefixError } from '../../../src/config/claude-settings.mjs';
  import { extensionsNav } from '../lib/extensionsNav.svelte.js';
  import { goto } from '../lib/pageMorph.js';
  import Sym from './ios27/Sym.svelte';
  import ClaudeLogo from './ClaudeLogo.svelte';
  import ClaudeWorkingMark from './ClaudeWorkingMark.svelte';
  import ClaudeSpriteMark from './ClaudeSpriteMark.svelte';
  import Toggle from './ios27/Toggle.svelte';
  import Slider from './ios27/Slider.svelte';
  import Segmented from './ios27/Segmented.svelte';
  import GlassButton from './ios27/GlassButton.svelte';
  import Customize from './ext/Customize.svelte';
  import PluginFrame from './ext/PluginFrame.svelte';
  import { pluginPanels, watchPluginPanels, openPluginStandalone, inAndroidApp, panelTitle } from '../lib/pluginPanels.svelte.js';
  import { showToast } from '../lib/toast.svelte.js';
  import Alert from './ios27/Alert.svelte';
  import Sheet from './ios27/Sheet.svelte';
  import Menu from './ios27/Menu.svelte';
  import TextField from './ios27/TextField.svelte';
  import { SI, agentMark } from '../lib/settingsIcons.js';
  // 玻璃图层 / 平滑圆角遮罩：公开版自带的，私有 overlay 有同名原版就换成它（lib/overlay.svelte.js）
  import { ovUrl, ovMarks } from '../lib/overlay.svelte.js';
  import sq26_pub from '../assets/ios27/squircle26.svg';
  import stagePanelGlass_pub from '../assets/ios27/stagepanel-light.png';
  import stageCapGlass_pub from '../assets/ios27/stagecap44-light.png';
  const sq26 = $derived(ovUrl('ios27/squircle26.svg', sq26_pub));
  const stagePanelGlass = $derived(ovUrl('ios27/stagepanel-light.png', stagePanelGlass_pub));
  const stageCapGlass = $derived(ovUrl('ios27/stagecap44-light.png', stageCapGlass_pub));

  // 应用图标：满版方图（apple-touch-icon），iOS 图标形状由平滑圆角遮罩给
  const BASE = import.meta.env.BASE_URL;
  const appIcon = BASE + 'icons/apple-touch-icon.png';
  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  // —— 外观：跟全局界面主题（与 Claude 等分页一致；「分页跟随主页」开着时即主页明暗）——
  const dark = $derived(ui.theme !== 'light');
  setContext('ios27', { get dark() { return dark; }, ink: true });
  // 单页模式（只开着一个 agent，App 直接落在那一页、没有主页）也用这一套设置（2026-10-21 起，原 claude.ai 风那套下线）：
  // 跟主页 / 跨分页的东西在这里没意义——壁纸与流体壁纸、「分页跟随主页明暗」——藏掉。
  const single = $derived(rootScreen() !== 'home');
  const plat = platform();   // 'android' | 'web'（桌面壳走 SettingsDesktop，到不了这里）

  let closing = $state(false);
  let sliding = $state(null);
  let stage = $state(null);       // null | 'light' | 'dark' 壁纸实景舞台

  // —— 通用：开关 ——
  const load = (k, def = false) => { try { const v = localStorage.getItem(k); return v == null ? def : v === '1'; } catch { return def; } };
  let notifyOn = $state(load('bridge-notify', true));   // 通知默认开（与 notify.js 门禁约定一致）
  function toggleNotify() { notifyOn = !notifyOn; try { localStorage.setItem('bridge-notify', notifyOn ? '1' : '0'); } catch {} }
  function toggleFollowSys() { prefs.followSys = !prefs.followSys; savePrefs(); if (prefs.followSys) applyFollowSys(); }
  function toggleFollowPage() {
    prefs.followPage = !prefs.followPage; savePrefs();
    if (prefs.followPage) setTheme(ui.glassMode === 'B' ? 'light' : 'dark');   // 开启瞬间先对齐一次
  }
  // 外观页的明暗卡片：手动选一种＝不再跟随系统（同 iOS）；「分页跟随主页」开着时主页一起换，免得下次被拉回去
  function pickTheme(th) {
    if (prefs.followSys) { prefs.followSys = false; savePrefs(); }
    setTheme(th);
    if (prefs.followPage) setHomeMode(th === 'light' ? 'B' : 'A');
  }
  function toggleNoAnim() { prefs.noEnterAnim = !prefs.noEnterAnim; savePrefs(); }
  // 「原图加载」：画廊查看器主图直接拉原图（预载也按原图跑）；关=1280 轻量档+缩放时升原图。
  function toggleFullRes() { prefs.fullResMedia = !prefs.fullResMedia; savePrefs(); }
  // —— 设置 › Claude（2026-10-20 对齐官方 Desktop「Settings → Claude Code」）——
  // 注册表 src/config/claude-settings.mjs、数据面 lib/claudeSettings.svelte.js、取值与文案 lib/claudeSettingsView.js（两套外壳共用）。
  // Claude 页只放常用组（撞上限额时 / 服务意外重启时 / 新会话默认 / 对话 / 会话协作 / 安全），Git 与拉取请求、会话管理、通知、这台电脑、
  // 扩展与记忆折成推入行；枚举项推入单选子页（cl-<键>，每项一行说明）。输入建议、自动压缩点 10-20 起存服务端。
  // 「自动压缩点」在对话页用量弹层上拖；这里只给一个恢复默认（CLI 自定）的出口
  const CL_CHOICE = { 'cl-perm': 'permissionMode', 'cl-style': 'outputStyle', 'cl-qto': 'questionTimeout', 'cl-lang': 'replyLanguage',
    'cl-newsess': 'newSessionPolicy', 'cl-inbound': 'crossSessionInbound', 'cl-base': 'worktreeBaseRef', 'cl-attrib': 'attribution', 'cl-archive': 'autoArchiveDays' };
  const CL_GROUP = { 'cl-git': () => t('Git 与拉取请求'), 'cl-sessions': () => t('会话管理'), 'cl-notify': () => t('通知'), 'cl-host': () => t('这台电脑'), 'cl-ext': () => t('扩展与记忆') };
  const clErr = $derived(errText(cs.err));
  const GIT_KEYS = ['branchPrefix', 'worktreeBaseRef', 'autoFixPullRequests', 'autoArchiveOnPrClose', 'attribution'];
  // 允许绕过权限模式：打开前先确认（危险操作的解释放在确认框里，页面上不写）
  let bypassAsk = $state(false);
  function toggleCs(key) {
    const v = !val(key);
    if (key === 'allowBypass' && v) { bypassAsk = true; return; }
    setVal(key, v);
  }
  function confirmBypass() { bypassAsk = false; setVal('allowBypass', true); }
  // 分支前缀：警告框 + 文本框（同服务器地址那种），本地先按注册表校验，服务端再校验一次
  let prefixEdit = $state(null);   // null | { value, err, busy }
  function openPrefix() { cs.err = ''; prefixEdit = { value: val('branchPrefix') === CS.branchPrefix.default ? '' : val('branchPrefix'), err: '', busy: false }; }
  async function savePrefix() {
    const e = prefixEdit;
    if (!e || e.busy) return;
    const bad = branchPrefixError(e.value);
    if (bad) { e.err = tr(bad); return; }
    e.busy = true;
    if (await setVal('branchPrefix', e.value.trim() || null)) prefixEdit = null;
    else { e.err = errText() || t('分支前缀没保存上，请重试'); cs.err = ''; e.busy = false; }
  }
  // 子 agent 调度偏好：警告框 + 多行文本框（同反馈那种），空 = 恢复默认（由 Claude 按任务难度自己定）
  let dspEdit = $state(null);   // null | { value, err, busy }
  function openDispatch() { cs.err = ''; dspEdit = { value: val('subagentDispatch') || '', err: '', busy: false }; }
  async function saveDispatch() {
    const e = dspEdit;
    if (!e || e.busy) return;
    e.busy = true;
    if (await setVal('subagentDispatch', e.value.trim() || null)) dspEdit = null;
    else { e.err = errText() || t('没保存上，请重试'); cs.err = ''; e.busy = false; }
  }
  // 扩展与记忆：落到现有扩展中心（直达某个类型）/ Claude 分页的定时任务
  function openExtType(type) { extensionsNav.type = type; push('extensions'); }
  function openRoutinesPage() { ui.settingsOpen = false; goto('claude'); ui.routinesOpen = true; }
  // 「思考动画」：Claude 回复进行中那颗标记——新版 Claude Code 活动标记（默认）/ 原来的 claude.ai 星标。
  // 三套都是原版动画，只有维护者的私有 overlay 带着；公开版只有一颗自绘星标，选项没有区别——overlay 带了两套以上才显示这一行。
  const MARKS_ALL = [{ value: 'clay', label: () => t('新版 Claude Code') }, { value: 'sprite', label: () => t('新版聊天页') }, { value: 'classic', label: () => t('经典星标') }];
  const MARKS = $derived.by(() => { const av = ovMarks(); return MARKS_ALL.filter((m) => av[m.value]); });
  const showMarks = $derived(MARKS.length > 1);
  const markLabel = $derived((MARKS.find((x) => x.value === prefs.claudeMark) || MARKS[0] || MARKS_ALL[0]).label());
  function setMark(v) { prefs.claudeMark = v; savePrefs(); }
  // —— 手机操控（Phone Control · 实验性）：仅离线 apk 壳（有 window.AndroidStore 原生桥）里可用 ——
  const hasPhoneCtrl = typeof window !== 'undefined' && !!(window.AndroidStore && window.AndroidStore.startPhoneControl);
  function readPhoneCtrl() { try { return !!(window.AndroidStore && window.AndroidStore.isPhoneControlRunning && window.AndroidStore.isPhoneControlRunning()); } catch { return false; } }
  let phoneCtrlOn = $state(readPhoneCtrl());
  function togglePhoneCtrl() {
    if (!hasPhoneCtrl) return;
    try { if (phoneCtrlOn) window.AndroidStore.stopPhoneControl(); else window.AndroidStore.startPhoneControl(); } catch {}
    phoneCtrlOn = !phoneCtrlOn;
  }
  function readAcc() { try { return !!(window.AndroidStore && window.AndroidStore.isAccessibilityEnabled && window.AndroidStore.isAccessibilityEnabled()); } catch { return false; } }
  let accOn = $state(hasPhoneCtrl ? readAcc() : false);
  function grantAccessibility() { try { window.AndroidStore && window.AndroidStore.openAccessibilitySettings(); } catch {} }
  function readImeEnabled() { try { return !!(window.AndroidStore && window.AndroidStore.isBridgeImeEnabled && window.AndroidStore.isBridgeImeEnabled()); } catch { return false; } }
  function readImeDefault() { try { return !!(window.AndroidStore && window.AndroidStore.isBridgeImeDefault && window.AndroidStore.isBridgeImeDefault()); } catch { return false; } }
  let imeEnabled = $state(hasPhoneCtrl ? readImeEnabled() : false);
  let imeDefault = $state(hasPhoneCtrl ? readImeDefault() : false);
  function openImeSettings() { try { window.AndroidStore && window.AndroidStore.openImeSettings(); } catch {} }
  function showImePicker() { try { window.AndroidStore && window.AndroidStore.showImePicker(); } catch {} }
  function onImeRow() { if (!imeEnabled) openImeSettings(); else showImePicker(); }
  function readBattery() { try { return !!(window.AndroidStore && window.AndroidStore.isIgnoringBattery && window.AndroidStore.isIgnoringBattery()); } catch { return false; } }
  // 后台运行（电池优化白名单）不只是手机操控要：任务通知栏也靠它在后台活着——「通用」里也给一行
  const hasBatteryApi = typeof window !== 'undefined' && !!window.AndroidStore?.isIgnoringBattery;
  let batteryOk = $state(hasPhoneCtrl || hasBatteryApi ? readBattery() : false);
  function grantBattery() { try { window.AndroidStore && window.AndroidStore.requestIgnoreBattery(); } catch {} }
  function openAppDetails() { try { window.AndroidStore && window.AndroidStore.openAppDetails(); } catch {} }
  const hasFloatShell = typeof window !== 'undefined' && !!(window.AndroidStore && window.AndroidStore.startFloatingShell);
  function readFloatShell() { try { return !!(window.AndroidStore && window.AndroidStore.isFloatingShellRunning && window.AndroidStore.isFloatingShellRunning()); } catch { return false; } }
  let floatShellOn = $state(hasFloatShell ? readFloatShell() : false);
  function toggleFloatShell() {
    if (!hasFloatShell) return;
    try { if (floatShellOn) window.AndroidStore.stopFloatingShell(); else window.AndroidStore.startFloatingShell(); } catch {}
    floatShellOn = !floatShellOn;
  }
  let cutoutDbgOn = $state(false);
  try { cutoutDbgOn = localStorage.getItem('cutoutDebug') === '1'; } catch {}
  function toggleCutoutDbg() {
    cutoutDbgOn = !cutoutDbgOn;
    try { localStorage.setItem('cutoutDebug', cutoutDbgOn ? '1' : '0'); } catch {}
    try { window.dispatchEvent(new Event('cutout-debug')); } catch {}
  }
  function startCutoutCal() { try { window.dispatchEvent(new Event('cutout-calibrate')); } catch {} }
  // 从系统设置页返回时刷新各状态（visibilitychange）；授权回来事件即时翻开关。
  // 「关于」页的安装权限（去系统设置里开「安装未知应用」再回来）也在这里重读。
  $effect(() => {
    if (!hasPhoneCtrl && !hasFloatShell && !hasBatteryApi) return;
    const refresh = () => {
      accOn = readAcc(); batteryOk = readBattery(); phoneCtrlOn = readPhoneCtrl(); floatShellOn = readFloatShell(); imeEnabled = readImeEnabled(); imeDefault = readImeDefault();
      if (plat === 'android' && !document.hidden) appInfo = nativeInfo();
    };
    const onGranted = () => { floatShellOn = true; };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('bridge-overlay-granted', onGranted);
    return () => { document.removeEventListener('visibilitychange', refresh); window.removeEventListener('bridge-overlay-granted', onGranted); };
  });

  // —— 设备：我的电脑（Claude 经设备通道操作它）、端口转发 ——
  // 设备是账号级的，手机上也能管；「这台电脑」的档位只在桌面客户端里出现（thisComputer.supported）。
  // 数据面 lib/devices.svelte.js，与桌面设置（DevicesSection）同源。
  const hasDevices = $derived(me.kind === 'admin' || me.kind === 'user');
  // 根页上按内置功能（插件）显隐的几行：设置 › 扩展 › 功能扩展里关掉就不出现
  const phoneRow = $derived(hasPhoneCtrl && pluginOn('phone-control'));
  const devRow = $derived(hasDevices && pluginOn('devices'));
  const myDeviceId = thisDeviceId();
  let dvErr = $state('');
  let dvNote = $state('');
  let dvBusy = $state('');
  let dvName = $state('');
  let dvFwdDevice = $state('');
  let dvFwdPort = $state('');
  let dvFwdLabel = $state('');
  $effect(() => { if (hasDevices && !devices.loaded) loadDevices(); });
  const dvOnline = $derived(devices.list.filter((d) => d.online).length);
  const dvFwdChoices = $derived(devices.list.filter((d) => !d.revoked && (d.client?.caps || []).includes('http')).map((d) => ({ value: d.id, label: d.name })));
  const DV_TIERS = [
    { value: 'off', label: tc('开关', '关闭'), sub: t('服务器上看这台电脑是离线') },
    { value: 'observe', label: t('只看'), sub: t('能看屏幕、读界面；动手前先问你') },
    { value: 'control', label: t('操作'), sub: t('能点键鼠、跑命令、读写文件') },
  ];
  const dvThisFoot = $derived.by(() => {
    const d = thisComputer.device;
    const conn = thisComputer.mode === 'off' ? '' : d && d.connected ? t('已连上服务器。') : d && d.error ? t('没连上：{err}', { err: d.error }) + ' ' : t('正在连接服务器…') + ' ';
    return conn + (thisComputer.shortcut
      ? t('被操作时屏幕上方有提示条，随时可急停或按 {shortcut}。档位由这台电脑自己把关，服务器改不了。', { shortcut: thisComputer.shortcut })
      : t('被操作时屏幕上方有提示条，随时可急停。档位由这台电脑自己把关，服务器改不了。'));
  });
  async function dvRun(key, fn, okNote = '') {
    dvBusy = key; dvErr = ''; dvNote = '';
    try { await fn(); if (okNote) dvNote = okNote; return true; } catch (e) { dvErr = String(e?.message || e); return false; }
    finally { dvBusy = ''; }
  }
  // 设备与端口转发的拉取挂在「设备」页本身（见 stack 下面那个 effect），不挂在这一行的点击上
  function openDevices() { dvErr = ''; dvNote = ''; push('devices'); }
  function openDevice(d) { dvName = d.name; dvErr = ''; dvNote = ''; push('device:' + d.id); }
  function openFwdNew() {
    dvErr = ''; dvFwdPort = ''; dvFwdLabel = '';
    if (!dvFwdChoices.some((o) => o.value === dvFwdDevice)) dvFwdDevice = (dvFwdChoices.find((o) => o.value === myDeviceId) || dvFwdChoices[0] || {}).value || '';
    push('fwd-new');
  }
  async function copyDv(text) {
    try { await navigator.clipboard.writeText(text); dvNote = t('已复制'); dvErr = ''; } catch { dvErr = t('复制失败'); }
  }
  const renameDv = (d) => dvRun('name', () => renameDevice(d.id, dvName.trim()), t('已改名'));
  const stopDv = (d) => dvRun('stop', () => stopDevice(d.id), t('已断开，客户端会自动重连'));
  const revokeDv = (d) => dvRun('revoke', () => revokeDevice(d.id), t('已吊销：那台电脑要重新登录才能再连上'));
  async function deleteDv(d) { if (await dvRun('delete', () => deleteDevice(d.id), t('已删除'))) pop(); }
  const dropFwdDv = (f) => dvRun('fwd:' + f.token, () => dropForward(f.token), t('已删除，地址立即失效'));
  async function addFwdDv() {
    const ok = await dvRun('fwd', async () => {
      const port = Number(dvFwdPort);
      if (!dvFwdDevice) throw new Error(t('先选一台电脑'));
      if (!(port >= 1 && port <= 65535)) throw new Error(t('端口要在 1-65535 之间'));
      await addForward(dvFwdDevice, port, dvFwdLabel.trim());
    }, t('已接通'));
    if (ok) pop();
  }

  // —— 服务端设置入口：仅桌面服务端形态（含附着主机）显示 ——
  // 条件：服务端就在这台电脑上（桌面客户端连本机）或开着远程管理，且后端探针通过
  // （/api/admin/ping，本地管理员门；旧后端 404 → 入口不出现，绝不给一个点了报错的入口）。
  // 服务端形态（features.remoteAdmin）的管理员在手机 / 网页上也能进：后端闸门按形态放行远程管理。
  let srvAdminOk = $state(false);
  $effect(() => {
    const want = serverOnThisMachine() || (me.kind === 'admin' && !!me.features?.remoteAdmin);
    if (want && !srvAdminOk) saPing().then(() => { srvAdminOk = true; }).catch(() => {});
  });

  // —— 扩展中心入口：admin 探针通过才显示。门是 admin token/cookie（可远程），与控制台的 loopback 门不同——手机出门也能管扩展。
  // 成员探的是自己的技能接口（/api/my-extensions：只有技能，见 ext/Customize 的成员模式）。
  let extOk = $state(false);
  const extMember = me.kind === 'user';
  api.get(extMember ? '/api/my-extensions' : '/api/extensions').then(() => { extOk = true; }).catch(() => {});
  // —— 按 agent 分页（2026-10-18）：根页「Agent」分组每个 agent 一行，各自一页堆它自己的设置——
  // 开关与认证（/api/agents）、Claude 的订阅号池与智能换号、对话偏好……
  // 号池 / 额度与注册原先只在服务端控制台（本机门），服务端给它们开了 settingsGate 后手机上也能改；
  // 会影响连接的（服务控制、隧道、客户端配对、管理员会话）仍只在控制台。数据面见 lib/agentSettings.svelte.js。
  if (me.kind === 'admin') { loadAgents(); loadPool(); loadPolicy(); loadVertexSettings(); }
  // 「扩展 › 功能扩展」拨了开关（或别的设备改了）：App 经总线 agents.changed 刷 me.agents，这里跟着重拉，根列表即时增减
  let agentsSeen = JSON.stringify(me.agents);
  $effect(() => { const k = JSON.stringify(me.agents); if (k !== agentsSeen && me.kind === 'admin') { agentsSeen = k; untrack(loadAgents); } });
  // Claude 设置（按身份存服务端）：总线会推，开设置页时再拉一次兜底（从主页直接进设置时 Claude 页可能没挂）
  if (me.kind !== 'none') loadClaudeSettings();
  // 管理员：服务器上全部 agent（含这台机器跑不了的，行尾标「不可用」）；其他人：只有 Claude 有本机偏好可调。
  // 在「扩展 › 功能扩展」里关掉的 agent 直接不列（维护者 10-21）；开着但这台机器跑不起来的仍列出、变灰，点进去看原因。
  // Claude 是核心、不在功能扩展里，关了也得留着入口才开得回来。
  const agentRows = $derived((ags.agents?.agents?.length ? ags.agents.agents : agentOn('claude') ? [{ id: 'claude', label: 'Claude', local: true }] : [])
    .filter((a) => a.local || a.id === 'claude' || a.switch !== false));
  // agent 的品牌标（真标）：明暗两版的随界面明暗换
  const markSrc = (id) => { const m = agentMark(id, dark); return m ? ovUrl(m) : ''; };   // 私有 overlay 有同名原版就换
  const AG_AUTH_HINT = {
    claude: () => t('在下面「订阅号池」里添加账号。'),
    gemini: () => t('在下面「Google 云凭据」里上传凭据 JSON。'),
    codex: () => t('在服务器上运行一次 codex login。'),
    dimensio: () => t('在 dimensio 的 .env 里填一家模型厂商的 API key。'),
  };
  function agStatus(a) {
    if (!a || a.local) return '';
    if (!a.runnable) return tr(a.note) || t('这台机器上不可用');
    if (!a.switch) return tc('开关', '关闭');
    if (!a.authed) return t('还没配认证');
    return a.multiUser ? t('可用') : t('可用 · 仅管理员');
  }
  // 根页行尾的短状态：Claude 有号池时显示当前号；别的只在「关着 / 跑不了 / 没认证」时出声
  const activeAcct = $derived(ags.accounts.find((x) => x.active) || null);
  function agTail(a) {
    if (a.local) return '';
    if (!a.runnable) return t('不可用');
    if (!a.switch) return tc('开关', '关闭');
    if (a.id === 'claude' && ags.poolOk && activeAcct && ags.accounts.length > 1) return accLabel(activeAcct.label);
    if (!a.authed) return t('未认证');
    return '';
  }
  let agLast = $state(false);   // 关最后一个开着的 agent 前的确认
  async function toggleAgent(a) {
    if (!a?.runnable || ags.agentBusy) return;
    const next = !a.switch;
    if (!next && ags.agents.agents.filter((x) => x.enabled).length <= 1) { agLast = a; return; }
    await setAgentOn(a, next);
  }
  async function confirmAgLast() { const a = agLast; agLast = false; if (a) await setAgentOn(a, false); }

  // Claude 页：进页才拉逐号用量（服务端 5 分钟缓存；每号一次 max_tokens:1 探针，别在根页就打）
  const claudeOpen = $derived(stack.includes('ag-claude'));
  $effect(() => { if (claudeOpen && ags.poolOk) untrack(() => loadUsage()); });
  const routerOn = $derived(!!ags.router?.settings?.enabled);
  const acctById = (id) => ags.accounts.find((x) => x.id === id) || null;
  // 添加 / 编辑账号（表单页）、删除账号（警告框）
  let acctForm = $state(null);   // null | { id?, label, token, isNew, hasToken, tokenTail, busy }
  let acctDel = $state(null);    // null | account
  function openAddAcct() { ags.err = ''; acctForm = { label: '', token: '', isNew: true, busy: false, err: '' }; }
  function openEditAcct(a) { ags.err = ''; acctForm = { id: a.id, label: a.label, token: '', isNew: false, hasToken: a.hasToken, tokenTail: a.tokenTail, busy: false, err: '' }; }
  async function saveAcctForm() {
    const f = acctForm;
    if (!f || f.busy) return;
    if (f.isNew && !f.token.trim()) { f.err = t('token 不能为空'); return; }
    f.busy = true; f.err = '';
    const done = f.isNew ? await addAccount(f.label, f.token) : await updateAccount(f.id, f.label, f.token);
    // 表单里的错只在表单里说，别漏到背后那一页的脚注上
    if (done) acctForm = null; else { f.err = ags.err; ags.err = ''; f.busy = false; }
  }
  async function confirmAcctDel() {
    const a = acctDel; acctDel = null;
    if (a && await deleteAccount(a.id) && stack[stack.length - 1] === 'acct:' + a.id) pop();
  }

  // 额度与注册（多用户形态）：数字项点开一个警告框改；quota 整体替换，改一项带上其余三项
  const POLICY_FIELDS = [
    { k: 'dayTurns', label: () => t('每天最多几轮'), unit: () => tc('admin', '轮') },
    { k: 'weekTurns', label: () => t('最近 7 天最多几轮'), unit: () => tc('admin', '轮') },
    { k: 'dayCostUsd', label: () => t('每天最多花多少'), unit: () => t('美元') },
    { k: 'weekCostUsd', label: () => t('最近 7 天最多花多少'), unit: () => t('美元') },
    { k: 'maxUserTurns', label: () => t('全服同时最多几轮（注册用户合计）'), unit: () => tc('admin', '轮') },
  ];
  const policyVal = (k) => (k === 'maxUserTurns' ? ags.policy?.maxUserTurns : ags.policy?.quota?.[k]) || 0;
  let numEdit = $state(null);    // null | { k, label, value, tz?, busy }
  function openNum(f) { ags.err = ''; const v = policyVal(f.k); numEdit = { k: f.k, label: f.label(), value: v ? String(v) : '', busy: false }; }
  function openTz() { ags.err = ''; numEdit = { k: 'timezone', label: t('「每天」按哪个时区换日'), value: ags.policy?.timezone || 'Asia/Shanghai', tz: true, busy: false }; }
  async function saveNum() {
    const e = numEdit;
    if (!e || e.busy) return;
    e.busy = true;
    let patch;
    if (e.tz) patch = { timezone: e.value.trim() || 'Asia/Shanghai' };
    else if (e.k === 'maxUserTurns') patch = { maxUserTurns: Number(e.value) || 0 };
    else patch = { quota: { ...(ags.policy?.quota || {}), [e.k]: e.value.trim() === '' ? 0 : Number(e.value) || 0 } };
    if (await savePolicy(patch)) numEdit = null; else { e.err = ags.err; ags.err = ''; e.busy = false; }
  }
  // 弹层总闸（左缘右滑 guard / 外壳 class:modal 都读它）：Claude 页的绕过权限确认、分支前缀编辑也登记在这里
  let provOpen = $state(false);
  if (canUseCustomApi()) loadProviders();
  const anyAgModal = $derived(!!acctForm || !!acctDel || !!numEdit || !!agLast || bypassAsk || !!prefixEdit || !!dspEdit || provOpen);

  // —— 账户（设置 App 顶上那张 Apple 账户卡）：资料、用量、改密码、切换账号、退出；没登录时这一页就是登录页。
  // 原先这些散在主页右上的账户胶囊卡和 Claude 侧栏菜单里，退出登录也在菜单里——统一收进这里。
  // tier 'pro' = 「完全信任」档（S2-2 改名，存储值不变）
  const roleLabel = $derived(me.kind === 'admin' ? t('管理员') : me.kind === 'user' ? (me.tier === 'pro' ? t('完全信任用户') : t('普通用户')) : t('未登录'));
  const shownName = $derived(me.user || (me.kind === 'admin' ? 'Admin' : ''));
  const initial = $derived((shownName || '?').trim().charAt(0).toUpperCase());
  // 「扫一扫登录网页版」只给手机形态（apk / 触屏）；网页登录页的「扫码登录」反过来只给电脑
  const canScan = (() => { try { return isOffline() || matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  const acctOpen = $derived(stack.includes('account'));
  // 用量：进账户页才拉
  let mine = $state(null);
  $effect(() => {
    if (!acctOpen || me.kind === 'none') return;
    api.status().then((s) => { status.limits = s.limits || null; status.context = s.context || null; if (s.plan) status.plan = s.plan; status.updatedAt = Date.now(); }).catch(() => {});
    if (me.kind === 'user') fetchMyUsage().then((r) => { mine = r; }).catch(() => {});
    if (me.kind === 'user') loadAa();
  });
  // 管理员可见性（S2-7，lib/adminAccess.js）：成员自己决定管理员能不能看内容 / 代聊代答 / 看他的电脑，并看访问记录
  let aa = $state(null);
  const loadAa = () => fetchAdminAccess().then((r) => { aa = r && !r.admin ? r : null; }).catch(() => {});
  // 账户页开着时管理员刚看过 / 代操作过：访问记录当场刷新（提示由 lib/adminAccess.js 统一弹）
  $effect(() => (acctOpen && me.kind === 'user' ? onAdminAccess(() => loadAa()) : undefined));
  async function toggleAa(key) {
    if (!aa) return;
    const next = !aa.consents[key];
    aa.consents[key] = next;
    try { const r = await saveAdminAccess({ [key]: next }); if (r?.consents) aa.consents = r.consents; } catch { aa.consents[key] = !next; }
  }
  const lim = $derived(status.limits || {});
  const usePct = (b) => (b && typeof b.pct === 'number' ? Math.max(0, Math.min(100, Math.round(b.pct))) : null);
  function resetIn(b) {
    const s = b?.resetsAt ? Math.round((b.resetsAt - Date.now()) / 1000) : 0;
    if (s <= 0) return '';
    if (s < 3600) return t('{n} 分钟后重置', { n: Math.max(1, Math.round(s / 60)) });
    if (s < 86400) return t('{n} 小时后重置', { n: Math.round(s / 3600) });
    return t('{n} 天后重置', { n: Math.round(s / 86400) });
  }

  // 登录表单（未登录时账户页的内容）：login | register | token | qr
  let lgMode = $state('login');
  let lgUser = $state(''), lgPass = $state(''), lgPass2 = $state(''), lgInvite = $state(''), lgTok = $state('');
  let lgBusy = $state(false), lgErr = $state('');
  let recents = $state(recentUsers());
  function lgSwitch(m) { lgMode = m; lgErr = ''; }
  function lgReset() { lgUser = ''; lgPass = ''; lgPass2 = ''; lgInvite = ''; lgTok = ''; lgErr = ''; lgMode = 'login'; }
  async function lgSubmit(e) {
    e?.preventDefault?.();
    if (lgBusy) return;
    lgBusy = true; lgErr = '';
    try {
      if (lgMode === 'register') await signUp({ username: lgUser.trim(), password: lgPass, password2: lgPass2, invite: lgInvite.trim() });
      else if (lgMode === 'token') await signInToken(lgTok);
      else await signIn(lgUser.trim(), lgPass);
      lgReset(); recents = recentUsers();
    } catch (err) {
      lgErr = tr(err?.body?.error) || (lgMode === 'register' ? t('注册失败') : lgMode === 'token' ? t('令牌无效') : t('登录失败'));
    }
    lgBusy = false;
  }
  function pickRecent(name) { lgMode = 'login'; lgUser = name; lgPass = ''; lgErr = ''; setTimeout(() => document.querySelector('.settings .lg-pass input')?.focus(), 30); }
  function dropRecent(name) { forgetUser(name); recents = recentUsers(); }
  // 扫码登录（网页端出码、手机扫）：进 qr 模式即领票出码 + 长轮询，离开即停。
  // 回调里不读 pair（读了就成了本 effect 的依赖，写回触发自身重跑 → 每圈领一张新票把限流打满）。
  let pair = $state({ status: 'idle', svg: '', error: '' });
  let pairCtl = null;
  $effect(() => {
    if (!(acctOpen && me.kind === 'none' && lgMode === 'qr')) return;
    let svg = '';
    const ctl = startPairLogin((u) => {
      if (u.svg !== undefined) svg = u.svg;
      pair = { status: u.status, svg, error: u.error || '' };
      if (u.status === 'done') lgReset();
    });
    pairCtl = ctl;
    return () => { ctl.stop(); if (pairCtl === ctl) pairCtl = null; pair = { status: 'idle', svg: '', error: '' }; };
  });
  const pairMsg = $derived(pair.status === 'scanned' ? t('已扫描，请在手机上确认')
    : pair.status === 'approved' ? t('登录中…')
    : pair.status === 'rejected' ? t('已在手机上取消 · 点击刷新')
    : pair.status === 'error' ? t('{error} · 点击刷新', { error: tr(pair.error) || t('出错了') })
    : pair.status === 'expired' ? t('二维码已过期 · 点击刷新')
    : pair.status === 'pending' ? '' : t('生成中…'));

  // 改密码（注册用户）：表单页
  let pw = $state(null);   // null | { old, next, again, busy, err }
  let pwDone = $state(false);
  async function savePw() {
    if (!pw || pw.busy) return;
    if (pw.next.length < 8) { pw.err = t('新密码至少 8 位'); return; }
    if (pw.next !== pw.again) { pw.err = t('两次输入的新密码不一致'); return; }
    pw.busy = true; pw.err = '';
    try { await changeMyPassword(pw.old, pw.next); pw = null; pwDone = true; }
    catch (err) { pw.err = tr(err?.body?.error) || t('修改失败'); pw.busy = false; }
  }
  // 退出 / 切换账号都先确认。切换＝退出这台设备上的当前会话，账户页随即变成登录页（最近登录过的账号点一下即填）。
  let acctAsk = $state(null);   // null | 'logout' | 'switch'
  let acctBusy = $state(false);
  async function acctConfirm() {
    if (acctBusy) return;
    const kind = acctAsk;
    acctBusy = true;
    await signOut();
    acctBusy = false; acctAsk = null; mine = null; pwDone = false;
    lgReset(); recents = recentUsers();
    // 退出：回设置根页（账户卡变成「登录」）；切换：留在这一页，它此刻已是登录页
    if (kind === 'logout' && stack.length > 1) pop();
  }
  function openWorkspaceFromAcct() { ui.settingsOpen = false; ui.screen = 'files'; }
  function openScanFromAcct() { ui.pairScan = { mode: 'scan' }; }   // 全屏取景层（z 400）盖在设置上，扫完回到这里

  // —— 流体壁纸参数（仅暗主题 glassMode A 装载该壁纸时显示）——
  function fluxFmt(s, v) { return s.step ? (Math.round(v / s.step) * s.step).toFixed(s.step < 0.1 ? 2 : 1) : Math.round(v); }
  // pow2 的参数（流体尺寸）滑条按指数走：32/64/128/256/512 均分整条
  function fluxFrac(s) {
    const v = fluxParams[s.key] ?? s.min;
    const f = s.pow2 ? (Math.log2(v) - Math.log2(s.min)) / (Math.log2(s.max) - Math.log2(s.min)) : (v - s.min) / (s.max - s.min);
    return Math.max(0, Math.min(1, f));
  }
  function fluxInput(s, f) {
    if (s.pow2) { const a = Math.log2(s.min), b = Math.log2(s.max); fluxParams[s.key] = 2 ** Math.round(a + f * (b - a)); return; }
    const raw = s.min + f * (s.max - s.min);
    fluxParams[s.key] = s.step ? Math.round(raw / s.step) * s.step : Math.round(raw);
  }
  function fluxDown(s) { sliding = 'flux-' + s.key; ui.settingsPreview = true; }
  function fluxUp() { sliding = null; ui.settingsPreview = false; saveFlux(); }
  function pickColor(cm) { fluxParams.colormode = cm; saveFlux(); }

  // —— 壁纸 ——
  const homeSys = $derived(ui.glassMode === 'B' ? 'light' : 'dark');
  function bgStyle(id) {
    const d = wpDef(id);
    if (d.css) return `background:${d.css}`;
    return `background-image:url("${d.url}");background-size:cover;background-position:center 30%`;
  }
  const gridItems = (slot, ids) => [...ids, ...wp.uploads.map((u) => u.id)];
  function pickGrid(slot, id) {
    setWp(slot, id);
    setHomeMode(slot === 'light' ? 'B' : 'A');   // 点谁就实时预览谁的系统
  }
  function enterStage(sys) { setHomeMode(sys === 'light' ? 'B' : 'A'); stage = sys; ui.wpStage = true; }
  function stageSwap(sys) { setHomeMode(sys === 'light' ? 'B' : 'A'); stage = sys; }
  function exitStage() { stage = null; ui.wpStage = false; }
  async function onUpload(slot, e) {
    const files = [...(e.target?.files || [])];
    e.target.value = '';
    if (!files.length) return;
    const s = slot || stage || homeSys;
    wpErr = '';
    const pair = splitWpFiles(files);                     // 单张 = 普通壁纸；原图 + 深度图 = 空间壁纸
    if (!pair) { wpErr = t('要做空间壁纸，请只选原图和深度图两张，深度图文件名带 depth'); return; }
    try {
      const f = await compressImage(pair.image);          // 降采样到 ≤1600 再传，省工作空间体积
      const d = pair.depth && await compressImage(pair.depth);
      const id = await addUpload(f, s, d);                // POST 到工作空间「壁纸」文件夹
      setWp(s, id);
      if (!stage) setHomeMode(s === 'light' ? 'B' : 'A');
    } catch { wpErr = t('壁纸上传失败，重试'); }
  }

  // —— 上传壁纸管理（长按/右键 → 删除菜单）——
  let wpMenu = $state(null);
  let wpPressTimer = null, wpPressXY = null, wpSuppressClick = false;
  let wpErr = $state('');

  function wpPressDown(e, id) {
    if (!wpIsUpload(id)) return;
    wpPressXY = { x: e.clientX, y: e.clientY };
    wpPressTimer = setTimeout(() => openWpMenu(e, id), 450);
  }
  function wpPressMove(e) {
    if (!wpPressTimer || !wpPressXY) return;
    if (Math.hypot(e.clientX - wpPressXY.x, e.clientY - wpPressXY.y) > 9) { clearTimeout(wpPressTimer); wpPressTimer = null; }
  }
  function wpPressUp() { if (wpPressTimer) { clearTimeout(wpPressTimer); wpPressTimer = null; } }
  function openWpMenu(e, id) {
    if (!wpIsUpload(id)) return;
    wpPressTimer = null; wpSuppressClick = true;
    try { navigator.vibrate?.(8); } catch {}
    const W = 250, vw = window.innerWidth, vh = window.innerHeight;
    const x = Math.min(Math.max(12, e.clientX - W / 2), vw - W - 12);
    const y = Math.min(e.clientY + 14, vh - 150);
    wpMenu = { id, x, y };
  }
  function closeWpMenu() { wpMenu = null; }
  async function wpMenuDelete() {
    const id = wpMenu.id; wpMenu = null;
    await deleteUpload(id);
  }
  function consumeLongPress() { if (wpSuppressClick) { wpSuppressClick = false; return true; } return false; }
  function wpCardClick(slot, id) { if (consumeLongPress()) return; pickGrid(slot, id); }

  function onSpatialToggle() { setSpatialOn(stage, !spatial[stage].on); }

  // —— 软件更新（沿用原自动静默下载逻辑）——
  let upState = $state('idle');
  let progress = $state(0);
  let upMsg = $state(t('检查更新'));
  let pollTimer = null;
  syncUpdateState();
  function syncUpdateState() {
    const st = updateState();
    if (st.state === 'ready') { upState = 'installable'; upMsg = t('一键更新'); }
    else if (st.state === 'downloading') { upState = 'downloading'; progress = (st.pct || 0) / 100; upMsg = t('正在下载'); pollState(); }
    // 桌面壳托管着本机服务端、正等对话跑完去装（S1-5；取消 / 立即安装在桌面设置「连接与更新」里）
    else if (st.state === 'waiting-idle') { upState = 'checking'; upMsg = waitingLine(st); pollState(); }
    else if (st.state === 'handing-off') { upState = 'checking'; upMsg = t('正在拉起安装…'); pollState(); }
  }
  function pollState() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      const st = updateState();
      if (st.state === 'ready') { progress = 1; upState = 'installable'; upMsg = t('一键更新'); clearInterval(pollTimer); }
      else if (st.state === 'downloading') { progress = (st.pct || 0) / 100; }
      else if (st.state === 'waiting-idle' || st.state === 'handing-off' || st.state === 'installing') { upState = 'checking'; upMsg = st.state === 'waiting-idle' ? waitingLine(st) : t('正在拉起安装…'); }
      else { upState = 'error'; upMsg = t('下载失败，点击重试'); clearInterval(pollTimer); }
    }, 500);
  }
  function onUpClick() {
    if (upState === 'downloading' || upState === 'checking') return;
    if (upState === 'installable') {
      upState = 'checking'; upMsg = t('正在拉起安装…');
      installPending().then((r) => {
        if (!r) { upState = 'installable'; return; }   // 安卓壳：交给系统安装器，按钮照旧（文案停在「正在拉起安装…」）
        // 桌面壳：用户取消 / 这次没装（壳回到「可以装」）时按钮还原；在等空闲 / 交接中就跟着壳的状态走
        if (r.cancelled || r.ok === false) { upState = 'installable'; upMsg = t('一键更新'); }
        else if (r.waiting) { upMsg = waitingLine(r); pollState(); }
        else pollState();
      });
      return;
    }
    checkUpdate();
  }
  async function checkUpdate() {
    upState = 'checking'; upMsg = t('检查中…');
    let checked;
    try { checked = await checkForUpdate(); }
    catch { upState = 'error'; upMsg = t('连不上服务器'); return; }
    if (!checked?.available) {
      // 说清楚为什么没有可装的（S1-4：App 只认所连这台服务器发的包）
      upState = 'latest';
      upMsg = checked?.blocked ? (updateInfo.blockedReason === 'package' ? t('包名不同，不能覆盖安装') : t('签名不同，需卸载重装'))
        : checked?.noBuild ? t('服务器没有可发的版本')
        : checked?.appNewer ? t('App 比服务器新')
        : t('已是最新版本');
      return;
    }
    startDownload(checked.latest || {});
  }
  async function startDownload(latest) {
    const A = window.AndroidStore;
    if (hasSilentUpdate()) {
      upState = 'downloading'; progress = 0; upMsg = t('正在下载');
      try { await startUpdate(latest); } catch { upState = 'error'; upMsg = t('下载失败'); return; }
      pollState();
    } else if (A && A.startUpdate) {
      upState = 'downloading'; progress = 0; upMsg = t('正在下载');
      try { await startUpdate(latest); } catch { upState = 'error'; upMsg = t('下载失败'); return; }
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        let p = -1;
        try { p = A.updateProgress(); } catch {}
        if (p >= 100) { progress = 1; upState = 'done'; upMsg = t('下载完成，安装中…'); clearInterval(pollTimer); }
        else if (p === -2) { upState = 'error'; upMsg = t('下载失败'); clearInterval(pollTimer); }
        else if (p >= 0) { progress = p / 100; }
      }, 500);
    } else {
      await startUpdate(latest);
      upState = 'done'; upMsg = t('已在浏览器下载');
    }
  }

  // 版本：「The Bridge · v5.67（380）」——根页应用卡片与「关于」页显示。
  let verLine = $state(DISTRO.brand);
  appVersionLine().then((line) => { verLine = line; }).catch(() => {});
  const verShort = $derived(stripBrand(verLine));
  // 放弃正在下载 / 已下好的更新包（「关于」页；新壳才有这个桥，旧壳 cancelUpdate 回 false 就不动状态）
  function discardUpdate() {
    if (!cancelUpdate()) return;
    clearInterval(pollTimer);
    upState = 'idle'; progress = 0; upMsg = t('检查更新');
  }

  // —— 关于（2026-10-21 并进原单页设置「关于与更新」「连接」两页的内容）——
  // 软件更新、自动检查更新、安装权限、新版本说明、版本历史、这台手机的信息；服务器那头的公网地址 / 后端运行多久。
  let appInfo = $state(plat === 'android' ? nativeInfo() : null);   // 装着的这一份 apk（+ 系统、机型、能否装包）
  let autoUp = $state(autoUpdateEnabled());
  function toggleAutoUp() { autoUp = !autoUp; setAutoUpdateEnabled(autoUp); }
  const upLatest = $derived(updateInfo.latest);
  const upHistory = $derived(upLatest?.history || []);
  const installedCode = $derived(plat === 'android' ? (appInfo?.code || 0) : (upLatest?.code || 0));
  const newerNotes = $derived(plat === 'android' && upLatest && upLatest.available !== false && (upLatest.code || 0) > installedCode ? upLatest : null);
  const aboutFoot = $derived(plat !== 'android' ? '' : [
    autoUp ? t('打开 app 时检查，发现新版就在后台下好并通知你，装不装由你决定') : '',
    appInfo && appInfo.canInstall === false ? t('安卓要求先允许「安装未知应用」，否则点安装会被系统拦下') : '',
    hasSilentUpdate() ? '' : t('这个安装包版本较旧，更新会交给浏览器下载，下载完手动安装'),
  ].filter(Boolean).join(' '));
  // /api/app/server-info（要登录）：{ app, multiUser, publicOrigin, server:{ uptimeSec, node } }。
  // 没有隧道状态——接口从来不给 tunnel 字段（原单页「连接」页那一行读的是空气），要显示得先让服务端给。
  let srvInfo = $state(null);
  let pubCopied = $state(false);
  async function copyPublic() {
    try { await navigator.clipboard.writeText(srvInfo.publicOrigin); pubCopied = true; setTimeout(() => { pubCopied = false; }, 1500); } catch {}
  }
  function fmtUptime(s) {
    s = Math.floor(Number(s) || 0);
    if (s < 60) return t('{n} 秒', { n: s });
    const m = Math.floor(s / 60);
    if (m < 60) return t('{n} 分钟', { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? t('{h} 小时 {m} 分钟', { h, m: m % 60 }) : t('{n} 小时', { n: h });
    const d = Math.floor(h / 24);
    return h % 24 ? t('{n} 天 {h} 小时', { n: d, h: h % 24 }) : t('{n} 天', { n: d });
  }
  function fmtDay(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // —— 服务器地址（iOS 警告框 + 文本框）/ 反馈（表单页）——
  let addrOpen = $state(false), addrInput = $state(''), addrBusy = $state(false), addrErr = $state('');
  let fbOpen = $state(false), fbText = $state(''), fbBusy = $state(false), fbDone = $state(false), fbErr = $state('');
  let fbAtts = $state([]), fbFileInput = $state();
  function openAddr() { addrInput = getServerBase() || ''; addrErr = ''; addrOpen = true; }
  let connectOpen = $state(false);   // 关于页「让另一台设备扫码连接」点开才出码（S1-2）
  $effect(() => { if (!aboutOpen) connectOpen = false; });
  function openFeedback() { fbText = ''; fbErr = ''; fbDone = false; fbAtts = []; fbSentUp = ''; fbConsent = false; fbOpen = true; loadFbUp(); }
  // 反馈去向（/api/feedback/upstream）：默认只留在这台服务器上。管理员在这张表单里主动打开「把用户反馈同时发给 bridge 开发者」
  // （默认关）之后，提交的人还要自己勾「这条也发给 bridge 开发者」（fbConsent，每次打开表单都是不勾）才发。
  // 没配中继地址（reason=no-relay）、不是正式实例时不出开关；开发者自己那台（mode=inbox）是汇总端，不出提示也不出开关。
  let fbUp = $state(null), fbUpBusy = $state(false), fbSentUp = $state(''), fbConsent = $state(false);
  function loadFbUp() { api.get('/api/feedback/upstream').then((r) => { fbUp = r; }).catch(() => {}); }
  // 去向文案里的「发给谁」：发行版声明的（服务端回的 dest 优先，其次注入的 DISTRO.feedback），没声明 = 本体的「bridge 开发者」
  const fbDest = $derived(feedbackDest(fbUp?.dest, lang()));
  async function toggleFbUp() {
    if (fbUpBusy || !fbUp) return;
    fbUpBusy = true;
    try { fbUp = await api.post('/api/feedback/upstream', { enabled: fbUp.mode !== 'push' }); }
    catch (e) { fbErr = t('没改成：{reason}', { reason: tr(e?.body?.error || e?.message) || t('连不上服务器') }); loadFbUp(); }
    finally { fbUpBusy = false; }
  }
  // 推送端由下面的勾选行自己写明发什么；其余一句话说清只留本机。没配中继 / 不是正式实例（reason 有值）时开关根本不出现，
  // 不提开关名；有中继、管理员没开时才提。管理员多看一句反馈库在服务器上的位置（单人服务器自己就是管理员）
  const fbUpNote = $derived.by(() => {
    if (!fbUp || fbUp.mode === 'inbox' || fbUp.mode === 'push') return '';
    const notOn = !fbUp.reason;
    if (fbUp.admin && fbUp.libraryDir) return (notOn ? t('这台服务器没开「把用户反馈同时发给 {to}」。', { to: fbDest.to }) + ' ' : '')
      + t('反馈只留在这台服务器上，存放在 {dir}。', { dir: fbUp.libraryDir });
    return notOn ? t('这台服务器没开「把用户反馈同时发给 {to}」，反馈只留在服务器上，由管理员查看。', { to: fbDest.to })
      : t('反馈只留在这台服务器上，由管理员查看。');
  });
  const fbUpAdminSub = $derived(!fbUp?.admin ? ''
    : t('默认关。打开后，提交页会多一个「这条也发给 {to}」，提交的人自己勾了才发。', { to: fbDest.to }) + (fbDest.public ? ' ' + t('这个去向是公开的：提交的内容任何人都能看到，请提醒大家别写隐私、账号和密钥。') : '')
      + (fbUp.relayHost ? ' ' + t('发往 {host}。', { host: fbUp.relayHost }) : ''));
  // 汇总端（开发者自己那台）只给管理员看拉取状态：令牌对不上、中继没部署时一眼能看出来，不会悄悄一直失败
  const fbWhen = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const fbInboxLine = $derived(!fbUp?.admin || fbUp.mode !== 'inbox' ? ''
    : fbUp.reason === 'no-relay' || fbUp.lastPullError === 'no relay'
      ? t('这台是汇总端，但没配中继地址，拉不了外部反馈：在 config.json 写 feedbackRelay，或设环境变量 BRIDGE_FEEDBACK_RELAY。')
    : fbUp.lastPullError ? t('这台是汇总端，拉取外部反馈出错（{at}）：{err}', { at: fbWhen(fbUp.lastPullAt), err: fbUp.lastPullError })
      + (/^relay 401/.test(fbUp.lastPullError) ? ' ' + t('收件令牌（config.json 的 feedbackInbox.token）和中继的 INBOX_TOKEN 对不上。')
        : /^relay 404/.test(fbUp.lastPullError) ? ' ' + t('中继还没部署收件箱，或没配 INBOX_TOKEN。') : '')
    : fbUp.lastPullOkAt ? t('这台是汇总端：上次拉取 {at}，累计收到 {n} 条外部反馈。', { at: fbWhen(fbUp.lastPullOkAt), n: fbUp.pulledTotal || 0 })
    : t('这台是汇总端：启动后约 20 秒第一次拉取外部反馈。'));
  async function compressImage(file) {
    if (!(file.type || '').startsWith('image/') || file.type === 'image/gif') return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (scale >= 1 && file.size < 600 * 1024) { bmp.close && bmp.close(); return file; }
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const cvs = document.createElement('canvas'); cvs.width = w; cvs.height = h;
      cvs.getContext('2d').drawImage(bmp, 0, 0, w, h); bmp.close && bmp.close();
      const blob = await new Promise((res) => cvs.toBlob(res, 'image/jpeg', 0.82));
      if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
      return file;
    } catch { return file; }
  }
  async function uploadFb(file, att) {
    return await api.uploadBlob(file.name, file, {
      onProgress: (p) => { if (att) att.progress = p; },
    });
  }
  async function onFbFiles(e) {
    const files = filesFromInput(e);
    for (const raw of files) {
      const isImg = (raw.type || '').startsWith('image/'), isVid = (raw.type || '').startsWith('video/');
      if (!isImg && !isVid) { fbErr = t('只能加图片或视频'); continue; }
      const f = isImg ? await compressImage(raw) : raw;
      await uploadAttachment(fbAtts, f, {
        draft: { name: f.name, kind: isImg ? 'image' : 'video', url: isImg ? URL.createObjectURL(f) : null, path: null, pending: true, progress: 0 },
        upload: uploadFb,
        applyResult: (att, result) => { att.path = result.path; att.pending = false; att.progress = 1; },
        onError: () => { fbErr = t('上传失败（弱网超时，可重试）：{name}', { name: raw.name }); },
      });
    }
  }
  function removeFbAtt(a) { removeAttachment(fbAtts, a); }
  async function submitFeedback() {
    if (fbDone) { fbOpen = false; return; }
    if (fbAtts.some((a) => a.pending)) { fbErr = t('附件还在上传…'); return; }
    const text = fbText.trim();
    if (!text && !fbAtts.length) { fbErr = t('写点什么、或加个图片/视频吧'); return; }
    fbBusy = true; fbErr = '';
    try {
      const attachments = fbAtts.filter((a) => a.path).map((a) => ({ path: a.path, name: a.name, kind: a.kind }));
      // shareWithDeveloper：提交的人自己勾了「这条也发给 bridge 开发者」才带 true，服务端才推（没带的只落本机）
      const r = await api.post('/api/feedback', { text, screen: ui.screen, attachments, shareWithDeveloper: fbUp?.mode === 'push' && fbConsent === true });
      if (r && r.ok === false) throw new Error(r.error || 'fail');
      fbSentUp = (r && r.upstream) || '';
      fbDone = true; fbText = ''; fbAtts = [];
    } catch (e) {
      const msg = e && (e.body?.error || e.message);
      fbErr = t('提交失败：{reason}', { reason: msg ? tr(msg) : t('连不上服务器') });
    }
    finally { fbBusy = false; }
  }
  async function connectAddr() {
    if (addrBusy) return;
    let a = addrInput.trim();
    if (!a) { addrErr = t('请输入地址'); return; }
    a = normalizeServerAddress(a) || a.replace(/\/+$/, '');   // 局域网 / 本机地址补 http，其余补 https（S1-2）
    addrBusy = true; addrErr = '';
    setServerBase(a);
    try {
      const r = await fetch(a + '/api/auth', { headers: getToken() ? { Authorization: 'Bearer ' + getToken() } : {} });
      if (r.ok || r.status === 401) { location.reload(); return; }
      addrErr = t('连接异常（HTTP {status}），检查地址', { status: r.status });
    } catch { addrErr = t('连不上这个地址，确认电脑 server 开着、地址没填错'); }
    addrBusy = false;
  }

  // —— 导航栈（设置 App 的推入 / 返回）——
  // 页面层叠渲染：顶层页 x = navX（px，0＝就位，W＝移出右侧），下一层随之在 −30%·W…0 之间视差平移并压暗；
  // 推入 / 返回都用弹簧驱动 navX（NAV_SPRING），左缘右滑直接跟手改 navX，松手由 swipeDismiss 的弹簧续写。
  const TITLES = {
    root: () => t('设置'), general: () => t('通用'), language: () => t('语言'), thinkmark: () => t('思考动画'), appearance: () => t('外观'),
    wallpaper: () => t('壁纸'), flux: () => t('流体壁纸'), agentapi: () => t('Agent 接入'),
    phone: () => t('手机操控'), devices: () => t('设备'), 'fwd-new': () => t('新的转发'), about: () => t('关于'), history: () => t('版本历史'),
    account: () => (me.kind === 'none' ? t('登录') : t('账户')), policy: () => t('额度与注册'), extensions: () => t('扩展'),
    ...CL_GROUP,
    ...Object.fromEntries(Object.entries(CL_CHOICE).map(([pid, key]) => [pid, () => csLabel(key)])),
  };
  // agent 页 'ag-<id>'、号池里某个账号 'acct:<id>' 的标题跟着数据走
  // 第三方插件的控制面板（清单 ui.panel）：根页「插件」组一行一个。网页里推入一页嵌插件页面（PluginFrame）；
  // 手机 App 交给原生另起的干净 WebView——App 的原生桥会注入所有帧，插件页面不能嵌在主页面里。
  watchPluginPanels();
  function openPlg(pp) {
    if (inAndroidApp()) { openPluginStandalone(pp.id, { title: panelTitle(pp) }).catch((e) => showToast(tr(e?.body?.error || e?.message || String(e)), 'err')); return; }
    push('plg-' + pp.id);
  }
  function titleOf(pid) {
    if (TITLES[pid]) return TITLES[pid]();
    if (pid.startsWith('plg-')) return panelTitle(pluginPanels.list.find((x) => 'plg-' + x.id === pid));
    if (pid.startsWith('ag-')) { const id = pid.slice(3); return agentById(id)?.label || (id === 'claude' ? 'Claude' : id); }
    if (pid.startsWith('vx:')) return VX[pid.slice(3)] ? vxLabel(pid.slice(3)) : '';
    if (pid.startsWith('acct:')) return accLabel(acctById(pid.slice(5))?.label || '') || t('账号');
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
    if (s.startsWith('ag-')) return ['root', s];
    if (s === 'connection' || s === 'connect') return ['root', 'about'];   // 服务器地址、线路、公网地址都在「关于」
    if (s === 'devices' || s === 'localpc') return hasDevices ? ['root', 'devices'] : ['root'];
    if (s === 'phone') return hasPhoneCtrl ? ['root', 'phone'] : ['root'];
    if (s === 'wallpaper') return single ? ['root'] : ['root', s];
    if (s === 'agentapi' || s === 'agent-api') return hasDevices ? ['root', 'agentapi'] : ['root'];
    if (s === 'account' || s === 'about' || s === 'general' || s === 'appearance' || s === 'language') return ['root', s];
    if (s.startsWith('plg-')) return ['root', s];   // 插件面板（手机 App 里不进这里：交给原生页面，见 openPlg）
    return ['root'];
  }
  // 反馈是根页上弹出的表单页（Sheet），不是推入页：直达 = 叠在根页上把它弹出来
  const isFeedbackSec = (s) => s === 'feedback' || s === 'help';
  const deep = settingsNav.sec;
  settingsNav.sec = null;
  let stack = $state(deepStack(deep));
  if (isFeedbackSec(deep)) openFeedback();
  let navX = $state(0);
  let navBusy = $state(false);
  let navSp = null;
  let panelW = $state(400);
  const depth = $derived(stack.length);
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
    if (stack.length < 2) return;
    navSp?.cancel();
    navBusy = true;
    navSp = spring({ from: navX, to: panelW, velocity, ...NAV_SPRING.close, restDist: 0.4, restVel: 4,
      onUpdate: (x) => (navX = x), onDone: () => { stack.pop(); navX = 0; navBusy = false; } });
  }
  // 开着时外部又点了「直达某分区」（分屏格里的「打开设置」等）：直接换到那一页
  $effect(() => {
    const s = settingsNav.sec;
    if (!s) return;
    untrack(() => {
      settingsNav.sec = null;
      if (isFeedbackSec(s)) { openFeedback(); return; }
      const want = deepStack(s);
      if (want.length > 1 && stack[stack.length - 1] !== want[1]) { navSp?.cancel(); navX = 0; navBusy = false; stack = want; }
    });
  });
  // 「设备」页一露面就拉设备与端口转发：根页那一行点进来、外部直达（输入框电脑芯片「管理设备…」）、
  // 从单台设备 / 新的转发页退回来都走这里（10-21 回归 R3：以前只有点根页那一行才拉，直达时端口转发列表是空的）
  $effect(() => { if (stack[stack.length - 1] === 'devices' && hasDevices) untrack(() => { loadDevices(true); loadForwards(); }); });
  // 「Agent 接入」页露面期间拉密钥列表、听总线 agent.keys；退出这一页就丢掉没看完的明文密钥
  const akOpen = $derived(stack.includes('agentapi'));
  $effect(() => { if (akOpen) return untrack(() => watchAgentKeys()); });
  let akLabel = $state('');
  let akAsk = $state('');
  let akNote = $state('');
  let akNoteTimer = 0;
  function akFlash(text) { akNote = text; clearTimeout(akNoteTimer); akNoteTimer = setTimeout(() => { akNote = ''; }, 1800); }
  async function akCopy(text, okText = t('已复制')) { akFlash((await copyText(text)) ? okText : t('复制失败')); }
  async function akCreate() { if (akLabel.trim() && !agentKeys.busy && await createAgentKey(akLabel)) akLabel = ''; }
  async function akRevoke(id) { akAsk = ''; if (await revokeAgentKey(id)) akFlash(t('已吊销，用这把密钥的 agent 立刻失去访问')); }
  const akMeta = (k) => [
    t('创建于 {date}', { date: fmtKeyDay(k.created) }),
    k.seen ? t('最近使用 {when}', { when: relTime(k.seen) }) : t('还没用过'),
    k.expiresAt ? t('{date} 到期', { date: fmtKeyDay(k.expiresAt) }) : '',
  ].filter(Boolean).join(' · ');
  // 「关于」进页才拉：服务器上的版本与历史（5 分钟内拉过就不重复打）、服务器状态（要登录）、这一份 apk 的信息
  const aboutOpen = $derived(stack.includes('about'));
  $effect(() => {
    if (!aboutOpen) return;
    untrack(() => {
      if (!updateInfo.latest || Date.now() - updateInfo.checkedAt > 5 * 60_000) fetchLatest().catch(() => {});
      if (me.kind !== 'none') fetchServerInfo().then((r) => { srvInfo = r; }).catch(() => {});
      if (me.kind === 'admin') srvUpd.load();
      if (plat === 'android') appInfo = nativeInfo();
    });
  });
  // 服务端更新（管理员，lib/serverUpdate.svelte.js）：手机 / 网页上也能查 GitHub 上的版本、一键更新服务端（10-28 以前只能到服务端那台电脑上点）
  const srvUpd = createServerUpdate();
  const srvUpdView = $derived(srvUpd.view);

  // 每页的滚动状态：大标题滚到顶栏下 → 顶栏小标题出现；有内容滚到顶栏下 → 滚动边缘效果显形
  let scrolled = $state({});
  const hasHero = (pid) => pid === 'about' || pid === 'account' || pid.startsWith('ag-') || pid.startsWith('acct:') || pid.startsWith('device:');
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
    if (addrOpen) { addrOpen = false; return; }
    if (fbOpen) { fbOpen = false; return; }
    if (acctAsk) { if (!acctBusy) acctAsk = null; return; }
    if (pw) { pw = null; return; }
    if (acctForm) { if (!acctForm.busy) acctForm = null; return; }
    if (acctDel) { acctDel = null; return; }
    if (numEdit) { if (!numEdit.busy) numEdit = null; return; }
    if (agLast) { agLast = false; return; }
    if (bypassAsk) { bypassAsk = false; return; }
    if (prefixEdit) { if (!prefixEdit.busy) prefixEdit = null; return; }
    if (dspEdit) { if (!dspEdit.busy) dspEdit = null; return; }
    if (wpMenu) { wpMenu = null; return; }
    if (stage) { exitStage(); return; }                  // 舞台中：先退回设置
    if (stack.length > 1) { pop(); return; }
    ui.homePop++; closing = true; setTimeout(() => { ui.settingsOpen = false; }, 360);
  }
  $effect(() => registerCloser('settings', back));
  // 键盘 Esc = 一次「返回」（电脑浏览器上用；原单页设置按 Esc 就关，合一后补回来）：先关弹层，子页退一页，根页关设置。
  // 让路：别人已经接住（扩展页的弹层在捕获阶段先 preventDefault）、供应商管理与服务端控制台自带 Esc、正在输入法组字。
  // 输入框里写着字（反馈正文、登录表单）时第一下只让它失焦，免得一按把写了一半的东西关掉；警告框里的输入框除外——
  // 那是「改一个值」的对话框，Esc 就该取消。开关、滑块这类 input 不算「输入框」。
  const TEXT_FIELD = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="password"], input[type="tel"], input[type="number"], [contenteditable="true"]';
  function onKey(e) {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || closing) return;
    if (provOpen || ui.serverAdminOpen) return;
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
    // 舞台态、拖滑块中、弹层开着、正在转场时不接管
    guard: () => !(stage || sliding || addrOpen || fbOpen || wpMenu || acctAsk || pw || anyAgModal || closing || navBusy),
    base: () => (stack.length > 1 ? navX : dragX), cur: () => (stack.length > 1 ? navX : dragX),
    onStart: () => { navSp?.cancel(); swipeOn = true; dragging = true; if (stack.length > 1) navBusy = true; },
    onMove: (x) => { if (stack.length > 1) navX = x; else dragX = x; },
    onEnd: () => { swipeEndAt = performance.now(); },
    onSettle: (go) => { swipeOn = false; swipeEndAt = performance.now(); dragging = false; if (!go) { if (stack.length > 1) { navX = 0; navBusy = false; } else dragX = 0; } },
    onDismiss: () => { if (stack.length > 1) { stack.pop(); navX = 0; navBusy = false; } else closeByDrag(); },
  });
  $effect(() => () => { clearInterval(pollTimer); navSp?.cancel(); });

  // 行尾「更新」状态文字（idle 不显示）
  const upDetail = $derived(upState === 'idle' ? '' : upMsg);
  const langLabel = $derived((LANGS.find((l) => l.value === lang()) || LANGS[0]).label);
  // 服务器换了地址、App 自动跟过去时（lib/server.js 地址簿）这一行要跟着刷新
  let baseTick = $state(0);
  $effect(() => onServerBaseChange(() => { baseTick++; }));
  const serverHost = $derived((baseTick, (getServerBase() || '').replace(/^https?:\/\//, '')) || t('同源'));
</script>

<!-- ─────────────── 行的零件 ─────────────── -->
{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}
{#snippet check()}<Sym name="checkmark" weight={600} size={15} class="ck" />{/snippet}
<!-- 行首图标：中性底方格里一枚线稿（不上色块）；agent 行放各自的真品牌标 -->
{#snippet ico(name)}<span class="ri" aria-hidden="true">{@html svgOf(name)}</span>{/snippet}
{#snippet agMark(id)}<span class="ri brand" aria-hidden="true">{#if markSrc(id)}<img src={markSrc(id)} alt="" draggable="false" />{:else}{@html svgOf('orb')}{/if}</span>{/snippet}
{#snippet gfoot(text)}<p class="gfoot">{text}</p>{/snippet}
{#snippet ghead(text)}<h2 class="ghead">{text}</h2>{/snippet}
<!-- 「软件更新」行：根页（带行首图标）与「关于 › 更新」组（组里其余行都没图标，这里也不带）共用一份，
     状态（检查中 / 下载进度环 / 一键更新）是同一个 upState，两处看到的永远一致 -->
{#snippet upRow(withIco)}
  <button class="r" type="button" onclick={onUpClick} disabled={upState === 'downloading' || upState === 'checking'}>
    {#if withIco}{@render ico('update')}{/if}
    <span class="r-main">
      <span class="r-tx">{t('软件更新')}</span>
      {#if upState === 'downloading'}
        <span class="r-d num">{Math.round(progress * 100)}%</span><span class="ring" style:--p="{Math.round(progress * 360)}deg"></span>
      {:else if upState === 'checking'}
        <span class="r-d">{upDetail}</span><span class="spin" aria-hidden="true"></span>
      {:else}
        <span class="r-d" class:accent={upState === 'installable'} class:err={upState === 'error'}>{#if upState === 'installable'}<span class="new-dot" aria-hidden="true"></span>{/if}{upDetail}</span>
        {@render chev()}
      {/if}
    </span>
  </button>
{/snippet}

<!-- ─────────────── 各页内容 ─────────────── -->
{#snippet avatar(big)}
  <span class="av" class:big class:none={me.kind === 'none'} aria-hidden="true">
    {#if me.kind === 'none'}
      <svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="4.2" fill="currentColor" /><path d="M3.8 21.2c.9-4 4.2-6.4 8.2-6.4s7.3 2.4 8.2 6.4" fill="currentColor" /></svg>
    {:else}{initial}{/if}
  </span>
{/snippet}

{#snippet pRoot()}
  <div class="ig">
    <button class="r acctcard" type="button" onclick={() => push('account')}>
      {@render avatar(false)}
      <span class="r-main">
        {#if me.kind === 'none'}
          <span class="r-tx"><span class="acct-title">{t('登录')}</span><span class="r-sub">{t('登录后使用对话、工作空间与用量')}</span></span>
        {:else}
          <span class="r-tx"><span class="acct-title">{shownName}</span><span class="r-sub">{roleLabel}{status.plan ? ' · ' + status.plan : ''}</span></span>
        {/if}
        {@render chev()}
      </span>
    </button>
  </div>

  <!-- Agent：每个 agent 一行、各自一页（开关与认证 + 它自己的设置） -->
  {@render ghead(tc('settings', 'Agent'))}
  <div class="ig">
    {#each agentRows as a (a.id)}
      <button class="r" type="button" onclick={() => push('ag-' + a.id)}>
        {@render agMark(a.id)}
        <span class="r-main" class:dim={!a.local && !a.enabled}><span class="r-tx">{a.label}</span><span class="r-d" class:warn={!a.local && a.enabled && !a.authed}>{agTail(a)}</span>{@render chev()}</span>
      </button>
    {/each}
    {#if hasDevices && pluginOn('agent-api')}
      <button class="r" type="button" onclick={() => push('agentapi')}>
        {@render ico('agentapi')}
        <span class="r-main"><span class="r-tx">{t('Agent 接入')}</span>{@render chev()}</span>
      </button>
    {/if}
  </div>

  {#if pluginPanels.list.length}
    {@render ghead(t('插件'))}
    <div class="ig">
      {#each pluginPanels.list as pp (pp.id)}
        <button class="r" type="button" onclick={() => openPlg(pp)}>
          {@render ico('extensions')}
          <span class="r-main"><span class="r-tx">{panelTitle(pp)}</span>{@render chev()}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if extOk || (ags.policyOk && ags.multiUser) || srvAdminOk}
    {@render ghead(extMember ? t('个性化') : t('服务器'))}
    <div class="ig">
      {#if extOk}
        <button class="r" type="button" onclick={() => push('extensions')}>
          {@render ico('extensions')}
          <span class="r-main"><span class="r-tx">{t('扩展')}</span>{#if me.pluginUpdates}<span class="r-d accent">{t('{n} 个插件有更新', { n: me.pluginUpdates })}</span>{/if}{@render chev()}</span>
        </button>
      {/if}
      {#if ags.policyOk && ags.multiUser}
        <button class="r" type="button" onclick={() => push('policy')}>
          {@render ico('policy')}
          <span class="r-main"><span class="r-tx">{t('额度与注册')}</span><span class="r-d">{ags.regOpen ? t('开放注册') : t('注册已关')}</span>{@render chev()}</span>
        </button>
      {/if}
      {#if srvAdminOk}
        <button class="r" type="button" onclick={() => { ui.serverAdminOpen = true; }}>
          {@render ico('server')}
          <span class="r-main"><span class="r-tx">{t('服务端控制台')}</span><span class="live-dot" aria-hidden="true"></span>{@render chev()}</span>
        </button>
      {/if}
    </div>
  {/if}

  {@render ghead(t('偏好'))}
  <div class="ig">
    <button class="r" type="button" onclick={() => push('general')}>
      {@render ico('general')}
      <span class="r-main"><span class="r-tx">{t('通用')}</span>{@render chev()}</span>
    </button>
    <button class="r" type="button" onclick={() => push('appearance')}>
      {@render ico('appearance')}
      <span class="r-main"><span class="r-tx">{t('外观')}</span><span class="r-d">{prefs.followSys ? t('自动') : dark ? t('深色') : t('明亮')}</span>{@render chev()}</span>
    </button>
    {#if !single && pluginOn('wallpapers')}
      <button class="r" type="button" onclick={() => push('wallpaper')}>
        {@render ico('wallpaper')}
        <span class="r-main"><span class="r-tx">{t('壁纸')}</span>{@render chev()}</span>
      </button>
    {/if}
    {#if ui.glassMode === 'A' && !single}
      <button class="r" type="button" onclick={() => push('flux')}>
        {@render ico('flux')}
        <span class="r-main"><span class="r-tx">{t('流体壁纸')}</span>{@render chev()}</span>
      </button>
    {/if}
  </div>

  {#if phoneRow || devRow}
    <!-- 小标题只给「手机操控」那种这台机器自己的能力；只剩账号级的「设备」一行时不挂标题 -->
    {#if phoneRow}{@render ghead(t('这台设备'))}{/if}
    <div class="ig">
      {#if phoneRow}
        <button class="r" type="button" onclick={() => push('phone')}>
          {@render ico('phone')}
          <span class="r-main"><span class="r-tx">{t('手机操控')}</span><span class="r-d">{phoneCtrlOn ? tc('开关', '打开') : tc('开关', '关闭')}</span>{@render chev()}</span>
        </button>
      {/if}
      {#if devRow}
        <button class="r" type="button" onclick={openDevices}>
          {@render ico('localpc')}
          <span class="r-main"><span class="r-tx">{t('设备')}</span><span class="r-d">{dvOnline ? t('{n} 台在线', { n: dvOnline }) : ''}</span>{@render chev()}</span>
        </button>
      {/if}
    </div>
  {/if}

  <div class="ig">
    <!-- 软件更新只给安卓壳：网页的界面就是服务器发的，刷新即最新（「关于」页里说明）；
         10-21 回归 FR7：以前网页上点这一行会把带令牌的 APK 下载地址交给浏览器 -->
    {#if plat !== 'web'}{@render upRow(true)}{/if}
    {#if pluginOn('feedback')}
    <button class="r" type="button" onclick={openFeedback}>
      {@render ico('feedback')}
      <span class="r-main"><span class="r-tx">{t('提交反馈')}</span>{@render chev()}</span>
    </button>
    {/if}
    <button class="r" type="button" onclick={() => push('about')}>
      {@render ico('about')}
      <span class="r-main"><span class="r-tx">{t('关于')}</span><span class="r-d num">{verShort}</span>{@render chev()}</span>
    </button>
  </div>
{/snippet}

{#snippet pGeneral()}
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('通知')}</span><Toggle checked={notifyOn} onchange={toggleNotify} label={t('启用通知')} /></span>
    </div>
    <button class="r" type="button" onclick={() => push('language')}>
      <span class="r-main"><span class="r-tx">{t('语言')}</span><span class="r-d">{langLabel}</span>{@render chev()}</span>
    </button>
  </div>
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('原图加载')}</span><Toggle checked={prefs.fullResMedia} onchange={toggleFullRes} label={t('原图加载')} /></span>
    </div>
  </div>
  <!-- 安卓：后台运行不受省电限制（任务通知栏靠它在后台活着；原单页设置「通用」里的那一行） -->
  {#if hasBatteryApi}
    <div class="ig">
      <button class="r" type="button" onclick={() => { if (!batteryOk) grantBattery(); }} aria-label={t('后台运行')}>
        <span class="r-main"><span class="r-tx">{t('后台运行')}</span>{#if !batteryOk}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(batteryOk)}</span>
      </button>
    </div>
    {@render gfoot(batteryOk ? t('已不受省电限制：切到后台也能收到任务进度与完成通知') : t('系统省电策略可能在后台掐断连接，任务跑完会收不到通知'))}
  {/if}
{/snippet}

<!-- ─────────────── Agent 页 ─────────────── -->
<!-- 开关 + 认证状态（管理员）：每个 agent 页最上面那一组 -->
{#snippet agSwitch(id)}
  {@const a = agentById(id)}
  <div class="hero">
    <span class="hero-mark">{#if markSrc(id)}<img src={markSrc(id)} alt="" draggable="false" />{/if}</span>
    <div class="hero-name">{titleOf('ag-' + id)}</div>
    {#if a && agStatus(a)}<div class="hero-sub" class:warn={a.runnable && a.switch && !a.authed}>{agStatus(a)}</div>{/if}
  </div>
  {#if a}
    <div class="ig">
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('启用 {name}', { name: a.label })}</span>
          <Toggle checked={a.switch && a.runnable} disabled={!a.runnable || ags.agentBusy === a.id} onchange={() => toggleAgent(a)} label={t('启用 {name}', { name: a.label })} /></span>
      </div>
    </div>
    {#if a.runnable && a.switch && !a.authed && AG_AUTH_HINT[id]}{@render gfoot(AG_AUTH_HINT[id]())}{/if}
  {/if}
{/snippet}

{#snippet agErr()}{#if ags.err}<p class="gfoot err">{ags.err}</p>{/if}{/snippet}

{#snippet meter(name, b, na)}
  <div class="u">
    <div class="u-top"><span class="u-l">{name}</span><span class="u-v" class:hot={b && usageTone(b) === 'red'}>{b ? t('{pct}% 已用', { pct: b.pct }) : '—'}</span></div>
    <span class="bar-u">{#if b}<i style:width="{Math.min(100, b.pct)}%" class:hot={usageTone(b) === 'red'} class:warm={usageTone(b) === 'amber'}></i>{/if}</span>
    {#if b}<span class="u-r">{b.status === 'rejected' ? t('已达上限') + ' · ' : ''}{poolResetIn(b.resetsAt)}</span>{:else if na}<span class="u-r">{na}</span>{/if}
  </div>
{/snippet}

{#snippet pClaude()}
  {@render agSwitch('claude')}
  <ClaudeCliStatus />
  {#if ags.poolOk}
    <div class="ghead-row">
      {@render ghead(t('订阅号池'))}
      <button class="gh-ico" class:busy={ags.usageBusy} type="button" onclick={() => loadUsage(true)} disabled={ags.usageBusy} aria-label={ags.usageBusy ? t('刷新中…') : t('刷新用量')}>{@html svgOf('refresh', 1.8)}</button>
    </div>
    <div class="ig">
      {#each ags.accounts as a (a.id)}
        {@const u = ags.usage[a.id]}
        <button class="r acct-r" type="button" onclick={() => push('acct:' + a.id)}>
          <span class="r-main">
            <span class="r-tx">
              <span class="acct-name">{accLabel(a.label)}
                {#if u?.plan === 'max'}<span class="pill">Max</span>{:else if u?.plan === 'pro'}<span class="pill">Pro</span>{/if}
                {#if a.active}<span class="cur">{t('使用中')}</span>{/if}
              </span>
              <span class="mini">
                {#if !u}<span class="mini-na">{ags.usageBusy ? t('读取用量…') : (a.hasToken ? '…' + (a.tokenTail || '') : t('用本机登录态（~/.claude）'))}</span>
                {:else if u.error && !u.five_hour && !u.seven_day}<span class="mini-na err">{tr(u.error)}</span>
                {:else}
                  {#each [['five_hour', t('5 小时')], ['seven_day', t('每周')], ['fable', 'Fable']] as [k, name] (k)}
                    {@const b = u[k]}
                    <span class="mini-m"><span class="mini-h">{name}<b class={b ? usageTone(b) : ''}>{b ? b.pct + '%' : '—'}</b></span><span class="mini-bar"><i class={b ? usageTone(b) : ''} style:width="{b ? Math.min(100, b.pct) : 0}%"></i></span><span class="mini-r">{b ? poolResetAt(b.resetsAt) : ''}</span></span>
                  {/each}
                {/if}
              </span>
            </span>
            {@render chev()}
          </span>
        </button>
      {/each}
      <button class="r add" type="button" onclick={openAddAcct}>
        <span class="r-main"><span class="r-tx accent">{t('添加账号')}</span></span>
      </button>
    </div>
    {#if apiKeyNote()}{@render gfoot(apiKeyNote())}{/if}
    <!-- 服务端标 source:'last-use' 时，用量是各号上次使用时的，说一句免得以为是实时的 -->
    {#if Object.values(ags.usage || {}).some((u) => u?.source === 'last-use')}{@render gfoot(t('闲置的号显示它上次使用时的额度；还没用过的号要用过一次才有数据。'))}{/if}
    {@render agErr()}

  {/if}

  <!-- 模型服务（自定义 API，管理员与成员各一份）：紧跟号池——两者都是「模型从哪来」；点开是盖在设置上的整页面板 -->
  {#if cp.ok}
    {@render ghead(t('模型服务'))}
    <div class="ig">
      <button class="r" type="button" onclick={() => (provOpen = true)}>
        <span class="r-main"><span class="r-tx">{t('自定义 API')}</span><span class="r-d">{cpSummaryText()}</span>{@render chev()}</span>
      </button>
    </div>
  {/if}

  <!-- 撞上限额时：按身份的「限额重置后自动继续」+ 号池智能路由（管理员）；号池最常看，限额相关三件事聚在它后面 -->
  {@render ghead(t('撞上限额时'))}
  <div class="ig">
    {@render cToggle('autoContinueOnLimit')}
    {#if ags.poolOk}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('额度用尽自动换号')}{#if ags.accounts.length < 2}<span class="r-sub">{t('号池里至少要有两个账号才用得上')}</span>{/if}</span>
          <Toggle checked={routerOn} disabled={!ags.router || ags.routerBusy} onchange={() => setRouter({ enabled: !routerOn })} label={t('额度用尽自动换号')} /></span>
      </div>
      {#if routerOn}
        <div class="r ind">
          <span class="r-main"><span class="r-tx">{t('额度恢复后回到首选号')}</span>
            <Toggle checked={ags.router.settings.returnToPrimary} disabled={ags.routerBusy} onchange={() => setRouter({ returnToPrimary: !ags.router.settings.returnToPrimary })} label={t('额度恢复后回到首选号')} /></span>
        </div>
        <div class="r ind">
          <span class="r-main"><span class="r-tx">{t('会话中无缝换号')}<span class="r-sub">{t('快用满时在两步之间换号，进行中的对话不中断')}</span></span>
            <Toggle checked={!!ags.router.settings.seamless} disabled={ags.routerBusy} onchange={() => setRouter({ seamless: !ags.router.settings.seamless })} label={t('会话中无缝换号')} /></span>
        </div>
      {/if}
    {/if}
  </div>
  {#if ags.poolOk && routerOn && ags.router.log?.length}
    {@render ghead(t('最近的自动切换'))}
    <div class="ig">
      {#each ags.router.log as l (l.at)}
        <div class="r"><span class="r-main"><span class="r-tx">{accLabel(acctById(l.from)?.label || l.fromLabel)} → {accLabel(acctById(l.to)?.label || l.toLabel)}<span class="r-sub">{whyText(l.reason)}</span></span><span class="r-d num">{hhmm(l.at)}</span></span></div>
      {/each}
    </div>
  {/if}

  <!-- 服务意外重启时：上一条命没跑完的轮，服务恢复后自动接着做（src/runtime/restart-resume.mjs） -->
  {@render ghead(t('服务意外重启时'))}
  <div class="ig">
    {@render cToggle('autoResumeOnRestart')}
  </div>

  <!-- 新会话默认：会话里可以单独改（输入框的模式菜单 / 加号菜单的输出风格），改的只是那个会话 -->
  {@render ghead(t('新会话默认'))}
  <div class="ig">
    {@render cPush('permissionMode', 'cl-perm')}
    {@render cPush('outputStyle', 'cl-style')}
    {#if cs.shell}
      <div class="r">
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('用工作树')}{@render devPill()}</span></span>
          <Toggle checked={prefs.worktree} onchange={() => { prefs.worktree = !prefs.worktree; savePrefs(); }} label={t('用工作树')} /></span>
      </div>
    {/if}
  </div>

  {@render ghead(t('对话'))}
  <div class="ig">
    {@render cToggle('promptSuggestions')}
    {@render cToggle('inlineVisualizations')}
    {@render cToggle('enableWorkflows')}
    {#if visible('subagentDispatch')}
      <button class="r ind" type="button" onclick={openDispatch}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{csLabel('subagentDispatch')}{@render cDot('subagentDispatch')}</span></span><span class="r-d dsp-d">{val('subagentDispatch') || t('按难度自动')}</span>{@render chev()}</span>
      </button>
    {/if}
    {@render cToggle('switchModelsOnFlag')}
    {@render cToggle('planClearContext')}
    {@render cPush('questionTimeout', 'cl-qto')}
    {@render cPush('replyLanguage', 'cl-lang')}
    {#if changed('compactFrac')}
      <button class="r" type="button" onclick={() => resetVal('compactFrac')}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{csLabel('compactFrac')}{@render cDot('compactFrac')}</span></span><span class="r-d num">{valueLabel('compactFrac')}</span><span class="r-d accent">{t('恢复默认')}</span></span>
      </button>
    {/if}
    {#if showMarks}
      <button class="r" type="button" onclick={() => push('thinkmark')}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('思考动画')}{@render devPill()}</span></span><span class="r-d">{markLabel}</span>{@render chev()}</span>
      </button>
    {/if}
  </div>

  {#if visible('newSessionPolicy') || visible('crossSessionInbound')}
    {@render ghead(t('会话协作'))}
    <div class="ig">
      {@render cPush('newSessionPolicy', 'cl-newsess')}
      {@render cPush('crossSessionInbound', 'cl-inbound')}
    </div>
  {/if}

  <!-- 不常改的整组折成推入行 -->
  <div class="ig">
    {#if cs.shell}
      <button class="r" type="button" onclick={() => push('cl-git')}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('Git 与拉取请求')}{#if GIT_KEYS.some(changed)}{@render cDot('')}{/if}</span></span>{@render chev()}</span>
      </button>
    {/if}
    <button class="r" type="button" onclick={() => push('cl-sessions')}>
      <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('会话管理')}</span></span><span class="r-d">{val('autoArchiveDays') ? valueLabel('autoArchiveDays') : ''}</span>{@render chev()}</span>
    </button>
    <button class="r" type="button" onclick={() => push('cl-notify')}>
      <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('通知')}{@render devPill()}</span></span><span class="r-d">{notifyOn ? '' : tc('开关', '关闭')}</span>{@render chev()}</span>
    </button>
    {#if cs.admin}
      <!-- 这一组眼下只有保持唤醒两项：服务端说这台机器做不到（非 Windows）时整组入口不出 -->
      {#if visible('keepAwake')}
        <button class="r" type="button" onclick={() => push('cl-host')}>
          <span class="r-main"><span class="r-tx">{t('这台电脑')}</span><span class="r-d">{val('keepAwake') ? t('保持唤醒') : ''}</span>{@render chev()}</span>
        </button>
      {/if}
      <button class="r" type="button" onclick={() => push('cl-ext')}>
        <span class="r-main"><span class="r-tx">{t('扩展与记忆')}</span>{@render chev()}</span>
      </button>
    {/if}
  </div>

  {#if cs.admin}
    <!-- 安全：危险项置底；绕过权限打开前走确认框 -->
    {@render ghead(t('安全'))}
    <div class="ig">
      {@render cToggle('allowBypass')}
      {@render cToggle('allowAutoMode')}
    </div>
  {/if}
  {#if clErr}<p class="gfoot err">{clErr}</p>{/if}
{/snippet}

<!-- Claude 设置的行零件：标签旁「已改过默认值」小点、本机项「这台设备」胶囊、开关行、推入行（行尾当前值） -->
{#snippet cDot(key)}{#if !key || changed(key)}<span class="chg" role="img" aria-label={t('已改过默认值')} title={t('已改过默认值')}></span>{/if}{/snippet}
{#snippet devPill()}<span class="pill dev">{t('这台设备')}</span>{/snippet}
{#snippet cToggle(key)}
  {#if visible(key)}
    <div class="r" class:ind={!!CS[key].dependsOn}>
      <span class="r-main"><span class="r-tx"><span class="r-lbl">{csLabel(key)}{@render cDot(key)}{#if CS[key].scope === 'device'}{@render devPill()}{/if}</span></span>
        <Toggle checked={!!val(key)} disabled={CS[key].scope === 'device' && !notifyOn} onchange={() => toggleCs(key)} label={csLabel(key)} /></span>
    </div>
  {/if}
{/snippet}
{#snippet cPush(key, pid)}
  {#if visible(key)}
    <button class="r" type="button" onclick={() => push(pid)}>
      <span class="r-main"><span class="r-tx"><span class="r-lbl">{csLabel(key)}{@render cDot(key)}</span></span><span class="r-d">{valueLabel(key)}</span>{@render chev()}</span>
    </button>
  {/if}
{/snippet}

<!-- 单选子页（权限模式 / 输出风格 / 提问超时 / 回复语言 / …）：每项一行说明，选中打勾；改过才出「恢复默认」 -->
{#snippet pChoice(key)}
  <div class="ig">
    {#each csOptions(key) as o (o.value)}
      <button class="r" type="button" disabled={o.disabled} onclick={() => setVal(key, o.value)}>
        <span class="r-main"><span class="r-tx">{o.label}{#if o.note}<span class="r-sub">{o.note}</span>{:else if o.desc}<span class="r-sub">{o.desc}</span>{/if}</span>{#if String(val(key)).toLowerCase() === String(o.value).toLowerCase()}{@render check()}{/if}</span>
      </button>
    {/each}
  </div>
  {#if changed(key)}
    <div class="ig"><button class="r" type="button" onclick={() => resetVal(key)}><span class="r-main center"><span class="r-tx accent">{t('恢复默认')}</span></span></button></div>
  {/if}
  {#if clErr}<p class="gfoot err">{clErr}</p>{/if}
{/snippet}

<!-- 推入组页：Git 与拉取请求 / 会话管理 / 通知 / 这台电脑 / 扩展与记忆 -->
{#snippet pClGroup(pid)}
  {#if pid === 'cl-git'}
    <div class="ig">
      <button class="r" type="button" onclick={openPrefix}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{csLabel('branchPrefix')}{@render cDot('branchPrefix')}</span></span><span class="r-d">{valueLabel('branchPrefix')}</span>{@render chev()}</span>
      </button>
      {@render cPush('worktreeBaseRef', 'cl-base')}
      {@render cToggle('autoFixPullRequests')}
      {@render cToggle('autoArchiveOnPrClose')}
      {@render cPush('attribution', 'cl-attrib')}
    </div>
  {:else if pid === 'cl-sessions'}
    <div class="ig">
      {@render cPush('autoArchiveDays', 'cl-archive')}
      {@render cToggle('followDesktopArchive')}
    </div>
  {:else if pid === 'cl-notify'}
    <div class="ig">
      {@render cToggle('notifyPermission')}
      {@render cToggle('notifyQuestion')}
      {@render cToggle('notifyTaskComplete')}
    </div>
    {#if !notifyOn}{@render gfoot(t('通知总开关在「通用」里关着'))}{/if}
  {:else if pid === 'cl-host'}
    <div class="ig">
      {@render cToggle('keepAwake')}
      {@render cToggle('keepAwakeOnBattery')}
    </div>
  {:else if pid === 'cl-ext'}
    <div class="ig">
      <!-- 扩展中心探针没过（服务端没开扩展）就只剩定时任务 -->
      {#if extOk}
        <button class="r" type="button" onclick={() => openExtType('skill')}><span class="r-main"><span class="r-tx">{t('技能')}</span>{@render chev()}</span></button>
        {#if !extMember}
        <button class="r" type="button" onclick={() => openExtType('connector')}><span class="r-main"><span class="r-tx">{t('连接器')}</span>{@render chev()}</span></button>
        <button class="r" type="button" onclick={() => openExtType('plugin')}><span class="r-main"><span class="r-tx">{t('插件')}</span>{@render chev()}</span></button>
        {/if}
      {/if}
      {#if pluginOn('routines')}<button class="r" type="button" onclick={openRoutinesPage}><span class="r-main"><span class="r-tx">{t('定时任务')}</span>{@render chev()}</span></button>{/if}
    </div>
  {/if}
  {#if clErr}<p class="gfoot err">{clErr}</p>{/if}
{/snippet}

{#snippet pAcct(id)}
  {@const a = acctById(id)}
  {#if a}
    {@const u = ags.usage[a.id]}
    {@const idx = ags.accounts.indexOf(a)}
    <div class="hero">
      <span class="av big" aria-hidden="true">{(accLabel(a.label) || '?').trim().charAt(0).toUpperCase()}</span>
      <div class="hero-name">{accLabel(a.label)}</div>
      <div class="hero-sub">{a.active ? t('当前在用') : t('待用')}{u?.plan === 'max' ? ' · Max' : u?.plan === 'pro' ? ' · Pro' : ''}</div>
    </div>
    {@render ghead(t('用量'))}
    <div class="ig usage">
      {#if u?.error && !u.five_hour && !u.seven_day}
        <span class="u-r err">{tr(u.error)}</span>
      {:else}
        {@render meter(t('5 小时'), u?.five_hour, '')}
        {@render meter(t('每周'), u?.seven_day, '')}
        {@render meter('Fable', u?.fable, u?.plan === 'pro' ? t('Pro 无此额度') : '')}
      {/if}
    </div>
    <div class="ig">
      {#if !a.active}
        <button class="r" type="button" onclick={() => activateAccount(a)}><span class="r-main"><span class="r-tx accent">{t('切到此号')}</span></span></button>
      {/if}
      <button class="r" type="button" onclick={() => openEditAcct(a)}><span class="r-main"><span class="r-tx">{t('编辑账号')}</span>{@render chev()}</span></button>
      {#if ags.accounts.length > 1}
        <!-- 顺序：一行两枚小钮（原来是「上移」「下移」两整行） -->
        <div class="r">
          <span class="r-main"><span class="r-tx">{t('顺序')}</span><span class="r-d num">{idx + 1} / {ags.accounts.length}</span>
            <span class="steps">
              <button type="button" disabled={idx <= 0} onclick={() => moveAccount(a, -1)} aria-label={t('上移')}>{@html svgOf('up', 1.8)}</button>
              <button type="button" disabled={idx >= ags.accounts.length - 1} onclick={() => moveAccount(a, 1)} aria-label={t('下移')}>{@html svgOf('down', 1.8)}</button>
            </span>
          </span>
        </div>
      {/if}
    </div>
    {@render agErr()}
    {#if ags.accounts.length > 1}
      <div class="ig">
        <button class="r" type="button" onclick={() => (acctDel = a)}><span class="r-main center"><span class="r-tx red">{t('删除账号')}</span></span></button>
      </div>
    {/if}
  {/if}
{/snippet}

{#snippet pAgent(id)}
  {@render agSwitch(id)}
  {#if id === 'gemini' && agentById(id)?.runnable}<VertexCredentials onchange={loadAgents} />{#if vx.loaded}{@render vxGroups()}{/if}{/if}
  {#if !agentById(id)}{@render gfoot(t('只有管理员能改这里'))}{/if}
{/snippet}

<!-- Gemini 页「Google 云凭据」下面那几组（注册表 src/config/vertex-settings.mjs）：开关行；单选项推入 vx:<key> 子页 -->
{#snippet vxGroups()}
  {@const ids = (ags.agents?.agents || []).filter((a) => a.runnable).map((a) => a.id)}
  {#each VERTEX_SETTING_GROUPS as g (g.id)}
    {@const keys = vxGroupKeys(g.id, ids)}
    {#if keys.length}
      {@render ghead(vxGroupLabel(g))}
      <div class="ig">
        {#each keys as key (key)}
          {#if VX[key].type === 'bool'}
            <div class="r" class:ind={!!VX[key].dependsOn}>
              <span class="r-main"><span class="r-tx"><span class="r-lbl">{vxLabel(key)}{#if vxChanged(key)}{@render cDot('')}{/if}</span>{#if vxDesc(key)}<span class="r-sub">{vxDesc(key)}</span>{/if}</span>
                <Toggle checked={!!vx.values[key]} disabled={vx.busy === key} onchange={() => setVertexSetting(key, !vx.values[key])} label={vxLabel(key)} /></span>
            </div>
          {:else}
            <button class="r" class:ind={!!VX[key].dependsOn} type="button" onclick={() => push('vx:' + key)}>
              <span class="r-main"><span class="r-tx"><span class="r-lbl">{vxLabel(key)}{#if vxChanged(key)}{@render cDot('')}{/if}</span>{#if vxDesc(key)}<span class="r-sub">{vxDesc(key)}</span>{/if}</span><span class="r-d">{vxValueLabel(key)}</span>{@render chev()}</span>
            </button>
          {/if}
        {/each}
      </div>
      {@render gfoot(vxGroupFoot(g))}
    {/if}
  {/each}
  {#if vx.err}<p class="gfoot err">{vx.err}</p>{/if}
{/snippet}

<!-- 单选子页（视频最高分辨率 / 内容安全过滤四类）：选中打勾；改过才出「恢复默认」 -->
{#snippet pVxChoice(key)}
  {#if VX[key]}
    <div class="ig">
      {#each vxOptions(key) as o (o.value)}
        <button class="r" type="button" disabled={vx.busy === key} onclick={() => setVertexSetting(key, o.value)}>
          <span class="r-main"><span class="r-tx">{o.label}</span>{#if vx.values[key] === o.value}{@render check()}{/if}</span>
        </button>
      {/each}
    </div>
    {#if vxDesc(key)}{@render gfoot(vxDesc(key))}{/if}
    {#if vxChanged(key)}
      <div class="ig"><button class="r" type="button" onclick={() => setVertexSetting(key, null)}><span class="r-main center"><span class="r-tx accent">{t('恢复默认')}</span></span></button></div>
    {/if}
    {#if vx.err}<p class="gfoot err">{vx.err}</p>{/if}
  {/if}
{/snippet}

{#snippet pPolicy()}
  {#if ags.policy}
    <div class="ig">
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('凭邀请码注册')}</span>
          <Toggle checked={ags.policy.register} onchange={() => savePolicy({ register: !ags.policy.register })} label={t('凭邀请码注册')} /></span>
      </div>
    </div>
    {@render ghead(t('注册用户的默认额度'))}
    <div class="ig">
      {#each POLICY_FIELDS as f (f.k)}
        <button class="r" type="button" onclick={() => openNum(f)}>
          <span class="r-main"><span class="r-tx">{f.label()}</span><span class="r-d num">{policyVal(f.k) ? policyVal(f.k) + ' ' + f.unit() : t('不限')}</span>{@render chev()}</span>
        </button>
      {/each}
      <button class="r" type="button" onclick={openTz}>
        <span class="r-main"><span class="r-tx">{t('「每天」按哪个时区换日')}</span><span class="r-d">{ags.policy.timezone}</span>{@render chev()}</span>
      </button>
    </div>
    {@render agErr()}
    {@render gfoot(t('只算 Claude，管理员不受限。'))}
  {/if}
{/snippet}

{#snippet pThinkMark()}
  <div class="ig">
    {#each MARKS as mk (mk.value)}
      <button class="r" type="button" onclick={() => setMark(mk.value)}>
        <span class="r-main">
          <span class="mk-prev">{#if mk.value === 'clay'}<ClaudeWorkingMark activity="think" size={22} standalone />{:else if mk.value === 'sprite'}<ClaudeSpriteMark phase="pending" box={22} />{:else}<ClaudeLogo anim="thinking" size={22} />{/if}</span>
          <span class="r-tx">{mk.label()}</span>{#if prefs.claudeMark === mk.value}{@render check()}{/if}
        </span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet pLanguage()}
  <div class="ig">
    {#each LANGS as l (l.value)}
      <button class="r" type="button" onclick={() => setLang(l.value)} lang={l.value === 'en' ? 'en' : 'zh-CN'}>
        <span class="r-main"><span class="r-tx">{l.label}</span>{#if lang() === l.value}{@render check()}{/if}</span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet pAppearance()}
  <div class="ig theme-pick" role="radiogroup" aria-label={t('外观')}>
    {#each ['light', 'dark'] as th (th)}
      {@const on = !prefs.followSys && ui.theme === th}
      <button class="tp" class:on type="button" role="radio" aria-checked={on} onclick={() => pickTheme(th)}>
        <span class="tp-art {th}" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="tp-name">{th === 'light' ? t('明亮') : t('深色')}</span>
        <span class="tp-dot" aria-hidden="true"></span>
      </button>
    {/each}
  </div>
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('跟随系统明暗')}</span><Toggle checked={prefs.followSys} onchange={toggleFollowSys} label={t('跟随系统明暗')} /></span>
    </div>
    {#if !single}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('分页跟随主页明暗')}</span><Toggle checked={prefs.followPage} onchange={toggleFollowPage} label={t('分页跟随主页')} /></span>
      </div>
    {/if}
  </div>
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('禁用系统转场动画')}</span><Toggle checked={prefs.noEnterAnim} onchange={toggleNoAnim} label={t('禁用转场动画')} /></span>
    </div>
  </div>
{/snippet}

{#snippet wpTile(slot, id)}
  <button class="wp-card" type="button" class:sel={wp[slot] === id} onclick={() => wpCardClick(slot, id)}
    onpointerdown={(e) => wpPressDown(e, id)} onpointermove={wpPressMove} onpointerup={wpPressUp} onpointercancel={wpPressUp}
    oncontextmenu={(e) => { e.preventDefault(); openWpMenu(e, id); }}>
    <span class="wp-thumb" style={bgStyle(id)}>
      {#if wpHasDepth(id)}<span class="wp-spatial-badge" aria-hidden="true"></span>{/if}
      {#if wpDef(id).dyn}<span class="wp-dyn">{t('动态')}</span>{/if}
      {#if wp[slot] === id}<span class="wp-ck">{@render check()}</span>{/if}
    </span>
    <span class="wp-name">{wpDef(id).name}</span>
  </button>
{/snippet}

{#snippet pWallpaper()}
  <div class="ig wp-cur">
    <div class="wp-pair">
      {#each ['light', 'dark'] as sys (sys)}
        <button class="wp-prev" type="button" class:now={homeSys === sys} onclick={() => enterStage(sys)} aria-label={sys === 'light' ? t('明亮壁纸预览') : t('深色壁纸预览')}>
          <span class="wp-phone" style={bgStyle(wp[sys])}><span class="wp-clock">9:41</span></span>
          <span class="wp-cap">
            <Sym name={sys === 'light' ? 'sun.max' : 'moon.fill'} weight={600} size={13} />
            {sys === 'light' ? t('明亮 · {name}', { name: wpDef(wp.light).name }) : t('深色 · {name}', { name: wpDef(wp.dark).name })}
          </span>
        </button>
      {/each}
    </div>
  </div>

  {@render ghead(t('明亮主题壁纸'))}
  <div class="wp-grid">
    {#each gridItems('light', LIGHT_IDS) as id (id)}{@render wpTile('light', id)}{/each}
    <label class="wp-card wp-add" for="wp-upl-light"><span class="wp-thumb"><Sym name="photo.badge.plus" weight={400} size={28} /></span><span class="wp-name">{t('相册上传')}</span></label>
  </div>
  {@render ghead(t('深色主题壁纸'))}
  <div class="wp-grid">
    {#each gridItems('dark', DARK_IDS) as id (id)}{@render wpTile('dark', id)}{/each}
    <label class="wp-card wp-add" for="wp-upl-dark"><span class="wp-thumb"><Sym name="photo.badge.plus" weight={400} size={28} /></span><span class="wp-name">{t('相册上传')}</span></label>
  </div>
  {#if wpErr && !stage}<p class="gfoot err">{wpErr}</p>{/if}
  {@render gfoot(t('长按自己上传的壁纸可以删除。上传时同时选中原图和它的深度图（文件名带 depth），就能开空间壁纸。'))}
  <input id="wp-upl-light" type="file" accept="image/*" multiple onchange={(e) => onUpload('light', e)} hidden />
  <input id="wp-upl-dark" type="file" accept="image/*" multiple onchange={(e) => onUpload('dark', e)} hidden />
{/snippet}

{#snippet fluxRows(list)}
  {#each list as s (s.key)}
    <div class="r slr" class:live={sliding === 'flux-' + s.key}>
      <span class="slr-head"><span class="r-tx">{s.label}</span><span class="r-d num">{fluxFmt(s, fluxParams[s.key])}</span></span>
      <Slider value={fluxFrac(s)} label={s.label} onstart={() => fluxDown(s)} oninput={(f) => fluxInput(s, f)} onend={fluxUp} />
    </div>
  {/each}
{/snippet}

{#snippet pFlux()}
  {@render ghead(t('颜色'))}
  <div class="seg-wrap"><Segmented options={FLUX_COLORMODES.map((c) => ({ value: c.id, label: c.name }))} value={fluxParams.colormode} onchange={pickColor} label={t('颜色')} /></div>
  {@render ghead(t('画面'))}
  <div class="ig">{@render fluxRows(FLUX_SLIDERS.filter((s) => !s.group))}</div>
  {@render ghead(t('模拟参数'))}
  <div class="ig">{@render fluxRows(FLUX_SLIDERS.filter((s) => s.group))}</div>
  <div class="ig">
    <button class="r" type="button" onclick={resetFlux}><span class="r-main center"><span class="r-tx accent">{t('恢复默认（Orange set）')}</span></span></button>
  </div>
{/snippet}

{#snippet pAgentApi()}
  <p class="gfoot ak-intro">{t('让别的 agent（Claude Code、Codex、脚本等）直接调用这台 bridge：读项目手册、给 Claude 派活、管文件和定时任务，不用开浏览器模拟点击。')}</p>
  {#if agentKeys.err}<p class="gfoot dv-err">{agentKeys.err}</p>{:else if akNote}<p class="gfoot">{akNote}</p>{/if}

  {#if agentKeys.fresh}
    {@render ghead(t('新密钥：{name}', { name: agentKeys.fresh.label }))}
    <div class="ig ak-fresh">
      <div class="r"><span class="r-main"><code class="ak-key">{agentKeys.fresh.key}</code></span></div>
      <button class="r" type="button" onclick={() => akCopy(agentKeys.fresh.prompt || agentKeys.fresh.key, t('已复制给 agent 的说明'))}><span class="r-main center"><span class="r-tx accent">{t('复制给 agent 的说明')}</span></span></button>
      <button class="r" type="button" onclick={() => akCopy(agentKeys.fresh.key, t('密钥已复制'))}><span class="r-main center"><span class="r-tx accent">{t('复制密钥')}</span></span></button>
      <button class="r" type="button" onclick={dismissFresh}><span class="r-main center"><span class="r-tx">{t('我已保存好')}</span></span></button>
    </div>
    <p class="gfoot ak-warn">{t('关掉之后就再也看不到这把密钥了。丢了就吊销它，再生成一把新的。')}</p>
  {/if}

  {@render ghead(t('地址'))}
  <div class="ig">
    <div class="r">
      <span class="r-main">
        <span class="r-tx">{t('Agent 入口')}<span class="r-sub dv-url">{agentKeys.agentUrl || (agentKeys.loaded ? '—' : t('正在读取…'))}</span></span>
        {#if agentKeys.agentUrl}<span class="dv-minis"><button type="button" onclick={() => akCopy(agentKeys.agentUrl)}>{t('复制')}</button></span>{/if}
      </span>
    </div>
    <div class="r">
      <span class="r-main">
        <span class="r-tx">{t('项目手册')}<span class="r-sub dv-url">{agentKeys.manualUrl || '—'}</span></span>
        {#if agentKeys.manualUrl}
          <span class="dv-minis">
            <button type="button" onclick={() => window.open(agentKeys.manualUrl, '_blank', 'noopener')}>{t('打开')}</button>
            <button type="button" onclick={() => akCopy(agentKeys.manualUrl)}>{t('复制')}</button>
          </span>
        {/if}
      </span>
    </div>
  </div>

  {@render ghead(t('生成密钥'))}
  <div class="ig">
    <div class="r"><span class="r-main"><input class="dv-in" bind:value={akLabel} placeholder={t('例如「家里的 Codex」')} onkeydown={(e) => { if (e.key === 'Enter') akCreate(); }} /></span></div>
    <button class="r" type="button" disabled={!akLabel.trim() || agentKeys.busy === 'create'} onclick={akCreate}><span class="r-main center"><span class="r-tx accent">{t('生成')}</span></span></button>
  </div>
  {@render gfoot(t('给每个 agent 单独一把，名字写清是谁在用，方便以后吊销。'))}

  {@render ghead(t('密钥'))}
  <div class="ig">
    {#if !agentKeys.keys.length}
      <div class="r"><span class="r-main"><span class="r-tx">{agentKeys.loaded ? t('还没有密钥') : t('正在读取…')}{#if agentKeys.loaded}<span class="r-sub">{t('生成一把，交给要接入的 agent')}</span>{/if}</span></span></div>
    {/if}
    {#each agentKeys.keys as k (k.id)}
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{k.label || k.id}<span class="r-sub">{akMeta(k)}</span></span>
          <span class="dv-minis">
            {#if akAsk === k.id}
              <button type="button" onclick={() => (akAsk = '')}>{t('取消')}</button>
              <button type="button" class="red" disabled={agentKeys.busy === 'revoke:' + k.id} onclick={() => akRevoke(k.id)}>{t('确认吊销')}</button>
            {:else}
              <button type="button" class="red" onclick={() => (akAsk = k.id)}>{t('吊销')}</button>
            {/if}
          </span>
        </span>
      </div>
    {/each}
  </div>
  {@render gfoot(t('密钥等同你的登录：拿到它的 agent 能做你能做的一切。每把 90 天后过期。') + ' ' + (me.kind === 'user' ? t('改密码会让你的全部密钥立即失效。') : t('换访问令牌会让全部密钥立即失效。')))}
{/snippet}

{#snippet statusTail(ok)}
  {#if ok}<Sym name="checkmark.circle.fill" weight={400} size={20} class="okmark" />{:else}{@render chev()}{/if}
{/snippet}

{#snippet pPhone()}
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('允许 Claude 操控这台手机')}</span><Toggle checked={phoneCtrlOn} onchange={togglePhoneCtrl} label={t('手机操控')} /></span>
    </div>
  </div>
  {#if phoneCtrlOn}
    {@render ghead(t('权限'))}
    <div class="ig">
      <button class="r" type="button" onclick={grantAccessibility} aria-label={t('授予无障碍权限')}>
        <span class="r-main"><span class="r-tx">{t('无障碍权限')}</span>{#if !accOn}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(accOn)}</span>
      </button>
      <button class="r" type="button" onclick={grantBattery} aria-label={t('保持后台运行')}>
        <span class="r-main"><span class="r-tx">{t('保持后台运行')}</span>{#if !batteryOk}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(batteryOk)}</span>
      </button>
      <button class="r" type="button" onclick={openAppDetails} aria-label={t('自启动与后台')}>
        <span class="r-main"><span class="r-tx">{t('自启动 / 后台活动')}</span>{@render chev()}</span>
      </button>
      <button class="r" type="button" onclick={onImeRow} aria-label={t('Bridge 输入法')}>
        <span class="r-main"><span class="r-tx">{t('Bridge 输入法')}</span>{#if !imeEnabled}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(imeEnabled)}</span>
      </button>
    </div>
  {/if}
  {#if hasFloatShell}
    {@render ghead(t('悬浮外壳'))}
    <div class="ig">
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('悬浮外壳 · Agent 模式')}</span><Toggle checked={floatShellOn} onchange={toggleFloatShell} label={t('悬浮外壳')} /></span>
      </div>
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('挖孔定位诊断')}</span><Toggle checked={cutoutDbgOn} onchange={toggleCutoutDbg} label={t('挖孔定位诊断')} /></span>
      </div>
      <button class="r" type="button" onclick={startCutoutCal}>
        <span class="r-main"><span class="r-tx">{t('校准挖孔位置')}</span>{@render chev()}</span>
      </button>
    </div>
  {/if}
{/snippet}

{#snippet dvMsg()}
  {#if dvErr}<p class="gfoot dv-err">{dvErr}</p>{:else if dvNote}<p class="gfoot">{dvNote}</p>{/if}
{/snippet}

{#snippet pDevices()}
  {@render dvMsg()}
  {#if thisComputer.supported}
    {@render ghead(t('这台电脑'))}
    <div class="ig">
      {#each DV_TIERS as o (o.value)}
        <button class="r" type="button" onclick={() => setThisComputerMode(o.value)}>
          <span class="r-main"><span class="r-tx">{o.label}<span class="r-sub">{o.sub}</span></span>{#if thisComputer.mode === o.value}{@render check()}{/if}</span>
        </button>
      {/each}
    </div>
    {@render gfoot(dvThisFoot)}
    {#if thisComputer.active}
      <div class="ig">
        <button class="r" type="button" onclick={stopThisComputer}>
          <span class="r-main center"><span class="r-tx red">{t('立即停止本轮操作')}<span class="r-sub">{tr(thisComputer.source) || 'agent'} · {tr(thisComputer.lastAction || '')}</span></span></span>
        </button>
      </div>
    {/if}
  {/if}

  {@render ghead(t('我的设备'))}
  <div class="ig">
    {#if !devices.list.length}
      <div class="r"><span class="r-main"><span class="r-tx">{devices.loaded ? t('还没有设备') : t('正在读取…')}</span></span></div>
    {/if}
    {#each devices.list as d (d.id)}
      <button class="r" type="button" onclick={() => openDevice(d)}>
        <span class="r-main">
          <span class="r-tx"><span class="r-lbl">{d.name}{#if d.id === myDeviceId}<span class="pill">{t('这台')}</span>{/if}</span><span class="r-sub">{deviceStatusLine(d, t)}</span></span>
          {@render chev()}
        </span>
      </button>
    {/each}
  </div>
  {@render gfoot(t('在电脑上装 bridge 桌面客户端并用同一个账号登录，它就会出现在这里。'))}

  {@render ghead(t('端口转发'))}
  <div class="ig">
    {#if forwards.err}
      <div class="r"><span class="r-main"><span class="r-tx">{t('端口转发')}<span class="r-sub err">{forwards.err}</span></span></span></div>
    {/if}
    {#each forwards.list as f (f.token)}
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{(f.label ? f.label + ' · ' : '') + t('端口 {port}', { port: f.port })}<span class="r-sub dv-url">{(f.deviceName ? f.deviceName + ' · ' : '') + forwardShareUrl(f)}</span></span>
          <span class="dv-minis">
            <button type="button" onclick={() => window.open(forwardShareUrl(f), '_blank', 'noopener')}>{t('打开')}</button>
            <button type="button" onclick={() => copyDv(forwardShareUrl(f))}>{t('复制')}</button>
            <button type="button" class="red" disabled={dvBusy === 'fwd:' + f.token} onclick={() => dropFwdDv(f)}>{t('删除')}</button>
          </span>
        </span>
      </div>
    {/each}
    {#if dvFwdChoices.length}
      <button class="r" type="button" onclick={openFwdNew}><span class="r-main"><span class="r-tx accent">{t('新的转发…')}</span></span></button>
    {:else}
      <div class="r"><span class="r-main"><span class="r-tx">{t('没有能转发端口的电脑')}<span class="r-sub">{t('需要新版桌面客户端在线')}</span></span></span></div>
    {/if}
  </div>
  {@render gfoot(t('把电脑上的本机端口（dev server、本机模型接口）接到服务器：手机上也能打开，Claude 也能用。持有地址的人都能访问，不用了就删掉。'))}

{/snippet}

{#snippet pDevice(id)}
  {@const d = devices.list.find((x) => x.id === id)}
  {#if d}
    <div class="hero">
      <div class="hero-name">{d.name}</div>
      <div class="hero-sub">{deviceStatusLine(d, t)}</div>
    </div>
    {@render dvMsg()}
    {@render ghead(t('名字'))}
    <div class="ig">
      <div class="r">
        <span class="r-main">
          <input class="dv-in" bind:value={dvName} />
          <span class="dv-minis"><button type="button" disabled={dvBusy === 'name' || !dvName.trim() || dvName.trim() === d.name} onclick={() => renameDv(d)}>{t('保存')}</button></span>
        </span>
      </div>
    </div>
    <div class="ig">
      {#if d.client?.os || d.platform}<div class="r"><span class="r-main"><span class="r-tx">{t('系统')}</span><span class="r-d">{d.client?.os || d.platform}</span></span></div>{/if}
      {#if d.hostname}<div class="r"><span class="r-main"><span class="r-tx">{t('主机名')}</span><span class="r-d">{d.hostname}</span></span></div>{/if}
      {#if d.client?.version}<div class="r"><span class="r-main"><span class="r-tx">{t('客户端版本')}</span><span class="r-d num">{d.client.version}</span></span></div>{/if}
      <div class="r"><span class="r-main"><span class="r-tx">{t('类型')}</span><span class="r-d">{d.kind === 'legacy' ? t('老客户端') : t('桌面客户端')}</span></span></div>
      {#if d.sameMachine}<div class="r"><span class="r-main"><span class="r-tx">{t('与服务器是同一台')}</span></span></div>{/if}
    </div>
    <div class="ig">
      {#if d.online}
        <button class="r" type="button" disabled={dvBusy === 'stop'} onclick={() => stopDv(d)}><span class="r-main center"><span class="r-tx">{t('断开')}</span></span></button>
      {/if}
      {#if !d.revoked}
        <button class="r" type="button" disabled={dvBusy === 'revoke'} onclick={() => revokeDv(d)}><span class="r-main center"><span class="r-tx red">{t('吊销')}</span></span></button>
      {:else}
        <button class="r" type="button" disabled={dvBusy === 'delete'} onclick={() => deleteDv(d)}><span class="r-main center"><span class="r-tx red">{t('删除')}</span></span></button>
      {/if}
    </div>
    {@render gfoot(t('吊销后那台电脑立刻断开，要重新登录才能再连。'))}
  {:else}
    {@render gfoot(t('这台设备已不在'))}
  {/if}
{/snippet}

{#snippet pFwdNew()}
  {@render dvMsg()}
  {@render ghead(t('哪台电脑'))}
  <div class="ig">
    {#each dvFwdChoices as o (o.value)}
      <button class="r" type="button" onclick={() => (dvFwdDevice = o.value)}><span class="r-main"><span class="r-tx">{o.label}</span>{#if dvFwdDevice === o.value}{@render check()}{/if}</span></button>
    {/each}
  </div>
  {@render ghead(t('本机端口'))}
  <div class="ig">
    <div class="r"><span class="r-main"><input class="dv-in" bind:value={dvFwdPort} inputmode="numeric" placeholder="5173" /></span></div>
    <div class="r"><span class="r-main"><input class="dv-in" bind:value={dvFwdLabel} placeholder={t('备注（可选）')} /></span></div>
  </div>
  <div class="ig">
    <button class="r" type="button" disabled={dvBusy === 'fwd' || !dvFwdPort} onclick={addFwdDv}><span class="r-main center"><span class="r-tx accent">{t('接通')}</span></span></button>
  </div>
  {@render gfoot(t('只转那台电脑的 127.0.0.1。WebSocket（热更新）暂不转，页面照常能用。'))}
{/snippet}

{#snippet pAbout()}
  <div class="hero">
    <img class="about-icon" src={appIcon} alt="" draggable="false" />
    <div class="hero-name">{DISTRO.brand}</div>
    <div class="hero-sub num">{verShort}</div>
  </div>
  <div class="ig">
    <button class="r" type="button" onclick={openAddr}>
      <span class="r-main"><span class="r-tx">{t('服务器地址')}</span><span class="r-d addr">{serverHost}</span>{@render chev()}</span>
    </button>
    {#if isOffline()}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('当前线路')}</span><span class="r-d"><span class="conn-dot {ui.connMode}"></span>{ui.connMode === 'lan' ? t('局域网直连') : t('Cloudflare 隧道')}</span></span>
      </div>
      <!-- 扫码连接（S1-2）：扫电脑上的配对二维码，换到那台服务器、并以出码的身份登录 -->
      <button class="r" type="button" onclick={() => { ui.pairScan = { mode: 'connect' }; }}>
        <span class="r-main"><span class="r-tx">{t('扫码连接服务器')}</span>{@render chev()}</span>
      </button>
    {/if}
    {#if me.kind !== 'none'}
      <!-- 出示配对码（S1-2）：让另一台手机 / 平板扫码连上这台服务器，并以你现在的身份登录。点开才出码 -->
      <button class="r" type="button" onclick={() => { connectOpen = !connectOpen; }}>
        <span class="r-main"><span class="r-tx">{t('让另一台设备扫码连接')}</span><span class="r-d accent">{connectOpen ? t('收起') : t('显示二维码')}</span></span>
      </button>
    {/if}
  </div>
  {#if connectOpen && me.kind !== 'none'}
    <div class="ig"><ConnectQr compact via="settings" /></div>
    {@render gfoot(t('只给你自己的设备扫：扫到的人会以你的身份登录。3 分钟内有效，只能用一次。'))}
  {/if}

  <!-- 服务器那头（要登录才拿得到）：出门在外用的公网地址、后端跑了多久 -->
  {#if srvInfo}
    {@render ghead(t('服务器'))}
    <div class="ig">
      {#if srvInfo.publicOrigin}
        <button class="r" type="button" onclick={copyPublic}>
          <span class="r-main"><span class="r-tx">{t('公网地址')}</span><span class="r-d addr sel">{srvInfo.publicOrigin.replace(/^https?:\/\//, '')}</span><span class="r-d accent">{pubCopied ? t('已复制') : t('复制')}</span></span>
        </button>
        {#if srvInfo.address?.kind}
          <div class="r">
            <span class="r-main"><span class="r-tx">{t('地址类型')}</span><span class="r-d">{srvInfo.address.kind === 'temporary' ? t('临时地址（重启会换）') : t('固定地址')}</span></span>
          </div>
        {/if}
      {/if}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('后端')}{#if srvInfo.server?.node}<span class="r-sub">Node {srvInfo.server.node.replace(/^v/, '')}</span>{/if}</span><span class="r-d num">{t('已运行 {t}', { t: fmtUptime(srvInfo.server?.uptimeSec) })}</span></span>
      </div>
    </div>
    {#if srvInfo.address?.kind === 'temporary'}
      {@render gfoot(t('服务器用的是临时地址：电脑或服务重启后会换一个。App 会自动跟过去——在线时立即收到新地址，离线时回家连上同一个 Wi-Fi 就会更新。长期使用建议在服务器上绑定自己的域名。'))}
    {/if}
  {/if}

  <!-- 服务端更新（管理员）：查 GitHub 发布仓库上的版本，按部署形态一键更新服务端（lib/serverUpdate.svelte.js）。
       整行就是动作：「一键更新」「检查更新」「检查并更新」；没有能做的动作时行不可点，脚注说怎么更新 -->
  {#if srvUpd.st && srvUpdView}
    {@render ghead(t('服务端更新'))}
    <div class="ig">
      {#snippet srvUpdMain()}
        <span class="r-main">
          <span class="r-tx">{t('服务端版本')}<span class="r-sub" class:warn={srvUpdView.tone === 'warn'}>{srvUpdView.sub}</span></span>
          {#if srvUpd.busy || srvUpd.loading}<span class="spin" aria-hidden="true"></span>
          {:else if srvUpdView.action}<span class="r-d accent">{#if srvUpdView.action === 'update'}<span class="new-dot" aria-hidden="true"></span>{/if}{srvUpdView.label}</span>{/if}
        </span>
      {/snippet}
      <!-- 没有能做的动作（正在装 / 等对话跑完 / 这种部署形态只能手动）时是纯状态行，不摆成一个点了没反应的按钮 -->
      {#if srvUpdView.action}
        <button class="r" type="button" disabled={srvUpd.busy || srvUpd.loading} onclick={() => srvUpd.act(srvUpdView.action)}>{@render srvUpdMain()}</button>
      {:else}
        <div class="r">{@render srvUpdMain()}</div>
      {/if}
      {#if srvUpd.st.newer && srvUpd.st.page}
        <a class="r" href={srvUpd.st.page} target="_blank" rel="noopener noreferrer">
          <span class="r-main"><span class="r-tx">{t('新版本说明')}</span>{@render chev()}</span>
        </a>
      {/if}
    </div>
    {#if srvUpd.err}{@render gfoot(srvUpd.err)}{:else if srvUpd.note}{@render gfoot(srvUpd.note)}{:else if srvUpdView.how}{@render gfoot(srvUpdView.how)}{/if}
  {/if}

  <!-- 更新：安卓壳是装包；网页的界面就是服务器发的，刷新即最新。
       「软件更新」这一行与根页共用：侧栏「关于与更新」直达的是这一页，有新版时在这里就能下载、装上，不用退回根页找 -->
  {#if plat === 'android'}
    {@render ghead(tc('settings', '更新'))}
    <div class="ig">
      {@render upRow(false)}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('自动检查更新')}</span><Toggle checked={autoUp} onchange={toggleAutoUp} label={t('自动检查更新')} /></span>
      </div>
      {#if appInfo && typeof appInfo.canInstall === 'boolean'}
        <button class="r" type="button" onclick={() => { if (!appInfo.canInstall) openInstallPermission(); }}>
          <span class="r-main"><span class="r-tx">{t('安装权限')}</span>{#if !appInfo.canInstall}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(appInfo.canInstall)}</span>
        </button>
      {/if}
      {#if upState === 'downloading' || upState === 'installable'}
        <button class="r" type="button" onclick={discardUpdate}>
          <span class="r-main center"><span class="r-tx red">{upState === 'downloading' ? t('取消下载') : t('丢弃已下载的新版本')}</span></span>
        </button>
      {/if}
      <!-- 服务器没有包：给发布页（服务器配了 / 推得出来才有）；App 只认所连这台服务器发的包，不自己去别处找 -->
      {#if updateInfo.noBuild && upLatest?.releasePage}
        <a class="r" href={upLatest.releasePage} target="_blank" rel="noopener noreferrer">
          <span class="r-main"><span class="r-tx">{t('去发布页下载')}</span>{@render chev()}</span>
        </a>
      {/if}
    </div>
    {#if aboutFoot}{@render gfoot(aboutFoot)}{/if}
    {#if updateInfo.blocked && updateInfo.blockedReason === 'package'}
      {@render gfoot(t('服务器上的这一版是另一个包名的 App（来自另一个发行渠道，或是自己编译的），装上会是另一个 App，不能用来更新这一个。要换用它，装好新的再卸载这个（本机缓存的聊天会清空，服务器上的数据不受影响）。'))}
    {:else if updateInfo.blocked}
      {@render gfoot(t('服务器上的这一版和手机上的 App 签名不同（来自另一个发行渠道，或是自己编译的），不能覆盖安装。要换用它，先卸载手机上的 App 再装（本机缓存的聊天会清空，服务器上的数据不受影响）。'))}
    {:else if updateInfo.noBuild}
      {@render gfoot(t('这台服务器没有可发的 App 版本：手机 App 由你连着的服务器自己发，服务器那头放上安装包后这里就能更新。'))}
    {:else if updateInfo.appNewer}
      {@render gfoot(t('手机上的 App 比服务器新：照常能用，个别新功能要等服务器更新后才有。'))}
    {/if}
    {#if newerNotes}
      {@render ghead(t('新版本说明'))}
      <div class="ig notes">
        <div class="n-h">{t('{name}（{code}）', { name: newerNotes.name, code: newerNotes.code })}{#if newerNotes.size}<span class="n-s">{(newerNotes.size / 1048576).toFixed(1)} MB</span>{/if}</div>
        <p class="n-b">{tr(newerNotes.notes)}</p>
      </div>
    {/if}
  {:else}
    <div class="ig">
      <div class="r"><span class="r-main"><span class="r-tx">{t('网页版总是最新的')}</span>{@render statusTail(true)}</span></div>
    </div>
    {@render gfoot(upLatest ? t('界面由服务器直接提供，刷新页面即是服务器上的版本（{version}）。', { version: upLatest.name }) : t('界面由服务器直接提供，刷新页面即是最新。'))}
  {/if}

  {#if upHistory.length}
    <div class="ig">
      <button class="r" type="button" onclick={() => push('history')}>
        <span class="r-main"><span class="r-tx">{t('版本历史')}</span><span class="r-d num">{upLatest?.name || ''}</span>{@render chev()}</span>
      </button>
    </div>
  {/if}

  <!-- 这台手机（安卓壳才有）：系统、机型、首次安装与最近更新 -->
  {#if plat === 'android' && appInfo && appInfo.release}
    {@render ghead(t('设备'))}
    <div class="ig">
      <div class="r"><span class="r-main"><span class="r-tx">{t('系统')}</span><span class="r-d">{t('Android {release}（SDK {sdk}）', { release: appInfo.release, sdk: appInfo.sdk })}</span></span></div>
      {#if appInfo.model}<div class="r"><span class="r-main"><span class="r-tx">{t('机型')}</span><span class="r-d">{[appInfo.brand, appInfo.model].filter(Boolean).join(' ')}</span></span></div>{/if}
      {#if appInfo.firstInstall}<div class="r"><span class="r-main"><span class="r-tx">{t('首次安装')}</span><span class="r-d num">{fmtDay(appInfo.firstInstall)}</span></span></div>{/if}
      {#if appInfo.lastUpdate && appInfo.lastUpdate !== appInfo.firstInstall}<div class="r"><span class="r-main"><span class="r-tx">{t('最近更新')}</span><span class="r-d num">{fmtDay(appInfo.lastUpdate)}</span></span></div>{/if}
    </div>
  {/if}
{/snippet}

<!-- 版本历史（服务器上发过的每一版与说明；装着的那一版、最新那一版各打一个签） -->
{#snippet pHistory()}
  <div class="ig">
    {#each upHistory as h (h.code)}
      <div class="r hist">
        <span class="r-main">
          <span class="r-tx">
            <span class="r-lbl">{h.name}<span class="h-c">{t('（{code}）', { code: h.code })}</span>
              {#if plat === 'android' && h.code === installedCode}<span class="pill">{t('当前')}</span>{/if}
              {#if h.code === upLatest?.code && (plat !== 'android' || h.code !== installedCode)}<span class="pill">{t('最新')}</span>{/if}
            </span>
            {#if h.notes}<span class="r-sub">{tr(h.notes)}</span>{/if}
          </span>
          <span class="r-d num">{h.date}</span>
        </span>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet pAccount()}
  {#if me.kind !== 'none'}
    <div class="hero">
      {@render avatar(true)}
      <div class="hero-name">{shownName}</div>
      <div class="hero-sub">{roleLabel}{status.plan ? ' · ' + status.plan : ''}</div>
    </div>

    {@render ghead(t('用量'))}
    <div class="ig usage">
      {#each [[t('当前会话（5 小时）'), usePct(lim.five_hour), lim.five_hour], [t('本周'), usePct(lim.seven_day), lim.seven_day]] as [name, p, b] (name)}
        <div class="u">
          <div class="u-top"><span class="u-l">{name}</span><span class="u-v">{p == null ? '—' : t('{pct}% 已用', { pct: p })}</span></div>
          <span class="bar-u">{#if p != null}<i style:width="{p}%" class:hot={p >= 80}></i>{/if}</span>
          {#if resetIn(b)}<span class="u-r">{resetIn(b)}</span>{/if}
        </div>
      {/each}
    </div>

    {#if me.kind === 'user'}
      {@render ghead(t('我的额度'))}
      <div class="ig">
        {#if mine && hasLimits(mine)}
          {#each quotaRows(mine) as r (r.label)}
            <div class="r"><span class="r-main"><span class="r-tx">{r.label}</span><span class="r-d" class:err={r.hot}>{r.value}</span></span></div>
          {/each}
        {:else}
          <div class="r"><span class="r-main"><span class="r-tx">{mine ? t('不限') : t('读取中…')}</span></span></div>
        {/if}
      </div>
      <!-- 额度里的美元按 API 价估算（S2-6：共用订阅号池时不是真花出去的钱） -->
      {#if mine && hasLimits(mine)}{@render gfoot(costNote())}{/if}
      {#if aa}
        {@render ghead(t('管理员可见性'))}
        <div class="ig">
          {#each accessItems() as it (it.key)}
            <div class="r"><span class="r-main"><span class="r-tx">{it.title}<span class="r-sub">{it.sub}</span></span>
              <Toggle checked={!!aa.consents[it.key]} onchange={() => toggleAa(it.key)} label={it.title} /></span></div>
          {/each}
        </div>
        {@render gfoot(accessDisclosure())}
        {#if aa.log?.length}
          {@render ghead(t('管理员的访问记录'))}
          <div class="ig">
            {#each aa.log.slice(0, 10) as e, i (e.at + e.action + i)}
              <div class="r"><span class="r-main"><span class="r-tx">{logLine(e)}<span class="r-sub">{new Date(e.at).toLocaleString()}</span></span></span></div>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}

    <div class="ig">
      <button class="r" type="button" onclick={openWorkspaceFromAcct}>
        <span class="r-main"><span class="r-tx">{t('工作空间')}</span>{@render chev()}</span>
      </button>
      {#if canScan}
        <button class="r" type="button" onclick={openScanFromAcct}>
          <span class="r-main"><span class="r-tx">{t('扫一扫 · 登录网页版')}</span>{@render chev()}</span>
        </button>
      {/if}
      {#if me.kind === 'user'}
        <button class="r" type="button" onclick={() => { pwDone = false; pw = { old: '', next: '', again: '', busy: false, err: '' }; }}>
          <span class="r-main"><span class="r-tx">{t('修改密码')}{#if pwDone}<span class="r-sub">{t('已改好。别的设备要用新密码重新登录，这台不受影响。')}</span>{/if}</span>{@render chev()}</span>
        </button>
      {/if}
    </div>

    <div class="ig">
      <button class="r" type="button" onclick={() => (acctAsk = 'switch')}>
        <span class="r-main center"><span class="r-tx accent">{t('切换账号')}</span></span>
      </button>
      <button class="r" type="button" onclick={() => (acctAsk = 'logout')}>
        <span class="r-main center"><span class="r-tx red">{t('退出登录')}</span></span>
      </button>
    </div>
  {:else}
    <div class="hero">
      {@render avatar(true)}
      <div class="hero-name">{lgMode === 'register' ? t('注册新账号') : lgMode === 'token' ? t('管理员令牌') : lgMode === 'qr' ? t('扫码登录') : t('登录 The Bridge')}</div>
      <div class="hero-sub">{lgMode === 'register' ? t('需要邀请码；注册即登录。') + ' ' + t('服主默认只看得到你的会话标题、时间和用量；看内容要你在设置里允许。') : lgMode === 'token' ? t('粘贴服务端的访问令牌，以管理员身份直连。') : lgMode === 'qr' ? t('打开手机上的 The Bridge，在设置 › 账户点「扫一扫」') : t('登录后使用对话、工作空间与用量')}</div>
    </div>

    {#if lgMode === 'qr'}
      <div class="ig qr-card">
        <div class="qrbox" class:dim={pair.status !== 'pending'}>
          {#if pair.svg}{@html pair.svg}{/if}
          {#if pair.status !== 'pending'}
            <button class="qrov" type="button" onclick={() => pairCtl?.refresh()}
              disabled={pair.status === 'loading' || pair.status === 'idle' || pair.status === 'approved' || pair.status === 'scanned'}>{pairMsg}</button>
          {/if}
        </div>
      </div>
      <div class="ig">
        <button class="r" type="button" onclick={() => lgSwitch('login')}><span class="r-main center"><span class="r-tx accent">{t('账号密码登录')}</span></span></button>
      </div>
    {:else}
      {#if lgMode === 'login' && recents.length}
        {@render ghead(t('最近登录'))}
        <div class="ig">
          {#each recents as name (name)}
            <div class="r recent" class:sel={lgUser === name}>
              <button class="rc-pick" type="button" onclick={() => pickRecent(name)}>
                <span class="av sm" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
                <span class="r-main"><span class="r-tx">{name}</span>{#if lgUser === name}{@render check()}{/if}</span>
              </button>
              <button class="rc-x" type="button" onclick={() => dropRecent(name)} aria-label={t('从列表移除 {name}', { name })}><Sym name="xmark" weight={500} size={13} /></button>
            </div>
          {/each}
        </div>
      {/if}
      <form class="lg-form" onsubmit={lgSubmit}>
        {#if lgMode === 'token'}
          <TextField bind:value={lgTok} type="password" placeholder={t('访问令牌')} autocomplete="off" autocapitalize="off" spellcheck="false" />
        {:else}
          <TextField bind:value={lgUser} placeholder={lgMode === 'register' ? t('账号（2–32 位字母/数字/_/-）') : tc('settings', '账号')} autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" />
          <div class="lg-pass"><TextField bind:value={lgPass} type="password" placeholder={lgMode === 'register' ? t('密码（至少 8 位）') : t('密码')} autocomplete={lgMode === 'register' ? 'new-password' : 'current-password'} /></div>
          {#if lgMode === 'register'}
            <TextField bind:value={lgPass2} type="password" placeholder={t('确认密码')} autocomplete="new-password" />
            <TextField bind:value={lgInvite} placeholder={t('邀请码')} autocapitalize="off" autocorrect="off" spellcheck="false" />
          {/if}
        {/if}
        {#if lgErr}<p class="lg-err">{lgErr}</p>{/if}
        <button class="lg-go" type="submit" disabled={lgBusy}>{lgBusy ? t('请稍候…') : lgMode === 'register' ? t('注册') : t('登录')}</button>
      </form>
      <div class="ig">
        {#if lgMode === 'login'}
          {#if !canScan}
            <button class="r" type="button" onclick={() => lgSwitch('qr')}><span class="r-main"><span class="r-tx">{t('扫码登录')}</span>{@render chev()}</span></button>
          {/if}
          {#if me.features?.register !== false}
            <button class="r" type="button" onclick={() => lgSwitch('register')}><span class="r-main"><span class="r-tx">{t('注册新账号')}</span>{@render chev()}</span></button>
          {/if}
          <button class="r" type="button" onclick={() => lgSwitch('token')}><span class="r-main"><span class="r-tx">{t('用访问令牌登录')}</span>{@render chev()}</span></button>
        {:else}
          <button class="r" type="button" onclick={() => lgSwitch('login')}><span class="r-main center"><span class="r-tx accent">{t('返回登录')}</span></span></button>
        {/if}
      </div>
    {/if}
  {/if}
{/snippet}

{#snippet page(pid)}
  {#if pid === 'root'}{@render pRoot()}
  {:else if pid === 'account'}{@render pAccount()}
  {:else if pid === 'general'}{@render pGeneral()}
  {:else if pid === 'language'}{@render pLanguage()}
  {:else if pid === 'thinkmark'}{@render pThinkMark()}
  {:else if pid === 'appearance'}{@render pAppearance()}
  {:else if pid === 'wallpaper'}{@render pWallpaper()}
  {:else if pid === 'flux'}{@render pFlux()}
  {:else if pid === 'agentapi'}{@render pAgentApi()}
  {:else if pid === 'phone'}{@render pPhone()}
  {:else if pid === 'devices'}{@render pDevices()}
  {:else if pid === 'fwd-new'}{@render pFwdNew()}
  {:else if pid.startsWith('device:')}{@render pDevice(pid.slice(7))}
  {:else if pid === 'about'}{@render pAbout()}
  {:else if pid === 'history'}{@render pHistory()}
  {:else if pid === 'policy'}{@render pPolicy()}
  {:else if pid === 'extensions'}<Customize title={false} />
  {:else if pid.startsWith('plg-')}
    {@const pp = pluginPanels.list.find((x) => 'plg-' + x.id === pid)}
    {#if pp}<div class="plg-host">{#key pp.id}<PluginFrame id={pp.id} page={pp.page} mode="panel" onBack={pop} />{/key}</div>
    {:else}<p class="plg-gone">{t('这个插件面板不在了（插件被关掉或卸载了）')}</p>{/if}
  {:else if pid === 'ag-claude'}{@render pClaude()}
  {:else if pid.startsWith('ag-')}{@render pAgent(pid.slice(3))}
  {:else if pid.startsWith('vx:')}{@render pVxChoice(pid.slice(3))}
  {:else if pid.startsWith('acct:')}{@render pAcct(pid.slice(5))}
  {:else if CL_CHOICE[pid]}{@render pChoice(CL_CHOICE[pid])}
  {:else if CL_GROUP[pid]}{@render pClGroup(pid)}
  {/if}
{/snippet}

<!-- ─────────────── 外壳 ─────────────── -->
<svelte:window onkeydown={onKey} />
<div class="settings ios" class:dark class:closing class:previewing={!!sliding} class:staged={!!stage} class:modal={addrOpen || fbOpen || !!wpMenu || !!acctAsk || !!pw || anyAgModal}
  class:covered={ui.serverAdminOpen || ui.agentsOpen} class:solid-cover={ui.serverAdminOpen && !ui.agentsOpen} style:--sq={`url("${sq26}")`} use:edgeSwipe>
  <div class="panel" class:dragging bind:clientWidth={panelW} style:transform={dragX > 0 ? `translateX(${dragX}px)` : null}>
    {#each stack as pid, i (pid + ':' + i)}
      {@const top = i === depth - 1}
      {@const under = i === depth - 2}
      <section class="pg" class:top class:under class:hidden={!top && !under}
        style:transform={top && i > 0 ? `translate3d(${navX}px,0,0)` : under ? `translate3d(${-0.3 * (panelW - navX) * (navX < panelW ? 1 : 0)}px,0,0)` : null}
        style:--dim={under ? 0.1 * (1 - navX / Math.max(1, panelW)) : 0}
        aria-hidden={!top}>
        <div class="pg-scroll" onscroll={(e) => onPageScroll(pid, e)}>
          {#if !hasHero(pid)}<h1 class="lt">{titleOf(pid)}</h1>{/if}
          <div class="pg-body">{@render page(pid)}</div>
        </div>
        <div class="edge" class:on={(scrolled[pid] || 0) > 0}></div>
        <div class="bar">
          <GlassButton symbol="chevron.backward" weight={600} aria={t('返回')} onclick={() => (i === 0 ? back() : pop())} />
          <span class="bar-title" class:on={(scrolled[pid] || 0) > 1}>{titleOf(pid)}</span>
          <span class="bar-trail"></span>
        </div>
      </section>
    {/each}
  </div>

  <!-- ── 壁纸实景舞台：设置页退开、主页即预览 ── -->
  {#if stage}
    <div class="stage">
      <div class="stage-top">
        <GlassButton variant="stage" symbol="chevron.backward" weight={600} aria={t('返回')} onclick={exitStage} />
        <GlassButton variant="stage" prominent label={t('完成')} onclick={exitStage} />
      </div>
      <div class="stage-seg" style:--img={`url("${stageCapGlass}")`}>
        <span class="stage-knob" class:right={stage === 'dark'}></span>
        <button type="button" class:lit={stage === 'light'} onclick={() => stageSwap('light')}><Sym name="sun.max" weight={600} size={15} />{t('明亮壁纸')}</button>
        <button type="button" class:lit={stage === 'dark'} onclick={() => stageSwap('dark')}><Sym name="moon.fill" weight={600} size={14} />{t('深色壁纸')}</button>
      </div>
      <div style="flex:1"></div>
      {#if wpHasDepth(wp[stage])}
        <div class="stage-panel" style:--img={`url("${stagePanelGlass}")`}>
          <div class="sp-row">
            <span class="sp-tx">{t('空间壁纸')}<small>{t('随视角产生景深 · 电脑指针 / 手机重力跟随')}</small></span>
            <Toggle checked={spatial[stage].on} onchange={onSpatialToggle} label={t('空间壁纸开关')} />
          </div>
          {#if spatial[stage].on}
            <div class="sp-amp">
              <span class="sp-amp-lbl">{t('景深运动幅度')}</span>
              <span class="sp-amp-sl"><Slider value={spatial[stage].amp} label={t('景深运动幅度')} oninput={(f) => setSpatialAmp(stage, f)} /></span>
              <span class="sp-val">{Math.round(spatial[stage].amp * 100)}%</span>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if wpMenu}
    <Menu x={wpMenu.x} y={wpMenu.y} title={wpDef(wpMenu.id).name} onclose={closeWpMenu}
      items={[{ label: t('删除壁纸'), symbol: 'trash', destructive: true, onclick: wpMenuDelete }]} />
  {/if}

  {#if addrOpen}
    <Alert title={t('更换服务器地址')} message={t('服务器换了地址时 App 一般会自动跟过去（在家连上同一个 Wi-Fi 时最快）；没跟上、或要改连另一台服务器时，在这里填新地址。')} error={addrErr}
      onclose={() => { if (!addrBusy) addrOpen = false; }}
      actions={[{ label: addrBusy ? t('连接中…') : t('连接'), role: 'default', disabled: addrBusy, onclick: connectAddr }, { label: t('取消'), role: 'cancel', onclick: () => (addrOpen = false) }]}>
      <TextField bind:value={addrInput} placeholder="https://xxxx.trycloudflare.com" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    </Alert>
  {/if}

  {#if acctAsk}
    <Alert title={acctAsk === 'switch' ? t('切换账号') : t('退出登录？')}
      message={acctAsk === 'switch' ? t('会先退出当前账号（{name}），再用别的账号登录。', { name: shownName }) : t('只退出这台设备，其它设备上的登录不受影响。')}
      onclose={() => { if (!acctBusy) acctAsk = null; }}
      actions={[{ label: acctBusy ? t('请稍候…') : acctAsk === 'switch' ? t('切换') : t('退出登录'), role: acctAsk === 'switch' ? 'default' : 'destructive', disabled: acctBusy, onclick: acctConfirm },
        { label: t('取消'), role: 'cancel', onclick: () => { if (!acctBusy) acctAsk = null; } }]} />
  {/if}

  {#if pw}
    <Sheet title={t('修改密码')} closeLabel={t('取消')} confirmLabel={t('保存')} confirmDisabled={pw.busy} onclose={() => { if (!pw.busy) pw = null; }} onconfirm={savePw}>
      <div class="pw-form">
        <TextField bind:value={pw.old} type="password" placeholder={t('原密码')} autocomplete="current-password" autofocus />
        <TextField bind:value={pw.next} type="password" placeholder={t('新密码（至少 8 位）')} autocomplete="new-password" />
        <TextField bind:value={pw.again} type="password" placeholder={t('再输一次新密码')} autocomplete="new-password" />
        {#if pw.err}<p class="fb-err">{pw.err}</p>{/if}
        <p class="fb-intro">{t('改完之后，别的设备需要重新登录')}</p>
      </div>
    </Sheet>
  {/if}

  {#if acctForm}
    <Sheet title={acctForm.isNew ? t('添加 Claude 账号') : t('编辑账号')} closeLabel={t('取消')} confirmLabel={acctForm.isNew ? t('添加') : t('保存')}
      confirmDisabled={acctForm.busy} onclose={() => { if (!acctForm.busy) acctForm = null; }} onconfirm={saveAcctForm}>
      <div class="pw-form">
        <TextField bind:value={acctForm.label} placeholder={t('如：主号 / 备用号')} autocapitalize="off" autocorrect="off" spellcheck="false" />
        <TextField bind:value={acctForm.token} type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
          placeholder={acctForm.isNew ? 'sk-ant-oat…' : (acctForm.hasToken ? t('留空＝不改，当前 …{tail}', { tail: acctForm.tokenTail || '' }) : t('留空＝用本机登录态'))} />
        {#if acctForm.err}<p class="fb-err">{acctForm.err}</p>{/if}
        <p class="fb-intro">{t('在目标账号登录状态下运行 claude setup-token，把返回的长期 token 粘进来。')}</p>
      </div>
    </Sheet>
  {/if}

  {#if acctDel}
    <Alert title={t('删除账号 {name}？', { name: accLabel(acctDel.label) })} message={t('只从切换列表移除；若删的是当前账号，会自动切到另一个。')}
      onclose={() => (acctDel = null)}
      actions={[{ label: t('删除'), role: 'destructive', onclick: confirmAcctDel }, { label: t('取消'), role: 'cancel', onclick: () => (acctDel = null) }]} />
  {/if}

  {#if agLast}
    <Alert title={t('关闭 {name}？', { name: agLast.label })} message={t('这是最后一个开着的 agent，关掉后所有客户端都没有可用的分页。确定吗？')}
      onclose={() => (agLast = false)}
      actions={[{ label: tc('开关', '关闭'), role: 'destructive', onclick: confirmAgLast }, { label: t('取消'), role: 'cancel', onclick: () => (agLast = false) }]} />
  {/if}

  {#if bypassAsk}
    <!-- 官方「Allow bypass permissions mode」的确认语义；页面上不写解释，全在这里 -->
    <Alert title={t('允许绕过权限模式？')} message={t('跳过所有权限检查，让 Claude 不间断地干活，适合修 lint、生成样板代码这类事。让 Claude 随意执行命令有风险，可能造成数据丢失、系统损坏或数据外泄（例如提示注入攻击）。')}
      onclose={() => (bypassAsk = false)}
      actions={[{ label: t('允许'), role: 'destructive', onclick: confirmBypass }, { label: t('取消'), role: 'cancel', onclick: () => (bypassAsk = false) }]} />
  {/if}

  {#if prefixEdit}
    <Alert title={t('分支前缀')} message={t('新会话的工作树分支叫 {prefix}/<名字>。留空 = claude。', { prefix: prefixEdit.value.trim() || 'claude' })} error={prefixEdit.err}
      onclose={() => { if (!prefixEdit.busy) prefixEdit = null; }}
      actions={[{ label: prefixEdit.busy ? t('保存中…') : t('保存'), role: 'default', disabled: prefixEdit.busy, onclick: savePrefix }, { label: t('取消'), role: 'cancel', onclick: () => (prefixEdit = null) }]}>
      <TextField bind:value={prefixEdit.value} placeholder="claude" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    </Alert>
  {/if}

  {#if dspEdit}
    <Alert title={t('子 agent 调度偏好')} message={t('派子 agent 时怎么挑模型和推理强度，用大白话写就行。空着时由 Claude 按任务难度自己定，不再照搬主会话。')} error={dspEdit.err}
      onclose={() => { if (!dspEdit.busy) dspEdit = null; }}
      actions={[{ label: dspEdit.busy ? t('保存中…') : t('保存'), role: 'default', disabled: dspEdit.busy, onclick: saveDispatch }, { label: t('取消'), role: 'cancel', onclick: () => (dspEdit = null) }]}>
      <TextField multiline rows={6} bind:value={dspEdit.value} maxlength={CS.subagentDispatch.maxLen}
        placeholder={t('例：简单任务用 mimo-v2.6-flash；普通构建任务用 deepseek-v4.1-flash；其余按实际情况判断。')} autofocus />
    </Alert>
  {/if}

  {#if numEdit}
    <Alert title={numEdit.label} message={numEdit.tz ? t('IANA 时区名，例如 Asia/Shanghai、America/Los_Angeles。') : t('留空或填 0 = 不限。')} error={numEdit.err || ''}
      onclose={() => { if (!numEdit.busy) numEdit = null; }}
      actions={[{ label: numEdit.busy ? t('保存中…') : t('保存'), role: 'default', disabled: numEdit.busy, onclick: saveNum }, { label: t('取消'), role: 'cancel', onclick: () => (numEdit = null) }]}>
      <TextField bind:value={numEdit.value} placeholder={numEdit.tz ? 'Asia/Shanghai' : t('不限')} inputmode={numEdit.tz ? undefined : 'decimal'} autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    </Alert>
  {/if}

  {#if fbOpen}
    <Sheet title={fbDone ? t('收到，谢谢！') : t('提交反馈')} closeLabel={t('关闭')} confirmLabel={fbDone ? t('好') : t('提交')}
      confirmDisabled={fbBusy} onclose={() => (fbOpen = false)} onconfirm={submitFeedback}>
      {#if fbDone}
        <div class="fb-done">
          <Sym name="checkmark.circle.fill" weight={400} size={56} class="fb-done-ic" />
          <p>{fbSentUp === 'queued' ? t('已记下，也会转给 {to}。', { to: fbDest.to }) : fbSentUp === 'off' ? t('已记下，服务器管理员会看到。') : t('反馈已记到开发者的库里，会看到。')}</p>
        </div>
      {:else}
        <p class="fb-intro">{fbUp && fbUp.mode !== 'inbox' ? t('遇到的问题、想要的功能、体验吐槽都行，可附图片/视频。') : t('遇到的问题、想要的功能、体验吐槽都行，可附图片/视频，会直接进开发者的反馈库。')}</p>
        <TextField multiline bind:value={fbText} placeholder={t('写下你的反馈…')} />
        <div class="fb-atts">
          {#each fbAtts as a (a)}
            <div class="fb-att">
              {#if a.kind === 'image' && a.url}<img src={a.url} alt="" />{:else}<span class="fb-att-ico">{a.kind === 'video' ? '🎬' : '📎'}</span>{/if}
              {#if a.pending}<span class="fb-att-up">{Math.round((a.progress || 0) * 100)}%</span>{/if}
              <button type="button" class="fb-att-x" onclick={() => removeFbAtt(a)} aria-label={t('移除')}><Sym name="xmark.circle.fill" weight={400} size={20} /></button>
            </div>
          {/each}
          <button type="button" class="fb-add" onclick={() => fbFileInput && fbFileInput.click()} aria-label={t('添加图片或视频')}>
            <Sym name="photo.badge.plus" weight={400} size={24} />
          </button>
        </div>
        {#if fbUp?.mode === 'push'}
          <div class="fb-up-row">
            <span class="fb-up-tx">{t('这条也发给 {to}', { to: fbDest.to })}<small>{fbDest.public ? t('勾选后会同时发给 {to}：带文字、所在界面、版本和系统，不带账号名和服务器地址。这是公开发布：内容任何人都能看到，请别写隐私、账号、密钥；图片不会公开发布（只记张数），视频不发。', { to: fbDest.to }) : t('勾选后会同时发给 {to}：带文字、所在界面、版本和系统，不带账号名和服务器地址；图片最多 3 张，原样发出，截图里能看到的开发者也能看到；视频不发。', { to: fbDest.to })}</small></span>
            <Toggle checked={fbConsent} onchange={() => (fbConsent = !fbConsent)} label={t('这条也发给 {to}', { to: fbDest.to })} />
          </div>
        {/if}
        {#if fbUpNote}<p class="fb-up">{fbUpNote}</p>{/if}
        {#if fbInboxLine}<p class="fb-up" class:bad={!!fbUp.lastPullError || fbUp.reason === 'no-relay'}>{fbInboxLine}</p>{/if}
        {#if fbUp?.admin && fbUp.mode !== 'inbox' && !fbUp.reason}
          <div class="fb-up-row">
            <span class="fb-up-tx">{t('把用户反馈同时发给 {to}', { to: fbDest.to })}<small>{fbUpAdminSub}</small>{#if fbUp.pending}<small>{t('还有 {n} 条没发出去，连上后自动补发。', { n: fbUp.pending })}</small>{/if}</span>
            <Toggle checked={fbUp.mode === 'push'} disabled={fbUpBusy} onchange={toggleFbUp} label={t('把用户反馈同时发给 {to}', { to: fbDest.to })} />
          </div>
        {/if}
        {#if fbErr}<p class="fb-err">{fbErr}</p>{/if}
        {#if fbBusy}<p class="fb-busy">{t('提交中…')}</p>{/if}
        <input bind:this={fbFileInput} type="file" accept="image/*,video/*" multiple onchange={onFbFiles} hidden />
      {/if}
    </Sheet>
  {/if}
</div>

{#if provOpen}<ProviderManager onClose={() => (provOpen = false)} />{/if}

<style>
  /* ── 颜色令牌 v5「墨与象牙」：取自应用图标（墨色渐变 #282521→#0F0E0C、月桥象牙 #F3EEE4）。
     暖灰中性色 + 单一墨色强调（开关、勾选、主按钮、进度）；红 / 琥珀 / 绿只表达状态，不做装饰。
     变量名沿用 --i-*（ios27 控件库读它们）；--i-blue / --i-green / --i-orange 映射到强调与语义色，旧引用自动跟上。── */
  .ios {
    --i-bg: #f2f0eb; --i-card: #fcfbf8; --i-label: #1d1b18;
    --i-label2: rgba(29, 27, 24, .56); --i-label3: rgba(29, 27, 24, .3); --i-label4: rgba(29, 27, 24, .13);
    --i-sep: rgba(29, 27, 24, .075);
    --i-fill1: rgba(29, 27, 24, .15); --i-fill2: rgba(29, 27, 24, .1); --i-fill3: rgba(29, 27, 24, .07); --i-fill4: rgba(29, 27, 24, .045);
    --i-press: rgba(29, 27, 24, .055);
    --i-seg-sel: #fff; --i-field: rgba(29, 27, 24, .06);
    --i-accent: #1d1b18; --i-on-accent: #f6f3ec; --i-knob: #fff; --i-knob-on: #fff;
    --i-tile: rgba(29, 27, 24, .05); --i-tile-ink: rgba(29, 27, 24, .82);
    --i-av: linear-gradient(160deg, #e8e3d9, #d6cfc1); --i-av-ink: #3a352d;
    --i-ok: #4f8a5b; --i-warn: #b0741c; --i-red: #c4473b;
    --i-dim: rgba(24, 21, 17, .26);
    --i-blue: var(--i-accent); --i-green: var(--i-ok); --i-orange: var(--i-warn);
    color-scheme: light;
  }
  .ios.dark {
    --i-bg: #100f0d; --i-card: #1a1917; --i-label: #f1ece2;
    --i-label2: rgba(241, 236, 226, .54); --i-label3: rgba(241, 236, 226, .27); --i-label4: rgba(241, 236, 226, .11);
    --i-sep: rgba(241, 236, 226, .065);
    --i-fill1: rgba(241, 236, 226, .19); --i-fill2: rgba(241, 236, 226, .12); --i-fill3: rgba(241, 236, 226, .08); --i-fill4: rgba(241, 236, 226, .05);
    --i-press: rgba(241, 236, 226, .05);
    --i-seg-sel: rgba(241, 236, 226, .2); --i-field: rgba(241, 236, 226, .07);
    --i-accent: #ebe5d8; --i-on-accent: #151412; --i-knob: #f1ece2; --i-knob-on: #151412;
    --i-tile: rgba(241, 236, 226, .065); --i-tile-ink: rgba(241, 236, 226, .86);
    --i-av: linear-gradient(160deg, #3a3631, #211f1b); --i-av-ink: #efe9dd;
    --i-ok: #85b78f; --i-warn: #d9a441; --i-red: #e2725f;
    --i-dim: rgba(0, 0, 0, .45);
    color-scheme: dark;
  }

  /* ── 外壳：全屏；手机上面板满宽，宽屏靠右 440（其余压暗 Overlays/Default）── */
  .settings {
    position: fixed; inset: 0; z-index: 60; display: flex; justify-content: flex-end;
    font-family: var(--font-brand-sans), -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased; color: var(--i-label);
    background: rgba(0, 0, 0, .2); animation: set-dim 360ms var(--ea-fade) both;
    transition: background-color 280ms var(--ea-fade);
  }
  .settings.dark { background: rgba(0, 0, 0, .5); }
  @keyframes set-dim { from { background-color: transparent; } }
  .panel {
    position: relative; width: 100%; max-width: 440px; height: 100%; overflow: hidden; background: var(--i-bg);
    animation: panel-in 520ms cubic-bezier(.2, .95, .25, 1) both;
    transition: transform 360ms cubic-bezier(.2, .95, .25, 1), background-color 240ms var(--ea-fade), opacity 240ms var(--ea-fade);
  }
  @keyframes panel-in { from { transform: translateX(100%); } }
  .panel.dragging { transition: background-color 240ms var(--ea-fade), opacity 240ms var(--ea-fade); }
  .settings.closing { background: transparent; }
  .settings.closing .panel { transform: translateX(100%) !important; transition: transform 340ms cubic-bezier(.3, 0, .8, .15); }

  /* 拖画质 / 流体滑块：设置页退开露出主页（主页那一刻恢复自己的玻璃折射），只留正在拖的那一行 */
  .settings.previewing, .settings.staged { background: transparent; }
  .settings.previewing .panel, .settings.staged .panel { background: transparent; }
  .settings.previewing .lt, .settings.previewing .bar, .settings.previewing .edge, .settings.previewing .gfoot,
  .settings.previewing .ghead, .settings.previewing .seg-wrap, .settings.previewing .r:not(.live) { opacity: 0; pointer-events: none; }
  .settings.previewing .ig { background: transparent; box-shadow: none; }
  .settings.previewing .r.live { background: var(--i-card); border-radius: 18px; }
  .lt, .bar, .edge, .gfoot, .ghead, .seg-wrap, .r { transition: opacity 200ms var(--ea-fade); }
  .settings.staged .panel { opacity: 0; pointer-events: none; }

  /* 服务端控制台 / 扩展 / Agent 盖在上面时：它们自带深色 tint、磨砂借本层——退回 v3 的毛玻璃罩（同屏单层 backdrop） */
  .settings.covered { background: rgba(9, 11, 16, .44); backdrop-filter: blur(26px) saturate(1.5); -webkit-backdrop-filter: blur(26px) saturate(1.5); }
  .settings.covered .panel { opacity: 0; pointer-events: none; }
  /* 服务端控制台 v2 不透明、从右推入：设置页原样留在底下（像又推了一层子页），不需要毛玻璃罩 */
  .settings.covered.solid-cover { background: rgba(0, 0, 0, .2); -webkit-backdrop-filter: none; backdrop-filter: none; }
  .settings.covered.solid-cover.dark { background: rgba(0, 0, 0, .5); }
  .settings.covered.solid-cover .panel { opacity: 1; }

  /* ── 页面层 ── */
  .pg { position: absolute; inset: 0; background: var(--i-bg); will-change: transform; transition: background-color 240ms var(--ea-fade); }
  .pg.hidden { visibility: hidden; }
  .pg.under::after { content: ''; position: absolute; inset: 0; background: #000; opacity: var(--dim, 0); pointer-events: none; }
  .pg.top:not(:first-child) { box-shadow: -1px 0 0 var(--i-label4), -12px 0 32px rgba(0, 0, 0, .07); }
  .settings.previewing .pg, .settings.staged .pg { background: transparent; box-shadow: none; }
  .pg-scroll { position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none;
    padding: calc(var(--sat) + 54px) 0 calc(max(16px, var(--sab)) + 32px); }
  .pg-scroll::-webkit-scrollbar { width: 0; }
  /* 大标题：30/38 Semibold，左边与卡内正文对齐 */
  .lt { margin: 0; padding: 4px 32px 6px; font-size: 30px; line-height: 38px; font-weight: 600; letter-spacing: -.2px; }
  .pg-body { padding: 16px 16px 0; }
  .plg-host { height: calc(100dvh - var(--sat, 0px) - 150px); min-height: 360px; margin: 0 -16px; }
  .plg-gone { color: var(--muted); font-size: 14px; text-align: center; padding: 40px 0; }

  /* 顶栏（kit「Toolbar - Top - iPhone」）：控件行 44 高、左右 16；滚上去后居中出现 17/22 Semibold 小标题 */
  .bar { position: absolute; left: 0; right: 0; top: var(--sat); height: 44px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; pointer-events: none; }
  .bar > :global(*) { pointer-events: auto; }
  .bar-title { position: absolute; left: 76px; right: 76px; text-align: center; font-size: 16px; line-height: 22px; font-weight: 600; letter-spacing: -.1px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0; transform: translateY(4px); transition: opacity 180ms linear, transform 220ms var(--ea-std); pointer-events: none; }
  .bar-title.on { opacity: 1; transform: none; }
  .bar-trail { width: 44px; }
  /* 滚动边缘效果（kit「Scroll Edge Effect - Soft」：顶上重度模糊 + 线性渐隐遮罩；Figma 模糊 → CSS σ） */
  .edge {
    position: absolute; left: 0; right: 0; top: 0; height: calc(var(--sat) + 76px); pointer-events: none; opacity: 0; transition: opacity 200ms linear;
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    background: linear-gradient(to bottom, color-mix(in srgb, var(--i-bg) 72%, transparent) 0%, color-mix(in srgb, var(--i-bg) 30%, transparent) 60%, transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 45%, transparent 100%); mask-image: linear-gradient(to bottom, #000 0%, #000 45%, transparent 100%);
  }
  .edge.on { opacity: 1; }
  /* 弹窗 / 表单页 / 菜单开着、或被控制台盖住时：它们自带一层 backdrop，这层让出去（同屏两层 backdrop 叠放，上层会静默失效） */
  .settings.modal .edge, .settings.covered .edge { -webkit-backdrop-filter: none; backdrop-filter: none; }

  /* ── 分组卡片：圆角 18，发丝描边托出层次（不靠投影） ── */
  .ig { position: relative; background: var(--i-card); border-radius: 18px; overflow: hidden; margin-bottom: 26px;
    box-shadow: inset 0 0 0 .5px var(--i-label4); transition: background-color 240ms var(--ea-fade); }
  .ig:has(+ .gfoot) { margin-bottom: 0; }
  .gfoot { margin: 0; padding: 8px 16px 24px; font-size: 12.5px; line-height: 18px; color: var(--i-label2); }
  .gfoot.ak-intro { padding-top: 0; }
  .gfoot.ak-warn { color: var(--i-warn); }
  .ig.ak-fresh { box-shadow: inset 0 0 0 1.5px var(--i-accent); }
  .ak-key { flex: 1; min-width: 0; padding: 6px 0; font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 14px; line-height: 20px; word-break: break-all; user-select: text; -webkit-user-select: text; }
  .gfoot.err { color: var(--i-red); padding-bottom: 10px; }
  /* 分组标题：13 Medium、次级色，与卡内正文左对齐 */
  .ghead { margin: 0; padding: 0 16px 8px; font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: .2px; color: var(--i-label2); }

  /* ── 行：50 高、左右 16；分隔线 1px，从正文起、到右内边距止 ── */
  .r {
    position: relative; display: flex; align-items: center; gap: 14px; width: 100%; min-height: 50px; padding: 0 16px;
    border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent;
    transition: background-color 260ms var(--ea-fade), opacity 200ms var(--ea-fade);
  }
  div.r { cursor: default; }
  a.r { text-decoration: none; }
  /* 按下：60ms 落墨、260ms 褪去——比瞬时灰块安静 */
  button.r:active:not(:disabled) { background: var(--i-press); transition-duration: 60ms; }
  .r:disabled { cursor: default; }
  .r:disabled .r-tx { opacity: .55; }
  .r-main { position: relative; flex: 1; min-width: 0; align-self: stretch; display: flex; align-items: center; gap: 10px; min-height: 50px; padding: 12px 0; }
  .r + .r .r-main::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: var(--i-sep); }
  .r-main.center { justify-content: center; text-align: center; }
  .r-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 16px; line-height: 22px; letter-spacing: -.1px; }
  .r-main.center .r-tx { flex: none; align-items: center; }
  .r-tx.accent { color: var(--i-accent); font-weight: 600; }
  .r-tx.red { color: var(--i-red); font-weight: 500; }
  .r-sub { font-size: 13px; line-height: 18px; letter-spacing: 0; color: var(--i-label2); }
  .r-d { flex: none; max-width: 52%; font-size: 15px; line-height: 22px; color: var(--i-label2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
  .r-d.accent { color: var(--i-accent); font-weight: 600; }
  /* Claude 设置：标签 + 「已改过默认值」小点 + 「这台设备」胶囊同一行；依赖项缩进紧跟主项 */
  .r-lbl { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  /* 设备页：行内输入框、行尾小按钮 */
  .dv-in { flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 0; border-radius: 10px; background: var(--i-fill3); color: var(--i-label); font: inherit; font-size: 16px; outline: none; }
  .dv-minis { flex: none; display: flex; gap: 6px; }
  .dv-minis button { padding: 5px 11px; border-radius: 9px; background: var(--i-fill3); color: var(--i-accent); font-size: 14px; font-weight: 600; }
  .dv-minis button.red { color: var(--i-red); }
  .dv-minis button:disabled { opacity: .5; }
  .dv-url { word-break: break-all; }
  .gfoot.dv-err { color: var(--i-red); }
  .chg { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--i-accent); }
  .pill.dev { font-weight: 500; letter-spacing: 0; }
  .r.ind { padding-left: 32px; }
  .mk-prev { flex: none; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; color: var(--coral); }
  .r-d.err { color: var(--i-red); }
  .r-d.num, .num { font-variant-numeric: tabular-nums; }
  .r-d.addr { direction: rtl; }   /* 长地址显示尾部（域名段） */
  .r-d.sel { user-select: text; }
  .r :global(.chev) { color: var(--i-label3); margin-left: 2px; }
  .r :global(.ck) { color: var(--i-accent); }
  .r :global(.okmark) { color: var(--i-ok); }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--i-ok); flex: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--i-ok) 18%, transparent); }
  .new-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--i-accent); flex: none; }
  .ring { flex: none; width: 20px; height: 20px; border-radius: 50%;
    background: conic-gradient(var(--i-accent) var(--p, 0deg), var(--i-fill2) 0);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px)); }
  .spin { flex: none; width: 16px; height: 16px; border-radius: 50%; border: 1.8px solid var(--i-fill2); border-top-color: var(--i-label2); animation: sp-rot .8s linear infinite; }

  /* 行首图标格：30 方、圆角 8、中性底；线稿 18（墨色），品牌标 18（原色） */
  .ri { flex: none; width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
    background: var(--i-tile); color: var(--i-tile-ink); }
  .ri :global(svg) { width: 18px; height: 18px; display: block; }
  .ri.brand img { width: 18px; height: 18px; display: block; object-fit: contain; }

  /* 账户卡（根页顶） */
  .r.acctcard { gap: 14px; min-height: 76px; }
  .r.acctcard .r-main { min-height: 76px; }
  .acct-title { font-size: 18px; line-height: 24px; font-weight: 600; letter-spacing: -.2px; }

  /* 字母头像：墨色渐变底 + 象牙衬线字（与应用图标同一套材质）；没登录是一个人形剪影 */
  .av { width: 50px; height: 50px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    background: var(--i-av); color: var(--i-av-ink); box-shadow: inset 0 0 0 .5px var(--i-label4);
    font-family: var(--font-brand-serif), Georgia, "Songti SC", serif; font-size: 22px; line-height: 1; font-weight: 500; }
  .av.none { background: var(--i-tile); color: var(--i-label3); }
  .av.none svg { width: 60%; height: 60%; }
  .av.big { width: 80px; height: 80px; font-size: 34px; }
  .av.sm { width: 30px; height: 30px; font-size: 14px; }
  /* 头图（agent 页 / 账户 / 关于 / 单个账号）：代替大标题 */
  .hero { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 4px 12px 28px; }
  .hero-mark { width: 76px; height: 76px; border-radius: 22px; display: flex; align-items: center; justify-content: center;
    background: var(--i-card); box-shadow: inset 0 0 0 .5px var(--i-label4), 0 10px 30px -12px rgba(0, 0, 0, .25); }
  .hero-mark img { width: 42px; height: 42px; object-fit: contain; }
  .hero-name { margin-top: 14px; font-family: var(--font-brand-serif), Georgia, "Songti SC", serif; font-size: 26px; line-height: 32px; font-weight: 500; letter-spacing: -.2px; }
  .hero-sub { margin-top: 4px; font-size: 13px; line-height: 18px; color: var(--i-label2); }
  .hero-sub.warn { color: var(--i-warn); }
  .ig.usage { display: flex; flex-direction: column; gap: 16px; padding: 14px 16px 16px; }
  .u { display: flex; flex-direction: column; gap: 8px; }
  .u-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .u-l { font-size: 16px; line-height: 22px; }
  .u-v { font-size: 14px; color: var(--i-label2); font-variant-numeric: tabular-nums; }
  .bar-u { display: block; height: 4px; border-radius: 2px; background: var(--i-fill3); overflow: hidden; }
  .bar-u i { display: block; height: 100%; min-width: 3px; border-radius: 2px; background: var(--i-accent); transition: width .4s var(--ea-std); }
  .bar-u i.hot { background: var(--i-red); }
  .u-r { font-size: 12.5px; line-height: 18px; color: var(--i-label2); }
  /* 登录表单：文本框组 + 满宽主按钮（kit Button / Large / Prominent：50 高、胶囊、17 Semibold） */
  .lg-form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
  .lg-err { margin: 2px 16px 0; font-size: 15px; line-height: 20px; color: var(--i-red); }
  .lg-go { height: 50px; margin-top: 6px; border: 0; border-radius: 25px; background: var(--i-accent); color: var(--i-on-accent); font: inherit; font-size: 16px; font-weight: 600;
    cursor: pointer; -webkit-tap-highlight-color: transparent; transition: opacity 150ms linear, transform 120ms var(--ea-out); }
  .lg-go:active:not(:disabled) { transform: scale(.98); opacity: .85; }
  .lg-go:disabled { opacity: .55; cursor: default; }
  .r.recent { padding: 0; gap: 0; }
  .rc-pick { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 0 0 0 16px; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .rc-pick:active { background: var(--i-press); }
  .rc-x { flex: none; width: 48px; align-self: stretch; display: flex; align-items: center; justify-content: center; border: 0; background: none; color: var(--i-label3); cursor: pointer; }
  .rc-x:active { color: var(--i-label2); }
  .r.recent + .r.recent .r-main::before { right: -48px; }
  .qr-card { display: flex; justify-content: center; padding: 18px; }
  .qrbox { position: relative; width: 216px; height: 216px; padding: 12px; border-radius: 18px; background: #fff; }
  .qrbox :global(svg) { display: block; width: 100%; height: 100%; }
  .qrbox.dim :global(svg) { opacity: .1; }
  .qrov { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; border: 0; border-radius: 18px; background: transparent;
    color: #000; font: inherit; font-size: 15px; line-height: 20px; font-weight: 600; text-align: center; cursor: pointer; }
  .qrov:disabled { cursor: default; }
  .pw-form { display: flex; flex-direction: column; gap: 10px; }
  .pw-form .fb-intro { margin: 4px 4px 0; }
  .pw-form .fb-err { margin: 2px 4px 0; }

  /* 滑块行：上面「名称 + 数值」，下面整行滑块（kit Sliders 轨道） */
  .r.slr { flex-direction: column; align-items: stretch; gap: 2px; padding: 12px 16px 4px; }
  .r.slr + .r.slr::before { content: ''; position: absolute; left: 16px; right: 16px; top: 0; height: 1px; background: var(--i-sep); transition: opacity 200ms; }
  .settings.previewing .r.slr::before { opacity: 0; }
  .slr-head { display: flex; align-items: center; gap: 12px; }
  .r.slr.off .slr-head { opacity: .45; }

  .seg-wrap { margin-bottom: 0; }

  /* ── Agent 页 ── */
  .r-main.dim .r-tx { opacity: .45; }
  .r-d.warn, .r-sub.warn { color: var(--i-warn); }
  /* 分组标题右侧的小图标钮（刷新用量）：忙时转圈 */
  .ghead-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
  .gh-ico { flex: none; width: 30px; height: 30px; margin: -6px 8px 2px 0; padding: 6px; border: 0; border-radius: 50%; background: none;
    color: var(--i-label2); cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background-color 200ms var(--ea-fade), color 200ms; }
  .gh-ico :global(svg) { width: 18px; height: 18px; display: block; }
  .gh-ico:active:not(:disabled) { background: var(--i-press); color: var(--i-label); }
  .gh-ico.busy :global(svg) { animation: sp-rot .9s linear infinite; }
  .gh-ico:disabled { cursor: default; }
  .r.acct-r .r-main { padding: 13px 0 14px; }
  .acct-name { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  /* 标签：套餐用发丝描边的中性小签；「暂不使用」是唯一带色的（状态） */
  .pill { flex: none; padding: 0 6px; border-radius: 5px; font-size: 11px; line-height: 17px; font-weight: 600; letter-spacing: .3px;
    color: var(--i-label2); box-shadow: inset 0 0 0 1px var(--i-label4); }
  .pill.red { color: var(--i-red); box-shadow: none; background: color-mix(in srgb, var(--i-red) 13%, transparent); }
  /* 「使用中」：绿点 + 小字，取代原来勾与箭头并排 */
  .cur { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; line-height: 17px; font-weight: 500; color: var(--i-label2); }
  .cur::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--i-ok); }
  /* 号池行里的三根迷你用量条（5 小时 / 每周 / Fable）：3 高轨道，默认中性，临界才上琥珀 / 红 */
  .mini { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 9px; }
  .mini-na { grid-column: 1 / -1; font-size: 12.5px; line-height: 18px; color: var(--i-label2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mini-na.err { color: var(--i-red); white-space: normal; }
  .mini-m { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .mini-h { display: flex; justify-content: space-between; gap: 4px; font-size: 12px; line-height: 16px; color: var(--i-label2); }
  .mini-h b { font-weight: 600; color: var(--i-label); font-variant-numeric: tabular-nums; }
  .mini-h b.amber { color: var(--i-warn); } .mini-h b.red { color: var(--i-red); }
  .mini-bar { display: block; height: 3px; border-radius: 2px; background: var(--i-fill3); overflow: hidden; }
  .mini-bar i { display: block; height: 100%; border-radius: 2px; background: var(--i-label2); transition: width .4s var(--ea-std); }
  .mini-bar i.amber { background: var(--i-warn); } .mini-bar i.red { background: var(--i-red); }
  .mini-r { min-height: 15px; font-size: 11px; line-height: 15px; color: var(--i-label2); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .u-v.hot { color: var(--i-red); }
  .bar-u i.warm { background: var(--i-warn); }
  .u-r.err { color: var(--i-red); }
  /* 顺序：两枚小圆钮 */
  .steps { flex: none; display: flex; gap: 6px; }
  .steps button { width: 32px; height: 32px; padding: 7px; border: 0; border-radius: 50%; background: var(--i-fill4); color: var(--i-label); cursor: pointer;
    -webkit-tap-highlight-color: transparent; transition: background-color 200ms var(--ea-fade), opacity 200ms; }
  .steps button :global(svg) { width: 18px; height: 18px; display: block; }
  .steps button:active:not(:disabled) { background: var(--i-fill2); }
  .steps button:disabled { opacity: .3; cursor: default; }

  /* 外观：明暗两张小样卡 + 单选圆点 */
  .ig.theme-pick { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 16px; }
  .tp { display: flex; flex-direction: column; align-items: center; gap: 10px; border: 0; padding: 0; background: none; font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .tp-art { position: relative; width: 100%; height: 104px; border-radius: 12px; padding: 14px 12px; display: flex; flex-direction: column; gap: 7px;
    box-shadow: inset 0 0 0 .5px rgba(0, 0, 0, .14); transition: box-shadow 220ms var(--ea-fade), transform 200ms var(--ea-std); }
  .tp:active .tp-art { transform: scale(.97); }
  .tp-art.light { background: #f2f0eb; }
  .tp-art.dark { background: #100f0d; box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .12); }
  .tp-art i { display: block; height: 18px; border-radius: 6px; }
  .tp-art i:first-child { width: 46%; height: 9px; border-radius: 3px; margin-bottom: 3px; }
  .tp-art.light i { background: #fcfbf8; box-shadow: inset 0 0 0 .5px rgba(29, 27, 24, .1); }
  .tp-art.light i:first-child { background: #1d1b18; box-shadow: none; }
  .tp-art.dark i { background: #1f1e1b; }
  .tp-art.dark i:first-child { background: #f1ece2; }
  .tp.on .tp-art { box-shadow: 0 0 0 2px var(--i-card), 0 0 0 3.5px var(--i-accent); }
  .tp-name { font-size: 14px; line-height: 18px; color: var(--i-label2); }
  .tp.on .tp-name { color: var(--i-label); font-weight: 600; }
  .tp-dot { width: 20px; height: 20px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--i-label3); transition: box-shadow 200ms var(--ea-fade); }
  .tp.on .tp-dot { box-shadow: inset 0 0 0 6px var(--i-accent); }

  /* 关于 */
  .about-icon { width: 84px; height: 84px; border-radius: 19px; -webkit-mask-box-image: var(--sq) 42 / 30px; }
  .conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--i-label3); flex: none; }
  .conn-dot.lan { background: var(--i-ok); }
  .r-sub.err { color: var(--i-red); }
  /* 新版本说明、版本历史：说明文字多行，日期贴顶 */
  .ig.notes { padding: 13px 16px 14px; }
  .n-h { display: flex; align-items: baseline; gap: 8px; font-size: 16px; line-height: 22px; font-weight: 600; }
  .n-s { font-size: 13px; font-weight: 400; color: var(--i-label2); }
  .n-b { margin: 6px 0 0; font-size: 14px; line-height: 21px; color: var(--i-label2); white-space: pre-line; }
  .r.hist .r-main { align-items: flex-start; }
  .r.hist .r-d { padding-top: 1px; font-size: 13px; }
  .r-d.dsp-d { display: block; max-width: 45%; }
  .h-c { font-weight: 400; color: var(--i-label2); }

  /* ── 壁纸页 ── */
  .wp-cur { padding: 16px; }
  .wp-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .wp-prev { display: flex; flex-direction: column; align-items: center; gap: 10px; border: 0; padding: 0; background: none; cursor: pointer; color: inherit; font: inherit; -webkit-tap-highlight-color: transparent; }
  .wp-phone { position: relative; width: 100%; aspect-ratio: 9 / 19.5; border-radius: 20px; background-color: #111; overflow: hidden;
    box-shadow: 0 0 0 1px var(--i-label4); transition: transform 200ms var(--ea-std), box-shadow 200ms linear; }
  .wp-prev:active .wp-phone { transform: scale(.97); }
  .wp-prev.now .wp-phone { box-shadow: 0 0 0 3px var(--i-card), 0 0 0 5.5px var(--i-blue); }
  .wp-clock { position: absolute; top: 14%; left: 0; right: 0; text-align: center; color: #fff; font-size: 30px; line-height: 1; font-weight: 600; text-shadow: 0 1px 8px rgba(0, 0, 0, .35); font-variant-numeric: tabular-nums; }
  .wp-cap { display: flex; align-items: center; gap: 5px; font-size: 13px; line-height: 18px; color: var(--i-label2); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wp-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 10px; margin-bottom: 22px; }
  .wp-card { display: flex; flex-direction: column; gap: 6px; border: 0; padding: 0; background: none; cursor: pointer; color: inherit; font: inherit; text-align: center; min-width: 0; -webkit-tap-highlight-color: transparent; }
  .wp-thumb { position: relative; display: flex; align-items: center; justify-content: center; aspect-ratio: 9 / 14; border-radius: 12px; overflow: hidden; background-color: var(--i-fill4);
    transition: transform 200ms var(--ea-std), box-shadow 180ms linear; }
  .wp-card:active .wp-thumb { transform: scale(.95); }
  .wp-card.sel .wp-thumb { box-shadow: 0 0 0 2.5px var(--i-bg), 0 0 0 5px var(--i-blue); }
  .wp-name { font-size: 12.5px; line-height: 18px; color: var(--i-label2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wp-card.sel .wp-name { color: var(--i-label); font-weight: 600; }
  .wp-add .wp-thumb { background: var(--i-card); color: var(--i-label2); box-shadow: inset 0 0 0 1px var(--i-label4); }
  .wp-ck { position: absolute; right: 7px; bottom: 7px; width: 24px; height: 24px; border-radius: 50%; background: var(--i-blue); display: flex; align-items: center; justify-content: center; }
  .wp-ck :global(.ck) { color: var(--i-on-accent); transform: scale(.8); }
  .wp-dyn { position: absolute; top: 7px; left: 7px; font-size: 11px; line-height: 16px; font-weight: 600; padding: 1px 7px; border-radius: 8px; background: rgba(255, 255, 255, .3); color: #fff; }
  .wp-spatial-badge { position: absolute; top: 0; left: 0; width: 40px; height: 40px; pointer-events: none; z-index: 3;
    clip-path: polygon(0 0, 100% 0, 0 100%);
    background: radial-gradient(rgba(255, 255, 255, .95) 1.1px, transparent 1.7px) 0 0 / 5px 5px, linear-gradient(135deg, rgba(8, 10, 18, .52), rgba(8, 10, 18, 0) 76%);
    -webkit-mask: linear-gradient(135deg, #000 40%, transparent 64%); mask: linear-gradient(135deg, #000 40%, transparent 64%); }

  /* ── 壁纸实景舞台（背后是主页壁纸：kit 玻璃按壁纸中灰锚点烘焙）── */
  /* 舞台右上的「完成」正好压在主页账户胶囊上：舞台期间把胶囊收起（预览的是壁纸与入口，不是账户） */
  :global(body:has(.settings.staged) .lc-fade) { opacity: 0 !important; pointer-events: none; transition: opacity 200ms linear; }
  .stage { position: absolute; inset: 0; display: flex; flex-direction: column; padding: var(--sat) 16px max(16px, var(--sab)); animation: stage-in 380ms cubic-bezier(.2, .95, .25, 1); }
  @keyframes stage-in { from { opacity: 0; transform: translateY(18px); } }
  .stage-top { display: flex; align-items: center; justify-content: space-between; height: 44px; }
  .stage-seg { position: relative; align-self: center; margin-top: 16px; display: grid; grid-template-columns: 1fr 1fr; width: 250px; height: 44px; padding: 4px; isolation: isolate; }
  .stage-seg::before { content: ''; position: absolute; z-index: -1; inset: 0; border: 0 solid transparent; border-image: var(--img) 0 210 fill / 0 70px / 40px stretch; pointer-events: none; }
  .stage-knob { position: absolute; top: 4px; left: 4px; width: calc(50% - 4px); height: 36px; border-radius: 18px; background: rgba(255, 255, 255, .72);
    box-shadow: 0 2px 10px rgba(0, 0, 0, .12); transition: transform 380ms cubic-bezier(.3, 1.15, .45, 1); }
  .stage-knob.right { transform: translateX(100%); }
  .stage-seg button { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 6px; border: 0; background: none; cursor: pointer;
    font: inherit; font-size: 15px; font-weight: 600; color: #0c0c0e; white-space: nowrap; }
  .stage-panel { position: relative; isolation: isolate; border-radius: 34px; padding: 6px 18px; box-shadow: 0 8px 40.6px rgba(0, 0, 0, .25); }
  .stage-panel::before { content: ''; position: absolute; z-index: -1; inset: 0; border: 0 solid transparent; border-image: var(--img) 228 fill / 76px / 16px stretch; pointer-events: none; }
  .sp-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; color: #000; }
  .sp-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 17px; line-height: 22px; }
  .sp-tx small { font-size: 13px; line-height: 18px; color: rgba(60, 60, 67, .6); }
  .sp-amp { display: flex; align-items: center; gap: 12px; padding: 4px 0 8px; border-top: 1px solid rgba(0, 0, 0, .08); color: #000; }
  .sp-amp-lbl { flex: none; font-size: 15px; }
  .sp-amp-sl { flex: 1; min-width: 0; }
  .sp-val { flex: none; width: 42px; text-align: right; font-size: 15px; font-variant-numeric: tabular-nums; color: rgba(60, 60, 67, .6); }

  /* ── 反馈表单页内容 ── */
  .fb-intro { margin: 0 4px 14px; font-size: 15px; line-height: 20px; color: var(--i-label2); }
  .fb-atts { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .fb-att { position: relative; width: 64px; height: 64px; border-radius: 14px; overflow: hidden; background: var(--i-field); display: flex; align-items: center; justify-content: center; }
  .fb-att img { width: 100%; height: 100%; object-fit: cover; }
  .fb-att-ico { font-size: 24px; }
  .fb-att-up { position: absolute; inset: 0; background: rgba(0, 0, 0, .45); display: flex; align-items: center; justify-content: center; color: #fff; font-size: 12px; font-weight: 600; }
  .fb-att-x { position: absolute; top: 3px; right: 3px; border: 0; padding: 0; background: none; color: rgba(255, 255, 255, .92); cursor: pointer; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .4)); }
  .fb-add { width: 64px; height: 64px; border-radius: 14px; border: 0; background: var(--i-field); color: var(--i-label2); display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .fb-err { margin: 12px 4px 0; font-size: 15px; line-height: 20px; color: var(--i-red); }
  .fb-busy { margin: 12px 4px 0; font-size: 15px; color: var(--i-label2); }
  .fb-up { margin: 14px 4px 0; font-size: 13px; line-height: 18px; color: var(--i-label2); }
  .fb-up.bad { color: var(--i-red); }
  .fb-up-row { display: flex; align-items: center; gap: 12px; margin-top: 10px; padding: 10px 12px 10px 14px; border-radius: 14px; background: var(--i-field); }
  .fb-up-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 15px; line-height: 20px; color: var(--i-label); }
  .fb-up-tx small { font-size: 13px; line-height: 18px; color: var(--i-label2); }
  .fb-done { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 18px 0 30px; text-align: center; }
  .fb-done :global(.fb-done-ic) { color: var(--i-ok); }
  .fb-done p { margin: 0; font-size: 17px; line-height: 22px; color: var(--i-label2); }
</style>
