// 工作区卡片的排布（纯函数，服务端测试直接 import，不碰 DOM / Svelte）。
//
// 两列的顺序（cols.a / cols.b）是全部工具的一份排列，没开的卡也留在里面——下次开出来还在老位置附近。
// 卡片按比例绝对定位：位置写成 calc(百分比 + 缝)，不量容器尺寸，列数变化时卡片不换父节点。

export type CardTool = "tasks" | "review" | "term" | "browser" | "files" | "memory";
export interface Cols {
  a: CardTool[];
  b: CardTool[];
}
export type Weights = Partial<Record<CardTool, number>>;

export const CARD_TOOLS: readonly CardTool[] = ["tasks", "review", "term", "browser", "files", "memory"];
// 渲染顺序固定：keyed each 不因列数 / 排序变化而重排出新节点（终端、浏览器的连接留着）
export const RENDER_ORDER: readonly CardTool[] = ["term", "review", "tasks", "browser", "files", "memory"];
export const DEFAULT_COLS: Cols = { a: ["term", "review", "tasks"], b: ["browser", "files", "memory"] };
export const GAP = 8;
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

export const sameCols = (p: Cols, q: Cols) => p.a.join() === q.a.join() && p.b.join() === q.b.join();
export const weightOf = (w: Weights, v: CardTool) => w[v] ?? 1;

// v 插进 col 列、排在这一列第 idx 张【看得见的】卡前面
export function place(st: Cols, v: CardTool, col: "a" | "b", idx: number, shown: readonly CardTool[]): Cols {
  const a = st.a.filter((k) => k !== v);
  const b = st.b.filter((k) => k !== v);
  const arr = col === "a" ? a : b;
  const vis = arr.filter((k) => shown.includes(k));
  const at = idx < vis.length ? arr.indexOf(vis[idx]) : vis.length ? arr.indexOf(vis[vis.length - 1]) + 1 : arr.length;
  arr.splice(at, 0, v);
  return { a, b };
}

// 拖动中的预览排布：一律从起手排布推（不在上一帧的预览上叠加），指针回到原处就原样复原。
//   · 起手两列：左半 / 右半定列，纵向按「这一列放进它之后每格多高」定第几格。拖空的那一列留着当落点。
//   · 起手一列：纵向定第几格；够宽、还有别的卡时拖进右侧三成 = 拆成两列、它单独占右列
//     （拆开后退回门槛放宽到右半边，免得在门槛上来回抖）。
// fx / fy = 指针在卡片区里的相对位置（0..1）。
export interface Target {
  n: 1 | 2;
  split: boolean;
  cols: Cols;
}
export function target(
  o: { start: Cols; v: CardTool; n0: 1 | 2; split: boolean; canTwo: boolean; shown: readonly CardTool[] },
  fx: number,
  fy: number,
  allowSplit = true,
): Target {
  const { start: st, v, shown } = o;
  const vis = (arr: CardTool[]) => arr.filter((k) => k !== v && shown.includes(k));
  const ra = vis(st.a);
  const rb = vis(st.b);
  const slot = (count: number) => Math.max(0, Math.min(count, Math.floor(fy * (count + 1))));
  if (o.n0 === 2) {
    const col = fx < 0.5 ? "a" : "b";
    return { n: 2, split: false, cols: place(st, v, col, slot(col === "a" ? ra.length : rb.length), shown) };
  }
  const others = ra.length + rb.length;
  if (allowSplit && o.canTwo && others > 0 && fx > (o.split ? 0.5 : 0.7)) {
    const a = [...st.a.filter((k) => k !== v), ...st.b.filter((k) => k !== v && shown.includes(k))];
    const b = [v, ...st.b.filter((k) => k !== v && !shown.includes(k))];
    return { n: 2, split: true, cols: { a, b } };
  }
  const i = slot(others);
  const toA = i < ra.length || (i === ra.length && (st.a.includes(v) || !rb.length));
  return { n: 1, split: false, cols: toA ? place(st, v, "a", i, shown) : place(st, v, "b", i - ra.length, shown) };
}

// 此刻摆出来的列：两列都有卡且允许两列才分两列，否则 a 再 b 叠成一列
export function columns(cols: Cols, shown: readonly CardTool[], two: boolean): CardTool[][] {
  const a = cols.a.filter((k) => shown.includes(k));
  const b = cols.b.filter((k) => shown.includes(k));
  return two ? [a, b] : [[...a, ...b]];
}

// 第 i 段的起点：(100% - 缝 × (n-1)) × 前面的占比 + 缝 × i
const startCalc = (frac: number, gaps: number, i: number) => `calc((100% - ${GAP * gaps}px) * ${frac.toFixed(6)} + ${GAP * i}px)`;
const sizeCalc = (frac: number, gaps: number) => `calc((100% - ${GAP * gaps}px) * ${frac.toFixed(6)})`;

export interface Slot {
  col: number;
  row: number;
  left: string;
  width: string;
  top: string;
  height: string;
}
// 每张卡的格子。列宽均分；一列里的卡按权重分高度。
export function slots(list: CardTool[][], w: Weights): Partial<Record<CardTool, Slot>> {
  const at: Partial<Record<CardTool, Slot>> = {};
  const nc = list.length;
  list.forEach((col, ci) => {
    const total = col.reduce((s, v) => s + weightOf(w, v), 0) || 1;
    let acc = 0;
    col.forEach((v, ri) => {
      const f = weightOf(w, v) / total;
      at[v] = {
        col: ci,
        row: ri,
        left: startCalc(ci / nc, nc - 1, ci),
        width: sizeCalc(1 / nc, nc - 1),
        top: startCalc(acc / total, col.length - 1, ri),
        height: sizeCalc(f, col.length - 1),
      };
      acc += weightOf(w, v);
    });
  });
  return at;
}
export const boxCss = (s: Pick<Slot, "left" | "width" | "top" | "height">) => `left:${s.left};width:${s.width};top:${s.top};height:${s.height}`;

// 卡与卡之间的分隔条（拖了调这两张的高度比）：落在上一张的下沿那道缝里
export interface Divider {
  key: string;
  up: CardTool;
  down: CardTool;
  css: string;
}
export function dividers(list: CardTool[][], at: Partial<Record<CardTool, Slot>>): Divider[] {
  const out: Divider[] = [];
  for (const col of list) {
    for (let i = 0; i + 1 < col.length; i++) {
      const up = at[col[i]];
      const down = at[col[i + 1]];
      if (!up || !down) continue;
      out.push({ key: `${col[i]}|${col[i + 1]}`, up: col[i], down: col[i + 1], css: `left:${up.left};width:${up.width};top:calc(${down.top} - ${GAP}px);height:${GAP}px` });
    }
  }
  return out;
}

// 拖分隔条：这两张的权重之和不变，按像素位移重新分；各自不低于 minPx。
// avail = 这一列可分的总高（容器高 - 缝），total = 这一列的权重和。
export function resizePair(wUp: number, wDown: number, total: number, avail: number, dy: number, minPx: number): [number, number] {
  const pair = wUp + wDown;
  const pxUp = (wUp / total) * avail;
  const pxPair = (pair / total) * avail;
  const lo = Math.min(minPx, pxPair / 2);
  const next = Math.min(pxPair - lo, Math.max(lo, pxUp + dy));
  const up = (next / avail) * total;
  return [up, pair - up];
}

