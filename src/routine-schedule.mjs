// 定时任务的频率：规范化 + 下次运行时间。纯函数、无 node 依赖——服务端（routines.mjs）与前端表单
//（「下次运行」预览，web/src/lib/routineText.js 一带）共用同一份算法，预览与实际触发永远一致。
// 时间按运行这段代码的机器的本地时区算：服务端 = 服务器时区；前端预览在别的时区时只作参考（界面标明服务器时区）。
import { normalizeCron, nextCron } from './cron.mjs';

// manual = 只手动运行；once = 指定时刻跑一次；cron = 自定义表达式。其余是友好预设。
const TYPES = new Set(['manual', 'once', 'hourly', 'daily', 'weekdays', 'weekly', 'cron']);

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

// 规范化频率。strict = 用户刚提交的（cron 不合法、一次性没给时间要报错）；读旧数据时宽松兜底。
export function normSchedule(s, { strict = false } = {}) {
  const type = TYPES.has(s && s.type) ? s.type : 'daily';
  if (type === 'manual') return { type };
  if (type === 'once') {
    const at = Number(s && s.at);
    if (!Number.isFinite(at) || at <= 0) {
      if (strict) throw Object.assign(new Error('请选择运行的日期和时间'), { status: 400 });
      return { type: 'manual' };
    }
    return { type, at: Math.floor(at / 60000) * 60000 };
  }
  if (type === 'cron') {
    try { return { type, cron: normalizeCron(s && s.cron) }; }
    catch (e) { if (strict) throw e; return { type: 'manual' }; }
  }
  const minute = clampInt(s && s.minute, 0, 59, 0);
  if (type === 'hourly') return { type, minute };
  const hour = clampInt(s && s.hour, 0, 23, 9);
  // weekly：一周里选几天（0=周日…6=周六，JS getDay）。老数据只有单个 weekday，照样认。
  if (type === 'weekly') {
    const raw = Array.isArray(s && s.days) ? s.days : [s && s.weekday != null ? s.weekday : 1];
    const days = [...new Set(raw.map((d) => clampInt(d, 0, 6, -1)).filter((d) => d >= 0))].sort((a, b) => a - b);
    const list = days.length ? days : [1];
    return { type, days: list, weekday: list[0], hour, minute };
  }
  return { type, hour, minute };
}

// Next fire time (ms epoch) strictly after `from`, in local time. null = never (manual / once already past).
export function computeNextRun(schedule, from = Date.now()) {
  const s = normSchedule(schedule);
  if (s.type === 'manual') return null;
  if (s.type === 'once') return s.at > from ? s.at : null;
  if (s.type === 'cron') return nextCron(s.cron, from);
  if (s.type === 'hourly') {
    const n = new Date(from);
    n.setSeconds(0, 0);
    n.setMinutes(s.minute);
    if (n.getTime() <= from) n.setHours(n.getHours() + 1);
    return n.getTime();
  }
  const n = new Date(from);
  n.setHours(s.hour, s.minute, 0, 0);
  if (n.getTime() <= from) n.setDate(n.getDate() + 1);
  if (s.type === 'weekdays') {
    while (n.getDay() === 0 || n.getDay() === 6) n.setDate(n.getDate() + 1);
  }
  if (s.type === 'weekly') {
    while (!s.days.includes(n.getDay())) n.setDate(n.getDate() + 1);
  }
  return n.getTime();
}
