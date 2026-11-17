// 改动历史上的操作：检查点回滚、从这里改写、审阅与逐文件撤销。
import type { TodoItem } from "../agent/events.ts";
import { parseTodos } from "../tools/todo.ts";
import { loadSessionResult, type PersistedSession, saveSession, unsupportedVersionMessage } from "../store.ts";
import { changedPathsSinceCheckpoint, checkpointRecord, recordRunEnd, restoreFromBaseline, rollbackPlan, rollbackTo, type SessionChange, sessionChangeList, sessionFileDiff, takeCheckpoint, turnCheckpointFor } from "../checkpoints.ts";
import type { Msg } from "../agent/turn.ts";
import { registry } from "./registry.ts";
import { dropSession, lifecycle } from "./lifecycle.ts";
import { sessionRecord, writeRecord } from "./persist.ts";
import { sessionWorkspace } from "./workspace.ts";

// Roll a session back to checkpoint n: restore the workspace files and the
// conversation as they were before that checkpoint's message. The in-memory
// session is dropped; the next access resumes from the restored file on disk
// (the normal resume path does all hydration). Refused while ANY session runs —
// the workspace is shared, a rollback under a running agent's feet corrupts both.
type RollbackResult = { ok: boolean; error?: string; code?: "running" | "external"; external?: string[] };

// M11（K29）：进这个会话的生命周期链；查「有没有会话在跑」与占上全局静默标记之间没有 await——查完到回滚结束，
// 谁也起不了新的一轮（startRun 回「正在回滚」），这个会话也落不了盘。同一时刻只许一个回滚（两个会话可能共用一个工作区）。
export function rollbackSession(sessionId: string, n: number, opts: { force?: boolean } = {}): Promise<RollbackResult> {
  return lifecycle(sessionId, async () => {
    for (const s of registry.sessions.values()) {
      if (s.running) {
        return { ok: false, code: "running", error: "a session is currently running — stop it before rolling back" };
      }
    }
    if (registry.rollingBack) return { ok: false, code: "running", error: "another rollback is in progress — try again when it finishes" };
    registry.rollingBack = sessionId;
    try {
      return await rollbackQuiesced(sessionId, n, opts);
    } finally {
      registry.rollingBack = null;
    }
  });
}

async function rollbackQuiesced(sessionId: string, n: number, opts: { force?: boolean }): Promise<RollbackResult> {
  try {
    const ws = await sessionWorkspace(sessionId);
    // P9（#29）：回滚前先把当前现场（工作区文件 + 完整对话）拍成一个新检查点——回滚本身可撤销，想反悔
    // 就回滚到这个「回滚前现场」。以前回滚直接覆盖会话文件、不留当前状态，手机上误触一次就回不来。
    // 拍不成就不回滚：绝不做一次撤不回来的回滚。
    const live = registry.sessions.get(sessionId);
    if (live && !live.discarded) await writeRecord(live); // 静默期间 persistNow 不落盘；回滚自己这一次要落
    // M7：更新版本写的会话不回滚——回滚要按本版本整份写回会话文件，会抹掉新版本的字段。
    const onDisk = live ? null : await loadSessionResult(sessionId);
    if (onDisk?.kind === "unsupported-version") return { ok: false, error: unsupportedVersionMessage(onDisk.version) };
    // P9（K22、C3）：要撤掉的改动里有不是这个对话留下的（手改的、别的对话改的），先不回滚，把它们列给人看；
    // 人确认了（force）才回滚——回滚前的现场照样先拍，覆盖了也撤得回来。
    if (!opts.force) {
      const { external } = await rollbackPlan(sessionId, n, ws);
      if (external.length) {
        return {
          ok: false,
          code: "external",
          external,
          error: `${external.length} file(s) were changed outside this conversation since that checkpoint; rolling back would overwrite them`,
        };
      }
    }
    const current = (live ? sessionRecord(live) : null) ?? (onDisk?.kind === "ok" ? onDisk.rec : null);
    const pre = current ? await takeCheckpoint(current, ws, PRE_ROLLBACK_LABEL) : null;
    if (current && !pre) {
      return { ok: false, error: "could not snapshot the current state first, so the rollback was not done (it would not be undoable)" };
    }
    await rollbackTo(sessionId, n, ws);
    // P9（K22）：回滚自己的改动也记在这个对话名下——撤销这次回滚（回滚到「回滚前现场」）不会被当成外部改动拦下
    if (pre) await recordRunEnd(sessionId, ws, pre.n);
    dropSession(sessionId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export const PRE_ROLLBACK_LABEL = "回滚前现场（要撤销回滚，就回滚到这里）";

// ── U9（X41、K23、D7）：「从这里改写」——只回退对话，工作区文件不动 ─────────────────────────────
// 用户在某条自己发的消息上点「从这里改写」：对话退回到这条消息之前（之后的全部删掉），原话由界面放回输入框，改完重发；
// 文件一概不动（要连文件一起回去，用检查点回滚）。改写前先把整个现场拍成检查点——改写可撤销（撤销 = 把那份对话原样换回来），
// 检查点面板里也看得到「改写前现场」。退回去之后文件和那一刻不一样了：从开跑检查点量出改过哪些文件，附一条 harness 说明
// 告诉模型（读过再用，别凭记忆）。只拦这个会话自己在跑；别的会话照跑（文件没人动）。
export const PRE_REWIND_LABEL = "改写前现场（要撤销改写，就回滚到这里）";
export const REWIND_KIND = "rewind";
const REWIND_FILES_SHOWN = 20;

export type RewindResult = {
  ok: boolean;
  error?: string;
  code?: "running" | "not_found" | "unavailable" | "moved_on";
  // 撤销用：改写前现场的检查点号 + 改写后对话的条数（之后又发过消息就不许撤销了）
  undo?: { n: number; length: number };
  changedFiles?: string[];
};

const userText = (m: Msg): string =>
  (typeof m.displayText === "string" ? m.displayText : m.content.filter((b) => b.t === "text").map((b) => (b as { text: string }).text).join("\n")).trim();

// 界面上的用户气泡与转录的对应：和前端 rebuildTimeline 同一个口径——不是内部消息、不是 harness 注入的、有字或附件的用户消息
//（visibleMessages 会拷贝消息对象，这里要下标，就按同样的条件直接数）
function userBubbles(messages: Msg[]): number[] {
  const out: number[] = [];
  messages.forEach((m, i) => {
    if (m.internal || m.role !== "user" || m.origin === "harness" || m.content.some((b) => b.t === "tool_result")) return;
    if (!userText(m) && !m.attachments?.length) return;
    out.push(i);
  });
  return out;
}

// 点的是第 ordinal 个气泡、写的是 text：先认第 ordinal 个（字对得上），对不上（压缩掉了前面的、界面没刷新）就在字对得上的里
// 挑位置不超过 ordinal、离它最近的一条。插话（steer）也是气泡，但退到插话之前等于把一轮拦腰截断——不许。
export function locateRewind(messages: Msg[], target: { ordinal: number; text: string }): number {
  const bubbles = userBubbles(messages);
  const want = target.text.trim();
  const at = bubbles[target.ordinal];
  let idx = at !== undefined && userText(messages[at]) === want ? at : -1;
  if (idx < 0) {
    for (let k = Math.min(target.ordinal, bubbles.length - 1); k >= 0; k--) {
      if (userText(messages[bubbles[k]]) === want) {
        idx = bubbles[k];
        break;
      }
    }
  }
  if (idx < 0 || messages[idx].origin === "steer") return -1;
  return idx;
}

// 那一刻的待办 = 保留下来的这一截里最后一次成功的 TodoWrite
function todosIn(messages: Msg[]): TodoItem[] {
  const ok = new Set<string>();
  for (const m of messages) for (const b of m.content) if (b.t === "tool_result" && b.ok) ok.add(b.id);
  let todos: TodoItem[] = [];
  for (const m of messages) {
    for (const b of m.content) if (b.t === "tool_call" && b.name === "TodoWrite" && ok.has(b.id)) todos = parseTodos(b.args);
  }
  return todos;
}

function rewindNote(changed: string[] | null): Msg {
  const files = changed === null
    ? "The workspace files were NOT rolled back and may have changed after this point."
    : `The workspace files were NOT rolled back: ${changed.length} file(s) changed after this point and still carry those changes: ` +
      changed.slice(0, REWIND_FILES_SHOWN).join(", ") +
      (changed.length > REWIND_FILES_SHOWN ? ` (+${changed.length - REWIND_FILES_SHOWN} more)` : "") + ".";
  return {
    role: "user",
    origin: "harness",
    kind: REWIND_KIND,
    content: [{
      t: "text",
      text: `[Rewound by the user] The conversation was taken back to this point; everything after it was removed. ${files} ` +
        "Read a file again before relying on what you remember of it.",
    }],
  };
}

async function currentRecord(sessionId: string): Promise<{ rec: PersistedSession | null; error?: string }> {
  const live = registry.sessions.get(sessionId);
  if (live && !live.discarded) {
    await writeRecord(live);
    return { rec: sessionRecord(live) };
  }
  const onDisk = await loadSessionResult(sessionId);
  if (onDisk.kind === "unsupported-version") return { rec: null, error: unsupportedVersionMessage(onDisk.version) };
  return { rec: onDisk.kind === "ok" ? onDisk.rec : null };
}

export function rewindSession(sessionId: string, target: { ordinal: number; text: string }): Promise<RewindResult> {
  return lifecycle(sessionId, async () => {
    if (registry.sessions.get(sessionId)?.running) {
      return { ok: false, code: "running", error: "this conversation is running — stop it before rewriting from an earlier message" };
    }
    registry.rewinding.add(sessionId);
    try {
      const ws = await sessionWorkspace(sessionId);
      const { rec: current, error } = await currentRecord(sessionId);
      if (!current) return { ok: false, code: "not_found", error: error ?? "unknown session" };
      const cut = locateRewind(current.messages, target);
      if (cut < 0) {
        return { ok: false, code: "not_found", error: "that message is no longer in the conversation (it may have been compacted into a summary)" };
      }
      const pre = await takeCheckpoint(current, ws, PRE_REWIND_LABEL);
      if (!pre) return { ok: false, code: "unavailable", error: "could not snapshot the conversation first, so nothing was rewound (it would not be undoable)" };
      const kept = current.messages.slice(0, cut);
      const turn = await turnCheckpointFor(sessionId, kept, [PRE_ROLLBACK_LABEL, PRE_REWIND_LABEL, PRE_RESTORE_LABEL]);
      const changed = turn ? await changedPathsSinceCheckpoint(sessionId, turn.n, ws) : null;
      const messages = changed && !changed.length ? kept : [...kept, rewindNote(changed)];
      const next: PersistedSession = { ...current, messages, todos: todosIn(kept), updatedAt: Date.now() };
      dropSession(sessionId);
      await saveSession(next);
      return { ok: true, undo: { n: pre.n, length: messages.length }, ...(changed ? { changedFiles: changed } : {}) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      registry.rewinding.delete(sessionId);
    }
  });
}

// ── U10（K38）：审阅面板的「本会话」视图 + 逐文件撤销这个对话的改动 ───────────────────────────
// 撤销 = 把文件退回这个会话开始之前的样子（新建的删掉），对话不动。规矩照回滚：有会话在跑不做（工作区可能是共用的，在跑的
// agent 脚下改文件两边都坏），做的时候全局静默；现在的内容不是这个对话留下的（它改完之后又被人动过）要人确认（force）；
// 撤销前先拍「撤销前现场」检查点——撤销本身也找得回来（回滚到那张）；撤销自己的改动记在这个对话名下，找回时不会被当成
// 外部改动拦下。转录末尾附一条 harness 说明（kind restore）：模型下一轮知道这些文件已经不是它最后写的样子。
export const PRE_RESTORE_LABEL = "撤销文件前现场（要找回，就回滚到这里）";
export const RESTORE_KIND = "restore";
const RESTORE_FILES_SHOWN = 20;
const REVIEW_FILES_CAP = 800;

export type SessionReview =
  | { scope: "session"; available: false; reason: "no-checkpoints" }
  | {
      scope: "session";
      available: true;
      since: number;
      files: SessionChange[];
      total: { add: number; del: number };
      truncated: boolean;
      others: number;
      // 现在撤销不了：有会话在跑 / 正在回滚（按钮先灰着，点了服务端也会拒）
      busy: boolean;
    };

const restoreBusy = (): boolean => registry.rollingBack !== null || [...registry.sessions.values()].some((s) => s.running);

export async function sessionReview(sessionId: string): Promise<SessionReview> {
  const list = await sessionChangeList(sessionId, await sessionWorkspace(sessionId));
  if (!list) return { scope: "session", available: false, reason: "no-checkpoints" };
  const total = list.files.reduce((a, f) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 });
  const files = list.files.slice(0, REVIEW_FILES_CAP);
  return { scope: "session", available: true, since: list.since, files, total, truncated: files.length < list.files.length, others: list.others, busy: restoreBusy() };
}

export async function sessionReviewDiff(sessionId: string, rel: string) {
  return sessionFileDiff(sessionId, await sessionWorkspace(sessionId), rel);
}

export type RestoreResult = {
  ok: boolean;
  error?: string;
  code?: "running" | "external" | "stale" | "not_found" | "unavailable";
  external?: string[];
  restored?: string[];
  removed?: string[];
  // 找回用：撤销前现场的检查点号
  undo?: { n: number };
};

function restoreNote(restored: string[], removed: string[]): Msg {
  const list = (ps: string[]) =>
    ps.slice(0, RESTORE_FILES_SHOWN).join(", ") + (ps.length > RESTORE_FILES_SHOWN ? ` (+${ps.length - RESTORE_FILES_SHOWN} more)` : "");
  const parts = [
    restored.length ? `restored to how they were before this conversation: ${list(restored)}` : "",
    removed.length ? `removed (they were created in this conversation): ${list(removed)}` : "",
  ].filter(Boolean);
  return {
    role: "user",
    origin: "harness",
    kind: RESTORE_KIND,
    content: [{
      t: "text",
      text: `[Files restored by the user] From the review panel, the user undid this conversation's changes to ${restored.length + removed.length} file(s) — ` +
        `${parts.join("; ")}. Read a file again before relying on what you remember of it.`,
    }],
  };
}

export function restoreSessionFiles(sessionId: string, paths: readonly string[], opts: { force?: boolean } = {}): Promise<RestoreResult> {
  return lifecycle(sessionId, async () => {
    if ([...registry.sessions.values()].some((s) => s.running)) {
      return { ok: false, code: "running", error: "a session is currently running — stop it before undoing file changes" };
    }
    if (registry.rollingBack) return { ok: false, code: "running", error: "a rollback is in progress — try again when it finishes" };
    registry.rollingBack = sessionId;
    try {
      return await restoreQuiesced(sessionId, [...new Set(paths)], opts);
    } finally {
      registry.rollingBack = null;
    }
  });
}

async function restoreQuiesced(sessionId: string, wanted: string[], opts: { force?: boolean }): Promise<RestoreResult> {
  try {
    const ws = await sessionWorkspace(sessionId);
    const { rec: current, error } = await currentRecord(sessionId);
    if (!current) return { ok: false, code: "not_found", error: error ?? "unknown session" };
    const list = await sessionChangeList(sessionId, ws);
    if (!list) return { ok: false, code: "unavailable", error: "this conversation has no checkpoints, so there is no baseline to restore from" };
    const byPath = new Map(list.files.map((f) => [f.path, f]));
    const stale = wanted.filter((p) => !byPath.has(p));
    if (stale.length) {
      return { ok: false, code: "stale", error: `not a change made in this conversation (any more): ${stale.join(", ")} — refresh the list` };
    }
    const external = wanted.filter((p) => byPath.get(p)!.external);
    if (external.length && !opts.force) {
      return {
        ok: false,
        code: "external",
        external,
        error: `${external.length} file(s) were changed outside this conversation after it last touched them; undoing would overwrite those changes`,
      };
    }
    const pre = await takeCheckpoint(current, ws, PRE_RESTORE_LABEL);
    if (!pre) return { ok: false, code: "unavailable", error: "could not snapshot the current state first, so nothing was undone (it would not be recoverable)" };
    const { restored, removed } = await restoreFromBaseline(sessionId, ws, wanted);
    await recordRunEnd(sessionId, ws, pre.n);
    const next: PersistedSession = { ...current, messages: [...current.messages, restoreNote(restored, removed)], updatedAt: Date.now() };
    dropSession(sessionId);
    await saveSession(next);
    return { ok: true, restored, removed, undo: { n: pre.n } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}


// 撤销改写：把「改写前现场」那份对话原样换回来（文件本来就没动）。改写之后又发过消息就不许了——那会把新的一轮抹掉。
export function undoRewind(sessionId: string, n: number, expectLength: number): Promise<RewindResult> {
  return lifecycle(sessionId, async () => {
    if (registry.sessions.get(sessionId)?.running) return { ok: false, code: "running", error: "this conversation is running — stop it first" };
    registry.rewinding.add(sessionId);
    try {
      const { rec: current, error } = await currentRecord(sessionId);
      if (!current) return { ok: false, code: "not_found", error: error ?? "unknown session" };
      if (current.messages.length !== expectLength) {
        return { ok: false, code: "moved_on", error: "the conversation has moved on since the rewrite, so it can no longer be undone here (roll back from the checkpoints instead)" };
      }
      const { meta, rec } = await checkpointRecord(sessionId, n);
      if (meta.label !== PRE_REWIND_LABEL) return { ok: false, code: "not_found", error: `checkpoint ${n} is not a pre-rewrite snapshot` };
      dropSession(sessionId);
      await saveSession({ ...rec, updatedAt: Date.now() });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      registry.rewinding.delete(sessionId);
    }
  });
}
