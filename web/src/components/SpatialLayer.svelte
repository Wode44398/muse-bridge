<script module>
  // 供外部（ParticleReveal 终帧对齐等）读取的空间壁纸 cover 常量：本层静止时画面 = 原图
  // cover × overscan 微放大，粒子转场的终帧须用同倍率才能与本层硬接不跳。
  export const SPATIAL_MAXAMP = 0.04;
  export const spatialOverscan = (a) => 1 / Math.max(0.55, 1 - 2.2 * a);   // a = MAXAMP×幅度
</script>

<script>
  // 空间壁纸层：给静态壁纸叠深度视差（电脑指针跟随 / 手机重力跟随）。
  // 全屏 canvas，铺在壁纸位（z-index 0，pointer-events none）——玻璃 UI 的 SVG backdrop 折射它，
  // 与既有 <img>/RefractionLayer 同层替换。深度图（assets/wallpapers/depth/<id>.png，白=近黑=远）
  // 驱动【迭代式反向 warp】视差：正确遮挡、无撕裂；overscan 随幅度自适应防露边；阻尼缓动 + dt
  // 时间归一化（60/120Hz 手感一致）。算法与独立调试台 1:1（已压力测试无瑕疵）。
  import { onMount } from 'svelte';

  // ondraw(canvas)：每画完一帧【同步】回调——WebGL 绘制缓冲只在本任务内有效（未开 preserveDrawingBuffer），
  // 桌面 Dock 的 Figma 玻璃（FigmaGlassDock）就在这里拷走自己那块背景。
  // onlost：GL 上下文丢失（GPU 进程崩溃/重启）——丢了的画布不自愈，交父级换新画布重建。
  let { imgUrl, depthUrl, amp = 0.55, ondraw = null, onlost = null } = $props();
  // 外部要一帧新画面（如玻璃刚就绪、Dock 挪了位）：标脏，下一帧照常画并触发 ondraw
  // now=true 当场画（桌面 Dock 跟窗口尺寸挪位时用，晚一帧玻璃会落后 Dock 本体一抖一抖）
  export function redraw(now = false) { dirty = true; if (now && ready && gl) draw(); }

  const MAXAMP = SPATIAL_MAXAMP, FOCUS = 0.5, DAMP = 0.15;   // DAMP=追赶目标速度(越大越跟手、阻尼感越轻)；迭代次数在着色器里硬编码为 8（WebGL1 循环上界须字面量）

  let canvas;
  let gl, prog, texImg, texDepth;
  const U = {};
  let imgW = 1, imgH = 1, ready = false;
  let cover = [1, 1];
  let target = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
  let usingGyro = false, neutral = null;
  let raf = 0, last = 0, pageVisible = true, visible = true, dirty = true, lastSig = '';
  let curAmp = MAXAMP * 0.55, loadedImg = null, loadedDepth = null;   // 初值占位；真值由下方 $effect 按 amp 响应更新

  const VERT = `attribute vec2 aPos; varying vec2 vUv;
    void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FRAG = `precision highp float;
    varying vec2 vUv;
    uniform sampler2D uImage, uDepth;
    uniform vec2  uOffset, uCover;
    uniform float uAmp, uFocus;
    void main(){
      vec2 base = (vUv - 0.5) * uCover + 0.5;
      vec2 dir = uOffset * uAmp;
      vec2 s = base;
      for (int i = 0; i < 8; i++){
        float d = texture2D(uDepth, s).r;
        s = base - (d - uFocus) * dir;
      }
      gl_FragColor = texture2D(uImage, s);
    }`;

  function compile(type, src){
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  function initGL(){
    gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog); gl.useProgram(prog);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    ['uImage','uDepth','uOffset','uAmp','uFocus','uCover'].forEach((n) => U[n] = gl.getUniformLocation(prog, n));
    gl.uniform1i(U.uImage, 0); gl.uniform1i(U.uDepth, 1);
    gl.uniform1f(U.uFocus, FOCUS);
    texImg = mkTex(0); texDepth = mkTex(1);
    return true;
  }
  function mkTex(unit){
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // 1px 兜底，纹理未就绪时不报错
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([10,12,18]));
    return t;
  }
  function upload(unit, tex, img){
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
  }
  function loadImg(src){
    return new Promise((res, rej) => {
      const im = new Image();   // 同源壁纸，无需 crossOrigin（设了反而在部分环境触发加载失败）
      // 等解码完再交出去：WebKit 对大图 onload 先到、解码在后台，这时传进 GPU 的是空纹理（见 RefractionLayer）
      im.onload = () => (im.decode ? im.decode() : Promise.resolve()).catch(() => {}).then(() => res(im));
      im.onerror = rej; im.src = src;
    });
  }
  async function loadScene(){
    if (!gl || !imgUrl || !depthUrl) return;
    if (imgUrl === loadedImg && depthUrl === loadedDepth) return;   // 无变化，跳过重载
    const iu = imgUrl, du = depthUrl; loadedImg = iu; loadedDepth = du;
    try {
      const [im, dp] = await Promise.all([loadImg(iu), loadImg(du)]);
      if (iu !== imgUrl || du !== depthUrl) return;                 // 加载期间又切了，丢弃
      imgW = im.naturalWidth; imgH = im.naturalHeight;
      upload(0, texImg, im); upload(1, texDepth, dp);
      ready = true; resize(); dirty = true;
      draw();   // 立即同步出一帧：壁纸即刻可见，不等 RAF（后台/被节流也先画上）
    } catch { loadedImg = loadedDepth = null; }                     // 失败可重试
  }

  const overscanFor = spatialOverscan;
  function computeCover(){
    const cw = canvas.width, ch = canvas.height;
    const ca = cw / ch, ia = imgW / imgH;
    let sx = 1, sy = 1;
    if (ca > ia) sy = ia / ca; else sx = ca / ia;
    const os = overscanFor(curAmp);
    cover = [sx / os, sy / os]; dirty = true;
  }
  function resize(){
    if (!gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // buffer 按【元素实测尺寸】（CSS 是 100vw × 100dvh）——用 innerHeight 在 Android 带
    // 系统栏时会偏小、画布被拉伸，与同屏的 <img object-fit:cover> 差出约 10% 的构图。
    const r = canvas.getBoundingClientRect();
    const cw = Math.max(1, r.width || window.innerWidth), chh = Math.max(1, r.height || window.innerHeight);
    const w = Math.round(cw * dpr), h = Math.round(chh * dpr);
    const changed = canvas.width !== w || canvas.height !== h;
    if (changed){ canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
    computeCover();
    // 改尺寸会当场清空画布：同步补画一帧，不等 RAF（否则拖动窗口宽度时每次变化闪一帧空白）
    if (changed && ready) draw();
  }

  // —— 输入 ——
  function onPointer(e){
    if (usingGyro || e.pointerType === 'touch') return;   // 触摸设备只用陀螺仪，指针仅电脑鼠标
    target.x = (e.clientX / window.innerWidth  - 0.5) * 2;
    target.y = (e.clientY / window.innerHeight - 0.5) * 2;
  }
  function onLeave(){ if (!usingGyro){ target.x = 0; target.y = 0; } }
  const GYRO_RANGE = 13;   // 满偏移所需倾角(度)：越小越灵敏、小幅倾斜就有明显视差（手机端幅度增强，且避开满偏极限撕裂）
  function onOrient(e){
    if (e.beta == null || e.gamma == null) return;
    usingGyro = true;
    if (!neutral) neutral = { beta: e.beta, gamma: e.gamma };
    const ori = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    let dx, dy;
    if (ori === 90 || ori === -90 || ori === 270){
      dx = e.beta - neutral.beta; dy = e.gamma - neutral.gamma;
      if (ori === -90 || ori === 270){ dx = -dx; dy = -dy; }
    } else { dx = e.gamma - neutral.gamma; dy = e.beta - neutral.beta; }
    target.x = Math.max(-1, Math.min(1, dx / GYRO_RANGE));
    target.y = Math.max(-1, Math.min(1, dy / GYRO_RANGE));
  }
  function initOrientation(){
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function'){
      // iOS：需用户手势授权，绑一次「首次触摸」再申请
      const ask = async () => {
        try { const p = await DOE.requestPermission(); if (p === 'granted') window.addEventListener('deviceorientation', onOrient); } catch {}
      };
      window.addEventListener('pointerdown', ask, { once: true });
    } else if (DOE){
      window.addEventListener('deviceorientation', onOrient);   // Android/桌面：直接监听
    }
  }

  // —— 渲染 ——
  function draw(){
    gl.uniform2f(U.uOffset, cur.x, cur.y);
    gl.uniform1f(U.uAmp, curAmp);
    gl.uniform2f(U.uCover, cover[0], cover[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (ondraw) { try { ondraw(canvas); } catch {} }
  }
  // 循环（按需重绘：静止时零 GPU）
  function frame(now){
    raf = requestAnimationFrame(frame);
    if (!pageVisible || !visible) return;   // 页面后台 / Home 被 display:none（切到其它页）时停摆，省电
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const k = 1 - Math.pow(1 - DAMP, dt * 60);
    cur.x += (target.x - cur.x) * k;
    cur.y += (target.y - cur.y) * k;
    if (!ready) return;
    const sig = cur.x.toFixed(4) + ',' + cur.y.toFixed(4) + ',' + curAmp.toFixed(5) + ',' + cover[0].toFixed(4) + ',' + canvas.width;
    if (!dirty && sig === lastSig) return;   // 无变化不画
    lastSig = sig; dirty = false;
    draw();
  }

  onMount(() => {
    if (!initGL()) { onlost?.(); return; }
    const onLost = () => onlost?.();
    canvas.addEventListener('webglcontextlost', onLost);
    resize();
    loadScene();
    const onR = () => resize();
    const onVis = () => { pageVisible = !document.hidden; };
    window.addEventListener('resize', onR);
    window.addEventListener('pointermove', onPointer);
    document.addEventListener('mouseleave', onLeave);
    document.addEventListener('visibilitychange', onVis);
    // Home 切到 Claude/Vertex 等页时是 display:none（不卸载）——用 IntersectionObserver 侦测
    // 不可见即暂停循环，可见再恢复（与 RefractionLayer 同策略），避免后台空烧 GPU/耗电。
    const io = new IntersectionObserver((es) => { visible = es[0] ? es[0].isIntersecting : true; });
    io.observe(canvas);
    initOrientation();
    last = performance.now();
    raf = requestAnimationFrame(frame);
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('resize', onR);
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('deviceorientation', onOrient);
    };
  });

  // prop 响应：切壁纸重载纹理；改幅度实时更新（重算 overscan）。
  $effect(() => { imgUrl; depthUrl; loadScene(); });
  $effect(() => { curAmp = MAXAMP * amp; if (gl) computeCover(); });
</script>

<canvas bind:this={canvas} class="spatial"></canvas>

<style>
  .spatial { position: fixed; top: 0; left: 0; width: 100vw; height: 100dvh; display: block; z-index: 0; pointer-events: none; }
</style>
