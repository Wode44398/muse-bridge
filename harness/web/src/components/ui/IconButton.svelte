<script lang="ts">
  // 图标按钮。label 必填（读屏 + 悬停提示）。变体：ghost 透明（工具栏默认）· soft 色阶底 · solid 墨底。
  // active = 开着的开关态（工作区开着、面板开着）。badge = 右上角的小点（true）或数字。
  import type { IconName } from "../../lib/icons.ts";
  import { press } from "../../lib/motion.ts";
  import Icon from "./Icon.svelte";
  import Mark from "../brand/Mark.svelte";

  let {
    icon,
    label,
    title,
    size = 32,
    iconSize,
    variant = "ghost",
    active = false,
    badge = false,
    disabled = false,
    loading = false,
    expanded,
    onclick,
    el = $bindable(),
  }: {
    icon: IconName;
    label: string;
    title?: string;
    size?: number;
    iconSize?: number;
    variant?: "ghost" | "soft" | "solid";
    active?: boolean;
    badge?: boolean | number;
    disabled?: boolean;
    loading?: boolean;
    expanded?: boolean;
    onclick?: (e: MouseEvent) => void;
    el?: HTMLButtonElement;
  } = $props();

  const px = $derived(iconSize ?? Math.round(size * 0.56));
</script>

<button
  bind:this={el}
  class="ib {variant}"
  class:active
  style="--s:{size}px"
  aria-label={label}
  title={title ?? label}
  aria-expanded={expanded}
  aria-pressed={active || undefined}
  aria-busy={loading || undefined}
  disabled={disabled || loading}
  use:press={{ scale: 0.92 }}
  {onclick}
>
  {#if loading}<Mark size={px + 1} live />{:else}<Icon name={icon} size={px} />{/if}
  {#if badge}
    <span class="badge" class:num={typeof badge === "number"}>{typeof badge === "number" ? badge : ""}</span>
  {/if}
</button>

<style>
  .ib {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--s);
    height: var(--s);
    border-radius: calc(var(--s) * 0.3);
    color: var(--text2);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .soft {
    background: var(--surface2);
    color: var(--text);
  }
  .solid {
    background: var(--primary);
    color: var(--on-primary);
  }
  .active {
    background: var(--surface2);
    color: var(--text);
  }
  @media (hover: hover) {
    .ghost:hover:not(:disabled) {
      background: var(--surface2);
      color: var(--text);
    }
    .soft:hover:not(:disabled),
    .active:hover:not(:disabled) {
      background: var(--surface3);
    }
    .solid:hover:not(:disabled) {
      background: color-mix(in srgb, var(--primary) 86%, var(--bg));
    }
  }
  .ib:disabled {
    opacity: 0.38;
  }
  /* 触屏：点按区域透明地扩到至少 40×40 */
  @media (pointer: coarse) {
    .ib::after {
      content: "";
      position: absolute;
      inset: calc(min(0px, (var(--s) - 40px) / 2));
    }
  }
  .badge {
    position: absolute;
    top: calc(var(--s) * 0.16);
    right: calc(var(--s) * 0.16);
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--live);
    box-shadow: 0 0 0 2px var(--bg);
  }
  .badge.num {
    width: auto;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    top: 1px;
    right: 1px;
    font-size: 10px;
    font-weight: 600;
    line-height: 15px;
    color: var(--on-live);
    font-variant-numeric: tabular-nums;
  }
</style>
