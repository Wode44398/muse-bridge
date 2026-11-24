<script>
  // 文件夹选择（mode=project，贴着顶栏文件夹按钮弹出）与已隐藏对话（mode=hidden，居中对话框：恢复或彻底删除，删除点两次确认）。
  // 文件夹 = 新对话的工作目录：工作空间根（默认）/ 已保存的项目 / 最近用过的目录 / 选择其他文件夹。
  // 已保存的项目与最近用过的目录支持长按 / 右键（桌面亦可点行尾 ⋯）弹出菜单，进行置顶或移除。
  import { hasNativePickDirectory, nativePickDirectory } from '../../lib/nativeDesktop.js';
  import {
    agy,
    newAgyChat,
    selectProjectForNewChat,
    selectDirectoryForNewChat,
    createAgyProjectAt,
    pinAgyProject,
    deleteAgyProject,
    restoreAgySession,
    restoreAllHiddenAgySessions,
    openAgySession,
  } from '../../lib/agy/store.svelte.js';
  import { purgeAgySession } from '../../lib/agy/session-manage.js';
  import { longPress } from '../../lib/agy/long-press.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tr } from '../../lib/i18n.js';
  import AgyPopover from './AgyPopover.svelte';
  import AgyContextMenu from './AgyContextMenu.svelte';
  import AgyPinIcon from './AgyPinIcon.svelte';

  const { mode = 'project', onClose } = $props();
  // 已隐藏列表里点了一次「删除」、等第二下确认的那一行
  let delConfirmId = $state('');
  // 长按 / 右键弹出的工作空间操作菜单：{ key, kind: 'project'|'recent', item, point, anchorEl, pointerId }
  let ctxMenu = $state(null);
  // 选完走弹层自己的 close()，菜单缩回顶栏的文件夹按钮再摘掉
  let pop = $state(null);
  const closePop = () => { if (pop) pop.close(); else agy.projectSheetOpen = false; };

  const baseName = (p = '') => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;

  function samePath(a = '', b = '') {
    const na = String(a || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const nb = String(b || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!na || !nb) return false;
    return /^[A-Za-z]:/.test(na) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
  }

  const isDefaultSel = $derived(!agy.projectId && (!agy.cwd || samePath(agy.cwd, agy.defaultCwd)));
  // 最近目录里去掉已作为项目列出的、以及工作空间根本身
  const recent = $derived(
    agy.recentDirs.filter((d) =>
      !samePath(d.path, agy.defaultCwd) && !agy.projects.some((p) => samePath(p.path, d.path))
    )
  );

  function openWorkspaceMenu(ev, kind, item) {
    const key = kind === 'project' ? `proj:${item.id}` : `rec:${item.path}`;
    ctxMenu = {
      key,
      kind,
      item,
      point: ev?.x != null && ev?.y != null ? { x: ev.x, y: ev.y } : null,
      anchorEl: ev?.el || null,
      pointerId: ev?.via === 'hold' ? ev.pointerId : null,
    };
  }

  function openMenuFromButton(ev, kind, item) {
    ev.stopPropagation();
    const el = ev.currentTarget;
    const r = el.getBoundingClientRect();
    openWorkspaceMenu({ x: r.left + r.width / 2, y: r.bottom, el, via: 'click' }, kind, item);
  }

  const ctxItems = $derived.by(() => {
    if (!ctxMenu) return [];
    const { kind, item } = ctxMenu;
    if (kind === 'project') {
      const pinned = Boolean(item.pinned);
      return [
        {
          id: pinned ? 'unpin' : 'pin',
          label: pinned ? t('取消置顶') : t('置顶'),
          icon: pinned ? 'unpin' : 'pin',
          onclick: () => pinAgyProject({ id: item.id, path: item.path, name: item.name, pinned: !pinned }),
        },
        { sep: true },
        {
          id: 'delete',
          label: t('删除'),
          icon: 'delete',
          danger: true,
          onclick: () => deleteAgyProject({ id: item.id, path: item.path, name: item.name }),
        },
      ];
    }
    return [
      {
        id: 'pin',
        label: t('置顶'),
        icon: 'pin',
        onclick: () => pinAgyProject({ path: item.path, name: item.name, pinned: true }),
      },
      { sep: true },
      {
        id: 'delete',
        label: t('删除'),
        icon: 'delete',
        danger: true,
        onclick: () => deleteAgyProject({ path: item.path, name: item.name }),
      },
    ];
  });

  function pickDefault() {
    newAgyChat({ projectId: '' });
    closePop();
    agy.drawerOpen = false;
  }

  async function pickOther() {
    if (hasNativePickDirectory()) {
      const picked = await nativePickDirectory(agy.cwd || agy.defaultCwd || '');
      if (!picked) return;
      try {
        await createAgyProjectAt(picked);
      } catch (err) {
        showToast(tr(err?.body?.error || err?.message) || t('添加文件夹失败'), 'err');
      }
      return;
    }
    onClose?.();
    agy.pickerOpen = true;
  }
</script>

{#if mode === 'project'}
  <AgyPopover bind:this={pop} skin="var(--ag-bg)" anchor={agy.popAnchor} anchorEl={agy.popAnchorEl} width={340} title={t('工作空间文件夹')} locked={!!ctxMenu} {onClose}>
    {#if agy.defaultCwd}
      <button type="button" class="agy-menu-row" class:cur={isDefaultSel} onclick={pickDefault} title={agy.defaultCwd}>
        <span class="msr4 row-ico">folder</span>
        <span class="row-main">
          <span class="row-name">{baseName(agy.defaultCwd)}</span>
          <span class="row-desc">{t('工作空间根目录（默认）')}</span>
        </span>
        {#if isDefaultSel}<span class="msr4 row-chk">check</span>{/if}
      </button>
    {/if}

    {#if agy.projects.length > 0}
      <div class="agy-menu-label">{t('项目')}</div>
      {#each agy.projects as proj (proj.id)}
        {@const cur = agy.projectId === proj.id}
        {@const target = ctxMenu?.key === `proj:${proj.id}`}
        <div
          class="ps-ws-wrap"
          class:menu-target={target}
          use:longPress={{ onTrigger: (ev) => openWorkspaceMenu(ev, 'project', proj) }}
        >
          <button
            type="button"
            class="agy-menu-row ps-ws-btn"
            class:cur
            onclick={() => selectProjectForNewChat(proj)}
            title={proj.path}
          >
            <span class="msr4 row-ico">folder</span>
            <span class="row-main">
              <span class="row-name">
                <span class="ps-name-tx">{proj.name}</span>
                {#if proj.pinned}
                  <span class="ps-pin-tag" title={t('已置顶')} aria-label={t('已置顶')}>
                    <AgyPinIcon filled size={12} />
                  </span>
                {/if}
              </span>
              <span class="row-desc">{proj.path}</span>
            </span>
            {#if cur}<span class="msr4 row-chk">check</span>{/if}
          </button>
          <button
            type="button"
            class="ps-ws-more"
            data-lp-ignore
            aria-label={t('工作空间操作')}
            title={t('工作空间操作')}
            onclick={(ev) => openMenuFromButton(ev, 'project', proj)}
          >
            <span class="msr">more_horiz</span>
          </button>
        </div>
      {/each}
    {/if}

    {#if recent.length > 0}
      <div class="agy-menu-label">{t('最近用过')}</div>
      {#each recent as dir (dir.path)}
        {@const sel = !agy.projectId && samePath(agy.cwd, dir.path)}
        {@const target = ctxMenu?.key === `rec:${dir.path}`}
        <div
          class="ps-ws-wrap"
          class:menu-target={target}
          use:longPress={{ onTrigger: (ev) => openWorkspaceMenu(ev, 'recent', dir) }}
        >
          <button
            type="button"
            class="agy-menu-row ps-ws-btn"
            class:cur={sel}
            onclick={() => selectDirectoryForNewChat(dir.path)}
            title={dir.path}
          >
            <span class="msr4 row-ico">folder</span>
            <span class="row-main">
              <span class="row-name">{dir.name}{#if dir.parentHint}<span class="hint">{' · '}{dir.parentHint}</span>{/if}</span>
              <span class="row-desc">{dir.path}</span>
            </span>
            {#if sel}<span class="msr4 row-chk">check</span>{/if}
          </button>
          <button
            type="button"
            class="ps-ws-more"
            data-lp-ignore
            aria-label={t('工作空间操作')}
            title={t('工作空间操作')}
            onclick={(ev) => openMenuFromButton(ev, 'recent', dir)}
          >
            <span class="msr">more_horiz</span>
          </button>
        </div>
      {/each}
    {/if}

    <div class="agy-menu-sep"></div>
    <button type="button" class="agy-menu-row dim" onclick={pickOther}>
      <span class="msr4 row-ico">folder_open</span>
      <span class="row-main"><span class="row-name">{t('选择其他文件夹…')}</span></span>
    </button>
  </AgyPopover>

  {#if ctxMenu}
    <AgyContextMenu
      point={ctxMenu.point}
      anchorEl={ctxMenu.anchorEl}
      pointerId={ctxMenu.pointerId}
      title={ctxMenu.item.name}
      subtitle={ctxMenu.item.path}
      items={ctxItems}
      onClose={() => { ctxMenu = null; }}
    />
  {/if}
{:else}
  <AgyPopover width={460} title={t('已隐藏的对话')} {onClose}>
    {#if agy.hiddenSessions.length === 0}
      <div class="ps-empty">{t('没有已隐藏的对话')}</div>
    {:else}
      {#each agy.hiddenSessions as hs (hs.sessionId)}
        <div class="ps-hidden-row">
          <button
            type="button"
            class="agy-menu-row"
            onclick={async () => {
              await restoreAgySession(hs.sessionId);
              onClose?.();
              await openAgySession(hs.sessionId);
            }}
          >
            <span class="row-main">
              <span class="row-name">{hs.title || t('未命名对话')}</span>
              {#if hs.cwd}<span class="row-desc">{hs.cwd}</span>{/if}
            </span>
          </button>
          <button type="button" class="ps-restore" onclick={() => { delConfirmId = ''; restoreAgySession(hs.sessionId); }}>
            {t('恢复')}
          </button>
          <button
            type="button"
            class="ps-restore ps-del"
            class:confirm={delConfirmId === hs.sessionId}
            onclick={() => {
              if (delConfirmId !== hs.sessionId) { delConfirmId = hs.sessionId; return; }
              delConfirmId = '';
              purgeAgySession(hs.sessionId);
            }}
          >
            {delConfirmId === hs.sessionId ? t('确认删除') : t('删除')}
          </button>
        </div>
      {/each}
      <div class="agy-menu-sep"></div>
      <button type="button" class="agy-menu-row dim" onclick={() => restoreAllHiddenAgySessions()}>
        <span class="msr4 row-ico">restore</span>
        <span class="row-main"><span class="row-name">{t('全部恢复')}</span></span>
      </button>
    {/if}
  </AgyPopover>
{/if}

<style>
  .hint { color: var(--ag-on-faint); }
  .ps-ws-wrap {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: 8px;
    -webkit-touch-callout: none;
    user-select: none;
    transition: transform 160ms var(--ag-ease-std), background var(--ag-dur-micro) var(--ag-ease-std);
  }
  :global(.agy-pop-root.sheet) .ps-ws-wrap {
    border-radius: 999px;
  }
  .ps-ws-wrap:global(.lp-arming) {
    transform: scale(0.975);
    background: var(--ag-active);
  }
  .ps-ws-wrap.menu-target {
    background: var(--ag-active);
  }
  .ps-ws-btn {
    flex: 1;
    min-width: 0;
  }
  .ps-ws-btn .row-name {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
  }
  .ps-name-tx {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .ps-pin-tag {
    flex: none;
    display: inline-flex;
    align-items: center;
    color: var(--ag-on-faint);
    opacity: 0.85;
  }
  .ps-ws-btn.cur .ps-pin-tag {
    color: var(--ag-accent);
    opacity: 1;
  }

  /* 桌面悬停辅助入口：触屏保持纯粹长按，不占行尾空间 */
  .ps-ws-more {
    display: none;
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    width: 26px;
    height: 26px;
    border-radius: 7px;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-faint);
    opacity: 0;
    transition: opacity var(--ag-dur-micro) var(--ag-ease-std), background var(--ag-dur-micro) var(--ag-ease-std), color var(--ag-dur-micro) var(--ag-ease-std);
  }
  .ps-ws-more .msr { font-size: 17px; }
  @media (hover: hover) and (pointer: fine) {
    .ps-ws-more { display: inline-flex; }
    .ps-ws-wrap:hover .ps-ws-more,
    .ps-ws-wrap.menu-target .ps-ws-more,
    .ps-ws-more:focus-visible {
      opacity: 1;
    }
    .ps-ws-wrap:hover .ps-ws-btn .row-chk,
    .ps-ws-wrap.menu-target .ps-ws-btn .row-chk {
      opacity: 0;
    }
    .ps-ws-more:hover {
      background: var(--ag-active);
      color: var(--ag-on);
    }
  }

  .ps-empty {
    padding: 28px 12px;
    text-align: center;
    font-size: 13px;
    color: var(--ag-on-faint);
  }
  .ps-hidden-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .ps-restore {
    flex: none;
    height: 28px;
    padding: 0 12px;
    border-radius: 14px;
    font-size: 12.5px;
    color: var(--ag-on-sub);
  }
  .ps-restore:hover { background: var(--ag-hover); color: var(--ag-on); }
  .ps-del { padding: 0 10px; color: var(--ag-on-faint); }
  .ps-del:hover,
  .ps-del.confirm { color: var(--ag-err); }
</style>
