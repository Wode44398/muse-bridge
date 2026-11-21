<script>
  // table 积木：{ columns: [{ key, label, align? }], rows: [], rowAction?, empty? }。
  //   放在一张卡里；列多、窄屏放不下时表格在卡里横滚（列宽按内容自然排，长单元格截断、悬停 / 长按看全文），整页不会被顶宽。
  //   点表头排序（升 → 降 → 原序），数字列按数值比、别的按本地语言自然序；空值永远排最后。只在前端排，不惊动插件。
  //   给了 rowAction：点一行 → ctx.run(rowAction, { row })（row = 这一行的原始对象，服务端规范过：列键 + 可选 id）。
  import { t } from '../../lib/i18n.js';
  let { block, ctx } = $props();

  const columns = $derived(Array.isArray(block.columns) ? block.columns : []);
  const rows = $derived(Array.isArray(block.rows) ? block.rows : []);
  const alignOf = (c) => (c.align === 'right' || c.align === 'center' ? c.align : 'left');

  let sortKey = $state('');
  let sortDir = $state(0);   // 1 升 / -1 降 / 0 原序
  function sortBy(key) {
    if (sortKey !== key) { sortKey = key; sortDir = 1; return; }
    sortDir = sortDir === 1 ? -1 : sortDir === -1 ? 0 : 1;
    if (!sortDir) sortKey = '';
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const asNum = (v) => {
    if (typeof v === 'number') return v;
    const s = String(v ?? '').trim().replace(/[,\s]/g, '').replace(/%$/, '');
    return s && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? Number(s) : NaN;
  };
  const view = $derived.by(() => {
    // 插件新给的树里没这一列了：当没排序
    if (!sortDir || !sortKey || !columns.some((c) => c.key === sortKey)) return rows.map((r, i) => ({ r, i }));
    const k = sortKey, dir = sortDir;
    const list = rows.map((r, i) => ({ r, i }));
    const allNum = list.every(({ r }) => r[k] === '' || r[k] == null || !Number.isNaN(asNum(r[k])));
    return list.sort((a, b) => {
      const x = a.r[k], y = b.r[k];
      const ex = x === '' || x == null, ey = y === '' || y == null;
      if (ex || ey) return ex === ey ? a.i - b.i : ex ? 1 : -1;
      const c = allNum ? asNum(x) - asNum(y) : coll.compare(String(x), String(y));
      return c ? c * dir : a.i - b.i;
    });
  });

  const clickable = $derived(!!block.rowAction);
  function press(r) { if (block.rowAction) ctx.run(block.rowAction, { row: r }); }
  function onKey(e, r) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); press(r); }
  }
</script>

<div class="tb av-card">
  <div class="scroll">
    <table>
      <thead>
        <tr>
          {#each columns as c (c.key)}
            <th class={alignOf(c)} aria-sort={sortKey === c.key ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}>
              <button type="button" class="sort" class:on={sortKey === c.key} onclick={() => sortBy(c.key)}>
                <span class="lb">{c.label}</span>
                <svg class="arr" class:down={sortKey === c.key && sortDir === -1} viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M5 8V2M2.5 4.5 5 2l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each view as { r, i } (i)}
          {#if clickable}
            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
            <tr class="act" class:busy={ctx.busy(block.rowAction, { row: r })} tabindex="0" role="button"
              onclick={() => press(r)} onkeydown={(e) => onKey(e, r)}>
              {#each columns as c (c.key)}<td class={alignOf(c)} title={String(r[c.key] ?? '').length > 24 ? r[c.key] : null}>{r[c.key] ?? ''}</td>{/each}
            </tr>
          {:else}
            <tr>
              {#each columns as c (c.key)}<td class={alignOf(c)} title={String(r[c.key] ?? '').length > 24 ? r[c.key] : null}>{r[c.key] ?? ''}</td>{/each}
            </tr>
          {/if}
        {:else}
          <tr class="none"><td colspan={Math.max(1, columns.length)}>{block.empty || t('还没有数据')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .tb { min-width: 0; }
  /* 横滚只在卡里发生；左右滑到头不把整页带着走 */
  .scroll { overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; scrollbar-width: thin; }
  table { width: max-content; min-width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 0 var(--av-px); text-align: left; white-space: nowrap; }
  th.right, td.right { text-align: right; }
  th.center, td.center { text-align: center; }
  th { height: 38px; border-bottom: 1px solid var(--av-sep); vertical-align: middle; }
  :global(.av-desk) th { height: 32px; }
  td {
    height: 46px; max-width: 280px; overflow: hidden; text-overflow: ellipsis;
    font-size: 15px; line-height: 20px; color: var(--av-ink);
  }
  :global(.av-desk) td { height: var(--av-row); font-size: var(--av-fs); line-height: var(--av-lh); }
  tbody tr + tr td { border-top: 1px solid var(--av-sep); }
  .sort {
    display: inline-flex; align-items: center; gap: 4px; max-width: 240px; padding: 0; border: 0; background: none; cursor: pointer;
    font: inherit; font-size: var(--av-fs-head); line-height: var(--av-lh-head); font-weight: 500; color: var(--av-ink2);
  }
  :global(.av-desk) .sort { font-weight: 600; }
  th.right .sort { flex-direction: row-reverse; }
  .sort .lb { overflow: hidden; text-overflow: ellipsis; }
  .sort:focus-visible { outline: none; box-shadow: var(--av-focus); border-radius: 4px; }
  .arr { flex: none; opacity: 0; transition: opacity var(--av-t), transform var(--av-t); }
  .sort.on { color: var(--av-ink); }
  .sort.on .arr { opacity: .8; }
  .arr.down { transform: rotate(180deg); }
  @media (hover: hover) { .sort:hover .arr { opacity: .45; } .sort.on:hover .arr { opacity: .8; } }
  tr.act { cursor: pointer; transition: background var(--av-t) linear; }
  tr.act:active, tr.act.busy { background: var(--av-press); }
  tr.act:focus-visible { outline: none; box-shadow: inset var(--av-focus); }
  @media (hover: hover) { :global(.av-desk) tr.act:hover { background: var(--av-hover); } }
  tr.none td { height: auto; padding: 18px var(--av-px); text-align: center; white-space: normal; font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-ink2); }
</style>
