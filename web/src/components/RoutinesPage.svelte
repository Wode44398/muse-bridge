<script>
  // 定时任务（Routines）页：列表 → 详情 → 新建 / 编辑。结构照官方 Claude Desktop 4.4212 的 Code 侧「Scheduled」
  //（规格：bridge build/bridge前端设计/claude页面设计参考资源/定时任务-官方规格/官方定时任务规格.md）——
  //   列表 = 两列卡片网格（标题 + 三行描述 + 「状态 · 频率」，悬停出 ⋯ 菜单），页头 搜索 / 筛选 / 排序 / 新建下拉；
  //   详情 = 左（描述 / 状态 / 文件夹 / 重复 / 模型 / 权限…）右（可折叠指令 / 运行记录）两列；
  //   表单 = 名称 / 描述 / 指令框（框内工具条：权限、模型；位置条：文件夹、分支、Worktree）/ 频率分段条。
  // 官方这页本来就带工作文件夹这些 Code 设置；bridge 另加：Gemini 引擎、思考强度与 Fast、一次性 / 自定义 cron、
  // 会话方式（每次新会话 / 接着上次）、跑完通知、运行记录里的结果摘要。
  // 电脑（侧栏常驻）嵌在正文区、侧栏照旧可点（embedded）；手机是全屏页。数据：lib/routines.svelte.js。
  import { untrack } from 'svelte';
  import { uiConfirm } from '../lib/dialogs.js';
  import { caps, ui, session, agentOn, hostIsServer } from '../lib/state.svelte.js';
  import { api } from '../lib/api.js';
  import { registerCloser, pushBackLayer } from '../lib/nav.js';
  import { claudeDefaultModel } from '../lib/caps.js';
  import { cs } from '../lib/claudeSettings.svelte.js';
  import { modeLabel, modeDesc, clampModeLocal } from '../lib/permissions.svelte.js';
  import { hasNativePickDirectory, nativePickDirectory } from '../lib/nativeDesktop.js';
  import { rt, loadRoutines, schedText, whenText, durText, folderName, tzLabel, wdName } from '../lib/routines.svelte.js';
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
  let pop = $state(null);             // 打开着的下拉：{ key, x, y, w, up, id? }
  let pickOpen = $state(false);       // 远程端的文件夹选择器
  let projects = $state([]);          // 工作文件夹候选（Claude 项目）
  let git = $state(null);             // 选中文件夹的 git 信息 { git, branch, branches, worktreeOk }
  let showAllPrompt = $state(false);
  let pageW = $state(1000);
  const wide = $derived(pageW >= 760);

  const blank = () => ({
    name: '', description: '', prompt: '', agent: 'claude', model: null, effort: null, fast: false, search: false,
    cwd: '', worktree: false, branch: '', permissionMode: '', sessionMode: 'new', notify: false,
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
  const modelList = $derived(f.agent === 'vertex' ? (caps.data?.vertex?.models || []) : (caps.data?.claude?.models || []));
  const effortList = $derived(f.agent === 'vertex'
    ? (caps.data?.vertex?.thinkLevels || []).filter((lv) => !(/pro/.test(f.model || '') && lv.id === 'minimal'))
    : (caps.data?.claude?.efforts || []).filter((e) => e.id !== 'ultracode'));
  const defModel = $derived(f.agent === 'vertex' ? caps.data?.vertex?.defaults?.model : claudeDefaultModel(caps.data));
  const defEffort = $derived(f.agent === 'vertex' ? caps.data?.vertex?.defaults?.think : 'high');
  const fastOk = $derived(f.agent !== 'vertex' && (caps.data?.claude?.fast || []).includes(f.model || defModel));
  const modelPill = $derived(`${nameOf(modelList, f.model || defModel)} · ${nameOf(effortList, f.effort || defEffort)}${fastOk && f.fast ? ' · Fast' : ''}`);
  const engineText = (r) => {
    const vx = r.agent === 'vertex';
    const fallback = vx ? (caps.data?.vertex?.defaults?.model || '') : claudeDefaultModel(caps.data);
    return `${vx ? 'Gemini' : 'Claude'} · ${nameOf(vx ? caps.data?.vertex?.models : caps.data?.claude?.models, r.model || fallback)}`;
  };
  const effortText = (r) => {
    const vx = r.agent === 'vertex';
    return nameOf(vx ? caps.data?.vertex?.thinkLevels : caps.data?.claude?.efforts, r.effort || (vx ? caps.data?.vertex?.defaults?.think : 'high'));
  };
  const permDefault = $derived(clampModeLocal(cs.values?.permissionMode));
  const permText = (m) => (m ? modeLabel(m) : t('设置默认（{mode}）', { mode: modeLabel(permDefault) }));
  const permEff = $derived(f.permissionMode || permDefault);
  const asks = (m) => m === 'default' || m === 'acceptEdits';

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
  $effect(() => { if (ui.routinesOpen) untrack(() => { view = 'list'; dlg = false; curId = null; pop = null; opErr = ''; loadRoutines(); }); });
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
    if (pop) { pop = null; return; }
    if (pickOpen) { pickOpen = false; return; }
    if (dlg || view === 'form') { leaveForm(); return; }
    if (view === 'detail') { view = 'list'; return; }
    ui.routinesOpen = false;
  }));
  function close() { ui.routinesOpen = false; }
  function openDetail(r) { pop = null; curId = r.id; showAllPrompt = false; opErr = ''; view = 'detail'; }

  function openNew() {
    pop = null; editing = null; err = ''; f = blank(); formBack = view === 'detail' ? 'detail' : 'list';
    view = 'form'; dlg = false; afterFormOpen();
  }
  function openEdit(r) {
    pop = null; editing = r.id; err = ''; curId = r.id;
    const s = r.schedule || {};
    f = {
      name: r.name || '', description: r.description || '', prompt: r.prompt || '', agent: r.agent || 'claude',
      model: r.model, effort: r.effort, fast: !!r.fast, search: !!r.search,
      cwd: r.cwd || '', worktree: !!r.worktree, branch: r.branch || '', permissionMode: r.permissionMode || '',
      sessionMode: r.sessionMode || 'new', notify: !!r.notify,
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
    loadGit();
    try { const d = await api.claudeProjects(); projects = (d.projects || []).filter((p) => !p.quick && !p.def); } catch {}
  }
  async function leaveForm() {
    if (busy) return;
    if (dirty() && !(await uiConfirm(t('放弃没保存的修改？'), { okLabel: t('放弃'), type: 'warning' }))) return;
    pop = null;
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
    if (f.agent === 'vertex') return;
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
    const out = [{ id: '', label: t('默认工作空间'), desc: rt.home }];
    seen.add(key(rt.home));
    for (const p of projects) { if (seen.has(key(p.path))) continue; seen.add(key(p.path)); out.push({ id: p.path, label: tr(p.name) || folderName(p.path), desc: p.path }); }
    if (f.cwd && !seen.has(key(f.cwd))) out.push({ id: f.cwd, label: folderName(f.cwd), desc: f.cwd });
    return out;
  });
  const cwdLabel = $derived(f.cwd ? folderName(f.cwd) : t('默认工作空间'));
  const wtAvail = $derived(!!git?.git && git.worktreeOk !== false);

  // ---- 下拉（单例弹层；锚在触发按钮上下，放不下就翻面；align end = 右对齐）----
  function openPop(e, key, { id = null, end = false, side = 'bottom', w = 220 } = {}) {
    e.stopPropagation();
    if (pop?.key === key && pop?.id === id) { pop = null; return; }
    const b = e.currentTarget.getBoundingClientRect();
    const roomBelow = window.innerHeight - b.bottom, roomAbove = b.top;
    const up = side === 'top' ? roomAbove > 220 || roomAbove > roomBelow : roomBelow < 280 && roomAbove > roomBelow;
    const width = Math.max(w, end ? 0 : b.width);
    const x = end ? b.right - width : b.left;
    pop = { key, id, x: Math.max(8, Math.min(x, window.innerWidth - width - 8)), y: up ? window.innerHeight - b.top + 4 : b.bottom + 4, w: width, up };
  }
  $effect(() => { if (pop) return pushBackLayer(() => { pop = null; }); });
  function pick(fn) { fn(); pop = null; }
  const popRoutine = $derived(pop?.id ? rt.items.find((r) => r.id === pop.id) : null);

  function setAgent(a) {
    if (f.agent === a) return;
    f.agent = a; f.model = null; f.effort = null; f.fast = false;
    if (a !== 'vertex') f.search = false;
    loadGit();
  }
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
  async function save(e) {
    e?.preventDefault?.();
    if (blocked || busy) return;
    busy = true; err = '';
    const vx = f.agent === 'vertex';
    const body = {
      name: f.name.trim(), description: f.description.trim(), prompt: f.prompt.trim(),
      agent: f.agent, model: f.model || null, effort: f.effort || null, search: vx && f.search,
      schedule: schedOut(), notify: f.notify,
      ...(vx ? {} : {
        cwd: f.cwd || '', worktree: f.worktree && wtAvail, branch: f.worktree && wtAvail ? f.branch : '',
        permissionMode: f.permissionMode || '', fast: fastOk && f.fast, sessionMode: f.sessionMode,
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
    if (!(await uiConfirm(t('删除「{name}」？已经跑出来的会话会保留。', { name: r.name }), { okLabel: t('删除'), type: 'warning' }))) return;
    const prev = rt.items;
    rt.items = rt.items.filter((x) => x.id !== r.id);
    if (curId === r.id) { view = 'list'; curId = null; }
    try { const res = await api.deleteRoutine(r.id); if (res && res.ok === false) throw 0; }
    catch { rt.items = prev; opErr = t('删除失败：{reason}', { reason: offline() }); }
  }
  async function openSessionId(id) {
    if (!id) return;
    ui.routinesOpen = false;
    const { openSession } = await import('../lib/chat.svelte.js');
    openSession(String(id));
  }

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
{#snippet sparkIc()}<svg class="ic12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8l4.2-1.3z"/></svg>{/snippet}
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
  <!-- 官方经典布局：名称 / 描述 / 指令框（工具条 + 位置条）/ 频率；bridge 加一张「运行」卡（会话方式、跑完通知） -->
  <form class="form" onsubmit={save}>
    <div class="banner">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6M8 5.2v.1" stroke-linecap="round"/></svg>
      <span>{hostIsServer() ? t('定时任务在服务器上运行，服务器在线就会按时跑；你的手机和电脑不用开着。') : t('定时任务在这台电脑上运行，只在它开机联网时跑。')}</span>
    </div>
    <label class="fld">
      <span class="lbl">{t('名称')}<span class="req"> *</span></span>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="inp" bind:value={f.name} maxlength="120" placeholder={t('每日代码回顾')} autofocus={!editing} />
    </label>
    <label class="fld">
      <span class="lbl">{t('描述')}</span>
      <input class="inp" bind:value={f.description} maxlength="300" placeholder={t('回看昨天的提交，标出值得注意的地方')} />
    </label>
    <div class="fld">
      <label class="lbl" for="rt-prompt">{t('指令')}</label>
      <div class="ibox">
        <textarea id="rt-prompt" class="ta" use:autosize bind:value={f.prompt} placeholder={t('看看过去 24 小时的提交：总结改了什么，指出有风险的写法或缺的测试，记下值得跟进的事。')}></textarea>
        <div class="tbar">
          {#if f.agent !== 'vertex'}
            <button type="button" class="pill" class:set={!!f.permissionMode} onclick={(e) => openPop(e, 'perm', { w: 280 })}>{@render shieldIc()}<span class="pill-t">{permText(f.permissionMode)}</span></button>
          {/if}
          <span class="sp"></span>
          <button type="button" class="pill set" onclick={(e) => openPop(e, 'model', { end: true, w: 260 })}>{@render sparkIc()}<span class="pill-t">{f.agent === 'vertex' ? 'Gemini · ' : ''}{modelPill}</span></button>
        </div>
        {#if f.agent !== 'vertex'}
          <div class="locbar">
            <button type="button" class="pill" class:set={!!f.cwd} class:mono={!!f.cwd} title={f.cwd || rt.home} onclick={(e) => openPop(e, 'folder', { side: 'top', w: 300 })}>{@render folderIc()}<span class="pill-t">{cwdLabel}</span></button>
            {#if git?.git}
              <button type="button" class="pill mono" class:set={!!f.branch} disabled={!f.worktree} title={f.worktree ? '' : t('打开 Worktree 后可以选从哪个分支切')} onclick={(e) => openPop(e, 'branch', { side: 'top', w: 220 })}>{@render branchIc()}<span class="pill-t">{f.branch || t('当前分支')}</span></button>
            {/if}
            <span class="sp"></span>
            <span class="wt" class:dim={!wtAvail} title={!git ? '' : !git.git ? t('这个文件夹不是 git 仓库') : git.worktreeOk === false ? t('这个文件夹本身就是一个 worktree') : t('每次运行先切一个新分支和工作目录，改动不碰你手上的检出')}>
              {@render sw(f.worktree && wtAvail, () => (f.worktree = !f.worktree), 'Worktree', !wtAvail)}<span>Worktree</span>
            </span>
          </div>
        {/if}
      </div>
      {#if f.agent !== 'vertex' && asks(permEff)}<span class="note">{t('「{mode}」模式下遇到要你批准的操作会停下来等，会话里亮「待回答」；想全程自己跑完，选「自动」。', { mode: modeLabel(permEff) })}</span>{/if}
    </div>

    <div class="fld">
      <span class="lbl">{t('频率')}</span>
      <div class="seg" role="group" aria-label={t('频率')}>
        {#each FREQS as [id, lbl]}<button type="button" class:on={f.sched.type === id} aria-pressed={f.sched.type === id} onclick={() => setFreq(id)}>{lbl()}</button>{/each}
      </div>
      {#if ['daily', 'weekdays', 'weekly'].includes(f.sched.type)}
        {#if f.sched.type === 'weekly'}
          <div class="when">
            <span>{t('星期')}</span>
            <span class="days">{#each WEEK as d}<button type="button" class="day" class:on={f.sched.days.includes(d)} aria-pressed={f.sched.days.includes(d)} onclick={() => toggleDay(d)}>{wdName(d, isEn() ? 'short' : 'narrow')}</button>{/each}</span>
          </div>
        {/if}
        <div class="when"><span>{t('时间')}</span><input class="inp time" type="time" value={timeStr} onchange={onTime} /></div>
      {:else if f.sched.type === 'hourly'}
        <div class="when"><span>{t('每小时的第')}</span><input class="inp num" type="number" min="0" max="59" value={f.sched.minute} onchange={onMinute} /><span>{t('分钟')}</span></div>
      {:else if f.sched.type === 'once'}
        <div class="when"><span>{t('在')}</span><input class="inp dt" type="datetime-local" value={atStr} onchange={onAt} /></div>
      {:else if f.sched.type === 'cron'}
        <label class="cronf">
          <span class="sub">{t('cron 表达式')}</span>
          <input class="inp mono" dir="ltr" bind:value={f.sched.cron} placeholder="0 9 * * *" spellcheck="false" autocapitalize="off" />
          {#if cronErr}<span class="bad">{cronErr}</span>{:else}<span class="sub">{t('5 段：分 时 日 月 周，只认数字（周日写 0），最多每小时一次。')}</span>{/if}
        </label>
      {/if}
      <p class="note">
        {#if f.sched.type === 'manual'}{t('不按时间自动跑，只在你点「立即运行」时跑。')}
        {:else if nextPreview}{t('下次运行：{when}', { when: nextPreview })} · {t('时间按服务器时区（{tz}）', { tz: tzLabel(rt.tz) })}
        {:else if f.sched.type === 'once'}{t('选一个以后的时间。')}{/if}
      </p>
    </div>

    <div class="fld">
      <span class="lbl">{t('运行')}</span>
      <div class="rows">
        {#if agentOn('gemini') || f.agent === 'vertex'}
          <div class="r"><span class="r-k">{t('引擎')}<span class="r-sub">{f.agent === 'vertex' ? t('单轮问答，可联网搜索；不碰文件') : t('能读写文件、跑命令，和 Claude 页的会话一样')}</span></span>
            <div class="seg sm">
              <button type="button" class:on={f.agent === 'claude'} onclick={() => setAgent('claude')}>Claude</button>
              <button type="button" class:on={f.agent === 'vertex'} onclick={() => setAgent('vertex')}>Gemini</button>
            </div>
          </div>
        {/if}
        {#if f.agent === 'vertex'}
          <div class="r"><span class="r-k">{t('联网搜索')}</span>{@render sw(f.search, () => (f.search = !f.search), t('联网搜索'))}</div>
        {:else}
          <div class="r"><span class="r-k">{t('会话方式')}<span class="r-sub">{f.sessionMode === 'continue' ? t('每次都在同一个会话里接着往下聊，记得上回做过什么') : t('每次开一个干净的新会话')}</span></span>
            <div class="seg sm">
              <button type="button" class:on={f.sessionMode === 'new'} onclick={() => (f.sessionMode = 'new')}>{t('每次新会话')}</button>
              <button type="button" class:on={f.sessionMode === 'continue'} onclick={() => (f.sessionMode = 'continue')}>{t('接着上次')}</button>
            </div>
          </div>
        {/if}
        <div class="r"><span class="r-k">{t('跑完通知我')}<span class="r-sub">{t('每次运行结束，在打开着的 bridge 里提醒你结果')}</span></span>{@render sw(f.notify, () => (f.notify = !f.notify), t('跑完通知我'))}</div>
      </div>
    </div>

    {#if err}<div class="err">{err}</div>{/if}
    <div class="foot">
      <button type="button" class="btn ghost" disabled={busy} onclick={leaveForm}>{t('取消')}</button>
      <button type="submit" class="btn primary" disabled={!!blocked || busy} title={blocked}>{busy ? t('保存中…') : (editing ? t('保存') : t('创建'))}</button>
    </div>
  </form>
{/snippet}

{#if ui.routinesOpen}
<section class="rt" class:embedded class:wide bind:clientWidth={pageW}>
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
                    <span class="t-st"><span>{stateWord(r)}</span><span class="t-sch">{schedText(r.schedule)}</span></span>
                    {#if r.agent === 'vertex'}<span class="t-proj">Gemini</span>
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
    <!-- ═══ 详情页 ═══ -->
    {@const lv = liveOf(cur)}
    {@const mAt = missedAt(cur)}
    <header class="bar">
      <button class="ibtn" aria-label={t('返回')} onclick={() => (view = 'list')}>{@render backIc()}</button>
      <span class="bar-t">{cur.name || t('未命名任务')}</span>
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
            <button class="btn ghost sm" onclick={() => openSessionId(lv.sessionId)}>{t('去处理')}</button>
          </div>
        {:else if running(cur) && lv?.sessionId}
          <div class="banner">
            <span class="spin"></span><span>{t('正在运行。')}</span>
            <button class="btn ghost sm" onclick={() => openSessionId(lv.sessionId)}>{t('打开会话')}</button>
          </div>
        {/if}
        <div class="dgrid">
          <div class="dcol">
            {#if cur.description}{#snippet descB()}<p class="txt">{cur.description}</p>{/snippet}{@render section(t('描述'), descB)}{/if}
            {#snippet statusB()}
              <div class="status">
                {#if cur.schedule?.type !== 'manual' && !isDone(cur)}{@render sw(cur.enabled !== false, () => toggleEnabled(cur), cur.enabled === false ? t('启用定时任务') : t('暂停定时任务'))}{/if}
                <span class="badge">{#if cur.enabled !== false && !isDone(cur)}<svg class="ok-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="m5.5 8.2 1.7 1.7 3.3-3.6"/></svg>{/if}{isDone(cur) ? t('已运行') : stateWord(cur)}</span>
                {#if mAt}<span class="fn warn-t">{t('错过了 {when}（服务器当时没在运行）', { when: whenText(mAt) })}</span>
                {:else if cur.enabled !== false && cur.nextRun}<span class="fn">{cur.schedule?.type === 'once' ? t('运行于：{when}', { when: whenText(cur.nextRun) }) : t('下次运行：{when}', { when: whenText(cur.nextRun) })}</span>{/if}
              </div>
            {/snippet}
            {@render section(t('状态'), statusB)}
            {#if cur.agent !== 'vertex'}
              {#snippet folderB()}
                <div class="chips">
                  <span class="chip" title={cur.cwd || rt.home}>{@render folderIc()}<span class="mono">{cur.cwd ? folderName(cur.cwd) : t('默认工作空间')}</span></span>
                  {#if cur.worktree}<span class="chip">{@render branchIc()}<span>{cur.branch ? t('每次从 {b} 切 worktree', { b: cur.branch }) : t('每次切新 worktree')}</span></span>{/if}
                </div>
              {/snippet}
              {@render section(t('文件夹'), folderB)}
            {/if}
            {#snippet repB()}<p class="txt">{schedText(cur.schedule)}{#if cur.schedule?.type !== 'manual'}<span class="fn">&nbsp;· {tzLabel(rt.tz)}</span>{/if}</p>{/snippet}
            {@render section(t('重复'), repB)}
            {#snippet modelB()}<p class="txt">{engineText(cur)} · {effortText(cur)}{#if cur.fast} · Fast{/if}{#if cur.agent === 'vertex' && cur.search} · {t('联网搜索')}{/if}</p>{/snippet}
            {@render section(t('模型'), modelB)}
            {#if cur.agent !== 'vertex'}
              {#snippet permB()}
                <p class="txt">{permText(cur.permissionMode)}<span class="fn">&nbsp;· {asks(cur.permissionMode || permDefault) ? t('要批准的操作会停下来等你') : modeDesc(cur.permissionMode || permDefault)}</span></p>
              {/snippet}
              {@render section(t('权限'), permB)}
              {#snippet sessB()}
                <p class="txt">{cur.sessionMode === 'continue' ? t('接着上次的会话') : t('每次新会话')}{#if cur.sessionMode === 'continue' && cur.threadSessionId} · <button class="link" onclick={() => openSessionId(cur.threadSessionId)}>{t('打开那个会话')}</button>{/if}</p>
              {/snippet}
              {@render section(t('会话方式'), sessB)}
            {/if}
            {#snippet notiB()}<p class="txt">{cur.notify ? t('每次跑完通知我') : t('不通知')}</p>{/snippet}
            {@render section(t('通知'), notiB)}
          </div>
          <div class="dcol">
            {#snippet instrB()}
              {@const long = (cur.prompt || '').split('\n').length > 3 || (cur.prompt || '').length > 270}
              <div class="instr" class:clamp={long && !showAllPrompt}>{cur.prompt}</div>
              {#if long}<button class="btn ghost xs" onclick={() => (showAllPrompt = !showAllPrompt)}>{showAllPrompt ? t('收起') : t('显示全部')}<span class="caret" class:up={showAllPrompt}>{@render chev()}</span></button>{/if}
            {/snippet}
            {@render section(t('指令'), instrB)}
            {#snippet histB()}
              {#if !(cur.runs || []).length}
                <p class="fn">{cur.lastRun ? t('上次运行：{when}（更早的记录没有保存）', { when: whenText(cur.lastRun) }) : t('还没有运行过。')}</p>
              {:else}
                <div class="hist">
                  {#each cur.runs as run (run.id)}
                    {@const k = runKind(run, cur)}
                    <button class="h-row" disabled={!run.sessionId} title={run.preview ? tr(run.preview) : ''} onclick={() => openSessionId(run.sessionId)}>
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
  {/if}

  {#if dlg}
    <!-- 宽屏编辑：640 对话框（官方 Edit scheduled task） -->
    <div class="dlg-bd" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) leaveForm(); }}>
      <div class="dlg" role="dialog" aria-modal="true" aria-label={t('编辑定时任务')}>
        <div class="dlg-h"><span>{t('编辑定时任务')}</span><button class="ibtn" aria-label={t('关闭')} onclick={leaveForm}>{@render closeIc()}</button></div>
        <div class="dlg-b">{@render formBody()}</div>
      </div>
    </div>
  {/if}

  <!-- 单例下拉 -->
  {#if pop}
    <button class="pop-bd" aria-label={t('关闭')} tabindex="-1" onclick={() => (pop = null)}></button>
    <div class="pop" role="menu" style:left={pop.x + 'px'} style:min-width={pop.w + 'px'}
      style:top={pop.up ? 'auto' : pop.y + 'px'} style:bottom={pop.up ? pop.y + 'px' : 'auto'}>
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
        {#if cur.lastSessionId}<button class="mi" onclick={() => { pop = null; openSessionId(cur.lastSessionId); }}><span class="mi-t">{t('打开最近一次的会话')}</span></button>{/if}
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
      {:else if pop.key === 'perm'}
        <button class="mi chk" class:sel={!f.permissionMode} onclick={() => pick(() => (f.permissionMode = ''))}><span class="mi-t">{t('设置默认（{mode}）', { mode: modeLabel(permDefault) })}</span><span class="mi-d">{t('跟着 设置 › Claude 里的默认权限模式走')}</span></button>
        {#each rt.permissionModes as m}<button class="mi chk" class:sel={f.permissionMode === m} onclick={() => pick(() => (f.permissionMode = m))}><span class="mi-t">{modeLabel(m)}</span><span class="mi-d">{asks(m) ? t('{desc}；无人值守时会停下来等你', { desc: modeDesc(m) }) : modeDesc(m)}</span></button>{/each}
      {:else if pop.key === 'model'}
        <div class="mi-h">{t('模型')}</div>
        {#each modelList as m}<button class="mi chk" class:sel={(f.model || defModel) === m.id} onclick={() => { f.model = m.id; if (f.effort && !effortList.some((e) => e.id === f.effort)) f.effort = null; }}><span class="mi-t">{tr(m.name)}</span></button>{/each}
        <div class="mi-sep"></div>
        <div class="mi-h">{t('思考强度')}</div>
        {#each effortList as e}<button class="mi chk" class:sel={(f.effort || defEffort) === e.id} onclick={() => (f.effort = e.id)}><span class="mi-t">{tr(e.name)}</span></button>{/each}
        {#if fastOk}
          <div class="mi-sep"></div>
          <div class="mi-row"><span class="mi-t">Fast<span class="mi-d">{t('更快出结果，按更高单价计费')}</span></span>{@render sw(f.fast, () => (f.fast = !f.fast), 'Fast')}</div>
        {/if}
      {/if}
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

  /* 横幅（官方 Banner neutral：py12 px16 rounded-card、surface-1 + 1px 环） */
  .banner { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: 12px; background: var(--st-surface); box-shadow: inset 0 0 0 1px var(--st-line); margin-bottom: 24px; color: var(--text); }
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
  .grid { list-style: none; margin: 0 0 12px; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-rows: 1fr; gap: 12px; }
  .wide .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-bottom: 24px; }
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

  /* ── 详情（官方 pt48、gap16，md 起两列 1 : 1.4） ── */
  .dwrap { max-width: 1120px; margin: 0 auto; padding: 32px 16px 32px; display: flex; flex-direction: column; gap: 16px; }
  .wide .dwrap { padding: 48px 32px 32px; }
  .dwrap > .banner, .dwrap > .err { margin: 0; }
  .dgrid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 28px; }
  .wide .dgrid { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 40px; }
  .dcol { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
  .sec { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .sec-h { font-size: 14px; font-weight: 400; color: var(--muted); margin: 0; }
  .txt { margin: 0; overflow-wrap: anywhere; }
  .fn { font-size: 13px; line-height: 17px; color: var(--muted); }
  .warn-t { color: #c2410c; }
  .status { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .badge { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 6px; background: var(--st-hover); font-size: 12.5px; font-weight: 500; }
  .ok-ic { width: 13px; height: 13px; color: #16a34a; }
  .chips { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  .chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 3px 6px; border-radius: 5px; background: var(--st-hover); font-size: 13px; line-height: 17px; }
  .chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .link { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
  .instr { color: var(--st-text2, var(--serif)); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .instr.clamp { max-height: 3lh; overflow: hidden; mask-image: linear-gradient(#000 45%, transparent); -webkit-mask-image: linear-gradient(#000 45%, transparent); }
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

  /* ── 表单（新建整页 max 720、gap 32；官方经典布局字段间 28） ── */
  .fwrap { max-width: 720px; margin: 0 auto; padding: 32px 16px 32px; }
  .wide .fwrap { padding: 48px 24px 32px; }
  .form { display: flex; flex-direction: column; gap: 28px; }
  .form .banner { margin: 0; }
  .fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .lbl { color: var(--muted); }
  .req { color: var(--crit, #d96a5a); }
  .inp { width: 100%; height: 32px; padding: 0 10px; border-radius: 8px; border: 0; background: var(--st-surface); box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; color: var(--text); outline: none; }
  .inp:focus { box-shadow: inset 0 0 0 1px var(--st-text2, var(--serif)), 0 0 0 3px var(--st-hover); }
  .inp.time { width: 140px; } .inp.num { width: 76px; } .inp.dt { width: 230px; max-width: 100%; }
  /* 指令框：fill-secondary + 环，聚焦出焦点环；下面挂工具条与位置条 */
  .ibox { display: flex; flex-direction: column; border-radius: 8px; background: var(--st-surface); box-shadow: inset 0 0 0 1px var(--st-line); overflow: hidden; transition: box-shadow .15s; }
  .ibox:focus-within { box-shadow: inset 0 0 0 1px var(--st-text2, var(--serif)), 0 0 0 3px var(--st-hover); }
  .ta { display: block; width: 100%; min-height: 120px; max-height: 300px; resize: none; overflow-y: auto; background: none; border: 0; outline: 0; font: inherit; color: var(--text); padding: 8px 12px; }
  .tbar { display: flex; align-items: center; gap: 3px; padding: 0 8px 8px; min-width: 0; }
  .locbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 5px 8px; background: var(--st-hover); min-width: 0; }
  /* 药丸选择器（官方 Xe：虚线描边小芯片，13px，muted，悬停变主色） */
  .pill { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; min-width: 0; padding: 2px 6px; border-radius: 5px; border: 1px dashed var(--st-line); font-size: 13px; line-height: 17px; color: var(--muted); }
  .pill:hover:not(:disabled) { color: var(--text); background: var(--st-hover); }
  .pill.set { color: var(--st-text2, var(--serif)); }
  .pill:disabled { opacity: .45; }
  .pill-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .wt { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
  .wt.dim { opacity: .6; }
  .note { margin: 0; font-size: 13px; line-height: 17px; color: var(--muted); }
  /* 频率分段条（官方 Kt：alpha-1 底、p2、选中 alpha-2） */
  .seg { display: inline-flex; flex-wrap: wrap; gap: 3px; padding: 2px; border-radius: 8px; background: var(--st-hover); align-self: flex-start; max-width: 100%; }
  .seg button { padding: 3px 8px; border-radius: 5px; font-size: 13px; line-height: 17px; color: var(--muted); white-space: nowrap; }
  .seg button:hover { color: var(--text); background: var(--st-sel, var(--hover-strong)); }
  .seg button.on { color: var(--text); background: var(--st-sel, var(--hover-strong)); }
  .seg.sm { align-self: center; flex: none; }
  .when { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--st-text2, var(--serif)); margin-top: 6px; }
  .days { display: inline-flex; gap: 3px; flex-wrap: wrap; }
  .day { min-width: 30px; height: 28px; padding: 0 6px; border-radius: 6px; font-size: 13px; color: var(--muted); box-shadow: inset 0 0 0 1px var(--st-line); }
  .day:hover { color: var(--text); }
  .day.on { background: var(--st-primary); color: var(--st-primary-ink); box-shadow: none; }
  .cronf { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .sub { font-size: 13px; line-height: 17px; color: var(--muted); }
  .bad { font-size: 13px; line-height: 17px; color: var(--crit, #d96a5a); }
  /* 「运行」卡（官方 unified 卡片行风格：px16 py14，相邻行细线） */
  .rows { border-radius: 12px; box-shadow: inset 0 0 0 1px var(--st-line); background: var(--st-surface); }
  .r { display: flex; align-items: center; gap: 12px; padding: 12px 16px; min-height: 52px; }
  .r + .r { border-top: 1px solid var(--st-hair, var(--divider)); }
  .r-k { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .r-sub { font-size: 13px; line-height: 17px; color: var(--muted); }
  .form .err { margin: 0; }
  .foot { display: flex; justify-content: flex-end; gap: 6px; }
  .rt:not(.wide) .foot .btn { flex: 1; height: 40px; }

  /* ── 编辑对话框（640，居中，不全屏；内容自己滚） ── */
  .dlg-bd { position: absolute; inset: 0; z-index: 60; background: var(--st-backdrop, rgba(0,0,0,.45)); display: flex; align-items: center; justify-content: center; padding: 24px 16px; animation: fadeIn .15s ease; }
  @keyframes fadeIn { from { opacity: 0; } }
  .dlg { width: 640px; max-width: calc(100% - 32px); max-height: 100%; display: flex; flex-direction: column; border-radius: 16px; background: var(--bg); box-shadow: var(--st-menu-shadow, var(--q-shadow)); animation: dlgIn .2s var(--ea-out, ease); }
  @keyframes dlgIn { from { opacity: 0; transform: translateY(8px) scale(.98); } }
  .dlg-h { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px 24px; font-size: 16px; font-weight: 500; }
  .dlg-b { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 24px 20px; }
  .dlg-b .banner { display: none; }

  /* ── 下拉 ── */
  .pop-bd { position: fixed; inset: 0; z-index: 90; cursor: default; }
  .pop { position: fixed; z-index: 91; max-width: min(380px, calc(100vw - 16px)); max-height: min(420px, 60vh); overflow-y: auto; padding: 4px;
    border-radius: 10px; background: var(--st-menu, var(--q-card)); box-shadow: var(--st-menu-shadow, var(--q-shadow)); animation: popIn .14s var(--ea-out, ease); }
  @keyframes popIn { from { opacity: 0; transform: translateY(-3px) scale(.98); } }
  .mi { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 10px; border-radius: 6px; text-align: left; position: relative; }
  .mi.chk { padding-left: 28px; }
  .mi:hover:not(:disabled) { background: var(--st-hover); }
  .mi:disabled { opacity: .45; }
  .mi.sel::before { content: ''; position: absolute; left: 10px; top: 13px; width: 9px; height: 5px; border: solid currentColor; border-width: 0 0 1.5px 1.5px; transform: rotate(-45deg); }
  .mi-t { font-size: 14px; color: var(--text); display: flex; flex-direction: column; }
  .mi-d { font-size: 12.5px; line-height: 16px; color: var(--muted); }
  .mi-d.mono { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .mi-n { position: absolute; right: 10px; top: 7px; font-size: 12.5px; color: var(--muted); }
  .mi-h { font-size: 12px; color: var(--muted); padding: 6px 10px 2px; }
  .mi-row { display: flex; align-items: center; gap: 12px; padding: 6px 10px; }
  .mi-row .mi-t { flex: 1; }
  .mi-empty { padding: 6px 10px; font-size: 13px; color: var(--muted); }
  .mi.danger .mi-t { color: var(--crit, #d96a5a); }
  .mi-sep { height: 1px; background: var(--st-hair, var(--divider)); margin: 4px 6px; }
</style>
