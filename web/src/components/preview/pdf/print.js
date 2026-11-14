// PDF 打印（电脑端）：逐页按打印分辨率画成 JPEG，挂进 body 下一个只在打印时显示的容器，再调 window.print()。
// 不走 iframe 打开原文件：带鉴权的地址、转出来的 Office PDF、桌面壳里都一样能打；也不受浏览器自带 PDF 插件有无影响。
// 页面多时分辨率降一档，免得几百页的文档先吃掉上百 MB 内存。

const ID = 'pv-print';

/**
 * @param {any} pdf PDFDocumentProxy
 * @param {{ rotation?: number, signal?: AbortSignal, onprogress?: (done:number, total:number) => void }} o
 * @returns {Promise<boolean>} 是否真的弹出了打印（取消或失败为 false）
 */
export async function printPdf(pdf, { rotation = 0, signal, onprogress } = {}) {
  const n = pdf.numPages;
  const dpi = n > 60 ? 110 : 150;
  const urls = [];
  let host = null, style = null;
  const cleanup = () => {
    host?.remove(); style?.remove();
    for (const u of urls) { try { URL.revokeObjectURL(u); } catch {} }
    urls.length = 0;
  };
  try {
    document.getElementById(ID)?.remove();
    host = document.createElement('div');
    host.id = ID;
    let first = null;
    for (let i = 1; i <= n; i++) {
      if (signal?.aborted) { cleanup(); return false; }
      const page = await pdf.getPage(i);
      const rot = (page.rotate + rotation) % 360;
      const vp = page.getViewport({ scale: dpi / 72, rotation: rot });
      if (!first) first = page.getViewport({ scale: 1, rotation: rot });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print', background: '#fff' }).promise;
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      c.width = c.height = 0;
      page.cleanup?.();
      if (!blob) continue;
      const u = URL.createObjectURL(blob);
      urls.push(u);
      const img = document.createElement('img');
      img.src = u; img.alt = '';
      host.appendChild(img);
      onprogress?.(i, n);
    }
    if (signal?.aborted) { cleanup(); return false; }
    await Promise.all([...host.querySelectorAll('img')].map((im) => im.decode?.().catch(() => {})));
    // 纸张按第一页的尺寸（pt）；横竖混排的文档按各页图片宽度铺满
    const w = first ? Math.round(first.width) : 595, h = first ? Math.round(first.height) : 842;
    style = document.createElement('style');
    style.textContent = `@media screen { #${ID} { display: none !important; } }
@media print {
  @page { size: ${w}pt ${h}pt; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; height: auto !important; overflow: visible !important; }
  body > *:not(#${ID}) { display: none !important; }
  #${ID} { display: block !important; }
  #${ID} img { display: block; width: 100%; height: auto; break-after: page; page-break-after: always; }
  #${ID} img:last-child { break-after: auto; page-break-after: auto; }
}`;
    document.head.appendChild(style);
    document.body.appendChild(host);
    let done = false;
    const finish = () => { if (done) return; done = true; window.removeEventListener('afterprint', finish); setTimeout(cleanup, 0); };
    window.addEventListener('afterprint', finish);
    window.print();
    // Chrome / Edge 的 print() 会阻塞到对话框关掉；不阻塞的环境靠 afterprint，再给一个兜底
    setTimeout(finish, 60_000);
    return true;
  } catch (e) {
    cleanup();
    throw e;
  }
}
