<script>
  // §0 预载页 —— 就绪驱动（2026-08-15 重做）。
  //
  // 旧版把「演出」和「等待」焊死在一起：A 版方块展开写死 .82s + 收尾 120ms，B 版粒子
  // 显影兜底 6000/9000ms —— 资源全在本地缓存里也照走一遍，这就是「网速快/本地化依旧
  // 要漫长等待」的直接原因。
  //
  // 新规则只有一条：**粒子显影是等待 UI，不是必播片头**。
  //   · 关键资源在 GRACE(400ms) 内就绪 → 走快路径，压根不挂粒子层：
  //       A(暗)：黑方块展开铺满 → 露主页（flux 自己从黑浮现）           ≈ 500ms
  //       B(亮)：白方块顶帧换成镂空窗+黑环，窗口展开【直接揭出主页】     ≈ 500ms
  //         （不再是"展开成白幕再交叉淡出"，省掉整段交叉，一次几何揭幕到底）
  //   · 400ms 还没就绪 = 真·冷启动（大图解码 / 字体下载），此时屏幕本来就得空等，
  //     才挂粒子层把这段等待变成演出；就绪后照旧由 onCondensed 收尾。
  // 「THE BRIDGE」标题由持久组件 BrandTitle 处理（据 preloadPhase 居中/归位）。
  import { onMount } from 'svelte';
  import { ui } from '../lib/state.svelte.js';
  import { wp, wpDef, spatial, wpHasDepth, wpDepthUrl } from '../lib/wallpaper.svelte.js';
  import { SPATIAL_MAXAMP, spatialOverscan } from './SpatialLayer.svelte';
  import { DUR, reduced } from '../lib/motion.js';
  import { canMorph, bootReveal, homeWallpaperReady } from '../lib/pageMorph.js';
  import ParticleReveal from './ParticleReveal.svelte';
  let { onDone } = $props();
  const glassB = ui.glassMode === 'B';
  let pr, preEl;
  let showParticles = $state(false);   // 是否走「粒子当等待 UI」的慢路径
  let done = false;
  function finish() { if (done) return; done = true; onDone?.(); }   // 防重入：条条收尾路径只跑一次

  const wpKnown = $derived(wp.ready || !String(wp.light).startsWith('up-'));
  const lightWp = $derived(wpDef(wp.light));
  const depthUrl = $derived(wpHasDepth(wp.light) ? wpDepthUrl(wp.light) : null);
  const overscan = $derived((spatial.light.on && wpHasDepth(wp.light))
    ? spatialOverscan(SPATIAL_MAXAMP * spatial.light.amp) : 1);

  let prReadyRes;
  const prReady = new Promise((r) => { prReadyRes = r; });

  // 快路径真正需要的东西，仅此二者：
  //  ① 标题衬线字体（否则封面→主页字形跳变）
  //  ② 明亮主题的壁纸图已解码（揭幕瞬间主页就得有图；暗主题是 flux，自带从黑浮现，无需等）
  function essentials() {
    const waits = [document.fonts?.ready ?? Promise.resolve()];
    if (glassB) {
      waits.push(new Promise((res) => {
        const u = wpDef(wp.light)?.url;
        if (!u) return res();
        const im = new Image();
        im.onload = () => (im.decode ? im.decode().then(res, res) : res());
        im.onerror = res;
        im.src = u;
      }));
    }
    return Promise.all(waits);
  }

  onMount(() => {
    ui.preloadPhase = 'cover';
    if (glassB) ui.revealIcons = false;

    const timers = [];
    const GRACE = 400;      // 就绪宽限：本地/缓存命中远小于它 → 永远走快路径
    const HARD = 2600;      // 兜底：资源迟迟不来也不许一直卡封面
    let decided = false;
    const decide = (fast) => {
      if (decided) return; decided = true;
      timers.forEach(clearTimeout);
      if (fast || !glassB) startFast();
      else startShow();
    };

    if (reduced()) { ui.preloadPhase = 'expand'; ui.revealIcons = true; finish(); return; }

    essentials().then(() => decide(true));
    timers.push(setTimeout(() => decide(false), GRACE));
    timers.push(setTimeout(() => decide(true), HARD));   // 慢路径都没就绪 → 硬揭幕，绝不卡死

    // —— 快路径：一次几何揭幕到底，不挂粒子层 ——
    // 【2026-09-26】先等主页里那张壁纸元素本身解码好（另开 Image 预解码不保证它首帧画得出来——
    // 以前窗子打开常是一片黑，半秒后主页才冒出来），再等封面方块的入场落定；支持 View Transitions
    // 时整段揭幕交给 bootReveal（快照上做：窗口张开 + 景深落定 + 标题共享元素飞往左上）。
    async function startFast() {
      await homeWallpaperReady(450);
      try { await Promise.race([preEl?.querySelector('.block')?.getAnimations?.()[0]?.finished, new Promise((r) => setTimeout(r, 260))]); } catch {}
      if (done) return;
      if (canMorph()) {
        const b = preEl?.querySelector('.block')?.getBoundingClientRect();
        const square = b && b.width > 1 ? { x: b.left, y: b.top, w: b.width, h: b.height, r: 34 } : null;
        bootReveal({ square, apply: () => { ui.preloadPhase = 'expand'; if (glassB) ui.revealIcons = true; finish(); } });
        return;
      }
      ui.preloadPhase = 'expand';
      if (glassB) {
        // 镂空窗直接揭主页：本层背景转透明（四周由方块的 9999px 黑环接管，肉眼无感），
        // 窗口扩到哪就露出多少主页——省掉旧版"展开成白幕 → 整层交叉淡出"的那 620ms。
        preEl?.classList.add('reveal-home');
        ui.revealIcons = true;
      }
      setTimeout(finish, DUR.page + 40);
    }

    // —— 慢路径：粒子显影充当等待 UI（真·冷启动才走到这）——
    function startShow() {
      showParticles = true;
      // 粒子舞台自己也要备料；备好即开演，仍有硬兜底
      prReady.then(() => {
        if (done) return;
        ui.preloadPhase = 'expand';
        pr?.begin();
      });
      setTimeout(() => { if (!done && ui.preloadPhase !== 'expand') { ui.preloadPhase = 'expand'; pr?.begin(); } }, 1800);
      setTimeout(finish, 7000);
    }

    return () => timers.forEach(clearTimeout);
  });

  // 粒子已全锁定、原图开始结晶（画布=底下 Home 同图）→ 图标即刻浮现 + 整层淡出交叉
  function onCondensed() {
    if (done || !preEl) { finish(); return; }
    ui.revealIcons = true;
    preEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 560, easing: 'ease', fill: 'forwards' })
         .finished.then(finish).catch(finish);
    setTimeout(finish, 700);
  }
</script>

<div class="preload {ui.preloadPhase}" class:b={glassB} bind:this={preEl} aria-hidden="true">
  {#if glassB && wpKnown && showParticles}
    <!-- 粒子舞台只在慢路径挂载：快路径下它连解码/建点云的开销都不产生 -->
    <ParticleReveal bind:this={pr} imgUrl={lightWp.url} {depthUrl} {overscan} speed={1.35}
      shown={ui.preloadPhase === 'expand'} onReady={() => prReadyRes?.()} {onCondensed} />
  {/if}
  <div class="block"></div>
</div>

<style>
  .preload { position: fixed; inset: 0; z-index: 200; background: #fff; }       /* A 暗版：白底 */
  .preload.b { background: #0a0a0a; }                                            /* B 白版：黑底（白方块展开成白） */
  /* 快路径：本层底色让位，镂空窗后面直接就是主页（四周由方块的黑环接管） */
  .preload.b.reveal-home { background: transparent; }

  /* 中央方块 → 居中放大铺满全屏（圆角同步归零）。曲线/时长走运动令牌。 */
  .block {
    position: fixed; top: 50%; left: 50%; width: 148px; height: 148px;
    transform: translate(-50%, -50%); background: #0a0a0a; border-radius: 34px;
    box-shadow: 0 24px 70px rgba(0,0,0,.28);
    transition: width var(--mo-page) var(--ea-decel), height var(--mo-page) var(--ea-decel),
                border-radius var(--mo-page) var(--ea-decel), box-shadow var(--mo-base) var(--ea-fade);
  }
  .preload.b .block { background: #fff; }
  .preload.cover .block { animation: blockIn var(--mo-quick) var(--ea-settle) both; }
  @keyframes blockIn { from { transform: translate(-50%,-50%) scale(.86); opacity: 0; } to { transform: translate(-50%,-50%) scale(1); opacity: 1; } }
  .preload.expand .block { width: 150vmax; height: 150vmax; border-radius: 0; box-shadow: none; }
  /* B 版 expand：白方块顶帧变「镂空窗 + 黑环」——中心透明，box-shadow 瞬时换成 9999px
     黑环接管四周（同为 #0a0a0a，肉眼无感）；transition 剔除 box-shadow 防止环从 0 长出来露馅。 */
  .preload.b.expand .block {
    background: transparent; box-shadow: 0 0 0 9999px #0a0a0a;
    transition: width var(--mo-page) var(--ea-decel), height var(--mo-page) var(--ea-decel),
                border-radius var(--mo-page) var(--ea-decel);
  }
</style>
