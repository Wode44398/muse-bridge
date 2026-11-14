<script>
  // 查看器线稿图标（lib/viewerIcons.js 的渲染件）。尺寸默认跟按钮走（--vw-ic），也可直接给 size。
  import { viewerSvg } from '../../../lib/viewerIcons.js';
  let { name, size = 0, stroke = 1.6, class: cls = '' } = $props();
  const svg = $derived(viewerSvg(name, { stroke }));
</script>

<span class="vw-ic {cls}" style:--s={size ? size + 'px' : null} aria-hidden="true">{@html svg}</span>
