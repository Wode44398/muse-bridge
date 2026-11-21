// Antigravity 会话侧栏分组、同名项目父路径消歧、本地链接解析与终端命令工作目录前缀剥离。

import { t } from '../i18n.js';

function startOfDayMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function timeBucketOf(updatedMs, nowMs = Date.now()) {
  const today0 = startOfDayMs(nowMs);
  const yesterday0 = today0 - 86_400_000;
  if (updatedMs >= today0) return 'today';
  if (updatedMs >= yesterday0) return 'yesterday';
  return 'older';
}

export function timeBucketLabel(bucket) {
  if (bucket === 'today') return t('今天');
  if (bucket === 'yesterday') return t('昨天');
  return t('更早');
}

export function isDaemonPseudoPath(p = '') {
  const norm = String(p || '').trim();
  if (!norm) return false;
  return /(?:^|[\\/])daemon-cwd(?:[\\/]|$)/i.test(norm);
}

function normCmpDir(p = '') {
  let s = String(p || '').trim().replace(/^file:\/\/\/?/i, '/');
  try { if (s.includes('%')) s = decodeURIComponent(s); } catch {}
  s = s.replace(/\\/g, '/');
  if (/^\/[A-Za-z]:(\/|$)/.test(s)) s = s.slice(1);
  if (!/^[A-Za-z]:\/$/.test(s) && s !== '/') s = s.replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}

// 剥离 agy 在执行命令前拼上的 Set-Location "<会话目录>"; 或 cd "<会话目录>" && 前缀，
// 供卡片标题与审批卡紧凑展示真实命令（展开详情里仍保留原始完整命令；切往子目录的 cd 保持原样不剥离）。
export function stripWorkspaceCdPrefix(rawCmd = '', sessionCwd = '') {
  let cur = String(rawCmd || '').trim();
  if (!cur) return '';
  const targetNorm = normCmpDir(sessionCwd);
  for (let step = 0; step < 3; step++) {
    const m = /^(?:Set-Location|Push-Location|chdir|cd|sl)\s+(?:-(?:LiteralPath|Path)\s+|\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:;|&&)\s*([\s\S]+)$/i.exec(cur);
    if (!m) break;
    const dirArg = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    const rest = (m[4] || '').trim();
    if (!rest) break;
    const argNorm = normCmpDir(dirArg);
    const matchesSession = Boolean(targetNorm && argNorm === targetNorm);
    const isAutoAbsSetLoc = !targetNorm && /^Set-Location\s+/i.test(cur) && (/^[A-Za-z]:[\\/]/.test(dirArg) || dirArg.startsWith('/'));
    if (!matchesSession && !isAutoAbsSetLoc) break;
    cur = rest;
  }
  return cur;
}

function cleanAncestorSegments(fullPath) {
  const segs = String(fullPath || '').split(/[\\/]+/).filter(Boolean);
  if (segs.length <= 1) return [];
  return segs.slice(0, -1).filter((seg, idx) => {
    // 过滤 iCloud~md~obsidian 等容器内部段，保留上层可读目录名（如 iCloudDrive）
    if (/^icloud~/i.test(seg) && idx > 0) return false;
    return Boolean(seg);
  });
}

// 对同名项目组（如 D:\Notes 与 ...\iCloudDrive\iCloud~md~obsidian\Claude）计算最短可区分父路径提示
export function disambiguateProjectGroups(groups = []) {
  const byName = new Map();
  for (const g of groups) {
    if (!g || g.unassigned || !g.name) continue;
    const k = String(g.name).toLowerCase();
    const list = byName.get(k) || [];
    list.push(g);
    byName.set(k, list);
  }

  for (const list of byName.values()) {
    if (list.length <= 1) continue;
    const ancList = list.map((g) => cleanAncestorSegments(g.path));
    for (let i = 0; i < list.length; i++) {
      const anc = ancList[i];
      if (!anc.length) continue;
      let hint = anc[anc.length - 1];
      for (let depth = 1; depth <= Math.min(3, anc.length); depth++) {
        const candidate = anc.slice(-depth).join('/');
        const dup = ancList.some((other, j) => j !== i && other.length >= depth && other.slice(-depth).join('/').toLowerCase() === candidate.toLowerCase());
        if (!dup) {
          hint = candidate;
          break;
        }
      }
      list[i].parentHint = hint;
      list[i].displayName = `${list[i].name} · ${hint}`;
    }
  }
  return groups;
}

export function groupSessionsByProjectAndTime(
  sessions = [],
  projects = [],
  query = '',
  nowMs = Date.now(),
  { primaryLimit = 5 } = {}
) {
  const q = String(query || '').trim().toLowerCase();
  const projById = new Map((Array.isArray(projects) ? projects : []).map((p) => [p.id, p]));
  const filtered = (Array.isArray(sessions) ? sessions : []).filter((s) => {
    if (!s || s.hidden) return false;
    const cleanCwd = isDaemonPseudoPath(s.cwd) ? '' : (s.cwd || '');
    if (!q) return true;
    const hay = `${s.title || ''}\n${cleanCwd ? (s.projectName || '') : ''}\n${cleanCwd}`.toLowerCase();
    return hay.includes(q);
  });

  const timeMap = new Map([['today', []], ['yesterday', []], ['older', []]]);
  const projBuckets = new Map();
  // 收藏的会话单独放在侧栏最上面一组，不在下面按文件夹分的组里重复出现（同 Claude 侧栏）
  const favorites = [];

  for (const s of filtered) {
    const ms = Number(s.updatedMs) || Date.parse(s.updatedAt || '') || 0;
    if (s.favorite) { favorites.push(s); continue; }
    const tb = timeBucketOf(ms, nowMs);
    timeMap.get(tb).push(s);

    const cleanCwd = isDaemonPseudoPath(s.cwd) ? '' : String(s.cwd || '').trim();
    const isUnassigned = !s.projectId && !cleanCwd;
    const pid = isUnassigned
      ? '__other__'
      : (s.projectId || `cwd:${cleanCwd.toLowerCase()}`);
    const proj = s.projectId ? projById.get(s.projectId) : null;
    const label = isUnassigned
      ? t('其他')
      : (proj?.name || (cleanCwd && s.projectName && !/^daemon-cwd$/i.test(s.projectName) ? s.projectName : '') || cleanCwd.split(/[\\/]/).filter(Boolean).pop() || t('其他'));
    const pathStr = isUnassigned ? '' : (proj?.path || cleanCwd || '');

    if (!projBuckets.has(pid)) {
      projBuckets.set(pid, {
        key: pid,
        projectId: s.projectId || null,
        name: label,
        path: pathStr,
        unassigned: isUnassigned,
        defaultCollapsed: isUnassigned,
        latestMs: ms,
        sessions: [],
        byTime: new Map([['today', []], ['yesterday', []], ['older', []]]),
      });
    }
    const group = projBuckets.get(pid);
    if (ms > group.latestMs) group.latestMs = ms;
    group.sessions.push(s);
    group.byTime.get(tb).push(s);
  }

  // 未归属目录的「其他」分组始终排在侧栏底部且默认折叠，不抢真实项目的首位
  const byProject = [...projBuckets.values()]
    .sort((a, b) => {
      if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
      return b.latestMs - a.latestMs;
    })
    .map((g) => ({
      key: g.key,
      projectId: g.projectId,
      name: g.name,
      displayName: g.name,
      parentHint: '',
      path: g.path,
      unassigned: g.unassigned,
      defaultCollapsed: g.defaultCollapsed,
      count: g.sessions.length,
      timeGroups: ['today', 'yesterday', 'older']
        .filter((k) => g.byTime.get(k).length > 0)
        .map((k) => ({ key: k, label: timeBucketLabel(k), items: g.byTime.get(k) })),
    }));

  disambiguateProjectGroups(byProject);

  const realGroups = byProject.filter((g) => !g.unassigned);
  const otherProjects = byProject.filter((g) => g.unassigned);
  const cap = Math.max(1, Number(primaryLimit) || 5);
  const primaryProjects = realGroups.slice(0, cap);
  const moreProjects = realGroups.slice(cap).map((g) => ({ ...g, defaultCollapsed: true }));

  const byTime = ['today', 'yesterday', 'older']
    .filter((k) => timeMap.get(k).length > 0)
    .map((k) => ({ key: k, label: timeBucketLabel(k), items: timeMap.get(k) }));

  return {
    total: filtered.length,
    favorites,
    byProject,
    primaryProjects,
    moreProjects,
    otherProjects,
    byTime,
  };
}

export function resolveAgyLocalLink(href = '', sessionCwd = '') {
  let raw = String(href || '').trim();
  if (!raw || /^(?:https?:|mailto:|tel:|data:|javascript:|#)/i.test(raw)) return null;
  if (/^file:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      raw = decodeURIComponent(u.pathname || '');
      if (/^\/[A-Za-z]:/.test(raw)) raw = raw.slice(1);
    } catch {}
  } else {
    try { raw = decodeURIComponent(raw); } catch {}
    if (/^\/[A-Za-z]:[\\/]/.test(raw)) raw = raw.slice(1);
  }
  raw = raw.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
  if (!raw) return null;
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')) {
    return raw;
  }
  if (!sessionCwd) return raw;
  const sep = sessionCwd.includes('\\') ? '\\' : '/';
  return sessionCwd.replace(/[\\/]+$/, '') + sep + raw.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
}
