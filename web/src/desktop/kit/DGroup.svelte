<script>
  // 设置分组卡：组标签 + 圆角卡（行容器）+ 组脚注。行间发丝分隔线在此统一画
  // （:global 选 DRow 的 .drow 兄弟），行组件自身不用关心自己是不是第一行。
  import '../tokens.css';
  let { label = '', foot = '', children } = $props();
</script>

<section class="grp">
  {#if label}<h3 class="glabel">{label}</h3>{/if}
  <div class="gcard">{@render children?.()}</div>
  {#if foot}<p class="gfoot">{foot}</p>{/if}
</section>

<style>
  .grp { display: block; }
  /* macOS System Settings 语气：组标签小号常规大小写（旧 uppercase 追踪距是 iOS 语汇） */
  .glabel {
    margin: 0 var(--dsk-s3) var(--dsk-s2);
    font-size: var(--dsk-fs-sm); font-weight: 600;
    color: var(--dsk-ink-2);
  }
  .gcard {
    border-radius: var(--dsk-r-lg); background: var(--dsk-panel);
    box-shadow: 0 0 0 1px var(--dsk-line); overflow: hidden;
  }
  /* 行间分隔线从文字列起（左端内缩），不再整宽贯穿——macOS 分组卡的画法 */
  .gcard :global(.drow + .drow) { position: relative; }
  .gcard :global(.drow + .drow)::before {
    content: ''; position: absolute; top: 0; left: var(--dsk-s3); right: 0; height: 1px;
    background: var(--dsk-line);
  }
  .gfoot {
    margin: var(--dsk-s2) var(--dsk-s3) 0;
    font-size: var(--dsk-fs-sm); line-height: 1.5; color: var(--dsk-ink-3);
  }
</style>
