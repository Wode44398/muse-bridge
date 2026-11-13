<script>
  // 生成失败的卡片（画布、图像页的某一轮）：一句中文原因（modules/studio/errors.js），上游原话点「详情」才展开；
  // 被内容安全拦下时同一句话重试注定再失败，按钮换成「改提示词」（把原话放回输入框）。
  import { t } from '../../../lib/i18n.js';
  import { studio } from '../../../modules/studio/media.svelte.js';
  import { errBrief } from '../../../modules/studio/errors.js';
  import { icon } from '../../../modules/studio/icons.js';

  let { error = '', page, prompt = '', onretry = null } = $props();
  const b = $derived(errBrief(error));
  let open = $state(false);
  function edit() { studio.pendingText = { page, text: prompt }; }
</script>

<div class="cv-err">
  {@html icon('warn')}
  <span class="cv-et">
    <span class="cv-eh">{b.head}{#if b.detail}<button class="cv-more" type="button" aria-expanded={open} onclick={() => (open = !open)}>{open ? t('收起') : t('详情')}</button>{/if}</span>
    {#if b.detail && open}<small class="cv-ed sel-text">{b.detail}</small>{/if}
  </span>
  {#if b.policy && prompt}<button class="tbtn" onclick={edit}>{t('改提示词')}</button>
  {:else if onretry}<button class="tbtn" onclick={onretry}>{t('重试')}</button>{/if}
</div>
