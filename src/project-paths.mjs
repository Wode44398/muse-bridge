// 项目路径授权：Claude 分页的「项目」、文件接口、分享链接都用它判断一个本地目录能不能用。
// admin 已有整机 shell，可以选任意本地目录；Pro 账号只能选自己工作空间里的目录（包括穿过
// 符号链接的情况——realpath 把这条逃逸路堵上）。

import os from 'node:os';
import path from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';

const real = (p) => realpathSync.native ? realpathSync.native(p) : realpathSync(p);
const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;

function inside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

// Resolve an existing directory and enforce the caller's filesystem boundary.
// Admin already has host-level shell access, so it may choose any local directory;
// a Pro account may only choose a directory under its own ctx.cwd, including through
// symlinks/junctions (realpath closes that escape hatch).
export function authorizeProjectPath(ctx, requested) {
  const raw = String(requested || ctx.cwd || '').trim();
  if (!raw) throw Object.assign(new Error('请选择项目路径'), { status: 400 });
  const resolved = path.resolve(raw);
  if (!existsSync(resolved)) throw Object.assign(new Error('路径不存在'), { status: 404 });
  let target;
  try { target = real(resolved); } catch { throw Object.assign(new Error('无法访问该路径'), { status: 403 }); }
  let st;
  try { st = statSync(target); } catch { throw Object.assign(new Error('无法读取该路径'), { status: 403 }); }
  if (!st.isDirectory()) throw Object.assign(new Error('请选择文件夹'), { status: 400 });
  if (ctx.kind !== 'admin') {
    let base;
    try { base = real(path.resolve(ctx.cwd)); } catch { base = path.resolve(ctx.cwd); }
    if (!inside(fold(base), fold(target))) throw Object.assign(new Error('项目路径必须位于你的工作空间内'), { status: 403 });
  }
  return target;
}

// 「位置」列表：新建项目选择器拿它当根切换栏——工作空间文件管理器本身锁在身份的工作空间根，
// 而真实项目常在工作空间之外。授权边界不变：admin 本来就能选任意本地目录（authorizeProjectPath
// 同款判断），Pro 只会拿到自己工作空间那一条。
export function projectLocations(ctx, extras = []) {
  const out = [];
  const seen = new Set();
  const push = (id, name, dir) => {
    if (!dir) return;
    let target;
    try { target = authorizeProjectPath(ctx, dir); } catch { return; }
    const key = fold(target);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, name, path: target });
  };
  push('ws', '工作空间', ctx.cwd);
  if (ctx.kind !== 'admin') return out;          // Pro 越不出自己的空间，多给也没用
  for (const extra of extras) push(String(extra?.id || extra?.path || ''), String(extra?.name || ''), extra?.path);
  push('home', '主目录', os.homedir());
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c += 1) {
      const root = String.fromCharCode(c) + ':\\';
      if (existsSync(root)) push('drive-' + String.fromCharCode(c), String.fromCharCode(c) + ':', root);
    }
  } else {
    push('root', '/', '/');
  }
  return out;
}

