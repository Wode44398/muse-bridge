// PDF 页面缩略图（侧栏缩略图、幻灯片缩略图条、触屏页面网格共用）。
//   · 只画「想要」的页（缩略图列表里进了视口的那几张），后进先出：快速拖过一长串时先画停下来那一屏；一次只画一张，不和主视图抢 worker。
//   · 主视图刚画完的页直接从它的画布缩一张（pagerendered），不再让 PDF.js 重画一遍。
//   · 产物是 JPEG 的 blob: 地址（比留着 canvas 省内存，300 页也就几 MB），销毁时统一回收。
//   · 旋转后缩略图整体作废重画。
import { SvelteMap } from 'svelte/reactivity';

export class PdfThumbs {
  /** 页码 → blob: 地址（响应式） */
  urls = new SvelteMap();
  #pdf;
  #width;
  #rotation = 0;
  #want = new Set();
  #queue = [];
  #busy = false;
  #gen = 0;
  #dead = false;

  /** @param {any} pdf PDFDocumentProxy  @param {{ width?: number }} o width = 缩略图 CSS 宽 */
  constructor(pdf, { width = 160 } = {}) {
    this.#pdf = pdf;
    this.#width = width;
  }

  get rotation() { return this.#rotation; }
  set rotation(r) {
    r = ((r % 360) + 360) % 360;
    if (r === this.#rotation) return;
    this.#rotation = r;
    this.#gen++;
    this.#clear();
    this.#queue = [...this.#want];
    this.#pump();
  }

  want(n) {
    if (this.#dead) return;
    this.#want.add(n);
    if (this.urls.has(n)) return;
    const i = this.#queue.indexOf(n);
    if (i >= 0) this.#queue.splice(i, 1);
    this.#queue.push(n);
    this.#pump();
  }

  unwant(n) { this.#want.delete(n); }

  /** 主视图画好的页：缩一张存起来（只收旋转一致、画布有内容的） */
  fromCanvas(n, canvas, rotation) {
    if (this.#dead || this.urls.has(n) || !canvas?.width || !canvas.height) return;
    if (((rotation ?? this.#rotation) % 360) !== this.#rotation) return;
    const gen = this.#gen;
    try {
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(this.#width * dpr));
      const h = Math.max(1, Math.round((w * canvas.height) / canvas.width));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, w, h);
      this.#store(n, c, gen);
    } catch { /* 跨域污染等：留给队列正常画 */ }
  }

  async #pump() {
    if (this.#busy || this.#dead) return;
    this.#busy = true;
    try {
      while (this.#queue.length && !this.#dead) {
        const n = this.#queue.pop();
        if (!this.#want.has(n) || this.urls.has(n)) continue;
        await this.#render(n);
      }
    } finally { this.#busy = false; }
  }

  async #render(n) {
    const gen = this.#gen;
    try {
      const page = await this.#pdf.getPage(n);
      if (gen !== this.#gen || this.#dead) return;
      const rotation = (page.rotate + this.#rotation) % 360;
      const vp1 = page.getViewport({ scale: 1, rotation });
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      const scale = (this.#width * dpr) / vp1.width;
      const vp = page.getViewport({ scale, rotation });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(vp.width));
      c.height = Math.max(1, Math.floor(vp.height));
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, background: '#fff' }).promise;
      await this.#store(n, c, gen);
    } catch { /* 单页坏了就留占位 */ }
  }

  #store(n, canvas, gen) {
    return new Promise((res) => {
      canvas.toBlob((b) => {
        if (b && gen === this.#gen && !this.#dead && !this.urls.has(n)) this.urls.set(n, URL.createObjectURL(b));
        canvas.width = canvas.height = 0;
        res();
      }, 'image/jpeg', 0.82);
    });
  }

  #clear() {
    for (const u of this.urls.values()) { try { URL.revokeObjectURL(u); } catch {} }
    this.urls.clear();
  }

  destroy() {
    this.#dead = true;
    this.#queue = [];
    this.#want.clear();
    this.#clear();
  }
}
