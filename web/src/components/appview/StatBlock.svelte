<script>
  // stat 积木：{ items: [{ label, value, delta?, tone?: ok|warn|error, hint? }] }（最多 8 个）。
  // 一格一张小卡，网格自适应列数（手机两列、宽屏三四列）：上面标签、中间大号数值、下面变化量 / 提示。
  // tone 只给字上色：有 delta 染 delta，没有 delta 染数值——不加彩色边条、彩点那类装饰。
  import { fitText } from '../../lib/fitText.js';
  let { block } = $props();
  const items = $derived((Array.isArray(block.items) ? block.items : []).slice(0, 8));
  const toneOf = (x) => (['ok', 'warn', 'error'].includes(x?.tone) ? 'av-tone-' + x.tone : '');
</script>

{#if items.length}
  <div class="st" class:few={items.length < 3} style:--n={items.length}>
    {#each items as it, i (i)}
      <div class="cell av-card" title={it.hint || null}>
        {#if it.label}<span class="lb">{it.label}</span>{/if}
        <span class="vl {it.delta ? '' : toneOf(it)}" use:fitText={{ min: 15, key: it.value }}>{it.value || '—'}</span>
        {#if it.delta || it.hint}
          <span class="ft">
            {#if it.delta}<span class="dl {toneOf(it)}">{it.delta}</span>{/if}
            {#if it.hint}<span class="hn">{it.hint}</span>{/if}
          </span>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .st { display: grid; gap: var(--av-gap-in); grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  /* 一两个的时候平分整行，不留半行空格 */
  .st.few { grid-template-columns: repeat(var(--n), minmax(0, 1fr)); }
  :global(.av-desk) .st { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  :global(.av-desk) .st.few { grid-template-columns: repeat(var(--n), minmax(0, 1fr)); }
  .cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 14px var(--av-px) 13px; }
  :global(.av-desk) .cell { padding: 12px var(--av-px); gap: 3px; }
  .lb, .hn { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .lb { font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-ink2); }
  /* 这里的字号是上限：一行放不下时 fitText 量实际宽度往下缩，最小 15px。缩到最小还放不下（几十个字的值）才折行，
     而且不截——这里放的多半是要看全的关键数字。折行先在空格、汉字之间；一串数字长到最小号也放不下，
     才不得不从中间断（anywhere），总比撑出格子强 */
  .vl {
    display: block; font-size: 26px; line-height: 1.24; font-weight: 650; letter-spacing: -.02em; color: var(--av-ink);
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere; min-height: 32px;
  }
  :global(.av-desk) .vl { font-size: 22px; min-height: 28px; letter-spacing: -.014em; }
  .ft { display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); }
  .dl { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--av-ink2); }
  .hn { min-width: 0; color: var(--av-ink3); }
  .vl.av-tone-ok, .dl.av-tone-ok { color: var(--av-ok); }
  .vl.av-tone-warn, .dl.av-tone-warn { color: var(--av-warn); }
  .vl.av-tone-error, .dl.av-tone-error { color: var(--av-err); }
</style>
