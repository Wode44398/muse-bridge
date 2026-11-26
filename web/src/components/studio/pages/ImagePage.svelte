<script>
  // 图像：画布是这一类作品的墙（wall/Wall）。打开一张就是焦点，在焦点里接着说一句 = 续改这条链（后端按 thread
  // 重建上下文，不支持多轮的方言用上一张当参考图，§3.3）；墙上发 = 另起一张。
  import { t } from '../../../lib/i18n.js';
  import { studio } from '../../../modules/studio/media.svelte.js';
  import CreateFrame from '../CreateFrame.svelte';
  import Wall from '../wall/Wall.svelte';

  let { active = false, sideOpen = false, wide = false } = $props();

  const placeholder = $derived(studio.focus?.page === 'image' ? t('接着改')
    : studio.drafts.image.inputs.some((x) => x.role === 'edit') ? t('怎么改这张图') : t('描述画面'));
</script>

{#snippet canvas()}
  <Wall page="image" {active} />
{/snippet}

<CreateFrame page="image" {active} {wide} title={t('图像')} {placeholder} sendLabel={t('生成')} {canvas} />
