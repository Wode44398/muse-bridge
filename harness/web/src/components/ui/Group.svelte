<script lang="ts">
  // 分组列表块（设置、记忆、检查点这类面板里用）：小标题 + 一块圆角面（行之间细线分隔）+ 脚注。
  // heading = 富文本标题（要在标题里放等宽片段、标签时用，优先于 title）；plain = 不画分组面（放分段控件、输入框这类）。
  import type { Snippet } from "svelte";

  let {
    title,
    heading,
    footnote,
    aside,
    plain = false,
    children,
  }: { title?: string; heading?: Snippet; footnote?: string; aside?: Snippet; plain?: boolean; children: Snippet } = $props();
</script>

<section class="grp" class:plain>
  {#if title || heading || aside}
    <header>
      {#if heading}<h3>{@render heading()}</h3>{:else if title}<h3>{title}</h3>{/if}
      {#if aside}<div class="aside">{@render aside()}</div>{/if}
    </header>
  {/if}
  <div class="body">{@render children()}</div>
  {#if footnote}<p class="foot">{footnote}</p>{/if}
</section>

<style>
  .grp {
    margin: 0 0 22px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 24px;
    margin: 0 4px 8px;
  }
  h3 {
    margin: 0;
    font-size: var(--fs-md);
    font-weight: 500;
    color: var(--text2);
  }
  .aside {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .body {
    border-radius: 14px;
    background: var(--surface2);
    overflow: hidden;
  }
  .plain .body {
    background: none;
    border-radius: 0;
    overflow: visible;
  }
  .body > :global(* + *) {
    box-shadow: 0 -1px 0 var(--border);
  }
  .plain .body > :global(* + *) {
    box-shadow: none;
  }
  .foot {
    margin: 8px 4px 0;
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--text3);
  }
</style>
