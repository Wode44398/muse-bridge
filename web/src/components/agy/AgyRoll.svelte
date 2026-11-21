<script>
  // 状态文字换场（11-19）：Material 的 shared axis Y——旧字向上退、虚化淡出（emphasized accelerate，短），
  // 新字从下方升起、由虚到实（emphasized decelerate，长），两者叠在同一格里交错，不推挤左右布局。
  // 只在 key 变化时演；第一次挂载直接显示（打开历史、切会话不会满屏翻字）。
  import { emphAccel, emphDecel, reducedMotion } from '../../lib/agy/motion.js';

  const { key = '', children, class: cls = '' } = $props();

  function rollIn() {
    if (reducedMotion()) return { duration: 0 };
    return {
      duration: 360,
      easing: emphDecel,
      css: (t, u) => `opacity:${Math.min(1, t * 1.25)};transform:translateY(${(u * 0.62).toFixed(3)}em);filter:blur(${(u * 3).toFixed(2)}px)`,
    };
  }
  function rollOut() {
    if (reducedMotion()) return { duration: 0 };
    return {
      duration: 170,
      easing: emphAccel,
      css: (t, u) => `opacity:${t};transform:translateY(${(-u * 0.5).toFixed(3)}em);filter:blur(${(u * 2.5).toFixed(2)}px)`,
    };
  }
</script>

<span class="agy-roll {cls}">
  {#key key}
    <span class="agy-roll-item" in:rollIn out:rollOut>{@render children?.()}</span>
  {/key}
</span>

<style>
  .agy-roll {
    display: inline-grid;
    grid-template-columns: minmax(0, auto);
    min-width: 0;
    vertical-align: bottom;
  }
  .agy-roll-item {
    grid-area: 1 / 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: inherit;
    overflow: hidden;
    white-space: nowrap;
  }
</style>
