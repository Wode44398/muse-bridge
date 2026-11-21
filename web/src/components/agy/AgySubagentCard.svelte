<script>
  // 对话内多代理 / 子代理查看卡片（直接嵌在对话流里，对标 Claude WorkflowCard，原生适配 --ag-* 令牌）：
  // 展示角色/团队名（活跃流光）、类型 / 准确状态 / 子代理数 / 耗时、多代理点阵、模型与 effort 构成、
  // 当前活跃步骤或报错摘要。点击后打开右侧工作区「代理」面板查看完整子代理表与逐条对话转录。
  import { openAgyAgentsPanel } from '../../lib/dock.svelte.js';
  import { fmtElapsed } from '../../lib/format.js';
  import {
    agySubagents,
    matchToolToSubagent,
    flattenSubtree,
    formatModelMixLine,
    subagentStatusLabel,
    subagentKindLabel,
  } from '../../lib/agy/subagents.svelte.js';
  import { t } from '../../lib/i18n.js';
  import AgyAgentDots from './AgyAgentDots.svelte';

  const { tool, msgTools = [] } = $props();

  const node = $derived(matchToolToSubagent(tool, msgTools, agySubagents.tree));
  const subtree = $derived(node ? flattenSubtree(node) : []);
  const counts = $derived(node?.subtreeCounts || { total: subtree.length, running: 0, waiting: 0, done: 0, error: 0, killed: 0, active: 0 });
  const hasChildren = $derived(Array.isArray(node?.children) && node.children.length > 0);
  const totalAgents = $derived(Math.max(1, counts.total || subtree.length));
  const active = $derived(Boolean(node && (node.status === 'running' || node.status === 'waiting' || (counts.active || 0) > 0)));
  const selfFailed = $derived(node?.status === 'error');
  const anyError = $derived(selfFailed || (counts.error || 0) > 0);

  const statusText = $derived.by(() => {
    if (!node) return '';
    if (active) return subagentStatusLabel(node.status === 'waiting' ? 'waiting' : 'running');
    if (selfFailed) return subagentStatusLabel('error');
    if ((counts.error || 0) > 0) return t('部分出错');
    return subagentStatusLabel(node.status);
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
    if (!node) return '';
    if (active && node.spawnedAt > 0) return fmtElapsed(Math.max(0, now - node.spawnedAt));
    if (node.durationMs > 0) return fmtElapsed(node.durationMs);
    return '';
  });

  const modelLine = $derived(node ? formatModelMixLine(node) : '');

  // 活跃态挑出正在干活的一步；出错态挑出出错代理的报错原因，一眼就能看清状况
  const liveStepLine = $derived.by(() => {
    if (!active) return '';
    const runningNodes = subtree.filter((a) => a.status === 'running');
    const latest = [...runningNodes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || node;
    if (latest?.lastTool?.name) {
      const piece = [latest.lastTool.name, latest.lastTool.summary].filter(Boolean).join(' · ');
      return (runningNodes.length > 1 || latest.id !== node?.id) ? `${latest.role}: ${piece}` : piece;
    }
    if (runningNodes.length > 1) return t('{n} 个代理并行执行中…', { n: runningNodes.length });
    return '';
  });

  const errLine = $derived.by(() => {
    if (active || !anyError) return '';
    const errNode = subtree.find((a) => a.status === 'error' && a.lastError) || subtree.find((a) => a.status === 'error');
    if (!errNode) return '';
    const msg = errNode.lastError || subagentStatusLabel('error');
    return errNode.id !== node?.id ? `${errNode.role}: ${msg}` : msg;
  });

  function openPanel() {
    if (!node) {
      openAgyAgentsPanel();
      return;
    }
    openAgyAgentsPanel({
      agentId: node.id || '',
      openTranscript: Boolean(node.id && !hasChildren),
    });
  }
</script>

{#if node}
  <div class="ag-subcard-wrap">
    <button
      type="button"
      class="ag-subcard"
      class:active
      class:failed={anyError && !active}
      aria-label={t('查看子代理：{name}', { name: node.role })}
      onclick={openPanel}
    >
      <span class="sc-surface" aria-hidden="true"></span>
      <span class="sc-col">
        <span class="sc-title-row">
          <span class="msr4 sc-ico" class:live={active} aria-hidden="true">smart_toy</span>
          <span class="sc-title trunc" class:agy-shine={active}>{node.role}</span>
        </span>
        <span class="sc-meta num">
          <span class="sc-kind">{subagentKindLabel(node.kind)}</span>
          <span class="sc-st" class:err={anyError && !active} class:warn={node.status === 'waiting' && active}>{statusText}</span>
          {#if totalAgents > 1}
            <span>{t('{n} 个代理', { n: totalAgents })}</span>
          {/if}
          {#if elapsedText}
            <span>{elapsedText}</span>
          {/if}
        </span>
        {#if active || totalAgents > 1}
          <span class="sc-dots">
            <AgyAgentDots {counts} agents={subtree} wrap maxRows={6} anticipate={active} />
          </span>
        {/if}
        {#if modelLine}
          <span class="sc-models trunc" title={modelLine}>{modelLine}</span>
        {/if}
        {#if liveStepLine}
          <span class="sc-live trunc" title={liveStepLine}>{liveStepLine}</span>
        {:else if errLine}
          <span class="sc-err trunc" title={errLine}>{errLine}</span>
        {/if}
      </span>
      <span class="msr sc-chev" aria-hidden="true">expand_more</span>
    </button>
  </div>
{/if}

<style>
  .ag-subcard-wrap {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    margin: 6px 0 8px;
  }
  .ag-subcard {
    appearance: none;
    background: none;
    border: 0;
    margin: 0;
    font: inherit;
    color: inherit;
    position: relative;
    isolation: isolate;
    display: flex;
    align-self: flex-start;
    align-items: flex-start;
    gap: 8px;
    width: 348px;
    max-width: 100%;
    box-sizing: border-box;
    padding: 10px 10px 10px 12px;
    border-radius: 10px;
    text-align: left;
    cursor: pointer;
    outline: none;
    -webkit-tap-highlight-color: transparent;
  }
  .ag-subcard:focus-visible {
    box-shadow: 0 0 0 1.5px var(--ag-accent);
  }
  .sc-surface {
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--ag-surface-1);
    box-shadow: inset 0 0 0 1px var(--ag-border-strong);
    transform-origin: 50% 50%;
    transition: transform 0.35s cubic-bezier(0.34, 1.26, 0.5, 1), background 0.14s ease, box-shadow 0.14s ease;
  }
  .ag-subcard.active .sc-surface {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ag-accent) 34%, var(--ag-border-strong));
  }
  .ag-subcard.failed .sc-surface {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ag-err) 32%, var(--ag-border-strong));
  }
  @media (hover: hover) {
    .ag-subcard:hover .sc-surface {
      background: var(--ag-surface-2);
    }
  }
  .ag-subcard:active .sc-surface {
    transform: scale(0.99);
    transition: transform 60ms ease-out;
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
    gap: 6px;
    min-width: 0;
  }
  .sc-ico {
    flex: none;
    font-size: 16px;
    color: var(--ag-on-dim);
  }
  .sc-ico.live {
    color: var(--ag-accent);
  }
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
  .sc-kind {
    color: var(--ag-on-sub);
  }
  .sc-st.err {
    color: var(--ag-err);
  }
  .sc-st.warn {
    color: var(--ag-warn);
  }
  .sc-dots {
    display: block;
    padding: 4px 0 2px;
  }
  .sc-models {
    font-size: 11.5px;
    line-height: 16px;
    color: var(--ag-on-dim);
  }
  .sc-live {
    font-size: 11.5px;
    line-height: 16px;
    color: var(--ag-on-sub);
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  }
  .sc-err {
    font-size: 11.5px;
    line-height: 16px;
    color: var(--ag-err);
  }
  .sc-chev {
    flex: none;
    font-size: 16px;
    line-height: 20px;
    color: var(--ag-on-faint);
    transform: rotate(-90deg);
    transition: transform 0.14s ease, color 0.14s ease;
  }
  @media (hover: hover) {
    .ag-subcard:hover .sc-chev {
      color: var(--ag-on-sub);
      transform: rotate(-90deg) translateY(1.5px);
    }
  }
  .trunc {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
</style>
