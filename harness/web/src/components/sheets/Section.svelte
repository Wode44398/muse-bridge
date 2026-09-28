<script lang="ts">
  // 面板里「不是列表」的一段：小标题（右边可带一枚附注）+ 控件（分段、输入框、按钮）+ 脚注。
  // 标题 / 脚注的版式与 ui/Group 同一套，只是不画分组面——分段控件、输入框自己就是面，别再套一层。
  import type { Snippet } from "svelte";

  let { title, footnote, aside, children }: { title?: string; footnote?: string; aside?: Snippet; children: Snippet } = $props();
</script>

<section class="sec">
  {#if title || aside}
    <header>
      {#if title}<h3>{title}</h3>{/if}
      {#if aside}<div class="aside">{@render aside()}</div>{/if}
    </header>
  {/if}
  {@render children()}
  {#if footnote}<p class="foot">{footnote}</p>{/if}
</section>

<style>
  .sec {
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
  .foot {
    margin: 8px 4px 0;
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--text3);
  }
</style>
