// 改文件时保住原文件的换行风格与 BOM。模型看到的、写出来的一律是 LF、不带 BOM；照原样写回，CRLF 的 .bat / .ps1 / .reg
// 和带 BOM 的文件就被悄悄改了格式（编码题里 MiMo、fp8、27B、Kimi 都栽过）。

export type Eol = "lf" | "crlf" | "mixed" | "none";

export function eolOf(text: string): Eol {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf && lf ? "mixed" : crlf ? "crlf" : lf ? "lf" : "none";
}

const BOM = "﻿";

/**
 * 整份覆盖已有文件时，把模型给的内容换成原文件的风格：原文件统一是 CRLF（或统一是 LF）而新内容统一是另一种，就换过去；
 * 原文件带 BOM、新内容没带就补上。混合换行的原文件、新内容自己就是混合的，都不动——那多半是有意为之，猜不准。
 */
export function matchFileStyle(previous: string, next: string): { text: string; notes: string[] } {
  let text = next;
  const notes: string[] = [];
  const was = eolOf(previous);
  const now = eolOf(text);
  if (was === "crlf" && now === "lf") {
    text = text.replace(/\n/g, "\r\n");
    notes.push("kept CRLF line endings");
  } else if (was === "lf" && now === "crlf") {
    text = text.replace(/\r\n/g, "\n");
    notes.push("kept LF line endings");
  }
  if (previous.startsWith(BOM) && !text.startsWith(BOM)) {
    text = BOM + text;
    notes.push("kept the UTF-8 BOM");
  }
  return { text, notes };
}

/** LF 视图（CRLF 折成 LF）里的位置 → 原文里的位置。 */
export function rawIndex(raw: string, lfIndex: number): number {
  let r = 0;
  for (let l = 0; l < lfIndex && r < raw.length; l++) r += raw[r] === "\r" && raw[r + 1] === "\n" ? 2 : 1;
  return r;
}

/**
 * 混合换行的文件只改命中的那一段：在 LF 视图里定位，回到原文拼接。新文字的换行跟被替换那段走；那段里没有换行，就跟它所在那一行
 * 的行尾走（最后一行没有行尾就看上一行）。整份按 CRLF 或 LF 重写会把其余几百行的换行一起改掉。
 */
export function spliceMixed(raw: string, lfStart: number, lfLen: number, replacementLF: string): string {
  const start = rawIndex(raw, lfStart);
  const end = rawIndex(raw, lfStart + lfLen);
  const region = raw.slice(start, end);
  let useCrlf: boolean;
  if (region.includes("\n")) useCrlf = region.includes("\r\n");
  else {
    const next = raw.indexOf("\n", end);
    const prev = raw.lastIndexOf("\n", start - 1);
    const at = next >= 0 ? next : prev;
    useCrlf = at > 0 && raw[at - 1] === "\r";
  }
  return raw.slice(0, start) + (useCrlf ? replacementLF.replace(/\n/g, "\r\n") : replacementLF) + raw.slice(end);
}
