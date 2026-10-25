// Claude 分页会话归档（2026-10-20，对齐官方 Claude Desktop 的 Archive）。
//
// 按身份数据目录落 claude-session-archive.json：
//   { rev, archived: { [sessionId]: { at, reason } }, unarchived: { [sessionId]: at } }
//   reason：'manual'（手动）| 'inactive'（N 天不活跃自动归档）| 'pr_closed'（PR 合并或关闭后自动归档）
//   unarchived：用户手动取消归档过的会话——它盖过「跟随 Desktop 的归档」，也不再被自动归档（官方同款语义）。
// 归档只是列表层的状态：不停会话、不删转录；worktree 也不动（bridge 有意不删：worktree 里常有联接目录，
// 删目录可能顺着联接删到主树依赖，见记忆 feedback_worktree_commit_discipline / reference_bridge_deploy_baseline）。
// 调用方负责 busPublish(ctx.key, { type:'archive', archive })。
import path from 'node:path';
import { readJson, writeJson, ID_RE } from '../jsonfile.mjs';

const MAX = 20000;
const cache = new Map();
const fileFor = (ctx) => path.join(ctx.dataDir, 'claude-session-archive.json');

function load(ctx) {
  const file = fileFor(ctx);
  if (cache.has(file)) return cache.get(file);
  const raw = readJson(file, {});
  const d = {
    rev: Number.isFinite(raw.rev) ? raw.rev : 0,
    archived: raw.archived && typeof raw.archived === 'object' ? raw.archived : {},
    unarchived: raw.unarchived && typeof raw.unarchived === 'object' ? raw.unarchived : {},
  };
  cache.set(file, d);
  return d;
}
const snapshot = (d) => ({ rev: d.rev, archived: { ...d.archived }, unarchived: { ...d.unarchived } });

export function getArchiveState(ctx) {
  if (!ctx?.dataDir || ctx.snap) return { rev: 0, archived: {}, unarchived: {} };
  return snapshot(load(ctx));
}

/** bridge 自己记的归档态：true / false（显式取消过）/ null（没记过，交给 Desktop 跟随或默认未归档）。 */
export function localArchiveFlag(ctx, id) {
  if (!ctx?.dataDir) return null;
  const d = load(ctx);
  if (d.archived[id]) return true;
  if (d.unarchived[id]) return false;
  return null;
}

/**
 * 归档 / 取消归档一批会话。on=true 归档（reason 记来源）；on=false 取消归档并记进 unarchived。
 * 自动归档（reason !== 'manual'）跳过用户取消归档过的会话。返回 { changed, archive }。
 */
export function setArchived(ctx, ids, on, { reason = 'manual', at = Date.now() } = {}) {
  if (!ctx?.dataDir || ctx.snap) throw Object.assign(new Error('not allowed'), { status: 403 });
  const d = load(ctx);
  let changed = false;
  for (const id of (Array.isArray(ids) ? ids : [ids])) {
    if (typeof id !== 'string' || !ID_RE.test(id)) continue;
    if (on) {
      if (reason !== 'manual' && d.unarchived[id]) continue;
      if (d.archived[id]) continue;
      if (Object.keys(d.archived).length >= MAX) break;
      d.archived[id] = { at, reason };
      if (reason === 'manual') delete d.unarchived[id];
      changed = true;
    } else {
      if (d.archived[id]) { delete d.archived[id]; changed = true; }
      if (!d.unarchived[id]) { d.unarchived[id] = at; changed = true; }
    }
  }
  if (changed) { d.rev += 1; writeJson(fileFor(ctx), d, 0); }
  return { changed, archive: snapshot(d) };
}

/** 删会话时同步清记录。 */
export function forgetArchived(ctx, id) {
  if (!ctx?.dataDir) return null;
  const d = load(ctx);
  if (!d.archived[id] && !d.unarchived[id]) return null;
  delete d.archived[id]; delete d.unarchived[id];
  d.rev += 1; writeJson(fileFor(ctx), d, 0);
  return snapshot(d);
}

export function _resetArchiveCache() { cache.clear(); }
