// Shared filesystem helpers + traversal guards used by multiple routes/handlers.
// Resolves a session id to its on-disk paths under the SDK's PROJECTS_DIR layout,
// and sanitizes user-supplied filenames before they touch UPLOADS.

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync, lstatSync, rmSync } from 'node:fs';

// Program assets and mutable runtime data are the same directory in the classic
// server checkout. Packaged desktop clients set BRIDGE_DATA_ROOT so upgrades can
// replace the program tree without touching sessions, caches, uploads or config.
export const PROGRAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_ROOT = path.resolve(process.env.BRIDGE_DATA_ROOT || PROGRAM_ROOT);

// Where the SDK writes a session transcript: <CLAUDE_CONFIG_DIR or ~/.claude>/
// projects/<encoded-cwd>/. admin passes configDir=null (host ~/.claude); each user
// passes their per-account configDir, so we read exactly what their Claude wrote.
// Resolve home lazily on EVERY call — never freeze it at module load. The server can
// be (re)started from a context whose USERPROFILE isn't ready yet (a tunnel trigger,
// a stray shell); a frozen home would then pin /api/sessions to a wrong/empty dir for
// the whole process lifetime. The SDK child that WRITES transcripts resolves home at
// spawn time, so reading at runtime too keeps reader and writer on the same ~/.claude.
function homeProjects() { return path.join(os.homedir(), '.claude', 'projects'); }
// configDir=null（admin）时按 SDK 子进程【实际会用的】位置读：进程环境里的 CLAUDE_CONFIG_DIR
// 优先，没有才是 ~/.claude。子进程继承本进程环境，读写就此对齐——生产环境没设这个变量、
// 行为一字不变；测试服的启动器设了它，此前读写分家：会话列表恒空、重开会话一律 404。
export function projectsBase(configDir) {
  if (configDir) return path.join(configDir, 'projects');
  const envDir = String(process.env.CLAUDE_CONFIG_DIR || '').trim();
  return envDir ? path.join(envDir, 'projects') : homeProjects();
}

// The Agent SDK derives a per-cwd subfolder by replacing non-alnum with '-'.
export function sessionsDir(cwd, configDir) {
  return path.join(projectsBase(configDir), String(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

// Resolve and validate a session id to its on-disk paths, guarding traversal.
export function sessionPaths(id, cwd, configDir) {
  if (!/^[0-9a-fA-F-]{8,}$/.test(id)) return null;
  const dir = sessionsDir(cwd, configDir);
  const file = path.join(dir, id + '.jsonl');
  const subdir = path.join(dir, id);
  if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) return null;
  return { dir, file, subdir };
}

export function sanitizeName(name) {
  const base = String(name).split(/[\\/]/).pop() || 'file';
  // 开头的点要保留：工作空间要能像资源管理器那样显示/新建 .gam、.env 这种名字。
  // 但 '.' 与 '..' 必须挡死——它们不是名字，是路径语义（分隔符已在上一行剔掉）。
  const clean = base.replace(/[\x00-\x1f:*?"<>|]/g, '_').slice(0, 120);
  if (clean === '.' || clean === '..') return 'file';
  return clean || 'file';
}

// 解包后清扫符号链接/junction：压缩包里塞一个指向包外的 symlink，落地后 /api/file 读、
// delete 删都会顺着链接越出沙箱（extensions.mjs 的 sanitizeTree 同款结论）。这里只剔链接、
// 不动普通文件——用户自己的压缩包内容不该被误删。lstat 不跟随链接，junction 在 Node 里
// 也按 symlink 上报。返回剔除数量，尽力而为不抛。
export function stripLinks(dir) {
  let removed = 0;
  let names;
  try { names = readdirSync(dir); } catch { return removed; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) { try { rmSync(p, { recursive: true, force: true }); removed++; } catch {} continue; }
    if (st.isDirectory()) removed += stripLinks(p);
  }
  return removed;
}

// Opportunistic cleanup: delete abandoned chunked-upload fragments (.part-<id>) in
// `dir` older than maxAgeMs. An in-progress / resuming upload keeps its .part mtime
// fresh, so this only ever removes truly orphaned parts. Best-effort, never throws.
export function sweepStaleParts(dir, maxAgeMs = 6 * 60 * 60 * 1000) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    if (!n.startsWith('.part-')) continue;
    try { if (now - statSync(path.join(dir, n)).mtimeMs > maxAgeMs) rmSync(path.join(dir, n), { force: true }); } catch {}
  }
}
