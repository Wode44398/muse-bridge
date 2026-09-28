// O7（K64、N61）：UpdateGoal——目标续跑里模型的自审。只在会话有进行中的目标时出现在工具清单里（两轮之间增删）。
//   · done：声明达成。声明了验证命令的，harness 当场自己执行（用户写的命令，不是模型写的），通过才算——门禁先于自审；
//     没过就把失败输出交回，模型这一轮接着改。没声明验证命令的，按模型的声明。
//   · blocked：离了人做不下去（要一个决定、权限、缺的信息）——这一轮收尾时目标暂停，等用户。
import { fail, ok, type Tool, type ToolRunResult } from "./types.ts";

export const updateGoalTool: Tool = {
  // 跑的是用户在目标里写的验证命令，模型改不了它；按只读判权限
  effect: "read",
  concurrencySafe: false,
  def: {
    name: "UpdateGoal",
    description:
      "Report on the goal this conversation is working toward (goal mode). status \"done\" = you believe the goal is met: if the goal " +
      "declares a verify command the harness runs it itself and only accepts the goal when it passes — otherwise you get its output and " +
      "keep going. status \"blocked\" = you cannot continue without the user (a decision, access, missing information): the goal pauses " +
      "after this round; say what you need.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "blocked"] },
        summary: { type: "string", description: "done: what was achieved, in one or two sentences." },
        reason: { type: "string", description: "blocked: what you need from the user." },
      },
      required: ["status"],
    },
  },
  async run(args, ctx): Promise<ToolRunResult> {
    const goal = ctx.goal;
    if (!goal) return fail("no goal", "There is no active goal in this conversation — just answer normally.");
    const status = String(args.status ?? "");
    if (status === "blocked") {
      const reason = String(args.reason ?? args.summary ?? "").trim() || "（没说原因）";
      goal.block(reason.slice(0, 300));
      return {
        ...ok("goal blocked", "Noted: the goal pauses after this round and waits for the user. Tell them concisely what you need."),
        outcome: `目标暂停：${reason.slice(0, 60)}`,
      };
    }
    if (status !== "done") return fail("bad status", 'status must be "done" or "blocked".');
    const verdict = await goal.claimDone(String(args.summary ?? "").trim().slice(0, 500));
    const extra = verdict.verification ? { verification: verdict.verification } : {};
    if (verdict.passed) {
      return {
        ...ok(
          "goal done",
          verdict.verify
            ? `Accepted: \`${verdict.verify}\` passed (${verdict.status ?? "exit 0"}), so the goal is marked done. Give the user a short final summary.`
            : "The goal is marked done. Give the user a short final summary.",
        ),
        outcome: verdict.verify ? `目标达成：${verdict.verify} 通过` : "目标达成",
        ...extra,
      };
    }
    return {
      ...fail(
        "goal not done",
        `Not accepted: \`${verdict.verify}\` did not pass (${verdict.status ?? "failed"}).` +
          (verdict.output ? `\nOutput (tail):\n${verdict.output}` : "") +
          '\nFix what it reports, then call UpdateGoal(status:"done") again.',
      ),
      outcome: `验证没过：${verdict.verify}（${verdict.status ?? "失败"}）`,
      ...extra,
    };
  },
};
