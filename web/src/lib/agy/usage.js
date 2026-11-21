// agy 开口仪表与用量面板的取数小工具：上下文占比、最吃紧的额度桶、token 与重置时间的显示格式。
// 额度数据形态（服务端 /api/agy/quota 规整后）：{ buckets: [{ id, group, window, usedPct, resetAt }], at, error }
//   group = 'Gemini' / 'Claude / GPT'（agy 按模型分组，组内共用一个周限和一个 5 小时限）；window = 'weekly' / '5h'。
//   usedPct = 已用百分比 0–100；resetAt = 重置时刻（毫秒时间戳，可无）。

import { t } from '../i18n.js';

export function agyContextPct(u) {
  if (!u || !u.size) return null;
  return Math.min(100, Math.max(0, Math.round((Number(u.used) / Number(u.size)) * 100)));
}

export function bucketLabel(b) {
  const w = b.window === '5h' ? t('5 小时') : b.window === 'weekly' ? t('每周') : String(b.window || '');
  return [b.group, w].filter(Boolean).join(' · ');
}

// 组内按「5 小时 → 每周」排，组按服务端顺序（Gemini 在前）
export function quotaBuckets(q) {
  const list = Array.isArray(q?.buckets) ? q.buckets.filter((b) => b && Number.isFinite(Number(b.usedPct))) : [];
  const rank = (b) => (b.window === '5h' ? 0 : b.window === 'weekly' ? 1 : 2);
  const groups = [...new Set(list.map((b) => b.group))];
  return list
    .map((b) => ({ ...b, label: bucketLabel(b) }))
    .sort((a, b) => (groups.indexOf(a.group) - groups.indexOf(b.group)) || (rank(a) - rank(b)));
}

// 最吃紧 = 已用比例最高的那一桶；并列时先重置的排后（更晚重置的更「卡」）。
export function tightestQuota(q) {
  const list = quotaBuckets(q);
  if (!list.length) return null;
  return list.slice().sort((a, b) => (b.usedPct - a.usedPct) || ((b.resetAt || 0) - (a.resetAt || 0)))[0];
}

// 仪表要画的那一组：最吃紧那一桶所在的模型分组，取它的周限（环的填充段）与 5 小时限（指示点）。
export function gaugeQuota(q) {
  const tight = tightestQuota(q);
  if (!tight) return null;
  const inGroup = quotaBuckets(q).filter((b) => b.group === tight.group);
  return {
    group: tight.group,
    weekly: inGroup.find((b) => b.window === 'weekly') || null,
    fiveH: inGroup.find((b) => b.window === '5h') || null,
  };
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return Math.round(v / 1_000) + 'k';
  return String(v);
}

// 「3 小时 12 分后重置」/「2 天后重置」/「即将重置」
export function fmtResetIn(at, now = Date.now()) {
  const ms = Number(at) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 60_000) return t('即将重置');
  const m = Math.round(ms / 60_000);
  if (m < 60) return t('{n} 分钟后重置', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) {
    const mm = m % 60;
    return mm ? t('{h} 小时 {m} 分后重置', { h, m: mm }) : t('{h} 小时后重置', { h });
  }
  const d = Math.round(h / 24);
  return t('{n} 天后重置', { n: d });
}

export function usageLevel(pct) {
  if (pct == null) return '';
  return pct >= 90 ? 'err' : pct >= 75 ? 'warn' : '';
}
