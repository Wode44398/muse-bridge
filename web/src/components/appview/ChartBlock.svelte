<script>
  // 声明式应用的 chart 积木：折线 / 柱状，SVG 自己画（不引图表库——应用页要轻、要和 bridge 的样子一致）。
  // 算数全在 lib/appChartMath.js（有测试）；这里只管量宽度、画、悬停 / 点按 / 方向键的落点与提示框。
  //   配色：ContextBreakdown 那套图表类目色（--cx-1…8，深浅两套各一份），按组在原数组里的位置取，藏掉别的组颜色不重排。
  //   文字一律用文字色（不用组的颜色）；组的身份靠图例与提示框里的色块——有三个颜色对底色对比不到 3:1，所以提示框一定要有。
  //   两组以上才有图例，点图例藏 / 显一组（至少留一组）。
  //   悬停（鼠标）跟着指针；触屏点一下钉住、再点同一处收起；聚焦后左右方向键逐个挪、Esc 收起。
  import { buildChart, clampHeight, nearestSlot, placeTip, seriesColor, fmtNum, textW } from '../../lib/appChartMath.js';
  import { t, locale } from '../../lib/i18n.js';

  let { block, ctx } = $props();

  const height = $derived(clampHeight(block?.height));
  let width = $state(0);
  let hidden = $state(new Set());
  let active = $state(-1);       // 当前落点（slots 的下标），-1 = 没有
  let pinned = false;            // 触屏点出来的（指针离开不收）
  let tipW = $state(0), tipH = $state(0);

  const chart = $derived(width > 0 ? buildChart(block, { width, height, hidden, locale: locale() }) : null);
  const names = $derived((Array.isArray(block?.series) ? block.series.slice(0, 8) : []).map((s, i) => ({ si: i, name: typeof s?.name === 'string' ? s.name : '' })));
  const unit = $derived(typeof block?.y?.unit === 'string' ? block.y.unit : '');
  const yLabel = $derived(typeof block?.y?.label === 'string' ? block.y.label : '');
  const xLabel = $derived(typeof block?.x?.label === 'string' ? block.x.label : '');
  const slot = $derived(chart && active >= 0 && active < chart.slots.length ? chart.slots[active] : null);
  // 点数不多时常驻小圆点（看得出数据在哪几处）；密了只在落点上画
  const showDots = $derived(!!chart && chart.kind === 'line' && chart.series.every((s) => s.dots.length <= 24));

  // 树刷新、藏显一组之后落点数变了：越界的收掉
  $effect(() => { if (chart && active >= chart.slots.length) active = -1; });

  // 单位接在数后面：%、中日韩字的单位不留空格，英文单位留一个
  const withUnit = (s) => (!unit || !s ? s : /^[%‰°⺀-鿿]/.test(unit) ? s + unit : s + ' ' + unit);
  const fmtV = (v) => withUnit(fmtNum(v, { locale: locale() }));

  function toggle(si) {
    const next = new Set(hidden);
    if (next.has(si)) next.delete(si);
    else {
      if (names.length - next.size <= 1) return;   // 最后一组不让藏（藏光了图就空了）
      next.add(si);
    }
    hidden = next;
  }

  function localX(e) {
    const r = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - r.left) / Math.max(1, r.width)) * width;
  }
  function onMove(e) {
    if (!chart || e.pointerType === 'touch' || pinned) return;
    active = nearestSlot(chart.slots, localX(e));
  }
  function onLeave(e) { if (e.pointerType !== 'touch' && !pinned) active = -1; }
  function onDown(e) {
    if (!chart || e.pointerType === 'mouse') return;
    const i = nearestSlot(chart.slots, localX(e));
    if (pinned && i === active) { active = -1; pinned = false; return; }
    active = i;
    pinned = i >= 0;
  }
  function onKey(e) {
    if (!chart || !chart.slots.length) return;
    const n = chart.slots.length;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      pinned = true;
      active = active < 0 ? (e.key === 'ArrowRight' ? 0 : n - 1) : (active + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault(); pinned = true; active = e.key === 'Home' ? 0 : n - 1;
    } else if (e.key === 'Escape' && active >= 0) { e.preventDefault(); active = -1; pinned = false; }
  }
  function onBlur() { if (pinned) { active = -1; pinned = false; } }

  // 柱子：数据那头 4px 圆角，基线那头方角（负值反过来）
  function barPath(b) {
    const r = Math.max(0, Math.min(4, b.w / 2, b.h));
    const { x, w } = b;
    if (b.h <= 0) return '';
    if (!b.neg) {
      const y = b.y, y1 = b.y + b.h;
      return `M${x} ${y1}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y1}Z`;
    }
    const y0 = b.y, y = b.y + b.h;
    return `M${x} ${y0}V${y - r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y - r}V${y0}Z`;
  }

  // 提示框锚点：折线取这一格里最高的那个点，柱状取这一组柱子的顶
  const anchorY = $derived.by(() => {
    if (!chart || !slot) return 0;
    let y = chart.box.t + chart.box.h / 2;
    const ys = [];
    for (const s of chart.series) {
      if (s.hidden) continue;
      for (const d of s.dots) if (Math.abs(d.x - slot.x) < 0.5) ys.push(d.y);
      for (const b of s.bars) if (Math.abs(b.x + b.w / 2 - slot.x) <= chart.band / 2) ys.push(b.y);
    }
    if (ys.length) y = Math.min(...ys);
    return y;
  });
  const tipPos = $derived(slot ? placeTip(slot.x, anchorY, tipW || 120, tipH || 48, width, height) : { x: 0, y: 0 });

  // 读屏用：一句话概括 + 一张藏起来的表（颜色看不清的也能拿到数）
  const summary = $derived.by(() => {
    const kind = block?.kind === 'bar' ? t('柱状图') : t('折线图');
    const list = names.map((n) => n.name).filter(Boolean).join('、');
    return list ? t('{kind}：{series}', { kind, series: list }) : kind;
  });
  const legendW = $derived(names.reduce((w, n) => w + textW(n.name, 12) + 30, 0));
</script>

<div class="ch av-card">
  {#if yLabel || unit || names.length >= 2}
    <div class="ch-head" class:wrap={legendW > width * 0.7}>
      {#if yLabel || unit}
        <span class="ch-ylab">{yLabel && unit ? t('{label}（{unit}）', { label: yLabel, unit }) : yLabel || t('单位：{unit}', { unit })}</span>
      {/if}
      {#if names.length >= 2}
        <!-- 图例键的名字带上「图例」：系列名常和页面上的标签页、分段按钮同名（收入 / 支出），
             不带的话读屏和按文字点击（内置浏览器先找名字完全相同的）都分不清是哪一个 -->
        <div class="ch-legend" role="group" aria-label={t('图例')}>
          {#each names as n (n.si)}
            <button type="button" class="ch-key" class:off={hidden.has(n.si)} aria-pressed={!hidden.has(n.si)} aria-label={t('图例：{name}', { name: n.name })}
              title={hidden.has(n.si) ? t('显示这一组') : t('藏起这一组')} onclick={() => toggle(n.si)}>
              <i style:background={seriesColor(n.si)}></i><span>{n.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <div class="ch-plot" bind:clientWidth={width} style:height={height + 'px'}>
    {#if chart}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} tabindex="0"
        onpointermove={onMove} onpointerleave={onLeave} onpointerdown={onDown} onkeydown={onKey} onblur={onBlur}>
        <!-- 网格：细实线、退后；0 线（有负值时）稍重一点 -->
        {#each chart.yTicks as tk (tk.v)}
          <line class="grid" class:zero={tk.v === 0 && chart.yTicks[0].v < 0} x1={chart.box.l} x2={chart.box.l + chart.box.w} y1={tk.y} y2={tk.y} />
          <text class="tick y" x={chart.box.l - 8} y={tk.y} dy="0.35em">{tk.label}</text>
        {/each}
        {#each chart.xTicks as tk, i (i)}
          <text class="tick x" x={tk.x} y={chart.box.t + chart.box.h + 16}>{tk.label}</text>
        {/each}

        {#if slot}
          {#if chart.kind === 'bar'}
            <rect class="band" x={slot.x - chart.band / 2} y={chart.box.t} width={chart.band} height={chart.box.h} rx="6" />
          {:else}
            <line class="cross" x1={slot.x} x2={slot.x} y1={chart.box.t} y2={chart.box.t + chart.box.h} />
          {/if}
        {/if}

        {#each chart.series as s (s.si)}
          {#if !s.hidden}
            {#if chart.kind === 'line'}
              <path class="line" d={s.path} style:stroke={seriesColor(s.si)} />
              {#if showDots || s.dots.length === 1}
                {#each s.dots as d, i (i)}<circle class="dot" cx={d.x} cy={d.y} r="3.5" style:fill={seriesColor(s.si)} />{/each}
              {/if}
            {:else}
              {#each s.bars as b, i (i)}<path class="bar" d={barPath(b)} style:fill={seriesColor(s.si)} />{/each}
            {/if}
          {/if}
        {/each}

        <!-- 落点上的点：r 4.5，外圈一道 2px 底色描边，和线、别的点分得开 -->
        {#if slot && chart.kind === 'line'}
          {#each chart.series as s (s.si)}
            {#each s.hidden ? [] : s.dots.filter((d) => Math.abs(d.x - slot.x) < 0.5) as d, i (i)}
              <circle class="dot on" cx={d.x} cy={d.y} r="4.5" style:fill={seriesColor(s.si)} />
            {/each}
          {/each}
        {/if}
      </svg>

      {#if chart.empty}
        <div class="ch-empty">{t('没有数据')}</div>
      {/if}

      {#if slot}
        <div class="ch-tip" bind:offsetWidth={tipW} bind:offsetHeight={tipH} style:left={tipPos.x + 'px'} style:top={tipPos.y + 'px'} aria-live="polite">
          <div class="ch-tip-h">{slot.label}</div>
          {#each slot.items as it (it.si)}
            <div class="ch-tip-r"><i style:background={seriesColor(it.si)}></i><span class="n">{it.name}</span><b>{fmtV(it.v)}</b></div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  {#if xLabel}<div class="ch-xlab">{xLabel}</div>{/if}

  {#if chart && !chart.empty}
    <table class="ch-sr">
      <caption>{summary}</caption>
      <thead><tr><th scope="col">{xLabel || t('横轴')}</th>{#each chart.series as s (s.si)}{#if !s.hidden}<th scope="col">{s.name}</th>{/if}{/each}</tr></thead>
      <tbody>
        {#each chart.slots as sl, i (i)}
          <tr><th scope="row">{sl.label}</th>{#each chart.series as s (s.si)}{#if !s.hidden}<td>{fmtV(sl.items.find((x) => x.si === s.si)?.v)}</td>{/if}{/each}</tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  /* 图表类目色：照抄 ContextBreakdown（官方类目色，浅色一套、深色单独选过一套，不是自动翻转） */
  .ch { --cx-1: #2a78d6; --cx-2: #eb6834; --cx-3: #1baf7a; --cx-4: #eda100; --cx-5: #e87ba4; --cx-6: #008300; --cx-7: #4a3aa7; --cx-8: #e34948;
    --ch-grid: rgba(29, 27, 24, .075); --ch-zero: rgba(29, 27, 24, .3); --ch-cross: rgba(29, 27, 24, .3); --ch-tip: #fff;
    --ch-tip-shadow: 0 8px 24px -8px rgba(40, 30, 10, .25), 0 0 0 .5px rgba(29, 27, 24, .14);
    position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 12px var(--av-px) 10px; overflow: visible; }
  :global(.av-dark) .ch { --cx-1: #3987e5; --cx-2: #d95926; --cx-3: #199e70; --cx-4: #c98500; --cx-5: #d55181; --cx-7: #9085e9; --cx-8: #e66767;
    --ch-grid: rgba(241, 236, 226, .07); --ch-zero: rgba(241, 236, 226, .3); --ch-cross: rgba(241, 236, 226, .32); --ch-tip: #2a2825;
    --ch-tip-shadow: 0 8px 24px -8px rgba(0, 0, 0, .6), 0 0 0 .5px rgba(241, 236, 226, .14); }

  .ch-head { display: flex; align-items: center; gap: 6px 16px; flex-wrap: wrap; min-height: 20px; }
  .ch-head.wrap { flex-direction: column; align-items: flex-start; }
  .ch-ylab { font-size: var(--av-fs-sm); line-height: var(--av-lh-sm); color: var(--av-ink2); }
  .ch-legend { display: flex; flex-wrap: wrap; gap: 2px 4px; margin-left: auto; }
  .ch-head.wrap .ch-legend { margin-left: 0; }
  .ch-key { appearance: none; border: 0; background: transparent; font: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 8px; border-radius: 7px; font-size: 12px; color: var(--av-ink); transition: background var(--av-t) ease, opacity var(--av-t) ease; max-width: 100%; }
  .ch-key:hover { background: var(--av-hover); }
  .ch-key:focus-visible { outline: none; box-shadow: var(--av-focus); }
  .ch-key i { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .ch-key span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ch-key.off { opacity: .45; }
  .ch-key.off i { background: transparent !important; box-shadow: inset 0 0 0 1.5px var(--av-ink3); }

  .ch-plot { position: relative; width: 100%; min-width: 0; }
  svg { display: block; overflow: visible; touch-action: pan-y; outline: none; -webkit-tap-highlight-color: transparent; }
  svg:focus-visible { outline: none; box-shadow: var(--av-focus); border-radius: 6px; }
  .grid { stroke: var(--ch-grid); stroke-width: 1; shape-rendering: crispEdges; }
  .grid.zero { stroke: var(--ch-zero); }
  .tick { font-size: 11px; fill: var(--av-ink2); font-variant-numeric: tabular-nums; }
  .tick.y { text-anchor: end; }
  .tick.x { text-anchor: middle; }
  .cross { stroke: var(--ch-cross); stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
  .band { fill: var(--av-fill2); pointer-events: none; }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; pointer-events: none; }
  .dot { stroke: var(--av-card); stroke-width: 2; pointer-events: none; }
  .bar { pointer-events: none; }

  .ch-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: var(--av-fs-sub); color: var(--av-ink2); pointer-events: none; }

  .ch-tip { position: absolute; z-index: 2; pointer-events: none; min-width: 110px; max-width: min(260px, 80%); padding: 8px 10px; border-radius: 10px;
    background: var(--ch-tip); box-shadow: var(--ch-tip-shadow); font-size: 12px; color: var(--av-ink); display: flex; flex-direction: column; gap: 4px; }
  .ch-tip-h { color: var(--av-ink2); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ch-tip-r { display: flex; align-items: center; gap: 6px; }
  .ch-tip-r i { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  .ch-tip-r .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ch-tip-r b { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }

  .ch-xlab { font-size: var(--av-fs-sm); color: var(--av-ink2); text-align: right; margin-top: -2px; }

  /* 读屏用的数据表：看不见但读得到 */
  .ch-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
