// 官方 Claude Desktop 的「子会话树」血缘，借给 bridge 的 Claude 侧栏用（2026-10-14，Desktop 2.37337）。
//
// 官方把父会话派生出来的会话（Claude 用 start_session 开的、交接出去的、点建议任务卡开的、fork 的）
// 缩进挂在父会话下面。血缘只存在 Desktop 本地的会话元数据里：
//   <Desktop 数据目录>/claude-code-sessions/<账号>/<org>/local_<uuid>.json
// 子会话上记着 spawnedFrom{sessionId(父的 local_ id), sideSession?, userFork?, handOff?}、
// forkedFromSessionId、lineageDetached（用户点了「移到顶层」）。cliSessionId 就是
// ~/.claude/projects/<slug>/<id>.jsonl 的文件名——也就是 bridge 会话列表里的 id。
//
// 数据目录（2026-10-20 修）：Desktop 3.x（MSIX）把用户数据搬到了
//   %LOCALAPPDATA%\Claude-Data\claude_<包族名后缀>\  （本机 claude_pzs8sxrjxfjjc）
// 旧的 %APPDATA%\Claude\ 只剩一个 0 字节的 .user-data-left.* 标记——bridge 一直读旧路径，10-14 起
// 血缘树、Desktop worktree 补扫、Desktop 标题三样全空。官方主进程自己写明数据目录可能叫
// Claude-Data / Claude-3p / Claude，在 %LOCALAPPDATA% 或 %APPDATA% 下：这里按候选列表探测、存在的都扫
//（包名后缀不写死，按 Claude-Data\claude_* 找）；BRIDGE_DESKTOP_SESSIONS_DIR 覆盖仍有效（可用 path.delimiter 分多个）。
// 不扫 claude-code-sessions-backup-*（Desktop 迁移时留的备份）。
//
// 规则照抄官方：
//   · 认父（app.asar 主进程的 q_）：lineageDetached→无父；spawnedFrom.sideSession 且非 userFork、
//     且没有指向别处的 forkedFromSessionId → spawnedFrom.sessionId；否则有 forkedFromSessionId → 它；
//     否则有 spawnedFrom（老数据没有 sideSession 标志，官方当 suggested_task 照样挂）→ spawnedFrom.sessionId。
//   · 摆树（ion-dist shared-11 的 $C）：一路上溯到最顶层祖先，所有后代都只缩进一级挂在根下；环检测。
// 血缘本身不看 isArchived——父在列表里就挂；Desktop 的归档态另外抽成 archived 集合，由 bridge 的归档
//（session-archive-auto.mjs 的 archiveView，设置「跟随 Claude Desktop 的归档」）决定列表里藏不藏。
//
// 同一会话在多个账号目录里各存一份（本机 4 个账号目录），副本之间 isArchived 可能不一致——归档不改
// lastActivityAt，按 at 比是平局、旧逻辑取「最后遍历到的」等于随机。现在先比 at、平局再比【文件 mtime】：
// 实测 156 个分歧会话按文件 mtime 取最新那份全部正确。
//
// 侧边对话（2026-10-21）：Desktop 的「侧边对话」（/btw，旁路问一句不打断主线）也是一条 fork 出来的会话，
// spawnedFrom 带 btw:true、userFork:true。官方 isBtwChild（btw 且没 lineageDetached）不进侧栏、不进相关会话名单，
// 只在父会话的侧边面板里出现。bridge 原先不认 btw，把它当普通分叉挂在父会话下——内容和父会话前半截一模一样。
// 现在单独抽成 btw 集合（不进 rootOf / parentOf / members），会话列表据此不列。
//
// 体量：本机 1600+ 个元数据文件、每个几百 KB（中段是整份远程 MCP 配置），合计六百 MB。
// 所以只在后台增量扫：按 mtime+size 缓存每个文件抽出来的那几个字段、落盘，重启后不必重读；
// 之后每轮只重读变了的文件。对外同步返回最近一次算好的快照（首轮扫完前是空的，下一次刷新就有）。

import os from 'node:os';
import path from 'node:path';
import { promises as fsp, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';

const REFRESH_MS = 15_000;
const CACHE_VERSION = 4;   // 2：记录里多了 title；3：多根目录 + arch / ts / alt，缓存条目带文件 mtime 断平局；4：sf.btw
const MAX_DEPTH = 32;   // 官方同款上溯上限
const READ_CONCURRENCY = 4;
const PROBE_MS = 60_000;   // 候选目录多久重探一次（Desktop 装上 / 迁移之后不用重启 bridge）

const readdirSafe = (p) => { try { return readdirSync(p); } catch { return []; } };

// 存在的 Desktop 会话元数据根目录（可能多个）。exists 可注入（单测）。
export function desktopSessionsDirs(env = process.env, platform = process.platform, { exists = existsSync, readdir = readdirSafe } = {}) {
  if (env.BRIDGE_DESKTOP_SESSIONS_DIR) return String(env.BRIDGE_DESKTOP_SESSIONS_DIR).split(path.delimiter).filter(Boolean);
  const out = [];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA, roam = env.APPDATA;
    if (local) {
      const base = path.join(local, 'Claude-Data');
      // MSIX：Claude-Data\claude_<包族名后缀>\claude-code-sessions（后缀随发行渠道变，不写死）
      for (const d of readdir(base)) if (/^claude_/i.test(d)) out.push(path.join(base, d, 'claude-code-sessions'));
      out.push(path.join(base, 'claude-code-sessions'));
      out.push(path.join(local, 'Claude-3p', 'claude-code-sessions'));
    }
    if (roam) out.push(path.join(roam, 'Claude', 'claude-code-sessions'));   // 旧版非 MSIX
  } else if (platform === 'darwin') {
    const sup = path.join(os.homedir(), 'Library', 'Application Support');
    out.push(path.join(sup, 'Claude', 'claude-code-sessions'), path.join(sup, 'Claude-3p', 'claude-code-sessions'));
  } else {
    const cfg = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    out.push(path.join(cfg, 'Claude', 'claude-code-sessions'), path.join(cfg, 'Claude-3p', 'claude-code-sessions'));
  }
  return out.filter((p) => exists(p));
}

// 旧接口（单目录）：取探测到的第一个；没有就 null。
export function defaultDesktopSessionsDir(env = process.env, platform = process.platform) {
  return desktopSessionsDirs(env, platform)[0] || null;
}

const str = (v) => (typeof v === 'string' && v ? v : undefined);

// 一份元数据 → 只留算血缘、定位 worktree、显示标题、归档态要用的字段（缓存里只存这些）。
//   title：Desktop 侧栏标题；没有就用派生那一刻的任务名 spawnedFrom.title（官方二者本机 100% 相同）
//   ts：titleSource（auto | user | tool）；arch：Desktop 里已归档
//   lf：lastFocusedAt（用户最后一次在 Desktop 里看它；Desktop 取消归档时也把它置成当下）
//   alt：同一会话 clear / resume 之前用过的 cli id（priorCliSessionIds 等）——那段旧 transcript 也认这条元数据
export function pickRecord(d) {
  if (!d || typeof d !== 'object' || !str(d.sessionId)) return null;
  const sf = d.spawnedFrom && typeof d.spawnedFrom === 'object' && str(d.spawnedFrom.sessionId) ? d.spawnedFrom : null;
  const cli = str(d.cliSessionId);
  const alt = [...new Set([
    ...(Array.isArray(d.priorCliSessionIds) ? d.priorCliSessionIds : []),
    d.unarchivedCliSessionId, d.preClearCliSessionId,
  ].filter((x) => str(x) && x !== cli))].slice(0, 20);
  return {
    id: d.sessionId,
    cli,
    cwd: str(d.cwd),
    branch: str(d.branch),
    wtName: str(d.worktreeName),
    title: str(d.title) || (sf ? str(sf.title) : undefined),
    at: Number(d.lastActivityAt) || Number(d.createdAt) || 0,
    ...(Number(d.lastFocusedAt) > 0 ? { lf: Number(d.lastFocusedAt) } : {}),
    ...(sf ? { sf: { id: sf.sessionId, side: sf.sideSession === true, userFork: sf.userFork === true, ...(sf.btw === true ? { btw: true } : {}) } } : {}),
    ...(str(d.forkedFromSessionId) ? { fork: d.forkedFromSessionId } : {}),
    ...(d.lineageDetached === true ? { detached: true } : {}),
    ...(str(d.titleSource) ? { ts: d.titleSource } : {}),
    ...(d.isArchived === true ? { arch: true } : {}),
    ...(alt.length ? { alt } : {}),
  };
}

// 官方 isBtwChild：Desktop 的侧边对话，侧栏不列
export const isBtwChild = (r) => !!(r && r.sf && r.sf.btw && !r.detached);

// 官方 q_：这条会话的直接父（local_ id）
export function parentOf(r) {
  if (!r || r.detached) return undefined;
  const sf = r.sf && r.sf.id !== r.id ? r.sf : undefined;
  const fork = r.fork && r.fork !== r.id ? r.fork : undefined;
  if (sf && sf.side && !sf.userFork && (fork === undefined || fork === sf.id)) return sf.id;
  if (fork !== undefined) return fork;
  return sf ? sf.id : undefined;
}

// records（同一 local_ id 可能多份：每个账号目录各存一份，取 at 最新、平局取文件 mtime fm 最新）→ 血缘快照。
//   rootOf:   子会话 cli id → 顶层祖先的 cli id（只收两头都有 cli id 的）
//   members:  参与血缘的会话（根和子）的 cli id → { cwd, branch, wtName }，给补扫 worktree 目录用
//   titles:   Desktop 给每条会话起的标题（cli id → title）。派生会话的 jsonl 首条消息是一大段派活提示词，
//             Desktop 标题（如「施工：1.9 成稿排版层」）才是人认得出的名字
//   titleSrc: cli id → titleSource（auto / user / tool）
//   archived: Desktop 里已归档的会话 cli id（含 alt 旧 id）→ 用户最后一次在 Desktop 里碰它的时刻
//             max(lastActivityAt, lastFocusedAt)。bridge 里取消过归档的会话，只有 Desktop 那边在这之后
//             又被人碰过（取消归档再归档、接着聊完再归档）才重新跟随——不能拿元数据文件的 mtime 比：
//             Desktop 会整批重写元数据（本机 10-20 一个小时里改写了 1104 份，lastActivityAt 早在几个月前）
//   parentOf: 子会话 cli id → 直接父的 cli id（中间一层没有 cli 的跳过，接到再往上最近的那个）。
//             bridge 的「移到顶层」要从直接父算起（session-lineage.mjs），rootOf 已经压平了
//   btw:      Desktop 侧边对话的 cli id（含 alt 旧 id）。不参与血缘，会话列表不列
export function buildLineage(records) {
  const byId = new Map();
  for (const r of records) {
    if (!r) continue;
    const prev = byId.get(r.id);
    if (!prev || r.at > prev.at || (r.at === prev.at && (r.fm || 0) >= (prev.fm || 0))) byId.set(r.id, r);
  }
  const up = (r) => {
    const p = parentOf(r);
    return p !== undefined && p !== r.id && byId.has(p) ? p : undefined;
  };
  const rootOf = new Map();
  const members = new Map();
  const titles = new Map();
  const titleSrc = new Map();
  const archived = new Map();
  const parentCli = new Map();
  const btw = new Set();
  for (const r of byId.values()) {
    const ids = [r.cli, ...(r.alt || [])].filter(Boolean);
    const touched = Math.max(r.at || 0, r.lf || 0);
    for (const id of ids) {
      // 主 id 优先：别的记录的 alt 不覆盖某条会话自己的 cli 标题
      if (r.title && (id === r.cli || !titles.has(id))) { titles.set(id, r.title); if (r.ts) titleSrc.set(id, r.ts); }
      if (r.arch && (id === r.cli || !archived.has(id))) archived.set(id, touched);
      if (isBtwChild(r)) btw.add(id);
    }
  }
  const note = (r) => { if (r.cli && !members.has(r.cli)) members.set(r.cli, { cwd: r.cwd, branch: r.branch, wtName: r.wtName }); };
  for (const r of byId.values()) {
    if (isBtwChild(r)) continue;
    let top = up(r);
    if (top === undefined) continue;
    const seen = new Set([r.id, top]);
    let near = byId.get(top).cli && byId.get(top).cli !== r.cli ? byId.get(top).cli : undefined;   // 最近一个有 cli 的祖先
    for (let i = 0; i < MAX_DEPTH; i++) {
      const next = up(byId.get(top));
      if (next === undefined || seen.has(next)) break;
      seen.add(next); top = next;
      if (!near && byId.get(top).cli && byId.get(top).cli !== r.cli) near = byId.get(top).cli;
    }
    const root = byId.get(top);
    if (!r.cli || !root.cli || root.cli === r.cli) continue;
    rootOf.set(r.cli, root.cli);
    if (near) parentCli.set(r.cli, near);
    note(r); note(root);
  }
  return { rootOf, members, titles, titleSrc, archived, parentOf: parentCli, btw };
}

// —— 后台增量扫描 ——

const EMPTY = Object.freeze({ rootOf: new Map(), members: new Map(), titles: new Map(), titleSrc: new Map(), archived: new Map(), parentOf: new Map(), btw: new Set() });
const state = { dir: undefined, cacheFile: undefined, files: null, snap: EMPTY, at: 0, running: null, probe: null, probeAt: 0 };

// 后台扫完、侧栏要跟着变的时候通知一声（session-archive-auto.mjs 据此推总线 archive，侧栏整表重拉）：
//   · 冷启动没有缓存（首次部署 / 缓存版本升级 / Desktop 数据目录变了）：首轮扫完前血缘是空的，列表里 Desktop 已归档的
//     混在活跃里、子会话不缩进；扫完不推的话要等下一次整表刷新才收拢；
//   · Desktop 里归档 / 取消归档了会话（设置「跟随 Claude Desktop 的归档」开着时列表要跟）。
// 只认这两种；新派生的子会话之类由下一次正常刷新带上，不为它整表重拉。回调拿到 (ctx, { cold, archivedChanged })。
const changeListeners = new Set();
let lastCtx = null;   // 最近一次查血缘的主机身份（只有它看得到 Desktop 血缘）
export function onDesktopLineageChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); }
const archSig = (snap) => [...snap.archived.keys()].sort().join(',');

const rootsKey = (dirs) => dirs.join('|');
const under = (p, dirs) => dirs.some((d) => p.startsWith(d + path.sep));
// 缓存条目 → 记录（带文件 mtime，buildLineage 断平局用）
const recordsOf = (files) => [...files.values()].map((c) => c && c.r && { ...c.r, fm: c.m });

function loadCache(cacheFile, dirs) {
  try {
    const j = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (j && j.v === CACHE_VERSION && j.files && typeof j.files === 'object') {
      // 根目录集合变了（装了 3P 版 / 迁移）：只留仍在当前根下的条目，其余下一轮扫描补上
      const ok = j.dir === rootsKey(dirs) ? null : dirs;
      return new Map(Object.entries(j.files).filter(([p]) => !ok || under(p, ok)));
    }
  } catch {}
  return new Map();
}

function saveCache(cacheFile, dirs, files) {
  if (!cacheFile) return;
  try {
    const tmp = cacheFile + '.tmp';
    writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, dir: rootsKey(dirs), files: Object.fromEntries(files) }));
    renameSync(tmp, cacheFile);
  } catch {}
}

async function listMetaFiles(dir) {
  const out = [];
  const sub = async (p) => { try { return await fsp.readdir(p, { withFileTypes: true }); } catch { return []; } };
  for (const a of await sub(dir)) {
    if (!a.isDirectory()) continue;
    for (const o of await sub(path.join(dir, a.name))) {
      if (!o.isDirectory()) continue;
      const od = path.join(dir, a.name, o.name);
      for (const f of await sub(od)) if (f.isFile() && /^local_[0-9a-f-]+\.json$/i.test(f.name)) out.push(path.join(od, f.name));
    }
  }
  return out;
}

// dir 可以是单个目录或目录数组（多根合并扫描）
export async function scanOnce(dir, files) {
  const dirs = Array.isArray(dir) ? dir : [dir];
  const paths = (await Promise.all(dirs.map(listMetaFiles))).flat();
  const live = new Set(paths);
  let changed = false;
  for (const k of [...files.keys()]) if (!live.has(k)) { files.delete(k); changed = true; }
  const todo = [];
  await Promise.all(paths.map(async (p) => {
    try {
      const st = await fsp.stat(p);
      const c = files.get(p);
      if (!c || c.m !== st.mtimeMs || c.s !== st.size) todo.push({ p, m: st.mtimeMs, s: st.size });
    } catch {}
  }));
  for (let i = 0; i < todo.length; i += READ_CONCURRENCY) {
    await Promise.all(todo.slice(i, i + READ_CONCURRENCY).map(async ({ p, m, s }) => {
      try {
        const rec = pickRecord(JSON.parse(await fsp.readFile(p, 'utf8')));
        files.set(p, { m, s, r: rec });
        changed = true;
      } catch {}   // Desktop 正在写这份文件（半截 JSON）：不记 m/s，下一轮重读
    }));
  }
  return changed;
}

// 候选根目录（探测结果缓存 PROBE_MS，列表接口每次都会来问）
function probedDirs(now) {
  if (!state.probe || now - state.probeAt >= PROBE_MS || now < state.probeAt) { state.probe = desktopSessionsDirs(); state.probeAt = now; }
  return state.probe;
}

// 同步取快照；过期了就在后台刷新一次（不等它）。dir/dirs 为空（平台不支持/没装 Desktop）恒返回空。
// dir：单个目录（旧调用方 / 单测）；dirs：多个；都不给就按 desktopSessionsDirs 探测。
export function desktopLineage({ dir, dirs, cacheFile, now = Date.now() } = {}) {
  const roots = dir ? [dir] : (dirs || probedDirs(now));
  if (!roots.length) return EMPTY;
  const key = rootsKey(roots);
  if (state.dir !== key) {
    state.dir = key; state.cacheFile = cacheFile; state.at = 0;
    state.files = loadCache(cacheFile, roots);
    state.snap = state.files.size ? buildLineage(recordsOf(state.files)) : EMPTY;
  }
  if (!state.running && now - state.at >= REFRESH_MS) {
    state.at = now;
    state.running = scanOnce(roots, state.files)
      .then((changed) => {
        if (!changed) return;
        const prev = state.snap;
        state.snap = buildLineage(recordsOf(state.files));
        saveCache(state.cacheFile, roots, state.files);
        const cold = prev === EMPTY && (state.snap.rootOf.size > 0 || state.snap.archived.size > 0);
        const archivedChanged = !cold && archSig(prev) !== archSig(state.snap);
        if ((cold || archivedChanged) && lastCtx) for (const fn of changeListeners) { try { fn(lastCtx, { cold, archivedChanged }); } catch {} }
      })
      .catch(() => {})
      .finally(() => { state.running = null; });
  }
  return state.snap;
}

// 测试用：等当前这轮后台扫描结束
export function desktopLineageSettled() { return state.running || Promise.resolve(); }
export function resetDesktopLineage() { state.dir = undefined; state.files = null; state.snap = EMPTY; state.at = 0; state.running = null; state.probe = null; state.probeAt = 0; }

// 哪些身份能看 Desktop 血缘：只有主机本人（admin），且 SDK 读写的是默认 ~/.claude
//（测试服设了 CLAUDE_CONFIG_DIR，那边的会话不是 Desktop 写的那批）。
export function lineageFor(ctx) {
  if (!ctx || ctx.kind !== 'admin' || ctx.configDir || String(process.env.CLAUDE_CONFIG_DIR || '').trim()) return EMPTY;
  if (ctx.key && ctx.dataDir) lastCtx = ctx;
  return desktopLineage({ cacheFile: ctx.dataDir ? path.join(ctx.dataDir, 'desktop-lineage-cache.json') : undefined });
}
