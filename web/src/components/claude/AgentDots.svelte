<script>
  // 官方工作流 agent 点阵（c360a9e1c rD/tD/aD，规格 workflow-panel.md §3.7）。
  // 6×6px 圆角 2 的小格，一格一个 agent；总数超容量时按状态比例压缩。
  // 配色铁律「彩色只留星芒」：官方 running 格是 accent 蓝，bridge 改用 var(--text)
  // （暗色白/亮色黑）；stalled 黄、error 红保留语义色。
  //
  // props：counts {done,running,stalled,error,pending,total}；agents [{label,state}]（一格一
  // agent 时按此顺序）；wrap（自动换行网格，maxRows 行封顶）；cols（定列数网格，w-fit）；
  // anticipate（末尾加一枚「还会有更多 agent」幽灵格）。
  let { counts, agents = undefined, wrap = false, cols = undefined, maxRows = 4, anticipate = false } = $props();

  const c = $derived(counts || { done: 0, running: 0, stalled: 0, error: 0, pending: 0, total: 0 });
  // 容量：指定 cols 不限；wrap 35×maxRows；单行 36
  const cap = $derived(cols ? Number.MAX_SAFE_INTEGER : wrap ? 35 * maxRows : 36);

  // 官方 ZO：【只在】总数超容量时按比例分配（最大余数法），每个非零状态至少 1 格；
  // 压缩后 stalled 并入 running（counts.running 本就含 stalled）。容量够就一状态一格——
  // 调用方只给 counts 不给 agents（或两者长度对不上）时不能把 1 个 agent 放大成 36 格。
  function compress(counts, cap) {
    const total = counts.total || 0;
    if (!total) return [];
    if (total <= cap) {
      const stalled = counts.stalled || 0;
      const n = { done: counts.done || 0, running: Math.max(0, (counts.running || 0) - stalled), stalled, error: counts.error || 0, pending: counts.pending || 0 };
      const cells = [];
      for (const s of ['done', 'running', 'stalled', 'error', 'pending']) for (let k = 0; k < n[s]; k++) cells.push(s);
      return cells;
    }
    const order = ['done', 'running', 'error', 'pending'];
    const parts = order.map((s) => ({ s, n: counts[s] || 0 })).filter((p) => p.n > 0);
    const alloc = parts.map((p) => { const exact = (p.n * cap) / total; const fl = Math.floor(exact); return { s: p.s, n: Math.max(1, fl), rem: exact - fl }; });
    let used = alloc.reduce((a, x) => a + x.n, 0);
    const byRem = [...alloc].sort((a, b) => b.rem - a.rem);
    let i = 0;
    while (used < cap && byRem.length) { byRem[i % byRem.length].n++; used++; i++; }
    while (used > cap) {
      const x = [...alloc].filter((a) => a.n > 1).sort((a, b) => a.rem - b.rem)[0];
      if (!x) break;
      x.n--; used--;
    }
    const cells = [];
    for (const s of order) { const a = alloc.find((x) => x.s === s); if (a) for (let k = 0; k < a.n; k++) cells.push(s); }
    return cells;
  }

  const oneToOne = $derived(!!agents && agents.length === c.total && c.total <= cap);
  const cells = $derived(oneToOne ? agents.map((a) => a.state) : compress(c, cap));
  const labels = $derived(oneToOne ? agents : null);

  const WORD = { done: 'Done', running: 'Running', stalled: 'Stalled', error: 'Failed', pending: 'Queued' };
  const summary = $derived(c.total === 0
    ? 'Waiting for agents to start'
    : `${c.done} of ${c.total} agents done, ${c.running - c.stalled} running, ${c.stalled} stalled, ${c.error} failed`);
  const cellTitle = (state, i) => {
    const lbl = labels && labels[i] && labels[i].label;
    return lbl ? `${WORD[state] || state} — ${lbl}` : (WORD[state] || state);
  };
  // 每个 running 格的呼吸相位/时长错开（官方 eD：黄金比例散列，2.4s ~ 3.8s）
  const pulseStyle = (i) => {
    const t = (0.61803398875 * i) % 1, n = 2.4 + ((0.7548776662 * i) % 1) * 1.4;
    return `--dur:${n.toFixed(2)}s;--delay:${(-t * n).toFixed(2)}s`;
  };
  const gridMode = $derived(wrap || cols !== undefined);
  const gridStyle = $derived(cols
    ? `grid-template-columns:repeat(${cols},6px)`
    : `grid-template-columns:repeat(auto-fill,6px);max-height:${8 * maxRows - 2}px`);
</script>

{#if gridMode}
  <span class="dots grid" class:fit={!!cols} class:full={!cols} role="img" aria-label={summary} title={summary} style={gridStyle}>
    {#each cells as st, i (i)}
      <span class="cell {st}" data-cell={st} title={cellTitle(st, i)} style={st === 'running' ? pulseStyle(i) : ''}></span>
    {/each}
    {#if anticipate}<span class="cell ghost" data-cell="ghost" title="More agents may appear"></span>{/if}
  </span>
{:else}
  <span class="dots row" role="img" aria-label={summary} title={summary}>
    <span class="grid full" style="grid-template-columns:repeat(auto-fill,6px);max-height:6px">
      {#each cells as st, i (i)}
        <span class="cell {st}" data-cell={st} title={cellTitle(st, i)} style={st === 'running' ? pulseStyle(i) : ''}></span>
      {/each}
      {#if anticipate}<span class="cell ghost" data-cell="ghost" title="More agents may appear"></span>{/if}
    </span>
  </span>
{/if}

<style>
  /* 令牌只挂在组件根上（嵌入宿主 bundle 的子应用 CSS 禁裸 :root）。
     done 格官方亮色 --t4(黑16%) / 暗色 --t5(白25%)；pending/ghost 描边 --t5。bridge 暗色是默认。 */
  .dots { --ad-done: rgba(255, 255, 255, .25); --ad-t5: rgba(255, 255, 255, .25); display: block; }
  :global(html[data-theme="light"]) .dots { --ad-done: rgba(0, 0, 0, .16); --ad-t5: rgba(0, 0, 0, .25); }
  .dots.row { display: flex; align-items: center; height: 20px; }
  .grid { display: grid; gap: 2px; }
  .grid.fit { width: fit-content; }
  .grid.full { width: 100%; overflow: hidden; }
  .cell {
    box-sizing: border-box; width: 6px; height: 6px; border-radius: 2px; flex: none;
    background-color: transparent; border: 1px solid transparent;
    transition: background-color .16s, border-color .16s, opacity .16s, filter .16s;
  }
  @media (hover: hover) {
    .cell:hover { filter: brightness(1.1); }
    :global(html[data-theme="light"]) .cell:hover { filter: brightness(.9); }
  }
  .cell.done { background-color: var(--ad-done); }
  /* 官方 accent 蓝 → var(--text)（配色铁律） */
  .cell.running { background-color: var(--text); animation: pulse var(--dur, 2.8s) ease-in-out var(--delay, 0s) infinite; }
  .cell.stalled { background-color: var(--warn); }
  .cell.error { background-color: var(--crit); }
  .cell.pending { border-color: var(--ad-t5); }
  .cell.ghost { border-color: var(--ad-t5); animation: ghost 2.2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .72; } }
  @keyframes ghost { 0%, 100% { opacity: .25; } 50% { opacity: .9; } }
  @media (prefers-reduced-motion: reduce) {
    .cell { transition: none; }
    .cell.running { animation: none; }
    .cell.ghost { opacity: .45; animation: none; }
  }
</style>
