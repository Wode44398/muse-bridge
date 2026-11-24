// SKILL.md 与命令文件（Claude Code 格式）的 frontmatter：只认「键: 值」一行的写法、YAML 的块标量（| 与 >）和「- 条目」列表，
// 不引 YAML 库——这几个字段从来不需要更多。
export const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[^\n]*(?:\r?\n|$)/;

export const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// 头（frontmatter 里面那段）与正文（去掉 frontmatter、去掉首尾空白）
export function splitFrontmatter(text: string): { head: string; body: string } {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = FRONTMATTER_RE.exec(t);
  return m ? { head: m[1], body: t.slice(m[0].length).trim() } : { head: "", body: t.trim() };
}

const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, "$2");

export function frontmatterValue(head: string, key: string): string | undefined {
  const m = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, "m").exec(head);
  if (!m) return undefined;
  return unquote(m[1]);
}

// 允许多行的文字字段（description: | 或 > 后面缩进的几行）
export function frontmatterText(head: string, key: string): string | undefined {
  const lines = head.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${key}[ \\t]*:`).test(l));
  if (at < 0) return undefined;
  const first = lines[at].slice(lines[at].indexOf(":") + 1).trim();
  if (!/^[|>][-+]?$/.test(first)) return unquote(first);
  const block: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && !/^\s/.test(l)) break;
    block.push(l.trim());
  }
  return block.join(first.startsWith(">") ? " " : "\n").trim();
}

// 列表字段：一行逗号分隔（括号里的逗号不算），或下面跟着几行「- 条目」，或 [a, b] 写法
export function frontmatterList(head: string, key: string): string[] {
  const lines = head.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${key}[ \\t]*:`).test(l));
  if (at < 0) return [];
  let first = lines[at].slice(lines[at].indexOf(":") + 1).trim();
  if (!first) {
    const items: string[] = [];
    for (const l of lines.slice(at + 1)) {
      const m = /^\s*-\s+(.*)$/.exec(l);
      if (!m) break;
      items.push(unquote(m[1]));
    }
    return items.filter(Boolean);
  }
  if (first.startsWith("[") && first.endsWith("]")) first = first.slice(1, -1);
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of first) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(unquote).filter(Boolean);
}
