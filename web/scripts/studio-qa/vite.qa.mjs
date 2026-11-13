// studio-qa 用的 vite 配置：照搬 web/vite.config.js，只把依赖预构建缓存（cacheDir）挪到系统临时目录。
// 为什么：worktree 的 web/node_modules 经 junction 和主树共用，两个 vite 同时（重）启动会互相覆盖 node_modules/.vite，
// 页面报「Failed to fetch dynamically imported module」，检测整轮作废。在 web/ 里这样起：
//   BRIDGE_API=http://127.0.0.1:<隔离后端端口> npx vite --config scripts/studio-qa/vite.qa.mjs --port <端口> --strictPort --host 127.0.0.1
// 换缓存目录：STUDIO_QA_VITE_CACHE=<目录>。
import os from 'node:os';
import path from 'node:path';
import base from '../../vite.config.js';

const cacheDir = process.env.STUDIO_QA_VITE_CACHE || path.join(os.tmpdir(), 'studio-qa-vite-cache');
export default (env) => ({ ...base(env), cacheDir });
