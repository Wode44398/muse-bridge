// 插件的定时任务：ctx.schedule(name, when, fn) —— 比 setInterval 多三样：上次运行时间落盘、bridge 关机错过了开机补跑一次、
// 状态（上次结果 / 下次时间）自动并进详情页状态块。时间一律按服务器本地时区。
//
//   when：{ every: '30m' | '2h' | '1d' | 毫秒数 }        固定间隔（从上次运行算起；最短 10 秒）
//         { daily: '04:30' }                            每天几点
//         { cron: '0 4 * * *' }                         五段 cron（分 时 日 月 周；支持 * , - /；周 0/7 = 周日）
//         另可加：immediate: true（每次启用时先跑一次）、dev: true（开发实例也跑；缺省只在正式实例跑）、
//                 catchUp: false（错过了不补）、label（状态块里的名字）
//   fn(info)：info = { name, scheduledAt, lastRun, catchUp }；可 async。抛错记进状态与插件日志，不影响下次。
//   返回 { runNow(), info() }。同一个任务上一次还没跑完时，到点的这次跳过。
//
// 记录在 plugin-data/<id>/schedules.json：{ 名字: { lastRun, lastOk, lastError, durationMs } }。

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../jsonfile.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const MAX_DELAY = 2 ** 31 - 1;
const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseEvery(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(10_000, Math.floor(v));
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/i.exec(String(v || ''));
  if (!m) throw new Error(`every 写法不对：「${v}」（如 '30m'、'2h'、'1d' 或毫秒数）`);
  return Math.max(10_000, Math.round(Number(m[1]) * UNITS[m[2].toLowerCase()]));
}

// cron 一段 → 允许值的集合
function field(expr, lo, hi, name) {
  const out = new Set();
  for (const part of String(expr).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`cron 的${name}写法不对：「${part}」`);
    let a = lo, b = hi;
    if (m[1] !== '*') { const [x, y] = m[1].split('-').map(Number); a = x; b = y ?? (m[2] ? hi : x); }
    const step = m[2] ? Number(m[2]) : 1;
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`cron 的${name}超出范围：「${part}」`);
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out;
}

export function parseCron(expr) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5) throw new Error(`cron 要五段（分 时 日 月 周）：「${expr}」`);
  const dow = field(p[4], 0, 7, '周');
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return { min: field(p[0], 0, 59, '分'), hour: field(p[1], 0, 23, '时'), dom: field(p[2], 1, 31, '日'), mon: field(p[3], 1, 12, '月'), dow, domAny: p[2] === '*', dowAny: p[4] === '*' };
}

// from 之后（不含）下一次触发的时刻
export function nextCron(c, from) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk = c.domAny && c.dowAny ? true
      : c.domAny ? c.dow.has(d.getDay())
      : c.dowAny ? c.dom.has(d.getDate())
      : c.dom.has(d.getDate()) || c.dow.has(d.getDay());
    if (!c.mon.has(d.getMonth() + 1) || !dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

// when → { next(from, lastRun) }
export function compileWhen(when) {
  if (!when || typeof when !== 'object') throw new Error('ctx.schedule 的 when 要写成 { every } / { daily } / { cron }');
  if (when.every != null) {
    const ms = parseEvery(when.every);
    return { desc: '每 ' + humanMs(ms), next: (from, last) => (last ? Math.max(from, last + ms) : from + ms), period: ms };
  }
  if (when.daily != null) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(when.daily));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`daily 写法不对：「${when.daily}」（如 '04:30'）`);
    const c = parseCron(`${Number(m[2])} ${Number(m[1])} * * *`);
    return { desc: '每天 ' + when.daily, next: (from) => nextCron(c, from - 1), cron: c };
  }
  if (when.cron != null) {
    const c = parseCron(when.cron);
    return { desc: 'cron ' + when.cron, next: (from) => nextCron(c, from - 1), cron: c };
  }
  throw new Error('ctx.schedule 的 when 要写成 { every } / { daily } / { cron }');
}

function humanMs(ms) {
  if (ms % 86_400_000 === 0) return ms / 86_400_000 + ' 天';
  if (ms % 3_600_000 === 0) return ms / 3_600_000 + ' 小时';
  if (ms % 60_000 === 0) return ms / 60_000 + ' 分钟';
  return Math.round(ms / 1000) + ' 秒';
}

export function makeScheduleService(ctx) {
  const jobs = new Map();   // name → job
  const file = () => path.join(ctx.dataDir, 'schedules.json');
  const readRec = () => readJson(file(), {}) || {};
  const writeRec = (name, patch) => {
    const all = readRec();
    all[name] = { ...(all[name] || {}), ...patch };
    try { mkdirSync(ctx.dataDir, { recursive: true }); writeJson(file(), all, 1); } catch {}
  };
  const refresh = () => { try { ctx.status?.refresh?.(); } catch {} };

  function schedule(name, when, fn) {
    if (!ctx.alive) throw new Error('插件已停用');
    if (!NAME_RE.test(String(name || ''))) throw new Error('定时任务名只能用字母、数字、- 和 _（≤32 字）');
    if (jobs.has(name)) throw new Error(`定时任务「${name}」重复`);
    if (typeof fn !== 'function') throw new Error('ctx.schedule 要 (name, when, fn)');
    const plan = compileWhen(when);
    const enabled = !!(when.dev || ctx.runtime?.production);
    const job = { name, label: String(when.label || name).slice(0, 40), desc: plan.desc, timer: null, running: false, nextAt: null, enabled };

    async function fire(scheduledAt, catchUp = false) {
      if (!ctx.alive) return;
      if (job.running) { arm(); return; }
      job.running = true;
      const t0 = Date.now();
      const lastRun = readRec()[name]?.lastRun || null;
      writeRec(name, { lastRun: t0 });
      refresh();
      try {
        await fn({ name, scheduledAt, lastRun, catchUp });
        writeRec(name, { lastOk: true, lastError: '', durationMs: Date.now() - t0 });
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 300);
        writeRec(name, { lastOk: false, lastError: msg, durationMs: Date.now() - t0 });
        ctx.warn(`定时任务 ${name} 出错：${msg}`);
      } finally {
        job.running = false;
        if (ctx.alive) { arm(); refresh(); }
      }
    }

    function arm() {
      clearTimeout(job.timer);
      job.timer = null;
      if (!ctx.alive || !job.enabled) { job.nextAt = null; return; }
      const last = readRec()[name]?.lastRun || null;
      const at = plan.next(Date.now(), last);
      job.nextAt = at;
      if (at == null) return;
      const delay = Math.max(0, at - Date.now());
      job.timer = setTimeout(() => { if (Date.now() + 1000 < at) arm(); else fire(at); }, Math.min(delay, MAX_DELAY));
      job.timer.unref?.();
    }

    jobs.set(name, job);
    ctx.onDispose(() => { clearTimeout(job.timer); jobs.delete(name); });
    if (job.enabled) {
      const last = readRec()[name]?.lastRun || null;
      // 错过了（bridge 关着时到过点）：启用后 15 秒补跑一次；immediate：启用后先跑一次
      let missed = false;
      if (when.catchUp !== false && last) {
        const due = plan.period ? last + plan.period : plan.next(last + 1, last);
        missed = due != null && due < Date.now() - 60_000;
      }
      if (missed || when.immediate) {
        const wait = missed ? 15_000 : 0;
        const t = setTimeout(() => fire(Date.now(), missed), wait);
        t.unref?.();
        ctx.onDispose(() => clearTimeout(t));
        job.nextAt = Date.now() + wait;
      } else arm();
    }
    return {
      runNow: () => fire(Date.now()),
      info: () => infoOf(job),
    };
  }

  const infoOf = (job) => {
    const r = readRec()[job.name] || {};
    return { name: job.name, label: job.label, when: job.desc, enabled: job.enabled, running: job.running, next: job.nextAt, lastRun: r.lastRun || null, lastOk: r.lastOk ?? null, lastError: r.lastError || '' };
  };

  return { schedule, list: () => [...jobs.values()].map(infoOf) };
}
