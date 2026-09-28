<script>
  // claude.ai 同款分段控件（官方实测：槽 32px、圆角 8、内边距 1px、底色 rgba(11,11,11,.05)；
  // 滑块圆角 7、1px 内描边 + 0 1px 2px 细投影；选中项文字深、其余弱）。
  // options: [{ value, label?, icon?（Anthropicons 字符）, svg?（内联 SVG）, title? }]
  import { untrack } from 'svelte';

  let { options = [], value, onchange, label = '' } = $props();

  let els = $state([]);
  // 滑块几何只写不读：effect 里若再读它就成了自己的依赖，写一次触发一次，直到 Svelte 报
  // effect_update_depth_exceeded、整棵组件树停止响应（2026-09-18 实测踩到）。
  let x = $state(0), w = $state(0), shown = $state(false), anim = $state(false);
  $effect(() => {
    const i = options.findIndex((o) => o.value === value);
    const el = els[i];
    if (!el) return;
    const measure = () => {
      x = el.offsetLeft;
      w = el.offsetWidth;
      // 首次落位不要从 0 滑过来：先无过渡落位，下一帧再打开过渡
      if (!untrack(() => shown)) { shown = true; requestAnimationFrame(() => { anim = true; }); }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<div class="seg" role="radiogroup" aria-label={label || undefined}>
  <span class="thumb" class:shown class:anim style:transform="translateX({x - 1}px)" style:width="{w}px" aria-hidden="true"></span>
  {#each options as o, i (o.value)}
    <button type="button" role="radio" aria-checked={o.value === value} class="opt" class:on={o.value === value} class:ic={!o.label}
      title={o.title || o.label || ''} aria-label={o.title || o.label || ''} bind:this={els[i]}
      onclick={() => { if (o.value !== value) onchange?.(o.value); }}>
      {#if o.svg}{@html o.svg}{:else if o.icon}<span class="gl">{o.icon}</span>{/if}
      {#if o.label}<span>{o.label}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .seg { position: relative; flex: none; display: inline-flex; height: 32px; padding: 1px; border-radius: 8px; background: var(--st-seg); }
  .thumb { position: absolute; top: 1px; left: 1px; height: 30px; border-radius: 7px; opacity: 0;
    background: var(--st-thumb); box-shadow: inset 0 0 0 1px var(--st-line), 0 1px 2px rgba(0, 0, 0, .05); }
  .thumb.shown { opacity: 1; }
  .thumb.anim { transition: transform .2s var(--ea-std), width .2s var(--ea-std); }
  .opt { position: relative; z-index: 1; height: 30px; padding: 0 12px; border: 0; border-radius: 6px; background: none; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap;
    font: inherit; font-size: 14px; color: var(--st-muted); transition: color .15s ease; }
  .opt.on { color: var(--text); }
  .opt.ic { width: 30px; padding: 0; }
  .opt:focus-visible { outline: 2px solid var(--st-accent); outline-offset: -2px; }
  @media (hover: hover) { .opt:not(.on):hover { color: var(--st-text2); } }
  .gl { font-family: var(--icons); font-size: 18px; font-weight: 433; line-height: 1; }
  .opt :global(svg) { width: 18px; height: 18px; display: block; }
</style>
