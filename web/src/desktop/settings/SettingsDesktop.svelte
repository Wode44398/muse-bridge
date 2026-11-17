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
    ui, me, applyMe, rootScreen, pluginOn,
  } from '../../lib/state.svelte.js';
  import { untrack, tick } from 'svelte';
  import { ags, agentById, setAgentOn, accLabel, PLAN_CHOICES } from '../../lib/agentSettings.svelte.js';
  import ClaudeResets from '../../components/ClaudeResets.svelte';   // 号池「重置卡」弹窗（与手机设置的账号页共用）
  import { SI, agentMark } from '../../lib/settingsIcons.js';
  import { registerCloser } from '../../lib/nav.js';
  import { hasSilentUpdate } from '../../lib/appUpdate.js';
  import { wcoActive, wcoHeight } from '../chrome/wco.svelte.js';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import DSegmented from '../kit/DSegmented.svelte';
  import '../kit/DSelect.svelte';
  import '../kit/DSlider.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import './ShortcutRecorder.svelte';
  import DevicesSection from './DevicesSection.svelte';
  import AgentKeysSection from './AgentKeysSection.svelte';
  import './DimensioSection.svelte';   // 设置 › dimensio（数据面 lib/dimensioSettings.svelte.js，与手机共用）
  import { prefLabel, prefDesc, visiblePrefItems, dimReady } from '../../lib/dimensioSettings.svelte.js';
  import './AdminAccessSection.svelte';
  import './NotifySection.svelte';   // 设置 › 通用 › 通知（会话消息通知，数据面 lib/notices.svelte.js）
  // Claude Code 运行组件的下载进度 / 失败重试（安装包不再内嵌，首启服务端去拿；就绪时不显示），与手机设置共用
  import '../../components/ClaudeCliStatus.svelte';
  // 设置 › Media Studio 的正文归 studio 扩展（components/studio/settings/），只经懒加载入口取，不许静态 import（2026-11-04）
  import { loadPage } from '../../modules/pages.js';
  import { serverOnThisMachine } from '../../lib/nativeDesktop.js';
  import Customize from '../../components/ext/Customize.svelte';
  import PluginFrame from '../../components/ext/PluginFrame.svelte';
  import { pluginPanels, watchPluginPanels, panelTitle } from '../../lib/pluginPanels.svelte.js';
  import '../../components/pairing/ConnectQr.svelte';
  import { t, tc, tr } from '../../lib/i18n.js';
  // 上面这几处只 import 不用名字的（DSelect、DimensioSection、ConnectQr……）现在由下面的分区组件用；拆分前它们都由外壳直接引入、
  // 样式排在外壳之前。先在这里引一次把次序定住，再引 scrollColumn.css（见那个文件开头），最后才是新拆出的分区组件。
  import './scrollColumn.css';

  import { settingsNav } from './settingsNav.svelte.js';
  import { extensionsNav } from '../../lib/extensionsNav.svelte.js';
  // 模型中心（2026-11-10 起是设置里的一个分区 'model-hub'，正文 components/modelhub/HubHome 懒加载）：管理员看 hub（/api/model-hub 总览），
  // 能自定义 API 的成员看 cp（自己的 Claude 服务）；添加 / 服务详情这类浮层挂在 App 根上（hubUi.sheet），外壳只负责给它让 Esc
  import { hub, hubUi, hubSummaryText, closeHubSheet } from '../../lib/modelHub.svelte.js';
  import { visible } from '../../lib/claudeSettingsView.js';
  import { goto } from '../../lib/pageMorph.js';
  import { studioStatus } from '../../lib/settings/common.js';
  import { createVersionLine } from '../../lib/settings/common.svelte.js';
  // 各分区：控制器（状态与动作，外壳按原来的先后创建）与分区组件（只画），都在本目录
  import { provideDesk, PERSON } from './ctx.js';
  import { createDeskAgents } from './agents.svelte.js';
  import { createDeskAccount } from './account.svelte.js';
  import { createDeskGeneral, createDeskClaudePrefs, createDeskShortcuts, createDeskWallpaper } from './prefs.svelte.js';
  import { createDeskDispatch } from './dispatch.svelte.js';
  import { createDeskConnect } from './connect.svelte.js';
  import { createDeskFeedback } from './feedback.svelte.js';
  import AccountSection from './AccountSection.svelte';
  import AgentSection from './AgentSection.svelte';
  import PrefsSection from './PrefsSection.svelte';
  import ConnectSection from './ConnectSection.svelte';
  import HelpSection from './HelpSection.svelte';

  // ═══ 分区导航 ═══（外部直达 settingsNav.sec 优先；dev ?dsec=xxx 供 headless 逐区截图，
  // ?dme=admin|user|pro|none 预置登录态供账户区截图）
  // 两套外壳共用的分区名（lib/settingsNav 的 openSettings）映射到这里的分区。
  // 「关于与更新」落在「连接与更新」（版本、检查更新都在那一页），反馈落在「反馈」。
  // Gemini 设置分区 11-04 删了（Gemini 对话下线），指向它的老入口一并落到 Media Studio
  // 模型中心的老名字（独立面板时代的 cproviders、口头的 models / providers）都落到 'model-hub'
  const SEC_ALIAS = { agents: 'ag-claude', claude: 'ag-claude', connection: 'connect', about: 'connect', feedback: 'help', localpc: 'devices', 'agent-api': 'agentapi',
    'ag-studio': 'studio', media: 'studio', gemini: 'studio', 'ag-gemini': 'studio', vertex: 'studio',
    modelhub: 'model-hub', models: 'model-hub', providers: 'model-hub', cproviders: 'model-hub',
    dispatch: 'ag-claude#dispatch', 'cl-dispatch': 'ag-claude#dispatch', 'dm-dispatch': 'ag-dimensio#dispatch', 'dimensio-dispatch': 'ag-dimensio#dispatch' };
  // 单页模式（只开着一个 agent、没有主页）也用这一套（2026-10-21 起，原 claude.ai 风那套下线）：
  // 壁纸在那里没意义，藏掉；左上角也不叫「主页」。
  const single = $derived(rootScreen() !== 'home');
  const sec0 = settingsNav.sec || (import.meta.env.DEV && new URLSearchParams(location.search).get('dsec')) || 'general';
  // 位置 = 分区，或「分区#子页」：Claude 与 dimensio 分区里有就地展开的子页（clSub，眼下只有 'dispatch' = 子 agent 调用策略，两边各一份）。
  // 子页不另起 sec：侧栏高亮、搜索过滤、「分区被收走就回通用」都按 sec 判，子页只是这个分区正文的另一副样子
  const loc0 = SEC_ALIAS[sec0] || sec0;
  let sec = $state(loc0.split('#')[0]);
  let clSub = $state(loc0.split('#')[1] || '');
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
  const dark = $derived(ui.theme !== 'light');
  const markSrc = (id) => agentMark(id, dark);
  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  // —— 外壳的设置上下文：分区组件从这里取当前分区、导航、搜索闪烁、明暗、桌面壳的桥和各控制器 ——
  const D = {
    get sec() { return sec; }, get clSub() { return clSub; }, navigate, subUp, get fl() { return fl; }, get dark() { return dark; }, get single() { return single; }, markSrc,
    get SEC_NAME() { return SEC_NAME; }, get SEC_TITLE() { return SEC_TITLE; }, openExtType, openRoutinesPage,
    agCtl, scCtl, asCtl, spCtl, ssCtl, get verLine() { return ver.line; },
  };
  provideDesk(D);
  D.ag = createDeskAgents(D);
  // 弹窗总闸：号池的添加 / 编辑 / 删除 / 重置卡、关最后一个 agent、退出登录、允许绕过权限模式（Claude 页「安全」组，打开前确认）
  const anyModal = $derived(!!D.ag.acctForm || !!D.ag.acctDel || !!D.ag.acctResets || !!D.ag.agLast || D.acc.logoutAsk || D.clp.bypassAsk);

  // ═══ 侧栏导航：线稿图标（ico）或品牌标（brand），没有色块 ═══
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
      ...D.ag.agentRows.map((a) => ({ key: a.id === 'studio' ? 'studio' : 'ag-' + a.id, label: tr(a.label), brand: a.id, off: !a.local && !a.enabled })),
      // 模型中心紧跟各 agent：几个 agent 的模型都从这里来
      ...(D.ag.mhOn ? [{ key: 'model-hub', label: t('模型中心'), ico: 'modelhub' }] : []),
      ...((me.kind === 'admin' || me.kind === 'user') && pluginOn('agent-api') ? [{ key: 'agentapi', label: t('Agent 接入'), ico: 'agentapi' }] : []),
    ],
    [
      ...(D.ag.extOk ? [{ key: 'extensions', label: t('扩展'), ico: 'extensions', badge: me.pluginUpdates }] : []),
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
  const SEC_NAME = $derived(sec === 'account' ? t('账户')
    : sec === 'model-hub' ? t('模型中心')   // 直达时侧栏这一项可能还没出来（数据在路上），标题别先闪成「设置」
    : (NAV_GROUPS.flat().find((n) => n.key === sec)?.label || t('设置')));
  // 工具栏标题：在子页里是子页的名字（头图 / 返回头上仍写分区名 SEC_NAME）
  const SEC_TITLE = $derived(D.dsp.subOn ? t('子 agent 调用策略') : SEC_NAME);

  // ═══ 导航历史（macOS 系统设置的 ‹ › 操作逻辑）═══
  // 历史里记的是位置（分区，或「分区#子页」）：进子页也算一步，工具栏 ‹ 从子页退回分区、› 再进去
  const locOf = (s, sub) => (sub ? s + '#' + sub : s);
  function setLoc(k) { const i = k.indexOf('#'); sec = i < 0 ? k : k.slice(0, i); clSub = i < 0 ? '' : k.slice(i + 1); }
  let hist = $state([loc0]);
  let hi = $state(0);
  // 换位置都经这里：人在子页、正文有没保存的改动时先由它问一句（D.dsp.dpLeave），答应了才走
  function moveTo(i, list = hist) { D.dsp.dpLeave(() => { hist = list; hi = i; setLoc(list[i]); }); }
  function navigate(k) { if (k !== locOf(sec, clSub)) moveTo(hi + 1, [...hist.slice(0, hi + 1), k]); }
  function goBack() { if (hi > 0) moveTo(hi - 1); }
  function goFwd() { if (hi < hist.length - 1) moveTo(hi + 1); }
  // 子页 → 回它所在的分区：上一步历史正好是这个分区就按「后退」走（› 还能再进来），搜索 / 外部直达进来的则推一条新的
  function subUp() { if (hi > 0 && hist[hi - 1] === sec) goBack(); else navigate(sec); }
  // 开着时外部又直达某分区（openSettings('devices') 等）：直接换到那一页，读完即清（同 iOS 那套 Settings.svelte）。
  // 以前只在打开时消费一次：开着时写进来的 sec 不跳也不清，之后从直接置 ui.settingsOpen 的入口打开会跳到这个过时的分区
  $effect(() => {
    const s = settingsNav.sec;
    if (!s) return;
    untrack(() => { settingsNav.sec = null; navigate(SEC_ALIAS[s] || s); });
  });

  // ═══ 设置搜索：扁平索引 → 过滤 → 跳区 + 行闪烁 ═══
  const INDEX = $derived([
    // 搜索关键词（keys）也过 t()：英文界面换成英文关键词表，中英各自能搜到
    { sec: 'account', id: 'acct', label: t('账户'), keys: t('登录 注册 令牌 退出 用户 account') },
    { sec: 'account', id: 'usage', label: t('订阅额度'), keys: t('用量 5小时 每周 quota') },
    { sec: 'account', id: 'admin-access', label: t('管理员可见性'), keys: t('管理员 隐私 访问记录 查看 代聊 电脑') },   // 只有成员看得到（AdminAccessSection）
    { sec: 'general', id: 'lang', label: t('语言'), keys: t('界面语言 中文 英文 English language i18n') },
    { sec: 'general', id: 'notify', label: t('通知'), keys: t('任务完成 提醒 notification') },
    { sec: 'general', id: 'notify-sound', label: t('通知声音'), keys: t('铃声 提示音 声音 sound ringtone') },
    { sec: 'general', id: 'notify-banner', label: t('通知横幅'), keys: t('横幅 弹窗 banner') },
    { sec: 'general', id: 'notify-preview', label: t('通知显示内容详情'), keys: t('预览 详情 隐私 preview') },
    { sec: 'general', id: 'autostart', label: t('开机自动启动'), keys: t('自启 静默 托盘 后台 startup login') },
    { sec: 'appearance', id: 'theme', label: t('外观'), keys: t('深色 浅色 自动 主题 跟随系统明暗') },
    { sec: 'appearance', id: 'noanim', label: t('转场动画'), keys: t('入场 动效 禁用') },
    { sec: 'general', id: 'fullres', label: t('原图加载'), keys: t('画质 相册 流量') },
    { sec: 'ag-claude', id: 'suggest', label: t('输入建议'), keys: t('提示词 预测 下一句 Tab 补全') },
    { sec: 'ag-claude', id: 'thinkmark', label: t('思考动画'), keys: t('菊花 星标 动画 Claude Code 经典 加载') },
    // Claude 设置（注册表项；key 用来按身份过滤：管理员项 / shell 项别人搜不到）。keys 带官方英文词
    { sec: 'ag-claude', id: 'climit', key: 'autoContinueOnLimit', label: t('限额重置后自动继续'), keys: t('限额 续跑 auto-continue usage limit') },
    { sec: 'ag-claude', id: 'crestart', key: 'autoResumeOnRestart', label: t('自动继续被中断的对话'), keys: t('重启 崩溃 中断 续跑 自动继续 restart crash resume interrupted') },
    { sec: 'ag-claude', id: 'cdef-perm', key: 'permissionMode', label: t('权限模式'), keys: t('手动 接受编辑 计划 自动 permission mode') },
    { sec: 'ag-claude', id: 'cdef-style', key: 'outputStyle', label: t('输出风格'), keys: t('简洁 讲解 学习 主动 output style concise') },
    { sec: 'ag-claude', id: 'cviz', key: 'inlineVisualizations', label: t('对话内交互图表'), keys: t('图表 示意图 inline visualizations') },
    { sec: 'ag-claude', id: 'cwf', key: 'enableWorkflows', label: t('动态工作流'), keys: t('工作流 并行 Ultracode dynamic workflows') },
    // 子 agent 调用策略：Claude 分区里的就地子页（sub），点了直达子页
    { sec: 'ag-claude', sub: 'dispatch', id: 'cdispatch', label: t('子 agent 调用策略'), keys: t('子 agent 模型 推理强度 effort 性价比 图谱 判定线 策略 档位 工作流 Ultracode 新会话 subagent dispatch policy') },
    { sec: 'ag-claude', id: 'cflag', key: 'switchModelsOnFlag', label: t('消息被拦时自动换模型'), keys: t('安全栅门 拒答 暂停 switch models flagged') },
    { sec: 'ag-claude', id: 'cplan', key: 'planClearContext', label: t('批准计划时可清空上下文'), keys: t('计划 清空上下文 plan clear context') },
    { sec: 'ag-claude', id: 'cqto', key: 'questionTimeout', label: t('Claude 提问无人回答时'), keys: t('提问 超时 question timeout') },
    { sec: 'ag-claude', id: 'clang', key: 'replyLanguage', label: t('回复语言'), keys: t('语言 中文 英文 language') },
    { sec: 'ag-claude', id: 'ccache', key: 'cacheExpiry', label: t('提示缓存快过期时'), keys: t('提示缓存 缓存 过期 冷 压缩 prompt cache expire') },
    { sec: 'ag-claude', id: 'ccompact', key: 'compactFrac', label: t('自动压缩点'), keys: t('压缩 上下文 auto compact') },
    { sec: 'ag-claude', id: 'cnewsess', key: 'newSessionPolicy', label: t('Claude 发起新会话'), keys: t('新会话 无关任务 unrelated task new session') },
    { sec: 'ag-claude', id: 'cinbound', key: 'crossSessionInbound', label: t('其它会话发来的消息'), keys: t('会话间消息 cross-session messages') },
    { sec: 'ag-claude', id: 'cpask', key: 'projectAskFirst', label: t('开讨论串前先问我'), keys: t('项目 讨论串 协调者 project thread coordinator') },
    { sec: 'ag-claude', id: 'cpmax', key: 'projectMaxLive', label: t('同时在跑的讨论串'), keys: t('项目 讨论串 并行 project threads parallel') },
    { sec: 'ag-claude', id: 'cpdaily', key: 'projectDailyThreads', label: t('每天最多新开讨论串'), keys: t('项目 讨论串 上限 project threads limit') },
    { sec: 'ag-claude', id: 'cpmodel', key: 'projectThreadModel', label: t('讨论串模型'), keys: t('项目 讨论串 模型 project thread model') },
    { sec: 'ag-claude', id: 'cpeffort', key: 'projectThreadEffort', label: t('讨论串推理强度'), keys: t('项目 讨论串 推理强度 project thread effort') },
    { sec: 'ag-claude', id: 'cbranch', key: 'branchPrefix', label: t('分支前缀'), keys: t('分支 git branch prefix') },
    { sec: 'ag-claude', id: 'cwtbase', key: 'worktreeBaseRef', label: t('工作树起点'), keys: t('工作树 分支 worktree base') },
    { sec: 'ag-claude', id: 'cautofix', key: 'autoFixPullRequests', label: t('自动修复拉取请求'), keys: t('拉取请求 CI 评审 auto-fix pull requests PR') },
    { sec: 'ag-claude', id: 'cprarchive', key: 'autoArchiveOnPrClose', label: t('拉取请求合并或关闭后自动归档'), keys: t('拉取请求 归档 auto-archive PR merge') },
    { sec: 'ag-claude', id: 'cattrib', key: 'attribution', label: t('提交与拉取请求署名'), keys: t('署名 提交 attribution co-authored-by') },
    { sec: 'ag-claude', id: 'carchive', key: 'autoArchiveDays', label: t('归档不活跃的会话'), keys: t('归档 不活跃 archive inactive sessions') },
    { sec: 'ag-claude', id: 'cquick', key: 'quickRetention', label: t('清理临时对话'), keys: t('临时对话 清理 回收站 条数 上限 temporary chats cleanup keep limit') },
    { sec: 'ag-claude', id: 'cdesk', key: 'followDesktopArchive', label: t('跟随 Claude Desktop 的归档'), keys: t('归档 官方桌面端 Claude Desktop archive') },
    { sec: 'ag-claude', id: 'cn-perm', key: 'notifyPermission', label: t('权限请求通知'), keys: t('通知 权限 notification permission requests') },
    { sec: 'ag-claude', id: 'cn-q', key: 'notifyQuestion', label: t('提问通知'), keys: t('通知 提问 notification questions') },
    { sec: 'ag-claude', id: 'cn-done', key: 'notifyTaskComplete', label: t('任务完成通知'), keys: t('通知 完成 notification task complete') },
    { sec: 'ag-claude', id: 'cn-err', key: 'notifyError', label: t('任务出错通知'), keys: t('通知 出错 报错 notification error') },
    { sec: 'ag-claude', id: 'cawake', key: 'keepAwake', label: t('Claude 工作时保持唤醒'), keys: t('睡眠 唤醒 电池 keep awake sleep battery') },
    { sec: 'ag-claude', id: 'cbypass', key: 'allowBypass', label: t('允许绕过权限模式'), keys: t('绕过 权限 bypass permissions') },
    { sec: 'ag-claude', id: 'cauto', key: 'allowAutoMode', label: t('允许自动模式'), keys: t('自动模式 权限 auto mode') },
    { sec: 'ag-claude', id: 'cdebug', key: 'debugMode', label: t('调试模式'), keys: t('调试 反馈 harness debug feedback') },
    { sec: 'ag-claude', id: 'agents', label: t('Agent 开关'), keys: t('claude codex chatgpt dimensio 分页 启用 关闭 认证') },
    { sec: 'ag-claude', id: 'pool', label: t('订阅号池'), keys: t('账号 切号 token 用量 Max Pro') },
    { sec: 'ag-claude', id: 'router', label: t('额度用尽自动换号'), keys: t('智能路由 换号') },
    // 模型中心（独立分区）：Claude 的自定义服务、两边共用的服务与 API 池、Vertex；管理员有总览时 dimensio 的自定义服务、
    // Studio 的媒体服务也并在这里管，它们原来那两条（dm-custom 已随 dimensio 分区的模型组删掉、st-providers）的关键词并进来、原条目不再出
    { sec: 'model-hub', id: 'mh', label: t('模型中心'), keys: [
      t('自定义 API 共用服务 API 池 Key 池 线路 Vertex 模型服务 第三方模型 接口地址 API Key OpenAI 兼容 DeepSeek Kimi GLM OpenRouter Ollama custom provider base url temperature 显示在模型列表 更多模型 More models 推理强度 档位 effort reasoning_effort 思考 检测连接 探测能力 小米 MiMo'),
      t('模型中心 媒体服务 文本 图像 视频 配音 音乐 模型 Claude model hub'),
      hub.ok ? t('dimensio 模型中心 自定义 API OpenAI 兼容 OpenRouter Ollama custom provider base url') : '',
      hub.ok ? t('Media Studio 生图 视频 配音 音乐 自定义 API Key OpenAI fal Replicate ElevenLabs MiniMax 火山方舟 OpenRouter Gemini Vertex provider') : '',
    ].join(' ') },
    // dimensio（DimensioSection）：偏好注册表的项进过这一分区、拉到了才进索引（模型 / Key / 本机模型 11-15 起不在这一分区）
    { sec: 'ag-dimensio', id: 'dm-mode', label: t('默认运行档位'), keys: t('dimensio 自主执行 只读 先出计划 全权 权限 模式 mode bypass') },
    { sec: 'ag-dimensio', id: 'dm-access', label: t('访问范围'), keys: t('dimensio 整机 仅工作空间 沙箱 access') },
    { sec: 'ag-dimensio', id: 'dm-allow', label: t('总是允许'), keys: t('dimensio 权限规则 允许 放行 allow rule') },
    { sec: 'ag-dimensio', id: 'dm-ask', label: t('每次问我'), keys: t('dimensio 权限规则 询问 ask rule') },
    { sec: 'ag-dimensio', id: 'dm-deny', label: t('从不允许'), keys: t('dimensio 权限规则 禁止 deny rule') },
    { sec: 'ag-dimensio', id: 'dm-ws', label: t('工作空间'), keys: t('dimensio 工作区 文件夹 目录 workspace') },
    { sec: 'ag-dimensio', id: 'dm-mem', label: t('记忆管理'), keys: t('dimensio 记忆 memory 召回') },
    { sec: 'ag-dimensio', id: 'dm-feed', label: t('显示全部工作过程'), keys: t('dimensio 工作过程 工具调用 折叠 展开 详细') },
    ...(me.kind === 'admin' ? [{ sec: 'ag-dimensio', id: 'dm-mcp', label: t('dimensio 的 MCP 连接器'), keys: t('dimensio mcp 连接器 connector 工具 server') }] : []),
    { sec: 'ag-dimensio', id: 'dm-skills', label: t('dimensio 的技能'), keys: t('dimensio 技能 skill 命令 command') },
    { sec: 'ag-dimensio', id: 'dm-diag', label: t('导出诊断包'), keys: t('dimensio 诊断 导出 日志 diagnostics') },
    ...visiblePrefItems().map((p) => ({ sec: 'ag-dimensio', id: 'dp-' + p.key, label: prefLabel(p), keys: prefDesc(p) + ' dimensio' })),
    // dimensio 的子 agent 调用策略：就地子页 ag-dimensio#dispatch（读到了 dimensio 的设置才有那一行）
    { sec: 'ag-dimensio', sub: 'dispatch', id: 'ddispatch', label: t('dimensio 的子 agent 调用策略'), keys: t('dimensio 子 agent 模型 思考深度 effort 性价比 判定线 策略 档位 跟随 Claude 工作流 StartSession dispatch policy') },
    // Media Studio（正文是懒加载的 studio 扩展；id 对应它里面的行，搜索跳过去闪一下）。Gemini 设置分区删了，搜 Gemini / Vertex 落到这里
    { sec: 'studio', id: 'st-import', label: t('一键导入 Vertex'), keys: t('Gemini Vertex Google 云凭据 服务账号 API Key OpenRouter 本机图像模型 导入 import') },
    { sec: 'studio', id: 'st-google', label: t('Google 云凭据'), keys: t('Gemini Vertex Google Cloud 凭据 服务账号 JSON 项目 区域 gcloud ADC credentials') },
    { sec: 'studio', id: 'st-providers', label: t('媒体服务'), keys: t('Media Studio 生图 视频 配音 音乐 自定义 API Key OpenAI fal Replicate ElevenLabs MiniMax 火山方舟 OpenRouter Gemini Vertex provider') },
    { sec: 'studio', id: 'st-def', label: t('默认模型'), keys: t('Media Studio 图像 视频 配音 音乐 模型 Nano Banana Veo Lyria Gemini default model') },
    { sec: 'studio', id: 'st-autosave', label: t('自动存进工作空间'), keys: t('Media Studio 保存 作品 工作空间 auto save') },
    { sec: 'studio', id: 'st-savedir', label: t('保存位置'), keys: t('Media Studio 保存 文件夹 目录 save folder') },
    ...(me.kind === 'admin' ? [
      { sec: 'studio', id: 'st-agents', label: t('允许的 agent'), keys: t('Claude dimensio Codex 媒体工具 生图 主动生成 Agent 接入 media tools') },
      { sec: 'studio', id: 'st-kinds', label: t('允许的种类'), keys: t('图片 语音 音乐 视频 分辨率 4K 1080p') },
      { sec: 'studio', id: 'st-safety', label: t('内容安全过滤'), keys: t('Gemini Google 安全 过滤 骚扰 仇恨 色情 危险 safety') },
    ] : []),
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
    { sec: 'devices', id: 'dv-web-bridge', label: t('浏览器扩展 Web Bridge'), keys: t('浏览器 扩展 插件 Edge Chrome 安装') },
    { sec: 'wallpaper', id: 'flux', label: t('流体壁纸参数'), keys: t('flux 点阵 颜色 海浪') },
    { sec: 'wallpaper', id: 'wp-light', label: t('明亮壁纸'), keys: t('风景 白天 上传') },
    { sec: 'wallpaper', id: 'wp-dark', label: t('深色壁纸'), keys: t('flux 夜间 上传') },
    { sec: 'wallpaper', id: 'spatial', label: t('空间壁纸'), keys: t('景深 视差 3d') },
    { sec: 'connect', id: 'addr', label: t('服务器地址'), keys: t('连接 电脑 域名') },
    { sec: 'connect', id: 'pairconnect', label: t('手机扫码连接'), keys: t('二维码 配对码 手机 扫码 连接 App') },
    { sec: 'connect', id: 'route', label: t('当前线路'), keys: t('隧道 局域网 lan') },
    { sec: 'connect', id: 'update', label: t('检查更新'), keys: t('版本 升级') },
    { sec: 'connect', id: 'server-update', label: t('服务端更新'), keys: t('服务器 版本 升级 GitHub') },
    { sec: 'connect', id: 'auto-update', label: t('自动检查更新'), keys: t('自动 更新') },
    { sec: 'connect', id: 'public', label: t('公网地址'), keys: t('外网 域名 example') },
    { sec: 'connect', id: 'srvadmin', label: t('服务端控制台'), keys: t('admin 管理') },
    { sec: 'connect', id: 'srvproc', label: t('bridge 服务进程'), keys: t('启动 停止 重启 服务 进程 掉线 隧道') },
    { sec: 'connect', id: 'quitconfirm', label: t('退出前确认'), keys: t('退出 关闭 停止 本机服务端 quit') },
    { sec: 'connect', id: 'keeponline', label: t('插电时保持在线'), keys: t('睡眠 休眠 唤醒 电源 常驻 在线 本机服务端 sleep awake') },
    { sec: 'connect', id: 'srvaccess', label: t('本机服务端访问信息'), keys: t('访问令牌 token 局域网 地址 公网 重新配置 端口') },
    { sec: 'help', id: 'feedback', label: t('提交反馈'), keys: t('问题 建议 截图') },
    { sec: 'help', id: 'fbup', label: t('把用户反馈同时发给 {to}', { to: D.fb.fbDest.to }), keys: t('反馈 推送 开发者 汇总 关闭') },
  ].filter((e) => !e.sec.startsWith('ag-') || D.ag.agentRows.some((a) => 'ag-' + a.id === e.sec))
   .filter((e) => e.sec !== 'studio' || D.ag.studioOn)
   .filter((e) => e.sec !== 'model-hub' || D.ag.mhOn)
   .filter((e) => e.id !== 'st-providers' || !(hub.ok && hub.v2 && !hub.studioErr))   // 有总览时这两样在模型中心管，并进了上面 mh 那条
   .filter((e) => e.id !== 'fbup' || (D.fb.fbUp?.admin && D.fb.fbUp.mode !== 'inbox' && !D.fb.fbUp.reason))   // 跟反馈页上开关的出现条件一致
   .filter((e) => e.id !== 'admin-access' || me.kind === 'user')
   .filter((e) => e.sec !== 'extensions' || (D.ag.extOk && (!D.ag.extMember || e.id === 'ext-skill')))   // 成员只有技能
   .filter((e) => !single || (e.sec !== 'wallpaper'))
   .filter((e) => e.id !== 'auto-update' || hasSilentUpdate())
   .filter((e) => e.id !== 'server-update' || (me.kind === 'admin' && !(hasSilentUpdate() && serverOnThisMachine())))   // 跟「服务端更新」那一组的出现条件一致
   .filter((e) => e.id !== 'quitconfirm' || (D.conn.spPrefs?.managed && typeof D.conn.spPrefs.confirmQuit === 'boolean'))   // 跟「连接与更新」里那一行的出现条件一致
   .filter((e) => e.id !== 'keeponline' || (D.conn.spPrefs?.managed && typeof D.conn.spPrefs.keepOnline === 'boolean'))
   .filter((e) => e.id !== 'srvaccess' || (D.conn.spPrefs?.managed && ssCtl))
   .filter((e) => !e.key || visible(e.key))
   .filter((e) => e.id !== 'cdispatch' || D.dsp.dpShown)   // 跟「对话」组里那一行的出现条件一致
   .filter((e) => e.id !== 'ddispatch' || dimReady())   // 跟 dimensio 分区里那一行的出现条件一致
   .filter((e) => e.sec !== 'policy' || (ags.policyOk && ags.multiUser)));
  const SECNAME = $derived(Object.fromEntries([['account', t('账户')], ...NAV_GROUPS.flat().map((n) => [n.key, n.label])]));
  // 选中的分区被收走（权限 / 扩展探针变化）时回到通用。模型中心例外一段时间：直达它时总览多半还没到，等两边都落定再判
  $effect(() => {
    if (sec === 'model-hub' && !D.ag.mhSettled) return;
    if (sec !== 'account' && NAV_GROUPS.length && !NAV_GROUPS.flat().some((n) => n.key === sec) && !sec.startsWith('ag-')) untrack(() => { sec = 'general'; clSub = ''; });
  });
  const hits = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return INDEX.filter((e) => (e.label + ' ' + e.keys).toLowerCase().includes(q)).slice(0, 12);
  });
  let flashTimer = 0;
  function jump(e) {
    if (e.id.startsWith('ext-')) { extensionsNav.type = e.id.slice(4); D.ag.extKey++; }
    navigate(locOf(e.sec, e.sub)); query = '';
    flash = e.id;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = ''; }, 1600);
  }
  const fl = (id) => flash === id;

  D.acc = createDeskAccount(D);
  D.gen = createDeskGeneral(D);
  D.clp = createDeskClaudePrefs();
  D.dsp = createDeskDispatch(D);
  // 进子页从顶上看起；从子页退回 Claude 分区时回到进去前滚到的那一行（进去是从页面中段的一行点的，回来不该被甩回顶上）。
  // 用 $effect.pre：要在正文换掉之前记下滚动位置
  let scrollEl = $state(null), clScrollY = 0, wasCl = false, wasSub = false;
  $effect.pre(() => {
    const on = D.dsp.subOn, inCl = sec === 'ag-claude' || sec === 'ag-dimensio';
    untrack(() => {
      if (scrollEl) {
        if (on && !wasSub) clScrollY = wasCl ? scrollEl.scrollTop : 0;   // 搜索 / 外部直达进来的没有「进去前的位置」
        const y = on ? (wasSub ? -1 : 0) : inCl && wasSub ? clScrollY : -1;
        if (y >= 0) tick().then(() => { if (scrollEl) scrollEl.scrollTop = y; });
      }
      wasCl = inCl && !on; wasSub = on;
    });
  });
  // 扩展与记忆：直达扩展分区的某个类型 / Claude 分页的定时任务
  function openExtType(type) { extensionsNav.type = type; D.ag.extKey++; navigate('extensions'); }
  function openRoutinesPage() { ui.settingsOpen = false; goto('claude'); ui.routinesOpen = true; }
  D.sc = createDeskShortcuts(D);
  D.wpd = createDeskWallpaper();
  D.conn = createDeskConnect(D);
  D.fb = createDeskFeedback(D);

  const ver = createVersionLine();   // 侧栏底部的版本行（两套外壳共用）
  // ═══ 关闭 ═══
  // home = 侧栏左上角那枚「主页 / 返回」钮：人在子页里也直接关设置，不先退一层（Esc 与系统返回才逐层退）
  function back(home = false) {
    if (closing) return;
    if (anyModal) { D.ag.acctForm = null; D.ag.acctDel = null; D.ag.acctResets = null; D.ag.agLast = null; D.acc.logoutAsk = false; D.clp.bypassAsk = false; return; }
    // 模型中心的浮层（App 根上，盖在设置上）开着：它自己登记了返回层就轮不到这里；没登记（还在懒加载）时兜底先关它，别把底下的设置一起关掉
    if (hubUi.sheet) { closeHubSheet(); return; }
    // 就地子页（子 agent 调用策略）开着：先退回 Claude 分区
    if (D.dsp.subOn && home !== true) { subUp(); return; }
    D.dsp.dpLeave(() => {
      ui.homePop++;
      closing = true;
      setTimeout(() => { ui.settingsOpen = false; }, 170);
    });
  }
  $effect(() => registerCloser('settings', back));
  // 快捷键清单的真相在主进程（注册成没成功只有它知道）：进设置拉一次，之后跟着它推。
  $effect(() => {
    D.sc.scRefresh();
    return scCtl?.onState?.((s) => { if (s) D.sc.scState = s; });
  });
  // 扩展面板有弹层 / 详情开着时它在捕获阶段先接了 Esc（defaultPrevented），这里就别再关整页
  // 服务管理器这类浮层（模型中心的添加 / 服务详情、Media Studio 正文里的、调用策略子页里的模型 / 推理强度选择）自己接 Esc 逐层后退：
  // 它们的监听挂得比这里晚、后触发，这里先让开
  function onKey(e) {
    if (e.key !== 'Escape' || e.defaultPrevented || hubUi.sheet || D.ag.stModal || D.dsp.dpModal) return;
    // 子页里正在文本框里写着字（口述备注、策略名）：输入法组字中不动；否则第一下只让它失焦，别一按就把人带出子页
    if (D.dsp.subOn) {
      if (e.isComposing) return;
      const a = document.activeElement;
      if (a?.matches?.('textarea, input:not([type]), input[type="text"]') && String(a.value ?? '').trim()) { e.preventDefault(); a.blur(); return; }
    }
    e.preventDefault();
    back();
  }

  // WCO 几何早期恒 visible=false（批1 课）：保持响应式，几何到位自动重算。
  // 首行折进标题栏带（macOS 系统设置同款）：带内垂直居中（(带高-34)/2，34=--sd-hd），
  // 控件中心对齐系统窗控中心；非 WCO 场景给 8px 呼吸位。
  const bandPad = $derived(wcoActive() ? Math.max((wcoHeight() - 34) / 2, 0) : 8);
</script>

<svelte:window onkeydown={onKey} />

{#snippet ava(cls = '')}
  <span class="ava {cls}" class:none={me.kind === 'none'}>{#if me.kind !== 'none'}{D.acc.initial}{:else}{@html PERSON}{/if}</span>
{/snippet}
{#snippet nico(n)}
  <span class="nico" aria-hidden="true">{#if n.brand}{#if markSrc(n.brand)}<img src={markSrc(n.brand)} alt="" draggable="false" />{:else}{@html svgOf('orb')}{/if}{:else}{@html svgOf(n.ico)}{/if}</span>
{/snippet}

<div class="sd" class:closing class:light={!dark} style:--sd-band="{bandPad}px">
  <aside class="side">
    <button class="back" onclick={() => back(true)} title={single ? t('关闭 (Esc)') : t('返回主页 (Esc)')}>
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
          <i>{me.kind === 'none' ? t('登录 bridge 账户') : D.acc.roleLabel}</i>
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
    <div class="ver sel-text">{ver.line}</div>
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
      <div class="htitle" class:on={scrolled || !(sec === 'account' || sec === 'extensions' || sec === 'agentapi' || sec === 'studio' || sec === 'model-hub' || sec.startsWith('ag-'))}>{SEC_TITLE}</div>
    </header>

    <div class="scroll" class:plg={!!plgOf(sec)} bind:this={scrollEl} onscroll={(e) => { scrolled = e.currentTarget.scrollTop > 2; }}>
    {#if plgOf(sec)}
      {@const pp = plgOf(sec)}
      {#key pp.id}<div class="plg-host"><PluginFrame id={pp.id} page={pp.page} mode="panel" onBack={goBack} /></div>{/key}
    {:else if sec.startsWith('plg-')}
      <p class="note">{pluginPanels.loaded ? t('这个插件面板不在了（插件被关掉或卸载了）') : t('载入中…')}</p>
    {:else if sec === 'account'}
      <AccountSection />

    {:else if sec === 'general' || sec === 'appearance'}
      <PrefsSection />

    {:else if sec === 'studio'}
      <!-- Media Studio（2026-11-04 接替 Gemini 分区）：头图 + 管理员的启用开关在这里画，正文是懒加载的 studio 扩展组件 -->
      {@const a = agentById('studio')}
      <div class="hero">
        <span class="mark">{#if markSrc('studio')}<img src={markSrc('studio')} alt="" draggable="false" />{/if}</span>
        <h2>Media Studio</h2>
        {#if studioStatus(a)}<p>{studioStatus(a)}</p>{/if}
      </div>
      {#if a}
        <DGroup>
          <DRow title={t('启用 {name}', { name: 'Media Studio' })} highlight={fl('agents')}>
            {#snippet trailing()}<DSwitch checked={a.switch && a.runnable} disabled={!a.runnable || ags.agentBusy === a.id} onchange={(v) => D.ag.toggleAgent(a, v)} />{/snippet}
          </DRow>
        </DGroup>
      {/if}
      {#await loadPage.studioSettings() then m}
        {@const StudioBody = m.default}
        <StudioBody shell="desk" {dark} {fl} agentIds={D.ag.studioIds.length ? D.ag.studioIds : null} onModal={(v) => (D.ag.stModal = v)} />
      {:catch}
        <p class="note">{t('Media Studio 的设置没加载出来：这台服务器可能没装 Media Studio 扩展。')}</p>
      {/await}

    {:else if sec === 'model-hub'}
      <!-- 模型中心（2026-11-10 起是设置里的独立分区）：头图在这里画（副文只写状态），正文是懒加载的 components/modelhub/HubHome；
           添加 / 服务详情是 App 根上的全局浮层，不在这一页里。正文比别的分区宽（.hubw 720，同 .cz 的做法）：服务行要并排摆
           名字、给谁用、种类与线路状态，600 一挤就折行 -->
      {@const sum = hubSummaryText()}
      <div class="hero">
        <span class="mark">{@html svgOf('modelhub', 1.4)}</span>
        <h2>{t('模型中心')}</h2>
        {#if sum}<p>{sum}</p>{/if}
      </div>
      <div class="hubw">
        {#await import('../../components/modelhub/HubHome.svelte') then m}
          <m.default shell="desk" />
        {:catch}
          <p class="note">{t('模型中心没加载出来：关掉设置再打开试试。')}</p>
        {/await}
      </div>

    {:else if D.dsp.subOn}
      <!-- 子 agent 调用策略：Claude / dimensio 分区里就地展开的子页（clSub='dispatch'），整块替换分区正文。返回头归外壳（回所在分区），
           正文是懒加载的 components/claude/dispatch/DispatchPolicy（dimensio 分区里传 dimensio 那份状态；两边切换时整个重挂）。
           内容列比标准的 600 宽（.subw ≤ 920）：性价比图和四档落点要并排摆得开 -->
      <div class="subw">
        <div class="subhd">
          <button class="sub-back" onclick={subUp} title={t('返回 (Esc)')}>
            <svg viewBox="0 0 10 16" width="7" height="12" aria-hidden="true"><path d="M8.5 1 2 8l6.5 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>{SEC_NAME}</span>
          </button>
          <h2>{t('子 agent 调用策略')}</h2>
        </div>
        {#key D.dsp.dmSubOn}
          {#await Promise.all([import('../../components/claude/dispatch/DispatchPolicy.svelte'), import('../../lib/dispatchPolicy.svelte.js')]) then [m, st]}
            <m.default shell="desk" store={D.dsp.dmSubOn ? st.dimDispatch : st.claudeDispatch} onModal={(v) => { D.dsp.dpModal = !!v; }} />
          {:catch}
            <p class="note">{t('调用策略没加载出来：关掉设置再打开试试。')}</p>
          {/await}
        {/key}
      </div>

    {:else if sec.startsWith('ag-')}
      <AgentSection />

    {:else if sec === 'extensions'}
      {#key D.ag.extKey}<Customize />{/key}

    {:else if sec === 'policy' || sec === 'shortcuts'}
      <PrefsSection />

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
      <PrefsSection />

    {:else if sec === 'connect'}
      <ConnectSection />

    {:else if sec === 'help'}
      <HelpSection />
    {/if}
    </div>
  </main>

  <!-- 确认 / 表单弹窗：同一个外壳，Esc 与点遮罩都关 -->
  {#if anyModal}
    <div class="dlg-root">
      <button class="dlg-dim" tabindex="-1" aria-label={t('关闭')} onclick={back}></button>
      <div class="dlg" role="dialog" aria-modal="true">
        {#if D.ag.acctForm}
          <form onsubmit={D.ag.saveAcctForm}>
            <h3>{D.ag.acctForm.isNew ? t('添加 Claude 账号') : t('编辑账号')}</h3>
            <p>{t('在目标账号登录状态下运行 claude setup-token，把返回的长期 token 粘进来。')}</p>
            <DField bind:value={D.ag.acctForm.label} placeholder={t('如：主号 / 备用号')} width="100%" />
            <DField bind:value={D.ag.acctForm.token} type="password" width="100%"
              placeholder={D.ag.acctForm.isNew ? 'sk-ant-oat…' : (D.ag.acctForm.hasToken ? t('留空＝不改，当前 …{tail}', { tail: D.ag.acctForm.tokenTail || '' }) : t('留空＝用本机登录态'))} />
            <div class="plan-pick">
              <span>{t('套餐')}</span>
              <DSegmented options={PLAN_CHOICES()} bind:value={D.ag.acctForm.plan} />
            </div>
            <p class="hint">{t('套餐：setup-token 读不到订阅档位，自动识别分不清 Pro / Max 5x / Ultra 时手动标一下。')}</p>
            {#if D.ag.acctForm.err}<p class="err">{D.ag.acctForm.err}</p>{/if}
            <div class="dacts">
              <DButton variant="ghost" onclick={() => { D.ag.acctForm = null; }}>{t('取消')}</DButton>
              <DButton variant="primary" type="submit" disabled={D.ag.acctForm.busy}>{D.ag.acctForm.isNew ? t('添加') : t('保存')}</DButton>
            </div>
          </form>
        {:else if D.ag.acctResets}
          <h3>{t('重置卡 · {name}', { name: accLabel(D.ag.acctResets.label) })}</h3>
          <p>{t('Anthropic 偶尔发给订阅号的限额重置：用掉一张，对应限额的用量立即清零。')}</p>
          <ClaudeResets account={D.ag.acctResets} skin="dsk" />
          <div class="dacts">
            <DButton variant="ghost" onclick={() => { D.ag.acctResets = null; }}>{t('关闭')}</DButton>
          </div>
        {:else if D.ag.acctDel}
          <h3>{t('删除账号 {name}？', { name: accLabel(D.ag.acctDel.label) })}</h3>
          <p>{t('只从切换列表移除；若删的是当前账号，会自动切到另一个。')}</p>
          <div class="dacts">
            <DButton variant="ghost" onclick={() => { D.ag.acctDel = null; }}>{t('取消')}</DButton>
            <DButton variant="danger" onclick={D.ag.confirmAcctDel}>{t('删除')}</DButton>
          </div>
        {:else if D.ag.agLast}
          <h3>{t('关闭 {name}？', { name: tr(D.ag.agLast.label) })}</h3>
          <p>{t('这是最后一个开着的 agent，关掉后所有客户端都没有可用的分页。确定吗？')}</p>
          <div class="dacts">
            <DButton variant="ghost" onclick={() => { D.ag.agLast = null; }}>{t('取消')}</DButton>
            <DButton variant="danger" onclick={async () => { const x = D.ag.agLast; D.ag.agLast = null; await setAgentOn(x, false); }}>{tc('开关', '关闭')}</DButton>
          </div>
        {:else if D.clp.bypassAsk}
          <h3>{t('允许绕过权限模式？')}</h3>
          <p>{t('跳过所有权限检查，让 Claude 不间断地干活，适合修 lint、生成样板代码这类事。让 Claude 随意执行命令有风险，可能造成数据丢失、系统损坏或数据外泄（例如提示注入攻击）。')}</p>
          <div class="dacts">
            <DButton variant="ghost" onclick={() => { D.clp.bypassAsk = false; }}>{t('取消')}</DButton>
            <DButton variant="danger" onclick={D.clp.confirmBypass}>{t('允许')}</DButton>
          </div>
        {:else if D.acc.logoutAsk}
          <h3>{t('退出登录？')}</h3>
          <p>{t('只退出这台设备，其它设备上的登录不受影响。')}</p>
          <div class="dacts">
            <DButton variant="ghost" onclick={() => { D.acc.logoutAsk = false; }}>{t('取消')}</DButton>
            <DButton variant="danger" onclick={D.acc.doLogout}>{t('退出登录')}</DButton>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>


<style>
  /* 整套样式在同目录的 kit.css（分区组件也 @import 同一份，各自带作用域）；内容列共用的几条在 scrollColumn.css */
  @import './kit.css';
</style>
