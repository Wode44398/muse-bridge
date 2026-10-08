// 报错记录：服务进程里没接住的异常、路由 500、浏览器报上来的页面错误，按指纹去重计数，落在 feedback/errors.json。
// 只记归一后的消息和我们自己代码的帧（scrub.mjs），不记请求内容。出报告时从这里挑最近的几条附上；
// 用户开了「自动上报」时，服务端自己的新错误会触发一次自动报告（auto.mjs）。
import path from 'node:path';
import { readJson, writeJson } from '../jsonfile.mjs';
import { DIR } from './store.mjs';
import { normalizeMessage, ownFrames, errorFingerprint, clip } from './scrub.mjs';

const FILE = path.join(DIR, 'errors.json');
const MAX = 60;
const listeners = new Set();
let cache = null;
let saveTimer = null;

function load() { if (!cache) { const a = readJson(FILE, []); cache = Array.isArray(a) ? a : []; } return cache; }
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeJson(FILE, cache || [], 2); }, 2000);
  saveTimer.unref?.();
}
export function flushErrors() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } if (cache) writeJson(FILE, cache, 2); }

/** 有新指纹（这个进程里第一次见）时通知：auto.mjs 订阅 */
export function onNewError(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * 记一条报错。where：server | client | harness；err 可以是 Error，也可以是 { name, message, stack }。
 * 返回记下的条目（含指纹）。
 */
export async function recordError(where, err, extra = {}) {
  try {
    const type = clip(String(err?.name || err?.constructor?.name || 'Error').replace(/[^A-Za-z0-9_.$]/g, ''), 40) || 'Error';
    const rawMsg = String(err?.message ?? err ?? '');
    const frames = ownFrames(err?.stack || '');
    const message = normalizeMessage(rawMsg);
    if (!message && !frames.length) return null;
    const fp = await errorFingerprint({ where, type, message, frames });
    const list = load();
    const now = new Date().toISOString();
    let e = list.find((x) => x.fp === fp);
    const fresh = !e;
    if (e) { e.count = (e.count || 1) + 1; e.last = now; }
    else {
      e = { fp, where, type, message, frames, count: 1, first: now, last: now, version: extra.version || '' };
      list.push(e);
      list.sort((a, b) => String(a.last).localeCompare(String(b.last)));
      if (list.length > MAX) list.splice(0, list.length - MAX);
    }
    saveSoon();
    if (fresh) for (const fn of listeners) { try { fn(e, extra); } catch {} }
    return e;
  } catch { return null; }
}

/** 最近的报错（新的在前）；sinceMs 只要这之后发生过的 */
export function recentErrors({ limit = 5, sinceMs = 0, where } = {}) {
  // 命令行（bootstrap.sh report）跑在另一个进程里：每次从磁盘读最新的；本进程还有没落盘的就用内存里的
  if (!saveTimer) cache = null;
  const list = load().filter((e) => (!where || e.where === where) && (!sinceMs || Date.parse(e.last) >= sinceMs));
  return list.slice().sort((a, b) => String(b.last).localeCompare(String(a.last))).slice(0, limit);
}
