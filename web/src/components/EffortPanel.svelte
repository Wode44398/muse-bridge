<script>
  // Effort 拉条面板——100% 复刻 claude.ai/code（2026-07-29 逆向官方 bundle
  // chunk c360a9e1c 所得，shader 原文照搬、宿主逻辑逐行移植、明暗 token 实测值）：
  // - 卡片 220px / p10 / gap16 / r12，surface-popover + stroke-shadow 双模式；
  // - 标题行 Effort(t6) + 档名(t7, 换档 0.2s easeOut ±0.55em blur2px 方向交换) + ?(U+e088)
  //   悬停 200ms 出官方帮助浮层；Faster/Smarter 12px t6；
  // - 轨道 24 命中/20 视高 r6，fill 按 --slider-drag-pos/--slider-rest-pos 走；
  //   拖拽自由跟手（catchUp 100ms cubic-out）、松手/点按吸附 400ms linear() 官方缓动、
  //   拖动中档名跟随高亮、松手才提交；键盘即时提交（官方同为瞬移）；
  // - 档位点 3px（末档 accent 紫）、35ms 步进错峰、顶档隐去；把手 16×19 r6 双模式色；
  // - 顶档（accent）= data-top-stop：WebGL2 能量场常按（pressStart(1)），爆发波前 +
  //   细胞网格 shader 原版；离开顶档 pressEnd 冷却。prefers-reduced-motion 全静。
  import { cubicOut } from 'svelte/easing';
  import { caps, settings } from '../lib/state.svelte.js';
  import { claudeEffortFallback } from '../lib/caps.js';
  import { rememberCurrentPrefs } from '../lib/chat.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { clampX } from '../lib/clampx.js';
  import { IS_CSNAP } from '../lib/csnap.js';
  import { t as tt } from '../lib/i18n.js';   // 本文件动画代码里 t 是插值进度变量，翻译函数取别名
  let { onClose, dir = 'up' } = $props();

  $effect(() => pushBackLayer(() => { onClose?.(); }));

  // 快照访客没有 Ultracode：服务端把它静默降到 xhigh 又不发 effort 实况，列出来只会让芯片恒显 Ultracode 却
  // 没有任何降档提示——直接不列（chat 内核发请求时也把残留的 ultracode 归成 xhigh）。
  const efforts = $derived((caps.data?.claude?.efforts || []).filter((e) => !IS_CSNAP || e.id !== 'ultracode'));
  const N = $derived(efforts.length);
  const idx = $derived.by(() => {
    const i = efforts.findIndex((e) => e.id === (settings.effort || claudeEffortFallback(caps.data, settings.model)));
    return i < 0 ? Math.min(2, Math.max(0, N - 1)) : i;
  });
  // Ultracode 档（capabilities.efforts 末尾 {id:'ultracode'}）= 官方唯一带 accent 的档位：紫档名 /
  // 紫点 / 能量场都跟着它走（官方 items.at(-1).accent）。表里还没有它（旧后端）时退回「最后一档」
  // ——沿用此前把顶档当 Ultracode 位的做法，过渡期视觉不回退。
  const ULTRA = 'ultracode';
  const accentIdx = $derived.by(() => { const i = efforts.findIndex((e) => e.id === ULTRA); return i >= 0 ? i : N - 1; });
  const accent = $derived(N > 1);

  // 拖动中的高亮档（官方 onValueChange 只改高亮、onValueCommitted 才落值）
  let hlIdx = $state(null);
  const disp = $derived(hlIdx == null ? idx : hlIdx);
  const restPct = $derived(N > 1 ? (disp / (N - 1)) * 100 : 0);
  const topStop = $derived(accent && disp === accentIdx);
  const label = $derived((efforts[disp] || {}).name || '');

  let dragging = $state(false);
  let control = $state(), trackEl = $state(), fillEl = $state(), thumbEl = $state(), railEl = $state(), inputEl = $state(), canvasEl = $state();

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 官方自定义弹性缓动（hse）：400ms linear() 前 48% 完成、尾段驻留
  const HSE = '400ms linear(0, 0.0497, 0.1647, 0.3069, 0.4517, 0.5848, 0.6991, 0.7923, 0.8647, 0.9186, 0.9571, 0.9831, 0.9996, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)';

  function commit(i) {
    const e = efforts[i];
    // 改即记，杀后台不丢；effortAt 让输入栏芯片知道「用户刚改过」——上一轮 Stop hook 回报的
    // 实际生效档位比这个时刻旧就不再盖住用户的新选择（下一轮跑完再更新）。
    if (e && settings.effort !== e.id) { settings.effort = e.id; settings.effortAt = Date.now(); rememberCurrentPrefs(); }
    hlIdx = null;
  }

  // —— 档名交换动画（官方 framer popLayout 逐行对位：0.2s easeOut、±0.55em、blur 2px）——
  let lbDir = $state(1);
  function setDisp(i) {
    if (i === disp) return;
    lbDir = i > disp ? 1 : -1;
    hlIdx = i;
  }
  const lbIn = (n, { d }) => ({ duration: 200, easing: cubicOut, css: (t, u) => `opacity:${t};filter:blur(${(2 * u).toFixed(2)}px);transform:translateY(${(0.55 * u * d).toFixed(3)}em)` });
  const lbOut = (n, { d }) => ({ duration: 200, easing: cubicOut, css: (t, u) => `position:absolute;left:0;top:0;max-width:100%;opacity:${t};filter:blur(${(2 * u).toFixed(2)}px);transform:translateY(${(-0.55 * u * d).toFixed(3)}em)` });

  // —— 拖拽（官方逐行移植：railRect 定位、thumb 抓取偏移、3px 起判、catchUp 100ms cubic-out、
  //    松手 |raw-target|≥0.5px 才播吸附动画）——
  let st = null;   // { railRect, grabOffsetX, downClientX, lastClientX, rafId, moved, catchUp }
  let endCb = null;
  const frac = () => Math.min(Math.max((st.lastClientX - st.grabOffsetX - st.railRect.left) / (st.railRect.width || 1), 0), 1);
  function setTransitions() {
    if (reduced()) { fillEl.style.transition = ''; thumbEl.style.transition = ''; return; }
    fillEl.style.transition = `width ${HSE}`;
    thumbEl.style.transition = `left ${HSE}, background-color 300ms`;
  }
  function clearEndCb() { if (endCb) { thumbEl.removeEventListener('transitionend', endCb); endCb = null; } }
  function down(e) {
    if (N < 2 || e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    clearEndCb();
    setTransitions();
    control.style.removeProperty('--slider-drag-pos');
    const tr = thumbEl.getBoundingClientRect();
    const onThumb = thumbEl.contains(e.target);
    st = { railRect: railEl.getBoundingClientRect(), grabOffsetX: onThumb ? e.clientX - (tr.left + tr.width / 2) : 0,
      downClientX: e.clientX, lastClientX: e.clientX, rafId: 0, moved: false, catchUp: null };
    // 点按（未拖）：目标档即刻成为高亮 → rest-pos 变化经 hse 过渡滑过去（官方 base-ui 同构）
    setDisp(Math.round(frac() * (N - 1)));
  }
  function tick() {
    if (!st || !control || !railEl) return;
    st.rafId = 0;
    st.railRect = railEl.getBoundingClientRect();
    const a = frac();
    let r = a;
    if (st.catchUp) {
      const t = Math.min((performance.now() - st.catchUp.startTime) / 100, 1);
      if (t >= 1) st.catchUp = null;
      else { const n = 1 - (1 - t) ** 3; r = st.catchUp.fromFraction + (a - st.catchUp.fromFraction) * n; }
    }
    control.style.setProperty('--slider-drag-pos', (100 * r) + '%');
    setDisp(Math.round(r * (N - 1)));
    if (st.catchUp && st.rafId === 0) st.rafId = requestAnimationFrame(tick);
  }
  function move(e) {
    if (!st) return;
    st.lastClientX = e.clientX;
    if (e.buttons === 0) { up(); return; }
    if (!st.moved) {
      if (Math.abs(e.clientX - st.downClientX) < 3) return;
      st.moved = true; dragging = true;
      const w = control.getBoundingClientRect().width;
      if (w > 0 && !reduced()) {
        const from = Math.min(Math.max(fillEl.getBoundingClientRect().width / w, 0), 1);
        control.style.setProperty('--slider-drag-pos', (100 * from) + '%');
        st.catchUp = { fromFraction: from, startTime: performance.now() };
      }
      fillEl.style.transition = ''; thumbEl.style.transition = '';
    }
    if (st.rafId === 0) st.rafId = requestAnimationFrame(tick);
  }
  function up() {
    const t = st;
    st = null; dragging = false;
    if (!t || !control || !fillEl || !thumbEl) return;
    if (t.rafId !== 0) cancelAnimationFrame(t.rafId);
    const raw = (() => { st = t; const v = frac(); st = null; return v; })();
    if (!t.moved) {
      // 点按：hse 过渡已在滑，落值 + transitionend 清理
      commit(disp);
      const done = (ev) => { if (ev && ev.propertyName !== 'left') return; clearEndCb(); fillEl.style.transition = ''; thumbEl.style.transition = ''; };
      if (thumbEl.getAnimations().length > 0) { endCb = done; thumbEl.addEventListener('transitionend', done); } else done();
      control.style.removeProperty('--slider-drag-pos');
      return;
    }
    const target = Math.round(raw * (N - 1));
    commit(target);
    const d = N > 1 ? target / (N - 1) : 0;
    if (Math.abs(raw - d) * (t.railRect.width || 1) < 0.5 || reduced()) { control.style.removeProperty('--slider-drag-pos'); return; }
    const done = (ev) => {
      if (ev && ev.propertyName !== 'left') return;
      clearEndCb(); fillEl.style.transition = ''; thumbEl.style.transition = ''; control.style.removeProperty('--slider-drag-pos');
    };
    setTransitions();
    control.style.setProperty('--slider-drag-pos', (100 * d) + '%');
    endCb = done;
    thumbEl.addEventListener('transitionend', done);
  }
  function dotTap(e, i) {
    e.stopPropagation();
    clearEndCb(); setTransitions();
    control.style.removeProperty('--slider-drag-pos');
    setDisp(i); commit(i);
    const done = (ev) => { if (ev && ev.propertyName !== 'left') return; clearEndCb(); fillEl.style.transition = ''; thumbEl.style.transition = ''; };
    endCb = done; thumbEl.addEventListener('transitionend', done);
  }
  // 键盘（隐藏 input）：官方即时落值、无动画
  function onInput() { const i = +inputEl.value; setDisp(i); commit(i); }
  function onKeyEsc(e) { if (e.key === 'Escape') { e.preventDefault(); onClose?.(); } }

  // —— WebGL2 能量场（官方 pse 宿主逐行移植 + shader 原文）——
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
  let energyApi = null;   // { pressStart(k), pressEnd(k) }
  $effect(() => {
    const cnv = canvasEl;
    if (!cnv || !accent) return;
    const gl = cnv.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return;
    const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const prog = gl.createProgram();
    const vs = mk(gl.VERTEX_SHADER, VERT), fs = mk(gl.FRAGMENT_SHADER, FRAG);
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { gl.deleteProgram(prog); return; }
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
    energyApi = {
      pressStart: (e) => {
        if (rm.matches) return;
        refreshColors();
        if (performance.now() - lastBurstWall > 5000 && fade <= 0) { bTimes.fill(-1000); gl.uniform1fv(uBT, bTimes); gl.uniform1f(uSeed, 512 * Math.random()); }
        T = true; hold = 0; E = e;
        emit(gain(e, 0), e);
      },
      pressEnd: (e) => { hiddenHeld = false; if (T) { T = false; E = e; if (!document.hidden) start(); } }
    };
    size(cnv.clientWidth || 1, cnv.clientHeight || 1, devicePixelRatio || 1);
    draw();
    return () => {
      energyApi = null; stopLoop(); ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      gl.deleteProgram(prog); gl.deleteBuffer(buf);
    };
  });

  // 顶档进出 → 能量场常按/冷却（官方 data-top-stop 语义）
  $effect(() => { if (topStop) { energyApi?.pressStart(1); return () => energyApi?.pressEnd(1); } });

  // —— help 悬浮层：200ms 延迟出、离开即收（官方 tooltip Root delay 200）——
  let helpOpen = $state(false);
  let helpT = 0;
  const helpEnter = () => { clearTimeout(helpT); helpT = setTimeout(() => (helpOpen = true), 200); };
  const helpLeave = () => { clearTimeout(helpT); helpOpen = false; };
  // 文案按当前档位给（官方 Nv 读 item.help）：Ultracode 档专属 title/body（官方 ultracodeHelpBody 同款，
  // {effortLabel} 是官方目录里 xhigh 的名字「Extra high」），其余档位一律默认句。bridge 的 efforts 表把 xhigh
  // 缩成「Extra」只是为了输入栏芯片省宽，帮助浮层不受那个约束，整句必须是 "Ultracode is Extra high effort…"。
  const isUltraDisp = $derived((efforts[disp] || {}).id === ULTRA);
  const xhighLabel = 'Extra high';
  const helpTitle = $derived(isUltraDisp ? 'Ultracode' : 'Effort');
  const helpBody = $derived(isUltraDisp
    ? `Ultracode is ${xhighLabel} effort plus workflows. Most thorough, slowest, and heaviest on your limits. Applies to this session only. New sessions start without it.`
    : 'Higher effort means more thorough responses, but takes longer and uses your limits faster.');
</script>

<button class="ef-backdrop" aria-label={tt('关闭')} onclick={() => onClose?.()}></button>
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="ef" class:down={dir === 'down'} role="dialog" aria-label="Effort" onkeydown={onKeyEsc} use:clampX>
  <div class="ef-head">
    <div class="ef-head-l">
      <h2 class="ef-title">Effort</h2>
      <span class="ef-valwrap">
        {#key disp}<span class="ef-val" class:accent={topStop} in:lbIn={{ d: lbDir }} out:lbOut={{ d: lbDir }}>{label}</span>{/key}
      </span>
    </div>
    <button type="button" class="ef-help" aria-label="About effort"
      onpointerenter={helpEnter} onpointerleave={helpLeave} onfocus={helpEnter} onblur={helpLeave}>
      <span class="ef-help-ic" aria-hidden="true">&#xe088;</span>
    </button>
    {#if helpOpen}
      <div class="ef-help-pop" role="tooltip">
        <span class="ef-help-t">{helpTitle}</span>
        <span class="ef-help-b">{helpBody}</span>
      </div>
    {/if}
  </div>
  <div class="ef-sec">
    <div class="ef-ends"><span>Faster</span><span>Smarter</span></div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ef-slider" class:dragging class:topstop={topStop} bind:this={control}
      style:--slider-rest-pos={restPct + '%'}
      onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onlostpointercapture={up}>
      <div class="ef-track" bind:this={trackEl}>
        <span class="ef-fill" bind:this={fillEl}>
          {#if accent}
            <span class="ef-energy-wrap" aria-hidden="true">
              <canvas class="ef-energy" bind:this={canvasEl}></canvas>
            </span>
          {/if}
        </span>
      </div>
      <span class="ef-dots" aria-hidden="true">
        {#each efforts as e, i (e.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span class="ef-dot" class:last={accent && i === accentIdx} style:--ds={35 * (N - 1 - i) + 'ms'} title={e.name}
            onpointerdown={(ev) => dotTap(ev, i)}><span class="ef-dot-hit"></span></span>
        {/each}
      </span>
      <span class="ef-rail" bind:this={railEl}>
        <span class="ef-thumb" bind:this={thumbEl} aria-hidden="true"></span>
        <span class="ef-thumb ef-focusring" aria-hidden="true"></span>
        <input class="ef-input" bind:this={inputEl} type="range" min="0" max={N - 1} step="1" value={disp}
          aria-label="Effort" aria-valuetext={label} oninput={onInput} />
      </span>
    </div>
  </div>
</div>

<style>
  /* ===== 官方 token（claude.ai/code 实测）。bridge 暗=:root 默认，亮=html[data-theme=light] ===== */
  .ef {
    --ef-pop-bg: rgb(44, 44, 42);
    --ef-pop-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08), 0 6px 16px rgba(11, 11, 11, .24);
    --ef-t5: rgba(255, 255, 255, .25);
    --ef-t6: rgba(255, 255, 255, .48);
    --ef-t7: rgba(255, 255, 255, .7);
    --ui-slider-background: rgb(26, 26, 25);
    --ui-slider-fill: rgba(255, 255, 255, .16);
    --ui-slider-handle: rgb(165, 164, 154);
    --ui-slider-handle-energized: rgb(241, 234, 255);
    --ef-thumb-shadow: 0 0 12px rgba(11, 11, 11, .24);
    --extended-purple: rgb(183, 150, 255);
    --extended-20-purple: rgba(183, 150, 255, .2);
    --ui-slider-energy-hot: rgb(183, 150, 255);
    --ui-slider-energy-cool: rgb(255, 255, 255);
    --ui-slider-fill-charged-start: rgb(158, 128, 235);
    --ui-slider-fill-charged-end: rgb(89, 64, 153);
    --ui-slider-energy-tint-blue: transparent;
    --ui-slider-energy-tint-pink: transparent;
    --ui-slider-energy-bed-fill: 0;
    --ui-slider-energy-charge-max: .85;
    --ui-slider-energy-charge-ramp: 1.1;
    --ui-slider-energy-ink-floor: .08;
    --ui-slider-energy-ink-ceil: .85;
    --ui-slider-energy-gain: 1;
    --ui-slider-energy-reveal: 60%;
    --ef-energy-op-k: .86;      /* 暗：opacity clamp 系数与上限（官方 dark 变体） */
    --ef-energy-op-max: 65%;
  }
  :global(html[data-theme="light"]) .ef {
    --ef-pop-bg: #fff;
    --ef-pop-shadow: 0 0 0 1px rgba(11, 11, 11, .06), 0 6px 16px rgba(11, 11, 11, .06);
    --ef-t5: rgba(11, 11, 11, .25);
    --ef-t6: rgba(11, 11, 11, .5);
    --ef-t7: rgba(11, 11, 11, .8);
    --ui-slider-background: rgb(237, 236, 232);
    --ui-slider-fill: rgba(11, 11, 11, .1);
    --ui-slider-handle: #fff;
    --ui-slider-handle-energized: #fff;
    --ef-thumb-shadow: 0 0 0 1px rgba(11, 11, 11, .04), 0 0 12px rgba(11, 11, 11, .06);
    --extended-purple: rgb(142, 107, 217);
    --extended-20-purple: rgba(142, 107, 217, .2);
    --ui-slider-energy-hot: rgb(251, 237, 241);
    --ui-slider-energy-cool: rgb(210, 196, 240);
    --ui-slider-fill-charged-start: rgb(151, 148, 218);
    --ui-slider-fill-charged-end: rgb(157, 107, 191);
    --ui-slider-energy-tint-blue: rgba(191, 215, 243, .28);
    --ui-slider-energy-tint-pink: rgba(240, 188, 204, .28);
    --ui-slider-energy-bed-fill: 1;
    --ui-slider-energy-charge-max: .92;
    --ui-slider-energy-charge-ramp: .5;
    --ui-slider-energy-ink-floor: .28;
    --ui-slider-energy-ink-ceil: 1;
    --ui-slider-energy-gain: 1.18;
    --ui-slider-energy-reveal: 45%;
    --ef-energy-op-k: 1.33;
    --ef-energy-op-max: 100%;
  }

  .ef-backdrop { position: fixed; inset: 0; z-index: 60; }
  /* 卡片：220 / p10 / gap16 / r12（官方 w-[220px] p-p7 gap-[16px] rounded-r8，click 即现无入场动画） */
  .ef {
    position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 61;
    width: 220px; padding: 10px; display: flex; flex-direction: column; gap: 16px;
    background: var(--ef-pop-bg); border-radius: 12px; box-shadow: var(--ef-pop-shadow);
    user-select: none; font-size: 13px; line-height: 18px; font-family: var(--sans);
  }
  .ef.down { bottom: auto; top: calc(100% + 8px); }

  /* 标题行：gap 4（g3）；Effort t6、档名 t7、? t5→hover t7 */
  .ef-head { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 4px; }
  .ef-head-l { display: flex; min-width: 0; align-items: center; gap: 4px; }
  .ef-title { flex: none; font-size: 13px; font-weight: 400; color: var(--ef-t6); }
  .ef-valwrap { position: relative; min-width: 0; display: flex; }
  .ef-val { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--ef-t7); }
  .ef-val.accent { color: var(--extended-purple); font-weight: 500; }
  .ef-help { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 999px; color: var(--ef-t5); cursor: default; outline: none; }
  .ef-help:hover { color: var(--ef-t7); }
  .ef-help-ic { font-family: var(--icons); font-size: 16px; line-height: 1; font-variation-settings: "opsz" 16, "wght" 430; }
  /* 帮助浮层：220px、上方右对齐（官方 side top / align end / sideOffset 18 / alignOffset -10） */
  .ef-help-pop { position: absolute; bottom: calc(100% + 8px); right: -10px; width: 220px; z-index: 5;
    display: flex; flex-direction: column; gap: 2px; padding: 10px;
    background: var(--ef-pop-bg); border-radius: 12px; box-shadow: var(--ef-pop-shadow); }
  .ef-help-t { font-size: 12px; line-height: 15px; font-weight: 500; color: var(--ef-t7); padding-bottom: 2px; }
  .ef-help-b { font-size: 13px; line-height: 18px; color: var(--ef-t6); overflow-wrap: break-word; text-wrap: pretty; }

  /* 滑条区：gap 8（g6）；Faster/Smarter 12px t6 */
  .ef-sec { display: flex; width: 100%; flex-direction: column; gap: 8px; }
  .ef-ends { display: flex; align-items: center; justify-content: space-between; gap: 4px;
    font-size: 12px; line-height: 15px; color: var(--ef-t6); }

  /* control 24 高；track 20 高 r6 上下 margin 2 */
  .ef-slider { position: relative; display: flex; height: 24px; width: 100%; align-items: center; touch-action: none; }
  .ef-slider.dragging { cursor: ew-resize; }
  .ef-track { position: relative; width: 100%; margin: 2px 0; height: calc(100% - 4px); border-radius: 6px;
    overflow: hidden; container-type: inline-size; background: var(--ui-slider-background); }
  .ef-fill { position: absolute; inset: 0 auto 0 0; left: 0; overflow: hidden;
    width: var(--slider-drag-pos, var(--slider-rest-pos)); background: var(--ui-slider-fill); }
  /* 能量层：官方 opacity clamp((pos-25%)*k) + mask 软渐入（reveal 45%/60%）+ mask-size 跟填充 */
  .ef-energy-wrap { pointer-events: none; position: absolute; inset: 0 auto 0 0; width: 100cqw;
    opacity: clamp(0%, calc((var(--slider-drag-pos, var(--slider-rest-pos)) - 25%) * var(--ef-energy-op-k)), var(--ef-energy-op-max));
    mask-image: linear-gradient(to right, transparent 0%, #000 var(--ui-slider-energy-reveal));
    -webkit-mask-image: linear-gradient(to right, transparent 0%, #000 var(--ui-slider-energy-reveal));
    mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
    mask-size: max(calc(var(--slider-drag-pos, var(--slider-rest-pos)) - 8px), 0px) 100%;
    -webkit-mask-size: max(calc(var(--slider-drag-pos, var(--slider-rest-pos)) - 8px), 0px) 100%; }
  .ef { --ef-blend: normal; }
  :global(html:not([data-theme="light"])) .ef .ef-energy-wrap { mix-blend-mode: plus-lighter; }
  .ef-energy { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;
    color: var(--ui-slider-energy-hot); outline-color: var(--ui-slider-energy-cool);
    border-top: 0 none var(--ui-slider-fill-charged-start); border-bottom: 0 none var(--ui-slider-fill-charged-end);
    text-decoration-color: var(--ui-slider-energy-tint-blue); column-rule-color: var(--ui-slider-energy-tint-pink); }

  /* 档位点：3px、px 10 两端、t5（末档紫）、35ms 步进错峰；顶档非拖动隐去；命中区 19×23 */
  .ef-dots { pointer-events: none; position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: space-between; padding: 0 10px; }
  .ef-dot { pointer-events: auto; position: relative; display: flex; width: 3px; height: 3px;
    align-items: center; justify-content: center; border-radius: 999px; background: var(--ef-t5); }
  .ef-dot.last { background: var(--extended-purple); }
  .ef-dot-hit { position: absolute; inset: -10px -8px; }
  @media (prefers-reduced-motion: no-preference) {
    .ef-dot { transition: opacity .3s ease var(--ds, 0ms); }
  }
  .ef-slider.dragging .ef-dot { pointer-events: none; }
  .ef-slider.topstop .ef-dot { pointer-events: none; }
  .ef-slider.topstop:not(.dragging) .ef-dot { opacity: 0; }

  /* 轨内滑轨：两侧内缩半把手（8px）；把手 16×19 r6，背景色 300ms 过渡 */
  .ef-rail { pointer-events: none; position: absolute; top: 0; bottom: 0; left: 8px; right: 8px; }
  .ef-thumb { pointer-events: auto; position: absolute; width: 16px; height: 19px; border-radius: 6px;
    left: var(--slider-drag-pos, var(--slider-rest-pos)); top: 50%; transform: translate(-50%, -50%);
    background: var(--ui-slider-handle); box-shadow: var(--ef-thumb-shadow); cursor: ew-resize; }
  @media (prefers-reduced-motion: no-preference) {
    .ef-thumb { transition: background-color .3s; }
  }
  .ef-slider.topstop .ef-thumb { background: var(--ui-slider-handle-energized); }
  /* 键盘聚焦环：白 2px + 环 4px + 20% 辉光（官方 shadow-focus-slider；顶档换紫） */
  .ef-focusring { pointer-events: none; opacity: 0; background: transparent; cursor: default;
    box-shadow: 0 0 0 2px var(--ef-pop-bg), 0 0 0 4px var(--coral), 0 0 14px 4px color-mix(in srgb, var(--coral) 20%, transparent); }
  .ef-slider:focus-within .ef-focusring { opacity: 1; }
  .ef-slider.topstop .ef-focusring {
    box-shadow: 0 0 0 2px var(--ef-pop-bg), 0 0 0 4px var(--extended-purple), 0 0 14px 4px var(--extended-20-purple); }
  /* 真 input：藏在把手位置承载键盘/读屏（官方 clip 内藏 input 同构） */
  .ef-input { position: absolute; width: 16px; height: 19px; top: 50%;
    left: var(--slider-drag-pos, var(--slider-rest-pos)); transform: translate(-50%, -50%);
    opacity: 0; pointer-events: none; margin: 0; }
</style>
