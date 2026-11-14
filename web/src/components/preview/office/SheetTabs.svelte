<script>
  // 工作表标签条（SheetGrid 底栏、触屏外框底栏共用）：一排胶囊，当前表是强调色淡底 + 深珊瑚字（全查看器统一的「选中」样式，
  //   不再用实底墨色——别处的选中、开关都是强调色）。电脑悬停提示带换表快捷键（Alt+↑ / Alt+↓）。
  //   隐藏的表不出标签（菜单「工作表」里仍能切过去）；标签多了横向滚动，鼠标竖滚轮也换成横滚；
  //   当前标签换了会滚进可视区；方向键在标签间移动（roving tabindex，吃掉这一下，不让外框拿去翻文件）。
  // props：sheets（[{ name, hidden }]）· active（当前表下标）· onpick(i, via)（via：'pointer' 鼠标 / 手指点的、'key' 键盘）· touch（胶囊加高、命中区 44）
  import { t } from '../../../lib/i18n.js';
  import { tip } from '../kit/tooltip.js';

  let { sheets = [], active = 0, onpick, touch = false } = $props();

  let strip = $state(null);
  const shown = $derived(sheets.map((s, i) => ({ i, name: s.name, hidden: !!s.hidden })).filter((s) => !s.hidden));

  // 当前标签滚进可视区（只动标签条自己，不用 scrollIntoView：它会顺带滚外层）
  $effect(() => {
    const i = active;
    if (!strip) return;
    const el = strip.querySelector(`[data-i="${i}"]`);
    if (!el) return;
    const l = el.offsetLeft, r = l + el.offsetWidth, pad = 24;
    if (l - pad < strip.scrollLeft) strip.scrollLeft = Math.max(0, l - pad);
    else if (r + pad > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r + pad - strip.clientWidth;
  });

  function onKey(e) {
    // 带 Ctrl / Alt / ⌘ 的（Ctrl+Home、Ctrl+PageDown …）不归标签条管，照常冒泡给表格
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const at = shown.findIndex((s) => s.i === active);
    let n = at;
    if (e.key === 'ArrowLeft') n = Math.max(0, at - 1);
    else if (e.key === 'ArrowRight') n = Math.min(shown.length - 1, at + 1);
    else if (e.key === 'Home') n = 0;
    else n = shown.length - 1;
    e.preventDefault(); e.stopPropagation();
    if (n !== at && shown[n]) {
      onpick?.(shown[n].i, 'key');
      queueMicrotask(() => strip?.querySelector(`[data-i="${shown[n].i}"]`)?.focus({ preventScroll: true }));
    }
  }

  // 竖滚轮 → 横滚（标签条放不下时才接管；放得下就让事件照常冒泡）
  function wheelX(node) {
    const on = (e) => {
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || node.scrollWidth <= node.clientWidth + 1) return;
      e.preventDefault();
      node.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    };
    node.addEventListener('wheel', on, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', on) };
  }
</script>

<div class="st" class:touch bind:this={strip} use:wheelX role="tablist" aria-label={t('工作表')} tabindex="-1" onkeydown={onKey}>
  {#each shown as s (s.i)}
    <button type="button" class="st-tab" class:on={s.i === active} role="tab" aria-selected={s.i === active}
      tabindex={s.i === active ? 0 : -1} data-i={s.i} use:tip={{ label: s.name, kbd: 'Alt+↑ / Alt+↓' }} onclick={(e) => onpick?.(s.i, e.detail ? 'pointer' : 'key')}><span class="st-n">{s.name}</span></button>
  {/each}
</div>

<style>
  .st { display: flex; align-items: center; gap: 2px; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
    overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; }
  .st::-webkit-scrollbar { display: none; }
  .st-tab { position: relative; flex: none; max-width: 180px; height: 26px; padding: 0 11px; border: 0; border-radius: 999px;
    background: none; color: var(--md-fg-2); font: inherit; font-size: 12.5px; line-height: 26px; cursor: pointer;
    white-space: nowrap; -webkit-tap-highlight-color: transparent;
    transition: background-color var(--mo-tap) var(--ea-out), color var(--mo-micro) var(--ea-out); }
  .st-n { display: block; overflow: hidden; text-overflow: ellipsis; }
  @media (hover: hover) { .st-tab:not(.on):hover { background: rgba(var(--md-ink), .06); color: var(--md-fg); } }
  .st-tab:active:not(.on) { background: rgba(var(--md-ink), .1); }
  .st-tab.on { background: var(--md-accent-tint); color: var(--md-accent-deep); font-weight: 600; cursor: default; }
  .st-tab:focus-visible { outline: 1.5px solid var(--md-fg-3); outline-offset: 1px; }
  /* 触屏：视觉 34，命中区上下各补 5 到 44 */
  .st.touch { gap: 6px; padding: 0 2px; }
  .st.touch .st-tab { height: 34px; line-height: 34px; padding: 0 14px; font-size: 14px; max-width: 200px; }
  .st.touch .st-tab::after { content: ''; position: absolute; left: 0; right: 0; top: -5px; bottom: -5px; }
  @media (prefers-reduced-motion: reduce) { .st-tab { transition: none; } }
</style>
