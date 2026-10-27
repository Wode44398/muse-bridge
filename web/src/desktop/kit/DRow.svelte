<script>
  // 设置行：可选彩色图标方块（chip 色 + icon snippet 白 glyph）、标题/副标题、
  // 右侧控件槽（trailing snippet）、可点行（onclick → hover 态 + chevron）。
  // 高度/间距/hover 全部令牌化；分隔线由外层 DGroup 统一画。
  import '../tokens.css';
  let {
    title = '',
    sub = '',
    chip = '',            // 图标方块底色（空=无图标列）
    danger = false,
    highlight = false,    // 搜索定位闪烁（设置搜索跳转后短暂高亮本行）
    chevron = true,       // 可点行右侧箭头；纯动作行（退出登录/急停…）传 false——箭头只留给跳转
    subSelectable = false, // 副标题是要复制的值（地址/路径/版本）：放开文本选择（仅非可点行）
    onclick,
    icon,                 // snippet：22×22 内的白色 glyph
    trailing,             // snippet：右侧控件（开关/下拉/值文本…）
  } = $props();
</script>

{#if onclick}
  <button class="drow act" class:danger class:hl={highlight} {onclick}>
    {#if chip}<span class="chip" style:background-color={chip}>{@render icon?.()}</span>{/if}
    <span class="txt"><span class="t">{title}</span>{#if sub}<span class="s">{sub}</span>{/if}</span>
    {#if trailing}<span class="tr">{@render trailing()}</span>{/if}
    {#if chevron}
      <svg class="chev" viewBox="0 0 6 10" width="6" height="10" aria-hidden="true">
        <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    {/if}
  </button>
{:else}
  <div class="drow" class:danger class:hl={highlight}>
    {#if chip}<span class="chip" style:background-color={chip}>{@render icon?.()}</span>{/if}
    <span class="txt"><span class="t">{title}</span>{#if sub}<span class="s" class:sel-text={subSelectable}>{sub}</span>{/if}</span>
    {#if trailing}<span class="tr">{@render trailing()}</span>{/if}
  </div>
{/if}

<style>
  .drow {
    display: flex; align-items: center; gap: var(--dsk-s3); width: 100%;
    min-height: var(--dsk-row-h); padding: var(--dsk-s2) var(--dsk-s3);
    font-family: var(--dsk-font); text-align: left; color: var(--dsk-ink);
  }
  .drow.act { cursor: pointer; transition: background var(--dsk-t-fast) var(--dsk-ease); }
  .drow.act:hover { background: var(--dsk-hover); }
  .drow.act:active { background: var(--dsk-active); }
  .drow.act:focus-visible { outline: none; box-shadow: inset var(--dsk-focus); }
  /* macOS 式渐变图标方块：底色走 style:background-color（shorthand 会把渐变层冲掉，
     必须用 longhand），上亮下暗的渐变 + 顶部高光发丝 + 微投影由这里统一叠加。 */
  .chip {
    width: 24px; height: 24px; border-radius: 6.5px; flex: none;
    display: inline-flex; align-items: center; justify-content: center;
    color: #fff;
    background-image: linear-gradient(180deg, rgba(255, 255, 255, .30) 0%, rgba(255, 255, 255, .05) 46%, rgba(0, 0, 0, .12) 100%);
    box-shadow: inset 0 .5px .5px rgba(255, 255, 255, .45), inset 0 0 0 .5px rgba(255, 255, 255, .12),
                0 .5px 1.5px rgba(0, 0, 0, .3);
  }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .t { font-size: var(--dsk-fs-ui); line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s { font-size: var(--dsk-fs-sm); line-height: 1.35; color: var(--dsk-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tr { flex: none; display: inline-flex; align-items: center; gap: var(--dsk-s2); color: var(--dsk-ink-2); font-size: var(--dsk-fs-ui); }
  .chev { flex: none; color: var(--dsk-ink-3); }
  .danger .t { color: var(--dsk-crit); }
  .hl { animation: drow-flash 1.5s var(--dsk-ease) 1; }
  @keyframes drow-flash {
    0%, 70% { background: var(--dsk-sel); }
    100% { background: transparent; }
  }
</style>
