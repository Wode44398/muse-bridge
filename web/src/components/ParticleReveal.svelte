<script>
  // 粒子凝聚入场层：把【任意静态壁纸】降维成粒子云（照片采样点云，非程序噪声——
  // Shopify Editions Spring'26 同款思路），在白底上以【景深对焦】的方式显影成图，
  // 最后粒子蒸发让位给原图。替代原多洛米蒂手绘线稿转场视频：不再绑死单一壁纸、
  // 任意分辨率/横竖屏通用。
  //
  // ── 核心：显影波（2026-07-28 重做，替代原「溪流凝聚」）──────────────────
  // ① 焦平面依深度图从最近扫到最远，每粒解析求出自己的「合焦时刻」tFoc：前景
  //    （草地/屋舍）先成形，焦点一层层推向树林 → 远山 → 天空。
  // ② 粒子的两态不是「有/无」而是【虚/实】：未合焦＝大而淡的散景光斑，合焦＝
  //    收缩成实心软点。原版缺这段光学过渡，是「生硬」的根源。
  // ③ 结晶与蒸发【也挂在每层自己的 tFoc 上】，没有全场统一的收尾段——已成形的
  //    前景不必干等天空。于是整支动画是一条连续的显影波扫过画面：波前之后已是
  //    成品照片，波前处粒子正活跃，波前之前还是散景云。
  // ④ 落位走临界阻尼弹簧（末端渐近、永不硬停），漂移走解析旋度流场（曲线与涡，
  //    非平移），强度随合焦度收敛到 0。
  // 无深度图时用【垂直伪深度】（画面下方＝近）降级，依旧是一条从下往上的波，
  // 不会退化成「全体同时合焦」。渲染配方沿用 Spring'26：圆软点 + 黄金比 dotNoise
  // 虹彩（收窄到合焦瞬间）+ 稀疏 sparkle。流场为解析式，不跑 GPGPU——手机 WebView 稳。
  //
  // 用法：父层在白幕全遮时挂载（画布不透明白底，顶帧换入无感），遮罩展开前 begin()；
  // onReady=资源就绪可开演；onCondensed=全画面已结晶（可开始撤层交叉）；onDone=溶解完。
  // overscan：撤层后接管的层带放大（空间壁纸 overscan）时传同倍率，终帧硬接不跳。
  import { onMount } from 'svelte';

  // shown=false 时画布隐形但照常挂载/加载/渲染——父层可提前挂上预载资源，白幕全遮后再显形。
  let { imgUrl, depthUrl = null, overscan = 1, speed = 1, shown = true, onReady = null, onCondensed = null, onDone = null } = $props();

  // 调试旋钮（与 Home 的 ?glass= 同风格）：?pr=slow 时间轴放慢 ~3×，逐段检视粒子编排
  const SLOW = typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('pr') === 'slow' ? 0.35 : 1;

  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

  // ── 编排常量（秒 / 倍率，speed=1）──────────────────────────────────────
  // 时间轴不再是「阶段接力」，而是【一条焦平面扫描 + 每层相对它的三拍】：
  //   tFoc（合焦）→ +CRYST_D 照片结晶到实 → +DISS_D 粒子蒸发让位。
  // 调节奏优先改 FOCUS_SPAN（波扫多久）与 DISS_D（波前多厚）。
  const FOCUS0 = 0.28, FOCUS_SPAN = 2.30;   // 焦平面扫描窗
  const SPAWN_SPAN = 1.15;                  // 出生波跨度——【跟父层方块展开对齐】(CSS .82s ÷ speed)，与焦扫无关
  const RAMP = 0.78;                        // 单粒从虚到实的时长
  const CRYST_D = 0.25, CRYST_SPAN = 0.45;  // 合焦后多久、多快结晶到全实
  const DISS_D = 0.60, DISS_SPAN = 0.85;    // 合焦后多久开始蒸发、蒸发多久
  // onCondensed 触发点＝焦扫推进到这个比例、且那一层已结晶。不等天空：撤层交叉的 620ms
  // 里显影波仍在推进，图标就浮现在「还在演的转场」上——维护者要的是这个重叠，不是演完再出。
  const REVEAL_AT = 0.48;
  const BED = 0.85;                         // 合焦即垫上的底图不透明度（填住点缝，别露白）
  // 散景是填充率大户：光斑面积按倍率平方涨。同屏旧版每帧约 2.3× 屏幕像素，散景 2.85×
  // 时飙到 21×——手机上直接掉帧，观感就是「动画速度不对」。手机三档一起降：
  // 倍率降档 + 网格放稀 + 近半粒子的散景压到 0.45×（大小混杂反而更像真实光斑云）。
  const BOKEH = coarse ? 2.10 : 2.85;
  const THIN = coarse ? 1.0 : 0.0;          // 散景稀释开关（见 VERT_P 的 bkMax）
  const GRID_PX = coarse ? 8 : 10;          // 网格间距（CSS px）
  const DIA = 1.95;                         // 点直径 ÷ 网格格距（1.95 恰好咬合成连续色块）
  const PAR = 0.115, TURB = 0.026, CAU = 0.14;

  const T_LAST = FOCUS0 + FOCUS_SPAN;       // 最后一层（天空）合焦时刻
  const TL = {
    spawn: [0.00, SPAWN_SPAN],
    reveal: FOCUS0 + FOCUS_SPAN * REVEAL_AT + CRYST_D + CRYST_SPAN,
    end: T_LAST + DISS_D + DISS_SPAN + 0.33,
  };

  let canvas;
  let gl, progPts, progQuad, texImg, texDep;
  const UP = {}, UQ = {};   // 两套程序的 uniform 句柄
  let quadBuf, ptsBuf, nPts = 0, pointPx = 12, maxPt = 128;
  let imgW = 1, imgH = 1, cover = [1, 1], hasDepth = 0;
  let ready = false, failed = false, began = false, t0 = 0;
  let condensedFired = false, doneFired = false;
  let raf = 0, tMount = 0;

  const VERT_Q = `attribute vec2 aPos; varying vec2 vUv;
    void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  // 底图层：不是整幅一起淡入，而是【跟着焦平面局部显影】——焦点扫到哪一层，照片就在
  // 哪一层垫上（先到 BED 填住点缝，再结晶到全实）。粒子缝里露出的不是白底而是同色
  // 照片，点彩自然「融进」画面；且前景早早就是成品，不必等天空。
  const FRAG_Q = /* i18n-ignore GLSL 着色器源码（注释），不是界面 */ `precision highp float;
    varying vec2 vUv;
    uniform sampler2D uImage, uDepth;
    uniform vec2 uCover;
    uniform float uT, uF0, uFSpan, uRamp, uBed, uCrystD, uCrystSpan, uHasDepth;
    const float PI = 3.14159265;
    float wob(vec2 p){
      return sin(p.x*4.1+1.7)*0.5 + sin(p.y*3.3-0.9)*0.32 + sin((p.x+p.y)*5.7+2.4)*0.18;
    }
    void main(){
      vec2 uv = (vUv - 0.5) * uCover + 0.5;
      vec3 c = texture2D(uImage, uv).rgb;
      vec2 tgt = vec2(vUv.x, 1.0 - vUv.y);              // 对齐粒子的 aTarget 坐标系（y 向下）
      float d = uHasDepth > 0.5 ? texture2D(uDepth, uv).r : (0.10 + 0.90 * tgt.y);
      float u = 1.0 - d;
      float p = clamp((u + 0.12) / 1.24, 0.0, 1.0);
      float xf = acos(clamp(1.0 - 2.0 * p, -1.0, 1.0)) / PI;
      float tFoc = uF0 + xf * uFSpan + wob(tgt * 1.6) * 0.11;
      float a = uBed * smoothstep(0.0, uRamp * 1.15, uT - tFoc + uRamp * 0.30);
      a = max(a, smoothstep(0.0, uCrystSpan, uT - (tFoc + uCrystD)));
      gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
    }`;

  // 顶点：出生（深度主导的渐次浮现）→ 散景光斑沿旋度流场漂移 → 焦平面扫到即收缩合焦
  //       → 结晶后蒸发让位。粒子终态 = 目标位 + 原图色（交叉不可见）。
  const VERT_P = /* i18n-ignore GLSL 着色器源码（注释），不是界面 */ `precision highp float;
    attribute vec2 aTarget; attribute vec3 aColor; attribute vec3 aRnd; attribute float aDepth;
    uniform vec2 uView; uniform float uPointPx, uT, uMaxPt;
    uniform float uF0, uFSpan, uS0, uSSpan, uRamp;
    uniform float uDissD, uDissSpan, uBokeh, uPar, uTurb, uThin;
    varying vec3 vColor; varying float vAlpha, vFocus, vSeed, vPulse; varying vec3 vWorld;
    const float PI = 3.14159265;

    // 低频有机噪声：同一深度层（如整片天空）内也要错峰，否则一大块会「啪」地同时落
    float wob(vec2 p){
      return sin(p.x*4.1+1.7)*0.5 + sin(p.y*3.3-0.9)*0.32 + sin((p.x+p.y)*5.7+2.4)*0.18;
    }
    // 解析旋度流场（两八度，∂ψ 手推）：无散度 → 路径是曲线与涡，不是平移
    vec2 curlFlow(vec2 p, float t){
      float a1 = 3.1, b1 = 2.7;
      float s1 = sin(p.x*a1 + t*0.35), c1 = cos(p.x*a1 + t*0.35);
      float s2 = sin(p.y*b1 - t*0.28), c2 = cos(p.y*b1 - t*0.28);
      vec2 g = vec2(a1*c1*c2, -b1*s1*s2);
      float a2 = 6.3, b2 = 5.1;
      float s3 = sin(p.x*a2 - t*0.21 + 1.7), c3 = cos(p.x*a2 - t*0.21 + 1.7);
      float s4 = sin(p.y*b2 + t*0.33),       c4 = cos(p.y*b2 + t*0.33);
      g += vec2(a2*c3*c4, -b2*s3*s4) * 0.40;
      return vec2(g.y, -g.x);
    }
    // 临界阻尼弹簧（归一化到 [0,1]）：起步柔、末端渐近，没有「到站即停」的折角
    float spring(float x){ float k = 7.0, e = exp(-k*x); return (1.0 - (1.0 + k*x)*e) / 0.9927354; }

    void main(){
      float s1 = aRnd.x, s2 = aRnd.y, s3 = aRnd.z;
      float u = 1.0 - aDepth;                       // 0＝最近 1＝最远

      // ① 合焦时刻：F(t) 以 easeInOutSine 从 -0.12 扫到 1.12（首尾留余量），这里反解出
      //    「焦平面扫到本粒深度」的时刻（acos 正是 easeInOutSine 的反函数）
      float p  = clamp((u + 0.12) / 1.24, 0.0, 1.0);
      float xf = acos(clamp(1.0 - 2.0*p, -1.0, 1.0)) / PI;
      float tFoc = uF0 + xf*uFSpan + wob(aTarget*1.6)*0.11 + (s2 - 0.5)*0.14;
      float g = spring(clamp((uT - (tFoc - uRamp*0.58)) / uRamp, 0.0, 1.0));

      // ② 出生：切比雪夫（方形）波前从中心往外铺——【必须与父层的方块遮罩同构同起点】，
      //    「遮罩推到哪，粒子长到哪」。出生与合焦是两件事：出生管从无到有（跟方块走），
      //    合焦管从虚到实（跟深度走）。把出生也改成深度主导会让方块展开时露出空白，
      //    白块扩散就脱节了。深度在这里只做微调（近的略早）。
      vec2 c = aTarget - 0.5;
      float cheb = max(abs(c.x)*uView.x, abs(c.y)*uView.y) / (0.5*max(uView.x, uView.y));
      float tB = uS0 + (cheb*0.56 + u*0.14 + s1*0.12 + wob(aTarget*2.4 + 3.1)*0.06) * uSSpan;
      float b  = smoothstep(0.0, 0.26, uT - tB);

      // ③ 位置：纵深视差（近景由外收拢、远景自内舒展）＋旋度湍流，随合焦收敛
      float sl = 1.0 - g;
      vec2 pos = aTarget;
      pos += (aTarget - 0.5) * (uPar * sl * (aDepth - 0.44) * 2.0);
      pos += curlFlow(aTarget*3.0 + s3*0.5, uT*0.9) * uTurb * pow(sl, 1.45) * (0.5 + 0.8*u);
      float ph = dot(aTarget, vec2(5.0, 3.4)) + s3*6.283;
      float settleL = smoothstep(0.0, 0.9, uT - tFoc - 0.25);   // 余韵也按本层自己的节拍收
      pos += vec2(sin(uT*0.9 + ph), cos(uT*0.75 + ph*1.3)) * 0.0017 * g * (1.0 - settleL);

      // ④ 蒸发：同样挂在【本粒的合焦时刻】之后，不等全场——此时照片已在它脚下结晶
      //    完毕，粒子只是让位。只轻微散开：脚下已是清晰照片，再胀大就成了盖在照片上
      //    的油渍（波前局部化后这点很显眼）。
      float dd = smoothstep(0.0, 1.0, clamp((uT - (tFoc + uDissD + s1*0.18)) / uDissSpan, 0.0, 1.0));
      pos += vec2(0.0, -0.042) * dd * dd;            // 升腾离位

      vec2 clip = pos * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);

      // ⑤ 尺寸：散景大圆盘 → 锐点；合焦瞬间极克制的呼吸
      float pulse = exp(-pow((uT - tFoc) / max(uRamp*0.42, 0.05), 2.0));
      // 散景稀释（手机）：约 45% 的粒子只散到 0.45×，填充率大降而光斑云依旧成立
      float bkMax = mix(uBokeh, uBokeh*0.45, uThin * step(0.55, s3));
      float bk = mix(bkMax, 1.0, smoothstep(0.0, 0.88, g));
      gl_PointSize = clamp(uPointPx * bk * b * (1.0 + 0.09*pulse) * (1.0 + 0.55*dd), 0.0, uMaxPt);

      // ⑥ 不透明度近似面积守恒：光斑越大越淡，合焦收缩时自然「凝实」
      //    （不能真按 1/面积 压——那样开场是一片看不见的白；2.0× 让光斑仍有存在感）
      float aBok = mix(min(0.88, 2.0*pow(uBokeh, -1.05)), 1.0, smoothstep(0.0, 0.92, g));
      vAlpha = b * aBok * pow(1.0 - dd, 1.5);        // 前段淡得快、末段贴地归零，交接无痕

      // ⑦ 色彩：白幕上先是带色的淡光斑，合焦渐次饱和到原图色（终态必须＝图色）
      vec3 fog = vec3(0.940, 0.955, 0.975);
      vec3 col = mix(fog, aColor, 0.50 + 0.50*smoothstep(0.0, 0.78, g));
      col = mix(col, fog, u * 0.22 * sl);            // 空气透视：远景多一分雾
      col += vec3(0.055, 0.052, 0.046) * pulse;      // 合焦微亮
      vColor = col;
      vFocus = g; vPulse = pulse; vSeed = s2;
      vWorld = vec3(pos * 6.0, aDepth * 2.0);
    }`;

  // 片元：散景圆盘 ↔ 高斯软点 双 profile 插值；黄金比 dotNoise 虹彩收窄到「正在合焦」
  // 的那一瞬（vPulse 窗），散景期不糊成一片。
  const FRAG_P = /* i18n-ignore GLSL 着色器源码（注释），不是界面 */ `precision highp float;
    uniform float uTime, uCaustics;
    varying vec3 vColor; varying float vAlpha, vFocus, vSeed, vPulse; varying vec3 vWorld;
    float dotNoise(vec3 p) {
      const float PHI = 1.618033988;
      const mat3 GOLD = mat3(
        -0.571464913, 0.814921382, 0.096597072,
        -0.278044873, -0.303026659, 0.911518454,
        0.772087367, 0.494042493, 0.399753815);
      return dot(cos(GOLD * p), sin(PHI * p * GOLD));
    }
    void main(){
      vec2 uv = gl_PointCoord - 0.5;
      float r2 = dot(uv, uv);
      if (r2 > 0.25) discard;
      float r = sqrt(r2) * 2.0;
      float disk = smoothstep(1.0, 0.58, r) * (0.80 + 0.34*smoothstep(0.48, 0.97, r));
      float pt   = smoothstep(1.0, 0.52, r);        // 合焦点＝大实心+短软边，相邻点才融成连续色块
      float shape = mix(disk, pt, smoothstep(0.10, 0.80, vFocus));
      vec3 color = vColor;
      float ca = uCaustics * vPulse;
      if (ca > 0.002) {
        vec3 d = uTime * vec3(0.10, 0.08, 0.12);
        float n1 = dotNoise(vWorld + d);
        float n2 = dotNoise(vWorld * 1.73 + vec3(-d.y, d.z, -d.x));
        float n3 = dotNoise(vWorld * 3.11 + vec3(d.z, -d.x, d.y));
        float ridges = max(0.0, 1.0 - min(min(abs(n1), abs(n2)), abs(n3)) * 1.7);
        color += vec3(1.0, 0.96, 0.88) * pow(clamp(ridges, 0.0, 1.0), 1.6) * ca;
        float sparse = smoothstep(0.986, 1.0, vSeed);   // 只有 1.4% 稀疏点闪
        if (sparse > 0.0) {
          float tw = 0.5 + 0.5*sin(uTime * mix(4.0, 11.0, vSeed) + vSeed*37.699112);
          color += vec3(1.0) * sparse * pow(smoothstep(0.7, 1.0, tw), 3.0)
                 * smoothstep(0.18, 0.0, r2) * ca * 3.0;
        }
      }
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), vAlpha * shape);
    }`;

  function compile(type, src) {
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  function mkProg(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  function mkTex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255]));
    return t;
  }
  function initGL() {
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false });
      if (!gl) return false;
      progQuad = mkProg(VERT_Q, FRAG_Q);
      progPts = mkProg(VERT_P, FRAG_P);
      ['uImage', 'uDepth', 'uCover', 'uT', 'uF0', 'uFSpan', 'uRamp', 'uBed', 'uCrystD', 'uCrystSpan', 'uHasDepth']
        .forEach((n) => UQ[n] = gl.getUniformLocation(progQuad, n));
      ['uView', 'uPointPx', 'uT', 'uMaxPt', 'uF0', 'uFSpan', 'uS0', 'uSSpan', 'uRamp',
       'uDissD', 'uDissSpan', 'uBokeh', 'uPar', 'uTurb', 'uTime', 'uCaustics', 'uThin']
        .forEach((n) => UP[n] = gl.getUniformLocation(progPts, n));
      quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      texImg = mkTex(); texDep = mkTex();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(1, 1, 1, 1);
      const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
      maxPt = Math.min(range ? range[1] : 64, 220);
      return true;
    } catch { return false; }
  }

  function loadImg(src) {
    return new Promise((res, rej) => {
      const im = new Image();   // 同源壁纸，无需 crossOrigin（设了反而在部分环境触发加载失败）
      im.onload = () => res(im); im.onerror = rej; im.src = src;
    });
  }

  // cover 采样映射（与 CSS object-fit:cover / SpatialLayer 同式）：可视源区比例 = [sx,sy]/overscan
  function coverFrac(iw, ih, cw, ch) {
    const ca = cw / ch, ia = iw / ih;
    let sx = 1, sy = 1;
    if (ca > ia) sy = ia / ca; else sx = ca / ia;
    return [sx / overscan, sy / overscan];
  }

  // 照片降维成点云：按屏幕间距铺网格（手机 7px / 桌面 10px CSS，封顶 2.4 万粒），每格
  // 从 cover 映射后的原图取色/取深度，目标位加随机抖动去网格感。
  function buildCloud(img, dimg) {
    const [W, H] = cssSize();   // 与 resize 同一基准，点云取色的 cover 才和底图 quad 对得上
    let sp = GRID_PX;
    let gw = Math.ceil(W / sp), gh = Math.ceil(H / sp);
    const CAP = 24000;
    if (gw * gh > CAP) { const k = Math.sqrt((gw * gh) / CAP); gw = Math.floor(gw / k); gh = Math.floor(gh / k); }
    const cnv = document.createElement('canvas');
    cnv.width = gw; cnv.height = gh;
    const cx = cnv.getContext('2d', { willReadFrequently: true });
    const [fx, fy] = coverFrac(img.naturalWidth, img.naturalHeight, W, H);
    const sw = img.naturalWidth * fx, sh = img.naturalHeight * fy;
    cx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, gw, gh);
    const px = cx.getImageData(0, 0, gw, gh).data;
    let dpx = null;
    if (dimg) {   // 深度图与原图同构图（后端由原图生成），走同一 cover 框
      const dw = dimg.naturalWidth * fx, dh = dimg.naturalHeight * fy;
      cx.drawImage(dimg, (dimg.naturalWidth - dw) / 2, (dimg.naturalHeight - dh) / 2, dw, dh, 0, 0, gw, gh);
      dpx = cx.getImageData(0, 0, gw, gh).data;
    }
    nPts = gw * gh;
    const buf = new Float32Array(nPts * 9);   // [tx,ty, r,g,b, s1,s2,s3, depth]
    let o = 0;
    for (let j = 0; j < gh; j++) {
      // 无深度图时的【垂直伪深度】：画面下方＝近。必须与 FRAG_Q 里同式，否则底图显影
      // 与粒子合焦会错层。有它兜着，未空间化的上传壁纸也是一条从下往上的波，不会退化
      // 成「全体同时合焦」那种更生硬的观感。
      const pseudo = 0.10 + 0.90 * ((j + 0.5) / gh);
      for (let i = 0; i < gw; i++) {
        const k = (j * gw + i) * 4;
        buf[o++] = (i + 0.5 + 0.86 * (Math.random() - 0.5)) / gw;   // ±0.43 格抖动：打散行列网格感
        buf[o++] = (j + 0.5 + 0.86 * (Math.random() - 0.5)) / gh;
        buf[o++] = px[k] / 255; buf[o++] = px[k + 1] / 255; buf[o++] = px[k + 2] / 255;
        buf[o++] = Math.random(); buf[o++] = Math.random(); buf[o++] = Math.random();
        buf[o++] = dpx ? dpx[k] / 255 : pseudo;   // 白=近 黑=远（Depth Anything V2 约定）
      }
    }
    ptsBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ptsBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // DIA 是「点直径 ÷ 网格格距」——1.95 时实心部分(0.52×)恰好铺满格距并互相咬合
    pointPx = Math.min((W / gw) * dpr * DIA, maxPt);
  }

  // 画布的 CSS 尺寸是 100vw × 100dvh；drawing buffer 必须按【元素实测尺寸】算，不能用
  // window.innerWidth/innerHeight——Android 带系统栏时 innerHeight ≠ 100dvh，buffer 偏小
  // 会被 CSS 拉伸，画面比 Home 的 <img object-fit:cover> 放大约 10%，撤层瞬间「跳」一下
  // （2026-07-28 真机录屏实锅：#65→#66 一帧之内整幅缩放，正好撞上图标浮现）。
  // 兜底 innerWidth/innerHeight 只为父层 display:none 时 rect 归零的情况。
  function cssSize() {
    const r = canvas.getBoundingClientRect();
    return [Math.max(1, r.width || window.innerWidth), Math.max(1, r.height || window.innerHeight)];
  }
  function resize() {
    if (!gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const [cw, ch] = cssSize();
    const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
    cover = coverFrac(imgW, imgH, canvas.width, canvas.height);
  }

  async function load() {
    try {
      const [im, dp] = await Promise.all([loadImg(imgUrl), depthUrl ? loadImg(depthUrl).catch(() => null) : null]);
      imgW = im.naturalWidth; imgH = im.naturalHeight;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, texImg);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, im);
      if (dp) {
        gl.bindTexture(gl.TEXTURE_2D, texDep);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, dp);
        hasDepth = 1;
      }
      buildCloud(im, dp);
      resize();
      ready = true;
    } catch { failed = true; }   // 加载失败：保持白底，走「白幕展开→撤层」的干净降级
    onReady?.();
  }

  const seg = (t, [a, b]) => Math.min(1, Math.max(0, (t - a) / (b - a)));

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!gl) return;
    const tGlobal = (now - tMount) / 1000;
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!ready || !began) return;   // 白底待命（父层白幕下顶帧换入无感）
    if (!t0) t0 = now;              // 时间轴锚在「已 begin 且资源就绪」的首帧：加载慢也不跳过出生波
    const t = ((now - t0) / 1000) * speed * SLOW;

    // 原图层（画在粒子底下，随焦平面局部显影 → 结晶；粒子终态色=图色，交叉不可见）
    gl.useProgram(progQuad);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    const aPos = gl.getAttribLocation(progQuad, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texImg);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texDep);
    gl.uniform1i(UQ.uImage, 0);
    gl.uniform1i(UQ.uDepth, 1);
    gl.uniform2f(UQ.uCover, cover[0], cover[1]);
    gl.uniform1f(UQ.uT, t);
    gl.uniform1f(UQ.uF0, FOCUS0);
    gl.uniform1f(UQ.uFSpan, FOCUS_SPAN);
    gl.uniform1f(UQ.uRamp, RAMP);
    gl.uniform1f(UQ.uBed, BED);
    gl.uniform1f(UQ.uCrystD, CRYST_D);
    gl.uniform1f(UQ.uCrystSpan, CRYST_SPAN);
    gl.uniform1f(UQ.uHasDepth, hasDepth);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 粒子层
    if (nPts) {
      gl.useProgram(progPts);
      gl.bindBuffer(gl.ARRAY_BUFFER, ptsBuf);
      const S = 36;   // 9 floats
      const at = gl.getAttribLocation(progPts, 'aTarget');
      const ac = gl.getAttribLocation(progPts, 'aColor');
      const ar = gl.getAttribLocation(progPts, 'aRnd');
      const ad = gl.getAttribLocation(progPts, 'aDepth');
      gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, S, 0);
      gl.enableVertexAttribArray(ac); gl.vertexAttribPointer(ac, 3, gl.FLOAT, false, S, 8);
      gl.enableVertexAttribArray(ar); gl.vertexAttribPointer(ar, 3, gl.FLOAT, false, S, 20);
      gl.enableVertexAttribArray(ad); gl.vertexAttribPointer(ad, 1, gl.FLOAT, false, S, 32);
      gl.uniform2f(UP.uView, canvas.width, canvas.height);
      gl.uniform1f(UP.uPointPx, pointPx);
      gl.uniform1f(UP.uMaxPt, maxPt);
      gl.uniform1f(UP.uTime, tGlobal);
      gl.uniform1f(UP.uT, t);
      gl.uniform1f(UP.uF0, FOCUS0);
      gl.uniform1f(UP.uFSpan, FOCUS_SPAN);
      gl.uniform1f(UP.uS0, TL.spawn[0]);
      gl.uniform1f(UP.uSSpan, TL.spawn[1] - TL.spawn[0]);
      gl.uniform1f(UP.uRamp, RAMP);
      gl.uniform1f(UP.uDissD, DISS_D);
      gl.uniform1f(UP.uDissSpan, DISS_SPAN);
      gl.uniform1f(UP.uBokeh, BOKEH);
      gl.uniform1f(UP.uThin, THIN);
      gl.uniform1f(UP.uPar, PAR);
      gl.uniform1f(UP.uTurb, TURB);
      gl.uniform1f(UP.uCaustics, CAU);   // 虹彩窗已按每粒 vPulse 局部化，无需全局收
      gl.drawArrays(gl.POINTS, 0, nPts);
    }

    if (!condensedFired && t >= TL.reveal) {
      condensedFired = true;
      onCondensed?.();
      // 手机端：交出画面后立刻停渲染，把 GPU 全让给同一刻开跑的图标浮现 / 玻璃折射鼓包 /
      // 整层淡出（真机上这三件事撞粒子层会冻帧）。本层正在淡出，定格最后一帧观感无损；
      // 桌面端 GPU 富余，继续把显影波演完。父层只用 onCondensed 收尾，不依赖 onDone。
      if (coarse) { cancelAnimationFrame(raf); raf = 0; return; }
    }
    if (!doneFired && t >= TL.end) {
      doneFired = true; onDone?.();
      cancelAnimationFrame(raf); raf = 0;   // 终帧=纯壁纸原图，冻结（父层随后撤走）
    }
  }

  // 开演（父层在遮罩展开前调；幂等）。资源未就绪/GL 不可用时立即视作凝聚完成，
  // 让父层按「白幕展开→撤层露 Home」干净降级，绝不卡幕。
  export function begin() {
    if (began) return;
    began = true;
    if (failed || !gl) { condensedFired = true; onCondensed?.(); doneFired = true; onDone?.(); }
  }

  onMount(() => {
    if (!initGL()) { failed = true; onReady?.(); return; }
    resize();
    load();
    const onR = () => resize();
    window.addEventListener('resize', onR);
    tMount = performance.now();
    raf = requestAnimationFrame(frame);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onR);
    };
  });
</script>

<canvas bind:this={canvas} class="pr" class:hide={!shown}></canvas>

<style>
  /* 不透明白底：GL 挂掉时元素本身也是白（降级=纯白幕），与父层白幕顶帧互换无感 */
  .pr { position: fixed; top: 0; left: 0; width: 100vw; height: 100dvh; display: block;
        background: #fff; pointer-events: none; }
  .pr.hide { visibility: hidden; }   /* 预载期隐形（仍在渲染，显形即有画面） */
</style>
