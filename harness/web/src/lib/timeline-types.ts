// 时间线条目的类型。单独成文件、不依赖 Svelte 与浏览器：归约器（timeline-reducer.ts）要能在 Node 测试里跑，
// server 的 tsconfig 只认纯 TS。state.svelte.ts 照旧 re-export，组件的 import 不用改。
export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  args: any;
  status: "running" | "ok" | "fail" | "denied";
  summary: string;
  output: string;
  open: boolean;
  // U8（kimi K36）：工具行第二行的结果（服务端给的中文，只说结果）；没给就显示 summary
  outcome?: string;
  // Agent 工具：挂在这行下面的子 agent 实况（subagent_* 事件驱动；历史从
  // tool_result.meta.subagent 重建）。
  agent?: AgentRun;
  // Workflow 工具：整个工作流运行（阶段 / 各 agent / 日志 / 结果）。
  workflow?: WorkflowRun;
  // R14（K37）：运行中的前台 Bash 的实时尾行（tool_progress 驱动，直播派生字段，不进合并指纹）；跑完清掉。
  progress?: { tail: string; elapsedMs: number; canBackground: boolean };
}
// 子 agent 内部的一步工具调用（比主时间线的 ToolItem 轻：只留看得懂的摘要）。
export interface AgentStep {
  id: string;
  name: string;
  arg: string;
  status: "running" | "ok" | "fail" | "denied";
  summary: string;
}
export interface AgentRun {
  id: string;
  label: string;
  tier: string; // research | coder
  model: string;
  phase?: string;
  status: "running" | "ok" | "fail";
  // 当前回合正在流的正文（每个 turn_start 重置）；结束时换成最终答复。
  text: string;
  steps: AgentStep[];
  turns: number;
  tokens: number;
  error?: string;
  cached?: boolean;
  result?: any;
  open: boolean;
  // 工作区「任务」面板用：prompt 气泡、厂商、工具调用计数、计时（startedAt 取服务端时钟——
  // 重连回放的事件晚到也不会把计时清零；durationMs 结束时落）。lastAt = 本机最近一次收到它的
  // 事件，只作「卡住」提示，不持久化。
  prompt?: string;
  provider?: string;
  toolCalls?: number;
  startedAt?: number;
  durationMs?: number;
  lastAt?: number;
  // O2：因为限流 / 上游过载挂起，到这个时刻（本机时钟）之前在等；恢复后清掉。任务面板显示为「卡住」那一档。
  suspendedUntil?: number;
  suspendReason?: string;
  // 子 agent 面板：coder 档改过的文件（绝对路径）；没做完的原因（预算用尽 / 被限流到截止 / provider 出错……，做完了不带）
  editedFiles?: string[];
  stopReason?: string;
}
export interface WorkflowRun {
  id: string;
  name: string;
  description: string;
  phases: { title: string; detail?: string }[];
  currentPhase: string;
  agents: AgentRun[];
  logs: string[];
  status: "running" | "ok" | "fail";
  error?: string;
  agentCount: number;
  cached: number;
  tokens: number;
  result?: any;
  startedAt?: number;
  durationMs?: number;
}
export interface AttachmentItem {
  path: string;
  kind: "image" | "video" | "audio" | "file" | "folder";
}
export interface ArtifactItem {
  path: string;
  name: string;
  kind: "image" | "video" | "audio" | "pdf" | "office" | "text" | "file";
  size: number;
}
// AskUserQuestion（人机协作）：agent 抛出的选择题卡片。
export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  id: string; // "<askId>:<index>"，卡片按此 key 选择
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
}
export interface AskItem {
  kind: "ask";
  id: string; // askId（回答用）；历史里的中断卡为 tool_call id
  questions: AskQuestion[];
  answered: boolean;
  // 每题 id → 已选标签（或自定义文本）
  selected: Record<string, string[]>;
  // P7：到这个时刻（epoch ms）没人答就按合理假设继续；expired = 真的超时作废了
  deadlineAt?: number;
  expired?: boolean;
  // P10（D9）：在哪台设备上答的
  by?: DecidedBy;
}
// O7（K64）：目标续跑的状态（与服务端 goal.ts 的 GoalState 同形，界面只用这些字段）
export interface GoalView {
  objective: string;
  verify?: string;
  maxRounds: number;
  maxMinutes: number;
  round: number;
  roundBase: number;
  status: "active" | "paused" | "done";
  reason?: string;
}
// U8（ZCode E3）：一轮的用时——整轮墙钟与其中挂着卡片等人的时间（服务端在卡片挂上 / 落定处计量）
export interface RunTiming {
  durationMs: number;
  waitedMs: number;
}
// 引用会话：消息引用的一个对话（与服务端 agent/turn.ts 的 SessionRef 同形；草稿里多一个厂商给芯片上的标）
export interface SessionRefView {
  id: string;
  title: string;
  provider?: string;
}
// N45：自动召回的一条（与服务端 agent/turn.ts 的 RecallRef 同形）
export interface RecallRef {
  id: string;
  title: string;
  kind: string;
  why?: string;
}
// P10（D9）：卡片是在哪台设备上定的（服务端广播的落定事件带回来）
export interface DecidedBy {
  id: string;
  label: string;
}
// 细粒度权限卡：规则把某次调用交给用户裁决（允许一次 / 本会话都允许 / 拒绝）。
export interface PermissionItem {
  kind: "permission";
  id: string;
  tool: string;
  subject: string;
  rule?: string;
  decided: "once" | "session" | "deny" | "deny_stop" | null; // P6：deny_stop = 拒绝并停止
  cancelled?: boolean; // M1：没等到人裁决这一轮就结束了（不是拒绝）
  // P7：到这个时刻（epoch ms）没人批就按拒绝处理；cancelReason "timeout" = 真的超时作废了（这一轮还在继续）
  deadlineAt?: number;
  cancelReason?: "timeout";
  // P5：「本会话都允许」会记下的规则原文；可选的「按前缀允许」规则；落定时选的是哪种
  sessionRules?: string[];
  prefixRules?: string[];
  scope?: "prefix";
  // S12：控制面文件——只能「允许这一次」
  noSession?: boolean;
  // P10：在哪台设备上定的；拒绝时附的话（N43：输入框里的话落到卡上）
  by?: DecidedBy;
  note?: string;
  // P11（ZCode C1 / C2）：给人看的中文原因；这次要执行的事实（命令、diff、写入内容、工作流脚本）
  why?: string;
  preview?: ApprovalPreview;
}
// P11：权限卡上的执行事实（与服务端 tools/types.ts 的 ApprovalPreview 同形；不认识的 kind 按文本显示）
export type ApprovalPreview =
  | { kind: "command"; command: string; background?: boolean; truncated?: boolean }
  | { kind: "diff"; path: string; old: string; new: string; replaceAll?: boolean; truncated?: boolean }
  | { kind: "write"; path: string; head: string; lines: number; bytes: number; truncated?: boolean }
  | { kind: "script"; name: string; description: string; phases: string[]; script: string; lines: number; truncated?: boolean }
  | { kind: "text"; text: string; truncated?: boolean };
// Plan mode 的计划卡：批准即切到自主执行并在同一轮继续。
export interface PlanItem {
  kind: "plan";
  id: string;
  plan: string;
  decided: "approved" | "returned" | "handoff" | null; // C8：handoff = 转到新会话实施
  cancelled?: boolean; // M1：没等到人决定这一轮就结束了（不是退回）
  // P7：到这个时刻（epoch ms）没人审就保持计划模式、以计划收尾；cancelReason "timeout" = 真的超时了
  deadlineAt?: number;
  cancelReason?: "timeout";
  // P10：在哪台设备上定的；退回时的修改意见
  by?: DecidedBy;
  note?: string;
}
export type Item =
  | ToolItem
  | AskItem
  | PermissionItem
  | PlanItem
  // N45：recall = 这一轮开跑时自动召回的条目（只有标题、类别、理由），气泡下写「召回 N 条」
  // refs = 这条消息引用的对话（把会话块拖进输入框），气泡里的芯片
  | { kind: "user"; text: string; attachments?: AttachmentItem[]; steer?: boolean; steerId?: string; recall?: RecallRef[]; refs?: SessionRefView[] }
  // U8（ZCode E3）：run = 这一轮的用时（整轮墙钟与其中等人的时间），挂在这一轮最后一段回答上
  | { kind: "text"; text: string; live: boolean; artifacts?: ArtifactItem[]; run?: RunTiming }
  | { kind: "thinking"; text: string; open: boolean; live: boolean }
  // U6（hermes N41）：text = 一句人话；detail = 原始报错（折起来）；ran = 这一轮已经执行过几次工具（接着做之前先核对）
  | { kind: "error"; text: string; detail?: string; cls?: string; ran?: number; retriable?: boolean }
  // R12（二）：asset = 会话资产 id（界面按 URL 取）；老事件 / 没有会话时才是 dataUri
  | { kind: "screenshot"; dataUri: string; asset?: string; url: string; verdict: string }
  | { kind: "notice"; text: string };
