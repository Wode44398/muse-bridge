// 每个 agy 数据目录当前那个常驻进程是什么时候起来的。
//
// agy 转入后台的命令（run_command 的后台任务）是它进程里的子任务：进程一换（bridge 重启、agy 崩溃重拉），
// 它们就没了，但 .db 里那一步常常一直停在 RUNNING（没被重新打开的会话不会有人去收尾），
// 界面会永远显示「后台任务在跑」，空闲重启也会被它一直拦着。比进程启动更早发起的后台命令一律当作已中断。
//
// 还没记到（agy 进程还没起来）时用 bridge 自己的启动时间兜底：agy 是 bridge 的子进程，bridge 一重启它也跟着重来。
import path from 'node:path';

const starts = new Map(); // 规范化的数据目录 → 进程就绪时间（毫秒）
const BRIDGE_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

const keyOf = (dataDir) => path.resolve(String(dataDir || '')).toLowerCase();

export function noteAgyProcessStart(dataDir, ms = Date.now()) {
  if (!dataDir) return;
  starts.set(keyOf(dataDir), Number(ms) || Date.now());
}

/** 比这个时间更早发起的后台命令不可能还活着 */
export function agyProcessEpoch(dataDir) {
  if (!dataDir) return BRIDGE_STARTED_AT;
  return starts.get(keyOf(dataDir)) || BRIDGE_STARTED_AT;
}
