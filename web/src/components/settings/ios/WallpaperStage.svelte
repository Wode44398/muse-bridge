<script>
  // 壁纸实景舞台（设置页退开、主页即预览）与上传壁纸的长按菜单（iOS 外壳）。外壳 components/Settings.svelte 在原来的位置挂它：
  // 舞台在面板之后、菜单在各弹层之前。舞台的状态在壁纸控制器（./wallpaper.svelte.js），这里只有要 DOM 节点的液态分段指示器。
  import { untrack } from 'svelte';
  import { useSettings } from './ctx.js';
  import GlassButton from '../../ios27/GlassButton.svelte';
  import MorphMenu from '../../ios27/MorphMenu.svelte';
  import Slider from '../../ios27/Slider.svelte';
  import Sym from '../../ios27/Sym.svelte';
  import Toggle from '../../ios27/Toggle.svelte';
  import stageCapGlass from '../../../visuals/ios27/stagecap44-light.png';
  import stagePanelGlass from '../../../visuals/ios27/stagepanel-light.png';
  import { LiquidTabs } from '../../../lib/liquid/tabs.js';
  import { setSpatialAmp, spatial, wp, wpHasDepth } from '../../../lib/wallpaper.svelte.js';
  import { t } from '../../../lib/i18n.js';
  const { wpc } = useSettings();
  // 舞台上「明亮 / 深色壁纸」切换的液态指示器（同工作空间底栏：Kyant LiquidBottomTabs，按住拖、点按滑过去时化成透镜）
  let stageEl = $state(), segBar = $state(), segPill = $state(), segRowU = $state(), segRowS = $state(), segGlow = $state();
  let segTabs = null;
  $effect(() => {
    const bar = segBar, host = stageEl;
    if (!bar || !host || !segRowU) return;
    const lt = untrack(() => new LiquidTabs({
      bar, pill: segPill, rowU: segRowU, rowS: segRowS, glow: segGlow, lensHost: host, count: 2,
      index: wpc.stage === 'dark' ? 1 : 0, tabW: segRowU.children[0]?.offsetWidth || 121, pad: 4, selH: 36, dark: false,
      onSelect: (i) => wpc.stageSwap(i ? 'dark' : 'light'),
    }));
    segTabs = lt;
    return () => { lt.destroy(); if (segTabs === lt) segTabs = null; };
  });
  $effect(() => { const i = wpc.stage === 'dark' ? 1 : 0; untrack(() => segTabs?.setIndex(i)); });
</script>

<!-- ── 壁纸实景舞台：设置页退开、主页即预览 ── -->
{#if wpc.stage}
  <div class="stage" bind:this={stageEl}>
    <div class="stage-top">
      <GlassButton variant="stage" symbol="chevron.backward" weight={600} aria={t('返回')} onclick={wpc.exitStage} />
      <GlassButton variant="stage" prominent label={t('完成')} onclick={wpc.exitStage} />
    </div>
    <!-- 指针手势挂在整条胶囊上（lib/liquid/tabs.js）；两层同样的标签：未选那层在指示器处挖洞、选中那层只在指示器里露出（按下放大）。
         上层按钮只给键盘用（pointer-events: none），按下的透镜挂在 .stage 上压在胶囊之上 -->
    {#snippet segLight()}<Sym name="sun.max" weight={600} size={15} />{t('明亮壁纸')}{/snippet}
    {#snippet segDark()}<Sym name="moon.fill" weight={600} size={14} />{t('深色壁纸')}{/snippet}
    <div class="stage-seg" bind:this={segBar} role="tablist" aria-label={t('壁纸')} style:--img={`url("${stageCapGlass}")`}>
      <span class="stage-knob" bind:this={segPill}></span>
      <div class="seg-row" bind:this={segRowU}>
        <button type="button" role="tab" aria-selected={wpc.stage === 'light'} onclick={(e) => { if (e.detail === 0) wpc.stageSwap('light'); }}>{@render segLight()}</button>
        <button type="button" role="tab" aria-selected={wpc.stage === 'dark'} onclick={(e) => { if (e.detail === 0) wpc.stageSwap('dark'); }}>{@render segDark()}</button>
      </div>
      <div class="seg-row" bind:this={segRowS} aria-hidden="true"><span>{@render segLight()}</span><span>{@render segDark()}</span></div>
      <span class="seg-glow" bind:this={segGlow}></span>
    </div>
    <div style="flex:1"></div>
    {#if wpHasDepth(wp[wpc.stage])}
      <div class="stage-panel" style:--img={`url("${stagePanelGlass}")`}>
        <div class="sp-row">
          <span class="sp-tx">{t('空间壁纸')}<small>{t('随视角产生景深 · 电脑指针 / 手机重力跟随')}</small></span>
          <Toggle checked={spatial[wpc.stage].on} onchange={wpc.onSpatialToggle} label={t('空间壁纸开关')} />
        </div>
        {#if spatial[wpc.stage].on}
          <div class="sp-amp">
            <span class="sp-amp-lbl">{t('景深运动幅度')}</span>
            <span class="sp-amp-sl"><Slider value={spatial[wpc.stage].amp} label={t('景深运动幅度')} oninput={(f) => setSpatialAmp(wpc.stage, f)} /></span>
            <span class="sp-val">{Math.round(spatial[wpc.stage].amp * 100)}%</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<!-- 上传壁纸的长按菜单：平铺在外壳里（玻璃要采得到底下的设置页） -->
<MorphMenu open={!!wpc.wpMenu} point={wpc.wpMenu} title={wpc.wpMenu?.name || ''} items={wpc.wpMenuItems} onclose={wpc.closeWpMenu} />

<style>
  @import './kit.css';
</style>
