// Small display formatters shared across components.

export const fmtTokens = (n) => (n >= 1000 ? Math.round(n / 100) / 10 + 'k' : String(n || 0));

export function fmtElapsed(ms) {
  const s = Math.floor((ms || 0) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + (s % 60) + 's';
}

export function fmtReset(ms) {
  const d = (ms || 0) - Date.now();
  if (d <= 0) return '已重置';
  const h = Math.floor(d / 3600000);
  if (h >= 24) return Math.floor(h / 24) + 'd';
  if (h >= 1) return h + 'h';
  return Math.max(1, Math.floor(d / 60000)) + 'm';
}

const k = (n) => (n >= 1000 ? Math.round(n / 100) / 10 + 'k' : String(n || 0));
export function fmtCtx(c) {
  if (!c) return '';
  return `${k(c.used || 0)} / ${k(c.total || 0)} (${Math.round(c.pct || 0)}%)`;
}

export function relTime(ms) {
  const d = Date.now() - (ms || 0);
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}
