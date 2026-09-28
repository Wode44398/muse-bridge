<script lang="ts" generics="T extends string">
  // 分段控件：二三选一的视图切换（审阅「本会话 | 项目 git」、记忆「这个项目 | 全局」、外观三档、思考深度）。
  // 选中块是一块会滑动的底（快弹簧），不是逐个按钮变色。落位规则在 lib/slide.ts：第一次落位不滑（以前每次打开思考深度
  // 都从「不思考」滑到当前档位）、按下就先滑向按着的那项、点了先停在点的那项（值要等调用方——比如服务端——回来）。
  import { untrack } from "svelte";
  import type { IconName } from "../../lib/icons.ts";
  import { IND_HIDDEN, slideTarget, slideTo, type Ind } from "../../lib/slide.ts";
  import { pressHold } from "../../lib/press-hold.ts";
  import Icon from "./Icon.svelte";

  let {
    options,
    value,
    onchange,
    size = "md",
    full = false,
    label,
  }: {
    options: { value: T; label: string; icon?: IconName; disabled?: boolean }[];
    value: T;
    onchange: (v: T) => void;
    size?: "sm" | "md";
    full?: boolean;
    label?: string;
  } = $props();

  let track: HTMLDivElement | undefined = $state();
  let ind = $state<Ind>(IND_HIDDEN);
  let pressed = $state<T | null>(null);
  let picked = $state<T | null>(null);
  let pickTimer = 0;
  const target = $derived(slideTarget(pressed, picked, value));

  function measure() {
    const key = target;
    const btn = track?.querySelector<HTMLElement>(`[data-v="${CSS.escape(key)}"]`);
    const prev = untrack(() => ind);
    const next = slideTo(prev, btn ? { x: btn.offsetLeft, w: btn.offsetWidth } : null, key);
    if (next !== prev) ind = next;
  }

  $effect(() => {
    void target;
    void options.length;
    measure();
  });
  // 值回来了（或者被别处改了）：「刚点的」使命结束
  $effect(() => {
    void value;
    untrack(() => {
      picked = null;
      clearTimeout(pickTimer);
    });
  });
  // 按下就先滑过去（lib/press-hold.ts：松在哪都算、滚动取消立刻清、触屏不拿 pointerleave 清）
  const hold = pressHold<T>(
    (v) => (pressed = v),
    () => pressed,
  );
  function pick(v: T) {
    hold.settle();
    if (v === value) return;
    picked = v;
    clearTimeout(pickTimer);
    pickTimer = window.setTimeout(() => (picked = null), 1500); // 调用方没改值（失败了）：块回到真实值
    onchange(v);
  }
  $effect(() => {
    if (!track) return;
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    return () => ro.disconnect();
  });
</script>

<div class="seg {size}" class:full bind:this={track} role="radiogroup" aria-label={label}>
  <span class="ind" class:shown={ind.shown} class:animate={ind.animate} style="transform:translateX({ind.x}px);width:{ind.w}px"></span>
  {#each options as o (o.value)}
    <button
      role="radio"
      aria-checked={o.value === value}
      class:on={o.value === target}
      data-v={o.value}
      disabled={o.disabled}
      onpointerdown={() => !o.disabled && hold.down(o.value)}
      onpointerleave={hold.leave}
      onclick={() => pick(o.value)}
    >
      {#if o.icon}<Icon name={o.icon} size={size === "sm" ? 14 : 15} />{/if}
      <span>{o.label}</span>
    </button>
  {/each}
</div>

<style>
  .seg {
    position: relative;
    display: inline-flex;
    padding: 3px;
    border-radius: 11px;
    background: var(--surface2);
    isolation: isolate;
  }
  .full {
    display: flex;
    width: 100%;
  }
  .full button {
    flex: 1;
  }
  .ind {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 0;
    border-radius: 8px;
    background: var(--surface);
    box-shadow:
      0 0 0 1px var(--border),
      0 1px 3px color-mix(in srgb, var(--text) 8%, transparent);
    z-index: -1;
    opacity: 0;
    will-change: transform;
  }
  .ind.shown {
    opacity: 1;
  }
  /* 快弹簧（几乎不过冲）：标准弹簧的过冲会让滑块冲出轨道几个像素，边界处看着像错位；第一次落位不带过渡 */
  .ind.animate {
    transition:
      transform var(--t-spring-snap, 260ms) var(--spring-snap, var(--ease-out)),
      width var(--t-spring-snap, 260ms) var(--spring-snap, var(--ease-out));
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 30px;
    padding: 0 14px;
    border-radius: 8px;
    font-size: var(--fs-md);
    font-weight: 500;
    color: var(--text2);
    white-space: nowrap;
    transition: color var(--t-fast) var(--ease);
  }
  .sm button {
    height: 26px;
    padding: 0 11px;
    font-size: var(--fs-sm);
  }
  button.on {
    color: var(--text);
  }
  @media (hover: hover) {
    button:hover:not(.on):not(:disabled) {
      color: var(--text);
    }
  }
  button:disabled {
    opacity: 0.4;
  }
</style>
