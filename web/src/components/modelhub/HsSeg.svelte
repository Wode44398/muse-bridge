<script>
  // 分段控件：种类分栏（tabs）、接口类型、Key 轮换策略共用。
  // 选中滑块按实测的段位置（offsetLeft / offsetWidth）做 transform 动画——不过渡 width / left（会触发重排、发抖）；
  // 挂载那两帧先不开过渡，免得滑块从 0 飞进来。
  import { tick } from 'svelte';

  // options: [{ value, label?, disabled?, title? }]；item：自定义段内容的 snippet（种类分栏用：线稿 + 名字 + 数量）
  // tabs：role=tablist（种类分栏），否则 radiogroup；controls：tabs 时 aria-controls 指向的面板 id
  let { options = [], value, onchange, label = '', tabs = false, item = null, size = '', controls = '' } = $props();

  let root = $state();
  let box = $state({ x: 0, w: 0 });
  let ready = $state(false);

  const idx = $derived(options.findIndex((o) => o.value === value));
  // 没有选中项时（不该出现，兜底）Tab 落在第一个能点的段上
  const firstOn = $derived(options.findIndex((o) => !o.disabled));

  function measure() {
    if (!root) return;
    const el = root.querySelectorAll('[data-seg]')[idx];
    if (!el) return;
    box = { x: el.offsetLeft, w: el.offsetWidth };
  }
  $effect(() => {
    idx; options.length;
    measure();
  });
  $effect(() => {
    if (!root) return;
    // 段宽随文字、字体加载、窗口变化：盯住容器尺寸重新量
    const ro = new ResizeObserver(() => measure());
    ro.observe(root);
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => { ready = true; }); });
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  });

  // 方向键在能点的段之间循环（跳过置灰的），Home / End 到头尾；焦点跟着选中走（WAI-ARIA 的 tabs / radio 惯例）
  function step(from, dir) {
    const n = options.length;
    for (let k = 1; k <= n; k++) {
      const j = (((from + dir * k) % n) + n) % n;
      if (!options[j].disabled) return j;
    }
    return from;
  }
  async function key(e, i) {
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = step(i, 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = step(i, -1);
    else if (e.key === 'Home') j = options.findIndex((o) => !o.disabled);
    else if (e.key === 'End') j = options.findLastIndex((o) => !o.disabled);
    else return;
    e.preventDefault();
    if (j < 0 || j === i) return;
    onchange?.(options[j].value);
    await tick();
    root?.querySelectorAll('[data-seg]')[j]?.focus();
  }
</script>

<div class="seg" class:big={size === 'big'} role={tabs ? 'tablist' : 'radiogroup'} aria-label={label || undefined}
  style:--n={options.length} bind:this={root}>
  <span class="thumb" class:ready class:hide={idx < 0} style:--x="{box.x}px" style:--w="{box.w}px" aria-hidden="true"></span>
  {#each options as o, i (o.value)}
    {@const on = i === idx}
    <button type="button" data-seg class="sg" class:on role={tabs ? 'tab' : 'radio'}
      aria-selected={tabs ? on : undefined} aria-checked={tabs ? undefined : on}
      aria-controls={tabs && controls ? controls : undefined}
      tabindex={on || (idx < 0 && i === firstOn) ? 0 : -1}
      disabled={o.disabled} title={o.title || undefined}
      onclick={() => { if (!on) onchange?.(o.value); }}
      onkeydown={(e) => key(e, i)}>
      <span class="in">
        {#if item}{@render item(o, on)}{:else}<span class="lb">{o.label}</span>{/if}
      </span>
    </button>
  {/each}
</div>

<style>
  .seg { position: relative; display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); padding: 3px; height: 34px; box-sizing: border-box;
    border-radius: 10px; background: var(--st-seg); isolation: isolate; }
  .seg.big { height: 40px; border-radius: 11px; }
  :global(.hs.narrow) .seg { height: 44px; border-radius: 12px; }
  .thumb { position: absolute; top: 3px; bottom: 3px; left: 0; width: var(--w); transform: translateX(var(--x)); border-radius: 7px;
    background: var(--st-thumb); box-shadow: 0 1px 2px rgba(0, 0, 0, .08), 0 0 0 .5px var(--st-line); pointer-events: none; }
  .seg.big .thumb, :global(.hs.narrow) .thumb { border-radius: 9px; }
  /* 各段等宽（1fr），滑块只需平移；宽度只在容器尺寸变化时跟着变，不过渡 */
  .thumb.ready { transition: transform var(--mo-base) var(--ea-decel), opacity var(--mo-micro) var(--ea-fade); }
  .thumb.hide { opacity: 0; }
  .sg { position: relative; z-index: 1; min-width: 0; display: flex; align-items: center; justify-content: center; padding: 0 10px; border: 0; border-radius: 7px;
    background: transparent; color: var(--st-text2); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
    transition: color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade); }
  .sg.on { color: var(--text); }
  .sg:disabled { opacity: .4; cursor: default; }
  @media (hover: hover) { .sg:hover:not(:disabled):not(.on) { color: var(--text); } }
  .sg:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  :global(.hs.narrow) .sg { font-size: 14px; border-radius: 9px; }
  .in { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; transition: transform var(--mo-tap) var(--ea-std); }
  .sg:active:not(:disabled) .in { transform: scale(.96); }
  .lb { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (prefers-reduced-motion: reduce) {
    .thumb.ready { transition: opacity var(--mo-micro) var(--ea-fade); }
    .in { transition: none; }
    .sg:active:not(:disabled) .in { transform: none; }
  }
</style>
