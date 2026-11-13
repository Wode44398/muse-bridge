<script>
  // 面板（方案 §9.2：手机的参数层、模型选择器、音色、任务托盘……）。做法照抄 dimensio 的 components/ui/Sheet.svelte：
  //   手机 = 底部抽屉：把手 / 标题行往下拖着关（位移或甩的速度判定）、柔弹簧滑入、ease-in 退场；圆角 22、左对齐 17/600 标题、右上 ×。
  //   宽屏（dialog）= 居中对话框，浮起 + 轻放大进场。
  // 共同：遮罩点一下关；登记 Studio 的返回栈（系统返回 / Esc 逐层关）；正文单独滚动、底部吃安全区。挂到 .studio-root。
  import { onMount } from 'svelte';
  import { t } from '../../../lib/i18n.js';
  import { swipeDismiss } from '../../../lib/motion.js';
  import { pushLayer } from '../../../modules/studio/layers.js';
  import { fade, reducedMotion, SPRING_SOFT } from '../../../modules/studio/motion.js';
  import { icon } from '../../../modules/studio/icons.js';

  // tall：高度固定成最高那档（带搜索的选项菜单：一搜索就按结果数忽高忽低、两根把手叠在一起，复核 11-06 第二轮）
  let { title = '', sub = '', wide = false, width = 440, tall = false, onclose, head = null, children } = $props();
  let scrolled = $state(false);   // 正文滚过：标题下面出一根细线（不然内容直接切在标题下）

  let panel = $state();
  let grab = $state();
  let dy = $state(0), dragging = $state(false);
  let dragged = false;   // 拖着关掉的：退场已经由手势走完，别再跳回来重播

  function portal(node) {
    const host = document.querySelector('.studio-root') || document.body;
    if (node.parentNode !== host) host.appendChild(node);
    return { destroy() { node.remove(); } };
  }
  onMount(() => {
    const off = pushLayer(() => onclose?.());
    if (wide) panel?.focus({ preventScroll: true });
    return off;
  });

  function enter(node, _p, opts = {}) {
    const leaving = opts.direction === 'out';
    if (reducedMotion() || node.closest('.sd-noanim')) return { duration: leaving ? 90 : 140, css: (k) => `opacity:${k}` };
    if (leaving && dragged) return { duration: 0 };
    if (wide) {
      return {
        duration: leaving ? 150 : SPRING_SOFT.ms,
        easing: leaving ? (k) => k * k : SPRING_SOFT.ease,
        css: (k, u) => `opacity:${Math.min(1, k * 1.6)};transform:translateY(${(u * 10).toFixed(2)}px) scale(${(1 - u * 0.03).toFixed(4)})`,
      };
    }
    const h = node.getBoundingClientRect().height + 24;
    return {
      duration: leaving ? 220 : SPRING_SOFT.ms + 80,
      easing: leaving ? (k) => k * k : SPRING_SOFT.ease,
      css: (_k, u) => `transform:translateY(${(u * h).toFixed(1)}px)`,
    };
  }
  // 手机：把手 / 标题行往下拖着关（核心 swipeDismiss：主轴占优才接管、松手按位移或甩速判定、弹簧归位）
  function drag(node) {
    if (wide) return {};
    const sw = swipeDismiss(node, {
      axis: 'y', dir: 1, threshold: 0.3, mouse: true,
      size: () => panel?.getBoundingClientRect().height || 400,
      onStart: () => { dragging = true; },
      onMove: (y) => { dy = y; },
      onSettle: (gone) => { dragging = false; if (gone) { dragged = true; onclose?.(); } else dy = 0; },
    });
    return sw;
  }
</script>

<div class="sh" class:wide class:tall use:portal role="presentation">
  <button class="sh-scrim" aria-label={t('关闭')} tabindex="-1" onclick={() => onclose?.()} in:fade|global={{ duration: 220 }} out:fade|global={{ duration: 200 }}
    style:opacity={dragging && panel ? Math.max(0, 1 - dy / (panel.getBoundingClientRect().height || 400)) : null}></button>
  <div bind:this={panel} class="sh-panel" class:scrolled role="dialog" aria-modal="true" aria-label={title} tabindex="-1"
    style:--sh-w="{width}px" style:transform={dy ? `translateY(${dy}px)` : null} in:enter|global out:enter|global>
    <div class="sh-head" bind:this={grab} use:drag>
      {#if !wide}<div class="sh-grip" aria-hidden="true"></div>{/if}
      <div class="sh-titles">
        <h2>{title}</h2>
        {#if sub}<p>{sub}</p>{/if}
      </div>
      <button class="sd-ib" aria-label={t('关闭')} onclick={() => onclose?.()}>{@html icon('close')}</button>
    </div>
    {#if head}<div class="sh-extra">{@render head()}</div>{/if}
    <div class="sh-body" onscroll={(e) => (scrolled = e.currentTarget.scrollTop > 2)}>{@render children?.()}</div>
  </div>
</div>
