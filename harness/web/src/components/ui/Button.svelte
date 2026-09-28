<script lang="ts">
  // 按钮。变体：primary 墨（主操作，一屏最多一个）· secondary 色阶 · ghost 透明 · outline 细线
  //           · accent 青（开 / 批准类的肯定操作）· danger 柔红（危险但可找回）· danger-solid 实红（不可逆）
  // 尺寸：sm 28 · md 34 · lg 42（触屏上的主操作用 lg）。loading 时图标换成在权衡的标志，宽度不变。
  import type { Snippet } from "svelte";
  import type { IconName } from "../../lib/icons.ts";
  import { press } from "../../lib/motion.ts";
  import Icon from "./Icon.svelte";
  import Mark from "../brand/Mark.svelte";

  let {
    variant = "secondary",
    size = "md",
    icon,
    iconFill = false,
    iconRight,
    loading = false,
    disabled = false,
    full = false,
    type = "button",
    title,
    label,
    expanded,
    pressed,
    onclick,
    children,
  }: {
    variant?: "primary" | "secondary" | "ghost" | "outline" | "accent" | "danger" | "danger-solid";
    size?: "sm" | "md" | "lg";
    icon?: IconName;
    iconFill?: boolean;
    iconRight?: IconName;
    loading?: boolean;
    disabled?: boolean;
    full?: boolean;
    type?: "button" | "submit";
    title?: string;
    label?: string;
    expanded?: boolean;
    pressed?: boolean;
    onclick?: (e: MouseEvent) => void;
    children?: Snippet;
  } = $props();

  const iconPx = $derived(size === "sm" ? 15 : size === "lg" ? 18 : 16);
</script>

<button
  class="btn {variant} {size}"
  class:full
  class:loading
  {type}
  {title}
  aria-label={label}
  aria-expanded={expanded}
  aria-pressed={pressed}
  aria-busy={loading || undefined}
  disabled={disabled || loading}
  use:press={{ scale: 0.97 }}
  {onclick}
>
  {#if loading}
    <span class="lead"><Mark size={iconPx + 2} live /></span>
  {:else if icon}
    <span class="lead"><Icon name={icon} size={iconPx} fill={iconFill} /></span>
  {/if}
  {#if children}<span class="txt">{@render children()}</span>{/if}
  {#if iconRight}<span class="trail"><Icon name={iconRight} size={iconPx - 1} /></span>{/if}
</button>

<style>
  .btn {
    --h: 34px;
    --px: 14px;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    height: var(--h);
    padding: 0 var(--px);
    border-radius: var(--r-pill);
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    user-select: none;
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease),
      opacity var(--t-fast) var(--ease);
  }
  .sm {
    --h: 28px;
    --px: 11px;
    gap: 5px;
    font-size: var(--fs-md);
  }
  .lg {
    --h: 42px;
    --px: 20px;
    gap: 8px;
    font-size: var(--fs-body);
  }
  .full {
    display: flex;
    width: 100%;
  }
  .lead,
  .trail {
    display: inline-flex;
    margin-left: -2px;
  }
  .trail {
    margin: 0 -3px 0 0;
    opacity: 0.7;
  }
  .txt {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .primary {
    background: var(--primary);
    color: var(--on-primary);
  }
  .secondary {
    background: var(--surface2);
    color: var(--text);
  }
  .ghost {
    color: var(--text2);
  }
  .outline {
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--border2);
  }
  .accent {
    background: var(--accent);
    color: var(--on-accent);
  }
  .danger {
    background: color-mix(in srgb, var(--err) 11%, transparent);
    color: var(--err);
  }
  .danger-solid {
    background: var(--err);
    color: var(--on-accent);
  }
  @media (hover: hover) {
    .primary:hover:not(:disabled) {
      background: color-mix(in srgb, var(--primary) 86%, var(--bg));
    }
    .secondary:hover:not(:disabled) {
      background: var(--surface3);
    }
    .ghost:hover:not(:disabled) {
      background: var(--surface2);
      color: var(--text);
    }
    .outline:hover:not(:disabled) {
      background: var(--surface2);
    }
    .accent:hover:not(:disabled) {
      background: var(--accent-hover);
    }
    .danger:hover:not(:disabled) {
      background: color-mix(in srgb, var(--err) 17%, transparent);
    }
    .danger-solid:hover:not(:disabled) {
      background: color-mix(in srgb, var(--err) 88%, var(--text));
    }
  }
  .btn:disabled:not(.loading) {
    opacity: 0.42;
  }
  .btn:focus-visible {
    outline-offset: 2px;
  }
  /* 触屏：视觉尺寸不变，点按区域透明地扩到 40px 高（DESIGN「触控目标」） */
  @media (pointer: coarse) {
    .btn:not(.lg)::after {
      content: "";
      position: absolute;
      inset: calc(min(0px, (var(--h) - 40px) / 2)) 0;
    }
  }
</style>
