// Effort 拉条顶档（Ultracode）的 WebGL2 能量场——维护者私有 overlay 的运行时模块。
// 来源：claude.ai/code 官方前端 bundle（2026-07-29 逆向 chunk c360a9e1c）：两段 shader 原文，宿主（pse）逐行移植。
// 这是 Anthropic 的专有代码，只放在 bridge-private，永不进公开仓。
// claude-bridge 的 web/src/components/EffortPanel.svelte 经 ovModule('effortField') 加载本文件；
// 公开版没有它，顶档用自写的 CSS 光带。
//
// mountEffortField(canvas) → { pressStart(k), pressEnd(k), destroy() } | null（不支持 WebGL2）
// 颜色与参数从 canvas 的计算样式读（EffortPanel 的 .ef-energy 把 token 挂在 color / outline-color / border-* / … 上）。

const VERT = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
uniform vec2 u_resolution;
void main() {
  v_uv = (a_position * 0.5 + 0.5) * u_resolution;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;
const FRAG = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_fg;
uniform vec3 u_fg2;
uniform float u_seed;
const int MAX_BURSTS = 8;
uniform float u_burstTime[MAX_BURSTS];
uniform vec2  u_burstCenter[MAX_BURSTS];
uniform float u_burstGain[MAX_BURSTS];
uniform float u_fade;
uniform float u_pos;
uniform vec4 u_charge0;
uniform vec4 u_charge1;
uniform float u_bedFill;
uniform vec4 u_tintA;
uniform vec4 u_tintB;
in vec2 v_uv;
out vec4 fragColor;
const float CELL_PITCH = 4.0;
const float CELL_SIZE  = 3.0;
const float CELL_R     = 0.9;
const float SPEED_LO   = 20.0;
const float SPEED_HI   = 36.0;
const float RANGE_LO   = 10.0;
const float RANGE_HI   = 55.0;
const float DENSITY_LO = 0.30;
const float DENSITY_HI = 0.85;
const float JITTER     = 0.10;
const float HEAD_GAIN  = 1.25;
const float HEAD_DECAY = 5.0;
const float BODY_GAIN  = 0.65;
const float BODY_LO    = 3.3;
const float BODY_HI    = 0.77;
const float AMP_LO     = 0.55;
const float MAX_AGE    = 5.0;
const float RAMP_POW    = 1.4;
const float BREATH_DIP  = 0.28;
const float BREATH_BASE = 2.4;
const float BREATH_VARY = 1.4;
uniform float u_chargeMax;
uniform float u_chargeRamp;
uniform float u_inkFloor;
uniform float u_inkCeil;
uniform float u_energyGain;
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  float pitch = u_resolution.y / max(round(u_resolution.y / CELL_PITCH), 1.0);
  float cellScale = pitch / CELL_PITCH;
  vec2 cell = floor(v_uv / pitch);
  vec2 cellCenter = (cell + 0.5) * pitch;
  float cellHalf = CELL_SIZE * 0.5 * cellScale;
  float cellR = CELL_R * cellScale;
  vec2 q = abs(v_uv - cellCenter) - vec2(cellHalf - cellR);
  float distC = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - cellR;
  float aa = min(fwidth(v_uv.x), 1.5);
  float cellMask = 1.0 - smoothstep(-aa, aa, distC);
  if (cellMask <= 0.0 && u_bedFill <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }
  float jitter = (hash21(cell + 41.7 + u_seed) - 0.5) * 2.0 * JITTER;
  float vary   = 0.35 + 0.65 * hash21(cell + 13.7 + u_seed);
  float energy = 0.0;
  float charged = 0.0;
  for (int i = 0; i < MAX_BURSTS; i++) {
    float age = u_time - u_burstTime[i];
    if (age < 0.0 || age > MAX_AGE) continue;
    float k = clamp(u_burstGain[i], 0.0, 1.0);
    vec2 originCell = floor(u_burstCenter[i] / pitch);
    float manh = abs(cell.x - originCell.x) + abs(cell.y - originCell.y);
    float range   = mix(RANGE_LO, RANGE_HI, k);
    float falloff = exp(-manh / (range * 0.85));
    float reach   = exp(-max(manh - range, 0.0) * 0.12);
    float speed   = mix(SPEED_LO, SPEED_HI, k);
    float t = age - manh / speed - jitter;
    charged = max(charged, smoothstep(0.0, 0.15, t) * reach);
    if (t < 0.0) continue;
    float rank = hash21(cell + 7.3 + u_seed + u_burstTime[i]);
    if (rank > mix(DENSITY_LO, DENSITY_HI, k)) continue;
    float head = HEAD_GAIN * exp(-t * HEAD_DECAY);
    float body = BODY_GAIN * exp(-t * mix(BODY_LO, BODY_HI, k));
    energy += (head + body) * mix(AMP_LO, 1.0, k) * falloff * reach * vary;
  }
  float lumA = hash21(cell + 8.8 + u_seed);
  float lumB = hash21(cell + 88.8 + u_seed);
  float lumDrift = 0.5 + 0.5 * sin(u_time * 0.35 + lumA * 6.2832);
  float lum = pow(mix(lumA, lumB, lumDrift), 1.9);
  float stream = 0.9 + 0.16 * sin(u_time * 1.3 + cell.x * 0.45 + lumB * 2.0);
  float e = clamp(energy, 0.0, 1.0) * u_fade * mix(0.16, 1.0, lum) * stream
    * u_energyGain;
  float g = clamp(v_uv.x / max(u_pos * u_resolution.x, 1.0), 0.0, 1.0);
  vec3 chargeColor = mix(u_charge0.rgb, u_charge1.rgb, g);
  float bedMask = mix(u_bedFill, 1.0, cellMask);
  float chargeA = u_chargeMax * pow(g, u_chargeRamp) * charged * u_fade
    * bedMask * mix(u_charge0.a, u_charge1.a, g);
  float lv = step(0.04, e) + step(0.2, e) + step(0.4, e) + step(0.6, e) + step(0.8, e);
  float alpha = lv <= 0.0 ? 0.0 : mix(u_inkFloor, u_inkCeil, (lv - 1.0) / 4.0);
  if (lv >= 5.0) {
    float period = BREATH_BASE + BREATH_VARY * hash21(cell + 3.1 + u_seed);
    float phase = hash21(cell + 5.5 + u_seed) * 6.2832;
    alpha *= 1.0 - BREATH_DIP * 0.5 * (1.0 + sin(u_time * 6.2832 / period + phase));
  }
  vec3 ink = mix(u_fg2, u_fg, pow(lv / 5.0, RAMP_POW));
  float hueSel = hash21(cell + 27.9 + u_seed);
  ink = mix(ink, u_tintA.rgb, u_tintA.a * smoothstep(0.62, 0.95, hueSel));
  ink = mix(ink, u_tintB.rgb, u_tintB.a * (1.0 - smoothstep(0.05, 0.38, hueSel)));
  float eA = alpha * cellMask;
  vec3 col = ink * eA + chargeColor * chargeA * (1.0 - eA);
  float a = eA + chargeA * (1.0 - eA);
  if (a <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }
  fragColor = vec4(col, a);
}
`;

export function mountEffortField(cnv) {
  const gl = cnv.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
  const prog = gl.createProgram();
  const vs = mk(gl.VERTEX_SHADER, VERT), fs = mk(gl.FRAGMENT_SHADER, FRAG);
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { gl.deleteProgram(prog); return null; }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_position');
  gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uTime = U('u_time'), uRes = U('u_resolution'), uSeed = U('u_seed'), uPos = U('u_pos'),
    uC0 = U('u_charge0'), uC1 = U('u_charge1'), uBed = U('u_bedFill'), uCMax = U('u_chargeMax'),
    uCRamp = U('u_chargeRamp'), uFloor = U('u_inkFloor'), uCeil = U('u_inkCeil'), uGain = U('u_energyGain'),
    uTA = U('u_tintA'), uTB = U('u_tintB'), uFg = U('u_fg'), uFg2 = U('u_fg2'),
    uBT = U('u_burstTime[0]'), uBC = U('u_burstCenter[0]'), uBG = U('u_burstGain[0]'), uFade = U('u_fade');
  gl.clearColor(0, 0, 0, 0);
  gl.uniform3fv(uFg, [0.72, 0.59, 1]); gl.uniform3fv(uFg2, [1, 1, 1]);
  gl.uniform1f(uFade, 0); gl.uniform1f(uSeed, 0); gl.uniform1f(uPos, 1);
  gl.uniform4f(uC0, 0.62, 0.5, 0.92, 1); gl.uniform4f(uC1, 0.35, 0.25, 0.6, 1);
  gl.uniform1f(uBed, 0); gl.uniform1f(uCMax, 0.85); gl.uniform1f(uCRamp, 1.1);
  gl.uniform1f(uFloor, 0.08); gl.uniform1f(uCeil, 0.85); gl.uniform1f(uGain, 1);
  gl.uniform4f(uTA, 0, 0, 0, 0); gl.uniform4f(uTB, 0, 0, 0, 0);
  const bTimes = new Float32Array(8).fill(-1000), bCenters = new Float32Array(16), bGains = new Float32Array(8);
  gl.uniform1fv(uBT, bTimes); gl.uniform2fv(uBC, bCenters); gl.uniform1fv(uBG, bGains);
  // 颜色解析探针（官方 cse/dse 等价，canvas2d 认所有 CSS 色格式）
  const pc = document.createElement('canvas'); pc.width = 1; pc.height = 1;
  const px = pc.getContext('2d', { willReadFrequently: true });
  const parse = (c, fb) => { try { px.clearRect(0, 0, 1, 1); px.fillStyle = '#000'; px.fillStyle = c; px.fillRect(0, 0, 1, 1);
    const d = px.getImageData(0, 0, 1, 1).data; return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255]; } catch { return fb; } };
  let slot = 0, T = false, E = 0, fade = 0, hold = 0;
  let W = 1, H = 1, dirty = true, raf = 0, running = false, prev = 0;
  let lastBurstU = -1 / 0, lastBurstWall = -1 / 0, nextGap = 0.45, hiddenHeld = false, Utime = 0;
  const rm = matchMedia('(prefers-reduced-motion: reduce)');
  const gain = (e, t) => Math.min((0.15 + 0.7 * e) * (0.45 + 0.55 * t), 1);
  const draw = () => {
    if (dirty) { gl.viewport(0, 0, cnv.width, cnv.height); gl.uniform2f(uRes, W, H); dirty = false; }
    gl.uniform1f(uTime, Utime); gl.uniform1f(uPos, Math.max(E, 0.02));
    gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 6);
  };
  const alive = () => Utime - lastBurstU < 5;
  const frame = (now) => {
    const dt = 0.001 * (now - prev);
    Utime += dt; prev = now;
    fade = T ? Math.min(fade + dt / 0.7, 1) : Math.max(fade - dt / 0.85, 0);
    hold = T ? hold + dt : 0;
    if (T && Utime - lastBurstU > nextGap) {
      const h = Math.min(hold / 1.6, 1);
      nextGap = 0.3 + 0.45 * Math.random();
      emit(gain(E, h) * (0.85 + 0.3 * Math.random()), E + 0.08 * (Math.random() - 0.5));
    }
    const s = fade * fade * (3 - 2 * fade);
    gl.uniform1f(uFade, s);
    draw();
    if ((T || (alive() && fade > 0)) && !document.hidden) raf = requestAnimationFrame(frame);
    else running = false;
  };
  const start = () => { if (!running) { running = true; prev = performance.now(); raf = requestAnimationFrame(frame); } };
  const stopLoop = () => { if (running) { running = false; cancelAnimationFrame(raf); } };
  const size = (w, h, dpr) => {
    const rw = Math.max(1, w), rh = Math.max(1, h);
    if (rw !== W || rh !== H) {
      const ex = rw / W, ey = rh / H;
      for (let i = 0; i < 8; i++) { bCenters[2 * i] *= ex; bCenters[2 * i + 1] *= ey; }
      gl.uniform2fv(uBC, bCenters); W = rw; H = rh; dirty = true;
    }
    let ow = Math.max(1, Math.round(w * dpr)), oh = Math.max(1, Math.round(h * dpr));
    if (ow * oh > 4147200) { const sc = Math.sqrt(4147200 / (ow * oh)); ow = Math.max(1, Math.round(ow * sc)); oh = Math.max(1, Math.round(oh * sc)); }
    if (cnv.width !== ow || cnv.height !== oh) { cnv.width = ow; cnv.height = oh; dirty = true; }
  };
  const emit = (k, posX) => {
    bTimes[slot] = Utime;
    bCenters[2 * slot] = posX * W;
    bCenters[2 * slot + 1] = H * (0.35 + 0.3 * Math.random());
    bGains[slot] = k;
    slot = (slot + 1) % 8;
    gl.uniform1fv(uBT, bTimes); gl.uniform2fv(uBC, bCenters); gl.uniform1fv(uBG, bGains);
    lastBurstU = Utime; lastBurstWall = performance.now();
    if (!document.hidden) start();
  };
  const refreshColors = () => {
    const cs = getComputedStyle(cnv);
    const fg = parse(cs.color, [0.72, 0.59, 1, 1]), fg2 = parse(cs.outlineColor, [1, 1, 1, 1]);
    gl.uniform3fv(uFg, fg.slice(0, 3)); gl.uniform3fv(uFg2, fg2.slice(0, 3));
    const c0 = parse(cs.borderTopColor, [0.62, 0.5, 0.92, 1]), c1 = parse(cs.borderBottomColor, [0.35, 0.25, 0.6, 1]);
    gl.uniform4f(uC0, c0[0], c0[1], c0[2], c0[3]); gl.uniform4f(uC1, c1[0], c1[1], c1[2], c1[3]);
    const ta = parse(cs.textDecorationColor, [0, 0, 0, 0]), tb = parse(cs.columnRuleColor, [0, 0, 0, 0]);
    gl.uniform4f(uTA, ta[0], ta[1], ta[2], ta[3]); gl.uniform4f(uTB, tb[0], tb[1], tb[2], tb[3]);
    const num = (n, fb) => { const v = parseFloat(cs.getPropertyValue(n)); return Number.isNaN(v) ? fb : v; };
    const cl = (v) => Math.min(Math.max(v, 0), 1);
    gl.uniform1f(uBed, cl(num('--ui-slider-energy-bed-fill', 0)));
    gl.uniform1f(uCMax, cl(num('--ui-slider-energy-charge-max', 0.85)));
    gl.uniform1f(uCRamp, Math.max(num('--ui-slider-energy-charge-ramp', 1.1), 0.01));
    gl.uniform1f(uFloor, cl(num('--ui-slider-energy-ink-floor', 0.08)));
    gl.uniform1f(uCeil, cl(num('--ui-slider-energy-ink-ceil', 0.85)));
    gl.uniform1f(uGain, Math.max(num('--ui-slider-energy-gain', 1), 0));
  };
  const ro = new ResizeObserver((es) => {
    const en = es[0], db = en.devicePixelContentBoxSize?.[0];
    if (db) { const dpr = devicePixelRatio || 1; size(db.inlineSize / dpr, db.blockSize / dpr, dpr); }
    else { const bb = en.borderBoxSize?.[0] ?? en.contentBoxSize?.[0]; size(bb?.inlineSize ?? cnv.clientWidth, bb?.blockSize ?? cnv.clientHeight, devicePixelRatio || 1); }
    draw();
  });
  ro.observe(cnv);
  const onVis = () => {
    if (document.hidden) {
      hiddenHeld = T; T = false; lastBurstU = -1 / 0; lastBurstWall = -1 / 0; fade = 0;
      bTimes.fill(-1000); gl.uniform1fv(uBT, bTimes); stopLoop(); gl.uniform1f(uFade, 0); draw();
    } else if (hiddenHeld && !rm.matches) {
      hiddenHeld = false; refreshColors(); T = true; hold = 0; emit(gain(E, 0), E);
    } else if (alive()) start();
  };
  document.addEventListener('visibilitychange', onVis);
  let live = true;
  const api = {
    pressStart: (e) => {
      if (!live || rm.matches) return;
      refreshColors();
      if (performance.now() - lastBurstWall > 5000 && fade <= 0) { bTimes.fill(-1000); gl.uniform1fv(uBT, bTimes); gl.uniform1f(uSeed, 512 * Math.random()); }
      T = true; hold = 0; E = e;
      emit(gain(e, 0), e);
    },
    pressEnd: (e) => { if (!live) return; hiddenHeld = false; if (T) { T = false; E = e; if (!document.hidden) start(); } }
  };
  size(cnv.clientWidth || 1, cnv.clientHeight || 1, devicePixelRatio || 1);
  draw();
  api.destroy = () => {
    if (!live) return;
    live = false; stopLoop(); ro.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    gl.deleteProgram(prog); gl.deleteBuffer(buf);
  };
  return api;
}


