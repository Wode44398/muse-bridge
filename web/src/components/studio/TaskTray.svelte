<script>
  // 任务托盘（v3）：桌面是贴着任务钮的 Popover，手机是 Sheet。「进行中」（朱点、mono 计时、朱色量度条、取消）+「最近」
  // （完成带缩略图、失败写原因可重试、已取消 / 已放弃）。任务跑在服务端，这里只是镜像（§3.3）。
  import { t, tc, tr } from '../../lib/i18n.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { studio, isActive, jobTiming, jobStateText, cancelJob, retryJob, openAsset, findModel, mediaSrc } from '../../modules/studio/media.svelte.js';
  import { pageOf, visual } from '../../modules/studio/kinds.js';
  import { icon, kindGlyph } from '../../modules/studio/icons.js';
  import { errBrief } from '../../modules/studio/errors.js';
  import Layer from './ui/Layer.svelte';
  import Img from './ui/Img.svelte';
  import Measure from './ui/Measure.svelte';

  let { anchor = null, onclose } = $props();

  const active = $derived(studio.jobs.filter(isActive));
  const recent = $derived(studio.jobs.filter((j) => !isActive(j)).slice(0, 30));
  const modelLabel = (j) => tr(j.modelLabel || findModel(j.key)?.label || '') || String(j.key || '').split('/').slice(1).join('/');
  function reveal(j) {
    const a = j.result?.[0];
    onclose?.();
    if (a) { openAsset(a); studio.flash = a.id; setTimeout(() => { if (studio.flash === a.id) studio.flash = ''; }, 1200); }
    else { const p = pageOf(j.kind); if (p) studio.page = p; }
  }
  async function retry(j) { if (!(await retryJob(j))) showToast(t('重试失败'), 'err'); }
  const glyphOf = (j) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${kindGlyph(j.kind)}</svg>`;
</script>

<Layer title={tc('任务托盘', '任务')} {anchor} width={360} align="end" {onclose}>
  {#if !active.length && !recent.length}
    <p class="tt-empty">{t('没有任务')}</p>
  {/if}
  {#if active.length}
    <div class="tt-sec">{tc('任务', '进行中')}</div>
    {#each active as j (j.id)}
      <div class="tt-r live">
        <span class="tt-th"><span class="wr-busy" aria-hidden="true"><span class="sd-dot live"></span></span></span>
        <span class="tt-tx">
          <span class="tt-p">{j.prompt || t('（无提示词）')}</span>
          <span class="tt-m"><span>{modelLabel(j)}</span>{#if j.state === 'queued'}<span>{jobStateText(j)}</span>{/if}<span class="mono live-t">{jobTiming(j)}</span></span>
          <Measure value={j.progress || null} tone="live" />
        </span>
        {#if !j.uncancelable}<button class="tt-x" aria-label={t('取消任务')} onclick={() => cancelJob(j.id)}>{@html icon('close')}</button>{/if}
      </div>
    {/each}
  {/if}
  {#if recent.length}
    <div class="tt-sec">{tc('任务', '最近')}</div>
    {#each recent as j (j.id)}
      {@const a = j.result?.[0]}
      <div class="tt-r" class:err={j.state === 'error'} role="button" tabindex="0" onclick={() => reveal(j)} onkeydown={(e) => { if (e.key === 'Enter') reveal(j); }}>
        {#if a && visual(a.kind)}<span class="tt-th"><Img src={mediaSrc(a, 'thumb')} alt="" loading="lazy" decoding="async" /></span>
        {:else}<span class="tt-th">{@html glyphOf(j)}</span>{/if}
        <span class="tt-tx">
          <span class="tt-p">{j.prompt || t('（无提示词）')}</span>
          <!-- 完成是默认态：不写「已完成」也不打勾，只写型号；取消 / 放弃才写状态 -->
          <span class="tt-m">{#if j.state === 'error'}{errBrief(j.error).head}{:else}<span>{modelLabel(j)}</span>{#if j.state !== 'done'}<span>{jobStateText(j)}</span>{/if}{/if}</span>
        </span>
        {#if j.state === 'error'}<button class="tt-retry" onclick={(e) => { e.stopPropagation(); retry(j); }}>{t('重试')}</button>{/if}
      </div>
    {/each}
  {/if}
</Layer>
