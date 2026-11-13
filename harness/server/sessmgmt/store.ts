// 会话管理的旁路记录：每个会话的归档状态、标题出处（AI / 用户改过），与稍后发送的队列。
// 存在会话目录下的 _mgmt/（会话列表只认会话目录顶层的 <id>.json，子目录不会被当成会话）：
//   flags.json  { [会话 id]: SessionFlags }
//   queue.json  { [会话 id]: QueuedMessage[] }
// 不写进会话记录本身：那份记录由会话的单写者整份覆盖写，在别处改字段会被下一次落盘冲掉；也不提记录版本。
// 写盘原子（临时文件 + 替换）、同一个文件串行；读失败（坏 JSON）当空表，不阻塞会话。
import { readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "../atomic-write.ts";
import { sessionsDir } from "../paths.ts";

export interface SessionFlags {
  // 归档时刻与原因（user = 手动，inactive = N 天不活跃自动归档）
  archivedAt?: number;
  archivedBy?: "user" | "inactive";
  // 手动取消归档的时刻：取消过的不再被自动归档（与 Claude 同）
  unarchivedAt?: number;
  // 当前标题的出处：user = 用户改过（AI 不再覆盖），ai = AI 起的
  titleBy?: "user" | "ai";
  // AI 起标题试过几次（失败两次就不再试，回退原来的首句标题）
  titleTries?: number;
}

export interface QueuedMessage {
  id: string;
  text: string;
  at: number;
}

const dir = (): string => path.join(sessionsDir(), "_mgmt");
const fileOf = (name: "flags" | "queue"): string => path.join(dir(), `${name}.json`);

function load<T>(name: "flags" | "queue"): Record<string, T> {
  try {
    const raw = JSON.parse(readFileSync(fileOf(name), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, T>) : {};
  } catch {
    return {};
  }
}

// 会话目录在测试里按用例改道：缓存按目录记，目录变了重读
let cachedFor = "";
let flags: Record<string, SessionFlags> = {};
let queues: Record<string, QueuedMessage[]> = {};
function ensure(): void {
  const d = dir();
  if (d === cachedFor) return;
  cachedFor = d;
  flags = load<SessionFlags>("flags");
  queues = load<QueuedMessage[]>("queue");
}

const writes: Record<string, Promise<void>> = {};
function save(name: "flags" | "queue"): Promise<void> {
  const data = JSON.stringify(name === "flags" ? flags : queues, null, 1) + "\n";
  const file = fileOf(name);
  const prev = writes[file] ?? Promise.resolve();
  const next = prev.then(() => atomicWriteFile(file, data)).catch((e) => console.warn(`[sessmgmt] ${name}.json 写盘失败：${(e as Error).message}`));
  writes[file] = next;
  return next;
}

// 测试用：等排着的写盘落地 / 丢掉内存、重读盘
export function flushSessMgmtStore(): Promise<void> {
  return Promise.all(Object.values(writes)).then(() => undefined);
}
export function reloadSessMgmtStore(): void {
  cachedFor = "";
}

export function getFlags(id: string): SessionFlags {
  ensure();
  return flags[id] ?? {};
}

export function allFlags(): Readonly<Record<string, SessionFlags>> {
  ensure();
  return flags;
}

export function patchFlags(id: string, patch: Partial<SessionFlags>): SessionFlags {
  ensure();
  const next: SessionFlags = { ...(flags[id] ?? {}), ...patch };
  for (const k of Object.keys(next) as (keyof SessionFlags)[]) if (next[k] === undefined) delete next[k];
  if (Object.keys(next).length) flags[id] = next;
  else delete flags[id];
  void save("flags");
  return next;
}

export function getQueue(id: string): QueuedMessage[] {
  ensure();
  return queues[id] ?? [];
}

export function allQueues(): Readonly<Record<string, QueuedMessage[]>> {
  ensure();
  return queues;
}

export function setQueue(id: string, items: QueuedMessage[]): void {
  ensure();
  if (items.length) queues[id] = items;
  else delete queues[id];
  void save("queue");
}

// 会话删掉了：两张表里都清掉
export function forgetSession(id: string): void {
  ensure();
  if (flags[id]) {
    delete flags[id];
    void save("flags");
  }
  if (queues[id]) {
    delete queues[id];
    void save("queue");
  }
}
