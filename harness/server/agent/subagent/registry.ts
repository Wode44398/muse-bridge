// 子 agent 台账（按父会话 id 分）：Agent 工具起的每一个子 agent（前台、后台）都记在这里，跑完了也留着它的上下文，好让父 agent
// 追加一条消息接着用。工作流里的 agent() 不记（它们由工作流自己的日志管）。只在内存里：服务重启后台账是空的，接不上的如实说。
// 留多少：每个会话最近结束的 MAX_KEPT 个（更早的连上下文一起丢掉）；同时在后台跑的不超过 MAX_BACKGROUND 个，超了明说。
// 会话被停、被删、服务退出时由会话层调这里的出口：停掉在跑的后台子 agent，并记下是谁停的。
import type { SubAgentTier } from "../events.ts";
import type { SubAgentResult } from "../../tools/types.ts";

export const MAX_BACKGROUND = 4;
export const MAX_KEPT = 10;

export type AgentStatus = "running" | "completed" | "failed" | "stopped";
// 被谁停的：model = 父 agent 自己用 Agent(action:"stop")；user = 用户停了会话；deleted = 会话被删；restart = 服务退出
export type StopCause = "model" | "user" | "deleted" | "restart";

export interface AgentRecord {
  id: string;
  owner: string;
  label: string;
  type: string; // 显示用：research / coder / 自定义类型名 / fork
  tier: SubAgentTier;
  background: boolean; // 这一次（最近一次）是不是后台跑的
  status: AgentStatus;
  startedAt: number;
  endedAt?: number;
  runs: number;
  ctrl: AbortController | null; // 这一次运行的中止口（没在跑 = null）
  closing?: boolean; // 这一次运行已经跑完最后一步、在收尾（worktree、交报告）：不再读追加的话
  done: Promise<SubAgentResult> | null;
  stoppedBy?: StopCause;
  result?: SubAgentResult;
  // 接着用要的东西（subagent.ts 的 Child）；还在准备（选型、建 worktree）时没有
  child?: unknown;
  // 有待送进去的消息（还在准备时收到的）
  inbox: string[];
}

const books = new Map<string, Map<string, AgentRecord>>();

function book(owner: string): Map<string, AgentRecord> {
  let b = books.get(owner);
  if (!b) books.set(owner, (b = new Map()));
  return b;
}

export function registerAgent(rec: AgentRecord): void {
  book(rec.owner).set(rec.id, rec);
}

export function getAgent(owner: string, id: string): AgentRecord | undefined {
  const b = books.get(owner);
  if (!b) return undefined;
  return b.get(id) ?? [...b.values()].find((r) => r.id.toLowerCase() === id.trim().toLowerCase());
}

// 没起来的（类型 / 选型出错）不留在台账里：没有上下文可接着用
export function dropAgent(owner: string, id: string): void {
  books.get(owner)?.delete(id);
}

export function agentIdTaken(owner: string, id: string): boolean {
  return Boolean(books.get(owner)?.has(id));
}

export function listAgents(owner: string): AgentRecord[] {
  return [...(books.get(owner)?.values() ?? [])].sort((a, b) => a.startedAt - b.startedAt);
}

export function runningBackground(owner: string): number {
  return listAgents(owner).filter((r) => r.status === "running" && r.background).length;
}

export function hasRunningAgents(owner: string): boolean {
  return listAgents(owner).some((r) => r.status === "running" && r.background);
}

/** 一次运行结束：记下结局，按上限丢掉最早结束的那些（连同上下文）。 */
export function settleAgent(rec: AgentRecord, result: SubAgentResult): void {
  rec.result = result;
  rec.endedAt = Date.now();
  rec.ctrl = null;
  rec.done = null;
  rec.status = rec.stoppedBy ? "stopped" : result.ok ? "completed" : "failed";
  const b = books.get(rec.owner);
  if (!b) return;
  const finished = [...b.values()].filter((r) => r.status !== "running").sort((a, c) => (c.endedAt ?? 0) - (a.endedAt ?? 0));
  for (const old of finished.slice(MAX_KEPT)) b.delete(old.id);
}

/** 停一个在跑的子 agent（返回 false = 它没在跑）。 */
export function stopAgent(rec: AgentRecord, cause: StopCause): boolean {
  if (rec.status !== "running" || !rec.ctrl) return false;
  rec.stoppedBy = cause;
  rec.ctrl.abort(cause);
  return true;
}

/** 会话被停 / 被删：停掉它在后台跑的子 agent，返回停了几个。前台的随这一轮的中止一起停。 */
export function stopOwnerAgents(owner: string, cause: StopCause): number {
  let n = 0;
  for (const rec of listAgents(owner)) if (rec.background && stopAgent(rec, cause)) n++;
  return n;
}

/** 会话被删 / 被逐出内存：台账一并忘掉（还在收尾的子 agent 结束时照常落定，只是没人再查得到它）。 */
export function forgetOwner(owner: string): void {
  books.delete(owner);
}

/** 有没有哪个会话的后台子 agent 在跑（回滚这类要求工作区上没人在动的操作看它）。 */
export function anyBackgroundRunning(): boolean {
  for (const owner of books.keys()) if (hasRunningAgents(owner)) return true;
  return false;
}

/** 服务退出：停掉所有在后台跑的子 agent，等它们收尾（有上限）。 */
export async function drainAgents(waitMs: number): Promise<number> {
  const live: Promise<unknown>[] = [];
  for (const owner of [...books.keys()]) {
    for (const rec of listAgents(owner)) {
      if (rec.background && rec.done && stopAgent(rec, "restart")) live.push(rec.done.catch(() => undefined));
    }
  }
  if (!live.length) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(live),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
  return live.length;
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
};

/** 一行一个：id、状态、类型、标签（Agent(action:"list") 与压缩回填共用）。 */
export function describeAgent(rec: AgentRecord, now = Date.now()): string {
  const state = rec.status === "running"
    ? `running ${ago(now - rec.startedAt)}${rec.background ? ", background" : ""}`
    : `${rec.status}${rec.stoppedBy ? ` by ${rec.stoppedBy === "model" ? "you" : rec.stoppedBy === "restart" ? "a server restart" : "the user"}` : ""} ${ago((rec.endedAt ?? now) - rec.startedAt)}`;
  return `- ${rec.id} [${state}] ${rec.type}: ${rec.label}`;
}

/** 压缩回填用：此刻还在后台跑的（没有 = ""）。 */
export function runningAgentsSummary(owner: string): string {
  return listAgents(owner)
    .filter((r) => r.status === "running" && r.background)
    .map((r) => describeAgent(r))
    .join("\n");
}

// 测试用：清掉模块状态
export function _resetAgentRegistry(): void {
  books.clear();
}
