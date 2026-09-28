<script lang="ts">
  // 菜单里的分组小标题（可带右侧说明）
  let { text, aside }: { text: string; aside?: string } = $props();
</script>

<div class="ml" role="presentation">
  <span>{text}</span>
  {#if aside}<span class="aside">{aside}</span>{/if}
</div>

<style>
  .ml {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 10px 4px;
    font-size: var(--fs-sm);
    color: var(--text3);
    user-select: none;
  }
  .aside {
    font-size: var(--fs-xs);
  }
</style>
