// 快照对话清理（2026-11-16）：设置 › dimensio › 会话管理「清理快照对话」（prefs 键 quickRetention）。
// 与 bridge Claude 分页的「清理临时对话」（src/claude-quick.mjs）同一套选项、各存各的：
//   ttl30          最后活动超过 30 天的桶进回收站；
//   max10 … max100 只留最近 N 只用过的桶，超出的按最后活动从旧到新进回收站，不看天数；
//   never          不清理（默认：快照以前一直是只藏不删，升级不替用户删东西）。
//
// 为什么要清：快照对话同时只列一条，旧桶只藏不删，一直攒在 ~/.dimensio/quick 下（本机 11-16 实测 113 只、1.3GB）。
//
// 一只桶 = 一条快照对话（桶里可能有好几个会话，按桶算）。最后活动 = 桶目录的修改时间与桶里各会话 updatedAt 取最晚。
// 永不动的：当前桶、已存为工作空间的桶、有会话在跑 / 在等你处理的桶、QUICK_LINGER_MS 内动过的桶（它们照样列在快照区里）。
// 没会话也没文件的空桶（「新建快照」换下来没用过的）：不清理模式之外过了宽限直接删，里面本来就什么都没有。
//
// 回收不直接删：桶目录整只挪进 <桶根>/.recycled/<id>（同卷 rename），旁边一张 <id>.json 记下原路径、时间、会话 id；
// 会话记录原地留着，列表与搜索因桶目录不在了而不再列出（quick.ts 的 quickSessionFilter）。恢复 = 把目录挪回原处。
// 回收站里放满 QUICK_TRASH_DAYS 天才永久删除：桶目录、它的会话（deleteSession，连附件 / 检查点一起）、这个工作区的记忆。
// 回收站对所有方式都照旧到期——选「从不清理」只是不再往里放。
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { memoryDir } from "./memory.ts";
import { onPrefsChange, prefValue } from "./prefs.ts";
import { QUICK_BUCKET_ID, QUICK_LINGER_MS, foldQuickPath, quickBucketOf, quickKeepSet } from "./quick.ts";
import { quickRoot } from "./paths.ts";
import { deleteSession, getSession, noteListChanged, waitingOf } from "./session.ts";
import { listAllSessions, type SessionMeta } from "./store.ts";

const DAY = 86_400_000;
export const QUICK_TTL_DAYS = 30;
export const QUICK_TRASH_DAYS = 30;
const GRACE_MS = 10 * 60_000; // 刚铸、还没用的空桶多久之后才删
const TRASH = ".recycled";

export type QuickRetention = { mode: "ttl" } | { mode: "count"; max: number } | { mode: "never" };
export function quickRetention(v: unknown): QuickRetention {
  const m = /^max(\d{1,4})$/.exec(String(v ?? ""));
  if (m && Number(m[1]) > 0) return { mode: "count", max: Number(m[1]) };
  if (v === "ttl30") return { mode: "ttl" };
  return { mode: "never" };
}

const trashRoot = (): string => path.join(quickRoot(), TRASH);

const sessionBusy = (id: string): boolean => {
  const live = getSession(id);
  return Boolean(live && (live.running || waitingOf(live)));
};

export interface PruneResult {
  recycled: number;
  purged: number;
  empty: number;
}

interface Bucket {
  id: string;
  dir: string;
  last: number;
  sessions: string[];
  items: number;
}

export async function pruneQuick(opts: {
  retention?: unknown;
  now?: number;
  ttlMs?: number;
  trashMs?: number;
  busy?: (id: string) => boolean;
} = {}): Promise<PruneResult> {
  const out: PruneResult = { recycled: 0, purged: 0, empty: 0 };
  const now = opts.now ?? Date.now();
  const pol = quickRetention(opts.retention ?? prefValue<string>("quickRetention"));
  const busy = opts.busy ?? sessionBusy;
  out.purged = await purgeTrash(now, opts.trashMs ?? QUICK_TRASH_DAYS * DAY);
  if (pol.mode === "never") return out;

  let keep: { current: string; adopted: Set<string> };
  try {
    keep = quickKeepSet();
  } catch {
    return out; // 指针这会儿读不了：这轮不动
  }
  const root = quickRoot();
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  const byBucket = new Map<string, SessionMeta[]>();
  for (const m of await listAllSessions()) {
    const b = quickBucketOf(m.workspace);
    if (!b) continue;
    const k = foldQuickPath(b);
    const l = byBucket.get(k);
    if (l) l.push(m);
    else byBucket.set(k, [m]);
  }

  const used: Bucket[] = [];
  let pinned = 0; // 不动、但按条数时占一个名额的：有内容的当前桶、在跑的、刚动过的
  for (const id of names) {
    if (!QUICK_BUCKET_ID.test(id)) continue;
    const dir = path.join(root, id);
    const k = foldQuickPath(dir);
    if (keep.adopted.has(k)) continue;
    let last: number;
    let items = 0;
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
      last = st.mtimeMs;
      items = (await readdir(dir)).length;
    } catch {
      continue;
    }
    const sess = byBucket.get(k) ?? [];
    const hasContent = sess.length > 0 || items > 0;
    if (k === keep.current || sess.some((m) => busy(m.id))) {
      if (hasContent) pinned++;
      continue;
    }
    for (const m of sess) last = Math.max(last, m.updatedAt);
    if (now - last < QUICK_LINGER_MS) {
      // 还列在快照区里的那几条不动
      if (hasContent) pinned++;
      continue;
    }
    if (!hasContent) {
      if (now - last < GRACE_MS) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        out.empty++;
      } catch {
        /* 删不动（文件锁）：下轮再试 */
      }
      continue;
    }
    used.push({ id, dir, last, sessions: sess.map((m) => m.id), items });
  }

  let due: Bucket[];
  if (pol.mode === "ttl") {
    const ttl = opts.ttlMs ?? QUICK_TTL_DAYS * DAY;
    due = used.filter((b) => now - b.last >= ttl);
  } else {
    // 不动的那几条本来就是最新的，名额先扣掉它们，剩下的按最后活动从新到旧排
    due = [...used].sort((a, b) => b.last - a.last).slice(Math.max(0, pol.max - pinned));
  }
  for (const b of due) if (await recycle(b, now)) out.recycled++;
  return out;
}

async function recycle(b: Bucket, now: number): Promise<boolean> {
  const troot = trashRoot();
  const to = path.join(troot, b.id);
  const marker = path.join(troot, b.id + ".json");
  try {
    await mkdir(troot, { recursive: true });
    if (existsSync(to)) return false;
    await writeFile(marker, JSON.stringify({ id: b.id, path: b.dir, recycledAt: now, lastActive: b.last, sessions: b.sessions }, null, 2) + "\n");
    await rename(b.dir, to); // 同卷整体挪：要么整只进去，要么原地不动
    return true;
  } catch {
    await rm(marker, { force: true }).catch(() => {});
    return false;
  }
}

async function purgeTrash(now: number, trashMs: number): Promise<number> {
  const troot = trashRoot();
  let names: string[] = [];
  try {
    names = await readdir(troot);
  } catch {
    return 0;
  }
  const dirs = new Set(names.filter((n) => QUICK_BUCKET_ID.test(n)));
  for (const n of names) {
    // 没有对应目录的标记（挪进去之前进程没了 / 手动恢复过）：清掉
    if (n.endsWith(".json") && !dirs.has(n.slice(0, -5))) await rm(path.join(troot, n), { force: true }).catch(() => {});
  }
  let n = 0;
  for (const id of dirs) {
    const dir = path.join(troot, id);
    const marker = path.join(troot, id + ".json");
    let m: { path?: string; recycledAt?: number; sessions?: string[] } = {};
    try {
      m = JSON.parse(await readFile(marker, "utf8"));
    } catch {
      /* 标记丢了：按目录时间算，会话按原路径找 */
    }
    let at = Number(m.recycledAt) || 0;
    if (!at) {
      try {
        at = (await stat(dir)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - at < trashMs) continue;
    const orig = typeof m.path === "string" ? m.path : path.join(quickRoot(), id);
    // 同名的桶又回到了原处（手动恢复过）：别碰它的会话和记忆
    const restored = existsSync(orig);
    try {
      if (!restored) {
        const ids = new Set(Array.isArray(m.sessions) ? m.sessions : []);
        for (const s of await listAllSessions()) if (foldQuickPath(quickBucketOf(s.workspace) ?? "") === foldQuickPath(orig)) ids.add(s.id);
        for (const sid of ids) await deleteSession(sid).catch(() => {});
        await rm(memoryDir(path.resolve(orig)), { recursive: true, force: true }).catch(() => {});
      }
      await rm(dir, { recursive: true, force: true });
      await rm(marker, { force: true });
      n++;
    } catch {
      /* 删不动：下轮再试 */
    }
  }
  return n;
}

// 回收站里有几只（给以后的回收站入口；现在只在日志里报）
export function recycledQuickCount(): number {
  try {
    return readdirSync(trashRoot()).filter((n) => QUICK_BUCKET_ID.test(n)).length;
  } catch {
    return 0;
  }
}

let running: Promise<void> | null = null;
let again = false;
function runOnce(): void {
  if (running) {
    again = true; // 设置刚改完撞上正在跑的一轮：跑完按新值再来一轮
    return;
  }
  running = pruneQuick()
    .then((r) => {
      if (r.recycled || r.purged || r.empty) {
        console.log(`[quick] 快照对话清理：${r.recycled} 只进回收站、${r.purged} 只永久删除、${r.empty} 只空桶`);
        noteListChanged("sessions");
      }
    })
    .catch((e) => console.warn(`[quick] 快照对话清理失败：${(e as Error).message}`))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        runOnce();
      }
    });
}

let timer: NodeJS.Timeout | null = null;
// 启动后等几分钟（别和启动时的续跑、知识对账抢），之后每小时一轮；改了这项设置当场跑一轮。
export function startQuickPrune(everyMs = 60 * 60_000): void {
  if (timer) return;
  const first = setTimeout(runOnce, 3 * 60_000);
  first.unref?.();
  timer = setInterval(runOnce, everyMs);
  timer.unref?.();
  onPrefsChange((keys) => {
    if (keys.includes("quickRetention")) runOnce();
  });
}
