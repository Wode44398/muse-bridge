// K8（Codex X52）：外部记忆库只读挂载。
//
// `bridge build/memory` 是 Codex、Claude、Kimi 共管的记忆库（Claude Code 的格式：frontmatter 里 name / description /
// metadata.type，正文在后；MEMORY.md 是索引），dimensio 在对应的工作区里可以读、永远不写：
//   · Recall(query) 的检索带上它，Recall 用 external:<id> 读全文、layer:"external" 列目录——结果一律标明「外部记忆，未经
//     dimensio 治理」（没有到期、证据、锚点这套治理，可能过时）；
//   · Remember 没有写它的路，也不会晋升到全局层。system 里给出库的绝对路径与它的索引（externalMemoryIndex：有 MEMORY.md
//     就放它的正文，没有就列各篇标题，都有预算），会话的沙箱把这些目录开成只读，模型照着链接直接 Read；
//   · 疑似含凭据的条目整条不收；命中注入特征的只露标题（和受治理的记忆同一套判法）。
// 挂哪个库、给哪些工作区，由 DIMENSIO_EXTERNAL_MEMORY 显式配置（默认不挂）：分号分隔，每项 `<库目录>` 或
// `<库目录>=><工作区>|<工作区>`（不写工作区 = 所有工作区）。每次现读环境变量（与 DIMENSIO_READONLY_PATHS 一样）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { containsSensitiveData, injectionSignals } from "./memory.ts";

export interface ExternalNote {
  id: string;
  title: string;
  description: string;
  type: string;
  body: string;
  // 库目录下的文件名（给人看出处）
  source: string;
  // 命中注入特征：正文与说明对模型隐藏，只露标题
  withheld: boolean;
}

const MAX_NOTES = 500;
const MAX_FILE_BYTES = 64 * 1024;

const samePath = (a: string, b: string): boolean => {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};

// 这个工作区挂着哪些外部库（目录必须存在）
export function externalMemoryDirs(workspaceRoot: string): string[] {
  const raw = process.env.DIMENSIO_EXTERNAL_MEMORY ?? "";
  const out: string[] = [];
  for (const entry of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [dir, scope] = entry.split("=>").map((s) => s.trim());
    if (!dir || !path.isAbsolute(dir)) continue;
    const workspaces = (scope ?? "").split("|").map((s) => s.trim()).filter(Boolean);
    if (workspaces.length && !workspaces.some((w) => samePath(w, workspaceRoot))) continue;
    try {
      if (statSync(dir).isDirectory()) out.push(path.resolve(dir));
    } catch {
      /* 配置的库不在了：当没挂 */
    }
  }
  return out;
}

// 索引文件：MEMORY.md 总索引 + MEMORY-<区>.md 分区索引（三层索引），都不是记忆正文
const isIndexFile = (f: string): boolean => /^MEMORY(-.+)?\.md$/i.test(f);

// 索引行 `- [标题](文件.md) — 说明` → 文件名 → 标题（总索引与各分区索引合起来）
function indexTitles(dir: string): Map<string, string> {
  const titles = new Map<string, string>();
  let indexes: string[];
  try {
    indexes = readdirSync(dir).filter(isIndexFile);
  } catch {
    return titles;
  }
  for (const file of indexes) {
    try {
      for (const m of readFileSync(path.join(dir, file), "utf8").matchAll(/^\s*-\s*\[([^\]]+)\]\(([^)]+\.md)\)/gm)) {
        if (!isIndexFile(path.basename(m[2]))) titles.set(path.basename(m[2]), m[1].trim());
      }
    } catch {
      /* 读不到的索引跳过，标题退回 name */
    }
  }
  return titles;
}

function frontmatterField(fm: string, key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*(.*)$`, "m").exec(fm);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

function parseNote(dir: string, file: string, titles: Map<string, string>): ExternalNote | undefined {
  const abs = path.join(dir, file);
  let text: string;
  try {
    if (statSync(abs).size > MAX_FILE_BYTES) return undefined;
    text = readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fm = m?.[1] ?? "";
  const body = (m ? m[2] : text).trim();
  const id = (frontmatterField(fm, "name") || file.replace(/\.md$/i, "")).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 80);
  const description = frontmatterField(fm, "description");
  const title = titles.get(file) ?? id;
  // 疑似含凭据：整条不收（这里不做打码，外部库本来就不该有）
  if (containsSensitiveData(`${title}\n${description}\n${body}`)) return undefined;
  return {
    id,
    title,
    description,
    type: frontmatterField(fm, "type") || "note",
    body,
    source: file,
    withheld: injectionSignals(`${title}\n${description}\n${body}`).length > 0,
  };
}

// 这个工作区能读到的全部外部条目（多个库按配置顺序，同 id 先到先得）
export function listExternalNotes(workspaceRoot: string): ExternalNote[] {
  const notes: ExternalNote[] = [];
  const seen = new Set<string>();
  for (const dir of externalMemoryDirs(workspaceRoot)) {
    const titles = indexTitles(dir);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md") && !isIndexFile(f)).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      if (notes.length >= MAX_NOTES) return notes;
      const note = parseNote(dir, file, titles);
      if (!note || seen.has(note.id)) continue;
      seen.add(note.id);
      notes.push(note);
    }
  }
  return notes;
}

export function readExternalNote(workspaceRoot: string, id: string): ExternalNote | undefined {
  const want = id.toLowerCase();
  return listExternalNotes(workspaceRoot).find((n) => n.id === want);
}

// system 里的外部库一节：库的绝对路径、只读、怎么读（有分区索引就说明分层），后面是它的 MEMORY.md 正文；没有 MEMORY.md 就
// 列各篇标题。合计有预算（随窗口缩放），超了截断并写明截在哪、全文在哪。MEMORY.md 本身命中注入特征或像含凭据的，正文不放，
// 只给路径。建会话时定下（不走 World State）：别的 agent 天天改这个库，模型要最新的照着路径去读就是。
export function externalMemoryBudget(contextWindow?: number): number {
  const w = contextWindow && contextWindow > 0 ? contextWindow : 200_000;
  return Math.max(3_000, Math.min(12_000, Math.round(w * 0.05)));
}

function readIndex(file: string): string | undefined {
  try {
    if (statSync(file).size > MAX_FILE_BYTES * 4) return undefined;
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text.trim();
  } catch {
    return undefined;
  }
}

export function externalMemoryIndex(workspaceRoot: string, budget = externalMemoryBudget()): string | undefined {
  const dirs = externalMemoryDirs(workspaceRoot);
  if (!dirs.length) return undefined;
  const notes = listExternalNotes(workspaceRoot);
  const each = Math.floor(budget / dirs.length);
  const parts: string[] = [];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const areas = files.filter((f) => /^MEMORY-.+\.md$/i.test(f));
    const indexFile = files.find((f) => /^MEMORY\.md$/i.test(f));
    const head =
      `External memory library at ${dir} — read-only: other agents keep it, dimensio never writes there, and it may be out of date (check it against the files). ` +
      (indexFile
        ? areas.length
          ? `It is layered: ${indexFile} (below) points to ${areas.length} area indexes (MEMORY-<area>.md), and those point to single notes — Read the area index for the task, then the notes it links.`
          : `${indexFile} (below) links its notes; Read the ones you need.`
        : "Its notes, one per file:");
    const room = Math.max(500, each - head.length);
    let body: string;
    if (indexFile) {
      const file = path.join(dir, indexFile);
      const text = readIndex(file) ?? "";
      if (!text) body = `(${indexFile} is empty or unreadable)`;
      else if (containsSensitiveData(text) || injectionSignals(text).length) body = `(${indexFile} is not shown here: it matches prompt-injection or credential patterns)`;
      else if (text.length <= room) body = text;
      else body = `${text.slice(0, room)}\n[… ${indexFile} truncated: ${room} of ${text.length} characters shown — Read ${file} for the rest]`;
    } else {
      const own = notes.filter((n) => existsSync(path.join(dir, n.source)));
      const lines: string[] = [];
      let used = 0;
      for (const n of own) {
        const line = `- ${n.title}${n.withheld || !n.description ? "" : ` — ${n.description}`} · ${n.source}`;
        if (used + line.length + 1 > room) break;
        lines.push(line);
        used += line.length + 1;
      }
      if (lines.length < own.length) lines.push(`- (${own.length - lines.length} more notes in that directory)`);
      body = lines.join("\n") || "(no notes)";
    }
    parts.push(`${head}\n\n${body}`);
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

// 会话的沙箱据此把外部库开成只读（不挂就是空）
export function externalReadDirs(workspaceRoot: string): string[] {
  return externalMemoryDirs(workspaceRoot);
}

// 检索 / 列表里给模型看的那一行（命中注入特征的只露标题）
export function externalLine(n: ExternalNote): string {
  return `- [external:${n.id}] (${n.type}; external, read-only) ${n.title}${n.withheld ? " — (text withheld: it matches prompt-injection patterns)" : n.description ? ` — ${n.description}` : ""}`;
}
