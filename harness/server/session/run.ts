// 一轮的运行：发送回执、开跑、执行与收尾、轮后的记忆沉淀。
import { clipMessage, lastAnswer, notifyBridge } from "../bridge-events.ts";
import { prAfterTurn } from "../pr-bridge.ts";
import { type FamilyOrigin, familyRunEnd, familyRunStart } from "../session-family.ts";
import { jobNotifyRunEnd, jobNotifyRunStart } from "../job-notify.ts";
import { settlePendingAgentCards } from "./subagents.ts";
import { cancelIdleCompact, idleCompactRunEnd } from "../idle-compact.ts";
import { cancelMemoryDream } from "../memory-dream.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentEvent } from "../agent/events.ts";
import { AgentState, isPureSocialTurn, visibleMessages } from "../agent/state.ts";
import { recallIds, ROUTINE_KIND, skillLoadedIn } from "../agent/injections.ts";
import { runAgent } from "../agent/loop.ts";
import { GOAL_CONTINUE_KIND, GOAL_START_KIND, goalContinueText, goalStartText, type RoundOutcome } from "../goal.ts";
import { resolveSlash, type SlashHit, slashInjection } from "../commands.ts";
import { runStartHooks } from "../hooks/index.ts";
import { clearRunMarker, PROCESS_CREATED, readRunMarker, writeRunMarker } from "../run-markers.ts";
import { noteRecalledDocs } from "../memory-usage.ts";
import { fileRunMemory, memoryExtractEnabled, runDigest, type RunDigest } from "../memory-extract.ts";
import { knowledgeWithin, refreshProjectKnowledge } from "../knowledge-service.ts";
import { searchUnifiedKnowledge, worthAutoRecall } from "../knowledge-search.ts";
import { warmRecentSessions } from "../recent-sessions.ts";
import type { PersistedSession } from "../store.ts";
import { changedPathsSinceCheckpoint, noteBeforeWrite, recordRunEnd, takeCheckpoint, takeFilesSnapshot } from "../checkpoints.ts";
import type { Msg } from "../agent/turn.ts";
import type { RefDigest } from "../session-refs.ts";
import { attachAssistantArtifacts } from "../artifacts.ts";
import { RESTART_REASON, retiring } from "../retire.ts";
import { runInTrace, startTrace } from "../trace.ts";
import { flushTraceLog, traceEvent } from "../trace-log.ts";
import { registry } from "./registry.ts";
import { initState } from "./build-state.ts";
import { fanout, fanoutLive, noteSessionStatus, RUN_LOG_RETAIN, runClockEvent, runTiming, stampRunTiming, watchSession } from "./events.ts";
import { goalHooks, scheduleGoalRound, settleGoalRound, syncGoalTool } from "./goal-run.ts";
import { registerAsk, registerPermission, registerPlan } from "./interactions.ts";
import { evictIdleSessions, touchSession } from "./lifecycle.ts";
import { persistNow, schedulePersist, sessionRecord } from "./persist.ts";
import { recallRefs, renderAutomaticRecall } from "./recall.ts";
import { RESUME_KIND, resumeText } from "./resume.ts";
import { applyModeChange, applyReadRoots, applySessionAllow, isAway, rebindModel, setSessionAway } from "./switches.ts";
import type { Session } from "./types.ts";
import { prepareUserInput } from "./user-input.ts";
import { workspaceRoot } from "./workspace.ts";

// M12：一轮开跑时给知识 worker 的新鲜度预算（小工作区通常几十毫秒就对完；大笔记库超时先用旧快照）
const RUN_START_KNOWLEDGE_BUDGET_MS = 250;


// Run one user message to completion, emitting agent events as they happen.
// `budget` (optional, per-run) bounds the run by wall-clock and/or model turns —
// the loop nudges convergence at 80% and forces a final summary once exhausted.
export interface RunHandle {
  started: boolean;
  done: Promise<void>;
  // M8：服务在退役（部署前冻结新 run），这一条没有起。
  retiring?: boolean;
  // M11：有会话在回滚（全局静默），这一条没有起。
  rollingBack?: boolean;
}


// ── M2（#51）：发送回执 ────────────────────────────────────────────────────────
// 手机切网、隧道抖动时 POST /api/run 有没有落地，客户端自己分不清：以前一律「认领 / 对账」，没落地的消息
// 在对账后静默消失，草稿和附件已经清空。现在客户端每次发送带一个 clientRunId，服务端记住最近这些，
// 客户端断流后按它问一句「落地了没有」；同一个 id 重发不会再起第二轮。只在内存里记（重启后查不到时，
// 客户端按「不知道」处理，让用户确认后再发）。
const CLIENT_RUN_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_CLIENT_RUNS = 500;
const clientRuns = new Map<string, string>(); // clientRunId → sessionId（插入顺序即新旧）

export function cleanClientRunId(raw: unknown): string | undefined {
  return typeof raw === "string" && CLIENT_RUN_ID_RE.test(raw) ? raw : undefined;
}

function rememberClientRun(clientRunId: string, sessionId: string): void {
  clientRuns.delete(clientRunId);
  clientRuns.set(clientRunId, sessionId);
  while (clientRuns.size > MAX_CLIENT_RUNS) clientRuns.delete(clientRuns.keys().next().value!);
}

export function lookupClientRun(raw: unknown): { sessionId: string; runId: string; running: boolean } | null {
  const cid = cleanClientRunId(raw);
  const sessionId = cid ? clientRuns.get(cid) : undefined;
  if (!cid || !sessionId) return null;
  const s = registry.sessions.get(sessionId);
  return { sessionId, runId: cid, running: Boolean(s?.running && s.runId === cid) };
}

// Start a turn as an in-process background job. This function reserves the
// session synchronously before its first await, so two near-simultaneous POSTs
// cannot both pass the running check. The returned promise is observability,
// not ownership: dropping an HTTP/SSE connection must not cancel it.
export function startRun(
  session: Session,
  message: string,
  budget?: { deadlineMs?: number; maxTurns?: number },
  attachmentPaths: string[] = [],
  clientRunId?: string,
  // M13：服务重启 / 进程死掉之后的自动续跑——不重提原 prompt，首条是 harness 内部片段
  // O7：goal = 目标续跑的下一轮（首条是 harness 片段 kind goal-continue）
  // 引用会话：路由里先按请求的 refs 做好的摘要（读记录要 await，startRun 必须同步占住会话，所以在外面做）
  // 拉取请求自动修复（pr.ts）：bridge 发来的 <ci-monitor-event>——首条是 harness 片段（kind 由调用方给），不是用户的话
  // 会话协作（session-family.ts）：head = 这一轮的首条不是用户打的字，而是 harness 片段（父会话派的任务、会话消息、子会话
  // 汇报——信封见 injections.ts）；family = 这一轮是谁发起的（会话间唤醒 / 派生；不给就按真人 / 续跑算）
  // 定时任务（routine-runs.ts，bridge 的 Routines）：message 是用户自己写在任务里的指令（照常落成用户消息），routine.text 是紧跟
  // 其后的一条 harness 片段（kind routine，写明「定时触发、无人值守」）；调用方另给 family（auto：不算真人发话）
  opts: {
    resume?: { resumes: number; reason: "restart" | "crash" };
    goal?: boolean;
    refs?: RefDigest[];
    event?: { text: string; kind: string; label: string };
    // prelude = 分叉（fork）出来的子会话先接上父会话的对话副本，再跟这条首条
    head?: { text: string; kind: string; title?: string; retrieval?: string; prelude?: Msg[] };
    family?: FamilyOrigin;
    routine?: { text: string };
  } = {},
): RunHandle {
  if (session.running) {
    return { started: false, done: session.runPromise ?? Promise.resolve() };
  }
  // M8：部署前的退役闸冻结了新 run——这一条不起（客户端按「没送达」放回输入框）。
  if (retiring()) return { started: false, done: Promise.resolve(), retiring: true };
  // M11（K29）：回滚期间全局静默——回滚在 checkout 工作区，这时开跑的 agent 会在半截的文件上干活
  // U9：这个会话正在改写（对话要被换掉）——这一条也不起
  if (registry.rollingBack || registry.rewinding.has(session.id)) return { started: false, done: Promise.resolve(), rollingBack: true };
  // 空闲压缩（idle-compact.ts）：要开跑了——撤掉定时器、掐掉正在压的（在动任何消息与状态之前）
  cancelIdleCompact(session.id);
  // 离线记忆整理（memory-dream.ts）：有人开跑就掐掉，别和这一轮抢模型（本机模型只有一个槽）
  cancelMemoryDream();

  if (!session.state) {
    session.state = initState(session);
  } else if (session.modelRebindPending) {
    // 上一轮跑着的时候换了型号 / 深度：这一轮开跑前按新配置重建（同步，仍在第一个 await 之前）
    rebindModel(session, session.modelRebindFrom);
  }
  // O7：UpdateGoal 只在有进行中的目标时出现（工具清单只在两轮之间变）
  syncGoalTool(session);

  // Capture the pre-message record synchronously. The filesystem snapshot is
  // written by the background job before any model/tool work starts.
  // #87：记录里的 messages / todos / ranCommands 是活数组——下一行就要把这条用户消息推进去，检查点在后台排队、几次 await
  // 之后才序列化，写下的就成了「这条消息已发、还没回答」，「回到这条消息之前」其实留着它。取一份浅拷贝定格在此刻
  //（开跑前没有别的改动会碰已有消息对象，浅拷贝够用）。
  const live = sessionRecord(session);
  const preRec = live && {
    ...live,
    messages: [...live.messages],
    todos: [...live.todos],
    gates: { ...live.gates, ranCommands: [...live.gates.ranCommands] },
  };
  let checkpointLabel: string;
  let retrievalText: string;
  // E3：这条消息是 /技能名（或 /包名）——正文等镜像底座定下来之后再追加（见下）
  let slash: SlashHit | null = null;
  // N45：本轮用户本人发的那条消息（续跑、目标下一轮是 harness 片段，没有）——自动召回挂在它上面
  let ownUserMsg: Msg | null = null;
  if (opts.resume) {
    // M13：续跑轮的首条是 harness 片段（kind resume）；addUserMessageBlocks 顺带把门禁照新一轮重置
    session.state.addUserMessageBlocks([{ t: "text", text: resumeText(opts.resume.reason) }], "");
    const head = session.state.messages[session.state.messages.length - 1];
    head.origin = "harness";
    head.kind = RESUME_KIND;
    checkpointLabel = "（服务重启后自动续跑）";
    retrievalText = "";
  } else if (opts.goal && session.goal) {
    // O7：目标续跑的下一轮——首条是 harness 片段（kind goal-continue），不重提原话
    session.goal = { ...session.goal, round: session.goal.round + 1, updatedAt: Date.now() };
    session.state.addUserMessageBlocks([{ t: "text", text: goalContinueText(session.goal) }], "");
    const head = session.state.messages[session.state.messages.length - 1];
    head.origin = "harness";
    head.kind = GOAL_CONTINUE_KIND;
    checkpointLabel = `（目标第 ${session.goal.round - session.goal.roundBase} 轮）`;
    retrievalText = "";
  } else if (opts.event) {
    // ── 拉取请求自动修复（pr.ts）：首条是 bridge 发来的事件，按 harness 片段落盘（界面上是一行提示，不是用户气泡）──
    session.state.addUserMessageBlocks([{ t: "text", text: opts.event.text }], "");
    const head = session.state.messages[session.state.messages.length - 1];
    head.origin = "harness";
    head.kind = opts.event.kind;
    checkpointLabel = opts.event.label;
    retrievalText = "";
  } else if (opts.head) {
    // 会话协作：首条是 harness 片段（kind 见 injections.ts 的会话信封），界面上画成会话消息卡
    if (opts.head.prelude?.length && !session.state.messages.length) session.state.messages.push(...opts.head.prelude);
    session.state.addUserMessageBlocks([{ t: "text", text: opts.head.text }], opts.head.retrieval ?? "");
    const head = session.state.messages[session.state.messages.length - 1];
    head.origin = "harness";
    head.kind = opts.head.kind;
    if (!session.title && opts.head.title) session.title = opts.head.title.slice(0, 200);
    checkpointLabel = opts.head.title ? opts.head.title.slice(0, 60) : "（会话间消息）";
    retrievalText = opts.head.retrieval ?? "";
  } else {
    const prepared = prepareUserInput(session, message, attachmentPaths, opts.refs ?? []);
    session.state.addUserMessageBlocks(prepared.content, prepared.retrievalText, {
      displayText: prepared.displayText,
      attachments: prepared.attachments,
    });
    ownUserMsg = session.state.messages[session.state.messages.length - 1];
    if (opts.refs?.length) {
      ownUserMsg.refs = opts.refs.map(({ id, title }) => ({ id, title }));
      // K9：被引用的对话读过外部内容——它的摘要也算外部内容，这个会话照样打上污染标记
      if (opts.refs.some((r) => r.tainted)) session.state.externalContentSeen = true;
    }
    if (!session.title) session.title = prepared.title;
    checkpointLabel = prepared.title;
    retrievalText = prepared.retrievalText;
    slash = resolveSlash(message, session.state.ctx.sandbox.root);
    // O7：这条消息开了一个目标——第一轮，跟一条说明（界面上是一行提示）
    if (session.goal?.status === "active" && session.goal.round === 0) {
      session.goal = { ...session.goal, round: 1, updatedAt: Date.now() };
      session.state.appendUserBlocks([{ t: "text", text: goalStartText(session.goal) }], false, { origin: "harness", kind: GOAL_START_KIND });
    }
    // 定时任务：指令后面跟一条「定时触发、无人值守」的说明（界面上是一行提示，见 web 的 harnessNotice）
    if (opts.routine?.text) session.state.appendUserBlocks([{ t: "text", text: opts.routine.text }], false, { origin: "harness", kind: ROUTINE_KIND });
  }
  session.state.setRunBudget(budget);
  // 会话协作：记下这一轮是谁发起的；真人发话时把攒着没送出去的会话消息附在这条后面（同一轮里一起读到）
  const held = familyRunStart(session, opts.family ?? (opts.resume || opts.goal ? { kind: "auto" } : opts.head ? { kind: "inbox", from: [] } : { kind: "user" }));
  if (held) session.state.appendUserBlocks([{ t: "text", text: held.text }], false, { origin: "harness", kind: held.kind });
  // 后台任务通知（job-notify.ts）：用户本人发话时清零连续自动开轮，攒着的通知在第一步之前注入
  jobNotifyRunStart(session, !opts.family && !opts.resume && !opts.goal && !opts.head && !opts.event);

  const abort = new AbortController();
  session.abort = abort;
  session.running = true;
  touchSession(session);
  noteSessionStatus(session); // P8：全局通道——开跑
  // bridge 插件订阅的 turn.start（bridge-events.ts）：续跑 / 目标续轮也发，kind 标出来
  notifyBridge("turn.start", {
    sessionId: session.id, model: session.cfg?.model ?? "", provider: session.cfg?.provider ?? "",
    kind: opts.resume ? "resume" : opts.goal ? "goal" : opts.event ? "event" : opts.routine ? "routine" : "chat", isNew: !(session.state?.messages.length), message: clipMessage(message),
  });
  // Pre-existing gap fixed: without this, tools never saw the abort signal —
  // stopping a session left running Bash children / fetches / walks alive.
  session.state.ctx.signal = abort.signal;

  // Live-mirror bookkeeping uses the same sanitized coordinate system as the
  // session API, otherwise hidden audit turns shift the replay boundary.
  session.runStartMsgCount = visibleMessages(session.state.messages).length;
  session.runUserMsg = session.state.messages[session.state.messages.length - 1] ?? null;
  // M2：客户端给了发送身份就用它当这一轮的 runId（重发时服务端认得出「已经落地」），否则自己铸一个。
  const cid = cleanClientRunId(clientRunId);
  session.runId = cid ?? randomUUID();
  if (cid) rememberClientRun(cid, session.id);
  // M13：开跑 marker（正常收尾删；被重启切断的留着并标上；进程死了自然留着）——下一个进程据此自动续跑
  writeRunMarker(session.id, {
    runId: session.runId,
    startedAt: Date.now(),
    resumes: opts.resume?.resumes ?? 0,
    pid: process.pid,
    pidCreated: PROCESS_CREATED,
  });
  session.runLog = [];
  // E3：技能正文追加在本轮用户消息（镜像底座）之后——后附着的设备看到的底座不含它，靠 runLog 里的 skill_loaded 补那一行
  // 提示，不会重复
  if (slash) {
    const inj = slashInjection(slash, (name) => skillLoadedIn(session.state!.messages, name), session.state.ctx.sandbox.root);
    if (inj) {
      session.state.appendUserBlocks([{ t: "text", text: inj.text }], false, { origin: "harness", kind: inj.kind });
      if (!inj.command) fanout(session, { e: "skill_loaded", name: inj.name, via: "slash", ...(inj.pkg ? { pkg: true } : {}) });
    }
  }
  // O7：目标的状态进这一轮的 runLog（后附着的设备重放得到）
  if (session.goal) fanout(session, { e: "goal", goal: session.goal });
  // Q12：这一轮一个 traceId；下面整个 executeRun 都在它的上下文里
  const trace = startTrace(session.id, session.runId);
  session.trace = trace;
  // U3：本轮计时开表（放在 runLog 重置之后，附着的设备重放得到）
  session.runClock = { startedAt: Date.now(), pausedMs: 0, pausedSince: null };
  fanout(session, runClockEvent(session));
  // P3：用户在这个会话发了新消息 = 人回来了，离开模式自动关（放在 runLog 重置之后，附着的设备重放得到）。续跑不算人回来。
  // 定时任务那一轮也不算人回来（它是到点自己跑的）
  // 首条是 harness 片段的轮（后台任务通知、定时唤醒、CI 事件、会话间消息）同样不算：以前两行各漏一样，event 与 head 的轮都会把离开模式关掉
  if (!opts.resume && !opts.goal && !opts.event && !opts.head && !opts.routine && isAway(session)) setSessionAway(session, false);
  const done = runInTrace(trace, () => executeRun(session, preRec, checkpointLabel, retrievalText, abort, ownUserMsg));
  session.runPromise = done;
  return { started: true, done };
}

async function executeRun(
  session: Session,
  preRec: PersistedSession | null,
  checkpointLabel: string,
  userMessage: string,
  abort: AbortController,
  ownUserMsg: Msg | null = null,
): Promise<void> {
  const state = session.state!;
  const runMsgStart = state.messages.length; // bridge 插件的 turn.end 只取这一轮里的回答
  // P9（K22）：这一轮开跑时的检查点——收尾时给它补结束快照（回滚前据此分出外部改动）
  let runCheckpoint: { n: number; ws: string } | null = null;
  // O7：这一轮怎么结束的、动没动过工具（目标续跑据此决定续不续）
  let outcome: RoundOutcome = { kind: "done" };
  let usedTools = false;
  // M12：先让知识 worker 对一遍（与下面拍检查点并行，召回前再按预算取结果）
  void refreshProjectKnowledge(session.cfg?.workspace ?? workspaceRoot()).catch(() => {});

  // Human-in-the-loop: the AskUserQuestion tool blocks on this. The question is
  // fanned out (so mirrors see it and reconnects replay it from runLog); the
  // returned promise resolves when answerAsk lands, or on abort.
  state.ctx.askUser = (questions, callId) => registerAsk(session, questions, abort.signal, callId);
  // 同一条阻塞-fanout-落定链路的另两个用途：规则判定为 ask 的调用、plan mode 的批准。
  state.ctx.requestPermission = (req) => registerPermission(session, req, abort.signal);
  state.ctx.submitPlan = (plan) => registerPlan(session, plan, abort.signal);
  // Live side-channel for long tools (Agent/Workflow): sub-agent and workflow
  // progress rides the same fanout as the loop's own events, so mirrors see it
  // and reconnects replay it from runLog.
  state.ctx.emit = (ev) => {
    if (ev.e === "tool_progress") {
      fanoutLive(session, ev);
      return;
    }
    fanout(session, ev);
    schedulePersist(session);
  };
  // 运行中改模式（plan 批准 / 用户手动切档）要落盘并广播，否则重开会话又回到 plan。
  // state 创建时已挂过，这里对老会话对象再确保一次（幂等）。
  state.onModeChange = (mode) => applyModeChange(session, mode);
  state.onSessionAllow = (list) => applySessionAllow(session, list);
  state.onReadRoots = (list) => applyReadRoots(session, list);
  // R6（#32）：有副作用的工具开跑前立即落盘（平时是 2 秒防抖）。
  state.beforeSideEffects = () => persistNow(session);
  // K2（#28）：记忆来源里的「有没有人在场」。#71（维护者 09-24 定）：无人值守那套先不做，照常默认有人在——
  // 只有明确开了离开模式（P3）才记为不在场；手机熄屏、SSE 断开都不算（以前按「有没有客户端连着」判，一熄屏就记成没人）。
  state.ctx.humanAttended = () => !isAway(session);
  // O7：有进行中的目标时 UpdateGoal 经它声明达成 / 要人
  state.ctx.goal = session.goal?.status === "active" ? goalHooks(session) : undefined;

  try {
    if (preRec) {
      // Snapshot the SESSION's workspace. Full-access edits outside this root
      // remain intentionally outside checkpoint coverage.
      const ws = session.cfg?.workspace ?? workspaceRoot();
      const cp = await takeCheckpoint(preRec, ws, checkpointLabel);
      // V5（#20）：验证门禁的「改过没有」补上这一轮开跑以来的影子 git 差异
      if (cp) state.changedSinceRunStart = () => changedPathsSinceCheckpoint(session.id, cp.n, ws, { skipNestedRepos: true });
      if (cp) {
        runCheckpoint = { n: cp.n, ws };
        // 大工作区（检查点只备份改过的文件）：Write / Edit 改文件前先把它补进这张检查点；这个会话头一回切到这一档时说一声
        if (cp.scope === "touched") state.ctx.beforeFileWrite = (abs) => noteBeforeWrite(session.id, ws, abs);
        if (cp.scopeStarted) fanout(session, { e: "notice", code: "checkpoint_touched" });
        // N26（HT3）：破坏性命令前的轮内快照（只有文件，回滚到它只还原文件）；这张开跑检查点就是「上一张」
        state.ctx.snapshotFiles = (label) => takeFilesSnapshot(session.id, ws, label, cp.n).then(() => undefined);
        state.snappedAtSeq = state.workSeq;
      }
    }
    // 用户 hooks：项目级 hooks 的信任确认、SessionStart、UserPromptSubmit——拦下了就不开跑，原因给用户看
    const hookGate = await runStartHooks(state, ownUserMsg);
    if (hookGate.blocked) {
      const summary = `这条消息被 UserPromptSubmit hook 拦下了：${hookGate.blocked.replace(/\s+/g, " ").slice(0, 200)}`;
      fanout(session, { e: "error", message: `UserPromptSubmit hook blocked this message: ${hookGate.blocked.slice(0, 2000)}`, retriable: false, summary });
      outcome = { kind: "error", summary: summary.slice(0, 120) };
      return;
    }
    try {
      const ws = session.cfg?.workspace ?? workspaceRoot();
      // M12：开跑时踢的那次对知识（与拍检查点并行）最多再等一个预算；超时先用旧快照（后台接着对），召回与 World State
      // 都读这一份。以前这里在主线程上同步扫描整个工作区，笔记库一次冻住所有会话 5–8 秒。
      const knowledge = await knowledgeWithin(ws, RUN_START_KNOWLEDGE_BUDGET_MS).catch(() => null);
      // 新会话的 system 里列这个工作区最近的会话：列会话要读文件（异步），在补 system 之前暖好
      if (!state.messages.some((m) => m.role === "assistant")) await warmRecentSessions(ws);
      state.refreshSystemIfUnsent(); // 新会话建 system 时知识可能还没对完：第一次请求前补进 system，不走片段
      // 每轮自动召回：档案开关（hardened 开；lean 关——记忆索引常驻 system）
      if (state.profile.memory.autoRecall && !isPureSocialTurn(userMessage)) {
        const recalled = await searchUnifiedKnowledge(ws, userMessage, {
          limit: 6,
          semantic: process.env.KNOWLEDGE_AUTO_SEMANTIC !== "0",
          signal: abort.signal,
          latestFailureOnly: true, // C7（#60）：陈旧的失败验证不往上下文里塞
          ...(knowledge ? { knowledge } : {}),
        });
        // C1（#35）：召回作为 internal 消息追加在本轮用户消息之后、随会话落盘（聊天记录里不显示）。以前它只插在
        // 请求里、不落盘，下一条消息一来就从请求里消失——前缀在它的位置断开，上一轮的全部工具往返都得重算。
        // 本会话已经注入过的文档不再追加（去重键是文档 id；被压缩掉之后模型看不到了，会再注入）。
        const seen = new Set(recallIds(state.messages));
        const fresh = recalled.results.filter((item) => !seen.has(item.document.id) && worthAutoRecall(item, userMessage, recalled.semantic));
        const recall = renderAutomaticRecall({ ...recalled, results: fresh });
        // K11：记下哪些记忆的全文被拉进了这一轮（记忆面板的「召回 N 次」）
        noteRecalledDocs(ws, fresh.map((item) => item.document.id));
        if (recall) {
          state.appendUserBlocks([{ t: "text", text: recall }], true, { origin: "harness", kind: "recall" });
          // N45：召回对人可见——标题与理由挂在本轮的用户消息上（下面紧接着落盘，翻历史也在），并告诉在看的设备
          if (ownUserMsg) {
            ownUserMsg.recall = recallRefs(fresh);
            fanout(session, { e: "recall", items: ownUserMsg.recall });
          }
        }
      }
    } catch (error) {
      // Retrieval is an accelerator, never a reason to block an otherwise
      // valid coding turn. Recall remains available as an explicit tool.
      console.error(`[knowledge] automatic recall: ${(error as Error).message}`);
    }
    // Capture the user message (and any healed transcript) before model work.
    await persistNow(session);
    const runStartLen = state.messages.length; // U8：这一轮追加的消息从这里往后
    for await (const ev of runAgent(state, abort.signal)) {
      // U3：「正在写某个工具的参数 · N 字」只是此刻的状态——只发给在看的设备，不进 runLog、不触发落盘
      if (ev.e === "tool_call_begin") {
        fanoutLive(session, ev);
        continue;
      }
      // O7：这一轮的结局（最后一个说了算）与动没动手
      if (ev.e === "tool_start") usedTools = true;
      else if (ev.e === "done") outcome = { kind: "done" };
      else if (ev.e === "error") {
        // U6：中断也是 error，带 stopped（谁停的）
        outcome = ev.stopped
          ? { kind: "aborted", by: ev.stopped === "restart" ? "restart" : "user" }
          : { kind: "error", summary: String(ev.summary ?? ev.message ?? "").slice(0, 120) };
      }
      if (ev.e === "done") {
        const artifacts = attachAssistantArtifacts(state.messages, state.ctx.sandbox, state.createdFiles);
        if (artifacts.length) fanout(session, { e: "artifacts", items: artifacts });
        // U8（ZCode E3）：这一轮的用时盖在最后一条可见回答上（翻历史折叠过程时用），也随 done 发出
        const timing = runTiming(session);
        if (timing) {
          stampRunTiming(state.messages, runStartLen, timing);
          fanout(session, { ...ev, ...timing });
          schedulePersist(session);
          continue;
        }
      }
      fanout(session, ev);
      schedulePersist(session);
    }
  } catch (e) {
    fanout(session, { e: "error", message: (e as Error).message, retriable: false });
    outcome = { kind: "error", summary: (e as Error).message.slice(0, 120) };
  } finally {
    // P9（K22）：这一轮的结束快照。在「不在跑了」之前同步排进检查点的串行队列——之后的回滚 / 预览一定排在它后面，
    // 拿到的是补过的记录；收尾最后等它拍完 run 才算完（不留一个 git 子进程在 run 结束之后还攥着工作区）。
    const ended = runCheckpoint ? recordRunEnd(session.id, runCheckpoint.ws, runCheckpoint.n) : null;
    // 瘦身 P0-1：这一轮正常收尾、又值得看——在任何 await 之前定格摘要（session.running 一放开，用户可能马上发下一条）
    const memoryDigest = outcome.kind === "done" ? digestForMemory(session, state, userMessage) : null;
    // M13：被「服务重启」切断的轮 marker 留着、标上；其余出口（做完、用户停、报错）删掉
    if (abort.signal.aborted && abort.signal.reason === RESTART_REASON) {
      const marker = readRunMarker(session.id);
      if (marker) writeRunMarker(session.id, { ...marker, interrupted: "restart" });
    } else {
      clearRunMarker(session.id);
    }
    session.running = false;
    session.abort = null;
    session.runPromise = null;
    // Unblock any AskUserQuestion still awaiting an answer (abnormal exit while a
    // question is open) so its tool call cannot hang a future continuation.
    for (const pending of session.pendingAsks.values()) pending.resolve({ cancelled: true, answers: [] });
    session.pendingAsks.clear();
    // 同理：还挂着的权限问询/计划批准一律按「拒绝」松手，绝不留下永远等不到答案的
    // tool 调用（下一次续聊会卡在它上面）。M3（#27）：但要标明是「没答」不是「拒绝」。
    for (const pending of session.pendingPermissions.values()) {
      pending.resolve({ decision: "deny", note: "the run ended before the user answered", unanswered: true });
    }
    session.pendingPermissions.clear();
    for (const pending of session.pendingPlans.values()) {
      pending.resolve({ approved: false, note: "run ended", unanswered: true });
    }
    session.pendingPlans.clear();
    noteSessionStatus(session); // P8：全局通道——收尾（在跑与等人都清了）
    state.ctx.askUser = undefined;
    state.ctx.requestPermission = undefined;
    state.changedSinceRunStart = undefined;
    state.ctx.snapshotFiles = undefined;
    state.ctx.beforeFileWrite = undefined;
    state.ctx.submitPlan = undefined;
    state.ctx.emit = undefined;
    state.onModeChange = undefined;
    state.beforeSideEffects = undefined;
    state.ctx.humanAttended = undefined;
    state.ctx.goal = undefined;
    // M3（#27、#45）：run 从任何出口结束（停止、报错、门禁连败、预算耗尽）时，还没送进模型的插话一律清算：
    // 不再留到下一轮、带着「优先于此前的指示」排在用户新消息后面注入（那时它往往已被用户推翻），而是
    // 退回客户端放回输入框。
    const leftover = state.takeSteer();
    if (leftover.length) {
      fanout(session, { e: "steer_returned", texts: leftover.map((s) => s.text), ids: leftover.map((s) => s.id) });
    }
    // O7：目标这一轮的结算（在告诉在看的设备「这一轮结束了」之前，它们收得到新的目标状态）
    const goalNext = settleGoalRound(session, outcome, usedTools);
    // Tell every currently attached SSE watcher that the independently-owned
    // job is over. Detached clients can reconnect while running and receive the
    // retained runLog before live events.
    for (const w of session.watchers) {
      try {
        w({ e: "mirror_end", runId: session.runId ?? undefined });
      } catch {
        /* ignore */
      }
    }
    session.watchers.clear();
    // The run log exists so another device can attach mid-run and replay; once the
    // run is over nothing replays it (the stream endpoint 409s on a stopped
    // session) and startRun clears it for the next one. Holding every text_delta
    // of every finished run kept whole conversations' worth of deltas resident for
    // the life of the process — keep only a bounded tail, which is what post-mortem
    // inspection ("did this run end in an abort?") actually needs.
    if (session.runLog.length > RUN_LOG_RETAIN) {
      session.runLog = session.runLog.slice(-RUN_LOG_RETAIN);
    }
    session.runLogTruncated = false;
    // Long-lived process resources (background jobs, dev servers, this session's own
    // browser tabs) deliberately outlive the turn, so nothing is reaped here: the next
    // turn picks the same page up, and stopSession / DELETE reap what they own.
    // （以前这里要放掉全进程唯一那个浏览器的占用，否则下一个会话被拒；现在每个会话各有一份，没有占用可放。）
    // Q12：收尾一行（整轮耗时、是不是被停的），然后把这一轮排着的行写下去
    // bridge 插件订阅的 turn.end（bridge-events.ts）
    notifyBridge("turn.end", {
      sessionId: session.id, model: session.cfg?.model ?? "", provider: session.cfg?.provider ?? "",
      ok: outcome.kind === "done" && !abort.signal.aborted, stopped: abort.signal.aborted,
      ...(outcome.kind === "error" ? { error: String((outcome as { summary?: string }).summary ?? "") } : {}),
      durationMs: session.runClock ? Date.now() - session.runClock.startedAt : 0,
      result: lastAnswer(state.messages, runMsgStart), usedTools,
    });
    // 拉取请求（pr-bridge.ts）：这一轮报出的 PR 链接交给 bridge 绑定；用户本人发起的轮清零自动修复的连续唤醒计数
    prAfterTurn(session.id, session.cfg?.workspace ?? workspaceRoot(), state.messages, runMsgStart, ownUserMsg !== null);
    // 后台任务通知：这一轮没注入的 watch 行收回来；模型最后一步之后才结束的 job 叫醒它（job-notify.ts）
    jobNotifyRunEnd(session);
    // 后台子 agent 在发起它的那条 tool_result 落进转录之前就结束了：卡片记录这时补上（session/subagents.ts）
    settlePendingAgentCards(session);
    // 会话协作：子会话这一轮收工 → 给父会话汇报、该唤醒的唤醒；没送进模型的会话消息收回收件箱（session-family.ts）
    familyRunEnd(session, {
      outcome: outcome.kind,
      by: outcome.kind === "aborted" ? outcome.by : undefined,
      summary: outcome.kind === "error" ? outcome.summary : undefined,
      result: lastAnswer(state.messages, runMsgStart),
    });
    traceEvent(session.id, {
      e: "run_end",
      durationMs: session.runClock ? Date.now() - session.runClock.startedAt : undefined,
      aborted: abort.signal.aborted,
      turns: state.runTurns,
    });
    void flushTraceLog();
    await persistNow(session);
    // 空闲压缩：按这个会话的缓存时长排一次（用户在缓存过期前回来就撤掉）
    idleCompactRunEnd(session);
    if (memoryDigest) scheduleMemoryFiling(session, state, memoryDigest);
    if (ended) await ended;
    evictIdleSessions();
    // O7：目标还没达成、预算还有——续下一轮
    if (goalNext === "continue") scheduleGoalRound(session);
  }
}

// ── 瘦身 P0-1：run 之后的记忆沉淀 ─────────────────────────────────────────────
// 收工不再有记忆审计（MemoryAudit 关口）。一轮正常收尾后，按确定性信号判断值不值得看（runDigest），值得就在后台另起一次
// 旁路请求挑出该长期记住的东西、经 Remember 同一套治理落盘（memory-extract.ts）。不占 running：答复早已交付，用户可以
// 接着发消息；失败只记一行日志。用量记进这个会话的账本（任务 memory）。
function digestForMemory(session: Session, state: AgentState, userMessage: string): RunDigest | null {
  if (!memoryExtractEnabled() || state.memoryAuditRequired || session.discarded) return null;
  // 这一轮从本轮的用户消息起；中途整段压缩把它摘掉了，就从最后那条压缩摘要起（压缩前干过什么在 compactedTrace 里）
  let from = session.runUserMsg ? state.messages.indexOf(session.runUserMsg) : -1;
  if (from < 0) from = state.messages.findLastIndex((m) => m.kind === "compaction-summary");
  if (from < 0) return null;
  const root = state.ctx.sandbox.root;
  const edited = [...state.editedFiles].map((f) => {
    const rel = path.relative(root, f);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replace(/\\/g, "/") : f;
  });
  return runDigest(state.messages, from, { workspace: root, edited, compacted: state.compactedTrace, request: userMessage || undefined });
}

function scheduleMemoryFiling(session: Session, state: AgentState, digest: RunDigest): void {
  const started = Date.now();
  const job = fileRunMemory({
    adapter: state.adapter,
    digest,
    ctx: {
      sandbox: state.ctx.sandbox,
      humanAttended: () => !isAway(session),
      lookupToolCall: state.ctx.lookupToolCall,
      externalContent: () => state.externalContentSeen,
      ownerId: session.id,
    },
    onUsage: (u) => state.recordSideUsage("memory", u),
  }).then(
    (r) => {
      traceEvent(session.id, { e: "memory_filed", why: digest.why, saved: r.saved.length, refused: r.rejected.length, ms: Date.now() - started });
      if (r.saved.length || r.rejected.length) {
        console.log(`[memory] ${session.id}: after-run filing (${digest.why}) saved ${r.saved.length}${r.saved.length ? ` — ${r.saved.join("; ")}` : ""}${r.rejected.length ? `; refused ${r.rejected.length}: ${r.rejected.join(" | ")}` : ""}`);
      }
    },
    (e) => console.warn(`[memory] ${session.id}: after-run filing failed (${digest.why}): ${(e as Error).message}`),
  );
  const tracked: Promise<void> = job.finally(() => {
    if (session.memoryJob === tracked) session.memoryJob = null;
    void persistNow(session); // 用量账本多了一笔（不走防抖：评测台等 memoryPending 消失后就读记录）
  });
  session.memoryJob = tracked;
}


// Compatibility helper for tests/internal callers that want to await a full
// turn through one callback. HTTP routes use startRun + watchSession directly.
export async function runMessage(
  session: Session,
  message: string,
  emit: (ev: AgentEvent | Record<string, unknown>) => void,
  budget?: { deadlineMs?: number; maxTurns?: number },
): Promise<void> {
  const run = startRun(session, message, budget);
  if (!run.started) {
    emit({ e: "error", message: "session is already running", retriable: false });
    return;
  }
  const unsub = watchSession(session, emit as (ev: Record<string, unknown>) => void);
  try {
    await run.done;
  } finally {
    unsub();
  }
}
