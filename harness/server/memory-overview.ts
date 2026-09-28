import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  GLOBAL_MEMORY,
  GLOBAL_PROMPT_BUDGET,
  listMemories,
  memoryDir,
  renderGlobalMemoryForPrompt,
  renderMemoryForPrompt,
  type MemoryMeta,
} from "./memory.ts";
import { memoryUsage } from "./memory-usage.ts";

// K11：记忆总览——设置里的「记忆」面板一次拿齐：全局层、每个有记忆的项目、旧快照桶里散落的记忆。
// 每一处给：条目元数据（与 GET /api/memory 同形）+ 用量（被拉进对话几次、最近一次）+ 进提示的字数 + 历史事件
// （.history 里每一份旧版就是一次「覆盖 / 驳回 / 撤销驳回 / 被替代 / 退场 / 删除」，只读文件名、不读内容）。
// 只读：没有记忆目录的项目不为这次查看去建（listMemories 会建），只计个数。

export type BucketKind = "global" | "project" | "quick";
export type HistoryWhy = "overwrite" | "delete" | "retire" | "superseded" | "reject" | "restore";

export interface OverviewItem extends MemoryMeta {
  uses?: number;
  firstUsed?: string;
  lastUsed?: string;
}

export interface MemoryBucket {
  kind: BucketKind;
  // 前端据此调 /api/memory*：项目 / 快照桶 = 绝对路径；全局层 = "@global"（与前端的 GLOBAL_MEMORY_WS 同一个值）
  ws: string;
  name: string;
  current?: boolean; // 当前工作空间（或当前快照桶）
  hidden?: boolean; // 侧栏里隐藏了的项目（记忆照样生效）
  createdAt?: number; // 快照桶：铸出来的时间
  items: OverviewItem[];
  promptChars: number; // 生效条目以索引行进每个新对话提示的字数
  history: Array<{ id: string; at: string; why: HistoryWhy }>;
}

export interface MemoryOverview {
  at: string;
  budget: number; // 全局层生效索引行的字数上限
  buckets: MemoryBucket[];
  emptyProjects: number; // 还没有任何记忆的项目个数
}

export const GLOBAL_WS = "@global";
const MAX_HISTORY = 400;
const WHY = new Set<HistoryWhy>(["overwrite", "delete", "retire", "superseded", "reject", "restore"]);

// .history/<id>.<2026-09-21T10-22-33-123Z>.<why>.md（memory.ts archiveVersion）；id 只有 [a-z0-9-]，不含点
export function parseHistoryName(file: string): { id: string; at: string; why: HistoryWhy } | null {
  const m = /^([a-z0-9-]+)\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.([a-z]+)\.md$/i.exec(file);
  if (!m || !WHY.has(m[7] as HistoryWhy)) return null;
  const at = `${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`;
  return Number.isFinite(Date.parse(at)) ? { id: m[1]!, at, why: m[7] as HistoryWhy } : null;
}

function historyOf(root: string): MemoryBucket["history"] {
  const dir = path.join(memoryDir(root), ".history");
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const events = names.map(parseHistoryName).filter((e): e is NonNullable<typeof e> => e !== null);
  events.sort((a, b) => a.at.localeCompare(b.at));
  return events.slice(-MAX_HISTORY);
}

function hasNotes(root: string): boolean {
  const dir = memoryDir(root);
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => f.endsWith(".md") && f !== "MEMORY.md");
  } catch {
    return false;
  }
}

function bucketFor(root: string, head: Omit<MemoryBucket, "items" | "promptChars" | "history">): MemoryBucket {
  const usage = memoryUsage(root);
  const items: OverviewItem[] = listMemories(root).map((m) => {
    const u = usage[m.id];
    return u ? { ...m, uses: u.n, firstUsed: u.first, lastUsed: u.last } : m;
  });
  const prompt = root === GLOBAL_MEMORY ? renderGlobalMemoryForPrompt() : renderMemoryForPrompt(root);
  return { ...head, items, promptChars: prompt?.length ?? 0, history: historyOf(root) };
}

export interface OverviewProject {
  path: string;
  name: string;
  hidden?: boolean;
}

// projects：项目列表（与侧栏同一份：注册表 + 历史会话里发现的工作区，不含快照桶）；currentWs：当前工作空间；
// quickRoot / currentQuick：快照桶根与当前那只桶（桶按铸造时间倒序，当前桶排最前）
export function buildMemoryOverview(opts: {
  projects: OverviewProject[];
  currentWs?: string;
  quickRoot?: string;
  currentQuick?: string;
}): MemoryOverview {
  const fold = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const current = opts.currentWs ? fold(opts.currentWs) : "";
  const buckets: MemoryBucket[] = [];

  if (hasNotes(GLOBAL_MEMORY)) buckets.push(bucketFor(GLOBAL_MEMORY, { kind: "global", ws: GLOBAL_WS, name: "全局" }));

  let emptyProjects = 0;
  const seen = new Set<string>();
  for (const p of opts.projects) {
    const key = fold(p.path);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!hasNotes(p.path)) {
      emptyProjects++;
      continue;
    }
    buckets.push(bucketFor(p.path, {
      kind: "project",
      ws: path.resolve(p.path),
      name: p.name,
      ...(key === current ? { current: true } : {}),
      ...(p.hidden ? { hidden: true } : {}),
    }));
  }

  if (opts.quickRoot && existsSync(opts.quickRoot)) {
    const currentQuick = opts.currentQuick ? fold(opts.currentQuick) : "";
    const quick: MemoryBucket[] = [];
    let dirs: string[] = [];
    try {
      dirs = readdirSync(opts.quickRoot);
    } catch {
      /* 桶根读不了：跳过 */
    }
    for (const name of dirs) {
      const dir = path.join(opts.quickRoot, name);
      let createdAt = 0;
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) continue;
        createdAt = Math.round(st.birthtimeMs || st.mtimeMs);
      } catch {
        continue;
      }
      if (!hasNotes(dir)) continue;
      quick.push(bucketFor(dir, {
        kind: "quick",
        ws: path.resolve(dir),
        name: "快照对话",
        createdAt,
        ...(fold(dir) === currentQuick ? { current: true } : {}),
      }));
    }
    quick.sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
    buckets.push(...quick);
  }

  return { at: new Date().toISOString(), budget: GLOBAL_PROMPT_BUDGET, buckets, emptyProjects };
}
