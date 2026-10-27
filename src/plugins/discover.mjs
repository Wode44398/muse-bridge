// 插件从哪来、怎么登记进内核：
//   1. 内置目录（catalog.mjs）——默认套装，随程序发布；
//   2. agent 扩展（Vertex / Codex / dimensio，modules/registry.mjs 管装卸）——以「agent」类插件出现在同一张表里，
//      开关仍在 Agent 页 / 功能扩展的 Agent 区（locked：插件表里不重复给开关）；
//   3. 第三方插件——装在数据根 plugins/<id>/（设置页上传 zip / agent 接口安装），或登记的本机开发目录（plugins.json 的 local）。
//
// 第三方插件目录：
//   bridge-plugin.json   { id, name, version, description, entry?（默认 index.mjs）, category?, requires?, restart?,
//                          config?（配置 schema）, author?, homepage?, web?: { page: 'web/index.html' },
//                          ui?: { panel, settings, who }（面板槽位，见 normUi）, engines?: { bridge: '>=6.70', pluginApi: 2 } }
//   index.mjs            export function apply(ctx, config) { … }   （或 export default { apply }）
//   web/、README.md      可选
// 代码里引 bridge 核心模块写 '@bridge/core/<src 下的相对路径>'（与 agent 扩展同一个解析钩子）。

import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync as fsRenameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT } from '../runtime/paths.mjs';
import { BUILTIN_PLUGINS } from './catalog.mjs';
import { MODULE_CATALOG, getModule, moduleStatus } from '../modules/registry.mjs';
import { installCoreResolver } from '../modules/core-resolve.mjs';
import { enginesProblem } from './engines.mjs';

export const MANIFEST = 'bridge-plugin.json';
export const INSTALLED_PLUGINS_DIR = path.resolve(process.env.BRIDGE_PLUGINS_DIR || path.join(DATA_ROOT, 'plugins'));
const STAGING = path.join(INSTALLED_PLUGINS_DIR, '.staging');
const TRASH = path.join(INSTALLED_PLUGINS_DIR, '.trash');
const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

export class PluginError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const readJsonFile = (f) => {
  const raw = readFileSync(f, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
};

// 读一个插件目录的清单并做基本校验；坏了抛 PluginError（安装时报给用户，启动时记成该插件的错误）。
export function readPluginDir(dir) {
  const file = path.join(dir, MANIFEST);
  if (!existsSync(file)) throw new PluginError(400, `缺 ${MANIFEST}（插件目录根上要有清单文件）`);
  let m;
  try { m = readJsonFile(file); } catch (e) { throw new PluginError(400, `${MANIFEST} 不是合法 JSON：${e.message}`); }
  if (!m || typeof m !== 'object') throw new PluginError(400, `${MANIFEST} 应为对象`);
  if (!ID_RE.test(m.id || '')) throw new PluginError(400, 'id 不合法（小写字母开头，只用小写字母、数字、连字符，≤48 字）');
  const entry = String(m.entry || 'index.mjs');
  const entryPath = path.resolve(dir, entry);
  if (!entryPath.startsWith(path.resolve(dir) + path.sep)) throw new PluginError(400, 'entry 越出插件目录');
  if (!existsSync(entryPath)) throw new PluginError(400, '缺入口文件 ' + entry);
  // engines：要的 bridge 版本 / 插件接口版本这台满足不了就拒装、拒加载（engines.mjs）
  const why = enginesProblem(m);
  if (why) throw new PluginError(409, why);
  return { manifest: m, entryPath };
}

// 清单的界面声明 → { panel: { page, title, icon } | null, settings: 页面 | null, who: 'host' | 'members' }。
// 页面一律要在 web/ 下（由 /plugins/<id>/web/ 提供）；旧写法 web.page 等同 ui.panel.page。
export function normUi(m) {
  const ui = m.ui && typeof m.ui === 'object' ? m.ui : {};
  const page = (v) => {
    const p = typeof v === 'string' ? v.replace(/\\/g, '/') : '';
    return /^web\/[^?#]+$/.test(p) && !p.includes('..') ? p : null;
  };
  const rawPanel = ui.panel != null ? ui.panel : (m.web && typeof m.web.page === 'string' ? { page: m.web.page } : null);
  const pp = rawPanel && page(typeof rawPanel === 'string' ? rawPanel : rawPanel.page);
  const panel = pp ? {
    page: pp,
    title: String((typeof rawPanel === 'object' && rawPanel.title) || m.name || m.id).slice(0, 30),
    icon: /^[a-z][a-z0-9-]{0,23}$/.test(String(rawPanel.icon || '')) ? rawPanel.icon : 'puzzle',
  } : null;
  const settings = page(typeof ui.settings === 'string' ? ui.settings : ui.settings && ui.settings.page);
  return { panel, settings, who: ui.who === 'members' ? 'members' : 'host' };
}

function entryOf(dir, source) {
  const { manifest: m, entryPath } = readPluginDir(dir);
  const url = pathToFileURL(entryPath).href;
  return {
    id: m.id,
    name: String(m.name || m.id).slice(0, 60),
    description: String(m.description || '').slice(0, 500),
    category: String(m.category || 'third-party'),
    version: String(m.version || ''),
    author: String(m.author || ''),
    homepage: String(m.homepage || ''),
    requires: Array.isArray(m.requires) ? m.requires.filter((x) => typeof x === 'string') : [],
    restart: !!m.restart,
    defaultEnabled: m.defaultEnabled !== false,
    config: m.config || null,
    web: m.web && typeof m.web === 'object' ? { page: typeof m.web.page === 'string' ? m.web.page : null } : null,
    extra: { ui: normUi(m) },
    source,
    dir,
    // rev 递增 = 重新加载：查询串让 Node 当成新模块；入口里的相对 import 由 core-resolve 的钩子带上同一个 rev。
    load: (rev) => import(url + (rev ? '?bpv=' + rev : '')),
  };
}

// ── 启动时登记全部 ─────────────────────────────────────────────────────────
export async function registerAll(kernel) {
  installCoreResolver();
  for (const e of BUILTIN_PLUGINS) {
    if (typeof e.available === 'function' && !e.available()) continue;
    const { available, defaultEnabled, ...rest } = e;
    kernel.register({ ...rest, source: 'builtin', defaultEnabled: typeof defaultEnabled === 'function' ? !!defaultEnabled() : defaultEnabled !== false });
  }
  for (const cat of MODULE_CATALOG) registerModulePlugin(kernel, cat);
  const seen = new Set();
  // 装好的
  let names = [];
  try { names = readdirSync(INSTALLED_PLUGINS_DIR).filter((n) => !n.startsWith('.')); } catch {}
  for (const n of names) {
    const dir = path.join(INSTALLED_PLUGINS_DIR, n);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    registerDir(kernel, dir, 'installed', seen);
  }
  // 登记的本机开发目录
  for (const p of kernel.readState().local) registerDir(kernel, String(p), 'local', seen);
}

function registerDir(kernel, dir, source, seen) {
  try {
    const e = entryOf(dir, source);
    if (seen.has(e.id) || kernel.has(e.id)) {
      console.error(`[plugins] ${dir} 的 id「${e.id}」和已有插件重名，没登记`);
      return null;
    }
    seen.add(e.id);
    kernel.register(e);
    return e.id;
  } catch (e) {
    console.error(`[plugins] ${dir} 没登记：${e.message}`);
    return null;
  }
}

// agent 扩展：代码已由 server.mjs 早早 loadModules() 载入（agent 能不能跑要先看扩展在不在），这里把它的
// 路由 / 预热接进插件生命周期。没装的扩展不进表（安装入口在功能扩展的 Agent 区）。
function registerModulePlugin(kernel, cat) {
  const st = moduleStatus(cat.id);
  if (!st || !st.installed) return;
  kernel.register({
    id: cat.id,
    name: cat.label,
    description: { vertex: 'Gemini 对话页，以及 Claude 的图像 / 视频 / 语音 / 音乐生成工具（media）。', codex: 'ChatGPT 页：本机 Codex 驱动的对话与编程。', dimensio: 'dimensio 页：多模型 agent 工作台。' }[cat.id] || '',
    category: 'agent',
    source: 'module',
    version: st.version || '',
    dir: st.dir,
    locked: true,
    restart: true,
    extra: { moduleSource: st.source, agents: cat.agents },
    load: async () => {
      const mod = getModule(cat.id);
      if (!mod) throw new Error(moduleStatus(cat.id)?.error || '扩展没加载成功');
      return {
        apply(ctx) {
          const a = ctx.service('auth');
          if (typeof mod.register === 'function') mod.register(ctx.router, { authOk: a.authOk, identify: a.identify });
          if (typeof mod.startup === 'function') ctx.when('ready', () => { mod.startup({ production: ctx.service('runtime').production }); });
        },
      };
    },
  });
}

// ── 安装 / 卸载 / 本机目录 ─────────────────────────────────────────────────
const firstExisting = (list) => list.find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
// 钉死 System32 的 bsdtar：裸跑 'tar' 可能命中 Git 的 GNU tar，把 C:\… 当远程主机（扩展中心同款坑）。
const BSDTAR = () => firstExisting(['C:\\Windows\\System32\\tar.exe', '/usr/bin/bsdtar', '/usr/bin/tar']) || 'tar';
const execFileAsync = promisify(execFile);
const runTar = (args) => execFileAsync(BSDTAR(), args, { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });

function sanitizeTree(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) { rmSync(p, { recursive: true, force: true }); continue; }
    if (ent.isDirectory()) sanitizeTree(p);
  }
}

// 清单可以在包根，也可以在唯一的一层子目录里（GitHub 打包的 zip 都多套一层 <仓库>-<分支>/）。
function findPluginRoot(dir) {
  if (existsSync(path.join(dir, MANIFEST))) return dir;
  const subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX');
  if (subs.length === 1 && existsSync(path.join(dir, subs[0].name, MANIFEST))) return path.join(dir, subs[0].name);
  throw new PluginError(400, `包里找不到 ${MANIFEST}（放在压缩包根上，或唯一的一层子目录里）`);
}

// Windows 上刚解压 / 刚写完的文件常被杀毒或索引短暂占着，改名报 EPERM / EBUSY：等一下重试几次。
function renameSync(from, to) {
  for (let i = 0; ; i++) {
    try { return fsRenameSync(from, to); }
    catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60 * (i + 1));
    }
  }
}

const moveToTrash = (dir, id) => {
  mkdirSync(TRASH, { recursive: true });
  const dst = path.join(TRASH, id + '-' + Date.now());
  renameSync(dir, dst);
  // 换下来的旧版只留最近几份
  try {
    const old = readdirSync(TRASH).filter((n) => n.startsWith(id + '-')).sort().reverse().slice(3);
    for (const n of old) rmSync(path.join(TRASH, n), { recursive: true, force: true });
  } catch {}
};

// 从 zip 安装（或覆盖安装同 id 的已装插件）。返回插件摘要。
export async function installFromArchive(kernel, buf) {
  if (!buf || !buf.length) throw new PluginError(400, '没收到文件');
  const work = path.join(STAGING, crypto.randomBytes(6).toString('hex'));
  mkdirSync(work, { recursive: true });
  const tmp = path.join(STAGING, path.basename(work) + '.zip');
  writeFileSync(tmp, buf);
  try {
    try { await runTar(['-xf', tmp, '-C', work]); }
    catch { await runTar(['--options', 'hdrcharset=UTF-8', '-xf', tmp, '-C', work]); }
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw new PluginError(400, '压缩包解不开（要 .zip）：' + String(e.stderr || e.message).slice(0, 200));
  } finally { rmSync(tmp, { force: true }); }
  try {
    sanitizeTree(work);
    const root = findPluginRoot(work);
    const { manifest } = readPluginDir(root);
    return await placePlugin(kernel, root, manifest.id);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

async function placePlugin(kernel, srcDir, id) {
  const existing = kernel.get(id);
  if (existing && existing.source !== 'installed') throw new PluginError(409, `id「${id}」已被${existing.source === 'local' ? '本机开发目录' : '内置功能'}占用`);
  const dest = path.join(INSTALLED_PLUGINS_DIR, id);
  mkdirSync(INSTALLED_PLUGINS_DIR, { recursive: true });
  if (existing) {
    // 覆盖安装：换目录，再按新代码重新加载（热插件当场换上；要重启的插件新代码下次启动生效——
    // 内存里跑着的是已加载的旧模块，换掉磁盘上的文件不影响它）
    if (existsSync(dest)) moveToTrash(dest, id);
    renameSync(srcDir, dest);
    const e = entryOf(dest, 'installed');
    kernel.update(id, e);
    if (existing.restart) return { ...kernel.get(id), pendingRestart: true };
    return kernel.reload(id, e.load);
  }
  if (existsSync(dest)) moveToTrash(dest, id);
  renameSync(srcDir, dest);
  const e = entryOf(dest, 'installed');
  return kernel.register(e);
}

export async function uninstallPlugin(kernel, id) {
  const p = kernel.get(id);
  if (!p) throw new PluginError(404, '没有插件「' + id + '」');
  if (p.source === 'local') return unlinkLocal(kernel, id);
  if (p.source !== 'installed') throw new PluginError(400, '内置功能只能关，不能卸载');
  await kernel.unregister(id);
  const dir = path.join(INSTALLED_PLUGINS_DIR, id);
  if (existsSync(dir)) moveToTrash(dir, id);
  kernel.writeState((s) => { delete s.plugins[id]; if (s.sources) delete s.sources[id]; });
  return { id, removed: true };
}

// 登记本机开发目录：直接从那儿加载，改了代码点「重新加载」即生效（不用打包安装）。
export async function linkLocal(kernel, dir) {
  const abs = path.resolve(String(dir || ''));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new PluginError(400, '目录不存在：' + abs);
  const e = entryOf(abs, 'local');
  if (kernel.has(e.id)) throw new PluginError(409, `id「${e.id}」已有同名插件`);
  kernel.writeState((s) => { if (!s.local.some((p) => path.resolve(p) === abs)) s.local.push(abs); });
  return kernel.register(e);
}

export async function unlinkLocal(kernel, id) {
  const p = kernel.get(id);
  if (!p || p.source !== 'local') throw new PluginError(404, '「' + id + '」不是登记的本机目录');
  await kernel.unregister(id);
  kernel.writeState((s) => { s.local = s.local.filter((x) => path.resolve(x) !== path.resolve(p.dir)); delete s.plugins[id]; });
  return { id, removed: true };
}

// 重新加载：清单可能也改了（名字、配置 schema），一起重读。
export async function reloadPlugin(kernel, id) {
  const p = kernel.get(id);
  if (!p) throw new PluginError(404, '没有插件「' + id + '」');
  if (p.source !== 'installed' && p.source !== 'local') throw new PluginError(400, '内置功能随程序更新，不需要重新加载');
  const e = entryOf(p.dir, p.source);
  if (e.id !== id) throw new PluginError(400, `清单里的 id 改成了「${e.id}」——请先卸载再按新 id 装`);
  kernel.update(id, e);
  return kernel.reload(id, e.load);
}

export const pluginWebDir = (p) => (p && p.dir && (p.source === 'installed' || p.source === 'local') ? path.join(p.dir, 'web') : null);
