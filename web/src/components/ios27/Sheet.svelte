<script>
  // iOS 27 表单页（kit「Sheet - iPhone」）：四周内缩 6、顶圆角 38、「Liquid Glass - Regular - Medium」材质；
  // 顶上 60×4 抓手，下面一条 Default 样式工具栏：左 ✕（玻璃圆钮）、中标题 17/22 Semibold、右 ✓（Glass Prominent 蓝钮）。
  // 玻璃层同 Alert：页面压暗底色（Overlays/Default 亮 20% / 暗 48%）两锚点解出的图层 + 9 宫；大投影交给 box-shadow。
  // （kit 底部圆角 58 跟 iPhone 屏幕圆角同心；安卓机屏幕圆角各不同，统一取 38——渲染器的玻璃只支持四角同径。）
  // 不传 onconfirm 就不出 ✓（纯选择型的表单页，点行即生效）；传 onback 时左钮换成 ‹ 返回上一层（多级选择）。
  import { ovUrl } from '../../lib/overlay.svelte.js';
  import { getContext } from 'svelte';
  import GlassButton from './GlassButton.svelte';
  import Sym from './Sym.svelte';
  import { swipeDismiss } from '../../lib/motion.js';
  import glassL_pub from '../../assets/ios27/sheet-light.png';
  const glassL = $derived(ovUrl('ios27/sheet-light.png', glassL_pub));
  import glassD_pub from '../../assets/ios27/sheet-dark.png';
  const glassD = $derived(ovUrl('ios27/sheet-dark.png', glassD_pub));
  import promL_pub from '../../assets/ios27/prom44-light.png';
  const promL = $derived(ovUrl('ios27/prom44-light.png', promL_pub));
  import promD_pub from '../../assets/ios27/prom44-dark.png';
  const promD = $derived(ovUrl('ios27/prom44-dark.png', promD_pub));

  let { title = '', onclose, onconfirm = null, onback = null, confirmDisabled = false, confirmLabel = '', closeLabel = '', backLabel = '', children } = $props();
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);
  const ink = $derived(!!ios?.ink);   // 墨色模式：确认钮画成实心墨圆，不用 kit 的蓝色 Prominent 玻璃

  let dy = $state(0), dragging = $state(false), leaving = $state(false);
  function close() { if (leaving) return; leaving = true; setTimeout(() => onclose?.(), 260); }
  const drag = (node) => swipeDismiss(node, {
    axis: 'y', dir: 1, threshold: 0.3,
    size: () => node.closest('.sh')?.offsetHeight || 400,
    guard: (e) => !e.target.closest('button, input, textarea'),
    base: () => dy, cur: () => dy,
    onStart: () => { dragging = true; },
    onMove: (y) => (dy = y),
    onSettle: (go) => { dragging = false; if (!go) dy = 0; },
    onDismiss: () => { leaving = true; onclose?.(); },
  });
</script>

<div class="sh-root" class:leaving role="presentation">
  <button class="sh-dim" class:dark type="button" tabindex="-1" aria-label={closeLabel || title} onclick={close}></button>
  <div class="sh" class:dark class:dragging role="dialog" aria-modal="true" aria-label={title}
    style:--glass={`url("${dark ? glassD : glassL}")`} style:transform={dy > 0 ? `translateY(${dy}px)` : null}>
    <div class="sh-top" use:drag>
      <span class="grab"></span>
      <div class="sh-bar">
        {#if onback}
          <GlassButton symbol="chevron.backward" weight={600} aria={backLabel} onclick={onback} />
        {:else}
          <GlassButton symbol="xmark" weight={500} aria={closeLabel} onclick={close} />
        {/if}
        <span class="sh-title">{title}</span>
        {#if onconfirm}
          <button type="button" class="prom" class:ink style:--img={`url("${dark ? promD : promL}")`} aria-label={confirmLabel}
            disabled={confirmDisabled} onclick={() => onconfirm?.()}><Sym name="checkmark" weight={500} size={17} /></button>
        {:else}
          <span class="sh-spacer" aria-hidden="true"></span>
        {/if}
      </div>
    </div>
    <div class="sh-body">{@render children?.()}</div>
  </div>
</div>

<style>
  .sh-root { position: fixed; inset: 0; z-index: 90; }
  .sh-dim { position: absolute; inset: 0; border: 0; padding: 0; cursor: default; background: rgba(0, 0, 0, .2); animation: sh-fade 260ms var(--ea-fade, ease) both; transition: opacity 240ms linear; }
  .sh-dim.dark { background: rgba(0, 0, 0, .48); }
  .sh {
    position: absolute; left: 6px; right: 6px; bottom: 6px; max-height: calc(100% - var(--sat, 0px) - 18px);
    display: flex; flex-direction: column; border-radius: 38px; isolation: isolate; color: var(--i-label);
    -webkit-backdrop-filter: blur(6.53px); backdrop-filter: blur(6.53px);
    box-shadow: 0 8px 40.6px rgba(0, 0, 0, .25);
    animation: sh-in 520ms cubic-bezier(.2, .95, .25, 1) both;
    transition: transform 380ms cubic-bezier(.2, .95, .25, 1);
  }
  .sh.dark { box-shadow: 0 8px 40.6px rgba(0, 0, 0, .45); }
  .sh.dragging { transition: none; }
  .sh::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--glass) 240 fill / 80px / 16px stretch; }
  .leaving .sh { transform: translateY(calc(100% + 24px)) !important; transition: transform 260ms cubic-bezier(.3, 0, .8, .15); }
  .leaving .sh-dim { opacity: 0; }
  @keyframes sh-fade { from { opacity: 0; } }
  @keyframes sh-in { from { transform: translateY(calc(100% + 24px)); } }
  .sh-top { flex: none; touch-action: none; padding-top: 16px; position: relative; }
  .grab { position: absolute; top: 6px; left: 50%; width: 60px; height: 4px; margin-left: -30px; border-radius: 2px; background: #b5b5b6; }
  .sh.dark .grab { background: #4d4d4d; }
  .sh-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 16px 10px; height: 54px; }
  .sh-title { flex: 1; min-width: 0; text-align: center; font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .prom { position: relative; flex: none; width: 44px; height: 44px; border: 0; padding: 0; background: none; cursor: pointer; color: #fff; isolation: isolate;
    display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent;
    transition: transform 420ms cubic-bezier(.3, 1.5, .45, 1); }
  .prom::before { content: ''; position: absolute; z-index: -1; inset: -40px; background: var(--img) center / 124px 124px no-repeat; }
  .prom:active:not(:disabled) { transform: scale(1.08); transition: transform 160ms cubic-bezier(.2, 0, 0, 1); }
  .prom:disabled { opacity: .45; cursor: default; }
  .prom.ink { color: var(--i-on-accent, #fff); }
  .prom.ink::before { inset: 0; border-radius: 50%; background: var(--i-accent); }
  .sh-spacer { flex: none; width: 44px; }
  .sh-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 16px max(16px, var(--sab, 0px)); }
</style>
