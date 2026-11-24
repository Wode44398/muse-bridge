// agent 主循环 runAgent。阈值与提示语、结局措辞、改动与验证证据、权限问询与审计、各类检查的辅助函数在 loop/ 下；对外的名字仍从这里引。
import type { AgentEvent, StopReason } from "./events.ts";
import type { Block, Msg } from "./turn.ts";
import { toolResult } from "./turn.ts";
import { mayHaveSideEffects, type AgentState } from "./state.ts";
import { RunInvariants } from "./turn-invariants.ts";
import { compactNow, contextNeedsTrim, contextTokens, effectiveWindow, ensureContextFits } from "./context.ts";
import { downsampleForModel, parseImageByteLimit } from "./media-budget.ts";
import "./injections.ts";
import { withDeferredDocs } from "./deferred-tools.ts";
import { playbooksForCalls, playbooksForRequest } from "./playbooks.ts";
import { attachProjectDocs } from "../project-docs/attach.ts";
import { loopStopText } from "./loop-guard.ts";
import { isRunawayRepetition, LOOP_CUT_NOTICE } from "./repetition.ts";
import { connectErrorLabel, isConnectFailure, isLocalLoadingError, planWait, type NetWait, type WaitPlan } from "./netwait.ts";
import { callSubject, decide, REPEAT_DENIAL_RULE, sessionRuleChoices } from "./permissions.ts";
import { approvalPreview } from "./approval-preview.ts";
import { permissionReceipt, type PermissionReceipt } from "./card-receipts.ts";
import { outsideReadOf, readRootFor, type Sandbox } from "../sandbox.ts";
import { traceEvent } from "../trace-log.ts";
import "./revdeps.ts";
import { fail, type PreparedCall, type ToolRunResult } from "../tools/types.ts";
import { commandCanVerify } from "../tools/bash.ts";
import { noteKnowledgeEdit, noteKnowledgeVerification } from "../knowledge-service.ts";
import { plainCheckOutcome } from "./verify-tools.ts";
import { nudgeOutboundProxy } from "../net-proxy.ts";
import "../retire.ts";
import { childSpan, runInTrace, traceIterable } from "../trace.ts";
import { bringsExternalContent, buildVerifyNudge, renderRaw, renderTodoReminder, sleep, thinkingOnlyReply, todoReminderDue } from "./loop/checks.ts";
import { profileToolPolicy } from "./profile.ts";
import { attachFootnote, attachPlaybooks, destructiveLabel, mayHaveWritten, noteInvariants, noteToolEdits, noteUnseenChanges, ownRequestText, RETRACT_REASON, RETRACTED_NOTICE, touchesCode, verificationFootnote } from "./loop/evidence.ts";
import { announcesMore, ANSWER_NUDGE, AUDIT_CLOSURE_TOOLS, AUDIT_LIFECYCLE_TOOLS, budgetExhaustedText, budgetNudgeText, budgetStatus, CUTOFF_NUDGE, EMPTY_RESPONSE_KIND, isSilentTool, LENGTH_CONTINUE_NUDGE, looksCutOff, MAX_MEMORY_AUDIT_NUDGES, MAX_VERIFICATION_AUDIT_NUDGES, MEMORY_AUDIT_NUDGE, MIN_OUTPUT_TOKENS, OUTPUT_ROOM_MARGIN, PLAN_SUBMIT_NUDGE, PRECOMPACT_AUDIT_NUDGE, RAN_COMMANDS_CAP, REDUNDANT_AUDIT_MESSAGE, REDUNDANT_AUDIT_TURNS, retryDelayMs, retryScale, type RetryWhy, STEER_PREFIX, UNDECLARED_EVIDENCE_CAP } from "./loop/limits.ts";
import { abortedEvent, byRestart, closeCutTurn, consentText, cutReason, denialsStopText, failureEvent, NOT_STARTED_RESTART, NOT_STARTED_USER_STOP, ranSummary, withLoopCut } from "./loop/outcomes.ts";
import { askOutsideRead, auditPermission, callContext, type PermissionAuditBy } from "./loop/permission-flow.ts";
import { AssistantAssembler } from "./loop/assistant-blocks.ts";
import { noteLoadedTools, prepareCall, refreshShellCwd, runsConcurrently } from "./loop/dispatch.ts";
import { appendPromptContext, applyHookPermission, hookDeniedText, postToolHook, preToolHook, stopHook, userPromptHook } from "../hooks/index.ts";
export { looksCutOff, PLAN_SUBMIT_NUDGE, VERIFY_NUDGE, VERIFY_UNDECLARED_NUDGE, MAX_LENGTH_CONTINUES, LENGTH_CONTINUE_NUDGE, MAX_ANSWER_NUDGES, ANSWER_NUDGE, MAX_CUTOFF_NUDGES, CUTOFF_NUDGE, MEMORY_AUDIT_NUDGE, PRECOMPACT_AUDIT_NUDGE, RETRY_ATTEMPTS, EMPTY_RESPONSE_RETRIES, EMPTY_RESPONSE_KIND, REDUNDANT_AUDIT_TURNS, REDUNDANT_AUDIT_MESSAGE, MAX_PARALLEL_TOOLS, retryDelayMs } from "./loop/limits.ts";
export type { RetryWhy } from "./loop/limits.ts";
export { DENIALS_BEFORE_STOP } from "./loop/outcomes.ts";
export { touchesCode, verificationFootnote } from "./loop/evidence.ts";
export { OUTSIDE_READ_RULE } from "./loop/permission-flow.ts";
export { bringsExternalContent, transcriptReadExternal } from "./loop/checks.ts";

// The agent loop: a while(true) state machine. Streams the model, collects any
// tool calls, executes them (permission-gated), appends results, and repeats
// until the model stops asking for tools. Runs one "task turn" — call again on
// the same state to continue a multi-turn conversation.
export async function* runAgent(
  state: AgentState,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  let turnIndex = 0;
  // A model may emit a complete answer before obeying the MemoryAudit gate.
  // Preserve that answer while the audit-only continuation runs; after a
  // successful audit we move it to the transcript tail and finish without a
  // third model turn that would restate the same answer.
  let pendingPreAuditFinal: Msg | null = null;
  // Once the loop injects an audit nudge, the resulting lifecycle turns are
  // provider-only transcript state. They must not become chat timeline rows.
  let hiddenAuditContinuation = false;
  // #98：审计已经交过之后，连着几轮只交审计生命周期工具（MemoryAudit / Remember / Recall）、一个字不说
  let redundantAuditTurns = 0;
  let auditSettledThisRun = false;
  // 本轮是否已经走过 ExitPlanMode（决定收尾前是否提醒）
  let planSubmitted = false;
  // 用户 hooks：这一轮 Stop hook 已经拦过几次收尾（有上限，见 hooks/points.ts）
  let stopHookBlocks = 0;
  // R6：这一轮（本次 runAgent）实际执行过的工具，失败时写进边界消息。
  const ran = new Map<string, number>();
  // Q3：请求不变量（每次请求的结构 + 本次 run 内 system / tools 稳定）。
  const invariants = new RunInvariants();
  // C4：这一轮的第一次请求前连日期、项目知识、记忆一起对一遍
  let worldRunStart = true;
  // 瘦身 P0-3：用户原话点名了某块（安卓、桌面应用……）——开工前就把那一章给它
  attachPlaybooks(state, playbooksForRequest(ownRequestText(state.messages)), "request");

  while (true) {
    if (signal.aborted) {
      // M8：重启打断在回合边界上（这一轮还没开口）也要留个边界，续聊时模型才知道上面那句没处理完。
      if (byRestart(signal)) closeCutTurn(state, "", cutReason(signal), true);
      yield abortedEvent(signal);
      return;
    }

    // Steering: anything the user said while this run was in flight goes in
    // BEFORE the next provider call, as a normal visible user message. Done here
    // (a turn boundary) rather than mid-stream so the transcript stays a clean
    // alternating conversation and no provider sees a message appear mid-turn.
    const steers = state.takeSteer();
    let steered = 0;
    for (const steer of steers) {
      // 用户 hooks：插话同样过 UserPromptSubmit——拦下就不进对话，退回输入框
      const gate = await userPromptHook(state, steer.text);
      if (gate.blocked) {
        console.warn(`[hooks] 插话被 UserPromptSubmit hook 拦下：${gate.blocked.slice(0, 200)}`);
        yield { e: "steer_returned", texts: [steer.text], ids: [steer.id], reason: gate.blocked.slice(0, 2000) };
        continue;
      }
      steered++;
      state.appendUserBlocks([{ t: "text", text: STEER_PREFIX + steer.text }], false, { origin: "steer", displayText: steer.text });
      yield { e: "steer_applied", text: steer.text, id: steer.id };
      // E3：这条插话是 /技能名——技能正文紧跟在插话后面
      if (steer.attach) {
        state.appendUserBlocks([{ t: "text", text: steer.attach.text }], false, { origin: "harness", kind: steer.attach.kind });
        if (steer.attach.kind !== "slash-command") yield { e: "skill_loaded", name: steer.attach.name, via: "slash", ...(steer.attach.pkg ? { pkg: true } : {}) };
      }
      if (gate.context) appendPromptContext(state, gate.context);
      attachPlaybooks(state, playbooksForRequest(steer.text), "request");
    }
    // 会话协作（session-family.ts）：这一轮跑着时别的会话发来的消息，同在这个回合边界注入（harness 消息，界面上是会话消息卡）
    const familyMsgs = state.takeFamily();
    for (const f of familyMsgs) {
      state.appendUserBlocks([{ t: "text", text: f.text }], false, { origin: "harness", kind: f.kind });
      yield { e: "session_message", kind: f.kind, text: f.text };
    }
    // #78：审计前那句收尾答复是对插话之前的对话说的，插话一进来它就不再是最终答复。以前模型下一轮只交了
    // MemoryAudit，loop 就拿那句旧话收工——插话被注入了，却没人回应（Q1 的严格脚本化测试照出来的）。
    if (steered || familyMsgs.length) pendingPreAuditFinal = null;

    // U3：到线了就先说一声再整理（整段压缩的摘要请求可能要几十秒，以前压完才有一条提示）
    if (contextNeedsTrim(state)) yield { e: "compact_start" };
    const fit = await ensureContextFits(state, signal);
    yield { e: "context", usedTokens: fit.used, limitTokens: fit.limit, compacted: fit.compacted, cacheTtlMs: state.adapter.capabilities.cacheTtlMs ?? 0 };
    // C4：模式、访问范围、GUIDE、技能……变了就追加一条内部片段（system 在会话里不再改写）；压缩之后算，基线跟着重建的 system 走
    state.injectWorldDelta(worldRunStart);
    worldRunStart = false;
    if (fit.auditRequired && !state.preCompactAuditPrompted) {
      state.preCompactAuditPrompted = true;
      state.memoryAuditCompleted = false;
      state.appendUserBlocks([{ t: "text", text: PRECOMPACT_AUDIT_NUDGE }], true, { origin: "harness", kind: "precompact-audit-nudge" });
      hiddenAuditContinuation = true;
    }

    // Budget guardrails: converge nudge once at 80%, final-summary notice once
    // when exhausted (the model then gets one last turn, tools disabled below).
    if (!state.budgetExhausted && (state.deadlineAt !== null || state.maxTurns !== null)) {
      const b = budgetStatus(state);
      if (b.exhausted) {
        state.budgetExhausted = true;
        state.appendUserBlocks([{ t: "text", text: budgetExhaustedText(b) }], false, { origin: "harness", kind: "budget-exhausted" });
      } else if (b.soft && !state.budgetNudged) {
        state.budgetNudged = true;
        state.appendUserBlocks([{ t: "text", text: budgetNudgeText(b) }], false, { origin: "harness", kind: "budget-nudge" });
      }
    }

    let calls: {
      id: string;
      name: string;
      args: Record<string, unknown>;
      argsError?: string;
      argsRaw?: string;
      meta?: Record<string, unknown>;
    }[] = [];
    let text = "";
    let thinkingText = "";
    let blocks = new AssistantAssembler();
    let stop: StopReason = "end";
    let errored = false;
    // Usage reported by the CURRENT attempt. A retried attempt's tokens must not
    // be committed: recording them inline billed every failed 429/5xx try into the
    // session total and inflated the context estimate that decides compaction.
    // Committed once, after the attempt loop settles on a result.
    let attemptUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }[] = [];
    const auditContinuationCandidate = hiddenAuditContinuation;

    // A dropped upstream connection (fetch throw / TLS reset — common when the
    // provider endpoint is reached over a flaky proxy, e.g. Gemini via Google)
    // otherwise kills the whole task, even after most of the work is done. The
    // turn is a pure function of the accumulated state (nothing is committed
    // until appendAssistant below), so a network-level throw is safe to retry:
    // we re-emit turn_start (frontend resets its per-turn cursor) and replay.
    // In-stream provider errors marked retriable (429 rate limit, 5xx
    // overloaded) ride the same retry loop for the same reason.
    const MAX_ATTEMPTS = state.profile.loop.retryAttempts;
    let streamThrew: unknown;
    let errRetriable = false;
    let errMessage = "";
    // 上一次为什么失败（provider 的 Retry-After、是不是限流），决定下一次等多久。
    let retryWhy: RetryWhy = {};
    let errKind = "";
    let errClass = "";
    let errSummary = ""; // U6：分类器给的一句人话（上屏）
    let errCompress = false;
    let reactiveThisTurn = false; // R7：这一轮已经为超窗压过一次
    let imageFitThisTurn = false; // 这一轮已经为「单张图太大」压过一次图
    // R3（#39）：第二本账。零字节的连接失败（和本机模型加载中）不消耗 MAX_ATTEMPTS，等网络 / 模型回来。
    let netWait: NetWait | null = null;
    let waitedForNetwork = false;
    const local = state.adapter.id === "local";
    // Q12：这次模型调用的耗时（含重试退避、等网络）与实际发了几次，随 usage 一起报
    const callStartedAt = Date.now();
    let tries = 0;
    let emptyRetries = 0; // R17（B7）：这次调用因「什么都没回来」重发过几次
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) {
        if (byRestart(signal)) closeCutTurn(state, "", cutReason(signal), true); // M8，同上
        yield abortedEvent(signal);
        return;
      }
      if (attempt > 0 && !waitedForNetwork) {
        const backoff = Math.round(retryDelayMs(attempt, retryWhy) * retryScale());
        retryWhy = {};
        if (state.deadlineAt !== null && Date.now() + backoff >= state.deadlineAt) {
          // 等下去就越过这一轮的截止时间了：不等，带着上一次的错收场（下面照常报）
          const why = `gave up retrying: waiting ${Math.round(backoff / 1000)}s would pass this run's deadline`;
          if (errored) errMessage = `${errMessage} (${why})`;
          else if (streamThrew) streamThrew = new Error(`${(streamThrew as Error).message} (${why})`);
          break;
        }
        // U6：活动行写清楚在等什么、等多久（「被限流，12 秒后第 2 次重试」），不进时间线
        yield {
          e: "context",
          usedTokens: fit.used,
          limitTokens: fit.limit,
          compacted: false,
          retry: attempt,
          retryInMs: backoff,
          ...(errClass ? { retryClass: errClass } : streamThrew ? { retryClass: "network" } : {}),
        };
        await sleep(backoff, signal);
      }
      waitedForNetwork = false;

      calls = [];
      text = "";
      thinkingText = "";
      blocks = new AssistantAssembler();
      stop = "end";
      errored = false;
      attemptUsage = [];
      streamThrew = undefined;
      errRetriable = false;
      errMessage = "";
      errKind = "";
      errClass = "";
      errSummary = "";
      errCompress = false;

      if (!auditContinuationCandidate) yield { e: "turn_start", index: turnIndex };

      let sawEvent = false;
      let waitPlan: WaitPlan | null = null;
      try {
        // 单张图超了模型上限的（目录配的、或上一次报错里读出来的）先压小再拼请求——不然同一张图每次重发都被拒
        await state.fitImagesToLimit();
        const turn = state.toTurn();
        // R9：输入 + 输出上限不能超过窗口（Anthropic、llama.cpp 等会直接拒）——离窗口边缘不远时，按剩下的地方夹住这一次的
        // 输出上限（留一点估算误差，至少给 1024）。本机 qwen 在 98K–118K 之间正是这个区间：还没到主动压缩线，请求已被拒。
        const room = effectiveWindow(state) - contextTokens(state) - OUTPUT_ROOM_MARGIN;
        if (room < turn.budget.maxOutputTokens) turn.budget = { ...turn.budget, maxOutputTokens: Math.max(MIN_OUTPUT_TOKENS, room) };
        noteInvariants(state, invariants, turn);
        // Q4：adapter 在 fetch 前把编码好的请求体交给前缀判定器（纯追加 / 断在哪、为什么）
        // Q12：每次发出是模型 span 里的一步——流的每一步都在 span 里跑，出站拦截器才认得出这是模型请求（加关联头、记元数据）
        tries++;
        const span = childSpan("model", state.adapter.id);
        const stream = runInTrace(span, () => state.adapter.stream(state.prefix.attach(turn, attempt), signal));
        for await (const ev of traceIterable(stream, span)) {
          sawEvent = true;
          if (ev.e !== "error") netWait = null; // 有正经回应了：下一次连接失败重新起算
          switch (ev.e) {
            case "text_delta":
              text += ev.text;
              blocks.text(ev.text);
              if (!auditContinuationCandidate) yield { e: "text_delta", text: ev.text };
              break;
            case "thinking_delta":
              if (ev.text) {
                thinkingText += ev.text;
                if (!auditContinuationCandidate) yield { e: "thinking_delta", text: ev.text };
              }
              blocks.thinking(ev);
              break;
            case "tool_call_begin":
              // U3：模型开始写这个工具调用的参数（活动行不再停在上一个工具的动词上）
              if (!auditContinuationCandidate) yield { e: "tool_call_begin", id: ev.id, name: ev.name, chars: ev.chars };
              break;
            case "tool_call":
              blocks.call();
              calls.push({
                id: ev.id,
                name: ev.name,
                args: ev.args,
                argsError: ev.argsError,
                argsRaw: ev.argsRaw,
                meta: ev.meta,
              });
              break;
            case "usage":
              // Buffered, not committed — this attempt may still be retried.
              attemptUsage.push({
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
                cacheReadTokens: ev.cacheReadTokens,
                cacheWriteTokens: ev.cacheWriteTokens,
              });
              break;
            case "turn_done":
              stop = ev.stopReason;
              break;
            case "notice":
              yield { e: "notice", code: ev.code, cooldownMs: ev.cooldownMs };
              break;
            case "error":
              // Not yielded yet: a retriable error may be retried below, and
              // the frontend treats an error event as terminal.
              errored = true;
              errRetriable = ev.retriable;
              errKind = ev.kind;
              errClass = ev.class ?? "";
              errSummary = ev.summary ?? "";
              errCompress = ev.compress === true;
              // R7：先一句人话（分类器给的），再原始的 kind 与响应体，末尾是上游关联头
              errMessage = `${ev.summary ? `${ev.summary}. ` : ""}${ev.kind}: ${renderRaw(ev.raw)}${ev.upstream ? ` [${ev.upstream}]` : ""}`;
              if (ev.retriable) {
                retryWhy = { retryAfterMs: ev.retryAfterMs, rateLimited: ev.class ? ev.class === "rate_limit" : /429|rate_limit/i.test(ev.kind) };
              }
              break;
          }
        }
        streamThrew = undefined;
        // R17（B7）：流「干净地」结束了，却什么都没带回来（见 EMPTY_RESPONSE_RETRIES）——当作可重试的错重发；次数用完就收场。
        if (!errored && !text.trim() && !thinkingText.trim() && calls.length === 0 && !attemptUsage.some((u) => u.inputTokens > 0 || u.outputTokens > 0)) {
          errored = true;
          errKind = EMPTY_RESPONSE_KIND;
          errMessage = `${EMPTY_RESPONSE_KIND}: the model returned nothing (no text, no tool calls, no usage) — the stream most likely dropped`;
          errSummary = "模型什么都没回（多半是连接中途掉了），重发几次也没回来";
          errRetriable = emptyRetries < state.profile.loop.emptyResponseRetries;
          if (errRetriable) emptyRetries++;
        }
        // 档案 thinkingOnly=retry：只有思考、没有答复也没有工具调用就要收尾——不追问，把这次调用原样重发（与空响应同一份次数）；
        // 次数用完就按这一次的结果往下走
        if (
          !errored &&
          state.profile.loop.thinkingOnly === "retry" &&
          !auditContinuationCandidate &&
          !state.budgetExhausted &&
          thinkingOnlyReply(stop, text, thinkingText, calls.length) &&
          emptyRetries < state.profile.loop.emptyResponseRetries &&
          attempt < MAX_ATTEMPTS - 1
        ) {
          emptyRetries++;
          if (state.ctx.ownerId) traceEvent(state.ctx.ownerId, { e: "thinking_only_retry", thinkingChars: thinkingText.length });
          continue;
        }
        // 本机 llama-server 加载期回 503：等它加载完，不算一次失败。
        // R7：provider 说超窗 / 请求体过大——先压一次再发（每轮最多一次）；上一轮刚为这个压过、这一轮又超，是
        // rapid refill：停下来报错，不在循环里反复压。
        if (errored && errCompress && !text && !calls.length) {
          // 上一轮刚为超窗压过（同一轮里的重复由 reactiveThisTurn 管）
          const refill = !reactiveThisTurn && state.lastReactiveCompactTurn !== null && state.runTurns - state.lastReactiveCompactTurn === 1;
          if (!reactiveThisTurn && !refill) {
            reactiveThisTurn = true;
            state.lastReactiveCompactTurn = state.runTurns;
            if (await compactNow(state, signal)) {
              yield { e: "context", usedTokens: state.lastContextTokens, limitTokens: fit.limit, compacted: true, cacheTtlMs: state.adapter.capabilities.cacheTtlMs ?? 0 };
              attempt--; // 压完重发这一次，不算重试
              continue;
            }
            errMessage += " (tried compacting the context first: nothing left to compact)";
          } else {
            errMessage += refill
              ? " (the context overflowed again right after being compacted; stopping instead of compacting in a loop)"
              : " (still too long after compacting once this turn)";
          }
          // U6：分类器那句是「先压缩再试」——这里已经压过了
          errSummary = "上下文超出了模型窗口，压缩之后仍然放不下：带摘要开一个新会话接着做";
        }
        // 单张图超了上限：从报错里读出上限（读不出就按最大那张的一半），把超的图压小改写进转录后重发（每轮一次，不算重试）。
        // 压完还超、或者根本没有可压的图，就照常报错。
        if (errored && errClass === "image_too_large" && !text && !calls.length) {
          if (!imageFitThisTurn) {
            imageFitThisTurn = true;
            const parsed = parseImageByteLimit(errMessage);
            const largest = state.largestImageBytes();
            if (parsed) state.learnImageLimit(parsed);
            else if (largest) state.learnImageLimit(Math.floor(largest / 2), false);
            if (largest && (await state.fitImagesToLimit())) {
              attempt--; // 压完重发这一次，不算重试
              continue;
            }
          }
          // 分类器那句是「会压小后自动重发」——这里已经压过了，连同报错正文开头那句一起换掉
          const said = errSummary;
          errSummary = "有张图超过了模型的单张上限，压小之后仍然被拒：换一个能收大图的模型，或删掉那张图后再试";
          if (said && errMessage.startsWith(said)) errMessage = errSummary + errMessage.slice(said.length);
          errRetriable = false;
        }
        if (errored && local && !text && !calls.length && isLocalLoadingError(errKind)) {
          waitPlan = await planWait(true, netWait, state.deadlineAt, errMessage.slice(0, 120));
          if (!waitPlan.wait) {
            errMessage = waitPlan.message;
            errRetriable = false;
          }
        }
        if (!waitPlan?.wait) {
          if (errored && errRetriable && attempt < MAX_ATTEMPTS - 1) continue;
          break; // stream drained cleanly (may still carry an `error` event)
        }
      } catch (e) {
        streamThrew = e;
        // Retry only network-level throws; an abort is intentional, stop now.
        if (signal.aborted) {
          closeCutTurn(state, text, cutReason(signal), auditContinuationCandidate);
          yield abortedEvent(signal);
          return;
        }
        if (!sawEvent && isConnectFailure(e)) {
          if (!netWait && !local) nudgeOutboundProxy(); // 首次命中：让出站探测立刻重探，不等 60s 周期
          waitPlan = await planWait(local, netWait, state.deadlineAt, connectErrorLabel(e));
          if (!waitPlan.wait) {
            streamThrew = new Error(waitPlan.message);
            break;
          }
        }
      }
      if (waitPlan?.wait) {
        netWait = waitPlan.state;
        if (!auditContinuationCandidate) {
          yield {
            e: "context",
            usedTokens: fit.used,
            limitTokens: fit.limit,
            compacted: false,
            retry: attempt,
            waiting: waitPlan.kind,
            waitedMs: waitPlan.waitedMs,
          };
        }
        await sleep(waitPlan.delayMs, signal);
        waitedForNetwork = true;
        attempt--; // 这一次不算：for 的 attempt++ 把它补回来
        continue;
      }
    }

    // The attempt loop has settled: commit only the surviving attempt's usage.
    // (A retried attempt's buffer was discarded when the next one reset it.)
    // Deliberately before the streamThrew bail-out — tokens the provider did
    // report for the final attempt were really spent, even if it then failed.
    for (const [i, u] of attemptUsage.entries()) {
      state.recordUsage(u.inputTokens, u.outputTokens, u);
      state.prefix.noteUsage({
        input: u.inputTokens,
        output: u.outputTokens,
        ...(u.cacheReadTokens !== undefined ? { cacheRead: u.cacheReadTokens } : {}),
        ...(u.cacheWriteTokens !== undefined ? { cacheWrite: u.cacheWriteTokens } : {}),
      });
      if (!auditContinuationCandidate) {
        yield {
          e: "usage",
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          totalInputTokens: state.totalInputTokens,
          totalOutputTokens: state.totalOutputTokens,
          ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
          ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
          // Q12：耗时与次数只挂在这次调用的最后一条 usage 上（有的 provider 一次调用报两条，别重复计）
          ...(i === attemptUsage.length - 1 ? { durationMs: Date.now() - callStartedAt, attempts: tries } : {}),
        };
      }
    }

    // 瘦身 P0-2：挂在这次请求末尾的提醒已经送到（重试也都带着它），不留到下一次
    state.dropEphemeralTail();

    if (streamThrew) {
      const message = `stream failed: ${(streamThrew as Error).message}`;
      closeCutTurn(state, text, `this turn ended on an error: ${message.slice(0, 300)}. ${ranSummary(ran)}`, auditContinuationCandidate);
      yield failureEvent(message, false, ran, { class: "network", summary: "和模型的连接断了，重试也没接上" });
      return;
    }

    turnIndex++;
    state.runTurns++;
    if (errored) {
      closeCutTurn(state, text, `this turn ended on an error: ${errMessage.slice(0, 300)}. ${ranSummary(ran)}`, auditContinuationCandidate);
      yield failureEvent(errMessage, errRetriable, ran, { class: errClass, summary: errSummary });
      return;
    }

    const auditLifecycleOnly = calls.every((call) => ["Recall", "Remember", "MemoryAudit"].includes(call.name));
    const internalAuditTurn = auditContinuationCandidate && auditLifecycleOnly;
    if (auditContinuationCandidate && !internalAuditTurn) {
      // A model unexpectedly left the audit lifecycle to do ordinary work.
      // Reveal the buffered turn rather than making real work invisible.
      hiddenAuditContinuation = false;
      pendingPreAuditFinal = null;
      yield { e: "turn_start", index: turnIndex - 1 };
      if (thinkingText) yield { e: "thinking_delta", text: thinkingText };
      if (text) yield { e: "text_delta", text };
    }

    const beforeAssistant = state.messages.length;
    state.appendAssistant({ text, thinkingText, calls, blocks: blocks.build(calls) }, internalAuditTurn);
    const appendedAssistant = state.messages.length > beforeAssistant
      ? state.messages[state.messages.length - 1]
      : null;
    if (stop !== "length") state.lengthContinues = 0;

    // Execute tool calls whenever the model issued any — even under a mislabeled
    // or truncated stop reason (a "length" cut after complete calls still means
    // "run these"; a truncated call rides in with argsError and fails cleanly).
    if (calls.length === 0) {
      // A turn cut off by the output-token limit is not a finished answer.
      // Auto-continue (bounded) instead of silently treating it as done.
      // Not when the budget is spent — the final summary may cut short, but
      // extending a run past its deadline is worse.
      if (stop === "length" && !state.budgetExhausted && state.lengthContinues < state.profile.loop.lengthContinues) {
        // R16：续写之前先看正文——已经退化成循环（宽松档）就不续写：转录里截到循环开始处、补一句标记，这一轮收工
        if (isRunawayRepetition(text, false, state.profile.loop.repetition)) {
          const block = appendedAssistant?.content.find((b) => b.t === "text");
          if (block && block.t === "text") {
            block.text = withLoopCut(text, state.profile.loop.repetition);
            // 正文被思考隔成了几段时，截过的全文已经放进第一段，其余几段去掉（不然后半截重复一遍）
            if (appendedAssistant) appendedAssistant.content = appendedAssistant.content.filter((b) => b.t !== "text" || b === block);
          }
          yield { e: "text_delta", text: `\n\n${LOOP_CUT_NOTICE}` };
          yield { e: "done", stopReason: "end" };
          return;
        }
        state.lengthContinues++;
        state.appendUserBlocks([{ t: "text", text: LENGTH_CONTINUE_NUDGE }], false, { origin: "harness", kind: "length-continue" });
        continue;
      }
      // R19：只有思考、没有答复就要收尾——追一句把答复写出来（追问不进聊天记录）。放在各道门禁之前：门禁审的应当是真正的答复
      if (
        state.profile.loop.thinkingOnly === "nudge" &&
        stop === "end" &&
        !text.trim() &&
        thinkingText.trim() &&
        !internalAuditTurn &&
        !state.budgetExhausted &&
        state.answerNudges < state.profile.loop.maxAnswerNudges
      ) {
        state.answerNudges++;
        // 计数进会话 trace（诊断永不影响主链路：traceEvent 自己吞错）
        if (state.ctx.ownerId) traceEvent(state.ctx.ownerId, { e: "answer_nudge", thinkingChars: thinkingText.length });
        state.appendUserBlocks([{ t: "text", text: ANSWER_NUDGE }], true, { origin: "harness", kind: "answer-nudge" });
        continue;
      }
      if (
        stop === "end" &&
        !internalAuditTurn &&
        !state.budgetExhausted &&
        state.cutoffNudges < state.profile.loop.maxCutoffNudges &&
        looksCutOff(text, state.todos.some((todo) => todo.status !== "completed"))
      ) {
        state.cutoffNudges++;
        if (state.ctx.ownerId) traceEvent(state.ctx.ownerId, { e: "cutoff_nudge", tail: text.trimEnd().slice(-40) });
        state.appendUserBlocks([{ t: "text", text: CUTOFF_NUDGE }], true, { origin: "harness", kind: "cutoff-continue" });
        continue;
      }
      // Done-gate: one structural nudge per user message, on either miss —
      // edits landed but nothing was run at all, OR test files that reference
      // the edited modules were never exercised (the "ran test_concat but not
      // test_combine" regression trap). Skipped once the budget is exhausted.
      // V5：要收尾了——先把影子 git 看到、调用自己没报的改动补进账
      if (stop === "end" && !state.budgetExhausted && !state.verificationGateGaveUp) await noteUnseenChanges(state);
      if (stop === "end" && state.profile.loop.verifyGate === "on" && !state.budgetExhausted && !state.verificationGateGaveUp && touchesCode(state.editedFiles)) {
        const nudge = await buildVerifyNudge(state);
        if (nudge && state.verificationAuditNudges >= MAX_VERIFICATION_AUDIT_NUDGES) {
          // V2（#21）：追问用尽不再报错——以前每一版答复都被撤回，最后只剩一行英文 error，用户在时间线
          // 和历史里一版答复都看不到。现在交付这最后一版，放行其余收尾；最终答复下的「未验证」尾注由
          // verificationFootnote 从账本生成，模型去不掉。
          state.verificationGateGaveUp = true;
        } else if (nudge) {
          state.verificationAuditNudges++;
          // Text has already streamed by the time we can know that the model
          // stopped without satisfying the gate. Retract this provisional
          // turn from every live watcher and hide it from persisted history;
          // it remains in the provider transcript so the model can continue
          // from exactly what it said. V2：撤回时说明原因（客户端显示在活动行）。
          if (appendedAssistant) appendedAssistant.internal = true;
          yield { e: "turn_discard", index: turnIndex - 1, reason: RETRACT_REASON };
          const notice = appendedAssistant && text.trim() ? RETRACTED_NOTICE : "";
          state.appendUserBlocks([{ t: "text", text: nudge + notice }], true, { origin: "harness", kind: "verify-nudge" });
          continue;
        }
      }
      if (
        stop === "end" &&
        !state.budgetExhausted &&
        state.memoryAuditRequired &&
        !state.memoryAuditCompleted
      ) {
        if (!pendingPreAuditFinal && !internalAuditTurn) {
          pendingPreAuditFinal = text.trim() ? appendedAssistant : null;
        }
        state.memoryAuditNudges++;
        if (state.memoryAuditNudges > MAX_MEMORY_AUDIT_NUDGES) {
          // K6（G4）：门禁连败不再杀轮。答复在追问之前就给了（界面上已经看见），以前追问用尽整轮报错，那版答复下面
          // 挂一张红卡、这一轮算失败；现在交付那一版，尾注写明没交审计（本机模型三次不交是常事）。
          // 追问之前一个字都没说的，照旧报错——那确实是没收成尾。
          if (pendingPreAuditFinal && state.messages.includes(pendingPreAuditFinal)) {
            state.memoryAuditGaveUp = true;
            const note = verificationFootnote(state);
            if (note) {
              attachFootnote(state, pendingPreAuditFinal, note);
              state.noteRewrite("audit-closure"); // 尾注补在模型已经看过的答复上：前缀从这条答复断开
              yield { e: "text_delta", text: note };
            }
            yield { e: "done", stopReason: "end" };
            return;
          }
          yield failureEvent("agent did not submit the mandatory MemoryAudit checkpoint", false, ran, {
            summary: "模型几次都没按要求交记忆审计，这一轮没能收尾",
          });
          return;
        }
        state.appendUserBlocks([{ t: "text", text: MEMORY_AUDIT_NUDGE }], true, { origin: "harness", kind: "audit-nudge" });
        hiddenAuditContinuation = true;
        continue;
      }
      // The user said something while this turn was wrapping up. Ending here
      // would drop it on the floor (the frontend has already shown it as sent),
      // so loop once more instead — the drain at the top injects it.
      if (state.hasSteer()) continue;
      // plan 模式下没提交计划就想收尾 → 提醒一次（见 PLAN_SUBMIT_NUDGE）
      if (
        stop === "end" &&
        !state.budgetExhausted &&
        state.permissionMode === "plan" &&
        !planSubmitted &&
        state.planNudges < 1
      ) {
        state.planNudges++;
        state.appendUserBlocks([{ t: "text", text: PLAN_SUBMIT_NUDGE }], true, { origin: "harness", kind: "plan-nudge" });
        continue;
      }
      // 用户 hooks：Stop（子 agent 是 SubagentStop）不让收尾——理由已追加进转录，接着跑一轮
      if (await stopHook(state, text, stopHookBlocks)) {
        stopHookBlocks++;
        continue;
      }
      const note = verificationFootnote(state);
      if (note) {
        attachFootnote(state, appendedAssistant, note);
        yield { e: "text_delta", text: note };
      }
      yield { e: "done", stopReason: stop };
      return;
    }

    // The budget-exhausted final turn: the model was told tools are off. If it
    // called some anyway, keep the transcript valid with explicit failure
    // results (a dangling tool_call breaks the next request), then end the run.
    if (state.budgetExhausted) {
      const skipped: Block[] = [];
      for (const call of calls) {
        const msg = state.loopGuardStopped
          ? "Not executed: the loop guard stopped this run. Give your final summary."
          : state.denialsStopped
            ? `Not executed: ${state.profile.loop.denialsBeforeStop} actions in a row were not approved. Give your final answer.`
            : "Not executed: the run's budget is exhausted. Give your final summary.";
        if (!isSilentTool(call.name)) {
          yield { e: "tool_start", id: call.id, name: call.name, args: call.args };
        }
        skipped.push(toolResult(call.id, false, msg));
        if (!isSilentTool(call.name)) {
          yield {
            e: "tool_end",
            id: call.id,
            name: call.name,
            ok: false,
            summary: state.loopGuardStopped
              ? "skipped (loop guard)"
              : state.denialsStopped
                ? "skipped (not approved repeatedly)"
                : "skipped (budget exhausted)",
            content: [{ t: "text", text: msg }],
          };
        }
      }
      state.appendToolResults(skipped, internalAuditTurn);
      const note = verificationFootnote(state);
      if (note) {
        attachFootnote(state, appendedAssistant, note);
        yield { e: "text_delta", text: note };
      }
      yield { e: "done", stopReason: "end" };
      return;
    }

    // Execute the requested tools, appending results for the next turn.
    // A maximal run of consecutive concurrency-safe calls (pure reads:
    // Read/Grep/Glob/…, read-only Bash commands) executes in parallel, at most
    // MAX_PARALLEL_TOOLS at a time; anything effectful runs serially, in call
    // order. Results always land in call order.
    const results: Block[] = [];
    const feedback: Block[] = [];
    const skills: { name: string; text: string }[] = []; // C5：这一批里加载的技能正文，工具结果之后各追加一条
    // 派发前处理（loop/dispatch.ts）：入参归一、不执行就能回话的情况；Bash 的当前目录在每批开跑前写；并行与否按归一后的入参判
    const dispatched = calls.map((rawCall) => prepareCall(state, rawCall));
    let idx = 0;
    while (idx < calls.length) {
      if (signal.aborted) {
        // R6：已执行批次的结果先落转录，没轮到的明说没执行。
        const notStarted = byRestart(signal) ? NOT_STARTED_RESTART : NOT_STARTED_USER_STOP;
        for (const call of calls.slice(idx)) results.push(toolResult(call.id, false, notStarted));
        state.appendToolResults(results, internalAuditTurn);
        yield abortedEvent(signal);
        return;
      }

      // Bash 的当前目录按这一刻的会话状态写（前一批串行的 cd 已经生效）；判并行也看这一份
      const fresh = (i: number) => (dispatched[i] = refreshShellCwd(state, dispatched[i]));
      let end = idx + 1;
      if (runsConcurrently(state, fresh(idx))) {
        while (end < calls.length && end - idx < state.profile.loop.maxParallelTools && runsConcurrently(state, fresh(end))) end++;
      }
      const batch = calls.slice(idx, end);
      const ready = dispatched.slice(idx, end);
      // 真要执行的不止一个：它们算并行批（Bash 不把 cd 带回会话）
      const parallel = ready.filter((d) => !d.early).length > 1;
      idx = end;

      // R6：有副作用的批次开跑前先落盘（会话接的是立即保存）——进程若在执行中途死掉，转录里至少
      // 留着这些调用，恢复时才能如实说「结果未知」。
      if (state.beforeSideEffects && batch.some((call) => mayHaveSideEffects(call.name, state.toolMap.get(call.name)?.effect))) {
        try {
          await state.beforeSideEffects();
        } catch (e) {
          console.error(`[loop] pre-execution save failed: ${(e as Error).message}`);
        }
      }

      for (const call of batch) {
        if (!internalAuditTurn && !isSilentTool(call.name)) {
          yield { e: "tool_start", id: call.id, name: call.name, args: call.args };
        }
      }

      const outcomes = await Promise.all(
        ready.map(async ({ call: dispatchedCall, early, docs }) => {
          if (early) return { call: dispatchedCall, denied: undefined, res: early };
          // 用户 hooks：PreToolUse 可以拦下、改参数、放行要问人的调用或把放行的转成问人
          const pre = await preToolHook(state, dispatchedCall);
          const call = pre?.call ?? dispatchedCall;
          if (pre?.deny) return { call, denied: pre.deny, res: fail("blocked by a PreToolUse hook", hookDeniedText(pre.deny)) };
          // P11（kimi K20）：出卡之前的规划阶段——注定失败的（硬拒的命令、编不过的工作流）不弹卡、直接回给模型；工具要求
          // 确认的（Workflow 启动）进统一权限闸；卡片上的执行事实优先用工具自己给的。抛错按「没有」处理。
          let prepared: PreparedCall | null = null;
          const prepare = state.toolMap.get(call.name)?.prepare;
          if (prepare) {
            try {
              prepared = await prepare(call.args, callContext(state.ctx, call.id, profileToolPolicy(state.profile)));
            } catch {
              prepared = null;
            }
          }
          if (prepared?.veto) return { call, denied: undefined, res: fail(prepared.veto.summary, prepared.veto.content) };
          // P6：Bash 的写目标 / 提到的路径（路径规则与拒绝台账按它判）；工作区根用来把各种写法的路径归一
          const view = state.toolMap.get(call.name)?.permissionView?.(call.args) ?? null;
          const root = state.ctx.sandbox.root;
          let decision = applyHookPermission(
            decide(
              state.effectiveMode(),
              call.name,
              state.toolMap,
              call.args,
              state.effectiveRules(), // P1：全局规则现读 + 还算数的本会话允许
              { root, denied: state.deniedTargets, ...(prepared?.confirm ? { confirm: prepared.confirm } : {}) },
            ),
            pre,
          );
          // P14：审计记「第一判」和「最后是谁定的」
          const initial = decision;
          let decidedBy: PermissionAuditBy = "rule";
          let scope: string | undefined;
          // A rule wants the user in the loop: block on a permission card. No
          // human attached (sub-agent, headless, test) → deny rather than hang,
          // and say why. P6：没被批准的都记进本 run 的拒绝台账，换工具碰同一个目标还得再问。
          let consentDenied = false;
          // #103：这次调用弹过的卡的回执（策略转问一张、越界只读再一张），随工具结果的 meta 落盘
          const receipts: PermissionReceipt[] = [];
          if (decision.effect === "ask") {
            if (!state.ctx.requestPermission) {
              decision = { effect: "deny", reason: consentText("unattended", decision.reason), rule: decision.rule };
              decidedBy = "unattended";
              consentDenied = true;
            } else {
              const subject = callSubject(call.name, call.args);
              // P5：卡片上显示「本会话都允许」会记下的规则原文，Bash 再给一个已自测的「按前缀允许」
              // S12：控制面文件只能「允许这一次」，不给候选规则
              const choices = decision.noSession ? { exact: [] as string[] } : sessionRuleChoices(call.name, call.args, state.toolMap);
              // P11（ZCode C1 / C2）：卡上写给人看的原因，摆这次真正要执行的东西
              const preview = prepared?.preview ?? approvalPreview(call.name, call.args);
              const req = {
                tool: call.name,
                subject,
                rule: decision.rule,
                sessionRules: choices.exact,
                ...("prefix" in choices && choices.prefix ? { prefixRules: choices.prefix } : {}),
                ...(decision.noSession ? { noSession: true } : {}),
                ...(decision.why ? { why: decision.why } : {}),
                ...(preview ? { preview } : {}),
              };
              const verdict = await state.ctx.requestPermission(req);
              const receipt = permissionReceipt(req, verdict);
              if (receipt) receipts.push(receipt);
              if (verdict.decision === "deny") {
                decision = {
                  effect: "deny",
                  // M3（#27）：用户根本没答（run 先结束了）就不能记成「用户拒绝」。
                  reason: consentText(
                    verdict.timedOut ? "timeout" : verdict.unanswered ? "withdrawn" : verdict.stop ? "denied_stop" : "denied",
                    verdict.note,
                  ),
                  rule: decision.rule,
                };
                // run 先结束了的不记（这一轮到此为止）；离开模式、超时没人批，照样记
                consentDenied = !verdict.unanswered || verdict.away === true || verdict.timedOut === true;
                decidedBy = verdict.timedOut ? "timeout" : verdict.away ? "away" : verdict.unanswered ? "withdrawn" : "user";
                if (verdict.stop) scope = "deny_stop";
              } else {
                // 用户对「刚拒绝过同一目标」又点了允许：这个目标不再算被拒
                if (decision.rule === REPEAT_DENIAL_RULE) state.deniedTargets.release(call.name, call.args, view, root);
                // "session" = don't ask again for this shape of call in this
                // session (an allow rule that outranks the ask rule that fired).
                if (verdict.decision === "session" && !decision.noSession) state.allowForSession(call.name, subject, verdict.rules);
                decision = { effect: "allow", reason: "", rule: decision.rule };
                decidedBy = verdict.away ? "away" : "user";
                scope = verdict.decision === "session" && !initial.noSession ? "session" : "once";
              }
            }
          }
          auditPermission(state, call, initial, decision, decidedBy, scope);
          if (consentDenied) state.deniedTargets.record(call.name, call.args, view, root);
          if (decision.effect === "deny") {
            return {
              call,
              denied: decision.reason,
              consentDenied,
              receipts,
              res: fail(`denied: ${decision.reason}`, `Denied by permission policy: ${decision.reason}`),
            };
          }
          const tool = state.toolMap.get(call.name)!;
          // N26（HT3）：删文件 / 丢弃 git 工作区改动的命令跑之前，给工作区拍一张只有文件的轮内快照——这一轮前面的改动
          // 不会因为一条命令就再也找不回来。这个 agent 上一张之后没写过东西就不拍；拍不成也不拦命令（snapshotFiles 永不抛）。
          if (view?.destroys && state.ctx.snapshotFiles && state.workSeq !== state.snappedAtSeq) {
            state.snappedAtSeq = state.workSeq;
            await state.ctx.snapshotFiles(destructiveLabel(call.args));
          }
          try {
            // Q12：每个工具调用一个子 span（它发的出站请求、落盘的事件据此归到这一轮）
            const span = childSpan("tool", call.name);
            // P13：sandbox 给了就用这个视图跑（「允许这一次」多放行的只读目录只对这一次调用有效）
            const runWith = async (sandbox?: Sandbox): Promise<ToolRunResult> => {
              // callContext 以会话的上下文为原型（readFileState 这些在原型上）——换沙箱也只加一层自有属性，不能展开
              const ctx = callContext(state.ctx, call.id, profileToolPolicy(state.profile));
              if (sandbox) ctx.sandbox = sandbox;
              if (parallel) ctx.parallel = true;
              try {
                return await runInTrace(span, () => tool.run(call.args, ctx));
              } catch (e) {
                // P13：只读越界（沙箱按「工作区外」拒的读）——带上要放行的目录，下面问人
                const outside = outsideReadOf(e);
                if (!outside) throw e;
                return { ...fail("tool error", `${call.name} threw: ${(e as Error).message}`), outsideRead: { dirs: [readRootFor(outside.path)] } };
              }
            };
            let res = await runWith();
            // P13（X18）：只因为读了工作区外被拒，有人在场就问：允许这一次 / 本会话把这些目录设为只读 / 拒绝；批了带放行重跑。
            // 写、凭据、别名这些拒绝不带 outsideRead，永远不问；没人在场（子 agent、无头）照旧直接失败
            if (res.outsideRead?.dirs.length && state.ctx.requestPermission) res = await askOutsideRead(state, call, res, runWith, receipts);
            // 没加载说明就直接执行了的推迟工具：结果后面附上这一族的完整说明
            if (docs?.length && state.ctx.deferredTools) res = withDeferredDocs(res, docs, state.ctx.deferredTools);
            res = await postToolHook(state, call, res, pre);
            return { call, denied: undefined, invoked: true, receipts, res };
          } catch (e) {
            return { call, denied: undefined, invoked: true, receipts, res: fail("tool error", `${call.name} threw: ${(e as Error).message}`) };
          }
        }),
      );

      for (const outcome of outcomes) {
        const { call, denied, res } = outcome;
        if (denied) {
          if (!internalAuditTurn && !isSilentTool(call.name)) {
            yield { e: "tool_permission", id: call.id, name: call.name, decision: "deny", reason: denied };
          }
        }
        if ("invoked" in outcome) ran.set(call.name, (ran.get(call.name) ?? 0) + 1);
        // P6：连续没被批准的次数；真跑了一个就清零
        if ("consentDenied" in outcome && outcome.consentDenied) state.consecutiveDenials++;
        else if ("invoked" in outcome) state.consecutiveDenials = 0;
        // U8（K36）：工具行第二行的结果随落盘的 meta 走，历史里重建工具行也有；#103：弹过的卡的回执同样
        const receipts = "receipts" in outcome ? outcome.receipts : undefined;
        const meta = {
          ...(res.meta ?? {}),
          ...(res.outcome ? { outcome: res.outcome } : {}),
          ...(receipts?.length ? { permissions: receipts } : {}),
        };
        results.push(toolResult(call.id, res.ok, res.content, Object.keys(meta).length ? meta : undefined));
        noteLoadedTools(state, res);
        if (!internalAuditTurn && !isSilentTool(call.name)) {
          yield {
            e: "tool_end",
            id: call.id,
            name: call.name,
            ok: res.ok,
            summary: res.summary,
            content: res.content,
            ...(res.outcome ? { outcome: res.outcome } : {}),
          };
        }

        if (call.name === "ExitPlanMode") planSubmitted = true;
        if (res.ok && call.name !== "MemoryAudit" && call.name !== "VerificationAudit") {
          state.noteActivityAfterAudit();
        }
        // V5（#20）：Edit/Write 之外改过的文件也进门禁的账——coder 子 agent / Workflow 报上来的，Bash 命令明确写的
        // （重定向、tee、sed -i、cp / mv 的落点……）。排在记验证结果之前：`npm test > out.log` 自己写的日志不能
        // 把自己刚交的验证作废。
        if ("invoked" in outcome) noteToolEdits(state, call, res);
        if ("invoked" in outcome && mayHaveWritten(state, call)) state.workSeq++; // N26
        if (res.verification) {
          state.recordVerification(res.verification.passed, res.verification.detail);
          try {
            // M12：发给知识 worker 追加（与重建串行，不在主线程上扫描工作区）
            noteKnowledgeVerification(state.ctx.sandbox.root, {
              tool: call.name,
              passed: res.verification.passed,
              detail: res.verification.detail,
              command: call.name === "Bash" ? String(call.args.command ?? "") : undefined,
              editedPaths: [...state.editedFiles],
            });
          } catch (error) {
            console.error(`[knowledge] verification record: ${(error as Error).message}`);
          }
        } else if (state.profile.tools.verifyTools === "off" && "invoked" in outcome) {
          // 工具不带 verify 的姿态：一次跑完的测试 / 构建照样记进项目知识的验证历史（不进门禁，agent/verify-tools.ts）
          const check = plainCheckOutcome(call, res);
          if (check) {
            try {
              noteKnowledgeVerification(state.ctx.sandbox.root, { tool: call.name, ...check, command: String(call.args.command ?? ""), editedPaths: [...state.editedFiles] });
            } catch (error) {
              console.error(`[knowledge] verification record: ${(error as Error).message}`);
            }
          }
        }

        if (res.feedback) feedback.push(...res.feedback);
        if (res.skill && !skills.some((s) => s.name === res.skill!.name)) skills.push(res.skill);
        if (bringsExternalContent(call, res, "invoked" in outcome)) state.externalContentSeen = true; // K9（X55）
        if (res.events && !internalAuditTurn) {
          for (const side of res.events) yield side;
        }
        if (call.name === "TodoWrite") {
          state.turnsSinceTodoSeen = -1; // seen this turn; the ++ below lands on 0
          yield { e: "todo", items: state.todos };
        }
        // V3（#33）：没落地的编辑按路径记账，同一路径之后编辑成功就销账。
        if (call.name === "Edit" || call.name === "Write") {
          const raw = String(call.args.path ?? call.args.file ?? "");
          let key = raw;
          let display = raw;
          try {
            key = state.ctx.sandbox.resolve(raw);
            display = state.ctx.sandbox.rel(key);
          } catch {
            /* 路径本身不合法：按原样记 */
          }
          if (res.ok) state.failedEdits.delete(key);
          else if (raw) state.failedEdits.set(key, { display, reason: denied ? `被拒：${denied}` : res.summary });
        }
        // Done-gate bookkeeping: edits dirty the tree, running something clears it.
        if ((call.name === "Edit" || call.name === "Write") && res.ok) {
          state.recordMutation();
          try {
            const edited = state.ctx.sandbox.resolve(String(call.args.path));
            state.editedFiles.add(edited);
            noteKnowledgeEdit(state.ctx.sandbox.root);
          } catch {
            // path resolved fine inside the tool; a throw here is cosmetic
          }
        }
        for (const created of res.createdFiles ?? []) {
          try { state.createdFiles.add(state.ctx.sandbox.resolve(created)); } catch { /* cosmetic metadata */ }
        }
        if (call.name === "Bash") {
          const cmd = String(call.args.command ?? "");
          if (call.args.kill) {
            // Killing a job neither verifies nor runs anything.
          } else if (call.args.poll || call.args.wait) {
            // The Bash tool emits evidence only once a requested verification
            // job has actually completed; a running poll (or a wait that timed out) proves nothing yet.
          } else if (call.args.background && cmd) {
            // The command will run (counts for revdep coverage), but merely
            // STARTING it verifies nothing — polling its output does.
            state.ranCommands.push(cmd);
            if (state.ranCommands.length > RAN_COMMANDS_CAP) state.ranCommands.shift();
          } else if (cmd && commandCanVerify(cmd)) {
            // Read-only commands (git status/diff, ls, cat …) verify nothing:
            // they neither clear the dirty flag nor count as having "run" a
            // test file for the revdep scan (cat-ing a test isn't running it).
            state.ranCommands.push(cmd);
            if (state.ranCommands.length > RAN_COMMANDS_CAP) state.ranCommands.shift();
            // Succeeded after an edit and looks like a real check, but was never
            // declared with verify:true. Still not evidence — but the nudge can
            // now say "you didn't declare it" instead of "you didn't verify".
            if (res.ok && !res.verification && state.dirtySinceVerify) {
              state.undeclaredEvidence.push(cmd);
              if (state.undeclaredEvidence.length > UNDECLARED_EVIDENCE_CAP) state.undeclaredEvidence.shift();
            }
          }
        }
      }
    }

    // R15：分级重复熔断——按调用顺序喂给护栏；提醒追加在这次调用结果的末尾。熔断只在无人值守时真停（收尾轮：工具不再执行、
    // 给最终总结），有人在场只留提醒（#71）。审计收尾轮与静默工具不计。
    let guardStop: string | undefined;
    if (!internalAuditTurn) {
      for (const call of calls) {
        if (isSilentTool(call.name)) continue;
        const block = results.find((b) => b.t === "tool_result" && b.id === call.id);
        if (!block || block.t !== "tool_result") continue;
        const verdict = state.loopGuard.observe(call.name, call.args, block.ok);
        if (verdict.note) block.content = [...block.content, { t: "text", text: verdict.note }];
        if (verdict.stop && !guardStop && (state.profile.loop.stopWhenAttended || state.ctx.humanAttended?.() === false)) guardStop = verdict.stop;
      }
    }

    state.appendToolResults(results, internalAuditTurn);
    if (guardStop) {
      state.budgetExhausted = true;
      state.loopGuardStopped = true;
      state.appendUserBlocks([{ t: "text", text: loopStopText(guardStop) }], true, { origin: "harness", kind: "loop-guard" });
    } else if (state.consecutiveDenials >= state.profile.loop.denialsBeforeStop && !state.budgetExhausted) {
      // P6（N16）：连着几次都没被批准，再试下去只是换着花样碰同一堵墙——收尾轮交代清楚，由人决定
      state.budgetExhausted = true;
      state.denialsStopped = true;
      state.appendUserBlocks([{ t: "text", text: denialsStopText(state.profile.loop.denialsBeforeStop) }], true, { origin: "harness", kind: "permission-stop" });
    }
    const auditOnly = calls.length > 0 && calls.every((call) => call.name === "MemoryAudit");
    if (pendingPreAuditFinal && auditOnly && state.memoryAuditCompleted) {
      if (state.messages.includes(pendingPreAuditFinal)) {
        // #79：答复留在原位。以前收工前把它挪到转录末尾，下一条消息的首个请求就在它原来的位置分叉；审计追问、
        // 审计调用与结果都是 internal，聊天记录里看不到，产物卡按「最后一条非 internal、有正文的 assistant」找，
        // 不挪也一样。
        const note = verificationFootnote(state);
        if (note) {
          attachFootnote(state, pendingPreAuditFinal, note);
          state.noteRewrite("audit-closure"); // 尾注补在模型已经看过的答复上：前缀从这条答复断开
          yield { e: "text_delta", text: note };
        }
        yield { e: "done", stopReason: "end" };
        return;
      }
      pendingPreAuditFinal = null;
    }
    // The symmetric shape: the model batched its complete answer AND the
    // mandatory checkpoint into ONE turn (k3 does this on a plain question).
    // The answer already streamed and the audit gate is closed, so handing the
    // tool result back buys nothing but a turn that restates what was just said
    // ("答案如上：…"). Finish on this turn instead.
    // Guards: a "length" cut is not a finished answer; a failed checkpoint or a
    // Remember that landed after it leaves memoryAuditCompleted false; tool
    // images (feedback) are input the model has not seen yet; and the
    // verification gate keeps priority — with a dirty tree and no passing
    // evidence, fall through so the done-gate can still nudge.
    // Two more guards, both learned the hard way (2026-08-20, k3): the run died
    // on "全部断言通过。执行强制审计收尾：" + MemoryAudit with a todo still
    // in_progress, because that text passed the "answer already streamed" test.
    // An open todo list is the model's own statement that work remains, and a
    // line ending in a colon is announcing what comes next — neither is a
    // finished reply. Being wrong here truncates the run; being too strict only
    // costs one cheap turn, so bias strict.
    if (
      !internalAuditTurn &&
      stop !== "length" &&
      text.trim() !== "" &&
      !announcesMore(text) &&
      !state.todos.some((todo) => todo.status !== "completed") &&
      // A steer waiting to be delivered means the conversation is not over.
      !state.hasSteer() &&
      state.memoryAuditCompleted &&
      feedback.length === 0 &&
      skills.length === 0 &&
      calls.some((call) => call.name === "MemoryAudit") &&
      calls.every((call) => AUDIT_CLOSURE_TOOLS.has(call.name)) &&
      results.every((block) => block.t === "tool_result" && block.ok) &&
      !(state.profile.loop.verifyGate === "on" && !state.verificationGateGaveUp && touchesCode(state.editedFiles) && (await buildVerifyNudge(state)))
    ) {
      // Why the run stopped is otherwise invisible from both sides of the wire
      // (the agent cannot tell "controller finished me" from "stream died").
      console.log("[loop] finished on the audit-closure turn (answer + MemoryAudit batched)");
      const note = verificationFootnote(state);
      if (note) {
        attachFootnote(state, appendedAssistant, note);
        yield { e: "text_delta", text: note };
      }
      yield { e: "done", stopReason: "end" };
      return;
    }
    // #98：审计已经落定，模型还一轮接一轮地只交审计（不说话、不干活）——本机模型卡住时会这样；用户在界面上只看到活动行一直是
    // 「记忆审计」（这些轮都是 internal），重复熔断在有人在场时又只提醒不停，一跑就是几千轮。审计本身早就交了，
    // 连着超过 REDUNDANT_AUDIT_TURNS 轮就收工（交成审计的那一轮也算在内——交完之后模型本来就该接着说话）。
    // 「落定过」按这一轮里交成过一次算：Remember 落在审计之后会把 memoryAuditCompleted 拨回 false，Remember / MemoryAudit
    // 交替着转圈也得算进来。
    if (state.memoryAuditCompleted) auditSettledThisRun = true;
    if (calls.length && calls.every((call) => AUDIT_LIFECYCLE_TOOLS.has(call.name)) && !text.trim() && auditSettledThisRun) {
      if (++redundantAuditTurns > REDUNDANT_AUDIT_TURNS) {
        console.warn(`[loop] stopped after ${redundantAuditTurns} audit-only turns with the audit already completed`);
        // 转录里也如实记一笔（模型下一轮看得到为什么上一轮停了；界面上只显示错误卡）
        state.appendUserBlocks([{ t: "text", text: `[Loop guard] ${REDUNDANT_AUDIT_MESSAGE}.` }], true, { origin: "harness", kind: "loop-guard" });
        yield failureEvent(REDUNDANT_AUDIT_MESSAGE, false, ran, { summary: "模型反复交审计、不干正事，已经让它停下" });
        return;
      }
    } else {
      redundantAuditTurns = 0;
    }
    if (state.memoryAuditCompleted && calls.some((call) => call.name === "MemoryAudit")) {
      hiddenAuditContinuation = false;
    }
    if (pendingPreAuditFinal && calls.some((call) => !["Recall", "Remember", "MemoryAudit"].includes(call.name))) {
      pendingPreAuditFinal = null;
    }
    // Images from tools ride in a follow-up user message (tool-role can't carry
    // them). Prepend a text label so the model knows what it's looking at.
    // R12：工具图进转录之前先降采样（长边 2000px；Read 的 fullRes:true 除外）
    if (feedback.length) {
      state.appendUserBlocks([
        { t: "text", text: "Attachment(s) from the previous tool call:" },
        ...(await Promise.all(feedback.map((block) => downsampleForModel(block, state.imageByteLimit())))),
      ], false, { origin: "harness", kind: "tool-attachments" });
    }
    // C5（K57）：技能正文不放 tool_result（微压缩只清旧工具输出），紧随其后作为一条 harness 消息
    for (const skill of skills) {
      state.appendUserBlocks([{ t: "text", text: skill.text }], false, { origin: "harness", kind: "skill" });
    }
    // 瘦身 P0-3：这一轮的调用碰到了某块（写了网页文件、起了 Preview、跑了 adb……）——那一章紧跟在结果后面
    attachPlaybooks(state, playbooksForCalls(calls), "work");
    // 读 / 改到的文件所在的子目录有自己的 AGENTS.md / CLAUDE.md、这个会话还没加载过：紧跟在后面
    attachProjectDocs(state, calls, results);

    // The plan drifts out of the model's attention over a long run (and dies in
    // a compaction). Periodically re-show the current todo list — on the next
    // request only (瘦身 P0-2: not persisted, so stale copies never pile up).
    state.turnsSinceTodoSeen++;
    if (todoReminderDue(state)) {
      state.turnsSinceTodoSeen = 0;
      state.ephemeralTail = renderTodoReminder(state.todos);
    }
  }
}
