// 会话对象与几张卡片落定结果的类型。
import type { SessionShape } from "../project-mode.ts";
import type { AskQuestion, DecidedBy } from "../agent/events.ts";
import { AgentState } from "../agent/state.ts";
import type { ApprovalPreview, AskQuestionSpec, AskResolution } from "../tools/types.ts";
import type { GoalState } from "../goal.ts";
import type { McpBaseline } from "../tools/mcp.ts";
import type { RuntimeConfig } from "../config.ts";
import type { PersistedConfig } from "../store.ts";
import type { Msg } from "../agent/turn.ts";
import type { TraceContext } from "../trace.ts";

export interface Session {
  id: string;
  state: AgentState | null;
  abort: AbortController | null;
  createdAt: number;
  running: boolean;
  // In-process background job for the current turn. The job owns execution;
  // SSE clients are only detachable watchers and never own its lifetime.
  runPromise: Promise<void> | null;
  // Prevent a deleted session's finishing background job from recreating its
  // persisted record after DELETE has removed it.
  discarded: boolean;
  // First user message, trimmed — the display name in the session list.
  title: string;
  // The provider/model/effort this session was built with. Persisted so a
  // resumed session continues on ITS configuration, not the current global one.
  cfg: PersistedConfig | null;
  // M11（N33）：还没开跑的新会话由发起端带来的配置快照；第一次开跑时（initState）变成 cfg，之后不再用
  initialConfig?: RuntimeConfig;
  // 项目对话（project-mode.ts）：新会话由发起端定的形态；第一次开跑时（initState）记进 cfg.shape，之后不再变
  initialShape?: SessionShape;
  // 运行中换了型号 / 思考深度：cfg 已是新的，会话状态等下一轮开跑前再按它重建（setSessionModel）
  modelRebindPending?: boolean;
  modelRebindFrom?: { provider: string; model: string };
  // U3（X38）：这一轮的运行计时——开跑时刻、卡片挂着（在等人）累计的暂停、此刻是否在暂停。服务端记账，所有设备一致
  runClock?: { startedAt: number; pausedMs: number; pausedSince: number | null } | null;
  // Q12：这一轮的 trace（上下文之外的 fanout——比如接口里落定卡片——也能归到这一轮）
  trace?: TraceContext;
  // O7（K64）：目标续跑的契约与进度（随会话落盘）
  goal?: GoalState;
  // E1（G6）：建会话时拍下的 MCP 基线（连上的连接器 + 直连工具的定义），随会话落盘；会话里的工具清单从此不变
  mcp?: McpBaseline | null;
  persistTimer: NodeJS.Timeout | null;
  // Live-mirror plumbing: a run's events are logged + fanned out so OTHER
  // devices can attach mid-run (GET /api/sessions/:id/stream) and watch the
  // same stream the originating device gets.
  watchers: Set<(ev: Record<string, unknown>) => void>;
  runLog: Record<string, unknown>[];
  // Set when the run produced more events than MAX_RUN_LOG. A later attach cannot
  // be served a partial replay as if it were complete — see watchSession.
  runLogTruncated: boolean;
  // Last time this session was run or read. Drives idle eviction: the record on
  // disk is the source of truth and getOrLoadSession rehydrates on demand.
  touchedAt: number;
  // User-visible message count right after the run's user message landed —
  // mirrors rebuild their base timeline from visible messages and replay runLog.
  // M4：只作兜底；真正的底座按 runUserMsg 在当前转录里的位置现算（见 mirrorBaseCount）。
  runStartMsgCount: number;
  // M4（#43）：本轮的用户消息对象。运行中全量压缩后，尾部保留的是同一个对象，底座按它定位。
  runUserMsg?: Msg | null;
  // M2（#44）：当前（或最近一次）这一轮的身份。停止 / 插话可以带上它做前置条件，对不上就不动别人的那一轮。
  runId?: string | null;
  // AskUserQuestion: questions posed by the running agent, awaiting an answer via
  // POST /answer. Keyed by askId (= the tool call id, M1). Non-empty only while a
  // tool call is blocked. payload = the wire questions, re-sent on reconnect.
  pendingAsks: Map<string, { resolve: (r: AskResolution) => void; questions: AskQuestionSpec[]; payload?: AskQuestion[]; deadlineAt?: number; since?: number }>;
  // 细粒度权限：规则判定为 ask 的那次调用在等用户点「允许一次 / 本会话都允许 / 拒绝」。
  pendingPermissions: Map<string, PendingPermission>;
  // Plan mode：ExitPlanMode 提交的计划在等用户批准。
  pendingPlans: Map<string, { resolve: (r: PlanVerdict) => void; plan: string; deadlineAt?: number; since?: number }>;
  // 瘦身 P0-1：上一轮收尾后在后台做的记忆沉淀（没有就是 null）。不占 running——用户可以接着发消息
  memoryJob?: Promise<void> | null;
}

export interface PermissionVerdict {
  decision: "once" | "session" | "deny";
  note?: string;
  // M3（#27）：用户根本没答（run 先结束了）——不是拒绝，转录里不许写成「user declined」。
  unanswered?: boolean;
  // P5：「本会话都允许」要记下的规则（用户选的那一组，取自服务端算好的候选，从不取客户端传来的原文）
  rules?: string[];
  // P6：没答复是因为离开模式开着（没人能批）——和「run 先结束了」不同，要记进拒绝台账
  away?: boolean;
  // P6：拒绝并停止——这一轮随即被停下
  stop?: boolean;
  // P7：倒计时到了没人批——按拒绝处理（fail-closed），不是用户拒绝
  timedOut?: boolean;
  // #103：弹过的那张卡的 id（离开模式直接拒、本会话已允许过直接放行的没有卡）、在哪台设备上定的、选的是不是按前缀——
  // 回执随工具结果落盘用
  card?: string;
  by?: DecidedBy;
  prefix?: boolean;
}

export interface PendingPermission {
  resolve: (r: PermissionVerdict) => void;
  tool: string;
  subject: string;
  since: number; // P8：卡片出现的时刻
  deadlineAt?: number; // P7
  rule?: string;
  sessionRules: string[];
  prefixRules?: string[];
  // S12：控制面文件——只能「允许这一次」，卡片不给「本会话都允许」，回传了也按一次算
  noSession?: boolean;
  // P11（ZCode C1 / C2）：给人看的中文原因；这次要执行的事实
  why?: string;
  preview?: ApprovalPreview;
}


export interface PlanVerdict {
  approved: boolean;
  note?: string;
  // M1：run 先结束了，用户没决定——不是退回。
  unanswered?: boolean;
  // P3：离开模式开着，没人能审——保持 plan、结束本轮并留言。
  away?: boolean;
  // P7：倒计时到了没人审——同上（timeoutMin = 等了几分钟）
  timedOut?: boolean;
  timeoutMin?: number;
  // C8：交给新会话实施了
  handoff?: boolean;
  // #103：弹过的那张卡的 id（离开模式没有卡）、在哪台设备上定的——回执随工具结果落盘用
  card?: string;
  by?: DecidedBy;
}
