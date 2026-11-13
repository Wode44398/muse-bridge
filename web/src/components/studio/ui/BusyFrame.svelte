<script>
  // 进行中的那一件（v3，方案 §9.2「画布 · 进行中」）：与目标比例同形的纸框（surface）+ 一道缓慢掠过的高光；
  // 中间一粒朱点 + mono 计时「0:14」+ text3「约 0:35」；底部 dimensio 量度条（细线 + 朱色走过的一段 + 末端一粒点）；
  // 「取消」文字钮（发出去就收不回的任务不给）。配音 / 音乐没有画面比例：一条矮框（flat）。
  import { t, tr } from '../../../lib/i18n.js';
  import { jobElapsed, jobEta, cancelJob } from '../../../modules/studio/media.svelte.js';
  import Measure from './Measure.svelte';

  let { job = null, state = 'queued', ratio = '', flat = false, modelLabel = '' } = $props();
  const st = $derived(job?.state || state);
  const eta = $derived(job ? jobEta(job) : '');
  // 「约 0:35」：只有时间用 mono，「约 / about」照常用无衬线
  const etaParts = $derived.by(() => { const m = /^(.*?)(\d+:\d{2})(.*)$/.exec(eta); return m ? [m[1], m[2], m[3]] : [eta, '', '']; });
  const who = $derived(tr(job?.modelLabel || modelLabel || ''));
</script>

<div class="busy busy-sheen" class:flat style={!flat && ratio ? `aspect-ratio:${ratio}` : ''}>
  <div class="busy-in">
    <div class="busy-t"><span class="sd-dot live" aria-hidden="true"></span><span class="mono busy-time">{job ? jobElapsed(job) : '0:00'}</span>{#if eta}<span class="busy-eta">{etaParts[0]}<span class="mono">{etaParts[1]}</span>{etaParts[2]}</span>{/if}</div>
    <!-- 在跑：朱点 + 计时已经说了，不再写「X 生成中」（模型名在输入框里）；排队中才写一句 -->
    {#if st === 'queued'}<div class="busy-hint">{t('排队中')}</div>{/if}
    {#if job && !job.uncancelable}<button class="tbtn" onclick={() => cancelJob(job.id)}>{t('取消')}</button>{/if}
  </div>
  <div class="busy-ms"><Measure value={job?.progress || null} tone="live" label={t('进度')} /></div>
</div>
