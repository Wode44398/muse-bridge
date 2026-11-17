// 阻塞交互：问答、权限、计划三种卡片的挂起与落定。
import { randomUUID } from "node:crypto";
import type { AskAnswer, AskQuestion, DecidedBy } from "../agent/events.ts";
import { sessionAllowRule } from "../agent/permissions.ts";
import type { ApprovalPreview, AskQuestionSpec, AskResolution, AskResolvedAnswer } from "../tools/types.ts";
import { fanout, noteSessionStatus, permissionAskEvent } from "./events.ts";
import { stopSession } from "./lifecycle.ts";
import { awayApproves, isAway } from "./switches.ts";
import type { PendingPermission, PermissionVerdict, PlanVerdict, Session } from "./types.ts";

// ── AskUserQuestion (human-in-the-loop) ──────────────────────────────────────

// Register a blocked question and return the promise the tool awaits. Resolves
// when answerAsk lands, or (cancelled) when the run is aborted.
// ── P7（A8b、X62；#6）：阻塞交互的倒计时兜底 ───────────────────────────────────
// 忘了开离开模式时，一张没人看的卡会让这一轮永远挂着（还占着并发名额）。到点按各自的方式落定：提问按合理假设继续
// （X62：只有 plan 档的提问值得久等——等一小时；auto 档等 10 分钟）；权限卡按拒绝处理（fail-closed）；计划等一小时，
// 没人审就保持 plan、以计划收尾。hermes #32762 的教训：超时太短会在人还在想的时候把卡清掉，所以都不少于 10 分钟。
// 卡片带着 deadlineAt，界面照着显示「几点前没人答会怎样」。DIMENSIO_INTERACTION_TIMEOUT_SCALE 只给测试把时间缩短。
const INTERACTION_TIMEOUT_MIN = { ask: 10, askPlan: 60, permission: 10, plan: 60 } as const;

function interactionTimeout(kind: keyof typeof INTERACTION_TIMEOUT_MIN): { ms: number; minutes: number; deadlineAt: number } {
  const minutes = INTERACTION_TIMEOUT_MIN[kind];
  const raw = Number(process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE ?? "1");
  const scale = Number.isFinite(raw) && raw > 0 ? raw : 1;
  const ms = Math.max(1, Math.round(minutes * 60_000 * scale));
  return { ms, minutes, deadlineAt: Date.now() + ms };
}

export function registerAsk(
  session: Session,
  questions: AskQuestionSpec[],
  signal: AbortSignal,
  callId?: string,
): Promise<AskResolution> {
  // P3：离开模式——不弹卡，立即落定（工具会叫模型按合理默认继续并写明假设）。
  if (isAway(session)) return Promise.resolve({ cancelled: true, answers: [], away: true });
  // M1（#26）：卡片 id 就用这次调用的 tool_call id——手机重连后从记录重建出的卡（id 取自转录）也能作答，
  // 以前另铸一个 UUID，重建卡的回答一律被当成「已失效」静默吞掉，这一轮永久挂起。
  const askId = callId && !session.pendingAsks.has(callId) ? callId : randomUUID();
  const payload: AskQuestion[] = questions.map((q, i) => ({
    id: `${askId}:${i}`,
    header: q.header,
    question: q.question,
    multiSelect: q.multiSelect,
    options: q.options,
  }));
  const limit = interactionTimeout(session.state?.effectiveMode() === "plan" ? "askPlan" : "ask");
  return new Promise<AskResolution>((resolve) => {
    const finish = (r: AskResolution) => {
      if (!session.pendingAsks.delete(askId)) return; // already resolved
      noteSessionStatus(session);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // M1：不是用户答的（停止 / run 结束 / P7 超时），告诉所有设备这张卡作废了。
      if (r.cancelled) fanout(session, { e: "ask_cancelled", id: askId, ...(r.timedOut ? { reason: "timeout" } : {}) });
      resolve(r);
    };
    const onAbort = () => finish({ cancelled: true, answers: [] });
    const timer = setTimeout(() => finish({ cancelled: true, answers: [], timedOut: true, timeoutMin: limit.minutes }), limit.ms);
    timer.unref?.();
    session.pendingAsks.set(askId, { resolve: finish, questions, payload, deadlineAt: limit.deadlineAt, since: Date.now() });
    fanout(session, { e: "ask", id: askId, questions: payload, deadlineAt: limit.deadlineAt });
    noteSessionStatus(session);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Coerce the raw wire answers (one entry per question, in order) into both the
// tool-facing resolution and the event-facing shape.
function normalizeAskAnswers(
  questions: AskQuestionSpec[],
  raw: unknown,
  askId: string,
): { resolved: AskResolvedAnswer[]; wire: AskAnswer[] } {
  const arr = Array.isArray(raw) ? raw : [];
  const resolved: AskResolvedAnswer[] = [];
  const wire: AskAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = (arr[i] ?? {}) as Record<string, unknown>;
    let selected = Array.isArray(a.selected)
      ? a.selected.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const custom = Boolean(a.custom);
    if (!q.multiSelect && selected.length > 1) selected = selected.slice(0, 1);
    resolved.push({ header: q.header, selected, custom });
    wire.push({ questionId: `${askId}:${i}`, selected, custom });
  }
  return { resolved, wire };
}


// ── 细粒度权限的问询（规则判定 ask）─────────────────────────────────────────
// 与 registerAsk 同构：事件 fanout 给所有设备（断线重连能从 runLog 重放），
// POST /permission 落定；run 被 abort 则按拒绝收尾，绝不悬着。
export function registerPermission(
  session: Session,
  req: {
    tool: string;
    subject: string;
    rule?: string;
    sessionKey?: string;
    sessionRules?: string[];
    prefixRules?: string[];
    noSession?: boolean;
    why?: string;
    preview?: ApprovalPreview;
  },
  signal: AbortSignal,
): Promise<PermissionVerdict> {
  // P1（#48）：工具自己弹的确认卡（Workflow）以前点「本会话都允许」毫无作用——没有人记账，下一次照样弹。
  // 现在由会话记：此前允许过（且模式 / 访问范围 / 规则都没变）就直接放行，不再弹卡。
  const state = session.state;
  if (req.sessionKey !== undefined && state?.isSessionAllowed(req.tool, req.sessionKey)) {
    return Promise.resolve({ decision: "session" });
  }
  // P3：离开模式——没人能批准。默认立即拒绝并注明「未经批准」（安全偏向拒）；
  // 设置 › 对话 › 离开模式下的批准请求 = 默认同意时，按「允许一次」放行（away 标记照留，审计记为离开模式放行）。
  if (isAway(session) && awayApproves()) return Promise.resolve({ decision: "once", away: true });
  if (isAway(session)) {
    return Promise.resolve({
      decision: "deny",
      // P6：以前说「skip this step or find another way」——等于教模型绕开没人批的那一步
      note: "the user is away (away mode is on), so nobody could approve it — skip this step (do not try to get the same effect another way) and mention it in your final answer",
      unanswered: true,
      away: true,
    });
  }
  const id = randomUUID();
  const limit = interactionTimeout("permission");
  return new Promise<PermissionVerdict>((resolve) => {
    const finish = (r: PermissionVerdict) => {
      if (!session.pendingPermissions.delete(id)) return; // 已落定
      noteSessionStatus(session);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (r.unanswered) fanout(session, { e: "permission_cancelled", id, ...(r.timedOut ? { reason: "timeout" } : {}) }); // M1
      if (r.decision === "session" && req.sessionKey !== undefined) state?.allowForSession(req.tool, req.sessionKey);
      resolve({ ...r, card: id }); // #103
    };
    // M3（#27）：用户点停止时卡片还没答——是「没答」，不是「拒绝」。
    const onAbort = () => finish({ decision: "deny", note: "the run was stopped before the user answered", unanswered: true });
    // P7：倒计时到了没人批——按拒绝处理（fail-closed），同样不是用户拒绝
    const timer = setTimeout(
      () => finish({ decision: "deny", note: `nobody answered within ${limit.minutes} minutes`, unanswered: true, timedOut: true }),
      limit.ms,
    );
    timer.unref?.();
    // P5：卡片照原样显示「本会话都允许」会记下的规则；工具自己弹的卡（Workflow）记的是 sessionKey 那条
    const pending: PendingPermission = {
      resolve: finish,
      tool: req.tool,
      subject: req.subject,
      since: Date.now(),
      deadlineAt: limit.deadlineAt,
      ...(req.rule ? { rule: req.rule } : {}),
      ...(req.why ? { why: req.why } : {}),
      ...(req.preview ? { preview: req.preview } : {}),
      ...(req.noSession
        ? { sessionRules: [], noSession: true }
        : {
            sessionRules: req.sessionRules?.length ? req.sessionRules : [sessionAllowRule(req.tool, req.sessionKey ?? req.subject)],
            ...(req.sessionKey === undefined && req.prefixRules?.length ? { prefixRules: req.prefixRules } : {}),
          }),
    };
    session.pendingPermissions.set(id, pending);
    fanout(session, permissionAskEvent(id, pending));
    noteSessionStatus(session);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

// P10（D9）：落定请求里客户端自报的设备（id 与标签）——格式不对就当没带，标签只留可见字符、截短
const DECIDED_BY_ID = /^[A-Za-z0-9_-]{6,80}$/;
export function decidedBy(raw: unknown): DecidedBy | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !DECIDED_BY_ID.test(r.id)) return undefined;
  const label = typeof r.label === "string" ? r.label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 16) : "";
  return { id: r.id, label: label || "另一台设备" };
}

// scope："prefix" = 用户在卡片上选了「按前缀允许」。要记下的规则只取服务端当初算好的候选，客户端传不进规则原文。
// P6：decision "deny_stop" = 拒绝并停止（Codex 的 Cancel → Abort）：拒掉这次调用，同时停下这一轮——手机上一次点完，
// 不再有「点了拒绝、还没找到停止键」那段空窗让模型换条路再试一次。
// P10：by = 在哪台设备上定的；拒绝时的附言（N43：输入框里的话落到卡上）一并广播，别的设备的回执也看得见
export function resolvePermission(
  session: Session,
  id: string,
  decision: unknown,
  note?: unknown,
  scope?: unknown,
  by?: DecidedBy,
): boolean {
  const pending = session.pendingPermissions.get(id);
  if (!pending) return false;
  const stop = decision === "deny_stop";
  // S12：控制面文件的卡只能「允许这一次」——客户端回传 session 也按 once 算，不记规则
  const d = decision === "session" ? (pending.noSession ? "once" : "session") : decision === "once" ? "once" : "deny";
  const prefix = d === "session" && scope === "prefix" && Boolean(pending.prefixRules?.length);
  const deniedNote = d === "deny" && typeof note === "string" && note.trim() ? note.trim() : undefined;
  fanout(session, {
    e: "permission_resolved",
    id,
    decision: stop ? "deny_stop" : d,
    ...(prefix ? { scope: "prefix" } : {}),
    ...(by ? { by } : {}),
    ...(deniedNote ? { note: deniedNote } : {}),
  });
  pending.resolve({
    decision: d,
    note: typeof note === "string" ? note : undefined,
    ...(d === "session" ? { rules: prefix ? pending.prefixRules : pending.sessionRules } : {}),
    ...(stop ? { stop: true } : {}),
    ...(by ? { by } : {}),
    ...(prefix ? { prefix: true } : {}),
  });
  if (stop) stopSession(session.id);
  return true;
}

// ── Plan mode 的批准 ────────────────────────────────────────────────────────
export function registerPlan(
  session: Session,
  plan: string,
  signal: AbortSignal,
): Promise<PlanVerdict> {
  // P3：离开模式——默认计划保持未批准，本轮结束并留言（自动批准不等于用户同意开工）；
  // 用户在设置里选了「默认同意」才直接批准：和点了批准一样切到自主执行、同一轮接着做。
  if (isAway(session) && awayApproves()) {
    session.state?.setPermissionMode("auto");
    return Promise.resolve({ approved: true, away: true });
  }
  if (isAway(session)) return Promise.resolve({ approved: false, note: "the user is away", unanswered: true, away: true });
  const id = randomUUID();
  const limit = interactionTimeout("plan");
  return new Promise<PlanVerdict>((resolve) => {
    const finish = (r: PlanVerdict) => {
      if (!session.pendingPlans.delete(id)) return;
      noteSessionStatus(session);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (r.unanswered) fanout(session, { e: "plan_cancelled", id, ...(r.timedOut ? { reason: "timeout" } : {}) }); // M1
      resolve({ ...r, card: id }); // #103
    };
    const onAbort = () => finish({ approved: false, note: "run stopped", unanswered: true });
    // P7：倒计时到了没人审——保持 plan、以计划收尾（与离开模式同一个出口：没审过的计划不能当成批准）
    const timer = setTimeout(
      () => finish({ approved: false, note: "nobody reviewed it in time", unanswered: true, timedOut: true, timeoutMin: limit.minutes }),
      limit.ms,
    );
    timer.unref?.();
    session.pendingPlans.set(id, { resolve: finish, plan, deadlineAt: limit.deadlineAt, since: Date.now() });
    fanout(session, { e: "plan_ask", id, plan, deadlineAt: limit.deadlineAt });
    noteSessionStatus(session);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

// 批准 = 本会话切到 auto：同一轮里继续执行这份计划（这正是 plan mode 的意义，
// 否则用户得改设置再重新提问）。模式落盘 + 广播，所有设备的指示器同步。
export function resolvePlan(
  session: Session,
  id: string,
  approved: boolean,
  note?: unknown,
  handoff = false,
  by?: DecidedBy,
): boolean {
  const pending = session.pendingPlans.get(id);
  if (!pending) return false;
  const cleanNote = typeof note === "string" && note.trim() ? note.trim() : undefined;
  if (approved && session.state) session.state.setPermissionMode("auto");
  // C8：交给新会话实施的，这边不批准、不退回——卡片落定为「已转到新会话实施」
  fanout(session, {
    e: "plan_resolved",
    id,
    approved,
    ...(cleanNote ? { note: cleanNote } : {}),
    ...(handoff ? { handoff: true } : {}),
    ...(by ? { by } : {}),
  });
  pending.resolve({ approved, note: cleanNote, ...(handoff ? { handoff: true } : {}), ...(by ? { by } : {}) });
  return true;
}

// Answer a pending question (from POST /answer). Returns false when the askId is
// unknown or already answered — the endpoint reports that so a stale/double
// submit is a no-op rather than an error.
export function answerAsk(session: Session, askId: string, rawAnswers: unknown, by?: DecidedBy): boolean {
  const pending = session.pendingAsks.get(askId);
  if (!pending) return false;
  const { resolved, wire } = normalizeAskAnswers(pending.questions, rawAnswers, askId);
  // Fan out so mirrors + the originating stream see the resolution (and
  // reconnects replay it from runLog), then unblock the waiting tool.
  // P10（D9）：by = 在哪台设备上答的
  fanout(session, { e: "ask_answer", id: askId, answers: wire, ...(by ? { by } : {}) });
  pending.resolve({ cancelled: false, answers: resolved });
  return true;
}
