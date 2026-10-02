// 工作区「任务」面板 / 工作流紧凑卡 / Agent 卡的纯函数层：没有 rune、不碰 DOM，Node 里直接测
//（server/tasks-view.test.ts，同 timeline-merge.ts 的路子）。
//
// 形态与算法照 bridge Claude 分页 lib/taskModel.js（官方 /code 页的进度树 hD、单 agent 显示态 pD、
// 点阵压缩 ZO）移植，数据源换成 dimensio 自己的 AgentRun / WorkflowRun：直播由 subagent_* /
// workflow_* 事件驱动，历史从 tool_result.meta 重建。这里只按结构取字段，不 import
// state.svelte.ts（那边带 rune 与浏览器全局，Node 里载不动）。

import { t } from "./i18n.ts";

export type TaskKind = "agent" | "workflow";
export type TaskStatus = "running" | "completed" | "failed" | "stopped";
export type DotState = "done" | "running" | "stalled" | "error" | "pending";
export type PhaseStatus = "pending" | "running" | "done" | "error";

// 子 agent 多久没有任何事件算「卡住」（点阵黄格，只是提示）。thinking_delta 不转发，思考型模型
// 单回合想两三分钟很常见，所以比官方的 90s 宽得多。
export const STALL_MS = 240_000;

export const STATUS_LABEL: Record<TaskStatus, string> = {
  running: t("运行中"),
  completed: t("已完成"),
  failed: t("失败"),
  stopped: t("已停止"),
};

interface RunLike {
  id: string;
  label: string;
  status: "running" | "ok" | "fail";
  phase?: string;
  error?: string;
  tokens?: number;
  lastAt?: number;
  suspendedUntil?: number; // O2：限流挂起中
  startedAt?: number;
  durationMs?: number;
}
interface WorkflowLike {
  name?: string;
  phases?: { title: string; detail?: string }[];
  currentPhase?: string;
  agents?: RunLike[];
  status: "running" | "ok" | "fail";
  error?: string;
  startedAt?: number;
  durationMs?: number;
}

export interface Counts {
  done: number;
  running: number; // 含 stalled
  stalled: number;
  error: number;
  pending: number;
  total: number;
}
export const EMPTY_COUNTS: Readonly<Counts> = Object.freeze({ done: 0, running: 0, stalled: 0, error: 0, pending: 0, total: 0 });

// ── 工具行 → 任务 ────────────────────────────────────────────────────────────
export function toolTaskKind(tool: any): TaskKind | "" {
  if (tool?.name === "Workflow") return "workflow";
  if (tool?.name === "Agent") return "agent";
  return "";
}

// 运行被掐（停止按钮 / 父轮 abort）落成 error "aborted"：算「已停止」而不是「失败」。
const STOP_RE = /abort|中断|cancel/i;

// 终态：有 run 记录看 run；run 还挂着 running 而工具行已经结束 = 被中断没收到 end 事件。
// 没有 run（工作流还在等确认卡 / 历史里没拿到结果）按工具行推：重建出来的无结果行摘要是「已中断…」。
export function toolTaskStatus(tool: any): TaskStatus {
  const run: RunLike | WorkflowLike | undefined = tool?.workflow ?? tool?.agent;
  const toolRunning = tool?.status === "running";
  if (run) {
    if (run.status === "running") return toolRunning ? "running" : "stopped";
    if (run.status === "ok") return "completed";
    return STOP_RE.test(run.error ?? "") ? "stopped" : "failed";
  }
  if (toolRunning) return "running";
  if (tool?.status === "ok") return "completed";
  if (/^已中断/.test(String(tool?.summary ?? ""))) return "stopped"; // i18n-ignore（认服务端摘要的固定开头）
  return "failed";
}

function firstLine(s: unknown, cap = 80): string {
  return typeof s === "string" ? (s.trim().split(/\r?\n/)[0] ?? "").trim().slice(0, cap) : "";
}

// 工作流名兜底：工作流对象还没到（等确认卡）或历史里没结果时，从脚本开头的 meta 字面量里抠。
const META_NAME_RE = /\bmeta\s*=\s*\{[\s\S]{0,400}?\bname\s*:\s*(['"`])([^'"`\n]+)\1/;
export function workflowNameFromScript(script: unknown): string {
  if (typeof script !== "string") return "";
  const m = script.slice(0, 4096).match(META_NAME_RE);
  return m ? m[2].trim() : "";
}

export function toolTaskTitle(tool: any): string {
  const kind = toolTaskKind(tool);
  if (kind === "workflow") return tool.workflow?.name || workflowNameFromScript(tool.args?.script) || t("工作流");
  if (kind === "agent") {
    const label = typeof tool.args?.label === "string" ? tool.args.label.trim() : "";
    return tool.agent?.label || label || firstLine(tool.args?.prompt) || t("子 agent");
  }
  return String(tool?.name ?? "");
}

export interface TaskEntry {
  tool: any;
  kind: TaskKind;
  status: TaskStatus;
  key: string;
  index: number;
  startedAt: number;
  endedAt: number;
}

// 本会话的全部任务 = 时间线上的 Agent / Workflow 工具行（工作流里的 agent 属于工作流详情，不单列）。
export function collectTasks(timeline: readonly any[]): TaskEntry[] {
  const out: TaskEntry[] = [];
  let index = 0;
  for (const it of timeline) {
    if (it?.kind !== "tool") continue;
    const kind = toolTaskKind(it);
    if (!kind) continue;
    const run: RunLike | WorkflowLike | undefined = it.workflow ?? it.agent;
    const startedAt = run?.startedAt ?? 0;
    const endedAt = startedAt && typeof run?.durationMs === "number" ? startedAt + run.durationMs : 0;
    out.push({ tool: it, kind, status: toolTaskStatus(it), key: String(it.id), index: index++, startedAt, endedAt });
  }
  return out;
}

// 分节：进行中按开始时间升序（先跑的在上）；已完成按结束时间降序（刚结束的在上），
// 老会话没有时间戳的按出现顺序倒排。
export function splitTasks(list: readonly TaskEntry[]): { running: TaskEntry[]; finished: TaskEntry[] } {
  const running = list
    .filter((x) => x.status === "running")
    .sort((a, b) => (a.startedAt - b.startedAt) || (a.index - b.index));
  const finished = list
    .filter((x) => x.status !== "running")
    .sort((a, b) => ((b.endedAt || b.startedAt) - (a.endedAt || a.startedAt)) || (b.index - a.index));
  return { running, finished };
}

// ── 子 agent 卡（对话流里的卡片 / 叠卡、任务面板的行与详情共用的一份读数）──────────────
// 并行批：时间线上紧挨着的 Agent 工具行（模型一轮里同时派出去的几个）。对话流把一批画成一张叠卡，
// 子 agent 面板的「上一个 / 下一个」也在这一批里走。
export function agentBatchOf(timeline: readonly any[], toolId: string): any[] {
  const at = timeline.findIndex((x) => x?.kind === "tool" && x.id === toolId);
  if (at < 0 || toolTaskKind(timeline[at]) !== "agent") return [];
  const isAgent = (x: any) => x?.kind === "tool" && toolTaskKind(x) === "agent";
  let from = at;
  let to = at;
  while (from > 0 && isAgent(timeline[from - 1])) from--;
  while (to + 1 < timeline.length && isAgent(timeline[to + 1])) to++;
  return timeline.slice(from, to + 1);
}

export interface AgentView {
  title: string;
  status: TaskStatus;
  // 在跑但久无动静 / 限流挂起中（只是提示，不是终态）
  stalled: boolean;
  suspended: boolean;
  tier: string;
  model: string;
  calls: number;
  tokens: number;
  time: string;
  // 在跑时最近动手的那一步（没有 = 还没动手）；这一步做完、模型在想下一步时仍是它，卡片上那一行不来回跳
  step: { id: string; name: string; arg: string } | null;
  error: string;
}

// chatRunning = 这一轮还在跑：停了而它还挂着 running = 被打断（没等到 end 事件），按「已停止」画。
// run 还没到（subagent_start 之前）时档位回落工具参数。
export function agentView(tool: any, opts: { now: number; chatRunning: boolean }): AgentView {
  const run = tool?.agent as
    | (RunLike & { tier?: string; model?: string; steps?: { id: string; name: string; arg: string; status: string }[]; toolCalls?: number })
    | undefined;
  const raw = toolTaskStatus(tool);
  const status: TaskStatus = raw === "running" && !opts.chatRunning ? "stopped" : raw;
  const running = status === "running";
  const steps = run?.steps ?? [];
  const last = steps[steps.length - 1];
  const dot = running && run ? agentDotState(run, { now: opts.now }) : "";
  const suspended = running && !!run?.suspendedUntil && opts.now < run.suspendedUntil;
  return {
    title: toolTaskTitle(tool),
    status,
    stalled: dot === "stalled" && !suspended,
    suspended,
    tier: run?.tier || (tool?.args?.tools === "coder" ? "coder" : "research"),
    model: modelShort(run?.model),
    calls: run ? (run.toolCalls ?? steps.length) : 0,
    tokens: run?.tokens ?? 0,
    time: runElapsed(run, running, opts.now),
    step: running && last ? { id: last.id, name: last.name, arg: last.arg } : null,
    error: status === "failed" ? firstLine(run?.error || (!run ? tool?.summary : ""), 160) : "",
  };
}

// 一批子 agent 的合计：叠卡头行、量线节点用。
export function batchCounts(views: readonly AgentView[]): { total: number; running: number; failed: number; stopped: number; done: number } {
  const c = { total: views.length, running: 0, failed: 0, stopped: 0, done: 0 };
  for (const v of views) {
    if (v.status === "running") c.running++;
    else if (v.status === "failed") c.failed++;
    else if (v.status === "stopped") c.stopped++;
    else c.done++;
  }
  return c;
}

// 一批的墙钟：最早开始到最晚结束（还有在跑的 = 到现在）；拿不到时间戳就空串。
export function batchElapsed(tools: readonly any[], running: boolean, now: number): string {
  let start = 0;
  let end = 0;
  for (const tl of tools) {
    const r = tl?.agent;
    if (!r?.startedAt) continue;
    start = start ? Math.min(start, r.startedAt) : r.startedAt;
    if (typeof r.durationMs === "number") end = Math.max(end, r.startedAt + r.durationMs);
  }
  if (!start) return "";
  if (running) return fmtDur(Math.max(0, now - start));
  return end ? fmtDur(end - start) : "";
}

// ── 单 agent 显示态 / 计数 ───────────────────────────────────────────────────
// settled：所属工作流已经结束，仍挂着 running 的 agent 视为没做完（红格）。
export function agentDotState(run: RunLike, opts: { now?: number; settled?: boolean } = {}): DotState {
  if (run.status === "ok") return "done";
  if (run.status === "fail") return "error";
  if (opts.settled) return "error";
  // O2：限流挂起中的子 agent 也算「卡住」那一档（在等，不是在干活）
  if (run.suspendedUntil && (opts.now ?? Date.now()) < run.suspendedUntil) return "stalled";
  if (opts.now !== undefined && run.lastAt && opts.now - run.lastAt > STALL_MS) return "stalled";
  return "running";
}

function bump(c: Counts, s: DotState) {
  c.total += 1;
  if (s === "stalled") {
    c.running += 1;
    c.stalled += 1;
  } else c[s] += 1;
}

export function countRuns(runs: readonly RunLike[], opts: { now?: number; settled?: boolean } = {}): Counts {
  const c = { ...EMPTY_COUNTS };
  for (const r of runs) bump(c, agentDotState(r, opts));
  return c;
}

// ── 工作流进度树（官方 hD 的 dimensio 版）────────────────────────────────────
// 阶段顺序 = meta.phases 顺序 + 运行中才冒出来的 opts.phase；没归阶段的 agent 收进末尾「未分组」
//（title ""）。阶段状态：有失败 → error；有在跑 → running（工作流已结束则 done）；
// 空阶段 → 正是当前阶段则 running，否则 pending；其余 done。
export interface PhaseView {
  index: number;
  title: string;
  detail?: string;
  agents: RunLike[];
  counts: Counts;
  status: PhaseStatus;
  tokens: number;
}

// settled 缺省 = 工作流对象已结束；工具行已结束而工作流没收到 end（被中断）时调用方显式传 true。
export function deriveWorkflow(
  wf: WorkflowLike,
  opts: { now?: number; settled?: boolean } = {},
): { phases: PhaseView[]; counts: Counts; tokens: number } {
  const settled = opts.settled ?? wf.status !== "running";
  const agents = wf.agents ?? [];
  const titles: string[] = [];
  const details = new Map<string, string | undefined>();
  for (const p of wf.phases ?? []) {
    if (!p?.title || titles.includes(p.title)) continue;
    titles.push(p.title);
    details.set(p.title, p.detail);
  }
  for (const a of agents) if (a.phase && !titles.includes(a.phase)) titles.push(a.phase);
  const groups = titles.map((title) => ({ title, detail: details.get(title), agents: agents.filter((a) => a.phase === title) }));
  const loose = agents.filter((a) => !a.phase);
  if (loose.length) groups.push({ title: "", detail: undefined, agents: loose });

  const counts = { ...EMPTY_COUNTS };
  let tokens = 0;
  const phases = groups.map((g, index): PhaseView => {
    const c = { ...EMPTY_COUNTS };
    let tk = 0;
    for (const a of g.agents) {
      const s = agentDotState(a, { now: opts.now, settled });
      bump(c, s);
      bump(counts, s);
      tk += a.tokens ?? 0;
    }
    tokens += tk;
    const current = !settled && g.title !== "" && g.title === wf.currentPhase;
    let status: PhaseStatus;
    if (c.error > 0) status = "error";
    else if (c.running > 0) status = settled ? "done" : "running";
    else if (c.total === 0) status = current ? "running" : "pending";
    else status = "done";
    return { index, title: g.title, detail: g.detail, agents: g.agents, counts: c, status, tokens: tk };
  });
  return { phases, counts, tokens };
}

// ── 点阵压缩（官方 ZO）───────────────────────────────────────────────────────
// 容量够就一个 agent 一格（按状态排）；超容量时按比例分配（最大余数法），每个非零状态至少一格，
// 压缩后 stalled 并入 running。
export function dotCells(counts: Counts, cap: number): DotState[] {
  const total = counts.total || 0;
  if (!total) return [];
  if (total <= cap) {
    const n: Record<DotState, number> = {
      done: counts.done,
      running: Math.max(0, counts.running - counts.stalled),
      stalled: counts.stalled,
      error: counts.error,
      pending: counts.pending,
    };
    const cells: DotState[] = [];
    for (const s of ["done", "running", "stalled", "error", "pending"] as DotState[]) for (let k = 0; k < n[s]; k++) cells.push(s);
    return cells;
  }
  const order: DotState[] = ["done", "running", "error", "pending"];
  const alloc = order
    .map((s) => ({ s, n: counts[s] || 0 }))
    .filter((p) => p.n > 0)
    .map((p) => {
      const exact = (p.n * cap) / total;
      const fl = Math.floor(exact);
      return { s: p.s, n: Math.max(1, fl), rem: exact - fl };
    });
  let used = alloc.reduce((a, x) => a + x.n, 0);
  const byRem = [...alloc].sort((a, b) => b.rem - a.rem);
  for (let i = 0; used < cap && byRem.length; i++, used++) byRem[i % byRem.length].n++;
  while (used > cap) {
    const x = alloc.filter((a) => a.n > 1).sort((a, b) => a.rem - b.rem)[0];
    if (!x) break;
    x.n--;
    used--;
  }
  const cells: DotState[] = [];
  for (const a of alloc) for (let k = 0; k < a.n; k++) cells.push(a.s);
  return cells;
}

// ── 格式化 ───────────────────────────────────────────────────────────────────
export function fmtDur(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTokens(n: number | undefined): string {
  if (!n || !Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return String(Math.round(n));
  const s = n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
  return s.replace(/\.0(?=[kM])/, "");
}

// 运行中 = 现在 - 开始；结束后 = durationMs。拿不到就空串（老会话没有时间戳）。
export function runElapsed(run: { startedAt?: number; durationMs?: number } | undefined, running: boolean, now: number): string {
  if (!run) return "";
  if (running) return run.startedAt ? fmtDur(Math.max(0, now - run.startedAt)) : "";
  return typeof run.durationMs === "number" ? fmtDur(run.durationMs) : "";
}

// 目录 id 可能带厂商前缀路径（accounts/…/models/x），面板里只露最后一段。
export function modelShort(model: unknown): string {
  const s = typeof model === "string" ? model.trim() : "";
  return s ? (s.split("/").pop() ?? s) : "";
}
