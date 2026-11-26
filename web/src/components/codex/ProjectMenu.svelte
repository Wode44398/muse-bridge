<script>
  // 项目菜单（托盘第一颗 / 首页那句话里的项目名）：列出项目，勾在当前项目上，有分支的写在右边；
  // 项目多了出搜索框；最下面「添加项目…」交给页面（原生选目录或 bridge 的项目选择器）。
  import { tick } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { codex, selectProject } from '../../lib/codex/store.svelte.js';
  import { cxPop, closePop } from '../../lib/codex/ui.svelte.js';
  import { haptic } from '../../lib/codex/feedback.js';
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';

  let { onAdd = null } = $props();

  const open = $derived(cxPop.id === 'proj');
  const projects = $derived(Array.isArray(codex.projects) ? codex.projects : []);
  const searchable = $derived(projects.length > 8);
  let q = $state('');
  let searchEl = $state(null);
  const shown = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return projects;
    return projects.filter((p) => String(p.name || '').toLowerCase().includes(s) || String(p.path || '').toLowerCase().includes(s));
  });

  $effect(() => {
    if (!open) return;
    q = '';
    tick().then(() => {
      let fine = false;
      try { fine = matchMedia('(pointer: fine)').matches; } catch {}
      if (fine && searchEl) searchEl.focus({ preventScroll: true });
    });
  });

  let closing = 0;
  function pick(id) {
    if (id !== codex.projectId) { selectProject(id); haptic('tick'); }
    clearTimeout(closing);
    closing = setTimeout(() => closePop('proj'), 140);
  }

  function add() {
    closePop('proj');
    onAdd?.();
  }

  function onKey(e) {
    if (e.key === 'Enter' && e.target === searchEl && shown.length) {
      e.preventDefault();
      pick(shown[0].id);
    }
  }
</script>

<Popover id="proj" side="top" align="start" width={280} class="cx-menu" label={t('项目')}>
  <div class="pop-cap">{t('项目')}</div>
  {#if searchable}
    <div class="pop-search">
      <Icon name="search" />
      <input bind:this={searchEl} bind:value={q} onkeydown={onKey} placeholder={t('找项目')} aria-label={t('找项目')} spellcheck="false" autocomplete="off" />
    </div>
  {/if}
  <div class="pop-sec pj-list">
    {#each shown as p (p.id)}
      <button type="button" class="mi" role="menuitemradio" aria-checked={p.id === codex.projectId} onclick={() => pick(p.id)} title={p.path || ''}>
        <Icon name="folder" class="mi-ico" />
        <span class="lb nm">{p.name || p.path || p.id}</span>
        {#if p.branch}<span class="sub mono br">{p.branch}</span>{/if}
        <Icon name="check" class="ck" />
      </button>
    {:else}
      <div class="pj-empty">{projects.length ? t('没有匹配的项目') : t('还没有项目')}</div>
    {/each}
  </div>
  {#if onAdd}
    <div class="pop-sep"></div>
    <div class="pop-sec">
      <button type="button" class="mi" onclick={add}>
        <Icon name="plus" class="mi-ico" />
        <span class="lb">{t('添加项目…')}</span>
      </button>
    </div>
  {/if}
</Popover>

<style>
  .pj-list { padding-top: 2px; max-height: min(360px, calc(var(--avail, 400px) - 110px)); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
  .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .br { max-width: 9em; overflow: hidden; text-overflow: ellipsis; font-size: 11.5px; }
  .pj-empty { padding: 14px 12px; text-align: center; color: var(--fg3); font-size: 12.5px; }
  .mi :global(.ck) { transition: opacity calc(var(--k, 1) * 150ms) ease; }
</style>
