// 权限判定的审计、工作区外只读目录的问询、调用的上下文。
import type { AgentState } from "../state.ts";
import { callSubject, type Decision } from "../permissions.ts";
import { approvalPreview } from "../approval-preview.ts";
import { permissionReceipt, type PermissionReceipt } from "../card-receipts.ts";
import type { Sandbox } from "../../sandbox.ts";
import { traceEvent } from "../../trace-log.ts";
import { fail, type ToolContext, type ToolPolicy, type ToolRunResult } from "../../tools/types.ts";

// P14（ZCode C5）：权限判定审计。每次不是「默认放行」的判定记一行进会话的 trace JSONL（e: permission_decision）：工具、
// 判定对象（trace-log 会截断、脱敏）、档位、第一判与最终结果、结构化来源与规则、最后是谁定的（规则 / 用户 / 没人在场 /
// 超时 / 离开模式 / 撤回）、批准的范围。诊断永不影响主链路：traceEvent 自己吞错。
export type PermissionAuditBy = "rule" | "user" | "unattended" | "timeout" | "away" | "withdrawn";
// P13（X18，Codex「被沙箱拒了 → 问要不要放行 → 重跑」）：越界只读的审批卡。选项同一张权限卡：允许这一次（这次调用
// 带着放行重跑）/ 本会话都允许（这些目录记成本会话的只读目录，随会话落盘，之后同目录的读不再问）/ 拒绝（原失败照旧，附一句）。
// 离开模式、超时没人批，按没批准处理（registerPermission 自己会这样落定）。
export const OUTSIDE_READ_RULE = "outside-read";
export async function askOutsideRead(
  state: AgentState,
  call: { id: string; name: string; args: Record<string, unknown> },
  res: ToolRunResult,
  runWith: (sandbox?: Sandbox) => Promise<ToolRunResult>,
  receipts: PermissionReceipt[],
): Promise<ToolRunResult> {
  const dirs = res.outsideRead!.dirs;
  const req = {
    tool: call.name,
    subject: dirs.join("; "),
    rule: OUTSIDE_READ_RULE,
    sessionRules: dirs.map((d) => `ReadOnly(${d})`),
    why: `要读工作区外的${dirs.length > 1 ? ` ${dirs.length} 个目录` : "目录"}「${dirs.join("」「")}」（只读，不会写）`,
    preview: approvalPreview(call.name, call.args) ?? { kind: "text" as const, text: `${call.name} ${JSON.stringify(call.args).slice(0, 400)}` },
  };
  const verdict = await state.ctx.requestPermission!(req);
  const receipt = permissionReceipt(req, verdict); // #103
  if (receipt) receipts.push(receipt);
  const initial: Decision = { effect: "ask", reason: `read outside the workspace: ${dirs.join(", ")}`, rule: OUTSIDE_READ_RULE, source: "outside-read" };
  if (verdict.decision === "deny") {
    const by: PermissionAuditBy = verdict.timedOut ? "timeout" : verdict.away ? "away" : verdict.unanswered ? "withdrawn" : "user";
    auditPermission(state, call, initial, { effect: "deny", reason: "reading outside the workspace was not allowed" }, by, undefined);
    const why = verdict.timedOut
      ? "nobody answered in time"
      : verdict.away
        ? "the user is away"
        : verdict.unanswered
          ? "no answer"
          : `the user declined${verdict.note ? `: ${verdict.note}` : ""}`;
    const text = res.content.map((b) => (b.t === "text" ? b.text : "")).join("");
    return {
      ...res,
      outsideRead: undefined,
      content: [{ t: "text", text: `${text}\n\nAsked the user to allow reading ${dirs.join(", ")} (read-only): not allowed — ${why}. Do without it, or ask the user to switch the project to full access.` }],
    };
  }
  auditPermission(state, call, initial, { effect: "allow", reason: "" }, verdict.away ? "away" : "user", verdict.decision === "session" ? "session" : "once");
  if (verdict.decision === "session") state.grantReadRoots(dirs);
  try {
    return await runWith(verdict.decision === "session" ? undefined : state.ctx.sandbox.withReadRoots(dirs));
  } catch (e) {
    return fail("tool error", `${call.name} threw: ${(e as Error).message}`);
  }
}

export function auditPermission(
  state: AgentState,
  call: { name: string; args: Record<string, unknown> },
  initial: Decision,
  final: Decision,
  by: PermissionAuditBy,
  scope: string | undefined,
): void {
  if (initial.source === "default" && final.effect === "allow") return;
  const owner = state.ctx.ownerId;
  if (!owner) return;
  traceEvent(owner, {
    e: "permission_decision",
    tool: call.name,
    subject: callSubject(call.name, call.args),
    mode: state.effectiveMode(),
    initial: initial.effect,
    effect: final.effect,
    source: initial.source ?? "unknown",
    ...(initial.rule ? { rule: initial.rule } : {}),
    by,
    ...(scope ? { scope } : {}),
    ...(final.effect === "deny" ? { reason: final.reason } : {}),
  });
}

// Per-call view of the shared ToolContext: prototype-chained so every read
// (signal, askUser, emit, …) still sees the live session values, while the
// call id rides on top without racing the parallel read batch (a plain
// `ctx.callId = …` would be clobbered by the next call in the same batch).
// 档案放松过的工具契约同样只挂在这一层（会话共享的 ctx 不动）。
export function callContext(ctx: ToolContext, callId: string, toolPolicy?: ToolPolicy): ToolContext {
  return Object.assign(Object.create(ctx) as ToolContext, { callId, ...(toolPolicy ? { toolPolicy } : {}) });
}
