// 主循环的阈值、harness 自己的提示语、重试退避与这一轮的预算。
import type { AgentState } from "../state.ts";

// Re-show the todo list after this many tool turns without the model seeing it
// (a TodoWrite call or an earlier reminder); compaction forces an immediate one.
export const TODO_REMIND_TURNS = 5;

export const RAN_COMMANDS_CAP = 300;
export const REVDEP_REPORT_MAX = 6;

// Tools whose per-call chrome (tool_start / tool_permission / tool_end) is never
// forwarded to the frontend. MemoryAudit is an internal lifecycle checkpoint;
// AskUserQuestion drives its own dedicated ask/ask_answer event + card, so the
// generic tool row would be a confusing duplicate. The tool still runs and its
// result still lands in the transcript — only the visible events are hidden.
const SILENT_TOOLS = new Set(["MemoryAudit", "AskUserQuestion"]);
export const isSilentTool = (name: string): boolean => SILENT_TOOLS.has(name);

// Memory bookkeeping the model can legitimately batch onto its final answer:
// nothing here produces a result the answer still depends on. A turn made up
// only of these, next to real answer text, is already a finished reply.
export const AUDIT_CLOSURE_TOOLS = new Set(["MemoryAudit", "Remember"]);

// Text that merely ANNOUNCES the call it rides with ("执行强制审计收尾：",
// "Saving the checkpoint:") is a preamble, not an answer — a turn that ends on
// a colon is promising more output, so it must never be mistaken for a
// finished reply (see the audit-closure early finish below).
export const announcesMore = (text: string): boolean => /[:：]\s*$/.test(text.trim());

// 10-10 实测：MiMo 正文停在「……重来一遍，逐」、工具调用没发出来，provider 却报正常结束（finish_reason=stop，
// usage 也到了），这一轮就当答完收了尾——待办还挂着 in_progress，用户看到的是「干一半断了」。正式服另有 Strata、
// OpenAI 各一例同样断在半个字上。偏保守：只在待办还有没做完时判（那是模型自己说过活没干完），且最后一行是普通段落
// （不是列表 / 标题 / 表格 / 代码）：结尾是逗号顿号冒号；或结尾是汉字 / 字母、而这一行前面已经有过标点（写到一半的
// 长句）——「好的」「做完了」这种不带句号的短答是常事，不算。
export function looksCutOff(text: string, openTodos: boolean): boolean {
  const body = text.trimEnd();
  if (!openTodos || !body || /```\s*$/.test(body)) return false;
  const last = body.slice(body.lastIndexOf("\n") + 1).trim();
  if (!last || /^([-*+>|#]|\d+[.)]\s)/.test(last)) return false;
  if (/[，、,:：]$/.test(last)) return true;
  return /[\u4e00-\u9fffA-Za-z]$/.test(last) && /[。，、；！？,.;!?]/.test(last);
}

// Marks a mid-run insertion so the model can tell it apart from the original
// task ("the user is talking to me right now"), and knows a correction here
// overrides earlier instructions rather than adding a second task.
export const STEER_PREFIX =
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

export const MAX_LENGTH_CONTINUES = 3;
export const LENGTH_CONTINUE_NUDGE =
  "[Automated check] Your previous reply was cut off by the output-token limit mid-response. " +
  "Continue exactly where you stopped — do not repeat what you already wrote. " +
  "If you were about to call tools, issue those tool calls now.";
// R19（hermes N23 的 reasoning-only 分流）：这一轮只写了思考、一个字的答复都没有就要收尾——用户那头只看得见一段思考。
// 正式服 1825 次模型回合里出现过 2 次，其中一次就这样收了尾（用户看到八千多字的思考、没有答复）。追问这么多次，还是没有就照旧收尾。
export const MAX_ANSWER_NUDGES = 1;
export const ANSWER_NUDGE =
  "[Automated check] Your last turn contained only reasoning — nothing reached the user. " +
  "Write your reply to the user now (do not repeat the reasoning). " +
  "If you meant to call tools, issue those tool calls now.";
// 正文断在半句、却报了正常结束（见 looksCutOff）——追一句接着干。每条用户消息最多两次，追问不进聊天记录。
export const MAX_CUTOFF_NUDGES = 2;
export const CUTOFF_NUDGE =
  "[Automated check] Your previous reply stopped mid-sentence and no tool call came through. " +
  "Continue exactly where you stopped — do not repeat what you already wrote. " +
  "If you were about to call tools, issue those tool calls now.";

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

export const UNDECLARED_EVIDENCE_CAP = 3;
export const MAX_MEMORY_AUDIT_NUDGES = 3;
export const MAX_VERIFICATION_AUDIT_NUDGES = 3;

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
export const AUDIT_LIFECYCLE_TOOLS = new Set(["MemoryAudit", "Remember", "Recall"]);
export const REDUNDANT_AUDIT_TURNS = 4;
export const REDUNDANT_AUDIT_MESSAGE =
  "redundant_audit_loop: the memory audit was already completed, but the model kept re-submitting audit calls without answering — the run was stopped";
// R17（B8）：一批并行的只读调用最多这么多个——模型一轮发几十个 Read / Grep 时不再同时起几十个（Grep 各占一个 worker 线程）
export const MAX_PARALLEL_TOOLS = 8;
export const OUTPUT_ROOM_MARGIN = 1_000; // R9：夹输出上限时给估算误差留的余量
export const MIN_OUTPUT_TOKENS = 1_024;
const BACKOFF_BASE_MS = 500;
const RATE_LIMIT_WAIT_MS = 15_000;
const RETRY_WAIT_CAP_MS = 60_000;

export interface RetryWhy {
  retryAfterMs?: number; // provider 自己说的等多久
  rateLimited?: boolean;
}

// 测试把节奏整体调快（逻辑不变），与 netwait 的 DIMENSIO_NET_WAIT_BASE_MS 同一个做法。
export const retryScale = (): number => {
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

export function budgetStatus(state: AgentState): BudgetStatus {
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

export const budgetNudgeText = (b: BudgetStatus) =>
  `[Budget] Most of this run's budget is used (${b.detail}). Converge now: finish the essential ` +
  "change, run the final verification, and wrap up. Do not start new explorations or side quests.";

export const budgetExhaustedText = (b: BudgetStatus) =>
  `[Budget exhausted] This run's budget is used up (${b.detail}). Stop working NOW. Reply with a ` +
  "concise final summary of what you did, what is verified, and what (if anything) remains. " +
  "Further tool calls will NOT be executed.";
