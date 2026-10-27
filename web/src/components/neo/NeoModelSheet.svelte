<script>
  // 模型选单：大选项行（图标块 + 名称/说明 + 选中大勾）。models 来自 caps；说明查 MODEL_DESC。
  import NeoSheet from './NeoSheet.svelte';
  import { icon, MODEL_DESC } from '../../lib/neoUi.js';
  import { t, tr } from '../../lib/i18n.js';
  let { title = t('选择模型'), sub = '', models = [], current = '', onpick, onclose } = $props();
</script>

<NeoSheet {title} {sub} {onclose}>
  {#each models as m (m.id)}
    <button class="sh-opt" class:on={m.id === current} onclick={() => { onpick?.(m.id); onclose?.(); }}>
      <span class="sh-opt-ic ic">{@html icon('spark', 24)}</span>
      <span class="sh-opt-tx"><b>{tr(m.name)}</b><small>{MODEL_DESC[m.id] || tr(m.desc) || m.id}</small></span>
      <span class="sh-opt-ck ic">{@html icon('check', 28)}</span>
    </button>
  {/each}
</NeoSheet>
