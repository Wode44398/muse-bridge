<script>
  // iOS 27 开关（kit「Toggle - Switch」）：轨道 64×28 胶囊、白色旋钮 38×24、内距 2。
  // 按下时旋钮化成液态玻璃透镜——透镜图是 Figma 用 kit 原版材质渲染的官方状态图（Pressed · On/Off × 明/暗，
  // 背景是已知的单元格底色，直接用它的渲染结果）；点按翻转时两张透镜图一边滑向另一端一边交叉淡换。
  import { ovUrl } from '../../lib/overlay.svelte.js';
  import { getContext } from 'svelte';
  import onL_pub from '../../assets/ios27/toggle-on-pressed-light.png';
  const onL = $derived(ovUrl('ios27/toggle-on-pressed-light.png', onL_pub));
  import onD_pub from '../../assets/ios27/toggle-on-pressed-dark.png';
  const onD = $derived(ovUrl('ios27/toggle-on-pressed-dark.png', onD_pub));
  import offL_pub from '../../assets/ios27/toggle-off-pressed-light.png';
  const offL = $derived(ovUrl('ios27/toggle-off-pressed-light.png', offL_pub));
  import offD_pub from '../../assets/ios27/toggle-off-pressed-dark.png';
  const offD = $derived(ovUrl('ios27/toggle-off-pressed-dark.png', offD_pub));

  let { checked = false, disabled = false, onchange, label = '' } = $props();
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);
  // 墨色模式（设置页 v5）：轨道吃 --i-accent、旋钮开着时换 --i-on-accent，按下不出 kit 的绿色透镜图，改旋钮横向拉长
  const ink = $derived(!!ios?.ink);

  let pressed = $state(false);
  let releaseTimer = 0;
  function down(e) {
    if (disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    clearTimeout(releaseTimer);
    pressed = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }
  function up(e) {
    if (!pressed) return;
    const r = e.currentTarget.getBoundingClientRect();
    const inside = e.clientX > r.left - 24 && e.clientX < r.right + 24 && e.clientY > r.top - 24 && e.clientY < r.bottom + 24;
    if (inside) onchange?.();
    // 透镜在新的一端停一拍再收回旋钮（滑动 200ms + 驻留）
    releaseTimer = setTimeout(() => { pressed = false; }, inside ? 260 : 0);
  }
  function cancel() { clearTimeout(releaseTimer); pressed = false; }
  function key(e) { if (disabled) return; if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onchange?.(); } }
</script>

<button class="tg" class:on={checked} class:pressed class:dis={disabled} class:ink type="button" role="switch" aria-checked={checked} aria-label={label}
  {disabled} onpointerdown={down} onpointerup={up} onpointercancel={cancel} onkeydown={key} onclick={(e) => e.preventDefault()}>
  <span class="knob"></span>
  {#if !ink}
    <img class="lens l-on" src={dark ? onD : onL} alt="" draggable="false" />
    <img class="lens l-off" src={dark ? offD : offL} alt="" draggable="false" />
  {/if}
</button>

<style>
  .tg {
    position: relative; flex: none; width: 64px; height: 28px; border-radius: 14px; padding: 0; border: 0; cursor: pointer;
    background: var(--i-label3); transition: background-color 220ms var(--ea-fade, ease);
    -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  }
  .tg.on { background: var(--i-green); }
  .tg.dis { opacity: .5; cursor: default; }
  .knob {
    position: absolute; left: 2px; top: 2px; width: 38px; height: 24px; border-radius: 12px; background: #fff;
    transition: transform 320ms cubic-bezier(.3, 1.25, .5, 1), opacity 120ms linear;
  }
  .tg.on .knob { transform: translateX(22px); }
  .tg.pressed .knob { opacity: 0; transition: transform 320ms cubic-bezier(.3, 1.25, .5, 1), opacity 90ms linear; }
  /* 透镜图（3× 位图，CSS 尺寸 97×64）：窗口内轨道位置 on=(12,18)、off=(21,18) */
  .lens { position: absolute; top: -18px; width: 97px; height: 64px; max-width: none; pointer-events: none; opacity: 0;
    transition: opacity 110ms linear, transform 200ms cubic-bezier(.2, .9, .1, 1); }
  .l-on { left: -12px; }
  .l-off { left: -21px; }
  /* 按住期间，隐藏的那张停在「对侧」：翻转时两张一起朝新的一端滑、交叉淡换 */
  .tg.pressed:not(.on) .l-on { transform: translateX(-22px); }
  .tg.pressed.on .l-off { transform: translateX(22px); }
  .tg.pressed.on .l-on, .tg.pressed:not(.on) .l-off { opacity: 1; }
  /* 墨色模式 */
  .tg.ink { width: 51px; height: 31px; border-radius: 16px; background: var(--i-fill1); transition: background-color 240ms var(--ea-fade, ease); }
  .tg.ink.on { background: var(--i-accent); }
  .tg.ink .knob { left: 2px; top: 2px; width: 27px; height: 27px; border-radius: 14px; background: var(--i-knob, #fff);
    box-shadow: 0 2px 6px rgba(0, 0, 0, .16), 0 0 0 .5px rgba(0, 0, 0, .04);
    transition: transform 300ms cubic-bezier(.3, 1.2, .5, 1), width 180ms var(--ea-std, ease), background-color 240ms var(--ea-fade, ease); }
  .tg.ink.on .knob { transform: translateX(20px); background: var(--i-knob-on, #fff); }
  .tg.ink.pressed .knob { opacity: 1; width: 33px; }
  .tg.ink.pressed.on .knob { transform: translateX(14px); }
</style>
