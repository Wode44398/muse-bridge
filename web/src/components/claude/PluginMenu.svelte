<script>
  // 插件动作的小弹出菜单（消息操作排的「⋯」，ctx.ui.messageAction）：锚在按钮旁，fixed 定位、贴边收进视口；
  // 点外面 / Esc / 安卓返回收起。行 = 插件给的图标 + 文字，右侧小字标出自哪个插件。
  import { onMount } from 'svelte';
  import { pushBackLayer } from '../../lib/nav.js';
  import { uiIcon } from '../../lib/pluginUi.svelte.js';
  import { t } from '../../lib/i18n.js';

  // anchor：触发按钮的 DOMRect；items：[{ plugin, pluginName, id, label, icon }]
  let { anchor, items = [], onPick, onClose } = $props();

  const W = 236;
  const ROW = 38;
  const pos = $derived.by(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const h = Math.min(items.length * ROW + 12, 300);
    const left = Math.max(8, Math.min(anchor.left, vw - W - 8));
    const below = vh - anchor.bottom - 8 >= h || anchor.top < h + 8;
    return below ? `left:${left}px;top:${anchor.bottom + 4}px` : `left:${left}px;bottom:${vh - anchor.top + 4}px`;
  });

  let el = $state();
  $effect(() => pushBackLayer(() => onClose?.()));
  onMount(() => {
    el?.querySelector('.pm-i')?.focus({ preventScroll: true });
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
</script>

<button class="pm-bd" aria-label={t('关闭')} tabindex="-1" onclick={() => onClose?.()}></button>
<div class="pm" role="menu" style={pos} bind:this={el}>
  {#each items as a (a.plugin + '/' + a.id)}
    <button class="pm-i" role="menuitem" title={a.pluginName} onclick={() => { onPick?.(a); onClose?.(); }}>
      <span class="pm-ic" aria-hidden="true">{@html uiIcon(a.icon)}</span>
      <span class="pm-lab">{a.label}</span>
      <span class="pm-from">{a.pluginName}</span>
    </button>
  {/each}
</div>

<style>
  .pm-bd { position: fixed; inset: 0; z-index: 70; border: 0; background: transparent; cursor: default; }
  .pm {
    position: fixed; z-index: 71; width: 236px; max-width: calc(100vw - 16px); max-height: 300px; overflow-y: auto; padding: 5px;
    background: var(--q-card); border-radius: 12px; box-shadow: var(--q-shadow);
    display: flex; flex-direction: column; animation: pmPop .14s ease;
  }
  @keyframes pmPop { from { opacity: 0; transform: translateY(3px); } }
  .pm-i { display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 0 10px; border-radius: 8px; width: 100%; text-align: left; color: var(--text); font-size: 14px; }
  .pm-i:active { background: var(--hover); }
  @media (hover: hover) { .pm-i:hover, .pm-i:focus-visible { background: var(--hover); outline: none; } }
  .pm-ic { width: 17px; height: 17px; flex: none; display: flex; color: var(--serif); }
  .pm-ic :global(svg) { width: 100%; height: 100%; }
  .pm-lab { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .pm-from { flex: none; max-width: 40%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11.5px; color: var(--muted); }
</style>
