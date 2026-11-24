<script>
  // 开机入场「穿月」：月桥的倒影长成和拱一样实，圆成了一扇门；门心一点光张开成门洞，镜头推过门洞落进主页。
  //
  // 这一层浮在主页上面，主页从第一帧就在底下正常渲染（入口、标题、Dock 按 html[data-boot] 先藏着）。
  // 画面全在 lib/boot/gate.js 的一个着色器里；时间轴见 lib/boot/timeline.js。洞里那片景在门出画的那一刻
  // 正好停稳、和主页壁纸逐像素一样，这一层就在那一帧撤掉，主页上的东西接着按同一台相机落位（lib/boot/landing.js）。
  //
  // 就绪驱动：字体、壁纸（或流光 iframe 的第一帧）到齐才开门；没到齐就停在门心光点上呼吸，就绪后在下一次
  // 最亮时开门，最多等 HARD。点一下 / 按任意键 = 剩下的在 240ms 内走完。系统减弱动效、关了转场动画、
  // 没有 WebGL2：不演，首帧封面淡掉、主页直接出来。
  import { onMount } from 'svelte';
  import { ui, prefs } from '../lib/state.svelte.js';
  import { wp, wpDef, spatial, wpHasDepth, wpDepthUrl } from '../lib/wallpaper.svelte.js';
  import { SPATIAL_MAXAMP, spatialOverscan } from './SpatialLayer.svelte';
  import { reduced } from '../lib/motion.js';
  import { homeWallpaperReady } from '../lib/pageMorph.js';
  import { arrival, arrivalHold, finishArrival } from '../lib/serverSwitch.js';
  import { isNativeDesktop } from '../lib/nativeDesktop.js';
  import { createGate } from '../lib/boot/gate.js';
  import { idlePlan, plan, planned, frameAt, smooth } from '../lib/boot/timeline.js';
  import { land } from '../lib/boot/landing.js';
  import { bootIntro, markUnit, dropFirstFrame, firstFrame, setBootAttr } from '../lib/boot/intro.js';

  let { onDone } = $props();
  const desktop = isNativeDesktop();
  const HARD = 2600;     // 资源迟迟不来也不许一直停在门口
  let root, cv, veil;
  let mode = $state('gate');   // 'gate' | 'plain'（不演，只淡掉首帧封面）
  let done = false;
  function finish() { if (done) return; done = true; onDone?.(); }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const capped = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
  // 上传壁纸的地址要等 /api/wallpaper/list 回来才知道
  async function wallpaper(slot) {
    if (String(wp[slot]).startsWith('up-') && !wp.ready) {
      const t0 = Date.now();
      while (!wp.ready && Date.now() - t0 < 1500) await sleep(40);
    }
    const id = wp[slot];
    return { id, def: wpDef(id) };
  }

  onMount(() => {
    const slot = ui.glassMode === 'B' ? 'light' : 'dark';
    ui.bootStage = 'gate';
    setBootAttr('gate');
    // 明亮主页的图标浮现（Home 的 .grid.fade）与玻璃折射的鼓包在门后面先走完，落位时直接是终态
    if (slot === 'light') ui.revealIcons = true;
    const fonts = document.fonts?.ready ?? Promise.resolve();

    let cleanup = () => {};
    const gate = !reduced() && !prefs.noEnterAnim ? createGate(cv) : null;
    if (!gate) { plain(slot, fonts); return () => teardown(); }

    let W = innerWidth, H = innerHeight, u = markUnit();
    let dpr = Math.min(3, devicePixelRatio || 1);
    gate.resize(W, H, dpr);
    const geo = () => ({ W, H, u, cx: W / 2, cy: H / 2 + u });   // 水面线比 108 网格的中心低 1 格

    // 流光要在 iframe 挂上之前就知道自己在开机演出里（drift.js 启动时读一次，决定要不要「从黑浮现」）
    const up0 = String(wp[slot]).startsWith('up-');
    let dyn = !up0 && !!wpDef(wp[slot]).dyn, overscan = 1;
    if (dyn) bootIntro.active = true;
    // 什么时候开演：标记就是启动画面那一帧；开机头一两帧主线程在挂主页、传纹理，
    // 等壁纸进了 GPU、连着两帧不卡就立刻开演（封顶 220ms），避免开场干等过久。
    const START_CAP = 220, mount0 = performance.now();
    let ready = false, started = false, arrived = !arrival, smoothRun = 0;
    let t = 0, last = 0, raf = 0, warp = null, firstDrawn = false;
    let T = idlePlan();
    // 开发调试：?bootT=毫秒 定格在那一刻（window.__bootSeek(t) 换一刻）；?bootSlow=毫秒 假装资源到那时才齐
    let frozen = null, slowUntil = 0;
    if (import.meta.env.DEV) {
      const q = new URLSearchParams(location.search);
      if (q.has('bootT')) frozen = Number(q.get('bootT'));
      if (q.has('bootSlow')) slowUntil = Number(q.get('bootSlow'));
      window.__bootSeek = (v) => { frozen = v; };
      window.__bootPlan = () => T;
    }

    (async () => {
      const { id, def } = await wallpaper(slot);
      dyn = !!def.dyn;
      bootIntro.active = dyn;
      const waits = [capped(fonts, 1200)];
      if (dyn) {
        // 流光：主页那个 iframe 画出第一帧（drift.js 读到 __bootIntro 会置 ready）
        waits.push((async () => { const t0 = Date.now(); while (!bootIntro.ready && Date.now() - t0 < HARD) await sleep(30); })());
      } else {
        if (spatial[slot].on && wpHasDepth(id)) overscan = spatialOverscan(SPATIAL_MAXAMP * spatial[slot].amp);
        waits.push(gate.load(def.url, wpHasDepth(id) ? wpDepthUrl(id) : null));
      }
      await capped(Promise.all(waits), HARD);
      ready = true;
    })();
    // 切换服务器重载来的：封面（方块 + 名字）先停够、再化开，露出底下的标记才开始演
    if (arrival) arrivalHold().then(() => finishArrival()).then(() => { arrived = true; });
    setTimeout(() => { ready = true; arrived = true; }, HARD + 900);

    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      if (innerWidth !== W || innerHeight !== H) {
        W = innerWidth; H = innerHeight;
        gate.resize(W, H, dpr);
        if (planned(T)) T = plan(T.i0, geo());
      }
      const dt = last ? Math.min(50, now - last) : 0;
      smoothRun = last && now - last < 28 ? smoothRun + 1 : 0;
      if (!started && arrived && ((ready && smoothRun >= 2) || now - mount0 > START_CAP + (arrival ? 900 : 0))) started = true;
      if (import.meta.env.DEV && last) { const st = (window.__bootStats ||= { frames: 0, over20: 0, max: 0 }); st.frames++; st.max = Math.max(st.max, now - last); if (now - last > 20) { st.over20++; (st.long ||= []).push([Math.round(t), Math.round(now - last), ready ? 1 : 0]); } }
      last = now;
      if (frozen != null) t = frozen;
      else if (started) {
        // 快进：时间轴 50ms 内提速到「剩下的 140ms 走完」，每样东西从当前样子接着走
        const rate = warp ? 1 + (warp.target - 1) * smooth(0, 50, now - warp.start) : 1;
        t += dt * rate;
      }
      if (ready && !planned(T) && (frozen != null || t >= slowUntil)) T = plan(frozen != null ? 0 : t, geo());
      const g0 = geo();
      const f = frameAt(t, T, { cx: g0.cx, cy: g0.cy, u, dark: dyn, overscan });
      f.g.scene = !dyn;
      gate.draw(f.g);
      if (veil) veil.style.opacity = dyn || !planned(T) ? '0' : smooth(T.p0, T.exit, t).toFixed(3);
      if (dyn) bootIntro.cam = f.cam;
      // 流光的门洞是透明的：门一开，后面的入口就得先藏起来（开演前它们照常画在门后，玻璃先热好）
      if (dyn && t >= T.i0 - 20 && document.documentElement.dataset.boot === 'gate') setBootAttr('hide');
      if (!firstDrawn) { firstDrawn = true; requestAnimationFrame(dropFirstFrame); }   // 画布已经盖住首帧封面
      if (t >= T.exit) handoff(g0);
    };

    function handoff(g0) {
      cancelAnimationFrame(raf); raf = 0;
      bootIntro.active = false; bootIntro.cam = null;
      // 同一帧里：落位动画先挂上（fill: backwards 让它们停在起点），再撤掉藏身的属性、撤掉这一层
      land({ cx: g0.cx, cy: g0.cy });
      setBootAttr(null);
      if (root) root.style.display = 'none';
      gate.destroy();
      try { window.AndroidStore?.hapticTick?.(); } catch {}
      finish();
    }
    function skip() {
      if (!planned(T) || warp) return;   // 资源还没到：快进也没东西可看
      const rem = T.exit - t;
      if (rem > 150) warp = { start: performance.now(), target: rem / 140 };
    }
    const onKey = (e) => { if (!e.repeat) skip(); };
    root.addEventListener('pointerdown', skip);
    window.addEventListener('keydown', onKey, true);
    raf = requestAnimationFrame(tick);
    cleanup = () => {
      cancelAnimationFrame(raf);
      root?.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', onKey, true);
      gate.destroy();
    };
    return () => { cleanup(); teardown(); };
  });

  // 不演：等主页壁纸（最多 1.5s），首帧封面里的标记先淡、底色随后淡，主页直接出来
  async function plain(slot, fonts) {
    mode = 'plain';
    ui.bootStage = 'plain';
    const { def } = await wallpaper(slot);
    const waits = [capped(fonts, 800)];
    if (!def.dyn) waits.push(homeWallpaperReady(1200));
    if (arrival) waits.push(arrivalHold().then(() => finishArrival()));
    await capped(Promise.all(waits), 1500);
    setBootAttr(null);
    finish();
    const fc = firstFrame();
    const end = () => { dropFirstFrame(); ui.bootStage = ''; };
    if (!fc) { end(); return; }
    const mark = fc.querySelector('svg');
    mark?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
    const a = fc.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, delay: 60, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
    a.finished.then(end, end);
  }

  // 半路被卸掉（发现要先配服务器、单页模式接管）：别把藏身属性、首帧封面、iframe 的推镜留在页面上
  function teardown() {
    bootIntro.active = false; bootIntro.cam = null;
    if (ui.bootStage === 'gate') ui.bootStage = '';
    if (document.documentElement.dataset.boot) setBootAttr(null);
    if (mode === 'gate') dropFirstFrame();
  }
</script>

<div class="boot-gate" class:plain={mode === 'plain'} bind:this={root} aria-hidden="true">
  <canvas bind:this={cv}></canvas>
  <!-- 主页壁纸上那层暗角：洞里的景停稳时一起到位，撤掉这一层时和主页一模一样 -->
  <div class="veil" class:dsk={desktop} bind:this={veil}></div>
</div>

<style>
  .boot-gate { position: fixed; inset: 0; z-index: 198; touch-action: none; -webkit-tap-highlight-color: transparent; }
  .boot-gate.plain { display: none; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  /* 与 Home / DesktopHome 的 .wp-veil 同值 */
  .veil { position: absolute; inset: 0; pointer-events: none; opacity: 0;
          background: radial-gradient(125% 95% at 50% 42%, rgba(0,0,0,0) 52%, rgba(0,0,0,.38) 100%); }
  .veil.dsk { background: radial-gradient(125% 95% at 50% 42%, rgba(0,0,0,0) 55%, rgba(0,0,0,.34) 100%); }
</style>
