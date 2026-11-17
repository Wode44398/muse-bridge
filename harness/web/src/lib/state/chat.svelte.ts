// 一个会话的全部运行时（Chat），以及侧栏列表里会话 / 项目的元数据。
import type * as tl from "../timeline-reducer.ts";
import type { AgentRun, AskItem, GoalView, Item, PermissionItem, PlanItem, SessionRefView, ToolItem, WorkflowRun } from "../timeline-types.ts";

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  provider: string;
  model: string;
  workspace: string;
  running?: boolean;
  // P8（X34）：在等你回答 / 批准 / 审计划
  waiting?: "permission" | "ask" | "plan" | null;
  // 快照会话（任意一代快照桶；服务端标记）：侧栏放进快照区
  quick?: boolean;
}

export interface ProjectMeta {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  exists: boolean;
  // 侧栏排序/可见性（老后端没有这两个字段 → 一律当未置顶、未隐藏）
  pinned?: boolean;
  pinnedAt?: number;
  hidden?: boolean;
  // 快照对话：一次性桶伪装成的项目（服务端 quick.ts）。不进「项目」区、
  // 不参与置顶/隐藏，由侧栏单独置顶成一行。
  quick?: boolean;
}

// ── Chat：一个会话的全部运行时 ───────────────────────────────────────────────
// 可视字段是 $state 类字段（组件经 app.chat.xxx / app.chats[i].xxx 读取，天然
// 响应）；流式游标与连接管理是普通字段（不需要响应，避免深代理开销）。
// Chat 实例放进 $state 容器不会被再包一层代理（Svelte 只深代理 POJO/数组），
// 所以 chat === app.chat 的引用比较始终成立 —— 前后台判断全靠它。
export class Chat {
  id = $state<string | null>(null);
  title = $state("");
  timeline = $state<Item[]>([]);
  todos = $state<{ content: string; status: string }[]>([]);
  todosOpen = $state(false);
  running = $state(false);
  // 直播连接断了但服务端任务还在跑（或状态未知）：正在自动重连/对账。
  // running 的真相在服务端，连接死亡 ≠ 运行结束。
  reconnecting = $state(false);
  activity = $state(""); // 运行中的当前动作："思考中" / "执行命令" / "回复中"…
  clock = $state<tl.RunClock | null>(null); // U3：这一轮的运行计时（服务端记账；卡片等人时暂停）
  // O7（K64）：目标续跑的状态（服务端 goal 事件 / 记录带回来）；输入框上「目标」开着时的草稿（发送就开一个目标）
  goal = $state<GoalView | null>(null);
  goalDraft = $state<{ on: boolean; verify: string; maxRounds: number } | null>(null);
  usage = $state({ inTok: 0, outTok: 0 });
  ctx = $state<{ used: number; limit: number; cacheTtlMs?: number }>({ used: 0, limit: 0 });
  attachments = $state<string[]>([]);
  // 引用会话：输入框里还没发出去的「引用」芯片（把会话块拖进输入框）
  refs = $state<SessionRefView[]>([]);
  // N42（U4）：输入框里还没发出去的话——跟着会话走，切会话不串
  draft = $state("");
  // P10（E1、N43）：此刻停在输入框上方的那张卡；这段草稿开始写时停着的那张（undefined = 草稿还空着，null = 没有）——
  // 发送就回应它；最近一次敲键盘的时刻（正在打字就先不停靠）
  dockedCardId = $state<string | null>(null);
  draftTarget = $state<string | null | undefined>(undefined);
  lastInputAt = 0;
  // U4（K08）：还没有会话 id 时附件落在 .dimensio/uploads/<draftId>/（有了 id 之后的附件落在 <id>/ 下）
  readonly draftId = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  // 在跑的 dev server（供浏览器面板的「预览」按钮一键拉起）。
  // publicUrl = 经隧道的公网 https 地址（pv-<token>.<域>），手机外部浏览器可直开。
  preview = $state<{ url: string; serviceId: string; publicUrl?: string } | null>(null);

  // ── 非响应式：流式游标 + 吐字节流缓冲 ──
  curText: any = null;
  curThinking: any = null;
  // 每个 delta 直改 $state 会让整段 markdown 重解析、{@html} 子树整体替换、
  // streamFade 重走全文、Feed 再跑一次 tick+scrollTo —— 长回答在手机上就是
  // O(n²) 卡顿的来源。增量先入缓冲，STREAM_FLUSH_MS 批量落地（肉眼仍是连续
  // 打字机，重渲染次数降一个数量级）。沿用 bridge Claude 分页的实测结论。
  pendingText = "";
  pendingThinking = "";
  flushTimer = 0;
  toolRefs = new Map<string, ToolItem>();
  askRefs = new Map<string, AskItem>();
  permRefs = new Map<string, PermissionItem>();
  planRefs = new Map<string, PlanItem>();
  // 子 agent / 工作流 id → 挂在时间线上的（代理）对象，subagent_*/workflow_* 事件按此落点
  agentRefs = new Map<string, AgentRun>();
  workflowRefs = new Map<string, WorkflowRun>();
  // Server turn index + its first timeline slot. A repeated turn_start with
  // the same index is an upstream retry; turn_discard is a lifecycle gate
  // retracting a provisional no-tool answer. Both must replace, not append.
  streamTurnIndex: number | null = null;
  turnStartTimelineLength = 0;

  // M2（#44）：本端附着到的那一轮（停止 / 插话带上它，服务端对不上就不动另一台设备新起的一轮）。
  runId: string | null = null;
  // M2（#51）：没送达、已放回输入框的那一条。用户原样再发时沿用同一个 clientRunId——万一其实已经落地，
  // 服务端认得出来，不会起第二轮。pendingRefill：后台会话没送达的草稿，切到前台时再放进输入框。
  undelivered: { clientRunId: string; text: string; paths: string[]; refs?: SessionRefView[] } | null = null;
  pendingRefill: string | null = null;

  // ── 非响应式：直播连接管理（per-chat，后台会话的循环独立自转）──
  abortCtl: AbortController | null = null;
  liveGen = 0; // 连接世代：任何恢复动作先 ++，旧连接/旧循环的回调一律失效（防幽灵事件）
  lastByteAt = 0; // 当前直播连接最近收到字节的时刻（含 ": ping" 心跳）
  resyncTimer = 0; // 退避重连定时器
  resyncAttempt = 0; // 连续失败次数（成功清零；回前台/网络恢复跳过退避）
  resyncing = false; // 对账阶段单飞
  // #93：嵌在 bridge 里离开 dimensio 页时收掉了这个会话的运行流（服务端照跑），回到页面要接上
  suspended = false;

  // 会话快照配置（provider/model/workspace/access/permissionMode），切前台时同步全局。
  // 必须是 $state：composer 的档位 / 范围胶囊读的是 `chat.cfg?.x ?? app.config?.x`——
  // cfg 一旦有值，`??` 短路后 app.config 根本不会被读到，胶囊就只依赖 chat 指针本身；
  // 普通字段的 `chat.cfg = {...}` 触不动它，已开过的会话里切档 / 切范围界面纹丝不动
  //（菜单是重新挂载的所以看着是对的，胶囊却停在旧值）。
  cfg = $state<any>(null);
  // C8：本端看到这一轮结束的时刻（本机时钟）——缓存变冷提示按它算（刚打开的老会话退回用列表里的 updatedAt）
  lastRunEndAt = $state(0);
  // P3：离开模式（会话级）。单独一个字段：本机新起的会话在第一轮里还没有 cfg 快照。
  away = $state(false);
  // P13：本会话放行的工作区外只读目录（同理单独一个字段）
  readRoots = $state<string[]>([]);
  // 项目对话（server/project-mode.ts）：新对话发第一条之前可以选「项目」形态，之后跟着会话记录走、不再变
  shape = $state<"" | "project">("");
  // U2（X36 第二步）：还没送达的插话（输入框上方的待送达托盘）
  pendingSteers = $state<tl.PendingSteer[]>([]);
  lastSeenAt = Date.now(); // LRU 淘汰用（终态缓存按最近浏览排序）
  // 手里这份【完整】记录的服务端指纹。对账时 /status 的 fp 与它相同 = 什么都没变，
  // 直接跳过整份转录（长会话 300KB+）。只在完整重建时置位；镜像 base（upTo）不算
  // 完整，一律清空 —— 宁可白拉一次，绝不因为「以为没变」而漏掉内容。
  recFp: string | null = null;
}
