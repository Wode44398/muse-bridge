// POST-SSE 流的读取与半开死连接看门狗。
//
// /api/chat 与账号级事件总线 /api/stream 都是 POST 回 SSE 流，EventSource（仅 GET）用不了：
// 这里自己读 response.body、按空行切帧、JSON 解析 data: 负载。心跳是 ": ping" 注释行。
// 用法见 chat.svelte.js（单写者同步内核）与 bus.js（事件总线）。

const isHeartbeat = (line) => line.charCodeAt(0) === 58; // ':'

// Split an SSE buffer on blank lines, collect `data:` payloads, JSON-parse, emit.
// Returns the unconsumed tail.
function drain(buf, onEvent) {
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    let data = '';
    for (const raw of frame.split('\n')) {
      const line = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw; // strip \r
      if (!line || isHeartbeat(line)) continue;
      if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
    }
    if (!data) continue;
    try { onEvent(JSON.parse(data)); } catch { /* ignore malformed frame */ }
  }
  return buf;
}

// Read a streaming Response to completion. Returns 'aborted' | 'ended'.
// onByte 在【每次成功读到数据】时调用（含只有 ': ping' 心跳的块）——看门狗靠它判死活。
// export：账号级事件总线（bus.js）是同一种 POST-SSE 长连接，读法与看门狗必须共用一套，
// 否则总线会成为唯一一条「切后台回来还半开着」的流。
export async function pump(res, onEvent, signal, onByte) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    if (signal.aborted) { try { await reader.cancel(); } catch {} return 'aborted'; }
    let chunk;
    try { chunk = await reader.read(); }
    catch { return 'ended'; } // network drop mid-stream
    if (onByte) onByte();
    if (chunk.done) { drain(buf + '\n\n', onEvent); return 'ended'; }
    buf = drain(buf + dec.decode(chunk.value, { stream: true }), onEvent);
  }
}

// ── 半开死连接看门狗 ────────────────────────────────────────────────────────
// 手机上把 app 切到后台，系统常把 WebView 的 socket 静默掐断：fetch 的 reader
// 既不出错、也不再产出任何东西。于是界面永远停在「思考中」，而服务端那一轮还在
// 好好地跑——回来「杀后台再进」就能看到新吐的字，正是这个成因（重进走的是
// resume/attach 新连接）。
//
// 判据用「多久没收到任何字节」而不是「有没有新 token」：服务端每 10s 发一个
// ': ping' 心跳（src/runtime/sse.mjs HEARTBEAT_MS；2026-10-21 前是 15s），所以静默本身就是
// 可靠的死亡信号，与模型思考多久无关。
// 处置=掐掉这条【本次连接】（不是整个 handle），让既有的 recover/reconnect 链路
// 去探 /api/active 并重新 attach——缓冲还在服务端，续得上。
//
// 回前台的阈值必须盖过一个完整心跳周期再留余量：原先 12s 小于当时的 15s 心跳，
// 最近一次 ping 之后 12–15s 内回前台就把健康的流当半开掐掉——直播流被掐会整轮重放（气泡清空重建），
// 总线被掐会重连；桌面窗口一获得焦点就算一次「回前台」，于是到处闪、到处重连。
// 现在 20s：新服务端是两个心跳，老服务端（15s）也还留 5s 余量。
// 回前台后的 WAKE_WINDOW_MS 内，5s 巡检改用这个阈值，所以真半开的流仍在 ~20–25s 内被发现，而不是等 40s。
const STALL_HARD_MS = 40_000; // 连丢几个心跳 → 判死（前台巡检用）
const STALL_WAKE_MS = 20_000; // 刚回前台更急：超过就直接当半开处理
const WAKE_WINDOW_MS = 30_000; // 回前台后这么久内，巡检都按 STALL_WAKE_MS 判
const FREEZE_GAP_MS = 20_000; // 巡检自己迟到这么久 = 进程刚被冻结过（见下）
const live = new Set();       // { touch(), kill(), idle() }

// 派生一个「随父一起 abort」的 controller：看门狗只掐当前这条连接，用户点停止
// （父 signal）仍然连带掐掉它。
export function linkAbort(parentSignal) {
  const c = new AbortController();
  if (parentSignal.aborted) c.abort();
  else parentSignal.addEventListener('abort', () => c.abort(), { once: true });
  return c;
}

export function watch(killer) {
  const entry = {
    at: Date.now(),
    touch() { entry.at = Date.now(); },
    idle() { return Date.now() - entry.at; },
    kill: killer,
  };
  live.add(entry);
  return { touch: entry.touch, release: () => live.delete(entry) };
}

function sweep(thresholdMs) {
  for (const entry of [...live]) {
    if (entry.idle() <= thresholdMs) continue;
    live.delete(entry);          // 只掐一次：后续由重连链路接管
    try { entry.kill(); } catch { /* 已经死了 */ }
  }
}

if (typeof window !== 'undefined') {
  let wakeT = 0;
  let wakeAt = 0;
  const onWake = () => {
    if (document.hidden) return;   // 切到后台那一下的 visibilitychange 不算「醒来」
    clearTimeout(wakeT);
    wakeAt = Date.now();
    // 稍等一下：回前台瞬间网络栈往往还没恢复，立刻判死会白撕一次连接。
    wakeT = setTimeout(() => { if (!document.hidden) sweep(STALL_WAKE_MS); }, 250);
  };
  // 前台巡检。后台不做：定时器本就被节流/暂停，真正的兜底是下面的回前台钩子。
  // 另外自查【时间跳变】：巡检本该 5s 一次，迟到 20s 以上说明进程刚被系统冻结过
  //（安卓省电最常见）。这种醒来 visibilitychange/pageshow 不保证补发，所以巡检
  // 自己也当一次「回前台」，按严格判据体检所有长连接——否则那条被静默掐断的流
  // 要等到 40s 后才被发现，甚至因为页面从没「隐藏过」而永远发现不了。
  let lastTick = Date.now();
  setInterval(() => {
    const gap = Date.now() - lastTick;
    lastTick = Date.now();
    if (gap > FREEZE_GAP_MS) { onWake(); return; }
    if (!document.hidden) sweep(Date.now() - wakeAt < WAKE_WINDOW_MS ? STALL_WAKE_MS : STALL_HARD_MS);
  }, 5_000);
  // 不挂 window 'focus'：窗口获得焦点不代表进程被冻结过（桌面上点一下窗口就是一次 focus），
  // 真正的「从后台回来」都会先发 visibilitychange / pageshow；断网恢复发 online；被冻结的醒来靠上面的时间跳变自查。
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('online', onWake);
  window.addEventListener('pageshow', onWake);   // 安卓 WebView 从冻结态回来只发这个
}
