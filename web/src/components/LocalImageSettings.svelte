<script>
  import { vertex as vs } from '../lib/state.svelte.js';
  import { t, tr } from '../lib/i18n.js';
  import { LOCAL_IMAGE_DEFAULTS, saveLocalImageSettings, localImageError } from '../lib/localImageSettings.js';
  let { aspects = [], sourceRatio = 1 } = $props();
  const dimensions = $derived.by(() => {
    if (vs.imageSize === 'custom') return { width: vs.imageWidth, height: vs.imageHeight };
    const [w, h] = String(vs.imageAspect).split(':').map(Number);
    const ratio = vs.imageAspect === 'auto' ? sourceRatio : w / h;
    const safeRatio = Number.isFinite(ratio) && ratio >= 1 / 3 && ratio <= 3 ? ratio : 1;
    const side = vs.imageSize === '4K' ? 4096 : vs.imageSize === '1K' ? 1024 : 2048;
    let width = Math.round(side * Math.sqrt(safeRatio) / 32) * 32;
    let height = Math.round(side / Math.sqrt(safeRatio) / 32) * 32;
    const maxSide = side === 4096 ? 6144 : 3072;
    if (Math.max(width, height) > maxSide) { const scale = maxSide / Math.max(width, height); width = Math.floor(width * scale / 32) * 32; height = Math.floor(height * scale / 32) * 32; }
    return { width, height };
  });
  const invalidSize = $derived(![dimensions.width, dimensions.height].every(v => Number.isInteger(v) && v >= 256 && v <= 6144 && v % 32 === 0) || dimensions.width * dimensions.height > 17_000_000);
  const error = $derived(localImageError(vs));
  $effect(() => saveLocalImageSettings(vs));
  function custom(width, height) { vs.imageSize = 'custom'; vs.imageWidth = width; vs.imageHeight = height; }
  function reset() {
    Object.assign(vs, { ...LOCAL_IMAGE_DEFAULTS, imageAspect: 'auto', imageSize: '2K' });
  }
</script>

<div class="local-settings">
  <section class="settings-group">
    <div class="group-head"><h3>{t('输出尺寸')}</h3><span>{dimensions.width || '—'} × {dimensions.height || '—'}</span></div>
    <div class="choices four">
      {#each ['1K', '2K', '4K', 'custom'] as size}
        <button class:active={(vs.imageSize || '2K') === size} onclick={() => (vs.imageSize = size)}>{size === 'custom' ? t('自定义') : size}</button>
      {/each}
    </div>
    {#if vs.imageSize === 'custom'}
      <div class="two-fields">
        <label><span>{t('宽度（像素）')}</span><input type="number" min="256" max="6144" step="32" bind:value={vs.imageWidth} /></label>
        <label><span>{t('高度（像素）')}</span><input type="number" min="256" max="6144" step="32" bind:value={vs.imageHeight} /></label>
      </div>
      <div class="quick-sizes"><button onclick={() => custom(3840, 2176)}>{t('4K 横屏')}</button><button onclick={() => custom(2176, 3840)}>{t('4K 竖屏')}</button><button onclick={() => custom(4096, 4096)}>{t('4K 方图')}</button><button onclick={() => custom(vs.imageHeight, vs.imageWidth)}>{t('交换宽高')}</button></div>
      <p class:warning={invalidSize}>{t('宽高须为 256–6144 间的 32 倍数，总像素不能超过 1700 万')}</p>
    {:else}
      <label><span>{t('比例')}</span><select bind:value={vs.imageAspect} aria-label={t('比例')}>{#each aspects as aspect}<option value={aspect.id}>{tr(aspect.name)}</option>{/each}</select></label>
    {/if}
    {#if dimensions.width * dimensions.height > 4_500_000}<p class="warning">{t('超过原生 2K 的尺寸为实验选项，会增加耗时与显存占用。')}</p>{/if}
    <p>{t('自动比例跟随最后一张参考图；没有参考图时生成方图。')}</p>
  </section>

  <section class="settings-group">
    <h3>{t('采样与引导')}</h3>
    <label><span>{t('采样步数')}<b>{vs.imageSteps}</b></span><input type="range" min="1" max="100" step="1" bind:value={vs.imageSteps} /></label>
    <p>{t('官方默认 40 步。更多步数增加耗时，不保证画质提高。')}</p>
    <label><span>{t('随机种子（-1 为随机）')}</span><input type="number" min="-1" max="4294967295" step="1" bind:value={vs.imageSeed} /></label>
    <label><span>{t('CFG 引导强度')}<b>{Number(vs.imageCfg).toFixed(1)}</b></span><input type="range" min="1" max="10" step="0.1" bind:value={vs.imageCfg} /></label>
    <p>{t('默认 1，关闭 CFG；大于 1 时启用正负提示词引导，每步计算量约翻倍。')}</p>
    <label><span>{t('负面提示词')}</span><textarea rows="3" maxlength="12000" bind:value={vs.imageNegative} disabled={vs.imageCfg <= 1} placeholder={t('描述想避免的元素或画面特征')}></textarea></label>
  </section>

  <section class="settings-group">
    <h3>{t('出图与参考')}</h3>
    <label><span>{t('出图数量')}</span><select bind:value={vs.imageCount} aria-label={t('出图数量')}>{#each [1, 2, 3, 4] as count}<option value={count}>{t('{n} 张', { n: count })}</option>{/each}</select></label>
    <p>{t('逐张生成，降低显存峰值；固定种子时每张依次加 1。')}</p>
    <label class="switch"><span>{t('透明背景（RGBA）')}</span><input type="checkbox" bind:checked={vs.imageTransparent} /></label>
    <p>{t('自动补充透明背景提示，实际透明效果由模型生成。')}</p>
    <label><span>{t('参考图处理分辨率')}</span><select bind:value={vs.imageReferenceResolution} aria-label={t('参考图处理分辨率')}>{#each [512, 1024, 2048] as size}<option value={size}>{size} × {size}</option>{/each}</select></label>
    <p>{t('控制参考图编码的像素预算，保留原比例；不改变输出尺寸。支持最多 10 张参考图，按添加顺序读取。')}</p>
  </section>

  <details class="settings-group advanced">
    <summary>{t('高级采样')}</summary>
    <label class="switch"><span>{t('前缀 KV 缓存')}</span><input type="checkbox" bind:checked={vs.imageKvCache} /></label>
    <p>{t('默认开启，可加速采样；多参考图显存不足时可尝试关闭。')}</p>
    <label><span>{t('自定义 Sigma 序列')}</span><textarea rows="3" bind:value={vs.imageSigmas} placeholder={t('留空使用默认调度；例如 1, 0.75, 0.5, 0.25')}></textarea></label>
    <p>{t('自定义 Sigma 须与采样步数一致，并在 (0, 1] 内严格递减')}</p>
  </details>
  <button class="reset" onclick={reset}>{t('恢复生成默认值')}</button>
  {#if error}<p class="warning" role="alert">{tr(error)}</p>{/if}
</div>

<style>
  .local-settings { display: grid; gap: 12px; min-width: 0; color: var(--on, inherit); }
  .settings-group { display: grid; gap: 13px; padding: 17px; border-radius: 18px; background: var(--sur, #8881); min-width: 0; }
  h3 { font-size: 13px; font-weight: 650; margin: 0; color: var(--on2, inherit); }
  .group-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
  .group-head > span { font-size: 11px; opacity: .7; font-variant-numeric: tabular-nums; }
  label { display: grid; gap: 8px; font-size: 12px; }
  label > span { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  b { font-size: 12px; font-variant-numeric: tabular-nums; }
  input:not([type=range]):not([type=checkbox]), select, textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 10px; border: 1px solid var(--line, #8885); border-radius: 10px; background: var(--sur2, #8881); color: inherit; font: inherit; }
  select option { background: var(--sur, #fff); color: var(--on, #252525); }
  textarea { resize: vertical; line-height: 1.6; }
  input[type=range] { width: 100%; accent-color: var(--acc, #427153); }
  input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--acc, #427153); }
  .switch { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .two-fields, .choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  button { font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--line, #8884); border-radius: 10px; background: transparent; min-height: 38px; padding: 7px 10px; font-size: 12px; }
  button.active { background: var(--acc, #427153); color: var(--onacc, #fff); border-color: transparent; }
  .quick-sizes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
  p { margin: 0; font-size: 11px; line-height: 1.65; color: var(--on3, #888); }
  p.warning { color: var(--err, #b88130); }
  :disabled { opacity: .45; }
  summary { cursor: pointer; font-size: 13px; font-weight: 600; }
  details[open] > :not(summary) { margin-top: 13px; }
  .reset { justify-self: start; }
</style>
