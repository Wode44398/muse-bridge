// 上下文卫生：立即压缩、空闲压缩、带摘要开新会话、在新会话中实施计划。
import type { DecidedBy } from "../agent/events.ts";
import type { PermissionMode } from "../agent/permissions.ts";
import { compactManually, contextTokens, handoffSummary } from "../agent/context.ts";
import { getConfig } from "../config.ts";
import { traceEvent } from "../trace-log.ts";
import { registry } from "./registry.ts";
import { initState } from "./build-state.ts";
import { resolvePlan } from "./interactions.ts";
import { createSession, dropSession, getSession, lifecycle } from "./lifecycle.ts";
import { getOrLoadSession, writeRecord } from "./persist.ts";
import { startRun } from "./run.ts";
import type { Session } from "./types.ts";

// ── C8（X42、K43、A3）：上下文卫生入口 ─────────────────────────────────────────────────────
// 长会话、计划模式调研完之后在脏上下文里实施、缓存冷了下一条要按全价重读整段——给三个动作：立即压缩、带摘要开新会话、
// 计划卡上「在新会话中实施」。两个「新会话」都沿用原会话的工作区、厂商、型号、思考档位与访问范围。
export type HygieneResult = {
  ok: boolean;
  error?: string;
  code?: "running" | "not_found" | "empty" | "failed";
  sessionId?: string;
  before?: number;
  after?: number;
};

// 立即压缩：不在跑时才行（压缩要改整段转录）；压缩期间这个会话不落盘、不起新的一轮
export function compactSession(sessionId: string): Promise<HygieneResult> {
  return lifecycle(sessionId, async () => {
    const session = await getOrLoadSession(sessionId);
    if (!session) return { ok: false, code: "not_found", error: "unknown session" };
    if (session.running) return { ok: false, code: "running", error: "this conversation is running — compact it after the run" };
    if (!session.state) session.state = initState(session);
    registry.rewinding.add(sessionId);
    try {
      const r = await compactManually(session.state);
      await writeRecord(session);
      return { ok: true, ...r };
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, code: /nothing to compact|would not shrink/.test(msg) ? "empty" : "failed", error: msg };
    } finally {
      registry.rewinding.delete(sessionId);
    }
  });
}

// 空闲压缩（idle-compact.ts 定时调）：和「立即压缩」同一个压法，但不占住会话——用户这时发话照常开跑，startRun 先掐掉这次
// 压缩（signal），压缩在提交前最后看一眼信号，没提交的不留痕迹。minTokens = 上下文至少这么大才压。
export function compactIdleSession(sessionId: string, minTokens: number, signal: AbortSignal): Promise<HygieneResult> {
  return lifecycle(sessionId, async () => {
    if (signal.aborted) return { ok: false, code: "running", error: "aborted" };
    const session = await getOrLoadSession(sessionId);
    if (!session || session.discarded) return { ok: false, code: "not_found", error: "unknown session" };
    if (session.running || registry.rollingBack || registry.rewinding.has(sessionId)) return { ok: false, code: "running", error: "busy" };
    if (!session.state) session.state = initState(session);
    const used = contextTokens(session.state);
    if (used < minTokens) return { ok: false, code: "empty", error: `context ${used} below ${minTokens}` };
    try {
      const r = await compactManually(session.state, signal, "auto");
      await writeRecord(session);
      traceEvent(session.id, { e: "idle_compaction", before: r.before, after: r.after });
      return { ok: true, ...r };
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, code: signal.aborted ? "running" : /nothing to compact|would not shrink/.test(msg) ? "empty" : "failed", error: msg };
    }
  });
}

// 这个会话现在走的提示缓存能活多久（毫秒）；没有缓存 / 不知道 = 0
export function sessionCacheTtlMs(session: Session): number {
  return session.state?.adapter.capabilities.cacheTtlMs ?? 0;
}

function spawnSibling(origin: Session, permissionMode: PermissionMode, title: string): Session {
  const c = origin.cfg;
  const base = getConfig();
  const s = createSession({
    ...base,
    ...(c
      ? { provider: c.provider, model: c.model, baseUrl: c.baseUrl, thinking: c.thinking, workspace: c.workspace, access: c.access, permissionRules: c.permissionRules }
      : {}),
    permissionMode,
  });
  s.state = initState(s);
  s.title = title.slice(0, 200);
  return s;
}

// 带摘要开新会话：整段对话压成一条摘要，新会话以它开头（不起跑，等用户说话）
export function handoffWithSummary(sessionId: string): Promise<HygieneResult> {
  return lifecycle(sessionId, async () => {
    const origin = await getOrLoadSession(sessionId);
    if (!origin) return { ok: false, code: "not_found", error: "unknown session" };
    if (origin.running) return { ok: false, code: "running", error: "this conversation is running — try again after the run" };
    if (!origin.state) origin.state = initState(origin);
    if (!origin.state.messages.length) return { ok: false, code: "empty", error: "nothing to summarize yet" };
    try {
      const summary = await handoffSummary(origin.state, origin.title);
      const next = spawnSibling(origin, origin.cfg?.permissionMode ?? getConfig().permissionMode, `接续：${origin.title || "对话"}`);
      next.state!.messages = [summary];
      await writeRecord(next);
      return { ok: true, sessionId: next.id };
    } catch (e) {
      return { ok: false, code: "failed", error: (e as Error).message };
    }
  });
}

// 计划卡「在新会话中实施」：原会话里这份计划落定为「转到新会话」（模型一句话收尾），新会话以自主档起跑、首条消息就是计划
export const HANDOFF_PLAN_PREFIX =
  "请按下面这份计划实施。它是在另一个会话里做计划模式调研时写的；这是新会话，没有之前的上下文——动手前先读需要的文件。\n\n";
export function handoffPlan(sessionId: string, planId: string, by?: DecidedBy): HygieneResult {
  const origin = getSession(sessionId);
  const pending = origin?.pendingPlans.get(planId);
  if (!origin || !pending) return { ok: false, code: "not_found", error: "that plan is no longer waiting for a decision" };
  let next: Session;
  try {
    next = spawnSibling(origin, "auto", `实施：${pending.plan.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? "计划"}`);
  } catch (e) {
    return { ok: false, code: "failed", error: (e as Error).message };
  }
  const run = startRun(next, HANDOFF_PLAN_PREFIX + pending.plan);
  if (!run.started) {
    dropSession(next.id);
    return { ok: false, code: "failed", error: "the new session could not start right now — try again" };
  }
  resolvePlan(origin, planId, false, undefined, true, by);
  return { ok: true, sessionId: next.id };
}
