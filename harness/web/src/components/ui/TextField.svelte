<script lang="ts">
  // 单行输入框。无描边的色阶槽，聚焦时亮一圈青色内描边。mono = 路径 / 命令 / 规则这类等宽内容。
  // tone="surface"：放在色阶分组面（Group）里时用 --surface 底，否则同色看不见。
  import type { Snippet } from "svelte";
  import type { HTMLInputAttributes } from "svelte/elements";
  import type { IconName } from "../../lib/icons.ts";
  import Icon from "./Icon.svelte";

  let {
    value = $bindable(""),
    placeholder = "",
    type = "text",
    icon,
    mono = false,
    size = "md",
    tone = "fill",
    maxlength,
    disabled = false,
    autofocus = false,
    label,
    name,
    autocomplete = "off",
    enterkeyhint,
    onkeydown,
    oninput,
    trailing,
    el = $bindable(),
  }: {
    value?: string;
    placeholder?: string;
    type?: "text" | "password" | "search" | "url" | "number";
    icon?: IconName;
    mono?: boolean;
    size?: "sm" | "md" | "lg";
    tone?: "fill" | "surface";
    maxlength?: number;
    disabled?: boolean;
    autofocus?: boolean;
    label?: string;
    name?: string;
    autocomplete?: HTMLInputAttributes["autocomplete"];
    enterkeyhint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send";
    onkeydown?: (e: KeyboardEvent) => void;
    oninput?: (e: Event) => void;
    trailing?: Snippet;
    el?: HTMLInputElement;
  } = $props();

  function focusOnMount(node: HTMLInputElement) {
    if (autofocus) requestAnimationFrame(() => node.focus());
  }
</script>

<label class="tf {size} {tone}" class:mono class:disabled>
  {#if icon}<span class="ic"><Icon name={icon} size={16} /></span>{/if}
  <input
    bind:this={el}
    bind:value
    {type}
    {placeholder}
    {disabled}
    {name}
    {maxlength}
    {autocomplete}
    {enterkeyhint}
    aria-label={label ?? placeholder}
    autocapitalize="off"
    spellcheck="false"
    use:focusOnMount
    {onkeydown}
    {oninput}
  />
  {#if trailing}<span class="trail">{@render trailing()}</span>{/if}
</label>

<style>
  .tf {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 12px;
    border-radius: 11px;
    background: var(--surface2);
    color: var(--text);
    box-shadow: inset 0 0 0 1px transparent;
    transition:
      box-shadow var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease);
    cursor: text;
  }
  .sm {
    height: 32px;
    padding: 0 10px;
    border-radius: 9px;
  }
  .lg {
    height: 44px;
    padding: 0 14px;
    border-radius: 13px;
  }
  .tf.surface {
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .tf:focus-within {
    background: var(--surface);
    box-shadow:
      inset 0 0 0 1px var(--accent),
      0 0 0 3px var(--accent-soft);
  }
  .disabled {
    opacity: 0.5;
  }
  .ic {
    display: inline-flex;
    color: var(--text3);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: var(--fs-base);
  }
  .mono input {
    font-family: var(--font-mono);
    font-size: var(--fs-md);
  }
  input::placeholder {
    color: var(--text3);
  }
  input:focus-visible {
    outline: none;
  }
  .trail {
    display: inline-flex;
    align-items: center;
    margin-right: -6px;
  }
</style>
