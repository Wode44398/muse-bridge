// O8（N39）：用量账本——会话 × 厂商 × 型号 × 任务。
//
// 以前会话只记主循环那一份（totals）：子 agent、工作流里的 agent、压缩摘要的用量都不并入——一个开了几十个 agent 的工作流
// 实际烧了多少、压缩一次花了多少，界面上看不到。现在每次模型请求的用量连同厂商 / 型号 / 任务记一笔，按这三样聚合，随会话
// 落盘（记录里的可选字段 usage），上下文弹层里分项显示。主循环的 totals 照旧（它的含义是「主对话的上下文与用量」）。
// 暂不含：识图辅助、嵌入（走各自的通道，拿不到逐次用量时不硬凑）。

// memory（瘦身 P0-1）：run 之后的记忆沉淀那次旁路请求
export type UsageTask = "main" | "subagent" | "workflow" | "compaction" | "memory";

export interface UsageDelta {
  provider: string;
  model: string;
  task: UsageTask;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageRow extends UsageDelta {
  calls: number;
}

// 键 = 厂商|型号|任务
export type UsageLedger = Record<string, UsageRow>;

const TASK_ORDER: Record<UsageTask, number> = { main: 0, subagent: 1, workflow: 2, compaction: 3, memory: 4 };
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export function addUsage(ledger: UsageLedger, d: UsageDelta): void {
  const key = `${d.provider}|${d.model}|${d.task}`;
  const row = (ledger[key] ??= { provider: d.provider, model: d.model, task: d.task, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
  row.input += num(d.input);
  row.output += num(d.output);
  row.cacheRead += num(d.cacheRead);
  row.cacheWrite += num(d.cacheWrite);
  row.calls += 1;
}

// 给界面：按任务（主对话 → 子 agent → 工作流 → 压缩）、同任务按输入量从大到小
export function ledgerRows(ledger: UsageLedger | undefined): UsageRow[] {
  return Object.values(ledger ?? {}).sort((a, b) => TASK_ORDER[a.task] - TASK_ORDER[b.task] || b.input - a.input);
}

// 读回来的账本只认形状对的行（旧记录没有这个字段；手改坏了的行丢掉，不让它弄坏整份记录）
export function sanitizeLedger(raw: unknown): UsageLedger {
  const out: UsageLedger = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = v as Partial<UsageRow> | null;
    if (!r || typeof r.provider !== "string" || typeof r.model !== "string" || !(r.task && r.task in TASK_ORDER)) continue;
    out[key] = { provider: r.provider, model: r.model, task: r.task as UsageTask, input: num(r.input), output: num(r.output), cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite), calls: num(r.calls) };
  }
  return out;
}
