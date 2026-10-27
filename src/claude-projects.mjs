// Claude 分页的「项目」：与 codex-projects 同构的【路径制】项目——项目=一个本地
// 工作空间目录，新会话以它为 cwd 运行，transcript 落到 ~/.claude/projects/<路径slug>/。
// 会话→项目的归属【由所在目录推导】（无 assign 表）：不管会话从哪来（手机/桌面/胶囊），
// 必有 cwd，也就必然归到某个项目；ctx.cwd 是恒存在的「工作空间」默认项目，兜住一切
// 没显式选项目的会话。存储按身份隔离：ctx.claudeProjects（admin=ROOT/claude-projects.json）。
//
// 路径授权复用核心 project-paths（admin 任意本地目录、Pro 限自己空间内）。

import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readJson, writeJson } from './jsonfile.mjs';
import { authorizeProjectPath, projectLocations } from './project-paths.mjs';
import { quickProject, quickProjects, adoptQuickBucket, inQuickRoots } from './claude-quick.mjs';
import { relocateSavedQuick } from './claude-quick-relocate.mjs';
import { sessionsDir } from './runtime/paths.mjs';
import { listWorktrees } from './claude-worktrees.mjs';
import { lineageFor } from './runtime/desktop-lineage.mjs';

export { authorizeProjectPath, projectLocations };

const MAX_PROJECTS = 200;
const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const samePath = (a, b) => fold(path.resolve(a || '')) === fold(path.resolve(b || ''));

function readStore(file) {
  const data = readJson(file, { projects: [] });
  // 只认 {id,name,path} 齐全的条目（顺带淘汰早期无 path 的组织制旧条目）。
  // order = 侧栏里用户拖出来的显示顺序（项目 id 数组，含默认项目）。只管【显示】：
  // listProjects 的返回顺序（[0] 恒为默认项目）不受它影响——那是后端兜底与归属推导的约定。
  // quickSeq = 「快照存为工作空间」的编号计数（只增不减，删了也不复用），随整张表读写带着走。
  return {
    projects: (Array.isArray(data.projects) ? data.projects : []).filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.path === 'string'),
    order: Array.isArray(data.order) ? data.order.filter((id) => typeof id === 'string') : [],
    quickSeq: Number.isInteger(data.quickSeq) && data.quickSeq > 0 ? data.quickSeq : 0,
  };
}

const cleanName = (name, dir) => {
  const fallback = path.basename(dir || '') || '项目';
  return String(name || fallback).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || fallback;
};

// 「一轮的 ctx」（chat 路由把 cwd 覆写成项目 / worktree 目录，homeRoot 留着身份原本的根）→ 身份本身的 ctx。
// 按会话查项目表（locateSessionPaths / locateSessionProject / listProjects）一律该用它：拿 worktree 目录当 cwd
// 去查，ensureDefaultProject 找不到同路径的项目就会新建一个「工作空间」幽灵项目插到表头。
export const identityCtx = (ctx) => (ctx && ctx.homeRoot ? { ...ctx, cwd: ctx.homeRoot, homeRoot: undefined, worktree: undefined } : ctx);

// 早先被 worktree 目录当 cwd 误建出来的幽灵默认项目：名字是硬编码的「工作空间」、没改过名、路径是
// <某个已有项目>/.claude/worktrees/<名>。读表时顺手清掉（它不对应任何用户操作；worktree 里的会话本来就由
// worktree 登记表 / Desktop 血缘并进所属项目）。
const WT_TAIL = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/;
function dropGhostDefaults(store, ctx) {
  const ghost = (p) => p.name === '工作空间' && !p.label && WT_TAIL.test(p.path) && !samePath(p.path, ctx.homeRoot || ctx.cwd)
    && store.projects.some((q) => q !== p && samePath(q.path, path.dirname(path.dirname(path.dirname(path.resolve(p.path))))));
  const bad = store.projects.filter(ghost);
  if (!bad.length) return false;
  const ids = new Set(bad.map((p) => p.id));
  store.projects = store.projects.filter((p) => !ids.has(p.id));
  store.order = store.order.filter((id) => !ids.has(id));
  return true;
}

// 恒存在的默认项目（path = ctx.cwd，即该身份的工作空间根）。幂等：有就返回，没有就建。
// 一轮的 ctx（带 homeRoot）cwd 不在表里（worktree 目录）：不拿它建项目，按身份的根找 / 建。
export function ensureDefaultProject(file, ctx) {
  const store = readStore(file);
  const dirty = dropGhostDefaults(store, ctx);
  let found = store.projects.find((p) => samePath(p.path, ctx.cwd));
  if (!found && ctx.homeRoot) { ctx = identityCtx(ctx); found = store.projects.find((p) => samePath(p.path, ctx.cwd)); }
  if (found) { if (dirty) writeJson(file, store, 2); return found; }
  const now = Date.now();
  const project = { id: crypto.randomUUID(), name: '工作空间', path: path.resolve(ctx.cwd), created: now, updated: now };
  store.projects.unshift(project);
  writeJson(file, store, 2);
  return project;
}

// 显示名：默认 = 工作空间文件夹名（分组按 Claude Code 启动目录的真实文件夹名）；用户改过名
//（label，2026-10-10 维护者要的「给工作空间改名」）就显示 label。存储里的 name 是建项目时的
// 遗留字段，不参与显示——别拿它当显示名（老条目里可能是早年的自定义名）。盘根等 basename
// 为空时退回完整路径。快照存成的工作空间桶目录名是 UUID，所以存的时候就带上 label。
const dirLabel = (p) => path.basename(path.resolve(p || '')) || String(p || '');
const labelOf = (p) => (typeof p.label === 'string' && p.label) || dirLabel(p.path);

// 默认项目优先，其余按最近更新排序；带 def 标记（默认项目不可删除）。
// 末尾追加全部还留着的「临时对话」桶（claude-quick.mjs，带 quick 标记；开新临时对话用的那只空桶带
// current、排在它们最前）——它们不是用户选的目录，但共用项目那套 cwd/归属/聚合管线，所以在这里一并列出；
// **必须在 [0] 之后**，调用方（locateSessionProject 的兜底、前端 defId）都认「[0] 恒为默认工作空间」。
export function listProjects(file, ctx) {
  const def = ensureDefaultProject(file, ctx);
  const rest = readStore(file).projects
    .filter((p) => p.id !== def.id)
    .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
  return [
    { ...def, name: labelOf(def), def: true },
    ...rest.map((p) => ({ ...p, name: labelOf(p) })),
    ...quickProjects(ctx),
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

// 改名只改显示名（label），不动目录、不动会话；留空 = 恢复成文件夹名。默认工作空间也能改。
// 不碰 updated——改个名不该让它在列表里跳位。快照桶不在表里，天然改不了（404）。
export function renameProject(file, ctx, id, name) {
  ensureDefaultProject(file, ctx);
  const store = readStore(file);
  const p = store.projects.find((x) => x.id === String(id || ''));
  if (!p) throw Object.assign(new Error('项目不存在'), { status: 404 });
  const clean = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  if (clean && clean !== dirLabel(p.path)) p.label = clean;
  else delete p.label;
  writeJson(file, store, 2);
  return { ...p, name: labelOf(p), ...(samePath(p.path, ctx.cwd) ? { def: true } : {}) };
}

// 「临时对话存为工作空间」：把某只临时对话桶原地登记成一枚普通项目（随后由 relocateSavedQuicks 挪到固定位置）。
//   · 先不搬家：transcript 按 cwd slug 落盘、续聊 query 吃的也是这个 cwd，登记与搬家分两步，搬不动就原地留着；
//   · 项目 id 沿用桶 id：前端手里那条会话的 projectId 原样有效，只是它所属的项目摘掉了
//     quick 标记——会话自然从「临时对话」区落进项目列表，正开着的对话不用重开；
//   · 从此不再是临时对话：pruneQuick 跳过登记在项目表里的桶，不再按时间回收；桶里所有 transcript 都按普通项目列出；
//   · 显示名：给了 label（前端传那条对话的标题）就用它；否则「<base> <编号>」，base 由前端按界面语言给，编号只增不减；
//   · id = 要存的那只桶（会话行的 projectId）。不给 id 时存 store 里记的当前桶（老前端只会存它，语义不变）；
//     那只桶已经不在了（别的设备刚存走 / 回收了）回 409。存的正好是当前桶时，当前桶位顺手换上一只新的空桶。
export function saveQuickProject(file, ctx, { id, expectId, base, label } = {}) {
  // 先读 store 再列桶：列桶时用过的当前桶会被换掉，store 随之指向新的空桶
  const stored = readJson(path.join(ctx.dataDir || '', 'claude-quick.json'), null);
  const want = String(id || expectId || (stored && typeof stored.id === 'string' ? stored.id : '') || '');
  const all = quickProjects(ctx);
  if (!all.length) throw Object.assign(new Error('该身份不支持临时对话'), { status: 403 });
  const cur = all.find((p) => p.id === want) || null;
  ensureDefaultProject(file, ctx);
  const store = readStore(file);
  if (store.projects.some((p) => p.id === want)) throw Object.assign(new Error('这个临时对话已经存为工作空间了'), { status: 409 });
  if (!cur) throw Object.assign(new Error('这个临时对话已经不在了，请刷新后再试'), { status: 409 });
  if (store.projects.some((p) => samePath(p.path, cur.path))) throw Object.assign(new Error('这个临时对话已经存为工作空间了'), { status: 409 });
  if (store.projects.length >= MAX_PROJECTS) throw Object.assign(new Error('项目数量已达上限'), { status: 400 });
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
  let name = clean(label, 80);
  let seq = store.quickSeq;
  if (!name) {
    seq += 1;
    name = `${clean(base, 40) || '存下的对话'} ${seq}`;
  }
  const now = Date.now();
  const project = { id: cur.id, name, label: name, path: cur.path, created: now, updated: now, fromQuick: true };
  store.projects.push(project);
  store.quickSeq = seq;
  writeJson(file, store, 2);
  adoptQuickBucket(cur.path);
  return { project: { ...project }, quick: quickProject(ctx) };
}

// 存好的工作空间挪出临时对话地盘（claude-quick-relocate.mjs）：项目表里还躺在桶根下的条目逐个挪到
// 固定位置并改写 path（id、label 都不变，前端会话的 projectId 原样有效）。存的当下（/quick/save）跑一次；
// 10-21 之前存的、或当时有会话在跑没挪成的，由会话列表接口节流补跑。返回挪成的 [{id, path}]。
//   新目录名见 savedDirName。
export async function relocateSavedQuicks(file, ctx, opts = {}) {
  const done = [];
  for (const p of readStore(file).projects) {
    if (samePath(p.path, ctx.cwd) || !inQuickRoots(ctx, p.path)) continue;
    const to = await relocateSavedQuick(ctx, p.path, { ...opts, name: savedDirName(p.label, p.id) });
    if (!to) continue;
    const store = readStore(file);   // 挪目录期间表可能被别的请求改过：重读再写
    const cur = store.projects.find((x) => x.id === p.id);
    if (!cur) continue;
    cur.path = to;
    writeJson(file, store, 2);
    done.push({ id: p.id, path: to });
  }
  return done;
}
// 存好的工作空间挪过去叫什么（会出现在工作台路径和面包屑里，所以要像个名字）：
//   · 标题里的英文 / 数字词连成 ASCII 短名（「介绍 iPhone 17」→ iphone-17，「Top 10 清单」→ top-10）；
//   · 标题里没有英文字母（纯中文、只有数字，如「对比 2025 和 2026 财报」「快照会话 3」）→ chat-<id 前 8 位>。
// 必须是 ASCII：transcript 目录按 cwd 把非字母数字全换成 -（runtime/paths.mjs），中文名彼此会撞同一个目录。
// 不再从标题末尾截数字当编号（以前的 snapshot-<n>：标题以数字结尾时既不是编号、也和对话对不上）。重名由挪的那一步加 -2。
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
export function savedDirName(label, id) {
  const words = String(label || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || [];
  let slug = '';
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 40) break;
    slug = next;
  }
  if (!/[a-z]/.test(slug) || WIN_RESERVED.test(slug)) return `chat-${String(id || '').slice(0, 8) || 'saved'}`;
  return slug;
}

const relocState = new Map();   // ctx.key -> { at, running }
export function scheduleRelocateSavedQuicks(file, ctx, opts = {}) {
  const key = ctx.key || ctx.kind;
  const st = relocState.get(key) || { at: 0, running: false };
  if (st.running || Date.now() - st.at < 5 * 60 * 1000) return;
  st.running = true; st.at = Date.now(); relocState.set(key, st);
  relocateSavedQuicks(file, ctx, opts)
    .then((r) => { if (r.length) console.log(`[quick] 存好的工作空间挪出临时对话目录：${r.map((x) => x.path).join('、')}`); })
    .catch((e) => console.warn('[quick] relocate failed:', e?.message || e))
    .finally(() => { st.running = false; });
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
  // 官方 Desktop 派生的子会话（start_session / 建议任务卡）多半各开一个 worktree：
  // <仓库根>/.claude/worktrees/<名>。它们不在上面那张 bridge 自己的登记表里，不补扫就整条看不见。
  // 只收参与血缘（根或子）的会话，且仓库根正好是某个项目的路径——与 bridge 自开 worktree 同形制并进该项目。
  const lin = lineageFor(ctx);
  if (lin.members.size) {
    const have = new Set(scopes.map((s) => foldPath(s.path)));
    const byRoot = new Map(projects.filter((p) => !p.quick && p.path).map((p) => [foldPath(p.path), p]));
    for (const m of lin.members.values()) {
      const cwd = m.cwd;
      if (!cwd || have.has(foldPath(cwd))) continue;
      const wtDir = path.dirname(cwd);
      if (path.basename(wtDir) !== 'worktrees' || path.basename(path.dirname(wtDir)) !== '.claude') continue;
      const root = path.dirname(path.dirname(wtDir));
      const p = byRoot.get(foldPath(root));
      if (!p) continue;
      have.add(foldPath(cwd));
      scopes.push({ project: { ...p, path: cwd, worktree: { name: m.wtName || path.basename(cwd), branch: m.branch, root }, desktop: true }, path: cwd });
    }
  }
  return scopes;
}

const foldPath = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };

// 会话 id → 它的 transcript 落在哪个 scope（逐 scope 同步 existsSync，scope 顺序先到先得）。
// 临时对话一条一只桶、每只桶一枚 scope 排在最后，30 天的窗口里能攒到几百只——续聊、打开、会话信息面板每次都
// 从头试一遍太浪费：记下上次在哪个目录找到的（按项目表文件 + 会话 id），下次先试它；文件不在了 / 那个 scope
// 不在了就退回逐个找。只是提示，不改结果：先试的那个命中了，从头找第一个命中的也是它（同一个 id 不会落两处）。
const locHint = new Map();   // `${file}\0${id}` -> foldPath(scope.path)
function findScope(file, ctx, id, scopes) {
  const k = `${file}\0${id}`;
  const hint = locHint.get(k);
  const tried = hint ? scopes.filter((s) => foldPath(s.path) === hint) : [];
  for (const s of [...tried, ...scopes]) {
    const dir = sessionsDir(s.path, ctx.configDir);
    const f = path.join(dir, id + '.jsonl');
    if (!path.resolve(f).startsWith(path.resolve(dir) + path.sep)) continue;
    if (!existsSync(f)) continue;
    if (locHint.size > 4000) locHint.clear();
    locHint.set(k, foldPath(s.path));
    return { scope: s, dir, file: f };
  }
  locHint.delete(k);
  return null;
}

// 会话 id → 所属项目（按 transcript 所在目录推导）。找不到就归默认项目。
// worktree 会话返回的是带 worktree cwd 的项目副本（见 sessionScopes）。
export function locateSessionProject(file, ctx, sessionId) {
  const id = String(sessionId || '');
  if (!/^[0-9a-fA-F-]{8,}$/.test(id)) return null;
  const projects = listProjects(file, ctx);
  const hit = findScope(file, ctx, id, sessionScopes(file, ctx, projects));
  if (hit) return hit.scope.project;
  return projects[0] || null;   // [0] 恒为默认项目
}

// 会话 id → 磁盘路径（跨所有项目目录找，含防穿越校验）。给 /api/session|delete|export 用。
export function locateSessionPaths(file, ctx, sessionId) {
  const id = String(sessionId || '');
  if (!/^[0-9a-fA-F-]{8,}$/.test(id)) return null;
  const hit = findScope(file, ctx, id, sessionScopes(file, ctx));
  return hit ? { dir: hit.dir, file: hit.file, subdir: path.join(hit.dir, id), project: hit.scope.project } : null;
}
