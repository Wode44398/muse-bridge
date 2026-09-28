// K8（Codex X52）：外部记忆库只读挂载。
//
// 其他编码 agent（Codex、Claude Code、Kimi……）共管的记忆库（Claude Code 的格式：frontmatter 里 name / description /
// metadata.type，正文在后；MEMORY.md 是索引）可以挂给 dimensio，在对应的工作区里可以读、永远不写：
//   · Recall(query) 的检索带上它，Recall 用 external:<id> 读全文、layer:"external" 列目录——结果一律标明「外部记忆，未经
//     dimensio 治理」（没有到期、证据、锚点这套治理，可能过时）；
//   · Remember 没有写它的路；不进提示词的索引（只一句「挂着一个外部库、有多少条」），也不会晋升到全局层；
//   · 疑似含凭据的条目整条不收；命中注入特征的只露标题（和受治理的记忆同一套判法）。
// 挂哪个库、给哪些工作区，由 DIMENSIO_EXTERNAL_MEMORY 显式配置（默认不挂）：分号分隔，每项 `<库目录>` 或
// `<库目录>=><工作区>|<工作区>`（不写工作区 = 所有工作区）。每次现读环境变量（与 DIMENSIO_READONLY_PATHS 一样）。
import { readdirSync, readFileSync, statSync } from "node:fs";
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

// MEMORY.md 的索引行 `- [标题](文件.md) — 说明` → 文件名 → 标题
function indexTitles(dir: string): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    for (const m of readFileSync(path.join(dir, "MEMORY.md"), "utf8").matchAll(/^\s*-\s*\[([^\]]+)\]\(([^)]+\.md)\)/gm)) {
      titles.set(path.basename(m[2]), m[1].trim());
    }
  } catch {
    /* 没有索引就用 name */
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
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md") && f !== "MEMORY.md").sort();
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

// 进提示词的只是一句：挂着外部库、有多少条、怎么读（条目本身不进——它没经过治理）
export function externalMemorySummary(workspaceRoot: string): string | undefined {
  if (!externalMemoryDirs(workspaceRoot).length) return undefined;
  const n = listExternalNotes(workspaceRoot).length;
  if (!n) return undefined;
  return `External memory library mounted read-only: ${n} notes kept by other agents on this project, NOT governed by dimensio ` +
    `(no expiry, evidence or anchors — they may be out of date; check against the files). Recall(query) searches them; ` +
    `Recall with layer "external" lists them; read one with Recall(id:"external:<id>"). Remember never writes there.`;
}

// 提示词里的记忆一节：挂了外部库就在末尾补那一句；没挂与以前一字不差
export function withExternalSummary(memory: string | undefined, workspaceRoot: string): string | undefined {
  const ext = externalMemorySummary(workspaceRoot);
  if (!ext) return memory;
  return memory ? `${memory}\n\n${ext}` : ext;
}

// 检索 / 列表里给模型看的那一行（命中注入特征的只露标题）
export function externalLine(n: ExternalNote): string {
  return `- [external:${n.id}] (${n.type}; external, not governed) ${n.title}${n.withheld ? " — (text withheld: it matches prompt-injection patterns)" : n.description ? ` — ${n.description}` : ""}`;
}
