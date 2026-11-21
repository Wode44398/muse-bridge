// 彻底删除 Antigravity 会话时要删的 agy 自己的文件，以及删不掉时的「待清理清单」。
//
// 只删固定位置：<数据目录>/conversations/<id>.db（连 -wal / -shm）、旧格式 <id>.pb、<数据目录>/brain/<id>/、
// <数据目录>/annotations/<id>.pbtxt（这个会话的标注）。agy 的摘要库（conversation_summaries.db）是所有会话共用的一个库，不动。
// id 只认 uuid 形状（拼进路径前先过这一关，防路径穿越），删之前再核一次路径确实落在数据目录里。
//
// agy 进程打开过的 .db 直到进程退出都不释放（Windows 下删会 EBUSY / EPERM），所以删不掉的路径记进清单，
// 等下次 agy 进程 spawn 之前（那时文件没人占着）再清——调用点在 acp/client.mjs 的 _spawnAndInitialize，
// 与 repairShadowedConversations 同一时机。本文件只依赖 node 与核心路径，不引 acp/，免得循环依赖。

import path from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';

export const AGY_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAgySessionId = (id) => AGY_SESSION_ID_RE.test(String(id || ''));

const CONVERSATION_EXTS = ['.db', '.db-wal', '.db-shm', '.pb'];
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

export function pendingPurgeFile() {
  return path.join(DATA_ROOT, 'agy', 'pending-purge.json');
}

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 一个会话在某个 agy 数据目录里的全部文件位置（不管存不存在）。id 不合格返回空。 */
export function sessionFileTargets(dataDir, id) {
  if (!dataDir || !isAgySessionId(id)) return [];
  const root = path.resolve(dataDir);
  const conv = path.join(root, 'conversations');
  const out = [
    ...CONVERSATION_EXTS.map((ext) => path.join(conv, id + ext)),
    path.join(root, 'brain', id),
    path.join(root, 'annotations', id + '.pbtxt'),
  ];
  return out.filter((p) => inside(p, root));
}

/**
 * 删一批位置。返回 { removed:[实际删掉的], busy:[被占着删不掉的] }；本来就不存在的不算。
 * rm 可注入（测试里模拟 EBUSY）；别的错误也按「这次删不掉」记进 busy，下次再试。
 */
export function removeTargets(targets, { rm = rmSync, exists = existsSync } = {}) {
  const removed = [];
  const busy = [];
  for (const p of targets) {
    if (!exists(p)) continue;
    try {
      rm(p, { recursive: true, force: true });
      removed.push(p);
    } catch (err) {
      busy.push(p);
      if (!BUSY_CODES.has(err?.code)) console.warn('[agy] 删除会话文件失败：', p, err?.message || err);
    }
  }
  return { removed, busy };
}

function readPending(file) {
  const data = readJson(file, { items: [] });
  return Array.isArray(data?.items) ? data.items.filter((x) => x && isAgySessionId(x.id) && Array.isArray(x.paths)) : [];
}

function writePending(file, items) {
  try { writeJson(file, { items }, 2); } catch {}
}

/** 删不掉的路径记进待清理清单（同一会话合并）。 */
export function notePendingPurge(id, dataDir, paths, file = pendingPurgeFile()) {
  if (!isAgySessionId(id) || !Array.isArray(paths) || !paths.length) return;
  const allowed = new Set(sessionFileTargets(dataDir, id));
  const clean = paths.filter((p) => allowed.has(p));
  if (!clean.length) return;
  const items = readPending(file);
  const hit = items.find((x) => x.id === id);
  if (hit) hit.paths = [...new Set([...hit.paths, ...clean])];
  else items.push({ id, paths: clean, at: Date.now() });
  writePending(file, items);
}

export function listPendingPurge(file = pendingPurgeFile()) {
  return readPending(file);
}

/**
 * agy 进程 spawn 之前调：清掉清单里落在这个数据目录下的路径。路径照 id 重新推一遍、只认固定位置，
 * 清单文件被改过也删不到别处。返回这次清干净的会话 id。
 */
export function purgePendingDeletions(dataDir, { file = pendingPurgeFile(), rm, exists } = {}) {
  if (!dataDir) return [];
  const items = readPending(file);
  if (!items.length) return [];
  const done = [];
  const keep = [];
  for (const it of items) {
    const allowed = new Set(sessionFileTargets(dataDir, it.id));
    const mine = it.paths.filter((p) => allowed.has(p));
    const others = it.paths.filter((p) => !allowed.has(p));
    const { busy } = mine.length ? removeTargets(mine, { rm, exists }) : { busy: [] };
    const rest = [...others, ...busy];
    if (rest.length) keep.push({ ...it, paths: rest });
    else done.push(it.id);
  }
  writePending(file, keep);
  return done;
}

/** 删一个会话在这些数据目录里的文件；删不掉的进清单。返回 { removed, pending }。 */
export function purgeSessionFiles(id, dataDirs, { file = pendingPurgeFile(), rm, exists } = {}) {
  const removed = [];
  const pending = [];
  if (!isAgySessionId(id)) return { removed, pending };
  const seen = new Set();
  for (const dir of dataDirs) {
    if (!dir) continue;
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const r = removeTargets(sessionFileTargets(dir, id), { rm, exists });
    removed.push(...r.removed);
    if (r.busy.length) {
      notePendingPurge(id, dir, r.busy, file);
      pending.push(...r.busy);
    }
  }
  return { removed, pending };
}
