// dimensio 功能扩展入口：harness 底座（默认 8799）的实例池与 /api/harness/* 反代。
// 钩子约定见核心 src/modules/registry.mjs 顶部。

import { existsSync } from 'node:fs';
import path from 'node:path';
import { harnessDir } from './harness-dir.mjs';
import { registerHarnessRoutes } from './routes/harness.mjs';

export { harnessDir };
// 公网预览子域（core routes/preview-host.mjs）查注册表、控制台「服务控制」排空与计数用。
export { harnessEndpoints, drainHarnesses } from './routes/harness.mjs';
// S2：管理员实例实际用的 .env 与数据目录（harness 是扩展自带的时候在 <数据根>/dimensio）。核心判「dimensio 配没配 key」
// （runtime/agent-status.mjs）应当看 harnessEnvFile()，而不是 <harness 目录>/.env。
export { adminEnvFile as harnessEnvFile, adminDataDir as harnessDataDir } from './routes/harness.mjs';

export function runnable() { return existsSync(path.join(harnessDir(), 'server', 'index.ts')); }

export function register(router, { identify }) {
  registerHarnessRoutes(router, { identify });   // /api/harness/* → 反代到独立 harness 底座进程(8799)
}
