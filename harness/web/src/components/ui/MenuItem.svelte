<script lang="ts">
  // 菜单项：图标 + 文字（可带第二行说明）+ 右侧提示（快捷键 / 数字）或勾。
  // checked 不为 undefined 时是单选语义（menuitemradio），勾在右边、青色；toggle = 开关语义（menuitemcheckbox）。
  import type { Snippet } from "svelte";
  import type { IconName } from "../../lib/icons.ts";
  import Icon from "./Icon.svelte";

  let {
    icon,
    label,
    description,
    hint,
    checked,
    toggle = false,
    danger = false,
    disabled = false,
    title,
    onclick,
    leading,
  }: {
    icon?: IconName;
    label: string;
    description?: string;
    hint?: string;
    checked?: boolean;
    toggle?: boolean;
    danger?: boolean;
    disabled?: boolean;
    title?: string;
    onclick?: (e: MouseEvent) => void;
    leading?: Snippet;
  } = $props();
</script>

<button
  class="mi"
  class:danger
  class:two={Boolean(description)}
  role={checked === undefined ? "menuitem" : toggle ? "menuitemcheckbox" : "menuitemradio"}
  aria-checked={checked === undefined ? undefined : checked}
  {disabled}
  {title}
  {onclick}
>
  {#if leading}
    <span class="lead">{@render leading()}</span>
  {:else if icon}
    <span class="lead"><Icon name={icon} size={17} /></span>
  {/if}
  <span class="body">
    <span class="label">{label}</span>
    {#if description}<span class="desc">{description}</span>{/if}
  </span>
  {#if hint}<span class="hint">{hint}</span>{/if}
  {#if checked !== undefined}
    <span class="check" class:on={checked}><Icon name="check" size={15} stroke={2} /></span>
  {/if}
</button>

<style>
  .mi {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 36px;
    padding: 6px 10px;
    border-radius: 9px;
    text-align: left;
    color: var(--text);
    font-size: var(--fs-base);
    line-height: 1.35;
    transition: background-color var(--t-fast) var(--ease);
  }
  .mi.two {
    align-items: flex-start;
    padding-top: 8px;
    padding-bottom: 8px;
  }
  .mi.two .lead {
    margin-top: 1px;
  }
  @media (pointer: coarse) {
    .mi {
      min-height: 44px;
    }
  }
  @media (hover: hover) {
    .mi:hover:not(:disabled) {
      background: var(--surface2);
    }
  }
  .mi:focus-visible {
    outline: none;
    background: var(--surface2);
  }
  .mi:active:not(:disabled) {
    background: var(--surface3);
  }
  .mi:disabled {
    opacity: 0.42;
  }
  .lead {
    display: inline-flex;
    flex: none;
    color: var(--text2);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .desc {
    font-size: var(--fs-sm);
    color: var(--text3);
    line-height: 1.4;
    white-space: normal;
  }
  .hint {
    flex: none;
    margin-left: 8px;
    font-size: var(--fs-sm);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  .check {
    flex: none;
    display: inline-flex;
    color: var(--accent);
    opacity: 0;
    transform: scale(0.6);
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-spring-pop, 400ms) var(--spring-pop, var(--ease));
  }
  .check.on {
    opacity: 1;
    transform: none;
  }
  .danger,
  .danger .lead {
    color: var(--err);
  }
</style>
