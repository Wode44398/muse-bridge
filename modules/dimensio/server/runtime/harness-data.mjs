// dimensio（harness）可写状态的落点，与旧数据的一次性迁移（S2，10-21）。
//
// harness 默认把运行配置、项目表、自定义模型服务（设置页填的厂商 key 与自定义端点，加密存）、快照指针、会话、记忆、
// 知识、默认工作区和 .env 都放在自己的工作目录里（harness/server/paths.ts）。程序目录内置的 harness/（源码 / 镜像部署：
// 维护者正式服、install-windows、install.sh、Docker、测试服、开发实例）一直这样用，这里不改它的默认位置。
// 要改的只有「扩展自带的 harness」（离线包装在 <数据根>/modules/dimensio/harness，安装包本机服务端就是这样）：扩展一更新 /
// 卸载，整个目录进 .trash 被删，里面的设置、key、项目表跟着没了。所以这种部署里 bridge 拉起管理员实例时给
// DIMENSIO_DATA_DIR=<数据根>/dimensio，harness 原本落在自己目录里的默认位置一律改落到那里（各项自己的环境变量 / .env 里写的
// 照旧优先），默认工作区没人指定时用 bridge 工作空间（同向导一直写的）；并在第一次拉起前把旧位置里已有的数据复制过去：
//   · 只往「目标还没有数据」的位置复制（不存在、空目录、空文件），绝不覆盖已有的新数据；
//   · 旧数据原样留着（不删不挪），来源目录里写一份 .migrated 记下搬过哪些、搬到哪，之后不再重复搬；
//   · 某项这次没复制成：本次先让 harness 直接用原件（目标留空），下次启动再试——不从空目录起、也不把「空」当成已迁移；
//   · 数据根 == 程序目录（维护者正式服）时整个是空操作：不设 DIMENSIO_DATA_DIR、不读不写任何文件。
// 内置 harness 的部署只做一件事：搬家工具 migrate/import 把源码形态那份 harness/ 原样落在 <数据根>/harness，而 Docker /
// install.sh 把会话、记忆等逐项指到了 <数据根>/dimensio——这些显式指到那里、还空着的项从 <数据根>/harness 补过去。
//
// 旧数据可能在的地方（按优先级）：扩展自带的 harness 目录；<数据根>/harness（搬家工具落地处）；
// <扩展目录>/.trash/dimensio-<时间>/harness（扩展刚被换下来、还没清掉的旧版；数据没救完的旧版 registry 不删、每个扩展最多留
// 3 份，所以「下次启动再试」成立——数据项名单与 src/modules/registry.mjs 的 TRASH_RESCUE 一一对应，增减要两边同步）。
// 来源只认数据根 / 扩展目录里面的位置，且绝不是程序目录里内置的 harness/：测试和开发实例常把数据根指到临时目录、却仍用
// 仓库里那份 harness（那里是维护者正式服的真数据，含 .env 明文 key 与 GB 级会话），不能被拷过去。
//
// 工作区特殊：会话和项目表里记着它的绝对路径（迁移只复制不改写）。所以它只从「会被整个删掉」的旧位置（扩展目录、.trash）
// 抢救性复制；稳定的旧位置（<数据根>/harness）不复制，没人指定工作区时直接让工作区指过去——复制一份就成了新旧两份各自变化。
//
// 纯函数 + 显式参数，便于用临时目录测；harness.mjs 负责接到真实的数据根 / 程序目录 / harness 目录上。

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

// harness 目录里会被写的东西 ↔ harness 认的覆盖变量（paths.ts）。.env 排第一：后面几项要看它里面有没有单独改道。
// referenced：别处记着它的绝对路径（工作区），见文件头。
export const HARNESS_DATA_ITEMS = Object.freeze([
  { name: '.env', env: 'HARNESS_ENV_FILE' },
  { name: 'runtime-config.json', env: 'DIMENSIO_CONFIG_FILE' },
  { name: 'projects.json', env: 'PROJECTS_FILE' },
  { name: 'custom-providers', env: 'DIMENSIO_CUSTOM_PROVIDERS_DIR' },
  { name: 'quick.json', env: 'DIMENSIO_QUICK_FILE' },
  { name: 'sessions', env: 'SESSIONS_DIR' },
  { name: 'memory', env: 'MEMORY_DIR' },
  { name: 'knowledge', env: 'KNOWLEDGE_DIR' },
  { name: 'workspace', env: 'WORKSPACE_DIR', referenced: true },
]);
// 数据目录里预先建好的空目录（同 docker/entrypoint.sh 与用户实例 tenantFor）：默认工作区不存在时会话起不来。
const ENSURE_DIRS = new Set(['sessions', 'memory', 'knowledge', 'workspace']);
export const MIGRATED_MARKER = '.migrated';
// 复制途中的临时名（copyItem）：<目标>.migrating-<pid>-<6 位十六进制>。只可能是这里产生的。
const MIGRATING_RE = /^(.+)\.migrating-(\d+)-[0-9a-f]{6}$/;

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function real(p) {
  try { return realpathSync.native(p); } catch { return path.resolve(p); }
}
// 同一个位置：字面（大小写 / 尾斜杠不计）或解析链接、8.3 短名之后相同。
export function samePath(a, b) {
  if (!a || !b) return false;
  return fold(path.resolve(a)) === fold(path.resolve(b)) || fold(real(a)) === fold(real(b));
}
// child 在 parent 里面（含相同）。
function within(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(fold(real(parent)), fold(real(child)));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/**
 * 管理员实例的数据目录与迁移方式。
 * @param {object} o
 * @param {string} o.dataRoot        bridge 数据根
 * @param {string} o.programRoot     bridge 程序目录（内置 harness 在它的 harness/ 下）
 * @param {string} o.harnessDir      当前 harness 目录（harness-dir.mjs 解析的结果）
 * @param {string|null} [o.modulesDir]  扩展安装目录（BRIDGE_MODULES_DIR 可把它放到数据根之外）
 * @returns {{ dataDir: string|null, targetDir: string|null, migrate: boolean, packaged: boolean }}
 *   dataDir    给 harness 的 DIMENSIO_DATA_DIR；null = 不设（harness 默认位置照旧是它自己的目录）
 *   targetDir  迁移的目标目录：只有实际落点就是 <targetDir>/<名> 的项才会被补数据
 *   migrate    要不要跑 prepareHarnessData；数据根 == 程序目录（维护者正式服）一律 false
 *   packaged   harness 是扩展自带的（会随扩展整个换掉）：这时才改默认位置、建数据目录、定默认工作区
 */
export function planHarnessData({ dataRoot, programRoot, harnessDir, modulesDir = null, env = process.env }) {
  const explicit = String(env.DIMENSIO_DATA_DIR || '').trim();
  const explicitDir = explicit ? path.resolve(explicit) : null;
  if (!dataRoot || !programRoot || samePath(dataRoot, programRoot)) return { dataDir: explicitDir, targetDir: null, migrate: false, packaged: false };
  const builtin = path.join(programRoot, 'harness');
  const packaged = !!harnessDir && !within(harnessDir, builtin) && (within(harnessDir, dataRoot) || within(harnessDir, modulesDir));
  const dir = explicitDir || path.join(path.resolve(dataRoot), 'dimensio');
  if (packaged) return { dataDir: dir, targetDir: dir, migrate: true, packaged: true };
  // 内置 harness：默认位置不动（显式给了 DIMENSIO_DATA_DIR 就是部署者自己定的，照传）；只补搬家工具落地的旧数据（见文件头）。
  return { dataDir: explicitDir, targetDir: dir, migrate: true, packaged: false };
}

// 管理员实例实际加载的 .env：显式 HARNESS_ENV_FILE > <数据目录>/.env > <harness 目录>/.env（harness 按自己的工作目录解析相对路径）。
export function harnessEnvFile({ dataDir, harnessDir, env = process.env }) {
  const explicit = String(env.HARNESS_ENV_FILE || '').trim();
  if (explicit) return path.resolve(harnessDir, explicit);
  return path.join(dataDir || harnessDir, '.env');
}

function readEnvFile(file) {
  if (!file) return {};
  try { return parseEnv(readFileSync(file, 'utf8')); } catch { return {}; }
}

// 某个变量有没有被「显式」给值（空串等于没给：harness paths.ts 的 fromEnv 同样这么认）。
const given = (v) => String(v ?? '').trim();

// 这一项在 harness 里实际会落在哪：进程环境 > .env 里写的（.env 不覆盖已有的进程环境）> 这里定的默认 > <默认目录>/<名>。
// .env 自己的位置只看进程环境（harness 先定位 .env 再加载它）。
function effectiveTarget(item, { home, harnessDir, env, envVars, defaults = {} }) {
  const fromFile = item.env === 'HARNESS_ENV_FILE' ? undefined : envVars[item.env];
  const v = given(env[item.env]) || given(fromFile) || given(defaults[item.env]);
  return v ? path.resolve(harnessDir, v) : path.join(home, item.name);
}

// 目标「还没有数据」：不存在、空目录、空文件。Docker 入口、install.sh 会先建好空目录和空 .env，那不算数据。
function hasData(p) {
  let st;
  try { st = statSync(p); } catch { return false; }
  if (st.isDirectory()) { try { return readdirSync(p).length > 0; } catch { return true; } }
  return st.size > 0;
}

function readMarker(dir) {
  try {
    const m = JSON.parse(readFileSync(path.join(dir, MIGRATED_MARKER), 'utf8'));
    return m && typeof m === 'object' && m.items && typeof m.items === 'object' ? m : { v: 1, items: {} };
  } catch { return { v: 1, items: {} }; }
}

// 扩展换下来的旧版（registry.mjs applyPending：<扩展目录>/.trash/dimensio-<毫秒时间>），新的在前。
export function trashedHarnessDirs(trashDir) {
  let names = [];
  try { names = readdirSync(trashDir); } catch { return []; }
  return names
    .map((n) => /^dimensio-(\d+)$/.exec(n))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map((m) => path.join(trashDir, m[0], 'harness'));
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

// 上次复制到一半被结束的进程留下的临时目录（SIGTERM 时没有在跑的 harness 就直接退出、Windows 上被硬杀，copyItem 的清理都走不到）：
// 起头先删掉。只认 <数据项名>.migrating-<pid>-<6 位十六进制>；那个 pid 还活着（另一个进程正在搬——同一数据根本不该跑两份）就不动。
async function sweepMigrating(dir, log) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return; }
  const items = new Set(HARNESS_DATA_ITEMS.map((i) => i.name));
  for (const n of names) {
    const m = MIGRATING_RE.exec(n);
    if (!m || !items.has(m[1])) continue;
    const pid = Number(m[2]);
    if (pid !== process.pid && pidAlive(pid)) continue;
    try {
      await fsp.rm(path.join(dir, n), { recursive: true, force: true });
      log(`[harness] 清掉上次复制到一半的残留：${path.join(dir, n)}`);
    } catch (e) { log(`[harness] 上次复制残留 ${path.join(dir, n)} 删不掉（下次启动再试）：${e?.message || e}`); }
  }
}

// Windows 上刚拷出来的一堆文件常被杀毒 / 索引短暂占着，改名报 EPERM / EBUSY / EACCES：短退避重试几次。
const RENAME_RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);
async function renameRetry(from, to, delays) {
  for (let i = 0; ; i++) {
    try { return await fsp.rename(from, to); } catch (e) {
      if (!RENAME_RETRY.has(e?.code) || i >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

// 复制一项：先拷到同目录的临时名再改名就位——拷到一半断电不会留下「半份但看着已存在」的目标（残留由 sweepMigrating 收）。
// 符号链接 / junction 跳过（Windows 上建链接要特权，拷进来也会把访问范围带出数据目录）。
async function copyItem(src, target, { retryDelays = [100, 250, 500, 1000, 2000] } = {}) {
  const tmp = `${target}.migrating-${process.pid}-${randomBytes(3).toString('hex')}`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    const st = await fsp.lstat(src);
    if (st.isSymbolicLink()) throw new Error('是链接，不搬');
    await fsp.cp(src, tmp, {
      recursive: true,
      errorOnExist: false,
      force: false,
      preserveTimestamps: true,
      filter: async (s) => { try { return !(await fsp.lstat(s)).isSymbolicLink(); } catch { return false; } },
    });
    // 目标是空目录 / 空文件（预先建好的占位）：先拿掉占位再就位。空目录用 rmdir（非递归）——这时冒出来东西就失败、不覆盖。
    try {
      const cur = await fsp.stat(target);
      if (cur.isDirectory()) await fsp.rmdir(target);
      else if (cur.size === 0) await fsp.unlink(target);
    } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    await renameRetry(tmp, target, retryDelays);
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 一次性迁移 + 建好数据目录。永不抛错（出错只记日志，harness 照常拉起）。
 * @param {object} o                    planHarnessData 的结果（dataDir / targetDir / migrate / packaged）加下面这些
 * @param {string} o.dataRoot           bridge 数据根：来源必须在它（或扩展目录）里面
 * @param {string} o.programRoot        bridge 程序目录：它里面内置的 harness/ 永远不当来源
 * @param {string} o.harnessDir         当前 harness 目录（harness 进程的工作目录）
 * @param {string|null} [o.modulesDir]  扩展安装目录
 * @param {string[]} [o.legacyDirs]     稳定的旧位置（按优先级）：<数据根>/harness
 * @param {string[]} [o.trashDirs]      会被删掉的旧位置（新的在前）：.trash 里换下来的旧版
 * @param {object} [o.defaults]         packaged 时没人指定的项的默认值（{ WORKSPACE_DIR: bridge 工作空间 }）
 * @param {object} [o.env]              进程环境（默认 process.env）
 * @param {(msg: string) => void} [o.log]
 * @param {Function} [o.copy]           复制一项（默认 copyItem；测试注入失败用）
 * @param {number[]} [o.retryDelays]    改名被占用时的退避（毫秒）
 * @returns {Promise<{ migrated: Array<{ name: string, from: string, to: string }>, failed: Array<{ name: string, error: string }>,
 *   fallbacks: Record<string, string>, defaults: Record<string, string> }>}
 *   fallbacks  本次没复制成的项：先指回原件（harnessDataEnv 无条件加进 harness 环境）
 *   defaults   这里替使用者定的位置（工作区）：.env 里后来写了就让 .env 说了算
 */
export async function prepareHarnessData({
  dataDir = null, targetDir = dataDir, migrate, packaged = false, dataRoot, programRoot, harnessDir, modulesDir = null,
  legacyDirs = [], trashDirs = [], defaults = {}, env = process.env, log = (m) => console.log(m),
  copy = copyItem, retryDelays,
}) {
  const out = { migrated: [], failed: [], fallbacks: {}, defaults: {} };
  if (!targetDir || !migrate || !dataRoot || !programRoot || !harnessDir) return out;
  const builtin = path.join(programRoot, 'harness');
  // 来源：存在；在数据根 / 扩展目录里面、不是程序目录内置的 harness/（见文件头）；与目标目录互不包含（免得把自己拷进自己）。
  const usable = (d) => existsSync(d) && (within(d, dataRoot) || within(d, modulesDir))
    && !within(d, builtin) && !within(d, targetDir) && !within(targetDir, d);
  const norm = (list) => list.filter(Boolean).map((d) => path.resolve(d));
  const replaceable = new Set(norm([...(packaged ? [harnessDir] : []), ...trashDirs]));
  const sources = [...new Set(norm([harnessDir, ...legacyDirs, ...trashDirs]))].filter(usable);
  // 内置 harness 又没有可搬的旧数据（测试 / 开发实例、正常的 Docker / install.sh 都是这样）：什么都不碰。
  if (!packaged && !sources.length) return out;

  if (packaged) {
    try {
      await fsp.mkdir(targetDir, { recursive: true });
    } catch (e) {
      log(`[harness] 数据目录 ${targetDir} 建不起来：${e?.message || e}`);
      out.failed.push({ name: '(数据目录)', error: String(e?.message || e) });
      return out;
    }
  }
  await sweepMigrating(targetDir, log);

  const markers = new Map(sources.map((d) => [d, readMarker(d)]));
  const dirty = new Set();
  const home = dataDir || harnessDir;          // harness 默认位置的基准（paths.ts dataHome）
  let envVars = {};
  const canonical = (item) => path.join(targetDir, item.name);
  const targetOf = (item, extra = {}) => effectiveTarget(item, { home, harnessDir, env, envVars, defaults: extra });
  const pick = (item, only = () => true) => sources.find((d) => only(d) && !markers.get(d).items[item.name] && hasData(path.join(d, item.name)));

  async function migrateItem(item, src, target) {
    const from = path.join(src, item.name);
    log(`[harness] 正在把旧数据 ${item.name} 复制到数据目录：${from} → ${target}（大目录要一会儿，期间 dimensio 暂不可用）`);
    try {
      await copy(from, target, { retryDelays });
      markers.get(src).items[item.name] = { to: target, at: new Date().toISOString() };
      dirty.add(src);
      out.migrated.push({ name: item.name, from, to: target });
      log(`[harness] 旧数据 ${item.name} 已复制到数据目录（原件留着）`);
    } catch (e) {
      // 目标留空、不记 .migrated：本次先让 harness 用原件（不从空的起），下次启动「目标没数据」才会真的再试。
      out.failed.push({ name: item.name, error: String(e?.message || e) });
      out.fallbacks[item.env] = from;
      log(`[harness] 旧数据 ${item.name} 这次没复制过去（${e?.message || e}）：本次先直接用原位置 ${from}，下次启动再试`);
    }
  }

  for (const item of HARNESS_DATA_ITEMS) {
    if (item.referenced) {
      const named = given(env[item.env]) || given(envVars[item.env]);
      const target = targetOf(item);
      if (named || !packaged) {
        // 使用者 / 部署脚本自己指定的位置（或内置 harness 的默认位置）：只在它恰好是目标目录里那份、还空着时，
        // 从会被删掉的旧位置抢救；稳定的旧位置不复制（会话里记着它的路径，复制一份就分叉了）。
        if (samePath(target, canonical(item)) && !hasData(target)) {
          const src = pick(item, (d) => replaceable.has(d));
          if (src) await migrateItem(item, src, target);
        }
      } else if (!hasData(target)) {
        // 扩展自带 harness、没人指定工作区：会被删掉的旧位置里有东西 → 抢救到数据目录接着用；稳定的旧位置有东西 →
        // 直接指过去（不复制）；都没有 → bridge 工作空间（向导一直写的就是它；数据目录里不再建空的工作区）。
        const src = pick(item);
        if (src && replaceable.has(src)) await migrateItem(item, src, target);
        else if (src) {
          out.defaults[item.env] = path.join(src, item.name);
          log(`[harness] 默认工作区沿用旧位置 ${out.defaults[item.env]}（会话里记着这个路径，不复制）`);
        } else if (given(defaults[item.env])) out.defaults[item.env] = path.resolve(defaults[item.env]);
      }
      continue;
    }
    const target = targetOf(item);
    if (samePath(target, canonical(item)) && !hasData(target)) {
      const src = pick(item);
      if (src) await migrateItem(item, src, target);
    }
    // .env 就位之后再读它：后面几项可能在里面单独改了道（向导写的 .env 就把会话 / 记忆 / 知识 / 工作区指了位置）。
    if (item.name === '.env') envVars = readEnvFile(out.fallbacks.HARNESS_ENV_FILE || harnessEnvFile({ dataDir, harnessDir, env }));
  }

  for (const src of dirty) {
    const m = markers.get(src);
    m.v = 1;
    m.to = targetDir;
    m.note = 'items 里列出的项已复制到 to 指的数据目录，harness 现在读写那边，这里对应的原件只是留底，确认新位置正常后可以删。'
      + '没列在 items 里的（尤其 workspace）别删：可能还在用，会话和项目表里也记着它的绝对路径。';
    try { await fsp.writeFile(path.join(src, MIGRATED_MARKER), JSON.stringify(m, null, 2) + '\n'); }
    catch (e) { log(`[harness] ${src} 里写不了 ${MIGRATED_MARKER}（只读？不影响使用，下次按「目标已有数据」跳过）：${e?.message || e}`); }
  }

  // 扩展自带 harness 时，默认会用到的目录先建好（没被单独改道到别处、也没临时指回原件的才建：
  // 占位一建，下次启动就当「已有」了，那一项的旧数据再也搬不过来）。
  if (packaged) {
    for (const item of HARNESS_DATA_ITEMS) {
      if (!ENSURE_DIRS.has(item.name) || out.fallbacks[item.env]) continue;
      const target = targetOf(item, out.defaults);
      if (!samePath(target, canonical(item))) continue;
      try { await fsp.mkdir(target, { recursive: true }); } catch {}
    }
  }
  return out;
}

/**
 * 拉起管理员实例时要加进环境的东西（每次拉起现算）：数据目录；prepareHarnessData 替使用者定的默认（.env 里后来写了同名项
 * 就不加——进程环境会盖过 .env）；本次没复制成、先指回原件的项（无条件加）。
 * @param {object} o
 * @param {string|null} o.dataDir    planHarnessData 给的数据目录
 * @param {object|null} o.prepared   prepareHarnessData 的结果（还没跑完就是 null）
 * @param {string} o.envFile         管理员实例加载的 .env（harnessEnvFile）
 */
export function harnessDataEnv({ dataDir, prepared, envFile }) {
  const out = {};
  if (dataDir) out.DIMENSIO_DATA_DIR = dataDir;
  const fallbacks = prepared?.fallbacks || {};
  const defaults = prepared?.defaults || {};
  if (Object.keys(defaults).length) {
    const fileVars = readEnvFile(fallbacks.HARNESS_ENV_FILE || envFile);
    for (const [k, v] of Object.entries(defaults)) if (!given(fileVars[k])) out[k] = v;
  }
  return Object.assign(out, fallbacks);
}
