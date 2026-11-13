// 模型档案阶段 1：换行符与 BOM 变更检测。跑题之前给工作区里的文本文件拍一张「换行风格」快照，跑完再比——
// 题目摆好时就有的文件，换行风格或 BOM 变了就记一笔（11-07 基线里 MiMo、fp8、27B 都在编码题上栽在这里）。
// 只看题目摆进去的文件；新建的、删掉的不算。大文件、二进制、node_modules / .git 跳过。
import fs from "node:fs";
import path from "node:path";

export type EolKind = "lf" | "crlf" | "mixed" | "none";
export interface TextStyle {
  eol: EolKind;
  bom: boolean;
}

const SKIP = new Set(["node_modules", ".git", "dist", ".venv", "__pycache__"]);
const MAX_BYTES = 1_000_000;

export function styleOf(buf: Buffer): TextStyle | null {
  if (buf.includes(0)) {
    // UTF-16 文本也满是 NUL：有 BOM 的照样看，别的按二进制跳过
    const u16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
    if (!u16) return null;
    const text = buf.toString(buf[0] === 0xff ? "utf16le" : "latin1");
    return { eol: eolOf(text.split("\u0000").join("")), bom: true };
  }
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { eol: eolOf(buf.toString("latin1")), bom };
}

function eolOf(text: string): EolKind {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf && lf ? "mixed" : crlf ? "crlf" : lf ? "lf" : "none";
}

export function snapshotStyles(root: string): Map<string, TextStyle> {
  const out = new Map<string, TextStyle>();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(abs);
      } else if (e.isFile()) {
        try {
          if (fs.statSync(abs).size > MAX_BYTES) continue;
          const st = styleOf(fs.readFileSync(abs));
          if (st) out.set(path.relative(root, abs).split(path.sep).join("/"), st);
        } catch {
          /* 读不了就不看 */
        }
      }
    }
  };
  walk(root);
  return out;
}

// 跑完后与快照比：返回换行风格或 BOM 变了的文件（相对路径）。原来没有换行（none）的文件、跑完没有换行的文件不算。
export function styleFlips(root: string, before: Map<string, TextStyle>): string[] {
  const after = snapshotStyles(root);
  const flips: string[] = [];
  for (const [rel, was] of before) {
    const now = after.get(rel);
    if (!now) continue;
    const eolChanged = was.eol !== "none" && now.eol !== "none" && was.eol !== now.eol;
    if (eolChanged || was.bom !== now.bom) flips.push(`${rel}(${was.bom ? "bom+" : ""}${was.eol}→${now.bom ? "bom+" : ""}${now.eol})`);
  }
  return flips.sort();
}
