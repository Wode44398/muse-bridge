<script>
  // 桌面主页 Dock 的 WebGPU 玻璃体。渲染模块（FigmaGlassRenderer / NOTIFICATION_SCENE）不在公开仓：
  // 维护者的私有 overlay 提供时（清单 modules.figmaGlass，见 lib/figmaHomeGlass.svelte.js 的 loadFigmaGlass）才走这条，
  // 公开版拿不到模块 → onready(false)，父级照用自有的 GlassScene / domGlass 玻璃。
  //
  // 几何：一张 WebGPU 画布盖住 Dock + 四周 margin（投影要 15 模糊 + 8 下移的余量），
  // 叠在壁纸画布之上、暗角遮罩之下；四边 16px 羽化，与底下的壁纸无缝相接。
  // 玻璃背后的「背景图层」两种来源：
  //   静态壁纸（GlassScene）：src 图片按 GlassScene FS_BG 同一 cover 映射裁出这块；
  //   空间视差（SpatialLayer，live）：父级在视差层每画完一帧时【同步】调 onSourceDraw(canvas)，
  //     直接从 WebGL 画布拷走这块（绘制缓冲只在那个任务里有效），玻璃里的折射跟着视差走。
  //   流体壁纸（flux iframe，live）：同一条路，画布在 iframe 里，父级把 iframe 的视口偏移一并传进来。
  //
  // 就绪（第一帧真画出来）才 onready(true)，父级再撤掉原来的玻璃——不闪。
  // 没有模块 / WebGPU 不可用 / 设备丢失 / 渲染失败 → onready(false)，父级继续用原玻璃。
  import { onMount } from 'svelte';
  import { loadFigmaGlass } from '../../../lib/figmaHomeGlass.svelte.js';

  // edgeLines：Figma 原稿「Fill + Shadow」层的三道 LINEAR_BURN 描边投影（外扩 0.5 的 0.8 灰环 + 左右 ±1.25 的
  // 0.816 灰边）。三道叠加把外沿 0.5 单位减成纯黑——深色底上几乎看不见，亮壁纸上是一圈细黑边。
  // 维护者 09-24 要求去掉：默认关（有意偏离原稿），true 恢复原稿。
  let {
    src = '', live = false, rect = null, radius = 23, smoothing = 0.6, edgeLines = false,
    onready = () => {}, requestSource = () => {}, onlost = null,
  } = $props();

  let NOTIFICATION_SCENE = null;   // 模块加载后才有
  let M = 40;                      // = NOTIFICATION_SCENE.margin（模块到了以它为准）
  let canvas = $state();
  let renderer = $state(null);
  let img = $state(null);
  let alive = false;
  let reported = false;
  let liveTex = null, liveKey = '';

  onMount(() => {
    alive = true;
    (async () => {
      try {
        if (!navigator.gpu) throw new Error('WebGPU 不可用');   // i18n-ignore 只进 console.warn，不上屏
        const mod = await loadFigmaGlass();
        if (!mod) throw new Error('WebGPU 玻璃模块不可用');   // i18n-ignore 只进 console.warn，不上屏
        if (!alive) return;
        NOTIFICATION_SCENE = mod.NOTIFICATION_SCENE;
        M = NOTIFICATION_SCENE.margin;
        const r = await mod.FigmaGlassRenderer.create(canvas);
        // 设备丢失（GPU 进程崩溃/重启）：先回退原玻璃，再请父级整组重建拿新设备
        r.device.lost.then((i) => {
          if (!alive) return;
          console.warn('[figmaPort] GPU 设备丢失，回退原玻璃：', i.message);
          onready(false);
          if (i.reason !== 'destroyed') onlost?.();
        });
        renderer = r;
      } catch (e) {
        console.warn('[figmaPort] 回退原玻璃：', e?.message || e);
        onready(false);
      }
    })();
    return () => { alive = false; liveTex?.destroy(); try { renderer?.device.destroy(); } catch {} };
  });

  // 静态壁纸：换图就重新解码
  $effect(() => {
    if (live || !src) { img = null; return; }
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => { if (alive) img = im; };
    im.src = src;
  });

  // 几何 / 形状 / 背景变化 → 重画。live 模式向视差层要一帧新画面（经 onSourceDraw 回来）
  $effect(() => {
    rect; img; radius; smoothing; renderer;
    if (!renderer || !rect) return;
    // 当场画：推到下一帧的话拖窗口时 Dock 本体已挪、玻璃还在旧位置，一抖一抖
    if (live) requestSource(); else paintStatic();
  });

  function tileGeom() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);   // 与壁纸层同上限
    const TW = rect.w + 2 * M, TH = rect.h + 2 * M;
    return { dpr, TW, TH, x0: rect.x - M, y0: rect.y - M };
  }

  function paintStatic() {
    if (!alive || !renderer || !rect || !img || !canvas) return;
    const { dpr, TW, TH, x0, y0 } = tileGeom();
    const S = 2 * dpr;
    const PW = Math.round(TW * S), PH = Math.round(TH * S);
    // GlassScene FS_BG 的 cover 映射（视口 css px → 图片像素）
    const vw = window.innerWidth, vh = window.innerHeight;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const s = Math.max(vw / iw, vh / ih);
    const offX = (vw - iw * s) / 2, offY = (vh - ih * s) / 2;
    const oc = new OffscreenCanvas(PW, PH);
    const g = oc.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (x0 - offX) / s, (y0 - offY) / s, TW / s, TH / s, 0, 0, PW, PH);
    const dev = renderer.device;
    const bg = dev.createTexture({ size: [PW, PH], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    dev.queue.copyExternalImageToTexture({ source: oc }, { texture: bg, premultipliedAlpha: true }, [PW, PH]);
    paint(bg);
    dev.queue.onSubmittedWorkDone().then(() => bg.destroy());
  }

  // 视差层 / 流体壁纸刚画完一帧（同一任务内）：拷走 Dock 那块当背景图层，立即重画玻璃。
  // origin：src 所在文档的视口在本页的位置（iframe 里的画布传 iframe 的 rect，本页画布不传）
  export function onSourceDraw(src, origin = null) {
    if (!alive || !renderer || !rect || !canvas || !live) return;
    const { TW, TH, x0, y0 } = tileGeom();
    const box = src.getBoundingClientRect();
    // 画布像素 / css px，两个轴分开算：flux 按自己的分辨率出图，缓冲宽高比不一定等于视口
    const kx = src.width / (box.width || window.innerWidth), ky = src.height / (box.height || window.innerHeight);
    const bx = box.left + (origin?.left || 0), by = box.top + (origin?.top || 0);
    const sx = Math.round((x0 - bx) * kx), sy = Math.round((y0 - by) * ky);
    const sw = Math.max(1, Math.round(TW * kx)), sh = Math.max(1, Math.round(TH * ky));
    // 越出视口的部分（Dock 贴底时下方余量）留透明，看不见
    const ix0 = Math.max(0, sx), iy0 = Math.max(0, sy);
    const ix1 = Math.min(src.width, sx + sw), iy1 = Math.min(src.height, sy + sh);
    if (ix1 <= ix0 || iy1 <= iy0) return;
    const dev = renderer.device;
    const key = [sw, sh, sx, sy, src.width, src.height].join(',');
    if (!liveTex || key !== liveKey) {
      liveTex?.destroy();
      liveTex = dev.createTexture({ size: [sw, sh], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      liveKey = key;
    }
    try {
      dev.queue.copyExternalImageToTexture(
        { source: src, origin: [ix0, iy0] },
        { texture: liveTex, origin: [ix0 - sx, iy0 - sy], premultipliedAlpha: true },
        [ix1 - ix0, iy1 - iy0]);
    } catch (e) {
      console.warn('[figmaPort] 取壁纸画面失败，回退原玻璃：', e?.message || e);
      onready(false);
      return;
    }
    paint(liveTex);   // 背景纹理任意分辨率：渲染器用 copyTile 双线性铺满瓦片
  }

  function paint(bgTex) {
    const { dpr, TW, TH, x0, y0 } = tileGeom();
    Object.assign(canvas.style, { left: x0 + 'px', top: y0 + 'px', width: TW + 'px', height: TH + 'px' });
    const cw = Math.round(TW * dpr), ch = Math.round(TH * dpr);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const scene = structuredClone(NOTIFICATION_SCENE);
    scene.node = { w: rect.w, h: rect.h, radius, smoothing };
    if (!edgeLines) scene.fillShadow.shadows = scene.fillShadow.shadows.filter((s) => s.blend !== 'LINEAR_BURN');
    scene.scale = 2 * dpr;   // 和 Figma 一样超采样 2×，上屏时 copyTile 双线性缩回
    scene.background = { texture: bgTex };
    try {
      renderer.render(scene, { pageColor: [0, 0, 0, 0] });
    } catch (e) {
      console.warn('[figmaPort] 渲染失败，回退原玻璃：', e?.message || e);
      onready(false);
      return;
    }
    if (!reported) { reported = true; onready(true); }
  }
</script>

<canvas bind:this={canvas} class="fgd" aria-hidden="true"></canvas>

<style>
  .fgd {
    position: fixed; z-index: 0; pointer-events: none; display: block;
    /* 四边 16px 羽化：与底下壁纸无缝衔接（投影外沿距画布边 ≥ 17px，不受影响） */
    -webkit-mask-image: linear-gradient(to right, transparent, #000 16px, #000 calc(100% - 16px), transparent),
                        linear-gradient(to bottom, transparent, #000 16px, #000 calc(100% - 16px), transparent);
    -webkit-mask-composite: source-in;
    mask-image: linear-gradient(to right, transparent, #000 16px, #000 calc(100% - 16px), transparent),
                linear-gradient(to bottom, transparent, #000 16px, #000 calc(100% - 16px), transparent);
    mask-composite: intersect;
  }
</style>
