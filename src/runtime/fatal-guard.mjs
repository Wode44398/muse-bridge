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

import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { spawn } from 'node:child_process';

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

// 2026-10-19：报告只给了「堆满 4GB」，没有 JS 栈、看不出是什么在堆（old_space 4015MB 全是小对象）。
// 堆快到上限时先落一份堆快照（V8 临时抬高上限写完再死），用 Chrome DevTools Memory 面板打开就能看
// 是哪种对象占满了。快照只能写进 cwd（--diagnostic-dir 运行时改不了）——正式服 cwd 是程序根，
// *.heapsnapshot 已进 .gitignore。写 4GB 堆的快照要几分钟，期间服务不响应；看门狗只认 ECONNREFUSED，不会误救。
function enableHeapSnapshotNearLimit(name) {
  try {
    v8.setHeapSnapshotNearHeapLimit(1);
    console.log(`[fatal-guard/${name}] 堆快照已开：堆接近上限时写入 ${process.cwd()}`);
  } catch (e) {
    console.error(`[fatal-guard/${name}] 堆快照开启失败（继续运行）：`, e?.message || e);
  }
}

// 只留最新 keep 份同类转储（dump / 堆快照动辄几个 GB）。
function pruneDumps(dir, re, keep) {
  try {
    const files = readdirSync(dir).filter((f) => re.test(f))
      .map((f) => { const p = path.join(dir, f); return { p, t: statSync(p).mtimeMs }; })
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(keep)) { try { unlinkSync(f.p); } catch {} }
  } catch {}
}

// 2026-10-19：fail-fast（4689 退出码 0xC0000409）两次都没留下 WER LocalDumps 的 dump、Application 日志
// 也没有 1000 事件——系统侧的崩溃转储接不住它。改由 procdump 以调试器身份挂在本进程上（-e：只抓未处理
// 异常 / fail-fast，-ma 全量），崩的那一刻落 dump 到 dumpDir。正常退出（重启、Stop-Process）procdump 跟着退。
// 实测代价：procdump 被强杀时，被调试的进程会被系统一并结束（调试器退出默认带走目标）——所以别按名字杀
// procdump64.exe；BRIDGE_CRASH_DEBUGGER=0 可关。只在调用方明确要（正式服）时挂，dev/测试实例不挂。
export function attachCrashDebugger(name, dumpDir, exe) {
  if (process.platform !== 'win32' || process.env.BRIDGE_CRASH_DEBUGGER === '0') return;
  if (!exe || !existsSync(exe)) { console.log(`[fatal-guard/${name}] 未找到 procdump（${exe}），崩溃转储未挂`); return; }
  try {
    mkdirSync(dumpDir, { recursive: true });
    pruneDumps(dumpDir, /\.dmp$/i, 4);
    const c = spawn(exe, ['-accepteula', '-ma', '-e', String(process.pid), dumpDir], { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', (e) => console.error(`[fatal-guard/${name}] procdump 启动失败：`, e?.message || e));
    c.unref();
    console.log(`[fatal-guard/${name}] 崩溃转储已挂：procdump pid=${c.pid} → ${dumpDir}`);
  } catch (e) {
    console.error(`[fatal-guard/${name}] 崩溃转储挂载失败（继续运行）：`, e?.message || e);
  }
}

export function installFatalGuard(name = 'bridge', reportDir = null, { heapSnapshot = false } = {}) {
  enableFatalReport(name, reportDir);
  if (heapSnapshot) {
    pruneDumps(process.cwd(), /\.heapsnapshot$/i, 2);
    enableHeapSnapshotNearLimit(name);
  }
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
