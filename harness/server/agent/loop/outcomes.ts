// 没被批准的调用回给模型的话、中止与失败事件、被打断的那一轮在转录里的收尾。
import type { AgentEvent } from "../events.ts";
import type { AgentState } from "../state.ts";
import { cutAtLoop, isRunawayRepetition, LOOP_CUT_NOTICE, type RepetitionLimits } from "../repetition.ts";
import { RESTART_REASON } from "../../retire.ts";

// ── P6（N16）：同意结局表 ─────────────────────────────────────────────────────
// 没被批准的调用回给模型的话，按结局只在这一处写。以前无人值守那句的注释是「so the model can route around it」，
// 拒绝文案也从不说「别换条路」——拒了 Edit，下一步换 Bash 照写（#49）。
//   denied     用户点了拒绝（可能带一句附言）
//   withdrawn  没等到答复（run 先结束了、离开模式没人能批）——不是拒绝
//   unattended 这次调用没有人能批（子 agent、无头运行）
//   denied_stop 用户点了「拒绝并停止」：这一轮随即停下
//   timeout    P7：倒计时到了没人批，按拒绝处理（fail-closed）——不是用户拒绝，但也别换条路绕过去
type ConsentOutcome = "denied" | "denied_stop" | "withdrawn" | "unattended" | "timeout";
const NO_BYPASS = "Do not try to achieve the same effect with another tool or command";
export function consentText(outcome: ConsentOutcome, detail?: string): string {
  const d = detail?.trim();
  switch (outcome) {
    case "denied":
      return `${d ? `user declined: ${d}` : "user declined this call"}. ${NO_BYPASS} — continue with other work, or ask the user`;
    case "denied_stop":
      return `${d ? `user declined: ${d}` : "user declined this call"} and stopped the run. ${NO_BYPASS}; wait for the user's next message`;
    case "withdrawn":
      return `not approved: ${d || "no answer"} (this is not a refusal — ask again if still needed)`;
    case "timeout":
      return `not approved: ${d || "nobody answered in time"} (this is not a refusal). ${NO_BYPASS}; skip this step and mention it in your final answer`;
    case "unattended":
      return `${d}, but no user is attached to approve it, so it was not approved. ${NO_BYPASS}; skip this step and mention it in your final answer`;
  }
}

// 同一个 run 里连续这么多次没被批准（用户拒绝 / 没人在场），就不再试了：收尾轮交代清楚，由人决定
// （次数随模型档案 loop.denialsBeforeStop，默认就是这个常量）
export const DENIALS_BEFORE_STOP = 3;
export const denialsStopText = (n: number): string =>
  `[Permissions] ${n} actions in a row were not approved. Stop here — do not retry them and do not try to ` +
  "get the same effect another way. Write your final answer now: what you were trying to do, what was not done because " +
  "it was not approved, and what the user needs to decide. Further tool calls will NOT be executed.";

// ── R6（#32）：中断与失败说真话 ───────────────────────────────────────────────
// 用户停下时，已经跑完的批次照实入转录，没轮到的明说没执行、别自动重试（以前直接 return，下次
// 恢复时连已经带副作用跑完的调用也被说成「没执行、需要就重发」）；流到一半被停，已经显示给用户的
// 文字也进转录；失败轮补一条 assistant 边界，写明出了什么错、这一轮已经跑过哪些工具。
export const NOT_STARTED_USER_STOP =
  "Not executed: the user stopped the run before this call started. Do not retry it automatically — " +
  "wait for the user's next instruction.";
// M8：部署 / 重启时的排空也是中止，但不是用户叫停的——照实写，续聊时模型才知道该接着干。
export const NOT_STARTED_RESTART =
  "Not executed: the server restarted (deploy) before this call started. The task was interrupted, " +
  "not cancelled — when the user resumes, check what already happened and continue.";
export const byRestart = (signal: AbortSignal) => signal.reason === RESTART_REASON;
// U6（hermes N41）：中断带上是谁停的——前端显示成灰色的「已停止」，不再是一张红色的 aborted 报错卡
export const abortedEvent = (signal: AbortSignal): AgentEvent => ({
  e: "error",
  message: "aborted",
  retriable: false,
  stopped: byRestart(signal) ? "restart" : "user",
});
// U6：失败的描述符——一句人话（分类器给的，或这里写的中文），这一轮已经执行过几次工具（重发之前先核对它们的结果）
export function failureEvent(message: string, retriable: boolean, ran: Map<string, number>, extra: { class?: string; summary?: string } = {}): AgentEvent {
  const count = [...ran.values()].reduce((a, b) => a + b, 0);
  return {
    e: "error",
    message,
    retriable,
    ...(extra.class ? { class: extra.class } : {}),
    ...(extra.summary ? { summary: extra.summary } : {}),
    ...(count ? { ran: count } : {}),
  };
}
export const cutReason = (signal: AbortSignal) =>
  byRestart(signal) ? "interrupted: the server restarted (deploy) before this turn finished" : "interrupted by the user";

export function ranSummary(ran: Map<string, number>): string {
  if (!ran.size) return "No tools ran in this run.";
  return `Tools that ran in this run: ${[...ran].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(", ")}.`;
}

// 被中断或失败的这一轮在转录里要有个结尾：已流出的文字照留（丢掉没签名的 thinking 与没收完的调用）
// 并注明原因；什么都没流出来时补一条只给模型看的边界。
export function closeCutTurn(state: AgentState, text: string, reason: string, internal: boolean): void {
  // R16：被打断时留下的半截已经是循环（严格档）——循环的部分不进转录，免得下一轮重放又把模型带回循环
  if (isRunawayRepetition(text, true, state.profile.loop.repetition)) text = withLoopCut(text, state.profile.loop.repetition);
  if (text.trim()) {
    state.appendAssistant({ text: `${text}\n\n[${reason}]`, thinkingText: "", calls: [] }, internal);
  } else {
    state.appendAssistant({ text: `[${reason}]`, thinkingText: "", calls: [] }, true);
  }
}

// R16：截到循环开始处，再补一句标记
export function withLoopCut(text: string, lim: RepetitionLimits): string {
  const kept = cutAtLoop(text, lim);
  return `${kept}${kept ? "\n\n" : ""}${LOOP_CUT_NOTICE}`;
}

// ── V1（#19）：最终答复下的服务端验证回执 ─────────────────────────────────────
// 模型写的「测试全绿」旁边，摆着这一轮真正交出的证据：通过的检查、最后一次没通过的检查、
// VerificationAudit 的豁免理由。只在这一轮出了问题时出现（全部通过不附，10-07）；写进最终
// 那条 assistant 消息（刷新后还在），并在 done 之前补一个 text_delta（在线的客户端当场看到）。
export const clipDetail = (d: string): string => {
  const one = d.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  return one.length > 140 ? one.slice(0, 140) + "…" : one;
};
