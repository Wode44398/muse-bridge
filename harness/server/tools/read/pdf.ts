// Read 读 PDF：按页抽文本（pdfjs-dist 的 legacy 构建，Node 里不用 canvas、不起 worker 线程）。
// pdfjs-dist 是 harness 自己的依赖（常规解析就能找到）。依赖没装全的旧安装里再从仓库根的 web/ 解析一次（bridge 前端的预览
// 也装着它）；两处都没有时如实说读不了（缺的是 pdfjs-dist，有命令行才提命令行的办法），不报模块错误。
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { disabledTools, tenantShell } from "../../tenant.ts";

export const MAX_PDF_PAGES_PER_READ = 20;
const MAX_PDF_CHARS = 100_000;

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  cleanup?(): void;
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfLoadingTask {
  promise: Promise<PdfDoc>;
  destroy(): Promise<void>;
}
interface PdfJs {
  getDocument(src: Record<string, unknown>): PdfLoadingTask;
}

let loader: Promise<PdfJs | null> | null = null;

async function tryImport(spec: string): Promise<PdfJs | null> {
  try {
    const mod = (await import(spec)) as PdfJs;
    return typeof mod?.getDocument === "function" ? mod : null;
  } catch {
    return null;
  }
}

/** pdfjs 的模块（找不到就是 null）。只找一次。 */
export function loadPdfJs(): Promise<PdfJs | null> {
  loader ??= (async () => {
    const direct = await tryImport("pdfjs-dist/legacy/build/pdf.mjs");
    if (direct) return direct;
    for (const anchor of ["../../../../web/package.json", "../../../web/package.json"]) {
      try {
        const file = createRequire(new URL(anchor, import.meta.url)).resolve("pdfjs-dist/legacy/build/pdf.mjs");
        const mod = await tryImport(pathToFileURL(file).href);
        if (mod) return mod;
      } catch {
        /* 这个位置没有：试下一个 */
      }
    }
    return null;
  })();
  return loader;
}

/** "3"、"1-5"、"1,3,7-9" → 页号（1 起，去重排序）；写错返回 null。 */
export function parsePages(spec: string, total: number): number[] | null {
  const out = new Set<number>();
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+)?)?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : part.includes("-") ? total : a;
    if (a < 1 || b < a) return null;
    for (let i = a; i <= Math.min(b, total); i++) out.add(i);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

// 连续页号压成「1–5, 8」
function ranges(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(i === j ? `${pages[i]}` : `${pages[i]}–${pages[j]}`);
    i = j;
  }
  return out.join(", ");
}

export interface PdfRead {
  ok: boolean;
  text: string;
  summary: string;
  outcome?: string;
}

/** 找不到 pdfjs-dist 时给模型的说明：缺什么；这个实例有命令行才建议走命令行。 */
export function pdfUnavailableText(rel: string, hasShell: boolean): string {
  const why = `${rel} is a PDF, but this server cannot extract PDF text: the pdfjs-dist package it uses is not installed here.`;
  return hasShell
    ? `${why} Extract the text through Bash instead (pdftotext ${rel} -, or python with pypdf).`
    : `${why} Tell the user the PDF could not be read here.`;
}

export async function readPdf(bytes: Buffer, rel: string, pagesArg: unknown): Promise<PdfRead> {
  const pdfjs = await loadPdfJs();
  if (!pdfjs) {
    return { ok: false, summary: "pdf reader unavailable", text: pdfUnavailableText(rel, tenantShell() && !disabledTools().has("Bash")) };
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    let doc: PdfDoc;
    try {
      doc = await task.promise;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const locked = /password/i.test(msg);
      return {
        ok: false,
        summary: locked ? "pdf is encrypted" : "pdf unreadable",
        text: locked ? `${rel} is password-protected; its text cannot be extracted.` : `Could not parse ${rel} as a PDF: ${msg}`,
      };
    }
    const total = doc.numPages;
    const spec = typeof pagesArg === "string" ? pagesArg.trim() : typeof pagesArg === "number" ? String(pagesArg) : "";
    let pages: number[];
    if (spec) {
      const parsed = parsePages(spec, total);
      if (!parsed) return { ok: false, summary: "bad pages", text: `pages "${spec}" is not a page list for ${rel} (${total} pages). Use e.g. "3", "1-5" or "1,4,7-9".` };
      pages = parsed;
    } else {
      pages = Array.from({ length: Math.min(total, MAX_PDF_PAGES_PER_READ) }, (_, i) => i + 1);
    }
    const asked = pages.length;
    pages = pages.slice(0, MAX_PDF_PAGES_PER_READ);
    const parts: string[] = [];
    let chars = 0;
    const done: number[] = [];
    let empty = 0;
    for (const n of pages) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join("").replace(/[ \t]+\n/g, "\n").trim();
      page.cleanup?.();
      if (!text) empty++;
      const block = `--- page ${n} ---\n${text || "(no extractable text on this page)"}`;
      if (chars + block.length > MAX_PDF_CHARS && done.length) break;
      parts.push(block);
      chars += block.length;
      done.push(n);
    }
    const last = done[done.length - 1] ?? 0;
    const notes: string[] = [];
    if (done.length < asked || (!spec && total > last)) {
      const next = last + 1 <= total ? `${last + 1}-${Math.min(total, last + MAX_PDF_PAGES_PER_READ)}` : "";
      notes.push(`[Showed pages ${ranges(done)} of ${total}.${next ? ` Read more with pages: "${next}".` : ""}]`);
    }
    if (empty && empty === done.length) notes.push("[No text layer on these pages — it may be a scanned PDF; render pages to images (e.g. pdftoppm) and Read those instead.]");
    const header = `${rel}: PDF, ${total} page${total === 1 ? "" : "s"}.`;
    return {
      ok: true,
      summary: `read pdf ${rel} (pages ${ranges(done)} of ${total})`,
      outcome: done.length >= total ? `读了全部 ${total} 页` : `读了第 ${ranges(done)} 页（共 ${total} 页）`,
      text: [header, ...parts, ...notes].join("\n\n"),
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** 文件头是不是 PDF。 */
export const looksLikePdf = (head: Buffer): boolean => head.subarray(0, 5).toString("latin1") === "%PDF-";
