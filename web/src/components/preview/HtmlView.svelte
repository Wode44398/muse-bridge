<script>
  // HTML 直接渲染查看器：把文件内容塞进一个 sandbox iframe 的 srcdoc（无 allow-same-origin ⇒
  // 脚本跑在不透明源、碰不到 bridge cookie/接口）。既能真渲染（自包含页/PPT 翻页、键盘、全屏都在），
  // 又安全隔离。文本已读（本地）就直接用，否则 fetch 原始字节（云端 /api/file，分享模式带 ?st）。
  // 塞进去之前经 prepareHtml：补存储垫片 + 内联同目录的 js/css/图片，否则不透明源里脚本跑不起来。
  import { onMount } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { prepareHtml } from '../../lib/htmlInline.js';
  const { item, onClose } = $props();
  let html = $state(null);
  let err = $state('');
  let loading = $state(true);
  onMount(async () => {
    try {
      let src = item.text;
      if (src == null) {
        const r = await fetch(item.url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        src = await r.text();
      }
      try { html = await prepareHtml(src, item.url); } catch { html = src; }
    } catch (e) { err = String(e?.message || e); }
    finally { loading = false; }
  });
</script>

<div class="hv">
  <div class="hv-bar">
    <button class="hv-btn" aria-label={t('返回')} onclick={onClose}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <span class="hv-name">{item.name}</span>
    {#if item.downloadHref}
      <a class="hv-btn" href={item.downloadHref} aria-label={t('下载')} download>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M12 16l-5-5M12 16l5-5" /><path d="M5 20h14" /></svg>
      </a>
    {/if}
  </div>
  <div class="hv-body">
    {#if loading}
      <div class="hv-msg">{t('加载中…')}</div>
    {:else if err}
      <div class="hv-msg">{t('打开失败：{reason}', { reason: tr(err) })}</div>
    {:else}
      <iframe class="hv-frame" title={item.name} sandbox="allow-scripts allow-popups allow-modals allow-forms" allowfullscreen srcdoc={html}></iframe>
    {/if}
  </div>
</div>

<style>
  .hv { position: fixed; inset: 0; display: flex; flex-direction: column; background: #fff; z-index: 1; }
  /* 顶栏让开系统状态栏（--sat，apk 原生注入）：与 DocViewer/PdfView/OfficeView 的头同一规矩。
     此前写死 height:52px、padding 0——手机全屏与折叠屏工作台侧列里，返回/下载键都压在状态栏下点不到。
     --pv-bar-h：宿主可调（手机工作台 sheet 里收成 44px 省地方）。 */
  .hv-bar { flex: none; box-sizing: border-box; height: calc(var(--pv-bar-h, 52px) + var(--sat, 0px)); display: flex; align-items: center; gap: 8px; padding: var(--sat, 0px) 10px 0; background: #f6f6f8; border-bottom: 1px solid #e5e5ea; color: #1c1c1e; }
  .hv-name { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hv-btn { width: 38px; height: 38px; flex: none; display: grid; place-items: center; border: 0; background: none; color: #1c1c1e; border-radius: 50%; cursor: pointer; text-decoration: none; }
  .hv-btn:hover { background: rgba(0, 0, 0, .06); }
  .hv-btn svg { width: 22px; height: 22px; }
  .hv-body { flex: 1; position: relative; background: #fff; }
  .hv-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
  .hv-msg { position: absolute; inset: 0; display: grid; place-items: center; color: #888; font-size: 14px; }
</style>
