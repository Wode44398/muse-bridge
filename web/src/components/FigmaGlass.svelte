<script>
  // 一块 Figma 玻璃（主页的入口方块 / 右上账户胶囊），各平台统一用它；没 WebGPU 才退回 SVG 折射 / 毛玻璃。
  // 材质＝桌面主页 Dock 的 Clear Glass（Figma「Notification」，同 FigmaGlassDock 去掉三道
  // LINEAR_BURN 描边）。渲染模块只在维护者的私有 overlay 里（公开版主页不挂这个组件），见 lib/figmaHomeGlass.svelte.js。
  //
  // 画布挂在宿主元素里，外扩 margin（渲染器要这圈余量采背景），再用 clip-path 裁回玻璃形状本身：
  // 宿主被 pressable / 弹跳缩放时玻璃跟着一起缩，外沿那圈拷出来的壁纸不会和底下真壁纸错位
  //（Figma 原稿的投影只有 2% 黑，裁掉看不出来）。圆角不做 Figma 平滑，与 CSS 裁切一致。
  // 宿主须是定位元素且自成层叠上下文（画布 z-index:-1 垫在宿主内容底下）。
  //
  // 背景＝玻璃背后那块壁纸，连同主页的暗角（.wp-veil）一起画进去——原来的 SVG 折射取的
  // backdrop 也带着暗角。rect 不传就量宿主：尺寸取布局尺寸、位置取包围盒中心，缩放动画中途量也准。
  import { onMount } from 'svelte';
  import { figmaRenderer, loadImage, homeGlass } from '../lib/figmaHomeGlass.svelte.js';

  // strength 0→1：折射与色散整体强度（主页入场「鼓包」），<1 时按半超采样画，省一半以上的 GPU
  let { bg = null, radius = 30, strength = 1, rect = null, remeasure = 0 } = $props();

  const M = 40;   // 与 NOTIFICATION_SCENE.margin 一致
  let canvas = $state();
  let geom = $state(null);   // 玻璃在视口里的未变换布局矩形 {x,y,w,h}（css px）
  let img = $state(null);
  let R = null, SCENE = null, ctx = null, alive = false, ready = $state(false);
  let bgTex = null, bgKey = '', liveTex = null, liveOk = false, work = null;
  // 换成逐帧背景后、第一帧到之前先藏起来：流光的 WASM 引擎起得慢，画布上还留着换场前那张壁纸的玻璃
  let waiting = $state(false);

  function fail(e) {
    console.warn('[figmaHome] 退回原玻璃：', e?.message || e);   // i18n-ignore 只进控制台
    homeGlass.failed = true;
  }

  function measure() {
    if (!alive || !canvas) return;
    let g;
    if (rect) g = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    else {
      const host = canvas.parentElement;
      const w = host?.offsetWidth, h = host?.offsetHeight;
      if (!w || !h) return;   // 宿主 display:none：等下次
      const b = host.getBoundingClientRect();
      g = { x: b.left + b.width / 2 - w / 2, y: b.top + b.height / 2 - h / 2, w, h };
    }
    const o = geom;
    if (!o || Math.abs(o.x - g.x) > 0.3 || Math.abs(o.y - g.y) > 0.3 || o.w !== g.w || o.h !== g.h) geom = g;
  }

  onMount(() => {
    alive = true;
    figmaRenderer().then(({ r, SCENE: S }) => {
      if (!alive) return;
      try { ctx = r.configure(canvas); } catch (e) { fail(e); return; }
      R = r; SCENE = S; ready = true;
    }, fail);
    const onR = () => measure();
    window.addEventListener('resize', onR);
    const ro = new ResizeObserver(onR);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    // 入口网格靠 transform 居中、字体晚到会挪位：挂载后补量几次
    const timers = [0, 120, 360, 1000].map((ms) => setTimeout(measure, ms));
    return () => {
      alive = false;
      window.removeEventListener('resize', onR); ro.disconnect(); timers.forEach(clearTimeout);
      bgTex?.destroy(); liveTex?.destroy();
    };
  });

  $effect(() => { rect; remeasure; measure(); });

  // 静态壁纸：原图解码一次（几块玻璃共用）
  $effect(() => {
    const u = bg?.kind === 'image' ? bg.url : null;
    if (!u) { img = null; return; }
    loadImage(u).then((im) => { if (alive && bg?.url === u) img = im; }, () => {});
  });

  // 空间视差 / 流光：订阅每一帧（回调与它的绘制同一个任务，WebGL/WebGPU 缓冲这时还在）
  $effect(() => {
    if (bg?.kind !== 'live') { waiting = false; return; }
    liveOk = false;
    waiting = true;
    return bg.subscribe(onLive);
  });

  $effect(() => { ready; geom; img; strength; radius; bg; schedule(); });

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!alive || !ready || !geom) return;
      if (bg?.kind === 'live') { if (liveOk) paint(liveTex, true); bg.request?.(); }
      else paintStatic();
    });
  }

  function dims(scaleMul) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const TW = geom.w + 2 * M, TH = geom.h + 2 * M;
    const S = scaleMul * dpr;
    return { dpr, TW, TH, x0: geom.x - M, y0: geom.y - M, S, PW: Math.round(TW * S), PH: Math.round(TH * S) };
  }

  // 暗角：与 Home 的 .wp-veil 同一条 radial-gradient(125% 95% at 50% 42%, 透明 52%, 黑 .38 100%)
  function drawVeil(g, x0, y0, k) {
    const W = window.innerWidth, H = window.innerHeight;
    g.save();
    g.setTransform(k * 1.25 * W, 0, 0, k * 0.95 * H, (0.5 * W - x0) * k, (0.42 * H - y0) * k);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    gr.addColorStop(0.52, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,0.38)');
    g.fillStyle = gr;
    g.fillRect(-3, -3, 6, 6);
    g.restore();
  }

  function scratch(PW, PH) {
    if (!work || work.width !== PW || work.height !== PH) work = new OffscreenCanvas(PW, PH);
    const g = work.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, PW, PH);
    g.imageSmoothingQuality = 'high';
    return g;
  }
  function upload(tex, PW, PH) {
    const dev = R.device;
    if (!tex || tex.width !== PW || tex.height !== PH) {
      tex?.destroy();
      tex = dev.createTexture({ size: [PW, PH], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    }
    dev.queue.copyExternalImageToTexture({ source: work }, { texture: tex, premultipliedAlpha: true }, [PW, PH]);
    return tex;
  }

  function paintStatic() {
    if (!img) return;
    const low = strength < 1;
    const { TW, TH, x0, y0, S, PW, PH } = dims(low ? 1 : 2);
    const b = bg.box?.() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const key = [bg.url, PW, PH, x0.toFixed(1), y0.toFixed(1), b.left, b.top, b.width, b.height].join();
    if (key !== bgKey) {
      // 壁纸 <img> 的 object-fit: cover（居中）映射：视口 css px → 原图像素
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const s = Math.max(b.width / iw, b.height / ih);
      const offX = b.left + (b.width - iw * s) / 2, offY = b.top + (b.height - ih * s) / 2;
      const g = scratch(PW, PH);
      g.drawImage(img, (x0 - offX) / s, (y0 - offY) / s, TW / s, TH / s, 0, 0, PW, PH);
      drawVeil(g, x0, y0, S);
      try { bgTex = upload(bgTex, PW, PH); } catch (e) { fail(e); return; }
      bgKey = key;
    }
    paint(bgTex, low);
  }

  // box：源画布在本页视口里的矩形（流光的画布在 iframe 里，自己量出来的是 iframe 内坐标）
  function onLive(src, box = src.getBoundingClientRect()) {
    if (!alive || !ready || !geom) return;
    const { TW, TH, x0, y0, S, PW, PH } = dims(1);   // 视差 / 流光是连续帧：半超采样
    const kx = src.width / (box.width || window.innerWidth), ky = src.height / (box.height || window.innerHeight);
    const g = scratch(PW, PH);
    g.drawImage(src, (x0 - box.left) * kx, (y0 - box.top) * ky, TW * kx, TH * ky, 0, 0, PW, PH);
    drawVeil(g, x0, y0, S);
    try { liveTex = upload(liveTex, PW, PH); } catch (e) { fail(e); return; }
    liveOk = true;
    waiting = false;
    paint(liveTex, true);
  }

  function paint(tex, low) {
    if (!tex || !geom) return;
    const { dpr, TW, TH, S } = dims(low ? 1 : 2);
    const cw = Math.round(TW * dpr), ch = Math.round(TH * dpr);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    Object.assign(canvas.style, {
      left: -M + 'px', top: -M + 'px', width: TW + 'px', height: TH + 'px',
      clipPath: `inset(${M}px round ${Math.min(radius, geom.w / 2, geom.h / 2)}px)`,
    });
    const scene = structuredClone(SCENE);
    scene.node = { w: geom.w, h: geom.h, radius: Math.min(radius, geom.w / 2, geom.h / 2), smoothing: 0 };
    scene.fillShadow.shadows = scene.fillShadow.shadows.filter((s) => s.blend !== 'LINEAR_BURN');
    scene.scale = S;
    scene.glass.refraction *= strength;
    scene.glass.dispersion *= strength;
    scene.background = { texture: tex };
    try { R.render(scene, { context: ctx, pageColor: [0, 0, 0, 0] }); }
    catch (e) { fail(e); }
  }
</script>

<canvas bind:this={canvas} class="fg" style:visibility={waiting ? 'hidden' : null} aria-hidden="true"></canvas>

<style>
  .fg { position: absolute; z-index: -1; display: block; pointer-events: none; }
</style>
