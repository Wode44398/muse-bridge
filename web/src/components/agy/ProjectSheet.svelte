<script>
  // 文件夹选择（mode=project，贴着输入框底栏的文件夹芯片弹出）与已隐藏对话（mode=hidden，居中对话框：恢复或彻底删除，删除点两次确认）。
  // 文件夹 = 新对话的工作目录：工作空间根（默认）/ 已保存的项目 / 最近用过的目录 / 选择其他文件夹。
  import { hasNativePickDirectory, nativePickDirectory } from '../../lib/nativeDesktop.js';
  import {
    agy,
    newAgyChat,
    selectProjectForNewChat,
    selectDirectoryForNewChat,
    createAgyProjectAt,
    restoreAgySession,
    restoreAllHiddenAgySessions,
    openAgySession,
  } from '../../lib/agy/store.svelte.js';
  import { purgeAgySession } from '../../lib/agy/session-manage.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tr } from '../../lib/i18n.js';
  import AgyPopover from './AgyPopover.svelte';

  const { mode = 'project', onClose } = $props();
  // 已隐藏列表里点了一次「删除」、等第二下确认的那一行
  let delConfirmId = $state('');
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
  <AgyPopover bind:this={pop} skin="var(--ag-bg)" anchor={agy.popAnchor} anchorEl={agy.popAnchorEl} width={340} title={t('工作空间文件夹')} {onClose}>
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
        <button type="button" class="agy-menu-row" onclick={() => selectProjectForNewChat(proj)} title={proj.path}>
          <span class="msr4 row-ico">folder</span>
          <span class="row-main">
            <span class="row-name">{proj.name}</span>
            <span class="row-desc">{proj.path}</span>
          </span>
          {#if agy.projectId === proj.id}<span class="msr4 row-chk">check</span>{/if}
        </button>
      {/each}
    {/if}

    {#if recent.length > 0}
      <div class="agy-menu-label">{t('最近用过')}</div>
      {#each recent as dir (dir.path)}
        {@const sel = !agy.projectId && samePath(agy.cwd, dir.path)}
        <button type="button" class="agy-menu-row" onclick={() => selectDirectoryForNewChat(dir.path)} title={dir.path}>
          <span class="msr4 row-ico">folder</span>
          <span class="row-main">
            <span class="row-name">{dir.name}{#if dir.parentHint}<span class="hint">{' · '}{dir.parentHint}</span>{/if}</span>
            <span class="row-desc">{dir.path}</span>
          </span>
          {#if sel}<span class="msr4 row-chk">check</span>{/if}
        </button>
      {/each}
    {/if}

    <div class="agy-menu-sep"></div>
    <button type="button" class="agy-menu-row dim" onclick={pickOther}>
      <span class="msr4 row-ico">folder_open</span>
      <span class="row-main"><span class="row-name">{t('选择其他文件夹…')}</span></span>
    </button>
  </AgyPopover>
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
