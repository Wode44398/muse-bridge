// 新对话空态的「字符风」背景——官方 Claude Code（claude.ai /epitaxy，Desktop 2.37337 起）LandingTextureLayer 源码级移植。
// 来源：claude.ai 线上 assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c9d397622-DooyXaD7.js（2026-10-14 抓取，js-beautify 格式化）。
//
// 做法：一张 WebGL2 画布铺满空态区。等宽字体的 96 个可见字符先画进一张图集（只留与「0」等宽的），
// 第一遍着色器在半分辨率网格上模拟「风」——带弯曲、阵风、涡卷、细丝，鼠标划过加温搅动、点击荡开一圈波纹
// （每第三下是心形的负波纹）；第二遍按网格一格一字地画，每格按自己的节奏轮换字符，迎风的笔画边更亮，
// 被点击波纹扫过的格子染上蓝光。输入卡片周围一块椭圆区域压暗（composition.card），不抢正文。
// 省电：40ms 一帧（波纹期间 10ms），跑满 180 秒（budgetS）后 8 秒内渐停，鼠标/键盘一动再续；窗口失焦或
// 页面隐藏就停；GPU 跟不上或连续掉帧就退避、按 60s→480s 重试；软件渲染器（SwiftShader 等）直接不画。
// 高对比度 / 强制颜色模式、或浏览器没有 devicePixelContentBoxSize（Safari）时整个不启用。
//
// 下面 var d = {...} 起直到 Ae() 为止是官方代码原样（变量名是压缩后的）。唯一改动在 ve()：没有
// KHR_parallel_shader_compile 扩展时退回同步检查链接结果（安卓 WebView 常缺，官方会直接不画）。
// 从外部引入的几样换成本地实现：
//   c(el) / o(el) = 元素所在窗口；a(el) = 该窗口的 ResizeObserver；s(el) = MutationObserver；
//   i(target) = 事件目标若是元素则返回它；l = 根元素上的主题属性名（官方 data-cds-theme，bridge 是 data-theme）；
//   u = 淡入时长（官方 3000ms）。
/* eslint-disable */
const winOf = (el) => (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
const c = winOf;
const o = winOf;
const a = (el) => winOf(el).ResizeObserver;
const s = (el) => winOf(el).MutationObserver;
const i = (t) => (t && t.nodeType === 1 ? t : null);
const l = 'data-theme';
const u = 3000;
export const LANDING_FADE_IN_MS = u;

var d = {
  seed: void 0,
  look: void 0,
  strength: {
    scale: 1,
    base: {
      dark: .26,
      light: .26
    },
    cap: {
      dark: .9,
      light: .9
    },
    rest: .03
  },
  surface: {
    fill: 1,
    weight: 300,
    glyphCss: 9,
    skipUnseen: !0
  },
  wind: {
    energy: 1,
    friction: .6,
    flick: 1.2,
    lull: .5,
    streak: .4,
    detail: .6,
    edge: .75,
    curl: .65,
    wisp: .5,
    tail: .35,
    sweep: .3,
    morph: 3,
    revealS: 4
  },
  glow: {
    amount: 1,
    headroom: 3,
    color: {
      dark: [.1, .68, 1],
      light: [0, .25, 1]
    }
  },
  touch: {
    stir: 1,
    ripple: 1,
    slowPxS: 60,
    fastPxS: 800
  },
  composition: {
    card: {
      centerY: .45,
      calmX: 250,
      calmY: 80,
      left: .3
    }
  },
  grid: {
    cellCss: 6.5,
    minCols: 24,
    minRows: 8,
    maxDevicePixels: 21e6
  },
  power: {
    frameMs: 40,
    rippleFrameMs: 10,
    backoffFrameMs: 83,
    budgetS: 180,
    settleS: 8,
    resumeS: 3,
    retryS: 60,
    retryMaxS: 480,
    resizeSettleMs: 150,
    linkDeadlineMs: 2e4
  }
};

function f(e) {
  let {
    grid: t
  } = d, n = e.devicePixelRatio;
  if (!(e.deviceWidth > 0 && e.deviceHeight > 0 && n > 0)) return null;
  let r = Math.max(5, Math.round(t.cellCss * n)),
    i = r * 2,
    a = Math.ceil(e.deviceWidth / r),
    o = Math.ceil(e.deviceHeight / i);
  if (a < t.minCols || o < t.minRows) return null;
  let s = a * r * o * i / t.maxDevicePixels;
  s > 1 && (a = Math.floor(a / Math.sqrt(s)), o = Math.floor(o / Math.sqrt(s)));
  let c = Math.round((e.deviceWidth - a * r) / 2),
    l = Math.round((e.deviceHeight - o * i) / 2);
  return {
    cellWidth: r,
    cellHeight: i,
    columns: a,
    rows: o,
    left: c,
    top: l,
    scale: n
  }
}

function p(e, t) {
  let n = e.createElement("canvas").getContext("2d", {
    willReadFrequently: !0
  });
  if (!n) return {
    rgb: [.5, .5, .5],
    alpha: 1
  };
  n.fillStyle = t, n.fillRect(0, 0, 1, 1);
  let [r = 128, i = 128, a = 128, o = 255] = n.getImageData(0, 0, 1, 1).data;
  return {
    rgb: [r / 255, i / 255, a / 255],
    alpha: o / 255
  }
}
var m = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u00B7",
  h = 6,
  g = {
    mixed: "ab0cAde1fEgh2iGjk3lHmn4oKpq5rMst6uRvw7xSyz8nT9eW",
    lettered: "abcd3efgRhijk7lmnAopqr0stuEvwxy5zaeKiou2gcS9",
    figured: "0a1b2C3d4e5F6g7h8i9J0k1m2N3p4q5R6s7t8U9v0w1X2y3z"
  };

function _(e, t, n, r) {
  let i = r >= 1.5 ? d.surface.weight : d.surface.weight + 100,
    a = e.createElement("canvas").getContext("2d"),
    o = .6;
  return a && (a.font = `${i} 100px ${t}`, o = a.measureText("0").width / 100 || o), {
    family: t,
    weight: i,
    px: Math.min(Math.round(d.surface.glyphCss * r), Math.floor((n - 2) / o))
  }
}

function v(e, t, n, r) {
  let i = e.createElement("canvas");
  i.width = 16 * n, i.height = h * r;
  let a = i.getContext("2d", {
    willReadFrequently: !0
  });
  if (!a) return null;
  a.font = `${t.weight} ${t.px}px ${t.family}`, a.textAlign = "left", a.textBaseline = "alphabetic", a.fillStyle = "white";
  let o = a.measureText("Mg|"),
    s = Math.round((r - (o.fontBoundingBoxAscent + o.fontBoundingBoxDescent)) / 2 + o.fontBoundingBoxAscent),
    c = a.measureText("0").width,
    l = Math.floor((n - c) / 2),
    u = [...m].map((e, t) => {
      if (Math.abs(a.measureText(e).width - c) > .5) return !0;
      let i = t % 16 * n,
        o = Math.floor(t / 16) * r;
      return a.save(), a.beginPath(), a.rect(i, o, n, r), a.clip(), a.fillText(e, i + l, o + s), a.restore(), !1
    }),
    d = a.getImageData(0, 0, i.width, i.height).data,
    f = new Uint8Array(i.width * i.height);
  for (let e = 0; e < f.length; e++) f[e] = d[e * 4 + 3] ?? 0;
  return {
    coverage: f,
    missing: u
  }
}
var y = 8;

function b(e, t, n) {
  let r = 16 * t,
    i = [],
    a = new Uint8Array(384);
  for (let o = 0; o < 96; o++) {
    let s = o % 16 * t,
      c = Math.floor(o / 16) * n,
      l = 0,
      u = t,
      d = n,
      f = -1,
      p = -1;
    for (let i = 0; i < n; i++)
      for (let n = 0; n < t; n++) {
        let t = e[(c + i) * r + s + n] ?? 0;
        l += t, t >= y && (u = Math.min(u, n), d = Math.min(d, i), f = Math.max(f, n), p = Math.max(p, i))
      }
    i.push(l / (255 * t * n)), f >= 0 && a.set([u, d, f - u + 1, p - d + 1], o * 4)
  }
  return {
    ink: i,
    boxes: a
  }
}

function x(e, t) {
  let n = [...g[e] ?? g.mixed ?? ""].map(e => m.indexOf(e)).filter(e => e > 0 && t[e] !== !0);
  return Uint8Array.from(n.length > 0 ? n : [m.indexOf(".")])
}
var S = Object.keys(g);

function C(e) {
  let t = e >>> 0;
  return t = Math.imul(t ^ t >>> 16, 569420461), t = Math.imul(t ^ t >>> 15, 1935289751), (t ^ t >>> 15) >>> 0
}

function w(e, t) {
  let n = C(e);
  for (let e of t) n = C(n ^ e.charCodeAt(0));
  return () => (n = n + 2654435769 >>> 0, C(n) / 4294967296)
}

function ee(e, t, n = S) {
  let r = n.filter(e => !t.includes(e)),
    i = n.filter(e => e !== t[0]),
    a = r.length > 0 ? r : i.length > 0 ? i : n;
  return a[Math.floor(w(e, "look")() * a.length)] ?? "mixed"
}

function T(e) {
  let t = Math.PI / 10,
    n = t + (Math.PI / 4.3 - t) * (e * 2 % 1);
  return e < .5 ? n : Math.PI - n
}

function te(e, t) {
  let n = w(e, "wind"),
    r = (e, t) => e + (t - e) * n();
  return {
    key: t in g ? t : "mixed",
    seed: e >>> 0,
    heading: T(n()),
    speed: r(42, 64),
    gustLength: r(380, 560),
    gustWidth: r(120, 190),
    bend: r(60, 110),
    bendScale: r(300, 440)
  }
}
var E = "code-landing-texture-recent",
  D = 3,
  O = [];

function k(e) {
  try {
    let t = JSON.parse(e.localStorage.getItem(E) ?? "[]");
    if (Array.isArray(t) && t.length > 0) return t.filter(e => typeof e == "string")
  } catch {}
  return O
}

function ne(e, t) {
  O = [t, ...k(e).filter(e => e !== t)].slice(0, D);
  try {
    e.localStorage.setItem(E, JSON.stringify(O))
  } catch {}
}
var A = 50,
  j = 3,
  M = 17,
  N = 5,
  re = 250;

function ie(e, t, n = {}) {
  let r = e.document,
    i = !1,
    a = !1,
    o, s, c = 0,
    l = 0,
    u = 0,
    d = 0,
    f = [],
    p = !1,
    m = () => i && !a && !r.hidden && r.hasFocus() && (n.allowed?.() ?? !0),
    h = () => {
      e.clearTimeout(o), s !== void 0 && e.cancelAnimationFrame(s), o = void 0, s = void 0
    },
    g = e => {
      f = [...f.slice(-9), e > M], f.filter(Boolean).length >= N && (f = [], n.onLate?.())
    },
    _ = r => {
      s = void 0, p = !0;
      try {
        let i = e.performance.now(),
          a = Math.max(r, u);
        g(i - a), c += Math.min(i - l, re), l = i, t(c / 1e3), d = e.performance.now() - a > A ? d + 1 : 0, d >= j && (d = 0, n.onStall?.())
      } finally {
        p = !1
      }
      m() && v()
    },
    v = () => {
      o = e.setTimeout(() => {
        o = void 0, u = e.performance.now(), s = e.requestAnimationFrame(_)
      }, n.intervalMs?.() ?? 40)
    },
    y = () => {
      if (p) return;
      let t = o !== void 0 || s !== void 0;
      m() && !t ? (l = e.performance.now(), v()) : !m() && t && h()
    };
  return r.addEventListener("visibilitychange", y), e.addEventListener("focus", y), e.addEventListener("blur", y), {
    redraw: () => {
      a || t(c / 1e3)
    },
    setRunning: e => {
      i = e, y()
    },
    refresh: y,
    kill: () => {
      a = !0, y()
    },
    destroy: () => {
      a = !0, h(), r.removeEventListener("visibilitychange", y), e.removeEventListener("focus", y), e.removeEventListener("blur", y)
    }
  }
}
var P = 3.6,
  F = 2.4,
  ae = .035,
  I = 18,
  L = .25,
  oe = .08,
  R = 90,
  se = .05,
  z = .65,
  B = 50,
  ce = 40,
  V = .002,
  le = 3;

function ue(e) {
  let t = Math.min(1, Math.max(0, e));
  return t * t * (3 - 2 * t)
}

function de() {
  let e = [],
    t = [],
    n = null,
    r = null,
    i = 0,
    a = 0,
    o = {
      now: 0,
      tapCount: 0,
      taps: new Float32Array(24),
      wakeCount: 0,
      wakes: new Float32Array(192),
      ways: new Float32Array(192)
    };
  return {
    move: (e, a, o) => {
      if (!n || !r || o - n.at > L) return n = {
        x: e,
        y: a,
        at: o
      }, r = n, i = 0, !1;
      let s = Math.max(o - n.at, 1 / 240),
        c = Math.hypot(e - n.x, a - n.y);
      i += (c / s - i) * Math.min(1, s / oe), n = {
        x: e,
        y: a,
        at: o
      };
      let l = Math.hypot(e - r.x, a - r.y);
      if (l < I || o - r.at < ae) return !1;
      let {
        slowPxS: u,
        fastPxS: f,
        stir: p
      } = d.touch, m = p * ue((i - u) / (f - u)), h = r;
      return r = n, m < .04 ? !1 : (t = [...t.slice(-47), {
        x: (e + h.x) / 2,
        y: (a + h.y) / 2,
        at: o,
        force: m * l / (l + R),
        wayX: (e - h.x) / 2,
        wayY: (a - h.y) / 2
      }], !0)
    },
    tap: (t, n, r) => {
      a += 1;
      let i = a % le === 0 ? -1.15 * d.touch.ripple : d.touch.ripple;
      e = [...e.slice(-5), {
        x: t,
        y: n,
        at: r,
        force: i,
        wayX: 0,
        wayY: 0
      }]
    },
    leave: () => {
      n = null
    },
    busy: n => e.some(e => n - e.at < P) || t.some(e => n - e.at < F),
    rippling: t => e.some(e => t - e.at < P),
    frame: n => {
      e = e.filter(e => n - e.at < P), t = t.filter(e => n - e.at < F), o.now = n, o.tapCount = e.length, e.forEach((e, t) => {
        o.taps.set([e.x, e.y, e.at, e.force], t * 4)
      });
      let r = 48 - t.length,
        i = 0;
      return t.forEach((e, t) => {
        let a = Math.max(0, n - e.at),
          s = e.force * Math.min(1, (t + 1 + r) / 8) * (1 - Math.exp(-a / se)) * Math.exp(-a / z);
        if (s < V) return;
        let c = B + ce * a,
          l = Math.hypot(e.wayX, e.wayY);
        o.wakes.set([e.x, e.y, s, 1 / (c * c)], i * 4), o.ways.set([e.wayX / (l || 1), e.wayY / (l || 1), l, 0], i * 4), i += 1
      }), o.wakeCount = i, o
    }
  }
}

function H(e) {
  return Number.isInteger(e) ? `${e}.0` : `${e}`
}
var U = `
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float unit(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
`,
  W = `
float value(uint v) { return unit(pcg(v)) * 2.0 - 1.0; }
// Value noise on an integer lattice hashed with the visit's seed, from -1 to 1.
float noise(vec3 p, uint salt) {
  vec3 fl = floor(p), f = p - fl;
  ivec3 i = ivec3(fl);
  vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  uint x0 = uint(i.x), x1 = uint(i.x + 1), y0 = uint(i.y), y1 = uint(i.y + 1);
  uint z0 = pcg(uint(i.z) ^ u_seed ^ salt), z1 = pcg(uint(i.z + 1) ^ u_seed ^ salt);
  uint a = pcg(y0 ^ z0), b = pcg(y1 ^ z0), c = pcg(y0 ^ z1), d = pcg(y1 ^ z1);
  return mix(
    mix(mix(value(x0 ^ a), value(x1 ^ a), w.x), mix(value(x0 ^ b), value(x1 ^ b), w.x), w.y),
    mix(mix(value(x0 ^ c), value(x1 ^ c), w.x), mix(value(x0 ^ d), value(x1 ^ d), w.x), w.y),
    w.z);
}
`,
  fe = `#version 300 es
precision highp float;
precision highp int;
uniform uint u_seed;
uniform float u_time;
uniform vec4 u_wind;
uniform vec2 u_canvasCss;
out vec4 v_air;
${U}
${W}
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
  vec2 heading = vec2(cos(u_wind.x), sin(u_wind.x));
  // It surges and slackens as it goes.
  float carried = u_wind.y * (u_time + 1.0 * noise(vec3(u_time * 0.09, 3.7, 0.0), 0x58u));
  v_air = vec4(heading, carried, 0.58 * (abs(heading.x) * u_canvasCss.x + abs(heading.y) * u_canvasCss.y));
}
`,
  pe = `
uniform float u_now;
uniform int u_tapCount;
// Each: where, when, and how hard.
uniform vec4 u_taps[6];
// How far out a heart's outline lies in a direction (a unit vector, y down), against a circle's 1.
float heart(vec2 u) {
  float k = -u.x * u.x * u.y * u.y * u.y;
  float c = sign(k) * pow(abs(k), 1.0 / 3.0);
  float r = 1.0;
  for (int i = 0; i < 6; i++) r = sqrt(max(0.05, 1.0 + c * pow(r, 5.0 / 3.0)));
  return r;
}
// At a place: the air's push in CSS pixels (xy), the wind raised or lowered (z), how roused (w). Out: a ripple's colour (x), its afterlight (y).
vec4 tapsAt(vec2 p, out vec2 glow) {
  vec4 sum = vec4(0.0);
  glow = vec2(0.0);
  // A click is a blow: a front runs out and slows, trough and weaker crest behind, shoving the air outward. Less than nothing: a heart.
  for (int i = 0; i < 6; i++) {
    if (i >= u_tapCount) break;
    vec4 tap = u_taps[i];
    float age = u_now - tap.z;
    vec2 away = p - tap.xy;
    float d = length(away);
    float reach = tap.w < 0.0 ? d / heart(away / max(d, 1.0)) : d;
    float behind = 620.0 * (1.0 - exp(-age / 1.3)) - reach;
    float width = 85.0 + 60.0 * age;
    float front = smoothstep(-16.0, 10.0, behind) * exp(-behind * behind / (width * width));
    float swell = abs(tap.w) * exp(-age / 1.5) * front;
    sum.xy += (away / max(d, 1.0)) * (44.0 * swell);
    sum.z += 1.9 * swell * (0.25 + 0.75 * cos(behind * (6.2831853 / 130.0)));
    sum.w += swell;
    // Far ahead of the front the fade would overflow, and nothing times that is not nothing.
    float trail = smoothstep(0.0, 70.0, behind) * exp(-max(behind, 0.0) / 260.0);
    glow.x += abs(tap.w) * (exp(-age / 1.0) * front + 0.7 * exp(-age / 1.3) * trail);
    glow.y += abs(tap.w) * (1.0 - exp(-age / 0.2)) * exp(-age / 1.2) * trail;
  }
  return sum;
}
`,
  G = `
uniform int u_wakeCount;
// Each stretch of the hand's path: its middle, how warm it is by now, and one over the square of how far that reaches.
uniform vec4 u_wakes[48];
// And which way it runs (xy), with half its length (z).
uniform vec4 u_ways[48];
// A moving hand warms the air where it is and cools behind in a short tail. No front, no push: ripples are a click's.
float warmthAt(vec2 p) {
  float warmth = 0.0;
  for (int i = 0; i < 48; i++) {
    if (i >= u_wakeCount) break;
    vec4 wake = u_wakes[i];
    vec3 way = u_ways[i].xyz;
    // Each is a stretch of the path, not a point on it, so that the quickest stroke still leaves one trail.
    vec2 away = p - wake.xy;
    away -= way.xy * clamp(dot(away, way.xy), -way.z, way.z);
    warmth += wake.z * exp(-dot(away, away) * wake.w);
  }
  // However hard the air is stirred, it is only ever warmed so far.
  return 1.0 - exp(-1.5 * warmth);
}
`;

function me() {
  let {
    card: e
  } = d.composition;
  return `#version 300 es
precision highp float;
precision highp int;
uniform uint u_seed;
uniform vec2 u_sampleCss, u_originCss, u_paneCss;
uniform float u_time, u_reveal;
// The wind: its heading, its speed, and the length and width of a gust.
uniform vec4 u_wind;
// How far its path is bent and the size of a bend; then how much lull lies between gusts, and how streaked a gust is.
uniform vec4 u_gust;
// A gust's shape: how broken its outline, how sharp its start, how far the air curls, how many strands trail it.
uniform vec4 u_shape;
// How far behind itself a gust fades out, 0 to 1; and how far gusts keep to the crests of the wind's long swells.
uniform float u_tail, u_sweep;
// How fast a gust changes shape as it travels, against a slow 1.
uniform float u_morph;
in vec4 v_air;
out vec4 o;

const float TAU = 6.2831853;
const vec2 CALM = vec2(${H(e.calmX)}, ${H(e.calmY)});
const float CALM_LEFT = ${H(e.left)};
const float CARD_Y = ${H(e.centerY)};
${U}
${W}
${pe}
${G}

// Gradient noise on the same lattice, about -1 to 1: it crosses zero between every pair of points, so it has no soft blobs.
vec3 slope(uint v) {
  uint h = pcg(v);
  return vec3(float(h & 1023u), float((h >> 10u) & 1023u), float((h >> 20u) & 1023u)) * (2.0 / 1023.0) - 1.0;
}
float swirl(vec3 p, uint salt) {
  vec3 fl = floor(p), f = p - fl;
  ivec3 i = ivec3(fl);
  vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  uint x0 = uint(i.x), x1 = uint(i.x + 1), y0 = uint(i.y), y1 = uint(i.y + 1);
  uint z0 = pcg(uint(i.z) ^ u_seed ^ salt), z1 = pcg(uint(i.z + 1) ^ u_seed ^ salt);
  uint a = pcg(y0 ^ z0), b = pcg(y1 ^ z0), c = pcg(y0 ^ z1), d = pcg(y1 ^ z1);
  return 1.5 * mix(
    mix(mix(dot(slope(x0 ^ a), f), dot(slope(x1 ^ a), f - vec3(1.0, 0.0, 0.0)), w.x),
        mix(dot(slope(x0 ^ b), f - vec3(0.0, 1.0, 0.0)), dot(slope(x1 ^ b), f - vec3(1.0, 1.0, 0.0)), w.x), w.y),
    mix(mix(dot(slope(x0 ^ c), f - vec3(0.0, 0.0, 1.0)), dot(slope(x1 ^ c), f - vec3(1.0, 0.0, 1.0)), w.x),
        mix(dot(slope(x0 ^ d), f - vec3(0.0, 1.0, 1.0)), dot(slope(x1 ^ d), f - vec3(1.0)), w.x), w.y),
    w.z);
}

// The gusts in the wind's own frame: longer along it than across, four sizes travelling nearly together, and thin strands between.
float gustsAt(vec2 at, float carried) {
  float gain = mix(0.38, 0.62, u_shape.x);
  float gust = 0.0, weight = 1.0, power = 0.0;
  vec2 size = vec2(0.85, 0.75) * u_wind.zw;
  for (int i = 0; i < 4; i++) {
    float k = float(i);
    gust += weight * swirl(vec3((at.x - carried * (1.0 + 0.1 * k)) / size.x, at.y / size.y, u_morph * u_time * (0.03 + 0.018 * k) + 11.0 * k), 0x60u + uint(i));
    power += weight * weight;
    weight *= gain;
    size *= vec2(0.5, 0.58);
  }
  float strand = 1.0 - abs(swirl(vec3((at.x - 1.15 * carried) / (0.7 * u_wind.z), at.y / (0.95 * u_wind.w), u_morph * u_time * 0.05 + 2.0), 0x66u));
  // Long swells, about one to the pane: gusts gather on a crest, so what is lit keeps together and the pane is seldom full or empty.
  float span = v_air.w;
  // A crest runs now ahead of its time and now behind it, by up to half the way to the next: it keeps no beat.
  float swell = cos((at.x - carried + 0.5 * span * noise(vec3(u_time * 0.045, at.y / (2.5 * u_wind.w), 7.0), 0x67u)) * (TAU / span));
  return gust * inversesqrt(power) + u_shape.w * 0.5 * (strand * strand * strand - 0.35) + u_sweep * swell;
}

void main() {
  vec2 p = u_originCss + gl_FragCoord.xy * u_sampleCss;
  vec2 heading = v_air.xy;
  vec2 across = vec2(-heading.y, heading.x);
  // What the hand has done here, read a little off true, so that a ripple's outline is never a drawn circle.
  vec4 hand = vec4(0.0);
  float warm = 0.0;
  if (u_tapCount + u_wakeCount > 0) {
    vec2 near = p + 24.0 * vec2(
      noise(vec3(p / 95.0, u_now * 0.12), 0x71u),
      noise(vec3(p / 95.0 + 9.1, u_now * 0.12 + 4.0), 0x72u));
    vec2 glow;
    hand = tapsAt(near, glow);
    // The warmth lights the characters by itself, calm air or not; a little of it also raises whatever wind is passing.
    warm = warmthAt(near);
    hand.zw += vec2(0.25, 0.05) * warm;
  }
  // Air that has been pushed shows here what was over there.
  vec2 from = p - hand.xy;
  // The wind's path bends, slowly, and what it carries bends with it.
  vec2 turn = vec2(
    noise(vec3(from / u_gust.y, u_time * 0.04), 0x51u),
    noise(vec3(from / u_gust.y + 17.3, u_time * 0.04 + 5.0), 0x52u));
  vec2 bent = from + u_gust.x * turn;
  vec2 q = vec2(dot(bent, heading), dot(bent, across));
  float carried = v_air.z;

  // The air curls as it travels: small eddies carried on large, and every gust's outline dragged through both.
  vec2 riding = vec2(q.x - 0.85 * carried, q.y);
  float eddySize = 1.15 * u_wind.w, fineSize = 0.38 * u_wind.w;
  vec2 eddy = vec2(
    swirl(vec3(riding / eddySize, u_morph * u_time * 0.04), 0x59u),
    swirl(vec3(riding / eddySize + 31.7, u_morph * u_time * 0.04 + 3.0), 0x5au));
  vec2 folded = riding + u_shape.z * 0.9 * u_wind.w * eddy;
  vec2 fine = vec2(
    swirl(vec3(folded / fineSize, u_morph * u_time * 0.06), 0x5bu),
    swirl(vec3(folded / fineSize + 13.1, u_morph * u_time * 0.06 + 7.0), 0x5cu));
  // And the smallest folds, two or three rows of characters across, so that no edge runs straight down the rows.
  vec2 creased = (folded + 0.3 * u_wind.w * fine) / 24.0;
  vec2 tiny = vec2(
    swirl(vec3(creased, u_time * 0.07), 0x5du),
    swirl(vec3(creased + 5.3, u_time * 0.07 + 1.0), 0x5eu));
  // Roused air curls further.
  vec2 pull = u_shape.z * (1.0 + 0.9 * min(hand.w, 1.5)) * (u_wind.w * (0.9 * eddy + 0.3 * fine) + u_shape.x * 30.0 * tiny);
  vec2 curled = q + pull;
  vec2 blows = normalize(heading + 0.6 * turn + hand.xy / 14.0 + u_shape.z * ((0.45 * eddy.x + 0.25 * fine.x) * heading + (0.45 * eddy.y + 0.25 * fine.y) * across));

  float still = gustsAt(curled, carried);
  float field = still + hand.z;

  // Light begins at once on the side a gust is heading for and thins out behind, so a still frame shows which way the wind goes.
  float level = mix(0.02, 0.82, u_gust.z);
  float band = mix(0.26, 0.03, u_shape.y);
  // Under this nothing shows, whatever lies ahead; and that is most of the pane, where the rest is not worked out.
  bool blowing = field > level - band - 0.55 * u_tail;
  float strength = 0.0, streaks = 0.0;
  if (blowing || warm > 0.0) {
    // Within a gust, thin quick streaks, as wind draws on water.
    float thread = noise(vec3((curled.x - carried * 1.6) / 140.0, curled.y / 30.0, u_time * 0.16), 0x57u);
    streaks = 1.0 - smoothstep(0.0, 0.5, abs(thread));
  }
  if (blowing) {
    float ahead = gustsAt(curled + vec2(56.0, 0.0), carried);
    float leaving = smoothstep(-0.05, 0.07, ahead - still);
    float lit = smoothstep(level - band - 0.55 * u_tail * leaving, level + band, field);
    float broad = lit * lit * mix(0.45, 1.0, clamp((field - level) / 0.45, 0.0, 1.0)) * (0.82 + 0.18 * fine.y);
    strength = broad * mix(1.0, 0.25 + 0.95 * streaks, u_gust.w);
  }
  if (warm > 0.0) {
    // Where the hand has warmed the air it shows, wind or no wind, in the air's own fine grain, which drifts with it.
    float grain = 0.55 * fine.y + 0.45 * tiny.x + 0.3 * (streaks - 0.4);
    strength = 1.0 - (1.0 - strength) * (1.0 - 0.85 * warm * smoothstep(-0.5, 0.25, grain));
  }

  // Thinner behind the content.
  vec2 e = (p - vec2(0.5 * u_paneCss.x, CARD_Y * u_paneCss.y)) / CALM;
  float calm = 1.0 - (1.0 - CALM_LEFT) * exp(-0.9 * dot(e, e));
  // What the hand does shows at once, however little of the wind has arrived.
  float shown = max(u_reveal, min(1.0, 2.0 * hand.w + warm));
  o = vec4(strength * calm * shown, blows * 0.5 + 0.5, calm * shown);
}
`
}

function K() {
  return `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D u_boxes;
uniform highp sampler2D u_sequence;
uniform highp sampler2D u_wind;
uniform ivec2 u_grid, u_cell, u_buffer;
uniform uint u_seed;
uniform float u_time, u_fill, u_flick;
uniform int u_count;
// The first cell's middle, and a cell's size, in CSS pixels of the pane.
uniform vec4 u_cellCss;
out vec2 v_shift;
out vec4 v_box;
out vec2 v_glow;
const ivec2 CORNER[6] = ivec2[6](ivec2(0, 0), ivec2(1, 0), ivec2(0, 1), ivec2(0, 1), ivec2(1, 0), ivec2(1, 1));
const ivec2 SAMPLES = ivec2(1, 2);
${U}
${pe}
void none() {
  gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
  v_shift = vec2(0.0);
  v_box = vec4(0.0);
  v_glow = vec2(0.0);
}
void main() {
  int id = gl_VertexID / 6;
  ivec2 c = ivec2(id % u_grid.x, id / u_grid.x);
  uint cell = pcg((uint(c.x) * 0x9E3779B9u) ^ pcg(uint(c.y) ^ u_seed));
  if (unit(cell) >= u_fill) {
    none();
    return;
  }
  // Each cell steps through the set at its own pace, from its own place in it.
  uint pace = pcg(cell);
  int steps = int(floor(u_time * u_flick * (0.6 + 0.8 * unit(pace)) + unit(pcg(pace))));
  vec2 glow = vec2(0.0);
  if (u_tapCount > 0) {
    // A roused cell runs on through its set, and back as it settles.
    steps += int(floor(6.0 * tapsAt(u_cellCss.xy + vec2(c) * u_cellCss.zw, glow).w + unit(pcg(pace ^ 0x33u))));
    // Every cell glows with its neighbours, some a little more than others.
    glow *= 0.65 + 0.35 * unit(pcg(pace ^ 0x51u));
  }
  if (${d.surface.skipUnseen&&d.strength.rest<=.030000000000000002} && glow.x < 0.04 && glow.y < 0.015) {
    // No wind at the cell's samples or those around them: only its resting light is left, which cannot be seen.
    ivec2 first = c * SAMPLES, last = u_grid * SAMPLES - 1;
    float most = 0.0;
    for (int y = -1; y <= SAMPLES.y; y++) {
      for (int x = -1; x <= SAMPLES.x; x++) {
        most = max(most, texelFetch(u_wind, clamp(first + ivec2(x, y), ivec2(0), last), 0).r);
      }
    }
    if (most == 0.0) {
      none();
      return;
    }
  }
  int g = int(texelFetch(u_sequence, ivec2((int(cell >> 8u) + steps) % u_count, 0), 0).r * 255.0 + 0.5);
  uvec4 box = texelFetch(u_boxes, ivec2(g, 0), 0);
  ivec2 origin = c * u_cell;
  ivec2 px = origin + ivec2(box.xy) + CORNER[gl_VertexID - id * 6] * ivec2(box.zw);
  ivec2 home = ivec2(g & 15, g >> 4) * u_cell;
  v_shift = vec2(home - origin);
  v_box = vec4(home, home + u_cell - 1);
  v_glow = glow;
  vec2 n = vec2(px) / vec2(u_buffer) * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
}
`
}

function he() {
  return `#version 300 es
precision highp float;
precision highp int;
in vec2 v_shift;
in vec4 v_box;
in vec2 v_glow;
uniform highp sampler2D u_atlas;
uniform highp sampler2D u_wind;
uniform vec3 u_color, u_glowColor;
uniform ivec2 u_buffer;
uniform float u_friction, u_glowAmount, u_inkAlpha;
out vec4 o;
const float REST = ${H(d.strength.rest)};
const float HEAD = ${H(d.glow.headroom)};
ivec4 box;
float inkAt(ivec2 at) { return texelFetch(u_atlas, clamp(at, box.xy, box.zw), 0).r; }
void main() {
  box = ivec4(floor(v_box + 0.5));
  ivec2 px = ivec2(int(gl_FragCoord.x), u_buffer.y - 1 - int(gl_FragCoord.y));
  ivec2 at = px + ivec2(floor(v_shift + 0.5));
  float ink = inkAt(at);
  if (ink <= 0.0) { o = vec4(0.0); return; }
  vec4 wind = texture(u_wind, (vec2(px) + 0.5) / vec2(u_buffer));
  vec2 blows = wind.gb * 2.0 - 1.0;
  // Which way the stroke's edge faces: into the ink from the side the wind arrives on is a face to the wind.
  vec2 rise = vec2(inkAt(at + ivec2(1, 0)) - inkAt(at - ivec2(1, 0)), inkAt(at + ivec2(0, 1)) - inkAt(at - ivec2(0, 1)));
  float steep = length(rise);
  float facing = steep > 0.02 ? max(0.0, dot(rise / steep, blows)) : 0.35;
  float caught = mix(1.0, 0.45 + 1.1 * facing, u_friction);
  float light = min(1.0, wind.r * caught) + REST * wind.a;
  // The colour comes in whole and goes out quickly: halfway between it and the plain ink is only mud.
  float tint = smoothstep(0.04, 0.3, u_glowAmount * v_glow.x);
  // The canvas is shown HEAD times stronger and the plain light drawn as much weaker, which leaves a glow room above it.
  float bright = min(1.0, light) * mix(u_inkAlpha, HEAD, tint);
  float left = u_glowAmount * 0.3 * v_glow.y * wind.a;
  float a = ink * min(1.0, (bright + left) / HEAD);
  o = vec4((mix(u_color, u_glowColor, tint) * bright + u_glowColor * left) / (bright + left + 0.0001) * a, a);
}
`
}
var q = /swiftshader|llvmpipe|softpipe|software|warp|basic render/i,
  ge = 50,
  _e = 4,
  J = {
    wind: 0,
    atlas: 1,
    boxes: 2,
    sequence: 3
  };

function Y(e, t) {
  e.useProgram(t)
}

function X(e, t, n) {
  let r = e.createProgram();
  for (let [i, a] of [
      [e.VERTEX_SHADER, t],
      [e.FRAGMENT_SHADER, n]
    ]) {
    let t = e.createShader(i);
    t && (e.shaderSource(t, a), e.compileShader(t), e.attachShader(r, t), e.deleteShader(t))
  }
  return e.linkProgram(r), r
}
async function ve(e, t, n, r) {
  let i = e.getExtension("KHR_parallel_shader_compile");
  // 【bridge 改动，唯一一处偏离官方】官方没有这个扩展就直接放弃（Desktop 的 Electron 恒有）。安卓 WebView
  // 常没有（2026-10-14 Galaxy Fold / Adreno 840 实测缺），而两段着色器在那上面同步链接只要 2–4ms——
  // 缺扩展时退回同步查 LINK_STATUS，手机上照样出效果。
  if (!i) return n.every(t => e.getProgramParameter(t, e.LINK_STATUS) === !0);
  let a = t.performance.now() + d.power.linkDeadlineMs;
  for (; n.some(t => e.getProgramParameter(t, i.COMPLETION_STATUS_KHR) !== !0);) {
    if (r() || t.performance.now() > a) return !1;
    await new Promise(e => t.setTimeout(e, ge))
  }
  return n.every(t => e.getProgramParameter(t, e.LINK_STATUS) === !0)
}

function Z(e, t, n = "exact") {
  let r = e.createTexture();
  e.activeTexture(e.TEXTURE0 + t), e.bindTexture(e.TEXTURE_2D, r);
  let i = n === "smooth" ? e.LINEAR : e.NEAREST;
  return e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), r
}

function Q(e, t, n, r, i, a) {
  e.activeTexture(e.TEXTURE0 + t);
  let [o, s] = n === "r8" ? [e.R8, e.RED] : n === "rgba8" ? [e.RGBA8, e.RGBA] : [e.RGBA8UI, e.RGBA_INTEGER];
  e.texImage2D(e.TEXTURE_2D, 0, o, r, i, 0, s, e.UNSIGNED_BYTE, a)
}
async function ye(e, t, n, r, i) {
  let a = e.ownerDocument,
    o = a.createElement("canvas");
  o.className = "absolute block";
  let s = o.getContext("webgl2", {
    alpha: !0,
    antialias: !1,
    depth: !1,
    stencil: !1,
    premultipliedAlpha: !0,
    preserveDrawingBuffer: !1,
    powerPreference: "low-power",
    failIfMajorPerformanceCaveat: !0
  });
  if (!s) return null;
  let c = () => (s.getExtension("WEBGL_lose_context")?.loseContext(), o.remove(), null),
    l = s.getExtension("WEBGL_debug_renderer_info");
  if (l && q.test(String(s.getParameter(l.UNMASKED_RENDERER_WEBGL)))) return c();
  let u = X(s, fe, me()),
    f = X(s, K(), he());
  if (!await ve(s, t, [u, f], i) || i()) return c();
  let p = Z(s, J.wind, "smooth"),
    g = Z(s, J.atlas),
    y = Z(s, J.boxes),
    S = Z(s, J.sequence),
    C = s.createFramebuffer();
  s.pixelStorei(s.UNPACK_ALIGNMENT, 1);
  let w = (e, t) => s.getUniformLocation(e, t);
  Y(s, u), s.uniform1ui(w(u, "u_seed"), n.seed), s.uniform1f(w(u, "u_tail"), d.wind.tail), s.uniform1f(w(u, "u_sweep"), d.wind.sweep), s.uniform1f(w(u, "u_morph"), d.wind.morph), s.uniform4f(w(u, "u_wind"), n.heading, n.speed, n.gustLength, n.gustWidth), s.uniform4f(w(u, "u_gust"), n.bend, n.bendScale, d.wind.lull, d.wind.streak), s.uniform4f(w(u, "u_shape"), d.wind.detail, d.wind.edge, d.wind.curl, d.wind.wisp), Y(s, f), s.uniform1i(w(f, "u_wind"), J.wind), s.uniform1i(w(f, "u_atlas"), J.atlas), s.uniform1i(w(f, "u_boxes"), J.boxes), s.uniform1i(w(f, "u_sequence"), J.sequence), s.uniform1ui(w(f, "u_seed"), n.seed), s.uniform1f(w(f, "u_fill"), d.surface.fill), s.uniform1f(w(f, "u_flick"), d.wind.flick), s.uniform1f(w(f, "u_friction"), d.wind.friction), s.uniform1f(w(f, "u_glowAmount"), d.glow.amount);
  let ee = e => ({
      now: w(e, "u_now"),
      tapCount: w(e, "u_tapCount"),
      wakeCount: w(e, "u_wakeCount"),
      taps: w(e, "u_taps"),
      wakes: w(e, "u_wakes"),
      ways: w(e, "u_ways")
    }),
    T = {
      wind: ee(u),
      glyphs: ee(f)
    },
    te = (e, t) => {
      s.uniform1i(e.tapCount, t?.tapCount ?? 0), s.uniform1i(e.wakeCount, t?.wakeCount ?? 0), t && (s.uniform1f(e.now, t.now), t.tapCount > 0 && s.uniform4fv(e.taps, t.taps), t.wakeCount > 0 && e.wakes && (s.uniform4fv(e.wakes, t.wakes), s.uniform4fv(e.ways, t.ways)))
    },
    E = {
      cellCss: w(f, "u_cellCss"),
      windTime: w(u, "u_time"),
      reveal: w(u, "u_reveal"),
      sampleCss: w(u, "u_sampleCss"),
      originCss: w(u, "u_originCss"),
      paneCss: w(u, "u_paneCss"),
      canvasCss: w(u, "u_canvasCss"),
      glyphTime: w(f, "u_time"),
      count: w(f, "u_count"),
      grid: w(f, "u_grid"),
      cell: w(f, "u_cell"),
      buffer: w(f, "u_buffer"),
      color: w(f, "u_color"),
      glowColor: w(f, "u_glowColor"),
      inkAlpha: w(f, "u_inkAlpha")
    },
    D = 0,
    O = 0,
    k = 0,
    ne = 0,
    A = 0,
    j = null,
    M = 0,
    N = (e, i) => {
      let o = _(a, r, e, t.devicePixelRatio),
        c = v(a, o, e, i);
      if (!c) return !1;
      let l = b(c.coverage, e, i),
        u = x(n.key, c.missing);
      return Q(s, J.atlas, "r8", 16 * e, h * i, c.coverage), Q(s, J.boxes, "rgba8ui", m.length, 1, l.boxes), Q(s, J.sequence, "r8", u.length, 1, u), Y(s, f), s.uniform1i(E.count, u.length), ne = e, !0
    };
  return e.append(o), {
    canvas: o,
    resize: (e, [t, n]) => {
      if (e.cellWidth !== ne && !N(e.cellWidth, e.cellHeight)) return !1;
      let r = e.columns * e.cellWidth,
        i = e.rows * e.cellHeight;
      (o.width !== r || o.height !== i) && (o.width = r, o.height = i);
      let a = t => t / e.scale;
      return o.style.left = `${a(e.left)}px`, o.style.top = `${a(e.top)}px`, o.style.width = `${a(r)}px`, o.style.height = `${a(i)}px`, (e.columns !== O || e.rows !== k) && ({
        columns: O,
        rows: k
      } = e, D = O * k, Q(s, J.wind, "rgba8", O * 1, k * 2, null), s.bindFramebuffer(s.FRAMEBUFFER, C), s.framebufferTexture2D(s.FRAMEBUFFER, s.COLOR_ATTACHMENT0, s.TEXTURE_2D, p, 0)), Y(s, u), s.uniform2f(E.sampleCss, a(e.cellWidth) / 1, a(e.cellHeight) / 2), s.uniform2f(E.originCss, a(e.left), a(e.top)), s.uniform2f(E.paneCss, t, n), s.uniform2f(E.canvasCss, a(r), a(i)), Y(s, f), s.uniform2i(E.grid, O, k), s.uniform4f(E.cellCss, a(e.left + e.cellWidth / 2), a(e.top + e.cellHeight / 2), a(e.cellWidth), a(e.cellHeight)), s.uniform2i(E.cell, e.cellWidth, e.cellHeight), s.uniform2i(E.buffer, r, i), !0
    },
    setInk: (e, t = 1) => {
      Y(s, f), s.uniform3f(E.color, ...e), s.uniform1f(E.inkAlpha, t)
    },
    setGlow: e => {
      Y(s, f), s.uniform3f(E.glowColor, ...e)
    },
    draw: ({
      time: e,
      reveal: t,
      touch: n
    }) => {
      D !== 0 && (j &&= (M = s.getSyncParameter(j, s.SYNC_STATUS) === s.SIGNALED ? 0 : M + 1, s.deleteSync(j), null), s.bindFramebuffer(s.FRAMEBUFFER, C), s.viewport(0, 0, O * 1, k * 2), Y(s, u), s.uniform1f(E.windTime, e), s.uniform1f(E.reveal, t), te(T.wind, n), s.drawArrays(s.TRIANGLES, 0, 3), s.bindFramebuffer(s.FRAMEBUFFER, null), s.viewport(0, 0, o.width, o.height), s.clearColor(0, 0, 0, 0), s.clear(s.COLOR_BUFFER_BIT), Y(s, f), s.uniform1f(E.glyphTime, e), te(T.glyphs, n), s.drawArrays(s.TRIANGLES, 0, 6 * D), A += 1, A % _e === 0 && (j = s.fenceSync(s.SYNC_GPU_COMMANDS_COMPLETE, 0), s.flush()))
    },
    fellBehind: () => M < 2 ? !1 : (M = 0, !0),
    destroy: () => {
      j && s.deleteSync(j), s.deleteProgram(u), s.deleteProgram(f), s.deleteTexture(p), s.deleteTexture(g), s.deleteTexture(y), s.deleteTexture(S), s.deleteFramebuffer(C), c()
    }
  }
}
var be = "(prefers-contrast: more), (forced-colors: active)",
  xe = "(prefers-color-scheme: dark)",
  Se = 64,
  Ce = 2,
  we = 1500,
  Te = ["a,button,input,textarea,select,label,summary", "[contenteditable]:not([contenteditable='false'])", "[draggable='true']", "[tabindex]:not([tabindex='-1'])", ..."button link textbox combobox listbox option menu menuitem tab switch checkbox radio slider dialog".split(" ").map(e => `[role='${e}']`)].join(",");

function Ee(e) {
  let t = Math.min(1, Math.max(0, e));
  return t * t * (3 - 2 * t)
}

function De(e) {
  return !e.matchMedia(be).matches && "ResizeObserverEntry" in e && "devicePixelContentBoxSize" in e.ResizeObserverEntry.prototype
}

function Oe(e, t) {
  let n = e.document,
    r = () => {
      n.removeEventListener("visibilitychange", i), e.removeEventListener("focus", i)
    };

  function i() {
    !n.hidden && n.hasFocus() && (r(), t())
  }
  return n.addEventListener("visibilitychange", i), e.addEventListener("focus", i), i(), r
}

function ke(e, t) {
  if (typeof e.requestIdleCallback == "function") {
    let n = e.requestIdleCallback(t, {
      timeout: we
    });
    return () => e.cancelIdleCallback(n)
  }
  let n = e.setTimeout(t, 0);
  return () => e.clearTimeout(n)
}

function Ae(e, t) {
  let n = c(e);
  if (!n || !De(n)) return null;
  let r = e.ownerDocument,
    {
      power: o,
      wind: m,
      strength: h
    } = d,
    g = [],
    _ = !1,
    v = !1,
    y = null,
    b = async () => {
      let c = d.seed ?? n.crypto.getRandomValues(new Uint32Array(1))[0] ?? 1,
        b = te(c, d.look ?? ee(c, k(n))),
        x = n.getComputedStyle(e).fontFamily;
      if (await r.fonts.load(`400 16px ${x}`, ".").catch(() => void 0), _) return;
      await new Promise(e => g.push(ke(n, e)));
      let S = await ye(e, n, b, x, () => _);
      if (!S) return;
      if (g.push(S.destroy), _) {
        S.destroy();
        return
      }
      e.dataset.landingTexture = "canvas", g.push(() => {
        delete e.dataset.landingTexture
      }), S.canvas.dataset.look = `${b.key}/${b.seed.toString(16)}`, S.canvas.style.opacity = "0", ne(n, b.key);
      let C = !1,
        w = !1,
        T = 0,
        E = !1,
        D = "",
        O = !1,
        A = 0,
        j = 0,
        M = c / 4294967296 * Se,
        N = 1,
        re = 1,
        P = 0,
        F = o.budgetS,
        ae = -o.resumeS,
        I = o.retryS,
        L, oe = 0,
        R = de(),
        se = n.performance.now(),
        z = () => (n.performance.now() - se) / 1e3,
        B = () => {
          let e = !r.hidden && r.hasFocus(),
            t = O || !D && e;
          S.canvas.style.transition = `opacity ${t?u:500}ms ease-out`, S.canvas.style.opacity = String(t ? oe : 0), S.canvas.dataset.state = O && "still" || D && `busy-${D}` || !e && "unseen" || E && "calm" || "moving"
        },
        ce = () => {
          S.draw({
            time: M,
            touch: O ? void 0 : R.frame(z()),
            reveal: O ? 1 : Ee((A - P) / m.revealS) * N
          })
        },
        V = () => {
          n.clearTimeout(L), L = void 0, E = !1, D = "", T = 0, P = A, ae = A, F = A + o.budgetS, y?.redraw(), B(), y?.refresh()
        },
        le = () => {
          let e = F;
          V(), F = e
        },
        ue = e => {
          D = e, B(), y?.refresh(), L = n.setTimeout(le, I * 1e3), I = Math.min(I * 2, o.retryMaxS)
        },
        H = e => {
          T += 1, T >= Ce ? ue(e) : y?.refresh()
        },
        U = e => {
          let t = Math.min(Math.max(e - j, 0), .25);
          j = e, A += t, N = 1 - Ee((A - F) / o.settleS), re = Ee((A - ae) / o.resumeS), M += t * m.energy * N * re, ce(), N === 0 && !E && !R.busy(z()) ? (E = !0, I = o.retryS, B()) : S.fellBehind() && !E && !D && H("gpu")
        },
        W = "",
        fe = () => {
          let t = n.getComputedStyle(e),
            i = `${t.color} ${t.colorScheme}`;
          if (i === W) return;
          W = i;
          let a = t.colorScheme.includes("light") ? "light" : "dark",
            o = p(r, t.color);
          S.setInk(o.rgb, o.alpha), S.setGlow(d.glow.color[a]), oe = Math.min(1, Math.min(h.base[a] * h.scale, h.cap[a]) * d.glow.headroom), B()
        },
        pe = e => {
          if (w) return;
          let r = f({
            ...e,
            devicePixelRatio: n.devicePixelRatio
          });
          if (C = r !== null && S.resize(r, [e.cssWidth, e.cssHeight]), S.canvas.style.visibility = C ? "" : "hidden", !C) {
            y?.refresh();
            return
          }
          if (fe(), y) {
            y.redraw(), y.refresh();
            return
          }
          y = ie(n, U, {
            intervalMs: () => T > 0 ? o.backoffFrameMs : R.rippling(z()) ? o.rippleFrameMs : o.frameMs,
            allowed: () => C && !E && !D,
            onLate: () => H("late"),
            onStall: () => ue("slow")
          }), O = !v, B(), y.redraw(), t(), y.setRunning(v)
        },
        G, me, K = "waiting",
        he = new(a(e))(e => {
          let t = e[0]?.devicePixelContentBoxSize[0],
            r = e[0]?.contentBoxSize[0];
          if (!t || !r) return;
          G = {
            deviceWidth: t.inlineSize,
            deviceHeight: t.blockSize,
            cssWidth: r.inlineSize,
            cssHeight: r.blockSize
          };
          let i = () => {
            K = "done", G && pe(G)
          };
          K === "waiting" ? (K = "asked", g.push(ke(n, i))) : K === "done" && (n.clearTimeout(me), me = n.setTimeout(i, o.resizeSettleMs))
        });
      he.observe(e, {
        box: "device-pixel-content-box"
      });
      let q, ge = () => {
          q ??= n.requestAnimationFrame(() => {
            q = void 0;
            let e = W;
            fe(), y && W !== e && y.redraw()
          })
        },
        _e = new(s(e))(ge);
      _e.observe(r.documentElement, {
        attributeFilter: ["data-mode", l]
      });
      let J = n.matchMedia(xe);
      J.addEventListener("change", ge);
      let Y = () => {
          E && !r.hidden && r.hasFocus() ? V() : B()
        },
        X = e.parentElement,
        ve = () => !O && v && C && !D,
        Z = t => {
          if (!ve()) return null;
          let n = e.getBoundingClientRect();
          return [t.clientX - n.left, t.clientY - n.top]
        },
        Q = () => {
          E ? V() : A < F && (F = A + o.budgetS)
        },
        be = e => {
          let t = e.pointerType === "mouse" ? Z(e) : null;
          t && (R.move(...t, z()), Q())
        },
        we = e => {
          let t = e.button === 0 ? Z(e) : null;
          if (!t) return;
          let n = i(e.target)?.closest(Te);
          n && n !== X && X?.contains(n) || R.tap(...t, z()), Q(), y?.refresh()
        },
        De = () => {
          ve() && Q()
        };
      X?.addEventListener("pointermove", be, {
        passive: !0
      }), X?.addEventListener("pointerdown", we, {
        passive: !0
      }), X?.addEventListener("pointerleave", R.leave, {
        passive: !0
      }), X?.addEventListener("keydown", De, {
        capture: !0,
        passive: !0
      });
      let Oe = () => {
          n.clearTimeout(me), n.clearTimeout(L), X?.removeEventListener("pointermove", be), X?.removeEventListener("pointerdown", we), X?.removeEventListener("pointerleave", R.leave), X?.removeEventListener("keydown", De, {
            capture: !0
          }), q !== void 0 && n.cancelAnimationFrame(q), he.disconnect(), _e.disconnect(), J.removeEventListener("change", ge), n.removeEventListener("blur", Y), n.removeEventListener("focus", Y), r.removeEventListener("visibilitychange", Y)
        },
        Ae = () => {
          w = !0, C = !1, y?.kill(), S.canvas.style.visibility = "hidden", Oe()
        };
      n.addEventListener("blur", Y), n.addEventListener("focus", Y), r.addEventListener("visibilitychange", Y), S.canvas.addEventListener("webglcontextlost", Ae), g.push(Oe, () => S.canvas.removeEventListener("webglcontextlost", Ae))
    };
  return g.push(Oe(n, () => void b())), {
    setRunning: e => {
      v = e, y?.setRunning(e)
    },
    destroy: () => {
      _ || (_ = !0, y?.destroy(), g.reverse().forEach(e => e()))
    }
  }
}

// 挂载：el = 铺满空态区的容器（官方 class：pointer-events-none absolute inset-0 font-mono-ui text-muted-as-secondary），
// 它的父元素接收指针事件（划过搅动、点击波纹）。onReady 在画布真正准备好时调用（外壳据此淡入）。
// 返回 { setRunning(bool), destroy() }；环境不支持时返回 null。
export function mountLandingTexture(el, onReady) {
  return Ae(el, onReady);
}
