<script>
  // 小菜单（新建策略、把图上的点设为某档的指定模型）：挪到 body 上的 fixed 浮层，贴着一个点或一个矩形展开。
  // 外观跟输入栏的模型菜单是一家（同一组全局令牌 --q-card / --q-shadow / --text / --muted），不依赖设置外壳的令牌。
  // items: [{ label, sub?, color?（档色小方块：要给具体色值，这里读不到子页根上的 --dp-t-*）, disabled?, onclick }]；
  // at: { x, y } 或 { rect }（视口坐标）。
  import { pushBackLayer } from '../../../lib/nav.js';
  import { portal, escLayer, fitPopover } from './dpDom.js';
  import { menuStep } from './dpUtil.js';
  import { t } from '../../../lib/i18n.js';

  let { at = null, title = '', items = [], onClose } = $props();

  $effect(() => pushBackLayer(() => { onClose?.(); }));
  $effect(() => escLayer(() => onClose?.()));
  // 窗口尺寸变了位置就不对了：直接收起
  $effect(() => {
    const h = () => onClose?.();
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  });

  let menu = $state();
  $effect(() => { menu?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }); });
  function key(e) {
    const rows = [...(menu?.querySelectorAll('button:not(:disabled)') || [])];
    const j = menuStep(e.key, rows.indexOf(document.activeElement), rows.length);   // ↑ ↓ Home End；别的键回 -1
    if (j < 0) return;
    e.preventDefault();
    rows[j].focus();
  }
  function run(it) {
    onClose?.();
    it.onclick?.();
  }
</script>

<div class="dpm-layer" use:portal>
  <button type="button" class="dpm-backdrop" tabindex="-1" aria-label={t('关闭')} onclick={() => onClose?.()}></button>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="dpm" role="menu" tabindex="-1" bind:this={menu} use:fitPopover={at} onkeydown={key}>
    {#if title}<div class="dpm-title">{title}</div>{/if}
    {#each items as it, i (i)}
      <button type="button" class="dpm-row" role="menuitem" disabled={it.disabled} onclick={() => run(it)}>
        {#if it.color}<span class="dpm-sw" style:background={it.color} aria-hidden="true"></span>{/if}
        <span class="dpm-name">{it.label}</span>
        {#if it.sub}<span class="dpm-sub">{it.sub}</span>{/if}
      </button>
    {/each}
  </div>
</div>

<style>
  /* 整屏一层，压在设置页（60）之上；里面是透明遮罩和菜单本体 */
  .dpm-layer { position: fixed; inset: 0; z-index: 1000; }
  .dpm-backdrop { position: fixed; inset: 0; z-index: 60; border: 0; padding: 0; background: transparent; cursor: default; }
  .dpm {
    position: fixed; left: 0; top: 0; z-index: 61; min-width: 172px; max-width: min(320px, 88vw); padding: 6px 0; outline: none;
    background: var(--q-card); border-radius: 10px; box-shadow: var(--q-shadow);
    max-height: 60vh; overflow-y: auto; font-family: var(--sans);
    animation: dpm-pop var(--mo-quick) var(--ea-decel);
  }
  @keyframes dpm-pop { from { opacity: 0; transform: scale(.97); } }
  .dpm-title { padding: 4px 12px 4px; font-size: 12px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .dpm-row { width: 100%; min-height: 30px; display: flex; align-items: center; gap: 9px; padding: 5px 12px; border: 0; background: transparent;
    text-align: left; font: inherit; color: var(--text); cursor: pointer; }
  .dpm-row:active:not(:disabled) { background: var(--hover); }
  .dpm-row:focus-visible { outline: none; background: var(--hover); }
  .dpm-row:disabled { opacity: .4; cursor: default; }
  @media (hover: hover) { .dpm-row:hover:not(:disabled) { background: var(--hover); } }
  .dpm-sw { flex: none; width: 9px; height: 9px; border-radius: 2.5px; }
  .dpm-name { flex: 1; min-width: 0; font-size: 13.5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .dpm-sub { flex: none; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  /* 触屏：行高放到 40、字号 15（手指点得准） */
  @media (pointer: coarse) { .dpm-row { min-height: 40px; } .dpm-name { font-size: 15px; } .dpm-sub { font-size: 13px; } }
  @media (prefers-reduced-motion: reduce) { .dpm { animation: none; } }
</style>
