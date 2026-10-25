// 事件循环卡顿观测（2026-10-21）。服务端是单线程：任何一段同步重活（同步扫盘、整读大文件、大 JSON）都会把所有
// 流式输出、总线、别的设备的请求一起冻住，以前只能靠外部探针去猜是谁。这里只看、不改行为：
//   · 卡顿哨兵：100ms 一跳的定时器，实际间隔比预期晚超过 STALL_MS（默认 300ms，BRIDGE_LOOP_STALL_MS 可调）就记一行，
//     附上卡顿开始前后进来、还没结束的请求（方法 + 路径 + 已经跑了多久）——同一组嫌疑 30 秒内只记一次；
//   · 每 5 分钟一行汇总（monitorEventLoopDelay 的 p50 / p99 / 最大值与卡顿次数），只在有卡顿或 p99 偏高时才打。
// loopSnapshot() 给基准脚本 / 以后的控制台读。
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const TICK_MS = 100;
const STALL_MS = Number(process.env.BRIDGE_LOOP_STALL_MS) || 300;
const SUMMARY_MS = 5 * 60_000;
const SAME_SUSPECT_MS = 30_000;

const inflight = new Set();   // { method, path, t0 }
let installed = false;
let hist = null;
const stats = { stalls: 0, worst: 0, since: Date.now(), last: null };

/** 每个请求进来时调：记下它，响应写完 / 连接断开就划掉。SSE 长连接一直挂着，报告时按进来的时刻筛掉。 */
export function trackRequest(req, res) {
  if (!installed) return;
  let p = String(req.url || '');
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  const r = { method: req.method, path: p.slice(0, 120), t0: performance.now() };
  inflight.add(r);
  const done = () => inflight.delete(r);
  res.once('finish', done);
  res.once('close', done);
}

export function installLoopMonitor() {
  if (installed) return;
  installed = true;
  hist = monitorEventLoopDelay({ resolution: 20 });
  hist.enable();
  let last = performance.now();
  const quietUntil = last + 5000;   // 启动头几秒（加载扩展、恢复状态）本来就是一整段同步活，不算
  const logged = new Map();   // 嫌疑签名 → 上次记录的时刻
  const tick = setInterval(() => {
    const now = performance.now();
    const lag = now - last - TICK_MS;
    last = now;
    if (lag < STALL_MS || now < quietUntil) return;
    stats.stalls++;
    if (lag > stats.worst) stats.worst = lag;
    const start = now - lag;   // 卡顿大约从这里开始
    // 嫌疑：卡顿开始前 2 秒内进来、卡顿时还没结束的请求（更早的多半是 SSE 长连接）
    const sus = [...inflight].filter((r) => r.t0 >= start - TICK_MS - 2000).sort((a, b) => a.t0 - b.t0).slice(0, 6);
    stats.last = { at: Date.now(), ms: Math.round(lag), suspects: sus.map((r) => r.method + ' ' + r.path) };
    const sig = stats.last.suspects.join(',') || '-';
    if (Date.now() - (logged.get(sig) || 0) < SAME_SUSPECT_MS) return;
    if (logged.size > 200) logged.clear();
    logged.set(sig, Date.now());
    const list = sus.length ? sus.map((r) => `${r.method} ${r.path}（已 ${Math.round(now - r.t0)}ms）`).join('、') : '没有在途请求（定时任务 / 后台活）';
    console.log(`[loop] 事件循环卡了 ${Math.round(lag)}ms；当时在处理：${list}`);
  }, TICK_MS);
  tick.unref?.();
  let lastStalls = 0;
  const sum = setInterval(() => {
    const p50 = hist.percentile(50) / 1e6, p99 = hist.percentile(99) / 1e6, max = hist.max / 1e6;
    const n = stats.stalls - lastStalls;
    lastStalls = stats.stalls;
    if (n || p99 > 100) console.log(`[loop] 近 5 分钟事件循环延迟 p50 ${p50.toFixed(1)}ms / p99 ${p99.toFixed(0)}ms / 最大 ${max.toFixed(0)}ms，卡顿 ≥${STALL_MS}ms ${n} 次`);
    hist.reset();
  }, SUMMARY_MS);
  sum.unref?.();
}

/** 当前窗口（上次汇总以来）的延迟分位 + 进程启动以来的卡顿统计。没装就是 null。 */
export function loopSnapshot() {
  if (!hist) return null;
  return {
    p50: +(hist.percentile(50) / 1e6).toFixed(1), p99: +(hist.percentile(99) / 1e6).toFixed(1), max: +(hist.max / 1e6).toFixed(1),
    stalls: stats.stalls, worst: Math.round(stats.worst), last: stats.last, since: stats.since, inflight: inflight.size,
  };
}
