<script>
  // iOS WebGL 折射层（方案 B）：替代 SVG backdrop-filter（iOS WebKit 不支持引用 SVG 滤镜）。
  // 全屏 canvas 把背景图按 cover 铺满 + 在 rects(玻璃位置) 上做凸透镜放大折射 + 7 档连续光谱色散。
  // 算法 1:1 来自验证过的 demo：向内放大、线性剖面、折射区拉高 mip 抗碎彩；纹理转 POT + mipmap 三线性。
  // rects 由父组件测量入口 DOM 传入（CSS px：{x,y,w,h,r}），本组件转 device px 喂给 shader。
  // strength(0→1)：折射/色散整体强度，入场时从 0 拉到 1 做「鼓包」浮现（0=背景全平、1=预设）。
  import { onMount } from 'svelte';

  let { bgUrl, rects = [], onReady, strength = 1 } = $props();

  let canvas;
  let raf = 0, gl, prog, tex, uR, uRe, uRR, uN, uTex, uTexSize, uStr;
  let texSize = [2048, 1536];
  const glassRects = new Float32Array(20), glassRR = new Float32Array(5);
  let glassN = 0, DPR = 1;

  const VS = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS = /* i18n-ignore GLSL 着色器源码（注释），不是界面 */ `precision highp float;
uniform vec2  R;
uniform vec2  texSize;
uniform sampler2D tex;
uniform vec4  rects[5];
uniform float rrad[5];
uniform int   N;
uniform float uStr;
vec3 bgL(vec2 px, float lod){
  float scale = max(R.x / texSize.x, R.y / texSize.y);
  vec2 disp = texSize * scale;
  vec2 uv = (px + (disp - R) * 0.5) / disp;
  return texture2D(tex, uv, lod).rgb;
}
vec3 bg(vec2 px){ return bgL(px, 0.0); }
float rrSDF(vec2 p, vec2 h, float r){ vec2 q = abs(p) - h + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main(){
  vec2 uvpx = vec2(gl_FragCoord.x, R.y - gl_FragCoord.y);
  vec3 col = bg(uvpx);
  for(int i = 0; i < 5; i++){
    if(i >= N) break;
    vec2 c = rects[i].xy; vec2 h = rects[i].zw; float r = rrad[i];
    vec2 dd = uvpx - c;
    float sd = rrSDF(dd, h, r);
    if(sd < 1.5){
      float bevel = min(h.x, h.y) * 0.42;
      float ctr  = clamp(-sd / bevel, 0.0, 1.0);
      float edge = 1.0 - ctr;
      vec2 e2 = vec2(1.5, 0.0);
      vec2 grad = normalize(vec2(
        rrSDF(dd + e2.xy, h, r) - rrSDF(dd - e2.xy, h, r),
        rrSDF(dd + e2.yx, h, r) - rrSDF(dd - e2.yx, h, r)) + 1e-6);
      float gsz = min(h.x, h.y);
      float lens = edge;
      vec2 dir = -grad;
      // strength 缩放折射位移/色散/折射区模糊/边缘亮：0 时全平无折射，1 时预设（鼓包动画）。
      float base = lens * gsz * 0.20 * uStr;
      float ab   = lens * gsz * 0.055 * uStr;
      float lod  = edge * 2.6 * uStr;
      vec3 refr = vec3(0.0), wsum = vec3(0.0);
      for(int s = 0; s < 7; s++){
        float f = float(s) / 6.0;
        vec2 p = uvpx + dir * (base + (f - 0.5) * 2.0 * ab);
        vec3 w = vec3(smoothstep(0.55, 0.0, f), 1.0 - abs(f - 0.5) * 2.0, smoothstep(0.45, 1.0, f));
        refr += bgL(p, lod).rgb * w;
        wsum += w;
      }
      refr /= max(wsum, vec3(0.001));
      refr += ctr * vec3(0.012) * uStr;
      float rim = smoothstep(0.86, 1.0, edge);
      refr += rim * vec3(0.10, 0.11, 0.13) * uStr;
      float m = clamp(0.5 - sd * 0.5, 0.0, 1.0);
      col = mix(col, refr, m);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

  function compile(type, src){
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function initGL(){
    gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if(!gl) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const pl = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl, 2, gl.FLOAT, false, 0, 0);
    uR = gl.getUniformLocation(prog, 'R'); uRe = gl.getUniformLocation(prog, 'rects');
    uRR = gl.getUniformLocation(prog, 'rrad'); uN = gl.getUniformLocation(prog, 'N');
    uTex = gl.getUniformLocation(prog, 'tex'); uTexSize = gl.getUniformLocation(prog, 'texSize');
    uStr = gl.getUniformLocation(prog, 'uStr');
    tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([26,34,48]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return true;
  }

  function loadTexture(url){
    const img = new Image();
    // 先等解码完再画：WebKit 对大图（多洛米蒂 3992×3000）是 onload 先到、解码还在后台，这时
    // drawImage 什么也画不上，传进 GPU 的是一张全透明纹理，整屏折射层就是纯黑
    //（WebKit 实测约一半概率，GL 不报任何错）。
    img.onload = () => (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(() => {
      const POT = 2048;
      const cn = document.createElement('canvas'); cn.width = POT; cn.height = POT;
      cn.getContext('2d').drawImage(img, 0, 0, POT, POT);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, cn);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      texSize = [img.naturalWidth, img.naturalHeight];
      texGen++; start();                          // 纹理代次 bump → 签名变化 → 必重画一帧
      requestAnimationFrame(() => onReady?.());   // 纹理就绪 + 渲染一帧后通知（start 先入队，先画后通知）
    });
    img.src = url;
  }

  function resize(){
    DPR = Math.min(2, window.devicePixelRatio || 1);
    // buffer 按【元素实测尺寸】（CSS 是 100vw × 100dvh）——innerHeight 在 Android 带系统栏
    // 时偏小，画布被拉伸后与 <img object-fit:cover> 的构图对不上。
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.round(Math.max(1, r.width || window.innerWidth) * DPR);
    canvas.height = Math.round(Math.max(1, r.height || window.innerHeight) * DPR);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function syncRects(){
    glassN = Math.min(5, rects.length);
    for(let i = 0; i < glassN; i++){
      const r = rects[i];
      glassRects[i*4]   = (r.x + r.w / 2) * DPR;
      glassRects[i*4+1] = (r.y + r.h / 2) * DPR;
      glassRects[i*4+2] = (r.w / 2) * DPR;
      glassRects[i*4+3] = (r.h / 2) * DPR;
      glassRR[i] = (r.r ?? 28) * DPR;
    }
  }

  // —— 按需渲染 ——
  // 原来无条件 60fps rAF：画面完全静止（鼓包动画结束后）仍全屏跑 7 采样折射 shader；
  // 且 Home 进 claude/vertex 页后只是 display:none 不卸载，整个聊天期间 GPU 持续空烧。
  // 现在：① 每帧先比对签名（strength/rects/尺寸/纹理代次），没变化就跳过全部 GL 工作；
  // ② 页面后台（visibilitychange）或本层被 display:none（IntersectionObserver）时整个
  // 循环停掉，恢复可见时再启动。canvas 保留最后合成帧，静止内容不会闪。
  let lastSig = '', texGen = 0, visible = true, pageVisible = typeof document === 'undefined' || !document.hidden;

  function drawIfChanged(){
    syncRects();
    let sig = strength + '|' + canvas.width + 'x' + canvas.height + '|' + texGen + '|' + glassN;
    for(let i = 0; i < glassN * 4; i++) sig += ',' + glassRects[i];
    for(let i = 0; i < glassN; i++) sig += ',' + glassRR[i];
    if(sig === lastSig) return;
    lastSig = sig;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uTex, 0);
    gl.uniform2f(uTexSize, texSize[0], texSize[1]);
    gl.uniform2f(uR, canvas.width, canvas.height);
    gl.uniform4fv(uRe, glassRects);
    gl.uniform1fv(uRR, glassRR);
    gl.uniform1i(uN, glassN);
    gl.uniform1f(uStr, strength);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function loop(){
    raf = 0;
    if(!visible || !pageVisible) return;   // 暂停；可见性恢复时由 start() 重启
    drawIfChanged();
    raf = requestAnimationFrame(loop);
  }
  function start(){ if(!raf) raf = requestAnimationFrame(loop); }

  onMount(() => {
    if(!initGL()) return;
    loadTexture(bgUrl);
    resize();
    const onR = () => { resize(); start(); };
    window.addEventListener('resize', onR);
    const onVis = () => { pageVisible = !document.hidden; if(pageVisible) start(); };
    document.addEventListener('visibilitychange', onVis);
    const io = new IntersectionObserver((es) => { visible = es[0] ? es[0].isIntersecting : true; if(visible) start(); });
    io.observe(canvas);
    start();
    return () => { cancelAnimationFrame(raf); raf = 0; window.removeEventListener('resize', onR); document.removeEventListener('visibilitychange', onVis); io.disconnect(); };
  });
</script>

<canvas bind:this={canvas} class="refraction"></canvas>

<style>
  .refraction { position: fixed; top: 0; left: 0; width: 100vw; height: 100dvh; display: block; z-index: 0; pointer-events: none; }
</style>
