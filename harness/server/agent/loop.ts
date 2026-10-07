import type { AgentEvent, StopReason, TodoItem } from "./events.ts";
import type { Block, Msg, Turn } from "./turn.ts";
import { toolResult } from "./turn.ts";
import { mayHaveSideEffects, type AgentState } from "./state.ts";
import { RunInvariants } from "./turn-invariants.ts";
import { compactNow, contextNeedsTrim, contextTokens, effectiveWindow, ensureContextFits } from "./context.ts";
import { downsampleForModel } from "./media-budget.ts";
import { messageKind } from "./injections.ts";
import { PLAYBOOK_KIND, playbookLoadedIn, playbookMessage, playbooksForCalls, playbooksForRequest, type Playbook } from "./playbooks.ts";
import { loopStopText } from "./loop-guard.ts";
import { cutAtLoop, isRunawayRepetition, LOOP_CUT_NOTICE } from "./repetition.ts";
import { connectErrorLabel, isConnectFailure, planWait, type NetWait, type WaitPlan } from "./netwait.ts";
import { REPEAT_DENIAL_RULE, callSubject, decide, sessionRuleChoices, type Decision } from "./permissions.ts";
import { normalizeToolArgs } from "./tool-input.ts";
import { approvalPreview } from "./approval-preview.ts";
import { permissionReceipt, type PermissionReceipt } from "./card-receipts.ts";
import { outsideReadOf, readRootFor, type Sandbox } from "../sandbox.ts";
import { traceEvent } from "../trace-log.ts";
import { uncoveredReferencingTests } from "./revdeps.ts";
import { fail, type PreparedCall, type ToolContext, type ToolRunResult } from "../tools/types.ts";
import { commandCanVerify } from "../tools/bash.ts";
import { noteKnowledgeEdit, noteKnowledgeVerification } from "../knowledge-service.ts";
import { nudgeOutboundProxy } from "../net-proxy.ts";
import { RESTART_REASON } from "../retire.ts";
import { childSpan, runInTrace, traceIterable } from "../trace.ts";

// Re-show the todo list after this many tool turns without the model seeing it
// (a TodoWrite call or an earlier reminder); compaction forces an immediate one.
const TODO_REMIND_TURNS = 5;

const RAN_COMMANDS_CAP = 300;
const REVDEP_REPORT_MAX = 6;

// Tools whose per-call chrome (tool_start / tool_permission / tool_end) is never
// forwarded to the frontend. MemoryAudit is an internal lifecycle checkpoint;
// AskUserQuestion drives its own dedicated ask/ask_answer event + card, so the
// generic tool row would be a confusing duplicate. The tool still runs and its
// result still lands in the transcript — only the visible events are hidden.
const SILENT_TOOLS = new Set(["MemoryAudit", "AskUserQuestion"]);
const isSilentTool = (name: string): boolean => SILENT_TOOLS.has(name);

// Memory bookkeeping the model can legitimately batch onto its final answer:
// nothing here produces a result the answer still depends on. A turn made up
// only of these, next to real answer text, is already a finished reply.
const AUDIT_CLOSURE_TOOLS = new Set(["MemoryAudit", "Remember"]);

// Text that merely ANNOUNCES the call it rides with ("执行强制审计收尾：",
// "Saving the checkpoint:") is a preamble, not an answer — a turn that ends on
// a colon is promising more output, so it must never be mistaken for a
// finished reply (see the audit-closure early finish below).
const announcesMore = (text: string): boolean => /[:：]\s*$/.test(text.trim());

// Marks a mid-run insertion so the model can tell it apart from the original
// task ("the user is talking to me right now"), and knows a correction here
// overrides earlier instructions rather than adding a second task.
const STEER_PREFIX =
  "[用户在运行中插话] 以下是用户刚刚发来的消息。它优先于此前的指示：如果与你正在做的事冲突，" +
  "按这条来（必要时放弃/回滚正在进行的做法），然后继续。\n\n";

// plan 模式实测（deepseek-v4-pro）：模型会直接用散文答「我的计划是…」而不调
// ExitPlanMode，于是用户永远等不到那张批准卡。像其他门禁一样提醒一次；只提醒一次，
// 因为「这个目录里有什么文件」这类纯问句在 plan 模式下直接回答本来就是对的。
// Q14（K54）：harness 自己的提示语都是导出的常量——测试比对常量或消息的 origin / kind，不照抄措辞（措辞随时可改）。
export const PLAN_SUBMIT_NUDGE =
  "[Plan mode] You are in plan mode and have not called ExitPlanMode. If the user asked you to CHANGE " +
  "anything, do not answer in prose: call ExitPlanMode now with the concrete plan (files/functions you " +
  "will touch, how you will verify, what you are not doing) — that is the only way the user can approve " +
  "and let you execute. If this was purely a question and you have fully answered it, say so plainly and stop.";

export const VERIFY_NUDGE =
  "[Automated check] You have edited files without sufficient passing verification evidence. " +
  "Do not declare the task done yet: run the relevant tests, build, or program with an explicit verification " +
  "operation, read the output, and fix what fails. If no meaningful executable check exists or the environment " +
  "blocks it, call VerificationAudit with a concrete reason and disclose that limitation in the final answer.";

// A turn cut off by the output-token limit is NOT a finished answer. Auto-ask
// the model to pick up where it stopped, bounded so a non-converging model
// can't ping-pong forever.
// Same gate, honest wording: the model DID run something meaningful, it just
// never marked it as evidence, so the harness cannot count it.
export const VERIFY_UNDECLARED_NUDGE =
  "[Automated check] You edited files and then ran something that looks like a real check, but never marked " +
  "it as verification, so this run still counts as unverified. If that command WAS the check, re-run it with " +
  "verify:true (or Bash(poll:\"<id>\", verify:true)) and read the output. If it was not, run the real test or " +
  "build now. If no meaningful executable check exists or the environment blocks it, call VerificationAudit " +
  "with a concrete reason.";

const MAX_LENGTH_CONTINUES = 3;
export const LENGTH_CONTINUE_NUDGE =
  "[Automated check] Your previous reply was cut off by the output-token limit mid-response. " +
  "Continue exactly where you stopped — do not repeat what you already wrote. " +
  "If you were about to call tools, issue those tool calls now.";
// R19（hermes N23 的 reasoning-only 分流）：这一轮只写了思考、一个字的答复都没有就要收尾——用户那头只看得见一段思考。
// 实际使用中 1825 次模型回合里出现过 2 次，其中一次就这样收了尾（用户看到八千多字的思考、没有答复）。追问这么多次，还是没有就照旧收尾。
export const MAX_ANSWER_NUDGES = 1;
export const ANSWER_NUDGE =
  "[Automated check] Your last turn contained only reasoning — nothing reached the user. " +
  "Write your reply to the user now (do not repeat the reasoning). " +
  "If you meant to call tools, issue those tool calls now.";

export const MEMORY_AUDIT_NUDGE =
  "[Memory audit required] Before finishing, inspect the memory index and decide whether this run " +
  "produced durable knowledge that is not recoverable from the files. Use Remember first for any " +
  "lasting decision/reason, gotcha, user preference, or project context, then call " +
  "MemoryAudit(decision:'updated', reason:'...'). If nothing warrants storage, call " +
  "MemoryAudit(decision:'none', reason:'<concrete reason>'). Do not give the final answer until the checkpoint succeeds.";

export const PRECOMPACT_AUDIT_NUDGE =
  "[Pre-compaction memory audit] The context is about to be lossily summarized. Before that happens, " +
  "save any durable fact that a future session should retain with Remember, then call MemoryAudit as " +
  "updated. If the files/transcript already contain everything durable, call MemoryAudit as none with " +
  "a concrete reason. Continue the task after the checkpoint.";

const UNDECLARED_EVIDENCE_CAP = 3;
const MAX_MEMORY_AUDIT_NUDGES = 3;
const MAX_VERIFICATION_AUDIT_NUDGES = 3;

// R8：重试加厚。最多 10 次（以前 4 次，一次几十秒的限流窗口或一阵 5xx 就能把整轮打死）。等多久：provider 给了
// Retry-After 就照办（sse.ts 解析时夹在 5 分钟内）；否则通用退避按 0.5s 起指数增长，限流按 15s 一档递增（真实的
// 429 窗口是几十秒，远超通用退避），两者都封顶 60s，并在 [一半, 全额] 之间随机抖动——多个会话同时撞上限流时错开，
// 不在同一刻一起再撞一次。等下去会越过这一轮的截止时间就不等了，带着上一次的错收场。
export const RETRY_ATTEMPTS = 10;
// R17（B7）：什么都没回来——没正文、没思考、没工具调用，provider 也没报任何用量（真实的一次调用输入 token 不会是 0）——
// 是流悄悄断了，不是模型选择沉默。重发这么多次；还是这样就以 EMPTY_RESPONSE_KIND 收场。以前它一路走进验证 / 记忆审计门禁，
// 被当成「该审计没审计」追问到用尽，最后报一句不相干的「没交 MemoryAudit」。
export const EMPTY_RESPONSE_RETRIES = 1;
export const EMPTY_RESPONSE_KIND = "empty_model_response";
// #98：审计落定之后，连着只交审计生命周期工具、一个字不说的轮数上限（交成审计的那一轮也算在内），超过就以这句收场
const AUDIT_LIFECYCLE_TOOLS = new Set(["MemoryAudit", "Remember", "Recall"]);
export const REDUNDANT_AUDIT_TURNS = 4;
export const REDUNDANT_AUDIT_MESSAGE =
  "redundant_audit_loop: the memory audit was already completed, but the model kept re-submitting audit calls without answering — the run was stopped";
// R17（B8）：一批并行的只读调用最多这么多个——模型一轮发几十个 Read / Grep 时不再同时起几十个（Grep 各占一个 worker 线程）
export const MAX_PARALLEL_TOOLS = 8;
const OUTPUT_ROOM_MARGIN = 1_000; // R9：夹输出上限时给估算误差留的余量
const MIN_OUTPUT_TOKENS = 1_024;
const BACKOFF_BASE_MS = 500;
const RATE_LIMIT_WAIT_MS = 15_000;
const RETRY_WAIT_CAP_MS = 60_000;

export interface RetryWhy {
  retryAfterMs?: number; // provider 自己说的等多久
  rateLimited?: boolean;
}

// 测试把节奏整体调快（逻辑不变），与 netwait 的 DIMENSIO_NET_WAIT_BASE_MS 同一个做法。
const retryScale = (): number => {
  const s = Number(process.env.DIMENSIO_RETRY_SCALE);
  return Number.isFinite(s) && s > 0 ? s : 1;
};

// retry = 这是第几次重试（从 1 起）
export function retryDelayMs(retry: number, why: RetryWhy, random: () => number = Math.random): number {
  if (why.retryAfterMs !== undefined) return why.retryAfterMs;
  const full = Math.min(why.rateLimited ? RATE_LIMIT_WAIT_MS * retry : BACKOFF_BASE_MS * 2 ** (retry - 1), RETRY_WAIT_CAP_MS);
  return Math.round(full / 2 + random() * (full / 2));
}

// Bash commands that only LOOK at state don't verify anything — they must not
// clear the done-gate's dirty flag, and (for the revdep scan) merely `cat`ing a
// test file must not count as having run it. Conservative: a match requires the
// whole command to be a single plain invocation (no pipes/chains/redirects).
// Run-budget guardrails (opt-in per run via /api/run {deadlineMs, maxTurns}):
// nudge convergence at 80%, and once exhausted give the model exactly ONE final
// turn — whose tool calls are not executed — so a run never dies mid-sentence
// against an external wall-clock (the xarray-3364 timeout loss).
const BUDGET_SOFT_FRACTION = 0.8;

interface BudgetStatus {
  soft: boolean;
  exhausted: boolean;
  detail: string;
}

function budgetStatus(state: AgentState): BudgetStatus {
  const now = Date.now();
  const parts: string[] = [];
  let frac = 0;
  let exhausted = false;
  if (state.deadlineAt !== null) {
    const total = Math.max(1, state.deadlineAt - state.runStartedAt);
    const elapsed = now - state.runStartedAt;
    frac = Math.max(frac, elapsed / total);
    if (now >= state.deadlineAt) exhausted = true;
    parts.push(`${Math.round(elapsed / 1000)}s of ${Math.round(total / 1000)}s`);
  }
  if (state.maxTurns !== null) {
    frac = Math.max(frac, state.runTurns / state.maxTurns);
    if (state.runTurns >= state.maxTurns) exhausted = true;
    parts.push(`turn ${state.runTurns} of ${state.maxTurns}`);
  }
  return { soft: frac >= BUDGET_SOFT_FRACTION, exhausted, detail: parts.join(", ") };
}

const budgetNudgeText = (b: BudgetStatus) =>
  `[Budget] Most of this run's budget is used (${b.detail}). Converge now: finish the essential ` +
  "change, run the final verification, and wrap up. Do not start new explorations or side quests.";

const budgetExhaustedText = (b: BudgetStatus) =>
  `[Budget exhausted] This run's budget is used up (${b.detail}). Stop working NOW. Reply with a ` +
  "concise final summary of what you did, what is verified, and what (if anything) remains. " +
  "Further tool calls will NOT be executed.";

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
function consentText(outcome: ConsentOutcome, detail?: string): string {
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
const DENIALS_BEFORE_STOP = 3;
const DENIALS_STOP_TEXT =
  `[Permissions] ${DENIALS_BEFORE_STOP} actions in a row were not approved. Stop here — do not retry them and do not try to ` +
  "get the same effect another way. Write your final answer now: what you were trying to do, what was not done because " +
  "it was not approved, and what the user needs to decide. Further tool calls will NOT be executed.";

// ── R6（#32）：中断与失败说真话 ───────────────────────────────────────────────
// 用户停下时，已经跑完的批次照实入转录，没轮到的明说没执行、别自动重试（以前直接 return，下次
// 恢复时连已经带副作用跑完的调用也被说成「没执行、需要就重发」）；流到一半被停，已经显示给用户的
// 文字也进转录；失败轮补一条 assistant 边界，写明出了什么错、这一轮已经跑过哪些工具。
const NOT_STARTED_USER_STOP =
  "Not executed: the user stopped the run before this call started. Do not retry it automatically — " +
  "wait for the user's next instruction.";
// M8：部署 / 重启时的排空也是中止，但不是用户叫停的——照实写，续聊时模型才知道该接着干。
const NOT_STARTED_RESTART =
  "Not executed: the server restarted (deploy) before this call started. The task was interrupted, " +
  "not cancelled — when the user resumes, check what already happened and continue.";
const byRestart = (signal: AbortSignal) => signal.reason === RESTART_REASON;
// U6（hermes N41）：中断带上是谁停的——前端显示成灰色的「已停止」，不再是一张红色的 aborted 报错卡
const abortedEvent = (signal: AbortSignal): AgentEvent => ({
  e: "error",
  message: "aborted",
  retriable: false,
  stopped: byRestart(signal) ? "restart" : "user",
});
// U6：失败的描述符——一句人话（分类器给的，或这里写的中文），这一轮已经执行过几次工具（重发之前先核对它们的结果）
function failureEvent(message: string, retriable: boolean, ran: Map<string, number>, extra: { class?: string; summary?: string } = {}): AgentEvent {
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
const cutReason = (signal: AbortSignal) =>
  byRestart(signal) ? "interrupted: the server restarted (deploy) before this turn finished" : "interrupted by the user";

function ranSummary(ran: Map<string, number>): string {
  if (!ran.size) return "No tools ran in this run.";
  return `Tools that ran in this run: ${[...ran].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(", ")}.`;
}

// 被中断或失败的这一轮在转录里要有个结尾：已流出的文字照留（丢掉没签名的 thinking 与没收完的调用）
// 并注明原因；什么都没流出来时补一条只给模型看的边界。
function closeCutTurn(state: AgentState, text: string, reason: string, internal: boolean): void {
  // R16：被打断时留下的半截已经是循环（严格档）——循环的部分不进转录，免得下一轮重放又把模型带回循环
  if (isRunawayRepetition(text, true)) text = withLoopCut(text);
  if (text.trim()) {
    state.appendAssistant({ text: `${text}\n\n[${reason}]`, thinkingText: "", calls: [] }, internal);
  } else {
    state.appendAssistant({ text: `[${reason}]`, thinkingText: "", calls: [] }, true);
  }
}

// R16：截到循环开始处，再补一句标记
function withLoopCut(text: string): string {
  const kept = cutAtLoop(text);
  return `${kept}${kept ? "\n\n" : ""}${LOOP_CUT_NOTICE}`;
}

// ── V1（#19）：最终答复下的服务端验证回执 ─────────────────────────────────────
// 模型写的「测试全绿」旁边，摆着这一轮真正交出的证据：通过的检查、最后一次没通过的检查、
// VerificationAudit 的豁免理由。只在这一轮出了问题时出现（全部通过不附，10-07）；写进最终
// 那条 assistant 消息（刷新后还在），并在 done 之前补一个 text_delta（在线的客户端当场看到）。
const clipDetail = (d: string): string => {
  const one = d.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  return one.length > 140 ? one.slice(0, 140) + "…" : one;
};

// V2（#21）：只改了文档类文件（.md、.txt、图片…）不进验证门禁——没有可执行的东西可验。
const DOC_EXT_RE = /\.(?:md|markdown|mdx|txt|rst|adoc|asciidoc|org|csv|tsv|log|png|jpe?g|gif|webp|ico|bmp)$/i;
export const touchesCode = (files: Iterable<string>): boolean => [...files].some((f) => !DOC_EXT_RE.test(f));

// ── V5（#20）：门禁的「改过没有」不只认 Edit/Write ───────────────────────────────
// 以前派 coder 子 agent 改完、或者用 Bash 写了文件就收尾，门禁一次都不问（probe delegated-edit-gate、bash-write-gate）。
// 两路信号：① 调用自己报的——coder / Workflow 的 editedFiles、Bash 命令里明确写的路径（按调用的时刻记，与验证的
// 先后关系是准的）；② 影子 git：这一轮开跑时的快照到现在，工作区改了哪些文件（有会话、开着检查点时才有；
// 兜住 npm run format、脚本生成这类看不出写了什么的）。
function noteToolEdits(state: AgentState, call: { name: string; args: Record<string, unknown> }, res: ToolRunResult): void {
  const paths = [...(res.editedFiles ?? []), ...(state.toolMap.get(call.name)?.permissionView?.(call.args)?.edits ?? [])];
  if (!paths.length) return;
  const fresh: string[] = [];
  for (const raw of paths) {
    try {
      const abs = state.ctx.sandbox.resolve(raw);
      state.editedFiles.add(abs);
      fresh.push(abs);
    } catch {
      /* 工作区外 / 解析不了的路径：门禁管不到它 */
    }
  }
  // 只有改到代码才把「验过了」作废——写个日志、改个 README 不该让门禁重新追问
  if (touchesCode(fresh)) {
    state.recordMutation();
    noteKnowledgeEdit(state.ctx.sandbox.root);
  }
}

// 影子 git 看到的改动：这些改动发生在这一轮的某个时刻，和验证谁先谁后说不清——这一轮有过通过的验证，就当它
// 覆盖到了；一次都没有，才算「改了还没验」。
async function noteUnseenChanges(state: AgentState): Promise<void> {
  if (!state.changedSinceRunStart) return;
  let changed: string[] = [];
  try {
    changed = await state.changedSinceRunStart();
  } catch {
    return;
  }
  const fresh: string[] = [];
  for (const rel of changed) {
    try {
      const abs = state.ctx.sandbox.resolve(rel);
      if (!state.editedFiles.has(abs)) {
        state.editedFiles.add(abs);
        fresh.push(abs);
      }
    } catch {
      /* 凭据路径等解析会拒的：不进账 */
    }
  }
  if (touchesCode(fresh) && !state.runEvidence.some((e) => e.passed)) state.recordMutation();
}

// N26（HT3）：这次调用可能写过工作区——不是只读的；只删不写的破坏性命令不算（它毁掉的内容在它之前那张快照里）。
function mayHaveWritten(state: AgentState, call: { name: string; args: Record<string, unknown> }): boolean {
  const tool = state.toolMap.get(call.name);
  if (!tool || tool.effect === "read") return false;
  const view = tool.permissionView?.(call.args);
  return view?.effect !== "read" && !view?.onlyDestroys;
}

// 轮内快照在回滚面板上的名字：「执行 rm -rf src 之前」（命令只取第一行、截短）
function destructiveLabel(args: Record<string, unknown>): string {
  const line = String(args.command ?? "").trim().split(/\r?\n/)[0];
  return `执行 ${line.length > 40 ? line.slice(0, 40) + "…" : line} 之前`;
}

const RETRACT_REASON = "答复先撤回：改了代码，但还没有通过的验证，正在让它补跑检查";
// 撤回的那版答复模型自己的上下文里还在，它会以为用户看过了，收尾只写一句「验证通过」——用户那边正文就没了
// （实例：六千字分析被撤回，最后只剩「分析已完成。补充验证结果：……」）。追问里明说。
const RETRACTED_NOTICE =
  " Note: the reply you just wrote has been withdrawn from the user's view — they will NOT see it. When you finish, " +
  "your final reply must be complete and self-contained: restate the full answer, then add the verification results.";

export function verificationFootnote(state: AgentState): string | null {
  if (!state.finalFootnotes) return null;
  const lines: string[] = [];
  // V3（#33）：本轮到最后也没落地的编辑，服务端点名列出。
  if (state.failedEdits.size) {
    const items = [...state.failedEdits.values()].slice(0, 5).map((f) => `\`${clipDetail(f.display)}\`（${clipDetail(f.reason)}）`);
    const more = state.failedEdits.size > 5 ? ` 等 ${state.failedEdits.size} 处` : "";
    lines.push(`⚠️ 这些编辑没有落地：${items.join("、")}${more}`);
  }
  // V2：追问用尽放行、或预算用完收场时，代码改动仍没有通过的验证——服务端写明，模型去不掉。
  if (touchesCode(state.editedFiles) && state.dirtySinceVerify && !state.verificationAuditCompleted) {
    lines.push(
      `⚠️ 未验证：这一轮改了 ${state.editedFiles.size} 个文件，但没有通过的验证证据` +
        (state.verificationGateGaveUp ? `（门禁追问 ${MAX_VERIFICATION_AUDIT_NUDGES} 次后放行）` : "") +
        "，以上结论请自行核对。",
    );
  }
  const last = state.runEvidence.at(-1);
  if (last && !last.passed) lines.push(`最后一次检查没通过：❌ \`${clipDetail(last.detail)}\``);
  if (state.runAudit) lines.push(`没有可跑的验证（${state.runAudit.decision}）：${state.runAudit.reason}`);
  // K6（G4）：记忆审计门禁追问用尽放行——服务端写明，模型去不掉
  if (state.memoryAuditGaveUp) lines.push(`⚠️ 记忆审计：追问 ${MAX_MEMORY_AUDIT_NUDGES} 次仍没交，已放行——这一轮值得记住的事可能没记下来`);
  // 10-07：验收顺利就不打扰——通过的回执只在上面有问题时作为对照一起给，全绿不附尾注
  if (!lines.length) return null;
  const passed = [...new Set(state.runEvidence.filter((e) => e.passed).map((e) => clipDetail(e.detail)))].slice(-3);
  if (passed.length) lines.push(`通过的检查：${passed.map((d) => `✅ \`${d}\``).join(" · ")}`);
  return `\n\n> ${lines.join("\n>\n> ")}`;
}

// Q3：请求不变量在生产上只计数、首次告警一次，绝不抛（检查本身出错也只记一笔）。测试里违反即失败：
// 脚本化 provider 验每次输入，loopState 收尾核对这里的计数。
const INVARIANT_SAMPLES = 5;
function noteInvariants(state: AgentState, invariants: RunInvariants, turn: Turn): void {
  let problems: string[];
  try {
    problems = invariants.check(turn, state.systemRewrites);
  } catch (err) {
    problems = [`request invariant check crashed: ${(err as Error).message}`];
  }
  if (!problems.length) return;
  if (!state.invariantViolations) {
    const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : "";
    console.warn(`[agent] request invariant violated before sending: ${problems[0]}${more}`);
  }
  state.invariantViolations += problems.length;
  for (const p of problems) {
    if (state.invariantSamples.length >= INVARIANT_SAMPLES) break;
    if (!state.invariantSamples.includes(p)) state.invariantSamples.push(p);
  }
}

// 瘦身 P0-3：专章（playbook）按需注入——用户点名或工作碰到那块时追加一条 harness 消息，同一章在转录里还在就不重复。
// Muse：这台机器没有浏览器（Browser 工具没注册）时，网页章给 curl 版、桌面 / 安卓两章不给（与 prompt.ts 的 browser 开关一致）。
function attachPlaybooks(state: AgentState, picks: Playbook[], why: "request" | "work"): void {
  const browser = state.toolMap.has("Browser");
  for (const p of picks) {
    if (p.needsBrowser && !browser) continue;
    if (playbookLoadedIn(state.messages, p)) continue;
    state.appendUserBlocks([{ t: "text", text: playbookMessage(p, why, browser) }], false, { origin: "harness", kind: PLAYBOOK_KIND });
  }
}

// 这一轮用户本人说的话（最后一条不带来源的用户文本消息；续跑 / 目标续跑的轮里是更早那条，重复注入由去重挡住）
function ownRequestText(messages: readonly Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || messageKind(m) !== null || m.content.some((b) => b.t === "tool_result")) continue;
    return m.content.flatMap((b) => (b.t === "text" ? [b.text] : [])).join("\n");
  }
  return "";
}

// 尾注接在最终答复最后一段正文后面；这一轮没有正文时单独成一条 assistant 消息。
function attachFootnote(state: AgentState, target: Msg | null, note: string): void {
  if (target?.role === "assistant") {
    for (let i = target.content.length - 1; i >= 0; i--) {
      const block = target.content[i];
      if (block.t === "text") {
        target.content[i] = { t: "text", text: block.text + note };
        return;
      }
    }
  }
  state.appendAssistant({ text: note.trimStart(), thinkingText: "", calls: [] });
}

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
    for (const steer of steers) {
      state.appendUserBlocks([{ t: "text", text: STEER_PREFIX + steer.text }], false, { origin: "steer", displayText: steer.text });
      yield { e: "steer_applied", text: steer.text, id: steer.id };
      // E3：这条插话是 /技能名——技能正文紧跟在插话后面
      if (steer.attach) {
        state.appendUserBlocks([{ t: "text", text: steer.attach.text }], false, { origin: "harness", kind: steer.attach.kind });
        yield { e: "skill_loaded", name: steer.attach.name, via: "slash", ...(steer.attach.pkg ? { pkg: true } : {}) };
      }
      attachPlaybooks(state, playbooksForRequest(steer.text), "request");
    }
    // #78：审计前那句收尾答复是对插话之前的对话说的，插话一进来它就不再是最终答复。以前模型下一轮只交了
    // MemoryAudit，loop 就拿那句旧话收工——插话被注入了，却没人回应（Q1 的严格脚本化测试照出来的）。
    if (steers.length) pendingPreAuditFinal = null;

    // U3：到线了就先说一声再整理（整段压缩的摘要请求可能要几十秒，以前压完才有一条提示）
    if (contextNeedsTrim(state)) yield { e: "compact_start" };
    const fit = await ensureContextFits(state, signal);
    yield { e: "context", usedTokens: fit.used, limitTokens: fit.limit, compacted: fit.compacted };
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
    let thinkingSig: string | undefined;
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
    const MAX_ATTEMPTS = RETRY_ATTEMPTS;
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
    // R3（#39）：第二本账。零字节的连接失败不消耗 MAX_ATTEMPTS，等网络回来。
    let netWait: NetWait | null = null;
    let waitedForNetwork = false;
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
      thinkingSig = undefined;
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
        const turn = state.toTurn();
        // R9：输入 + 输出上限不能超过窗口（Anthropic、llama.cpp 等会直接拒）——离窗口边缘不远时，按剩下的地方夹住这一次的
        // 输出上限（留一点估算误差，至少给 1024）。小窗口模型在逼近窗口时正是这个区间：还没到主动压缩线，请求已被拒。
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
              if (!auditContinuationCandidate) yield { e: "text_delta", text: ev.text };
              break;
            case "thinking_delta":
              if (ev.text) {
                thinkingText += ev.text;
                if (!auditContinuationCandidate) yield { e: "thinking_delta", text: ev.text };
              }
              if (ev.signature) thinkingSig = ev.signature;
              break;
            case "tool_call_begin":
              // U3：模型开始写这个工具调用的参数（活动行不再停在上一个工具的动词上）
              if (!auditContinuationCandidate) yield { e: "tool_call_begin", id: ev.id, name: ev.name, chars: ev.chars };
              break;
            case "tool_call":
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
          errRetriable = emptyRetries < EMPTY_RESPONSE_RETRIES;
          if (errRetriable) emptyRetries++;
        }
        // R7：provider 说超窗 / 请求体过大——先压一次再发（每轮最多一次）；上一轮刚为这个压过、这一轮又超，是
        // rapid refill：停下来报错，不在循环里反复压。
        if (errored && errCompress && !text && !calls.length) {
          // 上一轮刚为超窗压过（同一轮里的重复由 reactiveThisTurn 管）
          const refill = !reactiveThisTurn && state.lastReactiveCompactTurn !== null && state.runTurns - state.lastReactiveCompactTurn === 1;
          if (!reactiveThisTurn && !refill) {
            reactiveThisTurn = true;
            state.lastReactiveCompactTurn = state.runTurns;
            if (await compactNow(state, signal)) {
              yield { e: "context", usedTokens: state.lastContextTokens, limitTokens: fit.limit, compacted: true };
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
        if (errored && errRetriable && attempt < MAX_ATTEMPTS - 1) continue;
        break; // stream drained cleanly (may still carry an `error` event)
      } catch (e) {
        streamThrew = e;
        // Retry only network-level throws; an abort is intentional, stop now.
        if (signal.aborted) {
          closeCutTurn(state, text, cutReason(signal), auditContinuationCandidate);
          yield abortedEvent(signal);
          return;
        }
        if (!sawEvent && isConnectFailure(e)) {
          if (!netWait) nudgeOutboundProxy(); // 首次命中：让出站探测立刻重探，不等 60s 周期
          waitPlan = planWait(netWait, state.deadlineAt, connectErrorLabel(e));
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
    state.appendAssistant({ text, thinkingText, thinkingSig, calls }, internalAuditTurn);
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
      if (stop === "length" && !state.budgetExhausted && state.lengthContinues < MAX_LENGTH_CONTINUES) {
        // R16：续写之前先看正文——已经退化成循环（宽松档）就不续写：转录里截到循环开始处、补一句标记，这一轮收工
        if (isRunawayRepetition(text)) {
          const block = appendedAssistant?.content.find((b) => b.t === "text");
          if (block && block.t === "text") block.text = withLoopCut(text);
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
        stop === "end" &&
        !text.trim() &&
        thinkingText.trim() &&
        !internalAuditTurn &&
        !state.budgetExhausted &&
        state.answerNudges < MAX_ANSWER_NUDGES
      ) {
        state.answerNudges++;
        // 计数进会话 trace（诊断永不影响主链路：traceEvent 自己吞错）
        if (state.ctx.ownerId) traceEvent(state.ctx.ownerId, { e: "answer_nudge", thinkingChars: thinkingText.length });
        state.appendUserBlocks([{ t: "text", text: ANSWER_NUDGE }], true, { origin: "harness", kind: "answer-nudge" });
        continue;
      }
      // Done-gate: one structural nudge per user message, on either miss —
      // edits landed but nothing was run at all, OR test files that reference
      // the edited modules were never exercised (the "ran test_concat but not
      // test_combine" regression trap). Skipped once the budget is exhausted.
      // V5：要收尾了——先把影子 git 看到、调用自己没报的改动补进账
      if (stop === "end" && !state.budgetExhausted && !state.verificationGateGaveUp) await noteUnseenChanges(state);
      if (stop === "end" && !state.budgetExhausted && !state.verificationGateGaveUp && touchesCode(state.editedFiles)) {
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
          // 挂一张红卡、这一轮算失败；现在交付那一版，尾注写明没交审计（弱模型三次不交是常事）。
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
            ? `Not executed: ${DENIALS_BEFORE_STOP} actions in a row were not approved. Give your final answer.`
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
    // Read/Grep/Glob/…) executes in parallel, at most MAX_PARALLEL_TOOLS at a
    // time; anything effectful runs serially, in call order. Results always
    // land in call order.
    const results: Block[] = [];
    const feedback: Block[] = [];
    const skills: { name: string; text: string }[] = []; // C5：这一批里加载的技能正文，工具结果之后各追加一条
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

      let end = idx + 1;
      if (state.toolMap.get(calls[idx].name)?.concurrencySafe) {
        while (end < calls.length && end - idx < MAX_PARALLEL_TOOLS && state.toolMap.get(calls[end].name)?.concurrencySafe) end++;
      }
      const batch = calls.slice(idx, end);
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
        batch.map(async (rawCall) => {
          // P14（ZCode C6）：按工具声明的 schema 宽松归一化入参（只做强制转换、不做拒绝）；转录里的原始参数不动，
          // 归一化后的只用于权限判定与执行（以及之后的门禁记账）
          const normalized = normalizeToolArgs(state.toolMap.get(rawCall.name)?.def.parameters, rawCall.args);
          const call = normalized.changed.length ? { ...rawCall, args: normalized.args } : rawCall;
          // Arguments that never parsed as JSON: don't run the tool with {} —
          // feed the parse error back so the model can re-issue the call.
          if (call.argsError) {
            return {
              call,
              denied: undefined,
              res: fail(
                "bad tool arguments",
                `The arguments for ${call.name} were not valid JSON (${call.argsError}). ` +
                  `Raw arguments received:\n${call.argsRaw || "(empty)"}\n` +
                  "Re-issue the tool call with complete, valid JSON arguments.",
              ),
            };
          }
          // A name the registry doesn't know (hallucinated or mangled): tell the
          // model what IS available instead of a confusing permission denial.
          if (!state.toolMap.has(call.name)) {
            return {
              call,
              denied: undefined,
              res: fail(
                "unknown tool",
                `Unknown tool "${call.name}". Available tools: ${[...state.toolMap.keys()].join(", ")}.`,
              ),
            };
          }
          // P11（kimi K20）：出卡之前的规划阶段——注定失败的（硬拒的命令、编不过的工作流）不弹卡、直接回给模型；工具要求
          // 确认的（Workflow 启动）进统一权限闸；卡片上的执行事实优先用工具自己给的。抛错按「没有」处理。
          let prepared: PreparedCall | null = null;
          const prepare = state.toolMap.get(call.name)?.prepare;
          if (prepare) {
            try {
              prepared = await prepare(call.args, callContext(state.ctx, call.id));
            } catch {
              prepared = null;
            }
          }
          if (prepared?.veto) return { call, denied: undefined, res: fail(prepared.veto.summary, prepared.veto.content) };
          // P6：Bash 的写目标 / 提到的路径（路径规则与拒绝台账按它判）；工作区根用来把各种写法的路径归一
          const view = state.toolMap.get(call.name)?.permissionView?.(call.args) ?? null;
          const root = state.ctx.sandbox.root;
          let decision = decide(
            state.effectiveMode(),
            call.name,
            state.toolMap,
            call.args,
            state.effectiveRules(), // P1：全局规则现读 + 还算数的本会话允许
            { root, denied: state.deniedTargets, ...(prepared?.confirm ? { confirm: prepared.confirm } : {}) },
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
                decidedBy = "user";
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
              const ctx = callContext(state.ctx, call.id);
              if (sandbox) ctx.sandbox = sandbox;
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
        if (verdict.stop && !guardStop && state.ctx.humanAttended?.() === false) guardStop = verdict.stop;
      }
    }

    state.appendToolResults(results, internalAuditTurn);
    if (guardStop) {
      state.budgetExhausted = true;
      state.loopGuardStopped = true;
      state.appendUserBlocks([{ t: "text", text: loopStopText(guardStop) }], true, { origin: "harness", kind: "loop-guard" });
    } else if (state.consecutiveDenials >= DENIALS_BEFORE_STOP && !state.budgetExhausted) {
      // P6（N16）：连着几次都没被批准，再试下去只是换着花样碰同一堵墙——收尾轮交代清楚，由人决定
      state.budgetExhausted = true;
      state.denialsStopped = true;
      state.appendUserBlocks([{ t: "text", text: DENIALS_STOP_TEXT }], true, { origin: "harness", kind: "permission-stop" });
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
      !(!state.verificationGateGaveUp && touchesCode(state.editedFiles) && (await buildVerifyNudge(state)))
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
    // #98：审计已经落定，模型还一轮接一轮地只交审计（不说话、不干活）——弱模型卡住时会这样；用户在界面上只看到活动行一直是
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
        ...(await Promise.all(feedback.map(downsampleForModel))),
      ], false, { origin: "harness", kind: "tool-attachments" });
    }
    // C5（K57）：技能正文不放 tool_result（微压缩只清旧工具输出），紧随其后作为一条 harness 消息
    for (const skill of skills) {
      state.appendUserBlocks([{ t: "text", text: skill.text }], false, { origin: "harness", kind: "skill" });
    }
    // 瘦身 P0-3：这一轮的调用碰到了某块（写了网页文件、起了 Preview、跑了 adb……）——那一章紧跟在结果后面
    attachPlaybooks(state, playbooksForCalls(calls), "work");

    // The plan drifts out of the model's attention over a long run (and dies in
    // a compaction). Periodically re-show the current todo list — on the next
    // request only (瘦身 P0-2: not persisted, so stale copies never pile up).
    state.turnsSinceTodoSeen++;
    const openTodos = state.todos.some((t) => t.status !== "completed");
    if (openTodos && state.turnsSinceTodoSeen >= TODO_REMIND_TURNS) {
      state.turnsSinceTodoSeen = 0;
      state.ephemeralTail = renderTodoReminder(state.todos);
    }
  }
}

// P14（ZCode C5）：权限判定审计。每次不是「默认放行」的判定记一行进会话的 trace JSONL（e: permission_decision）：工具、
// 判定对象（trace-log 会截断、脱敏）、档位、第一判与最终结果、结构化来源与规则、最后是谁定的（规则 / 用户 / 没人在场 /
// 超时 / 离开模式 / 撤回）、批准的范围。诊断永不影响主链路：traceEvent 自己吞错。
type PermissionAuditBy = "rule" | "user" | "unattended" | "timeout" | "away" | "withdrawn";
// P13（X18，Codex「被沙箱拒了 → 问要不要放行 → 重跑」）：越界只读的审批卡。选项同一张权限卡：允许这一次（这次调用
// 带着放行重跑）/ 本会话都允许（这些目录记成本会话的只读目录，随会话落盘，之后同目录的读不再问）/ 拒绝（原失败照旧，附一句）。
// 离开模式、超时没人批，按没批准处理（registerPermission 自己会这样落定）。
export const OUTSIDE_READ_RULE = "outside-read";
async function askOutsideRead(
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
  auditPermission(state, call, initial, { effect: "allow", reason: "" }, "user", verdict.decision === "session" ? "session" : "once");
  if (verdict.decision === "session") state.grantReadRoots(dirs);
  try {
    return await runWith(verdict.decision === "session" ? undefined : state.ctx.sandbox.withReadRoots(dirs));
  } catch (e) {
    return fail("tool error", `${call.name} threw: ${(e as Error).message}`);
  }
}

function auditPermission(
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
function callContext(ctx: ToolContext, callId: string): ToolContext {
  return Object.assign(Object.create(ctx) as ToolContext, { callId });
}

// K9（X55）：会把外部内容（网页、搜索结果、浏览器里的页面、别的程序的界面）带进会话的工具。本会话真调过其中之一
// ——成没成都算，WebFetch 遇到 4xx / 5xx 照样带回页面正文——之后 Remember 想存成 active 的，一律先存成 proposed 等用户确认：
// 网页里写着的错误事实或注入，不能被模型自己写成以后每个会话都信的记忆。子 agent / Workflow 读过的，由它们的结果带上来。
const EXTERNAL_CONTENT_TOOLS = new Set(["WebFetch", "WebSearch", "Browser", "ReadPage", "Eval", "Network", "LocalPCInspect"]);
// Bash 里直接抓网页同理：curl / wget、PowerShell 的 Invoke-WebRequest / Invoke-RestMethod 与别名 iwr / irm。只认命令位置
// （开头、管道 / 分隔符 / 子命令 / 赋值之后），`grep -r wget docs/` 这种当参数的不算。
const FETCH_COMMAND_RE = /(?:^|[;&|(\n`=]|\$\()\s*(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(?:\.exe)?(?=[\s;&|)]|$)/im;

function readsExternal(call: { name: string; args: Record<string, unknown> }): boolean {
  if (EXTERNAL_CONTENT_TOOLS.has(call.name)) return true;
  // E1：MCP 连接器是别人的程序 / 服务，回来的都算外部内容
  if (call.name.startsWith("mcp__") || call.name === "McpCall" || call.name === "McpDescribe") return true;
  return call.name === "Bash" && FETCH_COMMAND_RE.test(String(call.args.command ?? ""));
}

export function bringsExternalContent(call: { name: string; args: Record<string, unknown> }, res: ToolRunResult, invoked: boolean): boolean {
  return res.externalContent === true || (invoked && readsExternal(call));
}

// 恢复 K9 之前写的会话：转录里出现过这类调用就算（被拒的也算——转录里分不清，宁可多标；压缩掉的推不出来）
export function transcriptReadExternal(messages: readonly Msg[]): boolean {
  return messages.some((m) => m.content.some((b) => b.t === "tool_call" && readsExternal(b)));
}

// Cache for the reverse-dependency scan below, which walks the whole workspace.
// Both done-gate paths (the no-tool stop and the audit-closure early finish) call
// buildVerifyNudge, so a single run used to pay for two full scans of a large
// repo. The scan is a pure function of (root, editedFiles, ranCommands) — key on
// those and reuse while they are unchanged.
let revdepCache: { key: string; files: string[] } | null = null;

async function scanUncovered(state: AgentState): Promise<string[]> {
  // 键用 JSON.stringify：无需自造分隔符（早先版本用不可见控制字符当分隔符，
  // 结果 git 把整个文件当二进制，diff/grep 全失效）。
  const key = JSON.stringify([
    state.ctx.sandbox.root,
    [...state.editedFiles].sort(),
    [...state.ranCommands].sort(),
  ]);
  if (revdepCache?.key === key) return revdepCache.files;
  const files = await uncoveredReferencingTests(
    state.ctx.sandbox.root,
    state.editedFiles,
    state.ranCommands,
  );
  revdepCache = { key, files };
  return files;
}

// Decide what (if anything) to nudge with when the model stops after editing.
// Never throws — the scan is a best-effort heuristic.
async function buildVerifyNudge(state: AgentState): Promise<string | null> {
  if (state.verificationAuditCompleted) return null;
  let uncovered: string[] = [];
  try {
    uncovered = await scanUncovered(state);
  } catch {
    // fall through — the dirty check below still applies
  }
  const list = uncovered.slice(0, REVDEP_REPORT_MAX).join(", ");
  const more = uncovered.length > REVDEP_REPORT_MAX ? ` (+${uncovered.length - REVDEP_REPORT_MAX} more)` : "";

  if (state.dirtySinceVerify) {
    // Same gate either way — only the accusation changes. Telling a model that
    // just ran a passing build "you have no verification evidence" reads as a
    // false report and teaches it to distrust the gate.
    const undeclared = state.undeclaredEvidence.slice(-2).join(" | ");
    const head = undeclared
      ? `${VERIFY_UNDECLARED_NUDGE} Commands that ran clean but were never declared: ${undeclared}.`
      : VERIFY_NUDGE + (state.lastVerification ? ` Last requested verification: ${state.lastVerification}.` : "");
    return head + (uncovered.length ? ` Start with the test files that reference what you changed: ${list}${more}.` : "");
  }
  if (uncovered.length) {
    return (
      `[Automated check] These test files reference modules you edited but were never run: ${list}${more}. ` +
      "Callers often depend on exact behavior, so your change may break them. Run them now and fix any failures before finishing."
    );
  }
  return null;
}

function renderTodoReminder(todos: TodoItem[]): string {
  const lines = todos.map(
    (t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content}`,
  );
  return (
    `[Reminder — your current todo list]\n${lines.join("\n")}\n` +
    "Continue the in_progress item. Keep the list up to date with TodoWrite; mark items completed as soon as they are done."
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function renderRaw(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw.slice(0, 800);
  try {
    return JSON.stringify(raw).slice(0, 800);
  } catch {
    return String(raw);
  }
}
