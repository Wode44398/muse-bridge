<script>
  // 视频（原 Vertex 视频面板）：任务由素材决定（参考图 → 参考生成，有尾帧 → 首尾插值，有首帧 → 图生，
  // 否则文生），后端按 inputs 的角色判断；这里只管把首帧 / 尾帧 / 参考图挂对。有素材时正文可以不写。
  import { t } from '../../../lib/i18n.js';
  import CreateFrame from '../CreateFrame.svelte';
  import FocusCanvas from '../FocusCanvas.svelte';
  import { studio } from '../../../modules/studio/media.svelte.js';

  let { active = false, sideOpen = false, wide = false } = $props();
  const ins = $derived(studio.drafts.video.inputs);
  const hasRef = $derived(ins.some((x) => x.role === 'ref'));
  const hasFrame = $derived(ins.some((x) => x.role === 'first' || x.role === 'last'));
  const placeholder = $derived(hasRef ? t('描述画面') : hasFrame ? t('描述运动') : t('描述画面和运动'));
  // 参考图生成要文字；首尾帧可以不写
  const needText = (d) => !d.inputs.some((x) => x.role === 'first' || x.role === 'last');
</script>

{#snippet canvas()}
  <FocusCanvas page="video" {sideOpen} />
{/snippet}

<CreateFrame page="video" {active} {wide} title={t('视频')} {placeholder} sendLabel={t('生成')} {needText} {canvas} />
