// 目标续跑的接线。
import type { GoalVerdict, ToolContext } from "../tools/types.ts";
import { bashTool, commandCanVerify } from "../tools/bash.ts";
import { afterRound, type GoalState, pauseGoal, resumeGoal, type RoundOutcome } from "../goal.ts";
import { updateGoalTool } from "../tools/goal.ts";
import { fanout } from "./events.ts";
import { getOrLoadSession, persistNow, schedulePersist } from "./persist.ts";
import { startRun } from "./run.ts";
import type { Session } from "./types.ts";

// ── O7（H8、K64、N61、X58）：目标续跑 ──────────────────────────────────────────────────────────
// 状态与判定在 goal.ts；这里是接线：开跑时同步 UpdateGoal 工具、挂上 ctx.goal；收尾时按这一轮的结局更新目标、续不续。
const GOAL_VERIFY_MAX_MS = 30 * 60_000;

function toolText(r: { content?: Array<{ t: string; text?: string }> }): string {
  return (r.content ?? []).map((b) => (b.t === "text" ? b.text ?? "" : "")).join("");
}

// 工具清单只在两轮之间变（一轮之内不变，Q3 的请求不变量）：有进行中的目标就挂上 UpdateGoal，没有就摘掉
export function syncGoalTool(session: Session): void {
  const state = session.state;
  if (!state) return;
  const name = updateGoalTool.def.name;
  const want = session.goal?.status === "active";
  const has = state.toolMap.has(name);
  if (want && !has) {
    state.tools = [...state.tools, updateGoalTool.def];
    state.toolMap.set(name, updateGoalTool);
  } else if (!want && has) {
    state.tools = state.tools.filter((t) => t.name !== name);
    state.toolMap.delete(name);
  }
}

// 目标里的验证命令由 harness 自己跑（用户写的命令）：前台跑，超过前台上限转了后台就等它（封顶 30 分钟）
async function runGoalVerify(command: string, ctx: ToolContext): Promise<GoalVerdict> {
  const verify = commandCanVerify(command) ? { verify: true } : {};
  const started = Date.now();
  let res = await bashTool.run({ command, timeout: ctx.limits.bashMaxTimeoutMs, ...verify }, ctx);
  let text = toolText(res);
  const moved = /background as (job\d+(?:-[a-z0-9]+)?)/.exec(text)?.[1];
  if (moved) {
    while (Date.now() - started < GOAL_VERIFY_MAX_MS && !ctx.signal?.aborted) {
      res = await bashTool.run({ wait: moved, timeout: ctx.limits.bashMaxTimeoutMs, ...verify }, ctx);
      text = toolText(res);
      if (!/still running/.test(text)) break;
    }
  }
  const running = /still running/.test(text);
  const status = running ? "still running" : (/\[(exit -?\d+|timeout|aborted|killed by timeout)\]/.exec(text)?.[1] ?? (res.ok ? "exit 0" : "failed"));
  const lines = text.split("\n");
  const output = lines.slice(-40).join("\n").slice(-4000);
  return { passed: res.ok && !running, verify: command, status, output, ...(res.verification ? { verification: res.verification } : {}) };
}

export function goalHooks(session: Session): NonNullable<ToolContext["goal"]> {
  return {
    verify: session.goal?.verify,
    block: (reason) => {
      if (session.goal?.status === "active") session.goal = { ...session.goal, blocked: reason };
    },
    claimDone: async (summary) => {
      const g = session.goal;
      if (!g || g.status !== "active") return { passed: false, status: "no active goal" };
      if (!g.verify) {
        session.goal = { ...g, achieved: summary ? `达成：${summary}` : "模型声明达成（没有验证命令）" };
        return { passed: true };
      }
      const verdict = await runGoalVerify(g.verify, session.state!.ctx);
      if (verdict.passed && session.goal?.status === "active") session.goal = { ...session.goal, achieved: `达成：${g.verify} 通过` };
      return verdict;
    },
  };
}

function noteGoal(session: Session): void {
  fanout(session, { e: "goal", goal: session.goal ?? null });
  schedulePersist(session);
}

// 一轮收尾：更新目标（在告诉在看的设备「这一轮结束了」之前，它们收得到），返回续不续
export function settleGoalRound(session: Session, outcome: RoundOutcome, usedTools: boolean): "continue" | "stop" {
  const g = session.goal;
  if (!g || g.status !== "active") return "stop";
  const { goal, next } = afterRound(g, outcome, usedTools);
  session.goal = goal;
  noteGoal(session);
  return next;
}

// 续下一轮：放到下一拍（这一轮的收尾——落盘、结束快照、放资源——都做完了）
export function scheduleGoalRound(session: Session): void {
  setImmediate(() => {
    if (session.discarded || session.running || session.goal?.status !== "active") return;
    const run = startRun(session, "", undefined, [], undefined, { goal: true });
    if (!run.started && session.goal) {
      session.goal = pauseGoal(session.goal, run.retiring ? "服务要重启，目标先暂停" : run.rollingBack ? "正在回滚，目标先暂停" : "没能起下一轮");
      noteGoal(session);
    }
  });
}

export type GoalAction = "pause" | "resume" | "clear";
export type GoalActionResult = { ok: boolean; error?: string; code?: "not_found" | "no_goal"; goal?: GoalState | null };

// 界面上的暂停 / 继续 / 结束。暂停不打断正在跑的这一轮（跑完不再续）；继续再给一份同样的预算，没在跑就立刻起下一轮。
export async function goalAction(sessionId: string, action: GoalAction): Promise<GoalActionResult> {
  const session = await getOrLoadSession(sessionId);
  if (!session) return { ok: false, code: "not_found", error: "unknown session" };
  if (!session.goal) return { ok: false, code: "no_goal", error: "this conversation has no goal" };
  if (action === "clear") session.goal = undefined;
  else if (action === "pause") session.goal = pauseGoal(session.goal, "你暂停了");
  else if (session.goal.status === "paused") session.goal = resumeGoal(session.goal);
  noteGoal(session);
  await persistNow(session);
  if (action === "resume" && session.goal?.status === "active" && !session.running) scheduleGoalRound(session);
  return { ok: true, goal: session.goal ?? null };
}
