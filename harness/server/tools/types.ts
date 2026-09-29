import type { Block, JsonObjectSchema, ThinkingLevel, ToolDef } from "../agent/turn.ts";
import type { TodoItem, AgentEvent, AskOption, DecidedBy, SubAgentTier, WorkflowPhaseMeta } from "../agent/events.ts";
import type { Sandbox } from "../sandbox.ts";
import type { ProviderId } from "../providers/types.ts";

// ── AskUserQuestion contract (tool ↔ session wiring) ─────────────────────────
// One question the agent poses. Mirrors the tool's public schema minus the id
// (the session assigns per-question ids when it emits the `ask` event).
export interface AskQuestionSpec {
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
}
export interface AskResolvedAnswer {
  header: string;
  // Chosen option labels, or free-text when the user picked "Other".
  selected: string[];
  custom: boolean;
}
export interface AskResolution {
  // True when the user never answered (run stopped / question dismissed). The
  // tool then tells the model to proceed on its best assumption.
  cancelled: boolean;
  answers: AskResolvedAnswer[];
  // P3：离开模式开着，没人能答——按合理默认继续并写明假设。
  away?: boolean;
  // P7：倒计时到了没人答（timeoutMin = 等了几分钟）——同样按合理默认继续并写明假设
  timedOut?: boolean;
  timeoutMin?: number;
}

// Snapshot of a file the model has Read — the gate Edit checks before writing.
export interface FileState {
  mtimeMs: number;
  content: string;
  // Ranges of lines actually returned to the model. `content` is kept in full
  // for concurrent-change detection, but must not be mistaken for visibility.
  readRanges: Array<[number, number]>;
  complete: boolean;
}

// O7（K64）：UpdateGoal(done) 的结论——声明了验证命令的，是 harness 自己跑出来的
export interface GoalVerdict {
  passed: boolean;
  verify?: string;
  status?: string; // exit 0 / exit 1 / timeout …
  output?: string; // 验证命令输出的尾巴
  verification?: ToolRunResult["verification"];
}

export interface ToolContext {
  sandbox: Sandbox;
  readFileState: Map<string, FileState>;
  setTodos: (items: TodoItem[]) => void;
  // O7（K64）：有进行中的目标时由会话挂上（UpdateGoal 用）；没有目标就没有
  goal?: {
    verify?: string;
    claimDone: (summary: string) => Promise<GoalVerdict>;
    block: (reason: string) => void;
  };
  signal?: AbortSignal;
  // Which session this context belongs to. Process-wide resources that outlive a
  // turn (background Bash jobs, Preview services, the shared browser) are tagged
  // with it so one session can never poll/kill/hijack another's — with several
  // devices driving concurrent sessions, an unscoped id is a cross-session
  // control channel. Absent for sub-agents/tests: those get the unowned pool.
  ownerId?: string;
  // Config knobs surfaced from the session (timeouts, limits, ...).
  limits: { bashTimeoutMs: number; bashMaxTimeoutMs: number };
  // Whether the MAIN agent model can see images. Lets a tool decide to feed a
  // screenshot back to the agent itself (multimodal) vs. route it to a separate
  // vision model (text-only agent like DeepSeek).
  agentSeesImages: boolean;
  // Whether the main model ingests video itself. When false, video is sampled
  // into frames instead of being handed over whole.
  agentSeesVideo?: boolean;
  agentHearsAudio?: boolean;
  // 这个会话（或子 agent）实际在用的 provider。WebSearch 先用它自带的原生搜索——全局配置可能是另一家
  // （会话按创建时的配置快照跑），只看全局的话「小米对话」会先去打智谱。没给就回落全局配置。
  provider?: ProviderId;
  // Spawn a sub-agent (wired by the session from agent/subagent.ts; absent in
  // bare/test contexts). Backs the Agent tool and every agent() call a Workflow
  // script makes.
  runSubAgent?: (req: SubAgentRequest) => Promise<SubAgentResult>;
  // Run a Workflow script (agent/workflow.ts). Backs the Workflow tool.
  runWorkflow?: (req: WorkflowRequest) => Promise<WorkflowResult>;
  // Live side-channel to every attached device (wired by the session to its
  // event fanout). ToolRunResult.events only fires AFTER a tool returns; long
  // tools (Agent, Workflow) push progress here while they run.
  emit?: (ev: AgentEvent) => void;
  // The tool_call id of the call currently executing. The loop hands each tool
  // a per-call view of the context carrying this, so a tool can tag the events
  // it emits (an agent card nests under its own tool row).
  callId?: string;
  // Pose a question to the user and block until they answer (or the run stops).
  // Wired by the session; absent for sub-agents and headless/test contexts, in
  // which case AskUserQuestion degrades to "proceed on your best assumption".
  // callId = 这次 AskUserQuestion 调用的 tool_call id（M1：卡片 id 与转录里的调用同一个，
  // 从记录重建出的卡也能作答）。
  askUser?: (questions: AskQuestionSpec[], callId?: string) => Promise<AskResolution>;
  // Plan mode: submit a plan and block until the user approves or returns it.
  // Approval flips the session to auto so the same run can execute the plan.
  // unanswered：run 先结束了，用户没看到 / 没决定——不是退回。away：离开模式开着，没人能审。
  // timedOut（P7）：倒计时到了没人审——同样保持 plan、以计划收尾。
  submitPlan?: (plan: string) => Promise<{
    approved: boolean;
    note?: string;
    unanswered?: boolean;
    away?: boolean;
    timedOut?: boolean;
    timeoutMin?: number;
    // C8（X42）：用户选了「在新会话中实施」——计划交给一个干净上下文的新会话去做，这边收尾
    handoff?: boolean;
    // #103：弹过的那张卡的 id（离开模式没有卡）、在哪台设备上定的——回执随工具结果落盘
    card?: string;
    by?: DecidedBy;
  }>;
  // A rule routed this tool call to the user ("ask"). Blocks for a decision.
  // Absent = no human attached, and the loop denies instead of hanging.
  requestPermission?: (req: {
    tool: string;
    subject: string;
    rule?: string;
    // P1（#48）：工具自己弹的确认卡（不走规则判定，如 Workflow）用它声明「本会话都允许」覆盖的范围
    // （"" = 这个工具的每一次调用）。给了就由会话记账：已允许过就不再弹卡，用户点了就记下。
    sessionKey?: string;
    // P5：「本会话都允许」会记下的规则原文（卡片照原样显示），与可选的「按前缀允许」规则（已自测）
    sessionRules?: string[];
    prefixRules?: string[];
    // S12：控制面文件——只能「允许这一次」，不给「本会话都允许」
    noSession?: boolean;
    // P11（ZCode C1 / C2）：卡片上给人看的中文原因；这次要执行的事实（命令、diff、写入内容、工作流脚本）
    why?: string;
    preview?: ApprovalPreview;
  }) => Promise<{
    decision: "once" | "session" | "deny";
    note?: string;
    unanswered?: boolean;
    rules?: string[];
    away?: boolean;
    stop?: boolean; // P6：拒绝并停止
    timedOut?: boolean; // P7：倒计时到了没人批，按拒绝处理（fail-closed）
    // #103：弹过的那张卡的 id（没弹卡直接定的没有）、在哪台设备上定的、选的是不是按前缀——回执随工具结果落盘
    card?: string;
    by?: DecidedBy;
    prefix?: boolean;
  }>;
  // Memory governance hooks wired by the main AgentState. Remember marks the
  // current audit dirty; MemoryAudit closes the end/pre-compaction gate.
  noteMemoryChanged?: () => void;
  // K1（#61）：按 id 查本会话转录里的一次工具调用（名字、结果是否成功；没有结果时 ok 为 null）。
  // Remember 用它核对 verified 记忆引用的证据确有其事。
  lookupToolCall?: (id: string) => { name: string; ok: boolean | null } | undefined;
  // C5：这个技能的正文此刻还在转录里（加载过、没被整段压缩掉）——Skill 同名不重复注入。
  skillLoaded?: (name: string) => boolean;
  // K9（X55）：本会话读过外部内容（网页、搜索结果、浏览器页面，或子 agent 读过）——Remember 据此只存 proposed
  externalContent?: () => boolean;
  // K2（#28）：此刻有没有人在场（会话有客户端连着）。记进记忆的来源；无人值守时的更严规则等 P3 的离开模式。
  humanAttended?: () => boolean;
  // N26（HT3）：给工作区拍一张只有文件的轮内快照（label 显示在回滚面板）。会话层按 run 挂上、子 agent 经 env 接同一个口；
  // 和上一张一样（没有新内容要护）就不记。何时拍由 loop 判（破坏性命令前、这个 agent 上一张之后写过东西）。永不抛。
  snapshotFiles?: (label: string) => Promise<void>;
  completeMemoryAudit?: (
    decision: "updated" | "none",
    reason: string,
  ) => { ok: boolean; message: string };
  // Honest escape hatch for work that genuinely cannot be checked. This does
  // not claim the mutation passed verification; it only closes the done gate
  // after the model records a concrete limitation for its final answer.
  completeVerificationAudit?: (
    decision: "not_applicable" | "blocked",
    reason: string,
  ) => { ok: boolean; message: string };
}

// ── Sub-agent contract (Agent tool ↔ session wiring) ─────────────────────────

export interface SubAgentRequest {
  // Self-contained task — the sub-agent sees nothing of the parent conversation.
  prompt: string;
  signal?: AbortSignal;
  // Tool tier: "research" (default) = Read/Grep/Glob/web only, permission mode
  // forced to read-only; "coder" = also Write/Edit/Bash, runs in auto mode
  // (refused unless the parent session is itself in auto mode).
  tier?: SubAgentTier;
  // Only meaningful for the coder tier ("auto" default); research is always
  // read-only regardless.
  permissionMode?: "auto" | "read-only";
  // Run budget overrides (defaults per tier: research 20 turns / 10 min,
  // coder 60 turns / 30 min).
  maxTurns?: number;
  deadlineMs?: number;
  // Model / effort override. `model` is a catalog id; its provider is looked
  // up in the catalog unless `provider` is given. A different provider needs
  // its own key configured, otherwise the run fails with a clear error.
  model?: string;
  provider?: ProviderId;
  thinking?: ThinkingLevel;
  // UI label (defaults to the first line of the prompt) and, inside a
  // workflow, the phase the call is grouped under.
  label?: string;
  phase?: string;
  // Structured output: a JSON object schema. The sub-agent gets a SubmitResult
  // tool whose parameters ARE this schema; calling it (validly) is the only way
  // to deliver, and `result` carries the validated object.
  schema?: JsonObjectSchema;
  // Extra instructions appended to the sub-agent's system prompt (workflow
  // agents are told their text is data for a script, not prose for a human).
  system?: string;
  // Identity for the event stream. `id` defaults to a fresh uuid; `toolId` is
  // the parent tool_call (Agent tool) and `workflowId` the owning workflow run.
  id?: string;
  toolId?: string;
  workflowId?: string;
  // Live progress sink (subagent_start / subagent_event / subagent_end).
  onEvent?: (ev: AgentEvent) => void;
  // O2：子 agent 因为限流 / 上游过载挂起（退避后在同一个 state 上接着跑）时回调——Workflow 据此缩并发。
  onSuspend?: (reason: string) => void;
}

export type SubAgentStop = "completed" | "budget_exhausted" | "rate_limited" | "provider_error" | "no_result" | "aborted";

export interface SubAgentTrailStep {
  name: string;
  arg: string;
  ok: boolean;
  summary: string;
}

export interface SubAgentResult {
  ok: boolean;
  id: string;
  label: string;
  tier: SubAgentTier;
  model: string;
  provider: string;
  // The sub-agent's final answer text ("" when it produced none).
  text: string;
  // Validated structured output when the request carried a schema.
  result?: unknown;
  // Set when the run ended on a provider/loop error (text may still hold
  // partial progress notes).
  error?: string;
  // O2：provider 错误的分类（R7 的 ErrorClass：auth / billing / rate_limit …）；不是 provider 错误时没有。
  errorClass?: string;
  // O3（K62）：交接单——为什么停下、父 agent 下一步该怎么办。completed 之外都是 ok:false（预算用尽不再报成功）。
  stopReason?: SubAgentStop;
  nextStep?: string;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  // Workspace files a coder-tier child edited/created (absolute paths).
  editedFiles: string[];
  // Capped tool trail — persisted in the Agent tool_result's meta so history
  // rebuilds can show what the child did.
  trail: SubAgentTrailStep[];
  // Wall-clock bounds of the child run (epoch ms / ms) for the task panel.
  startedAt?: number;
  durationMs?: number;
  // K9（X55）：这个子 agent 读过外部内容（网页 / 搜索 / 浏览器）——它交回的报告可能带着网上看来的说法
  externalContent?: boolean;
}

// ── Workflow contract (Workflow tool ↔ agent/workflow.ts) ───────────────────

export interface WorkflowRequest {
  script: string;
  args?: unknown;
  resumeFromRunId?: string;
  signal?: AbortSignal;
  onEvent?: (ev: AgentEvent) => void;
  toolId?: string;
  limits?: {
    maxConcurrency?: number;
    maxAgents?: number;
    tokenBudget?: number;
    deadlineMs?: number;
  };
}

export interface WorkflowAgentSummary {
  id: string;
  label: string;
  phase?: string;
  ok: boolean;
  cached: boolean;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  // Rendered by the task panel's agent table (model / tool uses / time columns).
  tier?: SubAgentTier;
  model?: string;
  turns?: number;
  toolCalls?: number;
  startedAt?: number;
  durationMs?: number;
  // V5：coder agent 改过的文件（父会话的验证门禁要算进去）
  editedFiles?: string[];
  // K9：这个 agent 读过外部内容
  externalContent?: boolean;
}

export interface WorkflowResult {
  ok: boolean;
  id: string;
  name: string;
  description: string;
  phases: WorkflowPhaseMeta[];
  error?: string;
  // The script's return value (JSON round-tripped, size-capped).
  result?: unknown;
  resultTruncated?: boolean;
  agents: WorkflowAgentSummary[];
  cached: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  startedAt?: number;
  logs: string[];
  // Where the run's journal lives (for a later resumeFromRunId).
  journalPath: string;
  // R18：到了时限没开始的 agent() 调用（返回了 null）
  skipped?: number;
}

export interface ToolRunResult {
  ok: boolean;
  // What the model sees as the tool_result content.
  content: Block[];
  // Short one-line summary for the UI.
  summary: string;
  // U8（kimi K36）：工具行第二行的结果（中文、只说结果：「退出码 0 · 12 行输出」「改了 1 处（+3 −1 行）」）。loop 把它随
  // tool_end 发出、并记进落盘的 tool_result.meta（历史里重建工具行也有）；没给的工具照旧只显示 summary。
  outcome?: string;
  // UI-only structured data the loop attaches to the persisted tool_result
  // block (never sent to providers). AskUserQuestion stores the user's exact
  // selections here so history rebuilds don't re-parse formatted text.
  meta?: Record<string, unknown>;
  // Workspace paths newly created by this tool call. The run collects these
  // as output candidates, but only files explicitly handed back in the final
  // response become user-visible artifact cards.
  createdFiles?: string[];
  // V5（#20）：这次调用改过内容的文件（coder 子 agent、Workflow 里的 coder 写的）——验证门禁把它们算进「改过没有」。
  // 以前只认 Edit/Write，派 coder 改完就收尾，门禁一次都不问。
  editedFiles?: string[];
  // Optional side-events a tool can push to the frontend (e.g. Preview opening
  // the preview pane). The loop yields these after the tool_end event.
  events?: AgentEvent[];
  // Extra blocks (e.g. a screenshot image) to inject as a follow-up USER message
  // after the tool_result. Needed because OpenAI/DashScope tool-role messages
  // can't carry images — the loop appends these as a separate user turn so a
  // multimodal agent can actually see them.
  feedback?: Block[];
  // C5（K57）：技能正文——loop 在工具结果之后追加成一条 harness 消息（kind "skill"），不放进 tool_result：
  // 微压缩只清旧的工具输出，长任务里技能指令不会被悄悄换成占位。
  skill?: { name: string; text: string };
  // K9（X55）：这次调用把外部内容带进了会话（子 agent / Workflow 里有人读过网页）——会话从此按「读过外部内容」算
  externalContent?: boolean;
  // P13（X18）：这次调用只因为读了工作区外被拒——放行这些目录（只读）就能过。loop 在有人在场时问一句，批了带放行重跑；
  // 写、凭据、别名 / 链接这些拒绝永远不带它
  outsideRead?: { dirs: string[] };
  // Explicit, machine-checkable completion evidence. Tools only set this when
  // the model requested a verification operation; ordinary inspection must not
  // accidentally satisfy the done gate.
  verification?: { passed: boolean; detail: string };
}

export type ToolEffect = "read" | "write" | "exec";

// P4：工具按这一次的入参细化权限判定（目前只有 Bash）。只影响权限判定，不影响并行调度与副作用前落盘。
export interface PermissionView {
  // 这次调用实际的副作用级别：纯读命令降为 "read"，plan / read-only 档也能跑（C9）
  effect?: ToolEffect;
  // 规则逐条比对的子命令：deny/ask 任一命中即生效，allow 须每条都被覆盖（A5）
  subjects?: { text: string; alt: string; exactOnly: boolean }[];
  // 子命令没拆全（引号没闭合、程序名运行时才知道……）：allow 只认整条命令一字不差的规则
  partial?: boolean;
  // 要人过目的原因（K5：分析不了又含高危程序名、递归删除的目标运行时才知道且可能落到根上）
  ask?: string;
  // P12：检查点兜不住的操作（强推、发布、全局装卸包、执行刚下载的内容……）——auto 下也转问，用户写的 allow 规则优先
  irreversible?: string;
  // P11（ZCode C1）：ask / irreversible 给人看的中文说明（写在权限卡上；英文那句是回给模型的）
  why?: string;
  // P5：「本会话按前缀允许」的候选模式（`npm run lint:*`）；高危根命令、解释器入口、过宽前缀时不给
  prefixes?: string[];
  // P6：这次调用明确要写的路径（原文）：Edit/Write 的路径规则与本 run 的拒绝台账同样管它
  writes?: string[];
  // V5：其中内容被改写 / 新建的（删除不算）——跑完之后验证门禁记成「改过的文件」
  edits?: string[];
  // P6：非只读子命令提到的词（原文）：拒绝台账兜底——解释器、构建工具写什么看不出来，但提到了被拒的路径就算碰
  mentions?: string[];
  // N26（HT3）：有子命令会删文件或丢弃 git 工作区改动——执行前给工作区拍一张只有文件的轮内快照
  destroys?: boolean;
  // 其余子命令都只读 / 导航：它毁掉的内容已在执行前那张快照里，它自己不算「又写过新东西」
  onlyDestroys?: boolean;
}

// P11（ZCode C2，kimi K20）：审批载荷 = 执行事实。卡片上摆的就是这次要执行的东西，前端按 kind 渲染（未知 kind 回落成文本）。
// 长的截断并标 truncated——卡片不是看全文的地方，但看到的每个字都是真的会执行的。
export type ApprovalPreview =
  | { kind: "command"; command: string; background?: boolean; truncated?: boolean }
  | { kind: "diff"; path: string; old: string; new: string; replaceAll?: boolean; truncated?: boolean }
  | { kind: "write"; path: string; head: string; lines: number; bytes: number; truncated?: boolean }
  | { kind: "script"; name: string; description: string; phases: string[]; script: string; lines: number; truncated?: boolean }
  | { kind: "text"; text: string; truncated?: boolean };

// P11（kimi K20）：出卡之前的规划阶段。loop 在权限判定之前调它（可以 async、可以读文件）：
//   veto    这次调用注定失败（硬拒的命令、编不过的工作流脚本）——不弹卡、不执行，直接把这句回给模型
//   confirm 这个工具要人确认（auto 档、没有规则也问）——进统一权限闸：用户写的 allow 规则、「本会话都允许」可放开，
//           没人在场 / 离开模式按「没被批准」处理，判定进权限审计
//   preview 卡片上的执行事实（不给就按工具与参数生成通用的）
export interface PreparedCall {
  veto?: { summary: string; content: string };
  confirm?: { reason: string; why: string };
  preview?: ApprovalPreview;
}

export interface Tool {
  def: ToolDef;
  effect: ToolEffect;
  concurrencySafe: boolean; // read-only tools may run in parallel
  // Environment-backed capabilities (for example Electron Local-PC) may only
  // exist while an external trusted host is alive. Registry filters them per turn.
  enabled?: () => boolean;
  permissionView?: (args: Record<string, unknown>) => PermissionView | null;
  // P11（K20）：出卡之前的规划阶段（见 PreparedCall）；抛错按「没有」处理
  prepare?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<PreparedCall | null> | PreparedCall | null;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult>;
}

// Convenience result builders.
export function ok(summary: string, body: string): ToolRunResult {
  return { ok: true, summary, content: [{ t: "text", text: body }] };
}
export function fail(summary: string, body: string): ToolRunResult {
  return { ok: false, summary, content: [{ t: "text", text: body }] };
}
