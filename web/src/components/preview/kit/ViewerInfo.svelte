<script>
  // 文件信息面板：触屏 = ios27 Sheet（墨色，媒体场景暗）；电脑 = 右侧抽屉（扁平，媒体钉暗、文档随主题）。
  // 行由外框给（名称 / 类型 / 大小 / 修改时间 / 子查看器追加的尺寸页数 / 位置 / 来源）；没带大小时间的
  // 由外框按需用一次 Range 请求补（kit/actions.js probeMeta）。
  // 进场纯 CSS 动画，关闭瞬时卸载（Sheet 自带下滑关闭与退场）。
  import Sheet from '../../ios27/Sheet.svelte';
  import VIcon from './VIcon.svelte';
  import { tip } from './tooltip.js';
  import { pointer } from '../../../lib/layout.svelte.js';
  import { pushBackLayer } from '../../../lib/nav.js';
  import { copyText } from './actions.js';
  import { t } from '../../../lib/i18n.js';

  let { rows = [], onclose, ontoast = null } = $props();
  const fine = $derived(pointer.fine);
  $effect(() => pushBackLayer(() => onclose?.()));
  let panel = $state();
  $effect(() => { if (fine && panel) queueMicrotask(() => { try { panel.focus({ preventScroll: true }); } catch {} }); });

  // 路径按分隔符切段、段后放 <wbr>：长路径优先在 / 处折行，不在文件名中间断成「.p df」（复制的仍是原文）
  const segs = (v) => String(v ?? '').split(/(?<=[\\/])/);
  async function copyRow(r) { if (await copyText(r.value)) ontoast?.(t('已复制')); }
  function key(e) { if (e.key === 'Escape') { e.preventDefault(); onclose?.(); } }
</script>

{#snippet list()}
  <dl class="vw-info">
    {#each rows as r, i (i)}
      <div class="vw-info-row">
        <dt>{r.label}</dt>
        <dd class:mono={r.mono}><button type="button" class="vw-info-v sel-text" onclick={() => copyRow(r)} use:tip={t('复制')}>{#if r.mono}{#each segs(r.value) as s, j (j)}{s}<wbr />{/each}{:else}{r.value}{/if}</button></dd>
      </div>
    {/each}
  </dl>
{/snippet}

{#if fine}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="vw-drawer" bind:this={panel} tabindex="-1" role="dialog" aria-label={t('文件信息')} onkeydown={key}>
    <header class="vw-drawer-h">
      <span>{t('文件信息')}</span>
      <button type="button" class="vw-btn" onclick={() => onclose?.()} use:tip={{ label: t('关闭'), kbd: 'Esc' }}><VIcon name="close" /></button>
    </header>
    <div class="vw-drawer-b">{@render list()}</div>
  </div>
{:else}
  <Sheet title={t('文件信息')} closeLabel={t('关闭')} onclose={() => onclose?.()}>
    {@render list()}
  </Sheet>
{/if}
