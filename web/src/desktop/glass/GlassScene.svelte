<script>
  // 引擎甲：WebGL 统一玻璃合成器（批2）。
  // 壁纸与所有玻璃件渲进同一个 GL 场景：真透镜折射（圆透镜剖面，边缘吸入外侧景物+全域微放大）、
  // 菲涅尔边缘增亮、定向高光、RGB 色散、泊松磨砂、柔影、内侧发丝描边、去带噪。
  // 彻底绕开「同屏 backdrop-filter 数量」限制——玻璃件数量只受 draw call 约束。
  // 用法（批4 主页 / 画廊）：
  //   <GlassScene src="/assets/wallpapers/ridges.jpg" getPanes={() => panes} />
  //   panes: [{ x,y,w,h, radius,bevel,refract,disp,frost,glow,tint:[r,g,b,a] }]（canvas 内 css px）
  //   动态源传 source=<canvas|video>（每帧上传纹理）；玻璃上的文字/图标是普通 DOM，叠在本组件之上。
  import { onMount } from 'svelte';
  import { frameLevel, LOW_FRAME_MS } from './attention.js';

  // onlost：GL 上下文丢失（GPU 进程崩溃/重启、驱动重置）。丢了的画布不会自愈、只剩一块白，
  // 由父级换一张新画布重建（DesktopHome 的 gpuEpoch）。
  let { src = '', source = null, getPanes = () => [], fallback = '#141413', onlost = null } = $props();

  let canvas = $state();
  let loadSrc = null, loadedSrc = '';   // onMount 里建好 GL 后挂上；下方 $effect 跟 src 换图

  const VS = `#version 300 es
  layout(location=0) in vec2 aPos;
  uniform vec2 uRes; uniform vec4 uQuad;
  out vec2 vPx;
  void main(){
    vec2 px = uQuad.xy + aPos * uQuad.zw;
    vPx = px;
    vec2 c = px / uRes * 2.0 - 1.0;
    gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  }`;

  const FS_BG = `#version 300 es
  precision highp float;
  uniform sampler2D uTex; uniform vec2 uRes; uniform vec2 uTexSize;
  in vec2 vPx; out vec4 o;
  void main(){
    float s = max(uRes.x/uTexSize.x, uRes.y/uTexSize.y);
    vec2 sz = uTexSize*s; vec2 off = (uRes-sz)*0.5;
    o = vec4(texture(uTex, clamp((vPx-off)/sz, 0.0, 1.0)).rgb, 1.0);
  }`;

  const FS_PANE = /* i18n-ignore GLSL 着色器源码（注释），不是界面 */ `#version 300 es
  precision highp float;
  uniform sampler2D uTex; uniform vec2 uRes; uniform vec2 uTexSize;
  uniform vec4 uRect; uniform float uRad; uniform float uBevel;
  uniform float uRefract; uniform float uDisp; uniform float uFrost; uniform float uGlow;
  uniform float uSat; uniform float uLift; uniform float uSheen; uniform float uZoom; uniform float uDispBand;
  uniform float uLens;   // 1=真圆穹顶剖面(小件/球) 0=平顶宽弯折带(长条/面板)
  uniform vec4 uTint;
  in vec2 vPx; out vec4 o;

  vec3 bg(vec2 px){
    float s = max(uRes.x/uTexSize.x, uRes.y/uTexSize.y);
    vec2 sz = uTexSize*s; vec2 off = (uRes-sz)*0.5;
    return texture(uTex, clamp((px-off)/sz, 0.001, 0.999)).rgb;
  }
  float sdRR(vec2 p, vec2 b, float r){
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main(){
    vec2 c = uRect.xy + uRect.zw * 0.5;
    vec2 hb = uRect.zw * 0.5;
    float r = min(uRad, min(hb.x, hb.y));
    vec2 p = vPx - c;
    float d = sdRR(p, hb, r);

    // 双层柔影（近实+远柔，向下垂 5px）——始终算，供边缘 AA 混合。
    // exp 永不归零：必须在绘制配额（quad 外沿）之前 smoothstep 压到 0，
    // 否则配额边界一刀切回原背景=玻璃件背后跟着一圈发黑方框。
    float dsh = sdRR(p - vec2(0.0, 5.0), hb, r);
    float win = 1.0 - smoothstep(6.0, 27.0, dsh);
    float sh = (exp(-max(dsh, 0.0) / 22.0) * 0.18 + exp(-max(dsh, 0.0) / 7.0) * 0.15) * win;
    vec3 shCol = bg(vPx) * (1.0 - sh);
    if (d > 1.0) { o = vec4(shCol, 1.0); return; }

    // SDF 梯度（指向外）
    float e = 1.0;
    vec2 g = normalize(vec2(
      sdRR(p + vec2(e, 0.), hb, r) - sdRR(p - vec2(e, 0.), hb, r),
      sdRR(p + vec2(0., e), hb, r) - sdRR(p - vec2(0., e), hb, r)) + 1e-5);

    // 两种剖面（维护者验收定案）：
    //   lens=真圆穹顶——SDF 归一化距离 x 代入 x/√(1-x²)，曲率从中心到边缘连续单调
    //   （窄 bevel 套在球上=「切掉一面打磨光滑」的生硬感，穹顶必须覆盖整个半径）；
    //   band=平顶宽弯折带（smootherstep）——长条/面板中心平整、只在边带弯折。
    float bev = uLens > 0.5 ? min(hb.x, hb.y) : uBevel;
    float t = clamp(-d / bev, 0.0, 1.0);      // 0=边缘 1=内部
    float edge = 1.0 - t;
    float s;                                   // 弯折参与度（磨砂强化/色散用）
    float mag;
    if (uLens > 0.5) {
      float xx = min(edge, 0.985);
      mag = min(xx / sqrt(1.0 - xx * xx), 3.0) * uRefract * 0.5;
      s = edge * edge;
    } else {
      s = edge * edge * edge * (edge * (edge * 6.0 - 15.0) + 10.0);
      mag = s * uRefract;
    }

    // 采样位移：可选全域微放大（uZoom，小圆件用；长条=0 内部纹丝不动）+ 弯折带向外抓取
    vec2 basePx = c + p / (1.0 + uZoom) + g * mag;

    // 磨砂：双环定分布泊松采样；弯折带内强制 ≥1.5px 扩散——既消带内锯齿颗粒，
    // 也符合苹果「弯折带略微漫射」的介质感
    vec3 col = vec3(0.0);
    float fr = max(uFrost, s * 1.5);
    // 色散只在弯折带最外段出现（uDispBand=参与色散的边带占比）
    float ds = mag * uDisp * 0.22 * smoothstep(1.0 - uDispBand, 1.0, edge);
    for (int i = 0; i < 8; i++) {
      float ring = i < 5 ? 1.0 : 0.55;
      float a = i < 5 ? 1.2566 * float(i) : 2.0944 * float(i) + 0.39;
      vec2 sp = basePx + vec2(cos(a), sin(a)) * fr * ring;
      col += vec3(bg(sp + g * ds).r, bg(sp).g, bg(sp - g * ds).b);
    }
    col /= 8.0;

    // 厚介质：饱和度提升 + 内部提亮（苹果玻璃内部隔着介质，不是生背景直出）
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, uSat);
    col += uLift * t;

    // 菲涅尔边缘增亮 + 左上定向高光 + 对角微暗（体积感）
    float fres = pow(edge, 2.8);
    vec2 L = normalize(vec2(-0.62, -0.79));
    float spec = pow(max(dot(g, L), 0.0), 6.0) * pow(edge, 1.6);
    float dark = pow(max(dot(g, -L), 0.0), 4.0) * pow(edge, 2.0);
    col += (fres * 0.08 + spec * 0.42 - dark * 0.08) * uGlow;

    // 双层边光：粗亮 rim（原版的环是均匀的——方向性只留一点点提味）+ 内侧柔亮带
    float hair = smoothstep(2.6, 0.6, abs(d + 1.3));
    float dirw = 0.75 + 0.4 * max(dot(g, L), 0.0);
    col += hair * 0.38 * uGlow * dirw;
    col -= hair * 0.06 * uGlow * max(dot(g, -L), 0.0);
    float band = smoothstep(6.0, 2.0, -d) * smoothstep(0.4, 2.0, -d);
    col += band * 0.05 * uGlow * dirw;

    // 低频斜向 sheen（45° 大面积柔光扫过，screen 感的加法近似）
    vec2 rel = (vPx - uRect.xy) / uRect.zw;
    float sheen = pow(1.0 - clamp((rel.x + rel.y * 1.4) / 2.4, 0.0, 1.0), 2.0);
    col += uSheen * sheen * uGlow;

    // 着色（越靠内越足）
    col = mix(col, uTint.rgb, uTint.a * t);

    o = vec4(mix(col, shCol, smoothstep(-0.8, 0.8, d)), 1.0);
  }`;

  onMount(() => {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) { canvas.style.background = fallback; onlost?.(); return () => {}; }
    let disposed = false;
    const onLost = () => { if (!disposed) onlost?.(); };
    canvas.addEventListener('webglcontextlost', onLost);

    function compile(type, srcCode) {
      const s = gl.createShader(type);
      gl.shaderSource(s, srcCode); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('glass shader: ' + gl.getShaderInfoLog(s));
      return s;
    }
    function program(fs) {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('glass link: ' + gl.getProgramInfoLog(p));
      return p;
    }
    const pBg = program(FS_BG), pPane = program(FS_PANE);
    const U = (p, n) => gl.getUniformLocation(p, n);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    let texW = 0, texH = 0, ready = false;
    const dynamic = () => Boolean(source);
    // src 会变（静态壁纸换静态壁纸时组件不重建）：新图加载完才换纹理，旧图撑到那一刻不闪；
    // 加载期间又切了就丢弃。之前只在挂载时读一次 src → 换壁纸只有 Dock 那块（FigmaGlassDock 自己响应 src）变了
    loadSrc = (url) => {
      if (!url) return;
      const img = new Image();
      img.onload = () => {
        if (disposed || url !== loadedSrc) return;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        texW = img.naturalWidth; texH = img.naturalHeight; ready = true; dirty = true;
      };
      loadedSrc = url;
      img.src = url;
    };
    loadSrc(src);

    let cssW = 0, cssH = 0, dirty = true, lastHash = '';
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cssW = canvas.clientWidth; cssH = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      // 改 width/height 会当场清空画布；等下一帧 RAF 再画，拖窗口时每次尺寸变化都闪一帧黑 → 同步补画
      dirty = true; render();
    });
    ro.observe(canvas);

    let raf = 0, lastTs = 0;
    // 窗口失焦 / 不可见超过 5 秒降帧（attention.js）：动态源每帧都要重传纹理，挂在后台也满帧跑 GPU 不值；
    // 改尺寸走 ResizeObserver 直接 render()，不受这里限速
    function frame(ts) {
      raf = requestAnimationFrame(frame);
      const lv = frameLevel();
      if (lv === 'off' || (lv === 'low' && ts - lastTs < LOW_FRAME_MS)) return;
      lastTs = ts;
      render();
    }
    function render() {
      if (!cssW || !cssH) return;
      if (dynamic() && source.width) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        texW = source.width; texH = source.height; ready = true; dirty = true;
      }
      if (!ready) return;
      const panes = getPanes() || [];
      const hash = panes.map((q) => `${q.x},${q.y},${q.w},${q.h},${q.refract},${q.disp},${q.frost},${q.frostRel},${q.glow},${q.radius},${q.bevel},${q.sat},${q.lift},${q.sheen},${q.zoom},${q.dispBand},${q.lens ? 1 : 0}`).join('|');
      if (!dirty && hash === lastHash) return;   // 静态场景不空转 GPU
      lastHash = hash; dirty = false;

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(pBg);
      gl.uniform2f(U(pBg, 'uRes'), cssW, cssH);
      gl.uniform4f(U(pBg, 'uQuad'), 0, 0, cssW, cssH);
      gl.uniform2f(U(pBg, 'uTexSize'), texW, texH);
      gl.uniform1i(U(pBg, 'uTex'), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.useProgram(pPane);
      gl.uniform2f(U(pPane, 'uRes'), cssW, cssH);
      gl.uniform2f(U(pPane, 'uTexSize'), texW, texH);
      gl.uniform1i(U(pPane, 'uTex'), 0);
      const M = 34;   // 柔影外沿
      for (const q of panes) {
        gl.uniform4f(U(pPane, 'uQuad'), q.x - M, q.y - M, q.w + M * 2, q.h + M * 2);
        gl.uniform4f(U(pPane, 'uRect'), q.x, q.y, q.w, q.h);
        gl.uniform1f(U(pPane, 'uRad'), q.radius ?? 22);
        gl.uniform1f(U(pPane, 'uBevel'), q.bevel ?? 20);
        gl.uniform1f(U(pPane, 'uRefract'), q.refract ?? 26);
        gl.uniform1f(U(pPane, 'uDisp'), q.disp ?? 0.3);
        // frostRel=原版语义（磨砂随件尺寸缩放，blur=短边×比例）；缺省回落绝对 px
        gl.uniform1f(U(pPane, 'uFrost'), q.frostRel ? q.frostRel * Math.min(q.w, q.h) : (q.frost ?? 0));
        gl.uniform1f(U(pPane, 'uGlow'), q.glow ?? 0.6);
        gl.uniform1f(U(pPane, 'uSat'), q.sat ?? 1.0);
        gl.uniform1f(U(pPane, 'uLift'), q.lift ?? 0.0);
        gl.uniform1f(U(pPane, 'uSheen'), q.sheen ?? 0.0);
        gl.uniform1f(U(pPane, 'uZoom'), q.zoom ?? 0.035);
        gl.uniform1f(U(pPane, 'uDispBand'), q.dispBand ?? 1.0);
        gl.uniform1f(U(pPane, 'uLens'), q.lens ? 1.0 : 0.0);
        const t = q.tint || [1, 1, 1, 0.05];
        gl.uniform4f(U(pPane, 'uTint'), t[0], t[1], t[2], t[3]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;   // 下面主动 loseContext 也会派发 webglcontextlost，别当成崩溃
      loadSrc = null;
      canvas.removeEventListener('webglcontextlost', onLost);
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  });
  $effect(() => { const u = src; if (loadSrc && u !== loadedSrc) loadSrc(u); });
</script>

<canvas bind:this={canvas} class="gs" aria-hidden="true"></canvas>

<style>
  .gs { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
</style>
