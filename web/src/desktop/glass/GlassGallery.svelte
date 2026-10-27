<script>
  // 玻璃双引擎验收画廊（dev-only，?dglass）。i18n-ignore-file（开发专用页，不翻译）
  // 上：引擎甲 GL 场景（壁纸 + Dock/面板/胶囊/游动圆钮，四滑杆实时调材质）；
  // 下：引擎乙 DOM 玻璃（内容滚动区 + 玻璃工具条，backdrop 折射真实 DOM）。
  import '../tokens.css';
  import { onMount } from 'svelte';
  import GlassScene from './GlassScene.svelte';
  import { dskGlass } from './domGlass.js';
  import { GLASS } from './material.js';
  import DSlider from '../kit/DSlider.svelte';
  import DButton from '../kit/DButton.svelte';

  document.documentElement.dataset.desktop = '1';

  let stageW = $state(0), stageH = $state(0);

  // 可调材质（作用于 Dock 条），初值取共享 preset
  let refract = $state(GLASS.dock.refract);
  let disp = $state(GLASS.dock.disp * 100);
  let frost = $state(GLASS.dock.frost * 10);
  let glow = $state(GLASS.dock.glow * 100);
  let sat = $state(GLASS.dock.sat * 100);
  let lift = $state(GLASS.dock.lift * 100);
  let sheen = $state(GLASS.dock.sheen * 100);

  // 游动圆钮（证明动态几何下折射实时正确）
  let orbT = $state(0);
  onMount(() => {
    let raf = 0;
    const tick = () => { orbT += 0.008; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  const dockW = $derived(Math.min(480, stageW - 48));
  const dockX = $derived((stageW - dockW) / 2);
  const dockY = $derived(stageH - 66 - 26);
  const orbX = $derived(stageW / 2 + Math.sin(orbT) * (stageW * 0.3) - 32);
  const orbY = $derived(stageH * 0.42 + Math.cos(orbT * 1.7) * 40);

  function panes() {
    if (!stageW || !stageH) return [];
    return [
      { x: 28, y: 28, w: 300, h: 168, ...GLASS.panel },
      { x: stageW - 148, y: 28, w: 120, h: 40, ...GLASS.pill },
      { x: orbX, y: orbY, w: 64, h: 64, ...GLASS.pill },
      { x: dockX, y: dockY, w: dockW, h: 66, ...GLASS.dock,
        refract, disp: disp / 100, frost: frost / 10, glow: glow / 100,
        sat: sat / 100, lift: lift / 100, sheen: sheen / 100 },
    ];
  }

  const DOCK_ICONS = ['#d97757', '#0a84ff', '#34c759', '#bf5af2', '#ff9f0a'];
</script>

<div class="gal">
  <div class="wrap">
    <header class="hd">
      <h1>液态玻璃 2.0 · 双引擎</h1>
      <p>上=引擎甲（WebGL 统一合成：真折射/菲涅尔/色散/磨砂，玻璃件数量不限）；下=引擎乙（DOM backdrop 折射真实内容）。材质参数两引擎共享 material.js。</p>
    </header>

    <section class="stage-card">
      <div class="stage" bind:clientWidth={stageW} bind:clientHeight={stageH}>
        <GlassScene src="/assets/wallpapers/ridges.jpg" getPanes={panes} />
        <!-- 玻璃上的 DOM 内容层（文字/图标浮在 GL 玻璃之上） -->
        {#if stageW}
          <div class="ov panel-ov" style:left="28px" style:top="28px" style:width="300px" style:height="168px">
            <b>最近会话</b>
            <span class="l">修复 WCO 拖拽区时机 bug</span>
            <span class="l">批2 玻璃引擎验收</span>
            <span class="l">泰拉瑞亚服务器巡检</span>
          </div>
          <div class="ov pill-ov" style:left="{stageW - 148}px" style:top="28px" style:width="120px" style:height="40px">Ctrl + K</div>
          <div class="ov dock-ov" style:left="{dockX}px" style:top="{dockY}px" style:width="{dockW}px" style:height="66px">
            {#each DOCK_ICONS as c (c)}<span class="dk" style:background={c}></span>{/each}
          </div>
        {/if}
      </div>
      <div class="ctl">
        <label>折射 <DSlider bind:value={refract} min={0} max={60} /> <i>{refract}px</i></label>
        <label>色散 <DSlider bind:value={disp} min={0} max={100} /> <i>{Math.round(disp)}%</i></label>
        <label>磨砂 <DSlider bind:value={frost} min={0} max={60} /> <i>{(frost / 10).toFixed(1)}px</i></label>
        <label>光感 <DSlider bind:value={glow} min={0} max={100} /> <i>{Math.round(glow)}%</i></label>
        <label>饱和 <DSlider bind:value={sat} min={80} max={160} /> <i>{Math.round(sat)}%</i></label>
        <label>提亮 <DSlider bind:value={lift} min={0} max={15} /> <i>{Math.round(lift)}%</i></label>
        <label>柔光 <DSlider bind:value={sheen} min={0} max={20} /> <i>{Math.round(sheen)}%</i></label>
      </div>
    </section>

    <section class="dom-card">
      <h3>参考配方 A/B · 同壁纸同引擎，只换「铬装」（左=当前 pill / 右=维护者参考：粗亮环+奶雾底+大软影）</h3>
      <div class="ref-stage">
        <img class="ref-bg" src="/assets/wallpapers/ridges.jpg" alt="" draggable="false" />
        <div class="refc ours" use:dskGlass={{ radius: 999, bevel: 100, refract: 30, disp: 0.3, frost: 0.4, glow: 0.9, tint: [1, 1, 1, 0.04] }}>
          <span class="ref-lab">当前</span>
        </div>
        <div class="refc theirs" use:dskGlass={{ radius: 999, bevel: 100, refract: 30, disp: 0.25, frost: 2, glow: 0, tint: [1, 1, 1, 0.08] }}>
        </div>
      </div>
    </section>

    <section class="dom-card">
      <h3>引擎乙 · DOM 玻璃 2.0（滚动下面的内容看折射）</h3>
      <div class="dom-stage">
        <div class="toolbar" use:dskGlass={{ ...GLASS.panel, radius: 18 }}>
          <DButton variant="primary" size="sm">新会话</DButton>
          <DButton size="sm">搜索</DButton>
          <DButton variant="ghost" size="sm">设置</DButton>
          <span class="tspace"></span>
          <span class="tchip" use:dskGlass={{ ...GLASS.pill, refract: 20, glow: 0.7 }}>bridge</span>
        </div>
        <div class="content">
          {#each Array.from({ length: 18 }) as _, i (i)}
            <div class="cc" style:background="hsl({(i * 47) % 360} 62% {i % 2 ? 58 : 42}%)">{i + 1}</div>
          {/each}
          <p class="ct">
            玻璃工具条 backdrop 折射的是这块真实 DOM——卡片颜色被透镜边缘掰弯、中心保持清晰。
            rim 高光是独立 conic 子层，光向与上面 GL 场景一致（左上）。滚动本区域观察折射随内容移动。
          </p>
        </div>
      </div>
    </section>
  </div>
</div>

<style>
  .gal {
    position: fixed; inset: 0; overflow: auto;
    background: var(--dsk-bg); color: var(--dsk-ink);
    font-family: var(--dsk-font); font-size: var(--dsk-fs-ui);
  }
  .wrap { max-width: 1020px; margin: 0 auto; padding: var(--dsk-s7) var(--dsk-s6) 80px; }
  .hd h1 { font-size: var(--dsk-fs-hero); font-weight: 700; letter-spacing: -.01em; margin: 0 0 6px; }
  .hd p { margin: 0 0 var(--dsk-s5); color: var(--dsk-ink-2); font-size: var(--dsk-fs-body); max-width: 72ch; }

  .stage-card { margin-bottom: var(--dsk-s6); }
  .stage {
    position: relative; height: 560px; border-radius: var(--dsk-r-xl); overflow: hidden;
    box-shadow: var(--dsk-sh-2);
  }
  .ov { position: absolute; pointer-events: none; color: #fff; }
  .panel-ov { display: flex; flex-direction: column; gap: 7px; padding: 16px 18px; }
  .panel-ov b { font-size: var(--dsk-fs-md); text-shadow: 0 1px 6px rgba(0,0,0,.4); }
  .panel-ov .l { font-size: var(--dsk-fs-sm); opacity: .85; text-shadow: 0 1px 5px rgba(0,0,0,.45); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pill-ov { display: grid; place-items: center; font-size: var(--dsk-fs-sm); font-weight: 600; letter-spacing: .04em; text-shadow: 0 1px 5px rgba(0,0,0,.4); }
  .dock-ov { display: flex; align-items: center; justify-content: center; gap: 18px; }
  .dk { width: 40px; height: 40px; border-radius: 11px; box-shadow: 0 4px 10px rgba(0,0,0,.28), inset 0 0 0 .5px rgba(255,255,255,.25); }

  .ctl { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--dsk-s4); padding: var(--dsk-s4) var(--dsk-s2) 0; }
  .ctl label { display: flex; align-items: center; gap: var(--dsk-s2); color: var(--dsk-ink-2); font-size: var(--dsk-fs-sm); white-space: nowrap; }
  .ctl label :global(input) { flex: 1; }
  .ctl i { font-style: normal; color: var(--dsk-ink-3); width: 44px; text-align: right; flex: none; }

  .dom-card h3 { margin: 0 0 var(--dsk-s3); font-size: var(--dsk-fs-caption); font-weight: 600; letter-spacing: .07em; color: var(--dsk-ink-3); text-transform: uppercase; }
  .dom-card { margin-bottom: var(--dsk-s6); }

  /* —— 参考配方 A/B —— */
  .ref-stage {
    position: relative; height: 340px; border-radius: var(--dsk-r-lg); overflow: hidden;
    box-shadow: var(--dsk-sh-1); display: flex; align-items: center; justify-content: center; gap: 90px;
  }
  .ref-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .refc { position: relative; width: 210px; height: 210px; display: grid; place-items: center; }
  .ref-lab {
    position: relative; z-index: 1; color: #fff; font-size: var(--dsk-fs-sm); font-weight: 600;
    letter-spacing: .08em; text-shadow: 0 1px 5px rgba(0,0,0,.4);
  }
  /* 维护者参考配方的铬装：粗亮环(2px/60%白) + 大软影 + 白十字内容 */
  .theirs { box-shadow: 0 0 0 2px rgba(255, 255, 255, .6), 0 16px 32px rgba(0, 0, 0, .12); }
  .theirs::before, .theirs::after {
    content: ""; position: absolute; width: 40%; height: 10px; background: #fff; border-radius: 10px;
  }
  .theirs::after { transform: rotate(90deg); }
  .dom-stage { position: relative; border-radius: var(--dsk-r-lg); overflow: hidden; box-shadow: var(--dsk-sh-1); background: var(--dsk-bg-raised); }
  .toolbar {
    position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2;
    display: flex; align-items: center; gap: var(--dsk-s2); padding: 9px 12px; width: min(560px, 86%);
  }
  .tspace { flex: 1; }
  .tchip { padding: 5px 13px; font-size: var(--dsk-fs-sm); font-weight: 600; color: #fff; text-shadow: 0 1px 4px rgba(0,0,0,.35); }
  .content {
    height: 380px; overflow: auto; padding: 76px 18px 18px;
    display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; align-content: start;
  }
  .cc { height: 86px; border-radius: var(--dsk-r-md); display: grid; place-items: center; color: rgba(255,255,255,.85); font-weight: 700; font-size: var(--dsk-fs-lg); }
  .ct { grid-column: 1 / -1; color: var(--dsk-ink-2); line-height: 1.7; margin: var(--dsk-s2) 0 0; }
</style>
