// 功能扩展注册表：Vertex / Codex / dimensio 三个可选模块「装没装、加载没加载」的单一真相。
//
// 基础版只有 Claude（核心自带）。其余 agent 各属一个功能扩展，按下面的顺序找：
//   1. 仓库内置   <程序目录>/modules/<id>/         —— 维护者本机、Linux/Docker 部署：满配，行为不变
//   2. 数据目录   <DATA_ROOT>/modules/<id>/        —— Windows 客户端/服务端从扩展中心装的离线包
//                （BRIDGE_MODULES_DIR 可改；升级覆盖程序目录时不受影响）
// 每个扩展目录里有 bridge-module.json（清单）和清单 entry 指向的入口文件；离线包还带 web/
// （它的前端 chunk，静态路由在主目录找不到时回落到这里，见 moduleWebDirs）。
//
// 扩展中心的安装 / 更新 / 卸载不直接动正在用的目录（Codex 的 exe 跑着就删不掉），而是落到
// 数据目录的 .pending/ 里，下次启动时在发现之前换上（applyPending）——所以都要重启生效。
// 离线包与主程序必须是同一次打包：主程序根目录的 bridge-build.json 记着 buildId，装的扩展清单里的
// buildId 对不上就不加载（前端 chunk 名、核心接口都按那一次构建对齐）。仓库满配没有这个文件，不校验。
//
// 发现（读清单）是同步的、导入即做；加载（import 入口）是异步的，由 server.mjs 在挂路由前
// await loadModules()。没加载成功的扩展只是「不可用」，绝不让核心起不来。
//
// 入口可导出的钩子（都可选；核心只经下面这些函数调用，不直接 import 扩展的文件）：
//   runnable(agentId)                         这台机器上跑不跑得起来（如 Codex 要 CLI）
//   register(router, { authOk, identify })    挂路由（在核心路由之后挂）
//   startup({ production })                   挂完路由、开始监听前调一次（预热之类）
//   chat: { <聊天 agent 字段>: (req, res, { parsed, message, sessionId, ctx, attachments }) }
//         POST /api/chat 的分支；attachments(额外根目录[]) 返回过了守卫的附件路径。准入（ctx.allow*）核心已判。
//   claude: { hostNudge(ctx), nudge(ctx), mcp(ctx, { getGen }) }   给 Claude 主聊天 / 定时任务的提示段与工具
//   routines: { <routine.agent>: async (ctx, r) => ({ sessionId, text, isError }) }   定时任务的引擎
//   其余具名导出供核心经 getModule(id) 按需取（控制台、预览子域等）。
//
// 测试开关：BRIDGE_MODULES_SKIP=codex,dimensio（或 all）假装这些扩展没装，在满配仓库里模拟基础版；
// BRIDGE_MODULES_BUILTIN=0 不看仓库内置目录，只认数据目录里装的（模拟客户端装离线包）。

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROGRAM_ROOT, DATA_ROOT } from '../runtime/paths.mjs';
import { installCoreResolver } from './core-resolve.mjs';

// 目录固定三项：id 即目录名；agents 是它撑起的 agent（config/agents.mjs 的统一 id）。
// 不在目录里的（含数据目录里残留的旧扩展）一律不发现、不加载：扩展中心不列、离线包不认。
export const MODULE_CATALOG = Object.freeze([
  { id: 'vertex', label: 'Gemini · Vertex', agents: ['gemini'] },
  { id: 'codex', label: 'ChatGPT · Codex', agents: ['codex'] },
  { id: 'dimensio', label: 'dimensio', agents: ['dimensio'] },
]);
const CATALOG_BY_ID = Object.fromEntries(MODULE_CATALOG.map((m) => [m.id, m]));
const MODULE_OF_AGENT = Object.fromEntries(MODULE_CATALOG.flatMap((m) => m.agents.map((a) => [a, m.id])));

export const MANIFEST_NAME = 'bridge-module.json';
export const BUILTIN_MODULES_DIR = path.join(PROGRAM_ROOT, 'modules');
export const INSTALLED_MODULES_DIR = path.resolve(process.env.BRIDGE_MODULES_DIR || path.join(DATA_ROOT, 'modules'));

const SKIP = new Set(String(process.env.BRIDGE_MODULES_SKIP || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const skipped = (id) => SKIP.has('all') || SKIP.has(id);
const USE_BUILTIN = process.env.BRIDGE_MODULES_BUILTIN !== '0';

// 数据目录里的工作区：.pending/<id>/ 待换上的新版、.pending/<id>.remove 待卸载标记、
// .staging/ 上传解包中、.trash/ 换下来的旧版（<id>-<毫秒时间>；什么时候删见 sweepTrash）。
export const PENDING_DIR = path.join(INSTALLED_MODULES_DIR, '.pending');
export const STAGING_DIR = path.join(INSTALLED_MODULES_DIR, '.staging');
const TRASH_DIR = path.join(INSTALLED_MODULES_DIR, '.trash');

// 换下来的旧版里还有要等扩展自己救走的数据：dimensio 扩展加载时把 .trash/dimensio-<时间>/harness 里的设置页 key、
// 自定义服务、运行配置、项目表、会话等复制进它的数据目录（modules/dimensio/server/runtime/harness-data.mjs）。
// 复制失败时那一轮 harness 直接用着旧版里的原件、下次启动再试；大目录搬到一半进程被结束，下次启动也要重搬——
// 这两种情形下旧版都还删不得。items / marker 与 harness-data.mjs 的 HARNESS_DATA_ITEMS / MIGRATED_MARKER
// 一一对应（manage.test.mjs 对拍）；迁移目标同 planHarnessData：DIMENSIO_DATA_DIR，没给就是 <数据根>/dimensio。
export const TRASH_RESCUE = Object.freeze({
  dimensio: Object.freeze({
    dir: 'harness',
    marker: '.migrated',
    items: Object.freeze(['.env', 'runtime-config.json', 'projects.json', 'custom-providers', 'quick.json', 'sessions', 'memory', 'knowledge', 'workspace']),
    targetEnv: 'DIMENSIO_DATA_DIR',
    targetDefault: 'dimensio',
  }),
});
// 没救完的旧版每个扩展最多留几份（新的在前，更早的照删），免得救不过来时 .trash 无限堆积。不按天数删：
// 复制一直失败时 harness 用的就是最近那份里的原件，删掉就是删正在用的数据。
const TRASH_KEEP_MAX = 3;
// 数据根 == 程序目录（维护者正式服）时 dimensio 不做迁移（planHarnessData），留着也没人来救。
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const RESCUE_ON = fold(path.resolve(DATA_ROOT)) !== fold(path.resolve(PROGRAM_ROOT));

// 主程序的打包号（P4 打包脚本写 bridge-build.json）；仓库 / 开发环境没有 = 不校验。
// BRIDGE_BUILD_ID 覆盖（测试用：在仓库里模拟打包好的主程序）。
export function baseBuildId() {
  if (process.env.BRIDGE_BUILD_ID) return process.env.BRIDGE_BUILD_ID;
  try {
    const raw = readFileSync(path.join(PROGRAM_ROOT, 'bridge-build.json'), 'utf8');
    return String(JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).buildId || '') || null;
  } catch { return null; }
}

// 发行渠道（开源路线 N5：首发公开版不带 Codex 扩展）。环境变量 BRIDGE_EDITION 优先，其次主程序 bridge-build.json 的
// edition（stage.ps1 写）；都没有回 ''（git 部署、旧安装包）。
let editionCache;
export function buildEdition() {
  if (process.env.BRIDGE_EDITION) return process.env.BRIDGE_EDITION === 'public' ? 'public' : 'private';
  if (editionCache !== undefined) return editionCache;
  try {
    const raw = readFileSync(path.join(PROGRAM_ROOT, 'bridge-build.json'), 'utf8');
    const e = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).edition;
    editionCache = e === 'public' ? 'public' : e ? 'private' : '';
  } catch { editionCache = ''; }
  return editionCache;
}
// 这一版提不提供某个扩展（扩展中心与 Agent 页据此隐去，别让人去找一个不存在的离线包）。装上了的（或排着待装的）一律照常列出。
// 公开版不提供 codex；没有打包信息的 git 部署里也没有 modules/codex 时同样不提供（公开仓的克隆）。
// 发行版另有取舍时由部署声明：BRIDGE_MODULES_HIDE=vertex,codex（Muse Bridge 不带 Gemini / Codex）——没装的就不列。
const HIDE = new Set(String(process.env.BRIDGE_MODULES_HIDE || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
export function moduleOffered(id) {
  if (HIDE.has(id) && !found[id]) return false;
  if (id !== 'codex') return true;
  if (found[id] || existsSync(path.join(PENDING_DIR, id, MANIFEST_NAME))) return true;
  if (buildEdition() === 'public') return false;
  return existsSync(path.join(BUILTIN_MODULES_DIR, id, MANIFEST_NAME)) || !!baseBuildId();
}

// 启动时把扩展中心排好的改动换上（只碰数据目录，不碰仓库内置）；换下来的旧版进 .trash，随后清理 .trash（sweepTrash）。
function applyPending() {
  const fresh = new Set();
  try { applyPendingInto(fresh); }
  finally { sweepTrash(fresh); }
}

// 目标「有数据」：存在且不是空目录 / 空文件（同 harness-data.mjs hasData：入口脚本预建的空目录、空 .env 不算）。
function hasData(p) {
  let st;
  try { st = statSync(p); } catch { return false; }
  if (st.isDirectory()) { try { return readdirSync(p).length > 0; } catch { return true; } }
  return st.size > 0;
}

// 这份换下来的旧版里，扩展要救的数据是不是都救完了。每一项满足其一即可：
//   · 旧版里这一项没数据；
//   · 记进了旧版的 .migrated（复制成功）；
//   · 迁移目标那一项已经有数据——扩展只往空位置复制，这份旧的再也用不上（也含「复制完、没来得及写 .migrated
//     进程就被结束」的情形：复制先拷到临时名、改名就位，就位了才算有）。
// 复制失败（目标留空、harness 本轮直接用着旧版里的原件）、搬到一半被结束（临时名下次启动由 dimensio 清掉）都算没救完。
function rescued(entry, r) {
  const src = path.join(entry, r.dir);
  if (!existsSync(src)) return true;
  let done = null;
  try { done = JSON.parse(readFileSync(path.join(src, r.marker), 'utf8'))?.items; } catch {}
  const target = path.resolve(String(process.env[r.targetEnv] || '').trim() || path.join(DATA_ROOT, r.targetDefault));
  return r.items.every((n) => !hasData(path.join(src, n)) || !!(done && typeof done === 'object' && done[n]) || hasData(path.join(target, n)));
}

function dropTrash(name) {
  try { rmSync(path.join(TRASH_DIR, name), { recursive: true, force: true }); }
  catch (e) { console.error('[modules] .trash/' + name + ' 删不掉（下次启动再试）：', (e && e.message) || e); }
}

// .trash 的清理（每次启动都跑，不只是有待生效改动的那次）：
//   · 本次刚换下来的（fresh）一律留着——要救数据的扩展还没加载。客户端自动更新时新核心和新扩展同一次启动换上，
//     当场删掉的话旧数据在迁移之前就没了；
//   · 要救数据的扩展（TRASH_RESCUE）换下来的旧版：数据救完才删，没救完的留着，每个扩展最多留 TRASH_KEEP_MAX 份；
//   · 其余的删掉。
function sweepTrash(fresh) {
  let names = [];
  try { names = readdirSync(TRASH_DIR); } catch { return; }
  const held = new Map();   // 扩展 id → 还没救完的旧版 [{ name, ts }]
  for (const name of names) {
    if (fresh.has(name)) continue;
    const m = /^(.+)-(\d+)$/.exec(name);
    const r = m && RESCUE_ON && Object.hasOwn(TRASH_RESCUE, m[1]) ? TRASH_RESCUE[m[1]] : null;
    let keep = false;
    if (r) { try { keep = !rescued(path.join(TRASH_DIR, name), r); } catch { keep = true; } }
    if (!keep) { dropTrash(name); continue; }
    if (!held.has(m[1])) held.set(m[1], []);
    held.get(m[1]).push({ name, ts: Number(m[2]) });
  }
  for (const [id, list] of held) {
    list.sort((a, b) => b.ts - a.ts);
    list.forEach((e, i) => {
      if (i < TRASH_KEEP_MAX) { console.log('[modules] .trash/' + e.name + ' 里还有没迁走的 ' + id + ' 旧数据，先留着（迁完后下次启动再删）'); return; }
      console.warn('[modules] .trash/' + e.name + ' 里还有没迁走的 ' + id + ' 旧数据，但没救完的旧版已超过 ' + TRASH_KEEP_MAX + ' 份，删掉较早的这份');
      dropTrash(e.name);
    });
  }
}

function applyPendingInto(fresh) {
  if (!existsSync(PENDING_DIR)) return;
  for (const cat of MODULE_CATALOG) {
    const next = path.join(PENDING_DIR, cat.id);
    const marker = path.join(PENDING_DIR, cat.id + '.remove');
    let hasNext = existsSync(path.join(next, MANIFEST_NAME));
    // 自动更新会在装新主程序之前就把新版扩展排进来：主程序没装上（还是旧的打包号）时先别换，
    // 否则换上去也会因打包号对不上而不加载——留着，等主程序跟上那次启动再换。
    if (hasNext) {
      const build = baseBuildId();
      let want = '';
      try { const raw = readFileSync(path.join(next, MANIFEST_NAME), 'utf8'); want = String(JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).buildId || ''); } catch {}
      if (build && want && want !== build) { console.log('[modules] ' + cat.id + ' 的待装版本是给另一版主程序的（' + want + '），先不换'); hasNext = false; }
    }
    if (!hasNext && !existsSync(marker)) continue;
    const cur = path.join(INSTALLED_MODULES_DIR, cat.id);
    try {
      if (existsSync(cur)) {
        mkdirSync(TRASH_DIR, { recursive: true });
        const name = cat.id + '-' + Date.now();
        renameSync(cur, path.join(TRASH_DIR, name));
        fresh.add(name);
      }
      if (hasNext) renameSync(next, cur);
      rmSync(marker, { force: true });
      console.log('[modules] ' + cat.id + (hasNext ? ' 已换上新装的版本' : ' 已卸载'));
    } catch (e) {
      console.error('[modules] ' + cat.id + ' 待生效的改动没换上（下次启动再试）：', (e && e.message) || e);
    }
  }
}

function readManifest(dir, id) {
  const file = path.join(dir, MANIFEST_NAME);
  if (!existsSync(file)) return null;
  let m;
  try { const raw = readFileSync(file, 'utf8'); m = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); }
  catch (e) { return { error: '清单解析失败：' + (e?.message || e) }; }
  if (!m || m.id !== id) return { error: '清单 id 与目录名不符' };
  const entry = String(m.entry || 'server/index.mjs');
  const entryPath = path.resolve(dir, entry);
  if (!entryPath.startsWith(path.resolve(dir) + path.sep)) return { error: '清单 entry 越出扩展目录' };
  if (!existsSync(entryPath)) return { error: '缺入口文件 ' + entry };
  return { manifest: m, entryPath };
}

// 发现：每个 id 取第一个有清单的位置（内置优先）。
function discover() {
  const out = {};
  const roots = [...(USE_BUILTIN ? [[BUILTIN_MODULES_DIR, 'builtin']] : []), [INSTALLED_MODULES_DIR, 'installed']];
  for (const cat of MODULE_CATALOG) {
    if (skipped(cat.id)) continue;
    for (const [root, source] of roots) {
      const dir = path.join(root, cat.id);
      const r = readManifest(dir, cat.id);
      if (!r) continue;
      const build = baseBuildId();
      if (source === 'installed' && build && r.manifest && String(r.manifest.buildId || '') !== build) {
        r.error = '与当前主程序版本不匹配（需要同一次打包的离线包）';
      }
      out[cat.id] = {
        id: cat.id, source, dir,
        version: r.manifest ? String(r.manifest.version || '') : '',
        entryPath: r.entryPath || null,
        error: r.error || null,
        exports: null,
      };
      break;
    }
  }
  return out;
}

applyPending();
const found = discover();
let loading = null;

// 加载全部已发现的扩展（幂等）。单个扩展失败只记错误，不抛。
export function loadModules() {
  if (loading) return loading;
  installCoreResolver();
  loading = (async () => {
    for (const rec of Object.values(found)) {
      if (rec.error || !rec.entryPath) continue;
      try {
        rec.exports = await import(pathToFileURL(rec.entryPath).href);
      } catch (e) {
        rec.error = '加载失败：' + String(e?.message || e).slice(0, 300);
        console.error('[modules] ' + rec.id + ' ' + rec.error);
      }
    }
    const ok = Object.values(found).filter((r) => r.exports).map((r) => r.id + (r.source === 'installed' ? '@' + (r.version || '?') : ''));
    console.log('[modules] 已加载：' + (ok.join(', ') || '(无，基础版)'));
  })();
  return loading;
}

export function getModule(id) { return found[id]?.exports || null; }

// 已加载扩展自带的前端产物目录（离线包的 web/，结构同 public/app）；仓库内置的扩展前端本就在主构建里。
export function moduleWebDirs() {
  return MODULE_CATALOG.map((m) => found[m.id])
    .filter((r) => r && r.exports && r.source === 'installed')
    .map((r) => path.join(r.dir, 'web'))
    .filter((d) => existsSync(d));
}
export function moduleOfAgent(agentId) { return MODULE_OF_AGENT[agentId] || null; }

// 这个 agent 的代码在不在：核心 agent（claude）恒在；其余看所属扩展是否加载成功。
export function agentModuleLoaded(agentId) {
  const id = MODULE_OF_AGENT[agentId];
  return !id || !!found[id]?.exports;
}

// 扩展自报「这台机器上能不能跑」（例如 Codex 要找到 CLI）。扩展没写 runnable 视为能跑。
export function agentModuleRunnable(agentId) {
  const id = MODULE_OF_AGENT[agentId];
  if (!id) return true;
  const mod = found[id]?.exports;
  if (!mod) return false;
  return typeof mod.runnable === 'function' ? !!mod.runnable(agentId) : true;
}

// 给设置页 / 扩展中心看的状态；agent 没对应扩展（claude）时返回 null。
export function moduleStatus(id) {
  const cat = CATALOG_BY_ID[id];
  if (!cat) return null;
  const rec = found[id];
  return {
    id, label: cat.label, agents: cat.agents,
    installed: !!rec,
    loaded: !!rec?.exports,
    source: rec?.source || null,
    dir: rec?.dir || null,
    version: rec?.version || '',
    error: rec?.error || null,
  };
}

export function modulesState() { return MODULE_CATALOG.map((m) => moduleStatus(m.id)); }

// ── 钩子汇总 ────────────────────────────────────────────────────────────────
const loadedList = () => MODULE_CATALOG.map((m) => found[m.id]).filter((r) => r && r.exports);

function safe(id, what, fn, fallback) {
  try { return fn(); } catch (e) { console.error('[modules] ' + id + ' ' + what + ' 出错：', (e && e.message) || e); return fallback; }
}

export function registerModuleRoutes(router, deps) {
  for (const r of loadedList()) if (typeof r.exports.register === 'function') safe(r.id, 'register', () => r.exports.register(router, deps));
}

export function startModules(opts) {
  for (const r of loadedList()) if (typeof r.exports.startup === 'function') safe(r.id, 'startup', () => r.exports.startup(opts));
}

// POST /api/chat 的 agent 字段（vertex / codex）→ 处理函数；扩展没装就是 null。
export function moduleChat(chatAgent) {
  for (const r of loadedList()) {
    const h = r.exports.chat && Object.hasOwn(r.exports.chat, chatAgent) ? r.exports.chat[chatAgent] : null;
    if (typeof h === 'function') return h;
  }
  return null;
}

// Claude 的提示词：hostNudge 取第一个非空的（替换核心开场句），nudge 按目录顺序拼接。
export function moduleClaudeText(ctx) {
  let hostNudge = '', nudge = '';
  for (const r of loadedList()) {
    const c = r.exports.claude;
    if (!c) continue;
    if (!hostNudge && typeof c.hostNudge === 'function') hostNudge = safe(r.id, 'claude.hostNudge', () => c.hostNudge(ctx) || '', '');
    if (typeof c.nudge === 'function') nudge += safe(r.id, 'claude.nudge', () => c.nudge(ctx) || '', '');
  }
  return { hostNudge, nudge };
}

export function moduleClaudeMcp(ctx, opts = {}) {
  const out = {};
  for (const r of loadedList()) {
    const c = r.exports.claude;
    if (c && typeof c.mcp === 'function') Object.assign(out, safe(r.id, 'claude.mcp', () => c.mcp(ctx, opts) || {}, {}));
  }
  return out;
}

// 定时任务引擎（routine.agent → 函数）；扩展没装就是 null。
export function moduleRoutine(agent) {
  for (const r of loadedList()) {
    const h = r.exports.routines && Object.hasOwn(r.exports.routines, agent) ? r.exports.routines[agent] : null;
    if (typeof h === 'function') return h;
  }
  return null;
}
