<script>
  // 设置分区里的一节：标题 + 一组行 + 可选脚注。
  // 宽屏 = claude.ai 设置对话框的分节（15px/580 标题、行间发丝线、没有卡片底）；
  // 手机（.stg.compact）= Claude app 的分组卡片（小号灰标题、圆角卡片底）。
  let { title = '', foot = '', children } = $props();
</script>

<section class="ss">
  {#if title}<h3 class="ss-h">{title}</h3>{/if}
  <div class="ss-grp">{@render children?.()}</div>
  {#if foot}<p class="ss-foot">{foot}</p>{/if}
</section>

<style>
  .ss { margin: 0 0 40px; }
  .ss-h { font-size: 15px; font-weight: 580; line-height: 20px; color: var(--text); margin: 0 0 16px; }
  .ss-foot { font-size: 13px; line-height: 18px; color: var(--st-muted); margin: 8px 0 0; }
  :global(.stg.compact) .ss { margin-bottom: 26px; }
  :global(.stg.compact) .ss-h { font-size: 13px; font-weight: 500; line-height: 18px; color: var(--st-muted); margin: 0 4px 8px; }
  :global(.stg.compact) .ss-grp { background: var(--st-surface); border-radius: 14px; padding: 0 16px; }
  :global(.stg.compact) .ss-foot { margin: 8px 4px 0; font-size: 12.5px; }
</style>
