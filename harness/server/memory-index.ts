// 进系统提示词的记忆索引：工作区层与全局层「还活着」的每一条都列一行——标题、一句什么时候用得上、文件名，没确认的、
// 被隔离的带一个短标记。模型据此在用户随口提到一个代号、一条规矩时知道指的是哪条，再按文件名去读全文。
//
// 不列的：被替代的（superseded）、用户驳回的、命中注入特征的、疑似含凭据的——后两类只给个数（K9：正文与标题都不该进上下文）。
// 预算随上下文窗口缩放（有上下限）。超了先把描述截短、再去掉描述，还放不下才把最不相关的几条（没确认 / 被隔离的、
// 很少被读、很久没改的）折叠成一句「另有 N 条在这个目录里」——标题能留就留，不整段丢。
//
// 两层的目录路径写在段首：模型可以直接 Read / Grep / Glob 读、Write / Edit 改（权限见 memory-files.ts）。目录还不存在也写上
// 路径，第一条笔记就写在那里。渲染只读不建目录。
import { existsSync } from "node:fs";
import { globalMemoryFor, listMemories, memoryDir, modelFacing, noteFlag, type MemoryMeta, type MemoryType } from "./memory.ts";
import { memoryUsage } from "./memory-usage.ts";

export interface MemoryBudgets {
  workspace: number;
  global: number;
}

const DEFAULT_WINDOW = 200_000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(n)));

// 字符预算：窗口每 token 给工作区层 0.08 字（200k 窗口 ≈ 16k 字 ≈ 4k token，2%），全局层 0.03 字
export function memoryBudgets(contextWindow?: number): MemoryBudgets {
  const w = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_WINDOW;
  return { workspace: clamp(w * 0.08, 4_000, 24_000), global: clamp(w * 0.03, 2_000, 8_000) };
}

const STATUS_RANK: Record<string, number> = { active: 0, proposed: 1, stale: 2 };
const TYPE_RANK: Record<MemoryType, number> = { user: 0, feedback: 1, project: 2, reference: 3 };
const DESC_FULL = 160;
const DESC_SHORT = 70;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

interface Entry {
  m: MemoryMeta;
  relevance: number;
}

function line(e: Entry, desc: number): string {
  const m = e.m;
  const flag = noteFlag(m);
  const title = oneLine(m.title || m.id);
  const d = desc > 0 && m.description && oneLine(m.description) !== title ? ` — ${clip(oneLine(m.description), desc)}` : "";
  return `- ${title}${d} · ${m.id}.md${flag ? ` (${flag})` : ""}`;
}

export interface LayerIndex {
  lines: string[];
  listed: number;
  folded: number;
  withheld: number;
  rejected: number;
}

// 一层的索引行（不含段首）。没有可列的条目返回 null。
export function layerIndex(root: string, budget: number): LayerIndex | null {
  if (!existsSync(memoryDir(root))) return null;
  const all = listMemories(root);
  const withheld = all.filter((m) => m.issues.includes("injection-pattern") || m.issues.includes("sensitive-content")).length;
  const rejected = all.filter((m) => m.declaredStatus === "rejected").length;
  const live = all.filter(
    (m) => m.declaredStatus !== "rejected" && m.declaredStatus !== "superseded" && m.status !== "superseded" &&
      !m.issues.includes("injection-pattern") && !m.issues.includes("sensitive-content"),
  );
  if (!live.length && !withheld && !rejected) return null;
  const uses = memoryUsage(root);
  const now = Date.now();
  const entries: Entry[] = live.map((m) => {
    const age = (now - (Date.parse(m.updated) || 0)) / 86_400_000;
    // 越大越该留：生效的优先，读得多的、最近改过的其次
    const relevance = (2 - (STATUS_RANK[m.status] ?? 2)) * 100 + Math.min(50, (uses[m.id]?.n ?? 0) * 5) + Math.max(0, 30 - age / 6);
    return { m: modelFacing(m), relevance };
  });
  entries.sort(
    (a, b) =>
      (STATUS_RANK[a.m.status] ?? 3) - (STATUS_RANK[b.m.status] ?? 3) ||
      TYPE_RANK[a.m.type] - TYPE_RANK[b.m.type] ||
      (b.m.updated || "").localeCompare(a.m.updated || "") ||
      a.m.id.localeCompare(b.m.id),
  );
  const tail = (folded: number): string[] => [
    ...(folded ? [`- (${folded} more notes in this directory are not listed here for space — Glob or Recall finds them)`] : []),
    ...(withheld ? [`- (${withheld} notes are withheld: they match prompt-injection patterns or appear to hold a credential; the user reviews them in the memory panel)`] : []),
    ...(rejected ? [`- (${rejected} notes the user rejected are not listed; do not save those claims again)`] : []),
  ];
  const size = (ls: string[]): number => ls.reduce((n, l) => n + l.length + 1, 0);
  for (const desc of [DESC_FULL, DESC_SHORT, 0]) {
    const ls = entries.map((e) => line(e, desc));
    if (size(ls) + size(tail(0)) <= budget) return { lines: [...ls, ...tail(0)], listed: ls.length, folded: 0, withheld, rejected };
  }
  // 还放不下：去掉描述，按相关度留下放得下的那些（留下的仍按原来的次序）
  const keep = new Set<Entry>();
  let used = size(tail(entries.length));
  for (const e of [...entries].sort((a, b) => b.relevance - a.relevance)) {
    const cost = line(e, 0).length + 1;
    if (used + cost > budget) continue;
    keep.add(e);
    used += cost;
  }
  const kept = entries.filter((e) => keep.has(e)).map((e) => line(e, 0));
  const folded = entries.length - kept.length;
  return { lines: [...kept, ...tail(folded)], listed: kept.length, folded, withheld, rejected };
}

// 工作区层（不含段首；没有可列的条目 = undefined）——记忆面板算「进提示的字数」也用它
export function renderMemoryForPrompt(root: string, budget = memoryBudgets().workspace): string | undefined {
  return layerIndex(root, budget)?.lines.join("\n");
}

export function renderGlobalMemoryForPrompt(globalRoot: string, budget = memoryBudgets().global): string | undefined {
  return layerIndex(globalRoot, budget)?.lines.join("\n");
}

// World State 的 memory 节变了、而模型手里那一版的原文还知道时：只报两版之间增删的行（后台沉淀每存一条、离线整理晋升一条，
// 都不该把整份索引再发一遍）。段首变了（某层从「还没有笔记」到有了）、或者差不多整份都变了：null，由调用方整份重发。
export function memoryIndexChanges(prev: string, next: string): string | null {
  const a = prev.split("\n\n");
  const b = next.split("\n\n");
  if (a.length !== b.length) return null;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const [headA, ...linesA] = a[i].split("\n");
    const [headB, ...linesB] = b[i].split("\n");
    if (headA !== headB) return null;
    const inA = new Set(linesA);
    const inB = new Set(linesB);
    const added = linesB.filter((l) => !inA.has(l));
    const removed = linesA.filter((l) => !inB.has(l));
    if (!added.length && !removed.length) continue;
    out.push(
      `${headB.split(" — ")[0]}:` +
        (added.length ? `\nNew or changed:\n${added.join("\n")}` : "") +
        (removed.length ? `\nNo longer listed (removed, or replaced by a changed line above):\n${removed.join("\n")}` : ""),
    );
  }
  if (!out.length) return null;
  const text = `Memory index changed — only the differences from the version you last saw; every other line of it still stands:\n\n${out.join("\n\n")}`;
  return text.length < next.length * 0.6 ? text : null;
}

// 进 system（与 World State 的 memory 节）的整段：两层各带段首与目录路径。空的层也写路径（第一条就写在那里）。
export function renderAllMemoryForPrompt(root: string, opts: { contextWindow?: number } = {}): string {
  const budget = memoryBudgets(opts.contextWindow);
  const local = layerIndex(root, budget.workspace);
  const globalRoot = globalMemoryFor(root);
  const global = layerIndex(globalRoot, budget.global);
  const parts = [
    local
      ? `This workspace — notes are Markdown files in ${memoryDir(root)}:\n${local.lines.join("\n")}`
      : `This workspace — no notes yet; they go in ${memoryDir(root)} as Markdown files.`,
    global
      ? `Global — about the user and this machine, shared by every workspace; files in ${memoryDir(globalRoot)}:\n${global.lines.join("\n")}`
      : `Global — about the user and this machine, shared by every workspace: no notes yet; they go in ${memoryDir(globalRoot)}.`,
  ];
  return parts.join("\n\n");
}
