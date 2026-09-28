<script>
  import { uiConfirm } from '../lib/dialogs.js';
  // Routines (定时触发) — a dedicated full-screen page: list of routines + a
  // claude.ai-styled New/Edit form. Wired to /api/routines (the bridge backend).
  // Schedule is the bridge's friendly preset {type:daily|weekdays|weekly|hourly,...}
  // in GMT+8 — not cron. Palette here is intentionally black/white/gray (no accent).
  import { caps, ui } from '../lib/state.svelte.js';
  import { api } from '../lib/api.js';
  import { registerCloser } from '../lib/nav.js';
  import { claudeDefaultModel, claudeEffortFallback } from '../lib/caps.js';

  const WEEKDAYS = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']];

  let mode = $state('list');         // 'list' | 'form'
  let items = $state([]);
  let running = $state([]);
  let loading = $state(true);
  let editing = $state(null);
  let enginePop = $state(false);
  let busy = $state(false);
  let err = $state('');

  let fName = $state('');
  let fPrompt = $state('');
  let fAgent = $state('claude');
  let fModel = $state(null);
  let fEffort = $state(null);
  let fSched = $state({ type: 'daily', weekday: 1, hour: 9, minute: 0 });
  let fEnabled = $state(true);

  const nameOf = (list, id) => (list || []).find((x) => x.id === id)?.name || id;
  const modelList = $derived(caps.data?.claude?.models || []);
  const effortList = $derived(caps.data?.claude?.efforts || []);
  const defModel = $derived(claudeDefaultModel(caps.data));
  const defEffort = $derived(claudeEffortFallback(caps.data, fModel || defModel));
  const engineLabel = $derived(`Claude · ${nameOf(modelList, fModel || defModel)} · ${nameOf(effortList, fEffort || defEffort)}`);

  const pad = (n) => String(n).padStart(2, '0');
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const schedText = (s) => {
    if (!s) return '';
    if (s.type === 'hourly') return `每小时 · 第 ${s.minute} 分`;
    const t = `${pad(s.hour)}:${pad(s.minute)}`;
    if (s.type === 'weekly') return `每周${WD[s.weekday] || ''} ${t}`;
    return (s.type === 'weekdays' ? '每工作日 ' : '每天 ') + t;
  };
  const engineText = (r) => `Claude · ${nameOf(caps.data?.claude?.models, r.model || claudeDefaultModel(caps.data))}`;

  let listErr = $state('');
  async function load() {
    loading = true;
    try { const d = await api.routines(); items = d.routines || []; running = d.running || []; listErr = ''; }
    catch { listErr = '加载失败：连不上服务器（列表可能不是最新）'; }
    loading = false;
  }
  $effect(() => { if (ui.routinesOpen) { mode = 'list'; load(); } });

  // 系统返回逐级退：引擎选单 → 编辑表单回列表 → 关整页。
  $effect(() => registerCloser('routines', () => {
    if (enginePop) { enginePop = false; return; }
    if (mode === 'form') { mode = 'list'; return; }
    ui.routinesOpen = false;
  }));

  function openNew() {
    editing = null; err = '';
    fName = ''; fPrompt = ''; fAgent = 'claude'; fModel = null; fEffort = null;
    fSched = { type: 'daily', weekday: 1, hour: 9, minute: 0 }; fEnabled = true;
    mode = 'form';
  }
  function openEdit(r) {
    editing = r.id; err = '';
    fName = r.name || ''; fPrompt = r.prompt || ''; fAgent = 'claude';
    fModel = r.model; fEffort = r.effort;
    fSched = { type: r.schedule?.type || 'daily', weekday: r.schedule?.weekday ?? 1, hour: r.schedule?.hour ?? 9, minute: r.schedule?.minute ?? 0 };
    fEnabled = r.enabled !== false;
    mode = 'form';
  }

  function setType(t) { fSched = { ...fSched, type: t }; }
  function timeStr() { return `${pad(fSched.hour)}:${pad(fSched.minute)}`; }
  function onTime(e) { const [h, m] = (e.target.value || '09:00').split(':').map(Number); fSched = { ...fSched, hour: h || 0, minute: m || 0 }; }
  function onMinute(e) { fSched = { ...fSched, minute: Math.max(0, Math.min(59, +e.target.value || 0)) }; }

  async function save() {
    if (busy) return;
    if (!fPrompt.trim()) { err = '请填写指令（Instructions）'; return; }
    busy = true; err = '';
    const body = { name: fName.trim(), prompt: fPrompt.trim(), agent: fAgent, model: fModel || undefined, effort: fEffort || undefined, schedule: fSched, enabled: fEnabled };
    try {
      if (editing) await api.updateRoutine({ id: editing, ...body });
      else await api.createRoutine(body);
      await load(); mode = 'list';
    } catch (e) { err = '保存失败：' + (e?.body?.error || e?.message || e); }
    busy = false;
  }
  // 操作失败不再静默吞掉——listErr 顶部提示，下一次成功 load 自动清除。
  const opFail = (what) => { listErr = what + '失败：连不上服务器，请重试'; };
  async function toggleEnabled(r) {
    const next = !(r.enabled !== false);
    const prev = items;
    items = items.map((x) => (x.id === r.id ? { ...x, enabled: next } : x));   // 乐观切换（即时），失败回滚
    try { const res = await api.updateRoutine({ id: r.id, enabled: next }); if (res && res.ok === false) throw 0; }
    catch { items = prev; opFail('切换'); }
  }
  async function runNow(r) { try { await api.runRoutine(r.id); await load(); } catch { opFail('运行'); } }
  async function del(r) {
    if (!(await uiConfirm('删除这条路由？'))) return;
    const prev = items;
    items = items.filter((x) => x.id !== r.id);   // 乐观移除（即时），失败回滚
    try { const res = await api.deleteRoutine(r.id); if (res && res.ok === false) throw 0; }
    catch { items = prev; opFail('删除'); }
  }
  function close() { ui.routinesOpen = false; }
</script>

{#snippet clock()}
  <svg class="clock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8" cy="8" r="5.5"/><line class="hh" x1="8" y1="8" x2="10" y2="9"/><line class="mh" x1="8" y1="8" x2="8" y2="5.5"/>
  </svg>
{/snippet}

{#if ui.routinesOpen}
<section class="rt-page">
  {#if mode === 'list'}
    <header class="rt-top">
      <button class="rt-back" aria-label="返回" onclick={close}>‹</button>
      <span class="rt-h">{@render clock()} Routines</span>
      <span class="sp"></span>
      <button class="rt-new" onclick={openNew}>＋ 新建</button>
    </header>
    <div class="rt-body">
      <p class="rt-desc">定时让 Claude 在 vault 里自动跑任务，无人值守。结果会进「历史对话」（标“路由”），事后可回看。</p>
      {#if listErr}<div class="rt-err">{listErr}</div>{/if}
      {#if loading}
        <div class="rt-empty">加载中…</div>
      {:else if !items.length}
        <div class="rt-empty">还没有定时路由。点右上角「＋ 新建」。</div>
      {:else}
        {#each items as r (r.id)}
          <div class="rt-card">
            <button class="rt-card-main" onclick={() => openEdit(r)}>
              <div class="rt-name">{r.name || '未命名路由'}</div>
              <div class="rt-meta">{schedText(r.schedule)} · {engineText(r)}{running.includes(r.id) ? ' · 运行中…' : (r.lastStatus ? ' · 上次' + r.lastStatus : '')}</div>
            </button>
            <button class="rt-icon" aria-label="立即运行" disabled={running.includes(r.id)} onclick={() => runNow(r)}>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <button class="rt-sw {r.enabled !== false ? 'on' : ''}" aria-label="启用" onclick={() => toggleEnabled(r)}><span class="knob"></span></button>
            <button class="rt-icon" aria-label="删除" onclick={() => del(r)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/></svg>
            </button>
          </div>
        {/each}
      {/if}
    </div>
  {:else}
    <header class="rt-top">
      <button class="rt-back" aria-label="返回" onclick={() => (mode = 'list')}>‹</button>
      <span class="rt-h">{@render clock()} Routines <span class="slash">/</span> {editing ? '编辑路由' : '新建路由'}</span>
    </header>
    <div class="rt-body form">
      <label class="rt-label" for="rtName">名称 <b>*</b></label>
      <input id="rtName" class="rt-input" bind:value={fName} maxlength="120" placeholder="例如：每早汇总今日笔记" />

      <label class="rt-label">指令 <span class="dim">Instructions</span></label>
      <div class="rt-instr">
        <textarea class="rt-ta" bind:value={fPrompt} placeholder="描述每次运行让 Claude 做什么…"></textarea>
        <div class="rt-instr-bar">
          <div class="eng-wrap">
            <button class="eng-btn" onclick={() => (enginePop = !enginePop)}>{engineLabel} <span class="cv">▾</span></button>
            {#if enginePop}
              <button class="eng-bd" aria-label="关闭" onclick={() => (enginePop = false)}></button>
              <div class="eng-pop">
                <div class="eng-sec">模型</div>
                <div class="pills">
                  {#each modelList as m}<button class="pill {(fModel || defModel) === m.id ? 'on' : ''}" onclick={() => (fModel = m.id)}>{m.name}</button>{/each}
                </div>
                <div class="eng-sec">思考强度</div>
                <div class="pills">
                  {#each effortList as e}<button class="pill {(fEffort || defEffort) === e.id ? 'on' : ''}" onclick={() => (fEffort = e.id)}>{e.name}</button>{/each}
                </div>
              </div>
            {/if}
          </div>
        </div>
      </div>

      <label class="rt-label">频率</label>
      <div class="pills">
        <button class="pill {fSched.type === 'daily' ? 'on' : ''}" onclick={() => setType('daily')}>每天</button>
        <button class="pill {fSched.type === 'weekdays' ? 'on' : ''}" onclick={() => setType('weekdays')}>每工作日</button>
        <button class="pill {fSched.type === 'weekly' ? 'on' : ''}" onclick={() => setType('weekly')}>每周</button>
        <button class="pill {fSched.type === 'hourly' ? 'on' : ''}" onclick={() => setType('hourly')}>每小时</button>
      </div>

      {#if fSched.type === 'hourly'}
        <div class="rt-when"><span>每小时的第</span><input class="rt-num" type="number" min="0" max="59" value={fSched.minute} onchange={onMinute} /><span>分钟</span></div>
      {:else}
        {#if fSched.type === 'weekly'}
          <div class="pills wk">
            {#each WEEKDAYS as [d, lbl]}<button class="pill {fSched.weekday === d ? 'on' : ''}" onclick={() => (fSched = { ...fSched, weekday: d })}>周{lbl}</button>{/each}
          </div>
        {/if}
        <div class="rt-when"><span>时间</span><input class="rt-time" type="time" value={timeStr()} onchange={onTime} /><span class="dim">服务器时区 GMT+8</span></div>
      {/if}

      <label class="rt-label">启用</label>
      <button class="rt-sw big {fEnabled ? 'on' : ''}" aria-label="启用" onclick={() => (fEnabled = !fEnabled)}><span class="knob"></span></button>

      {#if err}<div class="rt-err">{err}</div>{/if}
    </div>
    <footer class="rt-foot">
      <button class="rt-cancel" onclick={() => (mode = 'list')}>取消</button>
      <button class="rt-save" disabled={busy || !fPrompt.trim()} onclick={save}>{busy ? '保存中…' : (editing ? '保存' : '创建')}</button>
    </footer>
  {/if}
</section>
{/if}

<style>
  .rt-page { position: fixed; inset: 0; z-index: 80; background: var(--bg); color: var(--text); display: flex; flex-direction: column; animation: rtIn .22s ease; }
  @keyframes rtIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  /* 高度要把 --sat 加上：border-box 下固定 52px 会被 padding-top 挤扁，按钮溢出顶进状态栏（edge-to-edge 后实测重叠）。 */
  .rt-top { flex: none; display: flex; align-items: center; gap: 8px; height: calc(52px + var(--sat)); padding: 0 8px; padding-top: var(--sat); border-bottom: 1px solid var(--divider); }
  .rt-back { width: 38px; height: 38px; border-radius: 10px; font-size: 22px; color: var(--serif); display: flex; align-items: center; justify-content: center; }
  .rt-back:active { background: var(--hover); }
  .rt-h { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 7px; }
  /* 与侧栏「定时触发」同一枚钟（claude.ai Scheduled 实测规格，动效注释见 ClaudePage.svelte）：
     悬停标题两针以 8 8 为轴走一格——时针 +30°、分针 +390°，0.6s cubic-bezier(.3,.9,.4,1)。 */
  .clock { width: 18px; height: 18px; color: var(--text); }
  .clock line { transform-box: view-box; transform-origin: 8px 8px;
    transition: rotate .6s cubic-bezier(.3, .9, .4, 1); }
  @media (hover: hover) {
    .rt-h:hover .clock .hh { rotate: 30deg; }
    .rt-h:hover .clock .mh { rotate: 390deg; }
  }
  .slash { color: var(--muted); font-weight: 400; } .dim { color: var(--muted); font-weight: 400; font-size: 12px; }
  .sp { flex: 1; }
  .rt-new { font-size: 14px; color: var(--text); padding: 7px 13px; border-radius: 10px; border: 1px solid var(--divider); }
  .rt-new:active { background: var(--hover); }

  .rt-body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 16px; max-width: 760px; width: 100%; margin: 0 auto; }
  .rt-desc { color: var(--muted); font-size: 13px; line-height: 1.6; margin-bottom: 16px; }
  .rt-err { background: rgba(217,106,90,.14); color: var(--crit, #d96a5a); font-size: 13px; padding: 9px 13px; border-radius: 10px; margin-bottom: 12px; }
  .rt-empty { color: var(--muted); font-size: 14px; text-align: center; padding: 40px 0; }

  .rt-card { display: flex; align-items: center; gap: 6px; padding: 10px 4px; border-bottom: 1px solid var(--divider); }
  .rt-card-main { flex: 1; min-width: 0; text-align: left; padding: 4px 8px; border-radius: 10px; }
  .rt-card-main:active { background: var(--hover); }
  .rt-name { font-size: 15px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt-meta { font-size: 12.5px; color: var(--muted); margin-top: 3px; }
  .rt-icon { width: 32px; height: 32px; border-radius: 9px; color: var(--muted); flex: none; display: flex; align-items: center; justify-content: center; }
  .rt-icon:active { background: var(--hover); color: var(--text); } .rt-icon:disabled { opacity: .35; }
  .rt-icon svg { width: 16px; height: 16px; }

  .rt-sw { width: 42px; height: 25px; border-radius: 999px; background: var(--divider); flex: none; padding: 2px; transition: background .2s; }
  .rt-sw .knob { display: block; width: 21px; height: 21px; border-radius: 50%; background: var(--muted); transition: transform .2s, background .2s; }
  .rt-sw.on { background: var(--text); } .rt-sw.on .knob { background: var(--bg); transform: translateX(17px); }
  .rt-sw.big { width: 48px; height: 28px; } .rt-sw.big .knob { width: 24px; height: 24px; } .rt-sw.big.on .knob { transform: translateX(20px); }

  .form { padding-bottom: 24px; }
  .rt-label { display: block; font-size: 13px; color: var(--text); margin: 18px 0 7px; font-weight: 500; }
  .rt-label b { color: var(--muted); }
  .rt-label:first-child { margin-top: 4px; }
  .rt-input { width: 100%; background: var(--card); border: 1px solid var(--divider); border-radius: 12px; padding: 12px 14px; font: inherit; font-size: 15px; color: var(--text); outline: none; }
  .rt-input:focus { border-color: var(--serif); }
  .rt-instr { background: var(--card); border: 1px solid var(--divider); border-radius: 16px; padding: 6px; }
  .rt-instr:focus-within { border-color: var(--serif); }
  .rt-ta { width: 100%; min-height: 120px; max-height: 40vh; resize: vertical; background: none; border: none; outline: none; font: inherit; font-size: 15px; line-height: 1.5; color: var(--text); padding: 10px; }
  .rt-instr-bar { display: flex; justify-content: flex-end; padding: 2px 4px; }
  .eng-wrap { position: relative; }
  .eng-btn { font-size: 13px; color: var(--text); padding: 6px 10px; border-radius: 9px; }
  .eng-btn:active { background: var(--hover); } .eng-btn .cv { color: var(--muted); }
  .eng-bd { position: fixed; inset: 0; z-index: 60; }
  .eng-pop { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 61; min-width: 240px; max-width: 84vw; padding: 10px 12px; background: var(--q-card); border-radius: 14px; box-shadow: var(--q-shadow); max-height: 56vh; overflow-y: auto; }
  .eng-sec { font-size: 11px; font-weight: 600; letter-spacing: .3px; color: var(--muted); margin: 10px 0 6px; }
  .eng-sec:first-child { margin-top: 0; }

  .pills { display: flex; flex-wrap: wrap; gap: 7px; }
  .pills.wk { margin-top: 12px; }
  .pill { font-size: 13px; color: var(--serif); padding: 7px 13px; border-radius: 10px; border: 1px solid var(--divider); background: var(--card); }
  .pill:active { background: var(--hover); }
  .pill.on { background: var(--text); border-color: var(--text); color: var(--bg); }

  .rt-when { display: flex; align-items: center; gap: 10px; margin-top: 12px; color: var(--text); font-size: 14px; }
  .rt-time, .rt-num { background: var(--card); border: 1px solid var(--divider); border-radius: 10px; padding: 9px 12px; font: inherit; font-size: 15px; color: var(--text); outline: none; }
  .rt-num { width: 80px; }
  .rt-time:focus, .rt-num:focus { border-color: var(--serif); }
  .rt-err { margin-top: 14px; color: var(--crit); font-size: 14px; }

  .rt-foot { flex: none; display: flex; justify-content: flex-end; gap: 10px; padding: 12px 16px max(12px, var(--sab)); border-top: 1px solid var(--divider); }
  .rt-cancel { font-size: 15px; color: var(--text); padding: 11px 20px; border-radius: 12px; border: 1px solid var(--divider); }
  .rt-cancel:active { background: var(--hover); }
  .rt-save { font-size: 15px; color: var(--bg); background: var(--text); padding: 11px 22px; border-radius: 12px; }
  .rt-save:disabled { opacity: .4; }
</style>
