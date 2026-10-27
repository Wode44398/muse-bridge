<script>
  // 可复用参数下拉（点击打开小窗选项面板）。value=当前 id，options=[{id,name}]，onpick(id)。
  // 与图像参数面板的比例/分辨率下拉同款样式（.vp-dd*，theme.css）。
  import { t, tr } from '../lib/i18n.js';
  let { value, options = [], onpick } = $props();
  let open = $state(false);
  const name = $derived(tr((options.find((o) => o.id === value) || {}).name ?? value));
</script>

<div class="vp-dd">
  <button class="vp-dd-btn" onclick={() => (open = !open)}>{name}<svg viewBox="0 0 20 20"><path fill="currentColor" d="M14.13 7.17a.5.5 0 0 1 .74.67l-4.5 5a.5.5 0 0 1-.74 0l-4.5-5a.5.5 0 1 1 .74-.67L10 11.75z"/></svg></button>
  {#if open}
    <button class="vp-dd-scrim" aria-label={t('关闭')} onclick={() => (open = false)}></button>
    <div class="vp-dd-menu">
      {#each options as o (o.id)}
        <button class="vp-dd-item" class:on={o.id === value} onclick={() => { onpick?.(o.id); open = false; }}>{tr(o.name)}{#if o.id === value}<svg class="ck" viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>{/if}</button>
      {/each}
    </div>
  {/if}
</div>
