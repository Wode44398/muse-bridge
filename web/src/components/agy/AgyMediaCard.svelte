<script>
  // 媒体进度卡：生成图片 / 视频 / 语音 / 音乐时在对话里占一行读秒，生成完原地换成成品（段的来历见 lib/agy/media.js）。
  // 视频、音乐要等一两分钟——没有这一行的话，中间只有步骤流里一条工具调用，看着像卡住了。
  import { agyArtifactUrl } from '../../lib/preview.svelte.js';
  import { attDragSrc } from '../../lib/dragOut.js';
  import { attLook } from '../../lib/agy/attach-look.js';
  import { t } from '../../lib/i18n.js';
  import AgyAttachment from './AgyAttachment.svelte';

  const { seg, sessionId = '', onopen = null } = $props();

  const generating = $derived(seg.status === 'generating');
  let now = $state(Date.now());
  $effect(() => {
    if (!generating) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  const secs = $derived(seg.startedAt ? Math.max(0, Math.floor((now - seg.startedAt) / 1000)) : 0);
  const label = $derived.by(() => {
    const elapsed = secs >= 2 ? ` · ${secs}s` : '';
    if (seg.mediaKind === 'video') return t('生成视频中{elapsed}…', { elapsed });
    if (seg.mediaKind === 'music') return t('生成音乐中{elapsed}…', { elapsed });
    if (seg.mediaKind === 'speech') return t('生成语音中{elapsed}…', { elapsed });
    return t('生成图片中{elapsed}…', { elapsed });
  });

  // 能出预览图的（图片 / 视频）排一排，其余（音频）用类型卡另起一排——和交付物同一套摆法
  const rows = $derived.by(() => {
    const all = Array.isArray(seg.files) ? seg.files : [];
    return [all.filter((a) => attLook(a).media), all.filter((a) => !attLook(a).media)];
  });
</script>

{#if generating}
  <div class="agy-media-wait" role="status">
    <span class="dot" aria-hidden="true"></span>
    <span class="txt">{label}</span>
  </div>
{:else if seg.status === 'ready'}
  <div class="agy-media-out">
    {#each rows as row, ri (ri)}
      {#if row.length > 0}
        <div class="row" class:files={ri === 1}>
          {#each row as att (att.path)}
            {@const dlSrc = agyArtifactUrl(sessionId, att.path, { dl: true, name: att.name })}
            <AgyAttachment
              {att}
              {sessionId}
              variant="deliv"
              solo={ri === 0 && row.length === 1}
              {onopen}
              download={dlSrc}
              drag={() => attDragSrc({ path: att.path, name: att.name, downloadUrl: dlSrc })}
            />
          {/each}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .agy-media-wait {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 28px;
    color: var(--ag-on-dim);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ag-accent);
    animation: agy-media-pulse 1.2s ease-in-out infinite;
  }
  @keyframes agy-media-pulse { 50% { opacity: 0.3; transform: scale(0.8); } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }

  .agy-media-out { display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  .row.files {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(208px, 1fr));
  }
  .row.files :global(.aa-card) { min-width: 0; max-width: none; }
</style>
