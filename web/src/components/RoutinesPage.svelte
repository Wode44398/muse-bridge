<script>
  // 定时任务（Routines）页：列表 → 详情 → 新建 / 编辑。结构照官方 Claude Desktop 4.4212 的 Code 侧「Scheduled」
  //（规格：bridge build/bridge前端设计/claude页面设计参考资源/定时任务-官方规格/官方定时任务规格.md）——
  //   列表 = 两列卡片网格（标题 + 三行描述 + 「状态 · 频率」，悬停出 ⋯ 菜单），页头 搜索 / 筛选 / 排序 / 新建下拉；
  //   详情 = 左（描述 / 状态 / 文件夹 / 重复 / 模型 / 权限…）右（可折叠指令 / 运行记录）两列；
  //   表单 = 名称 / 描述 / 指令框（框内工具条：权限、模型；位置条：文件夹、分支、Worktree）/ 频率分段条。
  // 官方这页本来就带工作文件夹这些 Code 设置；bridge 另加：思考强度与 Fast、一次性 / 自定义 cron、
  // 会话方式（每次新会话 / 接着上次）、跑完通知、运行记录里的结果摘要。
  // 电脑（侧栏常驻）嵌在正文区、侧栏照旧可点（embedded）；手机是全屏页。数据：lib/routines.svelte.js。
  // 11-14 引擎可选 Claude / dimensio（身份两个都开着才出选择）：选 dimensio 时模型芯片列 dimensio 的厂商与型号（它自己的目录，
  // 含自定义服务）、思考强度是那个型号的深度档、权限芯片换成 dimensio 的运行档位（全权只给主机身份）；worktree / 分支 / Fast /
  // 项目对话是 Claude 才有的，不出现。运行记录里 dimensio 的会话点开跳到 dimensio 页。
  // 11-13 表单重排（维护者：太粗糙、模型菜单被遮挡、十字星图标莫名其妙）：
  //   · 指令框照输入栏的语言——模型 / 思考强度是两枚素文本芯片，点开就是输入栏那两个浮层（ModelPicker / EffortPanel
  //     受控模式，只列官方模型：服务端只认白名单）；其余芯片去掉虚线框，改成悬停浮底的图标 + 文字；
  //   · 所有下拉挪到 body 上、按触发点上下剩余的空间限高（以前固定 420，展开在屏幕下半截就探出屏幕底）；
  //   · 时间显示成 24 小时的按钮、点开系统时间选择器；频率分段条铺满一行，选中项是浮起的滑块；
  //   · 底部动作条常驻（整页 / 编辑对话框都是），保存不了时点「创建」直接说缺什么、跳到那一栏。
  import { untrack } from 'svelte';
  import { uiConfirm } from '../lib/dialogs.js';
  import { caps, ui, session, agentOn, hostIsServer, pluginOn } from '../lib/state.svelte.js';
  import { api } from '../lib/api.js';
  import { registerCloser, pushBackLayer } from '../lib/nav.js';
  import { claudeDefaultModel, claudeEffortFallback } from '../lib/caps.js';
  import { isCustomModel } from '../lib/claudeProviders.svelte.js';
  import { portal, escLayer, layerFocus } from './claude/dispatch/dpDom.js';
  import ModelPicker from './ModelPicker.svelte';
  import EffortPanel from './EffortPanel.svelte';
  import { cs } from '../lib/claudeSettings.svelte.js';
  import { modeLabel, modeDesc, clampModeLocal } from '../lib/permissions.svelte.js';
  import { hasNativePickDirectory, nativePickDirectory } from '../lib/nativeDesktop.js';
  import { rt, loadRoutines, schedText, whenText, durText, folderName, tzLabel, wdName, hm,
    loadDimCatalog, dimProviders, dimModelText, dimEfforts, dimDefaultEffort, dimModeLabel, dimModeDesc, openRoutineSession } from '../lib/routines.svelte.js';
  import { vendorName } from '../lib/dimensioSettings.svelte.js';
  import { computeNextRun } from '../../../src/routine-schedule.mjs';
  import { parseCron } from '../../../src/cron.mjs';
  import ProjectPicker from './ProjectPicker.svelte';
  import { t, tr, isEn } from '../lib/i18n.js';

  let { embedded = false } = $props();

  let view = $state('list');          // 'list' | 'detail' | 'form'（新建 / 窄屏编辑的整页）
  let dlg = $state(false);            // 宽屏编辑：640 对话框盖在详情页上（官方 Edit 同款）
  let curId = $state(null);
  let formBack = 'list';
  let editing = $state(null);         // 正在编辑的任务 id（null = 新建）
  let busy = $state(false);
  let err = $state('');
  let opErr = $state('');
  let q = $state('');
  let searchOpen = $state(false);
  let fSched = $state('all');         // 筛选·频率：all | recurring | once | manual
  let fStatus = $state('all');        // 筛选·状态：all | on | off
  let sort = $state('next');          // next | name | recent（官方默认 Next run）
  let showDone = $state(false);       // 显示已完成的一次性任务（官方 Include completed）
  let pop = $state(null);             // 打开着的下拉：{ key, x, y, w, h, up, id? }
  let mlay = $state(null);            // 模型 / 思考强度浮层：{ kind: 'model' | 'effort', rect }
  let tried = $state(false);          // 点过一次保存：之后才把缺的栏标出来
  let pickOpen = $state(false);       // 远程端的文件夹选择器
  let projects = $state([]);          // 工作文件夹候选（Claude 项目）
  let git = $state(null);             // 选中文件夹的 git 信息 { git, branch, branches, worktreeOk }
  let showAllPrompt = $state(false);
  let pageW = $state(1000);
  const wide = $derived(pageW >= 760);
  // 鼠标设备才自动聚焦名称栏：手机上一进来就弹软键盘，半个表单被挡住
  const finePointer = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;

  // 新建默认用 Claude；这个身份只开了 dimensio 就用 dimensio
  const blank = () => ({
    name: '', description: '', prompt: '', agent: rt.engines.includes('claude') || !rt.engines.length ? 'claude' : rt.engines[0], provider: null, model: null, effort: null, fast: false, search: false,
    cwd: '', worktree: false, branch: '', permissionMode: '', sessionMode: 'new', notify: false, shape: '',
    sched: { type: 'daily', hour: 9, minute: 0, days: [1], at: 0, cron: '0 9 * * 1-5' },
  });
  let f = $state(blank());
  let snap = '';                       // 打开表单时的样子：改过才在离开时确认「放弃修改？」
  const dirty = () => JSON.stringify(f) !== snap;

  const cur = $derived(rt.items.find((r) => r.id === curId) || null);
  const running = (r) => rt.running.includes(r.id);
  const liveOf = (r) => rt.live[r.id] || null;
  const isDone = (r) => r.schedule?.type === 'once' && !r.nextRun && r.lastRun;

  // ---- 列表：搜索 / 筛选 / 排序 ----
  const doneHidden = $derived(showDone ? 0 : rt.items.filter(isDone).length);
  const shown = $derived.by(() => {
    const k = q.trim().toLowerCase();
    const ty = (r) => r.schedule?.type;
    let list = rt.items.filter((r) => (showDone || !isDone(r))
      && (fStatus === 'all' || (fStatus === 'on' ? r.enabled !== false : r.enabled === false))
      && (fSched === 'all' || (fSched === 'once' ? ty(r) === 'once' : fSched === 'manual' ? ty(r) === 'manual' : !['once', 'manual'].includes(ty(r))))
      && (!k || (r.name + ' ' + (r.description || '')).toLowerCase().includes(k)));
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, isEn() ? 'en' : 'zh'));
    else if (sort === 'recent') list = [...list].sort((a, b) => (b.lastRun || b.createdAt || 0) - (a.lastRun || a.createdAt || 0));
    else list = [...list].sort((a, b) => ((a.enabled !== false && a.nextRun) || Infinity) - ((b.enabled !== false && b.nextRun) || Infinity) || a.name.localeCompare(b.name));
    return list;
  });
  const filtering = $derived(fSched !== 'all' || fStatus !== 'all');
  function clearFilters() { q = ''; searchOpen = false; fSched = 'all'; fStatus = 'all'; }

  // 状态：列表卡片底行的词 + 详情页徽标（官方 Active / Paused / Completed；bridge 加 运行中 / 等你处理）
  const stateWord = (r) => (r.enabled === false ? t('已暂停') : isDone(r) ? t('已完成') : t('启用中'));
  const liveDot = (r) => (running(r) ? (liveOf(r)?.waiting ? 'wait' : 'run') : r.lastStatus === 'error' && r.enabled !== false ? 'err' : '');
  const liveDotLabel = (k) => (k === 'wait' ? t('等你处理') : k === 'run' ? t('运行中') : t('上次失败'));
  const cardDesc = (r) => r.description || (String(r.prompt || '').length > 279 ? String(r.prompt).slice(0, 279) + '…' : r.prompt || '');
  const missedAt = (r) => (r.missedAt && r.missedAt > (r.lastRun || 0) ? r.missedAt : 0);

  // ---- 能力表 → 选项 ----
  const nameOf = (list, id) => tr((list || []).find((x) => x.id === id)?.name || id || '');
  // 引擎只剩 Claude（Gemini 11-04 下线，旧任务打开编辑时已改成 Claude）。没选思考强度 = 这个模型的 API 默认档
  //（Opus 5.5 是 Medium，其余 High；同输入栏芯片），以前这里写死 High，和实际跑的不一致。
  const effortList = $derived((caps.data?.claude?.efforts || []).filter((e) => e.id !== 'ultracode'));
  const defModel = $derived(claudeDefaultModel(caps.data));
  const curModel = $derived(f.model || defModel);
  const defEffort = $derived(claudeEffortFallback(caps.data, curModel));
  const fastOk = $derived((caps.data?.claude?.fast || []).includes(curModel));
  const modelLabel = $derived(nameOf(caps.data?.claude?.models, curModel));
  const effortLabel = $derived(nameOf(effortList, f.effort || defEffort));
  const officialOnly = (m) => !isCustomModel(m.id);   // 定时任务只存官方模型（服务端按白名单收，自定义 API 的会被丢回默认）
  function pickModel(id) {
    f.model = id;
    if (f.effort && !effortList.some((e) => e.id === f.effort)) f.effort = null;
  }
  const engineText = (r) => {
    const vx = r.agent === 'vertex';
    const fallback = vx ? (caps.data?.vertex?.defaults?.model || '') : claudeDefaultModel(caps.data);
    return `${vx ? 'Gemini' : 'Claude'} · ${nameOf(vx ? caps.data?.vertex?.models : caps.data?.claude?.models, r.model || fallback)}`;
  };
  const effortText = (r) => {
    const vx = r.agent === 'vertex';
    return nameOf(vx ? caps.data?.vertex?.thinkLevels : caps.data?.claude?.efforts,
      r.effort || (vx ? caps.data?.vertex?.defaults?.think : claudeEffortFallback(caps.data, r.model || claudeDefaultModel(caps.data))));
  };
  const permDefault = $derived(clampModeLocal(cs.values?.permissionMode));
  const permText0 = (m) => (m ? modeLabel(m) : t('设置默认（{mode}）', { mode: modeLabel(permDefault) }));
  // 以项目对话运行（运行档位 › 项目，src/runtime/project-mode.mjs）：协调者收到指令后自己派讨论串；权限那一档就是讨论串权限。
  // 要会话工具（插件开着、能跑命令的身份）
  const projOk = $derived(pluginOn('session-tools') && cs.shell !== false);
  const permText = (m, shape) => (shape === 'project' ? t('项目 · 讨论串用：{mode}', { mode: m ? modeLabel(m) : modeLabel(permDefault) }) : permText0(m));
  const permEff = $derived(f.permissionMode || permDefault);
  const asks = (m) => m === 'default' || m === 'acceptEdits';

  // ---- dimensio 引擎：型号目录 / 默认设置来自 dimensio 自己（rt.dim，选了才拉）----
  const isDim = $derived(f.agent === 'dimensio');
  const dimCfg = $derived(rt.dim.config);
  // 没选型号 = dimensio 设置里的默认型号（显示它的名字，同 Claude 那边显示默认型号）；目录还没拉到就写「dimensio 默认」
  const dimModelOf = (provider, model) => (provider ? dimModelText(provider, model) : dimCfg ? dimModelText(dimCfg.provider, dimCfg.model) : t('dimensio 默认'));
  const dimEffortOf = (provider, model, effort) => {
    const lv = effort || dimDefaultEffort(provider, model);
    return dimEfforts(provider, model).find((e) => e.id === lv)?.name || lv || t('默认');
  };
  const dimPermText = (m) => (m ? dimModeLabel(m) : t('设置默认（{mode}）', { mode: dimModeLabel(dimCfg?.permissionMode || 'auto') }));
  const dimPermEff = $derived(f.permissionMode || dimCfg?.permissionMode || 'auto');
  const dimEffortList = $derived(isDim ? dimEfforts(f.provider, f.model) : []);
  // 指令框里那三枚芯片的字：按引擎取
  const chipModel = $derived(isDim ? dimModelOf(f.provider, f.model) : modelLabel);
  const chipEffort = $derived(isDim ? dimEffortOf(f.provider, f.model, f.effort) : effortLabel);
  const chipPerm = $derived(isDim ? dimPermText(f.permissionMode) : permText(f.permissionMode, f.shape));
  function pickDimModel(provider, model) {
    f.provider = provider || null; f.model = provider ? model : null;
    // 各家深度档不一样：新型号没有原来那档就回到默认
    if (f.effort && !dimEfforts(f.provider, f.model).some((e) => e.id === f.effort)) f.effort = null;
  }
  // 引擎：身份两个都开着才出选择（编辑一条引擎已经关掉了的旧任务时，也把它现在的引擎列上，免得看不出是哪个）
  const engineChoices = $derived(rt.engines.includes(f.agent) ? rt.engines : [...rt.engines, f.agent]);
  function setEngine(a) {
    if (a === f.agent) return;
    // 换引擎：型号、深度、权限两边的取值不通用，回到默认；worktree / 分支 / Fast / 项目对话是 Claude 才有的
    Object.assign(f, { agent: a, provider: null, model: null, effort: null, permissionMode: '', fast: false, worktree: false, branch: '', shape: '' });
    mlay = null;
    if (a === 'dimensio') loadDimCatalog(); else loadGit();
  }
  const dimLoading = $derived(rt.dim.phase === 'loading' || rt.dim.phase === 'idle');

  const FREQS = [
    ['manual', () => t('手动')], ['once', () => t('一次')], ['hourly', () => t('每小时')], ['daily', () => t('每天')],
    ['weekdays', () => t('工作日')], ['weekly', () => t('每周')], ['cron', () => t('自定义')],
  ];
  const WEEK = [1, 2, 3, 4, 5, 6, 0];

  function schedOut() {
    const s = f.sched;
    switch (s.type) {
      case 'manual': return { type: 'manual' };
      case 'once': return { type: 'once', at: s.at };
      case 'cron': return { type: 'cron', cron: s.cron.trim() };
      case 'hourly': return { type: 'hourly', minute: s.minute };
      case 'weekly': return { type: 'weekly', days: s.days.length ? s.days : [1], hour: s.hour, minute: s.minute };
      default: return { type: s.type, hour: s.hour, minute: s.minute };
    }
  }
  const cronErr = $derived.by(() => {
    if (f.sched.type !== 'cron') return '';
    try { parseCron(f.sched.cron); return ''; } catch (e) { return tr(e.message); }
  });
  // 「下次运行」预览：与服务端同一份算法（routine-schedule.mjs）
  const nextPreview = $derived.by(() => {
    if (cronErr || f.sched.type === 'manual') return '';
    if (f.sched.type === 'once' && !f.sched.at) return '';
    try { const n = computeNextRun(schedOut()); return n ? whenText(n) : ''; } catch { return ''; }
  });
  // 保存按钮的禁用原因（官方 submitBlockedReason，按顺序取第一个）
  const blocked = $derived(!f.name.trim() ? t('填一个名称') : !f.prompt.trim() ? t('写上指令') : cronErr ? t('频率写法不对')
    : f.sched.type === 'once' && !(f.sched.at > Date.now()) ? t('一次性运行要选一个以后的时间') : '');

  // ---- 打开 / 关闭 ----
  $effect(() => { if (ui.routinesOpen) untrack(() => { view = 'list'; dlg = false; curId = null; pop = null; mlay = null; opErr = ''; loadRoutines(); }); });
  // 有任务在跑时轮询（等你处理 / 收尾的状态跟着变；总线事件是主路径，这里兜底）
  $effect(() => {
    if (!ui.routinesOpen || !rt.running.length) return;
    const h = setInterval(loadRoutines, 4000);
    return () => clearInterval(h);
  });
  // 电脑上侧栏照旧可点：点了别的会话 / 新对话，这页让开
  let lastSid = session.id;
  $effect(() => { const sid = session.id; if (sid !== lastSid) { lastSid = sid; if (embedded) untrack(() => { if (ui.routinesOpen) ui.routinesOpen = false; }); } });
  // 系统返回逐级退：下拉 → 文件夹选择器 → 表单 / 对话框 → 详情 → 关整页
  $effect(() => registerCloser('routines', () => {
    if (mlay) { mlay = null; return; }
    if (pop) { pop = null; return; }
    if (pickOpen) { pickOpen = false; return; }
    if (dlg || view === 'form') { leaveForm(); return; }
    if (view === 'detail') { view = 'list'; return; }
    ui.routinesOpen = false;
  }));
  function close() { ui.routinesOpen = false; }
  function openDetail(r) { pop = null; curId = r.id; showAllPrompt = false; opErr = ''; view = 'detail'; if (r.agent === 'dimensio') loadDimCatalog(); }

  function openNew() {
    pop = null; mlay = null; tried = false; editing = null; err = ''; f = blank(); formBack = view === 'detail' ? 'detail' : 'list';
    view = 'form'; dlg = false; afterFormOpen();
  }
  function openEdit(r) {
    pop = null; mlay = null; tried = false; editing = r.id; err = ''; curId = r.id;
    const s = r.schedule || {};
    f = {
      // Gemini 引擎 11-04 下线：旧任务（agent:'vertex'，服务端已停用）打开编辑时改用 Claude，保存即恢复可跑
      name: r.name || '', description: r.description || '', prompt: r.prompt || '', agent: r.agent === 'vertex' ? 'claude' : (r.agent || 'claude'),
      provider: r.agent === 'dimensio' ? r.provider || null : null, model: r.model, effort: r.effort, fast: !!r.fast, search: !!r.search,
      cwd: r.cwd || '', worktree: !!r.worktree, branch: r.branch || '', permissionMode: r.permissionMode || '',
      sessionMode: r.sessionMode || 'new', notify: !!r.notify, shape: r.shape === 'project' ? 'project' : '',
      sched: {
        type: s.type || 'daily', hour: s.hour ?? 9, minute: s.minute ?? 0,
        days: Array.isArray(s.days) ? [...s.days] : [s.weekday ?? 1], at: s.at || 0, cron: s.cron || '0 9 * * 1-5',
      },
    };
    if (wide) { if (view !== 'detail') view = 'detail'; dlg = true; }
    else { formBack = view; view = 'form'; }
    afterFormOpen();
  }
  async function afterFormOpen() {
    snap = JSON.stringify(f);
    if (f.agent === 'dimensio') loadDimCatalog();
    loadGit();
    try { const d = await api.claudeProjects(); projects = (d.projects || []).filter((p) => !p.quick && !p.def); } catch {}
  }
  async function leaveForm() {
    if (busy) return;
    if (dirty() && !(await uiConfirm(t('放弃没保存的修改？'), { okLabel: t('放弃'), type: 'warning' }))) return;
    pop = null; mlay = null;
    if (dlg) dlg = false; else view = formBack;
  }
  // 「让 Claude 帮我建」（官方 Create with Claude）：开一个新对话、预填一句，Claude 用 bridge 的 routines.create 建
  async function createWithClaude() {
    pop = null; ui.routinesOpen = false;
    const handled = !window.dispatchEvent(new CustomEvent('bridge:newchat', { cancelable: true }));
    if (!handled) { const { newConversation } = await import('../lib/chat.svelte.js'); newConversation(); }
    const { prefillComposer } = await import('../lib/composerBridge.svelte.js');
    setTimeout(() => prefillComposer(t('帮我建一个定时任务：')), 80);
  }

  // ---- 工作文件夹 / git（改文件夹：分支回到当前分支、关掉 worktree，重新探测是不是仓库）----
  let gitSeq = 0;
  async function loadGit() {
    git = null;
    if (f.agent !== 'claude') return;   // 分支 / worktree 只有 Claude 用
    const seq = ++gitSeq;
    try { const d = await api.routineGit(f.cwd || rt.home); if (seq === gitSeq) git = d; } catch { if (seq === gitSeq) git = { git: false }; }
  }
  function setCwd(p) {
    if ((p || '') === f.cwd) return;
    f.cwd = p || ''; f.branch = ''; f.worktree = false;
    loadGit();
  }
  async function browseFolder() {
    pop = null;
    if (hasNativePickDirectory()) {
      const dir = await nativePickDirectory(f.cwd || rt.home);
      if (dir) setCwd(dir);
      return;
    }
    pickOpen = true;
  }
  const folderOpts = $derived.by(() => {
    const seen = new Set();
    const key = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
    // 默认工作空间：Claude = 身份的默认工作空间；dimensio = 它设置里的工作空间（拉到了的话）
    const home = isDim && dimCfg?.workspace ? dimCfg.workspace : rt.home;
    const out = [{ id: '', label: t('默认工作空间'), desc: home }];
    seen.add(key(home));
    for (const p of projects) { if (seen.has(key(p.path))) continue; seen.add(key(p.path)); out.push({ id: p.path, label: tr(p.name) || folderName(p.path), desc: p.path }); }
    if (f.cwd && !seen.has(key(f.cwd))) out.push({ id: f.cwd, label: folderName(f.cwd), desc: f.cwd });
    return out;
  });
  const cwdLabel = $derived(f.cwd ? folderName(f.cwd) : t('默认工作空间'));
  const wtAvail = $derived(!!git?.git && git.worktreeOk !== false);

  // ---- 下拉（单例弹层；锚在触发按钮上下，放不下就翻面；align end = 右对齐）----
  // 弹层挪到 body 上（use:portal）：电脑上本页嵌在正文区，祖先的裁切 / transform 圈不住它。
  // 高度收进触发点这一侧剩下的空间（留出底部安全区）——以前固定 420，在屏幕下半截往下展开就探出屏幕底。
  const EDGE = 12;
  function openPop(e, key, { id = null, end = false, side = 'bottom', w = 220 } = {}) {
    e.stopPropagation();
    mlay = null;
    if (pop?.key === key && pop?.id === id) { pop = null; return; }
    const b = e.currentTarget.getBoundingClientRect();
    const vh = window.innerHeight;
    const roomBelow = vh - b.bottom - EDGE - 4, roomAbove = b.top - EDGE - 4;
    const up = side === 'top' ? roomAbove > 220 || roomAbove > roomBelow : roomBelow < 300 && roomAbove > roomBelow;
    const width = Math.min(Math.max(w, end ? 0 : b.width), window.innerWidth - 16);
    const x = end ? b.right - width : b.left;
    pop = { key, id, x: Math.max(8, Math.min(x, window.innerWidth - width - 8)), y: up ? vh - b.top + 4 : b.bottom + 4, w: width, up,
      h: Math.max(120, Math.min(440, Math.floor(up ? roomAbove : roomBelow))) };
  }
  // 模型 / 思考强度：就是输入栏那两个浮层（受控模式，fixed 贴着芯片展开、高度自己按剩余空间收）
  function openLayer(e, kind) {
    e.stopPropagation();
    pop = null;
    if (mlay?.kind === kind) { mlay = null; return; }
    const el = e.currentTarget;
    mlay = { kind, el, rect: rectOf(el) };
  }
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  // 关掉浮层后焦点回到触发的芯片上（浮层挪到了 body 末尾，不还回去键盘用户就迷路了）
  function closeLayer() { const el = mlay?.el; mlay = null; if (el?.isConnected) try { el.focus({ preventScroll: true }); } catch {} }
  $effect(() => { if (pop) return pushBackLayer(() => { pop = null; }); });
  $effect(() => (pop ? escLayer(() => { pop = null; }) : undefined));
  $effect(() => (mlay ? escLayer(closeLayer) : undefined));
  // 窗口尺寸变了（手机转屏、软键盘弹出）：普通下拉按旧坐标会错位，直接收起；模型 / 思考强度浮层按芯片现在的位置重新贴
  //（模型菜单里有搜索框，手机上点它弹出软键盘也算一次 resize，收起就没法搜了）
  $effect(() => {
    if (!pop && !mlay) return;
    const onResize = () => {
      pop = null;
      if (mlay) { if (mlay.el?.isConnected) mlay = { ...mlay, rect: rectOf(mlay.el) }; else mlay = null; }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
  function pick(fn) { fn(); pop = null; }
  const popRoutine = $derived(pop?.id ? rt.items.find((r) => r.id === pop.id) : null);

  function toggleDay(d) {
    const s = new Set(f.sched.days);
    if (s.has(d)) { if (s.size > 1) s.delete(d); } else s.add(d);
    f.sched.days = [...s].sort((a, b) => a - b);
  }
  const timeStr = $derived(`${String(f.sched.hour).padStart(2, '0')}:${String(f.sched.minute).padStart(2, '0')}`);
  function onTime(e) { const [h, m] = (e.target.value || '09:00').split(':').map(Number); f.sched.hour = h || 0; f.sched.minute = m || 0; }
  function onMinute(e) { f.sched.minute = Math.max(0, Math.min(59, Math.trunc(+e.target.value) || 0)); }
  const atStr = $derived.by(() => {
    if (!f.sched.at) return '';
    const d = new Date(f.sched.at), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  });
  function onAt(e) { const v = e.target.value; f.sched.at = v ? new Date(v).getTime() : 0; }
  // 时间 / 日期按钮：显示自己排的字（24 小时制、口语日期），系统选择器由盖在按钮上的透明 input 弹——
  // 触屏点它本来就会弹；鼠标点只会聚焦到某一段，这里补一句 showPicker() 把下拉打开
  function nativePick(e) {
    if (!matchMedia('(pointer: fine)').matches) return;
    try { e.currentTarget.showPicker?.(); } catch {}
  }
  const minuteStr = $derived(String(f.sched.minute).padStart(2, '0'));
  const atText = $derived(f.sched.at ? whenText(f.sched.at) : t('选择时间'));
  function setFreq(ty) {
    // 从自定义切回来时尽量沿用 cron 里的钟点（官方同款）
    if (f.sched.type === 'cron' && ty !== 'cron') {
      const m = f.sched.cron.trim().split(/\s+/);
      if (/^\d+$/.test(m[0] || '')) f.sched.minute = Math.min(59, +m[0]);
      if (/^\d+$/.test(m[1] || '')) f.sched.hour = Math.min(23, +m[1]);
    }
    if (ty === 'cron' && f.sched.type !== 'cron' && !['manual', 'once'].includes(f.sched.type)) {
      const s = schedOut();
      f.sched.cron = s.type === 'hourly' ? `${s.minute} * * * *` : `${s.minute} ${s.hour} * * ${s.type === 'weekdays' ? '1-5' : s.type === 'weekly' ? s.days.join(',') : '*'}`;
    }
    f.sched.type = ty;
    if (ty === 'once' && !f.sched.at) { const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); f.sched.at = d.getTime(); }
  }

  // 指令框跟着内容长高（官方 autosize，5 行起、300px 封顶后内部滚）
  function autosize(node) {
    const fit = () => { node.style.height = 'auto'; node.style.height = Math.min(300, Math.max(120, node.scrollHeight)) + 'px'; };
    fit(); node.addEventListener('input', fit);
    return { destroy() { node.removeEventListener('input', fit); } };
  }

  // ---- 保存 ----
  // 保存不了：点「创建 / 保存」时说清缺什么，并把焦点带到那一栏（按钮不置灰，手机上没有悬停提示可看）
  function focusBlocked() {
    const id = !f.name.trim() ? 'rt-name' : !f.prompt.trim() ? 'rt-prompt' : f.sched.type === 'cron' ? 'rt-cron' : '';
    const el = id && document.getElementById(id);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  async function save(e) {
    e?.preventDefault?.();
    if (busy) return;
    if (blocked) { tried = true; focusBlocked(); return; }
    busy = true; err = '';
    const vx = f.agent === 'vertex';
    const base = {
      name: f.name.trim(), description: f.description.trim(), prompt: f.prompt.trim(),
      agent: f.agent, model: f.model || null, effort: f.effort || null, search: vx && f.search,
      schedule: schedOut(), notify: f.notify,
    };
    // dimensio：厂商 + 型号（没选 = 它设置里的默认）、深度、运行档位、文件夹、会话方式；Claude 那几项（worktree / Fast / 项目对话）不带
    const body = isDim
      ? { ...base, provider: f.provider || null, model: f.provider ? f.model || null : null, cwd: f.cwd || '', permissionMode: f.permissionMode || '', sessionMode: f.sessionMode }
      : {
        ...base,
        ...(vx ? {} : {
          cwd: f.cwd || '', worktree: f.worktree && wtAvail, branch: f.worktree && wtAvail ? f.branch : '',
          permissionMode: f.permissionMode || '', fast: fastOk && f.fast, sessionMode: f.sessionMode,
          ...(projOk ? { shape: f.shape === 'project' ? 'project' : null } : {}),
        }),
      };
    try {
      const res = editing ? await api.updateRoutine({ id: editing, ...body }) : await api.createRoutine(body);
      await loadRoutines();
      snap = JSON.stringify(f);
      dlg = false;
      if (res?.routine?.id) { curId = res.routine.id; view = 'detail'; showAllPrompt = false; } else view = formBack;
    } catch (e2) { err = tr(String(e2?.body?.error || e2?.message || e2)); }
    busy = false;
  }

  // ---- 动作 ----
  const offline = () => (hostIsServer() ? t('连不上服务器，请重试') : t('连不上电脑，请重试'));
  async function toggleEnabled(r) {
    pop = null;
    const next = r.enabled === false;
    const i = rt.items.findIndex((x) => x.id === r.id);
    const prev = rt.items[i];
    if (i >= 0) rt.items[i] = { ...prev, enabled: next };   // 乐观切换（即时），失败回滚
    try {
      const res = await api.updateRoutine({ id: r.id, enabled: next });
      if (res && res.ok === false) throw res;
      loadRoutines();
    } catch (e) {
      if (i >= 0) rt.items[i] = prev;
      opErr = e?.body?.error ? tr(e.body.error) : next ? t('没能启用：{reason}', { reason: offline() }) : t('没能暂停：{reason}', { reason: offline() });
    }
  }
  async function runNow(r) {
    pop = null; opErr = '';
    try { await api.runRoutine(r.id); await loadRoutines(); }
    catch (e) { opErr = e?.body?.error ? tr(e.body.error) : t('运行失败：{reason}', { reason: offline() }); }
  }
  async function duplicate(r) {
    pop = null;
    try { const res = await api.duplicateRoutine(r.id); await loadRoutines(); if (res?.routine) openDetail(res.routine); }
    catch { opErr = t('复制失败：{reason}', { reason: offline() }); }
  }
  async function del(r) {
    pop = null;
    if (!(await uiConfirm(t('删除「{name}」？已经跑出来的会话会保留。', { name: r.name }), { okLabel: t('删除'), type: 'warning', danger: true }))) return;
    const prev = rt.items;
    rt.items = rt.items.filter((x) => x.id !== r.id);
    if (curId === r.id) { view = 'list'; curId = null; }
    try { const res = await api.deleteRoutine(r.id); if (res && res.ok === false) throw 0; }
    catch { rt.items = prev; opErr = t('删除失败：{reason}', { reason: offline() }); }
  }
  // 会话在哪个引擎那边：运行记录 / 在跑的那次自己带着 agent（任务后来换了引擎，旧记录照样打开得对）
  const openSessionId = (id, agent) => openRoutineSession(id, agent);
  const lastSessionAgent = (r) => {
    const run = (r.runs || []).find((x) => x.sessionId && x.sessionId === r.lastSessionId);
    return run ? run.agent || 'claude' : r.agent;
  };

  // 运行记录：状态 → 图标与右侧标签
  const runKind = (run, r) => (run.status === 'running' && liveOf(r)?.waiting ? 'wait' : run.status);
  const RUN_LABEL = { ok: () => '', error: () => t('失败'), stopped: () => t('已中断'), skipped: () => t('已跳过'), running: () => t('运行中'), wait: () => t('等你处理') };
  const runRight = (run, r) => { const k = runKind(run, r); return k === 'ok' ? (run.endedAt ? durText(run.endedAt - run.at) : '') : (RUN_LABEL[k] || (() => k))(); };
</script>

{#snippet clock(cls = 'clock')}
  <svg class={cls} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8" cy="8" r="5.5"/><line class="hh" x1="8" y1="8" x2="10" y2="9"/><line class="mh" x1="8" y1="8" x2="8" y2="5.5"/>
  </svg>
{/snippet}
{#snippet chev()}<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>{/snippet}
{#snippet backIc()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>{/snippet}
{#snippet closeIc()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>{/snippet}
{#snippet folderIc()}<svg class="ic12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>{/snippet}
{#snippet branchIc()}<svg class="ic12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3-5.5 4"/></svg>{/snippet}
{#snippet shieldIc()}<svg class="ic12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M8 2 3 4v4c0 3 2.2 5.2 5 6 2.8-.8 5-3 5-6V4z"/></svg>{/snippet}
{#snippet caret()}<svg class="caret-s" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 1.25 5 4.75l3.5-3.5"/></svg>{/snippet}
{#snippet infoIc()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6M8 5.2v.1" stroke-linecap="round"/></svg>{/snippet}
{#snippet calIc()}<svg class="ic14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/></svg>{/snippet}
{#snippet play()}<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l7.5-4.5z"/></svg>{/snippet}
{#snippet editIc()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 3.2a1.4 1.4 0 0 1 2 2L6 11.7l-2.7.7.7-2.7z"/></svg>{/snippet}
{#snippet trashIc()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2c.05.7.6 1.3 1.3 1.3h3.2c.7 0 1.25-.6 1.3-1.3l.6-8.2"/></svg>{/snippet}
{#snippet dots()}<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3.5" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="12.5" r="1.2"/></svg>{/snippet}
{#snippet searchIc()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>{/snippet}
{#snippet filterIc()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3"/></svg>{/snippet}
{#snippet sortIc()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v10M2.5 10.5 5 13l2.5-2.5M11 13V3M8.5 5.5 11 3l2.5 2.5"/></svg>{/snippet}
{#snippet sw(on, onclick, label, disabled = false, title = '')}
  <button type="button" class="sw" class:on role="switch" aria-checked={on} aria-label={label} {title} {disabled} {onclick}><span class="knob"></span></button>
{/snippet}
{#snippet section(title, body)}
  <section class="sec"><h2 class="sec-h">{title}</h2>{@render body()}</section>
{/snippet}

{#snippet formBody()}
  <!-- 名称 / 描述 / 指令框（输入栏同款：上面工具条放权限与模型、下面位置条放文件夹与 Worktree）/ 频率 / 运行。
       动作条在 formFoot：整页时常驻在底部，编辑对话框里贴在卡片底。 -->
  <form id="rt-form" class="form" onsubmit={save} novalidate>
    <p class="hint">{@render infoIc()}<span>{hostIsServer() ? t('定时任务在服务器上运行，服务器在线就会按时跑；你的手机和电脑不用开着。') : t('定时任务在这台电脑上运行，只在它开机联网时跑。')}</span></p>

    <div class="fld">
      <label class="lbl" for="rt-name">{t('名称')}</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input id="rt-name" class="inp" class:invalid={tried && !f.name.trim()} bind:value={f.name} maxlength="120" autocomplete="off"
        placeholder={t('每日代码回顾')} autofocus={!editing && finePointer} />
    </div>
    <div class="fld">
      <label class="lbl" for="rt-desc">{t('描述')}<span class="opt">{t('选填')}</span></label>
      <input id="rt-desc" class="inp" bind:value={f.description} maxlength="300" autocomplete="off" placeholder={t('回看昨天的提交，标出值得注意的地方')} />
    </div>

    {#if engineChoices.length > 1}
      <!-- 引擎：Claude / dimensio（品牌名不翻译） -->
      <div class="fld">
        <span class="lbl" id="rt-eng">{t('引擎')}</span>
        <div class="seg" role="radiogroup" aria-labelledby="rt-eng">
          {#each engineChoices as a (a)}<button type="button" role="radio" class:on={f.agent === a} aria-checked={f.agent === a} onclick={() => setEngine(a)}>{a === 'dimensio' ? 'dimensio' : 'Claude'}</button>{/each}
        </div>
      </div>
    {/if}

    <div class="fld">
      <label class="lbl" for="rt-prompt">{t('指令')}</label>
      <div class="ibox" class:invalid={tried && !!f.name.trim() && !f.prompt.trim()}>
        <textarea id="rt-prompt" class="ta" use:autosize bind:value={f.prompt} placeholder={t('看看过去 24 小时的提交：总结改了什么，指出有风险的写法或缺的测试，记下值得跟进的事。')}></textarea>
        <div class="tbar">
          <button type="button" class="fchip" class:set={!!f.permissionMode || (!isDim && f.shape === 'project')} aria-haspopup="menu" aria-expanded={pop?.key === 'perm'}
            onclick={(e) => openPop(e, 'perm', { w: 300 })}>{@render shieldIc()}<span class="chip-t">{chipPerm}</span>{@render caret()}</button>
          <span class="sp"></span>
          <!-- 模型 / 思考强度：Claude 是输入栏那两枚素文本芯片（点开同一个模型菜单和拉条面板）；dimensio 是它自己目录里的厂商与型号、那个型号的深度档 -->
          <button type="button" class="mchip" aria-haspopup="menu" aria-expanded={isDim ? pop?.key === 'dmodel' : mlay?.kind === 'model'} aria-label={t('模型：{name}', { name: chipModel })}
            onclick={(e) => (isDim ? openPop(e, 'dmodel', { end: true, w: 280 }) : openLayer(e, 'model'))}><span class="chip-t">{chipModel}</span>{#if !isDim && fastOk && f.fast}<span class="mchip-fast">&nbsp;· Fast</span>{/if}</button>
          <button type="button" class="mchip lvl" class:keep={isDim} aria-haspopup={isDim ? 'menu' : 'dialog'} aria-expanded={isDim ? pop?.key === 'deffort' : mlay?.kind === 'effort'} aria-label={t('思考强度：{name}', { name: chipEffort })}
            onclick={(e) => (isDim ? openPop(e, 'deffort', { end: true, w: 200 }) : openLayer(e, 'effort'))}><span class="chip-t">{chipEffort}</span></button>
        </div>
        <div class="locbar">
          <button type="button" class="fchip" class:set={!!f.cwd} title={f.cwd || (isDim && dimCfg?.workspace) || rt.home} aria-haspopup="menu" aria-expanded={pop?.key === 'folder'}
            onclick={(e) => openPop(e, 'folder', { side: 'top', w: 300 })}>{@render folderIc()}<span class="chip-t">{cwdLabel}</span>{@render caret()}</button>
          {#if git?.git && !isDim}
            <button type="button" class="fchip" class:set={!!f.branch} disabled={!f.worktree} aria-haspopup="menu" aria-expanded={pop?.key === 'branch'}
              title={f.worktree ? '' : t('打开 Worktree 后可以选从哪个分支切')}
              onclick={(e) => openPop(e, 'branch', { side: 'top', w: 240 })}>{@render branchIc()}<span class="chip-t mono">{f.branch || t('当前分支')}</span>{@render caret()}</button>
          {/if}
          <span class="sp"></span>
          {#if !isDim}
            <label class="wt" class:dim={!wtAvail} title={!git ? '' : !git.git ? t('这个文件夹不是 git 仓库') : git.worktreeOk === false ? t('这个文件夹本身就是一个 worktree') : t('每次运行先切一个新分支和工作目录，改动不碰你手上的检出')}>
              <span>Worktree</span>{@render sw(f.worktree && wtAvail, () => (f.worktree = !f.worktree), 'Worktree', !wtAvail)}
            </label>
          {/if}
        </div>
      </div>
      {#if isDim}
        {#if rt.dim.phase === 'down'}<p class="note bad">{t('dimensio 的型号没读出来：{reason}', { reason: rt.dim.why })} <button type="button" class="link" onclick={() => loadDimCatalog({ force: true })}>{t('重试')}</button></p>{/if}
        {#if dimPermEff === 'plan'}<p class="note">{t('「{mode}」档会停在计划上等你批准，会话里亮「待处理」；想全程自己跑完，选「{auto}」。', { mode: dimModeLabel('plan'), auto: dimModeLabel('auto') })}</p>{/if}
      {:else if asks(permEff)}<p class="note">{t('「{mode}」模式下遇到要你批准的操作会停下来等，会话里亮「待回答」；想全程自己跑完，选「自动」。', { mode: modeLabel(permEff) })}</p>{/if}
    </div>

    <div class="fld">
      <span class="lbl" id="rt-freq">{t('频率')}</span>
      <div class="seg full" role="radiogroup" aria-labelledby="rt-freq">
        {#each FREQS as [id, lbl]}<button type="button" role="radio" class:on={f.sched.type === id} aria-checked={f.sched.type === id} onclick={() => setFreq(id)}>{lbl()}</button>{/each}
      </div>
      {#if f.sched.type !== 'manual'}
        <div class="when">
          {#if f.sched.type === 'weekly'}
            <div class="days" role="group" aria-label={t('星期')}>
              {#each WEEK as d}<button type="button" class="day" class:on={f.sched.days.includes(d)} aria-pressed={f.sched.days.includes(d)} onclick={() => toggleDay(d)}>{wdName(d, isEn() ? 'short' : 'narrow')}</button>{/each}
            </div>
          {/if}
          {#if ['daily', 'weekdays', 'weekly'].includes(f.sched.type)}
            <span class="tpick">{@render clock()}<span class="tpick-v">{hm(f.sched.hour, f.sched.minute)}</span>{@render caret()}
              <input type="time" aria-label={t('时间')} value={timeStr} onchange={onTime} onclick={nativePick} /></span>
          {:else if f.sched.type === 'hourly'}
            <span class="when-t">{t('每小时的第')}</span>
            <input class="inp num" type="number" inputmode="numeric" min="0" max="59" value={minuteStr} onchange={onMinute} aria-label={t('分钟')} />
            <span class="when-t">{t('分钟')}</span>
          {:else if f.sched.type === 'once'}
            <span class="tpick">{@render calIc()}<span class="tpick-v">{atText}</span>{@render caret()}
              <input type="datetime-local" aria-label={t('运行时间')} value={atStr} onchange={onAt} onclick={nativePick} /></span>
          {:else if f.sched.type === 'cron'}
            <input id="rt-cron" class="inp mono cron" class:invalid={!!cronErr} dir="ltr" bind:value={f.sched.cron} placeholder="0 9 * * *"
              spellcheck="false" autocapitalize="off" autocomplete="off" aria-label={t('cron 表达式')} />
          {/if}
        </div>
      {/if}
      <p class="note" class:bad={!!cronErr}>
        {#if f.sched.type === 'manual'}{t('不按时间自动跑，只在你点「立即运行」时跑。')}
        {:else if cronErr}{cronErr}
        {:else if nextPreview}<span class="nx">{t('下次运行：{when}', { when: nextPreview })}</span> · <span class="nw">{t('时间按服务器时区（{tz}）', { tz: tzLabel(rt.tz) })}</span>
        {:else if f.sched.type === 'once'}{t('选一个以后的时间。')}{/if}
      </p>
      {#if f.sched.type === 'cron' && !cronErr}<p class="note">{t('5 段：分 时 日 月 周，只认数字（周日写 0），最多每小时一次。')}</p>{/if}
    </div>

    <div class="fld">
      <span class="lbl">{t('运行')}</span>
      <div class="rows">
        <div class="r"><span class="r-k">{t('会话方式')}<span class="r-sub">{f.sessionMode === 'continue' ? t('每次都在同一个会话里接着往下聊，记得上回做过什么') : t('每次开一个干净的新会话')}</span></span>
          <div class="seg sm" role="radiogroup" aria-label={t('会话方式')}>
            <button type="button" role="radio" class:on={f.sessionMode === 'new'} aria-checked={f.sessionMode === 'new'} onclick={() => (f.sessionMode = 'new')}>{t('每次新会话')}</button>
            <button type="button" role="radio" class:on={f.sessionMode === 'continue'} aria-checked={f.sessionMode === 'continue'} onclick={() => (f.sessionMode = 'continue')}>{t('接着上次')}</button>
          </div>
        </div>
        <div class="r"><span class="r-k">{t('跑完通知我')}<span class="r-sub">{t('每次运行结束，在打开着的 bridge 里提醒你结果')}</span></span>{@render sw(f.notify, () => (f.notify = !f.notify), t('跑完通知我'))}</div>
      </div>
    </div>
  </form>
{/snippet}

{#snippet formFoot()}
  {@const msg = err || (tried ? blocked : '')}
  <div class="foot">
    {#if msg}<p class="foot-msg" role="alert">{msg}</p>{/if}
    <div class="foot-btns">
      <button type="button" class="btn ghost" disabled={busy} onclick={leaveForm}>{t('取消')}</button>
      <button type="submit" form="rt-form" class="btn primary" class:dim={!!blocked} disabled={busy}>{busy ? t('保存中…') : (editing ? t('保存') : t('创建'))}</button>
    </div>
  </div>
{/snippet}

{#if ui.routinesOpen}
<section class="rt" class:embedded class:wide class:en={isEn()} bind:clientWidth={pageW}>
  {#if view === 'list'}
    <!-- ═══ 列表页 ═══ -->
    <div class="scroll">
      <header class="ph">
        <div class="wrap ph-in">
          {#if !embedded}<button class="ibtn" aria-label={t('返回')} onclick={close}>{@render backIc()}</button>{/if}
          {#if !(searchOpen && !wide)}<h1 class="title">{t('定时任务')}</h1>{/if}
          <div class="ctrls" class:searching={searchOpen}>
            {#if searchOpen}
              <label class="search">
                {@render searchIc()}
                <!-- svelte-ignore a11y_autofocus -->
                <input bind:value={q} placeholder={t('搜索定时任务…')} aria-label={t('搜索定时任务')} autofocus
                  onkeydown={(e) => { if (e.key === 'Escape') { q = ''; searchOpen = false; } }} onblur={() => { if (!q.trim()) searchOpen = false; }} />
                {#if q}<button class="x" aria-label={t('清除')} onclick={() => (q = '')}>{@render closeIc()}</button>{/if}
              </label>
            {:else if rt.items.length}
              <button class="ibtn" aria-label={t('搜索定时任务')} title={t('搜索')} onclick={() => (searchOpen = true)}>{@render searchIc()}</button>
            {/if}
            {#if !(searchOpen && !wide) && rt.items.length}
              <button class="ibtn" class:pressed={filtering} aria-label={t('筛选定时任务')} title={t('筛选')} onclick={(e) => openPop(e, 'filter', { end: true, w: 220 })}>{@render filterIc()}</button>
              <button class="ibtn" aria-label={t('排序')} title={t('排序')} onclick={(e) => openPop(e, 'sort', { end: true, w: 220 })}>{@render sortIc()}</button>
            {/if}
            {#if !(searchOpen && !wide)}
              <button class="btn primary" class:icon={!wide} aria-label={t('新建任务')} onclick={(e) => openPop(e, 'new', { end: true, w: 260 })}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>{#if wide}{t('新建任务')}{/if}
              </button>
            {/if}
            {#if embedded}<button class="ibtn" aria-label={t('关闭')} title={t('关闭')} onclick={close}>{@render closeIc()}</button>{/if}
          </div>
        </div>
      </header>

      <div class="wrap content">
        {#if rt.items.length}
          <div class="banner">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6M8 5.2v.1" stroke-linecap="round"/></svg>
            <span>{hostIsServer() ? t('定时任务在服务器上运行，服务器在线就会按时跑；你的手机和电脑不用开着。') : t('定时任务在这台电脑上运行，只在它开机联网时跑。')}</span>
          </div>
        {/if}
        {#if opErr}<div class="err">{opErr}<button class="x" aria-label={t('关闭')} onclick={() => (opErr = '')}>{@render closeIc()}</button></div>{/if}

        {#if !rt.loaded && rt.loading}
          <ul class="grid" aria-hidden="true">{#each [0, 1, 2, 3] as i (i)}<li><div class="tcard skel"><span></span><span></span><span></span></div></li>{/each}</ul>
        {:else if rt.err && !rt.items.length}
          <div class="state">
            <svg class="state-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"><path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1" stroke-linecap="round"/></svg>
            <div class="state-t">{t('定时任务没加载出来')}</div>
            <div class="state-d">{hostIsServer() ? t('连不上服务器。') : t('连不上电脑。')}</div>
            <button class="btn ghost sm" disabled={rt.loading} onclick={loadRoutines}>{t('重试')}</button>
          </div>
        {:else if !rt.items.length}
          <div class="state">
            <div class="empty-ic">{@render clock('clock huge')}</div>
            <div class="state-d">{t('还没有定时任务。')}</div>
            <div class="state-d small">{t('比如每天早上汇总新提交、每小时检查一个目录、每周一出一份周报。')}</div>
            <div class="empty-acts">
              <button class="btn primary" onclick={openNew}>{t('新建任务')}</button>
              <button class="btn ghost" onclick={createWithClaude}>{t('让 Claude 帮我建')}</button>
            </div>
          </div>
        {:else if !shown.length}
          <div class="state">
            {#if doneHidden && !q.trim() && !filtering}
              <div class="state-d">{t('有 {n} 个已完成的一次性任务被隐藏了。', { n: doneHidden })}</div>
              <button class="btn ghost sm" onclick={() => (showDone = true)}>{t('显示已完成')}</button>
            {:else}
              <div class="state-d">{q.trim() && filtering ? t('没有符合搜索和筛选条件的定时任务。') : q.trim() ? t('没有和「{q}」匹配的定时任务。', { q: q.trim() }) : t('没有符合筛选条件的定时任务。')}</div>
              <button class="btn ghost sm" onclick={clearFilters}>{t('清除')}</button>
            {/if}
          </div>
        {:else}
          <ul class="grid" aria-label={t('定时任务')}>
            {#each shown as r (r.id)}
              {@const ld = liveDot(r)}
              <li>
                <div class="tcard" class:off={r.enabled === false} class:menu-on={pop?.key === 'card' && pop?.id === r.id}>
                  <div class="t-row">
                    <button class="t-name" onclick={() => openDetail(r)}>{r.name || t('未命名任务')}</button>
                    {#if ld}<span class="t-live {ld}" title={liveDotLabel(ld)}><span class="dot"></span>{liveDotLabel(ld)}</span>{/if}
                  </div>
                  {#if cardDesc(r)}<p class="t-desc">{cardDesc(r)}</p>{/if}
                  <div class="t-foot">
                    <span class="t-st"><span>{stateWord(r)}</span><span class="t-sch">{schedText(r.schedule)}</span>{#if r.agent === 'dimensio'}<span class="t-sch t-eng">dimensio</span>{/if}</span>
                    {#if r.agent === 'vertex'}<span class="t-proj">{t('Gemini（已下线）')}</span>
                    {:else}<span class="t-proj" title={r.cwd || rt.home}>{@render folderIc()}<span>{r.cwd ? folderName(r.cwd) : t('默认工作空间')}</span></span>{/if}
                  </div>
                  <button class="t-more" aria-label={t('{name} 的更多操作', { name: r.name })} onclick={(e) => openPop(e, 'card', { id: r.id, end: true, w: 180 })}>{@render dots()}</button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>

  {:else if (view === 'detail') && cur}
    <!-- ═══ 详情页：大标题 + 描述 + 状态行；设置收进一张键值卡；右栏（窄屏在下）指令与运行记录 ═══ -->
    {@const lv = liveOf(cur)}
    {@const mAt = missedAt(cur)}
    {@const vx = cur.agent === 'vertex'}
    {@const dm = cur.agent === 'dimensio'}
    <header class="bar">
      <button class="ibtn" aria-label={t('返回')} onclick={() => (view = 'list')}>{@render backIc()}</button>
      <span class="sp"></span>
      <div class="bar-acts">
        <button class="ibtn" aria-label={t('编辑')} title={t('编辑')} onclick={() => openEdit(cur)}>{@render editIc()}</button>
        <button class="ibtn" aria-label={t('删除')} title={t('删除')} onclick={() => del(cur)}>{@render trashIc()}</button>
        <button class="ibtn" aria-label={t('更多操作')} title={t('更多操作')} onclick={(e) => openPop(e, 'more', { end: true, w: 200 })}>{@render dots()}</button>
        <button class="btn primary sm" disabled={running(cur)} onclick={() => runNow(cur)}>{#if running(cur)}<span class="spin"></span>{t('运行中')}{:else}{@render play()}{t('立即运行')}{/if}</button>
        {#if embedded}<button class="ibtn" aria-label={t('关闭')} title={t('关闭')} onclick={close}>{@render closeIc()}</button>{/if}
      </div>
    </header>
    <div class="scroll">
      <div class="dwrap">
        {#if opErr}<div class="err">{opErr}<button class="x" aria-label={t('关闭')} onclick={() => (opErr = '')}>{@render closeIc()}</button></div>{/if}
        {#if lv?.waiting}
          <div class="banner warn">
            <span>{t('这次运行停在一个需要你批准或回答的地方。')}</span>
            <button class="btn ghost sm" onclick={() => openSessionId(lv.sessionId, lv.agent)}>{t('去处理')}</button>
          </div>
        {:else if running(cur) && lv?.sessionId}
          <div class="banner">
            <span class="spin"></span><span>{t('正在运行。')}</span>
            <button class="btn ghost sm" onclick={() => openSessionId(lv.sessionId, lv.agent)}>{t('打开会话')}</button>
          </div>
        {/if}
        <div class="dhead">
          <h1 class="dtitle">{cur.name || t('未命名任务')}</h1>
          {#if cur.description}<p class="dlead">{cur.description}</p>{/if}
          <div class="status">
            {#if cur.schedule?.type !== 'manual' && !isDone(cur)}{@render sw(cur.enabled !== false, () => toggleEnabled(cur), cur.enabled === false ? t('启用定时任务') : t('暂停定时任务'))}{/if}
            <span class="badge" class:off={cur.enabled === false}>{#if cur.enabled !== false && !isDone(cur)}<svg class="ok-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="m5.5 8.2 1.7 1.7 3.3-3.6"/></svg>{/if}{isDone(cur) ? t('已运行') : stateWord(cur)}</span>
            {#if mAt}<span class="fn warn-t">{t('错过了 {when}（服务器当时没在运行）', { when: whenText(mAt) })}</span>
            {:else if cur.enabled !== false && cur.nextRun}<span class="fn">{cur.schedule?.type === 'once' ? t('运行于：{when}', { when: whenText(cur.nextRun) }) : t('下次运行：{when}', { when: whenText(cur.nextRun) })}</span>{/if}
          </div>
        </div>
        <div class="dgrid">
          <div class="dcol">
            <dl class="kv">
              <div class="kv-r"><dt>{t('重复')}</dt><dd><span>{schedText(cur.schedule)}</span>{#if cur.schedule?.type !== 'manual'}<span class="kv-sub">{t('时间按服务器时区（{tz}）', { tz: tzLabel(rt.tz) })}</span>{/if}</dd></div>
              {#if dm || rt.engines.length > 1}<div class="kv-r"><dt>{t('引擎')}</dt><dd><span>{dm ? 'dimensio' : vx ? 'Gemini' : 'Claude'}</span></dd></div>{/if}
              {#if dm}
                <!-- dimensio：型号 · 深度（目录没拉到时只写「dimensio 默认」）；运行档位 -->
                <div class="kv-r"><dt>{t('模型')}</dt><dd><span>{dimModelOf(cur.provider, cur.model)}{#if rt.dim.phase === 'ready' || cur.effort}{' · ' + dimEffortOf(cur.provider, cur.model, cur.effort)}{/if}</span></dd></div>
                <div class="kv-r"><dt>{t('权限')}</dt><dd><span>{dimPermText(cur.permissionMode)}</span><span class="kv-sub">{(cur.permissionMode || dimCfg?.permissionMode) === 'plan' ? t('会停在计划上等你批准') : dimModeDesc(cur.permissionMode || dimCfg?.permissionMode || 'auto')}</span></dd></div>
              {:else}
                <div class="kv-r"><dt>{t('模型')}</dt><dd><span>{vx ? engineText(cur) : nameOf(caps.data?.claude?.models, cur.model || defModel)} · {effortText(cur)}{#if cur.fast}{' · Fast'}{/if}</span></dd></div>
              {/if}
              {#if !vx}
                {#if !dm}<div class="kv-r"><dt>{t('权限')}</dt><dd><span>{permText(cur.permissionMode, cur.shape)}</span><span class="kv-sub">{asks(cur.permissionMode || permDefault) ? t('要批准的操作会停下来等你') : modeDesc(cur.permissionMode || permDefault)}</span></dd></div>{/if}
                <div class="kv-r"><dt>{t('文件夹')}</dt><dd>
                  <span class="kv-ic" title={cur.cwd || rt.home}>{@render folderIc()}<span class:mono={!!cur.cwd}>{cur.cwd ? folderName(cur.cwd) : t('默认工作空间')}</span></span>
                  {#if cur.worktree}<span class="kv-sub kv-ic">{@render branchIc()}<span>{cur.branch ? t('每次从 {b} 切 worktree', { b: cur.branch }) : t('每次切新 worktree')}</span></span>{/if}
                </dd></div>
                <div class="kv-r"><dt>{t('会话方式')}</dt><dd>
                  <span>{cur.sessionMode === 'continue' ? t('接着上次的会话') : t('每次新会话')}</span>
                  {#if cur.sessionMode === 'continue' && cur.threadSessionId}<button class="link kv-sub" onclick={() => openSessionId(cur.threadSessionId, cur.agent)}>{t('打开那个会话')}</button>{/if}
                </dd></div>
              {/if}
              <div class="kv-r"><dt>{t('通知')}</dt><dd><span>{cur.notify ? t('每次跑完通知我') : t('不通知')}</span></dd></div>
            </dl>
          </div>
          <div class="dcol">
            {#snippet instrB()}
              {@const long = (cur.prompt || '').split('\n').length > 3 || (cur.prompt || '').length > 270}
              <div class="instr-box">
                <div class="instr" class:clamp={long && !showAllPrompt}>{cur.prompt}</div>
                {#if long}<button class="btn ghost xs" onclick={() => (showAllPrompt = !showAllPrompt)}>{showAllPrompt ? t('收起') : t('显示全部')}<span class="caret" class:up={showAllPrompt}>{@render chev()}</span></button>{/if}
              </div>
            {/snippet}
            {@render section(t('指令'), instrB)}
            {#snippet histB()}
              {#if !(cur.runs || []).length}
                <p class="fn empty-runs">{cur.lastRun ? t('上次运行：{when}（更早的记录没有保存）', { when: whenText(cur.lastRun) }) : t('还没有运行过。')}</p>
              {:else}
                <div class="hist">
                  {#each cur.runs as run (run.id)}
                    {@const k = runKind(run, cur)}
                    <button class="h-row" disabled={!run.sessionId} title={run.preview ? tr(run.preview) : ''} onclick={() => openSessionId(run.sessionId, run.agent)}>
                      <span class="h-ic {k}">
                        {#if k === 'running'}<span class="spin"></span>
                        {:else if k === 'error'}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="m6 6 4 4M10 6l-4 4"/></svg>
                        {:else if k === 'ok'}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="m5.5 8.2 1.7 1.7 3.3-3.6"/></svg>
                        {:else}<span class="hollow"></span>{/if}
                      </span>
                      <span class="h-when">{whenText(run.at)}</span>
                      {#if run.trigger === 'manual'}<span class="h-tag">{t('手动')}</span>{/if}
                      <span class="h-pv">{run.preview ? tr(run.preview) : ''}</span>
                      <span class="h-st {k}">{runRight(run, cur)}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            {/snippet}
            {@render section(t('运行记录'), histB)}
          </div>
        </div>
      </div>
    </div>

  {:else if view === 'form'}
    <!-- ═══ 新建（整页，720 居中）/ 窄屏编辑 ═══ -->
    <header class="bar">
      <button class="ibtn" aria-label={t('返回')} onclick={leaveForm}>{@render backIc()}</button>
      <span class="bar-t">{editing ? t('编辑定时任务') : t('新建定时任务')}</span>
      {#if embedded}<div class="bar-acts"><button class="ibtn" aria-label={t('关闭')} title={t('关闭')} onclick={close}>{@render closeIc()}</button></div>{/if}
    </header>
    <div class="scroll"><div class="fwrap">{@render formBody()}</div></div>
    <div class="fbar"><div class="fbar-in">{@render formFoot()}</div></div>
  {/if}

  {#if dlg}
    <!-- 宽屏编辑：640 对话框（官方 Edit scheduled task） -->
    <div class="dlg-bd" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) leaveForm(); }}>
      <div class="dlg" role="dialog" aria-modal="true" aria-label={t('编辑定时任务')}>
        <div class="dlg-h"><span>{t('编辑定时任务')}</span><button class="ibtn" aria-label={t('关闭')} onclick={leaveForm}>{@render closeIc()}</button></div>
        <div class="dlg-b">{@render formBody()}</div>
        <div class="dlg-f">{@render formFoot()}</div>
      </div>
    </div>
  {/if}

  <!-- 模型 / 思考强度：输入栏那两个浮层的受控模式，挪到 body 上贴着芯片展开 -->
  {#if mlay}
    <div class="rt-layer" use:portal use:layerFocus>
      {#if mlay.kind === 'model'}
        <ModelPicker anchor={mlay.rect} value={curModel} onpick={pickModel} onClose={closeLayer} filter={officialOnly}
          fast={f.fast} onfast={(v) => (f.fast = v)} />
      {:else}
        <EffortPanel anchor={mlay.rect} model={curModel} value={f.effort || ''} onpick={(id) => (f.effort = id || null)} onClose={closeLayer}
          showUltracode={false} />
      {/if}
    </div>
  {/if}

  <!-- 单例下拉（挪到 body 上；高度收进触发点这一侧的剩余空间） -->
  {#if pop}
    <div class="rt-layer" use:portal>
    <button class="pop-bd" aria-label={t('关闭')} tabindex="-1" onclick={() => (pop = null)}></button>
    <div class="pop" role="menu" style:left={pop.x + 'px'} style:min-width={pop.w + 'px'} style:max-height={pop.h + 'px'}
      style:top={pop.up ? 'auto' : pop.y + 'px'} style:bottom={pop.up ? pop.y + 'px' : 'auto'} class:up={pop.up}>
      {#if pop.key === 'new'}
        <button class="mi" onclick={createWithClaude}><span class="mi-t">{t('让 Claude 帮我建')}</span><span class="mi-d">{t('开一个新对话，说说想定时做什么')}</span></button>
        <button class="mi" onclick={() => pick(openNew)}><span class="mi-t">{t('手动设置')}</span><span class="mi-d">{t('自己填名称、指令和频率')}</span></button>
      {:else if pop.key === 'filter'}
        <div class="mi-h">{t('频率')}</div>
        {#each [['all', t('全部')], ['recurring', t('循环')], ['once', t('一次性')], ['manual', t('仅手动')]] as [id, l]}<button class="mi chk" class:sel={fSched === id} onclick={() => pick(() => (fSched = id))}><span class="mi-t">{l}</span></button>{/each}
        <div class="mi-sep"></div>
        <div class="mi-h">{t('状态')}</div>
        {#each [['all', t('全部')], ['on', t('启用中')], ['off', t('已暂停')]] as [id, l]}<button class="mi chk" class:sel={fStatus === id} onclick={() => pick(() => (fStatus = id))}><span class="mi-t">{l}</span></button>{/each}
      {:else if pop.key === 'sort'}
        {#each [['next', t('下次运行')], ['name', t('名称')], ['recent', t('最近运行')]] as [id, l]}<button class="mi chk" class:sel={sort === id} onclick={() => pick(() => (sort = id))}><span class="mi-t">{l}</span></button>{/each}
        <div class="mi-sep"></div>
        <button class="mi chk" class:sel={showDone} onclick={() => (showDone = !showDone)}><span class="mi-t">{t('显示已完成')}</span>{#if rt.items.filter(isDone).length}<span class="mi-n">{rt.items.filter(isDone).length}</span>{/if}</button>
      {:else if pop.key === 'card' && popRoutine}
        {@const r = popRoutine}
        <button class="mi" disabled={running(r)} onclick={() => runNow(r)}><span class="mi-t">{t('立即运行')}</span></button>
        {#if r.schedule?.type !== 'manual' && !isDone(r)}<button class="mi" onclick={() => toggleEnabled(r)}><span class="mi-t">{r.enabled === false ? t('启用') : t('暂停')}</span></button>{/if}
        <button class="mi" onclick={() => openEdit(r)}><span class="mi-t">{t('编辑')}</span></button>
        <button class="mi" onclick={() => duplicate(r)}><span class="mi-t">{t('复制')}</span></button>
        <div class="mi-sep"></div>
        <button class="mi danger" onclick={() => del(r)}><span class="mi-t">{t('删除')}</span></button>
      {:else if pop.key === 'more' && cur}
        <button class="mi" onclick={() => duplicate(cur)}><span class="mi-t">{t('复制')}</span></button>
        {#if cur.lastSessionId}<button class="mi" onclick={() => { pop = null; openSessionId(cur.lastSessionId, lastSessionAgent(cur)); }}><span class="mi-t">{t('打开最近一次的会话')}</span></button>{/if}
      {:else if pop.key === 'folder'}
        {#each folderOpts as o (o.id)}
          <button class="mi chk" class:sel={f.cwd === o.id} onclick={() => pick(() => setCwd(o.id))}><span class="mi-t">{o.label}</span><span class="mi-d mono">{o.desc}</span></button>
        {/each}
        <div class="mi-sep"></div>
        <button class="mi" onclick={browseFolder}><span class="mi-t">{t('选择其他文件夹…')}</span></button>
      {:else if pop.key === 'branch' && git}
        <button class="mi chk" class:sel={!f.branch} onclick={() => pick(() => (f.branch = ''))}><span class="mi-t">{t('当前分支')}</span><span class="mi-d mono">{git.branch || 'HEAD'}</span></button>
        {#each git.branches || [] as b}<button class="mi chk" class:sel={f.branch === b} onclick={() => pick(() => (f.branch = b))}><span class="mi-t mono">{b}</span></button>{/each}
        {#if !(git.branches || []).length}<div class="mi-empty">{t('没有分支')}</div>{/if}
      {:else if pop.key === 'perm' && isDim}
        <!-- dimensio 的运行档位（全权只给主机身份，rt.dimModes 由服务端按身份裁好） -->
        <button class="mi chk" class:sel={!f.permissionMode} onclick={() => pick(() => (f.permissionMode = ''))}><span class="mi-t">{dimPermText('')}</span><span class="mi-d">{t('跟着 设置 › dimensio 里的默认运行档位走')}</span></button>
        {#each rt.dimModes as m}<button class="mi chk" class:sel={f.permissionMode === m} onclick={() => pick(() => (f.permissionMode = m))}><span class="mi-t">{dimModeLabel(m)}</span><span class="mi-d">{m === 'plan' ? t('{desc}无人值守时会停在计划上等你批准。', { desc: dimModeDesc(m) }) : dimModeDesc(m)}</span></button>{/each}
      {:else if pop.key === 'dmodel'}
        <!-- dimensio 的厂商与型号（它自己的目录，含自定义服务；只列能用的） -->
        <button class="mi chk" class:sel={!f.provider} onclick={() => pick(() => pickDimModel(null, null))}><span class="mi-t">{t('设置默认（{mode}）', { mode: dimCfg ? dimModelText(dimCfg.provider, dimCfg.model) : 'dimensio' })}</span><span class="mi-d">{t('跟着 设置 › dimensio 里的默认型号走')}</span></button>
        {#if rt.dim.phase === 'ready'}
          {#each dimProviders() as p (p.id)}
            <div class="mi-sep"></div>
            <div class="mi-h">{vendorName(p)}</div>
            {#each p.models as m (m.id)}
              <button class="mi chk" class:sel={f.provider === p.id && f.model === m.id} onclick={() => pick(() => pickDimModel(p.id, m.id))}><span class="mi-t">{tr(m.label || m.id)}</span>{#if m.note}<span class="mi-d">{tr(m.note)}</span>{/if}</button>
            {/each}
          {/each}
        {:else if rt.dim.phase === 'down'}
          <div class="mi-empty">{rt.dim.why}</div>
          <button class="mi" onclick={() => loadDimCatalog({ force: true })}><span class="mi-t">{t('重试')}</span></button>
        {:else}
          <div class="mi-empty">{t('正在读取 dimensio 的型号…')}</div>
        {/if}
      {:else if pop.key === 'deffort'}
        <button class="mi chk" class:sel={!f.effort} onclick={() => pick(() => (f.effort = null))}><span class="mi-t">{t('默认（{name}）', { name: dimEffortOf(f.provider, f.model, null) })}</span></button>
        {#each dimEffortList as e (e.id)}<button class="mi chk" class:sel={f.effort === e.id} onclick={() => pick(() => (f.effort = e.id))}><span class="mi-t">{e.name}</span></button>{/each}
        {#if !dimEffortList.length}<div class="mi-empty">{dimLoading ? t('正在读取 dimensio 的型号…') : t('这个型号没有可选的思考深度')}</div>{/if}
      {:else if pop.key === 'perm'}
        <button class="mi chk" class:sel={!f.permissionMode} onclick={() => pick(() => (f.permissionMode = ''))}><span class="mi-t">{t('设置默认（{mode}）', { mode: modeLabel(permDefault) })}</span><span class="mi-d">{t('跟着 设置 › Claude 里的默认权限模式走')}</span></button>
        {#each rt.permissionModes as m}<button class="mi chk" class:sel={f.permissionMode === m} onclick={() => pick(() => (f.permissionMode = m))}><span class="mi-t">{modeLabel(m)}</span><span class="mi-d">{asks(m) ? t('{desc}；无人值守时会停下来等你', { desc: modeDesc(m) }) : modeDesc(m)}</span></button>{/each}
        {#if projOk}
          <!-- 以项目对话运行：和上面那档同时选（那档就是讨论串权限）；配「接着上次的会话」就是一个长期挂着的项目 -->
          <div class="mi-sep"></div>
          <button class="mi chk" class:sel={f.shape === 'project'} onclick={() => pick(() => (f.shape = f.shape === 'project' ? '' : 'project'))}><span class="mi-t">{t('以项目对话运行')}</span><span class="mi-d">{t('协调者收到指令后自己开讨论串去做；配「接着上次的会话」就是一个长期挂着的项目')}</span></button>
        {/if}
      {/if}
    </div>
    </div>
  {/if}
</section>
{/if}

{#if pickOpen}
  <ProjectPicker title={t('选择工作文件夹')} hint={t('把文件夹拖进底栏，任务就在它里面运行')} preferPath={f.cwd || rt.home}
    onPick={(p) => { setCwd(p); pickOpen = false; }} onClose={() => (pickOpen = false)} />
{/if}

<style>
  /* 尺寸照官方 comfortable 档（规格 §1）：正文 14/20、脚注 13、控件 32、圆角 8 / 卡片 12、间距 6/8/12/16/24。
     颜色走 claude.ai 设置对话框那套令牌（app.css --st-*）：alpha-1 ≈ --st-hover、alpha-2 ≈ --st-sel、alpha-3 ≈ --st-line。 */
  .rt { position: fixed; inset: 0; z-index: 80; background: var(--bg); color: var(--text); display: flex; flex-direction: column;
    font-size: 14px; line-height: 20px; animation: rtIn .2s var(--ea-out, ease); }
  .rt.embedded { position: absolute; z-index: 40; }
  @keyframes rtIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .sp { flex: 1; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; scrollbar-gutter: stable; }
  .wrap { max-width: 1024px; margin: 0 auto; width: 100%; padding: 0 16px; }
  /* 宽窄按本页自己的宽度（.wide = 页宽 ≥ 760，见 pageW）而不是视口：电脑上嵌在正文区，宽度随侧栏 / 工作台变 */
  .wide .wrap { padding: 0 32px; }

  /* 图标按钮 / 按钮 */
  .ibtn { width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--st-text2, var(--serif)); flex: none; }
  .ibtn :global(svg) { width: 16px; height: 16px; }
  .ibtn:hover:not(:disabled), .ibtn.pressed { background: var(--st-hover); color: var(--text); }
  .ibtn:disabled { opacity: .35; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 8px; font-size: 14px; font-weight: 500; white-space: nowrap; border: 0; transition: background .15s, opacity .15s; }
  .btn :global(svg) { width: 14px; height: 14px; flex: none; }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); }
  .btn.primary:hover:not(:disabled) { opacity: .88; }
  .btn.ghost { box-shadow: inset 0 0 0 1px var(--st-line); color: var(--text); background: transparent; }
  .btn.ghost:hover:not(:disabled) { background: var(--st-hover); }
  .btn:disabled { opacity: .4; }
  .btn.sm { height: 28px; padding: 0 10px; font-size: 13px; }
  .btn.xs { height: 24px; padding: 0 8px; font-size: 12.5px; gap: 2px; align-self: flex-start; box-shadow: none; color: var(--st-text2, var(--serif)); }
  .btn.icon { width: 32px; padding: 0; }
  .caret { display: inline-flex; transition: transform .2s; } .caret.up { transform: rotate(180deg); }
  .rt :global(.chev) { width: 14px; height: 14px; flex: none; opacity: .7; }
  .rt :global(.ic12) { width: 12px; height: 12px; flex: none; }

  /* ── 列表页头（sticky，官方 PageHeader：标题 24 font-voice medium，右侧控件） ── */
  .ph { position: sticky; top: 0; z-index: 5; background: var(--bg); padding-top: var(--sat); }
  .ph-in { display: flex; align-items: center; gap: 8px; min-height: 64px; padding-top: 8px; padding-bottom: 8px; }
  .wide .ph-in { min-height: 88px; align-items: flex-end; padding-bottom: 20px; }
  :global(html[data-wco="1"]) .rt .ph-in { padding-right: calc(16px + var(--wco-right, 0px)); }
  .title { font-family: var(--font-brand-serif, var(--serif-stack, Georgia, serif)); font-size: 24px; line-height: 32px; font-weight: 500; letter-spacing: -.01em; margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctrls { margin-left: auto; display: flex; align-items: center; gap: 4px; min-width: 0; }
  .ctrls.searching { flex: 1; }
  .ctrls .btn.primary { margin-left: 4px; }
  .search { flex: 1; min-width: 0; max-width: 420px; margin-left: auto; display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 6px 0 10px; border-radius: 8px; background: var(--st-surface); box-shadow: inset 0 0 0 1px var(--st-line); color: var(--muted); }
  .search:focus-within { box-shadow: inset 0 0 0 1px var(--st-text2, var(--serif)); }
  .search > :global(svg) { width: 15px; height: 15px; flex: none; }
  .search input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; font: inherit; color: var(--text); }
  .search .x { width: 22px; height: 22px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
  .search .x :global(svg) { width: 12px; height: 12px; }
  .content { padding-top: 4px; padding-bottom: 32px; }

  /* 横幅：平铺浅底、无描边（提示卡只靠底色层次区分，不加边框 / 彩条；11-13 从官方 Banner 的描边卡改过来） */
  .banner { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 14px; border-radius: 10px; background: var(--st-hover); margin-bottom: 24px; color: var(--st-text2, var(--serif)); font-size: 13px; line-height: 18px; }
  .banner > :global(svg) { width: 16px; height: 16px; flex: none; color: var(--st-text2, var(--serif)); }
  .banner > span:not(.spin) { flex: 1; min-width: 0; }
  .banner.warn { background: rgba(217,119,6,.10); box-shadow: inset 0 0 0 1px rgba(217,119,6,.28); color: #b45309; }
  :global(html.dark) .banner.warn, :global([data-theme="dark"]) .banner.warn { color: #f0b46b; }
  .err { position: relative; display: flex; align-items: center; background: rgba(217,106,90,.12); color: var(--crit, #d96a5a); font-size: 13px; padding: 8px 36px 8px 12px; border-radius: 10px; margin: 0 0 16px; }
  .err .x { position: absolute; right: 6px; top: 50%; translate: 0 -50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; color: inherit; }
  .err .x :global(svg) { width: 12px; height: 12px; }

  /* 内容四态 */
  .state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 64px 0; color: var(--muted); text-align: center; }
  .state-ic { width: 28px; height: 28px; }
  .state-t { color: var(--text); font-weight: 500; }
  .state-d { max-width: 420px; }
  .state-d.small { font-size: 13px; margin-top: -6px; }
  .empty-ic { width: 56px; height: 56px; border-radius: 16px; background: var(--st-hover); display: flex; align-items: center; justify-content: center; color: var(--st-text2, var(--serif)); }
  .empty-acts { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; justify-content: center; }

  /* 钟：与侧栏「定时触发」同一枚（悬停两针走一格） */
  .rt :global(.clock) { width: 16px; height: 16px; flex: none; }
  .rt :global(.clock.huge) { width: 28px; height: 28px; }
  .rt :global(.clock line) { transform-box: view-box; transform-origin: 8px 8px; transition: rotate .6s cubic-bezier(.3, .9, .4, 1); }
  @media (hover: hover) { .empty-ic:hover :global(.hh) { rotate: 30deg; } .empty-ic:hover :global(.mh) { rotate: 390deg; } }

  /* ── 卡片网格（官方：1 列，md 起 2 列；gap 12 → 24） ── */
  .grid { list-style: none; margin: 0 0 12px; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .wide .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: 1fr; gap: 24px; margin-bottom: 24px; }   /* 两列时同排等高；单列（手机）按内容高，免得短卡底下空一截 */
  .grid > li { height: 100%; }
  .tcard { position: relative; height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 16px; border-radius: 12px; background: var(--st-surface); box-shadow: inset 0 0 0 1px var(--st-line); transition: background .15s, transform .12s; }
  .tcard:hover { background: color-mix(in srgb, var(--st-surface) 94%, var(--text)); }
  .tcard:active { transform: scale(.98); }
  .tcard.off .t-name, .tcard.off .t-desc { opacity: .6; }
  .t-row { display: flex; align-items: center; gap: 8px; padding-right: 40px; min-width: 0; }
  .t-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; text-align: left; color: var(--text); }
  .t-name::after { content: ''; position: absolute; inset: 0; border-radius: 12px; }
  .t-name:focus-visible::after { box-shadow: 0 0 0 2px var(--st-text2, var(--serif)); }
  .t-live { display: inline-flex; align-items: center; gap: 5px; flex: none; font-size: 12px; color: var(--muted); position: absolute; top: 18px; right: 16px; transition: opacity .15s; }
  .t-live .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .t-live.run { color: var(--text); } .t-live.run .dot { animation: pulse 1.4s ease-in-out infinite; }
  .t-live.wait { color: #d97706; } .t-live.wait .dot { animation: pulse 1.4s ease-in-out infinite; }
  .t-live.err { color: var(--crit, #d96a5a); }
  .t-desc { margin: 0 0 12px; color: var(--st-text2, var(--serif)); display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; white-space: pre-line; }
  .t-foot { margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; line-height: 17px; color: var(--muted); min-width: 0; }
  .t-st { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .t-st > span:first-child { flex: none; }
  .t-sch { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t-sch::before { content: '·'; margin-right: 8px; }
  .t-sch.t-eng { flex: none; }   /* 引擎名短，别被频率挤成省略号 */
  .t-proj { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 45%; flex: none; }
  .t-proj > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t-more { position: absolute; top: 12px; right: 12px; width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--st-text2, var(--serif)); opacity: 0; transition: opacity .15s; z-index: 1; }
  .t-more :global(svg) { width: 15px; height: 15px; }
  .t-more:hover { background: var(--st-hover); color: var(--text); }
  .tcard:hover .t-more, .tcard:focus-within .t-more, .tcard.menu-on .t-more { opacity: 1; }
  .tcard:hover .t-live, .tcard:focus-within .t-live, .tcard.menu-on .t-live { opacity: 0; }
  @media (hover: none) { .t-more { opacity: 1; } .t-live { opacity: 1 !important; right: 48px; } }
  .skel span { display: block; height: 12px; border-radius: 6px; background: var(--st-hover); }
  .skel span:nth-child(1) { width: 40%; height: 14px; } .skel span:nth-child(2) { width: 90%; } .skel span:nth-child(3) { width: 60%; margin-top: 18px; }
  .skel { min-height: 120px; animation: pulse 1.4s ease-in-out infinite; }

  /* ── 详情 / 表单顶栏（官方 32px 标题栏，返回 + 标题 + 右侧动作） ── */
  .bar { flex: none; display: flex; align-items: center; gap: 4px; height: calc(48px + var(--sat)); padding: var(--sat) 12px 0 8px; border-bottom: 1px solid var(--st-hair, var(--divider)); }
  :global(html[data-wco="1"]) .rt .bar { padding-right: calc(12px + var(--wco-right, 0px)); }
  .bar-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; padding-left: 4px; }
  .bar-acts { display: flex; align-items: center; gap: 4px; flex: none; }
  .bar-acts .btn { margin-left: 4px; }

  /* ── 详情：标题区 + 两列（宽处 1 : 1.4，窄处上下叠） ── */
  .dwrap { max-width: 1120px; margin: 0 auto; padding: 20px 16px 40px; display: flex; flex-direction: column; gap: 20px; }
  .wide .dwrap { padding: 40px 32px 40px; gap: 28px; }
  .dwrap > .banner, .dwrap > .err { margin: 0; }
  .dhead { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .dtitle { margin: 0; font-family: var(--font-brand-serif, var(--serif-stack, Georgia, serif)); font-size: 24px; line-height: 32px; font-weight: 500; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .dlead { margin: 0; color: var(--st-text2, var(--serif)); overflow-wrap: anywhere; }
  .dhead .status { margin-top: 6px; }
  .dgrid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .wide .dgrid { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 32px; align-items: start; }
  .dcol { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
  .sec { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .sec-h { font-size: 13px; line-height: 18px; font-weight: 500; color: var(--st-text2, var(--serif)); margin: 0; }
  .fn { font-size: 13px; line-height: 17px; color: var(--muted); }
  .warn-t { color: #c2410c; }
  :global(html.dark) .warn-t, :global([data-theme="dark"]) .warn-t { color: #f0a06b; }
  .status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .badge { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 6px; background: var(--st-hover); font-size: 12.5px; font-weight: 500; }
  .badge.off { color: var(--muted); }
  .ok-ic { width: 13px; height: 13px; color: #16a34a; }
  /* 设置一览：一张卡、行间细线、左列标签右列值（值的补充说明是灰色第二行） */
  .kv { margin: 0; border-radius: 12px; background: var(--st-surface); box-shadow: inset 0 0 0 1px var(--st-line); }
  .kv-r { display: grid; grid-template-columns: 5em minmax(0, 1fr); column-gap: 16px; padding: 12px 16px; align-items: baseline; }
  .rt.en .kv-r { grid-template-columns: 7.5em minmax(0, 1fr); }
  .kv-r + .kv-r { border-top: 1px solid var(--st-hair, var(--divider)); }
  .kv dt { font-size: 13px; color: var(--muted); }
  .kv dd { margin: 0; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; overflow-wrap: anywhere; }
  .kv-sub { font-size: 12.5px; line-height: 17px; color: var(--muted); }
  .kv-ic { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; }
  .kv-ic > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kv-ic :global(.ic12) { color: var(--muted); }
  .link { color: var(--text); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); }
  .link.kv-sub { color: var(--st-text2, var(--serif)); }
  .instr-box { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 12px; background: var(--st-hover); }
  .instr { color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; line-height: 22px; }
  .instr.clamp { max-height: 4lh; overflow: hidden; mask-image: linear-gradient(#000 55%, transparent); -webkit-mask-image: linear-gradient(#000 55%, transparent); }
  .instr-box .btn.xs { margin-left: -8px; }
  .empty-runs { margin: 0; padding: 12px 14px; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--st-hair, var(--divider)); }
  .hist { display: flex; flex-direction: column; gap: 4px; }
  .h-row { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 8px; background: var(--st-hover); text-align: left; min-width: 0; }
  .h-row:hover:not(:disabled) { background: var(--st-sel, var(--hover-strong)); }
  .h-row:disabled { cursor: default; }
  .h-ic { width: 14px; height: 14px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
  .h-ic :global(svg) { width: 14px; height: 14px; }
  .h-ic.error { color: var(--crit, #d96a5a); }
  .h-ic.wait { color: #d97706; }
  .hollow { width: 10px; height: 10px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--st-line); }
  .h-ic.wait .hollow { box-shadow: none; background: currentColor; animation: pulse 1.4s ease-in-out infinite; }
  .h-when { flex: none; color: var(--text); }
  .h-tag { flex: none; font-size: 11.5px; line-height: 16px; padding: 0 5px; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--st-line); color: var(--muted); }
  .h-pv { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 13px; }
  .h-st { flex: none; font-size: 13px; color: var(--muted); }
  .h-st.error { color: var(--crit, #d96a5a); } .h-st.wait { color: #d97706; }
  .spin { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; flex: none; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 50% { opacity: .35; } }

  /* 开关（官方 Switch xs） */
  .sw { width: 30px; height: 18px; border-radius: 999px; background: var(--st-line); padding: 2px; flex: none; transition: background .2s; }
  .sw .knob { display: block; width: 14px; height: 14px; border-radius: 50%; background: var(--bg); box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .2s var(--ea-out, ease); }
  .sw.on { background: var(--st-primary); }
  .sw.on .knob { transform: translateX(12px); background: var(--st-primary-ink); }
  .sw:disabled { opacity: .4; }

  /* ── 表单（整页 max 680，字段间 24） ── */
  .fwrap { max-width: 680px; margin: 0 auto; padding: 24px 16px 32px; }
  .wide .fwrap { padding: 40px 24px 40px; }
  .form { display: flex; flex-direction: column; gap: 24px; }
  /* 运行位置提示：平铺浅底、无描边——提示卡只靠底色层次区分，不加边框、不加彩条 */
  .hint { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--st-hover);
    color: var(--st-text2, var(--serif)); font-size: 13px; line-height: 18px; }
  .hint > :global(svg) { width: 15px; height: 15px; flex: none; margin-top: 1.5px; color: var(--muted); }
  .fld { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .lbl { display: flex; align-items: baseline; gap: 6px; font-size: 13px; line-height: 18px; font-weight: 500; color: var(--st-text2, var(--serif)); }
  .opt { font-weight: 400; color: var(--muted); }
  .inp { width: 100%; height: 38px; padding: 0 12px; border-radius: 10px; border: 0; background: var(--st-surface); box-shadow: inset 0 0 0 1px var(--st-line);
    font: inherit; font-size: 14px; color: var(--text); outline: none; transition: box-shadow .15s; }
  .inp::placeholder, .ta::placeholder { color: var(--muted); opacity: .75; }
  .inp:focus { box-shadow: inset 0 0 0 1px var(--st-text2, var(--serif)), 0 0 0 3px var(--st-hover); }
  .inp.num { width: 64px; padding: 0 6px; text-align: center; font-variant-numeric: tabular-nums; }
  .inp.cron { max-width: 280px; letter-spacing: .04em; }
  /* 指令框：输入栏的卡片语言——圆角 14、淡描边 + 软投影，聚焦时描边加深；下面挂工具条与位置条 */
  .ibox { display: flex; flex-direction: column; border-radius: 14px; background: var(--st-surface); overflow: hidden;
    box-shadow: inset 0 0 0 1px var(--st-line), 0 4px 20px rgba(0,0,0,.035); transition: box-shadow .15s; }
  .ibox:focus-within { box-shadow: inset 0 0 0 1px var(--st-text2, var(--serif)), 0 4px 20px rgba(0,0,0,.075); }
  .inp.invalid, .ibox.invalid { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--crit, #d96a5a) 75%, transparent); }
  .ta { display: block; width: 100%; min-height: 120px; max-height: 300px; resize: none; overflow-y: auto; background: none; border: 0; outline: 0;
    font: inherit; font-size: 14.5px; line-height: 22px; color: var(--text); padding: 12px 14px 6px; }
  .tbar { display: flex; align-items: center; gap: 2px; padding: 2px 6px 6px; min-width: 0; }
  .locbar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px 6px; min-height: 40px; min-width: 0;
    background: var(--st-hover); border-top: 1px solid var(--st-hair, var(--divider)); }
  /* 芯片：图标 + 文字 + 小箭头。平时无底无框，悬停 / 按下 / 展开时浮出浅底（以前是虚线框，看着像没做完） */
  .fchip { display: inline-flex; align-items: center; gap: 6px; height: 30px; max-width: 100%; min-width: 0; padding: 0 8px; border-radius: 8px;
    font-size: 13px; color: var(--muted); transition: background .15s, color .15s; }
  .fchip :global(.ic12) { width: 14px; height: 14px; }
  .fchip.set { color: var(--st-text2, var(--serif)); }
  .fchip[aria-expanded="true"], .fchip:active:not(:disabled) { background: var(--st-sel); color: var(--text); }
  @media (hover: hover) { .fchip:hover:not(:disabled) { background: var(--st-sel); color: var(--text); } }
  .fchip:disabled { opacity: .45; }
  .chip-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .caret-s { width: 9px; height: 6px; flex: none; opacity: .55; }
  /* 模型 / 思考强度：输入栏同款素文本芯片（模型正文色、强度灰），不配图标 */
  .mchip { display: inline-flex; align-items: center; height: 30px; min-width: 0; padding: 0 8px; border-radius: 8px; font-size: 13.5px;
    color: var(--text); white-space: nowrap; transition: background .15s; }
  .mchip.lvl { color: var(--muted); flex-shrink: 3; }
  /* dimensio 的深度只有 off / low / high / max 几个字母，窄屏挤不下时让权限与型号芯片去省略，深度不缩（以前 375 宽下缩成「o.」） */
  .mchip.lvl.keep { flex-shrink: 0; }
  .mchip-fast { color: var(--muted); }
  .mchip[aria-expanded="true"], .mchip:active { background: var(--st-sel); }
  @media (hover: hover) { .mchip:hover { background: var(--st-sel); } }
  .wt { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 6px 0 8px; font-size: 13px; color: var(--muted); cursor: pointer; }
  .wt.dim { opacity: .55; cursor: default; }
  .note { margin: 0; font-size: 13px; line-height: 18px; color: var(--muted); }
  .note.bad { color: var(--crit, #d96a5a); }
  .nx { color: var(--st-text2, var(--serif)); }
  .nw { white-space: nowrap; }
  /* 分段条：浅底槽 + 浮起的滑块。频率那条铺满一行，放不下就横着滑、不折行 */
  .seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--st-seg, var(--st-hover)); align-self: flex-start; max-width: 100%;
    overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
  .seg::-webkit-scrollbar { display: none; }
  /* 频率：七格按字宽分、余下的宽度均摊，铺满一行（中文 375 宽放得下，再窄就横着滑）；
     英文词长，窄屏排成两行四列（不能等宽硬塞，三个字的格子会被截成「每…」） */
  .seg.full { display: flex; align-self: stretch; }
  .seg.full button { flex: 1 1 auto; padding: 0 4px; }
  .rt.en:not(.wide) .seg.full { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .seg button { height: 30px; padding: 0 12px; border-radius: 7px; font-size: 13px; color: var(--muted); white-space: nowrap; transition: background .15s, color .15s, box-shadow .15s; }
  @media (hover: hover) { .seg button:hover:not(.on) { color: var(--text); } }
  .seg button.on { color: var(--text); background: var(--st-thumb, var(--st-surface)); box-shadow: 0 1px 2px rgba(0,0,0,.2), 0 0 0 .5px rgba(0,0,0,.08); }
  .seg.sm { align-self: center; flex: none; }
  .seg.sm button { height: 26px; padding: 0 10px; }
  .when { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .when-t { color: var(--st-text2, var(--serif)); }
  .days { display: flex; flex-wrap: wrap; gap: 6px; flex-basis: 100%; }
  .day { min-width: 36px; height: 36px; padding: 0 8px; border-radius: 18px; font-size: 13px; color: var(--st-text2, var(--serif));
    background: var(--st-surface); box-shadow: inset 0 0 0 1px var(--st-line); transition: background .15s, color .15s; }
  @media (hover: hover) { .day:hover:not(.on) { color: var(--text); background: color-mix(in srgb, var(--st-surface) 92%, var(--text)); } }
  .day.on { background: var(--st-primary); color: var(--st-primary-ink); box-shadow: none; }
  /* 时间 / 日期：输入框外观的按钮，显示 24 小时制（中文）与口语日期；系统选择器由盖在上面的透明 input 弹 */
  .tpick { position: relative; display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border-radius: 10px;
    background: var(--st-surface); box-shadow: inset 0 0 0 1px var(--st-line); color: var(--text); transition: box-shadow .15s, background .15s; }
  @media (hover: hover) { .tpick:hover { background: color-mix(in srgb, var(--st-surface) 94%, var(--text)); } }
  .tpick:focus-within { box-shadow: inset 0 0 0 1px var(--st-text2, var(--serif)), 0 0 0 3px var(--st-hover); }
  .tpick :global(.clock), .tpick :global(.ic14) { width: 15px; height: 15px; flex: none; color: var(--muted); }
  .tpick-v { font-size: 15px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tpick input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; font-size: 16px; color-scheme: light dark; }
  .tpick input::-webkit-calendar-picker-indicator { position: absolute; inset: 0; width: auto; height: auto; margin: 0; opacity: 0; cursor: pointer; }
  /* 「运行」卡：行间细线 */
  .rows { border-radius: 12px; box-shadow: inset 0 0 0 1px var(--st-line); background: var(--st-surface); }
  .r { display: flex; align-items: center; gap: 12px; padding: 12px 14px 12px 16px; min-height: 56px; }
  .r + .r { border-top: 1px solid var(--st-hair, var(--divider)); }
  .r-k { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .r-sub { font-size: 12.5px; line-height: 17px; color: var(--muted); }
  /* 动作条：整页时常驻底部（细线 + 页底色），宽处与表单同宽、按钮靠右；手机两键平分。
     保存不了时按钮不置灰（手机上没有悬停提示），点了在左边说缺什么、焦点跳到那一栏 */
  .fbar { flex: none; border-top: 1px solid var(--st-hair, var(--divider)); background: var(--bg); padding: 10px 16px calc(10px + var(--sab, 0px)); }
  .wide .fbar { padding-left: 24px; padding-right: 24px; }
  .fbar-in { max-width: 632px; margin: 0 auto; }
  .foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .foot-msg { flex: 1 1 0; min-width: 0; margin: 0; font-size: 13px; line-height: 18px; color: var(--crit, #d96a5a); }
  .foot-btns { display: flex; gap: 8px; margin-left: auto; }
  .rt:not(.wide) .foot-msg { flex-basis: 100%; }
  .rt:not(.wide) .foot-btns { flex: 1; }
  .rt:not(.wide) .foot-btns .btn { flex: 1; height: 40px; }
  .btn.primary.dim, .btn.primary.dim:hover:not(:disabled) { opacity: .5; }

  /* ── 编辑对话框（640，居中，不全屏；内容自己滚，动作条贴底） ── */
  .dlg-bd { position: absolute; inset: 0; z-index: 60; background: var(--st-backdrop, rgba(0,0,0,.45)); display: flex; align-items: center; justify-content: center; padding: 24px 16px; animation: fadeIn .15s ease; }
  @keyframes fadeIn { from { opacity: 0; } }
  .dlg { width: 640px; max-width: calc(100% - 32px); max-height: 100%; display: flex; flex-direction: column; border-radius: 16px; background: var(--bg); box-shadow: var(--st-menu-shadow, var(--q-shadow)); animation: dlgIn .2s var(--ea-out, ease); }
  @keyframes dlgIn { from { opacity: 0; transform: translateY(8px) scale(.98); } }
  .dlg-h { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px 24px; font-size: 16px; font-weight: 500; }
  .dlg-b { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 24px 24px; }
  .dlg-b .hint { display: none; }
  .dlg-f { flex: none; padding: 12px 24px 16px; border-top: 1px solid var(--st-hair, var(--divider)); }

  /* ── 下拉（挪到 body 上：整屏透明层 + 弹层；字号行高不再从本页继承，这里补上） ── */
  .rt-layer { position: fixed; inset: 0; z-index: 1000; font-size: 14px; line-height: 20px; color: var(--text); }
  .pop-bd { position: absolute; inset: 0; cursor: default; }
  .pop { position: fixed; max-width: min(380px, calc(100vw - 16px)); overflow-y: auto; overscroll-behavior: contain; padding: 4px;
    border-radius: 12px; background: var(--st-menu, var(--q-card)); box-shadow: var(--st-menu-shadow, var(--q-shadow)); animation: popIn .14s var(--ea-out, ease); transform-origin: top; }
  .pop.up { transform-origin: bottom; animation-name: popUp; }
  @keyframes popIn { from { opacity: 0; transform: translateY(-3px) scale(.98); } }
  @keyframes popUp { from { opacity: 0; transform: translateY(3px) scale(.98); } }
  .mi { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 10px; border-radius: 8px; text-align: left; position: relative; }
  .mi.chk { padding-left: 30px; }
  .mi:active:not(:disabled) { background: var(--st-hover); }
  @media (hover: hover) { .mi:hover:not(:disabled) { background: var(--st-hover); } }
  .mi:disabled { opacity: .45; }
  .mi.sel::before { content: ''; position: absolute; left: 11px; top: 13px; width: 9px; height: 5px; border: solid currentColor; border-width: 0 0 1.5px 1.5px; transform: rotate(-45deg); }
  .mi-t { font-size: 14px; color: var(--text); display: flex; flex-direction: column; }
  .mi-d { font-size: 12.5px; line-height: 16px; color: var(--muted); }
  .mi-d.mono { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .mi-n { position: absolute; right: 10px; top: 8px; font-size: 12.5px; color: var(--muted); }
  .mi-h { font-size: 12px; color: var(--muted); padding: 6px 10px 2px; }
  .mi-empty { padding: 6px 10px; font-size: 13px; color: var(--muted); }
  .mi.danger .mi-t { color: var(--crit, #d96a5a); }
  .mi-sep { height: 1px; background: var(--st-hair, var(--divider)); margin: 4px 6px; }
</style>
