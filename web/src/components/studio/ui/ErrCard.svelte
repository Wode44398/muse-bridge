<script>
  // 生成失败的卡片：一句中文原因（modules/studio/errors.js），上游原话点「详情」才展开；
  // 被内容安全拦下时同一句话重试注定再失败，主按钮换成「改提示词」（把原话放回输入栏）。
  // frame：作品墙上取景框里原地出的那张（墨淡下去之后）——重试 / 改提示词 / 收起（右上 ×）。
  import { t, tc } from '../../../lib/i18n.js';
  import { studio } from '../../../modules/studio/media.svelte.js';
  import { errBrief } from '../../../modules/studio/errors.js';
  import { icon } from '../../../modules/studio/icons.js';

  let { error = '', page, prompt = '', onretry = null, ondismiss = null, frame = false } = $props();
  const b = $derived(errBrief(error));
  let open = $state(false);
  // 墙上的那张：原话放回输入栏后这张失败卡就没用了，一起收起
  function edit() { studio.pendingText = { page, text: prompt }; if (frame) ondismiss?.(); }
</script>

{#if frame}
  <div class="sw-err" class:open>
    {#if ondismiss}<button class="sw-err-x" type="button" aria-label={tc('失败卡', '收起')} title={tc('失败卡', '收起')} onclick={ondismiss}>{@html icon('close')}</button>{/if}
    <span class="sw-err-ic">{@html icon('warn')}</span>
    <p class="sw-err-h">{b.head}</p>
    {#if b.detail}
      <button class="sw-err-more" type="button" aria-expanded={open} onclick={() => (open = !open)}>{open ? t('收起详情') : t('详情')}</button>
      {#if open}<small class="sw-err-d sel-text">{b.detail}</small>{/if}
    {/if}
    <div class="sw-err-row">
      {#if !b.policy && onretry}<button class="sw-tb pri" type="button" onclick={onretry}>{t('重试')}</button>{/if}
      {#if prompt}<button class="sw-tb" class:pri={b.policy || !onretry} type="button" onclick={edit}>{t('改提示词')}</button>{/if}
    </div>
  </div>
{:else}
  <div class="cv-err">
    {@html icon('warn')}
    <span class="cv-et">
      <span class="cv-eh">{b.head}{#if b.detail}<button class="cv-more" type="button" aria-expanded={open} onclick={() => (open = !open)}>{open ? t('收起') : t('详情')}</button>{/if}</span>
      {#if b.detail && open}<small class="cv-ed sel-text">{b.detail}</small>{/if}
    </span>
    {#if b.policy && prompt}<button class="tbtn" onclick={edit}>{t('改提示词')}</button>
    {:else if onretry}<button class="tbtn" onclick={onretry}>{t('重试')}</button>{/if}
  </div>
{/if}
