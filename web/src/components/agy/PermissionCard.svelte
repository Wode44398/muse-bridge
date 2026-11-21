<script>
  // 权限审批卡：清晰呈现工具类型、简要说明与目标命令行/文件路径，重连重放后准确还原处理结果。
  import { agy, submitAgyPermission } from '../../lib/agy/store.svelte.js';
  import { classifyToolKind, stripWorkspaceCdPrefix } from '../../lib/agy/logic.js';
  import { t, tr } from '../../lib/i18n.js';

  const { perm, sessionCwd = '' } = $props();

  let submitting = $state(false);
  const effectiveCwd = $derived(sessionCwd || agy.cwd || '');

  const toolMeta = $derived(classifyToolKind({
    name: perm.toolName,
    kind: perm.kind,
    title: perm.title,
    command: perm.command,
    locations: perm.locations,
    args: perm.args,
  }, { sessionCwd: effectiveCwd }));

  const displayCommand = $derived(stripWorkspaceCdPrefix(perm.command || '', effectiveCwd));
  const displayTitle = $derived(stripWorkspaceCdPrefix(perm.title || '', effectiveCwd));

  const targetPaths = $derived.by(() => {
    const locs = Array.isArray(perm.locations) ? perm.locations : [];
    const list = locs.map((l) => (typeof l === 'string' ? l : l?.path || '')).filter(Boolean);
    if (list.length > 0) return list;
    const argPath = perm.args?.Path || perm.args?.path || '';
    return argPath ? [String(argPath)] : [];
  });

  const explanation = $derived.by(() => {
    const sum = String(perm.summary || '').trim();
    // bridge 自己的工具各有各的落点（共享终端、你的电脑、你的手机、bridge 本身），不套「在当前工作空间执行终端命令」那几句
    if (toolMeta.bridge && toolMeta.note) return toolMeta.note;
    if (toolMeta.category === 'execute') {
      const hint = perm.bypassSandbox
        ? t('请求在沙盒外执行终端命令，请确认命令内容安全')
        : t('请求在当前工作空间执行终端命令');
      return sum ? `${tr(sum)} · ${hint}` : hint;
    }
    if (toolMeta.category === 'edit') {
      return sum ? `${tr(sum)} · ${t('请求写入或修改以下文件')}` : t('请求写入或修改以下文件');
    }
    if (toolMeta.category === 'read') {
      return sum ? `${tr(sum)} · ${t('请求读取工作空间外或受保护的文件')}` : t('请求读取工作空间外或受保护的文件');
    }
    return sum ? tr(sum) : (tr(perm.title) || t('需要确认是否允许执行此工具操作'));
  });

  const options = $derived.by(() => {
    if (Array.isArray(perm.options) && perm.options.length > 0) return perm.options;
    return [
      { optionId: 'allow', name: t('允许'), kind: 'allow_once' },
      { optionId: 'deny', name: t('拒绝'), kind: 'reject_once' },
    ];
  });

  function optionLabel(opt) {
    const k = String(opt.kind || opt.optionId || '').toLowerCase();
    if (k === 'allow_always') return t('始终允许');
    if (k === 'allow_once' || k === 'allow') return t('允许');
    if (k === 'reject_always') return t('始终拒绝');
    if (k === 'reject_once' || k === 'reject' || k === 'deny') return t('拒绝');
    return tr(opt.name) || opt.optionId;
  }

  function isAllowKind(opt) {
    const k = String(opt.kind || opt.optionId || '').toLowerCase();
    return k.includes('allow');
  }

  const chosenLabel = $derived.by(() => {
    if (perm.status === 'cancelled') return t('已取消');
    const hit = options.find((o) => o.optionId === perm.selectedOptionId);
    return hit ? optionLabel(hit) : t('已处理');
  });

  async function choose(optionId) {
    if (submitting || perm.status !== 'pending') return;
    submitting = true;
    try {
      await submitAgyPermission(perm, optionId);
    } finally {
      submitting = false;
    }
  }
</script>

<div class="agy-perm" class:pending={perm.status === 'pending'} data-agy-perm={perm.requestId}>
  <div class="agy-perm-head">
    <span class="msr4 agy-perm-ico">shield</span>
    <span class="agy-perm-type">{toolMeta.verb}</span>
    {#if perm.toolName && !toolMeta.bridge}
      <span class="agy-perm-tool">{perm.toolName}</span>
    {/if}
    {#if perm.bypassSandbox}
      <span class="agy-perm-unsandboxed">{t('沙盒外')}</span>
    {/if}
    <span class="agy-perm-spacer"></span>
    {#if perm.status === 'pending'}
      <span class="agy-perm-badge wait">{t('待确认')}</span>
    {:else}
      <span class="agy-perm-badge done">{chosenLabel}</span>
    {/if}
  </div>

  <div class="agy-perm-desc sel-text">{explanation}</div>

  {#if displayCommand}
    <div class="agy-perm-cmd sel-text" title={perm.command || undefined}>
      <span class="ps">$</span>
      <code>{displayCommand}</code>
    </div>
  {:else if toolMeta.bridge && toolMeta.detail}
    <div class="agy-perm-cmd sel-text">
      <code>{toolMeta.detail}</code>
    </div>
  {:else if targetPaths.length > 0}
    <div class="agy-perm-cmd sel-text">
      <span class="msr path-ico">description</span>
      <code>{targetPaths.join('\n')}</code>
    </div>
  {:else if displayTitle}
    <div class="agy-perm-cmd sel-text" title={perm.title || undefined}>
      <code>{displayTitle}</code>
    </div>
  {/if}

  {#if perm.status === 'pending'}
    <div class="agy-perm-actions">
      {#each options as opt (opt.optionId)}
        <button
          type="button"
          class="agy-perm-btn"
          class:primary={isAllowKind(opt)}
          disabled={submitting}
          onclick={() => choose(opt.optionId)}
        >
          {optionLabel(opt)}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .agy-perm {
    margin: 8px 0;
    padding: 12px 14px;
    border-radius: 13px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-2);
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: agy-perm-enter var(--ag-dur-quick, 200ms) var(--ag-ease-decel, cubic-bezier(0.05, 0.7, 0.1, 1)) both;
  }
  @keyframes agy-perm-enter {
    from { opacity: 0; transform: translateY(6px); }
  }
  .agy-perm.pending {
    border-color: color-mix(in srgb, var(--ag-warn) 44%, var(--ag-border));
  }
  .agy-perm-head {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .agy-perm-ico {
    font-size: 18px;
    color: var(--ag-warn);
  }
  .agy-perm:not(.pending) .agy-perm-ico {
    color: var(--ag-on-dim);
  }
  .agy-perm-type {
    font-weight: 560;
    color: var(--ag-on);
  }
  .agy-perm-tool {
    font-family: var(--ag-mono);
    font-size: 11.5px;
    padding: 1px 6px;
    border-radius: 5px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    color: var(--ag-on-sub);
  }
  .agy-perm-unsandboxed {
    font-size: 11px;
    font-weight: 550;
    padding: 1.5px 6px;
    border-radius: 5px;
    background: var(--ag-warn-bg);
    color: var(--ag-warn);
  }
  .agy-perm-spacer {
    flex: 1;
  }
  .agy-perm-badge {
    font-size: 11.5px;
    padding: 2px 8px;
    border-radius: 999px;
    flex: none;
  }
  .agy-perm-badge.wait {
    background: var(--ag-warn-bg);
    color: var(--ag-warn);
  }
  .agy-perm-badge.done {
    background: var(--ag-surface-1);
    color: var(--ag-on-dim);
  }
  .agy-perm-desc {
    font-size: 12.5px;
    line-height: 1.48;
    color: var(--ag-on-sub);
  }
  .agy-perm-cmd {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    padding: 8px 10px;
    border-radius: 9px;
    background: var(--ag-code-bg);
    border: 1px solid var(--ag-code-bd);
    font-family: var(--ag-mono);
    font-size: 12px;
    line-height: 1.54;
    color: var(--ag-code-on);
    word-break: break-all;
    white-space: pre-wrap;
  }
  .agy-perm-cmd .ps {
    color: var(--ag-warn);
    user-select: none;
    flex: none;
  }
  .agy-perm-cmd .path-ico {
    font-size: 16px;
    color: var(--ag-accent);
    margin-top: 2px;
  }
  .agy-perm-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 2px;
  }
  .agy-perm-btn {
    padding: 6px 15px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 540;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-1);
    color: var(--ag-on-sub);
    transition: background var(--ag-dur-micro, 140ms) var(--ag-ease-fade, ease),
      border-color var(--ag-dur-micro, 140ms) var(--ag-ease-fade, ease),
      color var(--ag-dur-micro, 140ms) var(--ag-ease-fade, ease);
  }
  .agy-perm-btn:hover:not(:disabled) {
    background: var(--ag-hover);
    color: var(--ag-on);
  }
  .agy-perm-btn.primary {
    background: var(--ag-accent-fill);
    border-color: transparent;
    color: var(--ag-on-accent);
  }
  .agy-perm-btn.primary:hover:not(:disabled) {
    background: var(--ag-accent-strong);
    color: var(--ag-on-accent);
  }
  .agy-perm-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
