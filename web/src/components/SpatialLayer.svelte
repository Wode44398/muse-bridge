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
  export function redraw(now = false) { dirty = true; if (now && ready && gl) draw(); kick(); }

  const MAXAMP = SPATIAL_MAXAMP, FOCUS = 0.5, DAMP = 0.15;   // DAMP=追赶目标速度(越大越跟手、阻尼感越轻)；迭代次数在着色器里硬编码为 8（WebGL1 循环上界须字面量）

  let canvas;
  let gl, prog, texImg, texDepth;
  const U = {};
  let imgW = 1, imgH = 1, ready = false;
  let cover = [1, 1];
  let target = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
  let usingGyro = false;
  let raf = 0, last = 0, lastDraw = 0, pageVisible = true, visible = true, dirty = true, lastSig = '', resizePending = false;
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
      float pd = -1.0;
      for (int i = 0; i < 8; i++){
        float d = texture2D(uDepth, s).r;
        s = base - (d - uFocus) * dir;
        if (abs(d - pd) < 0.0005) break;   // 已收敛（平坦区两三次就到）：后面几次是空算。0.0005 与跑满 8 次比仅遮挡边缘百余像素亚像素差
        pd = d;
      }
      gl_FragColor = texture2D(uImage, s);
    }`;

  function compile(type, src){
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  function initGL(){
    // 不开 MSAA：全屏一张四边形没有几何边缘可抗，开了每帧白多一遍多重采样+解析
    gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false });
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
  // 纹理按屏幕需要的分辨率缩一次再进 GPU：上传壁纸常 4–6K，每像素 9 次相依取样在大纹理上全是缓存缺失，
  // 且无 mipmap 时缩小采样还闪。原图缩到「cover×最大 overscan 后刚好 1 texel/px」；深度图只把超大的压到 2048（压到 1024 实测遮挡边缘挪位 2.7 万像素，别再降）。
  function scaled(img, s){
    const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
    if (s >= 0.999) return img;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h);
    return c;
  }
  const OS_MAX = spatialOverscan(MAXAMP);
  function needScale(img, pw, ph){   // 铺满 pw×ph 像素（任一方向旋转）所需的缩放比
    const iw = img.naturalWidth, ih = img.naturalHeight;
    return Math.min(1, OS_MAX * Math.max(Math.max(pw / iw, ph / ih), Math.max(ph / iw, pw / ih)));
  }
  let srcImg = null, texScale = 0;
  function uploadImage(pw, ph){
    texScale = needScale(srcImg, pw, ph);
    upload(0, texImg, scaled(srcImg, texScale));
  }
  function screenPx(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return [Math.max(canvas.width, (screen.width || 0) * dpr), Math.max(canvas.height, (screen.height || 0) * dpr)];
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
      srcImg = im; uploadImage(...screenPx());
      upload(1, texDepth, scaled(dp, Math.min(1, 2048 / Math.max(dp.naturalWidth, dp.naturalHeight))));
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
    cover = [sx / os, sy / os]; dirty = true; kick();
  }
  function resize(){
    if (!gl) return;
    // 主页被盖住（display:none）时量出来是 0、按 innerWidth 兜底重建缓冲再同步补画（还会叫玻璃们各拷一遍）——
    // 在分页里每弹一次键盘就白做一轮。看不见先记下，露面时再做。
    if (!visible) { resizePending = true; return; }
    resizePending = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // buffer 按【元素实测尺寸】（CSS 是 100vw × 100dvh）——用 innerHeight 在 Android 带
    // 系统栏时会偏小、画布被拉伸，与同屏的 <img object-fit:cover> 差出约 10% 的构图。
    const r = canvas.getBoundingClientRect();
    const cw = Math.max(1, r.width || window.innerWidth), chh = Math.max(1, r.height || window.innerHeight);
    const w = Math.round(cw * dpr), h = Math.round(chh * dpr);
    const changed = canvas.width !== w || canvas.height !== h;
    if (changed){ canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
    // 窗口挪到更大的屏上：纹理不够清晰时按新尺寸重缩一次
    if (changed && srcImg && texScale < 1 && needScale(srcImg, w, h) > texScale * 1.02) uploadImage(...screenPx());
    computeCover();
    // 改尺寸会当场清空画布：同步补画一帧，不等 RAF（否则拖动窗口宽度时每次变化闪一帧空白）
    if (changed && ready) draw();
  }

  // —— 输入 ——
  function onPointer(e){
    if (usingGyro || e.pointerType === 'touch') return;   // 触摸设备只用陀螺仪，指针仅电脑鼠标
    target.x = (e.clientX / window.innerWidth  - 0.5) * 2;
    target.y = (e.clientY / window.innerHeight - 0.5) * 2;
    kick();
  }
  function onLeave(){ if (!usingGyro){ target.x = 0; target.y = 0; kick(); } }
  // —— 手机：陀螺仪角速度积分 + 缓慢回中（同 iOS 视差壁纸）——
  // 旧版拿【第一帧姿势】当中心、按 beta/gamma 欧拉角差算：换个握姿就一直顶在边上；竖拿（beta≈90°）时 gamma
  // 万向节翻转乱跳；左右转身（偏航）重力不变、完全没反应——空间感弱且怪。现改为：
  //   ① 主路：devicemotion.rotationRate（绕机身 x/y 轴的角速度）积分成偏移，三向转动都有视差，竖拿左右转身也有；
  //   ② 偏移按 RECENTER 时间常数缓慢漏回 0：停住后画面慢慢回正，任何握姿都从中间开始；
  //   ③ 没有陀螺仪的机器退回重力向量（不走欧拉角，竖拿不翻转），中心同样缓慢跟随当前姿势。
  const GYRO_RANGE = 11;   // 满偏移所需转角(度)：越小越灵敏
  const RECENTER = 2.6;    // 回中时间常数(秒)：越大停住后保持偏移越久、慢转也有视差；越小越快回正
  let rateLive = false, ox = 0, oy = 0, lastRateT = 0, lastOriT = 0;
  function screenMap(dx, dy){   // 机身轴 → 屏幕轴（横屏换轴，与旧版同向）
    const ori = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    if (ori === 90 || ori === -90 || ori === 270){
      let x = dy, y = dx;
      if (ori === -90 || ori === 270){ x = -x; y = -y; }
      return [x, y];
    }
    return [dx, dy];
  }
  function setTarget(dGamma, dBeta){
    const [dx, dy] = screenMap(dGamma, dBeta);
    // 软限幅（tanh）：大幅转动时平滑地逼近满偏，不在 ±1 处硬顶出一道「撞墙」
    target.x = Math.tanh(dx / GYRO_RANGE);
    target.y = Math.tanh(dy / GYRO_RANGE);
    kick();
  }
  function onMotion(e){
    const r = e.rotationRate;
    if (!r || r.beta == null || r.gamma == null) return;
    if (!rateLive && !r.beta && !r.gamma && !r.alpha) return;   // 有的机器没陀螺仪也发事件、恒 0：别抢走重力路
    rateLive = usingGyro = true;
    const now = performance.now();
    const dt = lastRateT ? Math.min(0.1, (now - lastRateT) / 1000) : 0; lastRateT = now;
    if (!dt) return;
    const leak = Math.exp(-dt / RECENTER), lim = GYRO_RANGE * 2.5;   // 限住积分，防持续转动后回中要等很久
    const dz = (v) => (Math.abs(v) < 0.5 ? 0 : v);   // 陀螺仪静止噪声 ~0.1–0.5°/s：死区滤掉，拿稳不抖、也不白画
    ox = Math.max(-lim, Math.min(lim, (ox + dz(r.gamma) * dt) * leak));
    oy = Math.max(-lim, Math.min(lim, (oy + dz(r.beta)  * dt) * leak));
    if (Math.abs(ox) < 0.03) ox = 0; if (Math.abs(oy) < 0.03) oy = 0;
    setTarget(ox, oy);
  }
  // 兜底：重力「上」向量（机身系）u = (-cosβ·sinγ, sinβ, cosβ·cosγ)，与 alpha 无关、处处连续。
  // 中心 n 缓慢追 u；n×u 的 x/y 分量 ≈ 绕机身 x/y 轴的转角（弧度，取负即 dβ/dγ 同向）。
  let nUp = null;
  function onOrient(e){
    if (rateLive || e.beta == null || e.gamma == null) return;
    usingGyro = true;
    const R = Math.PI / 180, b = e.beta * R, g = e.gamma * R;
    const u = [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
    const now = performance.now();
    const dt = lastOriT ? Math.min(0.1, (now - lastOriT) / 1000) : 0; lastOriT = now;
    if (!nUp) nUp = u.slice();
    else {
      const k = 1 - Math.exp(-dt / RECENTER);
      for (let i = 0; i < 3; i++) nUp[i] += (u[i] - nUp[i]) * k;
      const l = Math.hypot(nUp[0], nUp[1], nUp[2]) || 1; for (let i = 0; i < 3; i++) nUp[i] /= l;
    }
    const cx = nUp[1] * u[2] - nUp[2] * u[1], cy = nUp[2] * u[0] - nUp[0] * u[2];
    setTarget(-cy / R, -cx / R);
  }
  function initOrientation(){
    const DOE = window.DeviceOrientationEvent, DME = window.DeviceMotionEvent;
    // 先直接监听：Android 无需授权就有数据。新版 Chrome / 安卓 WebView 也带了 requestPermission——旧版见到它就只走
    // 「等首次触摸再申请」的 iOS 分支，安卓上不点一下屏幕视差根本不启动。重复 addEventListener 同一函数是空操作。
    const listen = () => {
      if (DME) window.addEventListener('devicemotion', onMotion);
      if (DOE) window.addEventListener('deviceorientation', onOrient);   // 陀螺仪不发数时的兜底
    };
    listen();
    if ((DME && typeof DME.requestPermission === 'function') || (DOE && typeof DOE.requestPermission === 'function')){
      // iOS：需用户手势授权，绑一次「首次触摸」再申请（两类事件各自授权）
      const ask = async () => {
        try { await DME?.requestPermission?.(); } catch {}
        try { await DOE?.requestPermission?.(); } catch {}
        listen();
      };
      window.addEventListener('pointerdown', ask, { once: true });
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
  // 循环（按需：静止 / 看不见时连 RAF 都不挂）。旧版每帧都挂 RAF、进来再判断要不要画——主页被盖住时也照挂，
  // 等于整个 app 每帧都被叫醒跑一次主线程（真机：停在 Claude 页时每秒 120 次空转）。现在只在追赶目标、或标脏时跑，
  // 追上了就停；陀螺仪 / 指针 / 标脏 / 露面时 kick() 重新挂上。
  function kick(){
    if (raf || !pageVisible || !visible) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function frame(now){
    raf = 0;
    if (!pageVisible || !visible) return;   // 页面后台 / Home 被 display:none（切到其它页）时停摆，露面时 kick 续上
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const k = 1 - Math.pow(1 - DAMP, dt * 60);
    cur.x += (target.x - cur.x) * k;
    cur.y += (target.y - cur.y) * k;
    const moving = Math.abs(target.x - cur.x) > 1e-4 || Math.abs(target.y - cur.y) > 1e-4;
    if (ready) {
      // 偏移按 1/512 取整比对（满幅时 ≈0.1px）：回中尾段那些肉眼看不见的亚像素变化不再一帧帧重画+拷给玻璃
      const sig = Math.round(cur.x * 512) + ',' + Math.round(cur.y * 512) + ',' + curAmp.toFixed(5) + ',' + cover[0].toFixed(4) + ',' + canvas.width;
      // 高刷屏（120/144Hz）上限 60 帧：背景视差 60 帧已顺滑，再高只是双倍 GPU + 每块玻璃多拷一倍；停下那一帧不限
      if ((dirty || sig !== lastSig) && (!moving || now - lastDraw >= 15)) { lastSig = sig; dirty = false; lastDraw = now; draw(); }
    }
    if (moving) { raf = requestAnimationFrame(frame); }
  }

  onMount(() => {
    if (!initGL()) { onlost?.(); return; }
    const onLost = () => onlost?.();
    canvas.addEventListener('webglcontextlost', onLost);
    resize();
    loadScene();
    const onR = () => resize();
    const onVis = () => { pageVisible = !document.hidden; kick(); };
    window.addEventListener('resize', onR);
    window.addEventListener('pointermove', onPointer);
    document.addEventListener('mouseleave', onLeave);
    document.addEventListener('visibilitychange', onVis);
    // Home 切到 Claude/Vertex 等页时是 display:none（不卸载）——用 IntersectionObserver 侦测
    // 不可见即暂停循环，可见再恢复（与 RefractionLayer 同策略），避免后台空烧 GPU/耗电。
    const io = new IntersectionObserver((es) => {
      visible = es.length ? es[es.length - 1].isIntersecting : true;
      if (visible && resizePending) resize();
      kick();
    });
    io.observe(canvas);
    initOrientation();
    kick();
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('resize', onR);
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('deviceorientation', onOrient);
      window.removeEventListener('devicemotion', onMotion);
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
