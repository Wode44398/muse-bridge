// 进程级兜底：未捕获异常 / 未处理拒绝不再直接掐死 harness。
//
// harness 是常驻进程，手里攥着直播中的会话、PTY 终端、CDP 浏览器 target 和正在跑的
// agent loop。Node 默认「未捕获异常 → 立刻退出」，于是任何一处漏挂 'error' 监听的
// 子进程（浏览器起不来、taskkill 不在 PATH…）都能把这些全带走。bridge 那边会在下一次
// 请求时把 harness 重新拉起来，但这一轮的现场已经没了。
//
// 策略与 bridge 侧的 runtime/fatal-guard.mjs 一致：记下来、喊出来、继续跑；同一窗口内
// 反复触发说明进程真的坏了，就主动退出让上游做一次干净重启。这是兜底，不是许可证。

import { dumpRingSync } from "./diag-ring.ts";

const WINDOW_MS = 60_000;
const MAX_IN_WINDOW = 5;

export function installFatalGuard(name = "harness"): void {
  const hits: number[] = [];

  const note = (kind: string, err: unknown): void => {
    const now = Date.now();
    while (hits.length && now - hits[0]! > WINDOW_MS) hits.shift();
    hits.push(now);
    console.error(`[fatal-guard/${name}] ${kind}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    if (hits.length >= MAX_IN_WINDOW) {
      console.error(
        `[fatal-guard/${name}] ${WINDOW_MS / 1000}s 内已 ${hits.length} 次——判定进程已进入坏状态，主动退出交给上游重启`,
      );
      // Q13：崩溃留痕——退出前把诊断内存环连同这次的错误落一次盘（sessions/diagnostics/crash-*.json）
      dumpRingSync(`fatal-guard: ${hits.length} ${kind} within ${WINDOW_MS / 1000}s`, err);
      process.exit(1);
    }
  };

  process.on("uncaughtException", (err) => note("uncaughtException", err));
  process.on("unhandledRejection", (reason) => note("unhandledRejection", reason));
}
