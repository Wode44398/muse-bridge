<script>
  // 手机 / 网页设置（iOS 外壳）› Codex 的单选与编辑子页：
  //   单选（选中即存，留在本页）：cx:strategy / cx:approval / cx:sandbox / cx:websearch / cx:verbosity / cx:summary /
  //                              cx:member-approval / cx:member-sandbox / cx:maxruns / cx:idle
  //   cx:instructions  自定义指令（失焦保存，离开页面时没存的也存上）
  //   cx:archived      已归档的对话（恢复 / 删除）
  //   cx:pet           吉祥物角色（本机取得到的才列，带首帧预览；存在这台设备上）
  import { onDestroy, untrack } from 'svelte';
  import Sym from '../../../ios27/Sym.svelte';
  import { uiConfirm } from '../../../../lib/dialogs.js';
  import { t, locale } from '../../../../lib/i18n.js';
  import {
    cx,
    saveCodexSettings,
    setBehavior,
    setApproval,
    approvalOf,
    behavior,
    setRouter,
    unarchiveSession,
    deleteArchivedSession,
  } from '../../../../lib/codex/settings.svelte.js';
  import {
    approvalOptions,
    sandboxOptions,
    webSearchOptions,
    verbosityOptions,
    summaryOptions,
    summaryValue,
    idleOptions,
    maxRunsOptions,
    routeStrategies,
  } from '../../../../lib/codex/settings-logic.js';
  import { codexPrefs, setCodexPref } from '../../../../lib/codex/prefs.svelte.js';
  import { pets, loadPetPreviews, petLabel, petPreviewStyle } from './codex-pets.svelte.js';

  let { pid = '', onModal } = $props();

  const bh = $derived(behavior());

  // —— 单选页：选项、当前值、怎么存、错误区、脚注 ——
  const choice = $derived.by(() => {
    switch (pid) {
      case 'cx:strategy':
        return { opts: routeStrategies(), cur: cx.pool?.router?.strategy || 'smart', pick: (v) => setRouter({ strategy: v }), err: cx.errors.router };
      case 'cx:approval':
        return { opts: approvalOptions(cx.choices?.approvals), cur: approvalOf('admin').approvalPolicy, pick: (v) => setApproval('admin', 'approvalPolicy', v), err: cx.errors.approval };
      case 'cx:sandbox':
        return { opts: sandboxOptions(cx.choices?.sandboxes), cur: approvalOf('admin').sandbox, pick: (v) => setApproval('admin', 'sandbox', v), err: cx.errors.approval };
      case 'cx:member-approval':
        return { opts: approvalOptions(cx.choices?.member?.approvals), cur: approvalOf('member').approvalPolicy, pick: (v) => setApproval('member', 'approvalPolicy', v), err: cx.errors.approval };
      case 'cx:member-sandbox':
        return { opts: sandboxOptions(cx.choices?.member?.sandboxes), cur: approvalOf('member').sandbox, pick: (v) => setApproval('member', 'sandbox', v), err: cx.errors.approval };
      case 'cx:websearch':
        return { opts: webSearchOptions(), cur: bh.webSearch ?? '', pick: (v) => setBehavior('webSearch', v), err: cx.errors.behavior };
      case 'cx:verbosity':
        return { opts: verbosityOptions(), cur: bh.verbosity ?? '', pick: (v) => setBehavior('verbosity', v), err: cx.errors.behavior };
      case 'cx:summary':
        return { opts: summaryOptions(), cur: summaryValue(bh.reasoningSummary), pick: (v) => setBehavior('reasoningSummary', v), err: cx.errors.behavior };
      case 'cx:maxruns':
        return { opts: maxRunsOptions(), cur: cx.settings?.memberMaxRuns ?? 1, pick: (v) => saveCodexSettings({ memberMaxRuns: v }), err: cx.errors.settings };
      case 'cx:idle':
        return { opts: idleOptions(), cur: cx.settings?.idleStopMinutes ?? 60, pick: (v) => saveCodexSettings({ idleStopMinutes: v }), err: cx.errors.settings };
      default:
        return null;
    }
  });

  // —— 自定义指令：没改动时草稿跟着服务端值走；失焦存、离开页面时补存（没存上就留着草稿，不被回滚的旧值盖掉）——
  const saved = $derived(String(bh.instructions ?? ''));
  let draft = $state('');
  let dirty = false;
  $effect(() => {
    if (pid !== 'cx:instructions') return;
    const v = saved;
    untrack(() => { if (!dirty) draft = v; });
  });
  async function saveInstructions() {
    if (pid !== 'cx:instructions' || !dirty || !cx.settings) return;
    const v = draft;
    if (v === saved) { dirty = false; return; }
    const ok = await setBehavior('instructions', v);
    if (ok && draft === v) dirty = false;
  }
  function clearInstructions() {
    draft = '';
    dirty = true;
    saveInstructions();
  }
  onDestroy(() => saveInstructions());

  $effect(() => { if (pid === 'cx:pet') untrack(() => loadPetPreviews()); });

  // —— 已归档的对话 ——
  function fmtDay(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    try { return new Intl.DateTimeFormat(locale(), sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(d); }
    catch { return d.toISOString().slice(0, 10); }
  }
  async function askDelete(s) {
    onModal?.(true);
    let ok = false;
    try {
      ok = await uiConfirm(t('删除对话「{name}」？', { name: s.title || t('未命名对话') }), {
        detail: t('删除后无法恢复。'),
        okLabel: t('删除'),
        danger: true,
      });
    } finally { onModal?.(false); }
    if (ok) await deleteArchivedSession(s.id);
  }
</script>

{#snippet check()}<Sym name="checkmark" weight={600} size={15} class="ck" />{/snippet}

{#if choice}
  {#if !cx.loaded && !cx.snap}
    <p class="gfoot">{t('读取中…')}</p>
  {:else}
    <div class="ig">
      {#each choice.opts as o (o.value)}
        <button class="r" type="button" onclick={() => { if (o.value !== choice.cur) choice.pick(o.value); }}>
          <span class="r-main">
            <span class="r-tx">
              <span>{o.label}</span>
              {#if o.desc}<span class="r-sub">{o.desc}</span>{/if}
            </span>
            {#if o.value === choice.cur}{@render check()}{/if}
          </span>
        </button>
      {/each}
    </div>
    {#if choice.err}<p class="gfoot err">{choice.err}</p>{/if}
    {#if choice.foot}<p class="gfoot">{choice.foot}</p>{/if}
  {/if}

{:else if pid === 'cx:instructions'}
  <div class="ig prompt-card">
    <textarea
      class="prompt-area"
      rows="9"
      bind:value={draft}
      maxlength={cx.choices?.instructionsMax || 8000}
      disabled={!cx.settings}
      oninput={() => { dirty = true; }}
      onblur={saveInstructions}
    ></textarea>
  </div>
  {#if draft || saved}
    <div class="ig">
      <button class="r" type="button" onclick={clearInstructions}>
        <span class="r-main center"><span class="r-tx red">{t('清空')}</span></span>
      </button>
    </div>
  {/if}
  {#if cx.errors.behavior}<p class="gfoot err">{cx.errors.behavior}</p>{/if}

{:else if pid === 'cx:pet'}
  {#if !pets.loaded}
    <p class="gfoot">{t('读取中…')}</p>
  {:else if pets.available.length}
    <div class="ig">
      {#each pets.available as name (name)}
        <button class="r" type="button" onclick={() => setCodexPref('petName', name)}>
          <span class="r-main">
            <span class="pet-img" style={petPreviewStyle(pets.previews[name])}></span>
            <span class="r-tx">{petLabel(name)}</span>
            {#if codexPrefs.petName === name}{@render check()}{/if}
          </span>
        </button>
      {/each}
    </div>
  {:else}
    <p class="gfoot">{t('这台服务器上没有 Codex 桌面版，取不到吉祥物素材')}</p>
  {/if}

{:else if pid === 'cx:archived'}
  {#if !cx.archivedLoaded}
    <p class="gfoot">{t('读取中…')}</p>
  {:else}
    {#if cx.archived.length}
      <div class="ig">
        {#each cx.archived as s (s.id)}
          {@const busy = cx.busy === 'archived:' + s.id}
          <div class="r">
            <span class="r-main">
              <span class="r-tx">
                <span class="cx-title">{s.title || t('未命名对话')}</span>
                {#if s.projectName || s.mtime}<span class="r-sub">{[s.projectName, fmtDay(s.mtime)].filter(Boolean).join(' · ')}</span>{/if}
              </span>
              <span class="dv-minis">
                <button type="button" disabled={busy} onclick={() => unarchiveSession(s.id)}>{t('恢复')}</button>
                <button type="button" class="red" disabled={busy} onclick={() => askDelete(s)}>{t('删除')}</button>
              </span>
            </span>
          </div>
        {/each}
      </div>
    {/if}
    {#if cx.errors.archived}<p class="gfoot err">{cx.errors.archived}</p>{/if}
    {#if !cx.archived.length}<p class="gfoot">{t('没有已归档的对话')}</p>{/if}
  {/if}
{/if}

<style>
  @import '../kit.css';
  .prompt-card { padding: 12px 14px; }
  /* 精灵图一帧 192×208：按原比例缩到 32 宽 */
  .pet-img { flex: none; width: 32px; height: 35px; margin: -4px 0; }
  .prompt-area {
    width: 100%;
    box-sizing: border-box;
    border: 0;
    background: transparent;
    color: var(--i-label);
    font: inherit;
    font-size: 15px;
    line-height: 1.5;
    resize: vertical;
    outline: none;
  }
  .cx-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
