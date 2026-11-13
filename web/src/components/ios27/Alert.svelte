<script>
  // iOS 27 警告框（kit「Alert」）：宽 300、内距 14，底是「Liquid Glass - Regular - Medium」（圆角 34 / 平滑 60%）。
  // 玻璃层 = Figma 原版管线在「压暗后的页面底色」两个锚点上解出的图层，紧凑 9 宫切片（design/ios27-settings）；
  // kit 那道 0/8/48 的大投影交给 CSS box-shadow（外投影只画在形状外，与 Figma knockout 一致；模糊半径 2σ=40.6）；
  // frost 16 → backdrop blur σ = 16/√6 = 6.53px。遮罩 #29293A 23%（kit「Overlay - Alerts」，明暗同值）。
  // 标题 17/22 Semibold、正文 17/22 Regular，左对齐；按钮 48 高胶囊，两个时并排、否则竖排。
  //
  // 2026-11 应用内对话框（components/DialogHost.svelte）也用它，为此加了几个可选参数，老调用方不传时行为不变：
  //   detail   正文下面的补充说明（次要色、保留换行），长文在框里滚动
  //   dim      false = 不画自己的遮罩、根节点不拦指针（DialogHost 整串弹窗共用一层遮罩，不逐条闪）
  //   closing  true = 播退场（淡出 + 微缩），期间不接指针
  //   actions[i].act  原样写到按钮的 data-act 上，宿主据此找按钮做键盘焦点
  import { ov, ovHas, ovUrl } from '../../lib/overlay.svelte.js';
  import { getContext } from 'svelte';
  import { liquidPress } from '../../lib/liquid/press.js';
  const glassL = $derived(ovUrl('ios27/alert-light.png'));
  const glassD = $derived(ovUrl('ios27/alert-dark.png'));

  let { title = '', message = '', detail = '', error = '', actions = [], dim = true, closing = false, onclose, children } = $props();
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);
  const side = $derived(actions.length === 2);
  // 清单已就位却没有这张玻璃切图（精简构建 / 资源包不全）：换实心底，不然框是透明的、字压在页面上看不清
  const solid = $derived(ov.ready && !ovHas(dark ? 'ios27/alert-dark.png' : 'ios27/alert-light.png'));
  const uid = $props.id();

  // 防触摸「补发 click」误触：开关在 pointerup 里就把警告框渲染出来，同一次点按随后补发的兼容 click 会在新 DOM 上
  // 做命中测试——落到遮罩上就当场把框关掉、落到按钮上就替用户点了。所以只认「按下也发生在框里」的点击：
  // 遮罩要求按下就在遮罩上；按钮要求按下发生在框打开之后（键盘触发的 click detail=0，照常放行）。
  let downOnDim = false, downInside = false;
  function dimClick() { const ok = downOnDim; downOnDim = false; if (ok) onclose?.(); }
  function actClick(e, a) { if (e.detail > 0 && !downInside) return; a.onclick?.(); }
</script>

<div class="al-root" class:nodim={!dim} class:closing role="presentation" onpointerdowncapture={(e) => { downInside = true; downOnDim = e.target instanceof Element && e.target.classList.contains('al-dim'); }}>
  {#if dim}<button class="al-dim" type="button" tabindex="-1" aria-label={title} onclick={dimClick}></button>{/if}
  <div class="al" class:dark class:solid role="alertdialog" aria-modal="true" aria-label={title} aria-describedby={detail ? `${uid}-d` : undefined} style:--glass={`url("${dark ? glassD : glassL}")`}>
    <div class="al-tm">
      {#if title}<h3>{title}</h3>{/if}
      {#if message}<p>{message}</p>{/if}
      {#if detail}<p class="al-detail" id="{uid}-d">{detail}</p>{/if}
      {#if error}<p class="al-err">{error}</p>{/if}
    </div>
    {#if children}<div class="al-body">{@render children()}</div>{/if}
    {#if actions.length}
      <div class="al-acts" class:side>
        <!-- 按下标做键：两个按钮文案相同（比如英文里「关闭」与「取消」撞成同一个词）时按文案做键会直接报错 -->
        {#each actions as a, i (i)}
          <button type="button" class="al-btn {a.role || 'cancel'}" data-act={a.act} disabled={a.disabled} use:liquidPress onclick={(e) => actClick(e, a)}>{a.label}</button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .al-root { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 24px; }
  /* 不画自己的遮罩时根节点只是个定位层：指针穿过去落到宿主的遮罩上，只有框本身接指针 */
  .al-root.nodim { pointer-events: none; }
  .al-root.nodim .al { pointer-events: auto; }
  .al-dim { position: absolute; inset: 0; border: 0; padding: 0; background: var(--i-dim, rgba(41, 41, 58, .23)); cursor: default; animation: al-fade 220ms var(--ea-fade, ease) both;
    transition: opacity var(--mo-quick, 200ms) var(--ea-fade, ease); }
  .al {
    position: relative; width: min(300px, 100%); padding: 14px; border-radius: 34px; isolation: isolate;
    /* 竖向 flex：长文案时只让文字区滚动，按钮始终露在框底（老调用方文字短，排版与原来的块级一致） */
    display: flex; flex-direction: column; max-height: 100%; box-sizing: border-box;
    -webkit-backdrop-filter: blur(6.53px); backdrop-filter: blur(6.53px);
    box-shadow: 0 8px 40.6px rgba(0, 0, 0, .25);
    color: var(--i-label); animation: al-in 340ms cubic-bezier(.25, 1.2, .4, 1) both;
    transition: opacity var(--mo-quick, 200ms) var(--ea-fade, ease), transform var(--mo-quick, 200ms) var(--ea-accel, ease-in);
  }
  .al.dark { box-shadow: 0 8px 40.6px rgba(0, 0, 0, .45); }
  .al::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--glass) 228 fill / 76px / 16px stretch; }
  /* 缺玻璃切图时的实心底（明暗各一）：接近玻璃在压暗页面上的平均色 */
  .al.solid { background: rgba(250, 249, 246, .94); }
  .al.solid.dark { background: rgba(30, 29, 27, .95); }
  .al.solid::before { display: none; }
  /* 退场：内容先走（淡出 + 微缩，accel），遮罩同步淡出；keyframes 只写 from，末态跟随这里的底值 */
  .al-root.closing, .al-root.closing .al { pointer-events: none; }
  .al-root.closing .al { opacity: 0; transform: scale(.96); }
  .al-root.closing .al-dim { opacity: 0; }
  @keyframes al-fade { from { opacity: 0; } }
  @keyframes al-in { from { opacity: 0; transform: scale(1.1); } }
  .al-tm { display: flex; flex-direction: column; gap: 10px; padding: 8px 8px 24px; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .al-tm h3 { margin: 0; font-size: 17px; line-height: 22px; font-weight: 600; white-space: pre-line; overflow-wrap: anywhere; }
  .al-tm p { margin: 0; font-size: 17px; line-height: 22px; font-weight: 400; white-space: pre-line; overflow-wrap: anywhere; }
  .al-tm .al-detail { color: var(--i-label2); font-size: 15px; line-height: 20px; }
  .al-tm .al-err { color: var(--i-red); font-size: 15px; line-height: 20px; }
  .al-body { padding-bottom: 19px; flex-shrink: 0; }
  .al-acts { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
  .al-acts.side { flex-direction: row-reverse; }
  .al-acts.side .al-btn { flex: 1; }
  .al-btn {
    height: 48px; border-radius: 24px; border: 0; padding: 0 16px; cursor: pointer; font: inherit;
    font-size: 17px; line-height: 22px; font-weight: 600; color: var(--i-label);
    background: rgba(120, 120, 128, .2); -webkit-tap-highlight-color: transparent;
    /* 按压手感 = lib/liquid/press.js（Kyant LiquidButton：放大 1+4/高、跟手、白光斑）；自成隔离组，光斑只加在按钮自己身上 */
    position: relative; isolation: isolate;
  }
  .al.dark .al-btn { background: rgba(255, 255, 255, .17); }
  .al-btn.default, .al.dark .al-btn.default { background: var(--i-accent, var(--i-blue)); color: var(--i-on-accent, #fff); }
  .al-btn.destructive { color: var(--i-red); }
  .al-btn:disabled { opacity: .45; cursor: default; }
  /* 并排时「取消」在左（kit Side-by-Side：Cancel | Action）：actions 按 [主操作, 取消] 传入，row-reverse 排版 */
</style>
