/*!
 * 源设计稿位于 bridge build/bridge前端设计/antigravity-logo-studio/antigravity-logo.js，改动先改设计稿再同步。
 * AgyWorkingMark 以副作用 import 后调用 globalThis.AntigravityLogo.mount()。
 * i18n-ignore-file（引擎里的中文只是各状态的设计说明元数据，界面不显示）
 *
 * antigravity-logo.js — Google Antigravity 反重力极光动效引擎（Zero-G Continuum）
 * --------------------------------------------------------------------------
 * 设计语言：Antigravity Zero-G Continuum（反重力连续体）
 *   - 锚定官方抛物线拱与 1:1 拟合官方 Z-order 的 7 层四色极光云，单一 SVG <mask> 隔离抗锯齿零黑边
 *   - 零四芒星、零表面白色扫光；本体零滤镜，可选 glow: 'hero' | 'subtle' 挂载同源哑光桌面漫反射
 *   - 连续体转场：跨状态直融不绕回 A 拱、极光云带流体惯性追随零跳色、支持 then 无缝接力与悬停/按压分离交互
 *
 * 用法：
 *   <antigravity-logo state="ambient" size="52" glow="hero" interactive></antigravity-logo>
 *   const ctl = AntigravityLogo.mount(el, { state: 'entrance', then: 'ambient', size: 52, glow: 'hero', interactive: true });
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var TAU = Math.PI * 2;
  var ARCH_SCALE = 2.86;
  var CONTOUR_N = 64;
  var BLEND_MS = 340;

  var META = {
    static:    { label: '静止平衡', en: 'Rest',             category: 'lifecycle', duration: 0,     loop: false, desc: '100% 还原官方抛物线拱与四色极光层级，零 rAF 基态' },
    ambient:   { label: '官方极光', en: 'Spectral Drift',   category: 'lifecycle', duration: 10000, loop: true,  continuous: true, desc: '锁定精确官方拱形，纯粹内部四色极光沿弧潮汐呼吸，任意截帧忠于原生标志' },
    entrance:  { label: '反重力升现', en: 'Zero-G Rise',    category: 'lifecycle', duration: 620,   loop: false, desc: '失重液核自底部轻盈升腾，舒展双翼经 M3 弹簧悬停成官方 A 拱' },
    exit:      { label: '失重归核', en: 'Zero-G Ascent',    category: 'lifecycle', duration: 460,   loop: false, desc: '双翼轻柔合拢为向上水滴，失重升空收束淡出' },
    tickle:    { label: '反重力软弹', en: 'Zero-G Bounce',  category: 'lifecycle', duration: 660,   loop: false, desc: '磁垫微蹲蓄力，失重弹跃舒展后经果冻阻尼轻盈回位' },
    success:   { label: '拱顶腾辉', en: 'Apex Bloom',       category: 'lifecycle', duration: 760,   loop: false, desc: '轻蓄微沉后失重昂首舒展，外放单圈翠金涟漪环，随即轻盈落定回拱' },
    thinking:  { label: '失重液滴', en: 'Zero-G Droplet',   category: 'cognition', duration: 3200,  enterDuration: 360, leaveDuration: 340, loop: true, phased: true, desc: '拱体收拢为大体圆形的失重极光液滴，以面积守恒的粘稠表面张力缓慢搏动' },
    writing:   { label: '极光行波', en: 'Fluid Ribbon',     category: 'cognition', duration: 1080,  enterDuration: 320, leaveDuration: 340, loop: true, phased: true, desc: '拱弧展平为厚润圆滑的一笔画极光丝带，自左向右连绵行波输出' },
    planning:  { label: '几何推演', en: 'Prism Morph',      category: 'cognition', duration: 3400,  enterDuration: 340, leaveDuration: 340, loop: true, phased: true, desc: '实心饱满圆角几何在正三角、菱形与圆角六边间按 M3 节奏旋转推演' },
    shimmer:   { label: '失重星链', en: 'Arch Pearls',      category: 'cognition', duration: 1900,  enterDuration: 340, leaveDuration: 340, loop: true, phased: true, desc: '沿抛物线凝化为 5 颗饱满极光液珠，浮力波往复轻拂逐颗跃动' },
    waiting:   { label: '静候潮汐', en: 'Zero-G Standby',   category: 'cognition', duration: 2800,  loop: true,  desc: '严格端正的官方拱形垂向失重浮沉呼吸，并自拱后轻盈散开同形极光柔影波' },
    searching: { label: '光学聚焦', en: 'Optical Focus',    category: 'operation', duration: 3000,  enterDuration: 360, leaveDuration: 360, loop: true, phased: true, desc: '流畅卷合为厚实圆润透镜环，弧线巡览并弹性变焦对准焦点微核' },
    editing:   { label: '极光落笔', en: 'Liquid Stylus',    category: 'operation', duration: 2400,  enterDuration: 360, leaveDuration: 360, loop: true, phased: true, desc: '整体收束为简洁圆润画笔，一笔滑写圆头极光笔迹条后轻跃续写' },
    executing: { label: '终端脉冲', en: 'Terminal Pulse',   category: 'operation', duration: 1900,  enterDuration: 340, leaveDuration: 340, loop: true, phased: true, desc: '旋身 90° 化作饱满命令符 >_，干脆蓄力脉冲并伴随圆角推进幻影' },
    orbiting:  { label: '双轨协同', en: 'Dual Orbit',       category: 'operation', duration: 2400,  enterDuration: 360, leaveDuration: 360, loop: true, phased: true, desc: '凝为中枢光核与两条清晰交叉 3D 透视轨道环，22px 依然清晰分明' },
    approval:  { label: '拱弧承托', en: 'Cradle Hold',      category: 'operation', duration: 2300,  enterDuration: 360, leaveDuration: 360, loop: true, phased: true, desc: '经失重 180° 翻转成月牙承托弧 ◡，托举温和呼吸心珠静候确认' },
    error:     { label: '磁震复原', en: 'Magnetic Recoil',  category: 'operation', duration: 760,   loop: false, desc: '绯红脉冲下三片拱体干脆弹开错位，随即强磁吸合紧凑回弹自愈' }
  };

  var EFFORT_CFG = {
    low:    { amp: 0.80, rate: 0.86, spin: 0.78 },
    medium: { amp: 1.00, rate: 1.00, spin: 1.00 },
    high:   { amp: 1.16, rate: 1.15, spin: 1.22 },
    xhigh:  { amp: 1.30, rate: 1.28, spin: 1.44 }
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) {
    var u = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
    return u * u * (3 - 2 * u);
  }
  function easeOutCubic(t) { var u = 1 - clamp(t, 0, 1); return 1 - u * u * u; }
  function easeInCubic(t) { var u = clamp(t, 0, 1); return u * u * u; }
  function easeInOutCubic(t) {
    var u = clamp(t, 0, 1);
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  }
  function easeOutBack(t, s) {
    s = s === undefined ? 1.38 : s;
    var u = clamp(t, 0, 1) - 1;
    return u * u * ((s + 1) * u + s) + 1;
  }
  // M3 Emphasized 近似：起步迅速、落位长尾克制丝滑
  function easeEmphasized(t) {
    var u = clamp(t, 0, 1);
    return u < 0.35
      ? 0.42 * Math.pow(u / 0.35, 1.85)
      : 0.42 + 0.58 * (1 - Math.pow(1 - (u - 0.35) / 0.65, 2.75));
  }
  // M3 Expressive 欠阻尼弹簧（用于入场与跨态直接融合）
  function easeSpring(t, overshoot) {
    var u = clamp(t, 0, 1);
    if (u >= 1) return 1;
    var ov = overshoot === undefined ? 0.08 : overshoot;
    return 1 - Math.exp(-6.2 * u) * Math.cos(u * Math.PI * 1.95) * (1 + ov * 2.2 * Math.sin(u * Math.PI));
  }
  function fmt(n) { return (Math.round(n * 100) / 100).toString(); }

  function mapX(x24) { return 50 + (x24 - 12.037) * ARCH_SCALE; }
  function mapY(y24) { return 50 + (y24 - 12.0) * ARCH_SCALE; }

  // =========================================================================
  // 几何数学工具箱：精确官方轮廓 + 64 点等弧长闭环插值 + 液态丝带管
  // =========================================================================
  var STATIC_ARCH_D = (function () {
    function P(x24, y24) { return fmt(mapX(x24)) + ' ' + fmt(mapY(y24)); }
    return (
      'M ' + P(21.751, 22.607) +
      ' C ' + P(23.091, 23.612) + ', ' + P(25.101, 22.942) + ', ' + P(23.259, 21.099) +
      ' C ' + P(17.730, 15.740) + ', ' + P(18.904, 1.000)  + ', ' + P(12.037, 1.000) +
      ' C ' + P(5.170, 1.000)   + ', ' + P(6.342, 15.740)  + ', ' + P(0.815, 21.100) +
      ' C ' + P(-1.195, 23.109) + ', ' + P(0.982, 23.611)  + ', ' + P(2.322, 22.606) +
      ' C ' + P(7.514, 19.089)  + ', ' + P(7.179, 12.892)  + ', ' + P(12.037, 12.892) +
      ' C ' + P(16.894, 12.892) + ', ' + P(16.559, 19.089) + ', ' + P(21.751, 22.607) +
      ' Z'
    );
  })();

  function evalCubic(p0, c1, c2, p3, t) {
    var mt = 1 - t, mt2 = mt * mt, t2 = t * t;
    var a = mt2 * mt, b = 3 * mt2 * t, c = 3 * mt * t2, d = t2 * t;
    return [
      a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
      a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]
    ];
  }

  function evalQuad(p0, c1, p2, t) {
    var mt = 1 - t;
    return [
      mt * mt * p0[0] + 2 * mt * t * c1[0] + t * t * p2[0],
      mt * mt * p0[1] + 2 * mt * t * c1[1] + t * t * p2[1]
    ];
  }

  function resampleClosed(densePts, N) {
    var m = densePts.length;
    var cum = new Array(m + 1);
    cum[0] = 0;
    for (var i = 0; i < m; i++) {
      var a = densePts[i], b = densePts[(i + 1) % m];
      cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    var total = cum[m] || 1;
    var out = new Array(N);
    var j = 0;
    for (var k = 0; k < N; k++) {
      var target = (k / N) * total;
      while (j < m - 1 && cum[j + 1] < target) j++;
      var segLen = cum[j + 1] - cum[j] || 1e-6;
      var u = (target - cum[j]) / segLen;
      var pA = densePts[j], pB = densePts[(j + 1) % m];
      out[k] = [lerp(pA[0], pB[0], u), lerp(pA[1], pB[1], u)];
    }
    return out;
  }

  var ARCH_64 = (function () {
    function pt(x24, y24) { return [mapX(x24), mapY(y24)]; }
    var segs = [
      [pt(12.037, 1.000),  pt(18.904, 1.000),  pt(17.730, 15.740), pt(23.259, 21.099)],
      [pt(23.259, 21.099), pt(25.101, 22.942), pt(23.091, 23.612), pt(21.751, 22.607)],
      [pt(21.751, 22.607), pt(16.559, 19.089), pt(16.894, 12.892), pt(12.037, 12.892)],
      [pt(12.037, 12.892), pt(7.179, 12.892),  pt(7.514, 19.089),  pt(2.322, 22.606)],
      [pt(2.322, 22.606),  pt(0.982, 23.611),  pt(-1.195, 23.109), pt(0.815, 21.100)],
      [pt(0.815, 21.100),  pt(6.342, 15.740),  pt(5.170, 1.000),   pt(12.037, 1.000)]
    ];
    var dense = [];
    for (var s = 0; s < segs.length; s++) {
      var sg = segs[s];
      for (var i = 0; i < 40; i++) dense.push(evalCubic(sg[0], sg[1], sg[2], sg[3], i / 40));
    }
    return resampleClosed(dense, CONTOUR_N);
  })();

  function contourToPath(pts, tension) {
    var n = pts.length;
    var k = (tension === undefined ? 1 : tension) / 6;
    var out = 'M ' + fmt(pts[0][0]) + ' ' + fmt(pts[0][1]);
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n];
      var p1 = pts[i];
      var p2 = pts[(i + 1) % n];
      var p3 = pts[(i + 2) % n];
      var c1x = p1[0] + (p2[0] - p0[0]) * k;
      var c1y = p1[1] + (p2[1] - p0[1]) * k;
      var c2x = p2[0] - (p3[0] - p1[0]) * k;
      var c2y = p2[1] - (p3[1] - p1[1]) * k;
      out += ' C ' + fmt(c1x) + ' ' + fmt(c1y) + ', ' + fmt(c2x) + ' ' + fmt(c2y) + ', ' + fmt(p2[0]) + ' ' + fmt(p2[1]);
    }
    return out + ' Z';
  }

  function lerpContours(a, b, t) {
    var n = a.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = [lerp(a[i][0], b[i][0], t), lerp(a[i][1], b[i][1], t)];
    }
    return out;
  }

  function alignContourToTop(pts) {
    if (!pts || !pts.length) return ARCH_64;
    var bestI = 0, bestScore = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var score = pts[i][1] + Math.abs(pts[i][0] - 50) * 0.35;
      if (score < bestScore) { bestScore = score; bestI = i; }
    }
    var out = new Array(pts.length);
    for (var j = 0; j < pts.length; j++) out[j] = pts[(bestI + j) % pts.length];
    return out;
  }

  function transformContour(pts, cx, cy, sx, sy, rotDeg, shearX) {
    var rad = (rotDeg || 0) * Math.PI / 180;
    var c = Math.cos(rad), s = Math.sin(rad);
    var sh = shearX || 0;
    var out = new Array(pts.length);
    for (var i = 0; i < pts.length; i++) {
      var dx = pts[i][0] - 50;
      var dy = pts[i][1] - 50;
      if (sh) dx += sh * ((50 - pts[i][1]) / 34);
      dx *= sx;
      dy *= sy;
      var rx = rad ? (dx * c - dy * s) : dx;
      var ry = rad ? (dx * s + dy * c) : dy;
      out[i] = [cx + rx, cy + ry];
    }
    return out;
  }

  // —— 目标轮廓生成器（全部顺时针、索引 0 在 12 点钟，保证任意跨态直融零扭转）——

  function makeOrbContour(cx, cy, rx, ry) {
    var out = new Array(CONTOUR_N);
    for (var i = 0; i < CONTOUR_N; i++) {
      var a = -Math.PI / 2 + (i / CONTOUR_N) * TAU;
      out[i] = [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
    }
    return out;
  }

  // 反重力流线水滴核（用于 entrance / exit：上弧略收尖、下腹圆润，完全呼应 A 拱拓扑，无四芒星）
  function makeZeroGDropContour(cx, cy, rx, ry, taper) {
    var tp = taper === undefined ? 0.32 : taper;
    var out = new Array(CONTOUR_N);
    for (var i = 0; i < CONTOUR_N; i++) {
      var a = -Math.PI / 2 + (i / CONTOUR_N) * TAU;
      var ca = Math.cos(a), sa = Math.sin(a);
      var wScale = sa < 0 ? (1 - (-sa) * tp) : (1 + sa * tp * 0.28);
      out[i] = [cx + ca * rx * wScale, cy + sa * ry];
    }
    return out;
  }

  // 饱满圆角多边形轮廓（用于 planning 几何推演：圆角正三角 / 圆角菱形 / 圆角六边）
  function makeRoundedRegularPoly(cx, cy, R, sides, cornerRound, rotDeg) {
    var rad0 = (rotDeg || 0) * Math.PI / 180 - Math.PI / 2;
    var verts = [];
    for (var v = 0; v < sides; v++) {
      var ang = rad0 + (v / sides) * TAU;
      verts.push([cx + Math.cos(ang) * R, cy + Math.sin(ang) * R]);
    }
    var dense = [];
    var cr = clamp(cornerRound, 0.08, 0.44);
    for (var i = 0; i < sides; i++) {
      var prev = verts[(i - 1 + sides) % sides];
      var cur  = verts[i];
      var next = verts[(i + 1) % sides];
      var pIn  = [lerp(cur[0], prev[0], cr), lerp(cur[1], prev[1], cr)];
      var pOut = [lerp(cur[0], next[0], cr), lerp(cur[1], next[1], cr)];
      for (var c = 0; c < 12; c++) dense.push(evalQuad(pIn, cur, pOut, c / 12));
      var nextIn = [lerp(next[0], cur[0], cr), lerp(next[1], cur[1], cr)];
      for (var l = 0; l < 10; l++) dense.push([lerp(pOut[0], nextIn[0], l / 10), lerp(pOut[1], nextIn[1], l / 10)]);
    }
    return alignContourToTop(resampleClosed(dense, CONTOUR_N));
  }

  var PLAN_SHAPES = [
    makeRoundedRegularPoly(50, 53, 33.5, 3, 0.30, 0),   // 饱满圆角正三角（层级架构）
    makeRoundedRegularPoly(50, 50, 32.0, 4, 0.30, 0),   // 饱满圆角菱形（系统枢纽）
    makeRoundedRegularPoly(50, 50, 30.5, 6, 0.28, 0)    // 饱满圆角六边形（模块拓扑）
  ];

  // 粗细可变开放丝带 → 64 点顺时针闭环（索引 0 在上缘正中）
  function makeRibbonContour(spinePts, halfWidths) {
    var m = spinePts.length;
    var topPts = [], botPts = [];
    for (var i = 0; i < m; i++) {
      var prev = spinePts[Math.max(0, i - 1)];
      var next = spinePts[Math.min(m - 1, i + 1)];
      var tx = next[0] - prev[0], ty = next[1] - prev[1];
      var len = Math.hypot(tx, ty) || 1;
      var nx = ty / len, ny = -tx / len;
      var w = halfWidths[i];
      topPts.push([spinePts[i][0] + nx * w, spinePts[i][1] + ny * w]);
      botPts.push([spinePts[i][0] - nx * w, spinePts[i][1] - ny * w]);
    }
    var rEnd = spinePts[m - 1], rPrev = spinePts[m - 2];
    var rAng = Math.atan2(rEnd[1] - rPrev[1], rEnd[0] - rPrev[0]);
    var rW = halfWidths[m - 1], rightCap = [];
    for (var rc = 1; rc <= 5; rc++) {
      var a = rAng - Math.PI / 2 + (rc / 6) * Math.PI;
      rightCap.push([rEnd[0] + Math.cos(a) * rW, rEnd[1] + Math.sin(a) * rW]);
    }
    var lStart = spinePts[0], lNext = spinePts[1];
    var lAng = Math.atan2(lStart[1] - lNext[1], lStart[0] - lNext[0]);
    var lW = halfWidths[0], leftCap = [];
    for (var lc = 1; lc <= 5; lc++) {
      var la = lAng - Math.PI / 2 + (lc / 6) * Math.PI;
      leftCap.push([lStart[0] + Math.cos(la) * lW, lStart[1] + Math.sin(la) * lW]);
    }
    var mid = Math.floor(m / 2);
    var dense = [];
    for (var a1 = mid; a1 < m; a1++) dense.push(topPts[a1]);
    for (var a2 = 0; a2 < rightCap.length; a2++) dense.push(rightCap[a2]);
    for (var a3 = m - 1; a3 >= 0; a3--) dense.push(botPts[a3]);
    for (var a4 = 0; a4 < leftCap.length; a4++) dense.push(leftCap[a4]);
    for (var a5 = 0; a5 < mid; a5++) dense.push(topPts[a5]);
    return resampleClosed(dense, CONTOUR_N);
  }

  // 反转月牙承托弧 ◡（approval）
  var CRADLE_64 = (function () {
    var spine = [], widths = [], M = 31;
    for (var i = 0; i < M; i++) {
      var u = (i / (M - 1)) * 2 - 1;
      spine.push([50 + u * 33.5, 76 - Math.pow(Math.abs(u), 1.85) * 23]);
      widths.push(lerp(9.6, 4.4, Math.pow(Math.abs(u), 1.45)));
    }
    return makeRibbonContour(spine, widths);
  })();

  // 厚润一笔画流体行波（writing：22px 下波谷依然清晰饱满）
  function makeWaveRibbon64(phase, ampScale) {
    var spine = [], widths = [], M = 33;
    var ph = phase * TAU;
    for (var i = 0; i < M; i++) {
      var u = (i / (M - 1)) * 2 - 1;
      var x = 50 + u * 35.5;
      var env = 0.58 + 0.42 * Math.cos(u * Math.PI * 0.5);
      var wave = Math.sin(u * Math.PI * 1.55 - ph) * 18.0 * ampScale * env;
      var y = 53 + u * u * 9 + wave;
      var w = (9.2 + Math.cos(u * Math.PI * 1.55 - ph) * 2.6) * (1 - 0.36 * u * u);
      spine.push([x, y]);
      widths.push(Math.max(4.4, w));
    }
    return makeRibbonContour(spine, widths);
  }

  // 反重力软弹蓄力宽弧（tickle）
  var SQUASH_64 = (function () {
    var spine = [], widths = [], M = 29;
    for (var i = 0; i < M; i++) {
      var u = (i / (M - 1)) * 2 - 1;
      spine.push([50 + u * 38, 63 + u * u * 14]);
      widths.push(lerp(11.8, 4.8, u * u));
    }
    return makeRibbonContour(spine, widths);
  })();

  // 失重粘稠液滴（thinking）：大体呈圆形，采用严格面积守恒的低阶毛细张力慢搏动模拟微重力粘滞流体
  function makeZeroGDropletContour(t, ef) {
    var ph = t * TAU;
    var amp = ef ? ef.amp : 1.0;
    var scale = lerp(0.76, 1.24, clamp((amp - 0.75) / 0.60, 0, 1));
    // 非对称粘滞脉冲：柔胀略快、表面张力回拉滞重，还原粘稠液体弹性而非机械正弦
    var pulse2 = (0.72 * Math.sin(ph * 2) + 0.28 * Math.sin(ph * 4 - 0.75)) * 0.90;
    var pulse3 = 0.65 * Math.cos(ph) + 0.35 * Math.sin(ph * 2 + 0.55);
    // 2 阶主张力轴每周期缓转 π、3 阶慢毛细波逆向缓行 2π/3，保证 t=0 与 t=1 精确无缝闭合
    var axis2 = t * Math.PI + 0.32;
    var axis3 = -t * (TAU / 3) - 0.42;
    var R0 = 30.6 * (1 + Math.sin(ph) * 0.036 * scale);
    var c2Amp = (0.034 + 0.088 * pulse2) * scale;
    var c3Amp = (0.024 + 0.028 * pulse3) * scale;
    var c4Amp = 0.009 * Math.sin(ph * 2 + 1.1) * scale;

    var radii = new Array(CONTOUR_N);
    var sumR2 = 0;
    for (var i = 0; i < CONTOUR_N; i++) {
      var a = -Math.PI / 2 + (i / CONTOUR_N) * TAU;
      var r = R0 * (
        1
        + c2Amp * Math.cos(2 * (a - axis2))
        + c3Amp * Math.cos(3 * (a - axis3))
        + c4Amp * Math.cos(4 * (a + axis2 * 0.5))
      );
      radii[i] = r;
      sumR2 += r * r;
    }
    // 面积守恒归一化：一轴拉长必伴随正交轴回缩，呈现不可压缩流体张力质感
    var rms = Math.sqrt(sumR2 / CONTOUR_N) || R0;
    var norm = R0 / rms;
    var cx = 50 + Math.sin(ph) * 0.9 * scale;
    var cy = 50 - Math.cos(ph) * 1.4 * scale;
    var raw = new Array(CONTOUR_N);
    for (var j = 0; j < CONTOUR_N; j++) {
      var ang = -Math.PI / 2 + (j / CONTOUR_N) * TAU;
      var rr = radii[j] * norm;
      raw[j] = [cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr];
    }
    return resampleClosed(raw, CONTOUR_N);
  }

  function circlePath(cx, cy, r, dir) {
    r = Math.max(0.2, r);
    var sweep = dir === -1 ? 0 : 1;
    return (
      'M ' + fmt(cx) + ' ' + fmt(cy - r) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 1 ' + sweep + ' ' + fmt(cx) + ' ' + fmt(cy + r) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 1 ' + sweep + ' ' + fmt(cx) + ' ' + fmt(cy - r) + ' Z'
    );
  }

  function rotatedPillPath(cx, cy, w, h, rotDeg) {
    var hw = w * 0.5, hh = h * 0.5;
    var r = Math.min(hw, hh);
    var rad = (rotDeg || 0) * Math.PI / 180;
    var c = Math.cos(rad), s = Math.sin(rad);
    function R(x, y) { return fmt(cx + x * c - y * s) + ' ' + fmt(cy + x * s + y * c); }
    var topY = -hh + r, botY = hh - r;
    if (botY <= topY + 0.1) return circlePath(cx, cy, r, 1);
    return (
      'M ' + R(-hw, topY) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' ' + fmt(rotDeg || 0) + ' 0 1 ' + R(hw, topY) +
      ' L ' + R(hw, botY) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' ' + fmt(rotDeg || 0) + ' 0 1 ' + R(-hw, botY) +
      ' Z'
    );
  }

  function hCapsulePath(x0, x1, cy, r) {
    if (r < 0.35) return '';
    if (x1 <= x0 + 0.25) return circlePath(x0, cy, r, 1);
    return (
      'M ' + fmt(x0) + ' ' + fmt(cy - r) +
      ' L ' + fmt(x1) + ' ' + fmt(cy - r) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + fmt(x1) + ' ' + fmt(cy + r) +
      ' L ' + fmt(x0) + ' ' + fmt(cy + r) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + fmt(x0) + ' ' + fmt(cy - r) + ' Z'
    );
  }

  // 3D 透视厚实丝带环（外顺内逆 → nonzero 并集，22px 依然厚润清晰）
  function make3DRibbonRingPath(cx, cy, R, thick, rxDeg, ryDeg, rzDeg) {
    var rx = rxDeg * Math.PI / 180, ry = ryDeg * Math.PI / 180, rz = rzDeg * Math.PI / 180;
    var cxr = Math.cos(rx), sxr = Math.sin(rx);
    var cyr = Math.cos(ry), syr = Math.sin(ry);
    var czr = Math.cos(rz), szr = Math.sin(rz);
    var M = 40;
    var pts = new Array(M), depths = new Array(M);
    for (var i = 0; i < M; i++) {
      var a = (i / M) * TAU;
      var x = Math.cos(a) * R, y = Math.sin(a) * R;
      var y1 = y * cxr, z1 = y * sxr;
      var x2 = x * cyr + z1 * syr, z2 = -x * syr + z1 * cyr;
      var x3 = x2 * czr - y1 * szr, y3 = x2 * szr + y1 * czr;
      var persp = 210 / (210 - z2);
      pts[i] = [cx + x3 * persp, cy + y3 * persp];
      depths[i] = clamp((z2 / R + 1) * 0.5, 0, 1);
    }
    var area2 = 0;
    for (var k = 0; k < M; k++) {
      var pA = pts[k], pB = pts[(k + 1) % M];
      area2 += (pB[0] - pA[0]) * (pB[1] + pA[1]);
    }
    if (area2 > 0) { pts.reverse(); depths.reverse(); }
    if (Math.abs(area2) * 0.5 < 380) {
      var maxD = 0, p1 = pts[0], p2 = pts[M >> 1];
      for (var ii = 0; ii < (M >> 1); ii++) {
        var q1 = pts[ii], q2 = pts[ii + (M >> 1)];
        var dd = Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
        if (dd > maxD) { maxD = dd; p1 = q1; p2 = q2; }
      }
      return rotatedPillPath((p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5, thick * 1.1, maxD + thick,
        Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180 / Math.PI + 90);
    }
    var outer = new Array(M), inner = new Array(M);
    for (var j = 0; j < M; j++) {
      var prev = pts[(j - 1 + M) % M], next = pts[(j + 1) % M];
      var tx = next[0] - prev[0], ty = next[1] - prev[1];
      var len = Math.hypot(tx, ty) || 1;
      var nx = ty / len, ny = -tx / len;
      var halfW = thick * lerp(0.42, 0.64, depths[j]);
      outer[j] = [pts[j][0] + nx * halfW, pts[j][1] + ny * halfW];
      inner[M - 1 - j] = [pts[j][0] - nx * halfW, pts[j][1] - ny * halfW];
    }
    return contourToPath(outer, 0.9) + ' ' + contourToPath(inner, 0.9);
  }

  // 开放圆弧丝带（searching 卷合/解卷）
  function makeOpenArcTubePath(cx, cy, R, startDeg, endDeg, halfWStart, halfWPeak, halfWEnd) {
    var M = 30, spine = new Array(M), widths = new Array(M);
    for (var i = 0; i < M; i++) {
      var u = i / (M - 1);
      var rad = lerp(startDeg, endDeg, u) * Math.PI / 180;
      spine[i] = [cx + Math.cos(rad) * R, cy + Math.sin(rad) * R];
      widths[i] = lerp(lerp(halfWStart, halfWEnd, u), halfWPeak, Math.sin(u * Math.PI));
    }
    return contourToPath(makeRibbonContour(spine, widths), 0.96);
  }

  // 厚实圆润极光透镜（searching）
  function makeLensPath(cx, cy, rOuter, rInner, handleLen, handleW, handleDeg) {
    var ring = circlePath(cx, cy, rOuter, 1) + ' ' + circlePath(cx, cy, rInner, -1);
    if (handleLen <= 1) return ring;
    var rad = (handleDeg || 45) * Math.PI / 180;
    var dist = (rOuter + rInner) * 0.5 + handleLen * 0.5 + 1.2;
    var handle = rotatedPillPath(cx + Math.cos(rad) * dist, cy + Math.sin(rad) * dist, handleW, handleLen + 5, (handleDeg || 45) - 90);
    return ring + ' ' + handle;
  }

  // 整体简洁圆润极光画笔（editing：不分体碎笔帽，22px 依然清脆辨识）
  var STYLUS_TIP_OFFSET_Y = -24.5;
  var STYLUS_UPRIGHT_64 = (function () {
    var dense = [];
    function pushLine(a, b, steps) {
      for (var i = 0; i < steps; i++) dense.push([lerp(a[0], b[0], i / steps), lerp(a[1], b[1], i / steps)]);
    }
    function pushQuad(p0, p1, p2, steps) {
      for (var i = 0; i < steps; i++) dense.push(evalQuad(p0, p1, p2, i / steps));
    }
    pushQuad([50.0, 25.5], [52.0, 25.5], [53.4, 28.0], 8);
    pushLine([53.4, 28.0], [59.8, 40.5], 14);
    pushQuad([59.8, 40.5], [60.8, 43.0], [60.8, 46.5], 8);
    pushLine([60.8, 46.5], [60.6, 67.5], 20);
    pushQuad([60.6, 67.5], [60.6, 75.0], [50.0, 75.0], 12);
    pushQuad([50.0, 75.0], [39.4, 75.0], [39.4, 67.5], 12);
    pushLine([39.4, 67.5], [39.2, 46.5], 20);
    pushQuad([39.2, 46.5], [39.2, 43.0], [40.2, 40.5], 8);
    pushLine([40.2, 40.5], [46.6, 28.0], 14);
    pushQuad([46.6, 28.0], [48.0, 25.5], [50.0, 25.5], 8);
    return resampleClosed(dense, CONTOUR_N);
  })();

  function stylusCenterFromTip(tipX, tipY, rotDeg, scale) {
    var rad = rotDeg * Math.PI / 180;
    var s = scale === undefined ? 1 : scale;
    return [tipX + STYLUS_TIP_OFFSET_Y * s * Math.sin(rad), tipY - STYLUS_TIP_OFFSET_Y * s * Math.cos(rad)];
  }

  function makeChevronEchoPath(cx, cy, halfH, depth) {
    var x0 = cx - depth, y0 = cy - halfH, y1 = cy + halfH;
    var ax = lerp(cx, x0, 0.24), ay = lerp(cy, y0, 0.24);
    var bx = lerp(cx, x0, 0.24), by = lerp(cy, y1, 0.24);
    return 'M ' + fmt(x0) + ' ' + fmt(y0) + ' L ' + fmt(ax) + ' ' + fmt(ay) +
           ' Q ' + fmt(cx) + ' ' + fmt(cy) + ', ' + fmt(bx) + ' ' + fmt(by) + ' L ' + fmt(x0) + ' ' + fmt(y1);
  }

  // 三片磁流体碎片（error）
  var SHATTER_SHARDS = (function () {
    var crownSpine = [], crownW = [];
    for (var i = 0; i < 13; i++) {
      var u = (i / 12) * 2 - 1;
      crownSpine.push([50 + u * 15.5, 27.5 + u * u * 13.5]);
      crownW.push(lerp(9.6, 6.2, u * u));
    }
    var leftSpine = [], leftW = [], rightSpine = [], rightW = [];
    for (var j = 0; j < 9; j++) {
      var v = j / 8;
      leftSpine.push([lerp(18.5, 37.5, v), lerp(77.5, 45.5, v) - Math.sin(v * Math.PI) * 2.5]);
      leftW.push(lerp(4.4, 7.6, Math.pow(v, 0.7)));
      rightSpine.push([lerp(62.5, 81.5, v), lerp(45.5, 77.5, v) - Math.sin(v * Math.PI) * 2.5]);
      rightW.push(lerp(7.6, 4.4, Math.pow(v, 1.3)));
    }
    return {
      crown: makeRibbonContour(crownSpine, crownW),
      left:  makeRibbonContour(leftSpine, leftW),
      right: makeRibbonContour(rightSpine, rightW)
    };
  })();

  // 5 颗沿官方 A 拱抛物线分布的饱满极光液珠（shimmer：22px 下粒粒清晰分明）
  var PEARL_NODES = [
    { x: 19.5, y: 76.5, r: 6.4, idx: 0 },
    { x: 31.0, y: 52.5, r: 7.4, idx: 1 },
    { x: 50.0, y: 28.5, r: 9.2, idx: 2 },
    { x: 69.0, y: 52.5, r: 7.4, idx: 3 },
    { x: 80.5, y: 76.5, r: 6.4, idx: 4 }
  ];

  var ARCH_THIN_64 = (function () {
    var spine = [], widths = [], M = 25;
    for (var i = 0; i < M; i++) {
      var u = (i / (M - 1)) * 2 - 1;
      spine.push([50 + u * 30.5, 28.5 + u * u * 48.0]);
      widths.push(lerp(3.6, 2.2, u * u));
    }
    return makeRibbonContour(spine, widths);
  })();

  // 只有目标本身就是官方 A 拱形态（静息/生命周期态）时，leave 才归回 ARCH_64；
  // 其他工作态之间直接液态融变或经单轮廓直接交接，绝不中途闪现 A 拱
  var ARCH_REST_STATES = {
    static: true, ambient: true, waiting: true, entrance: true, exit: true, tickle: true, success: true, error: true
  };
  function getDirectTargetContour(nextState, ef) {
    if (!nextState || ARCH_REST_STATES[nextState]) return ARCH_64;
    if (nextState === 'thinking') return makeZeroGDropletContour(0, ef);
    if (nextState === 'writing')  return makeWaveRibbon64(0, ef ? ef.amp : 1.0);
    if (nextState === 'planning') return PLAN_SHAPES[0];
    return null;
  }

  // =========================================================================
  // 17 种状态编舞计算引擎（V4：零四芒星、纯反重力物理、22px 高清克制）
  // =========================================================================
  function computeScene(state, t, effortKey, pressBoost, phaseCtx) {
    t = clamp(t || 0, 0, 0.99999);
    var ef = EFFORT_CFG[effortKey] || EFFORT_CFG.medium;
    var boost = pressBoost || 0;
    var phase = (phaseCtx && phaseCtx.phase) || 'loop';
    var snap = (phaseCtx && phaseCtx.snap) || null;
    var nextState = (phaseCtx && phaseCtx.nextState) || '';
    var directTarget = (phase === 'leave') ? getDirectTargetContour(nextState, ef) : ARCH_64;
    var toArch = directTarget === ARCH_64;

    var sc = {
      bodyD: STATIC_ARCH_D,
      contour: ARCH_64,
      bodyAlpha: 1,
      spectralPhase: 0,
      spectralDrift: 0,
      spectralFlowX: 0,
      spectralPulse: 0,
      errWash: 0,
      okWash: 0,
      under: [],
      over: []
    };

    if (state === 'static') {
      return sc;
    }

    // 0. ambient · 官方极光（锁定精确拱形，纯粹内部四色沿弧潮汐呼吸，无表面扫光）
    if (state === 'ambient') {
      sc.ambientSec = (phaseCtx && typeof phaseCtx.ambientSec === 'number') ? phaseCtx.ambientSec : (t * 10);
      sc.ambientRamp = (phaseCtx && typeof phaseCtx.ambientRamp === 'number') ? phaseCtx.ambientRamp : 1;
      return sc;
    }

    // 1. entrance · 反重力升现（失重液核自下升起 → 自然分化舒展双翼 → M3 弹簧落定官方拱，零四芒星）
    if (state === 'entrance') {
      sc.spectralPhase = t * 0.45;
      sc.spectralDrift = (1 - smoothstep(0.55, 1.0, t)) * 0.65;
      sc.spectralPulse = Math.sin(t * Math.PI) * 0.14;
      sc.bodyAlpha = smoothstep(0.0, 0.16, t);
      if (t < 0.34) {
        var u0 = easeOutCubic(t / 0.34);
        var rx = lerp(5.5, 22.0, u0);
        var ry = lerp(5.5, 26.5, u0);
        var cy = lerp(68, 52, u0);
        sc.contour = makeZeroGDropContour(50, cy, rx, ry, lerp(0.10, 0.34, u0));
        sc.bodyD = contourToPath(sc.contour, 0.98);
      } else {
        var u1 = (t - 0.34) / 0.66;
        var dropBase = makeZeroGDropContour(50, 52, 22.0, 26.5, 0.34);
        var sp = easeSpring(u1, 0.06);
        var blended = lerpContours(dropBase, ARCH_64, clamp(sp, 0, 1.06));
        var liftY = -Math.sin(smoothstep(0.0, 0.85, u1) * Math.PI) * 2.8;
        var scOv = sp > 1 ? (1 + (sp - 1) * 0.42) : 1;
        sc.contour = transformContour(blended, 50, 50 + liftY, scOv, scOv, 0);
        sc.bodyD = u1 > 0.985 ? STATIC_ARCH_D : contourToPath(sc.contour, 1.0);
      }
      return sc;
    }

    // 2. exit · 失重归核（双翼温柔收拢为向上流线水滴 → 失重上升收束淡出，零四芒星）
    if (state === 'exit') {
      sc.spectralPhase = t * 0.55;
      sc.spectralDrift = 0.7;
      if (t < 0.52) {
        var e0 = easeInOutCubic(t / 0.52);
        var drop = makeZeroGDropContour(50, 48, 20.5, 25.0, 0.36);
        sc.contour = lerpContours(ARCH_64, drop, e0);
      } else {
        var e1 = easeInCubic((t - 0.52) / 0.48);
        sc.contour = makeZeroGDropContour(50, lerp(48, 28, e1), lerp(20.5, 3.2, e1), lerp(25.0, 4.5, e1), 0.36);
        sc.bodyAlpha = 1 - smoothstep(0.45, 1.0, e1);
      }
      sc.bodyD = contourToPath(sc.contour, 0.98);
      return sc;
    }

    // 3. tickle · 反重力软弹（蓄力宽弧 → 失重轻盈弹跃 → 果冻阻尼悬停归位，零四芒星）
    if (state === 'tickle') {
      var amp = 1 + boost * 0.28;
      sc.spectralPhase = t * 0.85;
      sc.spectralDrift = Math.sin(t * Math.PI) * 0.95 * amp;
      sc.spectralPulse = Math.sin(t * Math.PI) * 0.18;
      if (t < 0.24) {
        var k0 = Math.sin((t / 0.24) * Math.PI * 0.5);
        var sq = transformContour(SQUASH_64, 50, 52 + boost * 2.5, 1 + boost * 0.06, 1 - boost * 0.06, 0);
        sc.contour = lerpContours(ARCH_64, sq, k0);
      } else if (t < 0.56) {
        var k1 = (t - 0.24) / 0.32;
        var sq2 = transformContour(SQUASH_64, 50, 52 + boost * 2.5, 1 + boost * 0.06, 1 - boost * 0.06, 0);
        var leap = transformContour(ARCH_64, 50, 41.5 - boost * 3.5, 0.91, 1.11 * amp, 0);
        sc.contour = lerpContours(sq2, leap, easeEmphasized(k1));
      } else {
        var k2 = (t - 0.56) / 0.44;
        var leapEnd = transformContour(ARCH_64, 50, 41.5 - boost * 3.5, 0.91, 1.11 * amp, 0);
        var baseBack = lerpContours(leapEnd, ARCH_64, easeOutCubic(clamp(k2 / 0.55, 0, 1)));
        var jelly = Math.sin(k2 * Math.PI * 2.2) * Math.pow(1 - k2, 1.8);
        sc.contour = transformContour(baseBack, 50, 50 + jelly * 3.6, 1 + jelly * 0.10, 1 - jelly * 0.10, 0);
      }
      sc.bodyD = contourToPath(sc.contour, 1.0);
      return sc;
    }

    // 4. success · 拱顶腾辉（轻蓄微沉 → 反重力昂首轻跃 + 单圈翠金涟漪环 → 轻盈落定官方拱，零四芒星）
    if (state === 'success') {
      sc.spectralPhase = t * 0.7;
      sc.spectralDrift = Math.sin(t * Math.PI) * 0.8;
      sc.okWash = Math.sin(clamp(t / 0.72, 0, 1) * Math.PI) * 0.34;
      var sx = 1, sy = 1, cy = 50;
      if (t < 0.20) {
        var s0 = Math.sin((t / 0.20) * Math.PI * 0.5);
        sx = 1 + 0.07 * s0;
        sy = 1 - 0.08 * s0;
        cy = 50 + 2.5 * s0;
      } else if (t < 0.55) {
        var s1 = (t - 0.20) / 0.35;
        var peak = Math.sin(s1 * Math.PI * 0.5);
        sx = lerp(1.07, 0.96, easeOutCubic(s1));
        sy = lerp(0.92, 1.09, easeOutCubic(s1));
        cy = lerp(52.5, 44.0, peak);
      } else {
        var s2 = (t - 0.55) / 0.45;
        var settle = easeSpring(s2, 0.05);
        sx = lerp(0.96, 1.0, settle);
        sy = lerp(1.09, 1.0, settle);
        cy = lerp(44.0, 50.0, settle);
      }
      sc.contour = transformContour(ARCH_64, 50, cy, sx, sy, 0);
      sc.bodyD = t > 0.985 ? STATIC_ARCH_D : contourToPath(sc.contour, 1.0);

      // 纯净单圈翠金引力涟漪环（置于拱体后方舒展消散，不切过拱身，零四芒星）
      if (t >= 0.18 && t < 0.88) {
        var ru = (t - 0.18) / 0.70;
        var re = easeOutCubic(ru);
        sc.under.push({
          kind: 'circle', cx: 50, cy: 49,
          r: lerp(22, 47, re),
          stroke: 'ok', strokeWidth: lerp(5.2, 1.0, re),
          opacity: (1 - ru) * smoothstep(0.0, 0.14, ru) * 0.62
        });
      }
      return sc;
    }

    // 5. thinking · 失重液滴（大体圆形、严格面积守恒的粘稠表面张力慢搏动）
    if (state === 'thinking') {
      var drop0 = makeZeroGDropletContour(0, ef);
      if (phase === 'enter') {
        sc.spectralPhase = t * 0.35;
        sc.spectralDrift = 0.85 * ef.amp;
        var fromT = (snap && snap.contour) ? alignContourToTop(snap.contour) : ARCH_64;
        var uIn = easeEmphasized(t);
        // 双翼经表面张力柔和向心聚拢成失重液滴
        sc.contour = lerpContours(fromT, drop0, uIn);
        sc.bodyD = contourToPath(sc.contour, 1.0);
        return sc;
      }
      if (phase === 'leave') {
        sc.spectralPhase = (1 - t) * 0.35;
        sc.spectralDrift = (1 - t) * 0.8;
        var startT = (snap && snap.contour) ? alignContourToTop(snap.contour) : drop0;
        var uOutT = easeSpring(t, 0.05);
        sc.contour = lerpContours(startT, ARCH_64, clamp(uOutT, 0, 1.04));
        sc.bodyD = t > 0.98 ? STATIC_ARCH_D : contourToPath(sc.contour, 1.0);
        return sc;
      }
      var phD = t * TAU;
      var viscBeat = 0.72 * Math.sin(phD * 2) + 0.28 * Math.sin(phD * 4 - 0.75);
      sc.spectralPhase = t * 0.85 * ef.spin;
      sc.spectralDrift = (0.76 + Math.abs(viscBeat) * 0.28) * ef.amp;
      sc.spectralPulse = viscBeat * 0.075;
      sc.spectralFlowX = Math.sin(phD) * 4.2;
      sc.contour = makeZeroGDropletContour(t, ef);
      sc.bodyD = contourToPath(sc.contour, 1.0);
      return sc;
    }

    // 6. writing · 极光行波（厚润一笔画极光丝带自左向右连绵挥毫）
    if (state === 'writing') {
      var wave0 = makeWaveRibbon64(0, ef.amp);
      if (phase === 'enter') {
        sc.spectralPhase = t * 0.5;
        sc.spectralDrift = 1.0;
        var fromW = (snap && snap.contour) ? alignContourToTop(snap.contour) : ARCH_64;
        sc.contour = lerpContours(fromW, wave0, easeEmphasized(t));
        sc.bodyD = contourToPath(sc.contour, 1.0);
        return sc;
      }
      if (phase === 'leave') {
        sc.spectralPhase = (1 - t) * 0.45;
        sc.spectralDrift = (1 - t) * 0.9;
        var startW = (snap && snap.contour) ? alignContourToTop(snap.contour) : wave0;
        sc.contour = lerpContours(startW, ARCH_64, easeEmphasized(t));
        sc.bodyD = t > 0.98 ? STATIC_ARCH_D : contourToPath(sc.contour, 1.0);
        return sc;
      }
      sc.spectralPhase = t * 1.6;
      sc.spectralDrift = 1.25;
      sc.spectralFlowX = Math.sin(t * TAU) * 16;
      sc.spectralPulse = 0.16;
      sc.contour = makeWaveRibbon64(t, ef.amp);
      sc.bodyD = contourToPath(sc.contour, 1.0);
      return sc;
    }

    // 7. planning · 几何推演（实心饱满 M3 圆角三角 ⇄ 菱形 ⇄ 六边形旋转推演，22px 同样锐利高级）
    if (state === 'planning') {
      if (phase === 'enter') {
        sc.spectralPhase = t * 0.4;
        sc.spectralDrift = 0.85;
        var fromP = (snap && snap.contour) ? alignContourToTop(snap.contour) : ARCH_64;
        sc.contour = lerpContours(fromP, PLAN_SHAPES[0], easeEmphasized(t));
        sc.bodyD = contourToPath(sc.contour, 0.98);
        return sc;
      }
      if (phase === 'leave') {
        sc.spectralPhase = (1 - t) * 0.4;
        sc.spectralDrift = (1 - t) * 0.8;
        var startP = (snap && snap.contour) ? alignContourToTop(snap.contour) : PLAN_SHAPES[0];
        sc.contour = lerpContours(startP, ARCH_64, easeEmphasized(t));
        sc.bodyD = t > 0.98 ? STATIC_ARCH_D : contourToPath(sc.contour, 1.0);
        return sc;
      }
      sc.spectralPhase = t * 1.0;
      sc.spectralDrift = 0.95;
      var segF = clamp(t, 0, 0.99999) * 3;
      var idx = clamp(Math.floor(segF), 0, 2);
      var loc = segF - idx;
      var morphU = easeEmphasized(clamp((loc - 0.36) / 0.64, 0, 1));
      var morphed = lerpContours(PLAN_SHAPES[idx], PLAN_SHAPES[(idx + 1) % 3], morphU);
      // 变换过程伴随克制的 M3 弹性呼吸与微旋（回正落位无扭转）
      var pulseP = 1 + Math.sin(morphU * Math.PI) * 0.06;
      var tiltP = Math.sin(morphU * Math.PI) * 14;
      sc.contour = transformContour(morphed, 50, 50, pulseP, pulseP, tiltP);
      sc.bodyD = contourToPath(sc.contour, 0.98);
      return sc;
    }

    // 8. shimmer · 失重星链（5 颗饱满极光液珠沿官方抛物线悬浮涟漪跃动）
    if (state === 'shimmer') {
      if (phase === 'enter') {
        sc.spectralPhase = t * 0.5;
        sc.spectralDrift = 0.95;
        if (t < 0.45) {
          var fromS = (snap && snap.contour) ? alignContourToTop(snap.contour) : ARCH_64;
          sc.contour = lerpContours(fromS, ARCH_THIN_64, easeEmphasized(t / 0.45));
          sc.bodyD = contourToPath(sc.contour, 1.0);
        } else {
          var uB = easeOutBack((t - 0.45) / 0.55, 1.15);
          var beadD = '';
          for (var bi = 0; bi < PEARL_NODES.length; bi++) {
            var pn = PEARL_NODES[bi];
            beadD += circlePath(pn.x, pn.y, pn.r * clamp(uB, 0.2, 1.04), 1) + ' ';
          }
          sc.bodyD = beadD.trim();
          sc.contour = null;
        }
        return sc;
      }
      if (phase === 'leave') {
        sc.spectralPhase = (1 - t) * 0.45;
        sc.spectralDrift = (1 - t) * 0.85;
        if (toArch) {
          if (t < 0.45) {
            var uInB = easeInCubic(t / 0.45);
            var backD = '';
            for (var bj = 0; bj < PEARL_NODES.length; bj++) {
              var pnb = PEARL_NODES[bj];
              backD += circlePath(pnb.x, pnb.y, pnb.r * lerp(1.0, 0.38, uInB), 1) + ' ';
            }
            sc.bodyD = backD.trim();
            sc.contour = null;
          } else {
            var uF = easeSpring((t - 0.45) / 0.55, 0.05);
            sc.contour = lerpContours(ARCH_THIN_64, ARCH_64, clamp(uF, 0, 1.04));
            sc.bodyD = t > 0.98 ? STATIC_ARCH_D : contourToPath(sc.contour, 1.0);
          }
        } else if (directTarget) {
          if (t < 0.44) {
            var uCo = easeEmphasized(t / 0.44);
            var coalD = '';
            for (var bk = 0; bk < PEARL_NODES.length; bk++) {
              var pnc = PEARL_NODES[bk];
              coalD += circlePath(lerp(pnc.x, 50, uCo), lerp(pnc.y, 50, uCo), lerp(pnc.r, 24.0, uCo * uCo), 1) + ' ';
            }
            sc.bodyD = coalD.trim();
            sc.contour = null;
          } else {
            sc.contour = lerpContours(makeOrbContour(50, 50, 24, 24), directTarget, easeEmphasized((t - 0.44) / 0.56));
            sc.bodyD = contourToPath(sc.contour, 1.0);
          }
        } else {
          // 切往另一复合态：5 颗珠子直接向心聚拢成单圆核，零 A 拱绕路
          var uCo2 = easeEmphasized(t);
          var coalD2 = '';
          for (var bm = 0; bm < PEARL_NODES.length; bm++) {
            var pnm = PEARL_NODES[bm];
            coalD2 += circlePath(lerp(pnm.x, 50, uCo2), lerp(pnm.y, 50, uCo2), lerp(pnm.r, 24.0, uCo2 * uCo2), 1) + ' ';
          }
          sc.bodyD = t > 0.88 ? contourToPath(makeOrbContour(50, 50, 24, 24), 1.0) : coalD2.trim();
          sc.contour = t > 0.80 ? makeOrbContour(50, 50, 24, 24) : null;
        }
        return sc;
      }
      sc.spectralPhase = t * 1.25;
      sc.spectralDrift = 1.1;
      sc.spectralPulse = 0.14;
      var waveCenter = 2.0 - Math.cos(t * TAU) * 2.5;
      var dropD = '';
      for (var di = 0; di < PEARL_NODES.length; di++) {
        var dn = PEARL_NODES[di];
        var pulse = Math.exp(-Math.pow((dn.idx - waveCenter) / 1.05, 2));
        var jumpY = -pulse * 8.2 + Math.sin(t * TAU + dn.idx * 0.9) * 1.2;
        dropD += circlePath(dn.x, dn.y + jumpY, dn.r * (0.92 + pulse * 0.26), 1) + ' ';
      }
      sc.bodyD = dropD.trim();
      sc.contour = null;
      return sc;
    }

    // 9. waiting · 静候潮汐（严格端正零歪斜，垂向失重浮沉 + 拱后同形极光柔影波舒展消散）
    if (state === 'waiting') {
      var wph = t * TAU;
      var rise = 0.5 - 0.5 * Math.cos(wph);
      var dyW = lerp(2.8, -3.8, rise);
      var scW = lerp(0.955, 1.035, rise);
      // 保持暖顶蓝底的色相正位轻柔潮汐，使拱后柔影与本体上暖下蓝完全同向
      sc.spectralPhase = -0.22 + 0.06 * Math.sin(wph);
      sc.spectralDrift = 0.65;
      sc.spectralPulse = (rise - 0.5) * 0.22;
      sc.bodyAlpha = lerp(0.88, 1.0, rise);
      var out = new Array(CONTOUR_N);
      for (var wi = 0; wi < CONTOUR_N; wi++) {
        var bp = ARCH_64[wi];
        var dx = bp[0] - 50, dy = bp[1] - 50;
        var wingW = clamp((dy + 8) / 36, 0, 1);
        var wingBreath = (0.5 - rise) * 0.045 * wingW;
        out[wi] = [50 + dx * (scW + wingBreath), 50 + dy * scW + dyW];
      }
      sc.contour = out;
      sc.bodyD = contourToPath(sc.contour, 1.0);
      // 拱后同形极光柔影脉冲波：清晰传达"等待响应 / 重连中"，22px 依然干净克制
      var eu = (t + 0.14) % 1;
      if (eu < 0.86) {
        var en = eu / 0.86;
        var ee = easeOutCubic(en);
        var echoSc = lerp(1.00, 1.34, ee);
        var echoOp = (1 - en) * smoothstep(0, 0.16, en) * 0.30;
        var echoPts = transformContour(ARCH_64, 50, 50 + dyW * 0.4, echoSc, echoSc, 0);
        sc.under.push({
          kind: 'fill',
          d: contourToPath(echoPts, 1.0),
          fill: 'spectral',
          opacity: echoOp
        });
      }
      return sc;
    }

    // 10. searching · 光学聚焦（厚实透镜环流畅巡览并弹性变焦，聚焦极简圆核，零四芒星零碎弧）
    if (state === 'searching') {
      var baseCx = 45.0, baseCy = 44.0, baseR = 22.5, baseHalfW = 6.2;
      function buildOpenArch64() {
        var sp = [], wd = [];
        for (var i = 0; i < 30; i++) {
          var u = i / 29;
          var rad = lerp(132, 405, u) * Math.PI / 180;
          sp.push([baseCx + Math.cos(rad) * baseR, baseCy + Math.sin(rad) * baseR]);
          wd.push(lerp(5.2, 9.4, Math.sin(u * Math.PI)));
        }
        return makeRibbonContour(sp, wd);
      }

      if (phase === 'enter') {
        sc.spectralPhase = t * 0.55;
        sc.spectralDrift = 0.95;
        if (t < 0.36) {
          var fromL = (snap && snap.contour) ? alignContourToTop(snap.contour) : ARCH_64;
          sc.contour = lerpContours(fromL, buildOpenArch64(), easeEmphasized(t / 0.36));
          sc.bodyD = contourToPath(sc.contour, 1.0);
        } else {
          var uB = clamp((t - 0.36) / 0.64, 0, 1);
          var cU = easeEmphasized(uB);
          var hLen = lerp(4, 19.5, cU), hRad = 45 * Math.PI / 180;
          var hDist = baseR + hLen * 0.5 + 1.2;
          var hD = ' ' + rotatedPillPath(baseCx + Math.cos(hRad) * hDist, baseCy + Math.sin(hRad) * hDist, lerp(7.2, 9.6, cU), hLen + 5, -45);
          sc.bodyD = uB < 0.88
            ? makeOpenArcTubePath(baseCx, baseCy, baseR, lerp(132, 45, cU), 405, lerp(5.2, baseHalfW, cU), lerp(9.4, baseHalfW, cU), baseHalfW) + hD
            : makeLensPath(baseCx, baseCy, baseR + baseHalfW, baseR - baseHalfW, 19.5, 9.6, 45);
          sc.contour = null;
          sc.lensState = { lx: baseCx, ly: baseCy, hDeg: 45, zoom: 1.0 };
        }
        return sc;
      }
      if (phase === 'leave') {
        sc.spectralPhase = (1 - t) * 0.5;
        sc.spectralDrift = (1 - t) * 0.9;
        var ls = (snap && snap.lensState) || { lx: baseCx, ly: baseCy, hDeg: 45, zoom: 1.0 };
        if (toArch) {
          if (t < 0.30) {
            var uM = easeInOutCubic(t / 0.30);
            var cxL = lerp(ls.lx, baseCx, uM), cyL = lerp(ls.ly, baseCy, uM), zmL = lerp(ls.zoom, 1.0, uM);
            sc.bodyD = makeLensPath(cxL, cyL, (baseR + baseHalfW) * zmL, (baseR - baseHalfW) * zmL, 19.5, 9.6, lerp(ls.hDeg, 45, uM));
            sc.contour = null;
          } else if (t < 0.72) {
            var uC = easeInCubic((t - 0.30) / 0.42);
            var hLen2 = lerp(19.5, 4, uC), hRad2 = 45 * Math.PI / 180;
            var hD2 = ' ' + rotatedPillPath(baseCx + Math.cos(hRad2) * (baseR + hLen2 * 0.5 + 1.2), baseCy + Math.sin(hRad2) * (baseR + hLen2 * 0.5 + 1.2), lerp(9.6, 7.2, uC), hLen2 + 5, -45);
            sc.bodyD = makeOpenArcTubePath(baseCx, baseCy, baseR, lerp(45, 132, uC), 405, lerp(baseHalfW, 5.2, uC), lerp(baseHalfW, 9.4, uC), baseHalfW) + hD2;
            sc.contour = null;
          } else {
            var uD = easeSpring((t - 0.72) / 0.28, 0.05);
            sc.contour = lerpContours(buildOpenArch64(), ARCH_64, clamp(uD, 0, 1.04));
            sc.bodyD = t > 0.98 ? STATIC_ARCH_D : contourToPath(sc.contour, 1.0);
          }
        } else if (directTarget) {
          // 直接收柄并闭合镜孔为实心圆核，再直融到目标单轮廓（thinking/writing/planning），不经 A 拱
          if (t < 0.44) {
            var uCl = easeEmphasized(t / 0.44);
            var cxS = lerp(ls.lx, 50, uCl), cyS = lerp(ls.ly, 50, uCl);
            var rOutS = lerp((baseR + baseHalfW) * ls.zoom, 27.5, uCl);
            var rInS = lerp((baseR - baseHalfW) * ls.zoom, 0, easeInCubic(uCl));
            var hLenS = lerp(19.5, 0, easeInCubic(clamp(uCl * 1.25, 0, 1)));
            sc.bodyD = rInS > 0.6
              ? makeLensPath(cxS, cyS, rOutS, rInS, hLenS, lerp(9.6, 5.0, uCl), ls.hDeg)
              : circlePath(cxS, cyS, rOutS, 1);
            sc.contour = null;
          } else {
            sc.contour = lerpContours(makeOrbContour(50, 50, 27.5, 27.5), directTarget, easeEmphasized((t - 0.44) / 0.56));
            sc.bodyD = contourToPath(sc.contour, 1.0);
          }
        } else {
          // 切往另一复合态：直接收柄闭孔成实心圆核交接
          var uCl2 = easeEmphasized(t);
          var cxS2 = lerp(ls.lx, 50, uCl2), cyS2 = lerp(ls.ly, 50, uCl2);
          var rOutS2 = lerp((baseR + baseHalfW) * ls.zoom, 27.5, uCl2);
          var rInS2 = lerp((baseR - baseHalfW) * ls.zoom, 0, easeInCubic(uCl2));
          var hLenS2 = lerp(19.5, 0, easeInCubic(clamp(uCl2 * 1.25, 0, 1)));
          var orbS = makeOrbContour(50, 50, 27.5, 27.5);
          sc.bodyD = rInS2 > 0.6
            ? makeLensPath(cxS2, cyS2, rOutS2, rInS2, hLenS2, lerp(9.6, 5.0, uCl2), ls.hDeg)
            : circlePath(cxS2, cyS2, rOutS2, 1);
          sc.contour = uCl2 > 0.80 ? orbS : null;
        }
        return sc;
      }

      // 持续平滑椭圆轨道巡览 + 两次自然弹性变焦（聚焦一颗干净圆核）
      sc.spectralPhase = t * 1.4;
      sc.spectralDrift = 1.1;
      var ang = t * TAU;
      var lx = baseCx + Math.cos(ang) * 9.5;
      var ly = baseCy + Math.sin(ang * 2) * 5.8;
      var hDeg = 45 + Math.sin(ang) * 9.0;
      // 在左右两端各做一次清脆弹性变焦呼吸
      var f1 = Math.exp(-Math.pow((t - 0.24) / 0.085, 2));
      var f2 = Math.exp(-Math.pow((t - 0.74) / 0.085, 2));
      var focus = Math.max(f1, f2);
      var zoom = 1.0 + focus * 0.11;
      sc.spectralFlowX = (lx - baseCx) * 0.85;
      sc.bodyD = makeLensPath(lx, ly, (baseR + baseHalfW) * zoom, (baseR - baseHalfW) * zoom, 19.5, 9.6, hDeg);
      sc.contour = null;
      sc.lensState = { lx: lx, ly: ly, hDeg: hDeg, zoom: zoom };
      if (focus > 0.08) {
        sc.over.push({
          kind: 'circle', cx: lx, cy: ly,
          r: lerp(2.2, 6.2, focus),
          fill: 'spectral', opacity: focus * 0.88
        });
      }
      return sc;
    }

    // 11. editing · 极光落笔（整体简洁画笔一笔滑写圆头极光笔迹，零四芒星、22px 清晰）
    if (state === 'editing') {
      var penScale = 0.94, baseRot = -142;
      var sA = 17.0, sB = 66.0, lineY = 75.0, lineR = 5.0, tipY = lineY - 7.5;
      var startCtr = stylusCenterFromTip(sA, tipY, baseRot, penScale);

      if (phase === 'enter') {
        sc.spectralPhase = t * 0.5;
        sc.spectralDrift = 0.95;
        var fromE = (snap && snap.contour) ? alignContourToTop(snap.contour) : ARCH_64;
        var uE = easeEmphasized(t);
        var baseC = lerpContours(fromE, STYLUS_UPRIGHT_64, clamp(uE * 1.15, 0, 1));
        var cxIn = lerp(50, startCtr[0], uE), cyIn = lerp(50, startCtr[1], uE) - Math.sin(t * Math.PI) * 4;
        var rotIn = lerp(0, baseRot, uE), scIn = lerp(1.0, penScale, uE);
        var bodyC = transformContour(baseC, cxIn, cyIn, scIn, scIn, rotIn);
        var dotIn = smoothstep(0.76, 1.0, t);
        sc.bodyD = contourToPath(bodyC, 0.98) + (dotIn > 0.05 ? (' ' + circlePath(sA, lineY, lineR * dotIn, 1)) : '');
        sc.contour = null;
        sc.editState = { cx: cxIn, cy: cyIn, rotDeg: rotIn, scale: scIn, la: sA, lb: sA, lr: lineR * dotIn };
        return sc;
      }
      if (phase === 'leave') {
        sc.spectralPhase = (1 - t) * 0.45;
        sc.spectralDrift = (1 - t) * 0.9;
        var es = (snap && snap.editState) || { cx: startCtr[0] + 20, cy: startCtr[1], rotDeg: baseRot, scale: penScale, la: sA, lb: sB, lr: lineR };
        if (toArch) {
          var uOut = easeEmphasized(t);
          var uUnf = easeEmphasized(smoothstep(0.18, 1.0, t));
          var bodyOut = transformContour(lerpContours(STYLUS_UPRIGHT_64, ARCH_64, uUnf), lerp(es.cx, 50, uOut), lerp(es.cy, 50, uOut), lerp(es.scale, 1, uOut), lerp(es.scale, 1, uOut), lerp(es.rotDeg, 0, uOut));
          var lf = 1 - smoothstep(0.0, 0.36, t);
          var lOut = (lf > 0.04 && es.lr > 0.3) ? (' ' + hCapsulePath(lerp(es.lb, es.la, lf), es.lb, lineY, es.lr * lf)) : '';
          sc.bodyD = t > 0.98 ? STATIC_ARCH_D : (contourToPath(bodyOut, 0.98) + lOut);
          sc.contour = uUnf > 0.9 ? bodyOut : null;
        } else {
          var livePen = alignContourToTop(transformContour(STYLUS_UPRIGHT_64, es.cx, es.cy, es.scale, es.scale, es.rotDeg));
          if (directTarget) {
            // 笔迹收回的同时，画笔本体原地直接液态融变为目标轮廓（thinking/writing/planning），绝不回 A 拱
            var lfD = 1 - smoothstep(0.0, 0.36, t);
            var lOutD = (lfD > 0.04 && es.lr > 0.3) ? (' ' + hCapsulePath(lerp(es.lb, es.la, lfD), es.lb, lineY, es.lr * lfD)) : '';
            sc.contour = lerpContours(livePen, directTarget, easeEmphasized(t));
            sc.bodyD = contourToPath(sc.contour, 0.98) + lOutD;
          } else {
            // 切往另一复合态：极短收起笔迹条，保留当前画笔单轮廓直接交接下一态 enter
            var lfM = 1 - easeInCubic(t);
            var lOutM = (lfM > 0.04 && es.lr > 0.3) ? (' ' + hCapsulePath(lerp(es.lb, es.la, lfM), es.lb, lineY, es.lr * lfM)) : '';
            sc.contour = livePen;
            sc.bodyD = contourToPath(livePen, 0.98) + lOutM;
          }
        }
        return sc;
      }

      sc.spectralPhase = t * 1.3;
      sc.spectralDrift = 1.1;
      var penX = sA, penY = tipY, penRot = baseRot, la = sA, lb = sA, ly = lineY, lr = lineR;
      if (t < 0.62) {
        var u1 = t / 0.62;
        var e1 = easeEmphasized(u1);
        penX = lerp(sA, sB, e1);
        penY = tipY + Math.sin(u1 * Math.PI * 3) * 1.1 * Math.sin(u1 * Math.PI);
        penRot = baseRot + Math.sin(u1 * Math.PI * 3) * 3.5 * Math.sin(u1 * Math.PI);
        lb = penX;
      } else {
        var u2 = (t - 0.62) / 0.38;
        var e2 = easeInOutCubic(u2);
        penX = lerp(sB, sA, e2);
        penY = tipY - Math.sin(u2 * Math.PI) * 13.0;
        penRot = baseRot + Math.sin(u2 * Math.PI) * 12.0;
        var clr = smoothstep(0.0, 0.72, u2);
        la = lerp(sA, sB, clr * 0.82);
        lb = sB;
        ly = lineY - clr * 4.0;
        lr = lineR * (1 - clr);
        var nd = smoothstep(0.82, 1.0, u2);
        if (nd > 0.04) { la = sA; lb = sA; ly = lineY; lr = lineR * nd; }
      }
      sc.spectralFlowX = (penX - 40) * 0.75;
      var ctr = stylusCenterFromTip(penX, penY, penRot, penScale);
      var penC = transformContour(STYLUS_UPRIGHT_64, ctr[0], ctr[1], penScale, penScale, penRot);
      sc.bodyD = contourToPath(penC, 0.98) + (lr > 0.4 ? (' ' + hCapsulePath(la, lb, ly, lr)) : '');
      sc.contour = null;
      sc.editState = { cx: ctr[0], cy: ctr[1], rotDeg: penRot, scale: penScale, la: la, lb: lb, lr: lr };
      return sc;
    }

    // 12. executing · 终端脉冲（饱满 A 拱转 90° 作 > + 呼吸光标 _ + 柔和圆角回波 >）
    if (state === 'executing') {
      var chevCx = 35.5, chevCy = 49.0, chevSx = 0.80, chevSy = 0.74;
      var curY = 70.5, curR = 5.0, curA = 62.5, curB = 83.5;

      if (phase === 'enter') {
        sc.spectralPhase = t * 0.5;
        sc.spectralDrift = 0.95;
        var fromX = (snap && snap.contour) ? alignContourToTop(snap.contour) : ARCH_64;
        var uX = easeEmphasized(t);
        var chevC = transformContour(lerpContours(fromX, ARCH_64, uX), lerp(50, chevCx, uX), lerp(50, chevCy, uX), lerp(1, chevSx, uX), lerp(1, chevSy, uX), lerp(0, 90, uX));
        var barU = easeOutBack(smoothstep(0.42, 0.96, t), 1.1);
        var bMid = (curA + curB) * 0.5, bHalf = (curB - curA) * 0.5 * clamp(barU, 0, 1.04);
        sc.bodyD = contourToPath(chevC, 1.0) + (barU > 0.05 ? (' ' + hCapsulePath(bMid - bHalf, bMid + bHalf, curY, curR * clamp(barU, 0.25, 1))) : '');
        sc.contour = null;
        sc.phaseData = { cx: lerp(50, chevCx, uX), cy: lerp(50, chevCy, uX), sx: lerp(1, chevSx, uX), sy: lerp(1, chevSy, uX), rot: lerp(0, 90, uX), barScale: clamp(barU, 0, 1) };
        return sc;
      }
      if (phase === 'leave') {
        sc.spectralPhase = (1 - t) * 0.45;
        sc.spectralDrift = (1 - t) * 0.85;
        var xs = (snap && snap.phaseData) || { cx: chevCx, cy: chevCy, sx: chevSx, sy: chevSy, rot: 90, barScale: 1 };
        var barInit = xs.barScale === undefined ? 1 : xs.barScale;
        var bm = (curA + curB) * 0.5;
        if (toArch) {
          var uOutX = easeEmphasized(t);
          var outC = transformContour(ARCH_64, lerp(xs.cx, 50, uOutX), lerp(xs.cy, 50, uOutX), lerp(xs.sx, 1, uOutX), lerp(xs.sy, 1, uOutX), lerp(xs.rot, 0, uOutX));
          var bf = (1 - smoothstep(0.0, 0.36, t)) * barInit;
          var bh = (curB - curA) * 0.5 * bf;
          sc.bodyD = t > 0.98 ? STATIC_ARCH_D : (contourToPath(outC, 1.0) + (bf > 0.05 ? (' ' + hCapsulePath(bm - bh, bm + bh, curY, curR * bf)) : ''));
          sc.contour = uOutX > 0.9 ? outC : null;
        } else {
          var liveChev = alignContourToTop(transformContour(ARCH_64, xs.cx, xs.cy, xs.sx, xs.sy, xs.rot));
          if (directTarget) {
            var bfD = (1 - smoothstep(0.0, 0.36, t)) * barInit;
            var bhD = (curB - curA) * 0.5 * bfD;
            sc.contour = lerpContours(liveChev, directTarget, easeEmphasized(t));
            sc.bodyD = contourToPath(sc.contour, 1.0) + (bfD > 0.05 ? (' ' + hCapsulePath(bm - bhD, bm + bhD, curY, curR * bfD)) : '');
          } else {
            var bfM = (1 - easeInCubic(t)) * barInit;
            var bhM = (curB - curA) * 0.5 * bfM;
            sc.contour = liveChev;
            sc.bodyD = contourToPath(liveChev, 1.0) + (bfM > 0.05 ? (' ' + hCapsulePath(bm - bhM, bm + bhM, curY, curR * bfM)) : '');
          }
        }
        return sc;
      }

      sc.spectralPhase = t * 1.5;
      sc.spectralDrift = 1.2;
      var beatU = (t * 2) % 1;
      var kickX = 0, sqX = 1, sqY = 1, echoU = -1;
      if (beatU < 0.16) {
        var b0 = Math.sin((beatU / 0.16) * Math.PI * 0.5);
        kickX = -2.8 * b0 * ef.amp;
        sqX = 1 + 0.04 * b0; sqY = 1 - 0.05 * b0;
      } else if (beatU < 0.46) {
        var b1 = (beatU - 0.16) / 0.30;
        var punch = Math.sin(b1 * Math.PI);
        kickX = lerp(-2.8, 4.8, easeOutCubic(clamp(b1 * 1.7, 0, 1))) * ef.amp * (1 - smoothstep(0.55, 1.0, b1) * 0.65);
        sqX = 1 - 0.04 * punch; sqY = 1 + 0.07 * punch;
        echoU = clamp((beatU - 0.20) / 0.50, 0, 1);
      } else {
        kickX = lerp(1.6 * ef.amp, 0, easeOutCubic((beatU - 0.46) / 0.54));
        if (beatU < 0.70) echoU = clamp((beatU - 0.20) / 0.50, 0, 1);
      }
      var blinkDip = Math.sin(smoothstep(0.52, 0.88, beatU) * Math.PI);
      var curLenMul = 1.0 - blinkDip * 0.68;
      var curEnd = curA + (curB - curA) * clamp(curLenMul, 0.08, 1.08);
      var chevLoopC = transformContour(ARCH_64, chevCx + kickX, chevCy, chevSx * sqX, chevSy * sqY, 90);
      sc.spectralFlowX = kickX * 2.0;
      sc.bodyD = contourToPath(chevLoopC, 1.0) + ' ' + hCapsulePath(curA, curEnd, curY, curR * (1 - blinkDip * 0.14));
      sc.contour = null;
      sc.phaseData = { cx: chevCx + kickX, cy: chevCy, sx: chevSx * sqX, sy: chevSy * sqY, rot: 90, barScale: curLenMul };
      if (echoU >= 0 && echoU < 0.96) {
        var ee = easeOutCubic(echoU);
        sc.over.push({
          kind: 'arc',
          d: makeChevronEchoPath(lerp(60, 83, ee), chevCy - 2.0, lerp(9.5, 11.8, ee), lerp(8.0, 10.0, ee)),
          stroke: 'spectral', strokeWidth: lerp(5.2, 2.2, ee), opacity: Math.sin(echoU * Math.PI) * 0.85
        });
      }
      return sc;
    }

    // 13. orbiting · 双轨协同（清晰中枢核 + 两条交叉饱满 3D 透视丝带环，22px 零毛线团）
    if (state === 'orbiting') {
      var R_FULL = 35.0, THICK_FULL = 7.8;
      if (phase === 'enter') {
        sc.spectralPhase = t * 0.6;
        sc.spectralDrift = 1.0;
        if (t < 0.42) {
          var fromO = (snap && snap.contour) ? alignContourToTop(snap.contour) : ARCH_64;
          sc.contour = lerpContours(fromO, makeOrbContour(50, 50, 21, 21), easeEmphasized(t / 0.42));
          sc.bodyD = contourToPath(sc.contour, 1.0);
        } else {
          var uO1 = easeEmphasized((t - 0.42) / 0.58);
          var rIn = lerp(20, R_FULL, uO1), thIn = lerp(9.2, THICK_FULL, uO1), spIn = (uO1 - 1) * 40;
          sc.bodyD = make3DRibbonRingPath(50, 50, rIn, thIn, 62, spIn, 32) + ' ' +
                     make3DRibbonRingPath(50, 50, rIn, thIn, -62, spIn + 90, -32) + ' ' +
                     circlePath(50, 50, lerp(20, 8.8, uO1), 1);
          sc.contour = null;
        }
        sc.phaseData = { spinA: 0 };
        return sc;
      }
      if (phase === 'leave') {
        sc.spectralPhase = (1 - t) * 0.55;
        sc.spectralDrift = (1 - t) * 0.9;
        var os = (snap && snap.phaseData) || { spinA: 0 };
        if (directTarget) {
          if (t < 0.46) {
            var uO2 = easeInCubic(t / 0.46);
            var rOut = lerp(R_FULL, 20, uO2), thOut = lerp(THICK_FULL, 9.2, uO2), spOut = os.spinA + uO2 * 50;
            sc.bodyD = make3DRibbonRingPath(50, 50, rOut, thOut, 62, spOut, 32) + ' ' +
                       make3DRibbonRingPath(50, 50, rOut, thOut, -62, spOut + 90, -32) + ' ' +
                       circlePath(50, 50, lerp(8.8, 22, uO2), 1);
            sc.contour = null;
          } else {
            var uO3 = toArch ? clamp(easeSpring((t - 0.46) / 0.54, 0.05), 0, 1.04) : easeEmphasized((t - 0.46) / 0.54);
            sc.contour = lerpContours(makeOrbContour(50, 50, 22, 22), directTarget, uO3);
            sc.bodyD = (toArch && t > 0.98) ? STATIC_ARCH_D : contourToPath(sc.contour, 1.0);
          }
        } else {
          var uO4 = easeEmphasized(t);
          var rOut2 = lerp(R_FULL, 20, uO4), thOut2 = lerp(THICK_FULL, 9.2, uO4), spOut2 = os.spinA + uO4 * 50;
          var orbO = makeOrbContour(50, 50, 22, 22);
          sc.bodyD = uO4 > 0.92
            ? contourToPath(orbO, 1.0)
            : (make3DRibbonRingPath(50, 50, rOut2, thOut2, 62, spOut2, 32) + ' ' +
               make3DRibbonRingPath(50, 50, rOut2, thOut2, -62, spOut2 + 90, -32) + ' ' +
               circlePath(50, 50, lerp(8.8, 22, uO4), 1));
          sc.contour = uO4 > 0.80 ? orbO : null;
        }
        return sc;
      }
      sc.spectralPhase = t * 1.3;
      sc.spectralDrift = 1.15;
      var spinA = t * 360;
      var coreR = 8.8 + Math.sin(t * TAU * 2) * 1.2;
      sc.bodyD = make3DRibbonRingPath(50, 50, R_FULL, THICK_FULL, 62, spinA, 32) + ' ' +
                 make3DRibbonRingPath(50, 50, R_FULL, THICK_FULL, -62, spinA + 90, -32) + ' ' +
                 circlePath(50, 50, coreR, 1);
      sc.contour = null;
      sc.phaseData = { spinA: spinA };
      return sc;
    }

    // 14. approval · 拱弧承托（失重 180° 翻转成承托月牙 ◡，托起呼吸极光心珠静候确认）
    if (state === 'approval') {
      if (phase === 'enter') {
        sc.spectralPhase = t * 0.5;
        sc.spectralDrift = 0.85;
        var fromA = (snap && snap.contour) ? alignContourToTop(snap.contour) : ARCH_64;
        var uA = easeEmphasized(t);
        var crIn = transformContour(lerpContours(fromA, CRADLE_64, uA), 50, lerp(50, 54, uA), 1, 1, 0);
        var oPop = easeOutBack(smoothstep(0.32, 0.98, t), 1.15);
        var oR = 12.6 * clamp(oPop, 0, 1.04);
        sc.bodyD = contourToPath(crIn, 1.0) + (oR > 0.5 ? (' ' + circlePath(50, lerp(60, 39, easeOutCubic(smoothstep(0.28, 1, t))), oR, 1)) : '');
        sc.contour = null;
        return sc;
      }
      if (phase === 'leave') {
        sc.spectralPhase = (1 - t) * 0.45;
        sc.spectralDrift = (1 - t) * 0.8;
        if (toArch) {
          var uOutA = easeEmphasized(t);
          var oFade = 1 - smoothstep(0.0, 0.44, t);
          var crOut = transformContour(lerpContours(CRADLE_64, ARCH_64, easeEmphasized(smoothstep(0.14, 1.0, t))), 50, lerp(54, 50, uOutA), 1, 1, 0);
          sc.bodyD = t > 0.98 ? STATIC_ARCH_D : (contourToPath(crOut, 1.0) + (oFade > 0.05 ? (' ' + circlePath(50, lerp(39, 60, easeInCubic(clamp(t / 0.44, 0, 1))), 12.6 * oFade, 1)) : ''));
          sc.contour = t > 0.9 ? crOut : null;
        } else {
          var liveCradle = alignContourToTop(transformContour(CRADLE_64, 50, 54, 1, 1, 0));
          if (directTarget) {
            var oFadeD = 1 - smoothstep(0.0, 0.42, t);
            sc.contour = lerpContours(liveCradle, directTarget, easeEmphasized(t));
            sc.bodyD = contourToPath(sc.contour, 1.0) + (oFadeD > 0.05 ? (' ' + circlePath(50, lerp(39, 54, easeInCubic(clamp(t / 0.42, 0, 1))), 12.6 * oFadeD, 1)) : '');
          } else {
            var oFadeM = 1 - easeInCubic(t);
            sc.contour = liveCradle;
            sc.bodyD = contourToPath(liveCradle, 1.0) + (oFadeM > 0.05 ? (' ' + circlePath(50, lerp(39, 58, easeInCubic(t)), 12.6 * oFadeM, 1)) : '');
          }
        }
        return sc;
      }
      var aph = t * TAU;
      sc.spectralPhase = t * 0.75;
      sc.spectralDrift = 0.9;
      var cb = Math.sin(aph);
      var cradle = transformContour(CRADLE_64, 50, 54 + cb * 2.2, 1 + cb * 0.04, 1 - cb * 0.03, 0);
      var orbY = 39 - cb * 5.0, orbR = 12.6 + Math.sin(aph * 2) * 1.3;
      sc.bodyD = contourToPath(cradle, 1.0) + ' ' + circlePath(50, orbY, orbR, 1);
      sc.contour = null;
      var ringT = (t + 0.15) % 1;
      sc.under.push({
        kind: 'circle', cx: 50, cy: orbY, r: lerp(orbR + 2.2, orbR + 16, easeOutCubic(ringT)),
        stroke: 'warn', strokeWidth: lerp(3.4, 0.9, ringT),
        opacity: (1 - ringT) * smoothstep(0, 0.16, ringT) * 0.68
      });
      return sc;
    }

    // 15. error · 磁震复原（干脆力学弹开错位 → 强磁吸合紧凑阻尼自愈）
    if (state === 'error') {
      sc.spectralPhase = t * 0.9;
      sc.spectralDrift = 1.1;
      sc.errWash = Math.sin(clamp(t / 0.74, 0, 1) * Math.PI) * 0.78;
      if (t < 0.14) {
        var u0 = easeOutCubic(t / 0.14);
        sc.contour = transformContour(ARCH_64, 50 - u0 * 3.5, 52, 1.08, 0.91, -4.5 * u0, 7 * u0);
        sc.bodyD = contourToPath(sc.contour, 1.0);
      } else if (t < 0.62) {
        var u1 = (t - 0.14) / 0.48;
        var spread = Math.sin(u1 * Math.PI);
        var recoil = Math.sin(u1 * Math.PI * 2.5) * (1 - u1) * 1.8;
        var cS = transformContour(SHATTER_SHARDS.crown, 50 + recoil, 50 - spread * 10.5, 1, 1, recoil * 2.2);
        var lS = transformContour(SHATTER_SHARDS.left,  50 - spread * 10.0, 50 + spread * 4.5, 1, 1, -spread * 13);
        var rS = transformContour(SHATTER_SHARDS.right, 50 + spread * 10.0, 50 + spread * 4.5, 1, 1, spread * 13);
        sc.bodyD = contourToPath(cS, 0.96) + ' ' + contourToPath(lS, 0.96) + ' ' + contourToPath(rS, 0.96);
        sc.contour = null;
      } else {
        var u2 = (t - 0.62) / 0.38;
        var damp = Math.sin(u2 * Math.PI * 1.8) * Math.pow(1 - u2, 1.7);
        sc.contour = transformContour(ARCH_64, 50 + damp * 2.5, 50, 1 + damp * 0.08, 1 - damp * 0.08, damp * 2.5);
        sc.bodyD = t > 0.98 ? STATIC_ARCH_D : contourToPath(sc.contour, 1.0);
      }
      return sc;
    }

    return sc;
  }

  // =========================================================================
  // 内部流动四色极光光场（7 层官方拓扑校准倾斜椭圆高斯云，严格遵循官方 Z-order）
  // =========================================================================
  var CLOUD_KEYS = ['redBase', 'em', 'gold', 'blueCore', 'ice', 'redTop', 'lemon'];
  var CLOUD_GRAD = {
    redBase:  'g-redb',
    em:       'g-em',
    gold:     'g-gold',
    blueCore: 'g-blue',
    ice:      'g-ice',
    redTop:   'g-redt',
    lemon:    'g-lem'
  };

  function computeBlobStates(sc) {
    if (typeof sc.ambientSec === 'number') {
      var sec = sc.ambientSec;
      var k = sc.ambientRamp === undefined ? 1 : sc.ambientRamp;
      var pEm   = (sec / 8.6) * TAU;
      var pGold = (sec / 7.2) * TAU;
      var pRed  = (sec / 9.4) * TAU;
      var pBlue = (sec / 10.8) * TAU;
      var pIce  = (sec / 7.9) * TAU;
      var pLem  = (sec / 10.1) * TAU;
      return {
        redBase:  { cx: 79.0 + Math.sin(pRed) * 5.2 * k,        cy: 34.0 + Math.cos(pRed) * 4.8 * k,        rx: 46 + Math.sin(pRed + 0.8) * 3.6 * k,  ry: 40 + Math.cos(pRed) * 3.0 * k,  rot: -13 },
        em:       { cx: 15.5 + Math.cos(pEm) * 5.2 * k,         cy: 35.5 + Math.sin(pEm) * 5.6 * k,         rx: 44 + Math.sin(pEm + 0.6) * 4.0 * k,   ry: 35 + Math.cos(pEm) * 3.0 * k,   rot: -18 },
        gold:     { cx: 45.5 + Math.sin(pGold) * 5.2 * k,       cy: 9.5  + Math.cos(pGold * 0.7) * 3.2 * k, rx: 41 + Math.cos(pGold) * 3.4 * k,       ry: 35 + Math.sin(pGold) * 2.6 * k, rot: 18 },
        blueCore: { cx: 48.5 + Math.sin(pBlue) * 3.4 * k,       cy: 74.8 + Math.cos(pBlue) * 3.8 * k,       rx: 58 + Math.sin(pBlue + 1.1) * 3.0 * k, ry: 39 + Math.cos(pBlue) * 2.8 * k, rot: -8 },
        ice:      { cx: 76.5 + Math.cos(pIce) * 4.6 * k,        cy: 51.5 + Math.sin(pIce) * 5.0 * k,        rx: 32 + Math.sin(pIce) * 3.2 * k,        ry: 24 + Math.cos(pIce) * 2.4 * k,  rot: 38 },
        redTop:   { cx: 68.5 + Math.sin(pRed + 0.8) * 4.8 * k,  cy: 21.8 + Math.cos(pRed + 0.4) * 3.8 * k,  rx: 34 + Math.cos(pRed) * 3.4 * k,        ry: 24 + Math.sin(pRed) * 2.6 * k,  rot: 28 },
        lemon:    { cx: 30.5 + Math.sin(pLem + 2.1) * 4.8 * k,  cy: 22.8 + Math.cos(pLem + 1.4) * 3.6 * k,  rx: 27 + Math.sin(pLem + 0.6) * 3.0 * k,  ry: 25 + Math.cos(pLem) * 2.6 * k,  rot: 22 }
      };
    }

    var a = sc.spectralPhase * TAU;
    var d = sc.spectralDrift;
    var flow = sc.spectralFlowX || 0;
    var pulse = 1 + (sc.spectralPulse || 0);
    return {
      redBase:  { cx: 79.0 + Math.sin(a + 0.5) * 10 * d + flow * 0.9,  cy: 34.0 + Math.cos(a + 0.5) * 8 * d,  rx: 46 * pulse, ry: 40 * pulse, rot: -13 },
      em:       { cx: 15.5 + Math.cos(a + 1.8) * 11 * d + flow,        cy: 35.5 + Math.sin(a + 1.8) * 9 * d,  rx: 44 * pulse, ry: 35 * pulse, rot: -18 },
      gold:     { cx: 45.5 + Math.cos(a) * 10 * d + flow * 0.9,        cy: 9.5  + Math.sin(a) * 7 * d,        rx: 41 * pulse, ry: 35 * pulse, rot: 18 },
      blueCore: { cx: 48.5 + Math.cos(a + 3.8) * 7 * d + flow * 0.6,   cy: 74.8 + Math.sin(a + 3.8) * 6 * d,  rx: 58 * pulse, ry: 39 * pulse, rot: -8 },
      ice:      { cx: 76.5 + Math.sin(a + 2.6) * 9 * d + flow * 0.8,   cy: 51.5 + Math.cos(a + 2.6) * 8 * d,  rx: 32 * pulse, ry: 24 * pulse, rot: 38 },
      redTop:   { cx: 68.5 + Math.sin(a + 0.9) * 9 * d + flow * 0.9,   cy: 21.8 + Math.cos(a + 0.9) * 7 * d,  rx: 34 * pulse, ry: 24 * pulse, rot: 28 },
      lemon:    { cx: 30.5 + Math.sin(a * 1.2) * 8 * d + flow * 0.8,   cy: 22.8 + Math.cos(a * 1.2) * 6 * d,  rx: 27 * pulse, ry: 25 * pulse, rot: 22 }
    };
  }

  function cloneBlobs(src) {
    var out = {};
    for (var i = 0; i < CLOUD_KEYS.length; i++) {
      var k = CLOUD_KEYS[i], b = src[k];
      out[k] = { cx: b.cx, cy: b.cy, rx: b.rx, ry: b.ry, rot: b.rot };
    }
    return out;
  }

  function dampBlobs(cur, target, alpha) {
    for (var i = 0; i < CLOUD_KEYS.length; i++) {
      var k = CLOUD_KEYS[i], c = cur[k], g = target[k];
      c.cx = lerp(c.cx, g.cx, alpha);
      c.cy = lerp(c.cy, g.cy, alpha);
      c.rx = lerp(c.rx, g.rx, alpha);
      c.ry = lerp(c.ry, g.ry, alpha);
      c.rot = lerp(c.rot, g.rot, alpha);
    }
    return cur;
  }

  function resolveColor(token, isSpectral, uid) {
    if (!isSpectral) {
      if (token === 'hole') return 'var(--ag-hole, #131313)';
      return 'currentColor';
    }
    switch (token) {
      case 'gold':     return '#FFE432';
      case 'warn':     return '#FBBC04';
      case 'ok':       return '#00C462';
      case 'err':      return '#FC413D';
      case 'accent':   return '#6EA8FF';
      case 'hole':     return 'var(--ag-hole, #131313)';
      case 'spectral': return 'url(#' + uid + '-aur)';
      default:         return '#3186FF';
    }
  }

  function normalizeGlowMode(v) {
    if (!v || v === 'none' || v === 'false') return '';
    if (v === 'subtle') return 'subtle';
    return 'hero';
  }

  // 同源桌面漫反射滤镜：刻意摒弃贴边紧模糊（避免"散光感"），改为广角哑光桌面受光 + 向下偏移压扁的近地漫射光池
  function buildGlowFilterMarkup(uid, glowMode) {
    if (!glowMode) return '';
    if (glowMode === 'subtle') {
      return (
        '<filter id="' + uid + '-gwide" filterUnits="userSpaceOnUse" x="-140" y="-140" width="380" height="380" color-interpolation-filters="sRGB">' +
          '<feColorMatrix type="saturate" values="1.42"/>' +
          '<feGaussianBlur stdDeviation="24"/>' +
        '</filter>'
      );
    }
    return (
      '<filter id="' + uid + '-gwide" filterUnits="userSpaceOnUse" x="-180" y="-180" width="460" height="460" color-interpolation-filters="sRGB">' +
        '<feColorMatrix type="saturate" values="1.52"/>' +
        '<feGaussianBlur stdDeviation="28"/>' +
        '<feComponentTransfer><feFuncA type="linear" slope="1.26"/></feComponentTransfer>' +
      '</filter>' +
      '<filter id="' + uid + '-gdesk" filterUnits="userSpaceOnUse" x="-140" y="-140" width="380" height="380" color-interpolation-filters="sRGB">' +
        '<feColorMatrix type="saturate" values="1.35"/>' +
        '<feGaussianBlur stdDeviation="17"/>' +
      '</filter>'
    );
  }

  function buildGlowLayerMarkup(uid, glowMode) {
    if (!glowMode) return '';
    if (glowMode === 'subtle') {
      return (
        '<g class="ag-glow-wrap" style="opacity:var(--ag-glow-subtle-opacity,0.66)">' +
          '<g class="ag-glow-inner">' +
            '<use class="ag-glow-wide" href="#' + uid + '-spectral" filter="url(#' + uid + '-gwide)" opacity="0.78" transform="translate(50 57) scale(1.36 1.18) translate(-50 -50)"/>' +
          '</g>' +
        '</g>'
      );
    }
    return (
      '<g class="ag-glow-wrap" style="opacity:var(--ag-glow-opacity,0.90)">' +
        '<g class="ag-glow-inner">' +
          '<use class="ag-glow-wide" href="#' + uid + '-spectral" filter="url(#' + uid + '-gwide)" opacity="0.80" transform="translate(50 54) scale(1.56 1.38) translate(-50 -50)"/>' +
          '<use class="ag-glow-desk" href="#' + uid + '-spectral" filter="url(#' + uid + '-gdesk)" opacity="0.46" transform="translate(50 63) scale(1.16 0.84) translate(-50 -50)"/>' +
        '</g>' +
      '</g>'
    );
  }

  function buildDefsMarkup(uid, glowMode) {
    function gaussGrad(id, c0, op0, c1) {
      var c = c1 || c0;
      return (
        '<radialGradient id="' + uid + '-' + id + '" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0%" stop-color="' + c0 + '" stop-opacity="' + fmt(op0) + '"/>' +
          '<stop offset="22%" stop-color="' + c0 + '" stop-opacity="' + fmt(op0 * 0.90) + '"/>' +
          '<stop offset="46%" stop-color="' + c + '" stop-opacity="' + fmt(op0 * 0.58) + '"/>' +
          '<stop offset="70%" stop-color="' + c + '" stop-opacity="' + fmt(op0 * 0.22) + '"/>' +
          '<stop offset="88%" stop-color="' + c + '" stop-opacity="' + fmt(op0 * 0.05) + '"/>' +
          '<stop offset="100%" stop-color="' + c + '" stop-opacity="0"/>' +
        '</radialGradient>'
      );
    }
    var glowFilter = buildGlowFilterMarkup(uid, glowMode);
    return (
      gaussGrad('g-redb', '#FC413D', 0.94, '#F44336') +
      gaussGrad('g-em',   '#00B95C', 0.98, '#00B258') +
      gaussGrad('g-gold', '#FBBC04', 0.96, '#FCC91B') +
      gaussGrad('g-blue', '#3186FF', 1.00, '#3186FF') +
      gaussGrad('g-ice',  '#749BFF', 0.86, '#5E91FF') +
      gaussGrad('g-redt', '#FC413D', 0.96, '#FA463E') +
      gaussGrad('g-lem',  '#FFEE48', 0.92, '#FFE432') +
      gaussGrad('g-err',  '#FC413D', 0.96, '#D93025') +
      gaussGrad('g-ok',   '#00C866', 0.88, '#34D399') +
      '<linearGradient id="' + uid + '-aur" x1="15" y1="15" x2="85" y2="85" gradientUnits="userSpaceOnUse">' +
        '<stop offset="0%" stop-color="#FFE432"/>' +
        '<stop offset="32%" stop-color="#FC413D"/>' +
        '<stop offset="68%" stop-color="#00B95C"/>' +
        '<stop offset="100%" stop-color="#3186FF"/>' +
      '</linearGradient>' +
      glowFilter +
      // 单一 SVG <mask> 隔离抗锯齿：内部 7 层合成完毕后仅做一次抗锯齿裁切，根除多层 clipPath 黑边锯齿
      '<mask id="' + uid + '-mask" maskUnits="userSpaceOnUse" x="-12" y="-12" width="124" height="124">' +
        '<path class="ag-mask-path" fill="#ffffff" fill-rule="nonzero" d=""/>' +
      '</mask>'
    );
  }

  function serializePrims(list, isSpectral, uid) {
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var op = it.opacity !== undefined ? ' opacity="' + fmt(clamp(it.opacity, 0, 1)) + '"' : '';
      if (it.kind === 'circle') {
        var fc = it.fill ? resolveColor(it.fill, isSpectral, uid) : 'none';
        var sc = it.stroke ? ' stroke="' + resolveColor(it.stroke, isSpectral, uid) + '" stroke-width="' + fmt(it.strokeWidth || 1.8) + '"' : '';
        out += '<circle cx="' + fmt(it.cx) + '" cy="' + fmt(it.cy) + '" r="' + fmt(Math.max(0.1, it.r)) + '" fill="' + fc + '"' + sc + op + '/>';
      } else if (it.kind === 'arc') {
        out += '<path d="' + it.d + '" fill="none" stroke="' + resolveColor(it.stroke, isSpectral, uid) + '" stroke-width="' + fmt(it.strokeWidth || 1.8) + '" stroke-linecap="round"' + op + '/>';
      } else if (it.kind === 'fill') {
        out += '<path d="' + it.d + '" fill="' + resolveColor(it.fill, isSpectral, uid) + '" fill-rule="nonzero"' + op + '/>';
      }
    }
    return out;
  }

  function renderSVG(state, t, opts) {
    opts = opts || {};
    var uid = opts.uid || 'agv0';
    var pal = opts.palette || 'spectral';
    var isSpectral = pal === 'spectral';
    var glowMode = isSpectral ? normalizeGlowMode(opts.glow) : '';
    var size = opts.size || 64;
    var sc = computeScene(state || 'static', t || 0, opts.effort || 'medium', 0, {
      phase: opts.phase || 'loop',
      snap: opts.snap || null,
      nextState: opts.nextState || '',
      ambientSec: typeof opts.ambientSec === 'number' ? opts.ambientSec : undefined,
      ambientRamp: 1
    });
    var blobs = computeBlobStates(sc);

    var defs = buildDefsMarkup(uid, glowMode).replace('d=""', 'd="' + sc.bodyD + '"');
    var bodySvg = '';
    var glowSvg = '';
    if (sc.bodyAlpha > 0.005) {
      var opStr = sc.bodyAlpha < 0.995 ? ' opacity="' + fmt(sc.bodyAlpha) + '"' : '';
      if (isSpectral) {
        var cloudsSvg = '';
        for (var ci = 0; ci < CLOUD_KEYS.length; ci++) {
          var ck = CLOUD_KEYS[ci], cb = blobs[ck];
          cloudsSvg += '<ellipse cx="' + fmt(cb.cx) + '" cy="' + fmt(cb.cy) + '" rx="' + fmt(cb.rx) + '" ry="' + fmt(cb.ry) +
            '" transform="rotate(' + fmt(cb.rot) + ' ' + fmt(cb.cx) + ' ' + fmt(cb.cy) + ')" fill="url(#' + uid + '-' + CLOUD_GRAD[ck] + ')"/>';
        }
        bodySvg =
          '<g id="' + uid + '-spectral" mask="url(#' + uid + '-mask)"' + opStr + '>' +
            '<rect x="-12" y="-12" width="124" height="124" fill="#3186FF"/>' +
            cloudsSvg +
            (sc.errWash > 0.01 ? '<rect x="-12" y="-12" width="124" height="124" fill="url(#' + uid + '-g-err)" opacity="' + fmt(sc.errWash) + '"/>' : '') +
            (sc.okWash  > 0.01 ? '<rect x="-12" y="-12" width="124" height="124" fill="url(#' + uid + '-g-ok)"  opacity="' + fmt(sc.okWash)  + '"/>' : '') +
          '</g>';
        if (glowMode) glowSvg = buildGlowLayerMarkup(uid, glowMode);
      } else {
        bodySvg = '<path d="' + sc.bodyD + '" fill="currentColor" fill-rule="nonzero"' + opStr + '/>';
      }
    }

    var styles = [];
    if (!isSpectral) styles.push('color:' + pal);
    if (glowMode) styles.push('overflow:visible');
    var styleAttr = styles.length ? ' style="' + styles.join(';') + '"' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" shape-rendering="geometricPrecision" width="' + size + '" height="' + size + '"' + styleAttr + '>' +
      '<defs>' + defs + '</defs>' +
      glowSvg +
      serializePrims(sc.under, isSpectral, uid) +
      bodySvg +
      serializePrims(sc.over, isSpectral, uid) +
    '</svg>';
  }

  // =========================================================================
  // 持久化 SVG DOM 节点池 + 连续流体实时控制器
  // =========================================================================
  function setAttr(el, k, v) { if (el.getAttribute(k) !== v) el.setAttribute(k, v); }
  function createEl(tag) { return document.createElementNS(SVG_NS, tag); }

  function syncOverDOM(groupEl, items, isSpectral, uid) {
    var children = groupEl.children;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var tag = (it.kind === 'arc' || it.kind === 'fill') ? 'path' : 'circle';
      var node = children[i];
      if (!node || node.tagName.toLowerCase() !== tag) {
        var fresh = createEl(tag);
        if (node) groupEl.replaceChild(fresh, node);
        else groupEl.appendChild(fresh);
        node = fresh;
      }
      if (node.style.display === 'none') node.style.display = '';
      var op = it.opacity !== undefined ? fmt(clamp(it.opacity, 0, 1)) : '1';
      if (it.kind === 'circle') {
        setAttr(node, 'cx', fmt(it.cx));
        setAttr(node, 'cy', fmt(it.cy));
        setAttr(node, 'r', fmt(Math.max(0.1, it.r)));
        setAttr(node, 'fill', it.fill ? resolveColor(it.fill, isSpectral, uid) : 'none');
        setAttr(node, 'stroke', it.stroke ? resolveColor(it.stroke, isSpectral, uid) : 'none');
        setAttr(node, 'stroke-width', it.stroke ? fmt(it.strokeWidth || 1.8) : '0');
        setAttr(node, 'opacity', op);
      } else if (it.kind === 'fill') {
        setAttr(node, 'd', it.d);
        setAttr(node, 'fill', resolveColor(it.fill, isSpectral, uid));
        setAttr(node, 'fill-rule', 'nonzero');
        setAttr(node, 'stroke', 'none');
        setAttr(node, 'opacity', op);
      } else {
        setAttr(node, 'd', it.d);
        setAttr(node, 'fill', 'none');
        setAttr(node, 'stroke', resolveColor(it.stroke, isSpectral, uid));
        setAttr(node, 'stroke-width', fmt(it.strokeWidth || 1.8));
        setAttr(node, 'stroke-linecap', 'round');
        setAttr(node, 'opacity', op);
      }
    }
    for (var k = items.length; k < children.length; k++) {
      if (children[k].style.display !== 'none') children[k].style.display = 'none';
    }
  }

  // 单轮廓连续体状态（彼此之间可直接弹簧直融，出发切向复合态也可直接起手入场）
  var SINGLE_CONTOUR_STATES = {
    static: true, ambient: true, waiting: true, thinking: true, writing: true, planning: true
  };

  var _nextUid = 1;
  var _reducedMotion = false;
  if (typeof window !== 'undefined' && window.matchMedia) {
    try {
      var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      _reducedMotion = !!mq.matches;
      if (mq.addEventListener) mq.addEventListener('change', function (e) { _reducedMotion = !!e.matches; });
    } catch (_e) {}
  }

  function Controller(box, opts) {
    opts = opts || {};
    this.box = box;
    this.uid = 'agv' + (_nextUid++);
    this.speedMultiplier = opts.speedMultiplier || 1;
    this.effort = EFFORT_CFG[opts.effort] ? opts.effort : 'medium';
    this.palette = opts.palette || 'spectral';
    this.glow = normalizeGlowMode(opts.glow);
    this.interactive = !!opts.interactive;
    this.current = opts.then && META[opts.then] ? opts.then : 'static';
    this._playing = 'static';
    this._phase = 'loop';
    this._phaseSnap = null;
    this._pendingState = null;
    this._pendingOpts = null;
    this._revertAfter = false;
    this._revertTo = null;
    this._iterationsLeft = Infinity;
    this._raf = 0;
    this._startTs = 0;
    this._lastDrawTs = 0;
    this._visible = true;
    this._fromContour = null;
    this._blendStart = 0;
    this._lastContour = ARCH_64;
    this._curBlobs = null;
    this._lastLensState = null;
    this._lastEditState = null;
    this._lastPhaseData = null;
    this._pressDownTs = 0;
    this._pressBoost = 0;
    this._hoverTarget = 0;
    this._hoverAmt = 0;
    this._ambPhaseSec = 0;
    this._hoverFlowBonus = 0;
    this._frozenT = null;
    this.onStateChange = opts.onStateChange || null;

    box.classList.add('ag-logo');
    if (opts.size) {
      box.style.width = box.style.height = (typeof opts.size === 'number' ? opts.size + 'px' : opts.size);
    }
    if (this.palette !== 'spectral') box.style.color = this.palette;

    this._buildDOM();
    this._bindVisibility();
    if (this.interactive) this.setInteractive(true);
    this.setState(opts.state || 'static', { skipEnter: !!opts.skipEnter, immediate: true, then: opts.then });
  }

  Controller.prototype._buildDOM = function () {
    var uid = this.uid;
    var svg = createEl('svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('shape-rendering', 'geometricPrecision');
    svg.setAttribute('aria-hidden', 'true');
    if (this.glow || this.interactive) svg.style.overflow = 'visible';
    var glowMarkup = buildGlowLayerMarkup(uid, this.glow);
    svg.innerHTML =
      '<defs>' + buildDefsMarkup(uid, this.glow) + '</defs>' +
      glowMarkup +
      '<g class="ag-stage">' +
        '<g class="ag-under"></g>' +
        '<g class="ag-body">' +
          '<g id="' + uid + '-spectral" class="ag-spectral-wrap" mask="url(#' + uid + '-mask)">' +
            '<rect x="-12" y="-12" width="124" height="124" fill="#3186FF"/>' +
            '<ellipse class="ag-b-redBase"  cx="79" cy="34" rx="46" ry="40" fill="url(#' + uid + '-g-redb)"/>' +
            '<ellipse class="ag-b-em"       cx="15.5" cy="35.5" rx="44" ry="35" fill="url(#' + uid + '-g-em)"/>' +
            '<ellipse class="ag-b-gold"     cx="45.5" cy="9.5" rx="41" ry="35" fill="url(#' + uid + '-g-gold)"/>' +
            '<ellipse class="ag-b-blueCore" cx="48.5" cy="74.8" rx="58" ry="39" fill="url(#' + uid + '-g-blue)"/>' +
            '<ellipse class="ag-b-ice"      cx="76.5" cy="51.5" rx="32" ry="24" fill="url(#' + uid + '-g-ice)"/>' +
            '<ellipse class="ag-b-redTop"   cx="68.5" cy="21.8" rx="34" ry="24" fill="url(#' + uid + '-g-redt)"/>' +
            '<ellipse class="ag-b-lemon"    cx="30.5" cy="22.8" rx="27" ry="25" fill="url(#' + uid + '-g-lem)"/>' +
            '<rect class="ag-wash-err" x="-12" y="-12" width="124" height="124" fill="url(#' + uid + '-g-err)" opacity="0"/>' +
            '<rect class="ag-wash-ok"  x="-12" y="-12" width="124" height="124" fill="url(#' + uid + '-g-ok)"  opacity="0"/>' +
          '</g>' +
          '<g class="ag-mono-wrap" style="display:none">' +
            '<path class="ag-mono-path" fill="currentColor" fill-rule="nonzero" d=""/>' +
          '</g>' +
        '</g>' +
        '<g class="ag-over"></g>' +
      '</g>';

    this.box.innerHTML = '';
    this.box.appendChild(svg);

    this._svg = svg;
    this._el = {
      maskPath:      svg.querySelector('.ag-mask-path'),
      aurGrad:       svg.querySelector('#' + uid + '-aur'),
      glowWrap:      svg.querySelector('.ag-glow-wrap'),
      glowInner:     svg.querySelector('.ag-glow-inner'),
      glowWide:      svg.querySelector('.ag-glow-wide'),
      glowDesk:      svg.querySelector('.ag-glow-desk'),
      stage:         svg.querySelector('.ag-stage'),
      under:         svg.querySelector('.ag-under'),
      over:          svg.querySelector('.ag-over'),
      spectralWrap:  svg.querySelector('.ag-spectral-wrap'),
      monoWrap:      svg.querySelector('.ag-mono-wrap'),
      monoPath:      svg.querySelector('.ag-mono-path'),
      washErr:       svg.querySelector('.ag-wash-err'),
      washOk:        svg.querySelector('.ag-wash-ok'),
      blobs: {
        redBase:  svg.querySelector('.ag-b-redBase'),
        em:       svg.querySelector('.ag-b-em'),
        gold:     svg.querySelector('.ag-b-gold'),
        blueCore: svg.querySelector('.ag-b-blueCore'),
        ice:      svg.querySelector('.ag-b-ice'),
        redTop:   svg.querySelector('.ag-b-redTop'),
        lemon:    svg.querySelector('.ag-b-lemon')
      }
    };
  };

  Controller.prototype._bindVisibility = function () {
    var self = this;
    if (typeof IntersectionObserver !== 'undefined') {
      this._io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) self._visible = entries[i].isIntersecting;
        self._syncLoop();
      }, { threshold: 0 });
      this._io.observe(this.box);
    }
    if (typeof document !== 'undefined') {
      this._onVis = function () { self._syncLoop(); };
      document.addEventListener('visibilitychange', this._onVis);
    }
  };

  Controller.prototype.destroy = function () {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this._onVis && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVis);
    if (this._interBound) {
      this.box.removeEventListener('pointerenter', this._onEnter);
      this.box.removeEventListener('pointerdown', this._onDown);
      this.box.removeEventListener('pointerup', this._onUp);
      this.box.removeEventListener('pointerleave', this._onCancel);
      this.box.removeEventListener('pointercancel', this._onCancel);
    }
  };

  Controller.prototype.setInteractive = function (on) {
    this.interactive = !!on;
    this.box.classList.toggle('is-interactive', this.interactive);
    if (this._svg && (this.glow || this.interactive)) this._svg.style.overflow = 'visible';
    if (!this.interactive) {
      this._hoverTarget = 0;
      this._pressDownTs = 0;
      this._syncLoop();
    }
    if (on && !this._interBound) {
      var self = this;
      // 悬停只做轻盈微交互（桌面漫反射加强 + 内部流彩提速 + 轻幅放大悬浮），绝不误触发弹跳
      this._onEnter = function (ev) {
        if (!self.interactive || ev.pointerType === 'touch') return;
        self._hoverTarget = 1;
        self._syncLoop();
      };
      // 仅真正按下蓄力、并在图标内松开时触发反重力软弹 tickle
      this._onDown = function () {
        if (!self.interactive) return;
        if (self.current !== 'static' && self.current !== 'ambient' && self.current !== 'waiting') return;
        self._pressDownTs = performance.now();
        self._syncLoop();
      };
      this._onUp = function () {
        if (!self.interactive || !self._pressDownTs) return;
        var held = clamp((performance.now() - self._pressDownTs) / 360, 0, 1);
        self._pressDownTs = 0;
        if (self.current === 'static' || self.current === 'ambient' || self.current === 'waiting') {
          self._pressBoost = held;
          self.play('tickle', { then: self.current });
        }
      };
      this._onCancel = function () {
        self._hoverTarget = 0;
        if (self._pressDownTs) self._pressDownTs = 0;
        self._syncLoop();
      };
      this.box.addEventListener('pointerenter', this._onEnter);
      this.box.addEventListener('pointerdown', this._onDown);
      this.box.addEventListener('pointerup', this._onUp);
      this.box.addEventListener('pointerleave', this._onCancel);
      this.box.addEventListener('pointercancel', this._onCancel);
      this._interBound = true;
    }
  };

  Controller.prototype.setGlow = function (mode) {
    var next = normalizeGlowMode(mode);
    if (next === this.glow) return;
    this.glow = next;
    if (!this._svg) return;
    var uid = this.uid;
    var svg = this._svg;
    svg.style.overflow = (this.glow || this.interactive) ? 'visible' : '';

    var defs = svg.querySelector('defs');
    if (defs) {
      var oldWide = defs.querySelector('#' + uid + '-gwide');
      var oldDesk = defs.querySelector('#' + uid + '-gdesk');
      if (oldWide) defs.removeChild(oldWide);
      if (oldDesk) defs.removeChild(oldDesk);
      if (this.glow) {
        var tmpF = createEl('svg');
        tmpF.innerHTML = buildGlowFilterMarkup(uid, this.glow);
        while (tmpF.firstChild) defs.appendChild(tmpF.firstChild);
      }
    }

    if (this._el.glowWrap && this._el.glowWrap.parentNode) {
      this._el.glowWrap.parentNode.removeChild(this._el.glowWrap);
    }
    this._el.glowWrap = null;
    this._el.glowInner = null;
    this._el.glowWide = null;
    this._el.glowDesk = null;

    if (this.glow) {
      var tmpG = createEl('svg');
      tmpG.innerHTML = buildGlowLayerMarkup(uid, this.glow);
      var newWrap = tmpG.firstChild;
      if (newWrap) {
        if (this.palette !== 'spectral') newWrap.style.display = 'none';
        svg.insertBefore(newWrap, this._el.stage);
        this._el.glowWrap  = newWrap;
        this._el.glowInner = newWrap.querySelector('.ag-glow-inner');
        this._el.glowWide  = newWrap.querySelector('.ag-glow-wide');
        this._el.glowDesk  = newWrap.querySelector('.ag-glow-desk');
      }
    }

    var now = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._drawAt(this._frozenT !== null ? this._frozenT : this._currentProgress(now), now);
  };

  Controller.prototype.setPalette = function (palette) {
    this.palette = palette || 'spectral';
    this.box.style.color = this.palette !== 'spectral' ? this.palette : '';
    var now = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._drawAt(this._frozenT !== null ? this._frozenT : this._currentProgress(now), now);
  };

  Controller.prototype.setEffort = function (effort) {
    this.effort = EFFORT_CFG[effort] ? effort : 'medium';
    var now = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._drawAt(this._frozenT !== null ? this._frozenT : this._currentProgress(now), now);
  };

  Controller.prototype.setSpeed = function (mult) {
    this.speedMultiplier = Math.max(0.1, +mult || 1);
  };

  Controller.prototype.freezeAt = function (t, phase) {
    this._frozenT = (t === null || t === undefined) ? null : clamp(+t, 0, 0.9999);
    if (phase) this._phase = phase;
    if (this._frozenT !== null) {
      this._fromContour = null;
      this._curBlobs = null;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
      this._drawAt(this._frozenT, performance.now());
    } else {
      this._startTs = performance.now();
      this._lastDrawTs = this._startTs;
      this._syncLoop();
    }
  };

  Controller.prototype.setState = function (name, opts) {
    opts = opts || {};
    if (!META[name]) name = 'static';
    if (name !== 'tickle') this.current = (opts.then && META[opts.then]) ? opts.then : name;

    var curMeta = META[this._playing];
    if (!opts.immediate && !_reducedMotion && this._frozenT === null && curMeta && curMeta.phased) {
      if (this._phase === 'leave') {
        if (name === this._playing) {
          this._pendingState = null;
          this._pendingOpts = null;
        } else {
          this._pendingState = name;
          this._pendingOpts = opts;
          return;
        }
      } else if (name !== this._playing) {
        // 单轮廓连续体出发时永不绕路归拱：目标是单轮廓直接液态直融，目标是复合态直接以当前轮廓起手入场
        if (SINGLE_CONTOUR_STATES[this._playing]) {
          this._pendingState = null;
          this._pendingOpts = null;
          if (SINGLE_CONTOUR_STATES[name]) {
            this._phase = 'loop';
            this._phaseSnap = null;
            return this._start(name, META[name].loop ? Infinity : (name === 'static' ? 0 : 1), !opts.holdEnd && !META[name].loop && name !== 'static', opts.then);
          }
          return this._enterState(name, opts);
        }
        return this._beginLeave(name, opts);
      } else if (!opts.forceEnter) {
        return;
      }
    }

    this._pendingState = null;
    this._pendingOpts = null;
    return this._enterState(name, opts);
  };

  Controller.prototype._enterState = function (name, opts) {
    opts = opts || {};
    var m = META[name];
    if (m && m.phased && !opts.skipEnter && !_reducedMotion && this._frozenT === null) {
      this._phase = 'enter';
      this._phaseSnap = { contour: this._lastContour || ARCH_64, lensState: this._lastLensState, editState: this._lastEditState, phaseData: this._lastPhaseData };
      return this._start(name, 1, false, null);
    }
    this._phase = 'loop';
    this._phaseSnap = null;
    return this._start(name, m.loop ? Infinity : (name === 'static' ? 0 : 1), !opts.holdEnd && !m.loop && name !== 'static', opts.then);
  };

  Controller.prototype._beginLeave = function (nextState, nextOpts) {
    var now = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._pendingState = nextState || 'static';
    this._pendingOpts = nextOpts || {};
    this._phase = 'leave';
    this._phaseSnap = { contour: this._lastContour || ARCH_64, lensState: this._lastLensState, editState: this._lastEditState, phaseData: this._lastPhaseData };
    this._fromContour = null;
    this._iterationsLeft = 1;
    this._revertAfter = false;
    this._revertTo = null;
    this._startTs = now;
    this.box.setAttribute('data-phase', 'leave');
    if (this.onStateChange) this.onStateChange(this._playing, 'leave');
    this._drawAt(0, now);
    this._syncLoop();
  };

  Controller.prototype.finish = function (nextState) {
    return this.setState(nextState || 'static');
  };

  Controller.prototype.restartEnter = function (name) {
    var target = name || this._playing;
    if (!META[target]) return;
    this._lastContour = ARCH_64;
    this._lastLensState = null;
    this._lastEditState = null;
    this._lastPhaseData = null;
    this._pendingState = null;
    this._phase = 'loop';
    return this.setState(target, { immediate: true, forceEnter: true, skipEnter: false });
  };

  Controller.prototype.play = function (name, opts) {
    if (!META[name]) return;
    this._phase = 'loop';
    this._phaseSnap = null;
    this._pendingState = null;
    var iter = (opts && opts.iterations) ? opts.iterations : 1;
    var holdEnd = !!(opts && opts.holdEnd);
    var thenSt = (opts && opts.then && META[opts.then]) ? opts.then : null;
    return this._start(name, iter, !holdEnd, thenSt);
  };

  Controller.prototype.stop = function () { return this.finish('static'); };

  Controller.prototype._effectiveDuration = function (name, phase) {
    var m = META[name];
    if (!m) return 0;
    var ph = phase || this._phase;
    var baseDur = (ph === 'enter' && m.enterDuration) ? m.enterDuration
                : (ph === 'leave' && m.leaveDuration) ? m.leaveDuration
                : m.duration;
    if (!baseDur) return 0;
    // 复合态切往另一复合态时，leave 仅作极短配件收起/聚核交接（~175ms），随后直接进入下一态 enter
    if (ph === 'leave' && this._pendingState && !ARCH_REST_STATES[this._pendingState]) {
      var isDirectSingle = !!getDirectTargetContour(this._pendingState, EFFORT_CFG[this.effort] || EFFORT_CFG.medium);
      baseDur *= isDirectSingle ? 0.94 : 0.50;
    }
    var rate = (ph === 'loop' && (name === 'thinking' || name === 'writing' || name === 'executing' || name === 'orbiting'))
      ? (EFFORT_CFG[this.effort] ? EFFORT_CFG[this.effort].rate : 1)
      : 1;
    return baseDur / (Math.max(0.1, this.speedMultiplier) * rate);
  };

  Controller.prototype._start = function (name, iterations, revertAfter, revertTo) {
    var now = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._fromContour = (this._phase === 'enter' || this._phase === 'leave')
      ? null
      : (this._lastContour === ARCH_64 ? ARCH_64 : alignContourToTop(this._lastContour || ARCH_64));
    this._blendStart = now;
    this._playing = name;
    this._iterationsLeft = iterations;
    this._revertAfter = !!revertAfter;
    this._revertTo = revertTo || null;
    this._startTs = now;
    this.box.setAttribute('data-state', name);
    this.box.setAttribute('data-phase', this._phase);
    if (this.onStateChange) this.onStateChange(name, this._phase);

    if (this._frozenT !== null) {
      this._fromContour = null;
      this._drawAt(this._frozenT, now);
      return;
    }
    if (_reducedMotion) {
      this._fromContour = null;
      // 减动效模式：一次性事件态（如 success / error）直接落到目标静息态，不停留在中间帧
      if (this._revertAfter) {
        var settled = this._revertTo || ((this._playing === this.current) ? 'static' : this.current);
        this._playing = settled;
        this.current = settled;
        this._iterationsLeft = 0;
        this._revertAfter = false;
        this._revertTo = null;
        this.box.setAttribute('data-state', settled);
        if (this.onStateChange) this.onStateChange(settled, this._phase);
        this._drawAt((settled === 'static' || settled === 'ambient') ? 0 : 0.44, now);
        return;
      }
      this._drawAt((name === 'static' || name === 'ambient') ? 0 : 0.44, now);
      return;
    }
    // 页面隐藏或元素不在视口内切入静息态（如 static）时直接落定目标轮廓，避免 rAF 暂停导致永久停留在旧轮廓（例如思考液滴）
    var docHidden = (typeof document !== 'undefined') && document.hidden;
    if ((docHidden || !this._visible) && !this._effectiveDuration(name, this._phase)) {
      this._fromContour = null;
    }
    this._drawAt(0, now);
    this._syncLoop();
  };

  Controller.prototype._currentProgress = function (now) {
    var dur = this._effectiveDuration(this._playing, this._phase);
    if (!dur) return 0;
    var elapsed = Math.max(0, now - this._startTs);
    if (this._iterationsLeft !== Infinity && elapsed >= dur * this._iterationsLeft) return 0.999;
    return (elapsed % dur) / dur;
  };

  Controller.prototype._syncLoop = function () {
    if (this._frozenT !== null) return;
    var docHidden = (typeof document !== 'undefined') && document.hidden;
    var now = (typeof performance !== 'undefined') ? performance.now() : 0;
    // 融合计时已过期（如切后台、滚出视口或长卡帧后恢复）：先补画一帧落定最终轮廓，防止 activeDur=0 时停在旧形态
    if (this._fromContour && (now - this._blendStart >= BLEND_MS + 16)) {
      this._fromContour = null;
      this._drawAt(this._currentProgress(now), now);
    }
    var blending = this._fromContour && (now - this._blendStart < BLEND_MS + 16);
    var charging = this._pressDownTs > 0;
    var hovering = this._hoverTarget > 0 || this._hoverAmt > 0.002;
    var activeDur = this._effectiveDuration(this._playing, this._phase);
    var needRun = !docHidden && this._visible && !_reducedMotion && (activeDur > 0 || blending || charging || hovering);

    if (needRun && !this._raf) {
      var self = this;
      this._raf = requestAnimationFrame(function (ts) {
        self._raf = 0;
        self._step(ts);
      });
    } else if (!needRun && this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  };

  Controller.prototype._step = function (now) {
    var dur = this._effectiveDuration(this._playing, this._phase);
    var elapsed = Math.max(0, now - this._startTs);
    if (dur > 0 && this._iterationsLeft !== Infinity) {
      if (elapsed >= dur * this._iterationsLeft) {
        if (this._phase === 'enter') {
          this._phase = 'loop';
          this._phaseSnap = null;
          this._iterationsLeft = Infinity;
          this._startTs = now;
          this.box.setAttribute('data-phase', 'loop');
          if (this.onStateChange) this.onStateChange(this._playing, 'loop');
          this._drawAt(0, now);
          this._syncLoop();
          return;
        }
        if (this._phase === 'leave') {
          var target = this._pendingState || 'static';
          var targetOpts = this._pendingOpts || {};
          var finalSc = computeScene(this._playing, 0.999, this.effort, 0, {
            phase: 'leave',
            snap: this._phaseSnap,
            nextState: target
          });
          var directC = getDirectTargetContour(target, EFFORT_CFG[this.effort] || EFFORT_CFG.medium);
          this._pendingState = null;
          this._pendingOpts = null;
          this._phase = 'loop';
          this._phaseSnap = null;
          this._lastLensState = null;
          this._lastEditState = null;
          this._lastPhaseData = null;
          if (directC && directC !== ARCH_64) {
            // leave 已直接将上一态液态融变为目标单轮廓（thinking/writing/planning），直接进入 loop 零顿挫
            this._lastContour = directC;
            this._enterState(target, Object.assign({}, targetOpts, { skipEnter: true }));
            this._fromContour = null;
          } else if (directC === ARCH_64) {
            this._lastContour = ARCH_64;
            this._enterState(target, targetOpts);
          } else {
            // 复合态→复合态：保留 leave 收束后的单轮廓（画笔 / > / 月牙 / 圆核）直接起手下一态 enter，不经 A 拱
            this._lastContour = finalSc.contour || this._lastContour || makeOrbContour(50, 50, 25, 25);
            this._enterState(target, targetOpts);
          }
          return;
        }
        if (this._revertAfter) {
          var back = this._revertTo || ((this._playing === this.current) ? 'static' : this.current);
          this._pressBoost = 0;
          this._revertTo = null;
          this.setState(back, { immediate: true });
          return;
        } else {
          this._drawAt(0.999, now);
          return;
        }
      }
    }
    var t = dur > 0 ? (elapsed % dur) / dur : 0;
    this._drawAt(t, now);
    this._syncLoop();
  };

  Controller.prototype._drawAt = function (t, now) {
    var rawDt = this._lastDrawTs ? Math.max(0, now - this._lastDrawTs) : 0;
    this._lastDrawTs = now;
    var stepDt = (rawDt > 0 && rawDt <= 140) ? Math.min(rawDt, 64) : (rawDt > 140 ? 16 : 0);

    // 悬停势能平滑阻尼追随（离开平滑回落归零，冻结/减动效时归零）
    if (this._frozenT !== null || _reducedMotion) {
      this._hoverAmt = 0;
    } else if (stepDt > 0) {
      this._hoverAmt = lerp(this._hoverAmt, this._hoverTarget, 1 - Math.exp(-stepDt / 110));
      if (this._hoverTarget === 0 && this._hoverAmt < 0.002) this._hoverAmt = 0;
      else if (this._hoverTarget === 1 && this._hoverAmt > 0.998) this._hoverAmt = 1;
    }
    var hAmt = this._hoverAmt;

    var m = META[this._playing];
    var isCont = !!(m && m.continuous);
    var ambSec = undefined;
    var ambRamp = 1;
    if (isCont) {
      if (this._frozenT !== null) {
        ambSec = t * 10;
        ambRamp = 1;
      } else {
        // 用积分时钟驱动流彩加速，悬停平滑提速至 ~2.45x、移开平滑减速不倒转不跳帧
        var flowBoost = 1 + hAmt * 1.45;
        this._ambPhaseSec += (stepDt / 1000) * Math.max(0.1, this.speedMultiplier) * flowBoost;
        ambSec = this._ambPhaseSec;
        var elapsedSec = Math.max(0, (now - this._startTs) / 1000);
        ambRamp = smoothstep(0, 0.9, elapsedSec) * (1 + hAmt * 0.22);
      }
    } else if (this._playing === 'static' && hAmt > 0.002) {
      this._ambPhaseSec += (stepDt / 1000) * Math.max(0.1, this.speedMultiplier) * (1.2 + hAmt * 1.25);
    }

    var sc = computeScene(this._playing, t, this.effort, this._pressBoost, {
      phase: this._phase,
      snap: this._phaseSnap,
      nextState: this._pendingState,
      ambientSec: ambSec,
      ambientRamp: ambRamp
    });

    // 非 ambient 态悬停时，内部极光云也同步提速流转（静默累积不跳相位）
    if (hAmt > 0.002) {
      if (this._playing === 'static' && !this._pressDownTs) {
        sc.ambientSec = this._ambPhaseSec;
        sc.ambientRamp = hAmt * 0.85;
      } else if (!isCont) {
        this._hoverFlowBonus += (stepDt / 1000) * 0.45 * hAmt;
        sc.spectralPhase += this._hoverFlowBonus;
        sc.spectralDrift = Math.max(sc.spectralDrift, hAmt * 0.55) * (1 + hAmt * 0.25);
      }
    }

    var holdU = 0;
    if (this._pressDownTs > 0 && sc.contour) {
      holdU = easeOutCubic(clamp((now - this._pressDownTs) / 260, 0, 1));
      sc.contour = lerpContours(sc.contour, SQUASH_64, holdU * 0.90);
      sc.bodyD = contourToPath(sc.contour, 1.0);
      sc.spectralPhase = holdU * 0.35;
      sc.spectralDrift = 0.9;
    }

    // 单轮廓连续体直接 M3 弹簧融变（拱→拱跳过插值保持精确静态路径；单次事件态使用更快融合以保留爆发节拍）
    if (this._fromContour && sc.contour && this._playing !== 'entrance' && this._playing !== 'exit') {
      if ((this._playing === 'static' || this._playing === 'ambient') && this._fromContour === ARCH_64) {
        this._fromContour = null;
      } else {
        var blendDur = (this._playing === 'success' || this._playing === 'error' || this._playing === 'tickle') ? 200 : BLEND_MS;
        var bt = clamp((now - this._blendStart) / blendDur, 0, 1);
        if (bt < 1) {
          sc.contour = lerpContours(this._fromContour, sc.contour, easeEmphasized(bt));
          sc.bodyD = contourToPath(sc.contour, 0.98);
        } else {
          this._fromContour = null;
        }
      }
    } else if (!sc.contour) {
      this._fromContour = null;
    }
    if (sc.contour) this._lastContour = sc.contour;
    if (sc.lensState) this._lastLensState = sc.lensState;
    if (sc.editState) this._lastEditState = sc.editState;
    if (sc.phaseData) this._lastPhaseData = sc.phaseData;

    var el = this._el;
    var isSpectral = this.palette === 'spectral';
    var uid = this.uid;

    setAttr(el.maskPath, 'd', sc.bodyD);

    // 悬停轻幅放大 + 微悬浮抬升（按压蓄力时平滑让位给磁垫下蹲）
    var hLift = hAmt * (1 - holdU);
    if (el.stage) {
      if (hLift > 0.001) {
        var hScale = 1 + hLift * 0.075;
        var liftY = hLift * 1.6;
        setAttr(el.stage, 'transform', 'translate(50 ' + fmt(50 - liftY) + ') scale(' + fmt(hScale) + ') translate(-50 -50)');
      } else if (el.stage.hasAttribute('transform')) {
        el.stage.removeAttribute('transform');
      }
    }
    // 桌面漫反射同步加强与舒展：悬停抬升时桌面光池放大增亮，按压近桌时略收束并增强近地反光
    if (el.glowInner) {
      var gScale = 1 + hLift * 0.16 - holdU * 0.06;
      if (Math.abs(gScale - 1) > 0.001) {
        setAttr(el.glowInner, 'transform', 'translate(50 50) scale(' + fmt(gScale) + ') translate(-50 -50)');
      } else if (el.glowInner.hasAttribute('transform')) {
        el.glowInner.removeAttribute('transform');
      }
      var glowEnergy = clamp(hAmt + holdU * 0.45, 0, 1);
      if (el.glowWide) setAttr(el.glowWide, 'opacity', fmt(lerp(this.glow === 'subtle' ? 0.78 : 0.80, 1.0, glowEnergy)));
      if (el.glowDesk) setAttr(el.glowDesk, 'opacity', fmt(lerp(0.46, 0.88, clamp(hAmt * 0.85 + holdU * 0.55, 0, 1))));
    }

    if (isSpectral) {
      var ga = sc.spectralPhase * TAU;
      setAttr(el.aurGrad, 'x1', fmt(50 + Math.cos(ga) * 38));
      setAttr(el.aurGrad, 'y1', fmt(20 + Math.sin(ga) * 22));
      setAttr(el.aurGrad, 'x2', fmt(50 - Math.cos(ga) * 38));
      setAttr(el.aurGrad, 'y2', fmt(80 - Math.sin(ga) * 22));

      if (el.glowWrap && el.glowWrap.style.display === 'none') el.glowWrap.style.display = '';
      if (el.spectralWrap.style.display === 'none') el.spectralWrap.style.display = '';
      if (el.monoWrap.style.display !== 'none') el.monoWrap.style.display = 'none';
      setAttr(el.spectralWrap, 'opacity', fmt(clamp(sc.bodyAlpha, 0, 1)));

      var targetBlobs = computeBlobStates(sc);
      var blobs;
      var settledStatic = (this._playing === 'static' && !this._fromContour && !this._pressDownTs && hAmt <= 0.002);
      if (this._frozenT !== null || !this._curBlobs || rawDt <= 0 || rawDt > 140 || settledStatic) {
        this._curBlobs = cloneBlobs(targetBlobs);
        blobs = this._curBlobs;
      } else {
        // 指数阻尼惯性追随：任意跨状态切换色彩云丝滑流淌，零瞬移跳色
        var dampAlpha = 1 - Math.exp(-rawDt / 90);
        blobs = dampBlobs(this._curBlobs, targetBlobs, dampAlpha);
      }
      for (var ci = 0; ci < CLOUD_KEYS.length; ci++) {
        var bk = CLOUD_KEYS[ci], b = blobs[bk], bn = el.blobs[bk];
        setAttr(bn, 'cx', fmt(b.cx));
        setAttr(bn, 'cy', fmt(b.cy));
        setAttr(bn, 'rx', fmt(b.rx));
        setAttr(bn, 'ry', fmt(b.ry));
        setAttr(bn, 'transform', 'rotate(' + fmt(b.rot) + ' ' + fmt(b.cx) + ' ' + fmt(b.cy) + ')');
      }
      setAttr(el.washErr, 'opacity', fmt(clamp(sc.errWash, 0, 1)));
      setAttr(el.washOk,  'opacity', fmt(clamp(sc.okWash, 0, 1)));
    } else {
      if (el.glowWrap && el.glowWrap.style.display !== 'none') el.glowWrap.style.display = 'none';
      if (el.spectralWrap.style.display !== 'none') el.spectralWrap.style.display = 'none';
      if (el.monoWrap.style.display === 'none') el.monoWrap.style.display = '';
      setAttr(el.monoPath, 'd', sc.bodyD);
      setAttr(el.monoPath, 'opacity', fmt(clamp(sc.bodyAlpha, 0, 1)));
    }

    syncOverDOM(el.under, sc.under, isSpectral, uid);
    syncOverDOM(el.over, sc.over, isSpectral, uid);
  };

  // —— Web Component <antigravity-logo> ——
  var ATTRS = ['state', 'then', 'size', 'palette', 'color', 'effort', 'glow', 'interactive', 'speed-multiplier'];
  if (typeof window !== 'undefined' && window.customElements && !window.customElements.get('antigravity-logo')) {
    var AgElement = function () { return Reflect.construct(HTMLElement, [], AgElement); };
    AgElement.prototype = Object.create(HTMLElement.prototype);
    AgElement.prototype.constructor = AgElement;

    AgElement.prototype.connectedCallback = function () {
      if (this._ctl) return;
      var pal = this.getAttribute('palette') || this.getAttribute('color') || 'spectral';
      var glowAttr = this.getAttribute('glow');
      this._ctl = new Controller(this, {
        state: this.getAttribute('state') || 'static',
        then: this.getAttribute('then') || null,
        size: this.getAttribute('size') ? +this.getAttribute('size') : null,
        palette: pal,
        effort: this.getAttribute('effort') || 'medium',
        glow: this.hasAttribute('glow') ? (glowAttr === '' ? 'hero' : glowAttr) : false,
        interactive: this.hasAttribute('interactive'),
        speedMultiplier: this.getAttribute('speed-multiplier') ? +this.getAttribute('speed-multiplier') : 1
      });
    };
    AgElement.prototype.disconnectedCallback = function () {
      if (this._ctl) { this._ctl.destroy(); this._ctl = null; }
    };
    AgElement.observedAttributes = ATTRS;
    AgElement.prototype.attributeChangedCallback = function (n, _o, v) {
      if (!this._ctl) return;
      if (n === 'state') this._ctl.setState(v || 'static');
      if (n === 'palette' || n === 'color') this._ctl.setPalette(v || 'spectral');
      if (n === 'effort') this._ctl.setEffort(v || 'medium');
      if (n === 'size' && v) this.style.width = this.style.height = (+v) + 'px';
      if (n === 'speed-multiplier' && v) this._ctl.setSpeed(+v);
      if (n === 'interactive') this._ctl.setInteractive(v !== null);
      if (n === 'glow') this._ctl.setGlow(v === null ? false : (v === '' ? 'hero' : v));
    };
    Object.defineProperty(AgElement.prototype, 'state', {
      get: function () { return this.getAttribute('state') || 'static'; },
      set: function (v) { this.setAttribute('state', v); }
    });
    AgElement.prototype.play = function (name, opts) { return this._ctl && this._ctl.play(name, opts); };
    AgElement.prototype.finish = function (next) { return this._ctl && this._ctl.finish(next); };
    AgElement.prototype.setPalette = function (p) { return this._ctl && this._ctl.setPalette(p); };
    AgElement.prototype.setEffort = function (e) { return this._ctl && this._ctl.setEffort(e); };
    AgElement.prototype.setGlow = function (g) { return this._ctl && this._ctl.setGlow(g); };
    AgElement.prototype.freezeAt = function (t, ph) { return this._ctl && this._ctl.freezeAt(t, ph); };

    try { window.customElements.define('antigravity-logo', AgElement); } catch (_e) {}
  }

  var API = {
    META: META,
    states: Object.keys(META),
    mount: function (el, opts) { return new Controller(el, opts); },
    computeScene: computeScene,
    renderSVG: renderSVG
  };

  global.AntigravityLogo = API;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }
})(typeof window !== 'undefined' ? window : globalThis);
