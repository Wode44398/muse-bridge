// 定时唤醒的账本：每个会话待触发的唤醒，随会话落盘（<sessions>/wakeups/<会话 id>.json），服务重启后读回。
// 只管记账（加、取消、到点取走、清空、列出），不碰会话与定时器——到点开轮在 scheduler.ts。改动经 onWakeupsChanged 通知。
// 写盘同步（与开跑 marker 一样）：工具返回「约好了」时它已经在盘上。写不成只记一笔，内存里的照样生效。
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sessionsDir } from "../paths.ts";

// 到点那一轮的片段类别（injections.ts 登记、job-notify.ts 按它投递与收回；停止会话按它丢掉已到点还没注入的）
export const WAKEUP_KIND = "wakeup";
export const MIN_DELAY_S = 60;
export const MAX_DELAY_S = 24 * 3600;
export const MAX_PENDING = 5; // 每个会话同时待触发的唤醒
const MAX_REASON = 200;
const MAX_PROMPT = 4_000;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export interface Wakeup {
  id: string;
  owner: string; // 会话 id
  createdAt: number;
  dueAt: number;
  reason: string;
  prompt: string;
}

const cache = new Map<string, Wakeup[]>(); // 会话 id → 待触发（按到点先后）
const listeners = new Set<(owner: string) => void>();

export function wakeupDir(): string {
  return path.join(sessionsDir(), "wakeups");
}
const fileOf = (owner: string): string | null => (ID_RE.test(owner) ? path.join(wakeupDir(), `${owner}.json`) : null);

function sanitize(owner: string, raw: unknown): Wakeup | null {
  const w = raw as Partial<Wakeup> | null;
  if (!w || typeof w.id !== "string" || typeof w.dueAt !== "number" || !Number.isFinite(w.dueAt) || typeof w.prompt !== "string") return null;
  return {
    id: w.id,
    owner,
    createdAt: typeof w.createdAt === "number" ? w.createdAt : w.dueAt,
    dueAt: w.dueAt,
    reason: typeof w.reason === "string" ? w.reason : "",
    prompt: w.prompt,
  };
}

function load(owner: string): Wakeup[] {
  const hit = cache.get(owner);
  if (hit) return hit;
  let list: Wakeup[] = [];
  const file = fileOf(owner);
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as { items?: unknown[] };
      list = (Array.isArray(j.items) ? j.items : []).map((x) => sanitize(owner, x)).filter((x): x is Wakeup => x !== null);
    } catch {
      list = []; // 没有这个文件 / 坏了：当作没有
    }
  }
  list.sort((a, b) => a.dueAt - b.dueAt);
  cache.set(owner, list);
  return list;
}

function save(owner: string, list: Wakeup[]): void {
  cache.set(owner, list);
  const file = fileOf(owner);
  if (file) {
    try {
      if (!list.length) fs.rmSync(file, { force: true });
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const items = list.map(({ owner: _o, ...rest }) => rest);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, items }));
        fs.renameSync(tmp, file);
      }
    } catch (e) {
      console.error(`[wakeup] ${owner.slice(0, 8)}: could not save (${(e as Error).message})`);
    }
  }
  for (const fn of listeners) {
    try {
      fn(owner);
    } catch (e) {
      console.error(`[wakeup] listener: ${(e as Error).message}`);
    }
  }
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

export type AddResult = { ok: true; wakeup: Wakeup; clamped?: "min" | "max" } | { ok: false; error: string };

/** 约一次唤醒。延迟夹到 [MIN_DELAY_S, MAX_DELAY_S]；同时待触发的满了就拒。 */
export function addWakeup(owner: string, req: { delaySeconds: number; reason: string; prompt: string }, now = Date.now()): AddResult {
  if (!ID_RE.test(owner)) return { ok: false, error: "this conversation cannot schedule wakeups" };
  const prompt = String(req.prompt ?? "").trim().slice(0, MAX_PROMPT);
  if (!prompt) return { ok: false, error: "prompt is empty — say what to do when the wakeup fires" };
  const list = load(owner);
  if (list.length >= MAX_PENDING) return { ok: false, error: `${MAX_PENDING} wakeups are already pending in this conversation — cancel one first` };
  const asked = Number(req.delaySeconds);
  const base = Number.isFinite(asked) ? Math.round(asked) : MIN_DELAY_S;
  const delay = Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, base));
  const wakeup: Wakeup = {
    id: `wk-${randomBytes(3).toString("hex")}`,
    owner,
    createdAt: now,
    dueAt: now + delay * 1000,
    reason: oneLine(String(req.reason ?? ""), MAX_REASON),
    prompt,
  };
  save(owner, [...list, wakeup].sort((a, b) => a.dueAt - b.dueAt));
  return { ok: true, wakeup, ...(base < MIN_DELAY_S ? { clamped: "min" as const } : base > MAX_DELAY_S ? { clamped: "max" as const } : {}) };
}

/** 这个会话待触发的唤醒（按到点先后；返回副本）。 */
export function pendingWakeups(owner: string): Wakeup[] {
  return ID_RE.test(owner) ? [...load(owner)] : [];
}

/** 取消一个；没有这个 id 返回 null。 */
export function cancelWakeup(owner: string, id: string): Wakeup | null {
  const list = pendingWakeups(owner);
  const hit = list.find((w) => w.id === id);
  if (!hit) return null;
  save(owner, list.filter((w) => w !== hit));
  return hit;
}

/** 到点取走（取走即从账本里删掉；已经被取消 / 取走过的返回 null）。 */
export const takeWakeup = cancelWakeup;

/** 清掉这个会话的全部（删会话、停止会话）；返回清掉几个。 */
export function clearWakeups(owner: string): number {
  const n = pendingWakeups(owner).length;
  if (n) save(owner, []);
  else cache.delete(owner);
  return n;
}

/** 盘上有待触发唤醒的会话（服务启动时扫一遍）。 */
export function wakeupOwners(): string[] {
  try {
    return fs
      .readdirSync(wakeupDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((id) => ID_RE.test(id));
  } catch {
    return [];
  }
}

export function onWakeupsChanged(fn: (owner: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const ago = (ms: number): string => {
  const m = Math.round(Math.abs(ms) / 60_000);
  return m < 1 ? "under a minute" : m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
};

/** 给模型看的一行一个（压缩回填、list 共用）。 */
export function describeWakeup(w: Wakeup, now = Date.now()): string {
  const when = w.dueAt >= now ? `in ${ago(w.dueAt - now)}` : `overdue by ${ago(now - w.dueAt)}`;
  return `${w.id} (${when}${w.reason ? ` — ${w.reason}` : ""})`;
}

/** 待触发唤醒的一句话汇总（没有就是空串）。 */
export function pendingWakeupsSummary(owner: string, now = Date.now()): string {
  return pendingWakeups(owner).map((w) => describeWakeup(w, now)).join(", ");
}

// 测试用：清内存缓存（盘上的不动）
export function _resetWakeupCache(): void {
  cache.clear();
}
