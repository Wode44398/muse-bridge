// 记忆面板的可视化口径（K11）：四类、字形、时间轴。纯函数，不碰 DOM（服务端测试直接 import）。
//
// 四类就是面板的图例（统计卡上那四个数）：
//   待确认 = 模型存的、等你拍板（含因注入特征 / 外部内容被扣下的）；
//   被隔离 = 写着「生效」，却因过期、挂靠的文件不在、同主题冲突、缺证据……没进提示——要你修；
//   生效   = 此刻进每个新对话的提示；
//   已退场 = 失效、被替代、驳回（留着可查，不再影响模型）。
// 同一个顺序（先要你处理的，再生效的，最后退场的）贯穿统计卡、点阵、分组列表。
//
// 服务端测试直接 import 本文件：这里不许 import lib/api.ts（连类型也不行——server 的 tsc 会顺着把带 DOM 的 api.ts
// 拉进来检查）。用到的字段就地写成最小结构类型，与 api.ts 的 MemoryMeta / MemoryHistoryWhy 结构兼容。
type Status = "proposed" | "active" | "superseded" | "stale" | "rejected";
export type MemoryHistoryWhy = "overwrite" | "delete" | "retire" | "superseded" | "reject" | "restore";

export type Lane = "proposed" | "held" | "active" | "retired";
export const LANES: readonly Lane[] = ["proposed", "held", "active", "retired"];
export const LANE_TEXT: Record<Lane, { label: string; hint: string; empty: string }> = {
  proposed: { label: "待确认", hint: "等你确认才生效", empty: "没有等你确认的记忆" },
  held: { label: "被隔离", hint: "写着生效，却没进提示", empty: "没有被隔离的记忆" },
  active: { label: "生效", hint: "进每个新对话的提示", empty: "还没有生效的记忆" },
  retired: { label: "已退场", hint: "失效、被替代、驳回", empty: "没有退场的记忆" },
};

type Statusy = { status: Status; declaredStatus: Status };

// 与 memory-text.ts 的 groupOf 同一口径：写成 active、但因为注入特征 / 外部内容会话被扣成待确认的，也在等你拍板
export function laneOf(m: Statusy): Lane {
  if (m.status === "rejected" || m.declaredStatus === "rejected") return "retired";
  if (m.declaredStatus === "proposed" || m.status === "proposed") return "proposed";
  if (m.status === "active") return "active";
  if (m.declaredStatus === "active") return "held";
  return "retired";
}

// 字形：四类各一种，已退场再按怎么退的分三种（实心小点 = 失效 · 空心小圈 = 被替代 · 叉 = 驳回）。
// 颜色只是第二道编码——同色的两类形状一定不同（色觉差异、打印、强制高对比下照样分得开）。
export type Glyph = "proposed" | "held" | "active" | "stale" | "superseded" | "rejected";
export function glyphOf(m: Statusy): Glyph {
  const lane = laneOf(m);
  if (lane !== "retired") return lane;
  if (m.status === "rejected" || m.declaredStatus === "rejected") return "rejected";
  if (m.status === "superseded" || m.declaredStatus === "superseded") return "superseded";
  return "stale";
}
export const LANE_GLYPH: Record<Lane, Glyph> = { proposed: "proposed", held: "held", active: "active", retired: "stale" };
export const GLYPH_TEXT: Record<Glyph, string> = {
  proposed: "待确认",
  held: "被隔离",
  active: "生效中",
  stale: "已失效",
  superseded: "已被替代",
  rejected: "已驳回",
};

export function countLanes(items: Statusy[]): Record<Lane, number> {
  const out: Record<Lane, number> = { proposed: 0, held: 0, active: 0, retired: 0 };
  for (const m of items) out[laneOf(m)]++;
  return out;
}

// 点阵 / 列表里的先后：先按四类，同类里新的在前
export function byLane<T extends Statusy & { updated?: string }>(items: T[]): T[] {
  const rank = (m: T) => LANES.indexOf(laneOf(m));
  return [...items].sort((a, b) => rank(a) - rank(b) || (b.updated ?? "").localeCompare(a.updated ?? ""));
}

export const HISTORY_TEXT: Record<MemoryHistoryWhy, string> = {
  overwrite: "改写",
  delete: "删除",
  retire: "退场",
  superseded: "被替代",
  reject: "驳回",
  restore: "撤销驳回",
};

// ── 时间轴 ─────────────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
export interface Span {
  t0: number;
  t1: number;
}
const ms = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

// 一条记忆的一生：最早能证明它存在的时刻（最早一份旧版、或当前版本）→ 当前版本；中间每一份旧版是一个事件
export interface Life {
  start: number;
  end: number;
  events: Array<{ t: number; why: MemoryHistoryWhy }>;
}
export function lifeOf(m: { id: string; updated?: string }, history: Array<{ id: string; at: string; why: MemoryHistoryWhy }>): Life {
  const events = history
    .filter((e) => e.id === m.id)
    .map((e) => ({ t: ms(e.at), why: e.why }))
    .filter((e) => Number.isFinite(e.t));
  const end = ms(m.updated);
  const times = [...events.map((e) => e.t), ...(Number.isFinite(end) ? [end] : [])];
  const start = times.length ? Math.min(...times) : NaN;
  return { start, end: Number.isFinite(end) ? end : start, events };
}

// 轴的范围：最早的一生起点 → 现在；太短（不到两周）就撑到两周，左边留一点呼吸
export function spanOf(lives: Life[], now: number): Span {
  const starts = lives.map((l) => l.start).filter(Number.isFinite);
  let t0 = starts.length ? Math.min(...starts) : now - 14 * DAY;
  const t1 = Math.max(now, ...lives.map((l) => l.end).filter(Number.isFinite));
  if (t1 - t0 < 14 * DAY) t0 = t1 - 14 * DAY;
  t0 -= (t1 - t0) * 0.04;
  return { t0, t1 };
}
export const xOf = (t: number, s: Span): number => (s.t1 > s.t0 ? Math.max(0, Math.min(1, (t - s.t0) / (s.t1 - s.t0))) : 1);

// 刻度：按跨度挑步长（日 / 周 / 月），对齐到本地的零点或月初；最多 max 个
export function ticksOf(s: Span, max = 5): Array<{ t: number; label: string }> {
  const span = s.t1 - s.t0;
  const dayStep = [1, 2, 3, 7, 14].find((d) => span / (d * DAY) <= max);
  const out: Array<{ t: number; label: string }> = [];
  if (dayStep) {
    const d = new Date(s.t0);
    d.setHours(0, 0, 0, 0);
    if (dayStep === 7 || dayStep === 14) d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 周一
    while (d.getTime() < s.t0) d.setDate(d.getDate() + dayStep);
    for (; d.getTime() <= s.t1; d.setDate(d.getDate() + dayStep)) out.push({ t: d.getTime(), label: `${d.getMonth() + 1}/${d.getDate()}` });
    return out;
  }
  const months = span / (30.44 * DAY);
  const step = [1, 2, 3, 6, 12].find((m) => months / m <= max) ?? 12;
  const d = new Date(s.t0);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  while (d.getTime() < s.t0 || d.getMonth() % step) d.setMonth(d.getMonth() + 1);
  const multiYear = new Date(s.t0).getFullYear() !== new Date(s.t1).getFullYear();
  for (; d.getTime() <= s.t1; d.setMonth(d.getMonth() + step)) {
    out.push({ t: d.getTime(), label: multiYear && d.getMonth() === 0 ? String(d.getFullYear()) : `${d.getMonth() + 1}月` });
  }
  return out;
}

// ── 文案里的数与时间 ──────────────────────────────────────────────────────────────
export const fmtCount = (n: number): string => n.toLocaleString("en-US");

export function fmtShortDate(iso?: string, now = Date.now()): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

export function fmtAgo(iso?: string, now = Date.now()): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((now - t) / DAY);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 14) return `${days} 天前`;
  if (days < 60) return `${Math.round(days / 7)} 周前`;
  if (days < 365) return `${Math.round(days / 30.44)} 个月前`;
  return fmtShortDate(iso, now);
}

// 最近一次动过（条目本身或它的旧版）的时间：点阵行的「最近」
export function latestOf(items: Array<{ updated?: string }>, history: Array<{ at: string }> = []): string | undefined {
  let best = "";
  for (const m of items) if (m.updated && m.updated > best) best = m.updated;
  for (const e of history) if (e.at > best) best = e.at;
  return best || undefined;
}
