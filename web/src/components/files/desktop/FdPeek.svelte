<script>
  // 工作空间 · 桌面版（FilesDesktop）的右侧预览窗格（Explorer 的 Alt+P）：选中一项给大图 + 信息，选多项给件数与总大小，没选给提示。
  // P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图；配色令牌由外壳 .fd-root 给。
  import { untrack } from 'svelte';
  import { cloudFileUrl } from '../../../lib/preview.svelte.js';
  import { nativeWorkspaceThumbnail } from '../../../lib/nativeDesktop.js';
  import { t } from '../../../lib/i18n.js';
  import { cloudThumbable, typeIconSvg } from '../../../lib/fileGrid.js';
  import { tip } from '../../preview/kit/tooltip.js';
  // 文件夹图标：原版资源
  import wsIcon from '../../../visuals/assets/icons/workspace.png';
  import { fmtSize } from '../../../lib/files/common.js';
  import { fileIcon, fmtFull, typeLabel } from './fdLook.js';

  const { P } = $props();

  // —— 预览窗格：选中一项给大图 + 信息，选多项给件数与总大小，没选给当前文件夹 ——
  const peekRel = $derived(P.peekShown && P.selected.size === 1 ? [...P.selected][0] : '');
  const peekItem = $derived(peekRel ? P.rows.find((r) => r.rel === peekRel) || null : null);
  let peekThumb = $state({ rel: '', url: '' });
  let peekSeq = 0;
  $effect(() => {
    const rel = peekRel;
    untrack(() => {
      const my = ++peekSeq;
      const it = rel ? P.rows.find((r) => r.rel === rel) : null;
      if (!it || it.isDir) { if (peekThumb.rel || peekThumb.url) peekThumb = { rel: '', url: '' }; return; }
      peekThumb = { rel, url: '' };
      if (!P.nativeFs) {
        if (cloudThumbable(it.name, true)) peekThumb = { rel, url: cloudFileUrl(rel, { grid: true, mt: it.mtime, ws: P.wsRoot }) };
        return;
      }
      nativeWorkspaceThumbnail(rel, 512, P.locationId).then((r) => { if (my === peekSeq && r?.dataUrl) peekThumb = { rel, url: r.dataUrl }; }).catch(() => {});
    });
  });
  // 系统给的是类型图标而不是真缩略图（Windows 对没有缩略图的类型回落成 32/48 的小方块）：不放大成一团糊，退回线稿图标
  function peekLoaded(e) {
    const im = e.currentTarget;
    if (im.naturalWidth <= 64 && im.naturalHeight <= 64) peekThumb = { rel: peekThumb.rel, url: '' };
  }
  const peekSel = $derived(P.peekShown && P.selected.size > 1 ? P.rows.filter((r) => P.selected.has(r.rel)) : null);
  const peekSelSize = $derived(peekSel ? peekSel.reduce((s, r) => s + (r.isDir ? 0 : r.size || 0), 0) : 0);
</script>

    {#if P.peekShown}
      <aside class="fd-peek" aria-label={t('预览窗格')}>
        {#if peekItem}
          <div class="pk-hero" data-rel-peek={peekItem.rel}>
            {#if peekItem.isDir}
              <img class="pk-dir" src={wsIcon} alt="" draggable="false" />
            {:else if peekThumb.rel === peekItem.rel && peekThumb.url}
              <img class="pk-img" src={peekThumb.url} alt="" draggable="false" decoding="async" onload={peekLoaded} onerror={() => (peekThumb = { rel: peekItem.rel, url: '' })} />
              {#if P.durOf(peekItem)}<b class="tic-dur">{P.durOf(peekItem)}</b>{/if}
            {:else}
              <span class="pk-ic">{@html fileIcon(peekItem.name)}</span>
            {/if}
          </div>
          <div class="pk-name" title={peekItem.name}>{peekItem.name}</div>
          <dl class="pk-rows">
            <dt>{t('种类')}</dt><dd>{typeLabel(peekItem)}</dd>
            <dt>{t('大小')}</dt><dd>{peekItem.isDir ? P.dirSizeLabel(peekItem) : fmtSize(peekItem.size)}</dd>
            {#if P.metaOf(peekItem)?.w > 0}<dt>{t('分辨率')}</dt><dd>{P.metaOf(peekItem).w} × {P.metaOf(peekItem).h}</dd>{/if}
            {#if P.durOf(peekItem)}<dt>{t('时长')}</dt><dd>{P.durOf(peekItem)}</dd>{/if}
            {#if peekItem.isDir && P.metaOf(peekItem)?.n != null}<dt>{t('内容')}</dt><dd>{t('{n} 项', { n: P.metaOf(peekItem).n })}</dd>{/if}
            <dt>{t('修改时间')}</dt><dd>{fmtFull(peekItem.mtime)}</dd>
            {#if P.showParentCol}<dt>{t('位置')}</dt><dd>{peekItem.parent || P.rootLabel}</dd>{/if}
          </dl>
          <div class="pk-acts">
            {#if peekItem.isDir}
              <button class="pk-btn" onclick={() => P.openItem(peekItem)}>{t('打开')}</button>
            {:else}
              <button class="pk-btn" use:tip={{ label: t('快速查看'), kbd: t('空格') }} onclick={() => { const it = peekItem; P.selected = new Set([it.rel]); P.anchorRel = it.rel; P.quickLookSel(); }}>{t('预览')}</button>
            {/if}
          </div>
        {:else if peekSel}
          <div class="pk-hero"><span class="pk-ic">{@html typeIconSvg('', { isDir: false })}</span></div>
          <div class="pk-name">{t('已选 {n} 项', { n: peekSel.length })}</div>
          <dl class="pk-rows"><dt>{t('大小')}</dt><dd>{fmtSize(peekSelSize)}</dd></dl>
        {:else}
          <div class="pk-empty">{t('选中一个文件即可在这里预览')}</div>
        {/if}
      </aside>
    {/if}

<style>
  /* 预览窗格（Explorer 的 Alt+P）：固定 300 宽，出现时淡入 + 轻推，不做宽度动画 */
  .fd-peek { flex: 0 0 300px; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 16px; border-left: 1px solid var(--sep); background: var(--panel); overflow-y: auto; animation: fd-peek-in var(--mo-base) var(--ea-std); }
  @keyframes fd-peek-in { from { opacity: 0; transform: translateX(10px); } }
  .pk-hero { position: relative; aspect-ratio: 4 / 3; border-radius: 10px; background: var(--row-alt); box-shadow: inset 0 0 0 1px var(--sep); display: grid; place-items: center; overflow: hidden; }
  .pk-img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
  .pk-dir { width: 46%; height: 46%; object-fit: contain; }
  .pk-ic { color: var(--ink2); }
  .pk-ic :global(svg) { width: 64px; height: 64px; display: block; }
  .pk-name { font-size: 14px; font-weight: 600; line-height: 1.35; word-break: break-all; }
  .pk-rows { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 12px; line-height: 1.4; }
  .pk-rows dt { color: var(--ink2); }
  .pk-rows dd { margin: 0; text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .pk-acts { display: flex; gap: 8px; }
  .pk-btn { height: 32px; padding: 0 16px; border: 1px solid var(--sep); border-radius: 8px; background: var(--seg-bg); color: var(--ink); font: inherit; font-size: 13px; cursor: pointer; }
  .pk-btn:hover { background: var(--hover); }
  .pk-empty { margin: auto 0; text-align: center; font-size: 12.5px; color: var(--ink3); }
  .tic-dur { position: absolute; right: 4px; bottom: 4px; padding: 1px 5px; border-radius: 4px; background: rgba(0, 0, 0, .58); color: #fff; font-size: 10.5px; font-weight: 600; line-height: 15px; font-variant-numeric: tabular-nums; pointer-events: none; }
  @media (prefers-reduced-motion: reduce) {
    .fd-peek { animation: none; }
  }
</style>
