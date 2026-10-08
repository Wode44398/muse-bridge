// Q11（X45）：时间线归约器——把服务端事件落进一个会话的时间线模型。纯函数：不依赖 Svelte、不碰浏览器全局；
// 副作用（吐字批量落地的定时器、toast、记住最近会话、展开浏览器面板、改全局指示器）经 TimelineEffects 注入。
// state.svelte.ts 把 Chat（$state 类字段）当模型交进来；server/timeline-reducer.test.ts 拿普通对象当模型，
// 用脚本化 provider 驱动真 loop，对时间线的文本形态做快照。
// Svelte 5 深代理的坑：往 $state 数组 push 字面量之后，要改就改数组里那个代理元素，别改字面量——pushItem 返回的就是它。
import { toolMeta } from "./icons.ts";
import { t, tr } from "./i18n.ts";
import { discardStreamTurn, findSteerItem, resetStreamTurn, startStreamTurn } from "./stream-turn.ts";
import type { AgentRun, AskItem, DecidedBy, GoalView, Item, PermissionItem, PlanItem, RecallRef, ToolItem, WorkflowRun } from "./timeline-types.ts";

// U2（X36 第二步）：待送达托盘里的一条插话
export interface PendingSteer {
  id: string;
  text: string;
}
// 从托盘里拿掉一条（按 id；没有 id 时按原话），返回它
export function takePendingSteer(m: { pendingSteers?: PendingSteer[] }, id: string | null, text: string): PendingSteer | null {
  const list = m.pendingSteers;
  if (!list?.length) return null;
  const k = list.findIndex((p) => (id ? p.id === id : p.text === text));
  return k >= 0 ? list.splice(k, 1)[0] : null;
}

// 托盘上写的送达时机：这一轮里还有在跑的工具 → 等它跑完（模型只在两步之间读插话）；否则下一步就读到
export function steerDeliveryHint(timeline: readonly Item[]): string {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const it = timeline[i] as { kind?: string; status?: string; name?: string; steer?: boolean };
    if (it.kind === "user" && !it.steer) break; // 到这一轮的用户消息为止
    if (it.kind === "tool" && it.status === "running" && it.name) return t("等「{tool}」跑完后送达", { tool: tr(toolMeta(it.name).verb) });
  }
  return t("下一步送达");
}

// E3：用户 /技能名 点了技能的那一行提示（直播的 skill_loaded 与重开会话时的 slash-skill 消息共用这一句）
export function skillLoadedText(name: string, pkg = false): string {
  return pkg ? t("已指定技能包 {name}", { name }) : t("已载入技能 {name}", { name });
}

// N45：自动召回清单（直播的 recall 事件、历史里用户消息的 recall 字段共用）——形状不对的条目不要，最多 12 条
export function recallRefsFrom(raw: unknown): RecallRef[] {
  if (!Array.isArray(raw)) return [];
  const out: RecallRef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { id, title, kind, why } = r as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof title !== "string" || !title) continue;
    out.push({ id, title, kind: typeof kind === "string" ? kind : "", ...(typeof why === "string" && why ? { why } : {}) });
    if (out.length >= 12) break;
  }
  return out;
}

// U6（hermes N41）：失败条目。有服务端给的一句人话就用它（原文折进详情）；旧服务端 / 没分类的错，原文第一行当标题。
export function failureItem(ev: any): Extract<Item, { kind: "error" }> {
  const message = String(ev?.message ?? "");
  const summary = typeof ev?.summary === "string" ? ev.summary.trim() : "";
  const headline = summary || message.split("\n")[0].slice(0, 200);
  const ran = Number(ev?.ran);
  return {
    kind: "error",
    text: headline,
    ...(message && message !== headline ? { detail: message } : {}),
    ...(typeof ev?.class === "string" && ev.class ? { cls: ev.class } : {}),
    ...(Number.isFinite(ran) && ran > 0 ? { ran } : {}),
    ...(ev?.retriable === true ? { retriable: true } : {}),
  };
}

const RETRY_WHY: Record<string, string> = {
  rate_limit: t("被限流"),
  upstream_busy: t("上游繁忙"),
  timeout: t("上游超时"),
  server: t("服务端出错"),
  network: t("连接断了"),
};
// U6：「被限流，12 秒后第 2 次重试」
export function retryActivity(cls: unknown, inMs: number, attempt: number): string {
  const why = (typeof cls === "string" && RETRY_WHY[cls]) || t("出错了");
  return t("{why}，{sec} 秒后第 {attempt} 次重试", { why, sec: Math.max(1, Math.round(inMs / 1000)), attempt });
}

// P10（D9）：落定事件里的「在哪台设备上定的」——形状不对就当没带
function decidedBy(raw: unknown): DecidedBy | undefined {
  const r = raw as Partial<DecidedBy> | null | undefined;
  return r && typeof r.id === "string" && r.id && typeof r.label === "string" ? { id: r.id, label: r.label } : undefined;
}

// 一个会话里归约器读写的那些字段（state.svelte.ts 的 Chat 结构上满足它）。
export interface TimelineModel {
  id: string | null;
  runId: string | null;
  title: string;
  timeline: Item[];
  todos: { content: string; status: string }[];
  running: boolean;
  activity: string;
  usage: { inTok: number; outTok: number };
  ctx: { used: number; limit: number };
  preview: { url: string; serviceId: string; publicUrl?: string } | null;
  cfg: any;
  away: boolean;
  // P13：本会话放行的工作区外只读目录（单独一个字段，理由同 away：新起的会话第一轮还没有 cfg 快照）
  readRoots?: string[];
  // U2（X36 第二步）：还没送达的插话——放在输入框上方的待送达托盘，真注入模型上下文时才进时间线
  pendingSteers?: PendingSteer[];
  curText: any;
  curThinking: any;
  pendingText: string;
  pendingThinking: string;
  toolRefs: Map<string, ToolItem>;
  askRefs: Map<string, AskItem>;
  permRefs: Map<string, PermissionItem>;
  planRefs: Map<string, PlanItem>;
  agentRefs: Map<string, AgentRun>;
  workflowRefs: Map<string, WorkflowRun>;
  streamTurnIndex: number | null;
  turnStartTimelineLength: number;
  // U3（X38）：这一轮的运行计时（服务端记账的快照 + 本机与服务端的时钟差）；旧服务端不发就一直是空的
  clock?: RunClock | null;
  // O7（K64）：目标续跑的状态；旧服务端不发就一直是空的
  goal?: GoalView | null;
}

// U3（X38、#52）：运行计时。startedAt / pausedSince 是服务端时钟；skew = 服务端 - 本机，渲染时把本机「现在」换算过去。
// 卡片挂着（在等人）时 pausedSince 有值，计时停在那一刻。
export interface RunClock {
  startedAt: number;
  pausedMs: number;
  pausedSince: number | null;
  skew: number;
}

export function runElapsedMs(clock: RunClock, localNow = Date.now()): number {
  const now = clock.pausedSince ?? localNow + clock.skew;
  return Math.max(0, now - clock.startedAt - clock.pausedMs);
}

// 12s / 3:05 / 1:02:03
export function elapsedLabel(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  if (m) return `${m}:${String(s).padStart(2, "0")}`;
  return `${s}s`;
}

// U3：活动行的几种说法（服务端事件 → 此刻在干什么）
export const ACTIVITY_WAITING_MODEL = t("等待模型回复");
export const ACTIVITY_COMPACTING = t("整理上下文");
const charsLabel = (n: number) =>
  n >= 10_000 ? t("{n}k 字", { n: (n / 1000).toFixed(0) }) : n >= 1_000 ? t("{n}k 字", { n: (n / 1000).toFixed(1) }) : t("{n} 字", { n });
export function toolDraftActivity(name: string, chars: number): string {
  const tool = tr(toolMeta(name).verb);
  return chars > 0 ? t("{tool} · 生成参数（{chars}）", { tool, chars: charsLabel(chars) }) : t("{tool} · 生成参数", { tool });
}

export interface FlushControl {
  // 吐字缓冲的批量落地：浏览器上是一个短定时器，到点调 flushStream；测试里可以当场落。
  scheduleFlush(): void;
  cancelFlush(): void;
}

export interface TimelineEffects extends FlushControl {
  foreground: boolean; // 这是不是前台正在看的会话：只有前台弹面板、改全局指示器、记住最近会话
  // 分屏：这个会话在屏幕上（前台，或另一格）。看得见就不弹「后台对话在等你」；缺省按 foreground
  visible?: boolean;
  toast(msg: string): void;
  rememberSession(id: string): void;
  openBrowserPane(): void; // 前台时展开浏览器面板（要不要真展开——比如竖屏——由实现决定）
  setGlobal(patch: { permissionMode?: string; access?: string; model?: string; thinking?: string }): void;
  refill(text: string): void; // 没送出的插话放回输入框
  setBrowser(url: string): void;
}

export function pushItem(m: TimelineModel, item: Item): any {
  m.timeline.push(item);
  return m.timeline[m.timeline.length - 1]; // 代理元素——改这个，别改字面量
}

// 「已等 1 分 20 秒」/「刚开始」
export function waitedLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return t("刚开始");
  return s < 60 ? t("已等 {s} 秒", { s }) : t("已等 {m} 分 {s} 秒", { m: Math.floor(s / 60), s: s % 60 });
}

// 从时间线上删掉的条目，其 id→条目 索引也要一并松手。否则重试/门禁撤回后
// toolRefs/askRefs 仍指着已不在时间线上的孤儿：晚到的 tool_end 改到孤儿上
// （界面看不到任何更新），两张表还随对话一路只增不减。
export function forgetRefs(m: TimelineModel, dropped: Item[]) {
  for (const item of dropped) {
    const id = (item as any)?.id;
    if (typeof id !== "string") continue;
    const kind = (item as any).kind;
    if (kind === "tool") {
      m.toolRefs.delete(id);
      const tool = item as ToolItem;
      if (tool.agent) m.agentRefs.delete(tool.agent.id);
      if (tool.workflow) {
        m.workflowRefs.delete(tool.workflow.id);
        for (const a of tool.workflow.agents) m.agentRefs.delete(a.id);
      }
    }
    else if (kind === "ask") m.askRefs.delete(id);
    else if (kind === "permission") m.permRefs.delete(id);
    else if (kind === "plan") m.planRefs.delete(id);
  }
}

// ── 吐字节流缓冲 ─────────────────────────────────────────────────────────────
// flush = 把缓冲落进当前游标条目（内容不丢）；drop = 整轮要被重建，缓冲作废。
export function flushStream(m: TimelineModel, fx: FlushControl) {
  fx.cancelFlush();
  if (m.pendingThinking && m.curThinking) m.curThinking.text += m.pendingThinking;
  m.pendingThinking = "";
  if (m.pendingText && m.curText) m.curText.text += m.pendingText;
  m.pendingText = "";
}
export function dropStream(m: TimelineModel, fx: FlushControl) {
  fx.cancelFlush();
  m.pendingText = "";
  m.pendingThinking = "";
}

// 块结束时落定游标：live 旗子掐灭 + 置 null。live 必须是 per-item 真相
// （"这一块正在流"），只置 null 不掐旗子的话，条目永远 live:true，
// 本轮任何后续时刻再进思考态，历史思考行会全体跟着转圈（已踩）。
export function settleCursors(m: TimelineModel, fx: FlushControl) {
  flushStream(m, fx); // 缓冲里的尾巴必须先落地，再掐灭游标——否则最后一批字丢了
  if (m.curThinking) {
    m.curThinking.live = false;
    m.curThinking = null;
  }
  if (m.curText) {
    m.curText.live = false;
    m.curText = null;
  }
}

export const extractText = (content: any[]): string =>
  Array.isArray(content) ? content.map((b) => (b?.t === "text" ? b.text : "")).join("") : "";

// ── 子 agent / 工作流：事件落点与历史重建 ────────────────────────────────────
const STEP_ARG_KEYS = ["command", "pattern", "path", "url", "query", "prompt", "poll", "kill", "action"];
function stepArgPreview(args: any): string {
  if (!args || typeof args !== "object") return "";
  for (const k of STEP_ARG_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  return "";
}

const numOr = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strList = (v: unknown): string[] | undefined => {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
  return list.length ? list : undefined;
};

function newAgentRun(ev: any): AgentRun {
  return {
    id: String(ev.id), label: String(ev.label ?? ""), tier: String(ev.tier ?? "research"), model: String(ev.model ?? ""),
    phase: ev.phase, status: "running", text: "", steps: [], turns: 0, tokens: 0, cached: Boolean(ev.cached), open: false,
    prompt: typeof ev.prompt === "string" ? ev.prompt : "", provider: String(ev.provider ?? ""), toolCalls: 0,
    startedAt: numOr(ev.startedAt) ?? Date.now(), lastAt: Date.now(),
  };
}

// 从 tool_result.meta.subagent（服务端 Agent 工具落盘的摘要 + 工具轨迹）重建卡片。
export function agentRunFromMeta(m: any): AgentRun {
  const trail: any[] = Array.isArray(m?.trail) ? m.trail : [];
  return {
    id: String(m?.id ?? ""), label: String(m?.label ?? ""), tier: String(m?.tier ?? "research"), model: String(m?.model ?? ""),
    status: m?.ok ? "ok" : "fail", text: String(m?.text ?? ""),
    steps: trail.map((s, i) => ({
      id: `${m?.id}:${i}`, name: String(s?.name ?? ""), arg: String(s?.arg ?? ""),
      status: s?.ok ? "ok" : "fail", summary: String(s?.summary ?? ""),
    })),
    turns: Number(m?.turns ?? 0), tokens: Number(m?.inputTokens ?? 0) + Number(m?.outputTokens ?? 0),
    error: m?.error ? String(m.error) : undefined, result: m?.result, open: false,
    // 老会话的 meta 没有 prompt / 计时：面板回落工具参数里的 prompt，时长留空
    prompt: typeof m?.prompt === "string" ? m.prompt : undefined, provider: m?.provider ? String(m.provider) : undefined,
    toolCalls: numOr(m?.toolCalls) ?? trail.length, startedAt: numOr(m?.startedAt), durationMs: numOr(m?.durationMs),
    editedFiles: strList(m?.editedFiles),
    stopReason: typeof m?.stopReason === "string" && m.stopReason !== "completed" ? m.stopReason : undefined,
  };
}

export function workflowRunFromMeta(m: any): WorkflowRun {
  const agents: any[] = Array.isArray(m?.agents) ? m.agents : [];
  return {
    id: String(m?.id ?? ""), name: String(m?.name ?? ""), description: String(m?.description ?? ""),
    phases: Array.isArray(m?.phases) ? m.phases : [], currentPhase: "",
    // 历史只有摘要（模型/计数/计时）；某个 agent 的 prompt/轨迹/答复在工作流日志里，转录视图按需拉
    agents: agents.map((a) => ({
      id: String(a?.id ?? ""), label: String(a?.label ?? ""), tier: String(a?.tier ?? "research"), model: String(a?.model ?? ""),
      phase: a?.phase, status: a?.ok ? "ok" : "fail", text: "", steps: [], turns: Number(a?.turns ?? 0),
      tokens: Number(a?.inputTokens ?? 0) + Number(a?.outputTokens ?? 0),
      error: a?.error ? String(a.error) : undefined, cached: Boolean(a?.cached), open: false,
      toolCalls: numOr(a?.toolCalls), startedAt: numOr(a?.startedAt), durationMs: numOr(a?.durationMs),
    })),
    startedAt: numOr(m?.startedAt),
    durationMs: numOr(m?.durationMs),
    logs: Array.isArray(m?.logs) ? m.logs.map(String) : [],
    status: m?.ok ? "ok" : "fail", error: m?.error ? String(m.error) : undefined,
    agentCount: agents.length, cached: Number(m?.cached ?? 0),
    tokens: Number(m?.inputTokens ?? 0) + Number(m?.outputTokens ?? 0),
  };
}

// 找宿主工具行：优先按事件里的 toolId；没有（旧服务端）就找最近一条还在跑、还没挂
// 东西的同名工具行；都没有就自成一行（极端乱序也不丢实况）。
function hostToolItem(m: TimelineModel, name: "Agent" | "Workflow", toolId: string | undefined, fallbackArgs: any): ToolItem {
  const byId = toolId ? m.toolRefs.get(toolId) : undefined;
  if (byId) return byId;
  const running = [...m.toolRefs.values()].reverse().find(
    (x) => x.name === name && x.status === "running" && !(name === "Agent" ? x.agent : x.workflow),
  );
  if (running) return running;
  const tool = pushItem(m, {
    kind: "tool", id: `${name.toLowerCase()}:${Math.random().toString(36).slice(2, 8)}`, name, args: fallbackArgs,
    status: "running", summary: "", output: "", open: false,
  }) as ToolItem;
  m.toolRefs.set(tool.id, tool);
  return tool;
}

function applySubagentInner(run: AgentRun, inner: any) {
  switch (inner?.e) {
    case "turn_start":
      run.text = "";
      run.turns += 1; // 面板上的「回合」读数：直播时数 turn_start，结束时以服务端的为准
      break;
    case "text_delta":
      run.text += inner.text ?? "";
      break;
    case "tool_start":
      run.steps.push({ id: inner.id, name: inner.name, arg: stepArgPreview(inner.args), status: "running", summary: "" });
      run.toolCalls = (run.toolCalls ?? 0) + 1;
      break;
    case "tool_end": {
      const s = run.steps.find((x) => x.id === inner.id);
      if (s) {
        s.status = inner.ok ? "ok" : "fail";
        s.summary = inner.summary ?? "";
      }
      break;
    }
    case "tool_permission": {
      const s = run.steps.find((x) => x.id === inner.id);
      if (s && inner.decision === "deny") {
        s.status = "denied";
        s.summary = inner.reason ?? "";
      }
      break;
    }
    case "usage":
      run.tokens = Number(inner.totalInputTokens ?? 0) + Number(inner.totalOutputTokens ?? 0);
      break;
    case "error":
      run.error = inner.message;
      break;
  }
}

// ── 归约：一个事件落进一个会话的时间线 ─────────────────────────────────────────
export function reduceTimeline(m: TimelineModel, ev: any, fx: TimelineEffects) {
  // 非增量事件一律先把吐字缓冲落地，保证条目顺序正确（工具卡不会插到还没上屏
  // 的正文前面）。
  if (ev.e !== "text_delta" && ev.e !== "thinking_delta") flushStream(m, fx);
  switch (ev.e) {
    case "session":
      m.id = ev.sessionId;
      if (typeof ev.runId === "string") m.runId = ev.runId; // M2：停止 / 插话针对的就是这一轮
      if (fx.foreground) fx.rememberSession(ev.sessionId);
      break;
    case "turn_start":
      settleCursors(m, fx);
      forgetRefs(m, startStreamTurn(m, ev.index).dropped);
      // U3：新一次请求发出去了，模型还没开口（R3 的「等待网络」也在这里结束）。以前停在上一个工具的动词上
      if (m.running) m.activity = ACTIVITY_WAITING_MODEL;
      break;
    case "tool_call_begin":
      // U3：模型正在写这个工具调用的参数（大文件的 Write 参数能写好几分钟）
      if (m.running) m.activity = toolDraftActivity(String(ev.name ?? ""), Number(ev.chars) || 0);
      break;
    case "compact_start":
      if (m.running) m.activity = ACTIVITY_COMPACTING;
      break;
    case "goal":
      // O7：目标续跑的状态（null = 目标结束了）
      m.goal = ev.goal && typeof ev.goal === "object" ? (ev.goal as GoalView) : null;
      break;
    case "run_clock": {
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const startedAt = n(ev.startedAt);
      const serverNow = n(ev.serverNow);
      if (startedAt !== null && serverNow !== null) {
        m.clock = { startedAt, pausedMs: n(ev.pausedMs) ?? 0, pausedSince: n(ev.pausedSince), skew: serverNow - Date.now() };
      }
      break;
    }
    case "turn_discard":
      settleCursors(m, fx);
      forgetRefs(m, discardStreamTurn(m, ev.index).dropped);
      // V2：服务端说明为什么撤回（验证门禁追问），不再让答复凭空消失。
      m.activity = m.running ? (typeof ev.reason === "string" && ev.reason ? tr(ev.reason) : t("思考中")) : "";
      break;
    case "thinking_delta":
      if (!m.curThinking) {
        // 换块：先把上一段的缓冲落进它自己的条目，再掐灭旗子换游标
        flushStream(m, fx);
        // 新思考块开场 = 上一段正文（若在流）已结束
        if (m.curText) {
          m.curText.live = false;
          m.curText = null;
        }
        m.curThinking = pushItem(m, { kind: "thinking", text: "", open: false, live: true });
        m.activity = t("思考中");
      }
      m.pendingThinking += ev.text;
      fx.scheduleFlush();
      break;
    case "text_delta":
      if (!m.curText) {
        flushStream(m, fx);
        // 正文开场 = 这段思考已结束
        if (m.curThinking) {
          m.curThinking.live = false;
          m.curThinking = null;
        }
        m.curText = pushItem(m, { kind: "text", text: "", live: true });
        m.activity = t("回复中");
      }
      m.pendingText += ev.text;
      fx.scheduleFlush();
      break;
    case "tool_start": {
      settleCursors(m, fx);
      const tool = pushItem(m, {
        kind: "tool",
        id: ev.id,
        name: ev.name,
        args: ev.args,
        status: "running",
        summary: "",
        output: "",
        open: false,
      }) as ToolItem;
      m.toolRefs.set(ev.id, tool);
      m.activity = tr(toolMeta(ev.name).verb);
      break;
    }
    case "tool_end": {
      const ref = m.toolRefs.get(ev.id);
      if (ref) {
        ref.status = ev.ok ? "ok" : "fail";
        ref.summary = ev.summary ?? "";
        ref.output = extractText(ev.content);
        ref.progress = undefined;
        if (typeof ev.outcome === "string" && ev.outcome) ref.outcome = ev.outcome; // U8（K36）
      }
      // U3：这一批工具都跑完了就不再说「读取文件」——接下来是模型在想（还有别的工具在跑就说那一个）
      if (m.running) {
        const still = [...m.toolRefs.values()].reverse().find((x) => x.status === "running");
        m.activity = still ? tr(toolMeta(still.name).verb) : t("思考中");
      }
      break;
    }
    case "tool_progress": {
      // R14（K37）：前台 Bash 的实时尾行；只挂在还在跑的那一行上
      const ref = m.toolRefs.get(ev.id);
      if (ref && ref.status === "running") {
        ref.progress = { tail: ev.tail ?? "", elapsedMs: ev.elapsedMs ?? 0, canBackground: ev.canBackground === true };
      }
      break;
    }
    case "tool_permission": {
      const ref = m.toolRefs.get(ev.id);
      if (ref && ev.decision === "deny") {
        ref.status = "denied";
        ref.summary = ev.reason;
      }
      break;
    }
    // ── 子 agent / 工作流实况 ──
    case "subagent_start": {
      const run = newAgentRun(ev);
      let attached: AgentRun;
      const wf = ev.workflowId ? m.workflowRefs.get(ev.workflowId) : undefined;
      if (wf) {
        wf.agents.push(run);
        attached = wf.agents[wf.agents.length - 1];
      } else {
        const host = hostToolItem(m, "Agent", ev.toolId, { prompt: ev.prompt });
        host.agent = run;
        attached = host.agent!;
      }
      m.agentRefs.set(ev.id, attached);
      break;
    }
    case "subagent_event": {
      const run = m.agentRefs.get(ev.id);
      if (run) {
        run.lastAt = Date.now();
        run.suspendedUntil = undefined; // O2：又有动静了＝挂起结束
        applySubagentInner(run, ev.ev);
      }
      break;
    }
    case "subagent_suspended": {
      // O2：子 agent 因为限流 / 上游过载挂起，waitMs 之后在同一个状态上接着跑（不算失败）
      const run = m.agentRefs.get(ev.id);
      if (run && run.status === "running") {
        run.lastAt = Date.now();
        run.suspendedUntil = Date.now() + Number(ev.waitMs ?? 0);
        run.suspendReason = String(ev.reason ?? "");
      }
      break;
    }
    case "subagent_end": {
      const run = m.agentRefs.get(ev.id);
      if (!run) break;
      run.status = ev.ok ? "ok" : "fail";
      run.error = ev.error;
      run.turns = ev.turns ?? run.turns;
      run.tokens = Number(ev.inputTokens ?? 0) + Number(ev.outputTokens ?? 0) || run.tokens;
      if (ev.text) run.text = ev.text;
      if (ev.result !== undefined) run.result = ev.result;
      if (ev.cached) run.cached = true;
      if (typeof ev.toolCalls === "number") run.toolCalls = ev.toolCalls;
      run.editedFiles = strList(ev.editedFiles);
      if (typeof ev.stopReason === "string") run.stopReason = ev.stopReason;
      run.suspendedUntil = undefined;
      run.durationMs = numOr(ev.durationMs) ?? (run.startedAt ? Date.now() - run.startedAt : undefined);
      for (const s of run.steps) if (s.status === "running") s.status = ev.ok ? "ok" : "fail";
      break;
    }
    case "workflow_start": {
      const wf: WorkflowRun = {
        id: String(ev.id), name: String(ev.name ?? ""), description: String(ev.description ?? ""),
        phases: Array.isArray(ev.phases) ? ev.phases : [], currentPhase: "", agents: [], logs: [],
        status: "running", agentCount: 0, cached: 0, tokens: 0, startedAt: numOr(ev.startedAt) ?? Date.now(),
      };
      const host = hostToolItem(m, "Workflow", ev.toolId, { name: ev.name });
      host.workflow = wf;
      m.workflowRefs.set(wf.id, host.workflow!);
      m.activity = t("工作流 · {name}", { name: wf.name });
      break;
    }
    case "workflow_phase": {
      const wf = m.workflowRefs.get(ev.id);
      if (wf) {
        wf.currentPhase = String(ev.title ?? "");
        if (!wf.phases.some((p) => p.title === wf.currentPhase)) wf.phases.push({ title: wf.currentPhase });
        m.activity = t("工作流 · {name}", { name: wf.currentPhase });
      }
      break;
    }
    case "workflow_log": {
      const wf = m.workflowRefs.get(ev.id);
      if (wf) {
        wf.logs.push(String(ev.text ?? ""));
        if (wf.logs.length > 200) wf.logs.shift();
      }
      break;
    }
    case "workflow_end": {
      const wf = m.workflowRefs.get(ev.id);
      if (!wf) break;
      wf.status = ev.ok ? "ok" : "fail";
      wf.error = ev.error;
      wf.agentCount = ev.agents ?? wf.agents.length;
      wf.cached = ev.cached ?? 0;
      wf.tokens = Number(ev.inputTokens ?? 0) + Number(ev.outputTokens ?? 0);
      wf.durationMs = numOr(ev.durationMs) ?? (wf.startedAt ? Date.now() - wf.startedAt : undefined);
      if (ev.result !== undefined) wf.result = ev.result;
      for (const a of wf.agents) if (a.status === "running") a.status = ev.ok ? "ok" : "fail";
      if (m.running) m.activity = t("思考中");
      break;
    }
    case "ask": {
      settleCursors(m, fx);
      const item = pushItem(m, {
        kind: "ask",
        id: ev.id,
        questions: ev.questions ?? [],
        answered: false,
        selected: {},
        ...(typeof ev.deadlineAt === "number" ? { deadlineAt: ev.deadlineAt } : {}),
      }) as AskItem;
      m.askRefs.set(ev.id, item);
      m.activity = ""; // 等用户回答，不显示“思考中”转圈
      // 后台会话在等人 —— 提醒一声，免得它无声卡在提问上
      if (!(fx.visible ?? fx.foreground)) fx.toast(m.title ? t("「{title}」在等你回答", { title: m.title }) : t("「后台对话」在等你回答"));
      break;
    }
    case "ask_answer": {
      // 任一设备回答后落定（含本机乐观更新的二次确认，幂等）
      const ref = m.askRefs.get(ev.id);
      if (ref) {
        ref.answered = true;
        for (const a of ev.answers ?? []) ref.selected[a.questionId] = a.selected ?? [];
        if (decidedBy(ev.by)) ref.by = decidedBy(ev.by); // P10（D9）
      }
      if (m.running) m.activity = t("思考中"); // 拿到答案，agent 继续
      break;
    }
    // M1：卡片没等到人就作废了（停止 / 这一轮结束），收起交互态。
    // P7：reason "timeout" = 倒计时到了没人处理（这一轮还在继续），卡片标成「超时」而不是「这一轮已结束」。
    case "ask_cancelled": {
      const ref = m.askRefs.get(ev.id);
      if (ref) {
        ref.answered = true; // 所选为空 = 「未回答」
        if (ev.reason === "timeout") ref.expired = true;
      }
      if (ev.reason === "timeout" && m.running) m.activity = t("思考中"); // agent 按假设接着干
      break;
    }
    case "permission_cancelled": {
      const ref = m.permRefs.get(ev.id);
      if (ref && !ref.decided) {
        ref.cancelled = true;
        if (ev.reason === "timeout") ref.cancelReason = "timeout";
      }
      if (ev.reason === "timeout" && m.running) m.activity = t("思考中");
      break;
    }
    case "plan_cancelled": {
      const ref = m.planRefs.get(ev.id);
      if (ref && !ref.decided) {
        ref.cancelled = true;
        if (ev.reason === "timeout") ref.cancelReason = "timeout";
      }
      if (ev.reason === "timeout" && m.running) m.activity = t("思考中");
      break;
    }
    case "permission_ask": {
      settleCursors(m, fx);
      const item = pushItem(m, {
        kind: "permission",
        id: ev.id,
        tool: ev.tool,
        subject: ev.subject ?? "",
        rule: ev.rule,
        decided: null,
        ...(typeof ev.deadlineAt === "number" ? { deadlineAt: ev.deadlineAt } : {}),
        ...(Array.isArray(ev.sessionRules) ? { sessionRules: ev.sessionRules } : {}),
        ...(Array.isArray(ev.prefixRules) && ev.prefixRules.length ? { prefixRules: ev.prefixRules } : {}),
        ...(ev.noSession === true ? { noSession: true } : {}),
        // P11：给人看的原因；执行事实（形状不对就不要）
        ...(typeof ev.why === "string" && ev.why ? { why: ev.why } : {}),
        ...(ev.preview && typeof ev.preview === "object" && typeof ev.preview.kind === "string" ? { preview: ev.preview } : {}),
      }) as PermissionItem;
      m.permRefs.set(ev.id, item);
      m.activity = ""; // 在等人点，不转圈
      if (!(fx.visible ?? fx.foreground)) fx.toast(m.title ? t("「{title}」在等你批准一次操作", { title: m.title }) : t("「后台对话」在等你批准一次操作"));
      break;
    }
    case "permission_resolved": {
      const ref = m.permRefs.get(ev.id);
      if (ref) {
        ref.decided = ev.decision;
        if (ev.scope === "prefix") ref.scope = "prefix";
        // P10：在哪台设备上定的；拒绝时附的话
        if (decidedBy(ev.by)) ref.by = decidedBy(ev.by);
        if (typeof ev.note === "string" && ev.note) ref.note = ev.note;
      }
      if (m.running) m.activity = t("思考中");
      break;
    }
    case "plan_ask": {
      settleCursors(m, fx);
      const item = pushItem(m, {
        kind: "plan",
        id: ev.id,
        plan: ev.plan ?? "",
        decided: null,
        ...(typeof ev.deadlineAt === "number" ? { deadlineAt: ev.deadlineAt } : {}),
      }) as PlanItem;
      m.planRefs.set(ev.id, item);
      m.activity = "";
      if (!(fx.visible ?? fx.foreground)) fx.toast(m.title ? t("「{title}」提交了一份计划等你批准", { title: m.title }) : t("「后台对话」提交了一份计划等你批准"));
      break;
    }
    case "plan_resolved": {
      const ref = m.planRefs.get(ev.id);
      if (ref) {
        ref.decided = ev.handoff ? "handoff" : ev.approved ? "approved" : "returned";
        if (decidedBy(ev.by)) ref.by = decidedBy(ev.by); // P10
        if (!ev.approved && typeof ev.note === "string" && ev.note) ref.note = ev.note;
      }
      if (m.running) m.activity = t("思考中");
      break;
    }
    // 服务端把本会话的模式改了（批准计划 → 自主执行），同步全局指示器
    case "mode":
      if (m.cfg) m.cfg = { ...m.cfg, permissionMode: ev.permissionMode };
      if (fx.foreground) fx.setGlobal({ permissionMode: ev.permissionMode });
      break;
    // P3：离开模式开 / 关（任一设备手动切，或发新消息 / 插话时服务端自动关）
    case "away":
      m.away = ev.away === true;
      if (m.cfg) m.cfg = { ...m.cfg, away: m.away };
      break;
    // P13（X18）：本会话放行的工作区外只读目录变了（任一设备在卡片上放行、在档位菜单里删）
    case "read_roots":
      m.readRoots = Array.isArray(ev.roots) ? ev.roots.filter((d: unknown) => typeof d === "string") : [];
      if (m.cfg) m.cfg = { ...m.cfg, readRoots: m.readRoots };
      break;
    // 访问范围在任一设备被切（仅工作空间 ↔ 整机）：同步本会话快照与全局指示器
    case "access":
      if (m.cfg) m.cfg = { ...m.cfg, access: ev.access };
      if (fx.foreground) fx.setGlobal({ access: ev.access });
      break;
    // 型号 / 思考深度在任一设备被换（会话级）：同步本会话快照与全局指示器（型号菜单的勾读全局）
    case "model":
      if (m.cfg) m.cfg = { ...m.cfg, model: ev.model, thinking: ev.thinking };
      if (fx.foreground) fx.setGlobal({ model: ev.model, thinking: ev.thinking });
      break;
    // 插话在任一设备落地：先进输入框上方的待送达托盘（本机发起的已乐观放进去，按 id 去重）；别的设备插的话在这里补上
    // （镜像端也看得见有人在中途说话）。U2（X36 第二步）：以前一落地就进时间线——模型还在跑一个十分钟的工作流时，
    // 气泡早早排在上面，看着像已经被读到了。
    case "steer_queued": {
      if (typeof ev.text !== "string" || !ev.text) break;
      const id = typeof ev.id === "string" && ev.id ? ev.id : null;
      if (id && findSteerItem(m.timeline, ev) >= 0) break; // 已经送达（重放顺序乱了）
      const list = m.pendingSteers ?? (m.pendingSteers = []);
      if (!list.some((p) => (id ? p.id === id : p.text === ev.text))) list.push({ id: id ?? `t:${ev.text}`, text: ev.text });
      break;
    }
    // 已被注入进模型上下文：从托盘挪进时间线（落在它真正被读到的位置）
    case "steer_applied": {
      if (typeof ev.text !== "string" || !ev.text) break;
      const id = typeof ev.id === "string" && ev.id ? ev.id : null;
      takePendingSteer(m, id, ev.text);
      if (findSteerItem(m.timeline, ev) < 0) pushItem(m, { kind: "user", text: ev.text, steer: true, ...(id ? { steerId: id } : {}) });
      break;
    }
    // U2：还没送达就被撤回了（任一设备在托盘上撤的）
    case "steer_withdrawn":
      if (typeof ev.id === "string") takePendingSteer(m, ev.id, "");
      break;
    // E3：用户 /技能名 点的技能已经跟在消息（或插话）后面进了对话——一行提示（重开会话时由 slash-skill 消息还原成同一句）
    case "skill_loaded":
      if (typeof ev.name === "string" && ev.name) pushItem(m, { kind: "notice", text: skillLoadedText(ev.name, ev.pkg === true) });
      break;
    // N45：这一轮开跑时自动召回了哪些——挂到本轮那条用户消息下（从后往前第一条不是插话的用户气泡；镜像端的底座也含这一条）
    case "recall": {
      const items = recallRefsFrom(ev.items);
      if (!items.length) break;
      for (let i = m.timeline.length - 1; i >= 0; i--) {
        const it = m.timeline[i];
        if (it.kind === "user" && !it.steer) {
          it.recall = items;
          break;
        }
      }
      break;
    }
    // M3（#27、#45）：run 结束了，这些插话没来得及送进模型——撤掉对应的气泡，文字放回输入框。
    case "steer_returned": {
      const texts: string[] = (ev.texts ?? []).filter((x: unknown) => typeof x === "string" && x);
      const ids: unknown[] = Array.isArray(ev.ids) ? ev.ids : [];
      texts.forEach((text, k) => {
        takePendingSteer(m, typeof ids[k] === "string" ? (ids[k] as string) : null, text);
        // 旧前端时代乐观上屏的气泡（与旧服务端配合）照旧撤掉
        const i = findSteerItem(m.timeline, { id: ids[k], text });
        if (i >= 0) m.timeline.splice(i, 1);
      });
      if (texts.length && fx.foreground) {
        fx.refill(texts.join("\n"));
        fx.toast(t("这一轮已结束，刚才的插话没送出，已放回输入框"));
      }
      break;
    }
    case "todo":
      m.todos = ev.items ?? [];
      break;
    case "preview":
      // dev server 起来了：记下地址点亮「预览」按钮；前台才自动展开浏览器面板（后台会话的 dev server
      // 不该抢当前会话的屏幕）。是否真把页面拉进共享浏览器由用户点「预览」决定 —— 别抢 agent 正在操作的页面。
      m.preview = { url: ev.url, serviceId: ev.serviceId, publicUrl: ev.publicUrl };
      if (fx.foreground) fx.openBrowserPane();
      break;
    case "preview_closed":
      if (m.preview?.serviceId === ev.serviceId) m.preview = null;
      break;
    case "browser":
      // agent 的浏览器动了 —— 共享浏览器是全局单例，数据全局记；面板自动展开只给前台
      fx.setBrowser(ev.url);
      if (fx.foreground) fx.openBrowserPane();
      break;
    case "screenshot":
      pushItem(m, { kind: "screenshot", dataUri: ev.dataUri ?? "", ...(ev.asset ? { asset: ev.asset } : {}), url: ev.url, verdict: ev.verdict ?? "" });
      break;
    case "usage":
      m.usage = { inTok: ev.totalInputTokens, outTok: ev.totalOutputTokens };
      break;
    case "context":
      m.ctx = { used: ev.usedTokens, limit: ev.limitTokens };
      if (ev.compacted) pushItem(m, { kind: "notice", text: t("上下文已压缩") });
      if (m.running && m.activity === ACTIVITY_COMPACTING) m.activity = t("思考中"); // U3：整理完了
      // R3：连接失败时服务端在等网络恢复，不是卡死；停止键照常有效。
      if (ev.waiting && m.running) {
        const waited = waitedLabel(Number(ev.waitedMs) || 0);
        m.activity = t("等待网络恢复（{waited}）", { waited });
      } else if (ev.retry && typeof ev.retryInMs === "number" && m.running) {
        // U6：退避重试——活动行写清楚为什么、多久之后第几次（不进时间线）
        m.activity = retryActivity(ev.retryClass, ev.retryInMs, ev.retry);
      }
      break;
    case "artifacts": {
      const target = m.curText ?? [...m.timeline].reverse().find((item) => item.kind === "text");
      if (target?.kind === "text") target.artifacts = ev.items ?? [];
      break;
    }
    case "error":
      settleCursors(m, fx);
      resetStreamTurn(m);
      // U6（hermes N41）：中断不是失败——灰色的一行「已停止」；失败 = 一句人话 + 原始报错折起来 + 已经执行过几次工具
      if (ev.message === "aborted") pushItem(m, { kind: "notice", text: ev.stopped === "restart" ? t("服务重启打断了这一轮") : t("已停止") });
      else pushItem(m, failureItem(ev));
      break;
    case "done": {
      settleCursors(m, fx);
      resetStreamTurn(m);
      m.activity = "";
      // U8（E3）：这一轮的用时挂在最后一段回答上（折叠过程时写「用时 N（等你的 M 不算）」）
      if (typeof ev.durationMs === "number") {
        const last = [...m.timeline].reverse().find((it) => it.kind === "text" || it.kind === "user");
        if (last?.kind === "text") last.run = { durationMs: ev.durationMs, waitedMs: Number(ev.waitedMs) || 0 };
      }
      break;
    }
  }
}
