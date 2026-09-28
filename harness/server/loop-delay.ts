// M12（N37）：事件循环延迟看门狗。harness 是单进程：express 路由、所有会话的 agent loop、SSE 写出、bridge 1.5 秒的探活
// 都在同一条事件循环上——任何同步重活（以前是项目知识扫描，一次 5–8 秒）都会让全部会话一起卡住，而且没有任何地方
// 看得出来。这里一个自计时的心跳（每 tickMs 一跳，量实际间隔比应有的多出多少），每个窗口结算一次最长卡顿，超过阈值
// 就记一行。
//
// 不用 perf_hooks.monitorEventLoopDelay：Node 24 / Windows 上实测它漏报——卡在 setImmediate 阶段的 600ms 一下也没记到
// （只有卡在 timer 回调里才记得到），而普通 setInterval 心跳在任何阶段被卡都量得出来。

export interface LoopDelayWindow {
  at: number; // 结算时刻
  maxMs: number; // 这个窗口里最长的一次卡顿
}

export interface LoopDelayMonitor {
  stop(): void;
  last(): LoopDelayWindow | null; // 最近一个窗口（诊断接口以后读它）
  check(): LoopDelayWindow; // 立刻结算当前窗口（测试用；平时由定时器调）
}

export function startLoopDelayMonitor(
  options: { windowMs?: number; warnMs?: number; tickMs?: number; log?: (line: string) => void } = {},
): LoopDelayMonitor {
  const windowMs = options.windowMs ?? 30_000;
  const warnMs = options.warnMs ?? 1_000;
  const tickMs = options.tickMs ?? 100;
  const log = options.log ?? ((line: string) => console.warn(line));
  let lastTick = performance.now();
  let maxLag = 0;
  let latest: LoopDelayWindow | null = null;
  const lagNow = () => performance.now() - lastTick - tickMs;
  const ticker = setInterval(() => {
    maxLag = Math.max(maxLag, lagNow());
    lastTick = performance.now();
  }, tickMs);
  ticker.unref();
  const check = (): LoopDelayWindow => {
    // 刚卡完、心跳还没来得及跳的那一截也算上
    const w = { at: Date.now(), maxMs: Math.max(0, Math.round(Math.max(maxLag, lagNow()))) };
    maxLag = 0;
    latest = w;
    if (w.maxMs > warnMs) {
      log(`[loop-delay] 事件循环最长卡了 ${w.maxMs}ms（过去 ${Math.round(windowMs / 1000)} 秒内）——有同步重活跑在主线程上`);
    }
    return w;
  };
  const settle = setInterval(check, windowMs);
  settle.unref();
  return {
    stop() {
      clearInterval(ticker);
      clearInterval(settle);
    },
    last: () => latest,
    check,
  };
}
