<script>
  // 聊天流里媒体工具（mcp__media__generate_image）出的图。
  //
  // 以前是一个裸 <img src=…>，加载失败就永远停在浏览器的破图 + 一长串英文提示词（alt）。
  // 最常见的失败是在家走局域网直连：fetch 失败会自动降回隧道重试，但 <img> 的地址是渲染时
  // 一次性算好的，不会自愈（见 lib/server.js mediaFallbackUrl）；其余是隧道/网络的瞬时抖动。
  // 这里按顺序自救：① 局域网地址 → 隧道 ② 带新参数重试（按当前 token / 线路现算地址），
  // 第二次起换原图、绕开 1280 衍生图 ③ 全失败才露一张「加载失败 · 重试」的小卡，不再是破图。
  // 点图 = 全屏查看器（缩放 / 下载，查看器自带同一套线路自愈）。
  import { apiUrl, mediaFallbackUrl } from '../../lib/server.js';
  import { getToken } from '../../lib/api.js';
  import { openPreview } from '../../lib/preview.svelte.js';
  import { t } from '../../lib/i18n.js';

  const { id = '', dataUrl = null, prompt = '' } = $props();

  // v='preview' = 1280px 衍生图（4K 原图 ~20MB 会拖垮手机）；r = 重试序号，只为换一个 URL 绕开失败缓存
  const urlFor = (v, r) => apiUrl('/api/vertex/media?id=' + encodeURIComponent(id) + (v ? '&v=' + v : '') + (r ? '&r=' + r : '') + (getToken() ? '&token=' + encodeURIComponent(getToken()) : ''));
  const RETRY_MS = [1500, 4000, 10000];

  let src = $state(dataUrl || urlFor('preview'));
  let failed = $state(false);
  let attempt = 0;
  let timer = 0;

  function onError(e) {
    if (dataUrl || !id) { failed = true; return; }
    const cur = e.currentTarget.src;
    const viaTunnel = mediaFallbackUrl(cur);   // 走局域网 → 立刻换隧道（顺带把后续请求也切走）
    if (viaTunnel !== cur) { src = viaTunnel; return; }
    if (attempt >= RETRY_MS.length) { failed = true; return; }
    const n = ++attempt;
    clearTimeout(timer);
    timer = setTimeout(() => { src = urlFor(n >= 2 ? '' : 'preview', n); }, RETRY_MS[n - 1]);
  }
  function retry(e) {
    e.stopPropagation();
    clearTimeout(timer);
    attempt = 0;
    failed = false;
    src = urlFor('preview', Date.now());
  }
  function open() {
    if (id) openPreview([{ origin: 'vertex', id, kind: 'image' }], 0);
  }
  $effect(() => () => clearTimeout(timer));
</script>

{#if failed}
  <button class="cmi-fail" onclick={retry} title={prompt}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" /><path d="m4.5 16 4.6-4.6a1.5 1.5 0 0 1 2.1 0L16 16.2M14 14l1.4-1.4a1.5 1.5 0 0 1 2.1 0l2.5 2.5" /><circle cx="15.5" cy="9" r="1.4" /></svg>
    <span>{t('图片加载失败')}</span>
    <span class="cmi-retry">{t('重试')}</span>
  </button>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <img class="cmi" {src} alt={prompt} loading="lazy" decoding="async" onerror={onError} onclick={open} class:zoom={!!id} />
{/if}

<style>
  .cmi { max-width: 100%; border-radius: 12px; display: block; }
  .cmi.zoom { cursor: zoom-in; }
  .cmi-fail {
    display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 14px 0 12px;
    border: 1px solid var(--line, rgba(255, 255, 255, .1)); border-radius: 10px; background: none;
    color: var(--muted, rgba(250, 249, 245, .55)); font: inherit; font-size: 13.5px; cursor: pointer;
  }
  .cmi-fail:hover { background: var(--hover, rgba(255, 255, 255, .05)); }
  .cmi-fail svg { width: 18px; height: 18px; flex: none; }
  .cmi-retry { color: var(--fg, inherit); font-weight: 550; }
</style>
