// harness（dimensio 底座）在哪：
//   BRIDGE_HARNESS_DIR 显式指定 > 离线包自带（<扩展目录>/harness）> 程序目录的 harness/（仓库满配）。
// worktree 里各自解析到自己那份。

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_ROOT } from '@bridge/core/runtime/paths.mjs';

const MODULE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function harnessDir() {
  if (process.env.BRIDGE_HARNESS_DIR) return path.resolve(process.env.BRIDGE_HARNESS_DIR);
  const bundled = path.join(MODULE_DIR, 'harness');
  if (existsSync(path.join(bundled, 'server', 'index.ts'))) return bundled;
  return path.join(PROGRAM_ROOT, 'harness');
}
