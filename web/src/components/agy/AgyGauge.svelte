<script>
  // 开口仪表（iOS 27 UI Kit「Lock Screen Widget / Circular / Open Gauge」原样几何，2026-11-19 从 Figma 取样，
  // 即 50% + 雨伞那一款）：画板 72×72；环中心 (36, 35.4)、中心线半径 26、环宽 6、圆头；
  //   270° 开口朝下（kit 的 45° → -225°）；当前值指示点直径 5.67、在环上镂出直径 10 的缺口；
  //   中间数值 17 号（SF Pro 510、字距 -1）中心在 y≈34.5，开口里符号 15 号中心在 y≈56.5。
  //   kit 只有点没有填充（锁屏小组件靠点读数）；这里在点之前加一段淡填充，34px 下进度更好读。
  // agy 的用法（维护者 11-19 定）：中间数字 = 上下文占用、环的填充段 = 周额度、指示点 = 5 小时额度（都取最吃紧的
  //   那个模型分组），开口 = 运行模式图标。填充与点各自独立：点可以落在填充段前面或后面。
  // 小尺寸（< 48px）做了视觉补偿：点和缺口放大、数字与图标有最小字号，否则 34px 下点只有 2.7px、数字 8px。
  import AgyModeIcon from './AgyModeIcon.svelte';

  const {
    size = 34,
    fill = null,    // 0–100，环的填充段（周额度已用）；null = 不画
    dot = null,     // 0–100，指示点位置（5 小时额度已用）；null = 不画点也不镂空
    value = null,   // 0–100，中间数字（上下文占用）；null = 还没有上下文：不写数字，模式图标居中放大
    mode = 'default',
  } = $props();

  const CX = 36, CY = 35.4, R = 26, A0 = 135, SWEEP = 270;
  const pt = (deg) => [CX + R * Math.cos((deg * Math.PI) / 180), CY + R * Math.sin((deg * Math.PI) / 180)];
  function arc(a, b) {
    const [x0, y0] = pt(a), [x1, y1] = pt(b);
    return `M${x0.toFixed(3)} ${y0.toFixed(3)}A${R} ${R} 0 ${b - a > 180 ? 1 : 0} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`;
  }
  const TRACK = arc(A0, A0 + SWEEP);
  const uid = 'agg' + Math.random().toString(36).slice(2, 8);

  const k = $derived(size / 72);
  const small = $derived(size < 48);
  const dotR = $derived(small ? 3.4 : 2.835);
  const cutR = $derived(small ? 6 : 5);
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : null);
  const lvl = (v) => (v == null ? '' : v >= 90 ? 'err' : v >= 75 ? 'warn' : '');
  const fillV = $derived(num(fill));
  const dotV = $derived(num(dot));
  const hasDot = $derived(dotV != null);
  const dotPt = $derived(pt(A0 + (SWEEP * (dotV ?? 0)) / 100));
  const fillD = $derived(fillV != null && fillV > 0.4 ? arc(A0, A0 + (SWEEP * fillV) / 100) : '');
  const fillLevel = $derived(lvl(fillV));
  const dotLevel = $derived(lvl(dotV));
  const hasValue = $derived(value != null && Number.isFinite(Number(value)));
  const shown = $derived(hasValue ? String(Math.max(0, Math.min(100, Math.round(Number(value))))) : '');
  const valueLevel = $derived(hasValue ? lvl(Number(value)) : '');
  const fs = $derived(Math.max(10.5, 17 * k) * (shown.length >= 3 ? 0.84 : 1));
  const is = $derived(Math.max(10, 15 * k));
  // 空状态（新对话，还没有上下文数字）：原来中间一个「–」加开口里一把很小的锁，读起来像禁用 / 加载中。
  // 现在不写横线，模式图标挪到环心、放大成 isBig；第一条消息发出后数字淡入，图标缩回开口（同一枚图标，
  // 始终按 isBig 画、靠 transform 缩放，所以能过渡）。
  const isBig = $derived(Math.max(14, 30 * k));
  const icoScale = $derived(hasValue ? is / isBig : 1);
  const icoTop = $derived((hasValue ? 56.5 : 37.5) * k);
</script>

<span class="agy-gauge" style:width="{size}px" style:height="{size}px" aria-hidden="true">
  <svg viewBox="0 0 72 72">
    {#if hasDot}
      <defs>
        <mask id={uid} maskUnits="userSpaceOnUse" x="0" y="0" width="72" height="72">
          <rect width="72" height="72" fill="#fff" />
          <circle cx={dotPt[0]} cy={dotPt[1]} r={cutR} fill="#000" />
        </mask>
      </defs>
    {/if}
    <g mask={hasDot ? `url(#${uid})` : null} fill="none" stroke-width="6" stroke-linecap="round">
      <path class="g-track" d={TRACK} />
      {#if fillD}<path class="g-fill {fillLevel}" d={fillD} />{/if}
    </g>
    {#if hasDot}<circle class="g-dot {dotLevel}" cx={dotPt[0]} cy={dotPt[1]} r={dotR} />{/if}
  </svg>
  <span class="g-num {valueLevel}" class:none={!hasValue} style:font-size="{fs}px" style:top="{34.5 * k}px">{shown}{#if hasValue && shown.length < 3}<small>%</small>{/if}</span>
  <span class="g-ico" class:solo={!hasValue} style:top="{icoTop}px" style:--g-ico-s={icoScale}><AgyModeIcon {mode} size={isBig} /></span>
</span>

<style>
  .agy-gauge {
    position: relative;
    display: inline-block;
    flex: none;
    color: var(--ag-on-sub);
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .g-track { stroke: currentColor; stroke-opacity: 0.14; }
  .g-fill { stroke: currentColor; stroke-opacity: 0.42; }
  .g-fill.warn { stroke: var(--ag-warn); stroke-opacity: 0.7; }
  .g-fill.err { stroke: var(--ag-err); stroke-opacity: 0.8; }
  .g-dot { fill: var(--ag-on); }
  .g-dot.warn { fill: var(--ag-warn); }
  .g-dot.err { fill: var(--ag-err); }
  .g-num {
    position: absolute;
    left: 0;
    right: 0;
    transform: translateY(-50%);
    text-align: center;
    line-height: 1;
    font-weight: 500;
    letter-spacing: -0.04em;
    font-variant-numeric: tabular-nums;
    color: var(--ag-on);
  }
  .g-num small { font-size: 0.68em; letter-spacing: 0; margin-left: 0.04em; }
  .g-num { transition: opacity 0.3s cubic-bezier(0.2, 0, 0, 1) 0.12s; }
  .g-num.none { opacity: 0; transition: none; }
  .g-num.warn { color: var(--ag-warn); }
  .g-num.err { color: var(--ag-err); }
  .g-ico {
    position: absolute;
    left: 50%;
    transform: translate(-50%, -50%) scale(var(--g-ico-s, 1));
    display: inline-flex;
    color: var(--ag-on-dim);
    transition: top 0.45s cubic-bezier(0.2, 0, 0, 1), transform 0.45s cubic-bezier(0.2, 0, 0, 1), color 0.3s;
  }
  .g-ico.solo { color: var(--ag-on-sub); }
  @media (prefers-reduced-motion: reduce) {
    .g-ico, .g-num { transition: none; }
  }
</style>
