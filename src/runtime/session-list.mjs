// Claude 会话文件全集（2026-10-20 从 /api/sessions 抽出来，列表 / 全文搜索 / 自动归档三处共用）。
//
// 项目制：会话分散在各项目的 transcript 目录里（cwd slug），逐项目目录聚合。会话→项目的归属由所在
// 目录推导（见 claude-projects.mjs 头注）。worktree 会话（输入栏 worktree 勾选框开出来的、Desktop 派生的）
// 的 transcript 在 worktree cwd 的目录里，sessionScopes 把它们并进所属项目：projectId 仍是原项目，
// 另带 wt（cwd/分支）给前端工作台定位。
// 临时对话桶（claude-quick.mjs）：全部列出，单独放 quickFiles（侧栏单独一区，不参与 60 条截断、不归档）——
// 以前只列最新一条，其余的从列表和搜索里一起消失（S1-6）。数量由按时间回收兜住（30 天没动就进回收站）。
//
// 2026-10-21 性能：以前每个请求都同步 readdirSync + 逐文件 statSync（本机 46 个目录、434 个 jsonl，单次 100–650ms，
// 整段占住事件循环；开一次 Claude 页首页 + 5 个项目翻页同时到，整台服务冻 0.7–2.4 秒，流式输出、总线全跟着卡）。
// 请求路径一律改走 listSessionFilesAsync：
//   · fsp.readdir + 限并发的 fsp.stat，在 libuv 线程池里跑，不占主线程；
//   · 按身份短缓存（TTL 2s）+ 单飞：同一时刻的并发请求（首页、各项目翻页、标题预热、搜索）共用一次扫盘；
//   · 作废：transcript 目录 watcher 播出真实写入（session-watch.mjs）、删会话时调 invalidateSessionFiles()；
//     watcher 覆盖不到的（没人订阅总线、刚建的项目目录）靠 2s TTL 兜住。
// 同步版 listSessionFiles 原样保留（单测、归档按钮这类低频调用方），不读也不写缓存。
import path from 'node:path';
import { readdirSync, statSync, promises as fsp } from 'node:fs';
import * as claudeProjects from '../claude-projects.mjs';
import { sessionsDir } from './paths.mjs';

const TTL = 2000;
const STAT_CONCURRENCY = 16;

// 要扫的目录（同一个目录被两个 scope 覆盖不该发生，防重复行）+ 项目表。项目表是几份小 JSON 的同步读，几毫秒，不拆。
function plan(ctx) {
  const scopes = claudeProjects.sessionScopes(ctx.claudeProjects, ctx);
  const projects = new Map();
  const dirs = [];
  const seen = new Set();
  for (const { project: p } of scopes) {
    if (!projects.has(p.id) && !p.worktree) projects.set(p.id, p);
    const dir = sessionsDir(p.path, ctx.configDir);
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push({ p, dir });
  }
  return { projects, dirs };
}

const row = (p, dir, name, st) => ({
  id: name.slice(0, -6), file: path.join(dir, name), mtime: st ? st.mtimeMs : 0, size: st ? st.size : 0,
  projectId: p.id, wt: p.worktree ? { cwd: p.path, branch: p.worktree.branch } : undefined,
});

// found = [{ p, rows }]（按 scope 顺序）→ 对外形状
function assemble(projects, found) {
  const files = [];
  const quickFiles = [];
  for (const { p, rows } of found) (p.quick ? quickFiles : files).push(...rows);
  files.sort((a, b) => b.mtime - a.mtime);
  quickFiles.sort((a, b) => b.mtime - a.mtime);
  return { files, quickFiles, projects };
}

/**
 * → { files, quickFiles, projects }
 *   files：非快照会话，按 transcript mtime 倒序；元素 { id, file, mtime, size, projectId, wt? }
 *   projects：项目 id → 项目（显示名等，搜索结果要用）
 * 同步现扫（会占住事件循环）：请求路径用 listSessionFilesAsync。
 */
export function listSessionFiles(ctx) {
  const { projects, dirs } = plan(ctx);
  const found = [];
  for (const { p, dir } of dirs) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const rows = [];
    for (const d of entries) {
      if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
      let st = null;
      try { st = statSync(path.join(dir, d.name)); } catch {}
      rows.push(row(p, dir, d.name, st));
    }
    found.push({ p, rows });
  }
  return assemble(projects, found);
}

async function scanAsync(ctx) {
  const { projects, dirs } = plan(ctx);
  const lists = await Promise.all(dirs.map(async ({ p, dir }) => {
    try {
      const names = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && d.name.endsWith('.jsonl')).map((d) => d.name);
      return { p, dir, names, rows: new Array(names.length) };
    } catch { return null; }
  }));
  const jobs = [];
  const found = [];
  for (const l of lists) {
    if (!l) continue;
    found.push(l);
    for (let i = 0; i < l.names.length; i++) jobs.push([l, i]);
  }
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [l, i] = jobs[next++];
      let st = null;
      try { st = await fsp.stat(path.join(l.dir, l.names[i])); } catch {}
      l.rows[i] = row(l.p, l.dir, l.names[i], st);
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, jobs.length) }, worker));
  // 会话 id → { file, project }（scope 顺序先到先得，同 locateSessionPaths）
  const located = new Map();
  for (const l of found) for (const r of l.rows) if (r && !located.has(r.id)) located.set(r.id, { file: r.file, project: l.p });
  const data = assemble(projects, found);
  data.located = located;
  return data;
}

// 缓存：键 = 身份 + 工作空间根 + 配置目录 + 项目表（一轮的 ctx 会把 cwd 换成项目目录，默认项目跟着变，分开记）
const cache = new Map();   // key -> { at, epoch, data, pending, pendingEpoch }
let epoch = 0;
const keyOf = (ctx) => [ctx.key || '', ctx.cwd || '', ctx.configDir || '', ctx.claudeProjects || ''].join('\0');
// 数组拷一份再给出去（调用方会 push / sort），元素对象共用——调用方只读不改
const view = (d) => ({ files: d.files.slice(), quickFiles: d.quickFiles.slice(), projects: d.projects });

/**
 * listSessionFiles 的异步 + 缓存版（请求路径都走它）。maxAge：缓存比它新就直接用（默认 2s）。
 * 扫盘途中被作废（watcher 播出了写入）：结果照样回给这一批等着的请求，下一次请求重扫。
 */
export function listSessionFilesAsync(ctx, { maxAge = TTL } = {}) {
  const k = keyOf(ctx);
  let c = cache.get(k);
  if (!c) { c = { at: 0, epoch: -1, data: null, pending: null, pendingEpoch: -1 }; cache.set(k, c); }
  if (c.data && c.epoch === epoch && Date.now() - c.at <= maxAge) return Promise.resolve(view(c.data));
  if (c.pending && c.pendingEpoch === epoch) return c.pending.then(view);
  const mine = epoch;
  const startedAt = Date.now();
  const p = scanAsync(ctx).then((data) => {
    if (c.pending === p) c.pending = null;
    // 扫的途中作废过：照样记下（epoch 对不上，下一次请求会重扫；peekSessionFile 还能用它定位）
    if (startedAt >= c.at) { c.data = data; c.at = startedAt; c.epoch = mine; }
    return data;
  }, (e) => { if (c.pending === p) c.pending = null; throw e; });
  c.pending = p;
  c.pendingEpoch = mine;
  return p.then(view);
}

/**
 * 不扫盘，只在最近一次异步扫盘的结果里找这个会话（60s 内的、作废过的也认）→ { file, project } 或 null。
 * 给 /api/session 这类热路径省掉 locateSessionPaths 的逐目录同步 existsSync；调用方要自己确认文件还在，找不到再走老路。
 */
export function peekSessionFile(ctx, id) {
  const c = cache.get(keyOf(ctx));
  if (!c || !c.data || !c.data.located || Date.now() - c.at > 60_000) return null;
  return c.data.located.get(String(id || '')) || null;
}

/** transcript 有了真实变化（新建 / 写入 / 删除）：所有身份的缓存一起作废（下一次请求重扫，代价就是一次异步扫盘）。 */
export function invalidateSessionFiles() {
  epoch++;
  if (cache.size > 64) cache.clear();   // 键里带 cwd，长跑下来会攒一些一次性的键
}
