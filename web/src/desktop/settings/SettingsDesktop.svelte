<script>
  // 2026-10-19 v5「墨与象牙」（与手机设置 v6.24 同一套设计语言）：维护者嫌「AI 味浓、粗糙」——
  //   侧栏彩虹渐变图标块、整条珊瑚色选中、agent 只有色块加白点的假图标、每行一句解释小字。
  //   · 配色：应用图标的墨色 + 象牙白（令牌在 .sd 上就地覆盖 --dsk-*，kit 自动跟上，不碰全桌面令牌）；
  //     唯一强调色＝墨色（暗色下是象牙），红 / 琥珀 / 绿只表状态。
  //   · 图标：线稿（lib/settingsIcons.js，与手机共用），无色块；agent 用真品牌标。
  //   · 结构：与手机一致按 agent 分区（ag-<id>）：开关 + 认证；Claude 另有订阅号池 / 智能换号 / 对话偏好
  //     （输入建议、思考动画从「通用」迁来）；新增「外观」分区（明亮 / 深色 / 跟随系统 三选一）。
  //     数据面复用 lib/agentSettings.svelte.js，两端读写同源。
  //   · 小字：副标题只放状态，脚注只留安全提示与必要的配置指引。
  // 桌面设置（macOS Tahoe 式重做）：
  //   左列＝半透明磨砂侧栏（搜索 → 账户行 → 分组导航，图标是渐变小方块+白 glyph）；
  //   右侧＝工具栏（‹ › 导航历史 + 居中标题）+ 居中内容列（分组卡，行内不再摆彩色方块）。
  //   新增「账户」分区收编原主页右上登录胶囊：登录/注册/令牌表单、额度、退出登录。
  // 【换皮不换数据】：读写与手机版 Settings.svelte 完全同源——localStorage 键位
  // （bridge-prefs/bridge-notify/bridge-flux/壁纸槽）与
  // BridgeDesktop IPC（localPc/control/updates），两端设置互通、互不感知形态。
  // 仅桌面壳挂载（App.svelte isNativeDesktop() 分流），手机/网页仍走原 Settings。
  import {
    ui, prefs, savePrefs, setHomeMode,
    applyFollowSys, setTheme, fluxParams, saveFlux, resetFlux, FLUX_SLIDERS, FLUX_COLORMODES,
    me, applyMe, status, agentOn, rootScreen, pluginOn,
  } from '../../lib/state.svelte.js';
  import { untrack } from 'svelte';
  import { ags, loadAgents, setAgentOn, agentById, loadPool, loadUsage, setRouter, activateAccount, moveAccount, addAccount, updateAccount, deleteAccount,
    accLabel, whyText, hhmm, poolResetIn, poolResetAt, usageTone, loadPolicy, savePolicy, apiKeyNote } from '../../lib/agentSettings.svelte.js';
  import { SI, agentMark } from '../../lib/settingsIcons.js';
  import {
    wp, wpDef, setWp, addUpload, deleteUpload, splitWpFiles, LIGHT_IDS, DARK_IDS,
    spatial, setSpatialOn, setSpatialAmp, wpHasDepth, wpIsUpload,
  } from '../../lib/wallpaper.svelte.js';
  import { registerCloser } from '../../lib/nav.js';
  import { getServerBase, setServerBase, apiUrl } from '../../lib/server.js';
  import { updateState, installPending, hasSilentUpdate, checkForUpdate, startUpdate, appVersionLine,
    autoUpdateEnabled, setAutoUpdateEnabled, fetchServerInfo, appDownloadUrls, cancelPendingInstall, waitingLine } from '../../lib/appUpdate.js';
  import { api, getToken, setToken } from '../../lib/api.js';
  import { afterSignIn } from '../../lib/account.js';
  import { startPairLogin, qrSvg } from '../../lib/pair.js';
  import ConnectQr from '../../components/pairing/ConnectQr.svelte';
  import { normalizeServerAddress } from '../../lib/connectPair.js';
  import { saPing } from '../../lib/serverAdmin.svelte.js';
  import { fetchMyUsage, changeMyPassword, quotaRows, hasLimits, costNote } from '../../lib/me.js';
  import { wcoActive, wcoHeight } from '../chrome/wco.svelte.js';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import DSegmented from '../kit/DSegmented.svelte';
  import DSelect from '../kit/DSelect.svelte';
  import DSlider from '../kit/DSlider.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import ShortcutRecorder from './ShortcutRecorder.svelte';
  import DevicesSection from './DevicesSection.svelte';
  import AgentKeysSection from './AgentKeysSection.svelte';
  import AdminAccessSection from './AdminAccessSection.svelte';
  // Claude Code 运行组件的下载进度 / 失败重试（安装包不再内嵌，首启服务端去拿；就绪时不显示），与手机设置共用
  import ClaudeCliStatus from '../../components/ClaudeCliStatus.svelte';
  import { serverOnThisMachine } from '../../lib/nativeDesktop.js';
  import Customize from '../../components/ext/Customize.svelte';
  import PluginFrame from '../../components/ext/PluginFrame.svelte';
  import { pluginPanels, watchPluginPanels, panelTitle } from '../../lib/pluginPanels.svelte.js';
  import { filesFromInput, uploadAttachment } from '../../lib/attachments.js';
  import { t, tc, tr, lang, setLang, LANGS } from '../../lib/i18n.js';
  import { DISTRO, stripBrand, feedbackDest } from '../../lib/distro.js';
  import { ovUrl, ovMarks } from '../../lib/overlay.svelte.js';

  import { settingsNav } from './settingsNav.svelte.js';
  import { extensionsNav } from '../../lib/extensionsNav.svelte.js';
  // 设置 › Claude（2026-10-20 对齐官方 Desktop「Settings → Claude Code」）：注册表 + 按身份存服务端；取值与文案两套外壳共用
  import { cs, loadClaudeSettings } from '../../lib/claudeSettings.svelte.js';
  // 模型服务（自定义 API）：管理面板盖在设置上，两套设置外壳共用（components/claude/providers）
  import ProviderManager from '../../components/claude/providers/ProviderManager.svelte';
  import { cp, loadProviders, cpSummaryText, canUseCustomApi } from '../../lib/claudeProviders.svelte.js';
  import { S as CS, val, visible, setVal, resetVal, changed, label as csLabel, desc as csDesc, options as csOptions, valueLabel, errText } from '../../lib/claudeSettingsView.js';
  import { branchPrefixError } from '../../../../src/config/claude-settings.mjs';
  import { goto } from '../../lib/pageMorph.js';
  // ═══ 分区导航 ═══（外部直达 settingsNav.sec 优先；dev ?dsec=xxx 供 headless 逐区截图，
  // ?dme=admin|user|pro|none 预置登录态供账户区截图）
  // 两套外壳共用的分区名（lib/settingsNav 的 openSettings）映射到这里的分区。
  // 「关于与更新」落在「连接与更新」（版本、检查更新都在那一页），反馈落在「反馈」。
  const SEC_ALIAS = { agents: 'ag-claude', claude: 'ag-claude', connection: 'connect', about: 'connect', feedback: 'help', localpc: 'devices', 'agent-api': 'agentapi' };
  // 单页模式（只开着一个 agent、没有主页）也用这一套（2026-10-21 起，原 claude.ai 风那套下线）：
  // 壁纸、「分页跟随主页明暗」在那里没意义，藏掉；左上角也不叫「主页」。
  const single = $derived(rootScreen() !== 'home');
  const sec0 = settingsNav.sec || (import.meta.env.DEV && new URLSearchParams(location.search).get('dsec')) || 'general';
  let sec = $state(SEC_ALIAS[sec0] || sec0);
  settingsNav.sec = null;   // 消费一次即清
  if (import.meta.env.DEV) {
    const dm = new URLSearchParams(location.search).get('dme');
    if (dm === 'none') applyMe(null);
    else if (dm === 'admin') applyMe({ kind: 'admin', user: null });
    else if (dm === 'user') applyMe({ kind: 'user', user: 'coral' });
    else if (dm === 'pro') applyMe({ kind: 'user', user: 'coral', tier: 'pro' });
  }
  let closing = $state(false);
  let flash = $state('');           // 搜索跳转后闪烁的行 id
  let query = $state('');
  let scrolled = $state(false);     // 内容滚动后给工具栏压一条发丝线（macOS 行为）

  const agCtl = typeof window !== 'undefined' ? window.BridgeDesktop?.agent : null;
  const scCtl = typeof window !== 'undefined' ? window.BridgeDesktop?.shortcuts : null;
  const asCtl = typeof window !== 'undefined' ? window.BridgeDesktop?.autostart : null;
  // 服务进程桥（新壳才有）：走 IPC 不走 /api，**bridge 停着这一行照样能用**——
  // 网页版服务端控制台那时连入口探针都过不去，这里是唯一还能把服务拉起来的入口。
  const spCtl = typeof window !== 'undefined' ? window.BridgeDesktop?.serverProcess : null;
  // 本机服务端的「访问信息」（访问令牌、局域网与公网地址）与「重新配置」：壳打开它自己的本地页，网页这边不碰令牌（新壳才有）
  const ssCtl = typeof window !== 'undefined' && typeof window.BridgeDesktop?.serverSetup?.open === 'function' ? window.BridgeDesktop.serverSetup : null;

  // ═══ 扩展（独立分区）═══ admin 探针过了才在侧栏出现；内容＝官方「自定义」同款面板（components/ext/Customize），
  // 直接长在设置里（2026-10-20 起不再盖一层全屏玻璃页）。搜索命中某个类型时经 extensionsNav 直达、{#key} 重挂。
  let extOk = $state(false);
  let extKey = $state(0);
  api.get('/api/extensions').then(() => { extOk = true; }).catch(() => {});

  // ═══ Agent：每个 agent 一个分区（ag-<id>），数据面与手机共用 lib/agentSettings.svelte.js ═══
  // 各接口都是 admin 门；非管理员全部 404/403 → 对应 ok 位为 false，那一节不出现。
  loadAgents(); loadPool(); loadPolicy();
  if (canUseCustomApi()) loadProviders();
  let provOpen = $state(false);
  // 摘要只数启用服务里启用的对话模型，关了「显示在模型列表」的另注「N 个已隐藏」（与 iOS 设置同一口径）
  const provSummary = $derived(cpSummaryText() || t('接 DeepSeek、Kimi、OpenRouter、本机模型等兼容 API'));
  // 「扩展 › 功能扩展」拨了开关（或别的设备改了）：App 经总线 agents.changed 刷 me.agents，这里跟着重拉，侧栏即时增减
  let agentsSeen = JSON.stringify(me.agents);
  $effect(() => { const k = JSON.stringify(me.agents); if (k !== agentsSeen) { agentsSeen = k; untrack(loadAgents); } });
  if (me.kind !== 'none') loadClaudeSettings();   // Claude 设置：总线会推，开设置页时再拉一次兜底
  const BASE = import.meta.env.BASE_URL;
  const dark = $derived(ui.theme !== 'light');
  const markSrc = (id) => { const m = agentMark(id, dark); return m ? ovUrl(m) : ''; };   // 私有 overlay 有同名原版就换
  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;
  // 管理员：服务器上全部 agent；其他人只有 Claude（对话偏好是本机的）
  // 在「扩展 › 功能扩展」里关掉的 agent 直接不列（维护者 10-21）；开着但这台机器跑不起来的仍列出、变灰，点进去看原因。
  // Claude 是核心、不在功能扩展里，关了也得留着入口才开得回来。
  const agentRows = $derived((ags.agents?.agents?.length ? ags.agents.agents : agentOn('claude') || import.meta.env.DEV ? [{ id: 'claude', label: 'Claude', local: true }] : [])
    .filter((a) => a.local || a.id === 'claude' || a.switch !== false));
  function agStatus(a) {
    if (!a || a.local) return '';
    if (!a.runnable) return tr(a.note) || t('这台机器上不可用');
    if (!a.switch) return tc('开关', '关闭');
    if (!a.authed) return t('还没配认证');
    return a.multiUser ? t('可用') : t('可用 · 仅管理员');
  }
  const AG_AUTH_HINT = {
    claude: () => t('在下面「订阅号池」里添加账号。'),
    gemini: () => t('在服务器配置里填 geminiApiKey 或 Vertex 凭据。'),
    codex: () => t('在服务器上运行一次 codex login。'),
    dimensio: () => t('在 dimensio 的 .env 里填一家模型厂商的 API key。'),
  };
  let agLast = $state(null);   // 关最后一个开着的 agent 前确认
  async function toggleAgent(a, next) {
    if (!a?.runnable || ags.agentBusy) return;
    if (!next && ags.agents.agents.filter((x) => x.enabled).length <= 1) { agLast = a; return; }
    await setAgentOn(a, next);
  }
  // Claude 分区：进来才拉逐号用量（每号一次真探针，服务端 5 分钟缓存）
  $effect(() => { if (sec === 'ag-claude' && ags.poolOk) untrack(() => loadUsage()); });
  const routerOn = $derived(!!ags.router?.settings?.enabled);
  const acctById = (id) => ags.accounts.find((x) => x.id === id) || null;
  let acctForm = $state(null);   // null | { id?, label, token, isNew, hasToken, tokenTail, busy, err }
  let acctDel = $state(null);
  function openAddAcct() { ags.err = ''; acctForm = { label: '', token: '', isNew: true, busy: false, err: '' }; }
  function openEditAcct(a) { ags.err = ''; acctForm = { id: a.id, label: a.label, token: '', isNew: false, hasToken: a.hasToken, tokenTail: a.tokenTail, busy: false, err: '' }; }
  async function saveAcctForm(e) {
    e?.preventDefault?.();
    const f = acctForm;
    if (!f || f.busy) return;
    if (f.isNew && !f.token.trim()) { f.err = t('token 不能为空'); return; }
    f.busy = true; f.err = '';
    const done = f.isNew ? await addAccount(f.label, f.token) : await updateAccount(f.id, f.label, f.token);
    if (done) acctForm = null; else { f.err = ags.err; ags.err = ''; f.busy = false; }
  }
  async function confirmAcctDel() { const a = acctDel; acctDel = null; if (a) await deleteAccount(a.id); }
  // 额度与注册：数字项就地编辑，失焦 / 回车保存（quota 整体替换，改一项带上其余）
  const POLICY_FIELDS = [
    { k: 'dayTurns', label: () => t('每天最多几轮'), unit: () => tc('admin', '轮') },
    { k: 'weekTurns', label: () => t('最近 7 天最多几轮'), unit: () => tc('admin', '轮') },
    { k: 'dayCostUsd', label: () => t('每天最多花多少'), unit: () => t('美元') },
    { k: 'weekCostUsd', label: () => t('最近 7 天最多花多少'), unit: () => t('美元') },
    { k: 'maxUserTurns', label: () => t('全服同时最多几轮（注册用户合计）'), unit: () => tc('admin', '轮') },
  ];
  const policyVal = (k) => (k === 'maxUserTurns' ? ags.policy?.maxUserTurns : ags.policy?.quota?.[k]) || 0;
  function savePolicyField(k, raw) {
    const v = String(raw ?? '').trim();
    if (k === 'timezone') return savePolicy({ timezone: v || 'Asia/Shanghai' });
    if (k === 'maxUserTurns') return savePolicy({ maxUserTurns: Number(v) || 0 });
    return savePolicy({ quota: { ...(ags.policy?.quota || {}), [k]: v === '' ? 0 : Number(v) || 0 } });
  }
  let logoutAsk = $state(false);
  // Claude 页「安全」组：允许绕过权限模式打开前确认（解释只放在确认框里）
  let bypassAsk = $state(false);
  const anyModal = $derived(!!acctForm || !!acctDel || !!agLast || logoutAsk || bypassAsk);

  // ═══ 侧栏导航：线稿图标（ico）或品牌标（brand），没有色块 ═══
  const PERSON = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="5.4" r="2.7" fill="currentColor"/><path d="M2.8 13.4c.7-2.6 2.8-4 5.2-4s4.5 1.4 5.2 4Z" fill="currentColor"/></svg>';
  // 第三方插件的控制面板（清单 ui.panel）：侧栏单独一组，内容是插件自己的页面（PluginFrame，不透明源 iframe）
  watchPluginPanels();
  const plgOf = (k) => (k.startsWith('plg-') ? pluginPanels.list.find((p) => 'plg-' + p.id === k) || null : null);
  const NAV_GROUPS = $derived([
    [
      { key: 'general', label: t('通用'), ico: 'general' },
      { key: 'appearance', label: t('外观'), ico: 'appearance' },
      ...(scCtl ? [{ key: 'shortcuts', label: t('快捷键'), ico: 'keys' }] : []),
    ],
    [
      ...agentRows.map((a) => ({ key: 'ag-' + a.id, label: tr(a.label), brand: a.id, off: !a.local && !a.enabled })),
      ...((me.kind === 'admin' || me.kind === 'user') && pluginOn('agent-api') ? [{ key: 'agentapi', label: t('Agent 接入'), ico: 'agentapi' }] : []),
    ],
    [
      ...(extOk ? [{ key: 'extensions', label: t('扩展'), ico: 'extensions', badge: me.pluginUpdates }] : []),
      ...(ags.policyOk && ags.multiUser ? [{ key: 'policy', label: t('额度与注册'), ico: 'policy' }] : []),
      ...(pluginOn('devices') ? [{ key: 'devices', label: t('设备'), ico: 'localpc' }] : []),
      ...(single || !pluginOn('wallpapers') ? [] : [{ key: 'wallpaper', label: t('壁纸'), ico: 'wallpaper' }]),
    ],
    pluginPanels.list.map((p) => ({ key: 'plg-' + p.id, label: panelTitle(p), ico: 'extensions' })),
    [
      { key: 'connect', label: t('连接与更新'), ico: 'connect' },
      ...(pluginOn('feedback') ? [{ key: 'help', label: t('反馈'), ico: 'feedback' }] : []),
    ],
  ].filter((g) => g.length));
  const SEC_TITLE = $derived(sec === 'account' ? t('账户')
    : (NAV_GROUPS.flat().find((n) => n.key === sec)?.label || t('设置')));

  // ═══ 导航历史（macOS 系统设置的 ‹ › 操作逻辑）═══
  let hist = $state([sec]);
  let hi = $state(0);
  function navigate(k) {
    if (k === sec) return;
    const next = [...hist.slice(0, hi + 1), k];
    hist = next; hi = next.length - 1; sec = k;
  }
  function goBack() { if (hi > 0) { hi -= 1; sec = hist[hi]; } }
  function goFwd() { if (hi < hist.length - 1) { hi += 1; sec = hist[hi]; } }
  // 开着时外部又直达某分区（openSettings('devices') 等）：直接换到那一页，读完即清（同 iOS 那套 Settings.svelte）。
  // 以前只在打开时消费一次：开着时写进来的 sec 不跳也不清，之后从直接置 ui.settingsOpen 的入口打开会跳到这个过时的分区
  $effect(() => {
    const s = settingsNav.sec;
    if (!s) return;
    untrack(() => { settingsNav.sec = null; navigate(SEC_ALIAS[s] || s); });
  });

  // 「思考动画」三套都是原版动画，只有维护者的私有 overlay 带着；公开版只有一颗自绘星标——overlay 带了两套以上才显示这一行
  const markOpts = $derived.by(() => {
    const av = ovMarks();
    return [{ value: 'clay', label: t('新版 Claude Code') }, { value: 'sprite', label: t('新版聊天页') }, { value: 'classic', label: t('经典星标') }].filter((o) => av[o.value]);
  });
  // ═══ 设置搜索：扁平索引 → 过滤 → 跳区 + 行闪烁 ═══
  const INDEX = $derived([
    // 搜索关键词（keys）也过 t()：英文界面换成英文关键词表，中英各自能搜到
    { sec: 'account', id: 'acct', label: t('账户'), keys: t('登录 注册 令牌 退出 用户 account') },
    { sec: 'account', id: 'usage', label: t('订阅额度'), keys: t('用量 5小时 每周 quota') },
    { sec: 'account', id: 'admin-access', label: t('管理员可见性'), keys: t('管理员 隐私 访问记录 查看 代聊 电脑') },   // 只有成员看得到（AdminAccessSection）
    { sec: 'general', id: 'lang', label: t('语言'), keys: t('界面语言 中文 英文 English language i18n') },
    { sec: 'general', id: 'notify', label: t('通知'), keys: t('任务完成 提醒 notification') },
    { sec: 'general', id: 'autostart', label: t('开机自动启动'), keys: t('自启 静默 托盘 后台 startup login') },
    { sec: 'appearance', id: 'theme', label: t('外观'), keys: t('深色 浅色 自动 主题 跟随系统明暗') },
    { sec: 'appearance', id: 'followpage', label: t('分页跟随主页明暗'), keys: t('主题 联动') },
    { sec: 'appearance', id: 'noanim', label: t('转场动画'), keys: t('入场 动效 禁用') },
    { sec: 'general', id: 'fullres', label: t('原图加载'), keys: t('画质 相册 流量') },
    { sec: 'ag-claude', id: 'suggest', label: t('输入建议'), keys: t('提示词 预测 下一句 Tab 补全') },
    ...(markOpts.length > 1 ? [{ sec: 'ag-claude', id: 'thinkmark', label: t('思考动画'), keys: t('菊花 星标 动画 Claude Code 经典 加载') }] : []),
    // Claude 设置（注册表项；key 用来按身份过滤：管理员项 / shell 项别人搜不到）。keys 带官方英文词
    { sec: 'ag-claude', id: 'climit', key: 'autoContinueOnLimit', label: t('限额重置后自动继续'), keys: t('限额 续跑 auto-continue usage limit') },
    { sec: 'ag-claude', id: 'crestart', key: 'autoResumeOnRestart', label: t('自动继续被中断的对话'), keys: t('重启 崩溃 中断 续跑 自动继续 restart crash resume interrupted') },
    { sec: 'ag-claude', id: 'cdef-perm', key: 'permissionMode', label: t('权限模式'), keys: t('手动 接受编辑 计划 自动 permission mode') },
    { sec: 'ag-claude', id: 'cdef-style', key: 'outputStyle', label: t('输出风格'), keys: t('简洁 讲解 学习 主动 output style concise') },
    { sec: 'ag-claude', id: 'cviz', key: 'inlineVisualizations', label: t('对话内交互图表'), keys: t('图表 示意图 inline visualizations') },
    { sec: 'ag-claude', id: 'cwf', key: 'enableWorkflows', label: t('动态工作流'), keys: t('工作流 并行 Ultracode dynamic workflows') },
    { sec: 'ag-claude', id: 'cdispatch', key: 'subagentDispatch', label: t('子 agent 调度偏好'), keys: t('子 agent 模型 推理强度 effort 工作流 subagent dispatch') },
    { sec: 'ag-claude', id: 'cflag', key: 'switchModelsOnFlag', label: t('消息被拦时自动换模型'), keys: t('安全栅门 拒答 暂停 switch models flagged') },
    { sec: 'ag-claude', id: 'cplan', key: 'planClearContext', label: t('批准计划时可清空上下文'), keys: t('计划 清空上下文 plan clear context') },
    { sec: 'ag-claude', id: 'cqto', key: 'questionTimeout', label: t('Claude 提问无人回答时'), keys: t('提问 超时 question timeout') },
    { sec: 'ag-claude', id: 'clang', key: 'replyLanguage', label: t('回复语言'), keys: t('语言 中文 英文 language') },
    { sec: 'ag-claude', id: 'ccompact', key: 'compactFrac', label: t('自动压缩点'), keys: t('压缩 上下文 auto compact') },
    { sec: 'ag-claude', id: 'cnewsess', key: 'newSessionPolicy', label: t('Claude 发起新会话'), keys: t('新会话 无关任务 unrelated task new session') },
    { sec: 'ag-claude', id: 'cinbound', key: 'crossSessionInbound', label: t('其它会话发来的消息'), keys: t('会话间消息 cross-session messages') },
    { sec: 'ag-claude', id: 'cbranch', key: 'branchPrefix', label: t('分支前缀'), keys: t('分支 git branch prefix') },
    { sec: 'ag-claude', id: 'cwtbase', key: 'worktreeBaseRef', label: t('工作树起点'), keys: t('工作树 分支 worktree base') },
    { sec: 'ag-claude', id: 'cautofix', key: 'autoFixPullRequests', label: t('自动修复拉取请求'), keys: t('拉取请求 CI 评审 auto-fix pull requests PR') },
    { sec: 'ag-claude', id: 'cprarchive', key: 'autoArchiveOnPrClose', label: t('拉取请求合并或关闭后自动归档'), keys: t('拉取请求 归档 auto-archive PR merge') },
    { sec: 'ag-claude', id: 'cattrib', key: 'attribution', label: t('提交与拉取请求署名'), keys: t('署名 提交 attribution co-authored-by') },
    { sec: 'ag-claude', id: 'carchive', key: 'autoArchiveDays', label: t('归档不活跃的会话'), keys: t('归档 不活跃 archive inactive sessions') },
    { sec: 'ag-claude', id: 'cdesk', key: 'followDesktopArchive', label: t('跟随 Claude Desktop 的归档'), keys: t('归档 官方桌面端 Claude Desktop archive') },
    { sec: 'ag-claude', id: 'cn-perm', key: 'notifyPermission', label: t('权限请求通知'), keys: t('通知 权限 notification permission requests') },
    { sec: 'ag-claude', id: 'cn-q', key: 'notifyQuestion', label: t('提问通知'), keys: t('通知 提问 notification questions') },
    { sec: 'ag-claude', id: 'cn-done', key: 'notifyTaskComplete', label: t('任务完成通知'), keys: t('通知 完成 notification task complete') },
    { sec: 'ag-claude', id: 'cawake', key: 'keepAwake', label: t('Claude 工作时保持唤醒'), keys: t('睡眠 唤醒 电池 keep awake sleep battery') },
    { sec: 'ag-claude', id: 'cbypass', key: 'allowBypass', label: t('允许绕过权限模式'), keys: t('绕过 权限 bypass permissions') },
    { sec: 'ag-claude', id: 'cauto', key: 'allowAutoMode', label: t('允许自动模式'), keys: t('自动模式 权限 auto mode') },
    { sec: 'ag-claude', id: 'agents', label: t('Agent 开关'), keys: t('claude gemini vertex codex chatgpt dimensio 分页 启用 关闭 认证') },
    { sec: 'ag-claude', id: 'pool', label: t('订阅号池'), keys: t('账号 切号 token 用量 Max Pro') },
    { sec: 'ag-claude', id: 'cproviders', label: t('自定义 API'), keys: t('模型服务 第三方模型 接口地址 API Key OpenAI 兼容 DeepSeek Kimi GLM OpenRouter Ollama custom provider base url temperature 显示在模型列表 更多模型 More models 推理强度 档位 effort reasoning_effort 思考 检测连接 探测能力 小米 MiMo') },
    { sec: 'ag-claude', id: 'router', label: t('额度用尽自动换号'), keys: t('智能路由 换号') },
    { sec: 'policy', id: 'policy', label: t('额度与注册'), keys: t('邀请码 注册 限额 时区') },
    { sec: 'extensions', id: 'ext-skill', label: t('技能'), keys: t('扩展 skill 指引包') },
    { sec: 'extensions', id: 'ext-connector', label: t('连接器'), keys: t('扩展 mcp connector 服务') },
    { sec: 'extensions', id: 'ext-plugin', label: t('插件'), keys: t('扩展 plugin claude code') },
    { sec: 'shortcuts', id: 'sc-quick-ask', label: t('快速提问'), keys: t('全局 快捷键 热键 呼出 quick ask') },
    { sec: 'shortcuts', id: 'sc-focus-pending', label: t('跳到在等你回答的那一轮'), keys: t('快捷键 热键 提问 待回答') },
    { sec: 'shortcuts', id: 'sc-stop-local-pc', label: t('本机 Agent 急停'), keys: t('快捷键 热键 急停 停止') },
    { sec: 'agentapi', id: 'ak-url', label: t('Agent 入口与项目手册'), keys: t('agent 接口 API 地址 手册 manual 接入') },
    { sec: 'agentapi', id: 'ak-new', label: t('生成密钥'), keys: t('agent 接口 API 密钥 key token 接入') },
    { sec: 'agentapi', id: 'ak-list', label: t('吊销密钥'), keys: t('agent 密钥 key token 吊销 revoke') },
    { sec: 'devices', id: 'dv-tier', label: t('Claude 能用这台电脑吗'), keys: t('本机 设备 观察 操作 权限 档位 agent') },
    { sec: 'devices', id: 'dv-forward', label: t('端口转发'), keys: t('端口 转发 dev server 预览 本机模型') },
    { sec: 'wallpaper', id: 'flux', label: t('流体壁纸参数'), keys: t('flux 线条 颜色 粘度') },
    { sec: 'wallpaper', id: 'wp-light', label: t('明亮壁纸'), keys: t('风景 白天 上传') },
    { sec: 'wallpaper', id: 'wp-dark', label: t('深色壁纸'), keys: t('flux 夜间 上传') },
    { sec: 'wallpaper', id: 'spatial', label: t('空间壁纸'), keys: t('景深 视差 3d') },
    { sec: 'connect', id: 'addr', label: t('服务器地址'), keys: t('连接 电脑 域名') },
    { sec: 'connect', id: 'pairconnect', label: t('手机扫码连接'), keys: t('二维码 配对码 手机 扫码 连接 App') },
    { sec: 'connect', id: 'route', label: t('当前线路'), keys: t('隧道 局域网 lan') },
    { sec: 'connect', id: 'update', label: t('检查更新'), keys: t('版本 升级') },
    { sec: 'connect', id: 'auto-update', label: t('自动检查更新'), keys: t('自动 更新') },
    { sec: 'connect', id: 'public', label: t('公网地址'), keys: t('外网 域名 example') },
    { sec: 'connect', id: 'srvadmin', label: t('服务端控制台'), keys: t('admin 管理') },
    { sec: 'connect', id: 'srvproc', label: t('bridge 服务进程'), keys: t('启动 停止 重启 服务 进程 掉线 隧道') },
    { sec: 'connect', id: 'quitconfirm', label: t('退出前确认'), keys: t('退出 关闭 停止 本机服务端 quit') },
    { sec: 'connect', id: 'keeponline', label: t('插电时保持在线'), keys: t('睡眠 休眠 唤醒 电源 常驻 在线 本机服务端 sleep awake') },
    { sec: 'connect', id: 'srvaccess', label: t('本机服务端访问信息'), keys: t('访问令牌 token 局域网 地址 公网 重新配置 端口') },
    { sec: 'help', id: 'feedback', label: t('提交反馈'), keys: t('问题 建议 截图') },
    { sec: 'help', id: 'fbup', label: t('把用户反馈同时发给 {to}', { to: fbDest.to }), keys: t('反馈 推送 开发者 汇总 关闭') },
  ].filter((e) => !e.sec.startsWith('ag-') || agentRows.some((a) => 'ag-' + a.id === e.sec))
   .filter((e) => e.id !== 'fbup' || (fbUp?.admin && fbUp.mode !== 'inbox' && !fbUp.reason))   // 跟反馈页上开关的出现条件一致
   .filter((e) => e.id !== 'admin-access' || me.kind === 'user')
   .filter((e) => !single || (e.sec !== 'wallpaper' && e.id !== 'followpage'))
   .filter((e) => e.id !== 'auto-update' || hasSilentUpdate())
   .filter((e) => e.id !== 'quitconfirm' || (spPrefs?.managed && typeof spPrefs.confirmQuit === 'boolean'))   // 跟「连接与更新」里那一行的出现条件一致
   .filter((e) => e.id !== 'keeponline' || (spPrefs?.managed && typeof spPrefs.keepOnline === 'boolean'))
   .filter((e) => e.id !== 'srvaccess' || (spPrefs?.managed && ssCtl))
   .filter((e) => !e.key || visible(e.key))
   .filter((e) => e.sec !== 'policy' || (ags.policyOk && ags.multiUser)));
  const SECNAME = $derived(Object.fromEntries([['account', t('账户')], ...NAV_GROUPS.flat().map((n) => [n.key, n.label])]));
  // 选中的分区被收走（权限 / 扩展探针变化）时回到通用
  $effect(() => { if (sec !== 'account' && NAV_GROUPS.length && !NAV_GROUPS.flat().some((n) => n.key === sec) && !sec.startsWith('ag-')) untrack(() => { sec = 'general'; }); });
  const hits = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return INDEX.filter((e) => (e.label + ' ' + e.keys).toLowerCase().includes(q)).slice(0, 12);
  });
  let flashTimer = 0;
  function jump(e) {
    if (e.id.startsWith('ext-')) { extensionsNav.type = e.id.slice(4); extKey++; }
    navigate(e.sec); query = '';
    flash = e.id;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = ''; }, 1600);
  }
  const fl = (id) => flash === id;

  // ═══ 账户（原主页右上登录胶囊收编于此；登录逻辑与 LoginCard 同一套 api 语义）═══
  const roleLabel = $derived(me.kind === 'admin' ? t('管理员')
    : me.kind === 'user' ? (me.tier === 'pro' ? t('完全信任用户') : t('普通用户')) : t('未登录'));   // tier 'pro' = 「完全信任」档（S2-2）
  const initial = $derived((me.user || 'A').trim().charAt(0).toUpperCase());
  let mode = $state('login'); // 'login' | 'register' | 'token'
  let lgUser = $state(''), lgPass = $state(''), lgPass2 = $state(''), lgInvite = $state(''), lgTok = $state('');
  let lgBusy = $state(false), lgErr = $state('');
  async function refreshMe(fallback) {
    try { const a = await api.auth(); applyMe(a); }
    catch { applyMe(fallback); }
    afterSignIn();   // 桌面客户端按新登录立刻重新登记设备（lib/account.js）
  }
  // 拿到 session token 即存为 Bearer（与 LoginCard 同一课：refreshMe 的 /api/auth 否则 401 假登录）
  async function doLogin() {
    if (lgBusy) return; lgBusy = true; lgErr = '';
    try { const r = await api.login({ username: lgUser, password: lgPass }); if (r.token) setToken(r.token); await refreshMe({ kind: r.kind, user: r.user || lgUser }); lgReset(); }
    catch (e) { lgErr = tr(e.body?.error) || t('登录失败'); }
    lgBusy = false;
  }
  async function doRegister() {
    if (lgBusy) return; lgBusy = true; lgErr = '';
    try { const r = await api.register({ username: lgUser, password: lgPass, password2: lgPass2, invite: lgInvite }); if (r.token) setToken(r.token); await refreshMe({ kind: r.kind, user: r.user || lgUser }); lgReset(); }
    catch (e) { lgErr = tr(e.body?.error) || t('注册失败'); }
    lgBusy = false;
  }
  async function doToken() {
    if (lgBusy) return; lgBusy = true; lgErr = '';
    try { setToken(lgTok.trim()); const r = await api.login({}); if (r.token) setToken(r.token); await refreshMe({ kind: r.kind, user: r.user || null }); lgReset(); }
    catch (e) { setToken(null); lgErr = tr(e.body?.error) || t('令牌无效'); }
    lgBusy = false;
  }
  // —— 我的额度 / 改密码（注册用户；三端拆分 P4）——
  let myUsage = $state(null);
  $effect(() => { if (sec === 'account' && me.kind === 'user') fetchMyUsage().then((r) => { myUsage = r; }).catch(() => {}); });
  let pwForm = $state(null);   // null | { old, next, again, busy, err } ；pwOk = 刚改好
  let pwOk = $state(false);
  async function savePw(e) {
    e?.preventDefault?.();
    const f = pwForm; if (!f || f.busy) return;
    if (f.next.length < 8) { f.err = t('新密码至少 8 位'); return; }
    if (f.next !== f.again) { f.err = t('两次输入的新密码不一致'); return; }
    f.busy = true; f.err = '';
    try { await changeMyPassword(f.old, f.next); pwForm = null; pwOk = true; }
    catch (err) { f.err = tr(err?.body?.error) || t('修改失败'); f.busy = false; }
  }
  async function doLogout() {
    logoutAsk = false;
    try { await api.logout(); } catch {}
    setToken(null); applyMe(null); mode = 'login';
  }
  function lgReset() { lgUser = ''; lgPass = ''; lgPass2 = ''; lgInvite = ''; lgTok = ''; lgErr = ''; }
  // 扫码登录（与 LoginCard 同一套 lib/pair.js 状态机）：进 qr 模式即出码 + 长轮询，离开即停。
  let pair = $state({ status: 'idle', svg: '', error: '' });
  let pairCtl = null;
  $effect(() => {
    if (!(sec === 'account' && me.kind === 'none' && mode === 'qr')) return;
    // 回调里不读 pair（否则成依赖 → effect 自击死循环，见 LoginCard 同款注释）
    let svg = '';
    const ctl = startPairLogin((u) => {
      if (u.svg !== undefined) svg = u.svg;
      pair = { status: u.status, svg, error: u.error || '' };
      if (u.status === 'done') { mode = 'login'; lgReset(); }
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
  function submitAuth(e) {
    e.preventDefault();
    if (mode === 'register') doRegister(); else if (mode === 'token') doToken(); else doLogin();
  }
  function openWorkspace() { ui.settingsOpen = false; ui.screen = 'files'; }
  // 进账户区且已登录 → 拉一次额度快照
  $effect(() => {
    if (sec !== 'account' || me.kind === 'none') return;
    api.status().then((s) => { status.limits = s.limits || null; status.context = s.context || null; status.updatedAt = Date.now(); }).catch(() => {});
  });
  const lim = $derived(status.limits || {});
  const fiveH = $derived(lim.five_hour ? Math.round(lim.five_hour.pct || 0) : null);
  const weekly = $derived(lim.seven_day ? Math.round(lim.seven_day.pct || 0) : null);

  // ═══ 通用 ═══
  const load = (k, def = false) => { try { const v = localStorage.getItem(k); return v == null ? def : v === '1'; } catch { return def; } };
  let notifyOn = $state(load('bridge-notify', true));
  function onNotify(v) {
    notifyOn = v;
    try { localStorage.setItem('bridge-notify', v ? '1' : '0'); } catch {}
    try { agCtl?.setNotify?.(v); } catch {}   // 桌面壳系统通知总开关同步
  }
  // 开机自启（壳注册表 Run 键 + --hidden 静默到托盘）：真相在主进程，进设置拉一次。
  // 附着形态/旧壳/开发模式没有这个桥或 supported=false，行自然隐藏。
  let autoStart = $state({ supported: false, enabled: false });
  if (asCtl) asCtl.state().then((s) => { if (s) autoStart = s; }).catch(() => {});
  async function onAutoStart(v) {
    if (!asCtl) return;
    try {
      const r = await asCtl.set(v);
      if (r) autoStart = { supported: r.supported ?? autoStart.supported, enabled: r.enabled ?? v };
    } catch { /* 保持原状 */ }
  }

  function onFollowSys(v) { prefs.followSys = v; savePrefs(); if (v) applyFollowSys(); }
  // 外观三选一：手动选明暗＝关掉跟随系统；「分页跟随主页」开着时主页一起换
  const themeNow = $derived(prefs.followSys ? 'auto' : ui.theme === 'light' ? 'light' : 'dark');
  function pickTheme(v) {
    if (v === 'auto') { onFollowSys(true); return; }
    if (prefs.followSys) { prefs.followSys = false; savePrefs(); }
    setTheme(v);
    if (prefs.followPage) setHomeMode(v === 'light' ? 'B' : 'A');
  }
  function onFollowPage(v) { prefs.followPage = v; savePrefs(); if (v) setTheme(ui.glassMode === 'B' ? 'light' : 'dark'); }
  function onNoAnim(v) { prefs.noEnterAnim = v; savePrefs(); }
  function onFullRes(v) { prefs.fullResMedia = v; savePrefs(); }
  function onClaudeMark(v) { prefs.claudeMark = v; savePrefs(); }
  // —— Claude 设置（ag-claude 分区）——
  const clErr = $derived(errText(cs.err));
  function toggleCs(key, v) {
    if (key === 'allowBypass' && v) { bypassAsk = true; return; }
    setVal(key, v);
  }
  function confirmBypass() { bypassAsk = false; setVal('allowBypass', true); }
  // 分支前缀：失焦 / 回车保存，本地先按注册表校验（官方 220px 输入框同款）
  let prefixErr = $state('');
  async function savePrefix(v) {
    prefixErr = '';
    const bad = branchPrefixError(v);
    if (bad) { prefixErr = tr(bad); return; }
    if (!(await setVal('branchPrefix', String(v || '').trim() || null))) { prefixErr = errText() || t('分支前缀没保存上，请重试'); cs.err = ''; }
  }
  // 子 agent 调度偏好：多行文本，失焦保存（Ctrl/⌘+Enter 也存）；没在编辑时跟着服务端值走（别的设备改了这里同步）
  let dspDraft = $state(''), dspFocus = $state(false), dspMsg = $state(''), dspErr = $state('');
  $effect(() => { const v = val('subagentDispatch') || ''; if (!dspFocus) dspDraft = v; });
  async function saveDispatch() {
    const next = dspDraft.trim();
    if (next === (val('subagentDispatch') || '')) return;
    dspErr = ''; dspMsg = '';
    if (await setVal('subagentDispatch', next || null)) { dspMsg = t('已保存'); setTimeout(() => { dspMsg = ''; }, 1800); }
    else { dspErr = errText() || t('没保存上，请重试'); cs.err = ''; }
  }
  // 扩展与记忆：直达扩展分区的某个类型 / Claude 分页的定时任务
  function openExtType(type) { extensionsNav.type = type; extKey++; navigate('extensions'); }
  function openRoutinesPage() { ui.settingsOpen = false; goto('claude'); ui.routinesOpen = true; }
  // 枚举项的控件：短的用分段，其余下拉（宽度照官方：一般 160，无关任务 220）
  const SEGMENTED = new Set(['worktreeBaseRef', 'attribution']);
  const SELECT_W = { newSessionPolicy: '220px', crossSessionInbound: '180px' };
  // 权限模式下拉只列这个身份此刻能选的（绕过 / 自动受「安全」组的开关管）
  const csSelectOpts = (key) => csOptions(key).filter((o) => !o.disabled).map((o) => ({ value: o.value, label: o.label }));

  // ═══ 全局快捷键 ═══（桌面壳独有；主进程是唯一真相，这里只读它给的清单）
  let scState = $state({ groups: [], items: [], duplicates: [] });
  let scError = $state('');
  const scItemsOf = (group) => scState.items.filter((i) => i.group === group);
  // 组脚注：把「被占用 / 撞车 / 配置写坏了」三种失效摊开说，别只留一个不响的键。
  function scSub(item) {
    // 标签 / 说明 / 失败原因都来自桌面壳主进程（中文），显示处过 tr()
    if (item.failure) return t('{failure}——换一个组合键', { failure: tr(item.failure) });
    if (item.duplicate) return t('和另一条撞在同一个键上，只有一条能生效');
    if (item.invalid) return t('配置里的「{key}」认不出来，已退回默认', { key: item.invalid });
    if (!item.enabled) return t('已关闭');
    return tr(item.hint);
  }
  async function scRefresh() {
    if (!scCtl) return;
    try { scState = await scCtl.state(); } catch {}
  }
  async function scSet(id, accelerator) {
    if (!scCtl) return;
    scError = '';
    try {
      const r = await scCtl.set(id, accelerator);
      if (r?.state) scState = r.state;
      if (r && !r.ok) scError = tr(r.error) || t('改键失败');
    } catch (e) { scError = tr(e?.message) || t('改键失败'); }
  }
  async function scReset() {
    if (!scCtl) return;
    scError = '';
    try { scState = await scCtl.reset(); } catch (e) { scError = tr(e?.message) || t('恢复默认失败'); }
  }

  // ═══ 壁纸 ═══
  const gridOf = (ids) => [...ids, ...wp.uploads.map((u) => u.id)];
  function bgStyle(id) {
    const d = wpDef(id);
    return d.css ? `background:${d.css}` : `background-image:url("${d.url}");background-size:cover;background-position:center 30%`;
  }
  function pick(slot, id) { setWp(slot, id); setHomeMode(slot === 'light' ? 'B' : 'A'); }
  let wpErr = $state('');
  let upInputL = $state(), upInputD = $state();
  async function compressImage(file) {
    if (!(file.type || '').startsWith('image/') || file.type === 'image/gif') return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (scale >= 1 && file.size < 600 * 1024) { bmp.close?.(); return file; }
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const cvs = document.createElement('canvas'); cvs.width = w; cvs.height = h;
      cvs.getContext('2d').drawImage(bmp, 0, 0, w, h); bmp.close?.();
      const blob = await new Promise((res) => cvs.toBlob(res, 'image/jpeg', 0.82));
      if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
      return file;
    } catch { return file; }
  }
  async function onUpload(slot, e) {
    const files = [...(e.target?.files || [])];
    e.target.value = '';
    if (!files.length) return;
    wpErr = '';
    const pair = splitWpFiles(files);   // 单张 = 普通壁纸；原图 + 深度图 = 空间壁纸
    if (!pair) { wpErr = t('要做空间壁纸，请只选原图和深度图两张，深度图文件名带 depth'); return; }
    try {
      const f = await compressImage(pair.image);
      const d = pair.depth && await compressImage(pair.depth);
      const id = await addUpload(f, slot, d);
      pick(slot, id);
    } catch { wpErr = t('壁纸上传失败，重试'); }
  }

  // ═══ 连接与更新 ═══
  let addrInput = $state(getServerBase() || '');
  let addrBusy = $state(false), addrErr = $state('');
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

  let upState = $state('idle'), progress = $state(0), upMsg = $state(t('检查更新')), upErr = $state('');
  // 上一次「空闲后自动更新」没装成的原因（等满 30 分钟 / 服务端那边取消了 / 安装包不见了…）：壳写在 ready 状态的 note 里（带 noteAt）。
  // 不是错误，用中性说明样式；过一天不再显示，下次点「一键更新」也清掉。用户自己点的「取消等待」壳不写 note。
  let upNote = $state('');
  const noteOf = (st) => (st && st.note && (!st.noteAt || Date.now() - st.noteAt < 24 * 3600_000) ? tr(st.note) : '');
  let pollTimer = null;
  (() => {
    const st = updateState();
    if (st.state === 'ready') { upState = 'installable'; upMsg = t('一键更新'); upNote = noteOf(st); }
    else if (st.state === 'downloading') { upState = 'downloading'; progress = (st.pct || 0) / 100; upMsg = t('正在下载'); pollState(); }
    // 托管着本机服务端、正等所有人的对话跑完去装（S1-5）
    else if (st.state === 'waiting-idle') { upState = 'waiting'; upMsg = waitingLine(st); pollState(); }
    // 服务端已经在退、马上起安装器：撤不回了，只转圈
    else if (st.state === 'handing-off') { upState = 'checking'; upMsg = t('正在拉起安装…'); pollState(); }
    // 装到一半被静默中止过：壳启动时对账出来的。不说出来，用户只会看到「又提示有新版」。
    else if (st.state === 'failed') { upState = 'error'; upMsg = t('上次更新没装上，点击重试'); upErr = tr(st.error || ''); }
  })();
  function pollState() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      const st = updateState();
      if (st.state === 'ready') { progress = 1; upState = 'installable'; upMsg = t('一键更新'); upNote = noteOf(st); clearInterval(pollTimer); }
      else if (st.state === 'downloading') { progress = (st.pct || 0) / 100; }
      else if (st.state === 'waiting-idle') { upState = 'waiting'; upMsg = waitingLine(st); }
      else if (st.state === 'handing-off') { upState = 'checking'; upMsg = t('正在拉起安装…'); }
      else if (st.state === 'installing') { upState = 'checking'; upMsg = t('正在拉起安装…'); clearInterval(pollTimer); }
      else { upState = 'error'; upMsg = tc('settings', '下载失败，点击重试'); clearInterval(pollTimer); }
    }, 500);
  }
  // 一键更新：托管着本机服务端、有对话在跑时，壳会先问「空闲后自动更新 / 立即更新」（S1-5）。点下去就转圈（别留一个还能再点的按钮）
  async function installNow(mode) {
    upErr = ''; upNote = '';
    upState = 'checking'; upMsg = t('正在拉起安装…');
    const r = await installPending(mode ? { mode } : undefined);
    if (r && r.cancelled) { upState = 'installable'; upMsg = t('一键更新'); return; }
    // 这次没装（服务端没接下 / 没应答）：壳已回到「可以装」，把原因说一句
    if (r && r.ok === false && r.error) { upState = 'installable'; upMsg = t('一键更新'); upNote = tr(r.error); return; }
    if (r && r.waiting) { upState = 'waiting'; upMsg = waitingLine(r); }
    pollState();
  }
  async function onCancelWait() {
    const r = await cancelPendingInstall();
    // 服务端已经在退出去装了：撤不回（壳回 error），照实说
    if (r && r.ok === false && r.error) upNote = tr(r.error);
    pollState();
  }
  async function onUpdate() {
    if (upState === 'downloading' || upState === 'checking') return;
    if (upState === 'installable') { installNow(); return; }
    upState = 'checking'; upMsg = t('检查中…');
    let checked;
    try { checked = await checkForUpdate(); }
    catch { upState = 'error'; upMsg = t('连不上服务器'); return; }
    if (!checked?.available) { upState = 'latest'; upMsg = t('已是最新版本'); return; }
    if (hasSilentUpdate()) {
      upState = 'downloading'; progress = 0; upMsg = t('正在下载');
      try { await startUpdate(checked.latest || {}); } catch { upState = 'error'; upMsg = t('下载失败'); return; }
      pollState();
    } else {
      await startUpdate(checked.latest || {});
      upState = 'done'; upMsg = t('已开始下载');
    }
  }
  $effect(() => () => clearInterval(pollTimer));
  // 自动检查更新（启动时检查、后台下好，装不装由你）：只有带自更新桥的壳有（附着本机工程的形态没有）
  let autoUp = $state(autoUpdateEnabled());
  function onAutoUp(v) { autoUp = v; setAutoUpdateEnabled(v); }

  // 服务器那头（要登录）：公网地址 / 后端运行多久——原单页设置「连接」页的内容，进「连接与更新」才拉。
  // /api/app/server-info 不给隧道状态（没有 tunnel 字段），所以这里也不摆「公网隧道」行。
  let srvInfo = $state(null);
  let connectOpen = $state(false);   // 「手机扫码连接」点开才出码（S1-2，components/pairing/ConnectQr.svelte）
  $effect(() => { if (sec !== 'connect') connectOpen = false; });
  $effect(() => {
    if (sec !== 'connect' || me.kind === 'none') return;
    untrack(() => fetchServerInfo().then((r) => { srvInfo = r; }).catch(() => {}));
  });
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
  let pubCopied = $state(false);
  async function copyPublic() {
    try { await navigator.clipboard.writeText(srvInfo.publicOrigin); pubCopied = true; setTimeout(() => { pubCopied = false; }, 1500); } catch {}
  }

  // 手机扫码下载 App（S1-4：手机 App 由这台服务器自己发，/download/android）。只在服务器手里真有包、且是单人服务器时出码
  // （多人服务器上下载要先登录，手机相机扫开的浏览器还没登录）。局域网地址快、只在同一个 Wi-Fi 里通；公网的出门也能下。
  let apkVer = $state(null);
  $effect(() => {
    if (sec !== 'connect') return;
    untrack(() => fetch(apiUrl('/api/app/version'), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((v) => { apkVer = v; }).catch(() => {}));
  });
  // 默认出公网地址的码（出门也能下）；只有这页本身就是经局域网地址打开的、或没有公网地址时才默认局域网的。
  // dlWhich 是用户点「改用…」后的选择，空 = 按默认。局域网候选服务端只给手机真连得上的（app-update.mjs lanCandidates）
  let dlWhich = $state('');
  let dlQr = $state('');
  const dlUrls = $derived(appDownloadUrls(srvInfo));
  const pageOnLan = (() => {
    try { return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(new URL(getServerBase() || location.origin).hostname); } catch { return false; }
  })();
  const dlPick = $derived(dlWhich || (pageOnLan || !dlUrls.pub ? 'lan' : 'pub'));
  const dlUrl = $derived(dlPick === 'pub' ? (dlUrls.pub || dlUrls.lan) : (dlUrls.lan || dlUrls.pub));
  const dlShow = $derived(!!(srvInfo && !srvInfo.multiUser && apkVer && apkVer.available && dlUrl));
  $effect(() => {
    const u = dlShow ? dlUrl : '';
    if (!u) { dlQr = ''; return; }
    qrSvg(u).then((s) => { if (u === dlUrl) dlQr = s; }).catch(() => { dlQr = ''; });
  });

  // 服务端控制台入口：服务端就在这台电脑上（本机直连放行），或服务端开着远程管理（features.remoteAdmin）时的管理员。
  let srvAdminOk = $state(false);
  $effect(() => {
    const want = serverOnThisMachine() || (me.kind === 'admin' && !!me.features?.remoteAdmin);
    if (want && !srvAdminOk) saPing().then(() => { srvAdminOk = true; }).catch(() => {});
  });

  // ═══ 服务进程（壳原生，掉线也在）═══
  // 状态与「启停/重启/日志」都在壳的控制台窗口里，这里只做入口 + 一句实时状态。
  let spState = $state(null);
  function refreshSp() { spCtl?.status().then((s) => { if (s) spState = s; }).catch(() => {}); }
  $effect(() => {
    if (!spCtl || sec !== 'connect') return;
    refreshSp();
    // 壳侧状态要跑 admin.ps1 status（冷起 PowerShell + WMI，几秒）：15 秒一次、窗口在后台不拉；掉线 / 恢复有 onHealth 即时推（FR3）
    const timer = setInterval(() => { if (!document.hidden) refreshSp(); }, 15000);
    const off = spCtl.onHealth ? spCtl.onHealth(() => refreshSp()) : null;
    return () => { clearInterval(timer); try { off && off(); } catch {} };
  });
  const spLine = $derived(!spState ? t('读取中…')
    : spState.health === 'up' ? (spState.server?.pid ? t('运行中 · PID {pid}', { pid: spState.server.pid }) : t('运行中'))
    : spState.health === 'unresponsive' ? t('进程在，但没有应答')
    : t('已停止 · 点这里启动'));
  // 退出 App 会连带停掉本机服务端（壳托管的 managed 形态）：点「退出」先问一句，默认隐藏到托盘、服务端照常在线（S1-3）。
  // 插电时保持在线（S1-3）：这台电脑当服务器，插着电就不闲置睡眠。真相都在主进程（client.json），老壳没有这些字段 → 行不出现。
  let spPrefs = $state(null);
  $effect(() => {
    if (!spCtl?.prefs || sec !== 'connect') return;
    spCtl.prefs().then((p) => { if (p) spPrefs = p; }).catch(() => {});
  });
  async function onConfirmQuit(v) {
    try { const r = await spCtl.setPrefs({ confirmQuit: v }); if (r) spPrefs = { ...spPrefs, ...r }; } catch { /* 保持原状 */ }
  }
  async function onKeepOnline(v) {
    try { const r = await spCtl.setPrefs({ keepOnline: v }); if (r) spPrefs = { ...spPrefs, ...r }; } catch { /* 保持原状 */ }
  }
  // acSleepMin：电源计划里插电闲置多少分钟睡眠（0 = 从不，null = 读不出）
  const keepOnlineSub = $derived(!spPrefs ? ''
    : spPrefs.keepOnline
      ? (spPrefs.onBattery ? t('现在在用电池：照常睡眠，插上电再接着保持在线') : t('这台电脑当服务器：插着电时不会闲置睡眠（屏幕照常关），手机随时连得上；用电池时照常睡眠'))
      : spPrefs.acSleepMin > 0 ? t('关着：插电闲置 {n} 分钟后电脑会睡眠，睡着时手机连不上', { n: spPrefs.acSleepMin })
      : spPrefs.acSleepMin === 0 ? t('关着：电源计划本来就不让电脑自动睡眠，手机随时连得上')
      : t('关着：电脑按电源计划睡眠，睡着时手机连不上'));

  // ═══ 帮助 · 反馈 ═══
  let fbText = $state(''), fbBusy = $state(false), fbDone = $state(false), fbErr = $state('');
  let fbAtts = $state([]), fbFileInput = $state();
  async function onFbFiles(e) {
    const files = filesFromInput(e);
    for (const raw of files) {
      const isImg = (raw.type || '').startsWith('image/'), isVid = (raw.type || '').startsWith('video/');
      if (!isImg && !isVid) { fbErr = t('只能加图片或视频'); continue; }
      const f = isImg ? await compressImage(raw) : raw;
      await uploadAttachment(fbAtts, f, {
        draft: { name: f.name, kind: isImg ? 'image' : 'video', path: null, pending: true },
        upload: (file) => api.uploadBlob(file.name, file),
        onError: () => { fbErr = t('上传失败：{name}', { name: raw.name }); },
      });
    }
  }
  async function submitFeedback() {
    if (fbAtts.some((a) => a.pending)) { fbErr = t('附件还在上传…'); return; }
    const text = fbText.trim();
    if (!text && !fbAtts.length) { fbErr = t('写点什么、或加个图片/视频吧'); return; }
    fbBusy = true; fbErr = '';
    try {
      const attachments = fbAtts.filter((a) => a.path).map((a) => ({ path: a.path, name: a.name, kind: a.kind }));
      // shareWithDeveloper：提交的人自己勾了「这条也发给 bridge 开发者」才带 true，服务端才推（没带的只落本机）
      const r = await api.post('/api/feedback', { text, screen: 'settings-desktop', attachments, shareWithDeveloper: fbUp?.mode === 'push' && fbConsent === true });
      if (r && r.ok === false) throw new Error(r.error || 'fail');
      fbDone = true; fbText = ''; fbAtts = []; fbConsent = false;   // 同意只对这一条：下一条重新问
    } catch (e) { fbErr = t('提交失败：{reason}', { reason: tr(e?.body?.error || e?.message) || t('连不上服务器') }); }
    finally { fbBusy = false; }
  }
  // 反馈去向（/api/feedback/upstream）：默认只留在这台服务器上。管理员在这里主动打开「把用户反馈同时发给 bridge 开发者」
  // （默认关）之后，提交的人还要自己勾「这条也发给 bridge 开发者」（fbConsent，默认不勾、每条提交完复位）才发。
  // 没配中继地址（reason=no-relay）、不是正式实例时不出开关；开发者自己那台（mode=inbox）是汇总端，不出提示也不出开关。
  let fbUp = $state(null), fbUpBusy = $state(false), fbConsent = $state(false);
  function loadFbUp() { api.get('/api/feedback/upstream').then((r) => { fbUp = r; }).catch(() => {}); }
  // 去向文案里的「发给谁」：发行版声明的（服务端回的 dest 优先，其次注入的 DISTRO.feedback），没声明 = 本体的「bridge 开发者」
  const fbDest = $derived(feedbackDest(fbUp?.dest, lang()));
  // 打开设置就取一次（设置搜索按它决定出不出「同时发给 bridge 开发者」），进反馈页再刷新
  $effect(() => { const s = sec, k = me.kind; untrack(() => { if (k !== 'none' && (s === 'help' || !fbUp)) loadFbUp(); }); });
  async function onFbUp(v) {
    if (fbUpBusy) return;
    fbUpBusy = true;
    try { fbUp = await api.post('/api/feedback/upstream', { enabled: v }); }
    catch (e) { fbErr = t('没改成：{reason}', { reason: tr(e?.body?.error || e?.message) || t('连不上服务器') }); loadFbUp(); }
    finally { fbUpBusy = false; }
  }
  // 推送端由反馈卡里的勾选行自己写明发什么；其余一句话说清只留本机。没配中继 / 不是正式实例（reason 有值）时开关根本不出现，
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

  let verLine = $state(DISTRO.brand);
  appVersionLine().then((l) => { verLine = l; }).catch(() => {});

  // ═══ 关闭 ═══
  function back() {
    if (closing) return;
    if (anyModal) { acctForm = null; acctDel = null; agLast = null; logoutAsk = false; bypassAsk = false; return; }
    ui.homePop++;
    closing = true;
    setTimeout(() => { ui.settingsOpen = false; }, 170);
  }
  $effect(() => registerCloser('settings', back));
  // 快捷键清单的真相在主进程（注册成没成功只有它知道）：进设置拉一次，之后跟着它推。
  $effect(() => {
    scRefresh();
    return scCtl?.onState?.((s) => { if (s) scState = s; });
  });
  // 扩展面板有弹层 / 详情开着时它在捕获阶段先接了 Esc（defaultPrevented），这里就别再关整页
  function onKey(e) { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); back(); } }

  // WCO 几何早期恒 visible=false（批1 课）：保持响应式，几何到位自动重算。
  // 首行折进标题栏带（macOS 系统设置同款）：带内垂直居中（(带高-34)/2，34=--sd-hd），
  // 控件中心对齐系统窗控中心；非 WCO 场景给 8px 呼吸位。
  const bandPad = $derived(wcoActive() ? Math.max((wcoHeight() - 34) / 2, 0) : 8);
</script>

<svelte:window onkeydown={onKey} />

{#snippet ava(cls = '')}
  <span class="ava {cls}" class:none={me.kind === 'none'}>{#if me.kind !== 'none'}{initial}{:else}{@html PERSON}{/if}</span>
{/snippet}
{#snippet nico(n)}
  <span class="nico" aria-hidden="true">{#if n.brand}{#if markSrc(n.brand)}<img src={markSrc(n.brand)} alt="" draggable="false" />{:else}{@html svgOf('orb')}{/if}{:else}{@html svgOf(n.ico)}{/if}</span>
{/snippet}
<!-- Claude 设置的一行（注册表驱动）：标题旁「已改过默认值」小点、本机项「这台设备」胶囊、改过时「恢复默认」、
     依赖项缩进；控件按类型出（开关 / 分段 / 下拉 / 压缩点只读值）。沿用 .drow 类，分组卡的发丝线照画 -->
{#snippet crow(key, id)}
  {#if visible(key)}
    <div class="drow cr" class:ind={!!CS[key].dependsOn} class:hl={fl(id)}>
      <span class="cr-tx"><span class="cr-t">{csLabel(key)}{#if changed(key)}<i class="chg" title={t('已改过默认值')}></i>{/if}{#if CS[key].scope === 'device'}<span class="pill">{t('这台设备')}</span>{/if}</span></span>
      <span class="cr-tr">
        {#if changed(key)}<button class="cr-reset" aria-label={t('将「{label}」恢复默认', { label: csLabel(key) })} onclick={() => resetVal(key)}>{t('恢复默认')}</button>{/if}
        {#if CS[key].type === 'bool'}
          <DSwitch checked={!!val(key)} disabled={CS[key].scope === 'device' && !notifyOn} onchange={(v) => toggleCs(key, v)} />
        {:else if key === 'compactFrac'}
          <span class="num">{valueLabel(key)}</span>
        {:else if SEGMENTED.has(key)}
          <DSegmented options={csSelectOpts(key)} value={val(key)} onchange={(v) => setVal(key, v)} />
        {:else}
          <DSelect options={csSelectOpts(key)} value={val(key)} onchange={(v) => setVal(key, v)} width={SELECT_W[key] || '160px'} />
        {/if}
      </span>
    </div>
  {/if}
{/snippet}
{#snippet meter(name, b)}
  <span class="mm"><span class="mh">{name}<b class={b ? usageTone(b) : ''}>{b ? b.pct + '%' : '—'}</b></span><span class="mb"><i class={b ? usageTone(b) : ''} style:width="{b ? Math.min(100, b.pct) : 0}%"></i></span><span class="mr" title={b ? poolResetIn(b.resetsAt) : ''}>{b ? poolResetAt(b.resetsAt) : ''}</span></span>
{/snippet}

<div class="sd" class:closing class:light={!dark} style:--sd-band="{bandPad}px">
  <aside class="side">
    <button class="back" onclick={back} title={single ? t('关闭 (Esc)') : t('返回主页 (Esc)')}>
      <svg viewBox="0 0 10 16" width="7" height="12"><path d="M8.5 1 2 8l6.5 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      {single ? t('返回') : t('主页')}
    </button>
    <div class="srch">
      <svg class="si" viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m11 11 3.4 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <input placeholder={t('搜索')} bind:value={query} />
    </div>

    {#if hits.length}
      <div class="hits">
        {#each hits as h (h.sec + h.id)}
          <button class="hit" onclick={() => jump(h)}>
            <span class="hl">{h.label}</span>
            <span class="hs">{SECNAME[h.sec]}</span>
          </button>
        {/each}
      </div>
    {:else}
      <!-- 账户行（macOS：搜索下方第一位）：登录状态入口 -->
      <button class="acct" class:on={sec === 'account'} onclick={() => navigate('account')}>
        {@render ava()}
        <span class="atxt">
          <b>{me.kind === 'none' ? t('未登录') : (me.user || 'Admin')}</b>
          <i>{me.kind === 'none' ? t('登录 bridge 账户') : roleLabel}</i>
        </span>
      </button>
      <nav class="nav">
        {#each NAV_GROUPS as grp, gi (gi)}
          <div class="ngrp">
            {#each grp as n (n.key)}
              <button class="nit" class:on={sec === n.key} class:off={n.off} onclick={() => navigate(n.key)}>
                {@render nico(n)}<span class="nl">{n.label}</span>{#if n.badge}<span class="nbadge" title={t('{n} 个插件有更新', { n: n.badge })}>{n.badge}</span>{/if}
              </button>
            {/each}
          </div>
        {/each}
      </nav>
    {/if}
    <div class="ver sel-text">{verLine}</div>
  </aside>

  <main class="det">
    <header class="dhd" class:scrolled>
      <div class="hnav">
        <button class="hbtn" disabled={hi <= 0} onclick={goBack} title={t('后退')}>
          <svg viewBox="0 0 10 16" width="8" height="13"><path d="M8.5 1 2 8l6.5 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="hbtn" disabled={hi >= hist.length - 1} onclick={goFwd} title={t('前进')}>
          <svg viewBox="0 0 10 16" width="8" height="13"><path d="M1.5 1 8 8l-6.5 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="htitle" class:on={scrolled || !(sec === 'account' || sec === 'extensions' || sec === 'agentapi' || sec.startsWith('ag-'))}>{SEC_TITLE}</div>
    </header>

    <div class="scroll" class:plg={!!plgOf(sec)} onscroll={(e) => { scrolled = e.currentTarget.scrollTop > 2; }}>
    {#if plgOf(sec)}
      {@const pp = plgOf(sec)}
      {#key pp.id}<div class="plg-host"><PluginFrame id={pp.id} page={pp.page} mode="panel" onBack={goBack} /></div>{/key}
    {:else if sec.startsWith('plg-')}
      <p class="note">{pluginPanels.loaded ? t('这个插件面板不在了（插件被关掉或卸载了）') : t('载入中…')}</p>
    {:else if sec === 'account'}
      {#if me.kind !== 'none'}
        <div class="hero">
          {@render ava('xl')}
          <h2>{me.user || 'Admin'}</h2>
          <p>{roleLabel}{status.plan ? ' · ' + status.plan : ''}</p>
        </div>
        <DGroup label={t('订阅额度')}>
          <div class="usage" class:hl-line={fl('usage')}>
            {#each [[t('5 小时额度'), fiveH], [t('本周额度'), weekly]] as [name, v] (name)}
              <div class="u">
                <span class="ul">{name}</span>
                <span class="ubar">{#if v != null}<i style:width="{v}%" class:hot={v > 80}></i>{/if}</span>
                <span class="uv">{v == null ? '—' : v + '%'}</span>
              </div>
            {/each}
          </div>
        </DGroup>
        <DGroup>
          <DRow title={t('工作空间')} onclick={openWorkspace} highlight={fl('acct')} />
          {#if me.kind === 'user'}
            {#if pwForm}
              <form class="lform" onsubmit={savePw}>
                {#if pwForm.err}<p class="err">{pwForm.err}</p>{/if}
                <DField bind:value={pwForm.old} placeholder={t('原密码')} type="password" width="100%" />
                <DField bind:value={pwForm.next} placeholder={t('新密码（至少 8 位）')} type="password" width="100%" />
                <DField bind:value={pwForm.again} placeholder={t('再输一次新密码')} type="password" width="100%" />
                <div class="lacts">
                  <span class="sp"></span>
                  <DButton variant="ghost" onclick={() => { pwForm = null; }}>{t('取消')}</DButton>
                  <DButton variant="primary" type="submit" disabled={pwForm.busy}>{pwForm.busy ? t('保存中…') : t('保存')}</DButton>
                </div>
              </form>
            {:else}
              <DRow title={t('修改密码')} sub={pwOk ? t('已改好。别的设备要用新密码重新登录，这台不受影响。') : ''} onclick={() => { pwOk = false; pwForm = { old: '', next: '', again: '', busy: false, err: '' }; }} />
            {/if}
          {/if}
        </DGroup>
        {#if me.kind === 'user'}
          <DGroup label={t('我的额度')} foot={myUsage && hasLimits(myUsage) ? costNote() : ''}>
            {#if myUsage && hasLimits(myUsage)}
              {#each quotaRows(myUsage) as r (r.label)}
                <DRow title={r.label}>
                  {#snippet trailing()}<span class="qv" class:hot={r.hot}>{r.value}</span>{/snippet}
                </DRow>
              {/each}
            {:else}
              <DRow title={myUsage ? t('不限') : t('读取中…')} />
            {/if}
          </DGroup>
          <!-- 管理员可见性（S2-7）：成员自己决定管理员能不能看内容、代聊代答、看他的电脑，并看到访问记录 -->
          <AdminAccessSection highlight={fl('admin-access')} />
        {/if}
        <DGroup>
          <!-- 切换账号＝退出这台设备，账户区随即变成登录表单（不囤多张会话令牌，理由见 lib/account.js） -->
          <DRow title={t('切换账号')} chevron={false} onclick={() => { logoutAsk = 'switch'; }} />
          <DRow title={t('退出登录')} danger chevron={false} onclick={() => { logoutAsk = 'logout'; }} />
        </DGroup>
      {:else}
        <div class="hero">
          {@render ava('xl')}
          <h2>{mode === 'qr' ? t('扫码登录') : mode === 'register' ? t('注册新账号') : mode === 'token' ? t('管理员令牌') : t('登录 The Bridge')}</h2>
          <p>{mode === 'qr' ? t('打开手机上的 The Bridge，在设置 › 账户点「扫一扫」') : mode === 'register' ? t('需要邀请码；注册即登录。') + ' ' + t('服主默认只看得到你的会话标题、时间和用量；看内容要你在设置里允许。') : mode === 'token' ? t('粘贴服务端的访问令牌，以管理员身份直连。') : t('登录后使用对话、工作空间与用量')}</p>
        </div>
        <div class="lwrap">
          {#if mode === 'qr'}
            <div class="qrpane">
              <div class="qrbox" class:dim={pair.status !== 'pending'}>
                {#if pair.svg}{@html pair.svg}{/if}
                {#if pair.status !== 'pending'}
                  <button class="qrov" onclick={() => pairCtl?.refresh()} disabled={pair.status === 'loading' || pair.status === 'idle' || pair.status === 'approved' || pair.status === 'scanned'}>{pairMsg}</button>
                {/if}
              </div>
              <DButton variant="ghost" onclick={() => { mode = 'login'; lgErr = ''; }}>{t('账号密码登录')}</DButton>
            </div>
          {:else}
            <form class="lform card" onsubmit={submitAuth}>
              {#if mode === 'token'}
                <DField bind:value={lgTok} placeholder={t('访问令牌')} type="password" width="100%" />
              {:else}
                <DField bind:value={lgUser} placeholder={mode === 'register' ? t('账号（2–32 位字母/数字/_/-）') : tc('settings', '账号')} width="100%" />
                <DField bind:value={lgPass} placeholder={mode === 'register' ? t('密码（至少 8 位）') : t('密码')} type="password" width="100%" />
                {#if mode === 'register'}
                  <DField bind:value={lgPass2} placeholder={t('确认密码')} type="password" width="100%" />
                  <DField bind:value={lgInvite} placeholder={t('邀请码')} width="100%" />
                {/if}
              {/if}
              {#if lgErr}<p class="err">{lgErr}</p>{/if}
              <button class="go" type="submit" disabled={lgBusy}>{lgBusy ? t('请稍候…') : mode === 'register' ? t('注册') : t('登录')}</button>
            </form>
            <div class="alts">
              {#if mode === 'login'}
                <button onclick={() => { mode = 'qr'; lgErr = ''; }}>{t('扫码登录')}</button>
                {#if me.features?.register !== false}<button onclick={() => { mode = 'register'; lgErr = ''; }}>{t('注册新账号')}</button>{/if}
                <button onclick={() => { mode = 'token'; lgErr = ''; }}>{t('用访问令牌登录')}</button>
              {:else}
                <button onclick={() => { mode = 'login'; lgErr = ''; }}>{t('返回登录')}</button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

    {:else if sec === 'general'}
      <DGroup label={t('语言')}>
        <DRow title={t('界面语言')} highlight={fl('lang')}>
          {#snippet trailing()}<DSegmented options={LANGS} value={lang()} onchange={setLang} />{/snippet}
        </DRow>
      </DGroup>
      <DGroup label={t('系统')}>
        <DRow title={t('通知')} highlight={fl('notify')}>
          {#snippet trailing()}<DSwitch checked={notifyOn} onchange={onNotify} />{/snippet}
        </DRow>
        {#if asCtl && autoStart.supported}
          <DRow title={t('开机自动启动')} highlight={fl('autostart')}>
            {#snippet trailing()}<DSwitch checked={autoStart.enabled} onchange={onAutoStart} />{/snippet}
          </DRow>
        {/if}
        <DRow title={t('原图加载')} highlight={fl('fullres')}>
          {#snippet trailing()}<DSwitch checked={prefs.fullResMedia} onchange={onFullRes} />{/snippet}
        </DRow>
      </DGroup>

    {:else if sec === 'appearance'}
      <div class="themes" class:hl-line={fl('theme')} role="radiogroup" aria-label={t('外观')}>
        {#each [['light', t('明亮')], ['dark', t('深色')], ['auto', t('跟随系统')]] as [v, name] (v)}
          <button class="tp" class:on={themeNow === v} role="radio" aria-checked={themeNow === v} onclick={() => pickTheme(v)}>
            <span class="tp-art {v}" aria-hidden="true">
              {#each v === 'auto' ? ['light', 'dark'] : [v] as half (half)}
                <span class="half {half}"><i></i><i></i><i></i></span>
              {/each}
            </span>
            <span class="tp-name">{name}</span>
          </button>
        {/each}
      </div>
      <DGroup>
        {#if !single}
          <DRow title={t('分页跟随主页明暗')} highlight={fl('followpage')}>
            {#snippet trailing()}<DSwitch checked={prefs.followPage} onchange={onFollowPage} />{/snippet}
          </DRow>
        {/if}
        <DRow title={t('禁用转场动画')} highlight={fl('noanim')}>
          {#snippet trailing()}<DSwitch checked={prefs.noEnterAnim} onchange={onNoAnim} />{/snippet}
        </DRow>
      </DGroup>

    {:else if sec.startsWith('ag-')}
      {@const id = sec.slice(3)}
      {@const a = agentById(id)}
      <div class="hero">
        <span class="mark">{#if markSrc(id)}<img src={markSrc(id)} alt="" draggable="false" />{/if}</span>
        <h2>{SEC_TITLE}</h2>
        {#if a && agStatus(a)}<p class:warn={a.runnable && a.switch && !a.authed}>{agStatus(a)}</p>{/if}
      </div>
      {#if a}
        <DGroup foot={a.runnable && a.switch && !a.authed && AG_AUTH_HINT[id] ? AG_AUTH_HINT[id]() : ''}>
          <DRow title={t('启用 {name}', { name: tr(a.label) })} highlight={fl('agents')}>
            {#snippet trailing()}<DSwitch checked={a.switch && a.runnable} disabled={!a.runnable || ags.agentBusy === a.id} onchange={(v) => toggleAgent(a, v)} />{/snippet}
          </DRow>
        </DGroup>
      {/if}

      {#if id === 'claude'}
        <ClaudeCliStatus />
        {#if ags.poolOk}
          <div class="ghd">
            <h3>{t('订阅号池')}</h3>
            <button class="ico-btn" class:busy={ags.usageBusy} onclick={() => loadUsage(true)} disabled={ags.usageBusy} title={ags.usageBusy ? t('刷新中…') : t('刷新用量')}>{@html svgOf('refresh', 1.8)}</button>
          </div>
          <!-- 服务端标 source:'last-use' 时，用量是各号上次使用时的，脚注里说一句 -->
          <DGroup foot={[apiKeyNote(), Object.values(ags.usage || {}).some((u) => u?.source === 'last-use') ? t('闲置的号显示它上次使用时的额度；还没用过的号要用过一次才有数据。') : ''].filter(Boolean).join(' ')}>
            <div class="pool" class:hl-line={fl('pool')}>
              {#each ags.accounts as acc, i (acc.id)}
                {@const u = ags.usage[acc.id]}
                <div class="drow prow">
                  <div class="pmain">
                    <div class="pname">
                      <b>{accLabel(acc.label)}</b>
                      {#if u?.plan === 'max'}<span class="pill">Max</span>{:else if u?.plan === 'pro'}<span class="pill">Pro</span>{/if}
                      {#if acc.active}<span class="cur">{t('使用中')}</span>{/if}
                    </div>
                    <div class="mini">
                      {#if !u}<span class="mna">{ags.usageBusy ? t('读取用量…') : (acc.hasToken ? '…' + (acc.tokenTail || '') : t('用本机登录态（~/.claude）'))}</span>
                      {:else if u.error && !u.five_hour && !u.seven_day}<span class="mna bad">{tr(u.error)}</span>
                      {:else}
                        {@render meter(t('5 小时'), u.five_hour)}
                        {@render meter(t('每周'), u.seven_day)}
                        {@render meter('Fable', u.fable)}
                      {/if}
                    </div>
                  </div>
                  <div class="pacts">
                    {#if !acc.active}<DButton size="sm" onclick={() => activateAccount(acc)}>{t('切到此号')}</DButton>{/if}
                    <span class="tools">
                      {#if ags.accounts.length > 1}
                        <button class="ico-btn" disabled={i === 0} onclick={() => moveAccount(acc, -1)} title={t('上移')}>{@html svgOf('up', 1.8)}</button>
                        <button class="ico-btn" disabled={i === ags.accounts.length - 1} onclick={() => moveAccount(acc, 1)} title={t('下移')}>{@html svgOf('down', 1.8)}</button>
                      {/if}
                      <button class="ico-btn" onclick={() => openEditAcct(acc)} title={t('编辑账号')}>{@html svgOf('edit', 1.7)}</button>
                      {#if ags.accounts.length > 1}<button class="ico-btn danger" onclick={() => { acctDel = acc; }} title={t('删除账号')}>{@html svgOf('trash', 1.7)}</button>{/if}
                    </span>
                  </div>
                </div>
              {/each}
              <button class="drow addrow" onclick={openAddAcct}>{@html svgOf('plus', 1.8)}{t('添加账号')}</button>
            </div>
          </DGroup>
          {#if ags.err}<p class="err">{ags.err}</p>{/if}

        {/if}

        <!-- 模型服务（自定义 API，管理员与成员各一份）：紧跟号池——两者都是「模型从哪来」 -->
        {#if cp.ok}
          <DGroup label={t('模型服务')}>
            <DRow title={t('自定义 API')} sub={provSummary} highlight={fl('cproviders')} onclick={() => (provOpen = true)} />
          </DGroup>
        {/if}

        <!-- 撞上限额时：按身份的续跑默认 + 号池智能路由（管理员）；依赖项缩进紧跟主项 -->
        <DGroup label={t('撞上限额时')}>
          {@render crow('autoContinueOnLimit', 'climit')}
          {#if ags.poolOk}
            <DRow title={t('额度用尽自动换号')} sub={ags.accounts.length < 2 ? t('号池里至少要有两个账号才用得上') : ''} highlight={fl('router')}>
              {#snippet trailing()}<DSwitch checked={routerOn} disabled={!ags.router || ags.routerBusy} onchange={(v) => setRouter({ enabled: v })} />{/snippet}
            </DRow>
            {#if routerOn}
              <div class="drow cr ind">
                <span class="cr-tx"><span class="cr-t">{t('额度恢复后回到首选号')}</span></span>
                <span class="cr-tr"><DSwitch checked={ags.router.settings.returnToPrimary} disabled={ags.routerBusy} onchange={(v) => setRouter({ returnToPrimary: v })} /></span>
              </div>
              <div class="drow cr ind">
                <span class="cr-tx"><span class="cr-t">{t('会话中无缝换号')}</span><span class="cr-s">{t('快用满时在两步之间换号，进行中的对话不中断')}</span></span>
                <span class="cr-tr"><DSwitch checked={!!ags.router.settings.seamless} disabled={ags.routerBusy} onchange={(v) => setRouter({ seamless: v })} /></span>
              </div>
            {/if}
          {/if}
        </DGroup>
        {#if ags.poolOk && routerOn && ags.router.log?.length}
          <DGroup label={t('最近的自动切换')}>
            {#each ags.router.log as l (l.at)}
              <DRow title="{accLabel(acctById(l.from)?.label || l.fromLabel)} → {accLabel(acctById(l.to)?.label || l.toLabel)}" sub={whyText(l.reason)}>
                {#snippet trailing()}<span class="num">{hhmm(l.at)}</span>{/snippet}
              </DRow>
            {/each}
          </DGroup>
        {/if}

        <!-- 服务意外重启时：上一条命没跑完的轮，服务恢复后自动接着做（src/runtime/restart-resume.mjs） -->
        <DGroup label={t('服务意外重启时')}>
          {@render crow('autoResumeOnRestart', 'crestart')}
        </DGroup>

        <!-- 新会话默认：会话里可以单独改（模式菜单 / 加号菜单的输出风格） -->
        <DGroup label={t('新会话默认')}>
          {@render crow('permissionMode', 'cdef-perm')}
          {@render crow('outputStyle', 'cdef-style')}
          {#if cs.shell}
            <div class="drow cr">
              <span class="cr-tx"><span class="cr-t">{t('用工作树')}<span class="pill">{t('这台设备')}</span></span></span>
              <span class="cr-tr"><DSwitch checked={prefs.worktree} onchange={(v) => { prefs.worktree = v; savePrefs(); }} /></span>
            </div>
          {/if}
        </DGroup>

        <DGroup label={t('对话')}>
          {@render crow('promptSuggestions', 'suggest')}
          {@render crow('inlineVisualizations', 'cviz')}
          {@render crow('enableWorkflows', 'cwf')}
          {#if visible('subagentDispatch')}
            <div class="drow cr ind dsp" class:hl={fl('cdispatch')}>
              <span class="cr-tx">
                <span class="cr-t">{csLabel('subagentDispatch')}{#if changed('subagentDispatch')}<i class="chg" title={t('已改过默认值')}></i>{/if}</span>
                <span class="cr-s" class:bad={!!dspErr}>{dspErr || csDesc('subagentDispatch')}</span>
              </span>
              <span class="cr-tr">
                {#if dspMsg}<span class="dsp-ok">{dspMsg}</span>{/if}
                {#if changed('subagentDispatch')}<button class="cr-reset" onclick={() => { dspErr = ''; dspDraft = ''; resetVal('subagentDispatch'); }}>{t('清空')}</button>{/if}
              </span>
              <div class="dsp-box">
                <textarea rows="4" maxlength={CS.subagentDispatch.maxLen} bind:value={dspDraft}
                  placeholder={t('例：简单任务（检索、读文件、批量改名）用 mimo-v2.6-flash；普通构建任务用 deepseek-v4.1-flash；难题和最终审查留给主模型。其余按实际情况判断，不局限于这几个。')}
                  onfocus={() => { dspFocus = true; }} onblur={() => { dspFocus = false; saveDispatch(); }}
                  onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.blur(); } }}></textarea>
                <span class="dsp-n">{dspDraft.length} / {CS.subagentDispatch.maxLen}</span>
              </div>
            </div>
          {/if}
          {@render crow('switchModelsOnFlag', 'cflag')}
          {@render crow('planClearContext', 'cplan')}
          {@render crow('questionTimeout', 'cqto')}
          {@render crow('replyLanguage', 'clang')}
          {@render crow('compactFrac', 'ccompact')}
          {#if markOpts.length > 1}
            <div class="drow cr" class:hl={fl('thinkmark')}>
              <span class="cr-tx"><span class="cr-t">{t('思考动画')}<span class="pill">{t('这台设备')}</span></span></span>
              <span class="cr-tr">
                <DSelect options={markOpts} value={prefs.claudeMark} onchange={onClaudeMark} width="170px" />
              </span>
            </div>
          {/if}
        </DGroup>

        {#if visible('newSessionPolicy') || visible('crossSessionInbound')}
          <DGroup label={t('会话协作')}>
            {@render crow('newSessionPolicy', 'cnewsess')}
            {@render crow('crossSessionInbound', 'cinbound')}
          </DGroup>
        {/if}

        {#if cs.shell}
          <DGroup label={t('Git 与拉取请求')}>
            <div class="drow cr" class:hl={fl('cbranch')}>
              <span class="cr-tx"><span class="cr-t">{csLabel('branchPrefix')}{#if changed('branchPrefix')}<i class="chg" title={t('已改过默认值')}></i>{/if}</span>{#if prefixErr}<span class="cr-s bad">{prefixErr}</span>{/if}</span>
              <span class="cr-tr">
                {#if changed('branchPrefix')}<button class="cr-reset" onclick={() => { prefixErr = ''; resetVal('branchPrefix'); }}>{t('恢复默认')}</button>{/if}
                {#key cs.values.branchPrefix}<DField value={changed('branchPrefix') ? val('branchPrefix') : ''} placeholder="claude" width="220px" onchange={savePrefix} />{/key}
              </span>
            </div>
            {@render crow('worktreeBaseRef', 'cwtbase')}
            {@render crow('autoFixPullRequests', 'cautofix')}
            {@render crow('autoArchiveOnPrClose', 'cprarchive')}
            {@render crow('attribution', 'cattrib')}
          </DGroup>
        {/if}

        <DGroup label={t('会话管理')}>
          {@render crow('autoArchiveDays', 'carchive')}
          {@render crow('followDesktopArchive', 'cdesk')}
        </DGroup>

        <DGroup label={t('通知')} foot={notifyOn ? '' : t('通知总开关在「通用」里关着')}>
          {@render crow('notifyPermission', 'cn-perm')}
          {@render crow('notifyQuestion', 'cn-q')}
          {@render crow('notifyTaskComplete', 'cn-done')}
        </DGroup>

        {#if cs.admin}
          <!-- 这一组眼下只有保持唤醒两项：服务端说这台机器做不到（非 Windows）时整组不出 -->
          {#if visible('keepAwake')}
            <DGroup label={t('这台电脑')}>
              {@render crow('keepAwake', 'cawake')}
              {@render crow('keepAwakeOnBattery', 'cawake')}
            </DGroup>
          {/if}
          <DGroup label={t('扩展与记忆')}>
            {#if extOk}
              <DRow title={t('技能')} onclick={() => openExtType('skill')} />
              <DRow title={t('连接器')} onclick={() => openExtType('connector')} />
              <DRow title={t('插件')} onclick={() => openExtType('plugin')} />
            {/if}
            {#if pluginOn('routines')}<DRow title={t('定时任务')} onclick={openRoutinesPage} />{/if}
          </DGroup>
          <!-- 安全：危险项置底；打开「绕过」走确认框（{#key} 让取消后开关弹回原位） -->
          <DGroup label={t('安全')}>
            {#key bypassAsk}{@render crow('allowBypass', 'cbypass')}{/key}
            {@render crow('allowAutoMode', 'cauto')}
          </DGroup>
        {/if}
        {#if clErr}<p class="err">{clErr}</p>{/if}
      {/if}

      {#if !a && id !== 'claude'}<p class="note">{t('只有管理员能改这里')}</p>{/if}

    {:else if sec === 'extensions'}
      {#key extKey}<Customize />{/key}

    {:else if sec === 'policy'}
      {#if ags.policy}
        <DGroup>
          <DRow title={t('凭邀请码注册')} highlight={fl('policy')}>
            {#snippet trailing()}<DSwitch checked={ags.policy.register} onchange={(v) => savePolicy({ register: v })} />{/snippet}
          </DRow>
        </DGroup>
        <DGroup label={t('注册用户的默认额度')} foot={t('只算 Claude，管理员不受限。留空或填 0 = 不限。')}>
          {#each POLICY_FIELDS as f (f.k)}
            <DRow title={f.label()}>
              {#snippet trailing()}
                <span class="numf"><DField value={policyVal(f.k) ? String(policyVal(f.k)) : ''} placeholder={t('不限')} width="92px" onchange={(v) => savePolicyField(f.k, v)} /><i>{f.unit()}</i></span>
              {/snippet}
            </DRow>
          {/each}
          <DRow title={t('「每天」按哪个时区换日')}>
            {#snippet trailing()}<DField value={ags.policy.timezone || 'Asia/Shanghai'} width="170px" onchange={(v) => savePolicyField('timezone', v)} />{/snippet}
          </DRow>
        </DGroup>
        {#if ags.err}<p class="err">{ags.err}</p>{/if}
      {/if}

    {:else if sec === 'shortcuts'}
      {#each scState.groups as g}
        <DGroup
          label={tr(g.label)}
          foot={g.id === 'safety'
            ? t('急停键的组合刻意难按出来：一个拿到桌面权限的 agent 不该能自己复现另一把钥匙。改之前想清楚。')
            : g.id === 'ask' ? t('点键位改键，按 Backspace 关掉这一条。') : ''}
        >
          {#each scItemsOf(g.id) as item}
            <DRow title={tr(item.label)} sub={item.failure || item.duplicate || item.invalid || !item.enabled ? scSub(item) : ''}
              danger={Boolean(item.failure || item.duplicate)} highlight={fl('sc-' + item.id)}>
              {#snippet trailing()}
                <ShortcutRecorder accelerator={item.accelerator} placeholder={t('已关闭')} onrecord={(accel) => scSet(item.id, accel)} />
              {/snippet}
            </DRow>
          {/each}
        </DGroup>
      {/each}
      <DGroup>
        {#if scError}<DRow title={t('改键没成功')} sub={scError} danger />{/if}
        <DRow title={t('全部恢复默认')}>
          {#snippet trailing()}<DButton size="sm" onclick={scReset}>{t('恢复默认')}</DButton>{/snippet}
        </DRow>
      </DGroup>

    {:else if sec === 'agentapi'}
      <div class="hero">
        <span class="mark">{@html svgOf('agentapi', 1.4)}</span>
        <h2>{t('Agent 接入')}</h2>
        <p>{t('让别的 agent（Claude Code、Codex、脚本等）直接调用这台 bridge：读项目手册、给 Claude 派活、管文件和定时任务，不用开浏览器模拟点击。')}</p>
      </div>
      <AgentKeysSection {fl} />

    {:else if sec === 'devices'}
      <DevicesSection {fl} />

    {:else if sec === 'wallpaper'}
      {#if wpErr}<p class="err sel-text">{wpErr}</p>{/if}
      {#each [['light', t('明亮系统'), LIGHT_IDS, 'wp-light'], ['dark', t('深色系统'), DARK_IDS, 'wp-dark']] as [slot, name, ids, fid] (slot)}
        <DGroup label={name} foot={t('上传时同时选中原图和它的深度图（文件名带 depth），就能开空间壁纸。')}>
          <div class="wpgrid" class:hl-line={fl(fid)}>
            {#each gridOf(ids) as id (id)}
              <div class="wpc" class:sel={wp[slot] === id}>
                <button class="wpbg" style={bgStyle(id)} onclick={() => pick(slot, id)} aria-label={t('选择壁纸')}></button>
                {#if wpIsUpload(id)}<button class="wpx" onclick={() => deleteUpload(id)} title={t('删除')}>{@html svgOf('plus', 2)}</button>{/if}
              </div>
            {/each}
            <button class="wadd" onclick={() => (slot === 'light' ? upInputL : upInputD).click()} title={t('相册上传')}>{@html svgOf('plus', 1.6)}</button>
          </div>
          <!-- 只有带深度图的壁纸（内置默认 / 上传时附了深度图）才有空间壁纸 -->
          {#if wpHasDepth(wp[slot])}
            <DRow title={t('空间壁纸')} highlight={slot === 'light' && fl('spatial')}>
              {#snippet trailing()}<DSwitch checked={spatial[slot].on} onchange={(v) => setSpatialOn(slot, v)} />{/snippet}
            </DRow>
            {#if spatial[slot].on}
              <DRow title={t('景深幅度')}>
                {#snippet trailing()}
                  <span class="sldw"><DSlider value={spatial[slot].amp * 100} min={0} max={100}
                    oninput={(v) => setSpatialAmp(slot, v / 100)} /><i>{Math.round(spatial[slot].amp * 100)}%</i></span>
                {/snippet}
              </DRow>
            {/if}
          {/if}
        </DGroup>
      {/each}
      <input type="file" accept="image/*" multiple hidden bind:this={upInputL} onchange={(e) => onUpload('light', e)} />
      <input type="file" accept="image/*" multiple hidden bind:this={upInputD} onchange={(e) => onUpload('dark', e)} />
      {#if ui.glassMode === 'A'}
        <DGroup label={t('流体壁纸')}>
          <DRow title={tc('settings', '配色')} highlight={fl('flux')}>
            {#snippet trailing()}
              <DSelect options={FLUX_COLORMODES.map((c) => ({ value: c.id, label: c.name }))} value={fluxParams.colormode}
                onchange={(v) => { fluxParams.colormode = v; saveFlux(); }} width="130px" />
            {/snippet}
          </DRow>
          {#each FLUX_SLIDERS as s (s.key)}
            <DRow title={s.label}>
              {#snippet trailing()}
                <span class="sldw">{#if s.pow2}<DSlider value={Math.log2(fluxParams[s.key])} min={Math.log2(s.min)} max={Math.log2(s.max)} step={1}
                  oninput={(v) => { fluxParams[s.key] = 2 ** Math.round(v); saveFlux(); }} />{:else}<DSlider value={fluxParams[s.key]} min={s.min} max={s.max} step={s.step || 1}
                  oninput={(v) => { fluxParams[s.key] = v; saveFlux(); }} />{/if}<i>{s.step ? Number(fluxParams[s.key]).toFixed(s.step < 0.1 ? 2 : 1) : Math.round(fluxParams[s.key])}</i></span>
              {/snippet}
            </DRow>
          {/each}
          <DRow title={t('恢复默认参数')} chevron={false} onclick={resetFlux} />
        </DGroup>
      {/if}

    {:else if sec === 'connect'}
      <DGroup label={t('服务器')}>
        <div class="addr-line" class:hl-line={fl('addr')}>
          <DField bind:value={addrInput} placeholder={getServerBase() || t('同源（当前页面地址）')} width="100%" />
          <DButton variant="primary" disabled={addrBusy} onclick={connectAddr}>{addrBusy ? t('连接中…') : t('连接')}</DButton>
        </div>
        {#if addrErr}<p class="err sel-text">{addrErr}</p>{/if}
        <DRow title={t('当前线路')} highlight={fl('route')}>
          {#snippet trailing()}<span class="state"><i class="dot ok"></i>{ui.connMode === 'lan' ? t('局域网直连') : t('隧道 / 同源')}</span>{/snippet}
        </DRow>
        <!-- 后端跑了多久（登录后才拿得到）：以前放在「公网」组里，没有公网地址时那组只剩这一行、标题对不上 -->
        {#if srvInfo}
          <DRow title={t('后端')}>
            {#snippet trailing()}<span class="state">{t('已运行 {t}', { t: fmtUptime(srvInfo.server?.uptimeSec) })}{srvInfo.server?.node ? ' · Node ' + srvInfo.server.node.replace(/^v/, '') : ''}</span>{/snippet}
          </DRow>
        {/if}
        {#if spCtl}
          <!-- 这一行不走 bridge：服务停着也能在这里把它拉起来、看日志 -->
          <DRow title={t('bridge 服务')} onclick={() => spCtl.open()} highlight={fl('srvproc')}>
            {#snippet trailing()}<span class="state"><i class="dot" class:ok={spState?.health === 'up'} class:warn={spState?.health === 'unresponsive'} class:bad={spState && spState.health !== 'up' && spState.health !== 'unresponsive'}></i>{spLine}</span>{/snippet}
          </DRow>
          {#if spPrefs?.managed && typeof spPrefs.confirmQuit === 'boolean'}
            <DRow title={t('退出前确认')} sub={t('点「退出」先问一句，默认隐藏到托盘、服务端照常运行；关掉后「退出」直接退出并停止本机服务端')} highlight={fl('quitconfirm')}>
              {#snippet trailing()}<DSwitch checked={spPrefs.confirmQuit} onchange={onConfirmQuit} />{/snippet}
            </DRow>
          {/if}
          {#if spPrefs?.managed && typeof spPrefs.keepOnline === 'boolean'}
            <DRow title={t('插电时保持在线')} sub={keepOnlineSub} highlight={fl('keeponline')}>
              {#snippet trailing()}<DSwitch checked={spPrefs.keepOnline} onchange={onKeepOnline} />{/snippet}
            </DRow>
          {/if}
          {#if spPrefs?.managed && ssCtl}
            <!-- 本机服务端：令牌只在壳自己的本地页里显示（网页拿不到它），这里只是入口 -->
            <DRow title={t('本机服务端访问信息')} sub={t('访问令牌、局域网与公网地址')} onclick={() => ssCtl.open('access')} highlight={fl('srvaccess')} />
            <DRow title={t('重新配置本机服务端')} sub={t('工作空间、端口、Claude 账号')} onclick={() => ssCtl.open('edit')} />
          {/if}
        {/if}
        <!-- 网页版控制台整页靠 /api/admin/*：服务停着点进去只会满屏「加载失败」，所以服务不在跑时不摆这一行 -->
        {#if srvAdminOk && (spState ? spState.health === 'up' : true)}
          <DRow title={t('服务端控制台')} onclick={() => { ui.serverAdminOpen = true; }} highlight={fl('srvadmin')} />
        {/if}
      </DGroup>
      <!-- 服务器那头：出门在外用的公网地址（登录后才拿得到；没有公网地址就不出这一组） -->
      {#if srvInfo?.publicOrigin}
        <DGroup label={t('公网')} foot={srvInfo.address?.kind === 'temporary' ? t('临时地址：电脑或服务重启后会换一个。连过的手机 App 会自动跟过去（在线时立即收到，离线时回家连上同一个 Wi-Fi 就会更新）；网页和分享出去的链接要手动改。长期使用建议绑定自己的域名。') : ''}>
          <DRow title={t('公网地址')} sub={srvInfo.publicOrigin.replace(/^https?:\/\//, '')} highlight={fl('public')}>
            {#snippet trailing()}<DButton size="sm" onclick={copyPublic}>{pubCopied ? t('已复制') : t('复制')}</DButton>{/snippet}
          </DRow>
          {#if srvInfo.address?.kind}
            <DRow title={t('地址类型')}>
              {#snippet trailing()}<span class="state">{srvInfo.address.kind === 'temporary' ? t('临时地址（重启会换）') : t('固定地址')}</span>{/snippet}
            </DRow>
          {/if}
        </DGroup>
      {/if}
      <!-- 手机扫码连接（S1-2）：点开才出码（每次出码都是一张 3 分钟的一次性票，别一进页面就挂在屏幕上） -->
      {#if me.kind !== 'none'}
        <DGroup label={t('手机扫码连接')} foot={connectOpen ? '' : t('手机 App 首屏「扫码连接」扫一下就连上这台服务器，并以你现在的身份登录；不用抄地址和令牌。')}>
          {#if connectOpen}
            <ConnectQr via="settings" />
            <DRow title={t('收起二维码')} chevron={false} onclick={() => { connectOpen = false; }} />
          {:else}
            <DRow title={t('显示配对二维码')} chevron={false} onclick={() => { connectOpen = true; }} highlight={fl('pairconnect')} />
          {/if}
        </DGroup>
      {/if}
      <!-- 手机扫码下载 App：指向这台服务器自己的 /download/android（同一次构建的包，版本和服务器对齐） -->
      {#if dlShow}
        <DGroup label={t('手机 App')} foot={t('用手机相机扫码，下载和这台服务器同一版本的安卓 App；装好后打开 App 连这台服务器。')}>
          <div class="dl-app">
            {#if dlQr}<div class="dl-qr" aria-hidden="true">{@html dlQr}</div>{/if}
            <div class="dl-meta">
              <span class="dl-url sel-text">{dlUrl}</span>
              {#if dlUrls.lan && dlUrls.pub}
                <DButton size="sm" onclick={() => { dlWhich = dlPick === 'pub' ? 'lan' : 'pub'; }}>{dlPick === 'pub' ? t('改用局域网地址') : t('改用公网地址')}</DButton>
              {/if}
            </div>
          </div>
        </DGroup>
      {/if}
      <DGroup label={tc('settings', '更新')}>
        <!-- 行本身不可点：动作只在右侧按钮上（行内再放按钮会成按钮套按钮） -->
        <DRow title={t('软件更新')} sub={upState === 'idle' || upState === 'checking' ? stripBrand(verLine) : ''} highlight={fl('update')}>
          {#snippet trailing()}
            {#if upState === 'downloading'}<span class="num">{Math.round(progress * 100)}%</span><span class="ring" style:--p="{Math.round(progress * 360)}deg"></span>
            {:else if upState === 'checking'}<span class="spin"></span><span>{upMsg}</span>
            {:else if upState === 'installable'}<DButton size="sm" variant="primary" onclick={onUpdate}>{upMsg}</DButton>
            {:else if upState === 'waiting'}<span>{upMsg}</span><DButton size="sm" onclick={onCancelWait}>{tc('update', '取消等待')}</DButton><DButton size="sm" variant="danger" onclick={() => installNow('now')}>{t('立即安装（会中断）')}</DButton>
            {:else if upState === 'error'}<DButton size="sm" variant="danger" onclick={onUpdate}>{upMsg}</DButton>
            {:else if upState === 'latest' || upState === 'done'}<span>{upMsg}</span>
            {:else}<DButton size="sm" onclick={onUpdate}>{t('检查更新')}</DButton>{/if}
          {/snippet}
        </DRow>
        {#if hasSilentUpdate()}
          <DRow title={t('自动检查更新')} sub={autoUp ? t('启动时检查，发现新版在后台下载好，装不装由你决定') : ''} highlight={fl('auto-update')}>
            {#snippet trailing()}<DSwitch checked={autoUp} onchange={onAutoUp} />{/snippet}
          </DRow>
        {/if}
        {#if upErr}<p class="err sel-text">{upErr}</p>{/if}
        {#if upNote}<p class="note sel-text">{upNote}</p>{/if}
      </DGroup>

    {:else if sec === 'help'}
      <div class="fb card" class:hl-line={fl('feedback')}>
        <textarea rows="6" placeholder={t('遇到什么问题、想要什么功能…')} bind:value={fbText}></textarea>
        {#if fbAtts.length}
          <div class="fb-atts">
            {#each fbAtts as a (a.name)}
              <span class="fba" class:pending={a.pending}>{a.name}<button onclick={() => { fbAtts = fbAtts.filter((x) => x !== a); }} aria-label={t('移除')}>{@html svgOf('plus', 2)}</button></span>
            {/each}
          </div>
        {/if}
        {#if fbUp?.mode === 'push'}
          <div class="fb-consent">
            <span class="fb-consent-tx"><b>{t('这条也发给 {to}', { to: fbDest.to })}</b>{fbDest.public ? t('勾选后会同时发给 {to}：带文字、所在界面、版本和系统，不带账号名和服务器地址。这是公开发布：内容任何人都能看到，请别写隐私、账号、密钥；图片不会公开发布（只记张数），视频不发。', { to: fbDest.to }) : t('勾选后会同时发给 {to}：带文字、所在界面、版本和系统，不带账号名和服务器地址；图片最多 3 张，原样发出，截图里能看到的开发者也能看到；视频不发。', { to: fbDest.to })}</span>
            <DSwitch bind:checked={fbConsent} />
          </div>
        {/if}
        <div class="fb-acts">
          <DButton variant="ghost" onclick={() => fbFileInput.click()}>{t('添加图片 / 视频')}</DButton>
          <input type="file" accept="image/*,video/*" multiple hidden bind:this={fbFileInput} onchange={onFbFiles} />
          <span class="sp"></span>
          {#if fbDone}<span class="ok">{t('已提交，谢谢！')}</span>{/if}
          {#if fbErr}<span class="err sel-text">{fbErr}</span>{/if}
          <DButton variant="primary" disabled={fbBusy} onclick={submitFeedback}>{fbBusy ? t('提交中…') : t('提交反馈')}</DButton>
        </div>
      </div>
      {#if fbUpNote}<p class="fb-note sel-text">{fbUpNote}</p>{/if}
      {#if fbInboxLine}<p class="fb-note sel-text" class:bad={!!fbUp.lastPullError || fbUp.reason === 'no-relay'}>{fbInboxLine}</p>{/if}
      {#if fbUp?.admin && fbUp.mode !== 'inbox' && !fbUp.reason}
        <DGroup foot={fbUp.pending ? t('还有 {n} 条没发出去，连上后自动补发。', { n: fbUp.pending }) : ''}>
          <DRow title={t('把用户反馈同时发给 {to}', { to: fbDest.to })} sub={fbUpAdminSub + ' ' + t('关掉后，这台服务器上的反馈只留在本机，还没发出去的也一并取消。')} highlight={fl('fbup')}>
            {#snippet trailing()}<DSwitch checked={fbUp.mode === 'push'} disabled={fbUpBusy} onchange={onFbUp} />{/snippet}
          </DRow>
        </DGroup>
      {/if}
    {/if}
    </div>
  </main>

  <!-- 确认 / 表单弹窗：同一个外壳，Esc 与点遮罩都关 -->
  {#if anyModal}
    <div class="dlg-root">
      <button class="dlg-dim" tabindex="-1" aria-label={t('关闭')} onclick={back}></button>
      <div class="dlg" role="dialog" aria-modal="true">
        {#if acctForm}
          <form onsubmit={saveAcctForm}>
            <h3>{acctForm.isNew ? t('添加 Claude 账号') : t('编辑账号')}</h3>
            <p>{t('在目标账号登录状态下运行 claude setup-token，把返回的长期 token 粘进来。')}</p>
            <DField bind:value={acctForm.label} placeholder={t('如：主号 / 备用号')} width="100%" />
            <DField bind:value={acctForm.token} type="password" width="100%"
              placeholder={acctForm.isNew ? 'sk-ant-oat…' : (acctForm.hasToken ? t('留空＝不改，当前 …{tail}', { tail: acctForm.tokenTail || '' }) : t('留空＝用本机登录态'))} />
            {#if acctForm.err}<p class="err">{acctForm.err}</p>{/if}
            <div class="dacts">
              <DButton variant="ghost" onclick={() => { acctForm = null; }}>{t('取消')}</DButton>
              <DButton variant="primary" type="submit" disabled={acctForm.busy}>{acctForm.isNew ? t('添加') : t('保存')}</DButton>
            </div>
          </form>
        {:else if acctDel}
          <h3>{t('删除账号 {name}？', { name: accLabel(acctDel.label) })}</h3>
          <p>{t('只从切换列表移除；若删的是当前账号，会自动切到另一个。')}</p>
          <div class="dacts">
            <DButton variant="ghost" onclick={() => { acctDel = null; }}>{t('取消')}</DButton>
            <DButton variant="danger" onclick={confirmAcctDel}>{t('删除')}</DButton>
          </div>
        {:else if agLast}
          <h3>{t('关闭 {name}？', { name: tr(agLast.label) })}</h3>
          <p>{t('这是最后一个开着的 agent，关掉后所有客户端都没有可用的分页。确定吗？')}</p>
          <div class="dacts">
            <DButton variant="ghost" onclick={() => { agLast = null; }}>{t('取消')}</DButton>
            <DButton variant="danger" onclick={async () => { const x = agLast; agLast = null; await setAgentOn(x, false); }}>{tc('开关', '关闭')}</DButton>
          </div>
        {:else if bypassAsk}
          <h3>{t('允许绕过权限模式？')}</h3>
          <p>{t('跳过所有权限检查，让 Claude 不间断地干活，适合修 lint、生成样板代码这类事。让 Claude 随意执行命令有风险，可能造成数据丢失、系统损坏或数据外泄（例如提示注入攻击）。')}</p>
          <div class="dacts">
            <DButton variant="ghost" onclick={() => { bypassAsk = false; }}>{t('取消')}</DButton>
            <DButton variant="danger" onclick={confirmBypass}>{t('允许')}</DButton>
          </div>
        {:else if logoutAsk}
          <h3>{logoutAsk === 'switch' ? t('切换账号') : t('退出登录？')}</h3>
          <p>{logoutAsk === 'switch' ? t('会先退出当前账号（{name}），再用别的账号登录。', { name: me.user || 'Admin' }) : t('只退出这台设备，其它设备上的登录不受影响。')}</p>
          <div class="dacts">
            <DButton variant="ghost" onclick={() => { logoutAsk = false; }}>{t('取消')}</DButton>
            <DButton variant={logoutAsk === 'switch' ? 'primary' : 'danger'} onclick={doLogout}>{logoutAsk === 'switch' ? t('切换') : t('退出登录')}</DButton>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if provOpen}<ProviderManager onClose={() => (provOpen = false)} />{/if}

<style>
  /* ── v5「墨与象牙」令牌：就地覆盖 --dsk-*（kit 读它们），只在设置页生效 ──
     暗：墨底 #100f0d / 卡 #1a1917 / 象牙字；亮：纸底 #f2f0eb / 卡 #fcfbf8 / 墨字。强调色＝墨（暗色下象牙）。 */
  .sd {
    --dsk-bg: #100f0d; --dsk-bg-raised: #262420;
    --dsk-panel: #1a1917; --dsk-panel-strong: rgba(241, 236, 226, .085);
    --dsk-ink: #f1ece2; --dsk-ink-2: rgba(241, 236, 226, .62); --dsk-ink-3: rgba(241, 236, 226, .4);
    --dsk-line: rgba(241, 236, 226, .07); --dsk-line-strong: rgba(241, 236, 226, .14);
    --dsk-hover: rgba(241, 236, 226, .05); --dsk-active: rgba(241, 236, 226, .085); --dsk-sel: rgba(241, 236, 226, .085);
    --dsk-accent: #ebe5d8; --dsk-accent-hover: #f6f1e6; --dsk-accent-ink: #151412;
    --dsk-ok: #85b78f; --dsk-warn: #d9a441; --dsk-crit: #e2725f;
    --dsk-ctl: rgba(241, 236, 226, .16); --dsk-knob: #f1ece2; --dsk-knob-on: #151412;
    --dsk-sidebar-bg: rgba(22, 21, 19, .62);
    --dsk-focus: 0 0 0 2px rgba(235, 229, 216, .55);
    --sd-tile: rgba(241, 236, 226, .065); --sd-av: linear-gradient(160deg, #3a3631, #211f1b); --sd-av-ink: #efe9dd;
    --sd-dim: rgba(0, 0, 0, .5);
  }
  .sd.light {
    --dsk-bg: #f2f0eb; --dsk-bg-raised: #ffffff;
    --dsk-panel: #fcfbf8; --dsk-panel-strong: #ffffff;
    --dsk-ink: #1d1b18; --dsk-ink-2: rgba(29, 27, 24, .6); --dsk-ink-3: rgba(29, 27, 24, .4);
    --dsk-line: rgba(29, 27, 24, .085); --dsk-line-strong: rgba(29, 27, 24, .16);
    --dsk-hover: rgba(29, 27, 24, .045); --dsk-active: rgba(29, 27, 24, .08); --dsk-sel: rgba(29, 27, 24, .07);
    --dsk-accent: #1d1b18; --dsk-accent-hover: #34302a; --dsk-accent-ink: #f6f3ec;
    --dsk-ok: #4f8a5b; --dsk-warn: #b0741c; --dsk-crit: #c4473b;
    --dsk-ctl: rgba(29, 27, 24, .14); --dsk-knob: #ffffff; --dsk-knob-on: #ffffff;
    --dsk-sidebar-bg: rgba(236, 233, 226, .66);
    --dsk-focus: 0 0 0 2px rgba(29, 27, 24, .35);
    --sd-tile: rgba(29, 27, 24, .05); --sd-av: linear-gradient(160deg, #e8e3d9, #d6cfc1); --sd-av-ink: #3a352d;
    --sd-dim: rgba(24, 21, 17, .26);
  }

  /* macOS 双栏：根透明，磨砂只在侧栏（整页唯一 backdrop）；首行折进标题栏带（--sd-band 由脚本按 WCO 下发） */
  .sd {
    position: fixed; inset: 0; z-index: 60;
    display: grid; grid-template-columns: 232px 1fr;
    color: var(--dsk-ink);
    font-family: var(--dsk-font); font-size: var(--dsk-fs-ui);
    animation: sd-in .2s var(--dsk-ease-out);
    --sd-hd: 34px;
  }
  @keyframes sd-in { from { opacity: 0; transform: scale(.995); } }
  .sd.closing { opacity: 0; transform: scale(.995); transition: opacity .17s ease, transform .17s ease; pointer-events: none; }

  /* —— 侧栏 —— */
  .side {
    display: flex; flex-direction: column; gap: var(--dsk-s3); min-height: 0;
    padding: var(--sd-band) var(--dsk-s3) var(--dsk-s3);
    background: var(--dsk-sidebar-bg);
    -webkit-backdrop-filter: var(--dsk-sidebar-blur); backdrop-filter: var(--dsk-sidebar-blur);
    border-right: 1px solid var(--dsk-line);
  }
  .back {
    display: inline-flex; align-items: center; gap: 7px; align-self: flex-start;
    min-height: var(--sd-hd); padding: 0 10px 0 8px; border-radius: var(--dsk-r-sm);
    color: var(--dsk-ink-2); font-size: var(--dsk-fs-ui); font-weight: 500;
    transition: background var(--dsk-t-fast) var(--dsk-ease), color var(--dsk-t-fast) var(--dsk-ease);
  }
  .back:hover { background: var(--dsk-hover); color: var(--dsk-ink); }
  .srch { position: relative; }
  .srch .si { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--dsk-ink-3); pointer-events: none; }
  .srch input {
    width: 100%; height: var(--dsk-ctl-h); padding: 0 var(--dsk-s2) 0 28px;
    border: none; border-radius: var(--dsk-r-sm);
    background: var(--dsk-hover); box-shadow: inset 0 0 0 1px var(--dsk-line);
    font-family: inherit; font-size: var(--dsk-fs-ui); color: var(--dsk-ink);
    transition: background var(--dsk-t-fast) ease, box-shadow var(--dsk-t-fast) ease;
  }
  .srch input::placeholder { color: var(--dsk-ink-3); }
  .srch input:focus { outline: none; box-shadow: var(--dsk-focus); background: var(--dsk-panel); }

  .acct {
    display: flex; align-items: center; gap: 10px;
    padding: 7px var(--dsk-s2); border-radius: var(--dsk-r-md);
    font-family: inherit; text-align: left; color: var(--dsk-ink);
    transition: background var(--dsk-t-fast) var(--dsk-ease);
  }
  .acct:hover:not(.on) { background: var(--dsk-hover); }
  .acct.on { background: var(--dsk-sel); }
  .atxt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .atxt b { font-size: var(--dsk-fs-ui); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .atxt i { font-style: normal; font-size: var(--dsk-fs-caption); color: var(--dsk-ink-3); }

  /* 头像：墨色渐变 + 象牙衬线字母（与应用图标同材质） */
  .ava {
    width: 32px; height: 32px; border-radius: 50%; flex: none;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--sd-av); color: var(--sd-av-ink); box-shadow: inset 0 0 0 .5px var(--dsk-line-strong);
    font-family: var(--font-brand-serif), Georgia, "Songti SC", serif; font-size: 15px; font-weight: 500;
  }
  .ava.none { background: var(--sd-tile); color: var(--dsk-ink-3); }
  .ava.xl { width: 72px; height: 72px; font-size: 30px; }
  .ava.xl :global(svg) { width: 34px; height: 34px; }

  /* 导航：线稿 / 品牌标 + 标签；选中＝中性底 + 加粗，不再整条强调色 */
  .nav { display: flex; flex-direction: column; gap: var(--dsk-s4); overflow-y: auto; min-height: 0; margin: 0 -2px; padding: 0 2px; }
  .ngrp { display: flex; flex-direction: column; gap: 1px; }
  .nit {
    display: flex; align-items: center; gap: 10px;
    height: 30px; padding: 0 var(--dsk-s2); border-radius: var(--dsk-r-sm);
    font-family: inherit; font-size: var(--dsk-fs-ui); color: var(--dsk-ink-2); text-align: left;
    transition: background var(--dsk-t-fast) var(--dsk-ease), color var(--dsk-t-fast) var(--dsk-ease);
  }
  .nit:hover:not(.on) { background: var(--dsk-hover); color: var(--dsk-ink); }
  .nit.on { background: var(--dsk-sel); color: var(--dsk-ink); font-weight: 600; }
  .nit.off .nl { opacity: .5; }
  .nl { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* 插件市场有更新：只提示的小红点数 */
  .nbadge { margin-left: auto; flex: none; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--dsk-crit); color: #fff;
    font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }
  .nico { width: 18px; height: 18px; flex: none; display: inline-flex; align-items: center; justify-content: center; }
  .nico :global(svg) { width: 17px; height: 17px; display: block; }
  .nico img { width: 15px; height: 15px; object-fit: contain; display: block; }

  .hits { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 0; }
  .hit {
    display: flex; align-items: center; justify-content: space-between; gap: var(--dsk-s2);
    padding: 7px var(--dsk-s2); border-radius: var(--dsk-r-sm);
    font-family: inherit; font-size: var(--dsk-fs-ui); color: var(--dsk-ink); text-align: left;
  }
  .hit:hover { background: var(--dsk-hover); }
  .hit .hs { color: var(--dsk-ink-3); font-size: var(--dsk-fs-caption); flex: none; }
  .ver { margin-top: auto; padding: var(--dsk-s2) var(--dsk-s2) 0; color: var(--dsk-ink-3); font-size: var(--dsk-fs-caption); font-variant-numeric: tabular-nums; }

  /* —— 详情列 —— */
  .det { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--dsk-bg); transition: background-color .24s ease; }
  .dhd {
    position: relative; flex: none; display: flex; align-items: center;
    height: var(--sd-hd); margin-top: var(--sd-band); padding: 0 var(--dsk-s4);
    transition: box-shadow var(--dsk-t-fast) ease;
  }
  .dhd.scrolled { box-shadow: 0 1px 0 var(--dsk-line); }
  .hnav { display: inline-flex; gap: 2px; }
  .hbtn {
    width: 28px; height: 26px; border-radius: var(--dsk-r-xs);
    display: inline-flex; align-items: center; justify-content: center; color: var(--dsk-ink-2);
    transition: background var(--dsk-t-fast) var(--dsk-ease), color var(--dsk-t-fast) var(--dsk-ease);
  }
  .hbtn:hover:not(:disabled) { background: var(--dsk-hover); color: var(--dsk-ink); }
  .hbtn:disabled { color: var(--dsk-ink-3); opacity: .45; cursor: default; }
  /* 有头图的分区（账户 / agent）：标题等滚过头图再出现，不和头图里的大名字重复 */
  .htitle {
    position: absolute; left: 50%; transform: translate(-50%, 3px); opacity: 0;
    font-size: var(--dsk-fs-body); font-weight: 600; letter-spacing: -.01em;
    max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    transition: opacity .16s ease, transform .2s var(--dsk-ease);
  }
  .htitle.on { opacity: 1; transform: translate(-50%, 0); }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: var(--dsk-s4) var(--dsk-s7) 72px; }
  .scroll.plg { display: flex; padding: 0; overflow: hidden; }
  .scroll > .plg-host { flex: 1; min-width: 0; min-height: 0; max-width: none; margin: 0; }   /* 插件面板占满内容区，不受 600px 内容列限制 */
  .scroll > :global(*) { max-width: 600px; margin-left: auto; margin-right: auto; }
  /* 扩展分区是官方「自定义」页的宽版式（两栏卡片网格），放宽内容列 */
  .scroll > :global(.cz) { max-width: 1080px; }
  .scroll :global(section.grp) { margin-bottom: 26px; }
  .scroll :global(.gcard) { border-radius: 12px; box-shadow: inset 0 0 0 1px var(--dsk-line); }
  .scroll :global(.glabel) { font-weight: 500; color: var(--dsk-ink-3); }
  .scroll :global(.drow) { min-height: 42px; padding: 8px 14px; }
  .scroll :global(.drow .t) { font-size: var(--dsk-fs-body); }
  .scroll :global(.gcard .drow + .drow::before) { left: 14px; right: 14px; }
  /* 英文副标题只在英文界面放开换行 */
  :global(html[lang='en']) .scroll :global(.drow .s) { white-space: normal; }

  /* 头图（账户 / agent） */
  .hero { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; margin: var(--dsk-s3) auto 28px; }
  .hero h2 { margin-top: 10px; font-family: var(--font-brand-serif), Georgia, "Songti SC", serif; font-size: 24px; line-height: 30px; font-weight: 500; letter-spacing: -.01em; }
  .hero p { font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); }
  .hero p.warn { color: var(--dsk-warn); }
  .mark { width: 64px; height: 64px; border-radius: 18px; display: flex; align-items: center; justify-content: center;
    background: var(--dsk-panel); color: var(--dsk-ink); box-shadow: inset 0 0 0 1px var(--dsk-line), 0 12px 28px -14px rgba(0, 0, 0, .45); }
  .mark img { width: 34px; height: 34px; object-fit: contain; }
  .mark :global(svg) { width: 32px; height: 32px; }

  /* 额度条 */
  .usage { display: flex; flex-direction: column; gap: var(--dsk-s3); padding: 14px; }
  .u { display: flex; align-items: center; gap: var(--dsk-s3); }
  .ul { flex: none; min-width: 84px; white-space: nowrap; font-size: var(--dsk-fs-body); }
  .ubar { flex: 1; height: 4px; border-radius: var(--dsk-r-full); background: var(--dsk-ctl); overflow: hidden; }
  .ubar i { display: block; height: 100%; border-radius: var(--dsk-r-full); background: var(--dsk-accent); min-width: 2px; transition: width var(--dsk-t-slow) var(--dsk-ease); }
  .ubar i.hot { background: var(--dsk-crit); }
  .uv { flex: none; width: 42px; text-align: right; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-2); font-variant-numeric: tabular-nums; }

  .num { color: var(--dsk-ink-3); font-variant-numeric: tabular-nums; }
  .state { display: inline-flex; align-items: center; gap: 7px; color: var(--dsk-ink-2); font-size: var(--dsk-fs-sm); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsk-ink-3); flex: none; }
  .dot.ok { background: var(--dsk-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsk-ok) 18%, transparent); }
  .dot.warn { background: var(--dsk-warn); }
  .dot.bad { background: var(--dsk-crit); }
  .accent { color: var(--dsk-ink); font-weight: 600; }
  .bad { color: var(--dsk-crit); }
  .note { margin: 0 14px; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); }

  /* 小图标钮（刷新 / 上下移 / 编辑 / 删除） */
  .ico-btn { width: 26px; height: 26px; padding: 4px; border-radius: 7px; color: var(--dsk-ink-3); display: inline-flex; align-items: center; justify-content: center;
    transition: background var(--dsk-t-fast) ease, color var(--dsk-t-fast) ease; }
  .ico-btn :global(svg) { width: 17px; height: 17px; display: block; }
  .ico-btn:hover:not(:disabled) { background: var(--dsk-hover); color: var(--dsk-ink); }
  .ico-btn.danger:hover:not(:disabled) { color: var(--dsk-crit); }
  .ico-btn:disabled { opacity: .3; cursor: default; }
  .ico-btn.busy :global(svg) { animation: sd-rot .9s linear infinite; }
  @keyframes sd-rot { to { transform: rotate(360deg); } }
  .ghd { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--dsk-s2); padding: 0 6px 0 var(--dsk-s3); }
  .ghd h3 { font-size: var(--dsk-fs-sm); font-weight: 500; color: var(--dsk-ink-3); }

  /* Claude 设置行（crow 片段）：与 DRow 同尺寸；标题旁改动点 / 本机胶囊，尾部「恢复默认」+ 控件；依赖项缩进 */
  .cr { display: flex; align-items: center; gap: var(--dsk-s3); width: 100%; position: relative; font-family: var(--dsk-font); color: var(--dsk-ink); }
  .cr.ind { padding-left: 34px; }
  .cr.dsp { flex-wrap: wrap; align-items: flex-start; row-gap: 8px; padding-bottom: 12px; }
  .dsp-box { position: relative; flex: 1 0 100%; }
  .dsp-box textarea { display: block; width: 100%; box-sizing: border-box; min-height: 92px; max-height: 260px; resize: vertical;
    padding: 8px 10px 22px; border: none; border-radius: var(--dsk-r-sm); background: var(--dsk-panel); box-shadow: 0 0 0 1px var(--dsk-line);
    font-family: var(--dsk-font); font-size: var(--dsk-fs-ui); line-height: 1.5; color: var(--dsk-ink);
    transition: box-shadow var(--dsk-t-fast) var(--dsk-ease), background var(--dsk-t-fast) var(--dsk-ease); }
  .dsp-box textarea::placeholder { color: var(--dsk-ink-3); }
  .dsp-box textarea:hover:not(:focus) { background: var(--dsk-panel-strong); }
  .dsp-box textarea:focus { outline: none; box-shadow: var(--dsk-focus); background: var(--dsk-panel-strong); }
  .dsp-n { position: absolute; right: 9px; bottom: 5px; font-size: 11px; color: var(--dsk-ink-3); font-variant-numeric: tabular-nums; pointer-events: none; }
  .dsp-ok { font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); }
  .scroll :global(.gcard .drow.cr.ind::before) { left: 34px; }
  .cr-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .cr-t { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: var(--dsk-fs-body); line-height: 1.35; }
  .cr-s { font-size: var(--dsk-fs-sm); line-height: 1.35; color: var(--dsk-ink-3); }
  .cr-s.bad { color: var(--dsk-crit); }
  .cr-tr { flex: none; display: inline-flex; align-items: center; gap: var(--dsk-s2); color: var(--dsk-ink-2); font-size: var(--dsk-fs-ui); }
  .chg { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsk-accent); }
  .cr-reset { padding: 2px 7px; border-radius: 6px; font-family: inherit; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3);
    transition: background var(--dsk-t-fast) ease, color var(--dsk-t-fast) ease; }
  .cr-reset:hover { background: var(--dsk-hover); color: var(--dsk-ink); }
  .cr.hl { animation: cr-flash 1.5s var(--dsk-ease) 1; }
  @keyframes cr-flash { 0%, 70% { background: var(--dsk-sel); } 100% { background: transparent; } }

  /* 订阅号池：一号一行，名字 + 标签 + 三根迷你用量条；动作悬停才出现 */
  .pool { display: flex; flex-direction: column; }
  .prow { display: flex; align-items: center; gap: var(--dsk-s3); position: relative; }
  .pmain { flex: 1; min-width: 0; }
  .pname { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .pname b { font-size: var(--dsk-fs-body); font-weight: 500; }
  .pill { padding: 0 6px; border-radius: 5px; font-size: 10.5px; line-height: 17px; font-weight: 600; letter-spacing: .3px; color: var(--dsk-ink-2); box-shadow: inset 0 0 0 1px var(--dsk-line-strong); }
  .pill.red { color: var(--dsk-crit); box-shadow: none; background: color-mix(in srgb, var(--dsk-crit) 13%, transparent); }
  .cur { display: inline-flex; align-items: center; gap: 5px; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-2); }
  .cur::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--dsk-ok); }
  .mini { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 8px; max-width: 360px; }
  .mna { grid-column: 1 / -1; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mna.bad { color: var(--dsk-crit); white-space: normal; }
  .mm { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .mh { display: flex; justify-content: space-between; gap: 4px; font-size: var(--dsk-fs-caption); color: var(--dsk-ink-3); }
  .mh b { font-weight: 600; color: var(--dsk-ink); font-variant-numeric: tabular-nums; }
  .mh b.amber { color: var(--dsk-warn); } .mh b.red { color: var(--dsk-crit); }
  .mr { min-height: 1.4em; font-size: var(--dsk-fs-caption); color: var(--dsk-ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mb { display: block; height: 3px; border-radius: 2px; background: var(--dsk-ctl); overflow: hidden; }
  .mb i { display: block; height: 100%; border-radius: 2px; background: var(--dsk-ink-2); transition: width .4s var(--dsk-ease); }
  .mb i.amber { background: var(--dsk-warn); } .mb i.red { background: var(--dsk-crit); }
  .pacts { flex: none; display: flex; align-items: center; gap: 6px; }
  .tools { display: inline-flex; gap: 2px; opacity: 0; transition: opacity var(--dsk-t-fast) ease; }
  .prow:hover .tools, .prow:focus-within .tools { opacity: 1; }
  .addrow { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; font-family: inherit; font-size: var(--dsk-fs-body); color: var(--dsk-ink-2); position: relative;
    transition: background var(--dsk-t-fast) ease, color var(--dsk-t-fast) ease; }
  .addrow :global(svg) { width: 16px; height: 16px; }
  .addrow:hover { background: var(--dsk-hover); color: var(--dsk-ink); }

  /* 外观：三张小样卡 */
  .themes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 26px; padding: 16px; border-radius: 12px; background: var(--dsk-panel); box-shadow: inset 0 0 0 1px var(--dsk-line); }
  .tp { display: flex; flex-direction: column; align-items: center; gap: 8px; font-family: inherit; color: var(--dsk-ink-2); }
  .tp-art { position: relative; display: flex; width: 100%; aspect-ratio: 16 / 10; border-radius: 9px; overflow: hidden;
    box-shadow: inset 0 0 0 1px rgba(128, 120, 108, .28); transition: box-shadow .18s ease, transform .18s var(--dsk-ease); }
  .tp:hover .tp-art { transform: translateY(-1px); }
  .tp.on .tp-art { box-shadow: 0 0 0 2px var(--dsk-panel), 0 0 0 3.5px var(--dsk-accent); }
  .half { flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 12px 10px; }
  .half.light { background: #f2f0eb; } .half.dark { background: #100f0d; }
  .half i { display: block; height: 14%; border-radius: 3px; }
  .half i:first-child { width: 48%; height: 7%; margin-bottom: 4px; }
  .half.light i { background: #fcfbf8; box-shadow: inset 0 0 0 .5px rgba(29, 27, 24, .12); } .half.light i:first-child { background: #1d1b18; box-shadow: none; }
  .half.dark i { background: #1f1e1b; } .half.dark i:first-child { background: #f1ece2; }
  .tp-name { font-size: var(--dsk-fs-ui); }
  .tp.on .tp-name { color: var(--dsk-ink); font-weight: 600; }

  /* 登录：窄卡 + 满宽墨色主按钮 + 下方文字切换 */
  .lwrap { max-width: 360px !important; }
  .lform { display: flex; flex-direction: column; gap: var(--dsk-s2); padding: 14px; }
  .lform.card { border-radius: 12px; background: var(--dsk-panel); box-shadow: inset 0 0 0 1px var(--dsk-line); }
  .lform :global(.fld) { height: 34px; }
  .go { height: 36px; margin-top: 4px; border-radius: 9px; background: var(--dsk-accent); color: var(--dsk-accent-ink); font-family: inherit; font-size: var(--dsk-fs-body); font-weight: 600;
    transition: background var(--dsk-t-fast) ease, transform var(--dsk-t-fast) ease; }
  .go:hover:not(:disabled) { background: var(--dsk-accent-hover); }
  .go:active:not(:disabled) { transform: scale(.985); }
  .go:disabled { opacity: .5; cursor: default; }
  .alts { display: flex; justify-content: center; gap: 18px; margin-top: 14px; }
  .alts button { font-family: inherit; font-size: var(--dsk-fs-ui); color: var(--dsk-ink-2); }
  .alts button:hover { color: var(--dsk-ink); text-decoration: underline; text-underline-offset: 3px; }
  .lacts { display: flex; align-items: center; gap: var(--dsk-s2); margin-top: var(--dsk-s1); }
  .sp { flex: 1; }
  .qrpane { display: flex; flex-direction: column; gap: var(--dsk-s3); align-items: center; }
  .qrbox { position: relative; width: 208px; height: 208px; padding: 12px; border-radius: 14px; background: #fff; box-shadow: 0 0 0 1px var(--dsk-line); }
  .qrbox :global(svg) { display: block; width: 100%; height: 100%; }
  .qrbox.dim :global(svg) { opacity: .1; }
  .qrov { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px; border: 0; border-radius: inherit; background: transparent; color: #15171c; font: inherit; font-size: var(--dsk-fs-ui); font-weight: 600; cursor: pointer; }
  .qrov:disabled { cursor: default; color: #5a5e68; }

  .numf { display: inline-flex; align-items: center; gap: 8px; }
  .numf i { font-style: normal; color: var(--dsk-ink-3); font-size: var(--dsk-fs-sm); min-width: 24px; }
  .numf :global(.fld) { text-align: right; font-variant-numeric: tabular-nums; }
  .sldw { display: inline-flex; align-items: center; gap: var(--dsk-s2); width: 230px; }
  .sldw :global(input) { flex: 1; }
  .sldw i { font-style: normal; color: var(--dsk-ink-3); font-size: var(--dsk-fs-sm); width: 38px; text-align: right; flex: none; font-variant-numeric: tabular-nums; }
  .ring { width: 16px; height: 16px; border-radius: 50%; flex: none;
    background: conic-gradient(var(--dsk-accent) var(--p, 0deg), var(--dsk-ctl) 0);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px)); mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px)); }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 1.8px solid var(--dsk-ctl); border-top-color: var(--dsk-ink-2); animation: sd-rot .8s linear infinite; }

  /* 壁纸网格：横向比例缩略图；选中＝强调色双环；删除钮是 × 线稿，悬停才出现 */
  .wpgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 10px; padding: 14px; }
  .wpc { position: relative; }
  .wpbg { display: block; width: 100%; aspect-ratio: 16 / 10; border-radius: 9px; background: var(--dsk-panel-strong); box-shadow: inset 0 0 0 1px var(--dsk-line);
    transition: transform var(--dsk-t-fast) var(--dsk-ease), box-shadow var(--dsk-t-fast) var(--dsk-ease); }
  .wpc:hover .wpbg { transform: translateY(-1px); }
  .wpc.sel .wpbg { box-shadow: 0 0 0 2px var(--dsk-panel), 0 0 0 3.5px var(--dsk-accent); }
  .wpx { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; padding: 4px; border-radius: 50%;
    background: rgba(16, 15, 13, .66); color: #f1ece2; opacity: 0; transition: opacity var(--dsk-t-fast) ease, background var(--dsk-t-fast) ease; }
  .wpx :global(svg) { width: 14px; height: 14px; transform: rotate(45deg); display: block; }
  .wpx:hover { background: var(--dsk-crit); }
  .wpc:hover .wpx { opacity: 1; }
  .wadd { aspect-ratio: 16 / 10; border-radius: 9px; color: var(--dsk-ink-3); display: flex; align-items: center; justify-content: center;
    box-shadow: inset 0 0 0 1px var(--dsk-line-strong); transition: background var(--dsk-t-fast) ease, color var(--dsk-t-fast) ease; }
  .wadd :global(svg) { width: 20px; height: 20px; }
  .wadd:hover { background: var(--dsk-hover); color: var(--dsk-ink); }

  .addr-line { display: flex; gap: var(--dsk-s2); padding: 12px 14px; align-items: center; }
  .addr-line :global(input) { flex: 1; }
  /* 手机扫码下载 App：码放白底方块里（深色主题下也扫得出），右边是地址与切换 */
  .dl-app { display: flex; gap: 16px; padding: 14px; align-items: center; }
  .dl-qr { flex: none; width: 132px; height: 132px; padding: 10px; border-radius: var(--dsk-r-md); background: #fff; box-sizing: border-box; }
  .dl-qr :global(svg) { display: block; width: 100%; height: 100%; }
  .dl-meta { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: var(--dsk-s2); }
  .dl-url { font-size: var(--dsk-fs-sm); color: var(--dsk-ink-2); word-break: break-all; }
  .err { color: var(--dsk-crit); font-size: var(--dsk-fs-sm); margin: var(--dsk-s2) 14px; }
  .ok { color: var(--dsk-ok); font-size: var(--dsk-fs-sm); }
  .hl-line { animation: line-flash 1.5s var(--dsk-ease) 1; border-radius: var(--dsk-r-md); }
  @keyframes line-flash { 0%, 70% { background: var(--dsk-sel); } 100% { background: transparent; } }

  /* 反馈：整张卡就是一张信纸 */
  .fb { display: flex; flex-direction: column; gap: var(--dsk-s3); padding: 14px; }
  .fb.card { border-radius: 12px; background: var(--dsk-panel); box-shadow: inset 0 0 0 1px var(--dsk-line); }
  .fb textarea { width: 100%; resize: vertical; min-height: 140px; padding: 4px 2px; border: none; background: transparent;
    font-family: inherit; font-size: var(--dsk-fs-body); line-height: 1.65; color: var(--dsk-ink); }
  .fb textarea::placeholder { color: var(--dsk-ink-3); }
  .fb textarea:focus { outline: none; }
  .fb-atts { display: flex; flex-wrap: wrap; gap: var(--dsk-s2); }
  .fba { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 9px; border-radius: var(--dsk-r-full); background: var(--dsk-hover);
    font-size: var(--dsk-fs-sm); color: var(--dsk-ink-2); box-shadow: inset 0 0 0 1px var(--dsk-line); }
  .fba.pending { opacity: .55; }
  .fba button { width: 18px; height: 18px; padding: 3px; color: var(--dsk-ink-3); }
  .fba button :global(svg) { width: 12px; height: 12px; transform: rotate(45deg); display: block; }
  .fba button:hover { color: var(--dsk-crit); }
  /* 每条反馈单独问一次「发不发给开发者」（默认不勾），说明就写在开关旁边 */
  .fb-consent { display: flex; align-items: center; gap: var(--dsk-s3); padding-top: var(--dsk-s2); border-top: 1px solid var(--dsk-line); }
  .fb-consent-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--dsk-fs-sm); line-height: 1.5; color: var(--dsk-ink-3); }
  .fb-consent-tx b { font-weight: 500; color: var(--dsk-ink); }
  .fb-acts { display: flex; align-items: center; gap: var(--dsk-s2); flex-wrap: wrap; padding-top: var(--dsk-s2); border-top: 1px solid var(--dsk-line); }
  /* 只设上下边距：左右要留给 .scroll > * 的居中 auto */
  .fb-note { margin-top: 10px; margin-bottom: 18px; padding: 0 14px; font-size: var(--dsk-fs-sm); line-height: 1.55; color: var(--dsk-ink-3); }
  .fb-note.bad { color: var(--dsk-crit); }
  .qv { font-size: var(--dsk-fs-ui); color: var(--dsk-ink-2); font-variant-numeric: tabular-nums; }
  .qv.hot { color: var(--dsk-crit); }

  /* 弹窗：居中小卡（不做 backdrop——整页唯一 backdrop 留给侧栏） */
  .dlg-root { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; padding-left: 232px; }   /* 对齐内容列中心 */
  .dlg-root > .dlg-dim { left: 0; }
  .dlg-dim { position: absolute; inset: 0; background: var(--sd-dim); animation: dlg-fade .16s ease both; cursor: default; }
  .dlg { position: relative; width: min(380px, calc(100% - 48px)); padding: 20px; border-radius: 14px; background: var(--dsk-bg-raised); color: var(--dsk-ink);
    box-shadow: 0 0 0 1px var(--dsk-line-strong), 0 24px 60px rgba(0, 0, 0, .35); animation: dlg-in .2s var(--dsk-ease-out) both; }
  .dlg form { display: flex; flex-direction: column; gap: var(--dsk-s2); }
  .dlg h3 { font-size: var(--dsk-fs-md); font-weight: 600; margin-bottom: 6px; }
  .dlg p { font-size: var(--dsk-fs-ui); line-height: 1.55; color: var(--dsk-ink-2); margin-bottom: 10px; }
  .dlg p.err { color: var(--dsk-crit); margin: 0; }
  .dacts { display: flex; justify-content: flex-end; gap: var(--dsk-s2); margin-top: 10px; }
  @keyframes dlg-fade { from { opacity: 0; } }
  @keyframes dlg-in { from { opacity: 0; transform: translateY(6px) scale(.985); } }
</style>
