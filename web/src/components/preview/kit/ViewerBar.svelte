<script>
  // 查看器顶栏（外框专用，属于「纸」：两端都扁平）。
  //   左：关闭——电脑 ✕（Esc），触屏 ‹（系统返回同义）
  //   中：标题 15/600 单行省略 + 副标题 12px（计数 / 页码 / 保存状态）
  //   右：自定义区（barEnd）+ 主工具（≤3）+ ⋮ 溢出菜单
  // 高度：电脑 44、触屏 52，再加顶部安全区；宿主可用 --pv-bar-h / --pv-pad-y 压矮（手机工作台 sheet）。
  // 皮肤：媒体 = 压在画面上的黑渐变 + 白字（恒暗）；文档 = 实底随主题（--md-*）。WCO 桌面壳下右侧让 --wco-right。
  import VIcon from './VIcon.svelte';
  import { tip } from './tooltip.js';
  import { dragOut, previewDragSrc } from '../../../lib/dragOut.js';
  import { t } from '../../../lib/i18n.js';

  let {
    item = null, title = '', subtitle = '', subtitleSnippet = null, barEnd = null,
    tools = [], touch = false, overlay = false, hidden = false,
    nav = null,               // 画廊翻页（文档皮肤；触屏视频——横滑让给拖进度）：{ canPrev, canNext, onPrev, onNext, kbd?: [上一个, 下一个] }
    hasMenu = true, menuOpen = false, onMore = null, moreEl = $bindable(null),
    onClose = null, closeEl = $bindable(null),
    stacked = false,          // 层叠打开（笔记里点的附件）：关闭钮的语义是「返回上一层」，桌面也画返回箭头
    onhold = null,            // (on: boolean) 指针悬停在栏上：外框据此保持 chrome 显示
  } = $props();

  const visTools = $derived((tools || []).filter((x) => x && !x.hidden).slice(0, 3));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<header class="vw-bar" class:vw-bar-overlay={overlay} class:vw-hide={hidden}
  onpointerenter={(e) => e.pointerType === 'mouse' && onhold?.(true)} onpointerleave={(e) => e.pointerType === 'mouse' && onhold?.(false)}>
  <button type="button" class="vw-btn vw-close" bind:this={closeEl} onclick={() => onClose?.()}
    use:tip={touch ? t('返回') : { label: stacked ? t('返回') : t('关闭'), kbd: 'Esc' }}>
    <VIcon name={touch || stacked ? 'back' : 'close'} />
  </button>
  <div class="vw-titles">
    <span class="vw-title" use:dragOut={() => (item ? previewDragSrc(item) : null)}>{title}</span>
    {#if subtitleSnippet}
      <div class="vw-sub">{@render subtitleSnippet()}</div>
    {:else if subtitle}
      <span class="vw-sub">{subtitle}</span>
    {/if}
  </div>
  {#if barEnd}<div class="vw-bar-end">{@render barEnd()}</div>{/if}
  {#if nav}
    <div class="vw-bar-nav">
      <button type="button" class="vw-btn" disabled={!nav.canPrev} onclick={nav.onPrev} use:tip={{ label: t('上一个'), kbd: nav.kbd?.[0] || '←' }}><VIcon name="prev" /></button>
      <button type="button" class="vw-btn" disabled={!nav.canNext} onclick={nav.onNext} use:tip={{ label: t('下一个'), kbd: nav.kbd?.[1] || '→' }}><VIcon name="next" /></button>
    </div>
  {/if}
  {#each visTools as tl (tl.id || tl.icon)}
    {#if tl.href}
      <a class="vw-btn" class:on={tl.active} href={tl.href} download={tl.download || null} target={tl.download ? null : '_blank'} rel="noopener noreferrer"
        aria-disabled={tl.disabled || null} onclick={(e) => tl.onClick?.(e)} use:tip={{ label: tl.label, kbd: tl.kbd || '' }}><VIcon name={tl.icon} /></a>
    {:else}
      <button type="button" class="vw-btn" class:on={tl.active} disabled={tl.disabled} aria-pressed={tl.active == null ? null : !!tl.active}
        onclick={(e) => tl.onClick?.(e)} use:tip={{ label: tl.label, kbd: tl.kbd || '' }}><VIcon name={tl.icon} /></button>
    {/if}
  {/each}
  {#if hasMenu}
    <button type="button" class="vw-btn" class:open={menuOpen} bind:this={moreEl} aria-haspopup="menu" aria-expanded={menuOpen}
      onclick={() => onMore?.()} use:tip={t('更多')}><VIcon name="more" /></button>
  {/if}
</header>
