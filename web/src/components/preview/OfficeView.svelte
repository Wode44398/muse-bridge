<script>
  // Office 查看器（混合）。
  //   · 表格(xls/xlsx/csv/ods) → 一律客户端 SheetJS 渲染成【可交互表格】（多 sheet 切换，比 PDF 强）
  //   · 文档/演示(doc/docx/ppt/pptx…) → 先探【服务端转 PDF】(LibreOffice，像素级)，通了用 PdfView 渲染；
  //     不通(没装/失败/离线) → 回落客户端：Word=mammoth(docx→HTML)、PPT=fflate 解包取文字+图(可读近似)
  // 重库（mammoth/xlsx/fflate）动态 import → 代码分割，仅打开 office 时才加载，不拖累主包。
  import { onMount } from 'svelte';
  import PdfView from './PdfView.svelte';
  import { recoverStaleChunk } from '../../lib/staleGuard.js';
  import { t, tr } from '../../lib/i18n.js';

  let { item, onClose } = $props();

  const ext = (item.name.split('.').pop() || '').toLowerCase();
  const cat = ['xls', 'xlsx', 'csv', 'ods'].includes(ext) ? 'sheet'
    : ['ppt', 'pptx', 'odp'].includes(ext) ? 'slides' : 'word';

  let phase = $state('loading');   // loading | serverpdf | sheet | word | slides | error
  let errMsg = $state('');
  // 各形态产物
  let wordHtml = $state('');
  let sheets = $state([]);         // [{name, html}]
  let activeSheet = $state(0);
  let slides = $state([]);         // [{texts:[], imgs:[blobUrl]}]
  let objUrls = [];

  async function fetchBuf() {
    const r = await fetch(item.url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.arrayBuffer();
  }

  async function start() {
    phase = 'loading'; errMsg = '';
    try {
      if (cat === 'sheet') return await renderSheet();
      // word / slides：先探服务端 PDF
      if (item.officePdfUrl) {
        try {
          const r = await fetch(item.officePdfUrl, { headers: { Range: 'bytes=0-1' }, credentials: 'same-origin' });
          if (r.ok || r.status === 206) { phase = 'serverpdf'; return; }
        } catch {}
      }
      if (cat === 'word') return await renderWord();
      return await renderSlides();
    } catch (e) {
      // 新构建部署后旧页面拉不到懒加载 chunk（xlsx/mammoth/dompurify）→ 整页自愈刷新，
      // 不画错误态（stale 形状之外的错误照旧显示）。
      if (recoverStaleChunk(e)) return;
      errMsg = String(e?.message || e); phase = 'error';
    }
  }

  async function renderWord() {
    const mammoth = await import('mammoth');
    const DOMPurify = (await import('dompurify')).default;
    const buf = await fetchBuf();
    const { value } = await mammoth.convertToHtml({ arrayBuffer: buf });
    wordHtml = DOMPurify.sanitize(value || '<p>' + t('（空文档）') + '</p>');
    phase = 'word';
  }

  async function renderSheet() {
    const XLSX = await import('xlsx');
    const DOMPurify = (await import('dompurify')).default;
    const buf = await fetchBuf();
    let wb;
    if (['csv', 'tsv'].includes(ext)) {
      // 文本表格必须自己解码再喂字符串：SheetJS 对无 BOM 的 CSV 字节流按 cp1252 解，
      // UTF-8 中文全成「æ¾è...」乱码。先按 UTF-8 严格解（fatal：坏字节即抛），
      // 失败回落 GBK（大陆 Excel 导出的常态），再不行宽松 UTF-8 兜底。BOM 手动剥。
      const bytes = new Uint8Array(buf);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { try { text = new TextDecoder('gbk').decode(bytes); } catch { text = new TextDecoder().decode(bytes); } }
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      wb = XLSX.read(text, { type: 'string' });
    } else {
      wb = XLSX.read(buf, { type: 'array' });
    }
    // sheet_to_html 只转义单元格【文本节点】，但超链接会原样吐成 <a href="javascript:…">、
    // 单元格值里的引号还能逃出 data-v 属性注入事件处理器——不净化就是 XSS（{@html} 注入，
    // 且快照页把这条渲染管线暴露给公开访客：攻击者上传恶意 xlsx→别人打开即中招）。
    // 与 renderWord 一致过一遍 DOMPurify：table/样式保留，javascript: 协议与 on* 事件被清。
    sheets = wb.SheetNames.map((name) => ({ name, html: DOMPurify.sanitize(XLSX.utils.sheet_to_html(wb.Sheets[name], { id: '', editable: false })) }));
    if (!sheets.length) throw new Error(t('空表格'));
    phase = 'sheet';
  }

  async function renderSlides() {
    const { unzipSync, strFromU8 } = await import('fflate');
    const buf = new Uint8Array(await fetchBuf());
    const zip = unzipSync(buf);
    // 媒体：path -> blobURL
    const media = {};
    for (const p of Object.keys(zip)) {
      if (/^ppt\/media\//i.test(p)) {
        const ext2 = (p.split('.').pop() || '').toLowerCase();
        const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', emf: '', wmf: '' })[ext2] ?? 'image/*';
        if (mime) { const u = URL.createObjectURL(new Blob([zip[p]], { type: mime })); objUrls.push(u); media[p.toLowerCase()] = u; }
      }
    }
    // 幻灯片按序号
    const slideFiles = Object.keys(zip).filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
      .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));
    const out = [];
    for (const sf of slideFiles) {
      const xml = strFromU8(zip[sf]);
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).filter((s) => s.trim());
      // 该 slide 的图：查它的 rels 找 media 引用
      const relPath = sf.replace(/slides\/(slide\d+)\.xml/i, 'slides/_rels/$1.xml.rels');
      const imgs = [];
      if (zip[relPath]) {
        const rels = strFromU8(zip[relPath]);
        for (const m of rels.matchAll(/Target="([^"]+)"/g)) {
          const mp = ('ppt/' + m[1].replace(/^\.\.\//, '')).toLowerCase();
          if (media[mp]) imgs.push(media[mp]);
        }
      }
      out.push({ texts, imgs });
    }
    slides = out;
    if (!slides.length) throw new Error(t('无幻灯片'));
    phase = 'slides';
  }
  function decodeXml(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

  onMount(() => { start(); return () => { for (const u of objUrls) { try { URL.revokeObjectURL(u); } catch {} } }; });
</script>

{#if phase === 'serverpdf'}
  <!-- 服务端转好的 PDF：直接交给 PdfView（像素级还原 + 它自带头部/缩放/页码） -->
  <PdfView item={{ ...item, url: item.officePdfUrl }} {onClose} />
{:else}
  <div class="of-root">
    <header class="of-head">
      <button class="of-btn" aria-label={t('返回')} onclick={() => onClose?.()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
      </button>
      <span class="of-title">{item.name}</span>
      {#if item.downloadHref}<a class="of-btn" href={item.downloadHref} download={item.name} aria-label={t('下载')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M12 16l-5-5M12 16l5-5"/><path d="M5 20h14"/></svg></a>{/if}
    </header>

    {#if phase === 'sheet' && sheets.length > 1}
      <div class="of-tabs">
        {#each sheets as sh, i (sh.name + i)}
          <button class="of-tab" class:on={i === activeSheet} onclick={() => (activeSheet = i)}>{sh.name}</button>
        {/each}
      </div>
    {/if}

    <div class="of-body">
      {#if phase === 'loading'}
        <div class="of-center"><span class="of-spin"></span><p class="of-tip">{cat === 'sheet' ? t('解析表格…') : t('转换中…（首次稍候）')}</p></div>
      {:else if phase === 'error'}
        <div class="of-center of-err"><p>{t('无法预览此文档')}</p><p class="of-sub">{tr(errMsg)}</p><button onclick={start}>{t('重试')}</button>{#if item.downloadHref}<a class="of-dl" href={item.downloadHref} download={item.name}>{t('下载原文件')}</a>{/if}</div>
      {:else if phase === 'word'}
        <div class="of-scroll"><div class="of-doc">{@html wordHtml}</div></div>
      {:else if phase === 'sheet'}
        <div class="of-scroll of-sheetscroll">{@html sheets[activeSheet]?.html || ''}</div>
      {:else if phase === 'slides'}
        <div class="of-scroll of-slides">
          {#each slides as sl, i (i)}
            <div class="of-slide">
              <div class="of-slide-no">{i + 1}</div>
              {#each sl.imgs as src (src)}<img class="of-slide-img" {src} alt="" />{/each}
              {#each sl.texts as tx (tx)}<p class="of-slide-txt">{tx}</p>{/each}
              {#if !sl.imgs.length && !sl.texts.length}<p class="of-slide-empty">{t('（此页无文本）')}</p>{/if}
            </div>
          {/each}
          <div class="of-approx">{t('PPT 客户端近似渲染（文字+图片）。装好 LibreOffice 后将自动用像素级 PDF。')}</div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .of-root { position: absolute; inset: 0; background: #fbfbfa; color: #1d1d1f; display: flex; flex-direction: column; }
  .of-head { flex: none; display: flex; align-items: center; gap: 8px; padding: max(var(--pv-pad-y, 8px), var(--sat)) 10px var(--pv-pad-y, 8px); background: #fff; border-bottom: 1px solid #ececec; }
  .of-btn { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #1d1d1f; flex: none; }
  .of-btn svg { width: 21px; height: 21px; }
  .of-btn:active { background: rgba(0,0,0,.06); }
  .of-title { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

  .of-tabs { flex: none; display: flex; gap: 4px; overflow-x: auto; padding: 7px 10px; background: #fff; border-bottom: 1px solid #ececec; }
  .of-tab { flex: none; padding: 5px 13px; border-radius: 999px; font-size: 13px; background: #f0f0f2; color: #57575c; }
  .of-tab.on { background: var(--g-primary, #1a73e8); color: #fff; }

  .of-body { flex: 1; min-height: 0; position: relative; }
  .of-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #6b6b70; padding: 0 30px; text-align: center; }
  .of-spin { width: 30px; height: 30px; border-radius: 50%; border: 3px solid rgba(0,0,0,.12); border-top-color: #1a73e8; animation: ofspin .8s linear infinite; }
  @keyframes ofspin { to { transform: rotate(360deg); } }
  .of-tip { font-size: 13px; }
  .of-sub { font-size: 12px; color: #9a9aa0; max-width: 80vw; word-break: break-all; }
  .of-err button, .of-dl { padding: 7px 20px; border-radius: 999px; background: #1a73e8; color: #fff; font-size: 14px; }

  .of-scroll { position: absolute; inset: 0; overflow: auto; -webkit-overflow-scrolling: touch; }

  /* Word（mammoth HTML）*/
  .of-doc { max-width: 800px; margin: 0 auto; padding: 26px 22px 60px; font-size: 16px; line-height: 1.7; }
  .of-doc :global(h1) { font-size: 1.6em; font-weight: 700; margin: .7em 0 .4em; }
  .of-doc :global(h2) { font-size: 1.35em; font-weight: 700; margin: .7em 0 .4em; }
  .of-doc :global(h3) { font-size: 1.15em; font-weight: 650; margin: .6em 0 .35em; }
  .of-doc :global(p) { margin: .5em 0; }
  .of-doc :global(ul), .of-doc :global(ol) { margin: .5em 0; padding-left: 1.6em; }
  .of-doc :global(img) { max-width: 100%; height: auto; }
  .of-doc :global(table) { border-collapse: collapse; margin: .7em 0; width: 100%; }
  .of-doc :global(td), .of-doc :global(th) { border: 1px solid #d8d8dc; padding: 6px 10px; font-size: .95em; }

  /* 表格（SheetJS HTML）*/
  .of-sheetscroll { padding: 0; }
  .of-sheetscroll :global(table) { border-collapse: collapse; font-size: 13px; }
  .of-sheetscroll :global(td), .of-sheetscroll :global(th) { border: 1px solid #e2e2e6; padding: 5px 10px; white-space: nowrap; min-width: 48px; }
  .of-sheetscroll :global(tr:first-child td) { background: #f6f6f7; font-weight: 600; position: sticky; top: 0; }

  /* PPT 近似 */
  .of-slides { padding: 16px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .of-slide { width: 100%; max-width: 720px; background: #fff; border: 1px solid #e6e6ea; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,.06); padding: 22px 24px; position: relative; }
  .of-slide-no { position: absolute; top: 10px; right: 14px; font-size: 12px; color: #b0b0b6; }
  .of-slide-img { max-width: 100%; border-radius: 6px; margin: 6px 0; display: block; }
  .of-slide-txt { font-size: 16px; line-height: 1.6; margin: 5px 0; }
  .of-slide-empty { color: #b0b0b6; font-size: 14px; }
  .of-approx { font-size: 12px; color: #9a9aa0; text-align: center; padding: 6px 20px 30px; }
</style>
