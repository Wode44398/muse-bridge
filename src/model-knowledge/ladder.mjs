// 子 agent 四档的判定线与取舍（2026-11-14 抽出）：bridge 的 Claude 阶梯（src/runtime/model-ratings.mjs）和 dimensio 的阶梯
// （harness/server/agent/dispatch-ladder.ts）共用这一份，免得「子 agent 调用策略」的口径在两边分叉（先例：ratings.mjs 的归一与别名）。
// 纯函数、无依赖、不读盘：候选格子由调用方按各自的口径算好传进来，这里只认 { ii, cost, effort? }。
//
// 规则（设置 › 子 agent 调用策略 的图谱口径）：
//   · 每档一条绝对智力分判定线 floor；没调过的用默认线 defaultFloors——top = 候选里最高分 − 1.5，其余 = 最高分 × frac，一位小数往上取；
//   · 这一档的首选 = 智力分 ≥ floor 的候选里成本最低的，同价取智力分低的（更贴近判定线：够用就行，把更强的留给更高一档）；
//   · 谁都够不着 → 取最强的（同分取便宜的），标 short；
//   · 档位自定义（手动指定 模型 + 推理强度）压过图谱：模型对上了、档位没有对应格子时，按最接近的档借一格（nearestEffortCell）。

export const LADDER_TIER_KEYS = Object.freeze(['top', 'hard', 'normal', 'light']);
/** 默认线占「候选里最高智力分」的比例（top 档不按比例：最高分 − LADDER_TOP_SLACK）。 */
export const LADDER_FRACS = Object.freeze({ hard: 0.88, normal: 0.6, light: 0.4 });
export const LADDER_TOP_SLACK = 1.5;

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
// 判定线保留一位小数：往上取（智力分本身是一位小数，上取后「≥ 线」的结果和不取整完全一样）
const ceil1 = (x) => Math.ceil(x * 10 - 1e-6) / 10;

/** 默认线：{ top, hard, normal, light }；候选为空 → 全 0。 */
export function defaultFloors(list) {
  const top = list && list.length ? Math.max(...list.map((c) => c.ii)) : 0;
  const out = {};
  for (const k of LADDER_TIER_KEYS) out[k] = Math.max(0, ceil1(k === 'top' ? top - LADDER_TOP_SLACK : top * LADDER_FRACS[k]));
  return out;
}

/** 这一档实际用的线：floors[key] 是有限数就用它，否则用 fallback（默认线）。 */
export function floorOf(floors, key, fallback) {
  const v = floors && typeof floors === 'object' ? floors[key] : null;
  return fin(v) ? v : fallback;
}

/** 首选口径的「最便宜」：成本最低；同价取智力分低的。空 → null。 */
export function cheapestCell(xs) {
  return (xs || []).reduce((a, b) => (!a || b.cost < a.cost || (b.cost === a.cost && b.ii < a.ii) ? b : a), null);
}
/** 备选口径的「最便宜」：成本最低；同价取智力分高的（备选是首选出问题时顶上的，同价要更稳的那个）。空 → null。 */
export function cheapestAltCell(xs) {
  return (xs || []).reduce((a, b) => (!a || b.cost < a.cost || (b.cost === a.cost && b.ii > a.ii) ? b : a), null);
}
/** 最强：智力分最高；同分取便宜的。空 → null。 */
export function strongestCell(xs) {
  return (xs || []).reduce((a, b) => (!a || b.ii > a.ii || (b.ii === a.ii && b.cost < a.cost) ? b : a), null);
}

/**
 * 按一条判定线取首选 → { pick, short, ok }。
 *   ok      智力分 ≥ floor 的候选
 *   prefer  可选：优先从 ok 里满足它的那些挑（dimensio 用它把本机模型压到「没有云端够得着时才当首选」）；一个都没有再从全部 ok 挑
 * 谁都够不着 → 全部候选里最强的，short:true。候选为空 → pick null。
 */
export function pickAtFloor(list, floor, { prefer } = {}) {
  const all = list || [];
  const ok = all.filter((c) => c.ii >= floor);
  const pool = typeof prefer === 'function' ? ok.filter(prefer) : ok;
  const pick = cheapestCell(pool.length ? pool : ok);
  if (pick) return { pick, short: false, ok };
  return { pick: strongestCell(all), short: all.length > 0, ok };
}

/**
 * 档位自定义落到格子：same = 同一个模型的全部候选格子，effort = 用户指定的档（'' = 不指定）。
 * 有同档的格子 → 它；没有 → 按最接近的官方档借一格（ii / cost 借那一档，effort 换成指定的、标 est）；
 * 不指定按 high 估（Claude 与多数厂商的默认档），minimal 按 low 估；指定的不是官方五档、或这个模型没有分档的格子 → 借最强的那格。
 * same 为空 → null。
 */
export function nearestEffortCell(same, effort) {
  const cells = same || [];
  if (!cells.length) return null;
  const e = String(effort || '');
  const exact = cells.find((c) => c.effort === e);
  if (exact) return exact;
  const want = LEVELS.indexOf(e === '' ? 'high' : e === 'minimal' ? 'low' : e);
  const ranked = cells.filter((c) => LEVELS.includes(c.effort));
  let near;
  if (want < 0 || !ranked.length) near = strongestCell(cells);
  else {
    const d = (c) => Math.abs(LEVELS.indexOf(c.effort) - want);
    near = ranked.reduce((a, b) => (d(b) < d(a) || (d(b) === d(a) && b.ii > a.ii) ? b : a));
  }
  return { ...near, effort: e, est: true };
}
