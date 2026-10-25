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
// 想留下来的快照可以「存为工作空间」：桶原地留着、登记成普通项目，路径记进指针文件的 adopted
// 名单——此后 isQuickPath 不再认它，会话列表、项目发现、记忆沉淀都把它当普通工作空间；快照位
// 同时换上新桶。桶不搬家：会话的 workspace 快照写死了这个路径。
//
// 桶放 ~/.dimensio/quick/<uuid>（与全局 GUIDE.md 同一个状态目录）；指针文件
// quick.json 与 projects.json/runtime-config.json 同住 harness 根，均可用环境
// 变量改道（测试 / 并行 worktree）。

export const QUICK_NAME = "快照对话";

export interface QuickProject extends Project {
  quick: true;
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

const underRoot = (p: string): boolean => {
  const rel = path.relative(fold(quickRoot()), fold(path.resolve(p)));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
};

// 指针文件全文：当前桶 + 已存为工作空间的桶（adopted）+ 「快照会话 N」的编号计数（seq，只增不减）。
interface PointerFile {
  rec: any;
  adopted: string[];
  seq: number;
}
// 只有「文件不存在 / 内容坏了」才当作没有指针（随后现铸新桶）。读不了（Windows 上杀软 / 索引器短暂占着 → EBUSY、EPERM）
// 不能当成没有：以前一律吞掉，一次读失败就悄悄换掉快照桶，连 adopted 名单也被 mint 冲掉——正在跑的快照对话随之从侧栏消失。
function readPointer(): PointerFile {
  let text = "";
  for (let i = 0; ; i++) {
    try {
      text = readFileSync(storeFile(), "utf8");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { rec: null, adopted: [], seq: 0 };
      if (i >= 2) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // 同步小睡 20ms 再试
    }
  }
  try {
    const raw = JSON.parse(text);
    return {
      rec: raw,
      adopted: Array.isArray(raw?.adopted) ? raw.adopted.filter((x: unknown): x is string => typeof x === "string") : [],
      seq: Number.isInteger(raw?.seq) && raw.seq > 0 ? raw.seq : 0,
    };
  } catch {
    return { rec: null, adopted: [], seq: 0 };
  }
}
function writePointer(rec: QuickRec, adopted: string[], seq: number): void {
  const body = { v: 1, ...rec, ...(adopted.length ? { adopted } : {}), ...(seq ? { seq } : {}) };
  atomicWriteFileSync(storeFile(), JSON.stringify(body, null, 2) + "\n"); // M6：唯一临时名 + fsync
}

// 已存为工作空间的桶（不再是快照了）
export function isAdoptedQuickPath(p: string | undefined): boolean {
  if (!p?.trim() || !underRoot(p)) return false;
  const key = fold(path.resolve(p));
  try {
    return readPointer().adopted.some((a) => fold(path.resolve(a)) === key);
  } catch {
    return false; // 指针这会儿读不了：按快照处理（列表过滤照旧，不至于整个接口 500）
  }
}

// 这个路径是不是（任意一代）快照桶——项目发现、置顶/隐藏、会话列表都用它把
// 快照世界与项目世界隔开。存为工作空间的桶不算（它已经是普通项目了）。
export function isQuickPath(p: string | undefined): boolean {
  if (!p?.trim()) return false;
  return underRoot(p) && !isAdoptedQuickPath(p);
}

interface QuickRec {
  id: string;
  path: string;
  createdAt: number;
}

let lastBucket: QuickRec | null = null; // currentBucket 读不了指针时的退路

function mint(): QuickRec {
  const id = crypto.randomUUID();
  const dir = path.join(quickRoot(), id);
  mkdirSync(dir, { recursive: true });
  const rec: QuickRec = { id, path: dir, createdAt: Date.now() };
  const { adopted, seq } = readPointer();
  writePointer(rec, adopted, seq);
  return (lastBucket = rec);
}

// 当前快照桶（幂等）：有就返回，指针缺失/损坏/指到根外/已被存走就现铸一只。
// 指针短暂读不了时沿用上一次读到的桶（同一个桶根下才算），不现铸、不报错。
function currentBucket(): QuickRec {
  let rec: any;
  try {
    rec = readPointer().rec;
  } catch (e) {
    if (lastBucket && underRoot(lastBucket.path)) return lastBucket;
    throw e;
  }
  if (rec?.v !== 1 || typeof rec.id !== "string" || typeof rec.path !== "string" || !isQuickPath(rec.path)) {
    return mint();
  }
  try {
    mkdirSync(rec.path, { recursive: true });
  } catch {
    return mint();
  }
  return (lastBucket = { id: rec.id, path: path.resolve(rec.path), createdAt: Number(rec.createdAt) || 0 });
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

// 「存为工作空间」的快照这一半（项目登记那一半在 projects.ts 的 registerSavedQuick，由路由串起来：
// 先 currentQuickForSave 拿桶与编号 → 登记项目 → adoptCurrentQuick 摘出快照、换新桶。先登记再摘，
// 中途失败桶还是快照，不会两头落空）。expectPath = 前端以为的当前快照：别的设备刚换过就拒绝，
// 免得把另一只空桶存走。
export function currentQuickForSave(expectPath?: string): { path: string; seq: number } {
  const bucket = currentBucket();
  if (expectPath?.trim() && fold(path.resolve(expectPath)) !== fold(bucket.path)) {
    throw Object.assign(new Error("快照已经换过了，请刷新后再试"), { status: 409 });
  }
  return { path: bucket.path, seq: readPointer().seq + 1 };
}
export function adoptCurrentQuick(saved: { path: string; seq: number }): QuickProject {
  const { adopted } = readPointer();
  const id = crypto.randomUUID();
  const next: QuickRec = { id, path: path.join(quickRoot(), id), createdAt: Date.now() };
  mkdirSync(next.path, { recursive: true });
  writePointer(next, [...adopted, path.resolve(saved.path)], saved.seq);
  lastBucket = next;
  return asProject(next);
}

export function isCurrentQuickPath(p: string | undefined): boolean {
  if (!isQuickPath(p)) return false;
  try {
    return fold(path.resolve(p!)) === fold(currentBucket().path);
  } catch {
    return false;
  }
}

// 换了新快照之后，上一条快照在快照区多留这么久（从它最后一次变动算起）
export const QUICK_LINGER_MS = 30 * 60_000;

// /api/sessions 的过滤器（每个请求现做一个——它带状态）。喂进来的列表已按 updatedAt 倒序。快照桶的会话放行：
//   ① 当前桶的最新一条；
//   ② 所有快照里最新的那一条（刚点了「新建快照」、新桶里还没说话时，上一条不消失）；
//   ③ 还在跑 / 在等人的（busy），哪只桶都算；
//   ④ 最近 QUICK_LINGER_MS 内动过的。
// 其余（旧桶的老会话、当前桶更旧的会话）隐藏，文件留盘不删。
// 以前只认①：别处一点「新建快照」，正在跑的那条快照对话当场从所有侧栏消失（2026-10-13 实测）。
export function quickSessionFilter(opts: { busy?: (id: string) => boolean; now?: number } = {}): (m: SessionMeta) => boolean {
  let seenCurrent = false;
  let seenAny = false;
  const now = opts.now ?? Date.now();
  return (m) => {
    if (!isQuickPath(m.workspace)) return true;
    let keep = !seenAny;
    seenAny = true;
    if (!seenCurrent && isCurrentQuickPath(m.workspace)) {
      seenCurrent = true;
      keep = true;
    }
    return keep || Boolean(opts.busy?.(m.id)) || now - m.updatedAt < QUICK_LINGER_MS;
  };
}
