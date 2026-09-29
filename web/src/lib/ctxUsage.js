// 上下文用量面板的纯函数（官方 claude.ai/code 同款逻辑，2026-09-01 逆向桌面包
// shared-10-3 / ce96f5751 / c094b416e 所得）：紧凑数字、状态档、图例/计量条组装。
import { t, tc, isEn, locale } from './i18n.js';

// 官方 Vx：≥1e6 → "1M" / "1.5M"（去掉 .0），≥1e3 → "38.4k"，否则原样。
export function fmtCompact(n) {
  n = Number(n) || 0;
  const strip = (s) => (s.endsWith('.0') ? s.slice(0, -2) : s);
  if (n >= 1e9) return strip((n / 1e9).toFixed(1)) + 'B';
  if (n >= 1e6) { const v = Number((n / 1e6).toFixed(1)); return v >= 1e3 ? strip((n / 1e9).toFixed(1)) + 'B' : strip(v.toFixed(1)) + 'M'; }
  if (n >= 1e3) { const v = Number((n / 1e3).toFixed(1)); return v >= 1e3 ? strip((n / 1e6).toFixed(1)) + 'M' : strip(v.toFixed(1)) + 'k'; }
  return String(n);
}

// 官方 Wx：≥90 critical / ≥75 warning / 其余 normal（环、进度条同一套阈值）。
export const ctxLevel = (pct) => (pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : 'normal');

// 官方 tI：`38.4k / 1M (4%)`；没有上限（或超限）时只给用量数字。
export function ctxSummary(total, max) {
  total = Number(total) || 0; max = Number(max) || 0;
  if (!max || total > max) return { summary: fmtCompact(total), pct: max ? 100 : null };
  const pct = Math.round(100 * Math.max(0, Math.min(1, total / max)));
  return { summary: `${fmtCompact(total)} / ${fmtCompact(max)} (${pct}%)`, pct };
}

// 官方额度行的重置文案：24 小时内 → "Resets in 4 hr 49 min"，更远 → "Resets Wed 2:00 AM"。
// 中文同构：「4 小时 49 分后重置」/「周三 02:00 重置」；已过期 → 「已重置」。
export function fmtResetAt(ms) {
  ms = Number(ms) || 0;
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return tc('claude', '已重置');   // 英文单写 Reset 像按钮，额度行用 Has reset
  if (d < 86_400_000) {
    const h = Math.floor(d / 3_600_000), m = Math.floor((d % 3_600_000) / 60_000);
    if (!h) return t('{m} 分后重置', { m: Math.max(1, m) });
    return m ? t('{h} 小时 {m} 分后重置', { h, m }) : t('{h} 小时 后重置', { h });
  }
  const dt = new Date(ms);
  // 英文走 Intl（Resets Wed 2:00 AM）；中文维持「周三 02:00」原样
  const day = isEn() ? new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(dt) : '日一二三四五六'[dt.getDay()];   // i18n-ignore 中文星期字表
  const time = isEn()
    ? new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(dt)
    : String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
  return t('周{day} {time} 重置', { day, time });
}

const isFree = (c) => c.kind === 'free';
const isBuffer = (c) => c.kind === 'buffer';
const isDeferred = (c) => c.kind === 'deferred';

// 官方 ce96f5751 的组装规则：
// - used 类别按 tokens 降序；连同 buffer 超过 6 行时只给前 5-m 个各自配色，其余折进「Other」
//   一段（图例里每行仍单列，只是 swatch 用 reference 灰）；
// - deferred（窗口外的延迟加载工具）只进图例不进计量条，百分比显示「—」；
// - free 兜底一行（reference tint）；计量条总长 = max(窗口, 各段之和)，free 段就是底色。
export function prepareBreakdown(usage) {
  const cats = Array.isArray(usage?.categories) ? usage.categories : [];
  const max = Number(usage?.max) || 0;
  const used = cats.filter((c) => !isFree(c) && !isBuffer(c) && !isDeferred(c)).slice().sort((a, b) => b.tokens - a.tokens);
  const deferred = cats.filter(isDeferred).slice().sort((a, b) => b.tokens - a.tokens);
  const buffer = cats.find(isBuffer) || null;
  const free = cats.find(isFree) || null;
  // 官方 w()：有 free 行时已用 = 非 free、非 deferred 之和（含 buffer）；否则用自报 total。
  const usedTokens = free ? cats.filter((c) => !isFree(c) && !isDeferred(c)).reduce((a, c) => a + c.tokens, 0) : (Number(usage?.total) || 0);
  const usedPct = max > 0 ? usedTokens / max * 100 : (Number(usage?.pct) || 0);
  const m = buffer ? 1 : 0;
  const overflow = used.length + m > 6;
  const cut = overflow ? 5 - m : used.length;
  const colorOf = (i) => (i < cut ? (i < 8 ? `var(--cx-${i + 1})` : 'var(--cx-muted)') : 'var(--cx-ref)');
  const pctOf = (tk) => (max > 0 ? tk / max * 100 : 0);
  const legend = [
    ...used.map((c, i) => ({ id: 'used-' + i, name: c.name, tokens: c.tokens, pct: pctOf(c.tokens), color: colorOf(i), deferred: false })),
    ...(buffer ? [{ id: 'buffer', name: buffer.name, tokens: buffer.tokens, pct: pctOf(buffer.tokens), color: 'var(--cx-muted)', deferred: false }] : []),
    ...(free ? [{ id: 'free', name: free.name, tokens: free.tokens, pct: pctOf(free.tokens), color: 'var(--cx-ref-tint)', deferred: false }] : []),
    ...deferred.map((c, i) => ({ id: 'deferred-' + i, name: c.name, tokens: c.tokens, pct: 0, color: 'var(--cx-muted)', deferred: true })),
  ];
  const meter = [
    ...used.slice(0, cut).map((c, i) => ({ id: 'used-' + i, tokens: c.tokens, color: colorOf(i) })),
    ...(overflow ? [{ id: 'other', tokens: used.slice(cut).reduce((a, c) => a + c.tokens, 0), color: 'var(--cx-ref)' }] : []),
    ...(buffer ? [{ id: 'buffer', tokens: buffer.tokens, color: 'var(--cx-muted)' }] : []),
  ].filter((s) => s.tokens > 0);
  const barTotal = Math.max(max, [...used, ...(buffer ? [buffer] : []), ...(free ? [free] : [])].reduce((a, c) => a + c.tokens, 0)) || 1;
  // 计量条分段：官方 StackedMeter——段间 1px 缝、首段起点/末段终点圆到底、内侧 1px 小圆角；
  // 累计份额太小画不出来的段并进前一段（不出现 0 宽碎片）。
  const segments = [];
  let start = 0;
  for (const s of meter) {
    const width = s.tokens / barTotal * 100;
    segments.push({ ...s, start, width });
    start += width;
  }
  return { legend, meter, segments, barTotal, usedTokens, usedPct: Math.min(100, Math.round(usedPct)) };
}
