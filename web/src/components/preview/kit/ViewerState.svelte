<script>
  // 查看器统一的加载 / 错误 / 不支持态（七个查看器同一副长相）：
  //   loading      28px 转圈，延迟 delay（默认 300ms）才出，快加载不闪；label 给一句慢加载说明（如「转换中…」）
  //   error        线稿图标 + 14/600 标题 + 12.5 说明 + 主按钮「重试」+ 次按钮「下载」
  //                status（HTTP 状态码）：404 / 410 一律说「文件不存在或已被移动」、401 / 403「没有权限打开此文件」，
  //                状态码本身放说明行——七个查看器同一个错同一句话，别各写各的「打开失败：HTTP 404」
  //   unsupported  文件图标 + 「暂不支持预览」+ 文件名 + 下载 / 打开方式
  // 皮肤跟外框（媒体恒暗、文档随主题），在外框之外用时可传 tone。
  // overlay=true：压在内容上居中（加载时不挡手势：pointer-events 只给按钮）。
  import { onMount } from 'svelte';
  import VIcon from './VIcon.svelte';
  import { useViewer } from './context.js';
  import { t } from '../../../lib/i18n.js';
  import { saveLabel } from '../../../lib/save.js';

  let {
    kind = 'loading', title = '', detail = '', label = '', icon = '', status = 0,
    onRetry = null, retryLabel = '', download = true, actions = [],
    delay = 300, tone = '', overlay = true, size = 28,
  } = $props();
  const viewer = useViewer();

  let late = $state(false);
  onMount(() => { if (!(delay > 0)) { late = true; return; } const id = setTimeout(() => (late = true), delay); return () => clearTimeout(id); });

  const canDl = $derived(download && kind !== 'loading' && viewer.canDownload());
  const defTitle = $derived(kind === 'unsupported' ? t('暂不支持预览此类型') : kind === 'error' ? t('加载失败') : '');
  const defIcon = $derived(kind === 'unsupported' ? 'unsupported' : 'error');
  const stTitle = $derived(kind !== 'error' ? '' : status === 404 || status === 410 ? t('文件不存在或已被移动') : status === 401 || status === 403 ? t('没有权限打开此文件') : '');
  const shownDetail = $derived(detail || (kind === 'error' && status > 0 ? `HTTP ${status}` : ''));
</script>

<div class="vw-state" class:vw-state-overlay={overlay} class:vw-state-loading={kind === 'loading'}
  data-tone={tone || null} role={kind === 'loading' ? 'status' : 'alert'} aria-live="polite">
  {#if kind === 'loading'}
    {#if late}
      <span class="vw-spin" style:--s="{size}px" aria-label={t('加载中')}></span>
      {#if label}<p class="vw-state-d">{label}</p>{/if}
    {/if}
  {:else}
    <VIcon name={icon || defIcon} size={28} class="vw-state-ic" />
    <p class="vw-state-t">{stTitle || title || defTitle}</p>
    {#if shownDetail}<p class="vw-state-d sel-text">{shownDetail}</p>{/if}
    <div class="vw-state-acts">
      {#if onRetry}<button type="button" class="vw-pbtn pri" onclick={onRetry}>{retryLabel || t('重试')}</button>{/if}
      {#if canDl}<button type="button" class="vw-pbtn" class:pri={!onRetry} onclick={() => viewer.download()}>{saveLabel(t('下载'))}</button>{/if}
      {#each actions as a, i (i)}
        <button type="button" class="vw-pbtn" class:pri={a.primary} onclick={a.onClick}>{a.label}</button>
      {/each}
    </div>
  {/if}
</div>
