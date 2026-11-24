// 一层目录里的指令文件：AGENTS.md 与 CLAUDE.md 都读（AGENTS.override.md 在场时替代同层的 AGENTS.md）；两份内容一样、
// 或者其中一份只是指向另一份（很短、提到了另一份的文件名，或只有一行 @导入）时只留一份。每份连同它 @导入的文件一起收。
// 读失败（文件被占用之类，不是「不存在」）沿用上次读到的内容，不因为一次偶发错误就整段消失。
import { readFileSync } from "node:fs";
import path from "node:path";
import { collectImports, importRefs, linkEscapes, type ImportedFile } from "./imports.ts";

const lastGood = new Map<string, string>();

// 这一个文件：存在就是它的内容（空文件算命中、内容为空）；不存在 → undefined；别的读错误 → 上次读到的
export function readDoc(file: string): string | undefined {
  try {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.trim();
    lastGood.set(file, text);
    return text;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      lastGood.delete(file);
      return undefined;
    }
    return lastGood.get(file);
  }
}

export interface DocBlock {
  abs: string;
  rel: string; // 相对仓库顶（给模型看的来源）
  text: string;
  importedBy?: string; // 相对路径
}

const fold = (p: string): string => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

// 这一份是不是只是指向另一份：除了标题行，只剩提到那份文件名（或 @导入它）的一两句引导语（「See AGENTS.md」「先读 @AGENTS.md。」）。
// 有任何别的内容（哪怕一句中文规则）都不算指针——宁可两份都收，也不静默丢掉真规则
const POINTER_LINE_MAX = 40; // 引导语去掉文件名之后的字数上限
function pointsTo(text: string, other: string): boolean {
  const t = text.trim();
  if (t.length > 600) return false;
  const name = other.toLowerCase();
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const isMention = (l: string) => l.toLowerCase().includes(name) || importRefs(l).some((r) => path.basename(r).toLowerCase() === name);
  if (!lines.length || !lines.every(isMention) || lines.length > 2) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return lines.every((l) => l.replace(new RegExp(`@?\\S*${esc}`, "gi"), "").trim().length <= POINTER_LINE_MAX);
}

// 一层（dir）里该收的指令文件块（含导入），seen 是整个收集过程里已经收过的文件
// importCache：被导入文件的快照（见 imports.ts 的 collectImports），没给就每次现读
export function levelBlocks(dir: string, top: string, seen: Set<string>, importCache?: Map<string, string>): DocBlock[] {
  const read = (name: string) => {
    const abs = path.join(dir, name);
    // 指令文件本身（或它所在的子目录）是指向别处的链接、真实落点出了范围或是凭据：当它不存在
    if (linkEscapes(abs, top)) return undefined;
    const text = readDoc(abs);
    return text === undefined ? undefined : { name, abs, text };
  };
  const agents = read("AGENTS.override.md") ?? read("AGENTS.md");
  let claude = read("CLAUDE.md");
  if (agents && claude) {
    if (norm(agents.text) === norm(claude.text) || pointsTo(claude.text, agents.name) || pointsTo(claude.text, "AGENTS.md")) claude = undefined;
    else if (pointsTo(agents.text, claude.name)) {
      // AGENTS.md 只是指向 CLAUDE.md：留 CLAUDE.md
      return blocksOf([claude], top, seen, importCache);
    }
  }
  return blocksOf([agents, claude].filter((f): f is NonNullable<typeof f> => Boolean(f)), top, seen, importCache);
}

const relOf = (top: string, abs: string): string => {
  const rel = path.relative(top, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replace(/\\/g, "/") : abs.replace(/\\/g, "/");
};

function blocksOf(files: { name: string; abs: string; text: string }[], top: string, seen: Set<string>, importCache?: Map<string, string>): DocBlock[] {
  const out: DocBlock[] = [];
  for (const f of files) {
    const key = fold(f.abs);
    if (seen.has(key)) continue;
    seen.add(key);
    const imports: ImportedFile[] = collectImports(f.abs, f.text, top, seen, 1, importCache);
    if (f.text) out.push({ abs: f.abs, rel: relOf(top, f.abs), text: f.text });
    for (const i of imports) if (i.text) out.push({ abs: i.abs, rel: relOf(top, i.abs), text: i.text, importedBy: relOf(top, i.by) });
  }
  return out;
}

export function renderBlock(b: DocBlock, text = b.text): string {
  return `<file path="${b.rel}"${b.importedBy ? ` imported-by="${b.importedBy}"` : ""}>\n${text}\n</file>`;
}

// 合计放不下时，从离工作区最远的（排在最前的）开始截：先截短、放不下就整份换成一句「在哪、去读」
export function fitBlocks(blocks: DocBlock[], budget: number): string {
  const rendered = blocks.map((b) => renderBlock(b));
  const total = rendered.reduce((n, r) => n + r.length + 2, 0);
  if (total <= budget) return rendered.join("\n\n");
  const out: string[] = new Array(blocks.length);
  let left = budget;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const full = rendered[i];
    if (full.length + 2 <= left) {
      out[i] = full;
      left -= full.length + 2;
      continue;
    }
    const note = (shown: number) => `\n[… truncated: ${shown} of ${b.text.length} characters of ${b.rel} shown — Read ${b.abs} for the rest]`;
    const room = left - renderBlock(b, "").length - note(b.text.length).length - 2;
    if (room >= 400) {
      out[i] = renderBlock(b, b.text.slice(0, room) + note(room));
      left -= out[i].length + 2;
    } else {
      out[i] = `[${b.rel} (${b.text.length} characters) is not included for space — Read ${b.abs}]`;
      left -= out[i].length + 2;
    }
  }
  return out.join("\n\n");
}
