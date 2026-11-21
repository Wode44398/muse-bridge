<script>
  // Antigravity 多代理点阵（参考 Claude AgentDots 6×6 网格，严格使用 --ag-* 令牌）：
  // 一格一个子代理，总数超容量时按状态比例压缩；运行中呼吸错相（黄金比例散列），等待态提示黄，错误红，完成态中性低对比。
  import { t } from '../../lib/i18n.js';

  const {
    counts = null,
    agents = null,
    wrap = false,
    cols = undefined,
    maxRows = 4,
    anticipate = false,
  } = $props();

  const c = $derived(counts || { done: 0, running: 0, waiting: 0, error: 0, killed: 0, total: 0 });
  const cap = $derived(cols ? Number.MAX_SAFE_INTEGER : (wrap ? 32 * maxRows : 32));

  function compress(cnt, limit) {
    const total = cnt.total || 0;
    if (!total) return [];
    if (total <= limit) {
      const cells = [];
      for (const st of ['done', 'running', 'waiting', 'error', 'killed']) {
        const n = cnt[st] || 0;
        for (let k = 0; k < n; k++) cells.push(st);
      }
      return cells;
    }
    const order = ['done', 'running', 'waiting', 'error', 'killed'];
    const parts = order.map((s) => ({ s, n: cnt[s] || 0 })).filter((p) => p.n > 0);
    const alloc = parts.map((p) => {
      const exact = (p.n * limit) / total;
      const fl = Math.floor(exact);
      return { s: p.s, n: Math.max(1, fl), rem: exact - fl };
    });
    let used = alloc.reduce((acc, x) => acc + x.n, 0);
    const byRem = [...alloc].sort((a, b) => b.rem - a.rem);
    let idx = 0;
    while (used < limit && byRem.length) { byRem[idx % byRem.length].n++; used++; idx++; }
    while (used > limit) {
      const drop = [...alloc].filter((a) => a.n > 1).sort((a, b) => a.rem - b.rem)[0];
      if (!drop) break;
      drop.n--; used--;
    }
    const cells = [];
    for (const s of order) {
      const a = alloc.find((x) => x.s === s);
      if (a) for (let k = 0; k < a.n; k++) cells.push(s);
    }
    return cells;
  }

  const oneToOne = $derived(Array.isArray(agents) && agents.length > 0 && agents.length <= cap);
  const cells = $derived(oneToOne ? agents.map((a) => a.status || 'done') : compress(c, cap));
  const labels = $derived(oneToOne ? agents : null);

  function statusWord(st) {
    if (st === 'running') return t('运行中');
    if (st === 'waiting') return t('等待子代理');
    if (st === 'error') return t('出错');
    if (st === 'killed') return t('已停止');
    return t('已完成');
  }

  const summary = $derived(
    c.total === 0
      ? t('等待子代理启动')
      : t('共 {total} 个代理：{done} 已完成，{active} 活跃，{error} 出错', {
        total: c.total,
        done: c.done || 0,
        active: (c.running || 0) + (c.waiting || 0),
        error: c.error || 0,
      })
  );

  function cellTitle(st, idx) {
    const lbl = labels?.[idx]?.role;
    return lbl ? `${lbl} · ${statusWord(st)}` : statusWord(st);
  }

  function pulseStyle(idx) {
    const phase = (0.61803398875 * idx) % 1;
    const dur = 2.2 + ((0.7548776662 * idx) % 1) * 1.4;
    return `--dur:${dur.toFixed(2)}s;--delay:${(-phase * dur).toFixed(2)}s`;
  }

  const gridMode = $derived(wrap || cols !== undefined);
  const gridStyle = $derived(
    cols
      ? `grid-template-columns:repeat(${cols},6px)`
      : `grid-template-columns:repeat(auto-fill,6px);max-height:${8 * maxRows - 2}px`
  );
</script>

{#if gridMode}
  <span class="ag-dots grid" class:fit={!!cols} class:full={!cols} role="img" aria-label={summary} title={summary} style={gridStyle}>
    {#each cells as st, idx (idx)}
      <span class="cell {st}" data-cell={st} title={cellTitle(st, idx)} style={st === 'running' || st === 'waiting' ? pulseStyle(idx) : ''}></span>
    {/each}
    {#if anticipate}
      <span class="cell ghost" data-cell="ghost" title={t('可能会派出更多子代理')}></span>
    {/if}
  </span>
{:else}
  <span class="ag-dots row" role="img" aria-label={summary} title={summary}>
    <span class="grid full" style="grid-template-columns:repeat(auto-fill,6px);max-height:6px">
      {#each cells as st, idx (idx)}
        <span class="cell {st}" data-cell={st} title={cellTitle(st, idx)} style={st === 'running' || st === 'waiting' ? pulseStyle(idx) : ''}></span>
      {/each}
      {#if anticipate}
        <span class="cell ghost" data-cell="ghost" title={t('可能会派出更多子代理')}></span>
      {/if}
    </span>
  </span>
{/if}

<style>
  .ag-dots { display: block; }
  .ag-dots.row { display: flex; align-items: center; height: 18px; }
  .grid { display: grid; gap: 2px; }
  .grid.fit { width: fit-content; }
  .grid.full { width: 100%; overflow: hidden; }
  .cell {
    box-sizing: border-box;
    width: 6px;
    height: 6px;
    border-radius: 2px;
    flex: none;
    background: transparent;
    border: 1px solid transparent;
    transition: background-color 0.16s, border-color 0.16s, opacity 0.16s;
  }
  .cell.done { background: color-mix(in srgb, var(--ag-on) 28%, transparent); }
  .cell.killed { background: color-mix(in srgb, var(--ag-on) 15%, transparent); }
  .cell.running {
    background: var(--ag-on);
    animation: ag-dot-pulse var(--dur, 2.6s) ease-in-out var(--delay, 0s) infinite;
  }
  .cell.waiting {
    background: var(--ag-warn);
    animation: ag-dot-pulse var(--dur, 2.8s) ease-in-out var(--delay, 0s) infinite;
  }
  .cell.error { background: var(--ag-err); }
  .cell.ghost {
    border-color: color-mix(in srgb, var(--ag-on) 30%, transparent);
    animation: ag-dot-ghost 2.2s ease-in-out infinite;
  }
  @keyframes ag-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  @keyframes ag-dot-ghost { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.85; } }
  @media (prefers-reduced-motion: reduce) {
    .cell, .cell.running, .cell.waiting, .cell.ghost { animation: none; transition: none; }
    .cell.ghost { opacity: 0.45; }
  }
</style>
