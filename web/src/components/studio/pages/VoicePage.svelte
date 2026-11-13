<script>
  // 配音（原 Vertex 语音面板）：朗读文本进输入岛（长文，Ctrl/⌘+Enter 发送），音色是 ParamSpec 的 voice 类型，
  // 点 chip 开音色 sheet（/api/studio/voices）。文本文件可以直接拖进来当朗读文本。
  import { t } from '../../../lib/i18n.js';
  import CreateFrame from '../CreateFrame.svelte';
  import FocusCanvas from '../FocusCanvas.svelte';

  let { active = false, sideOpen = false, wide = false } = $props();
</script>

{#snippet canvas()}
  <FocusCanvas page="voice" {sideOpen} />
{/snippet}

<CreateFrame page="voice" {active} {wide} title={t('配音')} placeholder={t('要朗读的文字')} sendLabel={t('合成语音')} enterSends={false} tall {canvas} />
