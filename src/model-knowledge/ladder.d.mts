// ladder.mjs 的类型声明（src/model-knowledge/exports.test.mjs 核对这里声明的导出名与运行时一致）。

export type LadderTierKey = "top" | "hard" | "normal" | "light";
/** 参与判定的最小形状：智力分、每任务成本，可选推理档位。 */
export interface LadderCell {
  ii: number;
  cost: number;
  effort?: string;
}
export type LadderFloors = Record<LadderTierKey, number>;

export const LADDER_TIER_KEYS: readonly LadderTierKey[];
export const LADDER_FRACS: Readonly<Record<Exclude<LadderTierKey, "top">, number>>;
export const LADDER_TOP_SLACK: number;
/** 默认线：top = 最高分 − 1.5，其余 = 最高分 × frac（一位小数往上取）；候选为空全 0。 */
export function defaultFloors(list: readonly { ii: number }[] | null | undefined): LadderFloors;
/** floors[key] 是有限数就用它，否则 fallback。 */
export function floorOf(floors: Partial<Record<LadderTierKey, number | null>> | null | undefined, key: LadderTierKey, fallback: number): number;
/** 成本最低；同价取智力分低的。 */
export function cheapestCell<T extends LadderCell>(xs: readonly T[] | null | undefined): T | null;
/** 成本最低；同价取智力分高的。 */
export function cheapestAltCell<T extends LadderCell>(xs: readonly T[] | null | undefined): T | null;
/** 智力分最高；同分取便宜的。 */
export function strongestCell<T extends LadderCell>(xs: readonly T[] | null | undefined): T | null;
/** 按判定线取首选；prefer = 优先从满足它的够线候选里挑。谁都够不着 → 最强的、short。 */
export function pickAtFloor<T extends LadderCell>(
  list: readonly T[] | null | undefined,
  floor: number,
  opts?: { prefer?: (c: T) => boolean },
): { pick: T | null; short: boolean; ok: T[] };
/** 档位自定义：同一模型的格子里取同档的，没有就按最接近的官方档借一格（effort 换成指定的、est:true）。 */
export function nearestEffortCell<T extends LadderCell>(same: readonly T[] | null | undefined, effort: string): (T & { est?: boolean }) | null;
