<script>
  // 会话信息面板（官方 Desktop 2.37337 的 Session rail，cf74bc599 rD / c73f45bc3 Df 卡片外壳逆向）。
  // 一列圆角卡片：环境 / 上下文 / 连接器 / 输出内容 / 更改。标题旁的箭头是折叠（›=收起、⌄=展开），
  // 收起时标题右侧露摘要；Alt+点标题 = 全部一起展开/收起（官方同款）。
  // 宽的时候停靠在聊天区右侧（280px 悬浮，不挤正文）；不够宽就是工具条下面的弹层，点外面 / Esc 收起。
  // 数据：环境 = 项目 + 工作台 meta（分支 / worktree）；上下文 = 用量圆环同一份；连接器 = 每轮 init 帧的
  // MCP 状态；输出内容 = 服务端按 transcript 推算（/api/claude/session-rail）；更改 = 审阅面板那份 git diff。
  // 官方还有一行 Remote Control 开关——它要全权限登录，bridge 的推理令牌开不了，不摆。
  import { session, status, ui, pluginOn, settings, caps } from '../../lib/state.svelte.js';
  import { cp, claudeModelChoices, effortsFor, isCustomModel, effectiveEffort, defaultEffortFor, ensureCustomModels } from '../../lib/claudeProviders.svelte.js';
  import { claudeDefaultModel, claudeEffortFallback } from '../../lib/caps.js';
  import { dock, toggleDockView, openDockFiles, ensureDockMeta } from '../../lib/dock.svelte.js';
  import { chat, send, queueSend, mcpState, openSession } from '../../lib/chat.svelte.js';
  import { REL_LABEL, openFamilySession } from '../../lib/sessionFamily.svelte.js';
  import { isProjectView } from '../../lib/permissions.svelte.js';
  import { proj, loadProject, saveProject, resolveThread, stopThread, readMemory, writeMemory } from '../../lib/projectMode.svelte.js';
  import { busOn } from '../../lib/bus.js';
  import { untrack } from 'svelte';
  import SuggestedTasksCard from './SuggestedTasksCard.svelte';   // 「建议的任务」：Claude 提议了还没开的会话卡
  import PrCard from './PrCard.svelte';
  import McpAuthFlow from './McpAuthFlow.svelte';   // needs-auth 连接器的「授权」流程（lib/mcpAuth.svelte.js）
  import { authFlow, startAuth } from '../../lib/mcpAuth.svelte.js';   // 「拉取请求」卡（PR/CI 闭环，自带数据与样式）
  import { rail, toggleRail, railVisible, isFolded, toggleFold } from '../../lib/sessionRail.svelte.js';
  import { ctxSummary, fmtCompact } from '../../lib/ctxUsage.js';
  import { openPreview } from '../../lib/preview.svelte.js';
  import { api } from '../../lib/api.js';
  import { IS_CSNAP } from '../../lib/csnap.js';
  import { t, tr } from '../../lib/i18n.js';

  // name：项目名（芯片同款）；path：工作目录绝对路径
  let { name = '', path = '' } = $props();

  // 宽窄自己量：挂载点（聊天区）够宽就停靠在右侧、正文与输入栏让出 300px（官方同款，见下方 rail-docked），
  // 不够宽就是弹层。门槛 = 正文最小舒适宽度 760 + 面板 300。
  let probe = $state(null);
  $effect(() => {
    const host = probe && probe.parentElement;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { rail.narrow = host.clientWidth < 1060; });
    ro.observe(host);
    rail.narrow = host.clientWidth < 1060;
    return () => ro.disconnect();
  });
  // 停靠时给挂载点打标，正文滚动区与输入栏据此让出右侧（样式在本文件 :global 规则里）
  $effect(() => {
    const host = probe && probe.parentElement;
    if (!host) return;
    const on = docked && visible && !!sid;
    host.classList.toggle('rail-docked', on);
    return () => host.classList.remove('rail-docked');
  });
  const docked = $derived(!rail.narrow);
  const visible = $derived(railVisible());

  const sid = $derived(session.id || '');

  // —— 服务端数据：输出内容 + 连接器兜底；会话切换 / 一轮收尾时重拉 ——
  let railData = $state({ outputs: [], mcp: null, family: null, for: '' });
  let review = $state({ git: false, add: 0, del: 0, for: '' });
  async function loadRail(id) {
    if (!id || IS_CSNAP) { railData = { outputs: [], mcp: null, family: null, for: '' }; return; }
    try {
      const r = await api.get(`/api/claude/session-rail?id=${encodeURIComponent(id)}`);
      if (session.id === id) railData = { outputs: Array.isArray(r?.outputs) ? r.outputs : [], mcp: r?.mcp || null, family: r?.family || null, for: id };
    } catch { if (session.id === id) railData = { outputs: [], mcp: null, family: null, for: id }; }
  }
  async function loadReview(ws) {
    if (!ws) { review = { git: false, add: 0, del: 0, for: '' }; return; }
    try {
      const d = await api.get(`/api/claude/review?ws=${encodeURIComponent(ws)}`);
      if (dock.ws === ws) review = { git: !!d?.git, add: d?.total?.add || 0, del: d?.total?.del || 0, for: ws };
    } catch { if (dock.ws === ws) review = { git: false, add: 0, del: 0, for: ws }; }
  }
  let wasBusy = false;
  // 一轮收尾后的「更改」重拉去抖 3 秒：几秒内接连收尾的几轮（排队的消息、子会话陆续收工）只跑最后一次
  // git diff；到点时面板已经收起就记一笔，等面板再打开时补拉（FR2 ③）。
  // 「更改」卡折叠时标题右侧仍露 +N −M 摘要，所以折叠不算不拉的理由。
  let reviewT = 0, reviewStale = false;
  $effect(() => {
    const id = sid, ws = dock.ws, busy = session.busy;
    if (!visible) return;
    // 打开时、换会话时、一轮刚收尾时各拉一次（跑的过程中不追着拉，免得 git diff 被反复执行）
    const settled = wasBusy && !busy;
    wasBusy = busy;
    if (railData.for !== id || settled) loadRail(id);
    if (review.for !== ws || reviewStale) { clearTimeout(reviewT); reviewT = 0; reviewStale = false; loadReview(ws); }
    else if (settled) {
      clearTimeout(reviewT);
      reviewT = setTimeout(() => {
        reviewT = 0;
        if (dock.ws !== ws) return;          // 换了工作区：上面 review.for !== ws 那条自己会拉
        if (railVisible()) loadReview(ws); else reviewStale = true;
      }, 3000);
    }
    if (ws && !dock.meta) ensureDockMeta();
  });
  $effect(() => () => clearTimeout(reviewT));

  // —— 环境 ——
  const parent = $derived.by(() => {
    if (!path) return '';
    const p = String(path).replace(/[\\/]+$/, '');
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i > 0 ? p.slice(0, i) : '';
  });
  const folder = $derived.by(() => {
    const p = String(path || '').replace(/[\\/]+$/, '');
    return name || p.split(/[\\/]/).pop() || '';
  });
  const branch = $derived(dock.meta?.git ? (dock.meta.branch || '') : '');
  const isWt = $derived(!!dock.meta?.worktree);

  // —— 上下文（与用量圆环同一份：status.usages 优先，旧 status.contexts 兜底）——
  const ctx = $derived.by(() => {
    if (!sid) return null;
    const u = status.usages[sid];
    if (u) return { ...ctxSummary(u.total, u.max), used: u.total, max: u.max };
    const c = status.contexts[sid] || (status.context && status.context.sessionId === sid ? status.context : null);
    return c ? { ...ctxSummary(c.used, c.total), used: c.used, max: c.total } : null;
  });
  const ctxPct = $derived(ctx && ctx.pct != null ? ctx.pct : null);
  const ctxTone = $derived(ctxPct == null ? '' : ctxPct >= 90 ? 'danger' : ctxPct >= 75 ? 'warn' : 'accent');
  const compacting = $derived(!!chat.messages.at(-1)?.compacting);

  // —— 连接器 ——
  const servers = $derived((mcpState.bySession[sid]?.servers) || railData.mcp?.servers || []);
  const needFix = $derived(servers.filter((s) => s.status === 'failed' || s.status === 'needs-auth'));
  const STATUS_TXT = { failed: '重新连接', 'needs-auth': '需要登录', pending: '连接中…', disabled: '已停用', connected: '已连接' };
  const connSummary = $derived(needFix.length ? t('{n} 项待重新连接', { n: needFix.length }) : t('{n} 个已连接', { n: servers.length }));
  const connList = $derived([...needFix, ...servers.filter((s) => !needFix.includes(s))].slice(0, 3));

  // —— 相关会话（会话协作：父 / 子 / 兄弟，session-family）——
  const fam = $derived(railData.for === sid ? railData.family : null);
  const famRows = $derived(fam ? [...(fam.parent ? [fam.parent] : []), ...fam.children, ...fam.siblings] : []);
  const famWorking = $derived(famRows.filter((r) => r.state === 'working').length);
  // 项目对话（运行档位 › 项目）：子会话就是讨论串——卡名换成「讨论串」，每行按状态点：等你（有审批卡 / 提问在等）> 进行中 > 空闲
  const famProject = $derived(!!fam?.project);
  const famWaiting = $derived(famProject ? famRows.filter((r) => r.waiting).length : 0);
  const famSummary = $derived(famProject
    ? (famWaiting ? t('{n} 条等你', { n: famWaiting }) : famWorking ? t('{n} 条进行中', { n: famWorking }) : t('{n} 条', { n: famRows.length }))
    : famWorking ? t('{n} 个在干活', { n: famWorking }) : t('{n} 个', { n: famRows.length }));
  // 讨论串绑定的 PR 开着：bridge 代管着自动合并 = 合并中，否则 = 待评审（草稿 PR 不算，照常按在跑 / 空闲）
  const prOpen = (r) => !!r.pr && r.pr.state === 'open';
  const threadState = (r) => (r.waiting ? 'wait' : r.state === 'working' ? 'work' : r.resolved ? 'done' : prOpen(r) ? (r.pr.landing ? 'land' : 'review') : 'idle');
  const THREAD_LABEL = { review: '待评审', wait: '等你', work: '进行中', land: '合并中', idle: '空闲', done: '已解决' };

  // —— 项目概览（项目对话：讨论串按状态分组 + 暂停 / 恢复 + 项目说明 + 项目记忆，lib/projectMode.svelte.js）——
  // 官方六组同序：待评审 / 等你 / 进行中 / 合并中 / 空闲 / 已解决（已解决默认收起；PR 状态用台账里记的，不现读 GitHub）
  const projView = $derived(!!sid && (isProjectView(sid) || !!fam?.project));
  const pv = $derived(projView ? proj.views[sid] || null : null);
  $effect(() => { if (visible && projView && sid) { const id = sid; untrack(() => loadProject(id)); } });
  // 项目状态变了（标已解决、暂停、别的设备改了）：讨论串的分组跟着重拉
  $effect(() => busOn((ev) => { if (ev && ev.type === 'project' && ev.sessionId === session.id && railVisible()) loadRail(session.id); }));
  const threads = $derived(projView && fam ? fam.children : []);
  const GROUPS = ['review', 'wait', 'work', 'land', 'idle', 'done'];
  const grouped = $derived(GROUPS.map((g) => ({ g, rows: threads.filter((r) => threadState(r) === g) })).filter((x) => x.rows.length));
  let showDone = $state(false);
  $effect(() => { sid; showDone = false; });
  const projSummary = $derived(pv?.paused ? t('已暂停')
    : famWaiting ? t('{n} 条等你', { n: famWaiting })
    : t('在跑 {n}/{max}', { n: famWorking, max: pv?.limits?.maxLive || 4 }));
  // 用量按讨论串拆分（服务端读 transcript 里 CLI 记的累计花费，按 API 价折算）
  const usd = (n) => (n >= 10 ? '$' + n.toFixed(1) : '$' + (n || 0).toFixed(2));
  const costTitle = $derived(fam && fam.cost ? t('这个项目累计约 {total}（按 API 价折算）：协调者 {coord}，讨论串 {threads}', { total: usd(fam.cost.coordinator + fam.cost.threads), coord: usd(fam.cost.coordinator), threads: usd(fam.cost.threads) }) : '');
  let pausing = $state(false);
  async function togglePause() {
    if (!pv || pausing) return;
    pausing = true;
    try { await saveProject(sid, { paused: !pv.paused }); loadRail(sid); } finally { pausing = false; }
  }
  async function markResolved(r, v) { if (await resolveThread(sid, r.id, v)) loadRail(sid); }
  async function stopRow(r) { if (await stopThread(r.id)) setTimeout(() => loadRail(sid), 800); }

  // 模型：协调者 = 输入框里选的（settings.model / effort，同输入框芯片的口径）；讨论串 = 这里另选的 → 设置 › 项目对话 → 跟协调者。
  // 只管之后新开的讨论串：开出来的各自记着自己的模型，在讨论串里照样能换
  const modelChoices = $derived(claudeModelChoices(caps.data));
  const modelNameOf = (id) => { const m = modelChoices.find((x) => x.id === id); return m ? tr(m.name) : isCustomModel(id) ? t('已停用的自定义模型') : id; };
  const effortNameOf = (model, id) => { if (!id) return t('默认'); const e = effortsFor(model, caps.data).find((x) => x.id === id); return e ? tr(e.name) : id; };
  const coordModel = $derived(settings.model || claudeDefaultModel(caps.data));
  const coordEffort = $derived(isCustomModel(coordModel) ? (effectiveEffort(coordModel, settings.effort) || defaultEffortFor(coordModel) || '') : (settings.effort || claudeEffortFallback(caps.data, coordModel)));
  const coordText = $derived(modelNameOf(coordModel) + ' · ' + effortNameOf(coordModel, coordEffort));
  const tmDefault = $derived(pv?.thread?.defaultModel || '');
  const threadModel = $derived(pv?.thread?.model || tmDefault || coordModel);   // 讨论串实际会用的
  const tmDefaultName = $derived(tmDefault ? modelNameOf(tmDefault) : t('跟协调者'));
  const tmOpts = $derived.by(() => {
    const list = modelChoices.map((m) => ({ id: m.id, name: tr(m.name) }));
    const cur = pv?.thread?.model;
    if (cur && !list.some((m) => m.id === cur)) list.push({ id: cur, name: modelNameOf(cur) });
    return list;
  });
  const teOpts = $derived.by(() => {
    const list = effortsFor(threadModel, caps.data).filter((e) => e.id && e.id !== 'ultracode').map((e) => ({ id: e.id, name: tr(e.name) }));
    const cur = pv?.thread?.effort;
    if (cur && !list.some((e) => e.id === cur)) list.push({ id: cur, name: cur });
    return list;
  });
  const teDefaultName = $derived(effortNameOf(threadModel, pv?.thread?.defaultEffort || ''));
  const threadSum = $derived(modelNameOf(threadModel) + ' · ' + effortNameOf(threadModel, pv?.thread?.effort || pv?.thread?.defaultEffort || ''));
  $effect(() => { if (projView && isCustomModel(threadModel) && !cp.modelsReady) ensureCustomModels(); });
  // 每次改动照发（两个下拉连着改也不丢）；没存上把下拉退回原值（value 是单向的，界面不会自己回去）
  async function setThread(k, el) {
    if (!pv) return;
    const prev = (pv.thread && pv.thread[k === 'threadModel' ? 'model' : 'effort']) || '';
    if (!(await saveProject(sid, { [k]: el.value }))) el.value = prev;
  }

  // 项目说明：点「编辑」原地改（官方上限 16000 字）
  let instrEdit = $state(false), instrDraft = $state(''), instrBusy = $state(false);
  $effect(() => { sid; instrEdit = false; });
  function editInstr() { instrDraft = pv?.instructions || ''; instrEdit = true; }
  async function saveInstr() {
    if (instrBusy) return;
    instrBusy = true;
    try { if (await saveProject(sid, { instructions: instrDraft })) instrEdit = false; } finally { instrBusy = false; }
  }

  // 项目记忆：点一篇展开看全文，能改能删；「新建」写一篇（MEMORY.md 是索引）
  let memOpen = $state(''), memText = $state(''), memEdit = $state(false), memDraft = $state(''), memName = $state(''), memBusy = $state(false), memDelArm = $state(false);
  $effect(() => { sid; memOpen = ''; memEdit = false; });
  $effect(() => { memOpen; memEdit; memDelArm = false; });
  async function openMem(name) {
    if (memOpen === name) { memOpen = ''; memEdit = false; return; }
    const c = await readMemory(sid, name);
    if (c === null) return;
    memOpen = name; memText = c; memEdit = false;
  }
  function newMem() { memOpen = '+'; memName = (pv?.memory || []).some((f) => f.name === 'MEMORY.md') ? '' : 'MEMORY.md'; memDraft = ''; memEdit = true; }
  function editMem() { memDraft = memText; memEdit = true; }
  async function saveMem() {
    if (memBusy) return;
    const name = memOpen === '+' ? memName.trim() : memOpen;
    if (!name) return;
    memBusy = true;
    try { if (await writeMemory(sid, /\.md$/i.test(name) ? name : name + '.md', memDraft)) { memText = memDraft; memEdit = false; if (memOpen === '+') memOpen = ''; } } finally { memBusy = false; }
  }
  async function deleteMem() {
    if (memBusy || !memOpen || memOpen === '+') return;
    memBusy = true;
    try { if (await writeMemory(sid, memOpen, null)) { memOpen = ''; memEdit = false; } } finally { memBusy = false; }
  }
  const kb = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB');
  // 有会话在干活时每 6 秒重拉一次（子会话收工、父会话被唤醒，这张卡要跟上）
  $effect(() => {
    if (!visible || !sid || !famWorking) return;
    const id = sid;
    const timer = setInterval(() => { if (!document.hidden) loadRail(id); }, 6000);
    return () => clearInterval(timer);
  });

  // —— 输出内容 ——
  let outMore = $state(false);
  const outputs = $derived(railData.for === sid ? railData.outputs : []);
  const outShown = $derived(outMore ? outputs : outputs.slice(0, 5));
  $effect(() => { sid; outMore = false; });

  // —— 更改 ——
  const hasChanges = $derived(review.add > 0 || review.del > 0);
  const COMMIT_MSG = '把工作区的改动提交，写一条合适的提交说明。';
  function commitChanges() {
    if (!hasChanges || !sid) return;
    // 官方「Commit changes」= 以用户身份给 Claude 发一条消息让它自己提交；工作中就排进队列
    if (session.busy) queueSend(COMMIT_MSG, []);
    else send(COMMIT_MSG, []);
  }
  const num = (n) => Number(n || 0).toLocaleString();

  function head(e, card) { toggleFold(card, e.altKey); }

  // 弹层模式：点外面 / Esc 收起
  let rootEl = $state(null);
  $effect(() => {
    if (docked || !visible) return;
    const down = (e) => {
      if (rootEl && rootEl.contains(e.target)) return;
      if (e.target.closest && e.target.closest('[data-rail-toggle]')) return;
      toggleRail(false);
    };
    const key = (e) => { if (e.key === 'Escape') toggleRail(false); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  });
</script>

{#snippet caret(card)}<svg class="rc-caret" class:open={!isFolded(card)} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>{/snippet}
{#snippet ic(d)}<span class="rr-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{@html d}</svg></span>{/snippet}
<!-- 项目记忆展开的一篇：看 / 改 / 删（删要点两下）；memOpen === '+' 是新建 -->
{#snippet memBody()}
  <div class="p-mem">
    {#if memEdit}
      {#if memOpen === '+'}<input class="p-in" bind:value={memName} placeholder="decisions.md" aria-label={t('文件名')} />{/if}
      <textarea class="p-ta" rows="8" bind:value={memDraft}></textarea>
      <div class="p-acts"><span class="rr-grow"></span><button class="rbtn" onclick={() => { memEdit = false; if (memOpen === '+') memOpen = ''; }}>{t('取消')}</button><button class="rbtn pri" disabled={memBusy || (memOpen === '+' && !memName.trim())} onclick={saveMem}>{t('保存')}</button></div>
    {:else}
      <div class="p-text">{memText || t('（这篇是空的）')}</div>
      <div class="p-acts"><span class="rr-grow"></span>
        <button class="rbtn" class:danger={memDelArm} disabled={memBusy} onclick={() => (memDelArm ? deleteMem() : (memDelArm = true))}>{memDelArm ? t('确认删除') : t('删除')}</button>
        <button class="rbtn" onclick={editMem}>{t('编辑')}</button>
      </div>
    {/if}
  </div>
{/snippet}

<span class="rail-probe" bind:this={probe} aria-hidden="true"></span>
{#if visible && sid}
  <aside class="rail" class:docked class:pop={!docked} bind:this={rootEl} aria-label={t('会话信息')}>
    <div class="rail-scroll">
      <!-- 环境 -->
      {#if folder || branch}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'environment')}>{t('环境')}{@render caret('environment')}</button>
            {#if isFolded('environment')}<span class="rc-sum">{folder || branch}</span>{/if}
          </div>
          {#if !isFolded('environment')}
            <div class="rc-body">
              <div class="rr">{@render ic('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M2 20h20"/>')}<span class="rr-txt">{t('这台电脑')}</span></div>
              {#if folder}
                <button class="rr click" title={path} onclick={() => openDockFiles({})}>
                  {@render ic('<path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/>')}
                  <span class="rr-txt rr-name">{folder}</span>
                  {#if parent}<span class="rr-dim">· {parent}</span>{/if}
                </button>
              {/if}
              {#if branch}
                <div class="rr">{@render ic('<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6 3.5-11 7"/>')}<span class="rr-txt">{branch}</span>{#if isWt}<span class="rr-dim">· worktree</span>{/if}</div>
              {/if}
            </div>
          {/if}
        </section>
      {/if}

      {#if projView}
        <!-- 项目概览：讨论串按状态分组（待评审 / 等你 / 进行中 / 合并中 / 空闲 / 已解决），行尾 PR 号、停止 / 标为已解决；卡头暂停 / 恢复整个项目 -->
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'family')}>{t('讨论串')}{@render caret('family')}</button>
            <span class="rc-sum" class:warn={!!pv?.paused} title={costTitle}>{projSummary}</span>
            {#if pv}<button class="rbtn" disabled={pausing} title={pv.paused ? t('恢复后协调者接着派活，攒着的汇报一起送到') : t('停下项目对话和所有在跑的讨论串，恢复前不开新的')} onclick={togglePause}>{pv.paused ? t('恢复') : t('暂停')}</button>{/if}
          </div>
          {#if !isFolded('family')}
            <div class="rc-body">
              {#if !threads.length}<div class="rr"><span class="rr-dim small">{t('还没有讨论串：在下面跟协调者说要做什么')}</span></div>{/if}
              {#each grouped as grp (grp.g)}
                {#if grp.g === 'done'}
                  <button class="rr click grp" aria-expanded={showDone} onclick={() => (showDone = !showDone)}><span class="rr-dim small">{t('已解决')} · {grp.rows.length}</span><svg class="rc-caret" class:open={showDone} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>
                {:else}
                  <div class="rr grp"><span class="rr-dim small">{t(THREAD_LABEL[grp.g])} · {grp.rows.length}</span></div>
                {/if}
                {#if grp.g !== 'done' || showDone}
                  {#each grp.rows as r (r.id)}
                    <div class="rr th">
                      <button class="th-open" title={(r.report || r.title || '') + (r.cost ? '\n' + t('约 {cost}（按 API 价折算）', { cost: usd(r.cost) }) : '')} onclick={() => (r.agent === 'dimensio' ? openFamilySession(r.id, 'dimensio') : openSession(r.id))}>
                        <span class="th-dot {grp.g}" aria-hidden="true"></span>
                        <span class="rr-txt">{r.title || r.name || t('（无标题）')}</span>
                      </button>
                      {#if r.pr && r.pr.url}<a class="th-pr" href={r.pr.url} target="_blank" rel="noopener noreferrer" title={t('在 GitHub 上打开拉取请求')}>#{r.pr.number}</a>{/if}
                      <span class="th-acts">
                        {#if r.state === 'working'}
                          <button class="th-act" title={t('停止')} aria-label={t('停止')} onclick={() => stopRow(r)}><svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></button>
                        {/if}
                        {#if grp.g === 'done'}
                          <button class="th-act txt" onclick={() => markResolved(r, false)}>{t('重新打开')}</button>
                        {:else if r.state !== 'working'}
                          <button class="th-act" title={t('标为已解决')} aria-label={t('标为已解决')} onclick={() => markResolved(r, true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
                        {/if}
                      </span>
                    </div>
                  {/each}
                {/if}
              {/each}
            </div>
          {/if}
        </section>

        <!-- 模型：协调者用输入框里选的；讨论串在这里另选（只影响之后新开的） -->
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'pmodel')}>{t('模型')}{@render caret('pmodel')}</button>
            <span class="rc-sum" class:hide={!isFolded('pmodel')}>{threadSum}</span>
          </div>
          {#if !isFolded('pmodel')}
            <div class="rc-body">
              <div class="rr"><span class="rr-txt">{t('协调者')}</span><span class="rr-grow"></span><span class="rr-st p-val" title={t('在输入框里换')}>{coordText}</span></div>
              <div class="rr">
                <span class="rr-txt">{t('讨论串')}</span><span class="rr-grow"></span>
                <select class="p-sel" aria-label={t('讨论串模型')} disabled={!pv} value={pv?.thread?.model || ''} onchange={(e) => setThread('threadModel', e.currentTarget)}>
                  <option value="">{t('默认（{name}）', { name: tmDefaultName })}</option>
                  {#each tmOpts as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
                </select>
              </div>
              <div class="rr">
                <span class="rr-txt">{t('讨论串推理强度')}</span><span class="rr-grow"></span>
                <select class="p-sel" aria-label={t('讨论串推理强度')} disabled={!pv} value={pv?.thread?.effort || ''} onchange={(e) => setThread('threadEffort', e.currentTarget)}>
                  <option value="">{t('默认（{name}）', { name: teDefaultName })}</option>
                  {#each teOpts as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
                </select>
              </div>
              <div class="rr"><span class="rr-dim small">{t('只影响之后新开的讨论串')}</span></div>
            </div>
          {/if}
        </section>

        <!-- 项目说明：协调者和每条讨论串都要遵守的规矩（拼进它们的提示词） -->
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'pinstr')}>{t('项目说明')}{@render caret('pinstr')}</button>
            <span class="rr-grow"></span>
            {#if pv && !instrEdit && !isFolded('pinstr')}<button class="rbtn" onclick={editInstr}>{pv.instructions ? t('编辑') : t('添加')}</button>{/if}
          </div>
          {#if !isFolded('pinstr')}
            <div class="rc-body">
              {#if instrEdit}
                <textarea class="p-ta" rows="7" maxlength={pv?.limits?.instructionsMax || 16000} bind:value={instrDraft} placeholder={t('比如：所有改动都要带单测；不要动 legacy 目录')}></textarea>
                <div class="p-acts"><span class="rr-dim small">{instrDraft.length} / {pv?.limits?.instructionsMax || 16000}</span><span class="rr-grow"></span><button class="rbtn" onclick={() => (instrEdit = false)}>{t('取消')}</button><button class="rbtn pri" disabled={instrBusy} onclick={saveInstr}>{t('保存')}</button></div>
              {:else if pv && pv.instructions}
                <div class="p-text clamp">{pv.instructions}</div>
              {:else}
                <div class="rr"><span class="rr-dim small">{t('写下这个项目里协调者和每条讨论串都要遵守的规矩')}</span></div>
              {/if}
            </div>
          {/if}
        </section>

        <!-- 项目记忆：协调者和讨论串共用的笔记（MEMORY.md 是索引）；点一篇展开，能改能删 -->
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'pmem')}>{t('项目记忆')}{@render caret('pmem')}</button>
            <span class="rc-sum" class:hide={!isFolded('pmem')}>{t('{n} 篇', { n: pv?.memory?.length || 0 })}</span>
            {#if pv && !isFolded('pmem')}<span class="rr-grow"></span><button class="rbtn" onclick={newMem}>{t('新建')}</button>{/if}
          </div>
          {#if !isFolded('pmem')}
            <div class="rc-body">
              {#if !(pv?.memory?.length) && memOpen !== '+'}<div class="rr"><span class="rr-dim small">{t('协调者会把需求、决定和你的偏好记在这里')}</span></div>{/if}
              {#each pv?.memory || [] as f (f.name)}
                <button class="rr click" aria-expanded={memOpen === f.name} onclick={() => openMem(f.name)}>
                  {@render ic('<path d="M6.5 3.5h7.5l4 4v13h-11.5z"/><path d="M14 3.5v4h4"/>')}
                  <span class="rr-txt">{f.name}</span><span class="rr-grow"></span><span class="rr-st">{kb(f.size)}</span>
                </button>
                {#if memOpen === f.name}{@render memBody()}{/if}
              {/each}
              {#if memOpen === '+'}{@render memBody()}{/if}
            </div>
          {/if}
        </section>
      <!-- 相关会话（会话协作）：父会话、它派生的子会话、兄弟会话；点一行打开那个会话 -->
      {:else if famRows.length}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'family')}>{famProject ? t('讨论串') : t('相关会话')}{@render caret('family')}</button>
            <span class="rc-sum" class:hide={!isFolded('family')}>{famSummary}</span>
          </div>
          {#if !isFolded('family')}
            <div class="rc-body">
              {#each famRows as r (r.id)}
                <!-- 跨 agent（11-03）：dimensio 那边的会话（r.agent）标出来，点了去 dimensio 页 -->
                <button class="rr click fam" title={r.report || r.title} onclick={() => (r.agent === 'dimensio' ? openFamilySession(r.id, 'dimensio') : openSession(r.id))}>
                  {@render ic(r.relation === 'parent' ? '<path d="M12 19V7"/><path d="M7 11l5-5 5 5"/>' : r.relation === 'child' ? '<path d="M6 5v7a3 3 0 0 0 3 3h9"/><path d="M14 11l4 4-4 4"/>' : '<path d="M6 5v14M18 5v14M6 12h12"/>')}
                  <span class="rr-txt">{r.title || r.name || t('（无标题）')}</span>
                  <span class="rr-grow"></span>
                  {#if famProject && r.relation === 'child'}
                    {@const st = threadState(r)}
                    <span class="th-dot {st}" aria-hidden="true"></span>
                    <span class="rr-st" class:wait={st === 'wait'}>{t(THREAD_LABEL[st])}{#if r.agent === 'dimensio'} · dimensio{/if}</span>
                  {:else}
                    {#if r.state === 'working'}<span class="fam-dot" aria-hidden="true"></span>{/if}
                    <span class="rr-st">{t(REL_LABEL[r.relation] || REL_LABEL.linked)}{#if r.agent === 'dimensio'} · dimensio{/if}</span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      <!-- 建议的任务（会话协作：Claude 提议、还没开的会话卡，官方 “{count} suggested tasks”） -->
      <SuggestedTasksCard />

      <!-- 上下文 -->
      {#if !IS_CSNAP}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'context')}>{t('上下文')}{@render caret('context')}</button>
            <span class="rc-sum" class:hide={!isFolded('context')}>
              {#if ctxPct != null}{ctxPct}%<span class="bar"><span class="bar-fill {ctxTone}" style="width:{Math.max(6, ctxPct)}%"></span></span>{:else}{t('暂无数据')}{/if}
            </span>
          </div>
          {#if !isFolded('context')}
            <div class="rc-body">
              {#if ctx}
                <div class="rr"><span class="rr-txt">{fmtCompact(ctx.used)} / {fmtCompact(ctx.max)}</span><span class="rr-grow"></span><span class="rr-dim">{ctxPct}%</span></div>
                <div class="ctx-track"><span class="bar-fill {ctxTone}" style="width:{Math.max(2, ctxPct || 0)}%"></span></div>
                <div class="rr">
                  <span class="rr-dim small">{session.busy ? t('本轮结束后可压缩') : t('压缩会话可腾出上下文空间')}</span><span class="rr-grow"></span>
                  <button class="rbtn" disabled={session.busy || compacting || ui.offline} onclick={() => send('/compact', [])}>{compacting ? t('压缩中…') : t('压缩')}</button>
                </div>
              {:else}
                <div class="rr"><span class="rr-dim">{t('这个会话还没有上下文用量数据，发一条消息后就有')}</span></div>
              {/if}
            </div>
          {/if}
        </section>
      {/if}

      <!-- 连接器 -->
      {#if servers.length}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'connectors')}>{t('连接器')}{@render caret('connectors')}</button>
            <span class="rc-sum" class:hide={!isFolded('connectors')}>{connSummary}</span>
          </div>
          {#if !isFolded('connectors')}
            <div class="rc-body">
              {#each connList as s (s.name)}
                <div class="rr">
                  {@render ic('<path d="M9 7V4M15 7V4M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v4"/>')}
                  <span class="rr-txt">{s.name}</span><span class="rr-grow"></span>
                  {#if s.status === 'needs-auth' && !IS_CSNAP && !authFlow(sid, s.name)}
                    <button class="rr-auth" title={t('需要登录')} onclick={() => startAuth(sid, s.name)}>{t('授权')}</button>
                  {:else}
                    <span class="rr-st" class:warn={s.status === 'failed' || s.status === 'needs-auth'}>{t(STATUS_TXT[s.status] || s.status)}</span>
                  {/if}
                </div>
                <McpAuthFlow {sid} server={s.name} />
              {/each}
              {#if servers.length > 3}<div class="rr"><span class="rr-dim small">{t('另有 {n} 个', { n: servers.length - 3 })}</span></div>{/if}
            </div>
          {/if}
        </section>
      {/if}

      <!-- 输出内容 -->
      {#if outputs.length}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'outputs')}>{t('输出内容')}{@render caret('outputs')}</button>
            <span class="rc-sum" class:hide={!isFolded('outputs')}>{outputs.length}</span>
          </div>
          {#if !isFolded('outputs')}
            <div class="rc-body">
              {#each outShown as f (f.path)}
                <button class="rr click" title={f.path} onclick={() => openPreview({ origin: 'claude', id: sid, path: f.path, name: f.name })}>
                  {@render ic('<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>')}
                  <span class="rr-txt">{f.name}</span>
                </button>
              {/each}
              {#if outputs.length > 5 && !outMore}<button class="rr click more" onclick={() => (outMore = true)}><span class="rr-dim">{t('显示更多（{n}）', { n: outputs.length - 5 })}</span></button>{/if}
            </div>
          {/if}
        </section>
      {/if}

      <!-- 拉取请求（PrCard.svelte）：不是主机本人 / 不在 GitHub 仓库里时整张卡不出现 -->
      {#if !IS_CSNAP && pluginOn('pr')}<PrCard {sid} />{/if}

      <!-- 更改 -->
      {#if review.git}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'changes')}>{t('更改')}{@render caret('changes')}</button>
            {#if isFolded('changes')}<span class="rc-sum"><span class="add">+{num(review.add)}</span> <span class="del">−{num(review.del)}</span></span>{/if}
          </div>
          {#if !isFolded('changes')}
            <div class="rc-body">
              <div class="rr">
                <button class="diffbtn" title={t('打开改动')} onclick={() => toggleDockView('review')}>
                  {@render ic('<rect x="4" y="4" width="16" height="16" rx="3.6"/><path d="M12 7.9v4.2M9.9 10h4.2M9.9 15.6h4.2"/>')}
                  <span class="add">+{num(review.add)}</span><span class="del">−{num(review.del)}</span>
                </button>
                <span class="rr-grow"></span>
                <button class="rbtn" disabled={!hasChanges} title={hasChanges ? t('让 Claude 提交这些改动') : t('没有可提交的改动')} onclick={commitChanges}>{t('提交更改')}</button>
              </div>
            </div>
          {/if}
        </section>
      {/if}
    </div>
  </aside>
{/if}

<style>
  /* 官方紧凑密度 token：卡片无底色、1px ring（暗色内圈 / 亮色外圈，alpha-2）、圆角 10px、上下 8px；
     标题 12px 中粗、摘要 12px 次要色；行高 26px、正文 13px；图标盒 20px；卡片间距 10px；面板宽 280px。 */
  :global(.stage.rail-docked > .scroll), :global(.stage.rail-docked > .composer-wrap) { padding-right: 300px !important; transition: padding-right .2s cubic-bezier(.165,.84,.44,1); }
  .rail-probe { position: absolute; width: 0; height: 0; overflow: hidden; pointer-events: none; }
  .rail { --r-a2: color-mix(in srgb, var(--text) 10%, transparent); --r-ghost: color-mix(in srgb, var(--text) 6%, transparent);
    --r-add: #32d74b; --r-del: #ff2c56; --r-accent: #4c8dff; --r-warn: #db9300; --r-danger: #ff2c56;
    --r-ring: inset 0 0 0 1px var(--r-a2); width: 280px; display: flex; flex-direction: column; z-index: 25; }
  :global(html[data-theme="light"]) .rail { --r-add: #1e9e3c; --r-del: #cd2054; --r-accent: #2a78d6; --r-warn: #734500; --r-danger: #cd2054; --r-ring: 0 0 0 1px var(--r-a2); }
  .rail.docked { position: absolute; top: 56px; right: 14px; bottom: calc(var(--composer-h, 150px) + 12px); }
  .rail.pop { position: absolute; top: 52px; right: 12px; max-height: min(72vh, 640px); border-radius: 12px; background: var(--card); box-shadow: var(--card-shadow); padding: 4px 0; }
  .rail-scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; display: flex; flex-direction: column; gap: 10px; padding: 1px; }
  .rail-scroll::-webkit-scrollbar { display: none; }
  .rail.pop .rail-scroll { gap: 0; }
  .rc { display: flex; flex-direction: column; flex-shrink: 0; padding: 8px 0; border-radius: 10px; box-shadow: var(--r-ring); background: var(--bg); }
  .rail.pop .rc { border-radius: 0; box-shadow: none; background: transparent; }
  .rail.pop .rc + .rc { border-top: 1px solid var(--divider); }
  .rc-head { display: flex; align-items: center; min-height: 26px; padding: 0 8px; gap: 6px; }
  .rc-title { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 4px; font-size: 12px; font-weight: 500; color: var(--text); border-radius: 6px; }
  .rc-title:hover { background: var(--r-ghost); }
  .rc-caret { width: 13px; height: 13px; color: var(--muted); transition: transform .15s ease; }
  .rc-caret.open { transform: rotate(90deg); }
  .rc-sum { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-left: 6px; font-size: 12px; color: var(--muted); }
  .rc-sum.hide { visibility: hidden; }
  .rc-body { display: flex; flex-direction: column; padding: 2px 8px 0; }
  .rr { display: flex; align-items: center; gap: 8px; min-height: 26px; width: 100%; padding: 0 4px; font-size: 13px; color: var(--text); text-align: left; border-radius: 6px; min-width: 0; }
  .rr.click:hover { background: var(--r-ghost); }
  .rr.click:active { background: var(--r-a2); }
  .rr-ic { flex: none; display: grid; place-items: center; width: 20px; height: 20px; color: var(--serif, var(--muted)); }
  .rr-ic :global(svg) { width: 15px; height: 15px; }
  .rr-txt { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .rr-name { flex: none; max-width: 60%; }
  .rr-dim { min-width: 8ch; flex-shrink: 9999; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); }
  .rr-dim.small { font-size: 12px; }
  .rr.more .rr-dim { padding-left: 28px; }
  .rr-grow { flex: 1; }
  .rr-st { flex: none; font-size: 12px; color: var(--muted); }
  .rr-st.warn { color: var(--r-warn); }
  .rr-auth { flex: none; font-size: 12px; padding: 2px 9px; border-radius: 7px; background: var(--r-a2); color: var(--text); white-space: nowrap; }
  .rr-auth:hover { background: color-mix(in srgb, var(--text) 15%, transparent); }
  .bar { display: inline-flex; width: 24px; height: 10px; padding: 2px; border-radius: 99px; background: var(--r-a2); }
  .bar-fill { display: block; min-width: 6px; height: 100%; border-radius: 99px; background: var(--r-accent); }
  .bar-fill.warn { background: var(--r-warn); }
  .bar-fill.danger { background: var(--r-danger); }
  .ctx-track { display: flex; height: 6px; margin: 2px 4px 6px; border-radius: 99px; background: var(--r-a2); overflow: hidden; }
  .add { color: var(--r-add); }
  .del { color: var(--r-del); }
  .diffbtn { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 0 6px 0 0; border-radius: 6px; font-size: 13px; font-variant-numeric: tabular-nums; }
  .diffbtn:hover { background: var(--r-ghost); }
  .rbtn { flex: none; font-size: 12px; padding: 3px 9px; border-radius: 7px; background: var(--r-a2); color: var(--text); }
  .rbtn:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 15%, transparent); }
  .rbtn:disabled { opacity: .45; }
  .fam-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--r-accent); animation: famPulse 1.6s ease-in-out infinite; }
  @keyframes famPulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .fam-dot { animation: none; } }
  /* 讨论串状态点（项目对话）：等你 = 琥珀（同侧栏「等人」）、进行中 = 强调色呼吸、空闲 = 空心灰 */
  .th-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; }
  .th-dot.wait { background: var(--warn); }
  .th-dot.work { background: var(--r-accent); animation: famPulse 1.6s ease-in-out infinite; }
  .th-dot.idle { box-shadow: inset 0 0 0 1px var(--muted); }
  .rr-st.wait { color: var(--warn); }
  @media (prefers-reduced-motion: reduce) { .th-dot.work { animation: none; } }
  /* 项目概览：组头一行小字；讨论串行 = 左边整块可点开、右边悬停才露出的小动作（触屏常驻） */
  .th-dot.done { background: var(--muted); opacity: .5; }
  .th-dot.review { background: #a371f7; }
  .th-dot.land { background: var(--r-add); }
  .th-pr { flex: none; padding: 0 4px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; border-radius: 5px; }
  .th-pr:hover { color: var(--text); background: var(--r-a2); }
  .rc-sum.warn { color: var(--r-warn); }
  .rr.grp { min-height: 22px; margin-top: 2px; }
  .rr.grp .rc-caret { margin-left: -2px; }
  .rr.th { padding: 0; gap: 2px; }
  .rr.th:hover { background: var(--r-ghost); }
  .th-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 26px; padding: 0 4px 0 11px; text-align: left; font-size: 13px; color: var(--text); border-radius: 6px; }
  .th-acts { flex: none; display: flex; align-items: center; gap: 2px; padding-right: 2px; opacity: 0; transition: opacity .12s ease; }
  .rr.th:hover .th-acts, .rr.th:focus-within .th-acts { opacity: 1; }
  @media (hover: none) { .th-acts { opacity: 1; } }
  .th-act { display: grid; place-items: center; min-width: 22px; height: 22px; border-radius: 6px; color: var(--muted); }
  .th-act svg { width: 13px; height: 13px; }
  .th-act.txt { padding: 0 6px; font-size: 12px; }
  .th-act:hover { background: var(--r-a2); color: var(--text); }
  /* 项目说明 / 项目记忆：正文、编辑框、按钮行 */
  .p-text { padding: 2px 4px 4px; font-size: 12.5px; line-height: 18px; color: var(--serif, var(--text)); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow-y: auto; }
  .p-text.clamp { display: -webkit-box; -webkit-line-clamp: 6; line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
  .p-ta, .p-in { width: 100%; margin: 2px 0 4px; padding: 6px 8px; border-radius: 8px; font: inherit; font-size: 12.5px; line-height: 18px; color: var(--text); background: var(--r-ghost); box-shadow: var(--r-ring); border: 0; resize: vertical; }
  .p-ta:focus, .p-in:focus { outline: 1px solid var(--r-accent); outline-offset: 0; }
  .p-acts { display: flex; align-items: center; gap: 6px; padding: 0 2px 4px; }
  .p-val { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .p-sel { flex: 0 1 auto; min-width: 0; max-width: 62%; height: 24px; padding: 0 6px; border: 0; border-radius: 6px; font: inherit; font-size: 12px; color: var(--text); background: var(--r-ghost); box-shadow: var(--r-ring); text-overflow: ellipsis; cursor: pointer; }
  .p-sel:focus-visible { outline: 1px solid var(--r-accent); outline-offset: 0; }
  .p-sel:disabled { opacity: .6; cursor: default; }
  .p-mem { padding: 0 0 4px 28px; }
  .rbtn.pri { background: var(--text); color: var(--bg); }
  .rbtn.pri:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 85%, transparent); }
  .rbtn.danger { background: var(--r-danger); color: #fff; }
</style>
