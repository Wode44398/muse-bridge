<script lang="ts">
  // 列表行（放在 Group 里）：图标 + 标题 / 副标题 + 右侧内容（开关、数值、按钮）。
  // 给了 onclick 就是整行可点的按钮（带右箭头 chevron）；否则是静态行。
  import type { Snippet } from "svelte";
  import type { IconName } from "../../lib/icons.ts";
  import Icon from "./Icon.svelte";

  let {
    icon,
    title,
    subtitle,
    chevron = false,
    danger = false,
    disabled = false,
    onclick,
    trailing,
    leading,
  }: {
    icon?: IconName;
    title: string;
    subtitle?: string;
    chevron?: boolean;
    danger?: boolean;
    disabled?: boolean;
    onclick?: (e: MouseEvent) => void;
    trailing?: Snippet;
    leading?: Snippet;
  } = $props();
</script>

{#snippet inner()}
  {#if leading}<span class="lead">{@render leading()}</span>{:else if icon}<span class="lead"><Icon name={icon} size={18} /></span>{/if}
  <span class="txt">
    <span class="t">{title}</span>
    {#if subtitle}<span class="s">{subtitle}</span>{/if}
  </span>
  {#if trailing}<span class="trail">{@render trailing()}</span>{/if}
  {#if chevron}<span class="chev"><Icon name="chevronR" size={16} /></span>{/if}
{/snippet}

{#if onclick}
  <button class="row click" class:danger {disabled} {onclick}>{@render inner()}</button>
{:else}
  <div class="row" class:danger>{@render inner()}</div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 10px 14px;
    text-align: left;
    color: var(--text);
    font-size: var(--fs-base);
  }
  .click {
    transition: background-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .click:hover:not(:disabled) {
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
  }
  .click:active:not(:disabled) {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .click:disabled {
    opacity: 0.45;
  }
  .lead {
    display: inline-flex;
    flex: none;
    color: var(--text2);
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .t {
    line-height: 1.35;
  }
  .s {
    font-size: var(--fs-sm);
    color: var(--text3);
    line-height: 1.45;
  }
  .trail {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--text2);
    font-size: var(--fs-md);
  }
  .chev {
    display: inline-flex;
    color: var(--text3);
    margin-right: -4px;
  }
  .danger,
  .danger .lead {
    color: var(--err);
  }
</style>
