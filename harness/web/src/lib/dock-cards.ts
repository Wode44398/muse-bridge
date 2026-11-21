// 工作区卡片状态的规整（纯函数，服务端测试直接 import，不碰 DOM / Svelte）：存在本机的「开着哪几张、两列顺序、高度比」
// 读回来时去重、去掉不认识的。卡片怎么摆、怎么拖由宿主的统一外壳管（bridge 的 lib/dock/cards.js）。
//
// 两列的顺序（cols.a / cols.b）是全部工具的一份排列，没开的卡也留在里面——下次开出来还在老位置附近。

export type CardTool = "tasks" | "review" | "term" | "browser" | "files" | "memory";
export interface Cols {
  a: CardTool[];
  b: CardTool[];
}
export type Weights = Partial<Record<CardTool, number>>;

export const CARD_TOOLS: readonly CardTool[] = ["tasks", "review", "term", "browser", "files", "memory"];
export const DEFAULT_COLS: Cols = { a: ["term", "review", "tasks"], b: ["browser", "files", "memory"] };
// 权重的上下限：拖分隔条时按像素钳最小高度，这里只防存坏的值
const W_MIN = 0.15;
const W_MAX = 8;

export const isTool = (v: unknown): v is CardTool => typeof v === "string" && (CARD_TOOLS as readonly string[]).includes(v);

// 去重、去掉不认识的，缺的按默认列补在末尾
export function normCols(c: unknown): Cols {
  const src = (c && typeof c === "object" ? c : {}) as { a?: unknown; b?: unknown };
  const seen = new Set<CardTool>();
  const take = (arr: unknown): CardTool[] =>
    (Array.isArray(arr) ? arr : []).filter((v): v is CardTool => {
      if (!isTool(v) || seen.has(v)) return false;
      seen.add(v);
      return true;
    });
  const a = take(src.a);
  const b = take(src.b);
  for (const v of DEFAULT_COLS.a) if (!seen.has(v)) a.push(v);
  for (const v of DEFAULT_COLS.b) if (!seen.has(v)) b.push(v);
  return { a, b };
}

export function normOpen(v: unknown): CardTool[] {
  const out: CardTool[] = [];
  for (const x of Array.isArray(v) ? v : []) if (isTool(x) && !out.includes(x)) out.push(x);
  return out;
}

export function normWeights(v: unknown): Weights {
  const out: Weights = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (isTool(k) && typeof n === "number" && Number.isFinite(n)) out[k] = Math.min(W_MAX, Math.max(W_MIN, n));
  }
  return out;
}
