// 全局状态（Svelte 5 runes store）+ 所有动作。组件只读状态、调动作，不直接碰 API。
//
// dimensio 版：单一工作页，无 launcher / 厂商整页层。厂商切换 = 页内浮层
// （app.vendorMenu），只换 provider 与身份标识，视觉不换装。
//
// ── 多会话并发架构（2026-07-19）────────────────────────────────────────────
// 服务端的 run 本来就是 per-session 后台 job（sessions Map，各自 running/
// runLog/watchers，互不干扰）；单会话限制纯粹是前端单例造成的。现在把
// 「每会话的直播状态」收进 Chat 实例：时间线、流式游标、SSE 连接、断线
// 对账循环全部 per-chat。app.chat = 前台正在看的那个；app.chats = 活跃池
// （含前台 + 后台运行中 + 终态 LRU 缓存）。切换会话 = 换指针，后台会话的
// 连接与恢复循环继续自转 —— 模型思考时可以自由切走、再开一个并行任务。

import * as api from "./api.ts";
import { t, tr } from "./i18n.ts";
import { applyTheme, VENDORS, type Appearance } from "./theme.ts";
import { withViewTransition } from "./motion.ts";
import { haptic } from "./touch.ts";
import { findSteerItem, resetStreamTurn } from "./stream-turn.ts";
import { mergeTimeline } from "./timeline-merge.ts";
import { insertAfter, permissionItemsFromMeta, planItemFromResult } from "./card-receipts.ts";
import { toResume, toSuspend } from "./page-streams.ts";
import * as tl from "./timeline-reducer.ts";
import { applySnapshot, noticeFor, type NotifyState, type StatusEvent } from "./notify-policy.ts";
import { compat, type Compat } from "./protocol.ts";
import { artifactHost } from "./open-artifact.ts";
import type { Builtin } from "./slash.ts";
import { MAX_SESSION_REFS, sessionRefsFrom, withSessionRef } from "./session-refs.ts";
import { paneLeft, placeInSplit, withFocusedReplaced, type Side } from "./split.ts";

// ── 时间线条目（类型在 timeline-types.ts，这里照旧导出）──────────────────────────────────────
export type { AgentRun, AgentStep, ArtifactItem, AskItem, AskOption, AskQuestion, AttachmentItem, GoalView, Item, PermissionItem, PlanItem, ToolItem, WorkflowRun } from "./timeline-types.ts";
import type { AgentRun, AskItem, AskOption, AskQuestion, AttachmentItem, GoalView, Item, PermissionItem, PlanItem, SessionRefView, ToolItem, WorkflowRun } from "./timeline-types.ts";

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
  ctx = $state({ used: 0, limit: 0 });
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
  // U2（X36 第二步）：还没送达的插话（输入框上方的待送达托盘）
  pendingSteers = $state<tl.PendingSteer[]>([]);
  lastSeenAt = Date.now(); // LRU 淘汰用（终态缓存按最近浏览排序）
  // 手里这份【完整】记录的服务端指纹。对账时 /status 的 fp 与它相同 = 什么都没变，
  // 直接跳过整份转录（长会话 300KB+）。只在完整重建时置位；镜像 base（upTo）不算
  // 完整，一律清空 —— 宁可白拉一次，绝不因为「以为没变」而漏掉内容。
  recFp: string | null = null;
}

// 同时运行上限（与 bridge Claude 分页一致）；终态缓存条数（切回秒开）。
const MAX_PARALLEL = 3;
const MAX_IDLE_CACHE = 6;
// 吐字批量落地间隔。
const STREAM_FLUSH_MS = 90;
// 断线对账链路的请求时限：半开连接的 fetch 永不 settle，一条挂死就够让
// resyncing 永久为真、之后每次对账都早退 —— 界面卡死在「重连中」。
const RESYNC_TIMEOUT_MS = 12_000;

// ── 工作区 Dock（右侧五工具面板：任务/审阅/终端/浏览器/文件）────────────────
export type DockTool = "tasks" | "review" | "term" | "browser" | "files";
const DOCK_TOOL_KEY = "harness.dockTool";
function readDockTool(): DockTool {
  try {
    const v = localStorage.getItem(DOCK_TOOL_KEY);
    if (v === "tasks" || v === "review" || v === "term" || v === "browser" || v === "files") return v;
  } catch { /* ignore */ }
  return "browser";
}

// ── 状态 ─────────────────────────────────────────────────────────────────────
export const app = $state({
  booted: false,
  needsSetup: api.needsSetup(),
  connError: "" as string, // 启动时连不上服务器的提示（Hero 显示）
  info: null as any,
  config: null as any,
  features: { sessions: false, files: false, projects: false } as api.Features,
  // M10：前后端协议兼容判断（服务端不再服务这么老的前端 / 服务端比前端要求的还老，Hero 与一次性提示据此说话）
  compat: null as Compat | null,

  appearance: (localStorage.getItem("harness.appearance") ?? "auto") as Appearance,
  // 对话流里的工作过程：false（默认）= 精简——连续的工具调用收成一行（在做什么 / 做了哪些），点开再看；
  // true = 显示全部（每一步平铺参数摘要、结果行与实时尾行）。设置里切，只存本机。
  feedDetail: localStorage.getItem("harness.feedDetail") === "1",

  chat: new Chat(), // 前台正在看的会话（分屏时 = 有焦点的那一格）
  chats: [] as Chat[], // 活跃池：前台 + 后台运行中 + 终态 LRU 缓存
  // 分屏（宽屏多会话，把侧栏的会话块拖进正文区）：左右两格各是哪个会话；空 = 没分屏。app.chat 恒为其中一个——
  // 发送、档位、工作区、回滚都跟着有焦点的那一格走（点哪一格、焦点落进哪一格，哪一格就是 app.chat）。
  panes: [] as Chat[],

  // Agent 浏览器（服务端共享 headless Chrome 的 screencast 直播）—— 全局单例
  browser: null as { url: string } | null,
  // 工作区 Dock：右侧面板开关 + 当前工具（工具选择持久化，重开记住上次）
  dockOpen: false,
  dockTool: readDockTool(),
  // 文件视图的定位目标（产物卡点开走它）：{ seq, rel, open }——rel=要打开的目录，
  // open=落地后自动预览的文件名，seq 递增让宿主 {#key} 每次都重挂（初始路径是
  // 挂载时一次性消费的）。null = 默认行为：以工作空间根打开。
  filesTarget: null as null | { seq: number; rel: string; open: string },
  // 「任务」视图的定位（点对话里的 Workflow 卡 / Agent 行进来，= bridge Claude 分页 openTaskDetail）：
  // tasksFocus.toolId = 要滚到可见并描边一闪的那条工具行，seq 递增让同一条再点也重来一次；
  // tasksAgent = 压在任务列表之上的子 agent 转录视图。存 id 不存对象：断线对账会把时间线条目
  // 换成记录重建版，对象引用会悬空。
  tasksFocus: null as null | { toolId: string; seq: number },
  tasksAgent: null as null | { toolId: string; agentId: string },
  // 宿主是否注入了工作空间文件视图（bridge 嵌入态有，独立 8799 没有）——
  // 产物卡据此决定「进右侧工作区读」还是回落全屏查看器。
  hasFilesView: false,
  // 宿主是否接管了「选工作空间文件夹」（bridge 嵌入态有：桌面壳唤起系统原生选择器，
  // 网页/手机开工作空间文件管理器+底部拖入栏）。独立 8799 没有 → 回落自带目录对话框。
  hasHostPicker: false,
  // 共享浏览器的标签列表（stream 的 tabs 事件驱动；空 = 浏览器没跑）
  browserTabs: [] as { id: string; url: string; title: string; active: boolean }[],

  sessions: [] as SessionMeta[],
  sessionsLoading: false,
  // 服务端会话总数（-1 = 未知，见 api.listSessionsPage）与「还能再加载」判定，
  // 抽屉底部据此给出「加载更多」——以前列表在第 100 条硬截断，更旧的够不着。
  sessionsTotal: -1,
  sessionsMore: false,
  projects: [] as ProjectMeta[],
  projectsLoading: false,

  vendorMenu: false, // 厂商切换浮层（左上角 logo 节点呼出）
  drawer: false,
  sheet: null as null | "settings" | "attach" | "checkpoints" | "setup" | "memory",
  // K4：记忆面板看的是哪个项目（项目菜单里点「项目记忆」时定）
  memoryFor: null as null | { path: string; name: string },
  // K11：记忆面板是从设置里点进来的——返回键 / 左上角「‹」回到设置，而不是整个关掉
  memoryFromSettings: false,
  // 独立 8799 的兜底目录对话框开关（bridge 嵌入态用不到——选择器由宿主接管）
  projectModal: false,
  lightbox: null as null | { src: string; caption?: string },
  toast: "" as string,
  // U9：带一个动作的 toast（「撤销」）——点了就跑、跑完收起
  toastAction: null as null | { label: string; run: () => void },
  // M3：run 结束时没送进模型的插话退回来，由 Composer 接住放回输入框（接完置回 null）。
  refill: null as string | null,
});
app.chats.push(app.chat);

// ── Dock 动作 ────────────────────────────────────────────────────────────────
export function openDock(tool?: DockTool) {
  if (tool) setDockTool(tool);
  app.dockOpen = true;
}
export function closeDock() {
  app.dockOpen = false;
  app.tasksFocus = null;
  app.tasksAgent = null;
  // 关掉就清定位：下次打开是干净的工作空间视图，不会莫名跳回上次那个产物目录
  //（同一次打开内切工具再切回来则保留，算连续浏览）。
  app.filesTarget = null;
}
export function toggleDock() {
  // 关的那一支走 closeDock：清掉任务定位 / 文件定位，免得下次打开落回上次那个产物目录
  if (app.dockOpen) closeDock();
  else app.dockOpen = true;
}
export function setDockTool(tool: DockTool) {
  app.dockTool = tool;
  try {
    localStorage.setItem(DOCK_TOOL_KEY, tool);
  } catch { /* ignore */ }
}

// 在工作台「文件」视图里打开工作空间的某个位置：产物卡点开走这里（对齐 bridge
// Claude 分页的 openDockFiles）。rel = 工作空间内的相对目录，open = 落地后自动
// 弹出面板内预览的文件名。
let filesSeq = 0;
export function openDockFiles(target: { rel?: string; open?: string } = {}) {
  app.filesTarget = { seq: ++filesSeq, rel: target.rel ?? "", open: target.open ?? "" };
  openDock("files");
}

// 在工作台「任务」视图里定位一条 Agent / Workflow 工具行；给 agentId 就直接压上那个子 agent 的
// 转录视图（Agent 行 / 工作流详情里的 agent 表行）。
let taskSeq = 0;
export function openTaskDetail(toolId: string, agentId?: string) {
  app.tasksFocus = { toolId, seq: ++taskSeq };
  app.tasksAgent = agentId ? { toolId, agentId } : null;
  openDock("tasks");
}
export function openTaskAgent(toolId: string, agentId: string) {
  app.tasksAgent = { toolId, agentId };
}
export function backToTaskList() {
  app.tasksAgent = null;
}

// Dock 快捷键：Ctrl+Shift+G 审阅 / Ctrl+` 终端 / Ctrl+Shift+B 浏览器 / Ctrl+Shift+E 文件；同键再按 = 关 Dock。
// 避开浏览器保留键（Ctrl+T/W/N 之类拦不了，不用）。只在 dimensio 挂着时由 App 的 window keydown 调用——
// 以前是模块顶层监听，bridge 静态 import 本模块，结果 bridge 的每个分页都吞掉了这四个组合键。
const DOCK_KEYS: { tool: DockTool; match: (e: KeyboardEvent) => boolean }[] = [
  { tool: "review", match: (e) => e.ctrlKey && e.shiftKey && e.code === "KeyG" },
  { tool: "term", match: (e) => e.ctrlKey && !e.shiftKey && e.code === "Backquote" },
  { tool: "browser", match: (e) => e.ctrlKey && e.shiftKey && e.code === "KeyB" },
  { tool: "files", match: (e) => e.ctrlKey && e.shiftKey && e.code === "KeyE" },
];
// 服务端注册了浏览器工具吗（/api/info 的 tools 里有 Browser）。没装 Chromium 系浏览器的机器上没有——工作区不摆「浏览器」。
// info 还没到时按有算（不闪）。
export function browserToolAvailable(): boolean {
  const tools = app.info?.tools;
  return !Array.isArray(tools) || tools.includes("Browser");
}

export function handleDockShortcut(e: KeyboardEvent): boolean {
  for (const k of DOCK_KEYS) {
    if (!k.match(e)) continue;
    if (k.tool === "browser" && !browserToolAvailable()) return false;
    e.preventDefault();
    if (app.dockOpen && app.dockTool === k.tool) closeDock();
    else openDock(k.tool);
    return true;
  }
  return false;
}

export const vendorId = () => app.config?.provider ?? "anthropic";

// 后台（非前台）还在跑/在对账的会话数 —— Header 徽标、抽屉标识用。
export function backgroundRunning(): Chat[] {
  return app.chats.filter((c) => !paneVisible(c) && (c.running || c.reconnecting));
}
// 这个会话此刻在屏幕上（前台，或分屏里的另一格）：看得见的就不必再提醒「后台对话怎样了」
export function paneVisible(chat: Chat): boolean {
  return chat === app.chat || app.panes.includes(chat);
}
// 这个会话是否在本机有活跃连接（列表标识比服务端快照更实时）。
export function chatRunning(id: string): boolean {
  return app.chats.some((c) => c.id === id && (c.running || c.reconnecting));
}
function runningCount(): number {
  return app.chats.filter((c) => c.running || c.reconnecting).length;
}

// 背景网格脉冲（维度切换的信号灯；AxisGrid 监听）
export function pulseGrid() {
  window.dispatchEvent(new CustomEvent("dimensio-pulse"));
}

let toastTimer = 0;
let lastProbeAt = 0; // 空闲态对账节流（前台）
const LAST_SESSION_KEY = "harness.lastSession";

function rememberSession(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch { /* ignore */ }
}

// ── 时间线归约（逻辑在 timeline-reducer.ts；这里只把 Chat 的定时器、toast、全局指示器接成 effects）──
function flushControl(chat: Chat): tl.FlushControl {
  return {
    scheduleFlush: () => {
      if (chat.flushTimer) return;
      chat.flushTimer = window.setTimeout(() => {
        chat.flushTimer = 0;
        flushStream(chat);
      }, STREAM_FLUSH_MS);
    },
    cancelFlush: () => {
      if (chat.flushTimer) {
        clearTimeout(chat.flushTimer);
        chat.flushTimer = 0;
      }
    },
  };
}

function effectsFor(chat: Chat): tl.TimelineEffects {
  return {
    ...flushControl(chat),
    foreground: chat === app.chat, // 只有前台会话允许弹面板 / 改全局指示器 / 记忆 lastSession
    visible: paneVisible(chat), // 分屏里另一格也看得见：「后台对话在等你」这类提示不用弹
    toast,
    rememberSession,
    // 分栏形态（≥700，与 App 的布局门槛同一条线）才自动展开浏览器面板；手机只亮胶囊
    openBrowserPane: () => {
      if (matchMedia("(min-width: 700px)").matches) openDock("browser");
    },
    setGlobal: (patch) => {
      if (app.config) app.config = { ...app.config, ...(patch as any) };
    },
    refill: (text) => {
      app.refill = text;
    },
    setBrowser: (url) => {
      app.browser = { url };
    },
  };
}

const pushItem = (chat: Chat, item: Item): any => tl.pushItem(chat, item);
const flushStream = (chat: Chat) => tl.flushStream(chat, flushControl(chat));
const dropStream = (chat: Chat) => tl.dropStream(chat, flushControl(chat));
const settleCursors = (chat: Chat) => tl.settleCursors(chat, flushControl(chat));
const { extractText, agentRunFromMeta, workflowRunFromMeta } = tl;

// ── 启动 ─────────────────────────────────────────────────────────────────────
export async function boot() {
  pageAway = false; // #93：每次进页 App 重挂、重走 boot
  applyTheme(app.appearance);
  // 重算而不是用模块加载时的快照：嵌入宿主的 configureApi 在组件实例化时才注入，
  // 模块加载先于它——appassets 壳（手机 apk）上快照恒 true，会把 bridge 分页
  // 误关进手动连接门（2026-08-05 两渠道 apk 实证）。
  app.needsSetup = api.needsSetup();
  if (app.needsSetup) {
    app.booted = true;
    app.sheet = "setup";
    return;
  }
  await api.initRoute(); // bridge 模式：先探学习过的 LAN，能直连就不走隧道
  await reloadMeta();
  app.booted = true;
  await Promise.all([
    app.features.sessions ? refreshSessions() : Promise.resolve(),
    app.features.projects ? refreshProjects() : Promise.resolve(),
  ]);
  // #93：离开页面时收掉的运行流接回来（列表刚刷新过，服务端此刻在跑哪些是准的）
  resumeLiveStreams();
  // 服务端还有会话在跑（本机被杀 / 别的设备发起）→ 全部接上直播（后台），
  // 上次看的那个若在其中则放前台。
  if (app.features.sessions) void resumeRunningSessions();
  if (app.features.sessions) startGlobalEvents();
}

// ── P8（K30、K35、X34）：全局事件通道 ──────────────────────────────────────────
// 一条长连接收所有会话的状态变化：侧栏的「运行中 / 等你」随之更新（不必轮询整张列表），并在人没看着时通知——
// 页面隐藏（锁屏、切走）发系统通知（apk 里走原生 showNotification，浏览器里走 Notification），页面可见但不在
// 那个会话就应用内提示。去重与基线规则在 notify-policy.ts。WebView 被冻结后这里就收不到了——那种情况由 bridge
// apk 的原生服务轮询 /api/pending 兜底。
const notifyState: NotifyState = { notified: new Set(), wasRunning: new Map() };
let globalStarted = false;

function startGlobalEvents() {
  if (globalStarted) return;
  globalStarted = true;
  void (async () => {
    let backoff = 1000;
    for (;;) {
      const ctl = new AbortController();
      let aliveAt = Date.now();
      // 半开的死连接：服务端 15 秒一个 ping，45 秒没有任何字节就撕掉重连
      const watchdog = setInterval(() => {
        if (Date.now() - aliveAt > 45_000) ctl.abort();
      }, 10_000);
      try {
        await api.globalEvents(
          (ev) => {
            backoff = 1000;
            onGlobalEvent(ev);
          },
          ctl.signal,
          () => (aliveAt = Date.now()),
        );
      } catch (e: any) {
        if (e?.status === 404) {
          clearInterval(watchdog);
          return; // 旧后端没有全局通道：不再连（列表照旧靠刷新）
        }
      }
      clearInterval(watchdog);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  })();
}

let listRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function applyStatus(id: string, running: boolean, waiting: SessionMeta["waiting"]) {
  const row = app.sessions.find((s) => s.id === id);
  if (row) {
    row.running = running;
    row.waiting = waiting;
  } else if (running && !listRefreshTimer) {
    // 列表里还没有它（别的设备刚新建的）：合并一下再刷新整张列表
    listRefreshTimer = setTimeout(() => {
      listRefreshTimer = null;
      void refreshSessions();
    }, 1500);
  }
}

function onGlobalEvent(ev: any) {
  if (ev?.e === "snapshot") {
    const rows = (Array.isArray(ev.sessions) ? ev.sessions : []) as StatusEvent[];
    applySnapshot(notifyState, rows);
    for (const row of rows) applyStatus(row.id, row.running, row.waiting?.kind ?? null);
    return;
  }
  if (ev?.e !== "session_status") return;
  const status = ev as StatusEvent;
  applyStatus(status.id, status.running, status.waiting?.kind ?? null);
  // O7：服务端自己起的一轮（目标续跑的下一轮、重启后续跑）——本地开着这个对话却没在跑，接上直播
  // #93：人不在 dimensio 页就先记着，回到页面再接（页外不开运行流）
  const open = app.chats.find((c) => c.id === status.id);
  if (status.running && open && !open.running && !open.reconnecting) {
    if (pageAway) open.suspended = true;
    else forceResync(open);
  }
  const resident = new Set(app.chats.filter((c) => c.id && c.abortCtl).map((c) => c.id as string));
  const notice = noticeFor(notifyState, status, {
    hidden: typeof document !== "undefined" && document.hidden,
    foregroundId: app.chat.id,
    residentIds: resident,
  });
  if (!notice) return;
  if (notice.toast) toast(notice.toast);
  if (notice.system) systemNotify(notice.system.title, notice.system.text);
}

function notifyEnabled(): boolean {
  try {
    return localStorage.getItem("bridge-notify") !== "0";
  } catch {
    return true; // 读不到设置就照常
  }
}

// apk 壳（新版）里：发起一轮时拉起原生跟踪服务（此刻必在前台，Android 12+ 才准启前台服务）。App 退后台 / 锁屏、
// WebView 被冻结之后，由它轮询 /api/pending 发「等你处理」「跑完了」通知。旧壳没有这个方法就什么都不做。
function startNativeWatch() {
  if (!notifyEnabled()) return;
  try {
    (window as any).AndroidStore?.startHarnessWatch?.();
  } catch { /* 旧壳 */ }
}

// 系统通知：apk 壳里走原生 showNotification；浏览器里用 Notification（已授权时）。尊重 bridge 设置页的「通知」开关。
// 原生跟踪服务在跑时交给它发（同一件事不响两次）。
function systemNotify(title: string, text: string) {
  if (!notifyEnabled()) return;
  try {
    const native = (window as any).AndroidStore;
    if (native?.isHarnessWatching?.()) return;
    if (native?.showNotification) {
      native.showNotification(title, text);
      return;
    }
  } catch { /* 落到浏览器通知 */ }
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body: text });
  } catch { /* 没有通知能力就算了 */ }
}

let compatNoted = "";

export async function reloadMeta() {
  try {
    const [info, config] = await Promise.all([api.getInfo(), api.getConfig()]);
    // M10：服务端报了能力位就不再挨个探端点（只有 M10 之前的后端才探）
    const c = compat(info);
    const features = await api.detectFeatures(c.caps);
    app.info = info;
    app.config = config;
    app.features = features;
    app.compat = c;
    app.connError = "";
    // 不兼容就明说一次（Hero 上常驻一条；在会话里的人靠这条提示）
    const note = c.clientTooOld ? t("App 版本过旧，服务端已不再支持，请更新到最新版") : c.serverTooOld ? t("服务端版本较旧，部分功能可能用不了，请更新服务端") : "";
    if (note && note !== compatNoted) toast(note);
    compatNoted = note;
  } catch (e: any) {
    // 连不上：Hero 给入口提示（壳里点开连接设置，网页端提示检查服务）
    app.connError = tr(String(e?.message ?? e ?? t("连接失败")));
  }
}

export function setFeedDetail(on: boolean) {
  app.feedDetail = on;
  try {
    if (on) localStorage.setItem("harness.feedDetail", "1");
    else localStorage.removeItem("harness.feedDetail");
  } catch {
    /* 隐私模式等写不进去：本次会话照样生效 */
  }
}

export function setAppearance(a: Appearance) {
  app.appearance = a;
  localStorage.setItem("harness.appearance", a);
  // 深浅切换整页交叉淡化（浏览器支持视图过渡时），不是一帧硬切
  withViewTransition(() => applyTheme(a));
}

// 系统深浅变化时（auto 档）即时跟随
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (app.appearance === "auto") applyTheme("auto");
});

// ── 提示 ─────────────────────────────────────────────────────────────────────
export function toast(msg: string, action?: { label: string; run: () => void }) {
  app.toast = msg;
  app.toastAction = action ?? null;
  clearTimeout(toastTimer);
  // 带动作的多留一会儿，给人反应的时间
  toastTimer = window.setTimeout(() => ((app.toast = ""), (app.toastAction = null)), action ? 8000 : 2600);
}

// ── 事件归约（per-chat：后台会话的事件写进它自己的时间线）────────────────────
function handleEvent(chat: Chat, ev: any) {
  tl.reduceTimeline(chat, ev, effectsFor(chat));
}

// P10：卡片落定的结果——ok 送达；gone 卡已经失效（超时 / 这一轮已结束 / 别的设备先定了）；failed 没送达（网络）。
// quiet：输入框里的话落到卡上（N43）时由调用方自己说明，这里不另弹提示。
export type CardReply = "ok" | "gone" | "failed";

// 权限卡：把裁决回传。乐观置位，服务端广播 permission_resolved 再确认（幂等）。
// scope："prefix" = 本会话按前缀允许（记下卡片上显示的那几条前缀规则）；"deny_stop" = 拒绝并停止这一轮
// P10：note = 拒绝时附的话（N43：输入框里的话落到卡上——文字只走拒绝方向）
export async function decidePermission(
  id: string,
  decision: "once" | "session" | "deny" | "deny_stop",
  scope?: "prefix",
  note?: string,
  quiet = false,
): Promise<CardReply> {
  const chat = app.chat;
  const ref = chat.permRefs.get(id);
  if (!chat.id || !ref || ref.decided) return "gone";
  ref.decided = decision;
  if (scope) ref.scope = scope;
  if (note && decision === "deny") ref.note = note;
  haptic("light");
  // P6：拒绝并停止 = 服务端一步拒掉并停下这一轮。本端照停止键的做法先断开实时流（停下来的 aborted 不当错误显示），
  // 再送裁决；没送达就重新接上。
  const stopping = decision === "deny_stop";
  if (stopping) killLive(chat);
  try {
    const res = await api.decidePermission(chat.id, id, decision, scope, note);
    if (res && res.ok === false) {
      // P7：卡片已经失效（超时按拒绝处理了 / 这一轮已结束）——别装作点成功了
      ref.decided = null;
      ref.scope = undefined;
      ref.note = undefined;
      ref.cancelled = true;
      if (!quiet) toast(t("这张卡已经失效了（超时或这一轮已结束），没送达"));
      if (stopping) forceResync(chat);
      return "gone";
    }
  } catch {
    ref.decided = null; // 没送达 → 退回可点，用户可重试
    ref.scope = undefined;
    ref.note = undefined;
    if (!quiet) toast(t("没送达，请再点一次"));
    if (stopping) forceResync(chat);
    return "failed";
  }
  if (stopping) {
    settleCursors(chat);
    chat.running = false;
    chat.activity = "";
    chat.runId = null;
    if (app.features.sessions) refreshSessions();
  }
  return "ok";
}

// 计划卡：批准 / 退回（退回可带一句修改意见）。
export async function decidePlan(id: string, approved: boolean, note?: string, quiet = false): Promise<CardReply> {
  const chat = app.chat;
  const ref = chat.planRefs.get(id);
  if (!chat.id || !ref || ref.decided) return "gone";
  ref.decided = approved ? "approved" : "returned";
  if (!approved && note) ref.note = note;
  haptic("light");
  try {
    const res = await api.decidePlan(chat.id, id, approved, note);
    if (res && res.ok === false) {
      // P7：计划卡已经失效（超时 / 这一轮已结束）
      ref.decided = null;
      ref.note = undefined;
      ref.cancelled = true;
      if (!quiet) toast(t("这份计划的审批已经失效了（超时或这一轮已结束），没送达"));
      return "gone";
    }
  } catch {
    ref.decided = null;
    ref.note = undefined;
    if (!quiet) toast(t("没送达，请再点一次"));
    return "failed";
  }
  return "ok";
}

// P10（N43）：输入框里的话落到停着的那张卡上。权限卡 = 拒绝并附上这段话（文字永远不能批准）；提问 = 每题都以这段话作
// 「其他」答案；计划 = 退回并附上这段话。卡已经不在等了（别的设备先定了 / 失效了）返回 "gone"，由调用方改作插话。
async function replyToCard(chat: Chat, id: string, text: string): Promise<CardReply> {
  const perm = chat.permRefs.get(id);
  if (perm) return perm.decided || perm.cancelled ? "gone" : decidePermission(id, "deny", undefined, text, true);
  const plan = chat.planRefs.get(id);
  if (plan) return plan.decided || plan.cancelled ? "gone" : decidePlan(id, false, text, true);
  const ask = chat.askRefs.get(id);
  if (ask) return ask.answered ? "gone" : answerAsk(id, ask.questions.map(() => ({ selected: [text], custom: true })), true);
  return "gone";
}

// ── 发送 / 停止 / 新会话 ─────────────────────────────────────────────────────

// 运行中插话：先乐观上屏（用户立刻看到自己说了什么），再投给服务端。
// 服务端 409 = 那一轮刚好结束 → 回退成正常发送，消息不丢。
async function steerRunning(chat: Chat, msg: string) {
  if (!chat.id) {
    toast(t("这一轮还没建立会话，稍等一下再插话"));
    return;
  }
  // U2（#46）：插话的身份——乐观放进待送达托盘，服务端回来的 steer_queued / applied / returned 按它对号
  const steerId = newId("s");
  chat.pendingSteers.push({ id: steerId, text: msg });
  haptic("light");
  const dropBubble = () => {
    tl.takePendingSteer(chat, steerId, msg);
    const i = findSteerItem(chat.timeline, { id: steerId });
    if (i >= 0) chat.timeline.splice(i, 1);
  };
  try {
    await api.steer(chat.id, msg, chat.runId, steerId);
  } catch (e: any) {
    if (e?.status === 409 && e?.message === "run_mismatch") {
      // M2（#44）：本端以为还在跑的那一轮已经结束，此刻在跑的是另一台设备新起的一轮——这句纠偏不能
      // 带着「优先于此前的指示」注进别人的那一轮。撤掉气泡、放回输入框，接上正在跑的那一轮让人看清再说。
      dropBubble();
      if (chat === app.chat) app.refill = msg;
      toast(t("你插话的那一轮已经结束，现在在跑的是另一台设备发起的；话已放回输入框"));
      forceResync(chat);
      return;
    }
    if (e?.status === 409) {
      // 那一轮已经结束：把刚才乐观插入的气泡撤掉，按正常一轮重发。
      dropBubble();
      chat.running = false;
      await send(msg);
      return;
    }
    pushItem(chat, { kind: "error", text: t("插话没送达：{reason}", { reason: tr(String(e?.message ?? e)) }) });
  }
}
// M11（N33）：新会话用界面此刻显示的配置（顶栏的项目、输入框旁的型号 / 思考 / 档位 / 访问范围都读 app.config）。
// 服务端的全局值可能刚被另一台设备改了——手机切的项目、整机访问、auto 档以前会串进这台设备新建的对话。
function displayedConfig(): api.RunConfig | undefined {
  const c = app.config;
  if (!c) return undefined;
  const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    provider: pick(c.provider),
    model: pick(c.model),
    thinking: pick(c.thinking),
    workspace: pick(c.workspace),
    access: pick(c.access),
    permissionMode: pick(c.permissionMode),
  };
}

// cardTarget（P10，N43）：这段话要回应的那张停着的卡（输入框算好的：草稿开始写时它已经停着）。
export async function send(raw: string, cardTarget?: string | null) {
  const chat = app.chat;
  const msg = raw.trim();
  if (!msg && !chat.attachments.length && !chat.refs.length) return;
  // 运行中发送 = 插话/转向（服务端在下一个回合边界注入），不再是「被禁用」。
  // 附件不走这条路：注入点是纯文本消息，带附件的请等这一轮结束。
  if (chat.running) {
    if (!msg) return;
    if (cardTarget) {
      const reply = await replyToCard(chat, cardTarget, msg);
      if (reply === "ok") return;
      if (reply === "failed") {
        // 没送达：话放回输入框，卡还停着，可以再发一次或直接点卡片
        if (chat === app.chat) app.refill = msg;
        toast(t("没送达，话已放回输入框"));
        return;
      }
      // 卡已经不在等了（别的设备先定了 / 失效了）：这段话改作插话，不丢
      toast(t("那张卡已经处理过了，这段话作为插话发出"));
    }
    await steerRunning(chat, msg);
    return;
  }
  if (runningCount() >= MAX_PARALLEL) {
    toast(t("最多同时运行 {n} 个对话，先等一个跑完", { n: MAX_PARALLEL }));
    return;
  }
  const paths = [...chat.attachments];
  const attachments: AttachmentItem[] = paths.map((path) => ({
    path,
    kind: path.endsWith("/")
      ? "folder"
      : /\.(?:png|jpe?g|webp|gif|heic|heif)$/i.test(path) ? "image" : "file",
  }));
  // 引用会话：旧服务端不认 refs——芯片留在输入框里（不假装引用过）
  const refs = canRefSessions() ? chat.refs.slice() : [];
  const refKey = (list: SessionRefView[] | undefined) => (list ?? []).map((r) => r.id).join("\n");
  // M2（#51）：这一条的发送身份。上一条没送达、用户原样再发 → 沿用同一个 id（其实已落地的话服务端认得出）。
  const prior = chat.undelivered;
  const clientRunId =
    prior && prior.text === msg && prior.paths.join("\n") === paths.join("\n") && refKey(prior.refs) === refKey(refs)
      ? prior.clientRunId
      : newClientRunId();
  const draft = { clientRunId, text: msg, paths, ...(refs.length ? { refs } : {}) };
  // O7：输入框上「目标」开着——这一条开一个目标（发出去就收起；被拒收再还回去）
  const goalDraft = chat.goalDraft?.on && msg ? chat.goalDraft : null;
  const goal = goalDraft ? { maxRounds: goalDraft.maxRounds, ...(goalDraft.verify.trim() ? { verify: goalDraft.verify.trim() } : {}) } : undefined;
  if (goalDraft) chat.goalDraft = null;
  chat.undelivered = null;
  chat.attachments = [];
  if (refs.length) chat.refs = [];
  pushItem(chat, { kind: "user", text: msg, attachments, ...(refs.length ? { refs: refs.map(({ id, title }) => ({ id, title })) } : {}) });
  settleCursors(chat); // 上一轮若异常收尾，残留 live 旗子在此掐灭
  chat.running = true;
  chat.activity = t("思考中");
  if (!chat.title) chat.title = msg.replace(/\s+/g, " ").slice(0, 60) || t("新任务");
  haptic("light");
  startNativeWatch();
  const gen = ++chat.liveGen;
  chat.resyncAttempt = 0;
  chat.abortCtl = new AbortController();
  let sawEnd = false; // 服务端确认本轮结束（closed）；没等到 = 断流，不是结束
  let delivered = false; // 收到 session 回执 = 这一轮已在服务端起来
  let rejected = ""; // 服务端明确拒收（非 2xx）：这一条没起一轮
  try {
    chat.lastByteAt = Date.now();
    await api.runStream(
      {
        sessionId: chat.id,
        message: msg,
        attachments: paths,
        clientRunId,
        ...(chat.id ? {} : { config: displayedConfig() }),
        ...(goal ? { goal } : {}),
        ...(refs.length ? { refs: refs.map((r) => r.id) } : {}),
      },
      (ev) => {
        if (gen !== chat.liveGen) return;
        if (ev.e === "closed") {
          sawEnd = true;
          return;
        }
        if (ev.e === "session") delivered = true;
        if (ev.e === "error" && typeof ev.status === "number") {
          if (ev.status === 409 && ev.body?.error === "duplicate_run" && typeof ev.body.sessionId === "string") {
            // 同一条其实早已落地（上次只是回包没到）：接上那一轮，不重起
            delivered = true;
            chat.id = ev.body.sessionId;
            return;
          }
          rejected = String(ev.message ?? `HTTP ${ev.status}`);
          return;
        }
        handleEvent(chat, ev);
      },
      chat.abortCtl.signal,
      () => {
        if (gen === chat.liveGen) chat.lastByteAt = Date.now();
      },
    );
  } catch (e: any) {
    // 主动收线（stop / forceResync）都先 ++liveGen 再 abort，在此已被世代
    // 挡掉；能走到这的都是意外死亡的连接 —— 一律对账恢复，绝不当结束。
    if (gen !== chat.liveGen) return;
    if (!delivered) {
      // 回执没到：可能 POST 根本没落地（真·发送失败），也可能落地了、事件却没回来——先问服务端再定性。
      void confirmDelivery(chat, gen, draft, String(e?.message ?? e));
      return;
    }
    scheduleResync(chat, gen, 0); // 断流 ≠ 结束：对账后续播或收终态
    return;
  }
  if (gen !== chat.liveGen) return;
  if (rejected) {
    if (goalDraft) chat.goalDraft = goalDraft;
    undelivered(chat, gen, draft, rejected);
    // 常见的是 409「已经在跑」（另一台设备刚起了一轮）：接上它看清楚；草稿在输入框里不受影响
    if (chat.id) forceResync(chat);
    return;
  }
  if (sawEnd) {
    finishRun(chat, gen);
    return;
  }
  // 没等到 closed 就散场（中间层安静掐断）。回执没到 → 先问落地没有；到了 → 对账续上。
  if (!delivered) {
    void confirmDelivery(chat, gen, draft, "");
    return;
  }
  scheduleResync(chat, gen, 0);
}

// M2 / U2：发送 / 插话的身份。非安全上下文（局域网 http 直连）没有 crypto.randomUUID，用 getRandomValues 拼。
function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
const newClientRunId = () => newId("c");

// M2（#51）：回执没到时问服务端「这一条落地了没有」。落地了 → 接上那一轮；确定没落地 → 撤掉气泡、
// 文字和附件放回输入框（不自动重发）；问不到（网络还没回来 / 旧后端没这个接口）→ 退回旧的认领 / 对账。
async function confirmDelivery(
  chat: Chat,
  gen: number,
  draft: { clientRunId: string; text: string; paths: string[]; refs?: SessionRefView[] },
  failMsg: string,
) {
  if (gen !== chat.liveGen) return;
  chat.reconnecting = true;
  chat.activity = t("确认是否送达");
  const hit = await api.lookupRun(draft.clientRunId, RESYNC_TIMEOUT_MS);
  if (gen !== chat.liveGen) return;
  if (hit?.known && hit.sessionId) {
    chat.id = hit.sessionId;
    if (chat === app.chat) rememberSession(hit.sessionId);
    scheduleResync(chat, gen, 0);
    return;
  }
  if (hit && !hit.known) {
    undelivered(chat, gen, draft, failMsg || t("网络中断"));
    return;
  }
  if (!chat.id) {
    void adoptOrphanRun(chat, gen, failMsg);
    return;
  }
  scheduleResync(chat, gen, 0);
}

function undelivered(
  chat: Chat,
  gen: number,
  draft: { clientRunId: string; text: string; paths: string[]; refs?: SessionRefView[] },
  reason: string,
) {
  if (gen !== chat.liveGen) return;
  const i = chat.timeline.findLastIndex((it: any) => it.kind === "user" && !it.steer && it.text === draft.text);
  if (i >= 0) chat.timeline.splice(i, 1);
  chat.undelivered = draft;
  if (draft.paths.length) chat.attachments = [...draft.paths];
  if (draft.refs?.length) chat.refs = [...draft.refs];
  if (chat === app.chat) app.refill = draft.text;
  else chat.pendingRefill = draft.text;
  const why = tr(reason);
  toast(
    chat === app.chat
      ? t("消息没送达（{reason}），已放回输入框，确认后再发", { reason: why })
      : chat.title
        ? t("「{title}」消息没送达（{reason}），已放回输入框，确认后再发", { title: tr(chat.title), reason: why })
        : t("「后台对话」消息没送达（{reason}），已放回输入框，确认后再发", { reason: why }),
  );
  chat.reconnecting = false;
  finishRun(chat, gen);
}

// 新会话首轮断流的收场：POST 可能已经落地、服务端那一轮正在后台跑（手机切网
// 最容易撞这个窗口），本地却连 sessionId 都还没拿到，没有东西可对账。探一次
// 会话列表认领：在跑 + 不在本地活跃池 + 标题对得上（服务端标题就是首句 60 字，
// 与本地同规则）；只有一个陌生的在跑会话时也认（纯附件轮的标题两边不同款）。
// 认到 = 接上直播续看；认不到才算真发送失败。
async function adoptOrphanRun(chat: Chat, gen: number, failMsg: string) {
  if (gen !== chat.liveGen) return;
  chat.reconnecting = true;
  chat.activity = t("重连中");
  let found: SessionMeta | undefined;
  try {
    const page = await api.listSessionsPage(0, 10, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen) return;
    const known = new Set(app.chats.map((c) => c.id).filter(Boolean) as string[]);
    const strangers = (page.items as SessionMeta[]).filter((s) => s.running && !known.has(s.id));
    found = strangers.find((s) => s.title === chat.title) ?? (strangers.length === 1 ? strangers[0] : undefined);
  } catch { /* 连不上 → 按发送失败收场，用户可重发 */ }
  if (gen !== chat.liveGen) return;
  if (found) {
    chat.id = found.id;
    if (chat === app.chat) rememberSession(found.id);
    scheduleResync(chat, gen, 0); // 走统一对账：重建 base + 附着直播
    return;
  }
  chat.reconnecting = false;
  if (failMsg) pushItem(chat, { kind: "error", text: failMsg });
  finishRun(chat, gen);
}

// 权威收尾：只有确认服务端本轮真的结束（closed / mirror_end / status 说没在跑）
// 才降 running。断流路径一律走 scheduleResync，绝不从这里出。
function finishRun(chat: Chat, gen: number) {
  if (gen !== chat.liveGen) return;
  settleCursors(chat); // 断流没等到 done 也要掐灭 live 旗子
  const wasRunning = chat.running;
  if (wasRunning) chat.lastRunEndAt = Date.now();
  chat.running = false;
  chat.activity = "";
  chat.reconnecting = false;
  chat.abortCtl = null;
  chat.runId = null;
  // U2：这一轮收尾了，待送达托盘里还剩的（没等到 steer_returned 就断了流）放回输入框，不留残条
  if (chat.pendingSteers.length) {
    const left = chat.pendingSteers.map((p) => p.text);
    chat.pendingSteers = [];
    if (chat === app.chat) app.refill = left.join("\n");
  }
  // 后台会话跑完了 → 提醒（前台、分屏里的另一格自己看得见，不吵）
  if (wasRunning && !paneVisible(chat) && chat.id) {
    toast(chat.title ? t("「{title}」已完成", { title: tr(chat.title) }) : t("「后台对话」已完成"));
    haptic("light");
  }
  if (app.features.sessions) refreshSessions();
}

// 提交一个 AskUserQuestion 回答。answers 与卡片问题同序。乐观标记已答（随后的
// ask_answer 事件再确认一次，幂等）；POST 失败则回滚，允许重试。
export async function answerAsk(
  id: string,
  answers: { selected: string[]; custom?: boolean }[],
  quiet = false,
): Promise<CardReply> {
  const chat = app.chat;
  const ref = chat.askRefs.get(id);
  if (!ref || ref.answered || !chat.id) return "gone";
  ref.answered = true;
  ref.questions.forEach((q, i) => {
    ref.selected[q.id] = answers[i]?.selected ?? [];
  });
  chat.activity = t("思考中");
  haptic("light");
  try {
    const res = await api.answerAsk(chat.id, id, answers);
    if (!res?.ok) {
      // 服务端说这个 ask 已失效（P7 超时 / 这一轮已结束 / 被别的设备先答了）。答案没送到 agent——以前保持已答视图、
      // 不吭声，用户以为答上了。现在说一声，并清掉本端写上去的所选；别的设备先答的（ask_answer 已经写回来、和本端
      // 这次不一样）留着。按内容比，不按引用比：Svelte 5 的深代理读回来的不是原数组。
      const mine = ref.questions.every((q, i) => JSON.stringify(ref.selected[q.id] ?? []) === JSON.stringify(answers[i]?.selected ?? []));
      if (mine) ref.questions.forEach((q) => (ref.selected[q.id] = []));
      if (!quiet) toast(t("这个问题已经失效了（超时或这一轮已结束），这次的答案没送到"));
      return "gone";
    }
  } catch (e: any) {
    if (!quiet) toast(t("回答失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    ref.answered = false; // 回滚，让用户重试
    ref.questions.forEach((q) => (ref.selected[q.id] = []));
    return "failed";
  }
  return "ok";
}

// 撕掉一个 chat 的本地连接与恢复循环（不碰服务端的 run）。
function killLive(chat: Chat) {
  flushStream(chat); // 缓冲落地 + 停掉批量定时器（stop 时最后一批字不丢）
  chat.liveGen++;
  clearTimeout(chat.resyncTimer);
  chat.reconnecting = false;
  chat.abortCtl?.abort();
  chat.abortCtl = null;
}

export async function stop() {
  const chat = app.chat;
  const runId = chat.runId;
  killLive(chat);
  let mismatch = false;
  if (chat.id) {
    try {
      await api.stopRun(chat.id, runId);
    } catch (e: any) {
      mismatch = e?.status === 409 && e?.message === "run_mismatch";
    }
  }
  settleCursors(chat);
  chat.running = false;
  chat.activity = "";
  chat.runId = null;
  if (mismatch) {
    // M2（#44）：本端以为在跑的那一轮已经结束，此刻在跑的是另一台设备新起的一轮——没去停它。接上它，
    // 看清了还想停就再点一次（那时带的就是这一轮的 runId），不会停不下来。
    toast(t("你要停的那一轮已经结束；现在在跑的是另一台设备发起的，没有停它。要停请再点一次"));
    forceResync(chat);
  }
  if (app.features.sessions) refreshSessions();
}

// 把一个 chat 抬到前台（放进活跃池 + LRU 记时 + 缓存修剪）。
// 分屏时换的是有焦点的那一格；要换上的会话已经在另一格里 = 只是把焦点挪过去（同一个会话不会同时占两格）。
function foreground(chat: Chat) {
  if (!app.chats.includes(chat)) app.chats.push(chat);
  chat.lastSeenAt = Date.now();
  if (app.panes.length === 2 && !app.panes.includes(chat)) app.panes = withFocusedReplaced(app.panes, app.chat, chat);
  app.chat = chat;
  // M2：在后台时没送达的那一条，切过来时放回输入框
  if (chat.pendingRefill != null) {
    app.refill = chat.pendingRefill;
    chat.pendingRefill = null;
  }
  // 产物定位只对产它的那个会话/工作空间有意义——换会话就清掉，免得文件视图
  // 拿着上一个会话的相对路径去新工作空间里找。
  app.filesTarget = null;
  trimChats();
}

// 终态缓存修剪：非前台、不在跑的按最近浏览保留 MAX_IDLE_CACHE 个。
// running/reconnecting 的永不淘汰（连接与恢复循环还活着）。
function trimChats() {
  const idle = app.chats.filter((c) => !paneVisible(c) && !c.running && !c.reconnecting);
  if (idle.length <= MAX_IDLE_CACHE) return;
  idle.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  for (const c of idle.slice(0, idle.length - MAX_IDLE_CACHE)) {
    killLive(c);
    const i = app.chats.indexOf(c);
    if (i >= 0) app.chats.splice(i, 1);
  }
}

export function newChat() {
  const cur = app.chat;
  if (!cur.running && !cur.id && !cur.timeline.length) return; // 已是空白新对话
  // 空白但发送失败留下残迹（无 id）→ 直接丢弃；有 id / 在跑 → 留在活跃池
  if (!cur.running && !cur.id) {
    const i = app.chats.indexOf(cur);
    if (i >= 0) app.chats.splice(i, 1);
  }
  foreground(new Chat());
  // 清理孤儿 dev server —— 后端有护栏：任何会话在跑就拒绝 stop-all
  api.stopPreviews();
}

// 项目格右侧的新对话：先切全局 workspace，再开新会话视图。已有会话仍保留
// 自己快照里的 workspace；这里只决定接下来创建的新会话落在哪个项目。
export async function newChatInProject(project: ProjectMeta) {
  if (!project.exists) {
    toast(t("项目文件夹已不存在"));
    return;
  }
  const before = app.chat;
  const wasBlank = !before.running && !before.id && !before.timeline.length;
  try {
    await patchGlobalConfig({ workspace: project.path });
    // 等配置落地的这段时间里，用户已经在这张空白对话里发了消息 → 它就是那个新对话，别再把它挤到后台
    const startedMeanwhile = wasBlank && app.chat === before && (before.running || before.timeline.length > 0);
    if (!startedMeanwhile) newChat();
    app.drawer = false;
  } catch (e: any) {
    toast(t("切换项目失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// 「新建快照」= 服务端换一只全新的一次性桶（新 workspace → 新记忆作用域，
// 前尘不带），随即在里面开空对话。旧桶留盘不删，只是不再被列出。
export async function newQuickChat() {
  try {
    const p = (await api.newQuickChat()) as ProjectMeta;
    if (!p?.path) throw new Error(t("服务器未返回新的快照"));
    app.projects = [...app.projects.filter((x) => !x.quick), p];
    await newChatInProject(p);
  } catch (e: any) {
    // 老后端没有 /api/quick/new → 说人话
    toast(e?.status === 404 ? t("快照对话需要重启 harness 服务后可用") : t("新建快照失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// Q13：导出当前对话的诊断包——服务端写进会话工作区，这里按「产物」打开：有宿主（bridge）交给它的查看器（手机上能分享 /
// 另存），独立运行时直接下载。
export function diagnosticsAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("diagnostics"));
}
export async function exportDiagnostics(): Promise<void> {
  const id = app.chat.id;
  if (!id) {
    toast(t("先打开一个对话，再导出它的诊断包"));
    return;
  }
  try {
    const made = await api.createDiagnostics(id);
    const host = artifactHost();
    if (host) host({ path: made.path, name: made.name, kind: made.kind, size: made.size }, id);
    else window.open(api.artifactUrl(id, made.path, true), "_blank", "noopener,noreferrer");
    toast(t("诊断包已生成：{name}", { name: made.name }));
  } catch (e: any) {
    toast(t("导出诊断包失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// ── 厂商 / 模型 / 配置 ───────────────────────────────────────────────────────
// 全局配置写入统一走这里：序号守卫防连续切换时的乱序覆盖（最后发起的赢）。
let cfgSeq = 0;
async function patchGlobalConfig(patch: Record<string, unknown>) {
  const seq = ++cfgSeq;
  const cfg = await api.patchConfig(patch);
  if (seq === cfgSeq) app.config = cfg;
  return cfg;
}

// 页内切换：同家收起浮层即可；异家切 provider（会话绑定创建时的 provider，
// 切家 = 开新对话，旧的在历史里；在跑的转入后台继续）。成功打一发网格脉冲。
export async function switchVendor(provider: string) {
  if (provider === app.config?.provider) {
    app.vendorMenu = false;
    haptic("light");
    return;
  }
  haptic("medium");
  try {
    await patchGlobalConfig({ provider });
    newChat();
    app.vendorMenu = false;
    pulseGrid();
  } catch (e: any) {
    toast(t("切换失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// 型号 / 思考深度：先在本机上屏（菜单里的勾、思考深度的选中块当场挪过去），再写全局配置——以前要等服务端往返，
// 隧道上半秒多块才动（不跟手）。服务端会按型号的支持面收档，回来的配置为准；写失败退回并说一声。
// 与运行档位同一套语义：已经开跑的会话跑的是它自己的快照配置，只写全局等于没换（菜单勾着新型号、回答的还是旧的）——
// 所以先点名当前会话（服务端能力位 "session-model"），再写全局作新对话的默认。
export async function setModel(model: string) {
  await patchConfigOptimistic({ model }, (reason) => t("换型号没成功：{reason}", { reason }));
}
export async function setEffort(thinking: string) {
  await patchConfigOptimistic({ thinking }, (reason) => t("换思考深度没成功：{reason}", { reason }));
}
function sessionModelAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("session-model"));
}
async function patchConfigOptimistic(patch: Record<string, string>, failed: (reason: string) => string) {
  const prev = app.config;
  if (prev) app.config = { ...prev, ...patch };
  // 退回全局的乐观值：这期间没有别的写入盖上来（还是我这一版）才退
  const revertGlobal = () => {
    const cur = app.config;
    if (prev && cur && Object.entries(patch).every(([k, v]) => cur[k] === v)) {
      app.config = { ...cur, ...Object.fromEntries(Object.keys(patch).map((k) => [k, prev[k]])) };
    }
  };
  const chat = app.chat;
  // 菜单列的是全局那家的型号；会话是别家的（不该出现：切前台时全局已对齐会话）就不点名，只改新对话的默认
  if (chat.id && chat.cfg && sessionModelAvailable() && (!prev || chat.cfg.provider === prev.provider)) {
    const prevChat = chat.cfg;
    chat.cfg = { ...chat.cfg, ...patch };
    try {
      const r = await api.setSessionModel(chat.id, patch);
      if (chat.cfg) chat.cfg = { ...chat.cfg, model: r.model, thinking: r.thinking };
      if (r.pending) toast(t("这一轮跑完后生效，下一条消息起用新的设置"));
    } catch (e: any) {
      if (chat.cfg) chat.cfg = { ...chat.cfg, model: prevChat.model, thinking: prevChat.thinking };
      revertGlobal();
      toast(failed(tr(String(e?.message ?? e))));
      return;
    }
    // 全局默认写失败不回滚会话：这条会话已经换成功了，全局只影响下一条新对话
    try {
      await patchGlobalConfig(patch);
    } catch { /* 静默 */ }
    return;
  }
  try {
    await patchGlobalConfig(patch);
  } catch (e: any) {
    revertGlobal();
    toast(failed(tr(String(e?.message ?? e))));
  }
}
// ── 运行档位（自主执行 / 只读 / 先出计划）──────────────────────────────────
// 读：前台会话的快照值优先。已开跑的会话跑的是它自己的 cfg（服务端如此），
// 全局值只是「下一条新对话」的默认，拿全局显示会在多会话间串档。
export function permissionMode(chat: Chat = app.chat): "auto" | "read-only" | "plan" {
  return chat.cfg?.permissionMode ?? app.config?.permissionMode ?? "auto";
}

// 写：先点名当前会话（立刻生效，运行中也切得动——这正是「只读」这一档的用法：
// 给正在跑的 agent 拉手刹），再把全局值写成同一档作为新对话的默认。
export async function setPermissionMode(mode: "auto" | "read-only" | "plan") {
  if (mode === permissionMode()) return;
  const chat = app.chat;
  const prevChat = chat.cfg?.permissionMode;
  const prevGlobal = app.config?.permissionMode;
  // 乐观上屏；服务端随后广播的 mode 事件落到同一处，一致则无感
  if (chat.cfg) chat.cfg = { ...chat.cfg, permissionMode: mode };
  if (app.config) app.config = { ...app.config, permissionMode: mode };
  if (chat.id) {
    try {
      await api.setSessionMode(chat.id, mode);
    } catch (e: any) {
      if (chat.cfg) chat.cfg = { ...chat.cfg, permissionMode: prevChat };
      if (app.config) app.config = { ...app.config, permissionMode: prevGlobal };
      toast(t("切换档位失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
      return;
    }
  }
  // 全局默认写失败不回滚会话：这条会话已经切成功了，全局只影响下一条新对话。
  try {
    await patchGlobalConfig({ permissionMode: mode });
  } catch { /* 静默 */ }
}

// ── 访问范围（仅工作空间 / 整机）────────────────────────────────────────────
// 以前只住在设置页、且只对新会话生效——「让当前对话读一个工作空间外的文件」要
// 开设置→切→保存→再开新对话四步。现在与运行档位同一个菜单、同一套语义：
// 读=前台会话快照优先；写=先点名当前会话（服务端沙箱当场改判），再写全局默认。
export type AccessMode = "workspace" | "full";
// 默认整机（09-26 的产品决定）；仅工作空间是「有人拉了闸」
export function accessMode(chat: Chat = app.chat): AccessMode {
  return (chat.cfg?.access ?? app.config?.access ?? "full") as AccessMode;
}

// ── U2（X36 第二步、hermes N17a）：待送达托盘——撤回 / 立即中断并发送 ──────────────────────────────────────
export function steerTrayActions(): boolean {
  return Boolean(app.compat?.caps?.includes("steer-withdraw"));
}
// 撤回：还没送达就拿回来放进输入框（已经送达的撤不回来）
export async function withdrawPendingSteer(s: tl.PendingSteer): Promise<void> {
  const chat = app.chat;
  if (!chat.id) return;
  try {
    const r = await api.withdrawSteer(chat.id, s.id);
    if (!r.ok) {
      toast(r.reason === "delivered" ? t("这句已经送到了，撤不回来") : t("这一轮已经结束"));
      return;
    }
  } catch (e: any) {
    toast(t("没撤成：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return;
  }
  tl.takePendingSteer(chat, s.id, s.text);
  if (chat === app.chat) app.refill = s.text;
}
// 立即中断并发送：服务端撤回这条、只停这一轮（后台 job 与 dev server 留着）、以这句开新一轮；回来就接上新的一轮
export async function interruptWithPendingSteer(s: tl.PendingSteer): Promise<void> {
  const chat = app.chat;
  if (!chat.id) return;
  let r: { ok: boolean; reason?: string };
  try {
    r = await api.interruptSteer(chat.id, s.id);
  } catch (e: any) {
    toast(t("没中断成：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return;
  }
  if (!r.ok) {
    toast(
      r.reason === "delivered"
        ? t("这句已经送到了，不用再中断")
        : r.reason === "busy"
          ? t("这一轮还没停下来，话已放回输入框")
          : t("这一轮已经结束"),
    );
    return;
  }
  tl.takePendingSteer(chat, s.id, s.text);
  forceResync(chat);
}

// P13（X18）：本会话放行的工作区外只读目录（权限卡上「本会话都允许」记下的）；档位菜单里列着、能删
export function readRoots(chat: Chat = app.chat): string[] {
  return chat.readRoots;
}
export async function dropReadRoot(dir: string): Promise<void> {
  const chat = app.chat;
  if (!chat.id) return;
  try {
    const r = await api.revokeReadRoot(chat.id, dir);
    chat.readRoots = r.roots;
    if (chat.cfg) chat.cfg = { ...chat.cfg, readRoots: r.roots };
  } catch (e: any) {
    toast(t("没删成：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

export async function setAccessMode(access: AccessMode) {
  if (access === accessMode()) return;
  const chat = app.chat;
  const prevChat = chat.cfg?.access;
  const prevGlobal = app.config?.access;
  if (chat.cfg) chat.cfg = { ...chat.cfg, access };
  if (app.config) app.config = { ...app.config, access };
  if (chat.id) {
    try {
      await api.setSessionAccess(chat.id, access);
    } catch (e: any) {
      if (chat.cfg) chat.cfg = { ...chat.cfg, access: prevChat };
      if (app.config) app.config = { ...app.config, access: prevGlobal };
      toast(e?.status === 404 ? t("切换访问范围需要重启 harness 服务后可用") : t("切换访问范围失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
      return;
    }
  }
  try {
    await patchGlobalConfig({ access });
  } catch { /* 静默：会话已切成功，全局只影响下一条新对话 */ }
}

// ── P3：离开模式（会话级，与档位正交，默认关）────────────────────────────────
// 开着时：agent 的提问按合理默认继续并写明假设、需要批准的调用直接拒、计划留着等人回来——这一轮不会因为
// 没人点卡片而永久挂住。在这个会话发新消息 / 插话，服务端自动关（away 事件同步回来）。
export function awayMode(chat: Chat = app.chat): boolean {
  return chat.away;
}

export async function setAwayMode(on: boolean) {
  const chat = app.chat;
  if (!chat.id || chat.away === on) return;
  const prev = chat.away;
  chat.away = on;
  try {
    await api.setSessionAway(chat.id, on);
  } catch (e: any) {
    chat.away = prev;
    toast(e?.status === 404 ? t("离开模式需要重启 harness 服务后可用") : t("切换离开模式失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

export async function saveConfig(patch: Record<string, unknown>) {
  const cfg = await patchGlobalConfig(patch);
  await reloadMeta();
  return cfg;
}

// 当前 provider 的模型清单 / 当前模型支持的思考档（渲染直接用）
export function providerModels(): any[] {
  const cat = app.info?.catalog as any[] | undefined;
  return cat?.find((p) => p.id === app.config?.provider)?.models ?? [];
}
export function modelEfforts(): string[] {
  const m = providerModels().find((m) => m.id === app.config?.model);
  return m?.efforts ?? ["off", "low", "high"];
}
export function modelsOf(providerId: string): any[] {
  const cat = app.info?.catalog as any[] | undefined;
  return cat?.find((p) => p.id === providerId)?.models ?? [];
}

// 厂商的名字与副标题：内置八家查 theme.ts 的 VENDORS；自定义服务（custom-<hex>）查服务端目录——名字是用户填的备注，
// 副标题是接口主机名。删掉了的自定义服务（历史会话还指着它）给个中性的占位。
export interface VendorView {
  id: string;
  name: string;
  company: string;
  custom: boolean;
}
export const isCustomVendor = (id: string | null | undefined) => typeof id === "string" && id.startsWith("custom-");
export function vendorInfo(id: string | null | undefined): VendorView {
  const key = id ?? "anthropic";
  if (isCustomVendor(key)) {
    const spec = (app.info?.catalog as any[] | undefined)?.find((p) => p.id === key);
    return { id: key, name: spec?.name ?? t("自定义服务"), company: spec?.custom?.host ?? t("已删除"), custom: true };
  }
  const v = VENDORS[key] ?? VENDORS.anthropic;
  return { id: v.id, name: v.name, company: v.company, custom: false };
}
// 用户加的自定义服务，按添加顺序
export function customVendors(): VendorView[] {
  const cat = (app.info?.catalog as any[] | undefined) ?? [];
  return cat.filter((p) => isCustomVendor(p.id)).map((p) => vendorInfo(p.id));
}
// 「＋」卡只在服务端支持、且不是租户实例（多用户服务端上不许替用户连任意地址）时出现
export function canAddCustomVendor(): boolean {
  return Boolean(app.compat?.caps?.includes("custom-providers")) && !app.info?.tenant?.tenant;
}

// ── 历史会话 ─────────────────────────────────────────────────────────────────
const SESSION_PAGE = 100;

export async function refreshSessions() {
  if (!app.features.sessions) return;
  app.sessionsLoading = true;
  try {
    const page = await api.listSessionsPage(0, SESSION_PAGE);
    app.sessions = page.items as SessionMeta[];
    app.sessionsTotal = page.total;
    // total 未知（反代吃掉了头）时以「这一页装满了」当作可能还有。
    app.sessionsMore =
      page.total >= 0 ? page.items.length < page.total : page.items.length >= SESSION_PAGE;
  } catch { /* 列表失败不打扰 */ }
  app.sessionsLoading = false;
}

// 追加下一页（抽屉底部「加载更多」）。按 id 去重，避免与期间新建的会话重复。
export async function loadMoreSessions() {
  if (!app.features.sessions || app.sessionsLoading || !app.sessionsMore) return;
  app.sessionsLoading = true;
  try {
    const page = await api.listSessionsPage(app.sessions.length, SESSION_PAGE);
    const seen = new Set(app.sessions.map((s) => s.id));
    const fresh = (page.items as SessionMeta[]).filter((s) => !seen.has(s.id));
    app.sessions = [...app.sessions, ...fresh];
    app.sessionsTotal = page.total;
    app.sessionsMore =
      page.total >= 0 ? app.sessions.length < page.total : page.items.length >= SESSION_PAGE;
  } catch { /* 失败保持现状，用户可再点一次 */ }
  app.sessionsLoading = false;
}

export async function refreshProjects() {
  if (!app.features.projects) return;
  app.projectsLoading = true;
  try {
    app.projects = await api.listProjects();
  } catch { /* 列表失败不打扰 */ }
  app.projectsLoading = false;
}

// ── 引用会话（把会话块拖进输入框；服务端能力位 "session-refs"）──────────────────────────────────
export { MAX_SESSION_REFS, sessionRefsFrom };
export function canRefSessions(): boolean {
  return Boolean(app.compat?.caps?.includes("session-refs"));
}
// 拖进输入框：挂一个「引用」芯片。引用自己、重复的、超过上限的不挂（说一声）
export function addSessionRef(chat: Chat, ref: SessionRefView): boolean {
  const next = withSessionRef(chat.refs, ref, chat.id);
  if (next.note) toast(next.note);
  if (next.list === chat.refs) return false;
  chat.refs = next.list;
  return true;
}

// ── 侧栏项目块拖动排序（服务端能力位 "project-order"）──────────────────────────────────────
export function canReorderProjects(): boolean {
  return Boolean(app.compat?.caps?.includes("project-order"));
}
// zonePaths：拖完之后那一区（置顶区或非置顶区）的完整次序。先在本地按新次序排好（手指一松就到位），再落库；
// 落库失败按服务端的次序拉回来。
export async function reorderProjects(zonePaths: string[]): Promise<void> {
  const rank = new Map(zonePaths.map((p, i) => [pathKey(p), i]));
  const rows = [...app.projects];
  const slots = rows.map((p, i) => (rank.has(pathKey(p.path)) ? i : -1)).filter((i) => i >= 0);
  const moved = slots.map((i) => rows[i]).sort((a, b) => rank.get(pathKey(a.path))! - rank.get(pathKey(b.path))!);
  slots.forEach((slot, k) => (rows[slot] = moved[k]));
  app.projects = rows;
  try {
    await api.setProjectOrder(zonePaths);
    // 本区里有只在侧栏里补出来的隐式项目（列表里还没有它）：服务端这次顺手登记了，拉一次权威次序
    if (moved.length < zonePaths.length) void refreshProjects();
  } catch (e: any) {
    toast(t("排序没存上：{reason}", { reason: tr(String(e?.message ?? e)) }));
    void refreshProjects();
  }
}

// 宿主注入的「选一个文件夹当工作空间」。函数不是响应式数据，挂模块级即可；
// 是否可用由 app.hasHostPicker 供模板判断。
let hostPick: null | (() => Promise<string>) = null;
export function setHostPickWorkspace(fn: null | (() => Promise<string>)) {
  hostPick = fn;
  app.hasHostPicker = !!fn;
}
export function hostPickWorkspace() { return hostPick; }

export async function importProject(path: string) {
  const project = await api.importProject(path) as ProjectMeta;
  app.projects = [project, ...app.projects.filter((p) => p.id !== project.id)];
  app.projectModal = false;
  await newChatInProject(project);
  return project;
}

// 置顶 / 隐藏：服务端只改注册表（不动目录、不动会话），返回更新后的项目。
// 名单里的次序不在这里定 —— 侧栏统一按「置顶优先」排，隐式项目也吃得到。
export async function setProjectFlags(
  project: ProjectMeta,
  patch: { pinned?: boolean; hidden?: boolean },
): Promise<ProjectMeta | null> {
  const key = pathKey(project.path);
  try {
    const next = (await api.setProjectFlags(project.path, patch)) as ProjectMeta;
    // 原地替换：位置不变，重排（置顶优先）交给侧栏；隐式项目第一次落库才追加
    const rows = [...app.projects];
    const i = rows.findIndex((p) => pathKey(p.path) === key);
    if (i >= 0) rows[i] = next;
    else rows.push(next);
    app.projects = rows;
    // 置顶 / 取消置顶换了区：服务端按「拖出来的位次」排，新区里排到哪由它说了算——拉一次权威次序
    if (patch.pinned !== undefined && canReorderProjects()) void refreshProjects();
    return next;
  } catch (e: any) {
    // 老后端没有 /api/projects/flags → 报「重启服务」而不是光秃秃的 HTTP 404
    toast(
      e?.status === 404
        ? t("置顶/隐藏需要重启 harness 服务后可用")
        : t("操作失败：{reason}", { reason: tr(String(e?.message ?? e)) }),
    );
    return null;
  }
}

// 项目身份 = workspace 绝对路径（Windows 不分大小写）
export function pathKey(p: string) {
  return app.info?.platform === "win32" ? (p || "").toLowerCase() : p || "";
}

// C3（#41）：用户侧消息从哪来由服务端标（Msg.origin / kind），这里只认它——不再按开头猜。以前用户自己写的
// 「[Reminder] 明早九点…」被渲染成系统提示条，压缩摘要、附件转交、插话前缀又被当成用户气泡。
//  · origin "harness"：注入（预算 / 提醒 / 续写提示……）→ 提示条（首行）；压缩摘要给一句人话；附件转交不显示
//  · origin "steer"：用户运行中插话 → 用户气泡，显示原话（displayText；旧记录剥掉给模型看的前缀）
//  · 没有 origin：用户本人 → 用户气泡，无论写的是什么
function harnessNotice(kind: string | undefined, text: string): string | null {
  // C5：技能正文紧跟在 Skill 工具那一行后面，界面上那一行已经说了「载入技能」，正文不再单独显示
  if (kind === "tool-attachments" || kind === "skill") return null;
  // E3：用户 /技能名（/包名）点的技能——正文不显示，界面上一行提示（与直播时 skill_loaded 那一行同一句话）
  if (kind === "slash-skill") {
    const m = /^\[Skill( package| again)?: ([^\]\n]+)\]/.exec(text);
    return m ? tl.skillLoadedText(m[2], m[1] === " package") : t("已载入技能");
  }
  if (kind === "compaction-summary") return t("更早的对话已压缩成摘要");
  // U9：从这里改写之后给模型的说明——界面上只说一句
  if (kind === "rewind") return t("对话退回到这里 · 工作区文件没有回退");
  // O7：目标续跑——第一轮的说明、之后每一轮的首条
  if (kind === "goal-start") {
    const m = /at most (\d+) rounds/.exec(text);
    return m ? t("开始目标 · 最多 {n} 轮：没达成就一轮轮接着做", { n: m[1] }) : t("开始目标：没达成就一轮轮接着做");
  }
  if (kind === "goal-continue") {
    const m = /^\[Goal\] Round (\d+)\/(\d+)/.exec(text);
    return m ? t("目标 · 第 {x}/{y} 轮", { x: m[1], y: m[2] }) : t("目标 · 接着做");
  }
  // U10：审阅面板里撤销了这个对话对几个文件的改动
  if (kind === "restore") {
    const m = /changes to (\d+) file/.exec(text);
    return m ? t("在审阅面板撤销了 {n} 个文件的改动", { n: m[1] }) : t("在审阅面板撤销了文件改动");
  }
  // C8：带摘要开新会话——新会话开头那条接续摘要
  if (kind === "handoff-summary") return t("接续自上一个会话（开头是它的摘要）");
  // M13：服务重启 / 进程死掉之后自动续跑
  if (kind === "resume") return t("服务重启后自动接着做");
  if (kind === "resume-stopped") return t("连着几次被重启切断，没有再自动续跑——说「继续」接着做");
  return text.split("\n")[0] || null;
}
function steerText(msg: any, text: string): string {
  if (typeof msg.displayText === "string") return msg.displayText;
  const cut = text.indexOf("\n\n");
  return cut >= 0 ? text.slice(cut + 2) : text;
}

// 从 tool_call 参数重建问题。镜像服务端 parseQuestions 的规整（label 去重、
// 选项截 5、header 截 20），让历史重建卡与当时的 live 卡长一样。
function askQuestionsFromArgs(callId: string, raw: any): AskQuestion[] {
  return (Array.isArray(raw) ? raw : []).map((q: any, i: number) => {
    const seen = new Set<string>();
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o: any) => ({ label: String(o?.label ?? "").trim(), description: o?.description ? String(o.description) : undefined }))
      .filter((o: AskOption) => o.label && !seen.has(o.label) && (seen.add(o.label), true))
      .slice(0, 5);
    return {
      id: `${callId}:${i}`,
      header: String(q?.header ?? "").trim().slice(0, 20) || t("问题 {n}", { n: i + 1 }),
      question: String(q?.question ?? ""),
      multiSelect: Boolean(q?.multiSelect),
      options,
    };
  });
}

// 用户所选来自 tool_result 的结构化 meta.ask（服务端按题序写入），零解析。
// 无 meta（中断被 heal 的失败结果 / 预算跳过）→ 保持未选，卡片显示未作答。
function askSelectionsFromMeta(meta: any, questions: AskQuestion[]): Record<string, string[]> {
  const selected: Record<string, string[]> = {};
  const answers = Array.isArray(meta?.ask?.answers) ? meta.ask.answers : [];
  questions.forEach((q, i) => {
    const one = answers[i]?.selected;
    selected[q.id] = Array.isArray(one) ? one.map((s: unknown) => String(s)) : [];
  });
  return selected;
}

function rebuildTimeline(messages: any[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const asks = new Map<string, AskItem>();
  for (const msg of messages) {
    const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
    if (msg.role === "user") {
      const texts = blocks.filter((b) => b.t === "text").map((b) => b.text);
      // tool_result 回填到对应工具卡 / 问答卡
      for (const b of blocks) {
        if (b.t === "tool_result") {
          const ask = asks.get(b.id);
          if (ask) {
            ask.answered = true;
            ask.selected = askSelectionsFromMeta(b.meta, ask.questions);
            continue;
          }
          const ref = tools.get(b.id);
          if (ref) {
            ref.status = b.ok ? "ok" : "fail";
            ref.output = extractText(b.content);
            ref.summary = ref.output.split("\n")[0]?.slice(0, 80) ?? "";
            if (typeof b.meta?.outcome === "string" && b.meta.outcome) ref.outcome = b.meta.outcome; // U8（K36）：落盘的结果行
            // Agent / Workflow 的结构化摘要（服务端 meta）→ 历史里也有卡片可展开
            if (b.meta?.subagent) ref.agent = agentRunFromMeta(b.meta.subagent);
            if (b.meta?.workflow) ref.workflow = workflowRunFromMeta(b.meta.workflow);
            // #103：这次调用弹过的权限卡、计划卡的回执——刷新、换台设备打开也看得见批的哪一档、谁在哪台设备上定的
            const cards: Item[] = permissionItemsFromMeta(b.meta);
            const plan = ref.name === "ExitPlanMode" ? planItemFromResult(b.id, ref.args, b) : null;
            if (plan) cards.push(plan);
            insertAfter<Item>(items, ref, cards);
          }
        }
      }
      const raw = texts.join("\n").trim();
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      if (msg.origin === "harness") {
        const notice = harnessNotice(msg.kind, raw);
        if (notice) items.push({ kind: "notice", text: notice });
      } else {
        const text = msg.origin === "steer" ? steerText(msg, raw) : typeof msg.displayText === "string" ? msg.displayText : raw;
        const recall = tl.recallRefsFrom(msg.recall); // N45：这一轮自动召回了哪些
        const refs = sessionRefsFrom(msg.refs); // 引用会话：这条消息引用了哪些对话
        if (text || attachments.length || refs.length) {
          items.push({ kind: "user", text, attachments, ...(recall.length ? { recall } : {}), ...(refs.length ? { refs } : {}) });
        }
      }
    } else if (msg.role === "assistant") {
      // U8（E3）：这一轮的用时盖在这一轮最后一条回答上——挂到它的最后一段正文
      const run = msg.run && typeof msg.run.durationMs === "number" ? { durationMs: msg.run.durationMs, waitedMs: Number(msg.run.waitedMs) || 0 } : undefined;
      const lastTextIdx = run ? blocks.map((b) => b.t === "text" && Boolean(b.text?.trim())).lastIndexOf(true) : -1;
      for (const [bi, b] of blocks.entries()) {
        if (b.t === "thinking" && b.text?.trim()) {
          items.push({ kind: "thinking", text: b.text, open: false, live: false });
        } else if (b.t === "text" && b.text?.trim()) {
          items.push({ kind: "text", text: b.text, live: false, artifacts: msg.artifacts ?? undefined, ...(bi === lastTextIdx && run ? { run } : {}) });
        } else if (b.t === "tool_call" && b.name === "AskUserQuestion") {
          // 问答卡（历史静态态：等下方 tool_result 回填所选，未答则保持空）
          const ask: AskItem = {
            kind: "ask", id: b.id,
            questions: askQuestionsFromArgs(b.id, b.args?.questions),
            answered: false, selected: {},
          };
          items.push(ask);
          asks.set(b.id, ask);
        } else if (b.t === "tool_call") {
          // 默认按中断态建卡：完成的调用随后一定有 tool_result 回填成 ok/fail；
          // 没有结果的（运行被掐断的快照）不能假装绿色完成。
          const tool: ToolItem = {
            kind: "tool", id: b.id, name: b.name, args: b.args ?? {},
            status: "fail", summary: "已中断：未拿到结果", output: "", open: false, // i18n-ignore：tasks.ts 按「已中断」前缀认「已停止」，显示处 tr()
          };
          items.push(tool);
          tools.set(b.id, tool);
        }
      }
    }
  }
  return items;
}

// 合并后重建 id→条目 索引。必须扫【合并后的 chat.timeline】拿代理元素：
// 指到 rebuildTimeline 产出的原始字面量上，后续 tool_end 改的就是个影子，
// 界面看不到任何更新（pushItem 那条同款坑）。
function reindexRefs(chat: Chat) {
  chat.toolRefs.clear();
  chat.askRefs.clear();
  chat.permRefs.clear();
  chat.planRefs.clear();
  chat.agentRefs.clear();
  chat.workflowRefs.clear();
  for (const it of chat.timeline) {
    if (it.kind === "tool") {
      const tool = it as ToolItem;
      chat.toolRefs.set(tool.id, tool);
      if (tool.agent) chat.agentRefs.set(tool.agent.id, tool.agent);
      if (tool.workflow) {
        chat.workflowRefs.set(tool.workflow.id, tool.workflow);
        for (const a of tool.workflow.agents) chat.agentRefs.set(a.id, a);
      }
    }
    else if (it.kind === "ask") chat.askRefs.set(it.id, it as AskItem);
    else if (it.kind === "permission") chat.permRefs.set(it.id, it as PermissionItem);
    else if (it.kind === "plan") chat.planRefs.set(it.id, it as PlanItem);
  }
}

// 用服务端会话记录重建一个 chat 的视图。upTo 给出 = 镜像 base（截到本轮开始前，
// 后续事件靠重放补齐）；不给 = 终态完整重建。
function applyRecord(chat: Chat, rec: any, upTo?: number) {
  dropStream(chat); // 整轮由记录重建，在途缓冲作废（落地就重复了）
  chat.curText = null;
  chat.curThinking = null;
  const messages: any[] = rec.messages ?? [];
  mergeTimeline(
    chat.timeline,
    rebuildTimeline(upTo === undefined ? messages : messages.slice(0, upTo)),
  );
  reindexRefs(chat);
  chat.recFp = upTo === undefined ? (rec.fp ?? null) : null;
  if (rec.running && typeof rec.runId === "string") chat.runId = rec.runId; // M2：附着到的是哪一轮
  resetStreamTurn(chat);
  chat.todos = rec.todos ?? [];
  chat.goal = rec.goal ?? null; // O7：目标续跑的状态
  chat.usage = {
    inTok: rec.totals?.inputTokens ?? 0,
    outTok: rec.totals?.outputTokens ?? 0,
  };
  chat.title = rec.title ?? chat.title;
  chat.cfg = rec.config ?? chat.cfg;
  chat.away = rec.config?.away === true; // P3
  chat.readRoots = Array.isArray(rec.config?.readRoots) ? rec.config.readRoots.filter((d: unknown) => typeof d === "string") : []; // P13
}

// 拉取 / 复用一个会话的 Chat。已在活跃池 → 原样返回（连接还活着，秒切）；
// 不在 → 拉记录建实例，running 则立刻附着直播。in-flight 去重防双击并发。
const loadingChats = new Map<string, Promise<Chat>>();
function loadChat(id: string): Promise<Chat> {
  const cached = app.chats.find((c) => c.id === id);
  if (cached) return Promise.resolve(cached);
  const inflight = loadingChats.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    const rec = await api.getSession(id);
    // await 期间可能已被别的路径装载（resume 与手点竞态）
    const again = app.chats.find((c) => c.id === id);
    if (again) return again;
    const chat = new Chat();
    chat.id = rec.id;
    // 正在运行的会话（本机断线前发起 / 别的设备发起）：时间线只重建到本轮
    // 开始前，剩下的交给直播镜像逐事件重放 —— 和发起端看到的是同一条流。
    const mirroring = rec.running && Number.isInteger(rec.runStartMsgCount);
    applyRecord(chat, rec, mirroring ? rec.runStartMsgCount : undefined);
    app.chats.push(chat);
    if (mirroring) {
      const gen = ++chat.liveGen;
      void attachStream(chat, gen);
    }
    return chat;
  })().finally(() => loadingChats.delete(id));
  loadingChats.set(id, p);
  return p;
}

// 把前台会话的快照配置同步到全局（provider/model/workspace/access/运行档位）：
// 已有会话本身不受全局值影响（服务端跑它自己的快照 cfg），但随后点
// “新对话”应自然留在这个项目/厂商。后台静默做，失败不打扰。
async function syncConfigTo(chat: Chat) {
  if (!chat.cfg) return;
  const providerChanged = chat.cfg.provider !== app.config?.provider;
  try {
    await patchGlobalConfig({
      provider: chat.cfg.provider,
      model: chat.cfg.model,
      // 思考深度也是会话级的（会话内能换）：菜单里的选中块要显示这条会话的
      ...(chat.cfg.thinking ? { thinking: chat.cfg.thinking } : {}),
      workspace: chat.cfg.workspace,
      access: chat.cfg.access,
      permissionMode: chat.cfg.permissionMode,
    });
    if (providerChanged) pulseGrid();
  } catch { /* 静默：不影响切换本身 */ }
}

// 打开会话 —— 多会话核心入口。运行中也随便切：当前会话（连同它的连接）
// 留在活跃池继续自转，切回来直播还在。
export async function openSession(id: string) {
  // 前台实例刚被 evictChat 丢出活跃池（回滚）：它只是孤儿指针，照常重拉，不能当「重开当前会话」直接返回——
  // 以前回滚完 toast「已回滚」，页面却一直停在回滚前的对话上。
  if (id === app.chat.id && app.chats.includes(app.chat)) {
    // 重开当前会话 = 手动触发一次对账恢复（连接可疑时的自救入口）
    if (app.chat.running || app.chat.reconnecting) forceResync(app.chat);
    app.drawer = false;
    return;
  }
  const hadLocal = app.chats.some((c) => c.id === id);
  try {
    const chat = await loadChat(id);
    foreground(chat);
    rememberSession(id);
    app.drawer = false;
    void syncConfigTo(chat);
    // 缓存命中的终态会话：后台静默对账一次 —— 离开期间别的设备可能又跑了
    if (hadLocal && !chat.running && !chat.reconnecting) void reconcileIdle(chat);
  } catch (e: any) {
    toast(t("打开失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// ── 分屏（宽屏多会话）──────────────────────────────────────────────────────────────
// 焦点挪到分屏里的另一格：它成为 app.chat（发送、档位、工作区跟着它走），全局配置对齐到它的快照
export function focusPane(chat: Chat): void {
  if (chat === app.chat || !app.panes.includes(chat)) return;
  foreground(chat);
  if (chat.id) rememberSession(chat.id);
  void syncConfigTo(chat);
}
// 把一个会话放进分屏：side 0 = 左格、1 = 右格。没分屏时与当前对话左右并排；已分屏时换掉那一格。
// 已经在某一格里的：只把焦点挪过去。放进来的那一格拿到焦点。
export async function openInSplit(id: string, side: Side): Promise<void> {
  const hadLocal = app.chats.some((c) => c.id === id);
  let chat: Chat;
  try {
    chat = await loadChat(id);
  } catch (e: any) {
    toast(t("打开失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return;
  }
  if (app.panes.includes(chat)) {
    focusPane(chat);
    return;
  }
  const next = placeInSplit(app.panes, app.chat, chat, side);
  if (!next) return;
  app.panes = next;
  foreground(chat);
  rememberSession(id);
  app.drawer = false;
  void syncConfigTo(chat);
  if (hadLocal && !chat.running && !chat.reconnecting) void reconcileIdle(chat);
}
// 关掉分屏里的一格：留下另一格（关的是有焦点的那格，焦点挪到另一格）。关掉的会话留在活跃池里，在跑的照跑。
export function closePane(chat: Chat): void {
  const rest = paneLeft(app.panes, chat);
  if (!rest) return;
  app.panes = [];
  if (chat === app.chat) {
    foreground(rest);
    if (rest.id) rememberSession(rest.id);
    void syncConfigTo(rest);
  }
  trimChats();
}

// 缓存终态会话的静默对账：服务端在跑 → 接直播；有新内容 → 重建。
// liveGen 快照护栏：期间用户若在这个会话上发了新消息，一律丢弃对账结果。
async function reconcileIdle(chat: Chat) {
  if (!chat.id || chat.running || chat.resyncing) return;
  const gen = chat.liveGen;
  const id = chat.id;
  try {
    const st = await api.sessionStatus(id, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen || chat.running) return;
    if (!st.exists) return; // 已被删除：removeSession 路径负责清理，这里不动
    if (st.running) {
      forceResync(chat); // 别的设备把它跑起来了 → 接上直播
      return;
    }
    if (st.fp && st.fp === chat.recFp) return; // 一个字没变 → 别拉那 300KB
    const rec = await api.getSession(id, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen || chat.running) return;
    applyRecord(chat, rec);
  } catch { /* 静默 */ }
}

// 截断重放的补救：以服务端已落盘的记录重建时间线基线，不动直播连接（liveGen
// 不变、abortCtl 不换），随后到达的事件继续往这条基线上追加。
// M1（#26）：整份重建之后，把服务端此刻挂着的问答 / 权限 / 计划卡补回来（它们不在记录里，只在
// runLog 里——而走到整份重建这一步，恰恰就是 runLog 用不上了）。问答卡从记录重建时已经在（id 就是
// tool_call id），不重复加。
function restorePending(chat: Chat, pending: unknown) {
  if (!Array.isArray(pending)) return;
  for (const ev of pending) {
    if (!ev || typeof ev !== "object") continue;
    const id = (ev as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const kind = (ev as { e?: unknown }).e;
    if (kind === "ask" && chat.askRefs.has(id)) continue;
    if (kind === "permission_ask" && chat.permRefs.has(id)) continue;
    if (kind === "plan_ask" && chat.planRefs.has(id)) continue;
    if (kind === "ask" || kind === "permission_ask" || kind === "plan_ask") handleEvent(chat, ev);
  }
}

async function rebuildMirrorBase(chat: Chat, gen: number) {
  if (!chat.id || gen !== chat.liveGen) return;
  const id = chat.id;
  try {
    const rec = await api.getSession(id, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen || chat.id !== id) return;
    applyRecord(chat, rec);
    chat.running = true; // applyRecord 只重建视图，本轮仍在跑
    if (!chat.activity) chat.activity = t("思考中");
    restorePending(chat, rec.pending);
  } catch { /* 拉不到就维持现状，直播事件照常追加 */ }
}

// 附着直播镜像（发起端断线重连与围观端共用）：服务端在附着瞬间同步重放本轮
// 全部事件再续直播，与 base 重建拼成完整一致的时间线。断流走 scheduleResync
// 自动恢复；只有 mirror_end（本轮真结束）才收尾。
async function attachStream(chat: Chat, gen: number) {
  if (gen !== chat.liveGen || !chat.id) return;
  chat.curText = null;
  chat.curThinking = null;
  chat.running = true;
  if (!chat.activity) chat.activity = t("思考中");
  chat.abortCtl = new AbortController();
  let sawEnd = false;
  try {
    chat.lastByteAt = Date.now();
    await api.sessionStream(
      chat.id,
      (ev) => {
        if (gen !== chat.liveGen) return;
        if (ev.e === "mirror_end") {
          sawEnd = true;
          return;
        }
        // 服务端明说这一轮的重放日志被截断了（超长轮撞上 runLog 上限）：拼上去
        // 只会得到一条永久错位的时间线。改成用服务端已持久化的记录重建一次基线，
        // 然后【继续吃这条连接的直播事件】——细节有损，但不会错位。
        // 注意不能走 forceResync/reconcileIdle：前者会 ++liveGen 掐掉本连接并重新
        // 附着，而重新附着又会撞上同一条截断日志再报 desync（死循环）；后者在
        // running 时直接 return，什么也不做。
        if (ev.e === "mirror_desync") {
          void rebuildMirrorBase(chat, gen);
          return;
        }
        handleEvent(chat, ev);
      },
      chat.abortCtl.signal,
      () => {
        if (gen === chat.liveGen) chat.lastByteAt = Date.now();
      },
    );
  } catch (e: any) {
    // 同 send：主动收线已被世代挡掉；意外死亡（409 = 附着瞬间本轮刚好结束，
    // 对账自然拉到终态）一律走恢复。
    if (gen !== chat.liveGen) return;
    scheduleResync(chat, gen, 0);
    return;
  }
  if (gen !== chat.liveGen) return;
  if (sawEnd) finishRun(chat, gen);
  else scheduleResync(chat, gen, 0);
}

// ── 断线恢复：对账循环（per-chat，后台会话独立自愈）────────────────────────
function scheduleResync(chat: Chat, gen: number, delay: number) {
  if (gen !== chat.liveGen) return;
  chat.reconnecting = true;
  // 连试几次都没成 → 说人话，别让用户对着一个永远的「重连中」猜是不是死了。
  // 任务在服务端照跑，网络一通就自动补回来。
  if (chat.running) chat.activity = chat.resyncAttempt >= 3 ? t("重连中（网络不畅）") : t("重连中");
  clearTimeout(chat.resyncTimer);
  chat.resyncTimer = window.setTimeout(() => {
    chat.resyncTimer = 0; // 归零，否则「有没有排着下一次」永远读成有（排障时会被骗）
    void resyncLive(chat, gen);
  }, delay);
}

// 以服务端为真相对账一次：还在跑 → 重建 base + 重新附着；已结束 → 拉终态
// 完整重建（后台期间跑完的答案一分不少）；网络不通 → 退避重试，回前台 /
// 网络恢复事件会立刻再触发。
async function resyncLive(chat: Chat, gen: number) {
  if (gen !== chat.liveGen || !chat.id) return;
  // 前一次对账还在途：【让路重排】，不能直接 return —— forceResync 在对账在途时
  // ++gen，新的一轮在这里被 resyncing 挡掉、旧的一轮回来时被 gen 挡掉，两边都
  // 走人，没人再排定时器 → 永久卡在「重连中」（onWake 才救得回来）。
  if (chat.resyncing) {
    scheduleResync(chat, gen, 300);
    return;
  }
  chat.resyncing = true;
  const id = chat.id;
  try {
    const st = await api.sessionStatus(id, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen) return;
    if (!st.exists) {
      // 会话已被删除：没有可恢复的东西
      try {
        if (localStorage.getItem(LAST_SESSION_KEY) === id) rememberSession(null);
      } catch { /* ignore */ }
      finishRun(chat, gen);
      return;
    }
    if (st.running) {
      const rec = await api.getSession(id, RESYNC_TIMEOUT_MS);
      if (gen !== chat.liveGen) return;
      if (rec.running && Number.isInteger(rec.runStartMsgCount)) {
        applyRecord(chat, rec, rec.runStartMsgCount);
        chat.resyncAttempt = 0;
        chat.reconnecting = false;
        void attachStream(chat, gen);
        return;
      }
      // 两次请求的窗口里刚好收尾了 → 落到终态分支
      applyRecord(chat, rec);
      finishRun(chat, gen);
      return;
    }
    // 服务端说这个会话没在跑。手里那份还是最新的（指纹一致）→ 直接收尾，
    // 别为了确认「没变」再拉一遍整份转录。recFp 只有完整重建才置位，所以
    // 刚直播过一轮的会话必定不匹配，照常拉。
    if (st.fp && st.fp === chat.recFp) {
      finishRun(chat, gen);
      return;
    }
    const rec = await api.getSession(id, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen) return;
    applyRecord(chat, rec);
    finishRun(chat, gen);
  } catch {
    if (gen !== chat.liveGen) return;
    chat.resyncAttempt++;
    scheduleResync(chat, gen, Math.min(8_000, 1_000 * 2 ** Math.min(chat.resyncAttempt, 3)));
  } finally {
    chat.resyncing = false;
  }
}

// 撕掉 chat 的当前连接（半开死连接 read() 永远不返回，只能靠世代失效 + abort
// 兜底），立刻走一次对账。
function forceResync(chat: Chat) {
  if (!chat.id) return;
  const gen = ++chat.liveGen;
  chat.abortCtl?.abort();
  chat.abortCtl = null;
  chat.resyncAttempt = 0;
  scheduleResync(chat, gen, 0);
}

// ── #93：嵌在 bridge 里时，离开 dimensio 页就收掉运行流 ──────────────────────────────────────
// 局域网 http 直连时浏览器每主机只开 6 条连接；运行流挂在模块级的会话上、页面卸载也不收，离开页面后 dimensio 还占着
// 全局事件流 + 最多 3 条运行流，再去 Claude 页看一轮就满了。离开时把运行流收掉（服务端照跑，不停），只留全局事件流
// （侧栏状态与通知靠它）；回到页面（App 重挂 → boot）时按服务端现状接回：还在跑的重放续播，跑完了的拉终态。
let pageAway = false;

// App 卸载时调（只在嵌入态：独立页面不会卸载）
export function suspendLiveStreams() {
  pageAway = true;
  for (const chat of toSuspend(app.chats)) {
    killLive(chat);
    chat.suspended = true;
  }
}

function resumeLiveStreams() {
  if (pageAway) return; // boot 还没走完人又离开了
  const runningIds = new Set(app.sessions.filter((s) => s.running).map((s) => s.id));
  for (const chat of toResume(app.chats, runningIds)) {
    chat.suspended = false;
    forceResync(chat);
  }
}

// ── 挂后台自愈：watchdog + 回前台/网络恢复对账（遍历活跃池）────────────────
const STALL_HARD_MS = 40_000; // 服务端 15s 一发 ping：连丢两个多判死
const STALL_WAKE_MS = 12_000; // 回前台时更急：超过就直接撕掉重连

setInterval(() => {
  if (document.hidden) return; // 后台定时器本就不可靠；回前台由 onWake 兜
  for (const chat of app.chats) {
    if (!chat.running || chat.reconnecting || !chat.abortCtl) continue;
    if (Date.now() - chat.lastByteAt > STALL_HARD_MS) forceResync(chat);
  }
}, 5_000);

let wakeDebounce = 0;
function onWake() {
  clearTimeout(wakeDebounce);
  wakeDebounce = window.setTimeout(() => {
    if (document.hidden || !app.booted || pageAway) return; // #93：人在 bridge 别的页上，不替页外的会话开连接
    for (const chat of app.chats) {
      if (chat.reconnecting) {
        // 正在退避等待 → 跳过剩余等待立刻重试
        forceResync(chat);
        continue;
      }
      if (chat.running) {
        // 连接名义上还挂着：字节静默超阈值就当半开死连接处理
        if (chat.abortCtl && Date.now() - chat.lastByteAt > STALL_WAKE_MS) forceResync(chat);
      }
    }
    // 空闲态对账（前台）：上次可能异常收尾（network error / 假完成），服务端也许还在跑
    const chat = app.chat;
    if (chat.id && !chat.running && !chat.reconnecting && Date.now() - lastProbeAt > 5_000) {
      lastProbeAt = Date.now();
      void probeIdle();
    }
  }, 250);
}

async function probeIdle() {
  const chat = app.chat;
  const id = chat.id;
  if (!id) return;
  try {
    const st = await api.sessionStatus(id, RESYNC_TIMEOUT_MS);
    if (id !== chat.id || chat.running || chat.reconnecting) return;
    if (st.running) forceResync(chat); // 服务端还在跑而我们不在场 → 续上直播
  } catch { /* 连不上就下次再说 */ }
}

window.addEventListener("online", onWake);
window.addEventListener("focus", onWake);
window.addEventListener("pageshow", onWake);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) onWake();
});

// 冷启动续播：服务端还在跑的会话（进程被杀 / 手机重启 / 别的设备发起）全部
// 接上直播 —— 上次看的那个放前台，其余在后台自转（完成时 toast 提醒）。
// 只在有 running 会话时劫持首页；跑完了的历史会话不打扰，保持 Hero。
export async function resumeRunningSessions() {
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_SESSION_KEY);
  } catch { /* ignore */ }
  const running = app.sessions.filter((s) => s.running).slice(0, MAX_PARALLEL);
  for (const s of running) {
    try {
      await loadChat(s.id);
    } catch { /* 单个失败不影响其余 */ }
  }
  // 上次看的会话在跑 → 抬到前台（前台还是空白 Hero 时才劫持）
  if (last) {
    const c = app.chats.find((x) => x.id === last);
    const fg = app.chat;
    if (c && c !== fg && (c.running || c.reconnecting) && !fg.id && !fg.running && !fg.timeline.length) {
      foreground(c);
      void syncConfigTo(c);
    }
  }
}

// 丢弃某会话的本地缓存实例（回滚等场景：服务端状态已重置，本地必须重拉）。
// 前台被丢时 app.chat 暂成孤儿指针 —— 调用方紧接着 openSession 换上新实例。
export function evictChat(id: string) {
  const chat = app.chats.find((c) => c.id === id);
  if (!chat) return;
  killLive(chat);
  chat.running = false;
  const i = app.chats.indexOf(chat);
  if (i >= 0) app.chats.splice(i, 1);
}

// ── C8：上下文卫生（立即压缩 / 带摘要开新会话 / 计划转新会话实施 / 缓存变冷提示）──────────────────
export function hygieneAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("hygiene"));
}

// 前缀缓存大概多久变冷（分钟，按厂商默认的缓存寿命）。DeepSeek（硬盘缓存）留得久，不提示；没列的按 5 分钟
const CACHE_TTL_MIN: Record<string, number | null> = { anthropic: 5, openai: 10, gemini: 5, kimi: 5, zhipu: 5, deepseek: null };

// 这段对话上一次跟模型打交道是什么时候（本机时钟优先；刚打开的老会话退回用列表里的 updatedAt）
function lastActivityAt(c: Chat): number {
  const meta = c.id ? app.sessions.find((s) => s.id === c.id) : undefined;
  return Math.max(c.lastRunEndAt || 0, meta?.updatedAt || 0);
}

// 前缀缓存大概已经冷了：返回冷了几分钟；还热 / 不适用（没会话、在跑、缓存寿命长的厂商……）返回 null。c：分屏时是哪一格的会话
export function cacheColdMinutes(now: number, c: Chat = app.chat): number | null {
  if (!c.id || c.running || !c.ctx.used) return null;
  const provider = String(c.cfg?.provider ?? app.config?.provider ?? "");
  const ttl = provider in CACHE_TTL_MIN ? CACHE_TTL_MIN[provider] : 5;
  if (ttl == null) return null;
  const last = lastActivityAt(c);
  if (!last) return null;
  const minutes = Math.floor((now - last) / 60_000);
  return minutes >= ttl ? minutes : null;
}

const kTok = (n?: number) => (n ? `${(n / 1000).toFixed(1)}k` : "?");

export async function compactNow(): Promise<boolean> {
  const sid = app.chat.id;
  if (!sid) return false;
  if (app.chat.running) {
    toast(t("这一轮跑完再压缩"));
    return false;
  }
  const r = await api.compactSessionNow(sid);
  if (!r.ok) {
    toast(r.code === "empty" ? t("对话还短，没什么可压的") : r.code === "running" ? t("这一轮跑完再压缩") : t("压缩没成：{reason}", { reason: tr(r.error ?? "") }));
    return false;
  }
  evictChat(sid);
  await openSession(sid);
  toast(t("压缩好了：上下文约 {a} → {b} token", { a: kTok(r.before), b: kTok(r.after) }));
  return true;
}

export async function handoffWithSummary(): Promise<boolean> {
  const sid = app.chat.id;
  if (!sid) return false;
  if (app.chat.running) {
    toast(t("这一轮跑完再开新会话"));
    return false;
  }
  const r = await api.handoffWithSummary(sid);
  if (!r.ok || !r.sessionId) {
    toast(r.code === "empty" ? t("对话里还没有内容") : t("没开成：{reason}", { reason: tr(r.error ?? "") }));
    return false;
  }
  await openSession(r.sessionId);
  if (app.features.sessions) void refreshSessions();
  toast(t("已带着摘要开了新会话，原会话还在列表里"));
  return true;
}

// 计划卡「在新会话中实施」：原会话这份计划落定为「转到新会话」，新会话以自主档起跑、首条消息就是计划
export async function handoffPlan(item: PlanItem): Promise<void> {
  const chat = app.chat;
  const sid = chat.id;
  if (!sid || item.decided) return;
  haptic("medium");
  const r = await api.handoffPlan(sid, item.id);
  if (!r.ok || !r.sessionId) {
    toast(r.code === "not_found" ? t("这份计划已经不等审批了（超时或这一轮已结束）") : t("没转成：{reason}", { reason: tr(r.error ?? "") }));
    return;
  }
  item.decided = "handoff";
  await openSession(r.sessionId);
  if (app.features.sessions) void refreshSessions();
}

// ── U9：从这里改写（只退对话、文件不动、原话回填、可撤销）──────────────────────────────
export function rewindAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("rewind"));
}

// ── O8（N39）：用量账本（上下文弹层里的「用量」）───────────────────────────────────────────────
export function usageLedgerAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("usage-ledger"));
}

// ── E3（G7）：斜杠命令（/ 面板的技能清单；技能展开在服务端，内置命令见 runBuiltin）─────────────────────
export function commandsAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("commands"));
}
export const slashCommands = $state<{ list: api.CommandList | null; at: number }>({ list: null, at: 0 });
// 打开面板时取（一分钟内不重取；拿不到就只有内置命令）
export async function loadCommands(): Promise<void> {
  if (!commandsAvailable() || Date.now() - slashCommands.at < 60_000) return;
  slashCommands.at = Date.now();
  try {
    slashCommands.list = await api.listCommands();
  } catch {
    slashCommands.at = 0;
  }
}
// 内置命令此刻为什么用不了（面板上灰掉、发送时提示）；能用返回 undefined
export function builtinBlocked(b: Builtin): string | undefined {
  const chat = app.chat;
  if (b.idleOnly && chat.running) return t("这一轮跑完再用");
  if ((b.id === "compact" || b.id === "handoff") && (!hygieneAvailable() || !chat.id)) return chat.id ? t("服务端还不支持") : t("还没有对话");
  if (b.id === "goal" && !goalAvailable()) return t("服务端还不支持");
  return undefined;
}
// 执行内置命令。返回 true = 处理掉了（输入框清空）；false = 没执行（话留在输入框里）
export async function runBuiltin(b: Builtin, args: string): Promise<boolean> {
  const why = builtinBlocked(b);
  if (why) {
    toast(t("/{name}：{why}", { name: b.name, why }));
    return false;
  }
  switch (b.id) {
    case "new":
      newChat();
      return true;
    case "compact":
      void compactNow();
      return true;
    case "handoff":
      void handoffWithSummary();
      return true;
    case "goal": {
      const chat = app.chat;
      if (!chat.goalDraft?.on) toggleGoalDraft();
      // 没写目标：只把目标模式打开，接着在输入框里写
      if (args) void send(args);
      return true;
    }
  }
}

// ── O7（K64）：目标续跑 ──────────────────────────────────────────────────────────────────────
export function goalAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("goal"));
}
// 输入框上的「目标」开关：开着时发出去的那条就是目标
export function toggleGoalDraft(): void {
  const chat = app.chat;
  chat.goalDraft = chat.goalDraft?.on ? { ...chat.goalDraft, on: false } : { on: true, verify: chat.goalDraft?.verify ?? "", maxRounds: chat.goalDraft?.maxRounds ?? 10 };
}
// 状态条上的暂停 / 继续 / 结束
export async function goalControl(action: "pause" | "resume" | "clear"): Promise<void> {
  const chat = app.chat;
  if (!chat.id) return;
  try {
    const r = await api.goalAction(chat.id, action);
    if (app.chat === chat) chat.goal = r.goal ?? null;
    if (action === "resume" && r.goal?.status === "active") toast(t("接着做了"));
  } catch (e: any) {
    toast(t("操作失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// ── K7（N54）：全局层记忆（记忆面板里「这个项目 | 全局」）────────────────────────────────────────
export function globalMemoryAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("memory-global"));
}
// K11：记忆总览（全局层 + 各项目 + 旧快照桶一次拿齐）；旧服务端没有这一位，面板退回「一个项目」的视图
export function memoryOverviewAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("memory-overview"));
}
// 打开记忆面板：for = 直接看某个项目（侧栏项目菜单、召回芯片）；不给 = 从设置进总览
export function openMemory(opts: { for?: { path: string; name: string }; fromSettings?: boolean } = {}): void {
  app.memoryFor = opts.for ?? null;
  app.memoryFromSettings = Boolean(opts.fromSettings);
  app.sheet = "memory";
}

// ── U10（K38）：审阅面板的「本会话」视图 + 逐文件撤销 ────────────────────────────────────────
export function sessionReviewAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("session-review"));
}
// 撤销 / 找回之后服务端改了这个会话（转录末尾附了说明、内存态丢掉了）：丢本地缓存，正开着就重拉
export async function reloadChat(id: string): Promise<void> {
  const current = app.chat.id === id;
  evictChat(id);
  if (current) await openSession(id);
}

type UserBubble = Extract<Item, { kind: "user" }>;

// 点的是时间线上的哪个用户气泡 → 「第几个用户气泡」（和服务端同一个口径：插话也算气泡，只是不许退到插话之前）
export async function rewindFrom(item: UserBubble): Promise<void> {
  const chat = app.chat;
  const sid = chat.id;
  if (!sid) return;
  if (chat.running) {
    toast(t("这一轮还在跑，先停下再改写"));
    return;
  }
  const ordinal = chat.timeline.filter((it) => it.kind === "user").indexOf(item);
  if (ordinal < 0) return;
  haptic("medium");
  const r = await api.rewindSession(sid, ordinal, item.text);
  if (!r.ok) {
    toast(
      r.code === "running"
        ? t("这一轮还在跑，先停下再改写")
        : r.code === "not_found"
          ? t("这条消息已经压缩进摘要了，改写不了（可以用检查点回滚）")
          : t("改写失败：{reason}", { reason: tr(r.error ?? "") }),
    );
    return;
  }
  evictChat(sid);
  await openSession(sid);
  if (app.chat.id === sid) {
    if (item.attachments?.length) app.chat.attachments = item.attachments.map((a) => a.path);
    if (item.refs?.length && canRefSessions()) app.chat.refs = item.refs.map((r) => ({ ...r })); // 引用的对话也放回输入框
    app.refill = item.text;
  }
  const changed = r.changedFiles?.length ?? 0;
  const undo = r.undo;
  toast(
    changed ? t("已退回到这条消息之前（{n} 个文件没有回退）", { n: changed }) : t("已退回到这条消息之前，原话放回输入框了"),
    undo ? { label: t("撤销"), run: () => void undoRewindFor(sid, undo, item.text) } : undefined,
  );
}

async function undoRewindFor(sid: string, undo: { n: number; length: number }, text: string): Promise<void> {
  const r = await api.undoRewind(sid, undo.n, undo.length);
  if (!r.ok) {
    toast(r.code === "moved_on" ? t("改写之后又发过消息了，撤销不了（可以用检查点回滚）") : t("撤销失败：{reason}", { reason: tr(r.error ?? "") }));
    return;
  }
  evictChat(sid);
  await openSession(sid);
  // 放回输入框的原话还没动过就一起收回（那条消息又回到对话里了）
  if (app.chat.id === sid && app.chat.draft.trim() === text.trim()) {
    app.chat.draft = "";
    app.chat.attachments = [];
    app.chat.refs = [];
  }
  toast(t("已撤销改写"));
}

export async function removeSession(id: string) {
  try {
    await api.deleteSession(id);
    app.sessions = app.sessions.filter((s) => s.id !== id);
    const chat = app.chats.find((c) => c.id === id);
    if (chat) {
      killLive(chat);
      chat.running = false;
      const i = app.chats.indexOf(chat);
      if (i >= 0) app.chats.splice(i, 1);
      if (app.panes.includes(chat)) {
        // 分屏里的一格被删了：收起分屏，留下另一格（删的是有焦点的那格，焦点挪到另一格）
        const rest = paneLeft(app.panes, chat) ?? new Chat();
        app.panes = [];
        if (chat === app.chat) {
          foreground(rest);
          if (rest.id) rememberSession(rest.id);
          void syncConfigTo(rest);
        }
      } else if (chat === app.chat) foreground(new Chat());
    }
    try {
      if (localStorage.getItem(LAST_SESSION_KEY) === id) rememberSession(null);
    } catch { /* ignore */ }
  } catch (e: any) {
    toast(t("删除失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// 调试钩子：控制台可直接驱动状态（本地工具，顺手留着排障用）。
// live 组：排障断线自愈用 —— dropConn() 模拟网络层断流（abort 当前连接、
// 世代不动，走自动恢复）；stall() 把 lastByteAt 拨旧模拟半开死连接。
// 多会话版：chats() 一览活跃池，live 组默认操作前台，可传 idx 指定。
(window as any).__hx = {
  app, newChat, toast, openSession, refreshSessions, refreshProjects, switchVendor,
  send, stop,
  handleEvent: (ev: any) => handleEvent(app.chat, ev),
  chats: () =>
    app.chats.map((c, i) => ({
      i,
      id: c.id,
      title: c.title,
      fg: c === app.chat,
      running: c.running,
      reconnecting: c.reconnecting,
      items: c.timeline.length,
      gen: c.liveGen,
      conn: c.abortCtl !== null,
      suspended: c.suspended,
      idleMs: Date.now() - c.lastByteAt,
    })),
  live: {
    state: (i?: number) => {
      const c = i === undefined ? app.chat : app.chats[i];
      return c && {
        gen: c.liveGen,
        conn: c.abortCtl !== null,
        lastByteAt: c.lastByteAt,
        idleMs: Date.now() - c.lastByteAt,
        reconnecting: c.reconnecting,
        running: c.running,
        resyncAttempt: c.resyncAttempt,
        resyncing: c.resyncing,
        timerSet: c.resyncTimer !== 0,
        buffered: c.pendingText.length + c.pendingThinking.length,
      };
    },
    dropConn: (i?: number) => (i === undefined ? app.chat : app.chats[i])?.abortCtl?.abort(),
    stall: (ms = 60_000, i?: number) => {
      const c = i === undefined ? app.chat : app.chats[i];
      if (c) c.lastByteAt = Date.now() - ms;
    },
    forceResync: (i?: number) => {
      const c = i === undefined ? app.chat : app.chats[i];
      if (c) forceResync(c);
    },
    onWake,
    // #93：模拟离开 / 回到 dimensio 页（嵌入态由 App 卸载与 boot 触发）
    suspend: suspendLiveStreams,
    resume: () => {
      pageAway = false;
      resumeLiveStreams();
    },
  },
};
