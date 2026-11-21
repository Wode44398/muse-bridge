<script>
  // Swarm @mention 协作关系图与时间线回放器：
  // 响应式 SVG 绘制成员节点、有向曲线边（线宽映射交互频次，虚线代表 @all），
  // 支持逐帖步进 / 自动播放 / 滑块拖动 / 实时模式，点击节点直达该成员转录或消息。
  import { untrack } from 'svelte';
  import { computeSwarmGraph, stripLeadingMentions } from '../../../lib/agy/swarm-logic.js';
  import { t } from '../../../lib/i18n.js';

  const {
    snap,
    onOpenMember = () => {},
    onJumpSeq = () => {},
  } = $props();

  let boxEl = $state(null);
  let width = $state(400);
  let expandAll = $state(false);
  let hideInactive = $state(false);
  let replayIdx = $state(null); // null = 实时全量
  let playing = $state(false);

  $effect(() => {
    const el = boxEl;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      if (w >= 240) width = w;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  const graph = $derived(computeSwarmGraph(snap, {
    upto: replayIdx,
    expandAll,
    hideInactive,
    width,
  }));

  $effect(() => {
    if (!playing) return;
    const total = untrack(() => graph.totalPosts);
    if (!total) { playing = false; return; }
    const tid = setInterval(() => {
      const cur = replayIdx === null ? 0 : replayIdx;
      if (cur >= graph.totalPosts) {
        playing = false;
        return;
      }
      replayIdx = cur + 1;
    }, 1100);
    return () => clearInterval(tid);
  });

  function togglePlay() {
    if (playing) { playing = false; return; }
    if (!graph.totalPosts) return;
    if (replayIdx === null || replayIdx >= graph.totalPosts) replayIdx = 0;
    playing = true;
  }

  function stepBy(delta) {
    playing = false;
    const cur = replayIdx === null ? graph.totalPosts : replayIdx;
    replayIdx = Math.max(0, Math.min(graph.totalPosts, cur + delta));
  }

  function goLive() {
    playing = false;
    replayIdx = null;
  }

  function onNodeClick(node) {
    const m = (snap?.members || []).find((x) => x.name === node.id);
    if (m) onOpenMember(m);
  }
</script>

<div class="sw-graph" bind:this={boxEl}>
  <div class="sw-gctl">
    <div class="sw-play-row">
      <div class="sw-btn-grp">
        <button
          type="button"
          class="sw-pbtn"
          disabled={graph.upto <= 0}
          onclick={() => stepBy(-1)}
          title={t('上一条消息')}
          aria-label={t('上一条消息')}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="sw-pbtn"
          disabled={graph.totalPosts === 0}
          onclick={togglePlay}
          title={playing ? t('暂停回放') : t('播放回放')}
          aria-label={playing ? t('暂停回放') : t('播放回放')}
        >
          {#if playing}
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="4" y="3.5" width="2.8" height="9" rx="0.8" fill="currentColor" />
              <rect x="9.2" y="3.5" width="2.8" height="9" rx="0.8" fill="currentColor" />
            </svg>
          {:else}
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M5 3.6v8.8a.5.5 0 0 0 .76.43l7-4.4a.5.5 0 0 0 0-.86l-7-4.4A.5.5 0 0 0 5 3.6z" fill="currentColor" />
            </svg>
          {/if}
        </button>
        <button
          type="button"
          class="sw-pbtn"
          disabled={replayIdx === null || graph.upto >= graph.totalPosts}
          onclick={() => stepBy(1)}
          title={t('下一条消息')}
          aria-label={t('下一条消息')}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <input
        type="range"
        class="sw-gslider"
        min="0"
        max={graph.totalPosts}
        value={graph.upto}
        disabled={graph.totalPosts === 0}
        aria-label={t('拖动回放协作轨迹')}
        oninput={(e) => { playing = false; replayIdx = Number(e.currentTarget.value); }}
      />

      <button
        type="button"
        class="sw-live-btn"
        class:on={replayIdx === null}
        aria-pressed={replayIdx === null}
        onclick={goLive}
      >
        <i aria-hidden="true"></i>
        <span>{t('实时')}</span>
      </button>
    </div>

    <div class="sw-opt-row">
      <span class="sw-step-lbl num">
        {#if replayIdx === null}
          {t('共 {n} 条协作消息', { n: graph.totalPosts })}
        {:else}
          {t('第 {cur} / {total} 条', { cur: graph.upto, total: graph.totalPosts })}
        {/if}
      </span>
      <span class="sw-spacer"></span>
      <label class="sw-chk">
        <input type="checkbox" bind:checked={expandAll} />
        <span>{t('展开 @all')}</span>
      </label>
      <label class="sw-chk">
        <input type="checkbox" bind:checked={hideInactive} />
        <span>{t('隐藏非活跃')}</span>
      </label>
    </div>
  </div>

  <div class="sw-gstage">
    <svg
      class="sw-gsvg"
      viewBox={`0 0 ${graph.width} ${graph.height}`}
      style={`height:${graph.height}px`}
      role="img"
      aria-label={t('成员 @提及 协作关系图')}
    >
      <defs>
        <marker id="sw-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerUnits="userSpaceOnUse" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path class="sw-ah" d="M1,1.4 L9,5 L1,8.6 Q2.6,5 1,1.4 z" />
        </marker>
      </defs>

      {#each graph.edges as e (e.key)}
        <path
          class="sw-edge"
          class:via-all={e.viaAllOnly}
          class:cur={e.isCur}
          class:past={graph.replaying && !e.isCur}
          d={e.d}
          stroke-width={e.width}
          marker-end="url(#sw-arrow)"
        >
          <title>{e.from} → {e.to}: {e.total}</title>
        </path>
        {#if e.total > 1}
          <text class="sw-ecnt" x={e.mx} y={e.my + 3} text-anchor="middle">{e.total}</text>
        {/if}
        {#if e.isCur}
          <circle class="sw-curdot" cx={e.end.x} cy={e.end.y} r="4" />
        {/if}
      {/each}

      {#each graph.nodes as n (n.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <g
          class="sw-node"
          class:inactive={n.inactive}
          class:hot={n.hot}
          class:killed={n.killed}
          class:outsider={n.outsider}
          onclick={() => onNodeClick(n)}
        >
          <title>@{n.id}</title>
          {#if n.unaddressed > 0}
            <rect
              class="sw-ring-out"
              x={n.x - n.w / 2 - 4}
              y={n.y - n.h / 2 - 4}
              width={n.w + 8}
              height={n.h + 8}
              rx={n.h / 2 + 4}
            />
          {/if}
          <rect
            class="sw-nbox"
            x={n.x - n.w / 2}
            y={n.y - n.h / 2}
            width={n.w}
            height={n.h}
            rx={n.h / 2}
          />
          {#if n.status}
            <circle
              class="sw-ndot {n.status}"
              cx={n.x - n.w / 2 + 13}
              cy={n.y}
              r="3.2"
            />
          {/if}
          <text
            class="sw-nlbl"
            x={n.x - n.w / 2 + (n.status ? 22 : 12)}
            y={n.y + 4}
          >{n.label}</text>
          {#if n.broadcasts > 0}
            <g class="sw-bcast">
              <rect x={n.x + n.w / 2 - 36} y={n.y - n.h / 2 - 7} width="40" height="14" rx="7" />
              <text x={n.x + n.w / 2 - 16} y={n.y - n.h / 2 + 3} text-anchor="middle">@all {n.broadcasts}</text>
            </g>
          {/if}
        </g>
      {/each}
    </svg>
  </div>

  <div class="sw-legend">
    <span><i class="lg-solid"></i>{t('@提及（线宽=频次）')}</span>
    <span><i class="lg-dash"></i>{t('经 @all 广播')}</span>
    <span><i class="lg-ring"></i>{t('含无对象发帖')}</span>
  </div>

  {#if graph.current}
    <div class="sw-cap">
      <div class="sw-cap-h">
        <span class="sw-cap-who">@{graph.current.agent}</span>
        {#if (graph.current.mentions || []).length > 0 || graph.current.all}
          <span class="sw-cap-to trunc">
            → {[...(graph.current.mentions || []).map((x) => `@${x}`), ...(graph.current.all ? ['@all'] : [])].join(' ')}
          </span>
        {/if}
        <button type="button" class="sw-cap-jump num" onclick={() => onJumpSeq(graph.current.seq)}>
          #{graph.current.seq}
        </button>
      </div>
      <p class="sw-cap-txt">{stripLeadingMentions(graph.current.text)}</p>
    </div>
  {/if}
</div>

<style>
  .sw-graph {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .sw-gctl {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
  }
  .sw-play-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .sw-btn-grp {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--ag-border);
    border-radius: 7px;
    overflow: hidden;
    flex: none;
  }
  .sw-pbtn {
    width: 26px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-sub);
  }
  .sw-pbtn + .sw-pbtn { border-left: 1px solid var(--ag-border); }
  .sw-pbtn:hover:not(:disabled) { background: var(--ag-hover); color: var(--ag-on); }
  .sw-pbtn:disabled { opacity: 0.35; cursor: default; }
  .sw-gslider {
    flex: 1;
    min-width: 60px;
    accent-color: var(--ag-accent);
    margin: 0;
  }
  .sw-live-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    font-size: 11px;
    border: 1px solid var(--ag-border);
    color: var(--ag-on-dim);
  }
  .sw-live-btn i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ag-on-faint);
  }
  .sw-live-btn.on {
    border-color: color-mix(in srgb, var(--ag-accent) 45%, var(--ag-border));
    background: color-mix(in srgb, var(--ag-accent) 12%, transparent);
    color: var(--ag-on);
  }
  .sw-live-btn.on i { background: var(--ag-accent); }

  .sw-opt-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    font-size: 11px;
    color: var(--ag-on-dim);
  }
  .sw-spacer { flex: 1; }
  .sw-chk {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    user-select: none;
  }
  .sw-chk input { accent-color: var(--ag-accent); margin: 0; }

  .sw-gstage {
    border-radius: 11px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    padding: 6px 2px;
    overflow: hidden;
  }
  .sw-gsvg {
    width: 100%;
    display: block;
  }
  .sw-ah { fill: color-mix(in srgb, var(--ag-on) 48%, transparent); }
  .sw-edge {
    fill: none;
    stroke: color-mix(in srgb, var(--ag-on) 34%, transparent);
    stroke-linecap: round;
  }
  .sw-edge.via-all { stroke-dasharray: 4 4; stroke: color-mix(in srgb, var(--ag-on) 22%, transparent); }
  .sw-edge.past { opacity: 0.25; }
  .sw-edge.cur { stroke: var(--ag-accent); opacity: 0.95; }
  .sw-ecnt {
    font-size: 10px;
    font-weight: 500;
    fill: var(--ag-on-dim);
    paint-order: stroke;
    stroke: var(--ag-surface-1);
    stroke-width: 3.5px;
    stroke-linejoin: round;
  }
  .sw-curdot { fill: var(--ag-accent); stroke: var(--ag-surface-1); stroke-width: 1.5; }

  .sw-node { cursor: pointer; }
  .sw-node.inactive { opacity: 0.28; }
  .sw-nbox {
    fill: var(--ag-bg);
    stroke: var(--ag-border-strong);
    stroke-width: 1;
  }
  .sw-node:hover .sw-nbox { stroke: var(--ag-on-sub); }
  .sw-node.hot .sw-nbox {
    fill: color-mix(in srgb, var(--ag-accent) 12%, var(--ag-bg));
    stroke: var(--ag-accent);
    stroke-width: 1.5;
  }
  .sw-node.killed .sw-nbox { stroke-dasharray: 2.5 2.5; }
  .sw-node.outsider .sw-nbox { stroke-dasharray: 3 2; }
  .sw-ring-out {
    fill: none;
    stroke: var(--ag-on-faint);
    stroke-width: 1;
    stroke-dasharray: 2 2.5;
  }
  .sw-ndot.working { fill: var(--ag-accent); }
  .sw-ndot.waiting { fill: none; stroke: var(--ag-on-faint); stroke-width: 1.4; }
  .sw-ndot.error { fill: var(--ag-err); }
  .sw-ndot.killed { fill: var(--ag-on-faint); }
  .sw-nlbl {
    font-size: 11.5px;
    font-weight: 500;
    fill: var(--ag-on);
    font-family: var(--ag-mono);
  }
  .sw-node.killed .sw-nlbl { fill: var(--ag-on-dim); text-decoration: line-through; }
  .sw-bcast rect {
    fill: var(--ag-surface-2);
    stroke: var(--ag-border-strong);
    stroke-width: 1;
  }
  .sw-bcast text {
    font-size: 9px;
    font-weight: 600;
    fill: var(--ag-on-dim);
  }

  .sw-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    font-size: 11px;
    color: var(--ag-on-faint);
    padding: 0 2px;
  }
  .sw-legend span { display: inline-flex; align-items: center; gap: 5px; }
  .lg-solid { width: 14px; height: 1.5px; background: var(--ag-on-dim); display: inline-block; }
  .lg-dash { width: 14px; height: 0; border-top: 1.5px dashed var(--ag-on-dim); display: inline-block; }
  .lg-ring { width: 12px; height: 8px; border-radius: 4px; border: 1px dashed var(--ag-on-faint); display: inline-block; }

  .sw-cap {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 9px 11px;
    border-radius: 10px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
  }
  .sw-cap-h {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .sw-cap-who { font-weight: 560; font-family: var(--ag-mono); color: var(--ag-on); }
  .sw-cap-to { flex: 1; font-size: 11.5px; color: var(--ag-on-dim); font-family: var(--ag-mono); }
  .sw-cap-jump {
    flex: none;
    font-size: 11px;
    font-family: var(--ag-mono);
    color: var(--ag-accent);
    padding: 1px 6px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--ag-accent) 12%, transparent);
  }
  .sw-cap-txt {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--ag-on-sub);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 120px;
    overflow-y: auto;
  }
  .trunc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .num { font-variant-numeric: tabular-nums; }
</style>
