<script>
  // iOS 27 浮层面板（kit「Liquid Glass - Regular - Medium」圆角 34，与 Menu / Alert 同一张烘焙玻璃）：
  // 放 Menu 装不下的自定义内容（例如工作空间的传输列表）。锚在某个按钮下方，从 origin 缩放出现；
  // 点面板外关掉（遮罩不压暗——它只是工具栏按钮的附属面板，不是模态）。
  import { ovUrl } from '../../lib/overlay.svelte.js';
  import { getContext } from 'svelte';
  import glassL_pub from '../../assets/ios27/alert-light.png';
  const glassL = $derived(ovUrl('ios27/alert-light.png', glassL_pub));
  import glassD_pub from '../../assets/ios27/alert-dark.png';
  const glassD = $derived(ovUrl('ios27/alert-dark.png', glassD_pub));

  let { x = null, y = 0, right = null, width = 320, origin = 'top right', label = '', onclose, children } = $props();
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);
</script>

<div class="po-root" role="presentation">
  <button class="po-dim" type="button" tabindex="-1" aria-label={label} onclick={() => onclose?.()}></button>
  <div class="po" class:dark role="dialog" aria-label={label}
    style:left={x == null ? null : `${x}px`} style:right={right == null ? null : `${right}px`} style:top="{y}px"
    style:width="{width}px" style:transform-origin={origin} style:--glass={`url("${dark ? glassD : glassL}")`}>
    {@render children?.()}
  </div>
</div>

<style>
  .po-root { position: fixed; inset: 0; z-index: 94; pointer-events: none; }
  .po-dim { position: absolute; inset: 0; border: 0; padding: 0; background: transparent; cursor: default; pointer-events: auto; }
  .po {
    position: absolute; max-width: calc(100% - 24px); border-radius: 34px; isolation: isolate; overflow: hidden; pointer-events: auto;
    color: var(--i-label, #000);
    -webkit-backdrop-filter: blur(6.53px); backdrop-filter: blur(6.53px);
    box-shadow: 0 8px 40.6px rgba(0, 0, 0, .25);
    animation: po-in 380ms cubic-bezier(.25, 1.2, .4, 1) both;
  }
  .po.dark { box-shadow: 0 8px 40.6px rgba(0, 0, 0, .45); }
  .po::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--glass) 228 fill / 76px / 16px stretch; }
  @keyframes po-in { from { opacity: 0; transform: scale(.4); } }
</style>
