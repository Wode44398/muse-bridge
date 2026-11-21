<script>
  // 对话内 Native Swarm 协作总卡（同条消息里多次 swarm 调用聚合为一张卡，对标 AgySubagentCard 的克制材质）：
  // 展示协作群标题、实时状态（运行中 / 等你回复 / 停滞 / 已完成 / 部分出错）、成员人数与帖子数、
  // 成员点阵、模型构成、目标或最新消息板动态；主区域点击打开右侧「总览」，快捷芯片直达「消息板」。
  import { openAgyAgentsPanel } from '../../lib/dock.svelte.js';
  import { fmtElapsed } from '../../lib/format.js';
  import { agySwarm } from '../../lib/agy/swarm.svelte.js';
  import { buildSwarmViewModel, isSwarmRoleWorker, stripLeadingMentions } from '../../lib/agy/swarm-logic.js';
  import { parseAgyModelAndEffort } from '../../lib/agy/catalog.js';
  import { t } from '../../lib/i18n.js';
  import AgyAgentDots from './AgyAgentDots.svelte';

  const { swarmTools = [], sessionId = '' } = $props();

  const liveSnap = $derived(
    agySwarm.sessionId === sessionId && agySwarm.data?.hasSwarm ? agySwarm.data : null
  );
  const vm = $derived(liveSnap ? buildSwarmViewModel(liveSnap) : null);

  // 尚未落盘时的回退标题与成员列表（直接从本条消息的 swarm 工具参数推导）
  const fallbackTitle = $derived.by(() => {
    for (const item of swarmTools || []) {
      if (item?.args?.title) return String(item.args.title);
    }
    return t('多代理协作');
  });
  const fallbackWorkers = $derived.by(() => {
    const out = [];
    for (const item of swarmTools || []) {
      if (String(item?.name || '').toLowerCase() !== 'swarm') continue;
      if (String(item?.args?.action || '').toLowerCase() !== 'add') continue;
      const base = String(item.args?.name || '').trim();
      if (!base) continue;
      const tasks = Array.isArray(item.args?.tasks) ? item.args.tasks : null;
      const n = Number(item.args?.n) || 0;
      if (tasks && tasks.length > 0) {
        tasks.forEach((_, idx) => out.push({ role: `${base}-${idx + 1}`, status: 'running' }));
      } else if (n > 1) {
        for (let k = 1; k <= n; k++) out.push({ role: `${base}-${k}`, status: 'running' });
      } else {
        out.push({ role: base, status: 'running' });
      }
    }
    return out;
  });

  const title = $derived(vm?.title || fallbackTitle);
  const summary = $derived(liveSnap?.summary || null);
  const workers = $derived(
    liveSnap
      ? (liveSnap.members || []).filter((m) => !isSwarmRoleWorker(m) && m.role !== 'coordinator')
      : []
  );

  const dotAgents = $derived.by(() => {
    if (workers.length) {
      return workers.map((m) => ({
        role: `@${m.name}`,
        status: m.killed
          ? 'killed'
          : (m.failure ? 'error' : (m.status === 'working' ? 'running' : (vm?.finished ? 'done' : 'waiting'))),
      }));
    }
    return fallbackWorkers;
  });

  const dotCounts = $derived.by(() => {
    const c = { total: dotAgents.length, running: 0, waiting: 0, done: 0, error: 0, killed: 0, active: 0 };
    for (const a of dotAgents) {
      if (a.status === 'running') { c.running++; c.active++; }
      else if (a.status === 'waiting') { c.waiting++; c.active++; }
      else if (a.status === 'error') c.error++;
      else if (a.status === 'killed') c.killed++;
      else c.done++;
    }
    return c;
  });

  const active = $derived(
    liveSnap
      ? Boolean(liveSnap.hasActive)
      : (swarmTools || []).some((x) => x?.status === 'in_progress' || x?.status === 'pending')
  );
  const hasErr = $derived(Boolean(summary && (summary.errorCount > 0 || (liveSnap?.systemAttention?.length || 0) > 0)));
  const isWarn = $derived(Boolean(!active && (vm?.needsUser || vm?.stall)));

  const statusText = $derived.by(() => {
    if (!liveSnap) return active ? t('启动中') : '';
    if (vm?.needsUser) return t('等你回复');
    if (vm?.stall) return t('已停滞');
    if (liveSnap.hasActive) return t('协作中');
    if (vm?.finished) return t('已完成');
    if (hasErr) return t('部分出错');
    return t('待命中');
  });

  let now = $state(Date.now());
  $effect(() => {
    if (!active) return;
    now = Date.now();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  const elapsedText = $derived.by(() => {
    if (active && summary?.startedAt > 0) return fmtElapsed(Math.max(0, now - summary.startedAt));
    if (summary?.durationMs > 0) return fmtElapsed(summary.durationMs);
    return '';
  });

  const modelLine = $derived.by(() => {
    const mix = summary?.modelMix || [];
    if (!mix.length) return '';
    return mix.map((item) => {
      const parsed = parseAgyModelAndEffort(item.model || item.modelBase || '', [], { short: true });
      const eff = item.effort || parsed.effort;
      const base = eff ? `${parsed.modelName} · ${eff}` : parsed.modelName;
      return item.count > 1 ? `${base} ×${item.count}` : base;
    }).join(' / ');
  });

  const highlightLine = $derived.by(() => {
    if (vm?.stall) return { tone: 'warn', text: `@${vm.stall.agent}: ${vm.stall.text}` };
    if (vm?.needsUser && vm.coordAsk) return { tone: 'warn', text: vm.coordAsk };
    if (hasErr && liveSnap?.systemAttention?.length) {
      const first = liveSnap.systemAttention[0];
      return { tone: 'err', text: `@${first.member}: ${first.detail || (first.kind === 'quota' ? t('额度不足') : t('执行出错'))}` };
    }
    const busyWorker = workers.find((m) => !m.killed && m.status === 'working' && m.activity);
    if (busyWorker) return { tone: 'live', text: `@${busyWorker.name}: ${busyWorker.activity}` };
    if (summary?.latestMessage) {
      const lm = summary.latestMessage;
      const body = stripLeadingMentions(lm.text);
      return { tone: 'dim', text: `#${lm.seq} @${lm.agent}: ${body}` };
    }
    if (vm?.goal?.line) return { tone: 'dim', text: vm.goal.line };
    return null;
  });

  function openTab(tabName) {
    openAgyAgentsPanel({ swarmTab: tabName });
  }
</script>

<div class="ag-swcard-wrap">
  <div class="ag-swcard" class:active class:warn={isWarn} class:failed={hasErr && !active}>
    <span class="sc-surface" aria-hidden="true"></span>
    <button
      type="button"
      class="sc-main"
      aria-label={t('查看多代理协作：{name}', { name: title })}
      onclick={() => openTab('overview')}
    >
      <span class="sc-col">
        <span class="sc-title-row">
          <svg class="sc-glyph" class:live={active} viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
            <path d="M9 4.5 L4.5 13 L13.5 13 Z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" opacity="0.55" />
            <circle cx="9" cy="4.5" r="2.2" fill="currentColor" />
            <circle cx="4.5" cy="13" r="2" fill="currentColor" />
            <circle cx="13.5" cy="13" r="2" fill="currentColor" />
          </svg>
          <span class="sc-title trunc" class:agy-shine={active}>{title}</span>
        </span>

        <span class="sc-meta num">
          <span class="sc-kind">{t('多代理协作')}</span>
          {#if statusText}
            <span class="sc-st" class:live={active} class:warn={isWarn} class:err={hasErr && !active}>{statusText}</span>
          {/if}
          {#if dotCounts.total > 0}
            <span>{t('{n} 个成员', { n: dotCounts.total })}</span>
          {/if}
          {#if summary?.postsCount > 0}
            <span>{t('{n} 条消息', { n: summary.postsCount })}</span>
          {/if}
          {#if elapsedText}
            <span>{elapsedText}</span>
          {/if}
        </span>

        {#if dotAgents.length > 0}
          <span class="sc-dots">
            <AgyAgentDots counts={dotCounts} agents={dotAgents} wrap maxRows={4} anticipate={active} />
          </span>
        {/if}

        {#if modelLine}
          <span class="sc-models trunc" title={modelLine}>{modelLine}</span>
        {/if}

        {#if highlightLine}
          <span class="sc-line trunc {highlightLine.tone}" title={highlightLine.text}>{highlightLine.text}</span>
        {/if}
      </span>
      <span class="msr sc-chev" aria-hidden="true">expand_more</span>
    </button>

    {#if liveSnap}
      <div class="sc-quick">
        <button type="button" class="sc-qbtn" onclick={() => openTab('overview')}>
          {t('总览')}
        </button>
        <button type="button" class="sc-qbtn" onclick={() => openTab('board')}>
          {t('消息板')}
          {#if summary?.head > 0}<span class="num">#{summary.head}</span>{/if}
        </button>
        <button type="button" class="sc-qbtn" onclick={() => openTab('members')}>
          {t('成员')}
        </button>
        <button type="button" class="sc-qbtn" onclick={() => openTab('graph')}>
          {t('协作图')}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .ag-swcard-wrap {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    margin: 6px 0 8px;
  }
  .ag-swcard {
    position: relative;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    align-self: flex-start;
    width: 364px;
    max-width: 100%;
    box-sizing: border-box;
    border-radius: 11px;
    overflow: hidden;
  }
  .sc-surface {
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--ag-surface-1);
    box-shadow: inset 0 0 0 1px var(--ag-border-strong);
    transition: background 0.14s ease, box-shadow 0.14s ease;
  }
  .ag-swcard.active .sc-surface {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ag-accent) 36%, var(--ag-border-strong));
  }
  .ag-swcard.warn .sc-surface {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ag-warn) 36%, var(--ag-border-strong));
  }
  .ag-swcard.failed .sc-surface {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ag-err) 34%, var(--ag-border-strong));
  }
  .sc-main {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 10px 10px 9px 12px;
    text-align: left;
    outline: none;
  }
  @media (hover: hover) {
    .sc-main:hover { background: var(--ag-hover); }
  }
  .sc-main:focus-visible {
    box-shadow: inset 0 0 0 1.5px var(--ag-accent);
  }
  .sc-col {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 4px;
  }
  .sc-title-row {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .sc-glyph {
    flex: none;
    color: var(--ag-on-dim);
  }
  .sc-glyph.live { color: var(--ag-accent); }
  .sc-title {
    font-size: 13.5px;
    line-height: 20px;
    font-weight: 500;
    color: var(--ag-on);
  }
  .sc-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    font-size: 12px;
    line-height: 16px;
    color: var(--ag-on-dim);
  }
  .sc-kind { color: var(--ag-on-sub); }
  .sc-st.live { color: var(--ag-accent); }
  .sc-st.warn { color: var(--ag-warn); }
  .sc-st.err { color: var(--ag-err); }
  .sc-dots { display: block; padding: 3px 0 1px; }
  .sc-models {
    font-size: 11.5px;
    line-height: 16px;
    color: var(--ag-on-dim);
  }
  .sc-line {
    font-size: 11.5px;
    line-height: 16px;
    color: var(--ag-on-sub);
  }
  .sc-line.live {
    font-family: var(--ag-mono);
    color: var(--ag-on-sub);
  }
  .sc-line.warn { color: var(--ag-warn); }
  .sc-line.err { color: var(--ag-err); }
  .sc-line.dim { color: var(--ag-on-dim); }
  .sc-chev {
    flex: none;
    font-size: 16px;
    line-height: 20px;
    color: var(--ag-on-faint);
    transform: rotate(-90deg);
    transition: transform 0.14s ease, color 0.14s ease;
  }
  @media (hover: hover) {
    .sc-main:hover .sc-chev {
      color: var(--ag-on-sub);
      transform: rotate(-90deg) translateY(1.5px);
    }
  }
  .sc-quick {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px 7px;
    border-top: 1px solid var(--ag-border);
    background: color-mix(in srgb, var(--ag-surface-2) 55%, transparent);
  }
  .sc-qbtn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    border-radius: 6px;
    font-size: 11.5px;
    color: var(--ag-on-sub);
    transition: background 0.14s ease, color 0.14s ease;
  }
  .sc-qbtn:hover {
    background: var(--ag-hover);
    color: var(--ag-on);
  }
  .sc-qbtn .num {
    font-size: 10.5px;
    color: var(--ag-on-faint);
  }
  .trunc {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .num { font-variant-numeric: tabular-nums; }
</style>
