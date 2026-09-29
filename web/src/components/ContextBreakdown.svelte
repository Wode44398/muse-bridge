<script>
  // 上下文用量分布（官方 claude.ai/code「Context window」展开态同款，2026-09-01 逆向桌面包
  // ce96f5751 + c91b6e9db StackedMeter）：一根分段计量条（紧凑 4px / 常规 8px）+ 图例
  //（10×10 r2 色块 / 类别名 / tokens / 一位小数百分比，deferred 行显示「—」）+ 三个折叠小节
  //（MCP tools / Memory files / Custom agents：标题行带合计 tokens 与条数，>12 行内滚）。
  // 配色用官方 chart categorical 1–8（亮/暗两套实测值），free = reference tint、buffer/deferred = muted。
  import { prepareBreakdown, fmtCompact } from '../lib/ctxUsage.js';
  import { tr } from '../lib/i18n.js';
  // legend=false：只画计量条（官方收起态——弹层里计量条常显，展开只是多出图例与小节）。
  let { usage, compact = true, legend = true } = $props();

  const prep = $derived(prepareBreakdown(usage));
  const thick = $derived(compact ? 4 : 8);
  const rIn = $derived(Math.min(4, thick / 4));

  const cleanTool = (t) => {
    const raw = String(t.name || '');
    const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(raw);
    const name = (m ? m[1] : raw).replace(/_/g, ' ');
    return (t.server ? t.server + ' · ' : '') + name;
  };
  const sections = $derived([
    { id: 'mcp', label: 'MCP tools', rows: (usage?.mcpTools || []).map((t) => ({ name: cleanTool(t), tokens: t.tokens })) },
    { id: 'mem', label: 'Memory files', rows: (usage?.memoryFiles || []).map((f) => ({ name: f.path, tokens: f.tokens })) },
    { id: 'agents', label: 'Custom agents', rows: (usage?.agents || []).map((a) => ({ name: a.type, tokens: a.tokens })) },
  ].filter((s) => s.rows.length));
  let open = $state({});
  const sum = (rows) => rows.reduce((a, r) => a + (r.tokens || 0), 0);
</script>

<div class="cb">
  <div class="meter" style="height:{thick}px" role="img" aria-label={'Context window ' + fmtCompact(prep.usedTokens) + ' / ' + fmtCompact(usage?.max || 0)}>
    {#each prep.segments as s, i (s.id)}
      <span class="seg" style="left:calc({s.start}% + {i ? 1 : 0}px);width:calc({s.width}% - {i ? 1 : 0}px);background:{s.color};border-radius:{i === 0 ? thick / 2 : rIn}px {i === prep.segments.length - 1 ? thick / 2 : rIn}px {i === prep.segments.length - 1 ? thick / 2 : rIn}px {i === 0 ? thick / 2 : rIn}px"></span>
    {/each}
  </div>
  {#if legend}
  <div class="legend">
    {#each prep.legend as r (r.id)}
      <div class="row">
        <span class="sw" style="background:{r.color}"></span>
        <span class="nm">{tr(r.name)}</span>
        <span class="tk">{fmtCompact(r.tokens)}</span>
        <span class="pc">{r.deferred ? '—' : r.pct.toFixed(1) + '%'}</span>
      </div>
    {/each}
  </div>
  {#each sections as s (s.id)}
    <div class="sec">
      <button class="sec-h" aria-expanded={!!open[s.id]} onclick={() => (open[s.id] = !open[s.id])}>
        <span class="car" class:on={open[s.id]}><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2l3 3-3 3"/></svg></span>
        <span class="sec-l">{s.label}</span>
        <span class="tk">{fmtCompact(sum(s.rows))}</span>
        <span class="pc">{s.rows.length}</span>
      </button>
      {#if open[s.id]}
        <div class="sec-b" class:scroll={s.rows.length > 12}>
          {#each s.rows as r, i (r.name + i)}
            <div class="row sub">
              <span class="sw blank"></span>
              <span class="nm muted" title={r.name}>{r.name}</span>
              <span class="tk">{fmtCompact(r.tokens)}</span>
              <span class="pc"></span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  {/if}
</div>

<style>
  /* 官方 chart categorical 令牌（c25d7186f：亮色值 / 暗色 modes 值） */
  .cb {
    --cx-1: #2a78d6; --cx-2: #eb6834; --cx-3: #1baf7a; --cx-4: #eda100; --cx-5: #e87ba4; --cx-6: #008300; --cx-7: #4a3aa7; --cx-8: #e34948;
    --cx-ref: color-mix(in srgb, var(--muted) 85%, transparent);
    --cx-ref-tint: color-mix(in srgb, var(--muted) 18%, transparent);
    --cx-muted: color-mix(in srgb, var(--muted) 45%, transparent);
    display: flex; flex-direction: column; gap: 6px; min-width: 0;
  }
  :global(html[data-theme="dark"]) .cb {
    --cx-1: #3987e5; --cx-2: #d95926; --cx-3: #199e70; --cx-4: #c98500; --cx-5: #d55181; --cx-7: #9085e9; --cx-8: #e66767;
  }
  .meter { position: relative; width: 100%; overflow: hidden; border-radius: 999px; background: var(--cx-ref-tint); }
  .seg { position: absolute; top: 0; bottom: 0; display: block; }
  .legend { display: flex; flex-direction: column; }
  .row { display: flex; align-items: center; gap: 4px; font-size: 12px; line-height: 16px; min-width: 0; }
  .legend .row + .row { margin-top: 4px; }
  .sw { flex: none; width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .sw.blank { background: transparent; }
  .nm { flex: 1; min-width: 0; color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .nm.muted { color: var(--muted); }
  .tk { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
  .pc { flex: none; width: 44px; text-align: right; color: var(--text); font-variant-numeric: tabular-nums; }
  .sec { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
  .sec-h { display: flex; align-items: center; gap: 4px; width: 100%; text-align: left; font-size: 12px; line-height: 16px; padding: 0; }
  .car { flex: none; width: 10px; height: 10px; display: flex; align-items: center; justify-content: center; color: var(--muted); opacity: .7; }
  .car svg { width: 10px; height: 10px; transition: transform var(--mo-micro, .12s) var(--ea-std, ease); }
  .car.on svg { transform: rotate(90deg); }
  .sec-l { flex: 1; min-width: 0; color: var(--serif); }
  .sec-b { display: flex; flex-direction: column; gap: 2px; }
  .sec-b.scroll { max-height: 168px; overflow-y: auto; overscroll-behavior: contain; }
</style>
