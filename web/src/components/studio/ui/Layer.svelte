<script>
  // Studio 的浮层壳（v3）：手机 → dimensio 式底部 Sheet；桌面 / 平板 → 贴着锚点的 Popover，没有锚点（或 dialog）→ 居中 Sheet 对话框。
  // 调用方不管是哪种，只给标题、锚点、宽度和内容。挂进 layers.js 返回栈（Popover / Sheet 自己登记）。
  import { layout } from '../../../lib/layout.svelte.js';
  import Popover from './Popover.svelte';
  import Sheet from './Sheet.svelte';

  let {
    title = '', sub = '', anchor = null, width = 320, align = 'end', prefer = 'down', dialog = false, avoid = null,
    sheet = null,            // 强制（true / false）；默认手机走 sheet
    role = 'dialog', onclose, head: extra = null, children, trigger = null, tall = false,
  } = $props();

  const asSheet = $derived(sheet ?? layout.compact);
</script>

{#if asSheet || dialog || !anchor}
  <Sheet {title} {sub} wide={!asSheet} {width} {tall} {onclose} head={extra}>{@render children?.()}</Sheet>
{:else}
  <!-- 贴着锚点的面板最高 78% 视口（再高就盖掉顶栏，像换了一页） -->
  <Popover {anchor} {trigger} {onclose} {align} {prefer} {avoid} {role} label={title} {width} maxWidth={Math.max(width, 360)} maxHeight={Math.min(680, Math.round(innerHeight * 0.78))}>
    {#snippet head()}
      {#if title}<div class="pv-h"><b>{title}</b>{#if sub}<small>{sub}</small>{/if}</div>{/if}
      {#if extra}{@render extra()}{/if}
    {/snippet}
    {@render children?.()}
  </Popover>
{/if}
