// 扩展中心「功能扩展」的安装 / 卸载（离线包 → 数据目录）。
//
// 一律只排进 .pending/，下次启动由 registry.applyPending 换上——正在用的扩展目录不动（Codex 的 exe、
// dimensio 的 node-pty 跑着就删不掉；ESM 也没法热卸载）。所以装、换、卸都要「重启后生效」。
//
// 离线包（zip）：根目录（或唯一的一级子目录）里有 bridge-module.json；id 必须是目录里的四个之一；
// 主程序有打包号时（bridge-build.json）清单 buildId 必须一致——前端 chunk 名、核心接口都按那一次构建对齐。
// 仓库内置的扩展（维护者本机 / Linux 部署，随主程序走）不能经这里装或卸。

import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import {
  MODULE_CATALOG, MANIFEST_NAME, INSTALLED_MODULES_DIR, PENDING_DIR, STAGING_DIR,
  baseBuildId, moduleStatus, moduleOffered,
} from './registry.mjs';
import { agentSwitches } from '../runtime/agent-status.mjs';

const CATALOG_IDS = new Set(MODULE_CATALOG.map((m) => m.id));
const httpErr = (status, message) => Object.assign(new Error(message), { status });

// bsdtar：必须钉 System32 的 tar.exe（PATH 里 Git 的 GNU tar 会把 C:\ 当远程主机，见 extensions.mjs）。
const firstExisting = (list) => list.find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
const BSDTAR = () => firstExisting(['C:\\Windows\\System32\\tar.exe', '/usr/bin/bsdtar', '/usr/bin/tar']) || 'tar';
const runTar = (args) => promisify(execFile)(BSDTAR(), args, { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 });

function readJson(file) {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

// 解包后剔掉符号链接 / junction（zip 里塞 symlink 可指向包外，落地后读写会顺着越出去）。
function stripLinks(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) { rmSync(p, { recursive: true, force: true }); continue; }
    if (ent.isDirectory()) stripLinks(p);
  }
}

function pendingOf(id) {
  const next = path.join(PENDING_DIR, id);
  if (existsSync(path.join(next, MANIFEST_NAME))) {
    let version = '';
    try { version = String(readJson(path.join(next, MANIFEST_NAME)).version || ''); } catch {}
    return { action: 'install', version };
  }
  if (existsSync(path.join(PENDING_DIR, id + '.remove'))) return { action: 'remove' };
  return null;
}

// 扩展中心「功能扩展」页的整张表。
export function modulesOverview() {
  const sw = agentSwitches();
  // 这一版不提供的扩展（公开版的 Codex）不列：列出来只会显示「未安装」，还让人去找一个不存在的离线包
  const modules = MODULE_CATALOG.filter((m) => moduleOffered(m.id)).map((m) => {
    const st = moduleStatus(m.id);
    return {
      ...st,
      dir: undefined,
      builtin: st.source === 'builtin',
      pending: pendingOf(m.id),
      // 停用 = 这个扩展撑着的 agent 都关掉（同设置「Agent」页的开关，即时生效、不必重启）。
      enabled: m.agents.every((a) => sw[a] !== false),
    };
  });
  return { modules, buildId: baseBuildId(), restartNeeded: modules.some((m) => m.pending) };
}

// 装一个离线包（zip 文件路径）。成功只是排进 .pending，重启后生效。
export async function installModuleArchive(zipFile) {
  mkdirSync(STAGING_DIR, { recursive: true });
  const work = path.join(STAGING_DIR, 'x-' + crypto.randomBytes(5).toString('hex'));
  mkdirSync(work, { recursive: true });
  try {
    try { await runTar(['-xf', zipFile, '-C', work]); }
    catch {
      try { await runTar(['--options', 'hdrcharset=UTF-8', '-xf', zipFile, '-C', work]); }
      catch (e) { throw httpErr(400, '离线包解不开（要 .zip）：' + String(e.stderr || e.message).slice(0, 200)); }
    }
    stripLinks(work);
    // 清单在根目录，或在唯一的一级子目录里（右键「压缩」常多包一层）
    let root = work;
    if (!existsSync(path.join(root, MANIFEST_NAME))) {
      const subs = readdirSync(work, { withFileTypes: true }).filter((e) => e.isDirectory());
      if (subs.length === 1 && existsSync(path.join(work, subs[0].name, MANIFEST_NAME))) root = path.join(work, subs[0].name);
      else throw httpErr(400, '这不是功能扩展的离线包（里面没有 ' + MANIFEST_NAME + '）');
    }
    let manifest;
    try { manifest = readJson(path.join(root, MANIFEST_NAME)); } catch (e) { throw httpErr(400, '清单解析失败：' + (e?.message || e)); }
    const id = String(manifest?.id || '');
    if (!CATALOG_IDS.has(id)) throw httpErr(400, '不认识的功能扩展：' + (id || '（清单里没写 id）'));
    const entry = path.resolve(root, String(manifest.entry || 'server/index.mjs'));
    if (!entry.startsWith(path.resolve(root) + path.sep) || !existsSync(entry)) throw httpErr(400, '离线包缺入口文件');
    const build = baseBuildId();
    if (build && String(manifest.buildId || '') !== build) {
      throw httpErr(409, '这个离线包和当前主程序不是同一次打包的（离线包 ' + (manifest.buildId || '未标记') + '，主程序 ' + build + '），请用随这一版安装包一起发的离线包');
    }
    const st = moduleStatus(id);
    if (st?.source === 'builtin') throw httpErr(409, '「' + st.label + '」是主程序内置的，随主程序一起更新，不用另装');
    // 排进 .pending/<id>（覆盖之前排着的；撤掉待卸载标记）
    mkdirSync(PENDING_DIR, { recursive: true });
    const dest = path.join(PENDING_DIR, id);
    rmSync(dest, { recursive: true, force: true });
    rmSync(path.join(PENDING_DIR, id + '.remove'), { force: true });
    renameSync(root, dest);
    return { ok: true, id, version: String(manifest.version || ''), restartNeeded: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// 卸载：排一个待卸载标记（正在用的目录重启时再删）；只是排着还没装上的，直接撤掉。
export function uninstallModule(id) {
  if (!CATALOG_IDS.has(id)) throw httpErr(400, '不认识的功能扩展：' + id);
  const st = moduleStatus(id);
  if (st?.source === 'builtin') throw httpErr(409, '「' + st.label + '」是主程序内置的，不能卸载（可以在「Agent」里关掉）');
  const next = path.join(PENDING_DIR, id);
  const hadPending = existsSync(next);
  rmSync(next, { recursive: true, force: true });
  if (st?.installed && existsSync(path.join(INSTALLED_MODULES_DIR, id))) {
    mkdirSync(PENDING_DIR, { recursive: true });
    writeFileSync(path.join(PENDING_DIR, id + '.remove'), new Date().toISOString());
    return { ok: true, id, restartNeeded: true };
  }
  if (hadPending) return { ok: true, id, restartNeeded: false };
  throw httpErr(404, '这个功能扩展没装');
}

// 撤销还没生效的安装 / 卸载。
export function cancelPending(id) {
  if (!CATALOG_IDS.has(id)) throw httpErr(400, '不认识的功能扩展：' + id);
  rmSync(path.join(PENDING_DIR, id), { recursive: true, force: true });
  rmSync(path.join(PENDING_DIR, id + '.remove'), { force: true });
  return { ok: true, id };
}
