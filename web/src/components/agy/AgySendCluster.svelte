<script>
  // 输入框右端操作簇：
  //   1. 既有打字 / 运行态（Material 3 Expressive 动效）：开口仪表（children）+ 向右「分身」出的 9 瓣曲奇发送 / 停止键；
  //   2. 原生语音输入态（空输入框空闲时，长按开口仪表）：
  //      · 50–260ms：仪表轻压、270° 轨顺时针扫出强调色蓄力弧；260ms 前松手立刻回弹并照常弹开模式菜单；
  //      · ≥260ms：仪表向心收拢原地化为按住录音圆角方（超椭圆 p≈2.9 + 精绘麦克风 + 胶囊内三道声能柱 + 外柔光环），
  //        同时左侧经解析二次贝塞尔矢量液桥分身出取消键（× 双笔触错拍渐绘）；
  //      · 向左拖拽：按住键 0.25× 橡皮筋跟手拉扯，取消键外圈细环顺时针收满、向右磁吸迎靠、× 微旋上膛；
  //        跨过 68px 阈值（滞回 53px 防边界抖动）锁定珊瑚红软角方 + 确认余波环，按住键褪蓝让位；
  //      · 取消松手：取消键干脆一捏、× 收心，经反向液桥吸回右端并还原 270° 开口仪表；
  //      · 发送松手：取消键快撤，按住键发射脉冲并无缝原地接力为 M3 停止方块，开口仪表平滑让回左侧。
  // 全部弹簧停稳即自停 rAF，零空转；完整支持 prefers-reduced-motion 与 .ag-compact zoom:1.12 坐标换算。
  import { onDestroy, untrack } from 'svelte';
  import { Spring, stepAll, blobPath, metaballBridge } from '../../lib/agy/springs.js';
  import { t } from '../../lib/i18n.js';
  import { haptic } from '../../lib/dragdrop.svelte.js';

  const {
    show = false,
    busy = false,
    disabled = false,
    sendLabel = '',
    voiceEnabled = false,
    onsend,
    onstop,
    onGaugeTap,
    onVoiceBegin,
    onVoiceCancel,
    onVoiceSend,
    onVoiceState,
    sampleVoiceLevel,
    onVoiceWaveFrame,
    children,
  } = $props();

  const uid = 'avc' + Math.random().toString(36).slice(2, 8);

  // —— 既有右侧发送 / 停止键常量 ——
  const SLOT = 36;         // 32 键 + 4 缝
  const HOME = -16;        // 键心相对槽右缘
  const GAUGE_HALF = 18;   // 仪表按钮半宽
  const R_SEND = 16, R_STOP = 14.5, R_SEED = 7;
  const P_CIRCLE = 2, P_STOP = 3.4;
  const LOBES = 9, A_SEED = 0.13, ROT_SEED = -75;

  // —— 语音与左侧取消分身常量 ——
  const HOLD_MS = 260;
  const CHARGE_DELAY_MS = 50;
  const CANCEL_DIST = 54;
  const DRAG_TRIGGER_PX = 68;
  const DRAG_RELEASE_PX = 53;
  const MIN_SEND_SEC = 0.35;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, k) => a + (b - a) * k;
  function lerpRGB(a, b, k) {
    const t01 = clamp(k, 0, 1);
    return `rgb(${Math.round(lerp(a[0], b[0], t01))} ${Math.round(lerp(a[1], b[1], t01))} ${Math.round(lerp(a[2], b[2], t01))})`;
  }
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

  // —— 既有发送 / 停止键弹簧 ——
  const W = new Spring(0, 520, 0.8);
  const S = new Spring(0, 560, 0.82);
  const R = new Spring(R_SEED, 620, 0.66);
  const P = new Spring(P_CIRCLE, 620, 0.5);
  const A = new Spring(A_SEED, 560, 0.92);
  const ROT = new Spring(ROT_SEED, 420, 0.8);
  const AO = new Spring(0, 1600, 1);
  const AY = new Spring(8, 900, 0.62);
  const SS = new Spring(0, 900, 0.6);
  const GK = new Spring(1, 700, 0.44);

  // —— 语音按住键 & 仪表过渡弹簧 ——
  const G_OP = new Spring(1, 2200, 1);
  const G_SC = new Spring(1, 680, 0.72);
  const H_R = new Spring(0, 620, 0.64);
  const H_P = new Spring(2.0, 560, 0.56);
  const H_A = new Spring(0.08, 520, 0.85);
  const H_ROT = new Spring(-40, 440, 0.8);
  const H_X = new Spring(0, 520, 0.74);
  const H_COOL = new Spring(0, 1400, 1);
  const MIC_O = new Spring(0, 1800, 1);
  const MIC_S = new Spring(0.55, 760, 0.62);
  const MIC_Y = new Spring(5, 760, 0.64);
  const LA_O = new Spring(0, 2400, 1);
  const LA_Y = new Spring(10, 820, 0.65);

  // —— 左侧取消分身弹簧 ——
  const C_SLOT = new Spring(0, 520, 0.82);
  const C_SEP = new Spring(0, 520, 0.74);
  const C_R = new Spring(0, 640, 0.62);
  const C_P = new Spring(2.0, 560, 0.5);
  const C_A = new Spring(0.09, 540, 0.86);
  const C_ROT = new Spring(48, 440, 0.78);
  const C_HOT = new Spring(0, 1600, 1);
  const C_MAG = new Spring(0, 600, 0.68);
  const X_DRAW = new Spring(0, 920, 0.78);
  const X_ROT = new Spring(-36, 620, 0.64);
  const X_SC = new Spring(0.82, 680, 0.6);

  const ALL = [
    W, S, R, P, A, ROT, AO, AY, SS, GK,
    G_OP, G_SC, H_R, H_P, H_A, H_ROT, H_X, H_COOL, MIC_O, MIC_S, MIC_Y, LA_O, LA_Y,
    C_SLOT, C_SEP, C_R, C_P, C_A, C_ROT, C_HOT, C_MAG, X_DRAW, X_ROT, X_SC,
  ];

  let rootEl = $state(null);
  let gaugeWrapEl = $state(null);

  let mounted = $state(false);
  let pressed = $state(false);
  let leaving = $state(false);
  let visStop = $state(false);

  // 语音交互态：'idle' | 'charging' | 'recording' | 'cancelling' | 'sending'
  let voicePhase = $state('idle');
  let voiceActiveVisual = $state(false);
  let chargeProg = $state(0);
  let cancelArmed = $state(false);

  let frame = $state({
    // 既有发送/停止键
    w: 0, x: 0, d: '', ao: 0, ay: 8, ss: 0,
    // 仪表本体
    gScale: 1, gOp: 1,
    // 左侧取消槽
    cSlot: 0,
    // 语音矢量层
    kx: 0, kr: 0, heldD: '', heldInnerD: '', heldFill: '#2f80ed', heldInk: '#ffffff', heldInnerOp: 0,
    haloR: 18, haloOp: 0, haloFillR: 17, haloFillOp: 0,
    cx: -CANCEL_DIST, cr: 0, cancelD: '', cancelFill: '#262626', cancelInk: '#a0a0a0', cancelRimOp: 0,
    bridgeD: '', bridgeOp: 0,
    progDash: '0 120', progOp: 0,
    echoR: 17.5, echoOp: 0,
    micO: 0, micY: 5, micS: 0.55, b0: 0.7, b1: 1, b2: 0.7,
    laO: 0, laY: 10,
    xRot: -36, xSc: 0.82, xOp: 0, xOff1: 14, xOff2: 14,
  });

  let raf = 0, last = 0;
  let phase = 'idle';          // 'enter' | 'shown' | 'leave' | 'idle'
  let iconsArmed = false, retreatArmed = false, absorbed = false;
  let first = true;
  let prevBusy = untrack(() => busy);

  let holdStartTs = 0;
  let recElapsedMs = 0;
  let dragX = 0;
  let pull = 0;
  let echoAge = 99;
  let micPulse = 0;
  let activePointerId = null;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let pointerScale = 1;
  let suppressClickUntil = 0;
  let cancelConfirmTimer = 0;
  let sendHandoffTimer = 0;
  let lastNotifiedSec = -1;
  let sendGen = 0;

  function isLightTheme() {
    try { return Boolean(rootEl?.closest?.('.agy-root.light')); } catch { return false; }
  }

  function palette() {
    return isLightTheme()
      ? {
          accent: [47, 128, 237],
          mutedKey: [226, 229, 234],
          mutedInk: [128, 134, 139],
          cancelRest: [236, 238, 239],
          cancelTint: [252, 232, 230],
          cancelHot: [217, 48, 37],
          cancelInkRest: [95, 99, 104],
          cancelInkHot: [255, 255, 255],
        }
      : {
          accent: [47, 128, 237],
          mutedKey: [42, 43, 46],
          mutedInk: [122, 122, 122],
          cancelRest: [38, 38, 40],
          cancelTint: [64, 34, 34],
          cancelHot: [219, 55, 45],
          cancelInkRest: [160, 160, 160],
          cancelInkHot: [255, 255, 255],
        };
  }

  function emitVoiceState() {
    onVoiceState?.({
      phase: voicePhase,
      cancelArmed,
      elapsedMs: recElapsedMs,
      pull,
      charge: chargeProg,
    });
  }

  function render() {
    const pal = palette();
    const w = Math.max(0, W.x);
    const x = Math.min(-(w + GAUGE_HALF) + (SLOT + 2) * S.x, HOME);

    const amp = voicePhase === 'recording' && !cancelArmed ? micPulse : 0;
    const kx = H_X.x;
    const kr = Math.max(0, H_R.x + (voicePhase === 'recording' && !cancelArmed ? amp * 1.15 : 0));
    const pullStretch = voicePhase === 'recording' ? clamp(pull, 0, 1) * 0.065 : 0;
    const heldD = kr > 0.4 ? blobPath(kr, H_P.x, H_A.x, 6, H_ROT.x, kx, 0, 1 + pullStretch, 1 - pullStretch * 0.55) : '';
    const heldInnerD = kr > 8 ? blobPath(kr - 1.35, H_P.x, H_A.x * 0.5, 6, H_ROT.x, kx, 0, 1 + pullStretch, 1 - pullStretch * 0.55) : '';
    const heldFill = lerpRGB(pal.accent, pal.mutedKey, H_COOL.x);
    const heldInk = lerpRGB([255, 255, 255], pal.mutedInk, H_COOL.x);

    const sep = clamp(C_SEP.x, 0, 1.15);
    const cx = -CANCEL_DIST * sep + C_MAG.x + kx * 0.14;
    const cr = Math.max(0, C_R.x);
    const cancelD = cr > 0.4 ? blobPath(cr, C_P.x, C_A.x, 8, C_ROT.x, cx, 0) : '';
    const hot = clamp(C_HOT.x, 0, 1);
    const cancelFill = hot < 0.35
      ? lerpRGB(pal.cancelRest, pal.cancelTint, hot / 0.35)
      : lerpRGB(pal.cancelTint, pal.cancelHot, (hot - 0.35) / 0.65);
    const cancelInk = lerpRGB(pal.cancelInkRest, pal.cancelInkHot, clamp((hot - 0.25) / 0.55, 0, 1));

    const bridgeStrength = sep > 0.04 && sep < 0.82 && kr > 5 && cr > 4
      ? Math.sin(clamp((sep - 0.04) / 0.78, 0, 1) * Math.PI) * (1 - clamp((sep - 0.38) / 0.44, 0, 1) * 0.72)
      : 0;
    const bridgeD = metaballBridge(kx, kr * 0.94, cx, cr * 0.94, bridgeStrength);

    const progCircum = 2 * Math.PI * 18.2;
    const pull01 = voicePhase === 'recording' ? clamp(pull, 0, 1) : 0;
    const progDash = `${(pull01 * progCircum).toFixed(2)} ${progCircum.toFixed(2)}`;
    const progOp = voicePhase === 'recording' && pull01 > 0.04 && !cancelArmed ? clamp(pull01 * 1.15, 0, 0.92) : 0;

    const echoT = clamp(echoAge / 0.34, 0, 1);
    const echoR = 17.5 + echoT * 11;
    const echoOp = echoT < 1 ? (1 - echoT) * (1 - echoT) * 0.52 : 0;

    const haloCalm = 1 - pull01 * 0.68;
    const haloR = kr + (1.8 + amp * 6.2) * haloCalm;
    const haloOp = voicePhase === 'recording' && !cancelArmed && kr > 10
      ? (0.14 + amp * 0.26) * (1 - H_COOL.x) * haloCalm
      : 0;

    const xd = clamp(X_DRAW.x, 0, 1);
    const xd1 = clamp(xd / 0.82, 0, 1);
    const xd2 = clamp((xd - 0.18) / 0.82, 0, 1);

    voiceActiveVisual = voicePhase !== 'idle' || kr > 0.4 || cr > 0.4 || C_SLOT.x > 0.5 || echoOp > 0.01;

    frame = {
      w,
      x: x - HOME,
      d: mounted ? blobPath(R.x, P.x, A.x, LOBES, ROT.x) : '',
      ao: clamp(AO.x, 0, 1),
      ay: AY.x,
      ss: Math.max(0, SS.x),
      gScale: GK.x * G_SC.x,
      gOp: clamp(G_OP.x, 0, 1),
      cSlot: Math.max(0, C_SLOT.x),
      kx,
      kr,
      heldD,
      heldInnerD,
      heldFill,
      heldInk,
      heldInnerOp: kr > 10 ? 0.85 * (1 - H_COOL.x * 0.75) : 0,
      haloR,
      haloOp: haloOp * 0.85,
      haloFillR: kr + amp * 4.2,
      haloFillOp: haloOp * 0.42,
      cx,
      cr,
      cancelD,
      cancelFill,
      cancelInk,
      cancelRimOp: cr > 8 && hot < 0.4 ? 1 : 0,
      bridgeD,
      bridgeOp: bridgeStrength > 0.02 ? Math.min(0.95, bridgeStrength * 1.4) : 0,
      progDash,
      progOp,
      echoR,
      echoOp,
      micO: clamp(MIC_O.x, 0, 1),
      micY: MIC_Y.x,
      micS: Math.max(0.2, MIC_S.x),
      b0: 0.7 + amp * 2.1,
      b1: 1.0 + amp * 2.9,
      b2: 0.7 + amp * 1.85,
      laO: clamp(LA_O.x, 0, 1),
      laY: LA_Y.x,
      xRot: X_ROT.x,
      xSc: Math.max(0.2, X_SC.x),
      xOp: cr > 6 && xd > 0.02 ? clamp(xd * 1.4, 0, 1) : 0,
      xOff1: (1 - xd1) * 14,
      xOff2: (1 - xd2) * 14,
    };
  }

  function loop(ts) {
    const dt = last ? Math.min(0.05, (ts - last) / 1000) : 1 / 60;
    last = ts;

    // 推进长按蓄力（50ms 死区 → 260ms 触发录音）
    if (voicePhase === 'charging') {
      const elapsed = ts - holdStartTs;
      if (elapsed >= HOLD_MS) {
        igniteRecording();
      } else if (elapsed > CHARGE_DELAY_MS) {
        const raw = (elapsed - CHARGE_DELAY_MS) / (HOLD_MS - CHARGE_DELAY_MS);
        chargeProg = clamp(raw * raw * (2 - raw), 0, 1);
        emitVoiceState();
      }
    }

    // 推进录音计时、音量采样与声波 Canvas 绘制
    if (voicePhase === 'recording') {
      recElapsedMs += dt * 1000;
      const curSec = Math.floor(recElapsedMs / 1000);
      if (curSec !== lastNotifiedSec) {
        lastNotifiedSec = curSec;
        emitVoiceState();
      }
      micPulse = sampleVoiceLevel ? Number(sampleVoiceLevel(dt, cancelArmed)) || 0 : 0;
      onVoiceWaveFrame?.(micPulse, dt, cancelArmed);
    }

    if (echoAge < 1) echoAge += dt;

    // 既有放慢 20% 弹簧时间感（与 AgySendCluster 一致）
    stepAll(ALL, dt * 0.82);

    // 既有发送键编排闸门
    if (phase === 'enter' && !iconsArmed && S.x > 0.42) { iconsArmed = true; armIcons(); }
    if (phase === 'leave' && !retreatArmed && AO.x < 0.35 && SS.x < 0.35) { retreatArmed = true; armRetreat(); }
    if (phase === 'leave' && retreatArmed && !absorbed && S.x < 0.18) { absorbed = true; GK.kick(1.6); }

    render();

    const springsDone = ALL.every((s) => s.settled());
    if (springsDone) {
      if (phase === 'leave') { phase = 'idle'; mounted = false; leaving = false; }
      else if (phase === 'enter') phase = 'shown';
    }

    const keepRunning =
      !springsDone
      || voicePhase === 'charging'
      || voicePhase === 'recording'
      || voicePhase === 'cancelling'
      || voicePhase === 'sending'
      || echoAge < 0.4;

    if (keepRunning) {
      raf = requestAnimationFrame(loop);
    } else {
      raf = 0; last = 0;
    }
  }
  function run() { if (!raf) { last = 0; raf = requestAnimationFrame(loop); } }

  // —— 既有右侧发送 / 停止键动作 ——
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
      GK.kick(-2.4);
    }
    phase = 'enter'; iconsArmed = false; retreatArmed = false; absorbed = false; leaving = false; visStop = busy;
    W.to(SLOT); S.to(1); A.to(0); ROT.to(0); bodyTargets();
    if (S.x > 0.42) { iconsArmed = true; armIcons(); }
    run();
  }
  function enterFromVoiceStop() {
    mounted = true;
    phase = 'enter'; iconsArmed = true; retreatArmed = false; absorbed = false; leaving = false; visStop = true;
    prevBusy = true;
    W.jump(0).to(SLOT);
    S.jump(1).to(1);
    R.jump(17).to(R_STOP);
    P.jump(2.85).to(P_STOP);
    A.jump(0).to(0);
    ROT.jump(0).kick(180).to(0);
    AO.jump(0).to(0);
    AY.jump(-18).to(-18);
    SS.jump(0).to(1);
    if (reduced()) snapTo(true);
    else run();
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
      if (first) { first = false; snapTo(on); return; }
      if (voicePhase !== 'idle') return;
      if (reduced()) { snapTo(on); return; }
      if (on && (phase === 'idle' || phase === 'leave')) enter();
      else if (!on && (phase === 'enter' || phase === 'shown')) leave();
    });
  });

  $effect(() => {
    const b = busy;
    untrack(() => onBusy(b));
  });
  function onBusy(b) {
    if (b === prevBusy) return;
    prevBusy = b;
    if (!mounted || phase === 'leave' || voicePhase !== 'idle') return;
    visStop = b;
    if (reduced()) { snapTo(true); return; }
    bodyTargets();
    if (b) {
      AO.tune(3200, 1).to(0); AY.to(-20); AY.kick(-140);
      SS.to(1);
      ROT.kick(260);
    } else {
      SS.to(0);
      AY.jump(9); AO.tune(1600, 1).to(1); AY.to(0);
      ROT.kick(-200);
    }
    run();
  }

  $effect(() => {
    const pr = pressed;
    untrack(() => {
      if (!mounted || phase === 'leave') return;
      if (pr) { P.to((busy ? P_STOP : P_CIRCLE) + 0.9); R.to((busy ? R_STOP : R_SEND) - 1.2); }
      else bodyTargets();
      run();
    });
  });

  // 外部状态变化（如开始打字或切会话导致 voiceEnabled 变假）：若正在蓄力或录音则安全撤回
  $effect(() => {
    const ok = voiceEnabled;
    untrack(() => {
      if (!ok && voicePhase === 'charging') abortChargeToClick();
    });
  });

  // —— 语音动作编排 ——
  function startCharging() {
    if (!voiceEnabled || voicePhase !== 'idle') return;
    clearTimeout(cancelConfirmTimer);
    clearTimeout(sendHandoffTimer);
    voicePhase = 'charging';
    holdStartTs = performance.now();
    chargeProg = 0;
    dragX = 0;
    pull = 0;
    cancelArmed = false;
    GK.to(0.91);
    emitVoiceState();
    run();
  }

  function abortChargeToClick() {
    voicePhase = 'idle';
    chargeProg = 0;
    dragX = 0;
    pull = 0;
    cancelArmed = false;
    GK.to(1).kick(1.4);
    G_OP.to(1);
    G_SC.to(1);
    emitVoiceState();
    run();
  }

  function igniteRecording() {
    if (voicePhase !== 'charging') return;
    voicePhase = 'recording';
    chargeProg = 1;
    recElapsedMs = 0;
    lastNotifiedSec = 0;
    dragX = 0;
    pull = 0;
    cancelArmed = false;
    haptic('click');

    GK.to(1).kick(-1.9);
    G_OP.tune(2600, 1).to(0);
    G_SC.to(0.68);

    H_R.jump(6.5).to(17.4);
    H_P.jump(2.0).to(2.9);
    H_A.jump(0.085).to(0);
    H_ROT.jump(-38).to(0);
    H_X.jump(0).to(0);
    H_COOL.jump(0).to(0);

    MIC_O.tune(1800, 1).jump(0).to(1);
    MIC_S.jump(0.55).to(1);
    MIC_Y.jump(5).to(0);
    LA_O.jump(0); LA_Y.jump(10);

    C_SLOT.jump(0).to(56);
    C_SEP.jump(0).to(1);
    C_R.jump(5.5).to(15.2);
    C_P.jump(2.0).to(2.0);
    C_A.jump(0.095).to(0);
    C_ROT.jump(52).to(0);
    C_HOT.jump(0).to(0);
    C_MAG.jump(0).to(0);
    X_DRAW.jump(0).to(1);
    X_ROT.jump(-42).to(0);
    X_SC.jump(0.75).to(1);

    if (reduced()) {
      G_OP.jump(0); G_SC.jump(0.68);
      H_R.jump(17.4); H_P.jump(2.9); H_A.jump(0); H_ROT.jump(0);
      MIC_O.jump(1); MIC_S.jump(1); MIC_Y.jump(0);
      C_SLOT.jump(56); C_SEP.jump(1); C_R.jump(15.2); C_A.jump(0); C_ROT.jump(0);
      X_DRAW.jump(1); X_ROT.jump(0); X_SC.jump(1);
    }

    emitVoiceState();
    onVoiceBegin?.();
    run();
  }

  function updateDrag(dx) {
    if (voicePhase !== 'recording') return;
    dragX = Math.min(0, dx);
    const absD = -dragX;
    const rawPull = clamp(absD / DRAG_TRIGGER_PX, 0, 1.32);
    pull = rawPull;

    const wasArmed = cancelArmed;
    if (!wasArmed && absD >= DRAG_TRIGGER_PX) cancelArmed = true;
    else if (wasArmed && absD < DRAG_RELEASE_PX) cancelArmed = false;

    const p01 = clamp(rawPull, 0, 1);
    const rubber = -Math.min(18, absD * 0.25 - (absD > 50 ? (absD - 50) * 0.08 : 0));
    H_X.to(cancelArmed ? rubber * 0.72 : rubber);

    if (cancelArmed) {
      if (!wasArmed) {
        echoAge = 0;
        C_R.kick(42);
        C_A.jump(0.055).to(0);
        X_SC.kick(2.4);
        haptic('heavy');
      }
      C_R.to(18.6);
      C_P.to(3.25);
      C_HOT.to(1);
      C_MAG.to(5.5);
      X_ROT.to(0);
      X_SC.to(1.12);

      H_R.to(14.8);
      H_P.to(2.15);
      H_COOL.to(1);
      MIC_S.to(0.84);
    } else {
      if (wasArmed) haptic('tick');
      C_R.to(15.2 + p01 * 2.1);
      C_P.to(2.0 + p01 * 0.35);
      C_HOT.to(p01 * 0.28);
      C_MAG.to(p01 * 4.2);
      X_ROT.to(-p01 * 22);
      X_SC.to(1 + p01 * 0.05);

      H_R.to(17.4 - p01 * 0.9);
      H_P.to(2.9 - p01 * 0.3);
      H_COOL.to(p01 * 0.22);
      MIC_S.to(1 - p01 * 0.06);
    }

    if (wasArmed !== cancelArmed) emitVoiceState();
    run();
  }

  function restoreGaugeFromVoice() {
    C_SEP.to(0);
    C_SLOT.to(0);
    C_R.to(0);
    C_P.to(2.0);
    C_A.to(0.08);
    C_ROT.to(42);
    C_HOT.to(0);
    C_MAG.to(0);
    X_DRAW.to(0);

    H_R.to(0);
    H_X.to(0);
    H_P.to(2.0);
    H_COOL.to(0);
    MIC_O.tune(2600, 1).to(0);
    LA_O.to(0);

    G_OP.tune(1400, 1).to(1);
    G_SC.to(1);
    GK.to(1).kick(1.9);

    chargeProg = 0;
    pull = 0;
    dragX = 0;
    cancelArmed = false;
    voicePhase = 'idle';
    emitVoiceState();
    if (show) {
      if (reduced()) snapTo(true);
      else enter();
    } else {
      run();
    }
  }

  function finishRecordingCancel({ reason = 'cancel', notify = true } = {}) {
    if (voicePhase !== 'recording') return;
    voicePhase = 'cancelling';
    if (notify) onVoiceCancel?.({ reason });
    clearTimeout(cancelConfirmTimer);
    emitVoiceState();

    C_R.to(14.5).kick(-32);
    X_DRAW.to(0);
    X_SC.to(0.65);
    MIC_O.tune(2600, 1).to(0);
    MIC_S.to(0.6);

    const delay = reduced() ? 0 : 85;
    cancelConfirmTimer = setTimeout(() => {
      restoreGaugeFromVoice();
    }, delay);
    run();
  }

  function finishRecordingSend() {
    if (voicePhase !== 'recording') return;
    const durSec = Math.max(0.1, recElapsedMs / 1000);
    if (durSec < MIN_SEND_SEC) {
      finishRecordingCancel({ reason: 'short' });
      return;
    }

    voicePhase = 'sending';
    haptic('click');
    emitVoiceState();

    C_SEP.to(0);
    C_SLOT.to(0);
    C_R.to(0);
    C_HOT.to(0);
    C_MAG.to(0);
    X_DRAW.to(0);

    H_X.to(0);
    H_COOL.to(0);
    H_R.to(16.2).kick(24);
    H_P.to(2.0);
    MIC_O.tune(3200, 1).to(0);
    MIC_Y.to(-18).kick(-120);
    LA_O.jump(0.95).to(0);
    LA_Y.jump(8).to(-18).kick(-110);
    run();

    const myGen = ++sendGen;
    const sendPromise = Promise.resolve(onVoiceSend?.({ durSec })).catch(() => ({ ok: false }));
    const minBeat = new Promise((resolve) => {
      sendHandoffTimer = setTimeout(resolve, reduced() ? 0 : 145);
    });

    Promise.all([sendPromise, minBeat]).then(([res]) => {
      if (myGen !== sendGen || voicePhase !== 'sending') return;
      if (res?.ok && (show || busy)) {
        H_R.jump(0);
        LA_O.jump(0);
        G_OP.jump(1);
        G_SC.jump(1);
        GK.jump(1);
        chargeProg = 0;
        pull = 0;
        dragX = 0;
        cancelArmed = false;
        voicePhase = 'idle';
        emitVoiceState();
        enterFromVoiceStop();
      } else {
        restoreGaugeFromVoice();
      }
    });
  }

  let winPtrBound = false;
  function attachWindowPointer() {
    if (winPtrBound) return;
    winPtrBound = true;
    window.addEventListener('pointermove', onGaugePointerMove);
    window.addEventListener('pointerup', onGaugePointerUp);
    window.addEventListener('pointercancel', onGaugePointerCancel);
  }
  function detachWindowPointer() {
    if (!winPtrBound) return;
    winPtrBound = false;
    window.removeEventListener('pointermove', onGaugePointerMove);
    window.removeEventListener('pointerup', onGaugePointerUp);
    window.removeEventListener('pointercancel', onGaugePointerCancel);
  }

  // —— 外部命令入口（权限失败回退 / 键盘 Space·Esc / 到达最大时长自动发送 / 切后台取消）——
  export function abortVoiceToIdle() {
    activePointerId = null;
    detachWindowPointer();
    clearTimeout(cancelConfirmTimer);
    clearTimeout(sendHandoffTimer);
    sendGen += 1;
    if (voicePhase === 'idle') return;
    if (voicePhase === 'charging') abortChargeToClick();
    else restoreGaugeFromVoice();
  }

  export function cancelVoice({ animate = true, reason = 'cancel' } = {}) {
    activePointerId = null;
    detachWindowPointer();
    if (voicePhase === 'charging') {
      abortChargeToClick();
      return;
    }
    if (voicePhase === 'recording') {
      if (animate && !reduced()) {
        cancelArmed = true;
        updateDrag(-DRAG_TRIGGER_PX - 8);
        clearTimeout(cancelConfirmTimer);
        cancelConfirmTimer = setTimeout(() => {
          if (voicePhase === 'recording') finishRecordingCancel({ reason });
        }, 120);
      } else {
        finishRecordingCancel({ reason });
      }
    }
  }

  export function commitVoiceNow() {
    activePointerId = null;
    detachWindowPointer();
    if (voicePhase === 'recording') finishRecordingSend();
  }

  export function startKeyVoice() {
    if (!voiceEnabled || voicePhase !== 'idle') return false;
    startCharging();
    return true;
  }

  export function endKeyVoice() {
    if (voicePhase === 'charging') {
      abortChargeToClick();
    } else if (voicePhase === 'recording') {
      if (cancelArmed) finishRecordingCancel({ reason: 'cancel' });
      else finishRecordingSend();
    }
  }

  // —— 指针长按与左拉手势绑定在仪表外包裹上（move/up/cancel 挂 window 防止 capture 丢失卡住录音）——
  function onGaugePointerDown(ev) {
    if (!voiceEnabled || voicePhase !== 'idle') return;
    if (ev.button && ev.button !== 0) return;
    ev.preventDefault();
    activePointerId = ev.pointerId;
    pointerStartX = ev.clientX;
    pointerStartY = ev.clientY;
    const rect = gaugeWrapEl?.getBoundingClientRect?.();
    pointerScale = rect && rect.width > 0 ? rect.width / 36 : 1;
    try { gaugeWrapEl?.setPointerCapture?.(ev.pointerId); } catch {}
    attachWindowPointer();
    startCharging();
  }

  function onGaugePointerMove(ev) {
    if (activePointerId !== ev.pointerId) return;
    const dx = (ev.clientX - pointerStartX) / pointerScale;
    const dy = (ev.clientY - pointerStartY) / pointerScale;
    if (voicePhase === 'recording') {
      updateDrag(dx);
    } else if (voicePhase === 'charging' && (Math.abs(dx) > 22 || Math.abs(dy) > 28)) {
      activePointerId = null;
      detachWindowPointer();
      suppressClickUntil = performance.now() + 400;
      try { gaugeWrapEl?.releasePointerCapture?.(ev.pointerId); } catch {}
      abortChargeToClick();
    }
  }

  function onGaugePointerUp(ev) {
    if (activePointerId !== ev.pointerId) return;
    activePointerId = null;
    detachWindowPointer();
    suppressClickUntil = performance.now() + 400;
    try { gaugeWrapEl?.releasePointerCapture?.(ev.pointerId); } catch {}
    if (voicePhase === 'charging') {
      abortChargeToClick();
      const btn = gaugeWrapEl?.querySelector?.('button') || gaugeWrapEl;
      onGaugeTap?.(btn);
    } else if (voicePhase === 'recording') {
      if (cancelArmed) finishRecordingCancel({ reason: 'cancel' });
      else finishRecordingSend();
    }
  }

  function onGaugePointerCancel(ev) {
    if (activePointerId !== ev.pointerId) return;
    activePointerId = null;
    detachWindowPointer();
    suppressClickUntil = performance.now() + 400;
    if (voicePhase === 'charging') abortChargeToClick();
    else if (voicePhase === 'recording') finishRecordingCancel({ reason: 'interrupt' });
  }

  function onGaugeClickCapture(ev) {
    if (performance.now() < suppressClickUntil) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  function onGaugeContextMenu(ev) {
    if (voiceEnabled || voicePhase !== 'idle') ev.preventDefault();
  }

  onDestroy(() => {
    detachWindowPointer();
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(cancelConfirmTimer);
    clearTimeout(sendHandoffTimer);
    sendGen += 1;
    if (voicePhase === 'recording') onVoiceCancel?.({ reason: 'unmount' });
  });

  function onClick() {
    if (busy) { haptic('click'); onstop?.(); }
    else if (!disabled) { haptic('click'); onsend?.(); }
  }
</script>

<div class="agy-act" bind:this={rootEl}>
  <!-- 左侧取消分身占位槽（录音时优雅撑开宽度） -->
  {#if frame.cSlot > 0.2}
    <div class="cancel-slot" style:width="{frame.cSlot}px" aria-hidden="true"></div>
  {/if}

  <!-- 核心主位：空闲时为开口仪表；长按后原地变形为按住录音键 + 左侧液滴分身取消键 -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={gaugeWrapEl}
    class="g-wrap"
    class:voice-ready={voiceEnabled}
    class:voice-live={voicePhase !== 'idle'}
    onpointerdown={onGaugePointerDown}
    onclickcapture={onGaugeClickCapture}
    oncontextmenu={onGaugeContextMenu}
  >
    {#if voiceActiveVisual}
      <svg class="voice-svg" viewBox="-130 -46 176 92" aria-hidden="true">
        <defs>
          <linearGradient id="brg-{uid}" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color={frame.cancelFill} />
            <stop offset="100%" stop-color={frame.heldFill} />
          </linearGradient>
        </defs>
        <circle cx={frame.kx} cy="0" r={frame.haloR} fill="none" stroke="rgb(47 128 237)" stroke-width="1.5" opacity={frame.haloOp} />
        <circle cx={frame.kx} cy="0" r={frame.haloFillR} fill="rgb(47 128 237)" opacity={frame.haloFillOp} />
        <circle cx={frame.cx} cy="0" r={frame.echoR} fill="none" stroke="rgb(219 55 45)" stroke-width="1.6" opacity={frame.echoOp} />
        {#if frame.bridgeD}
          <path d={frame.bridgeD} fill="url(#brg-{uid})" opacity={frame.bridgeOp} />
        {/if}
        {#if frame.cancelD}
          <path d={frame.cancelD} fill={frame.cancelFill} />
          {#if frame.cancelRimOp > 0}
            <path d={frame.cancelD} fill="none" stroke="currentColor" stroke-opacity="0.1" stroke-width="1" opacity={frame.cancelRimOp} />
          {/if}
        {/if}
        {#if frame.progOp > 0.005}
          <circle
            cx={frame.cx}
            cy="0"
            r="18.2"
            fill="none"
            stroke="rgb(219 55 45)"
            stroke-width="1.65"
            stroke-linecap="round"
            transform="rotate(-90 {frame.cx} 0)"
            stroke-dasharray={frame.progDash}
            opacity={frame.progOp}
          />
        {/if}
        {#if frame.heldD}
          <path d={frame.heldD} fill={frame.heldFill} />
          {#if frame.heldInnerD && frame.heldInnerOp > 0.01}
            <path d={frame.heldInnerD} fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1" opacity={frame.heldInnerOp} />
          {/if}
        {/if}
      </svg>
    {/if}

    <div class="gauge-shell" style:transform="scale({frame.gScale})" style:opacity={frame.gOp}>
      {@render children?.()}
    </div>

    {#if voiceActiveVisual}
      <!-- 按住录音键图标层：精绘线性麦克风 + 胶囊内三道实时声能柱 + 发送发射箭 -->
      <div class="held-icon-layer" style:transform="translateX({frame.kx}px)" style:color={frame.heldInk} aria-hidden="true">
        <div class="held-icon-clip">
          {#if frame.micO > 0.005}
            <svg
              class="held-mic-svg"
              viewBox="0 0 24 24"
              fill="none"
              opacity={frame.micO}
              style:transform="translateY({frame.micY}px) scale({frame.micS})"
            >
              <rect x="8.6" y="3.2" width="6.8" height="10.4" rx="3.4" stroke="currentColor" stroke-width="1.85" />
              <line x1="10.6" y1={8.4 - frame.b0} x2="10.6" y2={8.4 + frame.b0} stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.88" />
              <line x1="12.0" y1={8.4 - frame.b1} x2="12.0" y2={8.4 + frame.b1} stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.96" />
              <line x1="13.4" y1={8.4 - frame.b2} x2="13.4" y2={8.4 + frame.b2} stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.88" />
              <path d="M5.6 10.6a6.4 6.4 0 0 0 12.8 0" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" />
              <path d="M12 17v3.4M9.1 20.4h5.8" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" />
            </svg>
          {/if}
          {#if frame.laO > 0.005}
            <svg
              class="launch-arrow-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.1"
              stroke-linecap="round"
              stroke-linejoin="round"
              opacity={frame.laO}
              style:transform="translateY({frame.laY}px)"
            >
              <path d="M12 19V5M6 11l6-6 6 6" />
            </svg>
          {/if}
        </div>
      </div>

      <!-- 左侧取消键双笔触 × 图标层 -->
      {#if frame.xOp > 0.005}
        <div
          class="cancel-icon-layer"
          style:transform="translateX({frame.cx}px) rotate({frame.xRot}deg) scale({frame.xSc})"
          style:opacity={frame.xOp}
          style:color={frame.cancelInk}
          aria-hidden="true"
        >
          <svg class="cancel-x-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="5.2" y1="5.2" x2="14.8" y2="14.8" stroke-dasharray="14 20" stroke-dashoffset={frame.xOff1} />
            <line x1="14.8" y1="5.2" x2="5.2" y2="14.8" stroke-dasharray="14 20" stroke-dashoffset={frame.xOff2} />
          </svg>
        </div>
      {/if}
    {/if}
  </div>

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
    position: relative;
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  /* 手机档：仪表与发送键整簇等比放大（内部几何是按 34 / 32 写死的弹簧参数，整簇缩放不动它们）→ 仪表 38、发送键 36 */
  :global(.agy-root.ag-compact) .agy-act { zoom: 1.12; }

  .cancel-slot {
    position: relative;
    height: 32px;
    flex: none;
    pointer-events: none;
  }

  /* 仪表叠在槽上面；语音长按态下允许原位变形与左侧液滴分身渲染 */
  .g-wrap {
    position: relative;
    z-index: 3;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    color: var(--ag-on);
  }
  .g-wrap.voice-ready,
  .g-wrap.voice-live {
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .g-wrap.voice-live :global(.agy-gauge-btn),
  .g-wrap.voice-live :global(.agy-gauge-btn:hover) {
    background: transparent !important;
  }

  .gauge-shell {
    position: relative;
    z-index: 3;
    display: inline-flex;
    will-change: transform, opacity;
  }

  .voice-svg {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 176px;
    height: 92px;
    margin-left: -130px;
    margin-top: -46px;
    overflow: visible;
    pointer-events: none;
    z-index: 2;
  }

  .held-icon-layer {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
    z-index: 5;
  }
  .held-icon-clip {
    position: relative;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
  }
  .held-mic-svg {
    grid-area: 1 / 1;
    width: 20px;
    height: 20px;
    overflow: visible;
    will-change: transform, opacity;
  }
  .launch-arrow-svg {
    grid-area: 1 / 1;
    width: 19px;
    height: 19px;
    will-change: transform, opacity;
  }

  .cancel-icon-layer {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 36px;
    height: 36px;
    margin-left: -18px;
    margin-top: -18px;
    display: grid;
    place-items: center;
    pointer-events: none;
    z-index: 5;
    will-change: transform, opacity;
  }
  .cancel-x-svg {
    width: 18px;
    height: 18px;
    overflow: visible;
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
