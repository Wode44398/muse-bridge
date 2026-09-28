<script lang="ts">
  // 胶囊按钮：输入框底行的型号 / 档位 / 附件，状态条上的小动作。
  // tone：plain 透明（悬停才浮底）· soft 色阶底 · accent 青（非默认状态要常驻可见，如「只读」「计划」档）
  import type { Snippet } from "svelte";
  import type { IconName } from "../../lib/icons.ts";
  import { press } from "../../lib/motion.ts";
  import Icon from "./Icon.svelte";

  let {
    icon,
    label,
    title,
    tone = "plain",
    chevron = false,
    open = false,
    pressed,
    disabled = false,
    mono = false,
    onclick,
    leading,
    children,
    el = $bindable(),
  }: {
    icon?: IconName;
    label?: string;
    title?: string;
    tone?: "plain" | "soft" | "accent" | "warn";
    chevron?: boolean;
    open?: boolean;
    pressed?: boolean;
    disabled?: boolean;
    mono?: boolean;
    onclick?: (e: MouseEvent) => void;
    leading?: Snippet;
    children?: Snippet;
    el?: HTMLButtonElement;
  } = $props();
</script>

<button
  bind:this={el}
  class="chip {tone}"
  class:open
  class:mono
  {title}
  aria-label={label}
  aria-expanded={chevron ? open : undefined}
  aria-pressed={pressed}
  {disabled}
  use:press={{ scale: 0.95 }}
  {onclick}
>
  {#if leading}{@render leading()}{:else if icon}<Icon name={icon} size={15} />{/if}
  {#if children}<span class="txt">{@render children()}</span>{/if}
  {#if chevron}<span class="chev"><Icon name="chevronD" size={13} stroke={1.8} /></span>{/if}
</button>

<style>
  .chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    max-width: 100%;
    padding: 0 10px;
    border-radius: var(--r-pill);
    font-size: var(--fs-md);
    font-weight: 500;
    color: var(--text2);
    white-space: nowrap;
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .soft {
    background: var(--surface2);
    color: var(--text);
  }
  .accent {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .warn {
    background: color-mix(in srgb, var(--warn) 13%, transparent);
    color: var(--warn);
  }
  .open {
    background: var(--surface2);
    color: var(--text);
  }
  .accent.open {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
  }
  .chip[aria-pressed="true"]:not(.accent):not(.warn) {
    background: var(--surface2);
    color: var(--text);
  }
  @media (hover: hover) {
    .plain:hover:not(:disabled) {
      background: var(--surface2);
      color: var(--text);
    }
    .soft:hover:not(:disabled) {
      background: var(--surface3);
    }
    .accent:hover:not(:disabled) {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
    }
  }
  .chip:disabled {
    opacity: 0.4;
  }
  /* 触屏：点按区域透明地扩到 40px 高 */
  @media (pointer: coarse) {
    .chip::after {
      content: "";
      position: absolute;
      inset: -5px 0;
    }
  }
  .txt {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mono .txt {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-weight: 450;
  }
  .chev {
    display: inline-flex;
    margin: 0 -3px 0 -2px;
    opacity: 0.6;
    transition: transform var(--t-med) var(--ease-out);
  }
  .open .chev {
    transform: rotate(180deg);
  }
</style>
