// O7（H8、K64、N61、X58）：目标续跑（goal）。
//
// 用户发一条消息时带上 goal——这条消息就是目标，可选一条验证命令与轮数、时长上限。这一轮做完如果目标还没达成，runtime
// 自动续下一轮（首条是 harness 片段 kind goal-continue，不重提原话），直到：
//   · 模型用 UpdateGoal(done) 声明达成——声明了验证命令的，由 harness 自己执行、通过才算（门禁先于自审；没过就把失败输出
//     交回模型，这一轮接着改），没声明的按模型的声明；
//   · 或者停下来：模型用 UpdateGoal(blocked) 说要人、这一轮出错、用户按了停止、服务重启（冷恢复不自动续）、连续 3 轮没动手、
//     轮数或时长用完——一律暂停并写明原因。模型自己恢复不了，只有用户点「继续」（继续会再给一份同样的预算）。
// 暂缓（记录 §3）：等后台任务不烧轮的 WAIT 屏障（O6 的 Bash(wait) 先顶着）、子 agent / 工作流的子树记账。
// 这里只放状态与判定（纯函数，测试直接测）；接线在 session.ts，UpdateGoal 在 tools/goal.ts。

export interface GoalState {
  objective: string;
  // 验证命令：harness 在模型声明达成时自己执行（用户写的，不是模型写的）
  verify?: string;
  maxRounds: number;
  maxMinutes: number;
  // 已经开跑的轮数（第一轮 = 用户那条消息）
  round: number;
  status: "active" | "paused" | "done";
  // 暂停 / 达成的原因（人话，界面照着显示）
  reason?: string;
  startedAt: number;
  // 时长预算从这里算（继续时重置）
  budgetFrom: number;
  // 轮数预算的起点（继续时 = 当时的 round）
  roundBase: number;
  updatedAt: number;
  // 连续没动手（没调工具）的轮数——熔断
  idleRounds: number;
  // 这一轮模型说需要人（UpdateGoal blocked）：这一轮收尾时暂停
  blocked?: string;
  // 这一轮 UpdateGoal(done) 通过了（验证命令过了，或没声明验证命令）：收尾时算达成
  achieved?: string;
}

export const GOAL_START_KIND = "goal-start";
export const GOAL_CONTINUE_KIND = "goal-continue";
export const GOAL_IDLE_LIMIT = 3;
export const GOAL_DEFAULT_ROUNDS = 10;
export const GOAL_MAX_ROUNDS = 50;
export const GOAL_DEFAULT_MINUTES = 120;
export const GOAL_MAX_MINUTES = 24 * 60;

const clampInt = (v: unknown, dflt: number, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : dflt;
};

export function newGoal(objective: string, opts: { verify?: unknown; maxRounds?: unknown; maxMinutes?: unknown } = {}, now = Date.now()): GoalState {
  const verify = typeof opts.verify === "string" && opts.verify.trim() ? opts.verify.trim().slice(0, 500) : undefined;
  return {
    objective: objective.trim().slice(0, 4000),
    ...(verify ? { verify } : {}),
    maxRounds: clampInt(opts.maxRounds, GOAL_DEFAULT_ROUNDS, GOAL_MAX_ROUNDS),
    maxMinutes: clampInt(opts.maxMinutes, GOAL_DEFAULT_MINUTES, GOAL_MAX_MINUTES),
    round: 0,
    status: "active",
    startedAt: now,
    budgetFrom: now,
    roundBase: 0,
    updatedAt: now,
    idleRounds: 0,
  };
}

const howToFinish = (g: GoalState): string =>
  g.verify
    ? `When you believe the goal is done, call UpdateGoal(status:"done", summary) — the harness then runs \`${g.verify}\` itself and only accepts the goal if it passes; if it fails you get the output and keep going.`
    : 'When the goal is done, call UpdateGoal(status:"done", summary).';

// 第一轮：跟在用户那条消息后面的说明（这一轮起就是目标模式）
export function goalStartText(g: GoalState): string {
  return (
    `[Goal] The user's message above is a goal, not a one-off request: the harness keeps starting new rounds until it is done ` +
    `(at most ${g.maxRounds} rounds / ${g.maxMinutes} minutes). ${howToFinish(g)} If you cannot continue without the user ` +
    '(a decision, access, missing information), call UpdateGoal(status:"blocked", reason) and say what you need — the goal pauses. ' +
    "Do real work every round; rounds without any tool use count against a stop."
  );
}

export function goalContinueText(g: GoalState): string {
  const used = g.round - g.roundBase;
  return (
    `[Goal] Round ${used}/${g.maxRounds}${g.roundBase ? ` (${g.round} in total)` : ""} — keep working toward the goal: ${g.objective}\n` +
    `Check what is already done before doing more; do not redo finished work. ${howToFinish(g)} ` +
    'If you need the user, call UpdateGoal(status:"blocked", reason).' +
    (used >= g.maxRounds ? " This is the last round in the budget." : "")
  );
}

export type RoundOutcome =
  | { kind: "done" }
  | { kind: "error"; summary: string }
  | { kind: "aborted"; by: "user" | "restart" };

// 一轮收尾之后：更新状态，决定续不续。只动 active 的目标（暂停着、达成了的不管）。
export function afterRound(g: GoalState, outcome: RoundOutcome, usedTools: boolean, now = Date.now()): { goal: GoalState; next: "continue" | "stop" } {
  if (g.status !== "active") return { goal: g, next: "stop" };
  const pause = (reason: string) => ({ goal: { ...g, status: "paused" as const, reason, blocked: undefined, updatedAt: now }, next: "stop" as const });
  if (g.achieved) return { goal: { ...g, status: "done", reason: g.achieved, updatedAt: now }, next: "stop" };
  if (outcome.kind === "aborted") return pause(outcome.by === "user" ? "你按了停止" : "服务重启打断了这一轮");
  if (outcome.kind === "error") return pause(`这一轮出错：${outcome.summary}`);
  if (g.blocked) return pause(`需要你：${g.blocked}`);
  const idleRounds = usedTools ? 0 : g.idleRounds + 1;
  if (idleRounds >= GOAL_IDLE_LIMIT) return pause(`连续 ${GOAL_IDLE_LIMIT} 轮没有动手`);
  if (g.round - g.roundBase >= g.maxRounds) return pause(`轮数用完（${g.maxRounds} 轮）`);
  if (now - g.budgetFrom >= g.maxMinutes * 60_000) return pause(`时长用完（${g.maxMinutes} 分钟）`);
  return { goal: { ...g, idleRounds, updatedAt: now }, next: "continue" };
}

// 服务重启后从盘上读回：进行中的一律暂停（冷恢复不自动续）
export function coldGoal(g: GoalState): GoalState {
  return g.status === "active" ? { ...g, status: "paused", reason: "服务重启了，目标先暂停——点「继续」接着做", blocked: undefined, achieved: undefined } : g;
}

// 用户点「继续」：再给一份同样的预算（轮数从现在算、时长重新计时）
export function resumeGoal(g: GoalState, now = Date.now()): GoalState {
  return { ...g, status: "active", reason: undefined, blocked: undefined, achieved: undefined, idleRounds: 0, roundBase: g.round, budgetFrom: now, updatedAt: now };
}

export function pauseGoal(g: GoalState, reason: string, now = Date.now()): GoalState {
  return g.status === "active" ? { ...g, status: "paused", reason, updatedAt: now } : g;
}
