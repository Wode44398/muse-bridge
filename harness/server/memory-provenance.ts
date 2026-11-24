// 模型直接用 Write / Edit 写进记忆目录的笔记：来源（哪个会话、那个会话读没读过外部内容）记在目录里的 .provenance.json，
// 不往模型刚写的文件里插 frontmatter——插了会让它下一次 Edit 的 old_string 对不上。读入笔记时（memory.ts listMemories）
// 按 id 合进去：external 照样把它压成 proposed，来源会话给离线整理回看原始对话。经 saveMemory 存的笔记把这些写进 frontmatter，
// 存完就把这里的那一项清掉。
import { readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";

export interface Provenance {
  at: string;
  session?: string;
  external?: boolean;
}

export const PROVENANCE_FILE = ".provenance.json";

export function readProvenance(dir: string): Record<string, Provenance> {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, PROVENANCE_FILE), "utf8")) as { v?: number; notes?: Record<string, Provenance> };
    return raw?.v === 1 && raw.notes && typeof raw.notes === "object" ? raw.notes : {};
  } catch {
    return {};
  }
}

function write(dir: string, notes: Record<string, Provenance>): void {
  try {
    atomicWriteFileSync(path.join(dir, PROVENANCE_FILE), JSON.stringify({ v: 1, notes }, null, 1) + "\n");
  } catch {
    /* 来源是参考：写不了不挡住笔记本身 */
  }
}

// 记一次直接写入。external 一旦记上就留着（同一个文件后来在干净的会话里又改了一个字，不等于外部内容的影响没了）
export function noteProvenance(dir: string, id: string, p: { session?: string; external?: boolean }): void {
  const notes = readProvenance(dir);
  const prev = notes[id];
  notes[id] = {
    at: new Date().toISOString(),
    ...(p.session ?? prev?.session ? { session: p.session ?? prev?.session } : {}),
    ...(p.external || prev?.external ? { external: true } : {}),
  };
  write(dir, notes);
}

export function clearProvenance(dir: string, id: string): void {
  const notes = readProvenance(dir);
  if (!(id in notes)) return;
  delete notes[id];
  write(dir, notes);
}
