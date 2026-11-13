<script>
  // iOS 27 液态玻璃按钮（kit「Liquid Glass - Regular - Small」，44pt 圆钮 / 胶囊）。
  // 材质是 Figma 原版着色器在两个纯色锚点上解出的「与底色无关的图层」（design/ios27-settings/bake.html）：
  //   variant 'nav'   → 页面底色锚点（亮 #F2F2F7 / 暗 #000），跟设置页明暗；
  //   variant 'stage' → 壁纸实景舞台上（中灰锚点，亮材质）。
  // 不加 backdrop-filter：按钮所在的顶栏底下已有滚动边缘效果把内容重度模糊过（kit 的 Scroll Edge Effect），
  // frost 6 的那点磨砂叠在上面看不出，却会让同屏多一层 backdrop（多层 backdrop 互毁，见 dev_verify 记忆）。
  // 字形颜色按 kit：亮 #1A1A1A LINEAR_BURN（在玻璃中心色 #F1F1F3 上 = #0C0C0E），暗 #F5F5F5 LINEAR_DODGE（= 白）。
  // 按压手感 = Kyant0 LiquidButton + InteractiveHighlight（lib/liquid/press.js）：按下 spring(0.5, 300) 放大 1 + 4/高；
  // 手指拖动时朝手指方向 tanh 跟随、沿拖动方向拉长；按住时白 8% 平铺 + 白 15% 径向光斑（Plus 混合）。
  // el（bindable）：按钮元素，液滴菜单（MorphMenu）从它长出来；渐隐 / 撞一下的接口登记在 lib/liquid/core.js 的 triggers 里。
  import { ovUrl } from '../../lib/overlay.svelte.js';
  import { getContext, onMount } from 'svelte';
  import Sym from './Sym.svelte';
  import { triggers } from '../../lib/liquid/core.js';
  import { liquidPress, pressOf } from '../../lib/liquid/press.js';
  const navL = $derived(ovUrl('ios27/nav44-light.png'));
  const navD = $derived(ovUrl('ios27/nav44-dark.png'));
  const capL = $derived(ovUrl('ios27/cap44-light.png'));
  const capD = $derived(ovUrl('ios27/cap44-dark.png'));
  const stg = $derived(ovUrl('ios27/stage44-light.png'));
  const stgCap = $derived(ovUrl('ios27/stagecap44-light.png'));
  const promCap = $derived(ovUrl('ios27/stageprom44.png'));

  let { symbol = '', weight = 600, label = '', variant = 'nav', prominent = false, onclick, aria = '', tint = '', disabled = false, round = false, el = $bindable(), children } = $props();
  const ios = getContext('ios27');
  const dark = $derived(variant === 'nav' && !!ios?.dark);
  const ink = $derived(prominent && !!ios?.ink);   // 墨色模式的主按钮：实心墨色胶囊 + 象牙白字，不用蓝色玻璃
  // round：自定义内容（children）但仍要 44 圆钮——比如工作空间顶栏的传输环
  const capsule = $derived(!round && (!!label || !!children));
  const img = $derived(prominent && capsule ? promCap : variant === 'stage' ? (capsule ? stgCap : stg) : capsule ? (dark ? capD : capL) : (dark ? navD : navL));

  onMount(() => {
    // 液滴菜单取用：渐隐（菜单长出来时按钮淡出）、撞一下（菜单收回按钮时）
    triggers.set(el, {
      fade(a) { el.style.opacity = a >= .999 ? '' : a.toFixed(4); el.style.pointerEvents = a < .5 ? 'none' : ''; },
      impact(t) { pressOf(el)?.setExtra(t); },
      // 被旁边按钮的菜单融进去（MorphMenu neighbors）：玻璃 ga、符号 ia 分开淡，变换 t 绕按钮中心（缩成水滴、流进菜单）
      fuse(ga, ia, t) {
        const s = el.style;
        if (ga >= .999) s.removeProperty('--gb-ga'); else s.setProperty('--gb-ga', ga.toFixed(4));
        if (ia >= .999) s.removeProperty('--gb-ia'); else s.setProperty('--gb-ia', ia.toFixed(4));
        s.pointerEvents = ia < .5 ? 'none' : '';
        pressOf(el)?.setExtra(t);
      },
    });
    return () => triggers.delete(el);
  });
</script>

<button type="button" class="gb" class:cap={capsule} class:dark class:stage={variant === 'stage'} class:prom={prominent} class:ink {disabled}
  bind:this={el} use:liquidPress style:--img={`url("${img}")`} style:--tint={tint || null} aria-label={aria || label} {onclick}>
  {#if symbol}<Sym name={symbol} {weight} size={17} />{/if}
  {#if label}<span class="lbl">{label}</span>{/if}
  {#if children}{@render children()}{/if}
</button>

<style>
  .gb {
    position: relative; flex: none; height: 44px; min-width: 44px; padding: 0; border: 0; background: none; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; isolation: isolate;
    color: #0c0c0e; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  }
  .gb.dark { color: #fff; }
  .gb.stage { color: #0c0c0e; }
  .gb.prom { color: #fff; }
  .gb::before { content: ''; position: absolute; z-index: -1; inset: -40px; background: var(--img) center / 124px 124px no-repeat; pointer-events: none; opacity: var(--gb-ga, 1); }
  /* 融进菜单时符号单独淡（玻璃已交给菜单的液滴） */
  .gb > :global(:not(.lq-glow)) { opacity: var(--gb-ia, 1); }
  /* 胶囊：横向三段切片（两端各 70pt＝外扩 40 + 30，中段逐列不变可拉伸），纵向 1:1 */
  .gb.cap { padding: 0 16px; }
  .gb.cap { min-width: 60px; }
  .gb.cap::before { background: none; inset: 0; border: 0 solid transparent; border-image: var(--img) 0 210 fill / 0 70px / 40px stretch; }
  .gb.prom.ink { color: #f3eee4; }
  .gb.prom.ink::before { border-image: none; inset: 0; border-radius: 22px; background: #1d1b18; box-shadow: 0 6px 20px rgba(0, 0, 0, .22); }
  .gb:disabled { opacity: .4; cursor: default; }
  .lbl { font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; white-space: nowrap; color: var(--tint, inherit); }
  /* 触摸光斑（lib/liquid/press.js 加的子元素）：按钮自己是隔离组（isolation），Plus 只加在按钮自己的玻璃上 */
  .gb { border-radius: 22px; }
</style>
