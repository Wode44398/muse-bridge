// 前端构建 / dev 之前的私有 overlay 步骤（package.json 的 prebuild / predev）。
// Codex 分页的界面由维护者的私有 overlay 提供（见 chatgpt-overlay.mjs）。overlay 的 assets/chatgpt/ 里带 prebuild.mjs 时
// 在这里跑它：默认导出 async ({ build, webDir, ov }) => …，build 是本仓库的 rolldown（overlay 里没有 node_modules）。
// 没有 overlay、公开版出包（BRIDGE_EDITION=public）、或 overlay 里没有这个脚本：什么都不做。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatgptOverlay } from './chatgpt-overlay.mjs';

const ov = chatgptOverlay();
const script = ov ? path.join(ov.root, 'prebuild.mjs') : '';
if (script && existsSync(script)) {
  const { build } = await import('rolldown');
  const mod = await import(pathToFileURL(script).href);
  const run = mod.default || mod.prebuild;
  if (typeof run !== 'function') throw new Error('overlay 的 prebuild.mjs 没有默认导出函数：' + script);
  await run({ build, webDir: fileURLToPath(new URL('..', import.meta.url)), ov });
}
