// Claude 会话在 bridge 这边的活动记录（2026-10-21，归档审查修复）。归档读侧（session-archive-auto.mjs）要两样
// transcript mtime 给不准的信号，按身份落 claude-session-activity.json：
//   { v:1, turns: { [会话 id]: at }, sizes: { [会话 id]: 字节数 } }
//
//  · turns：真人最近一次经 bridge 在这条会话里发消息的时刻（claude.mjs 的 unarchiveOnTurn 钩子里记）。
//    Desktop 只按它自己进程里的活动更新 lastActivityAt，看不见 bridge 的续聊：一条在 Desktop 开、之后一直用手机
//    经 bridge 聊的会话，Desktop 闲够 ccAutoArchiveInactiveDays 天就把它自动归档了。「跟随 Desktop 归档」
//    遇到「bridge 里在 Desktop 最后一次碰它之后还聊过」就不跟随（archiveView）。只记管理员：跟随 Desktop 只对管理员开。
//  · sizes：自动归档（reason 'inactive'）那一刻 transcript 的大小。之后在 Desktop / CLI 里续聊，文件变长，
//    「不活跃」的前提就没了；只看 mtime 不行——备份 / 同步工具会整批 touch（本机见过 52 个文件同一时刻被碰），
//    内容没变、大小不变，不能算活动。
//
// 不能拿 transcript mtime 当「bridge 里聊过」的证据，理由同上。
import path from 'node:path';
import { readJson, writeJson, ID_RE } from '../jsonfile.mjs';

const MAX_TURNS = 3000;
const MAX_SIZES = 20000;
const cache = new Map();
const fileFor = (ctx) => path.join(ctx.dataDir, 'claude-session-activity.json');
const enabled = (ctx) => !!(ctx && ctx.dataDir && !ctx.snap);

function clean(obj) {
  const out = {};
  if (obj && typeof obj === 'object') for (const [id, v] of Object.entries(obj)) if (ID_RE.test(id) && Number(v) >= 0) out[id] = Number(v);
  return out;
}
function load(ctx) {
  const file = fileFor(ctx);
  if (cache.has(file)) return cache.get(file);
  const raw = readJson(file, {});
  const d = { turns: clean(raw.turns), sizes: clean(raw.sizes) };
  cache.set(file, d);
  return d;
}
const save = (ctx) => { const d = load(ctx); writeJson(fileFor(ctx), { v: 1, turns: d.turns, sizes: d.sizes }); };

// 超上限：丢最旧的那一半（turns 按时刻；sizes 没有时刻，按插入顺序）
function trimTurns(m) {
  const ks = Object.keys(m);
  if (ks.length <= MAX_TURNS) return;
  ks.sort((a, b) => m[a] - m[b]).slice(0, ks.length - MAX_TURNS / 2).forEach((k) => delete m[k]);
}
function trimSizes(m) {
  const ks = Object.keys(m);
  if (ks.length <= MAX_SIZES) return;
  ks.slice(0, ks.length - MAX_SIZES / 2).forEach((k) => delete m[k]);
}

/** 只读视图（一次请求内复用）：{ turns, sizes }。 */
export function getActivity(ctx) {
  if (!enabled(ctx)) return { turns: {}, sizes: {} };
  return load(ctx);
}

/** 真人经 bridge 在这条会话里发了消息。只记管理员（跟随 Desktop 归档只对管理员开）。 */
export function noteBridgeTurn(ctx, id, at = Date.now()) {
  if (!enabled(ctx) || ctx.kind !== 'admin' || typeof id !== 'string' || !ID_RE.test(id)) return;
  const d = load(ctx);
  d.turns[id] = at;
  trimTurns(d.turns);
  save(ctx);
}

/** 记下自动归档那一刻的 transcript 大小：files = [{ id, size }]。 */
export function noteArchivedSizes(ctx, files) {
  if (!enabled(ctx)) return;
  const d = load(ctx);
  let changed = false;
  for (const f of files || []) {
    if (!f || typeof f.id !== 'string' || !ID_RE.test(f.id) || !(Number(f.size) >= 0)) continue;
    d.sizes[f.id] = Number(f.size); changed = true;
  }
  if (!changed) return;
  trimSizes(d.sizes);
  save(ctx);
}

/** 删会话 / 自动归档记录作废时同步清。 */
export function forgetActivity(ctx, id, { turns = true } = {}) {
  if (!enabled(ctx) || !id) return;
  const d = load(ctx);
  const had = (turns && id in d.turns) || id in d.sizes;
  if (!had) return;
  if (turns) delete d.turns[id];
  delete d.sizes[id];
  save(ctx);
}

export function _resetActivityCache() { cache.clear(); }
