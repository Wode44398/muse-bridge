<script>
  // 工作空间 · 桌面版（FilesDesktop）的右键菜单本体（条目由 fdMenus 给）：键盘在可用项间移动、首字母跳转，Esc / Tab 关闭并还焦点。
  // P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图；配色令牌由外壳 .fd-root 给。
  import { t } from '../../../lib/i18n.js';

  const { P } = $props();

  // 右键菜单的键盘：↑↓ / Home / End 在可用项间移动（跳过分隔线与禁用项）、首字母跳转，Enter / 空格由按钮自己执行，
  // Esc / Tab 关闭并把焦点还给打开前的行。挂原生监听并截住冒泡：window 上的列表快捷键（方向键换选中、Delete、空格速览）别跟着动
  function ctxNav(node) {
    const onKey = (e) => {
      e.stopPropagation();
      const items = [...node.querySelectorAll('.ctx-mi:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      const k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
        e.preventDefault();
        if (!items.length) return;
        const n = k === 'Home' ? 0 : k === 'End' ? items.length - 1
          : k === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
        items[n].focus({ preventScroll: true });
      } else if (k === 'Escape' || k === 'Tab') {
        e.preventDefault();
        P.closeMenu(true);
      } else if (k === 'Enter' || k === ' ') {
        if (i < 0) e.preventDefault();
      } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const ch = k.toLocaleLowerCase();
        const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
        order.find((b) => (b.querySelector('.ctx-lb')?.textContent || '').trim().toLocaleLowerCase().startsWith(ch))?.focus({ preventScroll: true });
      } else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) e.preventDefault();
    };
    node.addEventListener('keydown', onKey);
    return { destroy() { node.removeEventListener('keydown', onKey); } };
  }
  // 鼠标划过即把焦点给那一项（同系统菜单：之后按 ↑↓ 从这一项接着走）
  function ctxHover(e) {
    const b = e.currentTarget;
    if (e.pointerType === 'mouse' && !b.disabled && document.activeElement !== b) try { b.focus({ preventScroll: true }); } catch {}
  }
</script>

  <!-- 右键菜单 -->
  {#if P.menu}
    <button class="menu-scrim" aria-label={t('关闭')} tabindex="-1" onclick={() => P.closeMenu(true)} oncontextmenu={P.reMenu}></button>
    <div class="ctx" role="menu" tabindex="-1" style="left:{P.menu.x}px; top:{P.menu.y}px" use:ctxNav>
      {#each P.menu.entries as en, i (i)}
        {#if en.sep}
          <div class="ctx-sep" role="separator"></div>
        {:else}
          <button class="ctx-mi" role="menuitem" tabindex="-1" class:danger={en.danger} class:accent={en.accent} class:bold={en.bold} disabled={en.disabled} onpointermove={ctxHover} onclick={() => P.menuRun(en)}>
            <span class="ctx-lb">{en.label}</span>
            {#if en.hint}<span class="ctx-hint">{en.hint}</span>{/if}
          </button>
        {/if}
      {/each}
    </div>
  {/if}

<style>
  /* 右键菜单 */
  .menu-scrim { position: fixed; inset: 0; z-index: 80; border: 0; background: transparent; cursor: default; padding: 0; }
  .ctx { position: fixed; z-index: 81; min-width: 236px; padding: 4px; background: var(--pop-bg); border: 1px solid var(--sep); border-radius: 12px; box-shadow: var(--ctx-shadow); animation: fd-pop var(--mo-quick, .2s) var(--ea-decel, ease-out) both; outline: none; }
  @keyframes fd-pop { from { opacity: 0; transform: scale(.96); } }
  .ctx-mi { display: flex; align-items: center; width: 100%; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: none; text-align: left; font-size: 14px; color: var(--ink); cursor: pointer; outline: none; white-space: nowrap; }
  /* 键盘焦点 = 高亮行（菜单里不画外圈）；鼠标划过同一种浅底 */
  .ctx-mi:focus-visible, .ctx-mi:hover:not(:disabled) { background: var(--pop-hover); }
  .ctx-mi:disabled { color: var(--ink3); cursor: default; }
  .ctx-mi.danger { color: var(--red); }
  .ctx-mi.accent { color: var(--blue); font-weight: 600; }
  .ctx-mi.bold { font-weight: 600; }
  .ctx-lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .ctx-hint { margin-left: 18px; font-size: 12px; color: var(--ink2); }
  .ctx-sep { height: 1px; margin: 4px 6px; background: var(--sep); }

</style>
