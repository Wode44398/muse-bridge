// 会话记录的快照、防抖落盘与从盘上恢复。
import path from "node:path";
import { danglingToolCalls, healDanglingToolCalls, mayHaveSideEffects, visibleMessages } from "../agent/state.ts";
import { findWorkflowRunByToolId } from "../agent/workflow.ts";
import { coldGoal } from "../goal.ts";
import { sanitizeLedger } from "../usage-ledger.ts";
import { sanitizeBaseline } from "../tools/mcp.ts";
import { loadSessionResult, type PersistedSession, saveSession, SESSION_RECORD_VERSION, sessionsDir, unsupportedVersionMessage } from "../store.ts";
import { latestCheckpointDiffStat } from "../checkpoints.ts";
import { CodedError, ERROR_CODES } from "../errors.ts";
import { registry } from "./registry.ts";
import { buildState, restoreFromRecord, wireSessionState } from "./build-state.ts";
import { withModelIdentity } from "./switches.ts";
import type { Session } from "./types.ts";
import { workspaceRoot } from "./workspace.ts";

// ── Persistence ──────────────────────────────────────────────────────────────

// Content fingerprint a client can compare against the copy it already holds.
// A phone coming back to a session it has cached asks /status first; when the
// fingerprint matches there is nothing to re-render and it can skip pulling the
// full record — which for a long session is 300KB+ over a mobile tunnel, paid
// again on every switch back.
//
// updatedAt is NOT usable here: sessionRecord stamps it with Date.now() at
// serialization time, so it changes on every call even when nothing did.
// Message count is the primary signal; the last message's block count catches
// blocks appended to the tail in place, and output tokens catch anything the
// agent produced. All three are O(1) reads off data already in hand.
export function recordFp(rec: PersistedSession): string {
  const visible = visibleMessages(rec.messages);
  const last = visible[visible.length - 1] as { content?: unknown[] } | undefined;
  const blocks = Array.isArray(last?.content) ? last.content.length : 0;
  return `${visible.length}.${blocks}.${rec.totals?.outputTokens ?? 0}`;
}

// Snapshot a live session into its persisted form. Null until the session has
// run at least once (no state or config yet — nothing worth saving).
export function sessionRecord(session: Session): PersistedSession | null {
  if (session.discarded) return null;
  const st = session.state;
  if (!st || !session.cfg) return null;
  return {
    v: SESSION_RECORD_VERSION,
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    title: session.title,
    config: session.cfg,
    system: st.system,
    messages: st.messages,
    origins: 1, // C3：消息带结构化来源，没有来源的就是用户本人说的
    world: st.systemWorld, // C4：system 建成时各节的令牌（恢复时据此只补差量，不重写 system）
    todos: st.todos,
    totals: {
      inputTokens: st.totalInputTokens,
      outputTokens: st.totalOutputTokens,
      lastContextTokens: st.lastContextTokens,
      // Q4：缓存读 / 写与前缀判定的累计数（请求数、按原因计的断点、重发字符数）
      cacheReadTokens: st.totalCacheReadTokens,
      cacheWriteTokens: st.totalCacheWriteTokens,
      prefix: st.prefix.totals,
    },
    // Q4：上一次请求的前缀指纹（只有哈希与字符数），恢复会话后接着比——恢复即断（#30）在生产上也看得见
    prefixBaseline: st.prefix.baseline(),
    gates: {
      dirtySinceVerify: st.dirtySinceVerify,
      editedFiles: [...st.editedFiles],
      ranCommands: st.ranCommands,
      mutationEpoch: st.mutationEpoch,
      verifiedEpoch: st.verifiedEpoch,
      lastVerification: st.lastVerification,
      ...(st.externalContentSeen ? { externalContent: true } : {}),
    },
    counters: {
      compactionFailures: st.compactionFailures,
      turnsSinceTodoSeen: st.turnsSinceTodoSeen,
    },
    // O7：目标续跑的契约与进度（老版本读到会忽略）
    ...(session.goal ? { goal: session.goal } : {}),
    // O8：用量账本（会话 × 厂商 × 型号 × 任务）
    ...(registry.usageLedgers.get(session.id) && Object.keys(registry.usageLedgers.get(session.id)!).length ? { usage: registry.usageLedgers.get(session.id) } : {}),
    ...(session.mcp ? { mcp: session.mcp } : {}),
  };
}

const SAVE_DEBOUNCE_MS = 2_000;

// Mark the session dirty; an actual save lands at most once per debounce window
// (saves are full-snapshot writes — cheap enough, but not per-event cheap).
export function schedulePersist(session: Session): void {
  if (session.persistTimer) return;
  session.persistTimer = setTimeout(() => {
    session.persistTimer = null;
    void persistNow(session);
  }, SAVE_DEBOUNCE_MS);
}

export async function persistNow(session: Session): Promise<void> {
  // M11：回滚中的会话不落盘——回滚写回的记录才是真相，迟到的旧状态不许盖上去（U9 改写同理）
  if (session.discarded || registry.rollingBack === session.id || registry.rewinding.has(session.id)) return;
  await writeRecord(session);
}

export async function writeRecord(session: Session): Promise<void> {
  if (session.persistTimer) {
    clearTimeout(session.persistTimer);
    session.persistTimer = null;
  }
  const rec = sessionRecord(session);
  if (!rec) return;
  try {
    await saveSession(rec);
  } catch (e) {
    console.error(`[persist] session ${session.id}: ${(e as Error).message}`);
  }
}

// Get a session by id, resurrecting it from disk when it isn't in memory (the
// resume-after-restart path). Throws when the persisted provider's key is
// missing — the caller surfaces that message to the client.
export async function getOrLoadSession(id: string): Promise<Session | undefined> {
  const existing = registry.sessions.get(id);
  if (existing) return existing;
  // M11：这个会话正在回滚 / 删除——等它做完再从盘上读（否则读到回滚前的记录，或把刚删的会话读回来）
  const busy = registry.lifecycleChains.get(id);
  if (busy) {
    await busy;
    const settled = registry.sessions.get(id);
    if (settled) return settled;
  }

  const inFlight = registry.loading.get(id);
  if (inFlight) return inFlight;

  const p = hydrateSession(id).finally(() => {
    if (registry.loading.get(id) === p) registry.loading.delete(id);
    registry.droppedWhileLoading.delete(id);
  });
  registry.loading.set(id, p);
  return p;
}

async function hydrateSession(id: string): Promise<Session | undefined> {
  const loaded = await loadSessionResult(id);
  // M7：更新版本写的会话只读——恢复成可运行的会话就意味着之后按本版本整份写回，会抹掉新版本的字段。
  // Q14：状态码仍是 400（接口只加不改），多带一个稳定码
  if (loaded.kind === "unsupported-version") throw new CodedError(ERROR_CODES.sessionReadOnly, unsupportedVersionMessage(loaded.version), 400);
  // Q14：文件在但这会儿读不了——如实报（503，客户端稍后重试），不冒充「没有这个会话」
  if (loaded.kind === "unreadable") {
    throw new CodedError(ERROR_CODES.sessionUnreadable, `会话文件这会儿读不了（${loaded.code}），稍后再试`, 503);
  }
  if (loaded.kind !== "ok") return undefined;
  const rec = loaded.rec;

  // A racing dropSession/registration may have landed while we read from disk —
  // never evict a live object (it may already be running or have watchers).
  const raced = registry.sessions.get(id);
  if (raced) return raced;

  // O8：账本——内存里已有的（这个进程里更新的）优先，没有才用记录里的
  if (!registry.usageLedgers.has(rec.id) && rec.usage) registry.usageLedgers.set(rec.id, sanitizeLedger(rec.usage));
  // E1：MCP 工具按记录里的基线还原（E1 之前的会话没有这一项：不加 MCP 工具，工具清单与当初一致）
  const mcp = sanitizeBaseline(rec.mcp);
  // 运行中换过型号、还没等到下一轮重建就重启了：记录里的配置是新型号，system 里的身份句还是旧的——这里对齐
  const system = rec.system ? withModelIdentity(rec.system, rec.config) : "";
  const state = buildState(rec.config, system || undefined, rec.id, rec.world, mcp);
  restoreFromRecord(state, rec);
  if (system !== (rec.system ?? "")) state.noteRewrite("model");
  // A mid-run snapshot can end on an unanswered tool_call batch — heal it so
  // the next request is valid. R6（#32）：按工具 effect 如实说（只读的「没完成、无副作用」，
  // 有副作用的「结果未知、先查状态」），后者附上这一轮开始以来工作区的改动。
  const effectOf = (name: string) => state.toolMap.get(name)?.effect;
  const dangling = danglingToolCalls(state.messages);
  const diffstat = dangling.some((c) => mayHaveSideEffects(c.name, effectOf(c.name)))
    ? await latestCheckpointDiffStat(rec.id, rec.config.workspace ?? workspaceRoot())
    : "";
  healDanglingToolCalls(state.messages, {
    effectOf,
    diffstat,
    // O1（#9）：跑了一半的 Workflow 按工具调用 id 找回 journal，如实说完成了几个、怎么续跑。
    workflowRun: (toolCallId) => findWorkflowRunByToolId(path.join(sessionsDir(), "workflows"), toolCallId),
  });
  // Q4：C4 起恢复时 system 原样沿用，前缀不该断；只有 C4 之前写的会话（没有 world 令牌）照旧刷新了一次 system，
  // 下一次请求若断开就归因为恢复
  if (!rec.world) state.noteRewrite("resume");
  // readFileState intentionally starts empty: files may have changed while the
  // server was down, so the Edit gate must force fresh Reads.

  const session: Session = {
    id: rec.id,
    state,
    abort: null,
    createdAt: rec.createdAt,
    running: false,
    runPromise: null,
    discarded: false,
    title: rec.title,
    cfg: rec.config,
    persistTimer: null,
    watchers: new Set(),
    runLog: [],
    runLogTruncated: false,
    touchedAt: Date.now(),
    runStartMsgCount: visibleMessages(rec.messages).length,
    pendingAsks: new Map(),
    pendingPermissions: new Map(),
    pendingPlans: new Map(),
    // O7：从盘上读回的目标——进行中的一律暂停（冷恢复不自动续）
    ...(rec.goal ? { goal: coldGoal(rec.goal) } : {}),
    ...(mcp ? { mcp } : {}),
  };
  // 恢复出来的会话同样要能切档（历史会话打开后直接改模式）。
  wireSessionState(session, state);
  // Deleted out from under us mid-hydration — hand the record back without
  // registering it, so nothing persists it again.
  if (registry.droppedWhileLoading.has(id)) return undefined;
  registry.sessions.set(session.id, session);
  return session;
}
