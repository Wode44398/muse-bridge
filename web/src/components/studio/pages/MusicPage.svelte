<script>
  // 音乐：一句话描述风格与情绪；负面提示等只在模型的 ParamSpec 里有才出现。画布是一行一件的音频墙（wall/AudioWall）。
  import { t } from '../../../lib/i18n.js';
  import CreateFrame from '../CreateFrame.svelte';
  import AudioWall from '../wall/AudioWall.svelte';

  let { active = false, sideOpen = false, wide = false } = $props();
</script>

{#snippet canvas()}
  <AudioWall page="music" {active} />
{/snippet}

<CreateFrame page="music" {active} {wide} title={t('音乐')} placeholder={t('描述音乐')} sendLabel={t('生成音乐')} {canvas} />
