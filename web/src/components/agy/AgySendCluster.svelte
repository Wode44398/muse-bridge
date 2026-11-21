<script>
  // 输入框右端：开口仪表（children）+ 从仪表里「分身」出来的发送 / 停止键。Material 3 Expressive 动效：
  //   出现：仪表被顶得一缩（scale 弹簧带初速度）→ 让出位置（槽宽弹簧把它往左挤）；按钮从仪表环沿身后探出，
  //         以 9 瓣「曲奇」形边转边长大，落位时收成正圆（形状 / 尺寸 / 旋转各一根弹簧，节奏错开）；
  //         身子出来一半后箭头从下方升起（位移弹簧带回弹，透明度临界阻尼）。
  //   发送 → 停止：箭头向上「发射」飞走，圆形扭一下变成 M3 圆角方（超椭圆指数弹簧，欠阻尼所以有软糯感），停止方块弹出。
  //   停止 → 发送（有草稿时这一轮结束）：反过来，方块缩掉、身子回圆、箭头从下方升上来。
  //   收起：图标先退，身子转回曲奇形、缩小、退回仪表身后，槽宽归零，仪表回位时轻轻一弹（吸收）。
  //   按下：身子被按扁成更方的圆角方，松手弹回（M3 Expressive 按压形变）。
  // 槽宽是唯一走布局的量；其余只改 transform / opacity / 一条 SVG path。全部弹簧停稳即停 rAF。
  import { onDestroy, untrack } from 'svelte';
  import { Spring, stepAll, blobPath } from '../../lib/agy/springs.js';
  import { t } from '../../lib/i18n.js';
  import { haptic } from '../../lib/dragdrop.svelte.js';

  const { show = false, busy = false, disabled = false, sendLabel = '', onsend, onstop, children } = $props();

  const SLOT = 36;         // 32 键 + 4 缝
  const HOME = -16;        // 键心相对槽右缘
  const GAUGE_HALF = 18;   // 仪表按钮半宽
  const R_SEND = 16, R_STOP = 14.5, R_SEED = 7;
  const P_CIRCLE = 2, P_STOP = 3.4;
  const LOBES = 9, A_SEED = 0.13, ROT_SEED = -75;

  // M3 Expressive：spatial 用欠阻尼、effects 用临界阻尼
  const W = new Spring(0, 520, 0.8);       // 槽宽：把仪表挤开
  const S = new Spring(0, 560, 0.82);      // 身子从仪表心走到落位的进度
  const R = new Spring(R_SEED, 620, 0.66); // 身子大小：落位时带一点回弹（≈5%）
  const P = new Spring(P_CIRCLE, 620, 0.5);// 超椭圆指数：圆 ⇄ 圆角方，欠阻尼 → 软糯
  const A = new Spring(A_SEED, 560, 0.92); // 曲奇瓣幅度：身子露全之前就基本收圆
  const ROT = new Spring(ROT_SEED, 420, 0.8);
  const AO = new Spring(0, 1600, 1);       // 箭头透明度（effects）
  const AY = new Spring(8, 900, 0.62);     // 箭头位移（spatial，向上落位略过冲）
  const SS = new Spring(0, 900, 0.6);      // 停止方块缩放
  const GK = new Spring(1, 700, 0.42);     // 仪表被顶 / 吸收时的形变
  const ALL = [W, S, R, P, A, ROT, AO, AY, SS, GK];

  let mounted = $state(false);
  let frame = $state({ w: 0, x: 0, d: '', ao: 0, ay: 8, ss: 0, gk: 1 });
  let pressed = $state(false);
  let leaving = $state(false);   // 收起途中冻结外观（草稿清空会让 disabled 立刻变真，别让它先变灰再缩回）
  let visStop = $state(false);  // 按钮当前显示成停止键吗（收起途中不跟 busy 变）
  let raf = 0, last = 0;
  let phase = 'idle';          // 'enter' | 'shown' | 'leave' | 'idle'
  let iconsArmed = false, retreatArmed = false, absorbed = false;
  let first = true;
  let prevBusy = untrack(() => busy);   // 只记初值，之后在 effect 里比对

  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

  function render() {
    const w = Math.max(0, W.x);
    // 键心（相对槽右缘）：从仪表心出发，被仪表让出的位置推着走；不越过落位（再右就顶到输入框边）
    const x = Math.min(-(w + GAUGE_HALF) + (SLOT + 2) * S.x, HOME);
    frame = {
      w,
      x: x - HOME,
      d: blobPath(R.x, P.x, A.x, LOBES, ROT.x),
      ao: Math.max(0, Math.min(1, AO.x)),
      ay: AY.x,
      ss: Math.max(0, SS.x),
      gk: GK.x,
    };
  }

  function loop(ts) {
    const dt = last ? (ts - last) / 1000 : 1 / 60;
    last = ts;
    // 整段放慢 25%（维护者 11-19）：弹簧形态不变，只把时间轴拉长到 ×1.25
    stepAll(ALL, dt * 0.8);
    // 编排闸门：身子出来过半才亮图标；收起时图标退得差不多了身子才回撤
    if (phase === 'enter' && !iconsArmed && S.x > 0.42) { iconsArmed = true; armIcons(); }
    if (phase === 'leave' && !retreatArmed && AO.x < 0.35 && SS.x < 0.35) { retreatArmed = true; armRetreat(); }
    if (phase === 'leave' && retreatArmed && !absorbed && S.x < 0.18) { absorbed = true; GK.kick(1.6); }
    render();
    if (ALL.every((s) => s.settled())) {
      raf = 0; last = 0;
      if (phase === 'leave') { phase = 'idle'; mounted = false; leaving = false; }
      else if (phase === 'enter') phase = 'shown';
      return;
    }
    raf = requestAnimationFrame(loop);
  }
  function run() { if (!raf) { last = 0; raf = requestAnimationFrame(loop); } }

  function bodyTargets() {
    R.to(busy ? R_STOP : R_SEND);
    P.to(busy ? P_STOP : P_CIRCLE);
  }
  function armIcons() {
    AO.tune(1600, 1);
    if (busy) { SS.to(1); AO.to(0); }
    else { AO.to(1); AY.to(0); SS.to(0); }
  }
  function armRetreat() {
    W.to(0); S.to(0); R.to(R_SEED); P.to(P_CIRCLE); A.to(A_SEED); ROT.to(ROT_SEED * 0.7);
  }

  function enter() {
    if (!mounted) {
      mounted = true;
      W.jump(0); S.jump(0); R.jump(R_SEED); P.jump(P_CIRCLE); A.jump(A_SEED); ROT.jump(ROT_SEED);
      AO.jump(0); AY.jump(8); SS.jump(0);
      GK.kick(-2.4);           // 仪表被顶一下
    }
    phase = 'enter'; iconsArmed = false; retreatArmed = false; absorbed = false; leaving = false; visStop = busy;
    W.to(SLOT); S.to(1); A.to(0); ROT.to(0); bodyTargets();
    if (S.x > 0.42) { iconsArmed = true; armIcons(); }
    run();
  }
  function leave() {
    leaving = true;
    phase = 'leave'; retreatArmed = false; absorbed = false;
    AO.to(0); AY.to(6); SS.to(0);
    run();
  }

  function snapTo(on) {
    mounted = on; leaving = false; visStop = on && busy;
    phase = on ? 'shown' : 'idle';
    W.jump(on ? SLOT : 0); S.jump(on ? 1 : 0); A.jump(on ? 0 : A_SEED); ROT.jump(on ? 0 : ROT_SEED);
    R.jump(on ? (busy ? R_STOP : R_SEND) : R_SEED); P.jump(on && busy ? P_STOP : P_CIRCLE);
    AO.jump(on && !busy ? 1 : 0); AY.jump(0); SS.jump(on && busy ? 1 : 0); GK.jump(1);
    render();
  }

  $effect(() => {
    const on = show;
    untrack(() => {
      if (first) { first = false; snapTo(on); return; }   // 首次挂载（如打开时就在跑）直接到位，不演入场
      if (reduced()) { snapTo(on); return; }
      if (on && (phase === 'idle' || phase === 'leave')) enter();
      else if (!on && (phase === 'enter' || phase === 'shown')) leave();
    });
  });

  // 在场时 发送 ⇄ 停止：形状变形 + 图标换场
  $effect(() => {
    const b = busy;
    untrack(() => onBusy(b));
  });
  function onBusy(b) {
    if (b === prevBusy) return;
    prevBusy = b;
    if (!mounted || phase === 'leave') return;
    visStop = b;
    if (reduced()) { snapTo(true); return; }
    bodyTargets();
    if (b) {
      AO.tune(3200, 1).to(0); AY.to(-20); AY.kick(-140);  // 箭头向上发射（快、被键身裁掉）
      SS.to(1);
      ROT.kick(260);                       // 变方时扭一下
    } else {
      SS.to(0);
      AY.jump(9); AO.tune(1600, 1).to(1); AY.to(0);      // 箭头从下方升起
      ROT.kick(-200);
    }
    run();
  }

  // 按压形变：更方、略小，松手弹回
  $effect(() => {
    const pr = pressed;
    untrack(() => {
      if (!mounted || phase === 'leave') return;
      if (pr) { P.to((busy ? P_STOP : P_CIRCLE) + 0.9); R.to((busy ? R_STOP : R_SEND) - 1.2); }
      else bodyTargets();
      run();
    });
  });

  onDestroy(() => { if (raf) cancelAnimationFrame(raf); });

  function onClick() {
    if (busy) { haptic('light'); onstop?.(); }
    else if (!disabled) { haptic('light'); onsend?.(); }
  }
</script>

<div class="agy-act">
  <div class="g-wrap" style:transform="scale({frame.gk})">{@render children?.()}</div>
  {#if mounted}
    <div class="slot" style:width="{frame.w}px">
      <button
        type="button"
        class="bud"
        class:stop={visStop}
        class:disabled={!leaving && disabled && !busy}
        style:transform="translateX({frame.x}px)"
        disabled={leaving || (disabled && !busy)}
        onclick={onClick}
        onpointerdown={() => { pressed = true; }}
        onpointerup={() => { pressed = false; }}
        onpointerleave={() => { pressed = false; }}
        onpointercancel={() => { pressed = false; }}
        aria-label={visStop ? t('停止生成') : (sendLabel || t('发送'))}
        title={visStop ? t('停止生成') : (sendLabel || t('发送'))}
      >
        <svg class="body" viewBox="-24 -24 48 48" aria-hidden="true"><path d={frame.d} /></svg>
        <span class="ic-clip" aria-hidden="true">
          <span class="msr5 ic-arrow" style:opacity={frame.ao} style:transform="translateY({frame.ay}px)">arrow_upward</span>
          <span class="ic-stop" style:transform="scale({frame.ss})" style:opacity={Math.min(1, frame.ss * 1.6)}></span>
        </span>
      </button>
    </div>
  {/if}
</div>

<style>
  .agy-act {
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  /* 手机档：仪表与发送键整簇等比放大（内部几何是按 34 / 32 写死的弹簧参数，整簇缩放不动它们）→ 仪表 38、发送键 36 */
  :global(.agy-root.ag-compact) .agy-act { zoom: 1.12; }
  /* 仪表叠在槽上面；它的按钮自带只盖住环内的不透明圆底，按钮身子从环沿后面探出 */
  .g-wrap {
    position: relative;
    z-index: 2;
    display: inline-flex;
    flex: none;
  }
  .slot {
    position: relative;
    z-index: 1;
    height: 32px;
    flex: none;
  }
  .bud {
    position: absolute;
    right: 0;
    top: 0;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    background: none;
    display: grid;
    place-items: center;
    color: #fff;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .body {
    position: absolute;
    left: -8px;
    top: -8px;
    width: 48px;
    height: 48px;
    overflow: visible;
    pointer-events: none;
  }
  .body path {
    fill: var(--ag-accent-fill);
    transition: fill var(--ag-dur-quick) var(--ag-ease-std);
  }
  .bud.stop { color: var(--ag-bg); }
  .bud.stop .body path { fill: var(--ag-on); }
  .bud.disabled { color: var(--ag-on-low); cursor: default; }
  .bud.disabled .body path { fill: var(--ag-surface-2); }
  .bud:not(.disabled):not(.stop):hover .body path { fill: var(--ag-accent-strong); }
  .bud:focus-visible { outline: none; }
  .bud:focus-visible .body path { stroke: var(--ag-accent-bd); stroke-width: 3; paint-order: stroke; }
  /* 图标裁在键身里：发送后箭头从顶上「射」出去，不会飘到按钮外面 */
  .ic-clip {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    border-radius: 50%;
    overflow: hidden;
    pointer-events: none;
  }
  .ic-arrow {
    position: relative;
    grid-area: 1 / 1;
    font-size: 20px;
    line-height: 1;
    will-change: transform, opacity;
  }
  .ic-stop {
    position: relative;
    grid-area: 1 / 1;
    width: 10px;
    height: 10px;
    border-radius: 2.5px;
    background: currentColor;
  }
</style>
