// 一轮的事件扇出与镜像附着、全局事件通道、「等你」状态与运行计时。
import type { AgentEvent } from "../agent/events.ts";
import { visibleMessages } from "../agent/state.ts";
import { appendRunLog } from "../run-log.ts";
import type { Msg } from "../agent/turn.ts";
import { currentTrace } from "../trace.ts";
import { traceEvent } from "../trace-log.ts";
import { registry } from "./registry.ts";
import type { PendingPermission, Session } from "./types.ts";

export function permissionAskEvent(id: string, p: Omit<PendingPermission, "resolve">): Record<string, unknown> {
  return {
    e: "permission_ask",
    id,
    tool: p.tool,
    subject: p.subject,
    ...(p.rule ? { rule: p.rule } : {}),
    ...(p.deadlineAt ? { deadlineAt: p.deadlineAt } : {}),
    sessionRules: p.sessionRules,
    ...(p.prefixRules?.length ? { prefixRules: p.prefixRules } : {}),
    ...(p.noSession ? { noSession: true } : {}),
    ...(p.why ? { why: p.why } : {}),
    ...(p.preview ? { preview: p.preview } : {}),
  };
}

// runaway backstop. M9 起 delta 合并进日志，条数只随「结构性」事件（工具起止、子 agent 起止、卡片……）增长
const MAX_RUN_LOG = 200_000;
// How much of a finished run's log stays resident (tail). Enough to see how the
// run ended; bounded so finished runs stop accumulating in memory.
export const RUN_LOG_RETAIN = 200;

// Fan an event out to the session's run log + every attached watcher. The single
// path every run event takes — executeRun streams through it, and the ask
// helpers use it directly so questions/answers ride the same replayable stream.
// M9：日志按「重放结果等价」压实（run-log.ts）——delta 合并，上限只剩兜底意义。
export function fanout(session: Session, ev: AgentEvent | Record<string, unknown>): void {
  if (!appendRunLog(session.runLog, ev as Record<string, unknown>, MAX_RUN_LOG)) session.runLogTruncated = true;
  // Q12：旁路落盘（结构性事件、脱敏、有界、写失败全吞——诊断永不影响主链路）
  traceEvent(session.id, ev as Record<string, unknown>, currentTrace() ?? session.trace);
  for (const w of session.watchers) {
    try {
      w(ev as Record<string, unknown>);
    } catch {
      /* watcher's problem */
    }
  }
}

// R14（K37）：只发给此刻在看的设备，不进 runLog、不落盘——前台 Bash 的实时尾行每秒一条，只有最新那条有用；
// 重连的设备等下一条就是。
export function fanoutLive(session: Session, ev: AgentEvent | Record<string, unknown>): void {
  for (const w of session.watchers) {
    try {
      w(ev as Record<string, unknown>);
    } catch {
      /* watcher's problem */
    }
  }
}


// Attach a live-mirror watcher to a running session. Replays the current run's
// events so far (synchronously — no gap: JS is single-threaded and the replay +
// subscribe happen in one tick), then streams live ones. Returns unsubscribe.
export function watchSession(
  session: Session,
  cb: (ev: Record<string, unknown>) => void,
): () => void {
  // A truncated log would replay a PREFIX of the run and then splice live events
  // onto it — the mirror's timeline stays permanently shifted (missing tool
  // results, text that never arrives). Say so instead: the client rebuilds from
  // the persisted record and resumes live from here, losing detail but not sync.
  if (session.runLogTruncated) {
    // M1（#26）：挂起中的问答 / 权限 / 计划卡只活在内存和 runLog 里，重建记录拿不到——随 desync 一起下发。
    cb({ e: "mirror_desync", reason: "run log exceeded its cap; rebuild from the session record", pending: pendingInteractions(session) });
  } else {
    for (const ev of session.runLog) cb(ev);
  }
  // U3：重放出来的计时事件时间戳是当时的——补一份此刻的，附着的设备按它走表
  if (session.running && session.runClock) cb(runClockEvent(session));
  session.watchers.add(cb);
  return () => session.watchers.delete(cb);
}


// M1（#26）：此刻挂着、等人处理的交互，形状与当初 fanout 的事件相同（客户端按原事件渲染即可）。
// 随 mirror_desync 与 GET /api/sessions/:id 下发，重连的设备不必依赖 runLog 也能把卡片找回来。
export function pendingInteractions(session: Session): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [id, p] of session.pendingAsks) {
    out.push({ e: "ask", id, questions: p.payload ?? [], ...(p.deadlineAt ? { deadlineAt: p.deadlineAt } : {}) });
  }
  for (const [id, p] of session.pendingPermissions) out.push(permissionAskEvent(id, p));
  for (const [id, p] of session.pendingPlans) {
    out.push({ e: "plan_ask", id, plan: p.plan, ...(p.deadlineAt ? { deadlineAt: p.deadlineAt } : {}) });
  }
  return out;
}

// M4（#43）：镜像底座 = 本轮用户消息及其之前的可见消息，按这条消息对象在「当前」转录里的位置现算。以前用
// 开跑时记下的条数：运行中一旦全量压缩（转录换成 任务 + 摘要 + 尾部），按旧条数切会把本轮已完成的步骤收进
// 底座，runLog 再重放一遍（重复渲染），本轮之前的历史又少一截。本轮用户消息自己也被压进摘要时，以最后一条
// 摘要为界（尾部全是本轮之后的内容，交给 runLog 重放）。
const SUMMARY_PREFIX = "[Earlier context summary]";
export function mirrorBaseCount(session: Session): number {
  const msgs = session.state?.messages ?? [];
  let at = session.runUserMsg ? msgs.indexOf(session.runUserMsg) : -1;
  if (at < 0 && session.runUserMsg) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user" && msgs[i].content.some((b) => b.t === "text" && b.text.startsWith(SUMMARY_PREFIX))) {
        at = i;
        break;
      }
    }
  }
  return at < 0 ? session.runStartMsgCount : visibleMessages(msgs.slice(0, at + 1)).length;
}


// ── P8（K30、X34、K35）：全局事件通道 +「等你」旗标 ────────────────────────────────
// 会话列表与通知都要知道「哪个会话在跑、哪个在等人」，以前只能逐个会话连流、或者轮询整张列表。现在状态一变（开跑 /
// 收尾 / 挂起一张卡 / 卡落定）就往全局通道发一条 session_status，同一个状态不重复发；新连上的先收一份快照
// （pendingSummary，bridge apk 的原生通知服务也轮询它）。只给终态事实——在等哪一类、哪个工具——不带命令、路径、
// 模型原文（锁屏通知的规矩）。
export type WaitingKind = "permission" | "ask" | "plan";
export interface WaitingInfo {
  kind: WaitingKind;
  id: string; // 卡片 id：通知按它去重
  since: number;
  deadlineAt?: number;
  tool?: string; // 权限卡：哪个工具（不带参数）
}

export function waitingOf(s: Session): WaitingInfo | null {
  for (const [id, p] of s.pendingPermissions) return { kind: "permission", id, since: p.since, deadlineAt: p.deadlineAt, tool: p.tool };
  for (const [id, p] of s.pendingAsks) return { kind: "ask", id, since: p.since ?? s.touchedAt, deadlineAt: p.deadlineAt };
  for (const [id, p] of s.pendingPlans) return { kind: "plan", id, since: p.since ?? s.touchedAt, deadlineAt: p.deadlineAt };
  return null;
}

const globalWatchers = new Set<(ev: Record<string, unknown>) => void>();
const lastStatusKey = new Map<string, string>();

export function watchGlobal(fn: (ev: Record<string, unknown>) => void): () => void {
  globalWatchers.add(fn);
  return () => globalWatchers.delete(fn);
}

// 会话管理（稍后发送的队列、输入建议、AI 标题）也经这条全局通道广播自己的事件，所以导出
export function emitGlobal(ev: Record<string, unknown>): void {
  for (const fn of globalWatchers) {
    try {
      fn(ev);
    } catch {
      /* 一个坏掉的连接不影响别的 */
    }
  }
}

// 侧栏结构变了（新建 / 删除会话、换快照、存为工作空间、项目增改）：通知所有设备重拉列表。
// what：sessions = 会话列表，projects = 项目列表（含快照位）。只带种类，不带内容。
export function noteListChanged(what: "sessions" | "projects" | "both"): void {
  emitGlobal({ e: "list_changed", what, at: Date.now() });
}

// U3（X38）：运行计时的快照事件。serverNow 让客户端校正时钟差（手机与电脑的钟未必一致）。
export function runClockEvent(s: Session): Record<string, unknown> {
  const clock = s.runClock ?? { startedAt: Date.now(), pausedMs: 0, pausedSince: null };
  return { e: "run_clock", startedAt: clock.startedAt, pausedMs: clock.pausedMs, pausedSince: clock.pausedSince, serverNow: Date.now() };
}

// U8（ZCode E3）：此刻这一轮的用时——整轮墙钟与其中挂着卡片等人的时间（等人在卡片挂上 / 落定处计量，不是从进入权限判定
// 开始算：楔住的判定不会让「等人」随墙钟 1:1 增长）
export function runTiming(s: Session): { durationMs: number; waitedMs: number } | null {
  const clock = s.runClock;
  if (!clock) return null;
  const now = Date.now();
  return {
    durationMs: Math.max(0, now - clock.startedAt),
    waitedMs: clock.pausedMs + (clock.pausedSince !== null ? now - clock.pausedSince : 0),
  };
}

// 盖在这一轮最后一条可见的回答上（从 from 往后找；这一轮一条可见回答都没有就不盖）
export function stampRunTiming(messages: Msg[], from: number, timing: { durationMs: number; waitedMs: number }): void {
  for (let i = messages.length - 1; i >= from; i--) {
    const m = messages[i];
    if (m.role === "assistant" && !m.internal) {
      m.run = timing;
      return;
    }
  }
}

// 卡片挂上（在等人）就暂停计时，全落定了接着走——暂停与否一变就给所有设备发一份新的计时快照
function tickRunClock(s: Session): void {
  const clock = s.runClock;
  if (!clock || !s.running) return;
  const waiting = waitingOf(s) !== null;
  const now = Date.now();
  if (waiting && clock.pausedSince === null) clock.pausedSince = now;
  else if (!waiting && clock.pausedSince !== null) {
    clock.pausedMs += now - clock.pausedSince;
    clock.pausedSince = null;
  } else return;
  fanout(s, runClockEvent(s));
}

export function noteSessionStatus(s: Session): void {
  tickRunClock(s);
  const waiting = waitingOf(s);
  const key = `${s.running ? 1 : 0}|${waiting?.id ?? ""}`;
  if (lastStatusKey.get(s.id) === key) return;
  lastStatusKey.set(s.id, key);
  // 空闲的记录攒多了就整批清掉（下次它再变动，照发一条就是）
  if (lastStatusKey.size > 500) for (const [id, k] of lastStatusKey) if (k === "0|") lastStatusKey.delete(id);
  emitGlobal({ e: "session_status", id: s.id, title: s.title, running: s.running, waiting, at: Date.now() });
}

// 此刻在跑或在等人的会话
export function pendingSummary(): { serverTime: number; sessions: { id: string; title: string; running: boolean; waiting: WaitingInfo | null }[] } {
  const rows = [...registry.sessions.values()]
    .map((s) => ({ id: s.id, title: s.title, running: s.running, waiting: waitingOf(s) }))
    .filter((s) => s.running || s.waiting);
  return { serverTime: Date.now(), sessions: rows };
}
