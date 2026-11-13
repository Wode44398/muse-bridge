// ratings.mjs 的类型声明（src/model-knowledge/exports.test.mjs 核对这里声明的导出名与运行时一致）。

export type RatingLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type SubKey = "tb40" | "lcr" | "mlcr" | "scicode" | "hleD" | "fc2" | "tau3" | "ifbench" | "tau2" | "tbh";
/** 分项（0–100，一位小数）；没有的键省略。 */
export type RatingSubs = Partial<Record<SubKey, number>>;

/** 快照里的一条：一个「模型 × 推理档位」。 */
export interface RatingRow {
  slug: string;
  base: string;
  /** low / medium / high / xhigh / max / off / ""（这个型号只有一种配置） */
  effort: string;
  ii: number;
  cost: number;
  name?: string;
  creator?: string;
  rel?: string;
  dep?: boolean;
  est?: boolean;
  /** 没按现行指数版本重算的旧分：不进 families、不参与排名与中位数 */
  old?: boolean;
  /** 旧分所属的指数版本（如 v4.3.2） */
  ver?: string;
  subs?: RatingSubs;
}

/** 一家厂商的一个订阅 plan（导入的性价比图才有）。 */
export interface PlanPoint {
  /** 老档（停售、只能老用户续费）：算 plan 均价时不算它 */
  legacy: boolean;
  /** 月价（元） */
  price: number;
  /** slug → 每任务成本（元，图表点的中值；分时段的取贵的） */
  costs: Record<string, number>;
}
/** 图表厂商键（vkey，如 kimi / zhipu / tp_opencode）→ plan 显示名 → PlanPoint */
export type PlanPoints = Record<string, Record<string, PlanPoint>>;

export interface RatingsSnapshot {
  version?: number;
  generated?: string;
  /** 现行智力指数版本（如 v5.0） */
  index?: string;
  fx?: number;
  source?: string;
  models: RatingRow[];
  plans?: Record<string, Record<string, number>>;
  planPoints?: PlanPoints;
  /** 导入的性价比图才有：导入时间（毫秒）、来源、图表数据日期、图表点数、文件名 / 地址 */
  imported?: { at: number; from: "file" | "url"; generated: string; points: number; name?: string };
}

export interface RatingsIndex {
  generated: string;
  /** 现行智力指数版本 */
  version: string;
  fx?: number;
  source?: string;
  plans: Record<string, Record<string, number>>;
  /** 快照没带就是 {} */
  planPoints: PlanPoints;
  /** 现行版本的条目 */
  models: RatingRow[];
  /** 旧版条目 */
  old: RatingRow[];
  families: Map<string, RatingRow[]>;
  oldFamilies: Map<string, RatingRow[]>;
}

export interface RatingHit {
  slug: string;
  base: string;
  ii: number;
  /** 这条分数的指数版本：现行条目 = 索引的 version，旧条目 = 它自己的 ver */
  version: string;
  effort: string;
  subs: RatingSubs;
  date: string;
  deprecated: boolean;
  cost: number;
  /** 请求的档位正好有这一档的评分（没给档位 = 取最强那条，算 true；on / auto 也取最强那条但算 false；给了档位但没这一档、退到近邻档，算 false） */
  exact: boolean;
  name: string;
  est?: true;
  old?: true;
  /** 量化 / 本机版本：分数取自官方全精度条目，不是本机实测 */
  derived?: true;
}

export interface RatingStats {
  median: number;
  p25: number;
  p75: number;
  count: number;
}
export interface RatingsSummary extends RatingStats {
  version: string;
  allEfforts: RatingStats;
  bestPerFamily: RatingStats;
}

export const RATING_LEVELS: readonly RatingLevel[];
export const SUB_KEYS: Readonly<Record<SubKey, string>>;
export const ALIASES: Readonly<Record<string, string>>;
/** short 名括号里的档位：(max with fallback) → max；(non-reasoning) → off；认不出 → '' */
export function effortOf(short: unknown): string;
/** slug → 族名：剥档位后缀；-max 只在 slugs 里同族真有别的档位条目时才剥 */
export function baseOf(slug: unknown, slugs?: Iterable<unknown> | null): string;
export function normKey(id: unknown): string;
export function loadRatings(snapshotJson: unknown): RatingsIndex | null;
export function familyOf(index: RatingsIndex | null, id: unknown, label?: unknown): RatingRow[] | null;
export function bestByEffort(fam: RatingRow[] | null | undefined): RatingRow[];
export function strongestOf(fam: RatingRow[] | null | undefined): RatingRow | null;
export function lookupRating(
  index: RatingsIndex | null,
  modelId: unknown,
  opts?: { provider?: string; effort?: string; label?: string; allowOld?: boolean },
): RatingHit | null;
export function ratingsSummary(index: RatingsIndex | null): RatingsSummary;
