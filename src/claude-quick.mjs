// 「临时对话」（内部仍叫 quick / quickchat）——不进任何项目时用的一次性工作空间：一只空桶 + 桶里的对话。
//
// 2026-10-22 开源首发 S1-6（审查 G20 / D10）：以前叫「快照」，同时只列一条、跨桶只留最近 10 条，更老的连同
// 产物整只删掉、没有任何提示——外人第一次用就可能丢东西。现在：
//   · 改名「临时对话」（「快照」另指公开聊天快照链接与轮内检查点，三处撞名）；
//   · 所有还留着的临时对话都列出来、都能搜到（每只桶伪装成一枚 quick 项目，见 quickProjects）；
//   · 回收改成按时间：一只桶最后一次活动（桶目录或里面任一条对话记录的修改时间）超过 QUICK_TTL_DAYS 天
//     才回收；剩 QUICK_WARN_DAYS 天时界面提示，可「存为工作空间」或「继续保留」（keepQuick 记一次活动）；
//   · 回收不直接删：整只桶挪进回收站（<桶根>/.recycled/<id>），对话记录留在原处——恢复 = 挪回来，
//     对话与产物原样接上；回收站里再放 QUICK_TRASH_DAYS 天才永久删除。
//
// 为什么另起一个模块而不是复用 claude-projects 的普通项目：普通项目 = 用户自己选的本地目录（有 CLAUDE.md、
// 有历史、有自动记忆），临时对话要的正好相反——
//   1. 不属于任何已有工作空间：桶是现铸的空目录，与 vault / 用户目录无关；
//   2. 不共用任何记忆：见下面「桶必须落在 git 仓库之外」与 autoMemoryEnabled:false；
//   3. 一条临时对话一只桶：「当前桶」（store 里记的那只）永远是一只还没有对话的桶，开新的临时对话就落进它；
//      它一有对话记录，下一次列项目就换上一只新的空桶（currentBucket 的 fresh），用过的那只照常列出、按时间回收。
//      只放了文件、还没发第一条的不算用过（见 bucketUsed）；
//   4. 服务端状态：桶与 transcript 都在盘上，前端清缓存 / 杀后台 / 换设备都不会让它消失。
//
// 想留下来的临时对话可以「存为工作空间」（claude-projects.mjs 的 saveQuickProject）：桶登记成普通项目、
// 再挪到固定位置（claude-quick-relocate.mjs），此后回收跳过它（adoptedDirs），它也不再是临时对话。
//
// ⚠ 桶必须落在【任何 git 仓库之外】（实测踩过）：Claude Code 的自动记忆按【git 根】
// 推导目录，不是按 cwd。桶原先放在 <dataDir>/quickchat/ 下，而 admin 的 dataDir 就是
// claude-bridge 仓库本身 → 桶的 git 根 = 该仓库 → 临时对话开局就吃到了 bridge 项目的
// MEMORY.md（问它"上下文里有哪些记忆文件"当场自陈）。所以 admin 的桶改落用户主目录
// 下的 .bridge-quickchat/（非仓库），沙箱用户仍落自己空间内（那两层也都不是仓库，且
// authorizeProjectPath 要求项目路径必须在其 cwd 内）。另在桶里写一份
// .claude/settings.local.json { autoMemoryEnabled: false } 作第二道闸——万一将来数据根
// 又落进某个仓库里，自动记忆也读不进来、写不出去。
//
// 命名注意：本项目里 `snap` 已经是【公开聊天快照链接】（chat-snapshot.mjs 的 /c/<token>
// 桶身份），与本模块无关。这里内部一律叫 quick / quickchat，别混。

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir, stat, rm } from 'node:fs/promises';
import { readJson, writeJson } from './jsonfile.mjs';
import { sessionsDir } from './runtime/paths.mjs';

export const QUICK_NAME = '临时对话';
// 回收策略（前端经 /api/sessions 拿到同一组数，横条与侧栏角标据此显示，别在前端另写一份）
export const QUICK_TTL_DAYS = 30;     // 最后一次活动超过这么多天才回收
export const QUICK_WARN_DAYS = 3;     // 剩这么多天时界面开始提示
export const QUICK_TRASH_DAYS = 30;   // 回收站里再放这么多天才永久删除
const DAY = 24 * 3600 * 1000;
const QUICK_GRACE_MS = 10 * 60 * 1000;   // 铸了没用的空桶多久之后才删（刚铸的、别的设备正开着的都靠它兜住）
const BUCKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRASH = '.recycled';

// 公开只读分享桶 / 公开聊天快照桶本身就是一次性隔离桶，不给它们再套一层临时对话。
const quickAllowed = (ctx) => !!ctx && (ctx.kind === 'admin' || ctx.kind === 'user');
const err = (message, status) => Object.assign(new Error(message), { status });

// admin = 主机本人，桶放主目录（不在任何仓库里）；沙箱用户必须留在自己的空间内
//（authorizeProjectPath 对非 admin 强制 cwd 围栏），其根目录同样不是仓库。
//
// ⚠ admin 的主目录是【同机所有实例共用】的，而项目表、transcript 目录各实例自有一份
// （BRIDGE_DATA_ROOT / CLAUDE_CONFIG_DIR 隔离的测试夹具）。10-21 事故：夹具的 pruneQuick
// 在共用根里扫到生产「存为工作空间」的桶——自己的项目表里没登记、自己的配置目录里也没
// 它的记录——当成 0 条记录的旧桶整只删了（生产 transcript 完好、工作目录没了）。
// 所以共用根只归一个实例（根下 .owner 记它的数据根）；别的实例一律落进根下
// i-<数据根哈希>/ 子目录——生产回收只认 UUID 名的目录，碰不到它；它也只扫自己的子目录。
// 认主：.owner 缺失时，只有「当前桶已经在共用根里」的实例（即历来用它的那个）才认领；
// 全新的夹具没有临时对话记录，落子目录。
const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const keyOf = (p) => fold(path.resolve(p));
const within = (root, p) => {
  const rel = path.relative(fold(root), fold(path.resolve(p)));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const SHARED_ROOT = path.join(os.homedir(), '.bridge-quickchat');
const adminRoots = new Map();   // fold(dataDir) -> root
function adminRoot(ctx) {
  const me = fold(path.resolve(ctx.dataDir || ''));
  const hit = adminRoots.get(me);
  if (hit) return hit;
  const ownerFile = path.join(SHARED_ROOT, '.owner');
  let owner = '';
  try { owner = readFileSync(ownerFile, 'utf8').trim(); } catch {}
  if (!owner) {
    const rec = readJson(storeFile(ctx), null);
    if (rec && typeof rec.path === 'string' && within(SHARED_ROOT, rec.path)) {
      try { mkdirSync(SHARED_ROOT, { recursive: true }); writeFileSync(ownerFile, me); owner = me; } catch {}
    }
  }
  const root = owner === me ? SHARED_ROOT
    : path.join(SHARED_ROOT, 'i-' + crypto.createHash('sha1').update(me).digest('hex').slice(0, 10));
  adminRoots.set(me, root);
  return root;
}
const bucketRoot = (ctx) => ctx.kind === 'admin' ? adminRoot(ctx) : path.join(ctx.dataDir, 'quickchat');
// 回收站在桶根里（同一个卷，挪进挪出都是一次 rename）；名字不是 UUID，桶的枚举与回收都不认它。
const trashRoot = (ctx) => path.join(bucketRoot(ctx), TRASH);

const storeFile = (ctx) => path.join(ctx.dataDir, 'claude-quick.json');

const inRoot = (ctx, p) => within(bucketRoot(ctx), p);

// 路径是否还在临时对话桶的地盘里（admin 认整棵共用根，含别的实例的 i-<哈希> 子目录与回收站）。
// 「存为工作空间」的桶一律要挪出这里（claude-quick-relocate.mjs）——这里是回收的地盘。
export const inQuickRoots = (ctx, p) => within(ctx.kind === 'admin' ? SHARED_ROOT : path.join(ctx.dataDir, 'quickchat'), p);

// 存好的工作空间的固定落点：任何回收都不扫这里。仍须在 git 仓库之外（自动记忆按 git 根推导）。
//   admin 共用根的属主 → ~/Bridge Workspaces（看得见、好找）；
//   其它 admin 实例（测试夹具）→ 自己子目录下的 saved/（不是 UUID 名，回收不认），不污染主目录；
//   沙箱用户 → <dataDir>/workspaces（在其 cwd 内，authorizeProjectPath 放行；与 quickchat 同层）。
export function savedQuickRoot(ctx) {
  if (ctx.kind !== 'admin') return path.join(ctx.dataDir, 'workspaces');
  const root = adminRoot(ctx);
  return root === SHARED_ROOT ? path.join(os.homedir(), 'Bridge Workspaces') : path.join(root, 'saved');
}

function mint(ctx) {
  const id = crypto.randomUUID();
  const dir = path.join(bucketRoot(ctx), id);
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  // 第二道闸：这只桶不读也不写自动记忆（键见 SDK settings schema）。写失败不致命——
  // 桶已在仓库外，第一道闸就够；这里只是纵深防御，所以吞掉异常。
  try { writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryEnabled: false }, null, 2)); } catch {}
  const rec = { id, path: dir, created: Date.now() };
  writeJson(storeFile(ctx), rec, 2);
  return rec;
}

// 桶用过没有：只认对话记录（.jsonl）。桶里的文件不算——空白临时对话里先往工作台传的文件，必须和随后发出的
// 第一条留在同一只桶里。以前文件也算「用过」：一传文件，下一次列表刷新就换掉当前桶，前端的空白对话跟去新桶，
// 刚传的文件看着没了，第一条发出去 Claude 也找不到它；留在旧桶里的文件没有对话、侧栏不列，静静等着被回收。
function bucketUsed(ctx, dir) {
  try { return readdirSync(sessionsDir(dir, ctx.configDir)).some((n) => n.endsWith('.jsonl')); } catch { return false; }
}

// 当前桶（幂等）：有就返回，没有 / 记录坏了 / 桶落在旧位置 / 目录没了 / 已存为工作空间就现铸一只。
// fresh：当前桶已经用过（一条临时对话已经开在里面）就换一只新的空桶——用过的那只不动，照常列出、按时间回收。
// 目录没了不原地重建：同一路径的旧对话记录还在配置目录里，重建等于让它们「复活」进一只空桶。
function currentBucket(ctx, { fresh = false } = {}) {
  const rec = readJson(storeFile(ctx), null);
  if (!rec || typeof rec.id !== 'string' || typeof rec.path !== 'string' || !inRoot(ctx, rec.path) || !existsSync(rec.path)
    || adoptedDirs(ctx).has(keyOf(rec.path))) return mint(ctx);
  if (fresh && bucketUsed(ctx, rec.path)) return mint(ctx);
  return rec;
}

// 桶伪装成一枚项目（project.quick = true）——这样 cwd 解析、会话归属推导、/api/sessions 目录聚合、
// 右侧工作台作用域全部沿用项目那套管线。前端据 quick 标记把它们从「项目」区摘出去，单独成「临时对话」一区；
// current = 开新临时对话时落进的那只空桶。
const asProject = (rec, current = false) => ({
  id: rec.id, name: QUICK_NAME, path: rec.path, created: rec.created || 0, updated: rec.created || 0, quick: true,
  ...(current ? { current: true } : {}),
});

// 当前桶（开新临时对话的落点）。用过了就先换一只新的。
export function quickProject(ctx) {
  if (!quickAllowed(ctx)) return null;
  try { return asProject(currentBucket(ctx, { fresh: true }), true); } catch { return null; }
}

// 全部还留着的临时对话桶：当前桶在最前，其余按目录名（顺序不重要——前端按会话的修改时间排）。
// 已存为工作空间、还没挪走的桶（项目表里登记过）不算。同步扫一层目录，几十只桶也是亚毫秒级。
export function quickProjects(ctx) {
  const cur = quickProject(ctx);
  if (!cur) return [];
  const root = bucketRoot(ctx);
  const curKey = keyOf(cur.path);
  const adopted = adoptedDirs(ctx);
  const rest = [];
  let names = [];
  try { names = readdirSync(root, { withFileTypes: true }); } catch {}
  for (const d of names) {
    if (!d.isDirectory() || !BUCKET_ID.test(d.name)) continue;
    const dir = path.join(root, d.name);
    const k = keyOf(dir);
    if (k === curKey || adopted.has(k)) continue;
    rest.push(asProject({ id: d.name, path: dir }));
  }
  return [cur, ...rest];
}

// 「新建临时对话」：给出一只没用过的空桶（当前桶没用过就是它本身，用过了就现铸一只）。
// 顺手记下「刚明确开过新的」的时刻（handed）：还没更新的老前端只认一只「快照」，按它挑（见 legacyQuickSlot）。
export function newQuickProject(ctx) {
  if (!quickAllowed(ctx)) throw err('该身份不支持临时对话', 403);
  const rec = currentBucket(ctx, { fresh: true });
  markQuickHanded(ctx, rec);
  return asProject(rec, true);
}
// 老前端「存为工作空间」之后，它的「快照」位换上的是当前空桶（旧语义）——同样记一笔 handed。
export function markQuickHanded(ctx, rec = null) {
  if (!quickAllowed(ctx)) return;
  try {
    const cur = rec || currentBucket(ctx, { fresh: true });
    writeJson(storeFile(ctx), { ...cur, handed: Date.now() }, 2);
  } catch {}
}

// ---- 老前端兼容 ----
// 手机 App 的界面打包在安装包里，服务端先升级、手机还没装新包的那段时间跑的是老前端：它只认一只「快照」
//（projects.find(p => p.quick)，会话列表里也只认这只桶的最新一条），其余临时对话在它那儿找不到所属项目，
// 会整排掉进默认工作空间组。所以没带 quick=2 的请求（老前端）照旧只给一只，挑最像旧语义的那只：
//   · 最近活动的那只用过的桶（老前端里「快照」就是一直接着用的那一条）；
//   · 刚明确开过新的（「新建快照 / 新建临时对话」，store 里的 handed 比所有对话都新）→ 当前空桶；
//   · 一条临时对话都没有 → 当前空桶。
// rows = 会话列表的临时对话行（runtime/session-list.mjs 的 quickFiles，mtime 倒序）。调用前当前桶已刷新过。
export function legacyQuickSlot(ctx, rows = []) {
  if (!quickAllowed(ctx)) return null;
  const rec = readJson(storeFile(ctx), null);
  let best = null, at = -Infinity;
  for (const r of rows || []) {
    const m = Number(r && r.mtime) || 0;
    if (r && r.projectId && m > at) { at = m; best = r.projectId; }
  }
  const cur = rec && typeof rec.id === 'string' ? rec.id : null;
  if (cur && (!best || (Number(rec.handed) || 0) > at)) return cur;
  return best;
}

export const isQuickProject = (p) => !!p && p.quick === true;

// 这个目录是不是临时对话桶（含回收站里的；存成工作空间的不算）——权限模式按文件夹记忆时，一次性的桶共用一个
// 「scratch:」键（官方同款），绕过权限也不记（runtime/permissions.mjs）。
export function isQuickDir(ctx, dir) {
  if (!quickAllowed(ctx) || !dir || !inRoot(ctx, dir)) return false;
  return !adoptedDirs(ctx).has(keyOf(dir));
}

// 「存为工作空间」（claude-projects.mjs 的 saveQuickProject）之后，这只桶就是一个普通
// 工作空间了：撤掉铸桶时写的第二道闸（autoMemoryEnabled:false），让它像别的工作空间一样
// 有自动记忆。安全性仍由第一道闸保证——桶在任何 git 仓库之外，记忆目录只属于它自己。
// 文件里只剩这一个键就整个删掉；别的键（用户后来加的设置）原样留着。失败不致命。
export function adoptQuickBucket(dir) {
  const f = path.join(dir, '.claude', 'settings.local.json');
  let cfg;
  try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { return; }
  if (!cfg || typeof cfg !== 'object' || !('autoMemoryEnabled' in cfg)) return;
  delete cfg.autoMemoryEnabled;
  try {
    if (Object.keys(cfg).length) writeFileSync(f, JSON.stringify(cfg, null, 2));
    else rmSync(f, { force: true });
  } catch {}
}

// 已登记进项目表的桶（存成的工作空间）：枚举与回收一律跳过。
// 直接读项目表文件（claude-projects.mjs 反过来 import 本模块，这里不能 import 它）。
function adoptedDirs(ctx) {
  const data = ctx?.claudeProjects ? readJson(ctx.claudeProjects, null) : null;
  const list = Array.isArray(data?.projects) ? data.projects : [];
  return new Set(list.filter((p) => p && typeof p.path === 'string').map((p) => keyOf(p.path)));
}

// 还在列表里的某只桶（按 id）：不在 / 已存走 → null。
function liveBucket(ctx, id) {
  const sid = String(id || '');
  if (!BUCKET_ID.test(sid)) return null;
  const dir = path.join(bucketRoot(ctx), sid);
  if (!existsSync(dir) || adoptedDirs(ctx).has(keyOf(dir))) return null;
  return dir;
}

// 「继续保留」：给这只桶记一次活动（桶目录的修改时间改成现在），回收时钟从头算。
// 不碰对话记录本身——改 transcript 的时间会把它在会话列表里顶到最前面。
export function keepQuick(ctx, id, { now = Date.now() } = {}) {
  if (!quickAllowed(ctx)) throw err('该身份不支持临时对话', 403);
  const dir = liveBucket(ctx, id);
  if (!dir) throw err('这个临时对话已经不在了，请刷新后再试', 404);
  const t = new Date(now);
  utimesSync(dir, t, t);
  return { id: String(id), expiresAt: now + QUICK_TTL_DAYS * DAY };
}

// ---- 按时间回收 ----
//
// 一只桶的「最后活动」= 桶目录本身与它 transcript 目录里每条对话记录（.jsonl）修改时间的最大值
//（每一轮都会写 transcript；Claude 在桶顶层写产物、「继续保留」都会动桶目录）。
// 永不回收的：当前桶（没用过的空桶）、有会话正在跑的桶、已存为工作空间的桶。
// 铸了没用、也没放进任何东西的空桶（多台设备同时换桶时多铸的那只）：过了宽限直接删，里面本来就什么都没有。
// 到期的桶整只挪进回收站，对话记录留在原处不动（恢复时原路挪回来，按 cwd 归档的记录自然接上）；
// 回收站里放满 QUICK_TRASH_DAYS 天的才永久删除（连同对话记录）。Windows 文件锁挪不动 / 删不动就吞掉，下轮再试。
async function activity(ctx, dir) {
  let last;
  try { last = (await stat(dir)).mtimeMs; } catch { return null; }
  const tdir = sessionsDir(dir, ctx.configDir);
  const ids = [];
  let ents = [];
  try { ents = await readdir(tdir, { withFileTypes: true }); } catch {}
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    ids.push(e.name.slice(0, -6));
    try { last = Math.max(last, (await stat(path.join(tdir, e.name))).mtimeMs); } catch {}
  }
  let items = 0;
  try { items = (await readdir(dir)).filter((n) => n !== '.claude').length; } catch {}
  return { dir, tdir, last, ids, content: items > 0, items };
}

function recycle(ctx, id, a, now) {
  const troot = trashRoot(ctx);
  const to = path.join(troot, id);
  const marker = path.join(troot, id + '.json');
  try {
    mkdirSync(troot, { recursive: true });
    if (existsSync(to)) return false;   // 回收站里已有同名的（不该发生）：原地留着，别覆盖
    writeFileSync(marker, JSON.stringify({ id, path: a.dir, recycledAt: now, lastActive: a.last, sessions: a.ids }, null, 2));
    renameSync(a.dir, to);   // 同一个卷上整体挪：要么整个进去，要么原地不动
    return true;
  } catch {
    try { rmSync(marker, { force: true }); } catch {}
    return false;
  }
}

async function purgeTrash(ctx, { trashMs, now, onDrop }) {
  const troot = trashRoot(ctx);
  let ents = [];
  try { ents = await readdir(troot, { withFileTypes: true }); } catch { return 0; }
  const dirs = new Set(ents.filter((e) => e.isDirectory() && BUCKET_ID.test(e.name)).map((e) => e.name));
  let n = 0;
  for (const e of ents) {
    // 没有对应目录的标记（挪进去之前进程没了 / 恢复到一半）：只是一张废纸，清掉
    if (e.isFile() && e.name.endsWith('.json') && !dirs.has(e.name.slice(0, -5))) { try { await rm(path.join(troot, e.name), { force: true }); } catch {} }
  }
  for (const id of dirs) {
    const dir = path.join(troot, id);
    const marker = path.join(troot, id + '.json');
    const m = readJson(marker, null) || {};
    let at = Number(m.recycledAt) || 0;
    if (!at) { try { at = (await stat(dir)).mtimeMs; } catch { continue; } }
    if (now - at < trashMs) continue;
    const orig = path.join(bucketRoot(ctx), id);
    const tdir = sessionsDir(orig, ctx.configDir);
    let ids = [];
    try { ids = (await readdir(tdir)).filter((x) => x.endsWith('.jsonl')).map((x) => x.slice(0, -6)); } catch {}
    try {
      await rm(dir, { recursive: true, force: true });
      // 同名的桶又回到了列表里（恢复过）就别碰它的对话记录
      if (!existsSync(orig)) await rm(tdir, { recursive: true, force: true });
      await rm(marker, { force: true });
      n++;
      for (const sid of ids) { try { onDrop?.(sid); } catch {} }
    } catch {}
  }
  return n;
}

// 返回值另带 orphans：只有文件、没有对话记录的桶（[{ id, last, items, expiresAt }]）——在里面删光了对话、
// 或老版本留下的。它们按会话行列不出来，schedulePruneQuick 记下这份名单，会话列表接口转给侧栏单独列出来
//（quickOrphans），不让它们不声不响地走完两轮 30 天。
export async function pruneQuick(ctx, { ttlMs = QUICK_TTL_DAYS * DAY, trashMs = QUICK_TRASH_DAYS * DAY, busy = new Set(), onDrop, now = Date.now() } = {}) {
  const out = { recycled: 0, purged: 0, empty: 0, orphans: [] };
  if (!quickAllowed(ctx)) return out;
  let cur;
  try { cur = currentBucket(ctx, { fresh: true }); } catch { return out; }   // 用过的当前桶先换掉：它和别的桶一样按时间回收
  const root = bucketRoot(ctx);
  const curKey = keyOf(cur.path);
  const adopted = adoptedDirs(ctx);
  let names = [];
  try { names = await readdir(root, { withFileTypes: true }); } catch {}
  for (const d of names) {
    if (!d.isDirectory() || !BUCKET_ID.test(d.name)) continue;
    const dir = path.join(root, d.name);
    const k = keyOf(dir);
    if (k === curKey || adopted.has(k)) continue;
    const a = await activity(ctx, dir);
    if (!a || a.ids.some((id) => busy.has(id))) continue;
    if (!a.ids.length && !a.content) {
      if (now - a.last < QUICK_GRACE_MS) continue;
      try { await rm(dir, { recursive: true, force: true }); await rm(a.tdir, { recursive: true, force: true }); out.empty++; } catch {}
      continue;
    }
    if (now - a.last < ttlMs) {
      if (!a.ids.length) out.orphans.push({ id: d.name, last: a.last, items: a.items, expiresAt: a.last + ttlMs });
      continue;
    }
    if (recycle(ctx, d.name, a, now)) out.recycled++;
  }
  out.purged = await purgeTrash(ctx, { trashMs, now, onDrop });
  return out;
}

// 节流版：/api/sessions 每次列表都会叫，按身份 5 分钟最多扫一遍。不 await——回收在后台跑，不拖慢列表。
const pruneState = new Map();   // ctx.key -> { at, running }
export function schedulePruneQuick(ctx, opts = {}, { force = false } = {}) {
  if (!quickAllowed(ctx)) return;
  const key = ctx.key || ctx.kind;
  const st = pruneState.get(key) || { at: 0, running: false };
  if (st.running || (!force && Date.now() - st.at < 5 * 60 * 1000)) return;
  st.running = true; st.at = Date.now(); pruneState.set(key, st);
  pruneQuick(ctx, opts)
    .then((r) => {
      st.orphans = r.orphans;
      if (r.recycled || r.purged || r.empty) console.log(`[quick] 临时对话回收：${r.recycled} 只进回收站、${r.purged} 只永久删除、${r.empty} 只空桶`);
    })
    .catch((e) => console.warn('[quick] prune failed:', e?.message || e))
    .finally(() => { st.running = false; });
}

// 只有文件、没有对话记录的临时对话桶（最近一轮回收扫出来的，最多晚 5 分钟）：侧栏单独列一行，点开 = 在那只桶里
// 开空白对话、工作台里看得见文件。交出去之前再核一遍还在不在（这几分钟里可能被存走 / 恢复成别的样子）。
export function quickOrphans(ctx) {
  if (!quickAllowed(ctx)) return [];
  const st = pruneState.get(ctx.key || ctx.kind);
  const list = (st && st.orphans) || [];
  if (!list.length) return [];
  const root = bucketRoot(ctx);
  const adopted = adoptedDirs(ctx);
  return list.flatMap((o) => {
    const dir = path.join(root, o.id);
    if (adopted.has(keyOf(dir))) return [];
    let m;
    try { m = statSync(dir).mtimeMs; } catch { return []; }
    // 「继续保留」/ 往里放了东西会动桶目录：到期时刻按现在的修改时间重算，别拿扫描时的旧值盖掉
    const last = Math.max(o.last, m);
    return [{ ...o, last, expiresAt: last + (o.expiresAt - o.last) }];
  });
}

// 每只（用过的）临时对话桶什么时候到期：{ 桶 id: 到期时刻 ms }。rows = 会话列表里的临时对话行
//（{ projectId, mtime }，见 runtime/session-list.mjs 的 quickFiles），再补上桶目录本身的修改时间。
// 算法与 pruneQuick 一致（对话记录与桶目录取最晚）——界面上写的天数就是真实回收的时候，不会提前删。
export async function quickExpiries(ctx, rows, { ttlMs = QUICK_TTL_DAYS * DAY } = {}) {
  const last = new Map();
  for (const r of rows || []) {
    if (!r || !BUCKET_ID.test(String(r.projectId || ''))) continue;
    last.set(r.projectId, Math.max(last.get(r.projectId) || 0, Number(r.mtime) || 0));
  }
  if (!last.size || !quickAllowed(ctx)) return {};
  const root = bucketRoot(ctx);
  const out = {};
  await Promise.all([...last.keys()].map(async (id) => {
    let m = last.get(id);
    try { m = Math.max(m, (await stat(path.join(root, id))).mtimeMs); } catch {}
    out[id] = m + ttlMs;
  }));
  return out;
}

// ---- 回收站 ----

// 回收站里有几只（侧栏入口的计数）。
export function recycledQuickCount(ctx) {
  if (!quickAllowed(ctx)) return 0;
  try { return readdirSync(trashRoot(ctx), { withFileTypes: true }).filter((e) => e.isDirectory() && BUCKET_ID.test(e.name)).length; }
  catch { return 0; }
}

// 回收站列表（新回收的在前）：[{ id, recycledAt, purgeAt, lastActive, items, files:[{ id, file, mtime, size }] }]
//   items = 桶里除 .claude 外的条目数（有没有产物）；files = 它的对话记录（还在原处），给路由解析标题用。
export async function listRecycledQuick(ctx, { trashMs = QUICK_TRASH_DAYS * DAY } = {}) {
  if (!quickAllowed(ctx)) return [];
  const troot = trashRoot(ctx);
  let ents = [];
  try { ents = await readdir(troot, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory() || !BUCKET_ID.test(e.name)) continue;
    const dir = path.join(troot, e.name);
    const m = readJson(path.join(troot, e.name + '.json'), null) || {};
    let at = Number(m.recycledAt) || 0;
    if (!at) { try { at = (await stat(dir)).mtimeMs; } catch { continue; } }
    const tdir = sessionsDir(path.join(bucketRoot(ctx), e.name), ctx.configDir);
    const files = [];
    let tents = [];
    try { tents = await readdir(tdir, { withFileTypes: true }); } catch {}
    for (const t of tents) {
      if (!t.isFile() || !t.name.endsWith('.jsonl')) continue;
      const file = path.join(tdir, t.name);
      try { const s = await stat(file); files.push({ id: t.name.slice(0, -6), file, mtime: s.mtimeMs, size: s.size }); } catch {}
    }
    files.sort((x, y) => y.mtime - x.mtime);
    let items = 0;
    try { items = (await readdir(dir)).filter((n) => n !== '.claude').length; } catch {}
    out.push({ id: e.name, recycledAt: at, purgeAt: at + trashMs, lastActive: Number(m.lastActive) || 0, items, files });
  }
  return out.sort((x, y) => y.recycledAt - x.recycledAt);
}

// 从回收站恢复：整只桶挪回原位（对话记录按原路径归档，自然接上），并记一次活动——不然下一轮回收立刻又把它收走。
export function restoreQuick(ctx, id, { now = Date.now() } = {}) {
  if (!quickAllowed(ctx)) throw err('该身份不支持临时对话', 403);
  const sid = String(id || '');
  if (!BUCKET_ID.test(sid)) throw err('参数不对', 400);
  const from = path.join(trashRoot(ctx), sid);
  const to = path.join(bucketRoot(ctx), sid);
  if (!existsSync(from)) throw err('回收站里已经没有这个临时对话了', 404);
  if (existsSync(to)) throw err('这个临时对话已经在列表里了', 409);
  renameSync(from, to);
  const t = new Date(now);
  try { utimesSync(to, t, t); } catch {}
  try { rmSync(path.join(trashRoot(ctx), sid + '.json'), { force: true }); } catch {}
  return asProject({ id: sid, path: to });
}
