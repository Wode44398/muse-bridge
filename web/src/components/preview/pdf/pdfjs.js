// PDF.js 加载与公共参数（PdfView / 缩略图 / Office 转出的 PDF 共用一份）。
//   · 核心 ~450KB、查看器层 ~310KB 都按需动态加载，worker 走 ?url 本地资源，不依赖 CDN。
//   · cmaps / 标准字体 / wasm / icc 由 scripts/pdfjs-assets.mjs 随包带上，地址按 BASE_URL + 版本拼：
//     中文 PDF 不嵌字体时靠 cmaps 才不丢字，扫描件的 JBIG2 / JPX 靠 wasm 解码——离线 apk 同样可用。
//   · 画布清晰度：DPR 上限触屏 2、电脑 2.5（更高的屏幕肉眼差别很小，内存翻倍），再加整张画布像素上限防 OOM；
//     放大到上限以外由 PDF.js 的「细节画布」只补画可见区域，放大后照样锐利。
import { pointer } from '../../../lib/layout.svelte.js';

let loading = null;

/** 载入 PDF.js 核心与查看器层；失败后下次重试（不缓存失败的 Promise）。 */
export function loadPdfjs() {
  if (!loading) {
    loading = (async () => {
      const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      // pdf_viewer.mjs 在模块顶层从 globalThis.pdfjsLib 解构核心 API，必须先挂上再 import 它
      globalThis.pdfjsLib = lib;
      capPixelRatio(lib);
      const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
      return { lib, viewer };
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

// OutputScale.pixelRatio 是 PDF.js 所有画布（页面、细节、缩略图）取 DPR 的唯一出口，在这里统一封顶。
function capPixelRatio(lib) {
  const OS = lib.OutputScale;
  if (!OS || OS.__bridgeCapped) return;
  try {
    Object.defineProperty(OS, 'pixelRatio', {
      configurable: true,
      get: () => Math.min(globalThis.devicePixelRatio || 1, pointer.fine ? 2.5 : 2),
    });
    OS.__bridgeCapped = true;
  } catch { /* 定义不上就用 PDF.js 自己的值 */ }
}

/** 单张画布像素上限：触屏 4M（约 16MB 显存），电脑 12M。 */
export const maxCanvasPixels = () => (pointer.fine ? 12 * 1024 * 1024 : 4 * 1024 * 1024);

/** 随包数据文件的绝对地址（worker 里取数要绝对 URL）。 */
export function assetBase(lib) {
  return new URL(`${import.meta.env.BASE_URL}assets/pdfjs-${lib.version}/`, location.href).href;
}

/** getDocument 的公共参数。 */
export function docParams(lib, url, extra = {}) {
  const base = assetBase(lib);
  return {
    url,
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    wasmUrl: base + 'wasm/',
    iccUrl: base + 'iccs/',
    // 不让 PDF.js 用 eval 编译字形路径：分享页面向公网，宁可慢一点
    isEvalSupported: false,
    ...extra,
  };
}

// PDF.js 查看器层自带的 Fluent 本地化会挂 MutationObserver 盯整个容器；我们自己的 UI 不用它，换成空实现。
export const quietL10n = {
  getLanguage: () => 'zh-CN',
  getDirection: () => 'ltr',
  get: async (_ids, _args, fallback) => fallback ?? '',
  translate: async () => {},
  translateOnce: async () => {},
  pause() {},
  resume() {},
  destroy: async () => {},
};

/** 把错误归类：password（要密码，PasswordException 由 onPassword 处理，这里兜底）、corrupt、missing、network。 */
export function classifyPdfError(e) {
  const name = e?.name || '';
  if (name === 'PasswordException') return 'password';
  if (name === 'InvalidPDFException' || /invalid pdf|corrupt|bad xref|startxref/i.test(e?.message || '')) return 'corrupt';
  if (name === 'ResponseException' || name === 'MissingPDFException') return (e?.status === 404 ? 'missing' : 'network');
  if (/fetch|network|load failed/i.test(e?.message || '')) return 'network';
  return 'other';
}
