<script>
  // 输入栏「/」命令菜单（纯渲染：过滤/键盘/选中都在 Composer 里）。行 = /名字 + 参数提示 +
  // 一行省略的描述；mousedown 拦掉默认行为，点选不会把焦点从输入框抢走。
  import { t, tr } from '../lib/i18n.js';
  let { items = [], active = 0, onPick, onHover } = $props();
  let listEl = $state();
  $effect(() => {
    const el = listEl && listEl.children && listEl.children[active];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  });
</script>

<div class="sm" role="listbox" aria-label={t('斜杠命令')} bind:this={listEl}>
  {#each items as c, i (c.name)}
    <button class="sm-row" class:on={i === active} role="option" aria-selected={i === active}
      onmousedown={(e) => e.preventDefault()} onclick={() => onPick && onPick(c)} onpointerenter={() => onHover && onHover(i)}>
      <span class="sm-name">/{c.name}{#if c.argumentHint}<span class="sm-arg"> {c.argumentHint}</span>{/if}</span>
      {#if c.description}<span class="sm-desc">{tr(c.description)}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .sm {
    position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); z-index: 61;
    max-height: 46vh; overflow-y: auto; overscroll-behavior: contain; padding: 6px;
    background: var(--q-card); border-radius: 12px; box-shadow: var(--q-shadow);
    animation: smPop var(--mo-quick, .16s) var(--ea-decel, ease-out);
  }
  @keyframes smPop { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .sm-row { width: 100%; display: flex; align-items: baseline; gap: 10px; padding: 7px 10px; border-radius: 8px; text-align: left; min-width: 0; }
  .sm-row.on { background: var(--hover); }
  .sm-name { flex: none; max-width: 55%; font-size: 13.5px; color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .sm-arg { color: var(--muted); font-size: 12px; margin-left: 5px; }
  .sm-desc { flex: 1; min-width: 0; font-size: 12px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
