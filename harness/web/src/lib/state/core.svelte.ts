// 全局状态 app（前台会话、活跃池、侧栏列表、面板开关），以及各模块共用的常量与小工具。
import * as api from "../api.ts";
import type { Appearance } from "../theme.ts";
import type { Compat } from "../protocol.ts";
import { Chat, type ProjectMeta, type SessionMeta } from "./chat.svelte.ts";

// 同时运行上限（与 bridge Claude 分页一致）；终态缓存条数（切回秒开）。
export const MAX_PARALLEL = 3;
export const MAX_IDLE_CACHE = 6;
// 吐字批量落地间隔。
export const STREAM_FLUSH_MS = 90;
// 断线对账链路的请求时限：半开连接的 fetch 永不 settle，一条挂死就够让
// resyncing 永久为真、之后每次对账都早退 —— 界面卡死在「重连中」。
export const RESYNC_TIMEOUT_MS = 12_000;

// ── 工作区 Dock（右侧五工具面板：任务/审阅/终端/浏览器/文件）────────────────
// memory = 宿主（bridge）的记忆卡，看 dimensio 的记忆（工作区外壳与共用面板都由宿主给，见 components/dock/HostedDock.svelte）
export type DockTool = "tasks" | "review" | "term" | "browser" | "files" | "memory";
export const DOCK_TOOL_KEY = "harness.dockTool";
function readDockTool(): DockTool {
  try {
    const v = localStorage.getItem(DOCK_TOOL_KEY);
    if (v === "tasks" || v === "review" || v === "term" || v === "browser" || v === "files" || v === "memory") return v;
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

  // Agent 浏览器（服务端 headless Chrome 的 screencast 直播）：前台会话的那份（服务端按会话各开一份，
  // lib/browser-mount.svelte.ts 切会话时对账）；null = 这个会话的浏览器里没有标签
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
  // 前台会话浏览器的标签列表（stream 的 tabs 事件驱动；空 = 这个会话的浏览器没开）
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
  // 宿主（bridge 的模型中心）要直接打开某个自定义服务的编辑器：「模型服务」面板挂上后接住、置回 null
  vendorEditReq: null as null | string,
  // 宿主（bridge 设置页「本机模型」）要打开本机模型面板、看哪一台：有焦点的那格输入框接住后置回 null
  localMenuReq: null as null | "qwen" | "strata",
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

// 几个模块都要改写的模块级开关（别的模块不能给导入的 let 赋值，所以收进一个对象）。
export const flags = {
  // 用户在 agent 干活时亲手关掉了 Dock：这一轮里浏览器动了也别再自动展开（以前每次 Browser 调用都弹回来，
  // 关了马上又出来）。用户自己再打开 Dock、或发下一条消息，才恢复自动展开。
  browserAutoMuted: false,
  // #93：嵌在 bridge 里离开了 dimensio 页（这期间不开运行流，回到页面再接上）
  pageAway: false,
};

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
export function runningCount(): number {
  return app.chats.filter((c) => c.running || c.reconnecting).length;
}

// 背景网格脉冲（维度切换的信号灯；AxisGrid 监听）
export function pulseGrid() {
  window.dispatchEvent(new CustomEvent("dimensio-pulse"));
}

let toastTimer = 0;

export const LAST_SESSION_KEY = "harness.lastSession";

export function rememberSession(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch { /* ignore */ }
}

// ── 提示 ─────────────────────────────────────────────────────────────────────
export function toast(msg: string, action?: { label: string; run: () => void }) {
  app.toast = msg;
  app.toastAction = action ?? null;
  clearTimeout(toastTimer);
  // 带动作的多留一会儿，给人反应的时间
  toastTimer = window.setTimeout(() => ((app.toast = ""), (app.toastAction = null)), action ? 8000 : 2600);
}
