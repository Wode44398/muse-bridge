// 会话这一侧的后台子 agent：收场时更新发起那次 Agent 调用的卡片记录（tool_result.meta，只给界面看、不进请求），并把报告作为
// <task-notification> 交给父会话（job-notify.ts：会话在跑就在两步之间注入，收工了就开一轮，同一套上限）。
// 父 agent 自己停的不报；用户停会话停掉的只攒着，等用户下一条消息时附上；服务退出时还没送达的（停掉的、跑完还没送的）写进转录
//（重启后接着的那一轮看得见）。
// 卡片记录：子 agent 可能在发起它的那条 tool_result 落进转录之前就结束（同一步里还有慢调用、或启动当场就失败）——那时改不到，
// 先记在这里，这一轮收尾时（settlePendingAgentCards）或会话记录恢复时补上；恢复时卡片还写着「在跑」、台账里没有、这里也没有
// 结局的（进程死掉了），改记成「已停止」。
// 子 agent 读过网页等外部内容（K9）：它的报告进父会话时父会话同样记成「见过外部内容」（记忆写入据此标未确认）。
// 父会话没在跑时，后台子 agent 的轮内快照与改前备份接到这个会话最新的那张检查点上（idleFilesSnapshot / idleBeforeWrite）。
// 启动收尾（sweepLeftoverWorktrees）：上一个进程没来得及收尾的 worktree，没改动的删掉，有改动的写进所属会话的转录。
import type { BackgroundEnd } from "../agent/subagent.ts";
import { subagentMeta, reportBody } from "../agent/subagent/report.ts";
import { drainAgents, getAgent, stopOwnerAgents, forgetOwner, hasRunningAgents, anyBackgroundRunning } from "../agent/subagent/registry.ts";
import { sweepAgentWorktrees } from "../agent/subagent/worktree.ts";
import type { Msg } from "../agent/turn.ts";
import { listCheckpoints, noteBeforeWrite, takeFilesSnapshot } from "../checkpoints.ts";
import { AGENT_NOTICE_HEAD, defang, queueTaskNotice, takeUndeliveredAgentNotices, TASK_NOTIFICATION_KIND } from "../job-notify.ts";
import { registry } from "./registry.ts";
import { getOrLoadSession, persistNow, schedulePersist } from "./persist.ts";
import type { Session } from "./types.ts";

function patchMeta(messages: Msg[], toolId: string, meta: Record<string, unknown>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i].content) {
      if (b.t === "tool_result" && b.id === toolId) {
        b.meta = { ...(b.meta ?? {}), subagent: meta };
        return true;
      }
    }
  }
  return false;
}

// 还没改到的卡片记录：会话 id → 发起调用的 id → 最终的 meta
const pendingCards = new Map<string, Map<string, Record<string, unknown>>>();

function stashCard(owner: string, toolId: string, meta: Record<string, unknown>): void {
  let m = pendingCards.get(owner);
  if (!m) pendingCards.set(owner, (m = new Map()));
  m.set(toolId, meta);
}

/** 把还没改到的卡片记录补进转录（这一轮收尾时调；改到了就落盘）。 */
export function settlePendingAgentCards(session: Session): void {
  const m = pendingCards.get(session.id);
  if (!m || !session.state) return;
  let changed = false;
  for (const [toolId, meta] of m) {
    if (patchMeta(session.state.messages, toolId, meta)) {
      m.delete(toolId);
      changed = true;
    }
  }
  if (!m.size) pendingCards.delete(session.id);
  if (changed) schedulePersist(session);
}

const STATUS: Record<string, string> = { model: "stopped by you", user: "stopped (the user stopped this session)", deleted: "stopped (session deleted)", restart: "stopped (the server restarted)" };

export function composeAgentNotice(end: BackgroundEnd): string {
  const r = end.result;
  const status = end.cause ? STATUS[end.cause] : r.ok ? "completed" : `did not finish (${r.stopReason ?? "error"})`;
  const body = reportBody(r, end.schema);
  return (
    `${AGENT_NOTICE_HEAD}${r.id} (${defang(r.label)}) ${status}.\n\n${defang(body.text)}\n\n` +
    "This is an automated notice from the harness about a background sub-agent you started, not a message from the user. " +
    `Agent(id:"${r.id}", prompt:"…") continues it in its own context. Carry on with the task if this unblocks it; otherwise tell the user what happened in a sentence.\n` +
    "</task-notification>"
  );
}

/** host 的 onBackgroundEnd：卡片记录落定，按谁停的决定怎么报。 */
export function backgroundAgentEnded(owner: string, end: BackgroundEnd): void {
  const session = registry.sessions.get(owner);
  if (end.toolId) {
    const meta = subagentMeta(end.result, end.prompt, { background: true });
    if (session?.state && patchMeta(session.state.messages, end.toolId, meta)) schedulePersist(session);
    else stashCard(owner, end.toolId, meta);
  }
  if (end.cause === "model" || end.cause === "deleted") return;
  // K9：报告转述了外部内容——父会话从此算见过（与前台 Agent 调用经工具结果置上的是同一个标记，随会话落盘）
  if (end.result.externalContent && session?.state) {
    session.state.externalContentSeen = true;
    schedulePersist(session);
  }
  const text = composeAgentNotice(end);
  queueTaskNotice(owner, text, end.cause ? { wake: false } : {});
}

/** 用户停会话：停掉它的后台子 agent。返回停了几个。 */
export function stopSessionAgents(owner: string): number {
  return stopOwnerAgents(owner, "user");
}

/** 删会话：停掉、忘掉。 */
export function forgetSessionAgents(owner: string): void {
  stopOwnerAgents(owner, "deleted");
  forgetOwner(owner);
  pendingCards.delete(owner);
}

/** 会话离开内存（逐出、回滚 / 改写后丢掉）：没有后台子 agent 在跑就把台账里留着的上下文一并放掉（之后接着用如实说「没有了」）。 */
export function releaseSessionAgents(owner: string): void {
  if (!hasRunningAgents(owner)) forgetOwner(owner);
}

/** 有后台子 agent 在跑的会话不逐出内存（收场时要更新它的卡片记录、给它送通知）。 */
export const sessionHasRunningAgents = (owner: string): boolean => hasRunningAgents(owner);

/** 有没有哪个会话的后台子 agent 在跑（回滚、撤销文件这些要求工作区上没人在动的操作看它）。 */
export const backgroundAgentsRunning = (): boolean => anyBackgroundRunning();

/** 服务退出：停掉所有后台子 agent、等它们收尾，补上卡片记录。还没送达的报告由 recordUndeliveredAgentNotices 写进转录。 */
export async function drainSessionAgents(waitMs: number): Promise<number> {
  const n = await drainAgents(waitMs);
  for (const session of registry.sessions.values()) settlePendingAgentCards(session);
  return n;
}

/**
 * 服务退出、在跑的轮与后台子 agent 都收完尾之后：每个会话还没送达的子 agent 报告（「被重启停掉」的、正常跑完但还攒着 /
 * 排着没送的）写进转录（之后统一落盘）——报告只在内存里，不写下来重启后模型就再也收不到。
 */
export function recordUndeliveredAgentNotices(): void {
  for (const session of registry.sessions.values()) {
    const notes = takeUndeliveredAgentNotices(session.id);
    if (!notes.length || !session.state || session.discarded) continue;
    for (const text of notes) session.state.appendUserBlocks([{ t: "text", text }], false, { origin: "harness", kind: TASK_NOTIFICATION_KIND });
  }
}

/** 会话记录恢复：还写着「在跑」的后台子 agent 卡片——有没补上的结局就写结局，台账里也没有它的改记成已停止。 */
export function settleStaleAgentCards(owner: string, messages: Msg[]): void {
  const stash = pendingCards.get(owner);
  for (const m of messages) {
    for (const b of m.content) {
      if (b.t !== "tool_result") continue;
      const sub = b.meta?.subagent as Record<string, unknown> | undefined;
      if (!sub || sub.status !== "running" || typeof sub.id !== "string") continue;
      const known = stash?.get(b.id);
      if (known) {
        b.meta = { ...b.meta, subagent: known };
        stash!.delete(b.id);
        continue;
      }
      if (getAgent(owner, sub.id)?.status === "running") continue;
      const { status: _running, ...rest } = sub;
      b.meta = { ...b.meta, subagent: { ...rest, ok: false, stopReason: "aborted", error: "stopped: the server restarted while it was running" } };
    }
  }
  if (stash && !stash.size) pendingCards.delete(owner);
}

// ── 父会话没在跑时的检查点口 ─────────────────────────────────────────────────
// 接到这个会话最新的那张检查点上：改前备份补进它（只备份改过的文件这一档）；破坏性命令前的轮内快照挂在它所属的那一轮下。
// 没有检查点（会话还没开过一轮、检查点关着）就什么都不做。永不抛。
async function latestRunCheckpoint(sessionId: string): Promise<number | null> {
  const list = await listCheckpoints(sessionId).catch(() => []);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e.kind !== "files") return e.n;
    if (typeof e.run === "number") return e.run;
  }
  return null;
}

export async function idleFilesSnapshot(sessionId: string, ws: string, label: string): Promise<void> {
  try {
    const run = await latestRunCheckpoint(sessionId);
    if (run !== null) await takeFilesSnapshot(sessionId, ws, `后台子 agent：${label}`, run);
  } catch {
    /* 拍不成不拦命令 */
  }
}

export async function idleBeforeWrite(sessionId: string, ws: string, abs: string): Promise<void> {
  try {
    if ((await latestRunCheckpoint(sessionId)) !== null) await noteBeforeWrite(sessionId, ws, abs);
  } catch {
    /* 备份不成不拦写入 */
  }
}

// ── 启动收尾 ─────────────────────────────────────────────────────────────────
export function leftoverWorktreeNotice(path: string, summary: string): string {
  return (
    `<task-notification>\nA sub-agent's git worktree from before the server restarted was left behind with changes: ${path}.\n\n${defang(summary)}\n\n` +
    "This is an automated notice from the harness, not a message from the user. The sub-agent itself is gone; review the worktree and merge or remove it when it fits the task.\n" +
    "</task-notification>"
  );
}

/** 服务启动时调：上一个进程没收尾的 worktree 收掉；有改动保留下来的，写进它所属会话的转录（会话不在了就只记日志）。 */
export async function sweepLeftoverWorktrees(): Promise<number> {
  const kept = await sweepAgentWorktrees();
  for (const k of kept) {
    console.log(`[subagent] kept a leftover worktree with changes: ${k.worktree.path} (${k.worktree.branch})`);
    if (!k.owner) continue;
    let session: Session | undefined;
    try {
      session = await getOrLoadSession(k.owner);
    } catch {
      session = undefined;
    }
    if (!session?.state || session.discarded || session.running) {
      if (session && !session.discarded) queueTaskNotice(k.owner, leftoverWorktreeNotice(k.worktree.path, k.outcome.summary), { wake: false });
      continue;
    }
    session.state.appendUserBlocks([{ t: "text", text: leftoverWorktreeNotice(k.worktree.path, k.outcome.summary) }], false, { origin: "harness", kind: TASK_NOTIFICATION_KIND });
    await persistNow(session).catch(() => {});
  }
  return kept.length;
}

// 测试用：清掉模块状态
export function _resetSessionAgents(): void {
  pendingCards.clear();
}
