// Small display formatters shared across components.
import { t, isEn, locale } from './i18n.js';

export const fmtTokens = (n) => (n >= 1000 ? Math.round(n / 100) / 10 + 'k' : String(n || 0));

export function fmtElapsed(ms) {
  const s = Math.floor((ms || 0) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + (s % 60) + 's';
}

export function fmtReset(ms) {
  const d = (ms || 0) - Date.now();
  if (d <= 0) return t('已重置');
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

// 相对时间。英文走 GLOSSARY §1.9 紧凑式（5m ago / 3h ago / Yesterday / 4d ago），满 7 天改写日期
// （Sep 28 / Sep 28, 2025）；中文输出与原先逐字一致（「N 天前」不封顶）。
export function relTime(ms) {
  const d = Date.now() - (ms || 0);
  if (d < 60000) return t('刚刚');
  if (d < 3600000) return t('{n} 分钟前', { n: Math.floor(d / 60000) });
  if (d < 86400000) return t('{n} 小时前', { n: Math.floor(d / 3600000) });
  const days = Math.floor(d / 86400000);
  if (days === 1 && isEn()) return t('昨天');
  if (days >= 7 && isEn()) {
    const at = new Date(ms || 0);
    const o = at.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
    return new Intl.DateTimeFormat(locale(), o).format(at);
  }
  return t('{n} 天前', { n: days });
}
