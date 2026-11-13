<script>
  // 音乐（原 Vertex 音乐面板）：一句话描述风格与情绪；负面提示等只在模型的 ParamSpec 里有才出现。
  import { t } from '../../../lib/i18n.js';
  import CreateFrame from '../CreateFrame.svelte';
  import FocusCanvas from '../FocusCanvas.svelte';

  let { active = false, sideOpen = false, wide = false } = $props();
</script>

{#snippet canvas()}
  <FocusCanvas page="music" {sideOpen} />
{/snippet}

<CreateFrame page="music" {active} {wide} title={t('音乐')} placeholder={t('描述音乐')} sendLabel={t('生成音乐')} {canvas} />
