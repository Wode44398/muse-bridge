<script>
  // iOS 27 滑块（kit「Sliders」）：轨道 6 高、圆角 3（Fills/Primary），蓝色填充到旋钮中心；
  // 旋钮 38×24 白色胶囊 + 两道投影（Figma 0/6/13 与 0/0.5/4 黑 12%，模糊半径按 σ=0.4227·r 换成 CSS 2σ）。
  // 拖动时旋钮化成液态玻璃透镜：透镜图是 Figma 用 kit 原版材质渲染的 Pressed 状态（透镜底下永远是
  // 「左蓝右灰、分界在中心」，所以同一张图随旋钮平移即可）。
  import { ovUrl } from '../../lib/overlay.svelte.js';
  import { getContext } from 'svelte';
  import lensL_pub from '../../assets/ios27/slider-pressed-light.png';
  const lensL = $derived(ovUrl('ios27/slider-pressed-light.png', lensL_pub));
  import lensD_pub from '../../assets/ios27/slider-pressed-dark.png';
  const lensD = $derived(ovUrl('ios27/slider-pressed-dark.png', lensD_pub));

  let { value = 0, disabled = false, oninput, onstart, onend, label = '' } = $props();
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);

  let w = $state(0);
  let dragging = $state(false);
  const v = $derived(Math.max(0, Math.min(1, value || 0)));
  const cx = $derived(19 + Math.max(0, w - 38) * v);

  function at(e, el) {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left - 19) / Math.max(1, r.width - 38)));
  }
  // 触屏照 iOS 原生：只有按在旋钮上、并且先横向拖开才算拖动，按轨道别处不跳值；竖向滑动交给页面滚动
  // （touch-action: pan-y，浏览器接管后发 pointercancel）。之前整行 touch-action:none + 按下即跳到触点，
  // 设置页一屏十根滑条，手指想滚动页面就把参数改了，从左边缘做返回手势正好落在最小值（流光壁纸被改成全黑）。
  // 鼠标保持点哪跳哪。
  let grab = null;   // 触屏：按在旋钮上的那根手指 { id, x0, y0, v0 }，拖动时按位移相对旋钮原位置算
  function down(e) {
    if (disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.currentTarget;
    if (e.pointerType === 'touch') {
      if (Math.abs(e.clientX - el.getBoundingClientRect().left - cx) > 30) return;
      grab = { id: e.pointerId, x0: e.clientX, y0: e.clientY, v0: v };
      return;
    }
    dragging = true;
    try { el.setPointerCapture(e.pointerId); } catch {}
    onstart?.();
    oninput?.(at(e, el));
  }
  function move(e) {
    const el = e.currentTarget;
    if (grab && !dragging) {
      if (e.pointerId !== grab.id) return;
      const dx = e.clientX - grab.x0, dy = e.clientY - grab.y0;
      if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(dy)) return;
      dragging = true;
      try { el.setPointerCapture(e.pointerId); } catch {}
      onstart?.();
    }
    if (!dragging) return;
    if (grab) oninput?.(Math.max(0, Math.min(1, grab.v0 + (e.clientX - grab.x0) / Math.max(1, w - 38))));
    else oninput?.(at(e, el));
  }
  function up() { grab = null; if (!dragging) return; dragging = false; onend?.(); }
  function key(e) {
    if (disabled) return;
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); oninput?.(Math.min(1, v + step)); onend?.(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); oninput?.(Math.max(0, v - step)); onend?.(); }
  }
</script>

<div class="sl" class:dragging class:dis={disabled} bind:clientWidth={w} role="slider" tabindex={disabled ? -1 : 0}
  aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(v * 100)} aria-disabled={disabled}
  onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onkeydown={key}>
  <span class="track"></span>
  <span class="fill" style:width="{cx}px"></span>
  <span class="knob" style:transform="translateX({cx - 19}px)"></span>
  <img class="lens" src={dark ? lensD : lensL} alt="" draggable="false" style:transform="translateX({cx - 42}px)" />
</div>

<style>
  .sl { position: relative; height: 44px; width: 100%; touch-action: pan-y; cursor: pointer; outline: none; -webkit-tap-highlight-color: transparent; }
  .sl.dis { opacity: .45; cursor: default; }
  .track, .fill { position: absolute; left: 0; top: 19px; height: 6px; border-radius: 3px; }
  .track { right: 0; background: var(--i-fill1); }
  .fill { background: var(--i-accent, var(--i-blue)); }
  .knob {
    position: absolute; left: 0; top: 10px; width: 38px; height: 24px; border-radius: 12px; background: #fff;
    box-shadow: 0 6px 11px rgba(0, 0, 0, .12), 0 .5px 3.4px rgba(0, 0, 0, .12);
    transition: opacity 110ms linear;
  }
  /* 透镜图：3× 位图，CSS 80×60；窗口内轨道中线 y=30、分界点 x=42 */
  .lens { position: absolute; left: 0; top: -8px; width: 80px; height: 60px; max-width: none; pointer-events: none; opacity: 0; transition: opacity 110ms linear; }
  .sl.dragging .knob { opacity: 0; }
  .sl.dragging .lens { opacity: 1; }
</style>
