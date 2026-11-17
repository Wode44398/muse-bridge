<script>
  // 设置 › 壁纸、流体壁纸（iOS 外壳）。状态在外壳创建的控制器里（./ctx.js）；实景舞台在 WallpaperStage.svelte。
  import { useSettings } from './ctx.js';
  import { bgStyle } from '../../../lib/settings/common.js';
  import Segmented from '../../ios27/Segmented.svelte';
  import Slider from '../../ios27/Slider.svelte';
  import Sym from '../../ios27/Sym.svelte';
  import { DARK_IDS, LIGHT_IDS, wp, wpDef, wpHasDepth } from '../../../lib/wallpaper.svelte.js';
  import { FLUX_COLORMODES, FLUX_SLIDERS, fluxParams, resetFlux } from '../../../lib/state.svelte.js';
  import { t } from '../../../lib/i18n.js';

  let { pid } = $props();
  const S = useSettings();
  const { wpc } = S;
</script>
{#snippet check()}<Sym name="checkmark" weight={600} size={15} class="ck" />{/snippet}
{#snippet gfoot(text)}<p class="gfoot">{text}</p>{/snippet}
{#snippet ghead(text)}<h2 class="ghead">{text}</h2>{/snippet}

{#snippet wpTile(slot, id)}
  <button class="wp-card" type="button" class:sel={wp[slot] === id} onclick={() => wpc.wpCardClick(slot, id)}
    onpointerdown={(e) => wpc.wpPressDown(e, id)} onpointermove={wpc.wpPressMove} onpointerup={wpc.wpPressUp} onpointercancel={wpc.wpPressUp}
    oncontextmenu={(e) => { e.preventDefault(); wpc.openWpMenu(e, id); }}>
    <span class="wp-thumb" style={bgStyle(id)}>
      {#if wpHasDepth(id)}<span class="wp-spatial-badge" aria-hidden="true"></span>{/if}
      {#if wpDef(id).dyn}<span class="wp-dyn">{t('动态')}</span>{/if}
      {#if wp[slot] === id}<span class="wp-ck">{@render check()}</span>{/if}
    </span>
    <span class="wp-name">{wpDef(id).name}</span>
  </button>
{/snippet}

{#snippet pWallpaper()}
  <div class="ig wp-cur">
    <div class="wp-pair">
      {#each ['light', 'dark'] as sys (sys)}
        <button class="wp-prev" type="button" class:now={wpc.homeSys === sys} onclick={() => wpc.enterStage(sys)} aria-label={sys === 'light' ? t('明亮壁纸预览') : t('深色壁纸预览')}>
          <span class="wp-phone" style={bgStyle(wp[sys])}><span class="wp-clock">9:41</span></span>
          <span class="wp-cap">
            <Sym name={sys === 'light' ? 'sun.max' : 'moon.fill'} weight={600} size={13} />
            {sys === 'light' ? t('明亮 · {name}', { name: wpDef(wp.light).name }) : t('深色 · {name}', { name: wpDef(wp.dark).name })}
          </span>
        </button>
      {/each}
    </div>
  </div>

  {@render ghead(t('明亮主题壁纸'))}
  <div class="wp-grid">
    {#each wpc.gridItems('light', LIGHT_IDS) as id (id)}{@render wpTile('light', id)}{/each}
    <label class="wp-card wp-add" for="wp-upl-light"><span class="wp-thumb"><Sym name="photo.badge.plus" weight={400} size={28} /></span><span class="wp-name">{t('相册上传')}</span></label>
  </div>
  {@render ghead(t('深色主题壁纸'))}
  <div class="wp-grid">
    {#each wpc.gridItems('dark', DARK_IDS) as id (id)}{@render wpTile('dark', id)}{/each}
    <label class="wp-card wp-add" for="wp-upl-dark"><span class="wp-thumb"><Sym name="photo.badge.plus" weight={400} size={28} /></span><span class="wp-name">{t('相册上传')}</span></label>
  </div>
  {#if wpc.wpErr && !wpc.stage}<p class="gfoot err">{wpc.wpErr}</p>{/if}
  {@render gfoot(t('长按自己上传的壁纸可以删除。上传时同时选中原图和它的深度图（文件名带 depth），就能开空间壁纸。'))}
  <input id="wp-upl-light" type="file" accept="image/*" multiple onchange={(e) => wpc.onUpload('light', e)} hidden />
  <input id="wp-upl-dark" type="file" accept="image/*" multiple onchange={(e) => wpc.onUpload('dark', e)} hidden />
{/snippet}

{#snippet fluxRows(list)}
  {#each list as s (s.key)}
    <div class="r slr" class:live={S.sliding === 'flux-' + s.key}>
      <span class="slr-head"><span class="r-tx">{s.label}</span><span class="r-d num">{wpc.fluxFmt(s, fluxParams[s.key])}</span></span>
      <Slider value={wpc.fluxFrac(s)} label={s.label} onstart={() => wpc.fluxDown(s)} oninput={(f) => wpc.fluxInput(s, f)} onend={wpc.fluxUp} />
    </div>
  {/each}
{/snippet}

{#snippet pFlux()}
  {@render ghead(t('颜色'))}
  <div class="seg-wrap"><Segmented options={FLUX_COLORMODES.map((c) => ({ value: c.id, label: c.name }))} value={fluxParams.colormode} onchange={wpc.pickColor} label={t('颜色')} /></div>
  {@render ghead(t('画面'))}
  <div class="ig">{@render fluxRows(FLUX_SLIDERS.filter((s) => !s.group))}</div>
  {@render ghead(t('海浪'))}
  <div class="ig">{@render fluxRows(FLUX_SLIDERS.filter((s) => s.group))}</div>
  <div class="ig">
    <button class="r" type="button" onclick={resetFlux}><span class="r-main center"><span class="r-tx accent">{t('恢复默认参数')}</span></span></button>
  </div>
{/snippet}
{#if pid === 'wallpaper'}{@render pWallpaper()}
{:else if pid === 'flux'}{@render pFlux()}
{/if}

<style>
  @import './kit.css';
</style>
