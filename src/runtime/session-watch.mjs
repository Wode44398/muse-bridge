// transcript 目录 watcher：把「文件系统上真实发生的写入」变成总线事件。
//
// 有这一层，会话变化才是【全来源】同步的——不只 bridge 自己发起的轮（那条路 gen 就够
// 了），还包括你在 PC 上直接跑的 Claude Code CLI、桌面 Claude Code、routines 跑的轮。
// 这些写入以前对 bridge 完全不可见：没人 watch，客户端也只在进页面时全量扫一次盘。
//
// 只在【有人订阅总线】时运行，最后一个订阅者走了就把所有 FSWatcher 关掉（引用计数）。
// 空转的目录监听既费句柄又在 Windows 上拖住进程退出。

import { watch as fsWatch, promises as fsp } from 'node:fs';
import path from 'node:path';
import { busPublish } from './bus.mjs';
import { sessionsDir } from './paths.mjs';
import { findGenBySession } from './gen.mjs';
import { invalidateSessionFiles } from './session-list.mjs';
import * as claudeProjects from '../claude-projects.mjs';

// 同一个 transcript 在一轮里会被写几十次（每条消息一行）。去抖把它压成「安静下来
// 400ms 才播一次」，既跟得紧又不会把总线打成筛子。
const DEBOUNCE_MS = 400;
// 项目目录集合会变（新建项目、目录首次被 SDK 创建）。定期重扫补上，不需要谁来通知。
const RESCAN_MS = 45_000;
// 「目录事件但 mtime 没变」的日志（10-21：占了 server.out.log 的 61%，读日志的人以为满处报错）：
// 全局计数，每分钟最多汇总一行；逐条明细只在 BRIDGE_DEBUG_WATCH=1 时打。
const NOISE_LOG_MS = 60_000;
const DEBUG_WATCH = process.env.BRIDGE_DEBUG_WATCH === '1';
const noise = { count: 0, ids: new Set(), timer: null };
function noteNoise(sessionId, mtime) {
  if (DEBUG_WATCH) console.log(`[watch] fs event without mtime change: ${sessionId.slice(0, 8)} (mtime ${new Date(mtime).toISOString()}) — not published`);
  noise.count++;
  noise.ids.add(sessionId);
  if (noise.timer) return;
  noise.timer = setTimeout(() => {
    noise.timer = null;
    if (!noise.count) return;
    console.log(`[watch] ${noise.count} 次目录事件没有内容变化（${noise.ids.size} 个会话），未上总线（明细：BRIDGE_DEBUG_WATCH=1）`);
    noise.count = 0;
    noise.ids.clear();
  }, NOISE_LOG_MS);
  noise.timer.unref?.();
}

const _groups = new Map(); // key -> group

function makeGroup(key, ctx) {
  return {
    key,
    ctx,
    refs: 0,
    watchers: new Map(),  // dir -> FSWatcher
    pending: new Map(),   // sessionId -> timer
    pendingDirs: new Map(), // sessionId -> Set<dir>（这个去抖窗口里哪些目录报过它）
    lastMtime: new Map(), // sessionId -> 上次播出的 mtime（同 mtime 的重复事件不再播）
    rescan: null,
    closed: false,
  };
}

function dirsFor(ctx) {
  const out = [];
  let scopes = [];
  try { scopes = claudeProjects.sessionScopes(ctx.claudeProjects, ctx); } catch { return out; }   // 含 worktree 会话目录
  for (const s of scopes) {
    try { out.push(sessionsDir(s.path, ctx.configDir)); } catch {}
  }
  return out;
}

async function flush(group, sessionId) {
  group.pending.delete(sessionId);
  const evDirs = group.pendingDirs.get(sessionId);
  group.pendingDirs.delete(sessionId);
  // 只 stat 报过事件的那几个目录（以前逐个目录同步 stat，46 个目录每次 15–25ms，一轮里每次写入都来一遍）；
  // 报事件的目录 rescan 后都不在了才退回全部在看的目录。异步 stat，不占主线程。
  const live0 = evDirs ? [...evDirs].filter((d) => group.watchers.has(d)) : [];
  const dirs = live0.length ? live0 : [...group.watchers.keys()];
  const sts = await Promise.all(dirs.map((dir) => fsp.stat(path.join(dir, sessionId + '.jsonl')).catch(() => null)));
  if (group.closed) return;
  let mtime = 0;
  for (const st of sts) if (st && st.mtimeMs > mtime) mtime = st.mtimeMs;
  // 文件已删 / 读不到 → 没什么可同步的；播出过的会话没了（别处删的），会话列表缓存作废
  if (!mtime) { if (group.lastMtime.delete(sessionId)) invalidateSessionFiles(); return; }
  // 只播【mtime 真变了】的写入。目录事件不等于内容变化（Windows 上关句柄、改属性、外部工具
  // 扫描都可能触发 change），以前照播不误：客户端每收一条就把那个会话顶到列表最前 + 重拉整份
  // transcript——老会话被莫名顶上去、列表看着像乱序（09-13 回归「顺序是乱的」）。mtime 没变
  // 的事件只进汇总日志（noteNoise，便于下次追是谁在碰文件），不上总线。
  if (group.lastMtime.get(sessionId) === mtime) { noteNoise(sessionId, mtime); return; }
  group.lastMtime.set(sessionId, mtime);
  invalidateSessionFiles();   // 会话列表缓存（session-list.mjs）：mtime / 大小变了，也可能是新文件
  // live=true 表示这个会话此刻正由本机的一轮在写：客户端据此知道「正文有直播流在覆盖，
  // 不要再去重载 transcript」，只更新列表排序即可。
  const live = !!findGenBySession(group.key, sessionId);
  busPublish(group.key, { type: 'session.touch', sessionId, mtime, live });
}

function onDirEvent(group, dir, filename) {
  if (!filename) return;
  const name = String(filename);
  if (!name.endsWith('.jsonl')) return;
  const sessionId = name.slice(0, -6);
  if (!/^[0-9a-fA-F-]{8,}$/.test(sessionId)) return;
  const prev = group.pending.get(sessionId);
  if (prev) clearTimeout(prev);
  let ds = group.pendingDirs.get(sessionId);
  if (!ds) group.pendingDirs.set(sessionId, (ds = new Set()));
  ds.add(dir);
  const t = setTimeout(() => { flush(group, sessionId).catch(() => {}); }, DEBOUNCE_MS);
  if (t.unref) t.unref();
  group.pending.set(sessionId, t);
}

function syncWatchers(group) {
  const want = new Set(dirsFor(group.ctx));
  for (const [dir, w] of [...group.watchers]) {
    if (want.has(dir)) continue;
    try { w.close(); } catch {}
    group.watchers.delete(dir);
  }
  let added = false;
  for (const dir of want) {
    if (group.watchers.has(dir)) continue;
    let w;
    // 目录还不存在（该项目尚未跑过会话）→ 下次 rescan 再试，别抛。
    try { w = fsWatch(dir, { persistent: false }, (_evt, filename) => onDirEvent(group, dir, filename)); }
    catch { continue; }
    // 目录被删/重命名时 fs.watch 会 emit error；不处理会把整个进程带崩。
    w.on('error', () => { try { w.close(); } catch {} group.watchers.delete(dir); });
    group.watchers.set(dir, w);
    added = true;
  }
  // 新看上的目录（新项目第一次跑出会话、worktree 刚建）：这之前写进去的会话 watcher 没看见，列表缓存作废一次
  if (added) invalidateSessionFiles();
}

// 盯着的目录已经不在了（项目 / worktree 被删、账号目录被删或归档）：主动关掉它的 watcher。
// Windows 上被盯着的目录删掉后 FSWatcher 不发 'error'，而是空转吃满一个核（Node 24 实测），上面的 on('error') 关不到它。
// 目录以后再出现，下一次 syncWatchers 会重新看上。异步 stat，不占主线程。
async function pruneGone(group) {
  const dirs = [...group.watchers.keys()];
  if (!dirs.length) return;
  const alive = await Promise.all(dirs.map((d) => fsp.stat(d).then((st) => st.isDirectory(), () => false)));
  if (group.closed) return;
  dirs.forEach((d, i) => {
    if (alive[i]) return;
    const w = group.watchers.get(d);
    if (!w) return;
    try { w.close(); } catch {}
    group.watchers.delete(d);
  });
}

// 订阅总线时调用。同一个 key 多条连接共用一组 watcher，引用计数。
export function watchSessions(key, ctx) {
  let group = _groups.get(key);
  if (!group) {
    group = makeGroup(key, ctx);
    _groups.set(key, group);
    syncWatchers(group);
    group.rescan = setInterval(() => { syncWatchers(group); pruneGone(group).catch(() => {}); }, RESCAN_MS);
    if (group.rescan.unref) group.rescan.unref();
  }
  group.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--group.refs > 0) return;
    // 最后一个订阅者走了——把句柄和定时器全收干净。
    group.closed = true;
    clearInterval(group.rescan);
    for (const w of group.watchers.values()) { try { w.close(); } catch {} }
    for (const t of group.pending.values()) clearTimeout(t);
    group.watchers.clear();
    group.pending.clear();
    group.pendingDirs.clear();
    group.lastMtime.clear();
    _groups.delete(key);
  };
}
