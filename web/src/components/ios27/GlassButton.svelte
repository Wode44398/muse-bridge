<script>
  // iOS 27 液态玻璃按钮（kit「Liquid Glass - Regular - Small」，44pt 圆钮 / 胶囊）。
  // 材质是 Figma 原版着色器在两个纯色锚点上解出的「与底色无关的图层」（design/ios27-settings/bake.html）：
  //   variant 'nav'   → 页面底色锚点（亮 #F2F2F7 / 暗 #000），跟设置页明暗；
  //   variant 'stage' → 壁纸实景舞台上（中灰锚点，亮材质）。
  // 不加 backdrop-filter：按钮所在的顶栏底下已有滚动边缘效果把内容重度模糊过（kit 的 Scroll Edge Effect），
  // frost 6 的那点磨砂叠在上面看不出，却会让同屏多一层 backdrop（多层 backdrop 互毁，见 dev_verify 记忆）。
  // 字形颜色按 kit：亮 #1A1A1A LINEAR_BURN（在玻璃中心色 #F1F1F3 上 = #0C0C0E），暗 #F5F5F5 LINEAR_DODGE（= 白）。
  import { ovUrl } from '../../lib/overlay.svelte.js';
  import { getContext } from 'svelte';
  import Sym from './Sym.svelte';
  import navL_pub from '../../assets/ios27/nav44-light.png';
  const navL = $derived(ovUrl('ios27/nav44-light.png', navL_pub));
  import navD_pub from '../../assets/ios27/nav44-dark.png';
  const navD = $derived(ovUrl('ios27/nav44-dark.png', navD_pub));
  import capL_pub from '../../assets/ios27/cap44-light.png';
  const capL = $derived(ovUrl('ios27/cap44-light.png', capL_pub));
  import capD_pub from '../../assets/ios27/cap44-dark.png';
  const capD = $derived(ovUrl('ios27/cap44-dark.png', capD_pub));
  import stg_pub from '../../assets/ios27/stage44-light.png';
  const stg = $derived(ovUrl('ios27/stage44-light.png', stg_pub));
  import stgCap_pub from '../../assets/ios27/stagecap44-light.png';
  const stgCap = $derived(ovUrl('ios27/stagecap44-light.png', stgCap_pub));
  import promCap_pub from '../../assets/ios27/stageprom44.png';   // Glass Prominent 胶囊（蓝底白字，几乎不透明）
  const promCap = $derived(ovUrl('ios27/stageprom44.png', promCap_pub));

  let { symbol = '', weight = 600, label = '', variant = 'nav', prominent = false, onclick, aria = '', tint = '', disabled = false, round = false, children } = $props();
  const ios = getContext('ios27');
  const dark = $derived(variant === 'nav' && !!ios?.dark);
  const ink = $derived(prominent && !!ios?.ink);   // 墨色模式的主按钮：实心墨色胶囊 + 象牙白字，不用蓝色玻璃
  // round：自定义内容（children）但仍要 44 圆钮——比如工作空间顶栏的传输环
  const capsule = $derived(!round && (!!label || !!children));
  const img = $derived(prominent && capsule ? promCap : variant === 'stage' ? (capsule ? stgCap : stg) : capsule ? (dark ? capD : capL) : (dark ? navD : navL));
</script>

<button type="button" class="gb" class:cap={capsule} class:dark class:stage={variant === 'stage'} class:prom={prominent} class:ink {disabled}
  style:--img={`url("${img}")`} style:--tint={tint || null} aria-label={aria || label} {onclick}>
  {#if symbol}<Sym name={symbol} {weight} size={17} />{/if}
  {#if label}<span class="lbl">{label}</span>{/if}
  {#if children}{@render children()}{/if}
</button>

<style>
  .gb {
    position: relative; flex: none; height: 44px; min-width: 44px; padding: 0; border: 0; background: none; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; isolation: isolate;
    color: #0c0c0e; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
    transition: transform 420ms cubic-bezier(.3, 1.5, .45, 1);
  }
  .gb.dark { color: #fff; }
  .gb.stage { color: #0c0c0e; }
  .gb.prom { color: #fff; }
  .gb::before { content: ''; position: absolute; z-index: -1; inset: -40px; background: var(--img) center / 124px 124px no-repeat; pointer-events: none; }
  /* 胶囊：横向三段切片（两端各 70pt＝外扩 40 + 30，中段逐列不变可拉伸），纵向 1:1 */
  .gb.cap { padding: 0 16px; }
  .gb.cap { min-width: 60px; }
  .gb.cap::before { background: none; inset: 0; border: 0 solid transparent; border-image: var(--img) 0 210 fill / 0 70px / 40px stretch; }
  .gb.prom.ink { color: #f3eee4; }
  .gb.prom.ink::before { border-image: none; inset: 0; border-radius: 22px; background: #1d1b18; box-shadow: 0 6px 20px rgba(0, 0, 0, .22); }
  .gb:active:not(:disabled) { transform: scale(1.08); transition: transform 160ms cubic-bezier(.2, 0, 0, 1); }
  .gb:disabled { opacity: .4; cursor: default; }
  .lbl { font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; white-space: nowrap; color: var(--tint, inherit); }
</style>
