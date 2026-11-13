// 流光·海面：正对屏幕的一片锐边点阵，被一整片海浪推着起伏（暗主题动态壁纸）。
//
// 11-03 版是旋度流场，点顺着涡转——像飓风，不像水；11-07 上午那版只叠了几道又长又整齐的浪，一屏只看得见半个波，
// 看着就是正弦波。这版按真实海面的做法：
//   · 海面 = 32 道 Gerstner 波叠加，波长按对数铺开、振幅取 Pierson–Moskowitz 风浪谱（峰值波长附近最强，
//     更长的浪迅速变弱、更短的浪保持同样的陡度），方向围绕风向随机散开（越短越散），相位随机——
//     叠出来是一块块不规则、此起彼伏、成组到来的浪，不会有整齐的条纹；
//   · 峰值波长约为屏幕长边的 1/4.6（不小于 240 px），桌面一屏能看到四五道浪；
//   · 深水色散：长浪跑得快、短浪慢（ω ∝ 1/√λ），浪群会自己聚散；
//   · Gerstner 的水平位移让浪峰处的点被挤密、浪谷被拉疏——点阵本身就把浪形画出来了；
//   · 每颗点是锐利的实心圆（1 个设备像素抗锯齿，不虚化、不加光晕），亮度与颜色全场恒定；
//   · 浪只靠点的体积表现：点径是大尺度浪高（峰值附近及更长的浪）的平滑非线性 S 曲线，
//     波谷是针尖点、浪脊最饱满——碎浪只让点轻轻晃，不参与，否则轮廓发散（11-07 552 版就是因此「边缘太散」）。
//
// 与宿主（Home.svelte / DesktopHome.svelte）的接口沿用 flux 那一套，宿主代码不用分两套：
//   window.wallpaperPropertyListener.applyUserProperties({ key: { value } })   套参数（state.fluxProps()）
//   window.wallpaperPropertyListener.applyGeneralProperties({ fps })            宿主降帧（被盖住 1、失焦 20、Infinity=不限）
//   window.__fluxFrame()   每画完一帧、同一任务内调用：宿主借此把画布拷给玻璃（缓冲只在这个任务里有效）
//   canvas#canvas          宿主直接读这块画布
// 构造前先从 parent.__fluxProps() 取参数，第一帧就是对的。
// 单独调试：drift.html?colormode=Plasma&turbulence=1；?t=秒 定格在某一刻（无头截图用），window.__freeze(t) 同理。

const canvas = document.getElementById('canvas');

// —— 参数（与 state.svelte.js 的 FLUX_DEFAULTS 同步；宿主没给的字段用这里的） ——
// gridspacing 点距 / linelength 拖尾 / linewidth 光点大小（css px）；flowscale 浪长倍数；turbulence 碎浪多少；glow 光晕（默认 0 = 锐边）
const P = {
  colormode: 'Poolside', speed: 1, flowscale: 1, turbulence: 0.5,
  gridspacing: 18, linelength: 0, linewidth: 4.4, brightness: 1, glow: 0, maxfps: 30,
};
const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
function setProps(p) {
  if (!p) return;
  for (const k in p) {
    const v = p[k] && typeof p[k] === 'object' && 'value' in p[k] ? p[k].value : p[k];
    if (k === 'colormode') { if (typeof v === 'string') P.colormode = v; continue; }
    if (k in P) P[k] = Number(v);
  }
  P.gridspacing = num(P.gridspacing, 5, 60, 18);
  P.linelength = num(P.linelength, 0, 12, 0);
  P.linewidth = num(P.linewidth, 0.4, 12, 4.4);
  P.brightness = num(P.brightness, 0, 3, 1);
  P.glow = num(P.glow, 0, 1, 0);
  P.speed = num(P.speed, 0, 5, 1);
  P.flowscale = num(P.flowscale, 0.3, 3, 1);
  P.turbulence = num(P.turbulence, 0, 1, 0.5);
  P.maxfps = num(P.maxfps, 5, 120, 30);
  dirty = true;
}

// 配色：深水 / 水色 / 浪峰 / 浪尖。Original = 虹彩（色相随浪面朝向流转）。
const PALETTES = {
  Poolside: ['#123a8a', '#3f7fe6', '#a9cdff', '#f4f8ff'],
  Plasma:   ['#4a1386', '#b5338a', '#ff8a5c', '#fff0d8'],
  Freedom:  ['#163fa0', '#3f86f0', '#ffd65a', '#fff8de'],
  Original: ['#2a2060', '#6a5acd', '#b9a8ff', '#f6f2ff'],
};
function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }

const NW = 32;
const VS = `#version 300 es
precision highp float;
#define NW ${NW}
uniform vec2 uRes;            // 画布像素
uniform float uDpr;
uniform float uSpacing;       // 点距（css px）
uniform int uCols;
uniform vec2 uOrigin;         // 第一个格点（css px）
uniform vec4 uWa[NW];         // 方向 x、方向 y、波数 k（1/css px）、振幅 A（css px）
uniform vec4 uWb[NW];         // 陡度 Q、角频率 ω、当前相位、波长 λ（css px）
uniform float uSigma;         // 大尺度浪高的均方根（css px）
uniform float uLamP;          // 峰值波长（css px）
uniform float uLen, uWid, uGlow, uBright, uFade;
uniform int uMode;
uniform vec3 uPal[4];
uniform vec3 uL;              // 光的方向（屏幕坐标，y 向下，z 朝向观者）
out vec2 vLocal;              // 相对点中心：x 沿运动方向、y 横向（设备像素）
flat out float vHalf, vRad, vGlowR;
flat out vec4 vCol;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  int id = gl_InstanceID;
  vec2 cell = vec2(float(id % uCols), float(id / uCols));
  vec2 x0 = uOrigin + cell * uSpacing;                  // 静止位置（css px）
  float hv = hash(cell);

  // Gerstner 叠加；比 2.5 个点距短的浪在点阵上会走样闪烁，连续衰减掉
  vec2 p = x0;
  float z = 0.0, zl = 0.0;
  vec2 vel = vec2(0.0);
  float nx = 0.0, ny = 0.0, nz = 1.0;
  for (int i = 0; i < NW; i++) {
    vec4 a = uWa[i], b = uWb[i];
    float att = smoothstep(2.5, 4.0, b.w / uSpacing);
    if (att <= 0.0) continue;
    float A = a.w * att;
    float th = a.z * dot(a.xy, x0) + b.z;
    float s = sin(th), c = cos(th);
    float qa = b.x * A;
    p += qa * a.xy * c; z += A * s;
    zl += A * s * smoothstep(0.45, 0.8, b.w / uLamP);  // 只取峰值附近及更长的浪：浪形轮廓由它定
    nx -= a.x * a.z * A * c; ny -= a.y * a.z * A * c; nz -= b.x * a.z * A * s;
    vel += qa * a.xy * b.y * s;
  }
  vec3 N = normalize(vec3(nx * 2.0, ny * 2.0, nz));

  // 浪形只看大尺度浪高（碎浪只让点轻轻晃，不参与，否则轮廓发散）。
  // 亮度和颜色全场恒定，浪只靠【点的体积】表现：点径是浪高的平滑非线性函数——
  // 两次 smoothstep 叠成一条更柔的 S 曲线：波谷是细小的针尖点，爬坡时点平滑地胀大，浪脊上最饱满。
  float hl = zl / uSigma;
  float sz = smoothstep(-0.9, 1.7, hl);
  sz = sz * sz * (3.0 - 2.0 * sz);
  vec3 col = mix(uPal[1], uPal[2], 0.75);
  if (uMode == 1) {
    float hh = atan(N.y, N.x) * 1.2 + hl * 0.6;
    col = mix(vec3(0.72), 0.5 + 0.5 * cos(hh + vec3(0.0, 2.094, 4.189)), 0.6);
  }
  float alpha = min(uBright, 1.0) * uFade;
  // uWid = 浪脊上最大的点径；波谷约为它的 12%（片元里亚像素的点按覆盖面积自然变淡，不另调亮度）
  float rad = 0.5 * uWid * uDpr * mix(0.12, 1.0, sz);

  // 拖尾（默认 0 = 纯圆点）：最近 uLen×0.045 秒在屏幕上划过的轨迹，头在当前位置
  vec2 delta = vel * (uLen * 0.045) * uDpr;
  float L = length(delta);
  vec2 dir = L > 1e-3 ? delta / L : vec2(1.0, 0.0);
  float half_ = min(0.5 * L, (4.0 + 2.5 * uWid) * uDpr);
  vec2 cen = p * uDpr - dir * half_;

  float gr = uGlow * (1.0 + uWid) * 1.5 * uDpr;
  float ex = half_ + rad + gr + 1.0, ey = rad + gr + 1.0;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec2 local = corner * vec2(ex, ey);
  vec2 pos = cen + dir * local.x + vec2(-dir.y, dir.x) * local.y;
  gl_Position = vec4(pos / uRes * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  vLocal = local; vHalf = half_; vRad = rad; vGlowR = max(gr, 1e-3);
  vCol = vec4(col, alpha);
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in float vHalf, vRad, vGlowR;
flat in vec4 vCol;
uniform float uGlowAmt;
out vec4 o;
void main() {
  float ax = clamp(vLocal.x, -vHalf, vHalf);
  float u = vHalf > 0.0 ? ax / vHalf * 0.5 + 0.5 : 1.0;   // 0 = 尾，1 = 头
  // 有拖尾时是头圆尾尖的水滴；拖尾比点径短就是一颗完整的圆点
  float tk = clamp(vHalf / (vRad * 2.0 + 0.5), 0.0, 1.0);
  float r = vRad * mix(1.0, mix(0.3, 1.0, u * u * (3.0 - 2.0 * u)), tk);
  float d = length(vec2(vLocal.x - ax, vLocal.y));
  float core = clamp(r + 0.5 - d, 0.0, 1.0);             // 锐边：只留 1 个设备像素的抗锯齿
  float e = max(d - r, 0.0) / vGlowR;
  float halo = uGlowAmt * 0.2 * exp(-e * e * 3.0);
  float a = (core + halo * (1.0 - core)) * vCol.a * mix(1.0, mix(0.25, 1.0, u), tk);
  if (a < 0.002) discard;
  o = vec4(vCol.rgb * a, a);
}`;

// —— 底色（全屏一个三角形）：近黑的深水色，四角略压暗，带抖动防色带 ——
const BG_VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const BG_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec3 uDeep;
uniform float uFade, uSeed;
out vec4 o;
float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec2 c = gl_FragCoord.xy / uRes - 0.5;
  c.x *= uRes.x / uRes.y;
  float vig = 1.0 - smoothstep(0.4, 1.1, length(c));
  vec3 col = uDeep * (0.035 + 0.04 * vig) * uFade;
  col += (h12(gl_FragCoord.xy + uSeed) - 0.5) / 255.0;    // 抖动防色带
  o = vec4(max(col, 0.0), 1.0);
}`;

let gl = null, prog = null, bg = null, U = {}, BU = {}, dirty = true;
let W = 0, H = 0, dpr = 1, cols = 0, rows = 0, origin = [0, 0];
const waves = [];                     // { dx, dy, k, A, Q, w, ph, lam }
let wavesKey = '', sigma = 1, lamPeak = 200;
let simT = 0, lastNow = 0, lastDraw = 0, born = 0, hostFps = Infinity, raf = 0, shown = false;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function link(vs, fs, names, out) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return p;
}
function init() {
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'low-power' });
  if (!gl) return false;
  prog = link(VS, FS, ['uRes', 'uDpr', 'uSpacing', 'uCols', 'uOrigin', 'uWa', 'uWb', 'uSigma', 'uLamP',
    'uLen', 'uWid', 'uGlow', 'uBright', 'uFade', 'uMode', 'uPal', 'uL', 'uGlowAmt'], U);
  bg = link(BG_VS, BG_FS, ['uRes', 'uDeep', 'uFade', 'uSeed'], BU);
  gl.bindVertexArray(gl.createVertexArray());       // 空 VAO：全部由 gl_VertexID / gl_InstanceID 推
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 1);
  dirty = true;
  return true;
}

// 画布按元素实测尺寸 × DPR（封顶 2）
function measure() {
  const r = canvas.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return false;   // 宿主切走 display:none：不动画布
  const d = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (w !== canvas.width || h !== canvas.height || d !== dpr || r.width !== W || r.height !== H) {
    canvas.width = w; canvas.height = h; dpr = d; W = r.width; H = r.height; dirty = true;
  }
  return true;
}
// 网格居中铺满，四周各多出几格：浪把点推来推去时边上不露空
function layout() {
  const sp = P.gridspacing;
  cols = Math.ceil(W / sp) + 7; rows = Math.ceil(H / sp) + 7;
  origin = [(W - (cols - 1) * sp) / 2, (H - (rows - 1) * sp) / 2];
}

// —— 浪谱 ——
// 固定种子：每台设备、每次打开都是同一片海的「性格」（时间起点随机，所以画面每次不同）
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }
function buildWaves() {
  const ext = Math.max(W, H);
  const key = P.flowscale + '|' + P.turbulence + '|' + ext;
  if (key === wavesKey) return;
  wavesKey = key;
  const old = waves.splice(0);
  const r = rng(0x5eaf10);
  // 峰值波长：长边的 1/4.6（桌面一屏四五道浪），夹在 240–420 css px 之间，再乘「浪长」
  // 点距 18 时至少要 9–10 个点才画得出一道浪的形状，所以小屏也不低于 240
  const lamP = Math.min(420, Math.max(240, ext / 4.6)) * P.flowscale;
  const wind = 0.5;                                              // 风向：朝右下
  const chop = 0.25 + 0.9 * P.turbulence;                        // 短于峰值波长的浪乘这个
  const lamMax = lamP * 2.4, lamMin = lamP / 7;
  let var_ = 0;
  for (let i = 0; i < NW; i++) {
    // 波长按对数均匀铺开，每道再抖一点，避免成整倍数（整倍数会叠出规则花纹）
    // 峰值附近采得更密（t 经 smoothstep 反向拉伸）：真实海面的能量集中在峰值波长附近
    let t = (i + 0.2 + 0.6 * r()) / NW;
    t = 0.5 + (t - 0.5) * (0.55 + 0.9 * Math.abs(t - 0.5));
    const lam = lamMax * Math.pow(lamMin / lamMax, t);
    const k = 2 * Math.PI / lam;
    // Pierson–Moskowitz：A ∝ λ·exp(-0.625(λ/λp)²)（对数间隔采样下的振幅）
    let A = 0.03 * lam * Math.exp(-0.625 * (lam / lamP) ** 2) * (0.75 + 0.5 * r());
    if (lam < lamP) A *= chop;
    // 方向：围绕风向随机散开，越短的浪越散（长涌浪整齐、碎浪乱）
    // 峰值附近 σ≈0.62 rad：浪峰短而交错（short-crested），不是一条条平行长条
    const spread = 0.62 + 0.4 * Math.max(0, Math.min(1, Math.sqrt(lamP / lam) - 0.7));
    const a = wind + gauss(r) * spread;
    // 深水色散 ω ∝ 1/√λ：峰值浪约 4.5 秒一个周期
    const w = (2 * Math.PI / 4.5) * Math.sqrt(lamP / lam);
    waves.push({ dx: Math.cos(a), dy: Math.sin(a), k, A, w, lam, ph: old[i] ? old[i].ph : r() * 2 * Math.PI });
    // 大尺度浪高的方差（与着色器里 zl 同一个权重）
    const wl = Math.min(1, Math.max(0, (lam / lamP - 0.45) / 0.35)); const wls = wl * wl * (3 - 2 * wl);
    var_ += (A * wls) ** 2 / 2;
  }
  sigma = Math.sqrt(var_);
  lamPeak = lamP;
  // 陡度：浪尖挤尖但不打卷（Σ Q·k·A = 0.55–0.85）
  let qk = 0;
  for (const w of waves) qk += w.k * w.A;
  const steep = 0.55 + 0.3 * P.turbulence;
  for (const w of waves) w.Q = steep / qk;
}

// 光从左上方斜照
const LIGHT = (() => { const v = [-0.45, -0.5, 0.74]; const n = Math.hypot(...v); return v.map((x) => x / n); })();

function draw(now) {
  if (!gl || !W) return;
  if (dirty) { layout(); buildWaves(); dirty = false; }
  const pal = (PALETTES[P.colormode] || PALETTES.Poolside).map(hex);
  const f = Math.min(1, (now - born) / 1800);
  const fade = 1 - (1 - f) ** 3;                                 // 挂上后 1.8 秒从黑浮现
  gl.viewport(0, 0, canvas.width, canvas.height);

  gl.disable(gl.BLEND);
  gl.useProgram(bg);
  gl.uniform2f(BU.uRes, canvas.width, canvas.height);
  gl.uniform3fv(BU.uDeep, pal[0]);
  gl.uniform1f(BU.uFade, fade);
  gl.uniform1f(BU.uSeed, (simT * 61) % 997);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.enable(gl.BLEND);
  gl.useProgram(prog);
  gl.uniform2f(U.uRes, canvas.width, canvas.height);
  gl.uniform1f(U.uDpr, dpr);
  gl.uniform1f(U.uSpacing, P.gridspacing);
  gl.uniform1i(U.uCols, cols);
  gl.uniform2f(U.uOrigin, origin[0], origin[1]);
  const wa = new Float32Array(NW * 4), wb = new Float32Array(NW * 4);
  waves.forEach((w, i) => {
    wa.set([w.dx, w.dy, w.k, w.A], i * 4);
    wb.set([w.Q, w.w * P.speed, w.ph, w.lam], i * 4);
  });
  gl.uniform4fv(U.uWa, wa); gl.uniform4fv(U.uWb, wb);
  gl.uniform1f(U.uSigma, sigma);
  gl.uniform1f(U.uLamP, lamPeak);
  gl.uniform1f(U.uLen, P.linelength);
  gl.uniform1f(U.uWid, P.linewidth);
  gl.uniform1f(U.uGlow, P.glow);
  gl.uniform1f(U.uGlowAmt, P.glow > 0 ? 1 : 0);
  gl.uniform1f(U.uBright, P.brightness);
  gl.uniform1f(U.uFade, fade);
  gl.uniform1i(U.uMode, P.colormode === 'Original' ? 1 : 0);
  gl.uniform3fv(U.uPal, pal.flat());
  gl.uniform3fv(U.uL, LIGHT);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cols * rows);
  try { window.__fluxFrame && window.__fluxFrame(); } catch {}
}

// 推进时间：相位按双精度累加（ω 随「浪速」缩放，改速度不跳）
function advance(dt) {
  simT += dt;
  for (const w of waves) w.ph = (w.ph - w.w * P.speed * dt) % (2 * Math.PI);
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  const fps = Math.min(P.maxfps, hostFps);
  // 允许 ±半帧的抖动，否则 60Hz 屏上 30 帧会落成 20 帧
  if (now - lastDraw < 1000 / fps - 4) return;
  const dt = Math.min(0.1, (now - (lastNow || now)) / 1000);
  lastNow = now; lastDraw = now;
  if (dirty && W) { layout(); buildWaves(); dirty = false; }
  advance(dt);
  if (shown) draw(now);
}

// —— 对外接口（同 flux 的 Wallpaper Engine 接口） ——
window.wallpaperPropertyListener = {
  applyUserProperties(p) { setProps(p); },
  applyGeneralProperties(p) {
    if (p && 'fps' in p) { const v = Number(p.fps); hostFps = v > 0 ? v : Infinity; }
  },
};
window.wallpaperRegisterAudioListener = window.wallpaperRegisterAudioListener || function () {};

try { if (parent !== window && parent.__fluxProps) setProps(parent.__fluxProps()); } catch {}
const q = new URLSearchParams(location.search);
for (const [k, v] of q) if (k in P) setProps({ [k]: { value: k === 'colormode' ? v : Number(v) } });
const freezeT = q.has('t') ? Number(q.get('t')) : null;
window.__stats = () => ({ instances: cols * rows, cols, rows, sigma });
window.__freeze = (t) => {
  if (!gl) return;
  cancelAnimationFrame(raf);
  waves.length = 0; wavesKey = ''; simT = 0;
  shown = measure(); layout(); buildWaves(); dirty = false;
  advance(t); born = -1e9; draw(performance.now());
};

function start() {
  if (!init()) { document.body.style.background = '#05070d'; return; }
  born = performance.now();
  shown = measure();
  if (shown) { layout(); buildWaves(); dirty = false; }
  if (freezeT != null) { window.__freeze(freezeT); return; }
  advance(20 + Math.random() * 300);                           // 每次进来是另一片海
  if (shown) draw(born);
  raf = requestAnimationFrame(frame);
}
// 尺寸变了当场补画一帧：改 width/height 会清空画布，等下一个 RAF 就会闪一帧黑
new ResizeObserver(() => { shown = measure(); if (gl && shown) draw(performance.now()); }).observe(canvas);
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(raf); });
canvas.addEventListener('webglcontextrestored', () => { start(); });
start();
