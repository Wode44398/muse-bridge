// 隔离后端的进程入口（由 dev.mjs 以 detached 方式拉起；环境变量由 dev.mjs 设好）。
// 命令行带 --qa-name <实例名>：stop 时据此核对「这个 PID 确实是我起的 preview-qa 后端」再杀。
// --ttl <分钟>：到点按自己的 PID 收整棵进程树（后端可能拉起 ffmpeg / soffice / CLI 子进程，只 exit 会留孤儿）。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, parseArgs } from './paths.mjs';

const a = parseArgs(process.argv.slice(2));
const ttl = Math.max(1, Number(a.ttl) || 60);
function selfDestruct(why) {
  console.log(`[preview-qa] 后端自杀（${why}），PID ${process.pid}`);
  try { execFileSync('taskkill', ['/T', '/F', '/PID', String(process.pid)], { stdio: 'ignore', windowsHide: true }); } catch {}
  process.exit(0);
}
setTimeout(() => selfDestruct('ttl ' + ttl + ' 分钟到'), ttl * 60_000).unref();
if (process.env.BRIDGE_NO_AUTH !== '1' || !process.env.BRIDGE_DATA_ROOT || !process.env.VAULT_PATH || !process.env.BRIDGE_USERS_ROOT) {
  console.error('[preview-qa] 环境变量不全（BRIDGE_NO_AUTH / BRIDGE_DATA_ROOT / VAULT_PATH / BRIDGE_USERS_ROOT），拒绝启动：只许经 dev.mjs 起');
  process.exit(2);
}
process.chdir(REPO);
console.log(`[preview-qa] 后端 ${a['qa-name']} PID ${process.pid} 端口 ${process.env.PORT} ttl ${ttl} 分钟`);
await import(pathToFileURL(path.join(REPO, 'src', 'server.mjs')).href);
