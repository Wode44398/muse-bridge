// 定时任务的文案拼装（纯函数、无副作用）：定时任务页、管理台的定时任务页共用。
import { t, locale, isEn } from './i18n.js';

const pad = (n) => String(n).padStart(2, '0');
// 星期名走 Intl（d = 0 周日 … 6 周六；2023-01-01 是周日）：zh-CN short = 周一、narrow = 一；en-US short = Mon
export const wdName = (d, style) => new Intl.DateTimeFormat(locale(), { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + d)));
// 钟点：中文 09:00；英文 12 小时制 9:00 AM
export const hm = (h, m) => (isEn() && Number.isFinite(+h) && Number.isFinite(+m)
  ? new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, h, m)))
  : `${pad(h)}:${pad(m)}`);

// 一周里选几天 + 钟点：选满七天 = 每天、周一到五 = 工作日、六日 = 周末，其余逐个列（每周一、三 09:00）
function weekText(days, time) {
  const set = [...new Set(days || [])].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (set.length === 7) return t('每天 {time}', { time });
  if (set.join() === '1,2,3,4,5') return t('工作日 {time}', { time });
  if (set.join() === '0,6') return t('周末 {time}', { time });
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => set.includes(d));
  return t('每周{days} {time}', { days: order.map((d) => wdName(d, isEn() ? 'short' : 'narrow')).join(isEn() ? ', ' : '、'), time });
}

// 常见的 cron 写成人话（官方同款：Weekdays at / Weekends at / Every N hours / Monthly on the…），认不出的原样显示
function cronText(expr) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5 || !/^\d+$/.test(p[0])) return '';
  const [mi, h, dom, mon, dow] = p, m = +mi;
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') return t('每小时 · 第 {m} 分', { m: isEn() ? pad(m) : m });
  const every = h.match(/^\*\/(\d+)$/);
  if (every && dom === '*' && mon === '*' && dow === '*') return t('每 {n} 小时 · 第 {m} 分', { n: +every[1], m: isEn() ? pad(m) : m });
  if (!/^\d+$/.test(h) || mon !== '*') return '';
  const time = hm(+h, m);
  if (dom === '*' && dow === '*') return t('每天 {time}', { time });
  if (dom === '*' && /^[\d,-]+$/.test(dow)) {
    const days = [];
    for (const part of dow.split(',')) { const [a, b] = part.split('-').map(Number); for (let d = a; d <= (b ?? a); d++) if (d >= 0 && d <= 6) days.push(d); }
    return weekText(days, time);
  }
  if (/^\d+$/.test(dom) && dow === '*') return t('每月 {d} 日 {time}', { d: +dom, time });
  return '';
}

/** 频率的一句话（列表行 / 详情页「重复」）。 */
export function schedText(s) {
  if (!s) return '';
  switch (s.type) {
    case 'manual': return t('仅手动运行');
    case 'once': return t('一次 · {when}', { when: whenText(s.at) });
    case 'cron': return cronText(s.cron) || t('自定义 · {cron}', { cron: s.cron || '' });
    case 'hourly': return t('每小时 · 第 {m} 分', { m: isEn() ? pad(s.minute) : s.minute });
    case 'weekdays': return t('工作日 {time}', { time: hm(s.hour, s.minute) });
    case 'weekly': return weekText(s.days || [s.weekday], hm(s.hour, s.minute));
    default: return t('每天 {time}', { time: hm(s.hour, s.minute) });
  }
}

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** 某个时刻的口语写法：今天 09:00 / 明天 09:00 / 昨天 … / 11月3日 周二 09:00（跨年带年份）。 */
export function whenText(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const time = hm(d.getHours(), d.getMinutes());
  const diff = Math.round((dayStart(d) - dayStart(now)) / 86400000);
  if (diff === 0) return t('今天 {time}', { time });
  if (diff === 1) return t('明天 {time}', { time });
  if (diff === -1) return t('昨天 {time}', { time });
  const opts = { month: 'short', day: 'numeric', weekday: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) };
  return new Intl.DateTimeFormat(locale(), opts).format(d) + ' ' + time;
}

/** 多久之前（运行记录）：刚刚 / 5 分钟前 / 3 小时前 / 超过一天给日期。 */
export function agoText(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t('刚刚');
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) });
  return whenText(ms);
}

/** 耗时：45 秒 / 3 分 12 秒 / 1 小时 5 分。 */
export function durText(ms) {
  if (!(ms > 0)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return t('{n} 秒', { n: s });
  if (s < 3600) return t('{m} 分 {s} 秒', { m: Math.floor(s / 60), s: s % 60 });
  return t('{h} 小时 {m} 分', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
}

/** 文件夹显示名（路径最后一段；盘根就整段）。 */
export const folderName = (p) => { const s = String(p || '').replace(/[\\/]+$/, ''); return s.split(/[\\/]/).pop() || s; };

/** 服务器时区标签：GMT+8 / GMT-5:30。 */
export function tzLabel(tz) {
  const off = tz && Number.isFinite(tz.offset) ? tz.offset : -new Date().getTimezoneOffset();
  const h = Math.floor(Math.abs(off) / 60), m = Math.abs(off) % 60;
  return 'GMT' + (off < 0 ? '-' : '+') + h + (m ? ':' + pad(m) : '');
}
