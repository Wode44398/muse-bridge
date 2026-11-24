// Antigravity 项目表：复用核心路径授权守卫，每个项目对应主机上的一个工作目录（即 ACP 会话 cwd）。

import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { authorizeProjectPath, projectLocations, fold } from '@bridge/core/project-paths.mjs';

export { authorizeProjectPath, projectLocations };

const MAX_PROJECTS = 200;
const MAX_DISMISSED = 500;

function readStore(file) {
  const data = readJson(file, { projects: [], dismissedPaths: [], order: [] });
  return {
    projects: Array.isArray(data.projects) ? data.projects : [],
    dismissedPaths: Array.isArray(data.dismissedPaths)
      ? data.dismissedPaths.filter((p) => typeof p === 'string' && p.trim())
      : [],
    order: Array.isArray(data.order)
      ? data.order.filter((p) => typeof p === 'string' && p.trim())
      : [],
  };
}

const dirLabel = (p) => path.basename(path.resolve(p || '')) || String(p || '');

function normFold(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  return fold(path.resolve(raw));
}

function cleanName(name, dir) {
  const fallback = dirLabel(dir);
  return String(name || fallback).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || fallback;
}

// 侧栏显示名：用户改过（label）就用它，否则跟着文件夹名走。旧数据里的 name 字段一直没显示过，不拿它当显示名，
// 免得升级后突然冒出一批用户从没见过的名字。改名只动这里，不动磁盘目录：会话按绝对路径绑定，改文件夹会断。
function cleanLabel(label) {
  return String(label || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
}

function formatProject(p) {
  const label = cleanLabel(p.label);
  const out = { ...p, name: label || dirLabel(p.path), folderName: dirLabel(p.path), renamed: Boolean(label), pinned: Boolean(p.pinned) };
  delete out.label;
  if (out.pinned && Number.isFinite(p.pinnedAt)) out.pinnedAt = p.pinnedAt;
  else delete out.pinnedAt;
  return out;
}

function dropDismissed(store, targetPath) {
  const key = normFold(targetPath);
  if (!key) return;
  store.dismissedPaths = store.dismissedPaths.filter((p) => normFold(p) !== key);
}

function addDismissed(store, targetPath) {
  const key = normFold(targetPath);
  if (!key) return false;
  const prevLen = store.dismissedPaths.length;
  const had = store.dismissedPaths.some((p) => normFold(p) === key);
  store.dismissedPaths = [
    ...store.dismissedPaths.filter((p) => normFold(p) !== key),
    key,
  ].slice(-MAX_DISMISSED);
  return !had || store.dismissedPaths.length !== prevLen;
}

export function listProjects(file) {
  if (!file) return [];
  return readStore(file).projects
    .filter((p) => p && typeof p.id === 'string' && typeof p.path === 'string')
    .sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (ap && bp) {
        const dt = (b.pinnedAt || b.updated || b.created || 0) - (a.pinnedAt || a.updated || a.created || 0);
        if (dt !== 0) return dt;
      }
      return (b.updated || b.created || 0) - (a.updated || a.created || 0);
    })
    .map(formatProject);
}

// 被用户从工作空间列表删除 / 忽略过的路径：最近用过目录提取时跳过，避免刚删完又落回「最近用过」
export function listDismissedPaths(file) {
  if (!file) return new Set();
  return new Set(readStore(file).dismissedPaths.map(normFold).filter(Boolean));
}

export function getProject(file, id) {
  if (!file || !id) return null;
  return listProjects(file).find((p) => p.id === String(id)) || null;
}

export function findProjectByPath(file, targetPath) {
  if (!file || !targetPath) return null;
  const target = normFold(targetPath);
  return listProjects(file).find((p) => normFold(p.path) === target) || null;
}

export function createProject(file, ctx, input = {}) {
  const dir = authorizeProjectPath(ctx, input.path);
  const store = readStore(file);
  dropDismissed(store, dir);
  const same = store.projects.find((p) => normFold(p.path) === fold(dir));
  const now = Date.now();
  if (same) {
    same.updated = now;
    if (input.pinned === true) {
      same.pinned = true;
      same.pinnedAt = now;
    }
    writeJson(file, store, 2);
    return formatProject(same);
  }
  if (store.projects.length >= MAX_PROJECTS) {
    throw Object.assign(new Error('项目数量已达上限'), { status: 400 });
  }
  const project = {
    id: crypto.randomUUID(),
    name: cleanName(input.name, dir),
    path: dir,
    created: now,
    updated: now,
    ...(input.pinned === true ? { pinned: true, pinnedAt: now } : {}),
  };
  store.projects.push(project);
  writeJson(file, store, 2);
  return formatProject(project);
}

// 侧栏工作空间手动排序：按规范化目录路径存储，兼容已登记项目与隐式会话目录。
export function projectOrder(file) {
  if (!file) return [];
  return readStore(file).order;
}

export function setProjectOrder(file, _ctx, paths) {
  if (!Array.isArray(paths)) {
    throw Object.assign(new Error('顺序必须为路径数组'), { status: 400 });
  }
  const store = readStore(file);
  const seen = new Set();
  const next = [];
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.replace(/[\u0000-\u001f]/g, '').trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    const resolved = path.resolve(trimmed);
    const key = fold(resolved);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(resolved);
    if (next.length >= MAX_PROJECTS) break;
  }
  store.order = next;
  writeJson(file, store, 2);
  return next;
}

export function pinProject(file, ctx, { id = '', path: targetPath = '', pinned = true } = {}) {
  const pid = String(id || '').trim();
  const rawPath = String(targetPath || '').trim();
  if (!pid && !rawPath) {
    throw Object.assign(new Error('缺少项目 id 或路径'), { status: 400 });
  }
  const store = readStore(file);
  const targetKey = rawPath ? normFold(rawPath) : '';
  const hit = store.projects.find((p) => (pid && p.id === pid) || (targetKey && normFold(p.path) === targetKey));
  if (hit) {
    if (pinned) {
      hit.pinned = true;
      hit.pinnedAt = Date.now();
      dropDismissed(store, hit.path);
      if (store.order.length > 0) {
        const hk = normFold(hit.path);
        store.order = [path.resolve(hit.path), ...store.order.filter((p) => normFold(p) !== hk)].slice(0, MAX_PROJECTS);
      }
    } else {
      delete hit.pinned;
      delete hit.pinnedAt;
    }
    writeJson(file, store, 2);
    return formatProject(hit);
  }
  // 置顶「最近用过」或尚未登记的目录时直接纳入项目表并置顶
  if (pinned && rawPath) {
    const created = createProject(file, ctx, { path: rawPath, pinned: true });
    const after = readStore(file);
    if (after.order.length > 0 && created?.path) {
      const ck = normFold(created.path);
      after.order = [path.resolve(created.path), ...after.order.filter((p) => normFold(p) !== ck)].slice(0, MAX_PROJECTS);
      writeJson(file, after, 2);
    }
    return created;
  }
  if (!pinned && rawPath) return null;
  throw Object.assign(new Error('项目不存在'), { status: 404 });
}

// 改侧栏显示名（不动磁盘目录）。目录还没登记成项目（「最近用过」或只来自历史会话的分组）就先登记再记名字；
// 名字留空或和文件夹名相同 = 恢复成跟着文件夹名走。
export function renameProject(file, ctx, { id = '', path: targetPath = '', name = '' } = {}) {
  const pid = String(id || '').trim();
  const rawPath = String(targetPath || '').trim();
  if (!pid && !rawPath) {
    throw Object.assign(new Error('缺少项目 id 或路径'), { status: 400 });
  }
  let store = readStore(file);
  const targetKey = rawPath ? normFold(rawPath) : '';
  let hit = store.projects.find((p) => (pid && p.id === pid) || (targetKey && normFold(p.path) === targetKey));
  if (!hit) {
    if (!rawPath) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const created = createProject(file, ctx, { path: rawPath });
    store = readStore(file);
    hit = store.projects.find((p) => p.id === created.id);
    if (!hit) throw Object.assign(new Error('项目不存在'), { status: 404 });
  }
  const label = cleanLabel(name);
  if (!label || label === dirLabel(hit.path)) delete hit.label;
  else hit.label = label;
  // 不碰 updated：项目列表按它排序，改个名字不该让项目跳到前面
  writeJson(file, store, 2);
  return formatProject(hit);
}

// 仅从工作空间列表移除并抑制其回流「最近用过」：不删磁盘目录、不删历史对话；磁盘目录已不存在时也允许照常清理。
export function deleteProject(file, _ctx, { id = '', path: targetPath = '' } = {}) {
  const pid = String(id || '').trim();
  const rawPath = String(targetPath || '').trim();
  if (!pid && !rawPath) {
    throw Object.assign(new Error('缺少项目 id 或路径'), { status: 400 });
  }
  const store = readStore(file);
  const targetKey = rawPath ? normFold(rawPath) : '';
  const idx = store.projects.findIndex((p) => (pid && p.id === pid) || (targetKey && normFold(p.path) === targetKey));
  let removed = null;
  if (idx >= 0) {
    removed = store.projects[idx];
    store.projects.splice(idx, 1);
  }
  const dismissTarget = removed?.path || rawPath;
  const dismissedChanged = dismissTarget ? addDismissed(store, dismissTarget) : false;
  let orderChanged = false;
  if (dismissTarget && store.order.length > 0) {
    const dk = normFold(dismissTarget);
    const nextOrder = store.order.filter((p) => normFold(p) !== dk);
    if (nextOrder.length !== store.order.length) {
      store.order = nextOrder;
      orderChanged = true;
    }
  }
  if (removed || dismissedChanged || orderChanged) {
    writeJson(file, store, 2);
  }
  return {
    deleted: Boolean(removed || dismissedChanged),
    project: removed ? formatProject(removed) : null,
    path: dismissTarget,
  };
}
