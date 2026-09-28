import crypto from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { quickFile as storeFile, quickRoot } from "./paths.ts";
import type { Project } from "./projects.ts";
import type { SessionMeta } from "./store.ts";

// 「快照对话」——不属于任何项目时的快问快答落点：一次性的空桶 + 一条对话。
// 语义对齐 bridge Claude 分页的 claude-quick.mjs，但按 harness 的地形重排：
//   1. 不属于任何已有工作空间：桶是现铸的空目录，与用户项目无关；
//   2. 不共用任何记忆：harness 的决策记忆按 workspace 路径隔离（memory.ts 的
//      memoryDir(workspaceRoot)），新桶天然零记忆——没有 Claude CLI 那个
//      「自动记忆按 git 根推导」的坑，无需第二道闸；
//   3. 同时只存在一条对话：/api/sessions 对快照桶只列【当前桶的最新一条】，
//      旧桶的会话全部隐藏（文件留盘不删）；
//   4. 「新建快照」= 换一只新桶（新 workspace → 新记忆作用域 → 新文件空间），
//      旧桶【不删】——万一上一单快照真产出了东西，不至于一键蒸发。
//
// 桶放 ~/.dimensio/quick/<uuid>（与全局 GUIDE.md 同一个状态目录）；指针文件
// quick.json 与 projects.json/runtime-config.json 同住 harness 根，均可用环境
// 变量改道（测试 / 并行 worktree）。

export const QUICK_NAME = "快照对话";

export interface QuickProject extends Project {
  quick: true;
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

// 这个路径是不是（任意一代）快照桶——项目发现、置顶/隐藏、会话列表都用它把
// 快照世界与项目世界隔开。
export function isQuickPath(p: string | undefined): boolean {
  if (!p?.trim()) return false;
  const rel = path.relative(fold(quickRoot()), fold(path.resolve(p)));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

interface QuickRec {
  id: string;
  path: string;
  createdAt: number;
}

function mint(): QuickRec {
  const id = crypto.randomUUID();
  const dir = path.join(quickRoot(), id);
  mkdirSync(dir, { recursive: true });
  const rec: QuickRec = { id, path: dir, createdAt: Date.now() };
  atomicWriteFileSync(storeFile(), JSON.stringify({ v: 1, ...rec }, null, 2) + "\n"); // M6：唯一临时名 + fsync
  return rec;
}

// 当前快照桶（幂等）：有就返回，指针缺失/损坏/指到根外就现铸一只。
function currentBucket(): QuickRec {
  let rec: any;
  try {
    rec = JSON.parse(readFileSync(storeFile(), "utf8"));
  } catch {
    return mint();
  }
  if (rec?.v !== 1 || typeof rec.id !== "string" || typeof rec.path !== "string" || !isQuickPath(rec.path)) {
    return mint();
  }
  try {
    mkdirSync(rec.path, { recursive: true });
  } catch {
    return mint();
  }
  return { id: rec.id, path: path.resolve(rec.path), createdAt: Number(rec.createdAt) || 0 };
}

// 快照桶伪装成一枚项目（quick 标记）——这样 workspace 切换、会话归属、右侧
// 工作台作用域全部沿用项目那套管线，一处不用改。前端据 quick 标记把它从
// 「项目」区摘出去，单独置顶成一行。
const asProject = (rec: QuickRec): QuickProject => ({
  id: rec.id,
  name: QUICK_NAME,
  path: rec.path,
  createdAt: rec.createdAt,
  exists: true,
  pinned: false,
  pinnedAt: 0,
  hidden: false,
  quick: true,
});

export function quickProject(): QuickProject | null {
  try {
    return asProject(currentBucket());
  } catch {
    return null;
  }
}

// 「新建快照」= 换一只新桶（旧桶留盘、不再列出）。
export function newQuickProject(): QuickProject {
  return asProject(mint());
}

export function isCurrentQuickPath(p: string | undefined): boolean {
  if (!isQuickPath(p)) return false;
  try {
    return fold(path.resolve(p!)) === fold(currentBucket().path);
  } catch {
    return false;
  }
}

// /api/sessions 的过滤器（每个请求现做一个——它带状态）：快照桶的会话里只放行
// 【当前桶的最新一条】。喂进来的列表已按 updatedAt 倒序，所以第一条命中当前桶
// 的就是最新的；旧桶的会话与当前桶更旧的会话全部隐藏（文件留盘不删）。
export function quickSessionFilter(): (m: SessionMeta) => boolean {
  let seen = false;
  return (m) => {
    if (!isQuickPath(m.workspace)) return true;
    if (seen || !isCurrentQuickPath(m.workspace)) return false;
    seen = true;
    return true;
  };
}
