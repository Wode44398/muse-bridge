<script>
  // 配音：朗读文本进输入栏（长文，Ctrl/⌘+Enter 发送），音色是 ParamSpec 的 voice 类型。
  // 画布是一行一件的音频墙（wall/AudioWall）：同一段文字的几个音色并成一张卡。
  import { t } from '../../../lib/i18n.js';
  import CreateFrame from '../CreateFrame.svelte';
  import AudioWall from '../wall/AudioWall.svelte';

  let { active = false, sideOpen = false, wide = false } = $props();
</script>

{#snippet canvas()}
  <AudioWall page="voice" {active} />
{/snippet}

<CreateFrame page="voice" {active} {wide} title={t('配音')} placeholder={t('要朗读的文字')} sendLabel={t('合成语音')} enterSends={false} tall {canvas} />
