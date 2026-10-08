// 进程级兜底：未捕获异常 / 未处理拒绝不再直接掐死常驻服务。
//
// 为什么需要：bridge 是一台 7×24 的常驻服务，手里攥着直播 SSE、PTY 会话、CDP 浏览器
// 会话和正在跑的 agent 轮。Node 的默认行为是「未捕获异常 → 立刻退出」，于是任何一处
// 漏挂 'error' 监听的子进程（浏览器起不来、taskkill 不在 PATH…）都能把这些全部带走，
// 而 tunnel-watchdog 要探到 ECONNREFUSED 三次（约 2 分钟）才会把它拉起来。体检时实测
// 过：一个 spawn ENOENT 就足以让整个进程退出，没有任何路由 try/catch 接得住。
//
// 但「一律吞掉继续跑」也不对——真的进入坏状态时，一瘸一拐地活着比干脆重启更难查。
// 折中：记下来、喊出来、继续跑；如果同一个窗口内反复触发（说明不是孤立事件而是进程
// 已经坏了），就主动退出，把场子交给 watchdog 做一次干净的重启。
//
// 注意：这是【兜底】，不是许可证。该挂的 'error' 监听、该 catch 的 await 一个都不能省。

import { mkdirSync } from 'node:fs';

const WINDOW_MS = 60_000;
const faultHooks = [];
/** 每次兜住一个未捕获异常 / 未处理拒绝时通知（反馈模块记进报错记录） */
export function onFault(fn) { faultHooks.push(fn); }
const MAX_IN_WINDOW = 5;

// V8 致命错误（含 OOM）和 Node 的 fail-fast 自崩都绕过上面那两个 JS 钩子、什么栈都不留，进程就这么没了。
// 诊断报告专抓这一类：Node 在 abort 之前先写一份带 JS + 原生栈的 json 到 reportDir（数据目录的 crashdumps/），
// 事后查「服务怎么突然没了」就看它。报告只留在本机，不会自动发出去。
function enableFatalReport(name, reportDir) {
  try {
    if (!process.report || !reportDir) return;
    mkdirSync(reportDir, { recursive: true });
    process.report.directory = reportDir;
    process.report.reportOnFatalError = true;   // V8 致命错误 / OOM → abort 前写报告
    console.log(`[fatal-guard/${name}] 诊断报告已开：致命错误时写入 ${reportDir}`);
  } catch (e) {
    console.error(`[fatal-guard/${name}] 诊断报告开启失败（继续运行）：`, e?.message || e);
  }
}

export function installFatalGuard(name = 'bridge', reportDir = null) {
  enableFatalReport(name, reportDir);
  const hits = [];

  const note = (kind, err) => {
    const now = Date.now();
    while (hits.length && now - hits[0] > WINDOW_MS) hits.shift();
    hits.push(now);
    // 完整堆栈——这条日志就是事后查「到底谁炸的」的唯一线索，别省。
    console.error(`[fatal-guard/${name}] ${kind}:`, err instanceof Error ? (err.stack || err.message) : err);
    for (const h of faultHooks) { try { h(kind, err); } catch {} }
    if (hits.length >= MAX_IN_WINDOW) {
      console.error(`[fatal-guard/${name}] ${WINDOW_MS / 1000}s 内已 ${hits.length} 次——判定进程已进入坏状态，主动退出交给守护重启`);
      process.exit(1);
    }
  };

  process.on('uncaughtException', (err) => note('uncaughtException', err));
  process.on('unhandledRejection', (reason) => note('unhandledRejection', reason));
}
