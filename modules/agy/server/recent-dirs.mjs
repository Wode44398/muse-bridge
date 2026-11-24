// 从历史会话列表中提取「最近用过的目录」候选（按最近活跃时间降序、最多 8 个，剔除不存在或未授权的目录，并对同名目录补父路径提示）。

import { statSync } from 'node:fs';
import path from 'node:path';
import { normalizeAgyPath, foldAgyPath } from './paths.mjs';
import { listProjects, listDismissedPaths, authorizeProjectPath } from './projects.mjs';

function cleanParentSegments(fullPath) {
  const segs = String(fullPath || '').split(/[\\/]+/).filter(Boolean);
  if (segs.length <= 1) return [];
  return segs.slice(0, -1).filter((seg, idx, arr) => {
    // 跳过 iCloud 容器自动生成的 iCloud~md~obsidian 类内部段（保留上层可读目录名如 iCloudDrive）
    if (/^icloud~/i.test(seg) && idx > 0) return false;
    return Boolean(seg);
  });
}

export function disambiguateDirItems(items = []) {
  const byName = new Map();
  for (const item of items) {
    if (!item?.name) continue;
    const key = String(item.name).toLowerCase();
    const arr = byName.get(key) || [];
    arr.push(item);
    byName.set(key, arr);
  }

  for (const group of byName.values()) {
    if (group.length <= 1) continue;
    const ancestors = group.map((g) => cleanParentSegments(g.path));
    for (let i = 0; i < group.length; i++) {
      const anc = ancestors[i];
      if (!anc.length) continue;
      let chosen = anc[anc.length - 1];
      for (let depth = 1; depth <= Math.min(3, anc.length); depth++) {
        const candidate = anc.slice(-depth).join('/');
        const collides = ancestors.some((other, j) => j !== i && other.length >= depth && other.slice(-depth).join('/').toLowerCase() === candidate.toLowerCase());
        if (!collides) {
          chosen = candidate;
          break;
        }
      }
      group[i].parentHint = chosen;
    }
  }
  return items;
}

function defaultDirExists(dirPath) {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function extractRecentSessionDirs(sessions = [], {
  ctx = null,
  projectsFile = '',
  isPseudoCwd = null,
  limit = 8,
  isDirFn = defaultDirExists,
} = {}) {
  const existingProjects = projectsFile ? listProjects(projectsFile) : [];
  const savedKeys = new Set(existingProjects.map((p) => foldAgyPath(p.path)).filter(Boolean));
  const dismissedKeys = projectsFile ? listDismissedPaths(projectsFile) : new Set();
  const byFolded = new Map();

  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    const raw = String(s?.cwd || '').trim();
    if (!raw) continue;
    if (isPseudoCwd && isPseudoCwd(raw)) continue;
    const norm = normalizeAgyPath(raw);
    if (!norm) continue;
    const key = foldAgyPath(norm);
    if (!key || savedKeys.has(key) || dismissedKeys.has(key)) continue;

    const ms = Number(s.updatedMs) || Date.parse(s.updatedAt || '') || 0;
    const prev = byFolded.get(key);
    if (prev) {
      prev.count += 1;
      if (ms > prev.updatedMs) prev.updatedMs = ms;
      continue;
    }

    let authedPath = norm;
    if (ctx) {
      try { authedPath = authorizeProjectPath(ctx, norm); }
      catch { continue; }
    }
    if (!isDirFn(authedPath)) continue;

    byFolded.set(key, {
      path: authedPath,
      name: path.basename(authedPath) || authedPath,
      parentHint: '',
      updatedMs: ms,
      count: 1,
    });
  }

  const top = [...byFolded.values()]
    .sort((a, b) => b.updatedMs - a.updatedMs)
    .slice(0, Math.max(0, limit));

  return disambiguateDirItems(top);
}
