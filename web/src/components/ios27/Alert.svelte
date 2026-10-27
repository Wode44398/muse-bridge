<script>
  // iOS 27 警告框（kit「Alert」）：宽 300、内距 14，底是「Liquid Glass - Regular - Medium」（圆角 34 / 平滑 60%）。
  // 玻璃层 = Figma 原版管线在「压暗后的页面底色」两个锚点上解出的图层，紧凑 9 宫切片（design/ios27-settings）；
  // kit 那道 0/8/48 的大投影交给 CSS box-shadow（外投影只画在形状外，与 Figma knockout 一致；模糊半径 2σ=40.6）；
  // frost 16 → backdrop blur σ = 16/√6 = 6.53px。遮罩 #29293A 23%（kit「Overlay - Alerts」，明暗同值）。
  // 标题 17/22 Semibold、正文 17/22 Regular，左对齐；按钮 48 高胶囊，两个时并排、否则竖排。
  import { ovUrl } from '../../lib/overlay.svelte.js';
  import { getContext } from 'svelte';
  import glassL_pub from '../../assets/ios27/alert-light.png';
  const glassL = $derived(ovUrl('ios27/alert-light.png', glassL_pub));
  import glassD_pub from '../../assets/ios27/alert-dark.png';
  const glassD = $derived(ovUrl('ios27/alert-dark.png', glassD_pub));

  let { title = '', message = '', error = '', actions = [], onclose, children } = $props();
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);
  const side = $derived(actions.length === 2);

  // 防触摸「补发 click」误触：开关在 pointerup 里就把警告框渲染出来，同一次点按随后补发的兼容 click 会在新 DOM 上
  // 做命中测试——落到遮罩上就当场把框关掉、落到按钮上就替用户点了。所以只认「按下也发生在框里」的点击：
  // 遮罩要求按下就在遮罩上；按钮要求按下发生在框打开之后（键盘触发的 click detail=0，照常放行）。
  let downOnDim = false, downInside = false;
  function dimClick() { const ok = downOnDim; downOnDim = false; if (ok) onclose?.(); }
  function actClick(e, a) { if (e.detail > 0 && !downInside) return; a.onclick?.(); }
</script>

<div class="al-root" role="presentation" onpointerdowncapture={(e) => { downInside = true; downOnDim = e.target instanceof Element && e.target.classList.contains('al-dim'); }}>
  <button class="al-dim" type="button" tabindex="-1" aria-label={title} onclick={dimClick}></button>
  <div class="al" class:dark role="alertdialog" aria-modal="true" aria-label={title} style:--glass={`url("${dark ? glassD : glassL}")`}>
    <div class="al-tm">
      {#if title}<h3>{title}</h3>{/if}
      {#if message}<p>{message}</p>{/if}
      {#if error}<p class="al-err">{error}</p>{/if}
    </div>
    {#if children}<div class="al-body">{@render children()}</div>{/if}
    {#if actions.length}
      <div class="al-acts" class:side>
        {#each actions as a (a.label)}
          <button type="button" class="al-btn {a.role || 'cancel'}" disabled={a.disabled} onclick={(e) => actClick(e, a)}>{a.label}</button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .al-root { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .al-dim { position: absolute; inset: 0; border: 0; padding: 0; background: var(--i-dim, rgba(41, 41, 58, .23)); cursor: default; animation: al-fade 220ms var(--ea-fade, ease) both; }
  .al {
    position: relative; width: min(300px, 100%); padding: 14px; border-radius: 34px; isolation: isolate;
    -webkit-backdrop-filter: blur(6.53px); backdrop-filter: blur(6.53px);
    box-shadow: 0 8px 40.6px rgba(0, 0, 0, .25);
    color: var(--i-label); animation: al-in 340ms cubic-bezier(.25, 1.2, .4, 1) both;
  }
  .al.dark { box-shadow: 0 8px 40.6px rgba(0, 0, 0, .45); }
  .al::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--glass) 228 fill / 76px / 16px stretch; }
  @keyframes al-fade { from { opacity: 0; } }
  @keyframes al-in { from { opacity: 0; transform: scale(1.1); } }
  .al-tm { display: flex; flex-direction: column; gap: 10px; padding: 8px 8px 24px; }
  .al-tm h3 { margin: 0; font-size: 17px; line-height: 22px; font-weight: 600; }
  .al-tm p { margin: 0; font-size: 17px; line-height: 22px; font-weight: 400; }
  .al-tm .al-err { color: var(--i-red); font-size: 15px; line-height: 20px; }
  .al-body { padding-bottom: 19px; }
  .al-acts { display: flex; flex-direction: column; gap: 8px; }
  .al-acts.side { flex-direction: row-reverse; }
  .al-acts.side .al-btn { flex: 1; }
  .al-btn {
    height: 48px; border-radius: 24px; border: 0; padding: 0 16px; cursor: pointer; font: inherit;
    font-size: 17px; line-height: 22px; font-weight: 600; color: var(--i-label);
    background: rgba(120, 120, 128, .2); -webkit-tap-highlight-color: transparent;
    transition: transform 160ms cubic-bezier(.2, 0, 0, 1), filter 160ms linear;
  }
  .al.dark .al-btn { background: rgba(255, 255, 255, .17); }
  .al-btn.default, .al.dark .al-btn.default { background: var(--i-accent, var(--i-blue)); color: var(--i-on-accent, #fff); }
  .al-btn.destructive { color: var(--i-red); }
  .al-btn:active:not(:disabled) { transform: scale(.97); filter: brightness(.92); }
  .al-btn:disabled { opacity: .45; cursor: default; }
  /* 并排时「取消」在左（kit Side-by-Side：Cancel | Action）：actions 按 [主操作, 取消] 传入，row-reverse 排版 */
</style>
