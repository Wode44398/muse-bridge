<script>
  // 新对话空态的背景层：一层静态的点阵底纹（自绘 CSS，中间输入区一带渐隐，不抢正文），淡入 600ms。
  // shown=false 时 500ms 淡出。animate 留着与调用方的接口一致（静态底纹没有动画可停）。
  let { shown = true, animate = true } = $props();
  void animate;
</script>

<div class="landing-texture dots" aria-hidden="true"
  style:opacity={shown ? 1 : 0} style:transition-duration={(shown ? 600 : 500) + 'ms'}></div>

<style>
  .landing-texture { position: absolute; inset: 0; pointer-events: none; contain: strict; z-index: 0;
    transition-property: opacity; transition-timing-function: ease-out;
    color: #c3c2b7; color-scheme: dark; }
  :global(html[data-theme="light"]) .landing-texture { color: #52514e; color-scheme: light; }

  /* 静态底纹：14px 点阵，四周与中部输入区渐隐 */
  .dots {
    background-image: radial-gradient(circle at center, color-mix(in srgb, currentColor 26%, transparent) 0 1px, transparent 1.4px);
    background-size: 14px 14px;
    background-position: center;
    -webkit-mask-image: radial-gradient(ellipse 46% 30% at 50% 58%, transparent 0 55%, #000 100%), radial-gradient(ellipse 80% 70% at 50% 50%, #000 40%, transparent 100%);
    -webkit-mask-composite: source-in;
    mask-image: radial-gradient(ellipse 46% 30% at 50% 58%, transparent 0 55%, #000 100%), radial-gradient(ellipse 80% 70% at 50% 50%, #000 40%, transparent 100%);
    mask-composite: intersect;
  }
</style>
