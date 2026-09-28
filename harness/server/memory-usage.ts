import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { GLOBAL_MEMORY, memoryDir } from "./memory.ts";

// K11：记忆用量——一条记忆的全文被拉进对话（开跑时的自动召回、Recall 按 id 读全文）的次数、第一次与最近一次。
// 记忆面板据此回答「这条到底有没有被用上」：生效了几个月从没被召回的，多半该退场。
//
// 存在该层记忆目录下的 usage.json（不是 .md：列表、索引、检索都不碰它）。只记 id 与时间，不记查询原文。
// 目录不存在就不记（没有记忆的工作区不为它建目录）；读写出错一律吞掉——用量是参考，绝不挡一轮开跑。
// 并发的两轮同时记，后写的会盖掉先写的一次计数：可以接受（原子写保证文件本身不坏）。

export interface MemoryUse {
  n: number;
  first: string;
  last: string;
}
interface UsageFile {
  v: 1;
  notes: Record<string, MemoryUse>;
}

const usageFile = (root: string) => path.join(memoryDir(root), "usage.json");

export function memoryUsage(root: string): Record<string, MemoryUse> {
  try {
    const raw = JSON.parse(readFileSync(usageFile(root), "utf8")) as UsageFile;
    return raw?.v === 1 && raw.notes && typeof raw.notes === "object" ? raw.notes : {};
  } catch {
    return {};
  }
}

export function noteMemoryUse(root: string, ids: string[], at: Date = new Date()): void {
  const wanted = [...new Set(ids.filter((id) => /^[a-z0-9-]{1,64}$/i.test(id)))];
  if (!wanted.length || !existsSync(memoryDir(root))) return;
  try {
    const notes = memoryUsage(root);
    const iso = at.toISOString();
    for (const id of wanted) {
      const prev = notes[id];
      notes[id] = { n: (prev?.n ?? 0) + 1, first: prev?.first ?? iso, last: iso };
    }
    atomicWriteFileSync(usageFile(root), JSON.stringify({ v: 1, notes } satisfies UsageFile) + "\n");
  } catch (error) {
    console.error(`[memory] usage: ${(error as Error).message}`);
  }
}

// 自动召回的结果是检索文档 id：工作区的记忆是 memory:<id>，全局层是 memory:global:<id>，其余（项目知识）不算
export function noteRecalledDocs(workspaceRoot: string, docIds: string[], at: Date = new Date()): void {
  const local: string[] = [];
  const global: string[] = [];
  for (const doc of docIds) {
    const m = /^memory:(global:)?(.+)$/.exec(doc);
    if (!m) continue;
    (m[1] ? global : local).push(m[2]!);
  }
  if (local.length) noteMemoryUse(workspaceRoot, local, at);
  if (global.length) noteMemoryUse(GLOBAL_MEMORY, global, at);
}
