// transcript 目录 watcher：把「文件系统上真实发生的写入」变成总线事件。
//
// 有这一层，会话变化才是【全来源】同步的——不只 bridge 自己发起的轮（那条路 gen 就够
// 了），还包括你在 PC 上直接跑的 Claude Code CLI、桌面 Claude Code、routines 跑的轮。
// 这些写入以前对 bridge 完全不可见：没人 watch，客户端也只在进页面时全量扫一次盘。
//
// 只在【有人订阅总线】时运行，最后一个订阅者走了就把所有 FSWatcher 关掉（引用计数）。
// 空转的目录监听既费句柄又在 Windows 上拖住进程退出。

import { watch as fsWatch, statSync } from 'node:fs';
import path from 'node:path';
import { busPublish } from './bus.mjs';
import { sessionsDir } from './paths.mjs';
import { findGenBySession } from './gen.mjs';
import * as claudeProjects from '../claude-projects.mjs';

// 同一个 transcript 在一轮里会被写几十次（每条消息一行）。去抖把它压成「安静下来
// 400ms 才播一次」，既跟得紧又不会把总线打成筛子。
const DEBOUNCE_MS = 400;
// 项目目录集合会变（新建项目、目录首次被 SDK 创建）。定期重扫补上，不需要谁来通知。
const RESCAN_MS = 45_000;

const _groups = new Map(); // key -> group

function makeGroup(key, ctx) {
  return {
    key,
    ctx,
    refs: 0,
    watchers: new Map(),  // dir -> FSWatcher
    pending: new Map(),   // sessionId -> timer
    lastMtime: new Map(), // sessionId -> 上次播出的 mtime（同 mtime 的重复事件不再播）
    noisyAt: new Map(),   // sessionId -> 上次记「无内容变化事件」日志的时刻（限频）
    rescan: null,
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

function flush(group, sessionId) {
  group.pending.delete(sessionId);
  let mtime = 0;
  // 逐目录 stat 找这个 id 的文件——比记住「事件来自哪个目录」更稳（rescan 会换目录集合）。
  for (const dir of group.watchers.keys()) {
    try {
      const st = statSync(path.join(dir, sessionId + '.jsonl'));
      if (st.mtimeMs > mtime) mtime = st.mtimeMs;
    } catch {}
  }
  if (!mtime) return;   // 文件已删/读不到 → 没什么可同步的
  // 只播【mtime 真变了】的写入。目录事件不等于内容变化（Windows 上关句柄、改属性、外部工具
  // 扫描都可能触发 change），以前照播不误：客户端每收一条就把那个会话顶到列表最前 + 重拉整份
  // transcript——老会话被莫名顶上去、列表看着像乱序（09-13 回归「顺序是乱的」）。mtime 没变
  // 的事件记一条限频日志（便于下次追是谁在碰文件），不上总线。
  if (group.lastMtime.get(sessionId) === mtime) {
    const now = Date.now();
    if (now - (group.noisyAt.get(sessionId) || 0) > 60_000) {
      group.noisyAt.set(sessionId, now);
      console.log(`[watch] fs event without mtime change: ${sessionId.slice(0, 8)} (mtime ${new Date(mtime).toISOString()}) — not published`);
    }
    return;
  }
  group.lastMtime.set(sessionId, mtime);
  // live=true 表示这个会话此刻正由本机的一轮在写：客户端据此知道「正文有直播流在覆盖，
  // 不要再去重载 transcript」，只更新列表排序即可。
  const live = !!findGenBySession(group.key, sessionId);
  busPublish(group.key, { type: 'session.touch', sessionId, mtime, live });
}

function onDirEvent(group, filename) {
  if (!filename) return;
  const name = String(filename);
  if (!name.endsWith('.jsonl')) return;
  const sessionId = name.slice(0, -6);
  if (!/^[0-9a-fA-F-]{8,}$/.test(sessionId)) return;
  const prev = group.pending.get(sessionId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => flush(group, sessionId), DEBOUNCE_MS);
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
  for (const dir of want) {
    if (group.watchers.has(dir)) continue;
    let w;
    // 目录还不存在（该项目尚未跑过会话）→ 下次 rescan 再试，别抛。
    try { w = fsWatch(dir, { persistent: false }, (_evt, filename) => onDirEvent(group, filename)); }
    catch { continue; }
    // 目录被删/重命名时 fs.watch 会 emit error；不处理会把整个进程带崩。
    w.on('error', () => { try { w.close(); } catch {} group.watchers.delete(dir); });
    group.watchers.set(dir, w);
  }
}

// 订阅总线时调用。同一个 key 多条连接共用一组 watcher，引用计数。
export function watchSessions(key, ctx) {
  let group = _groups.get(key);
  if (!group) {
    group = makeGroup(key, ctx);
    _groups.set(key, group);
    syncWatchers(group);
    group.rescan = setInterval(() => syncWatchers(group), RESCAN_MS);
    if (group.rescan.unref) group.rescan.unref();
  }
  group.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--group.refs > 0) return;
    // 最后一个订阅者走了——把句柄和定时器全收干净。
    clearInterval(group.rescan);
    for (const w of group.watchers.values()) { try { w.close(); } catch {} }
    for (const t of group.pending.values()) clearTimeout(t);
    group.watchers.clear();
    group.pending.clear();
    group.lastMtime.clear();
    group.noisyAt.clear();
    _groups.delete(key);
  };
}
