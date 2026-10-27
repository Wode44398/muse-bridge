// 项目路径授权与「位置」列表——agent 中立的核心件。
//
// 原本长在 codex-projects.mjs 里，但 Claude 项目、文件接口、分享、分享空间都在用它；
// Codex 拆成可选扩展后，核心不能再从 Codex 的文件里拿这两个函数，故独立成文件
// （codex-projects.mjs 仍原样转出，旧引用不受影响）。

import os from 'node:os';
import path from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { allowedRoots, can } from './runtime/principal.mjs';

const real = (p) => realpathSync.native ? realpathSync.native(p) : realpathSync(p);
export const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;

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
  // 边界一律走 allowedRoots（principal.mjs，开源路线 C5）：null = 主机身份不设边界；否则落在任意一个根内即可。
  // 今天沙箱身份只有 [ctx.cwd] 一个根，判断与以前逐字等价。
  const roots = allowedRoots(ctx);
  if (roots) {
    const ok = roots.some((r) => {
      let base;
      try { base = real(path.resolve(r)); } catch { base = path.resolve(r); }
      return inside(fold(base), fold(target));
    });
    if (!ok) throw Object.assign(new Error('项目路径必须位于你的工作空间内'), { status: 403 });
  }
  return target;
}

// 「位置」列表：远程端（网页/手机）的新建项目选择器拿它当根切换栏——工作空间文件管理器
// 本身是【锁在身份工作空间根】的（admin=vault），而真实项目大量落在库外
// （例如 C:\Users\<你>\some-repo、D:\projects\…）。没有这一层，换成文件管理器当
// 选择器基底就等于砍掉一半项目的可达性。授权边界一字不改：admin 本来就能选任意本地目录
// （authorizeProjectPath 同款判断），完全信任档只会拿到自己工作空间那一条。
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
  if (!can(ctx, 'fs.anyPath')) return out;       // Pro 越不出自己的空间，多给也没用
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
