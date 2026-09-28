// M12（N37、#22）：项目知识的扫描与重建挪出主事件循环。
//
// 以前 ensureProjectKnowledge 全程同步跑在 harness 唯一的事件循环上：最多 1 万个文件 readdir + stat，指纹变了就同步重建
// 五张表并落盘——每轮开跑（自动召回、World State）、每次带验证证据的工具结果都要走一遍，用户自己的笔记库一次冻住
// 5–8 秒：所有会话的 SSE 停流、所有 API（含 bridge 1.5 秒的探活）无响应。现在读写知识缓存的活都在一条常驻 worker
// 线程里按到达顺序做（knowledge-worker.ts），主线程只拿结果：
//   · knowledgeSnapshot(root)：内存里最近一份，同步、可能略旧、可能为空（内存没有就读盘上那份，不扫描）；
//   · refreshProjectKnowledge(root, {force})：等 worker 对完（显式检索、ProjectKnowledge 工具、知识接口用）。同一工作区
//     单飞：对的过程中又有人要，就在它后面再排一次（那次请求之后的改动它可能没看见），调用方等排着的那次；
//   · knowledgeWithin(root, ms)：一轮开跑时用——给 worker 一个新鲜度预算，预算内对完就用新的（小工作区基本都能），
//     超时先用旧快照、后台接着对；内存与盘上都没有（这个工作区第一次）才等到底；
//   · noteKnowledgeEdit / noteKnowledgeVerification：打 dirty、追加验证记录，发给 worker 就不管（出错记日志）。
// worker 起不来或崩了：下次用时重建；实在用不了就退回主线程同步做（功能不丢，只是回到以前会卡的样子）。
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  ensureProjectKnowledge,
  loadCachedProjectKnowledge,
  markProjectKnowledgeDirty,
  recordProjectVerification,
  type ProjectKnowledge,
  type RecordProjectVerificationOptions,
} from "./knowledge.ts";
import type { KnowledgeJob } from "./knowledge-worker.ts";

type Reply = { id: number; ok: boolean; error?: string; knowledge?: ProjectKnowledge; unchanged?: boolean; health?: ProjectKnowledge["health"] };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type JobInput = DistributiveOmit<KnowledgeJob, "id" | "env">;

const snapshots = new Map<string, ProjectKnowledge>();
const inflight = new Map<string, Promise<ProjectKnowledge>>();
const again = new Map<string, boolean>(); // 工作区 → 排着的那一次要不要 force
let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();

const ENV_KEYS = ["KNOWLEDGE_DIR", "NODE_TEST_CONTEXT", "DIMENSIO_TEST_ISOLATION"] as const;
const envNow = () => Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const keyOf = (root: string) => path.resolve(root);

function failAll(error: Error): void {
  for (const p of pending.values()) p.reject(error);
  pending.clear();
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (workerBroken) return null;
  try {
    const w = new Worker(new URL("./knowledge-worker.ts", import.meta.url));
    w.unref(); // 闲着不拖住进程；有活时 ref（见 send）
    w.on("message", (msg: Reply) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (!pending.size) w.unref();
      p.resolve(msg);
    });
    w.on("error", (error) => {
      console.error(`[knowledge] worker 出错，下次用时重建：${error.message}`);
      if (worker === w) worker = null;
      failAll(error);
    });
    w.on("exit", () => {
      if (worker === w) worker = null;
      failAll(new Error("knowledge worker exited"));
    });
    worker = w;
    return w;
  } catch (error) {
    console.error(`[knowledge] 起不来 worker，退回主线程同步做：${(error as Error).message}`);
    workerBroken = true;
    return null;
  }
}

// M8 补（09-25）：计划内退出前先把 worker 收掉——Windows 上 process.exit 撞上正在干活的 worker 线程，偶发以 0xC0000409 原生
// 崩溃收场（全量测试里 M8 的真 harness 退役用例真撞上过一次：该是 0 的退出码成了 3221226505）。之后不再起新的。
export async function stopKnowledgeWorker(timeoutMs = 2_000): Promise<void> {
  workerBroken = true;
  const w = worker;
  worker = null;
  if (!w) return;
  failAll(new Error("knowledge worker stopped: the process is exiting"));
  await Promise.race([w.terminate().catch(() => 0), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
}

function send(job: JobInput): Promise<Reply> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("no knowledge worker"));
  const id = ++seq;
  return new Promise<Reply>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.ref();
    w.postMessage({ ...job, id, env: envNow() });
  });
}

// worker 的回复落进快照：没变就只换 health（验证记录可能多了）
function absorb(key: string, reply: Reply): ProjectKnowledge {
  if (!reply.ok) throw new Error(reply.error ?? "knowledge worker failed");
  if (reply.knowledge) {
    snapshots.set(key, reply.knowledge);
    return reply.knowledge;
  }
  const current = snapshots.get(key);
  if (!current) throw new Error("knowledge worker replied 'unchanged' without a snapshot");
  const next = reply.health ? { ...current, health: reply.health, rebuilt: false } : { ...current, rebuilt: false };
  snapshots.set(key, next);
  return next;
}

function start(key: string, force: boolean): Promise<ProjectKnowledge> {
  const known = force ? undefined : snapshots.get(key)?.profile.sourceFingerprint;
  const run = send({ kind: "ensure", root: key, force, known })
    .then((reply) => absorb(key, reply))
    .catch(() => {
      // worker 用不了：退回主线程同步做（功能不丢）
      const knowledge = ensureProjectKnowledge(key, { force });
      snapshots.set(key, knowledge);
      return knowledge;
    })
    .finally(() => {
      inflight.delete(key);
      const next = again.get(key);
      if (next !== undefined) {
        again.delete(key);
        void start(key, next).catch(() => {});
      }
    });
  inflight.set(key, run);
  return run;
}

export function refreshProjectKnowledge(root: string, options: { force?: boolean } = {}): Promise<ProjectKnowledge> {
  const key = keyOf(root);
  const running = inflight.get(key);
  if (!running) return start(key, Boolean(options.force));
  // 正在对的那次可能已经扫过了这次请求之前的改动所在的目录：排一次，调用方等排着的那次
  again.set(key, (again.get(key) ?? false) || Boolean(options.force));
  return running.then(
    () => inflight.get(key) ?? Promise.resolve(snapshots.get(key)!),
    () => inflight.get(key) ?? refreshProjectKnowledge(key, options),
  );
}

export function knowledgeSnapshot(root: string): ProjectKnowledge | null {
  const key = keyOf(root);
  let snapshot = snapshots.get(key);
  if (!snapshot) {
    const disk = loadCachedProjectKnowledge(key);
    if (disk) snapshots.set(key, (snapshot = disk));
  }
  return snapshot ?? null;
}

// 一轮开跑用：新鲜度预算内对完就用新的；超时先用旧的、后台接着对；一份都没有才等到底。已经有一次在对（开跑时
// 先踢了一脚）就等那一次，不另排——一轮开头不扫两遍。
export async function knowledgeWithin(root: string, budgetMs: number): Promise<ProjectKnowledge> {
  const key = keyOf(root);
  const fresh = inflight.get(key) ?? start(key, false);
  const snapshot = knowledgeSnapshot(root);
  if (!snapshot) return fresh;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<ProjectKnowledge>((resolve) => {
    timer = setTimeout(() => resolve(knowledgeSnapshot(root) ?? snapshot), budgetMs);
  });
  fresh.catch(() => {});
  try {
    return await Promise.race([fresh, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function noteKnowledgeEdit(root: string): void {
  send({ kind: "dirty", root: keyOf(root) }).catch(() => {
    try { markProjectKnowledgeDirty(root); } catch { /* best-effort 缓存标记 */ }
  });
}

export function noteKnowledgeVerification(root: string, options: RecordProjectVerificationOptions): void {
  const key = keyOf(root);
  send({ kind: "verify", root: key, options, known: snapshots.get(key)?.profile.sourceFingerprint })
    .then((reply) => absorb(key, reply))
    .catch((error) => {
      try {
        recordProjectVerification(root, options);
      } catch {
        console.error(`[knowledge] verification record: ${(error as Error).message}`);
      }
    });
}

// 测试用：等 worker 手上的活都做完（后台对知识、打 dirty、记验证）
export async function knowledgeIdle(): Promise<void> {
  while (inflight.size || pending.size) {
    await Promise.allSettled([...inflight.values()]);
    if (pending.size) await new Promise((r) => setTimeout(r, 5));
  }
}
