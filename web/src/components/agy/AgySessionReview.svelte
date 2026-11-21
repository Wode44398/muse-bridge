<script>
  // Antigravity 审阅面板：git 仓库直接复用核心 ReviewPanel（随 fsSync 自动重拉 worktree diff）；
  // 非 git 目录优雅退化为「本会话改过的文件」汇总列表，可展开查看行级净变更并跳转定位或预览。
  import { agyDock } from '../../lib/dock.svelte.js';
  import { agy, locateAgyFileInWorkspace } from '../../lib/agy/store.svelte.js';
  import { extractSessionModifiedFiles } from '../../lib/agy/workspace-logic.js';
  import { openPreview } from '../../lib/preview.svelte.js';
  import { t } from '../../lib/i18n.js';
  import ReviewPanel from '../dock/ReviewPanel.svelte';

  let openPaths = $state({});

  const isNonGit = $derived(Boolean(agyDock.meta && agyDock.meta.git === false));
  const sessionChanges = $derived(extractSessionModifiedFiles(agy.messages, agyDock.ws || agy.cwd));

  function toggleFile(key) {
    openPaths[key] = !openPaths[key];
  }

  function locateFile(absPath, ev) {
    ev?.stopPropagation?.();
    locateAgyFileInWorkspace(absPath);
  }

  function previewFile(absPath, ev) {
    ev?.stopPropagation?.();
    if (!absPath) return;
    openPreview({
      origin: 'agy',
      id: agy.sessionId || '',
      path: absPath,
      name: absPath.split(/[\\/]/).pop() || absPath,
    });
  }
</script>

{#if !isNonGit}
  <ReviewPanel dockState={agyDock} />
{:else}
  <div class="agy-srev">
    <div class="srev-banner">
      <div class="srev-title">
        <span class="msr4">edit_note</span>
        <span>{t('本会话改过的文件')}</span>
      </div>
      <div class="srev-note">{t('当前目录不是 Git 仓库，已汇总本轮对话内的文件变更')}</div>
    </div>

    {#if sessionChanges.files.length === 0}
      <div class="srev-empty">
        <span class="msr4">description</span>
        <span>{t('本会话暂无文件修改记录')}</span>
      </div>
    {:else}
      <div class="srev-summary">
        <span>{t('共 {n} 个文件', { n: sessionChanges.files.length })}</span>
        {#if sessionChanges.total.add > 0}
          <b class="add">+{sessionChanges.total.add}</b>
        {/if}
        {#if sessionChanges.total.del > 0}
          <b class="del">-{sessionChanges.total.del}</b>
        {/if}
      </div>

      <div class="srev-list">
        {#each sessionChanges.files as f (f.absPath)}
          {@const isOpen = openPaths[f.absPath] ?? (sessionChanges.files.length === 1)}
          <div class="srev-card">
            <div class="srev-head">
              <button type="button" class="srev-toggle" onclick={() => toggleFile(f.absPath)}>
                <span class="msr chev" class:open={isOpen}>expand_more</span>
                <span class="srev-path" title={f.absPath}>{f.path}</span>
                {#if f.editCount > 1}
                  <span class="srev-edits">{t('{n} 次修改', { n: f.editCount })}</span>
                {/if}
                <span class="srev-stat">
                  {#if f.added > 0}<b class="add">+{f.added}</b>{/if}
                  {#if f.removed > 0}<b class="del">-{f.removed}</b>{/if}
                </span>
              </button>

              <div class="srev-acts">
                <button
                  type="button"
                  class="srev-act"
                  onclick={(ev) => locateFile(f.absPath, ev)}
                  title={t('在文件面板中定位：{path}', { path: f.absPath })}
                  aria-label={t('在文件面板中定位：{path}', { path: f.absPath })}
                >
                  <span class="msr">folder_open</span>
                </button>
                <button
                  type="button"
                  class="srev-act"
                  onclick={(ev) => previewFile(f.absPath, ev)}
                  title={t('预览')}
                  aria-label={t('预览')}
                >
                  <span class="msr">open_in_new</span>
                </button>
              </div>
            </div>

            {#if isOpen}
              <div class="srev-diff sel-text">
                {#each f.lines as ln, li (li)}
                  <div class="srev-ln {ln.type}">
                    <span class="ln-no">{ln.oldNo ?? ''}</span>
                    <span class="ln-no">{ln.newNo ?? ''}</span>
                    <span class="ln-mark">{ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' '}</span>
                    <span class="ln-code">{ln.text || ' '}</span>
                  </div>
                {/each}
                {#if f.truncated}
                  <div class="srev-more">
                    {t('共 {total} 行变更，已折叠其余部分', { total: f.totalLines })}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .agy-srev {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .srev-banner {
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--ag-border);
    background: var(--ag-surface-1);
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .srev-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 560;
    color: var(--ag-on);
  }
  .srev-title .msr4 { font-size: 18px; color: var(--ag-accent); }
  .srev-note {
    font-size: 11.5px;
    color: var(--ag-on-dim);
  }
  .srev-empty {
    flex: 1;
    min-height: 180px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--ag-on-faint);
  }
  .srev-empty .msr4 { font-size: 24px; opacity: 0.7; }
  .srev-summary {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--ag-on-sub);
    padding: 0 2px;
  }
  .srev-summary b,
  .srev-stat b {
    font-family: var(--ag-mono);
    font-weight: 600;
  }
  .add { color: var(--ag-diff-add-fg); }
  .del { color: var(--ag-diff-del-fg); }

  .srev-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .srev-card {
    border-radius: 10px;
    border: 1px solid var(--ag-border);
    background: var(--ag-surface-1);
    overflow: hidden;
  }
  .srev-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-right: 6px;
  }
  .srev-toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 8px 6px 8px 8px;
    text-align: left;
    font-size: 12px;
    color: var(--ag-on);
  }
  .srev-toggle:hover { background: var(--ag-hover); }
  .chev {
    font-size: 16px;
    color: var(--ag-on-faint);
    transform: rotate(-90deg);
    transition: transform 0.14s ease;
    flex: none;
  }
  .chev.open { transform: rotate(0deg); }
  .srev-path {
    flex: 1;
    min-width: 0;
    font-family: var(--ag-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .srev-edits {
    font-size: 10.5px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--ag-surface-2);
    color: var(--ag-on-dim);
    flex: none;
  }
  .srev-stat {
    display: inline-flex;
    gap: 5px;
    font-size: 11.5px;
    flex: none;
  }
  .srev-acts {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .srev-act {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
  }
  .srev-act:hover { background: var(--ag-hover); color: var(--ag-accent); }
  .srev-act .msr { font-size: 16px; }

  .srev-diff {
    border-top: 1px solid var(--ag-divider);
    background: var(--ag-code-bg);
    max-height: 280px;
    overflow: auto;
    font-family: var(--ag-mono);
    font-size: 11.5px;
    line-height: 1.5;
  }
  .srev-ln {
    display: grid;
    grid-template-columns: 30px 30px 14px minmax(0, 1fr);
    padding: 0 8px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .srev-ln.add { background: var(--ag-diff-add-bg); color: var(--ag-diff-add-fg); }
  .srev-ln.del { background: var(--ag-diff-del-bg); color: var(--ag-diff-del-fg); }
  .srev-ln.ctx { color: var(--ag-code-on); }
  .ln-no {
    color: var(--ag-on-faint);
    text-align: right;
    padding-right: 5px;
    user-select: none;
  }
  .ln-mark { user-select: none; opacity: 0.85; }
  .srev-more {
    padding: 6px 10px;
    font-size: 11px;
    color: var(--ag-on-dim);
    border-top: 1px solid var(--ag-divider);
  }
</style>
