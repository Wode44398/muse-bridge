<script>
  // 设置行（claude.ai 同款：左边标题 + 说明，右边控件；行高随内容，上下 12px，行与行之间一道发丝线）。
  //   trailing：右侧控件片段（开关 / 分段 / 按钮 / 值）
  //   onclick：整行可点（此时右侧默认给一个 ›，trailing 里就别再放可点的东西）
  //   sid：设置搜索跳转用的行 id，命中后闪一下
  //   stack：控件放到文字下面（手机上放不下一排时用）
  let {
    label = '', desc = '', sid = '', icon = '', danger = false,
    onclick = null, chevron = undefined, stack = false, trailing, children,
  } = $props();
  const showChev = $derived(chevron ?? (!!onclick && !trailing));
</script>

{#snippet body()}
  {#if icon}<span class="sr-ic" aria-hidden="true">{icon}</span>{/if}
  <span class="sr-tx">
    {#if label}<span class="sr-l">{label}</span>{/if}
    {#if desc}<span class="sr-d">{desc}</span>{/if}
    {@render children?.()}
  </span>
  {#if trailing}<span class="sr-tr">{@render trailing()}</span>{/if}
  {#if showChev}<span class="sr-chev" aria-hidden="true">&#xe02a;</span>{/if}
{/snippet}

{#if onclick}
  <button type="button" class="st-row sr click" class:danger class:stack data-sid={sid || undefined} {onclick}>{@render body()}</button>
{:else}
  <div class="st-row sr" class:danger class:stack data-sid={sid || undefined}>{@render body()}</div>
{/if}

<style>
  .sr { position: relative; width: 100%; display: flex; align-items: center; gap: 28px; padding: 12px 0; min-height: 56px;
    text-align: left; color: var(--text); font: inherit; background: none; border: 0; border-radius: 0; }
  /* 行与行之间的发丝线：相邻的两行是两个组件实例，作用域选择器 .sr + .sr 会被编译器当成用不上
     而剪掉（单个实例里只有一行），所以挂在全局唯一的 st-row 上。 */
  :global(.st-row + .st-row) { border-top: 1px solid var(--st-hair); }
  .sr.click { cursor: pointer; }
  .sr.stack { flex-direction: column; align-items: stretch; gap: 10px; }
  .sr.stack .sr-tr { justify-content: flex-start; flex-wrap: wrap; }
  .sr-ic { width: 20px; flex: none; font-family: var(--icons); font-size: 20px; font-weight: 433; line-height: 1; color: var(--st-text2); }
  .sr-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .sr-l { font-size: 14px; line-height: 20px; color: var(--text); }
  .sr-d { font-size: 14px; line-height: 20px; color: var(--st-muted); }
  .sr.danger .sr-l { color: var(--crit); }
  .sr-tr { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
  .sr-chev { flex: none; margin-left: -14px; font-family: var(--icons); font-size: 16px; line-height: 1; color: var(--st-muted); transition: color .12s ease, transform .12s ease; }
  @media (hover: hover) {
    .sr.click:hover .sr-chev { color: var(--text); transform: translateX(2px); }
  }
  /* 设置搜索命中：整行底色闪一下（Settings 容器负责加 / 摘 st-flash） */
  :global(.st-row.st-flash) { animation: st-row-flash 1.4s var(--ea-fade) 1; }
  @keyframes -global-st-row-flash { 0%, 55% { background: color-mix(in srgb, var(--st-accent) 14%, transparent); } 100% { background: transparent; } }

  :global(.stg.compact) .sr { gap: 12px; min-height: 52px; }
  :global(.stg.compact) .sr-l { font-size: 15px; }
  :global(.stg.compact) .sr-d { font-size: 13px; line-height: 18px; }
  :global(.stg.compact) .sr.click:active { background: var(--st-hover); }
</style>
