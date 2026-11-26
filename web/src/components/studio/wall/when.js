// 墙上的时间文字：时长 m:ss、日期小标题、mono 元信息里的时刻与用时。
import { t, locale } from '../../../lib/i18n.js';

export const ts = (x) => (typeof x === 'number' ? x : Date.parse(x) || 0);
export const mmss = (s) => { const v = Math.max(0, Number(s) || 0); return Math.floor(v / 60) + ':' + String(Math.floor(v % 60)).padStart(2, '0'); };

const pad = (n) => String(n).padStart(2, '0');
export function dayKey(x) {
  const d = new Date(ts(x));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
/** 日期小标题：今天 / 昨天 / 本年写月日 / 往年带年份 */
export function dayLabel(x) {
  const d = new Date(ts(x)), now = new Date();
  const k = dayKey(d), today = dayKey(now), y = new Date(now); y.setDate(now.getDate() - 1);
  if (k === today) return t('今天');
  if (k === dayKey(y)) return t('昨天');
  const o = d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' };
  try { return new Intl.DateTimeFormat(locale(), o).format(d); } catch { return k; }
}
/** mono 元信息里的时刻：今天只写时分，其余写月-日 时分（数字不分语言） */
export function stamp(x) {
  const d = new Date(ts(x));
  if (!ts(x)) return '';
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return hm;
  const md = pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return (d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '-' + md) + ' ' + hm;
}
/** 用时：任务从发出到完成（12.4s / 1:05） */
export function tookOf(job) {
  const a = ts(job?.createdAt), b = ts(job?.finishedAt);
  if (!(a && b && b > a)) return '';
  const s = (b - a) / 1000;
  return s >= 60 ? mmss(s) : (Math.round(s * 10) / 10) + 's';
}
