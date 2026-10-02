// Claude 分页的「项目」：【路径制】项目——项目=一个本地
// 工作空间目录，新会话以它为 cwd 运行，transcript 落到 ~/.claude/projects/<路径slug>/。
// 会话→项目的归属【由所在目录推导】（无 assign 表）：不管会话从哪来（手机/桌面/胶囊），
// 必有 cwd，也就必然归到某个项目；ctx.cwd 是恒存在的「工作空间」默认项目，兜住一切
// 没显式选项目的会话。存储按身份隔离：ctx.claudeProjects（admin=ROOT/claude-projects.json）。
//
// 路径授权复用 project-paths（admin 任意本地目录、Pro 限自己空间内）。

import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readJson, writeJson } from './jsonfile.mjs';
import { authorizeProjectPath, projectLocations } from './project-paths.mjs';
import { quickProject } from './claude-quick.mjs';
import { sessionsDir } from './runtime/paths.mjs';
import { listWorktrees } from './claude-worktrees.mjs';

export { authorizeProjectPath, projectLocations };

const MAX_PROJECTS = 200;
const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const samePath = (a, b) => fold(path.resolve(a || '')) === fold(path.resolve(b || ''));

function readStore(file) {
  const data = readJson(file, { projects: [] });
  // 只认 {id,name,path} 齐全的条目（顺带淘汰早期无 path 的组织制旧条目）。
  // order = 侧栏里用户拖出来的显示顺序（项目 id 数组，含默认项目）。只管【显示】：
  // listProjects 的返回顺序（[0] 恒为默认项目）不受它影响——那是后端兜底与归属推导的约定。
  return {
    projects: (Array.isArray(data.projects) ? data.projects : []).filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.path === 'string'),
    order: Array.isArray(data.order) ? data.order.filter((id) => typeof id === 'string') : [],
  };
}

const cleanName = (name, dir) => {
  const fallback = path.basename(dir || '') || '项目';
  return String(name || fallback).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || fallback;
};

// 恒存在的默认项目（path = ctx.cwd，即该身份的工作空间根）。幂等：有就返回，没有就建。
export function ensureDefaultProject(file, ctx) {
  const store = readStore(file);
  const found = store.projects.find((p) => samePath(p.path, ctx.cwd));
  if (found) return found;
  const now = Date.now();
  const project = { id: crypto.randomUUID(), name: '工作空间', path: path.resolve(ctx.cwd), created: now, updated: now };
  store.projects.unshift(project);
  writeJson(file, store, 2);
  return project;
}

// 显示名【固定 = 工作空间文件夹名】（分组按 Claude Code 启动目录的真实文件夹名，
// 不用自定义名）。存储里的 name 保留但不再参与显示；盘根等 basename 为空时退回完整路径。
const dirLabel = (p) => path.basename(path.resolve(p || '')) || String(p || '');

// 默认项目优先，其余按最近更新排序；带 def 标记（默认项目不可删除）。
// 末尾追加「快照对话」那只一次性桶（claude-quick.mjs，带 quick 标记）——它不是用户
// 选的目录，但共用项目那套 cwd/归属/聚合管线，所以在这里一并列出；**必须在 [0] 之后**，
// 调用方（locateSessionProject 的兜底、前端 defId）都认「[0] 恒为默认工作空间」。
export function listProjects(file, ctx) {
  const def = ensureDefaultProject(file, ctx);
  const rest = readStore(file).projects
    .filter((p) => p.id !== def.id)
    .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
  const quick = quickProject(ctx);
  return [
    { ...def, name: dirLabel(def.path), def: true },
    ...rest.map((p) => ({ ...p, name: dirLabel(p.path) })),
    ...(quick ? [quick] : []),
  ];
}

export function getProject(file, ctx, id) {
  return listProjects(file, ctx).find((p) => p.id === String(id || '')) || null;
}

export function createProject(file, ctx, input = {}) {
  const dir = authorizeProjectPath(ctx, input.path);
  const store = readStore(file);
  const same = store.projects.find((p) => samePath(p.path, dir));
  if (same) return same;
  if (store.projects.length >= MAX_PROJECTS) throw Object.assign(new Error('项目数量已达上限'), { status: 400 });
  const now = Date.now();
  const project = { id: crypto.randomUUID(), name: cleanName(input.name, dir), path: dir, created: now, updated: now };
  store.projects.push(project);
  writeJson(file, store, 2);
  return project;
}

export function renameProject(file, id, name) {
  const store = readStore(file);
  const p = store.projects.find((x) => x.id === String(id || ''));
  if (!p) throw Object.assign(new Error('项目不存在'), { status: 404 });
  const clean = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  if (!clean) throw Object.assign(new Error('请输入项目名称'), { status: 400 });
  p.name = clean;
  p.updated = Date.now();
  writeJson(file, store, 2);
  return p;
}

// 删项目=不再列出该目录的会话（transcript 文件原样保留在磁盘，不删）。默认项目不可删。
export function deleteProject(file, ctx, id) {
  const store = readStore(file);
  const pid = String(id || '');
  const p = store.projects.find((x) => x.id === pid);
  if (!p) return false;
  if (samePath(p.path, ctx.cwd)) throw Object.assign(new Error('工作空间项目不可删除'), { status: 400 });
  store.projects = store.projects.filter((x) => x.id !== pid);
  store.order = store.order.filter((x) => x !== pid);
  writeJson(file, store, 2);
  return true;
}

// 侧栏拖放排序：记下用户排好的显示顺序。只收认得的 id（去重、丢掉已删的），默认项目
// 也能排；快照桶不在 store 里、天然排不进来（它在侧栏另占一区）。
export function projectOrder(file) {
  return readStore(file).order;
}
export function setProjectOrder(file, ctx, ids) {
  if (!Array.isArray(ids)) throw Object.assign(new Error('ids 必须是数组'), { status: 400 });
  ensureDefaultProject(file, ctx);
  const store = readStore(file);
  const known = new Set(store.projects.map((p) => p.id));
  const seen = new Set();
  const order = [];
  for (const raw of ids) {
    const id = String(raw || '');
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  store.order = order;
  writeJson(file, store, 2);
  return order;
}

// 会话目录的全集：每个项目自己的 cwd，外加挂在它名下的 worktree 会话 cwd（claude-worktrees.mjs）。
// worktree 那几项的 project 是「所属项目换上 worktree cwd」的副本：id 不变（侧栏照旧归原项目），
// path = worktree cwd（续聊 query cwd / 回滚 / 交付根 / 工作台都吃 project.path，一处换掉全链路一致），
// 另带 worktree:{name,branch,root} 供前端标注。所属项目已删的 worktree 记录不列（与删项目同语义）。
export function sessionScopes(file, ctx, projects = listProjects(file, ctx)) {
  const scopes = projects.map((p) => ({ project: p, path: p.path }));
  const byId = new Map(projects.map((p) => [p.id, p]));
  for (const w of listWorktrees(file)) {
    const p = byId.get(w.projectId);
    if (!p || p.quick) continue;
    scopes.push({ project: { ...p, path: w.cwd, worktree: { name: w.name, branch: w.branch, root: w.root } }, path: w.cwd });
  }
  return scopes;
}

// 会话 id → 所属项目（按 transcript 所在目录推导）。找不到就归默认项目。
// worktree 会话返回的是带 worktree cwd 的项目副本（见 sessionScopes）。
export function locateSessionProject(file, ctx, sessionId) {
  const id = String(sessionId || '');
  if (!/^[0-9a-fA-F-]{8,}$/.test(id)) return null;
  const projects = listProjects(file, ctx);
  for (const s of sessionScopes(file, ctx, projects)) {
    if (existsSync(path.join(sessionsDir(s.path, ctx.configDir), id + '.jsonl'))) return s.project;
  }
  return projects[0] || null;   // [0] 恒为默认项目
}

// 会话 id → 磁盘路径（跨所有项目目录找，含防穿越校验）。给 /api/session|delete|export 用。
export function locateSessionPaths(file, ctx, sessionId) {
  const id = String(sessionId || '');
  if (!/^[0-9a-fA-F-]{8,}$/.test(id)) return null;
  for (const s of sessionScopes(file, ctx)) {
    const dir = sessionsDir(s.path, ctx.configDir);
    const f = path.join(dir, id + '.jsonl');
    if (!path.resolve(f).startsWith(path.resolve(dir) + path.sep)) continue;
    if (existsSync(f)) return { dir, file: f, subdir: path.join(dir, id), project: s.project };
  }
  return null;
}
