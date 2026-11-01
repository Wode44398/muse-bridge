// 插件自己的日志：ctx.log / warn / error 除了进服务端控制台，再记一份插件名下的——
//   · 内存环形缓冲（每个插件最近 500 条）：设置页详情「日志」、agent 接口 plugins.status { logs: 'plugin' } 读它；
//   · 第三方插件另落盘 plugin-data/<id>/logs/plugin.log（满 2MB 轮转一份 .1），重启后还能看上一次的。
// 内核的 logger 换成这里的 pluginLogger：插件上下文的日志带 '[plugin:<id>]' 前缀，内核自己记的「<id> 启用失败」之类带 '[plugins] <id> '。

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { DATA_ROOT } from '../runtime/paths.mjs';

const RING = 500;
const FILE_MAX = 2 * 1024 * 1024;
const rings = new Map();   // 插件 id → [{ t, level, text }]
const listeners = new Set();
const dataRoot = () => path.join(process.env.BRIDGE_DATA_ROOT ? path.resolve(process.env.BRIDGE_DATA_ROOT) : DATA_ROOT, 'plugin-data');

export function noteLog(id, level, text) {
  if (!id) return;
  const line = { t: Date.now(), level, text: String(text).slice(0, 4000) };
  let r = rings.get(id);
  if (!r) { r = []; rings.set(id, r); }
  r.push(line);
  if (r.length > RING) r.splice(0, r.length - RING);
  // 只给已经有数据目录的插件落盘（第三方插件启用时就建好了；内置功能不往 plugin-data 里堆东西）
  const dir = path.join(dataRoot(), id);
  if (existsSync(dir)) {
    try {
      const f = path.join(dir, 'logs', 'plugin.log');
      mkdirSync(path.dirname(f), { recursive: true });
      try { if (statSync(f).size > FILE_MAX) renameSync(f, f + '.1'); } catch {}
      appendFileSync(f, `${new Date(line.t).toISOString()} ${level.toUpperCase().padEnd(5)} ${line.text.replace(/\r?\n/g, '\n    ')}\n`);
    } catch {}
  }
  for (const fn of listeners) { try { fn(id, line); } catch {} }
}

// 最近 n 条（新的在后）；level 过滤：'warn' = warn + error
export function pluginLogs(id, { lines = 200, level = '' } = {}) {
  const r = rings.get(id) || [];
  const f = level === 'error' ? r.filter((x) => x.level === 'error') : level === 'warn' ? r.filter((x) => x.level !== 'info') : r;
  return f.slice(-Math.max(1, Math.min(RING, Number(lines) || 200)));
}

export function onPluginLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const idOf = (args) => {
  const a0 = typeof args[0] === 'string' ? args[0] : '';
  let m = /^\[plugin:([a-z][a-z0-9-]{0,47})\]$/.exec(a0);
  if (m) return { id: m[1], rest: args.slice(1) };
  m = /^\[plugins\] ([a-z][a-z0-9-]{0,47}) /.exec(a0);
  if (m) return { id: m[1], rest: [a0.slice(m[0].length), ...args.slice(1)] };
  return null;
};

const wrap = (level, sink) => (...args) => {
  sink(...args);
  const hit = idOf(args);
  if (hit) { try { noteLog(hit.id, level, format(...hit.rest)); } catch {} }
};

export const pluginLogger = {
  log: wrap('info', (...a) => console.log(...a)),
  warn: wrap('warn', (...a) => console.warn(...a)),
  error: wrap('error', (...a) => console.error(...a)),
};

export const _test = { idOf, rings };
