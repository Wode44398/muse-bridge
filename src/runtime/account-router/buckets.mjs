// 额度桶与模型家族：哪个桶管哪个模型。号池路由的几种策略共用。
//
// 5 小时、每周两个桶所有模型共用；其余是某个家族独占的：seven_day_overage_included 是 Fable 周限额（不是「含超额」，
// 见 status.mjs 桶名注释），seven_day_opus / seven_day_sonnet 是老式按家族的周限额，model_<名> 是 SDK usage 给的按模型周桶。

import { CLAUDE_MODEL_DEFAULT } from '../../config/capabilities.mjs';

export const FAMILIES = Object.freeze(['fable', 'opus', 'sonnet', 'haiku']);
export const SHARED_BUCKETS = Object.freeze(['five_hour', 'seven_day']);
// 各家族独占的桶（model_<名> 另按 label 认）。
export const DEDICATED = Object.freeze({ fable: 'seven_day_overage_included', opus: 'seven_day_opus', sonnet: 'seven_day_sonnet' });

/** 模型名 → 家族（'fable' | 'opus' | 'sonnet' | 'haiku' | 'other'）。空 = 默认模型。 */
export function familyOf(model) {
  const m = String(model || CLAUDE_MODEL_DEFAULT).toLowerCase();
  for (const f of FAMILIES) if (m.includes(f)) return f;
  return 'other';
}

/** 这个桶管不管这个模型（model 也可以直接传家族名）。overage（extra usage 信用）等不决定号能不能用。 */
export function relevantBucket(k, b, model) {
  const m = String(model || CLAUDE_MODEL_DEFAULT).toLowerCase();
  if (k === 'five_hour' || k === 'seven_day') return true;
  if (k === 'seven_day_opus') return m.includes('opus');
  if (k === 'seven_day_sonnet') return m.includes('sonnet');
  if (k === 'seven_day_overage_included') return m.includes('fable');
  if (k.startsWith('model_')) return !!(b && b.label && m.includes(String(b.label).toLowerCase()));
  return false;
}

export const isShared = (k) => k === 'five_hour' || k === 'seven_day';
