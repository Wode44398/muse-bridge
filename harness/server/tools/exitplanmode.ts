import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";
import { planReceipt } from "../agent/card-receipts.ts";

// How a plan-mode run ends: the agent submits the plan it researched, the user
// approves or sends it back, and an approval flips this session to auto so the
// SAME run keeps going and executes it. Without this the only way out of plan
// mode was for the user to change a setting and re-ask.
//
// effect:"read" on purpose — plan mode blocks every non-read tool, and this is
// the one call that must remain available inside it.
export const exitPlanModeTool: Tool = {
  effect: "read",
  concurrencySafe: false,
  def: {
    name: "ExitPlanMode",
    description:
      "Submit your plan for the user's approval and ask to leave plan mode. Call this ONLY in plan mode, " +
      "after you have read enough of the code to be concrete. BLOCKS until the user answers. " +
      "If they approve, this session switches to normal execution and you carry out the plan in the same run. " +
      "If they send it back, stay in plan mode and revise using their feedback. " +
      "Write the plan as short markdown: what you will change (file by file), how you will verify it, " +
      "and anything you deliberately are NOT doing.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description: "The plan, as markdown. Concrete: name the files/functions you will touch and how you will verify.",
        },
      },
      required: ["plan"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const plan = String(args.plan ?? "").trim();
    if (!plan) return fail("exit plan mode", "ExitPlanMode requires a `plan`.");
    if (!ctx.submitPlan) {
      // Sub-agents and headless/test contexts have no user to approve anything.
      return fail(
        "exit plan mode",
        "Plan approval is unavailable in this context (no user attached). Continue with read-only research and report your plan as your final answer.",
      );
    }
    const decision = await ctx.submitPlan(plan);
    // #103：计划卡的回执随工具结果落盘——刷新、换台设备打开会话也看得见「计划已批准 · 在手机上」与退回意见
    const receipt = planReceipt(decision);
    const res = planResult(decision);
    return receipt ? { ...res, meta: { ...(res.meta ?? {}), plan: receipt } } : res;
  },
};

type PlanDecision = Awaited<ReturnType<NonNullable<ToolContext["submitPlan"]>>>;

// U8（K36）：工具行第二行只说结论——直播时与刷新后重建（meta.outcome）是同一句，不再露出给模型看的英文原文
const withOutcome = (outcome: string, r: ToolRunResult): ToolRunResult => ({ ...r, outcome });

function planResult(decision: PlanDecision): ToolRunResult {
  if (decision.away) {
    // P3：离开模式默认「保持 plan、结束本轮并留言」——自动批准不等于用户同意开工。
    return {
      ok: false,
      summary: "plan waiting for the user",
      outcome: "你不在，计划等你回来审",
      content: [{ t: "text", text: "The user is away (away mode is on) and could not review the plan. Stay in plan mode: end this run by presenting the plan as your final answer; they will approve it when they are back." }],
    };
  }
  if (decision.timedOut) {
    // P7：倒计时到了没人审——同离开模式：保持 plan、以计划收尾（没审过的计划不能当成批准）
    return {
      ok: false,
      summary: "plan waiting for the user",
      outcome: "超时没人审，计划保持未批准",
      content: [{
        t: "text",
        text: `Nobody reviewed the plan within ${decision.timeoutMin ?? "the allowed"} minutes. Stay in plan mode: end this run by presenting the plan as your final answer; the user can approve it when they are back.`,
      }],
    };
  }
  if (decision.unanswered) {
    // M1：run 先结束了，用户根本没看这份计划——不是退回。
    return {
      ok: false,
      summary: "plan not decided",
      outcome: "没等到决定，这一轮先结束了",
      content: [{ t: "text", text: "The run ended before the user decided on the plan (this is not a rejection). You are still in plan mode; present the plan again when the conversation resumes." }],
    };
  }
  if (decision.handoff) {
    // C8（X42）：计划交给了一个新会话（干净的上下文、自主档）去实施——这边不动手、不再改计划，一句话收尾
    return withOutcome("转到新会话实施", ok(
      "plan handed to a new session",
      "The user is carrying this plan out in a NEW session with a fresh context (it has already been handed over there). " +
        "Do NOT implement it here and do not revise it. End this run now with one short sentence saying the plan moved to a new session.",
    ));
  }
  if (decision.approved) {
    return withOutcome("已批准，接着执行", ok(
      "plan approved",
      "The user APPROVED your plan and this session is now in normal execution mode. " +
        "Carry the plan out now, in this same run, starting with the first step. " +
        (decision.note ? `Their note: ${decision.note}` : ""),
    ));
  }
  return {
    ok: false,
    summary: "plan sent back",
    outcome: "被退回修改",
    content: [
      {
        t: "text",
        text:
          "The user did NOT approve the plan; you are still in plan mode (no writes or commands). " +
          (decision.note
            ? `Their feedback: ${decision.note}\nRevise the plan accordingly and call ExitPlanMode again.`
            : "Revise the plan — ask them what to change if the objection is unclear — and call ExitPlanMode again."),
      },
    ],
  };
}
