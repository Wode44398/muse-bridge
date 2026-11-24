// 记忆目录当普通文件读写：一个会话可以直接 Read / Grep / Glob 它自己工作区的记忆目录和全局层目录，用 Write / Edit 改里面的
// 笔记（顶层的 .md）。目录里的内部文件（.history、usage.json、来源记录、生成的 MEMORY.md）不许直接写；别的工作区的记忆目录、
// 记忆根下的其余东西（整理状态、旧版迁移标记）读写都不行——工作区之间的隔离是产品契约。
// 能直接写笔记的只有 Write / Edit（白名单）：它们写之前把旧版留进 .history、写之后记下来源；Bash、Terminal、设备拉取等别的
// 带写目标的工具都留不了这些，一律拒（删一条用 Remember 的 delete）。
// 另外几条在工具里再查一遍（memoryWriteGate，bypass 也不放）：内部文件不许写；子 agent / Workflow worker 不写持久记忆（记忆根下哪里都不写）；
// 用户驳回的笔记不许改、不许覆盖；模型写的文本不许自称被驳回。命中注入特征的笔记，Read / Grep 只给扣留说明（与索引、Recall 一致）。
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  archiveMemoryFile,
  declaresRejected,
  globalMemoryFor,
  INJECTION_WITHHELD,
  isNoteFile,
  listMemories,
  memoryDir,
  memoryRoot,
  refreshMemoryIndexFile,
} from "./memory.ts";
import { noteProvenance } from "./memory-provenance.ts";
import { realOrNearest } from "./sandbox.ts";

const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

function inside(dir: string, abs: string): boolean {
  const rel = path.relative(fold(path.resolve(dir)), fold(path.resolve(abs)));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

// 这个工作区的会话能读写的两份记忆目录：[工作区层, 全局层]（目录可以还不存在）
export function ownMemoryDirs(workspaceRoot: string): { root: string; dir: string }[] {
  const globalRoot = globalMemoryFor(workspaceRoot);
  return [
    { root: path.resolve(workspaceRoot), dir: memoryDir(workspaceRoot) },
    { root: globalRoot, dir: memoryDir(globalRoot) },
  ];
}

// 记忆根（沙箱的围栏用；测试进程里解析到临时目录之外会抛：那就是 null）
export function safeMemoryRoot(): string | null {
  try {
    return memoryRoot();
  } catch {
    return null; // 测试进程里解析到临时目录之外会抛：这一项就不比
  }
}

export type MemoryPathKind =
  | { kind: "note"; root: string; dir: string; id: string } // 自己的记忆目录顶层的笔记文件
  | { kind: "own"; root: string; dir: string } // 自己的记忆目录里别的东西（目录本身、内部文件、子目录）
  | { kind: "foreign" }; // 记忆根下、不属于这个工作区的

// at = 比较用的目录写法（字面或真实落点），dir = 对外报的那个（字面）
function kindIn(dirs: OwnDir[], p: string): Exclude<MemoryPathKind, { kind: "foreign" }> | null {
  for (const own of dirs) {
    const at = own.at ?? own.dir;
    if (!inside(at, p)) continue;
    const rel = path.relative(at, p);
    if (rel && !rel.includes(path.sep) && isNoteFile(rel) && fold(rel) !== "memory.md") return { kind: "note", root: own.root, dir: own.dir, id: rel.slice(0, -3) };
    return { kind: "own", root: own.root, dir: own.dir };
  }
  return null;
}

// 真实落点（不存在的部分按最近的已有上级接回去）：8.3 短名（DEPLOY~1.MD）换回长名、链接换成它指向的地方
const real = (p: string): string => realOrNearest(p) ?? p;

// 按字面与真实落点各判一次。笔记 id 一律取真实落点的文件名——用短名写进来的也记在真名下面（来源记录、.history 归档、
// 注入扣留都按 id 查）；字面在自己的记忆目录里、真实落点却在外面（目录里一个指向别处的链接）的，当内部文件处理（不许直接写）
type OwnDir = { root: string; dir: string; at?: string };
const withReal = (dirs: OwnDir[]): OwnDir[] => dirs.map((d) => ({ ...d, at: real(d.dir) }));

function classify(dirs: OwnDir[], abs: string, realDirs: OwnDir[] = withReal(dirs)): MemoryPathKind | null {
  const p = path.resolve(abs);
  const r = real(p);
  const byReal = kindIn(realDirs, r) ?? kindIn(dirs, r);
  if (byReal) return byReal;
  const byLiteral = kindIn(dirs, p);
  return byLiteral ? { kind: "own", root: byLiteral.root, dir: byLiteral.dir } : null;
}

// abs 落在记忆根下面时它是什么；不在记忆根下（也不在自己的记忆目录里）= null
export function memoryPathKind(abs: string, workspaceRoot: string | undefined): MemoryPathKind | null {
  const own = workspaceRoot ? classify(ownMemoryDirs(workspaceRoot), abs) : null;
  if (own) return own;
  const root = safeMemoryRoot();
  if (!root) return null;
  const p = path.resolve(abs);
  return inside(root, p) || inside(real(root), real(p)) ? { kind: "foreign" } : null;
}

// 沙箱用：这个会话能当自己的读写的记忆目录（工作区之外也放行）
export function memoryGrantDirs(workspaceRoot: string): string[] {
  return ownMemoryDirs(workspaceRoot).map((d) => d.dir);
}

// 能直接写笔记文件的工具
const DIRECT_WRITE_TOOLS = new Set(["Write", "Edit"]);

const rejectedMessage = (raw: string): string =>
  `${raw} is a note the user rejected in the memory panel; it stays as their decision record, so it cannot be edited or replaced — only the user can restore or remove it there`;

// 目标文件此刻是不是一条被用户驳回的笔记
function rejectedOnDisk(abs: string): boolean {
  try {
    return existsSync(abs) && declaresRejected(readFileSync(abs, "utf8"));
  } catch {
    return false;
  }
}

// 权限判定用：往这个路径写，要拒的话给出原因；null = 不是记忆目录里的东西，或者是允许直接写的笔记
export function memoryWriteBlock(toolName: string, raw: string, workspaceRoot: string | undefined): string | null {
  let abs: string;
  try {
    abs = path.isAbsolute(raw) || !workspaceRoot ? path.resolve(raw) : path.resolve(workspaceRoot, raw);
  } catch {
    return null;
  }
  const hit = memoryPathKind(abs, workspaceRoot);
  if (!hit) return null;
  if (hit.kind === "foreign") return `${raw} belongs to another workspace's memory (or dimensio's own memory bookkeeping), which this session cannot touch`;
  if (!DIRECT_WRITE_TOOLS.has(toolName)) {
    return `${raw} is in the memory directory: change notes there with Write or Edit (they keep the previous version), or delete one with Remember(action:"delete", id)`;
  }
  if (hit.kind === "own") {
    return `${raw} is not a note file — only top-level .md notes in the memory directory can be written directly (MEMORY.md is generated; .history, usage.json and the other dot files are internal)`;
  }
  return rejectedOnDisk(abs) ? rejectedMessage(raw) : null;
}

// Write / Edit 落盘之前（权限判定之外再管一层，bypass 也照样）：要拒就给出原因。next = 将要写进去的全文
export function memoryWriteGate(abs: string, ctx: { sandbox: { root: string }; memoryWriter?: boolean }, next: string): string | null {
  const hit = memoryPathKind(abs, ctx.sandbox.root);
  if (!hit) return null;
  // 子 agent / Workflow worker：记忆根下一律不写，不管它算不算自己的——worktree 隔离的子 agent 的工作区根是 worktree，父工作区
  // 的记忆目录在它看来是 foreign，bypass 下沙箱与权限判定都不拦
  if (!ctx.memoryWriter) {
    return "Sub-agents and workflow workers can read the memory directory but not write to it. Put what is worth remembering in your report; the main session decides what to save.";
  }
  if (hit.kind === "foreign") return null; // 别的工作区的：沙箱与权限判定管
  // 内部文件（来源记录、.history、生成的索引）：bypass 下权限判定不拦，这里照样不许——改掉来源记录就能洗掉外部内容标记
  if (hit.kind === "own") return memoryWriteBlock("Write", abs, ctx.sandbox.root);
  if (rejectedOnDisk(abs)) return rejectedMessage(path.basename(abs));
  if (declaresRejected(next)) return "status: rejected and rejected_at are set only by the user, in the memory panel — leave them out of the note.";
  return null;
}

// Write / Edit 写一个笔记文件之前：已有的旧版进 .history
export function beforeMemoryWrite(abs: string, workspaceRoot: string): void {
  const hit = memoryPathKind(abs, workspaceRoot);
  if (hit?.kind !== "note" || !existsSync(abs)) return;
  archiveMemoryFile(hit.root, hit.id);
}

// 写完之后：记下来源（会话、读没读过外部内容），重新生成 MEMORY.md。是笔记文件就返回 true（调用方据此报「记忆变了」）
export function afterMemoryWrite(abs: string, workspaceRoot: string, from: { session?: string; external?: boolean }): boolean {
  const hit = memoryPathKind(abs, workspaceRoot);
  if (hit?.kind !== "note") return false;
  noteProvenance(hit.dir, hit.id, from);
  refreshMemoryIndexFile(hit.root);
  return true;
}

// ── 命中注入特征的笔记：给模型看的地方只露标题（K9）。Read / Grep 读到它时同样扣下正文 ──────────────────
// Read 用：abs 是自己记忆目录里命中注入特征的笔记时，给模型的扣留说明；否则 null
export function withheldNoteText(abs: string, workspaceRoot: string): string | null {
  return withheldNoteCheck(workspaceRoot)(abs) ? `${path.basename(abs)}: ${INJECTION_WITHHELD}` : null;
}

// 返回一个判定函数：abs 是不是自己记忆目录里命中注入特征的笔记。每个目录只列一次（Grep 一次遍历里反复问）
export function withheldNoteCheck(workspaceRoot: string): (abs: string) => boolean {
  const dirs = ownMemoryDirs(workspaceRoot);
  const realDirs = withReal(dirs);
  const cache = new Map<string, Set<string>>();
  return (abs) => {
    const hit = classify(dirs, abs, realDirs);
    if (hit?.kind !== "note") return false;
    let held = cache.get(hit.dir);
    if (!held) {
      try {
        held = new Set(listMemories(hit.root).filter((m) => m.issues.includes("injection-pattern")).map((m) => fold(m.id)));
      } catch {
        held = new Set();
      }
      cache.set(hit.dir, held);
    }
    return held.has(fold(hit.id));
  };
}
