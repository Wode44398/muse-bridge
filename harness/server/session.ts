// 会话的运行与状态。实现按职责分在 session/ 下；对外的名字仍从这里引。
import "./session/load-order.ts";

export type { Session, PermissionVerdict, PendingPermission, PlanVerdict } from "./session/types.ts";
export { watchSession, pendingInteractions, mirrorBaseCount, waitingOf, watchGlobal, emitGlobal, noteListChanged, runTiming, stampRunTiming, noteSessionStatus, pendingSummary } from "./session/events.ts";
export type { WaitingKind, WaitingInfo } from "./session/events.ts";
export { workspaceRoot, sessionWorkspace, readGuide } from "./session/workspace.ts";
export { createSession, getSession, liveSessionMetas, anySessionRunning, runningRuns, drainSessions, stopSession, sweepOrphanResources, evictIdleSessions, touchSession, dropSession, lifecycle, rollbackInProgress, deleteSession } from "./session/lifecycle.ts";
export type { StopReport } from "./session/lifecycle.ts";
export { sessionUsage } from "./session/build-state.ts";
export { isAway, awayApproves, setSessionAway, revokeReadRoot, setSessionMode, setSessionAccess, setSessionModel } from "./session/switches.ts";
export { recordFp, sessionRecord, persistNow, getOrLoadSession } from "./session/persist.ts";
export { rollbackSession, PRE_ROLLBACK_LABEL, PRE_REWIND_LABEL, REWIND_KIND, locateRewind, rewindSession, PRE_RESTORE_LABEL, RESTORE_KIND, sessionReview, sessionReviewDiff, restoreSessionFiles, undoRewind } from "./session/history.ts";
export type { RewindResult, SessionReview, RestoreResult } from "./session/history.ts";
export { goalAction } from "./session/goal-run.ts";
export type { GoalAction, GoalActionResult } from "./session/goal-run.ts";
export { RESUME_KIND, RESUME_STOPPED_KIND, MAX_AUTO_RESUMES, resumeInterruptedRuns } from "./session/resume.ts";
export { compactSession, compactIdleSession, sessionCacheTtlMs, handoffWithSummary, HANDOFF_PLAN_PREFIX, handoffPlan } from "./session/hygiene.ts";
export type { HygieneResult } from "./session/hygiene.ts";
export { cleanClientRunId, lookupClientRun, startRun, runMessage } from "./session/run.ts";
export type { RunHandle } from "./session/run.ts";
export { decidedBy, resolvePermission, resolvePlan, answerAsk } from "./session/interactions.ts";
export { steerSession, withdrawSteer, interruptWithSteer } from "./session/steer.ts";
export { recallRefs, renderAutomaticRecall } from "./session/recall.ts";
