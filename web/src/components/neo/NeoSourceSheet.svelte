<script>
  // 素材来源菜单：工作空间（云端选图）/ 手机存储（系统选择器）。
  import NeoSheet from './NeoSheet.svelte';
  import { icon } from '../../lib/neoUi.js';
  import { t } from '../../lib/i18n.js';
  let { onWorkspace, onDevice, onclose } = $props();
</script>

<NeoSheet title={t('添加图片')} {onclose}>
  <button class="sh-opt" onclick={onWorkspace}>
    <span class="sh-opt-ic ic">{@html icon('folder', 25)}</span>
    <span class="sh-opt-tx"><b>{t('工作空间')}</b><small>{t('从云端文件里选图片')}</small></span>
    <span class="ic" style="opacity:.55">{@html icon('chevR', 22)}</span>
  </button>
  <button class="sh-opt" onclick={onDevice}>
    <span class="sh-opt-ic ic">{@html icon('phone', 25)}</span>
    <span class="sh-opt-tx"><b>{t('手机存储')}</b><small>{t('从手机相册 / 文件选')}</small></span>
    <span class="ic" style="opacity:.55">{@html icon('chevR', 22)}</span>
  </button>
</NeoSheet>
