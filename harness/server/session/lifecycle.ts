// 会话的建、查、排空、停止、逐出与删除；生命周期按会话 id 串行。
import { forgetFamilySession } from "../session-family.ts";
import { forgetProjectSession, type SessionShape } from "../project-mode.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { deleteSessionArchive } from "../compaction-archive.ts";
import { deleteSessionOutputs } from "../tools/result-store.ts";
import { clearRunMarker } from "../run-markers.ts";
import type { RuntimeConfig } from "../config.ts";
import { deleteSessionFile, loadSession, sessionFilePath, type SessionMeta } from "../store.ts";
import { deleteCheckpoints } from "../checkpoints.ts";
import { disposeOwner, type ResourceCounts, resourceOwners } from "../resources.ts";
import { deleteUploadDirs, uploadKeyOf } from "../files.ts";
import { deleteSessionAssets } from "../image-assets.ts";
import { RESTART_REASON } from "../retire.ts";
import { deleteTraceLog } from "../trace-log.ts";
import { deleteSessionDiagnostics } from "../diagnostics.ts";
import { registry } from "./registry.ts";
import { persistNow, sessionRecord } from "./persist.ts";
import type { Session } from "./types.ts";
import { workspaceRoot } from "./workspace.ts";

// M11（N33）：initial = 发起端显式带来的配置快照（界面上显示的那一份，已按设置页同一套规则校验过）。不给才读全局——
// 全局值是「最后一个切前台的设备」写的，手机刚切的项目 / 访问范围 / 运行档位以前会串进电脑上新建的对话。
// shape = 会话形态（project-mode.ts），只有新会话能带。
export function createSession(initial?: RuntimeConfig, opts: { shape?: SessionShape } = {}): Session {
  const s: Session = {
    id: randomUUID(),
    state: null,
    abort: null,
    createdAt: Date.now(),
    running: false,
    runPromise: null,
    discarded: false,
    title: "",
    cfg: null,
    initialConfig: initial,
    ...(opts.shape ? { initialShape: opts.shape } : {}),
    persistTimer: null,
    watchers: new Set(),
    runLog: [],
    runLogTruncated: false,
    touchedAt: Date.now(),
    runStartMsgCount: 0,
    pendingAsks: new Map(),
    pendingPermissions: new Map(),
    pendingPlans: new Map(),
  };
  registry.sessions.set(s.id, s);
  return s;
}


export function getSession(id: string): Session | undefined {
  return registry.sessions.get(id);
}

// 已经开跑、盘上可能还没有的会话（列表接口并进去）：新会话第一次落盘要等检查点 + 知识召回，大工作区十几秒，
// 这期间侧栏刷新拿不到它（维护者 10-11：「发了个你好之后列表里压根没这个对话」）。
export function liveSessionMetas(): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const s of registry.sessions.values()) {
    if (s.discarded || !s.cfg || !s.state) continue;
    out.push({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.touchedAt,
      messageCount: s.state.messages.length,
      provider: s.cfg.provider,
      model: s.cfg.model,
      workspace: s.cfg.workspace,
      ...(s.cfg.shape === "project" ? { shape: "project" as const } : {}),
    });
  }
  return out;
}


export function anySessionRunning(): boolean {
  for (const s of registry.sessions.values()) if (s.running) return true;
  return false;
}

// M8：此刻在跑的轮（退役闸 / 忙闲探针用）。
export function runningRuns(): { sessionId: string; runId: string | null; title: string }[] {
  return [...registry.sessions.values()]
    .filter((s) => s.running)
    .map((s) => ({ sessionId: s.id, runId: s.runId ?? null, title: s.title }));
}


// M8：优雅排空。在跑的轮按「服务重启」中止（loop 据此在转录里写明原因），等它们收尾（有上限），
// 然后把所有常驻会话立即落盘——平时是 2 秒防抖，进程随后就要退出，等不到那一下。
export async function drainSessions(waitMs = 10_000): Promise<number> {
  const live = [...registry.sessions.values()].filter((s) => s.running);
  for (const s of live) s.abort?.abort(RESTART_REASON);
  if (live.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(live.map((s) => s.runPromise ?? Promise.resolve())),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }
  for (const s of [...registry.sessions.values()]) await persistNow(s).catch(() => {});
  return live.length;
}

// Stop everything this session owns and report what actually stopped. The old
// version aborted the turn, returned true, and left the session's background
// Bash jobs and dev servers running — the UI said "已停止" while a test suite
// and a dev server kept going.
export interface StopReport {
  stopped: boolean;      // did anything at all stop
  turnAborted: boolean;
  jobsKilled: number;
  servicesStopped: number;
  // M2：带了 runId、而此刻在跑的是另一轮——什么都没动。
  error?: "run_mismatch";
  currentRunId?: string | null;
}

// M2（#44）：控制请求的前置条件。带了 runId、且此刻在跑的恰好不是那一轮 → 对不上。不带 runId 的旧客户端
// （离线 apk）照旧。停止只在「别的轮正在跑」时拒绝：什么都没在跑时，停掉遗留的后台 job 不会误伤谁。
export function runMismatch(s: Session | undefined, runId: string | undefined): boolean {
  return Boolean(runId && s?.running && s.runId !== runId);
}

export function stopSession(id: string, runId?: string): StopReport {
  const s = registry.sessions.get(id);
  if (runMismatch(s, runId)) {
    return { stopped: false, turnAborted: false, jobsKilled: 0, servicesStopped: 0, error: "run_mismatch", currentRunId: s?.runId ?? null };
  }
  const turnAborted = !!s?.abort;
  if (s?.abort) s.abort.abort();
  // Background jobs deliberately outlive a turn, but "stop this session" is the
  // user asking for the work to end — reap them and the session's dev servers.
  // M5（K03）：出口只说「这个会话的都收掉」，账本按登记的逆序拆（job、dev server），回执照账本的计数报。
  // 会话自己的浏览器（cdp.ts getBrowser）不收：停下之后用户还要看 agent 停在了哪一页；删除会话时才收（deleteSession）。
  const reaped = disposeOwner(id, "stop", ["job", "service"]);
  const jobsKilled = reaped.job;
  const servicesStopped = reaped.service;
  return {
    stopped: turnAborted || jobsKilled > 0 || servicesStopped > 0,
    turnAborted,
    jobsKilled,
    servicesStopped,
  };
}

// M5（K03）：owner 已经不在的资源——会话记录被删了（不是经删除接口）、快照对话被替换了……——没有任何出口会再去收，
// 以前 dev server 会一直跑到进程退出。巡检一遍：内存里没有、盘上也没有这条会话的，账上的东西一律收掉（与终端的
// 5 分钟巡检同构，由 index.ts 定时调）。不属于任何会话的（owner ""）不动。
export function sweepOrphanResources(): ResourceCounts {
  const total: ResourceCounts = { job: 0, service: 0, browser: 0 };
  for (const owner of resourceOwners()) {
    if (!owner || registry.sessions.has(owner) || registry.loading.has(owner)) continue;
    const file = sessionFilePath(owner);
    if (file && existsSync(file)) continue;
    const reaped = disposeOwner(owner, "orphan");
    total.job += reaped.job;
    total.service += reaped.service;
    total.browser += reaped.browser;
    if (reaped.job || reaped.service) {
      console.log(`[resources] 会话 ${owner} 已不在：收掉 ${reaped.job} 个后台 job、${reaped.service} 个 dev server`);
    }
  }
  return total;
}

// ── Idle eviction ────────────────────────────────────────────────────────────
// Sessions used to accumulate in this Map for the process's whole life: every
// conversation ever opened kept its full message history (plus provider blocks)
// resident. The persisted record is the source of truth and getOrLoadSession
// rehydrates on demand, so an idle, non-running session is free to drop.
const MAX_RESIDENT_SESSIONS = 24;
const SESSION_IDLE_MS = 30 * 60_000;

function evictable(s: Session): boolean {
  // O7：有进行中的目标的不逐出——两轮之间马上要续下一轮，从盘上读回会按冷恢复把它暂停
  return !s.running && !s.runPromise && s.pendingAsks.size === 0 && s.watchers.size === 0 && !s.persistTimer && s.goal?.status !== "active";
}

export function evictIdleSessions(now = Date.now()): number {
  const candidates = [...registry.sessions.values()]
    .filter(evictable)
    .sort((a, b) => a.touchedAt - b.touchedAt); // oldest first
  let dropped = 0;
  // 1) Anything idle past the window goes, regardless of how many are resident.
  for (const s of candidates) {
    if (now - s.touchedAt <= SESSION_IDLE_MS) continue;
    registry.sessions.delete(s.id);
    dropped++;
  }
  // 2) Still over the cap (many recently-touched sessions) → keep dropping the
  //    oldest evictable ones. A running/awaiting session is never a candidate.
  for (const s of candidates) {
    if (registry.sessions.size <= MAX_RESIDENT_SESSIONS) break;
    if (!registry.sessions.has(s.id)) continue;
    registry.sessions.delete(s.id);
    dropped++;
  }
  return dropped;
}

// Mark a session as recently used (run start, read, mirror attach).
export function touchSession(s: Session): void {
  s.touchedAt = Date.now();
}

// Remove a session from memory (aborting any run) — the DELETE endpoint pairs
// this with deleting the file on disk.
export function dropSession(id: string): void {
  // Tombstone any in-flight hydration so it can't register after we delete.
  if (registry.loading.has(id)) registry.droppedWhileLoading.add(id);
  const s = registry.sessions.get(id);
  if (!s) return;
  s.discarded = true;
  s.abort?.abort();
  if (s.persistTimer) {
    clearTimeout(s.persistTimer);
    s.persistTimer = null;
  }
  registry.sessions.delete(id);
}

// ── M11（K29）：会话生命周期按 id 串行 + 回滚期间全局静默 ──────────────────────
// 回滚要一路 await git 操作好几秒。以前只在入口查一次「有没有会话在跑」：窗口期里别的会话照样能开跑（agent 在一个
// 正被 checkout 的工作区里干活），同一会话能被删（删完又被回滚写回来），这个会话的防抖落盘还能在回滚写完记录之后
// 把旧状态写回去（回滚白做）。现在：
//   · 回滚、删除按会话 id 排成一条链，前一个做完后一个才开始；这期间要从盘上加载这个会话的，等链走完再读；
//   · 回滚期间全局静默：startRun 一律不起（409「正在回滚」），这个会话的落盘一律跳过（回滚结果才是真相）。
// startRun 自己不进链——它必须保持「第一个 await 之前同步占位」的性质，只在入口查静默标记。

export function lifecycle<T>(id: string, work: () => Promise<T>): Promise<T> {
  const prev = registry.lifecycleChains.get(id) ?? Promise.resolve();
  const next = prev.then(work);
  const tail = next.catch(() => {});
  registry.lifecycleChains.set(id, tail);
  void tail.then(() => {
    if (registry.lifecycleChains.get(id) === tail) registry.lifecycleChains.delete(id);
  });
  return next;
}

export function rollbackInProgress(): string | null {
  return registry.rollingBack;
}

// M5（#13）：删除会话要回收它名下的一切。以前两个删除入口只 dropSession + 删文件：后台 Bash job
// 照跑 30 分钟到 2 小时、Preview dev server 永不停，owner 已经没了，UI 也停不掉。先 stopSession
// （中止在跑的轮、杀 job、停服务），再关掉它的浏览器（标签、隔离存储开关），再忘掉内存状态、删盘上的记录、图片与检查点。
export function deleteSession(id: string): Promise<{ deleted: boolean; stopped: StopReport }> {
  return lifecycle(id, async () => {
    const stopped = stopSession(id);
    disposeOwner(id, "delete", ["browser"]);
    // U4（K08）：记录删了就不知道它的工作区和附件目录了——先记下
    const live = registry.sessions.get(id);
    const rec = (live ? sessionRecord(live) : null) ?? (await loadSession(id).catch(() => null));
    dropSession(id);
    const deleted = await deleteSessionFile(id);
    registry.usageLedgers.delete(id); // O8
    await deleteSessionAssets(id);
    await deleteSessionArchive(id);
    await deleteSessionOutputs(id);
    await deleteCheckpoints(id);
    await deleteTraceLog(id); // Q12：这个会话的运行事件日志
    clearRunMarker(id); // M13：删掉的会话不再自动续跑
    forgetFamilySession(id); // 会话协作：它的父子关系一并清掉（它开的子会话升为顶层）、收件箱作废
    forgetProjectSession(id); // 项目对话：台账与项目记忆一并删掉（讨论串被删只清它的「已解决」标记）
    await deleteSessionDiagnostics(rec?.config?.workspace ?? workspaceRoot(), id); // Q13：这个会话导出过的诊断包
    if (rec) {
      const keys = [id, ...rec.messages.flatMap((m) => (m.attachments ?? []).map((a) => uploadKeyOf(a.path)).filter((k): k is string => Boolean(k)))];
      await deleteUploadDirs(rec.config?.workspace ?? workspaceRoot(), keys).catch((error) => {
        console.error(`[session] ${id} 的附件目录没删掉：${(error as Error).message}`);
      });
    }
    return { deleted, stopped };
  });
}
