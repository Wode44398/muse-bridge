<script>
  // 画布空态（v3，方案 §9.2「空态」）：一句宋体展示句（图像「画点什么」/ 视频「拍点什么」/ 配音「读点什么」/ 音乐「写首曲子」，
  // 做法同 dimensio 首屏问候：只收这几句的字做子集）+ 这一页的线稿母题缩小放在上方。不加说明句。
  import { art } from '../../../modules/studio/icons.js';
  import { emptyLine } from '../../../modules/studio/display.js';
  let { page, compact = false } = $props();
</script>

<div class="em" class:compact>
  <span class="em-art" aria-hidden="true">{@html art(page)}</span>
  <p class="em-line">{emptyLine(page)}</p>
</div>
