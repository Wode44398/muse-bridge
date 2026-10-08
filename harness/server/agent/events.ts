import type { Block, RecallRef, ThinkingLevel } from "./turn.ts";
import type { ApprovalPreview } from "../tools/types.ts";
import type { GoalState } from "../goal.ts";

// Why an agent stops a turn.
export type StopReason = "end" | "tool_use" | "length" | "refusal";

// ── Provider stream events (adapter output, §2 出向) ─────────────────────────
// The narrow contract every adapter's stream() emits. tool_call is accumulated
// to a complete args object before being emitted (no per-arg deltas) — three
// providers format function-call deltas differently and nobody needs to watch
// arguments stream in character by character. Only text/thinking stream.
export type StreamEvent =
  | { e: "text_delta"; text: string }
  | { e: "thinking_delta"; text: string; signature?: string }
  // U3（X38、#52）：模型开始写一个工具调用（适配器一知道工具名就发）；之后按时间节流报「参数已经写了多少字」。
  // 模型花两三分钟生成一个大文件的 Write 参数时，活动行以前一直停在上一个工具的动词上。Gemini 整块返回，不发。
  | { e: "tool_call_begin"; id: string; name: string; chars: number }
  // argsError/argsRaw: set when the provider streamed argument JSON that did not
  // parse (truncation, malformed output). The loop turns this into a tool_result
  // error the model can act on, instead of running the tool with empty args.
  // meta: provider replay state (e.g. Gemini thoughtSignature) that must be
  // stored on the transcript's tool_call block and echoed back on encode.
  | {
      e: "tool_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
      argsError?: string;
      argsRaw?: string;
      meta?: Record<string, unknown>;
    }
  // Q4：inputTokens 是整个提示的量（含命中缓存的部分）；cacheReadTokens / cacheWriteTokens 是其中读自缓存 /
  // 写入缓存的量——provider 回报了才有（llama.cpp 兼容服务回报的是复用的 KV 量，记作读取）。
  | { e: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { e: "turn_done"; stopReason: StopReason }
  // retryAfterMs: parsed from a Retry-After header on an HTTP-level error, so
  // the loop's retry can honor the provider's own pacing instead of a blind backoff.
  // R7：class / compress / summary / upstream 来自 providers/classify.ts——错误类别、要不要先压缩上下文再试、
  // 一句人话、上游关联头（request-id、cf-ray、server）。
  | {
      e: "error";
      kind: string;
      retriable: boolean;
      raw?: unknown;
      retryAfterMs?: number;
      class?: string;
      compress?: boolean;
      summary?: string;
      upstream?: string;
    };

// ── Agent events (loop output, forwarded to the frontend over SSE) ───────────
// A superset of StreamEvent with the loop's own lifecycle + tool visibility.
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

// ── AskUserQuestion (human-in-the-loop) ──────────────────────────────────────
// The AskUserQuestion tool blocks the loop and emits an `ask` event; the user's
// answer arrives out-of-band (POST /answer) and unblocks it. One tool call can
// pose up to a few questions, each with its own options. `id` inside a question
// is "<askId>:<index>" so the frontend can key selections per question.
export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
}
// One answered question: the labels the user chose (custom free-text rides here
// too, flagged by `custom`), matched back to options by the frontend.
export interface AskAnswer {
  questionId: string;
  selected: string[];
  custom: boolean;
}

// P10（D9）：卡片是在哪台设备上定的——客户端自报的设备 id 与标签（「手机」「电脑」）。只用来让别的设备显示
// 「在手机上拒绝了」，不做鉴权（鉴权在 bridge）。
export interface DecidedBy {
  id: string;
  label: string;
}

export type AgentEvent =
  | { e: "turn_start"; index: number }
  // U3（X38、#52）：活动行说真话。tool_call_begin = 模型正在写这个工具调用的参数（chars 节流上报，只发给在看的设备、
  // 不进 runLog）；compact_start = 上下文到线了、开始整理（整段压缩的摘要请求可能要几十秒，以前压完才有一条提示）；
  // run_clock = 服务端记的运行计时：本轮开跑时刻、卡片挂着（在等人）累计的暂停、此刻是否在暂停，serverNow 供客户端
  // 校正时钟差——附着时重放末尾会补一份「此刻」的（重放出来的旧计时事件时间戳不可信）。
  | { e: "tool_call_begin"; id: string; name: string; chars: number }
  | { e: "compact_start" }
  | { e: "run_clock"; startedAt: number; pausedMs: number; pausedSince: number | null; serverNow: number }
  // O7：目标续跑的状态（开跑时一次、每轮收尾时一次、界面暂停 / 继续 / 结束时一次；null = 目标结束了）
  | { e: "goal"; goal: GoalState | null }
  // The just-streamed no-tool turn tried to finish while a lifecycle gate was
  // still open. Clients must remove only that turn's provisional UI; the raw
  // provider transcript keeps it as internal context for the continuation.
  // reason（V2）：为什么撤回，客户端显示在活动行里（以前答复凭空消失，用户不知道发生了什么）。
  | { e: "turn_discard"; index: number; reason?: string }
  | { e: "text_delta"; text: string }
  | { e: "thinking_delta"; text: string }
  | { e: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  // R14（K37）：运行中的前台 Bash 的实时尾行（每秒最多一次；只发给在看的设备，不进 runLog、不落盘）。canBackground = 可以点
  // 「转后台」（POST /api/sessions/:id/tools/:callId/background）。
  | { e: "tool_progress"; id: string; tail: string; elapsedMs: number; canBackground?: boolean }
  | { e: "tool_permission"; id: string; name: string; decision: "allow" | "deny"; reason: string }
  // ── Fine-grained permission (a rule routed this call to the user) ──────────
  // The run blocks on `permission_ask` until POST /permission resolves it, then
  // `permission_resolved` fans out to every device. Replayed from runLog on
  // reconnect, exactly like the ask card.
  | {
      e: "permission_ask";
      id: string;
      tool: string;
      subject: string;
      rule?: string;
      // P7：到这个时刻（epoch ms）还没人批就按拒绝处理（fail-closed）
      deadlineAt?: number;
      // P5：「本会话都允许」会记下的规则原文；可选的「按前缀允许」规则（服务端算好、已自测）
      sessionRules?: string[];
      prefixRules?: string[];
      // S12：控制面文件——只能「允许这一次」，卡片不给「本会话都允许」
      noSession?: boolean;
      // P11（ZCode C1 / C2）：给人看的中文原因；这次要执行的事实（命令、diff、写入内容、工作流脚本）
      why?: string;
      preview?: ApprovalPreview;
    }
  // P10（D9）：by = 在哪台设备上定的（客户端自报，只用来显示「在手机上拒绝了」）；note = 拒绝时附的话
  | { e: "permission_resolved"; id: string; decision: "once" | "session" | "deny" | "deny_stop"; scope?: "prefix"; by?: DecidedBy; note?: string }
  // ── Plan mode ─────────────────────────────────────────────────────────────
  // The agent submitted a plan (ExitPlanMode) and is blocked on approval.
  // P7：deadlineAt = 到这个时刻（epoch ms）还没人审，就按超时落定（保持 plan、以计划收尾）
  | { e: "plan_ask"; id: string; plan: string; deadlineAt?: number }
  | { e: "plan_resolved"; id: string; approved: boolean; note?: string; handoff?: boolean; by?: DecidedBy }
  // The session's permission mode changed at runtime (plan approved → auto), so
  // every attached device can update its mode indicator.
  | { e: "mode"; permissionMode: "auto" | "read-only" | "plan" }
  | {
      e: "tool_end";
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      content: Block[];
      // U8（kimi K36）：工具行第二行的结果（中文、只说结果）
      outcome?: string;
    }
  | {
      e: "usage";
      inputTokens: number;
      outputTokens: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      // Q12：这次模型调用从第一次发出到落定花了多久（含重试的退避、等网络）；一共发了几次（1 = 没重试）
      durationMs?: number;
      attempts?: number;
    }
  // R3：waiting = 这次不是重试计数，而是在等网络恢复；waitedMs 是这一段已经等了多久。
  // U6：retryInMs / retryClass = 这次重试前要等多久、上一次为什么失败（分类器的类别；连接断了是 network）——只进活动行
  | {
      e: "context";
      usedTokens: number;
      limitTokens: number;
      compacted: boolean;
      retry?: number;
      retryInMs?: number;
      retryClass?: string;
      waiting?: "network";
      waitedMs?: number;
    }
  | { e: "todo"; items: TodoItem[] }
  // Preview pane control, pushed by the Preview tool via ToolRunResult.events.
  // publicUrl = tunnel-backed https URL (pv-<token>.<domain>) any device can
  // open directly; absent when PV_PUBLIC_DOMAIN isn't configured.
  | { e: "preview"; url: string; frameUrl: string; port: number; serviceId: string; publicUrl?: string }
  | { e: "preview_closed"; serviceId: string }
  // The agent's shared browser moved somewhere — the frontend opens/updates the
  // live Browser pane (screencast) on this.
  | { e: "browser"; url: string }
  // A headless screenshot of the preview, optionally with a multimodal model's
  // text verdict. Pushed by the Preview tool's screenshot action so the user can
  // see what the agent "looked at".
  // R12（二，K31）：asset = 会话资产 id（界面按 URL 取，事件流里不再带 base64）；没有会话时才退回 dataUri。
  | { e: "screenshot"; dataUri?: string; asset?: string; url: string; serviceId?: string; verdict?: string }
  // The agent asked the user to choose. The run blocks until POST /answer
  // resolves it (see session.answerAsk). Replayed from runLog on reconnect.
  // P7：deadlineAt = 到这个时刻（epoch ms）还没人答，就按合理假设继续
  | { e: "ask"; id: string; questions: AskQuestion[]; deadlineAt?: number }
  // The pending ask was answered (by any attached device) — mirrors update and
  // the originating stream gets confirmation. Carries the resolved selections.
  | { e: "ask_answer"; id: string; answers: AskAnswer[]; by?: DecidedBy }
  // M1（#26）：挂着的问答 / 权限 / 计划卡没等到人（停止或 run 结束）就作废了——所有设备收起交互态。
  // P3（#6）：离开模式开 / 关（手动，或用户发了新消息 / 插话自动关）——所有设备同步开关状态。
  | { e: "away"; away: boolean }
  // P13（X18）：本会话放行的工作区外只读目录变了（卡片上「本会话都允许」、档位菜单里删掉一个）
  | { e: "read_roots"; roots: string[] }
  // 本会话换了型号 / 思考深度（任一设备在型号菜单里换的；运行中的这一轮不受影响，下一条消息起生效）
  | { e: "model"; model: string; thinking: ThinkingLevel }
  // P7：reason "timeout" = 倒计时到了没人处理（这一轮还在继续）；没有 reason = 停止 / run 结束
  | { e: "ask_cancelled"; id: string; reason?: "timeout" }
  | { e: "permission_cancelled"; id: string; reason?: "timeout" }
  | { e: "plan_cancelled"; id: string; reason?: "timeout" }
  // Steering: the user sent a message while the run was in flight. `steer_queued`
  // is emitted by the API the moment it lands (so every attached device shows the
  // insertion immediately, even mid-turn); `steer_applied` when the loop actually
  // injects it at a turn boundary.
  // U2（#46）：id 由发起插话的客户端生成（旧客户端不带时服务端补），客户端按它去重 / 落位 / 撤回。
  | { e: "steer_queued"; text: string; id?: string }
  | { e: "steer_applied"; text: string; id?: string }
  // M3（#27、#45）：run 结束时还没送进模型的插话——退回客户端放回输入框，不留到下一轮。
  | { e: "steer_returned"; texts: string[]; ids?: string[] }
  // U2（X36 第二步）：还没送达的插话被撤回了（任一设备在待送达托盘上撤的）——各设备把它从托盘里拿掉
  | { e: "steer_withdrawn"; id: string }
  // E3：用户用 /技能名（或 /包名）点了技能，正文已经跟在这条消息 / 插话后面进了对话（界面上是一行提示）
  | { e: "skill_loaded"; name: string; via: "slash"; pkg?: boolean }
  // N45：这一轮开跑时自动召回了哪些（标题、类别、理由，不含正文）——挂在本轮用户消息下（界面上「召回 N 条」）
  | { e: "recall"; items: RecallRef[] }
  // ── Sub-agents / workflows (visibility into delegated work) ──────────────
  // A sub-agent (Agent tool, or an agent() call inside a Workflow script)
  // started. `toolId` = the parent tool_call it belongs to (the UI nests the
  // agent card under that tool row); `workflowId` = the workflow run it belongs
  // to (nested under the workflow card instead). `cached` = a resumed workflow
  // served this call from its journal without running anything.
  | {
      e: "subagent_start";
      id: string;
      label: string;
      tier: SubAgentTier;
      model: string;
      provider: string;
      prompt: string;
      phase?: string;
      workflowId?: string;
      toolId?: string;
      cached?: boolean;
      // Server clock at launch — a reconnecting client replays this event late,
      // so the task panel's timers must not use the receive time.
      startedAt?: number;
    }
  // One of the sub-agent's OWN loop events (text_delta / tool_start / tool_end /
  // usage / done / error …), wrapped so it can never be mistaken for the main
  // agent's stream. thinking_delta is deliberately not forwarded (volume).
  | { e: "subagent_event"; id: string; ev: AgentEvent }
  | {
      e: "subagent_end";
      id: string;
      ok: boolean;
      error?: string;
      turns: number;
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
      // Final answer text (capped) and, when a schema was requested, the
      // validated structured result.
      text: string;
      result?: unknown;
      cached?: boolean;
      durationMs?: number;
      // Sub-agent panel: files a coder touched (absolute paths; omitted when none) and why it
      // stopped short (omitted when it completed). History reads the same fields off
      // tool_result.meta.subagent.
      editedFiles?: string[];
      stopReason?: string;
    }
  // A Workflow script run: meta (statically extracted before execution) →
  // phases as the script enters them → narrator lines from log() → summary.
  | {
      e: "workflow_start";
      id: string;
      name: string;
      description: string;
      phases: WorkflowPhaseMeta[];
      toolId?: string;
      resumedFrom?: string;
      startedAt?: number;
    }
  | { e: "workflow_phase"; id: string; title: string }
  | { e: "workflow_log"; id: string; text: string }
  | {
      e: "workflow_end";
      id: string;
      ok: boolean;
      error?: string;
      agents: number;
      cached: number;
      inputTokens: number;
      outputTokens: number;
      result?: unknown;
      durationMs?: number;
    }
  // U8（ZCode E3）：durationMs / waitedMs = 这一轮的整轮用时与其中等人的时间（会话在转发时补上）
  | { e: "done"; stopReason: StopReason; durationMs?: number; waitedMs?: number }
  // O2：class = provider 错误的分类（R7），子 agent / Workflow 据此决定挂起重试还是整个停下
  // U6（hermes N41）：summary = 一句人话（上屏）；ran = 这一轮已经执行过几次工具（重发之前先核对）；
  // stopped = 这是中断不是失败（用户停的 / 服务重启打断的），前端显示成「已停止」
  | { e: "error"; message: string; retriable: boolean; class?: string; summary?: string; ran?: number; stopped?: "user" | "restart" }
  // O2：子 agent 因为限流 / 上游过载挂起，waitMs 之后在同一个 state 上接着跑（不算失败）
  | { e: "subagent_suspended"; id: string; reason: string; waitMs: number; attempt: number }

// Tool tier a sub-agent runs with. research = read-only exploration (the
// original Agent tool); coder = may also Write/Edit/Bash (only when the parent
// session itself is in auto mode — a read-only/plan parent can never spawn a
// child that writes).
export type SubAgentTier = "research" | "coder";

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  model?: string;
}
