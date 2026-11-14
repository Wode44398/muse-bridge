// vite dev server 的进程入口（由 dev.mjs 以 detached 方式拉起）。用 vite 的 JS API 起 studio-qa/vite.qa.mjs：
// 依赖预构建缓存挪到各实例自己的目录（STUDIO_QA_VITE_CACHE），worktree 与主树、多个实例之间互不覆盖 node_modules/.vite。
// 命令行带 --qa-name 供 stop 核对；--ttl 分钟到点按 PID 收整棵树。
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { WEB as WEB0, parseArgs } from './paths.mjs';

const a = parseArgs(process.argv.slice(2));
// --web <目录>：用另一份前端源码树（dev.mjs start --ref 生成的 git 快照）起 vite，跑「某个提交的基线」
const WEB = a.web ? path.resolve(String(a.web)) : WEB0;
const ttl = Math.max(1, Number(a.ttl) || 60);
const port = Number(a.port);
function selfDestruct(why) {
  console.log(`[preview-qa] vite 自杀（${why}），PID ${process.pid}`);
  try { execFileSync('taskkill', ['/T', '/F', '/PID', String(process.pid)], { stdio: 'ignore', windowsHide: true }); } catch {}
  process.exit(0);
}
setTimeout(() => selfDestruct('ttl ' + ttl + ' 分钟到'), ttl * 60_000).unref();
if (!port || !process.env.BRIDGE_API || !process.env.STUDIO_QA_VITE_CACHE) { console.error('[preview-qa] 缺 --port / BRIDGE_API / STUDIO_QA_VITE_CACHE'); process.exit(2); }
process.chdir(WEB);
// node_modules 在 worktree / 快照里都是 junction（指回主树）：vite 按真实路径核对 fs.allow，
// 真实路径 C:\Users\you\claude-bridge\web\node_modules 不在 vite.config.js 的 allow 里 →
// `?url` 引的资源（pdf.js worker 等）回 403，PDF / 转 PDF 的 Office 全部「加载失败」。这里只把两个 node_modules 的
// 真实路径补进 allow（vite 合并配置时数组是拼接，原有 allow / deny 不变；不放开主树其它目录）。
const extraAllow = [];
for (const rel of ['node_modules', '../node_modules']) {
  try { const real = realpathSync(path.join(WEB, rel)); if (real !== path.join(WEB, rel)) extraAllow.push(real); } catch {}
}
const { createServer } = await import('vite');
const server = await createServer({
  configFile: path.join(WEB, 'scripts', 'studio-qa', 'vite.qa.mjs'),
  root: WEB,
  clearScreen: false,
  server: { port, strictPort: true, host: '127.0.0.1', open: false, ...(extraAllow.length ? { fs: { allow: extraAllow } } : {}) },
});
if (extraAllow.length) console.log('[preview-qa] fs.allow 补上 junction 真实路径：' + extraAllow.join('、'));
await server.listen();
console.log(`[preview-qa] vite ${a['qa-name']} PID ${process.pid} → http://127.0.0.1:${port}/ （代理 ${process.env.BRIDGE_API}）ttl ${ttl} 分钟`);
