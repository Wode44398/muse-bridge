<script>
  // 工具调用（11-18 翻新为单行步骤）：语义图标 + 动词 + 对象，点开看命令输出、文件位置与行级 diff。
  import { classifyToolKind, computeDiffLines } from '../../lib/agy/logic.js';
  import { relativeToWorkspace } from '../../lib/agy/workspace-logic.js';
  import { agy, locateAgyFileInWorkspace } from '../../lib/agy/store.svelte.js';
  import { openPreview } from '../../lib/preview.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  const { tool, sessionId = '' } = $props();

  let expanded = $state(false);

  const locPathOf = (loc) => (typeof loc === 'string' ? loc : String(loc?.path || ''));

  const meta = $derived(classifyToolKind(tool, { sessionCwd: agy.cwd }));
  const isRunning = $derived(tool.status === 'in_progress' || tool.status === 'pending');
  const isCancelled = $derived(tool.status === 'cancelled');
  const isFailed = $derived(
    !isCancelled && (
      tool.status === 'failed' || tool.status === 'error'
      || (tool.exitCode !== null && tool.exitCode !== undefined && Number(tool.exitCode) !== 0)
    )
  );

  const computedDiffs = $derived.by(() => {
    const raw = Array.isArray(tool.diffs) ? tool.diffs : [];
    const fallbackPath = tool.locations?.length ? locPathOf(tool.locations[0]) : '';
    return raw.map((d) => ({
      path: d.path || fallbackPath,
      ...computeDiffLines(d.oldText ?? '', d.newText ?? ''),
    }));
  });

  const diffTotals = $derived.by(() => {
    let added = 0;
    let removed = 0;
    for (const d of computedDiffs) {
      added += d.added;
      removed += d.removed;
    }
    return { added, removed };
  });

  // 入参：没有命令行可看的工具（bridge 工具、扩展连接器……）展开时列出来；agy 自己加的 toolSummary 不算参数。
  // 有返回内容时入参在上、返回在下（以前一有返回就不显示入参了）。
  const shownArgs = $derived.by(() => {
    const a = tool.args && typeof tool.args === 'object' ? { ...tool.args } : {};
    delete a.toolSummary;
    return a;
  });
  const showArgs = $derived(!tool.command && Object.keys(shownArgs).length > 0);
  const argsText = $derived(showArgs ? JSON.stringify(shownArgs, null, 2) : '');

  const hasDetail = $derived(Boolean(
    tool.command
    || tool.output
    || computedDiffs.length > 0
    || (Array.isArray(tool.locations) && tool.locations.length > 0)
    || (tool.args && Object.keys(tool.args).length > 0)
  ));

  function displayFilePath(filePath) {
    const rel = relativeToWorkspace(filePath, agy.cwd);
    if (rel) return rel;
    const norm = String(filePath || '').replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);
    return parts.length > 3 ? parts.slice(-3).join('/') : String(filePath || '');
  }

  function locatePath(filePath, ev) {
    ev?.stopPropagation?.();
    if (!filePath) return;
    locateAgyFileInWorkspace(filePath);
  }

  function previewPath(filePath, ev) {
    ev?.stopPropagation?.();
    if (!filePath) return;
    const baseName = String(filePath).split(/[\\/]/).pop() || filePath;
    if (locateAgyFileInWorkspace(filePath, { openFile: true })) return;
    openPreview({
      origin: 'agy',
      id: sessionId,
      path: filePath,
      name: baseName,
    });
  }
</script>

<div
  class="agy-tool"
  class:open={expanded}
  class:running={isRunning}
  class:cancelled={isCancelled}
  class:failed={isFailed}
  data-agy-tool={tool.toolCallId || undefined}
>
  <button
    type="button"
    class="agy-tool-head"
    disabled={!hasDetail}
    onclick={() => { if (hasDetail) expanded = !expanded; }}
    aria-expanded={expanded}
  >
    <span class="agy-tool-status" aria-hidden="true">
      {#if isRunning}
        <span class="agy-spin"></span>
      {:else if isCancelled}
        <span class="msr4 cancel">stop_circle</span>
      {:else if isFailed}
        <span class="msr4 err">error</span>
      {:else}
        <span class="msr4 ok">{meta.icon}</span>
      {/if}
    </span>

    <span class="agy-tool-verb">{meta.verb}</span>
    <span class="agy-tool-sum">{tr(meta.summary)}</span>

    {#if tool.approvalState === 'allowed'}
      <span class="agy-approval-badge allowed">{t('已允许')}</span>
    {:else if tool.approvalState === 'denied'}
      <span class="agy-approval-badge denied">{t('已拒绝')}</span>
    {/if}

    {#if isCancelled && tool.approvalState !== 'denied'}
      <span class="agy-cancel-badge">{t('已取消')}</span>
    {/if}

    {#if computedDiffs.length > 0 && (diffTotals.added > 0 || diffTotals.removed > 0)}
      <span class="agy-diff-stat">
        {#if diffTotals.added > 0}<b class="add">+{diffTotals.added}</b>{/if}
        {#if diffTotals.removed > 0}<b class="del">-{diffTotals.removed}</b>{/if}
      </span>
    {/if}

    {#if tool.exitCode !== null && tool.exitCode !== undefined && Number(tool.exitCode) !== 0}
      <span class="agy-exit">{t('退出码 {code}', { code: tool.exitCode })}</span>
    {/if}

    {#if hasDetail}
      <span class="msr agy-tool-chev" aria-hidden="true">
        {expanded ? 'expand_less' : 'expand_more'}
      </span>
    {/if}
  </button>

  {#if expanded && hasDetail}
    <div class="agy-tool-body">
      {#if Array.isArray(tool.locations) && tool.locations.length > 0 && computedDiffs.length === 0}
        <div class="agy-tool-locs">
          {#each tool.locations as loc, li (locPathOf(loc) || li)}
            {@const lp = locPathOf(loc)}
            {#if lp}
              <div class="agy-loc-group">
                <button
                  type="button"
                  class="agy-loc-chip"
                  onclick={(ev) => locatePath(lp, ev)}
                  title={t('在文件面板中定位：{path}', { path: lp })}
                >
                  <span class="msr">folder_open</span>
                  <span class="agy-loc-txt">{lp.split(/[\\/]/).slice(-2).join('/')}{loc?.line ? `:${loc.line}` : ''}</span>
                </button>
                <button
                  type="button"
                  class="agy-loc-pv"
                  onclick={(ev) => previewPath(lp, ev)}
                  title={t('预览')}
                  aria-label={t('预览')}
                >
                  <span class="msr">open_in_new</span>
                </button>
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      {#if tool.command}
        <div class="agy-cmd-box sel-text">
          <span class="agy-cmd-ps">$</span>
          <code>{tool.command}</code>
        </div>
      {/if}

      {#if showArgs && tool.output}
        <pre class="agy-tool-out sel-text">{argsText}</pre>
      {/if}

      {#if tool.output}
        <pre class="agy-tool-out sel-text" class:err={isFailed}>{tool.output}</pre>
      {/if}

      {#if computedDiffs.length > 0}
        {#each computedDiffs as d, idx (d.path || idx)}
          <div class="agy-diff-card">
            {#if d.path}
              <div class="agy-diff-file">
                <button
                  type="button"
                  class="agy-diff-path"
                  onclick={(ev) => locatePath(d.path, ev)}
                  title={t('在文件面板中定位：{path}', { path: d.path })}
                >
                  <span class="msr">folder_open</span>
                  <span>{displayFilePath(d.path)}</span>
                </button>
                <button type="button" class="agy-diff-open" onclick={(ev) => previewPath(d.path, ev)}>
                  <span class="msr">open_in_new</span>
                  <span>{t('预览')}</span>
                </button>
              </div>
            {/if}
            <div class="agy-diff-scroll sel-text">
              {#each d.lines as ln, li (li)}
                <div class="agy-diff-ln {ln.type}">
                  <span class="ln-no">{ln.oldNo ?? ''}</span>
                  <span class="ln-no">{ln.newNo ?? ''}</span>
                  <span class="ln-mark">{ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' '}</span>
                  <span class="ln-code">{ln.text || ' '}</span>
                </div>
              {/each}
              {#if d.truncated}
                <div class="agy-diff-more">
                  {t('共 {total} 行变更，已折叠其余部分', { total: d.totalLines })}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      {:else if showArgs && !tool.output}
        <pre class="agy-tool-out sel-text">{argsText}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* 单行步骤：图标 · 动词 · 对象（等宽、弱化）· 右侧状态；无边框无底色，悬停才浮出底色 */
  .agy-tool { border-radius: 8px; }
  .agy-tool.open { background: var(--ag-surface-1); }

  .agy-tool-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
    border-radius: 8px;
    text-align: left;
    font-size: 13px;
    color: var(--ag-on-sub);
    min-width: 0;
  }
  .agy-tool-head:not(:disabled):hover { background: var(--ag-hover); }
  .agy-tool.open .agy-tool-head:hover { background: transparent; }
  .agy-tool-head:disabled { cursor: default; }

  .agy-tool-status {
    width: 18px;
    height: 18px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .agy-tool-status .msr4 { font-size: 16px; }
  .agy-tool-status .msr4.ok { color: var(--ag-on-faint); }
  .agy-tool-status .msr4.cancel { color: var(--ag-on-faint); }
  .agy-tool-status .msr4.err { color: var(--ag-err); }
  .agy-spin {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1.6px solid var(--ag-border-strong);
    border-top-color: var(--ag-accent);
    animation: agy-tool-spin 0.8s linear infinite;
  }
  @keyframes agy-tool-spin { to { transform: rotate(360deg); } }

  .agy-tool-verb { flex: none; color: var(--ag-on-sub); font-weight: 500; }
  .agy-tool.running .agy-tool-verb { color: var(--ag-on); }
  .agy-tool.failed .agy-tool-verb { color: var(--ag-err); }
  .agy-tool-sum {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--ag-mono);
    font-size: 12px;
    color: var(--ag-on-faint);
  }

  .agy-cancel-badge,
  .agy-approval-badge {
    flex: none;
    font-size: 11.5px;
    color: var(--ag-on-faint);
  }
  .agy-approval-badge.denied { color: var(--ag-err); }

  .agy-diff-stat {
    flex: none;
    display: inline-flex;
    gap: 6px;
    font-family: var(--ag-mono);
    font-size: 11.5px;
  }
  .agy-diff-stat b { font-weight: 500; }
  .agy-diff-stat .add { color: var(--ag-ok); }
  .agy-diff-stat .del { color: var(--ag-err); }
  .agy-exit {
    flex: none;
    font-family: var(--ag-mono);
    font-size: 11.5px;
    color: var(--ag-err);
  }

  .agy-tool-chev {
    flex: none;
    font-size: 16px;
    color: var(--ag-on-faint);
    opacity: 0;
  }
  .agy-tool-head:hover .agy-tool-chev,
  .agy-tool.open .agy-tool-chev { opacity: 1; }

  /* —— 展开详情 —— */
  .agy-tool-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 2px 10px 10px 34px;
    min-width: 0;
  }
  .agy-tool-locs { display: flex; flex-wrap: wrap; gap: 4px; }
  .agy-loc-group {
    display: inline-flex;
    align-items: center;
    border-radius: 7px;
    background: var(--ag-surface-2);
    min-width: 0;
    max-width: 100%;
  }
  .agy-loc-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 8px;
    border-radius: 7px;
    font-size: 12px;
    color: var(--ag-on-sub);
    min-width: 0;
  }
  .agy-loc-chip:hover { color: var(--ag-on); }
  .agy-loc-chip .msr { font-size: 14px; color: var(--ag-on-faint); }
  .agy-loc-txt {
    font-family: var(--ag-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agy-loc-pv {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-faint);
    flex: none;
  }
  .agy-loc-pv:hover { color: var(--ag-on); }
  .agy-loc-pv .msr { font-size: 14px; }

  .agy-cmd-box {
    display: flex;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--ag-code-bg);
    font-family: var(--ag-mono);
    font-size: 12px;
    line-height: 1.55;
    color: var(--ag-code-on);
    min-width: 0;
  }
  .agy-cmd-box code {
    white-space: pre-wrap;
    word-break: break-all;
    font-family: inherit;
  }
  .agy-cmd-ps { color: var(--ag-on-faint); flex: none; user-select: none; }
  .agy-tool-out {
    margin: 0;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--ag-code-bg);
    color: var(--ag-on-dim);
    font-family: var(--ag-mono);
    font-size: 12px;
    line-height: 1.55;
    max-height: 280px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .agy-tool-out.err { color: var(--ag-err); }

  .agy-diff-card {
    border-radius: 8px;
    overflow: hidden;
    background: var(--ag-code-bg);
  }
  .agy-diff-file {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 6px 4px 4px;
    border-bottom: 1px solid var(--ag-divider);
  }
  .agy-diff-path {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 6px;
    border-radius: 6px;
    font-family: var(--ag-mono);
    font-size: 12px;
    color: var(--ag-on-sub);
    min-width: 0;
  }
  .agy-diff-path span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agy-diff-path:hover { background: var(--ag-hover); color: var(--ag-on); }
  .agy-diff-path .msr { font-size: 14px; color: var(--ag-on-faint); }
  .agy-diff-open {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--ag-on-dim);
    flex: none;
  }
  .agy-diff-open:hover { background: var(--ag-hover); color: var(--ag-on); }
  .agy-diff-open .msr { font-size: 14px; }
  .agy-diff-scroll {
    max-height: 340px;
    overflow: auto;
    font-family: var(--ag-mono);
    font-size: 12px;
    line-height: 1.6;
    padding: 4px 0;
  }
  .agy-diff-ln {
    display: flex;
    min-width: max-content;
    padding-right: 12px;
  }
  .agy-diff-ln.add { background: var(--ag-diff-add-bg); color: var(--ag-diff-add-fg); }
  .agy-diff-ln.del { background: var(--ag-diff-del-bg); color: var(--ag-diff-del-fg); }
  .agy-diff-ln.ctx { color: var(--ag-code-on); }
  .ln-no {
    width: 38px;
    flex: none;
    text-align: right;
    padding-right: 8px;
    color: var(--ag-on-low);
    user-select: none;
  }
  .ln-mark { width: 16px; flex: none; text-align: center; user-select: none; opacity: 0.8; }
  .ln-code { white-space: pre; }
  .agy-diff-more {
    padding: 6px 12px;
    font-size: 11.5px;
    color: var(--ag-on-faint);
    font-family: var(--ag-sans);
  }

  @media (max-width: 599px) {
    .agy-tool-body { padding-left: 10px; }
  }
</style>
