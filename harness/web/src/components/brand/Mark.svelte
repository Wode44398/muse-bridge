<script lang="ts">
  // dimensio 标志：bridge 的月桥——一道拱、一根贯穿圆心的水面线、一道渐隐的倒影（拱与倒影合成整圆）。
  // 几何见 lib/brand.ts（出自 brand/geometry.mjs）。颜色 = currentColor；倒影沿竖直方向渐隐。
  // 两套画法：≥ FINE_AT px 用精绘版（填充的三笔：拱顶厚、拱脚收，水面与倒影两头收）；更小用月桥原样（等宽描边），
  // 精绘的笔势在十几像素下看不出来，反倒糊。
  //
  // intro：出场（首页 / 空态用）——整枚竖着旋入、一笔绕出整圆，线从圆心射出贯穿，再三笔一起顺时针转过 90° 落成月桥。
  // live：正在发生——月桥沉进水面、水面线独自转半圈、月桥重新升起。
  // 两段动作都由 lib/mark-motion.ts 逐帧驱动（弹簧、惯性、形变都在那里），这里只摆好分层：
  //   body 整枚（转、缩、淡入）⊃ ring 圆环（形变）⊃ arch 拱 / refl 倒影（各自沉浮）；line 水面线（现算轮廓）。
  // 静止时这些层都不带属性，画出来与 brand.ts 原样逐数相同。
  // 小尺寸：水面线与倒影的笔画按像素下限加粗（≥1px），否则 14px 下细线会消失。
  // 减弱动效：出场只淡入，live 只做明暗呼吸。
  import { MARK, MARK_FINE } from "../../lib/brand.ts";
  import { MarkMotion, reducedMotion } from "../../lib/mark-motion.ts";

  let {
    size = 24,
    live = false,
    intro = false,
    label = "",
  }: {
    size?: number;
    live?: boolean;
    intro?: boolean;
    label?: string;
  } = $props();

  const FINE_AT = 40;
  const uid = $props.id();
  const fine = $derived(size >= FINE_AT);
  const G = $derived(fine ? MARK_FINE : MARK);
  // 视框：标志包围盒四周各留 3 个网格单位的方形；出场时竖着的整枚（高 = 水面线长）也落在框里
  const pad = 3;
  const side = $derived(Math.max(G.box.w, G.box.h) + 2 * pad);
  const vb = $derived(`${G.box.x + G.box.w / 2 - side / 2} ${G.box.y + G.box.h / 2 - side / 2} ${side} ${side}`);
  const k = $derived(size / side); // 每网格单位多少像素
  const lineW = $derived(Math.max(MARK.lineW, 1 / k));
  const reflW = $derived(Math.max(MARK.reflW, 1.1 / k));

  const reduced = reducedMotion();
  const motion = new MarkMotion();
  let body = $state<SVGGElement>();
  let ring = $state<SVGGElement>();
  let archG = $state<SVGGElement>();
  let reflG = $state<SVGGElement>();
  let lineEl = $state<SVGPathElement>();
  let drawA = $state<SVGPathElement>();
  let drawR = $state<SVGPathElement>();

  // 分层或几何变了（跨过 FINE_AT、像素下限变了）就把新元素交给控制器，正在播的姿态接着画上去
  $effect(() => {
    if (!body || !ring || !archG || !reflG || !lineEl) return;
    motion.attach(
      { body, ring, arch: archG, refl: reflG, line: lineEl, drawA, drawR },
      fine
        ? { cx: G.cx, cy: G.cy, fine: true, half: MARK_FINE.lineTaper.half, lineW: 0, lineD: MARK_FINE.line, taper: MARK_FINE.lineTaper }
        : { cx: G.cx, cy: G.cy, fine: false, half: MARK.lineLen / 2, lineW, lineD: MARK.line },
    );
  });
  $effect(() => {
    if (intro) motion.intro();
  });
  $effect(() => {
    motion.setLive(live);
  });
  $effect(() => () => motion.destroy());
</script>

<svg
  class="mark"
  class:fadein={intro && reduced}
  class:pulse={live && reduced}
  viewBox={vb}
  width={size}
  height={size}
  role={label ? "img" : undefined}
  aria-label={label || undefined}
  aria-hidden={label ? undefined : "true"}
>
  <defs>
    <linearGradient id="{uid}-fade" x1="0" y1={G.fade.y1} x2="0" y2={G.fade.y2} gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="currentColor" stop-opacity={G.fade.o0} />
      <stop offset="1" stop-color="currentColor" stop-opacity={G.fade.o1} />
    </linearGradient>
    {#if intro}
      <!-- 一笔绕圆：沿拱 / 倒影中线的粗描边（圆笔头）做遮罩，描到哪显到哪 -->
      <mask id="{uid}-ma" maskUnits="userSpaceOnUse" x="0" y="0" width="108" height="108">
        <path bind:this={drawA} d={G.archMask.d} stroke="white" stroke-width={G.archMask.w} stroke-linecap="round" fill="none" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset={reduced ? 0 : 100} />
      </mask>
      <mask id="{uid}-mr" maskUnits="userSpaceOnUse" x="0" y="0" width="108" height="108">
        <path bind:this={drawR} d={G.reflMask.d} stroke="white" stroke-width={G.reflMask.w} stroke-linecap="round" fill="none" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset={reduced ? 0 : 100} />
      </mask>
    {/if}
  </defs>
  <g bind:this={body} opacity={intro && !reduced ? 0 : undefined}>
    <g bind:this={ring}>
      <g bind:this={archG}>
        {#if fine}
          <path d={MARK_FINE.arch} fill="currentColor" mask={intro ? `url(#${uid}-ma)` : undefined} />
        {:else}
          <path class="s" d={MARK.arch} stroke="currentColor" stroke-width={MARK.archW} mask={intro ? `url(#${uid}-ma)` : undefined} />
        {/if}
      </g>
      <g bind:this={reflG}>
        {#if fine}
          <path d={MARK_FINE.refl} fill="url(#{uid}-fade)" mask={intro ? `url(#${uid}-mr)` : undefined} />
        {:else}
          <path class="s round" d={MARK.refl} stroke="url(#{uid}-fade)" stroke-width={reflW} mask={intro ? `url(#${uid}-mr)` : undefined} />
        {/if}
      </g>
    </g>
    {#if fine}
      <path bind:this={lineEl} d={MARK_FINE.line} fill="currentColor" />
    {:else}
      <path bind:this={lineEl} class="s round" d={MARK.line} stroke="currentColor" stroke-width={lineW} />
    {/if}
  </g>
</svg>

<style>
  .mark {
    display: block;
    flex: none;
    overflow: visible;
    color: inherit;
  }
  /* 描边颜色写在属性上（倒影是渐变），这里不写 stroke / fill——样式表会盖过属性 */
  .s {
    fill: none;
  }
  .round {
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* 减弱动效：只留透明度 */
  .fadein {
    animation: mk-in 240ms ease-out both;
  }
  .pulse {
    animation: mk-breathe 1.6s ease-in-out infinite;
  }
  @keyframes mk-in {
    from {
      opacity: 0;
    }
  }
  @keyframes mk-breathe {
    50% {
      opacity: 0.4;
    }
  }
</style>
