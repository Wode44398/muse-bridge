// SSE chat client — the trickiest piece of the frontend.
//
// /api/chat is a POST whose response is an SSE stream, so EventSource (GET-only)
// can't be used: we POST and read response.body ourselves. The server BUFFERS the
// in-flight generation per caller and keeps it alive across disconnects. If the
// stream drops we recover by probing /api/active and re-attaching to the buffered
// events via POST /api/attach — NOT by re-reading the transcript (a just-finished
// turn isn't on disk yet). Heartbeats arrive as ": ping" comment lines.
//
// Event objects carry a `type`: start | token | thinking | tool_call | tool_args |
// tool_result | question | gen_media(_start|_progress|_error) | task_start |
// task_progress | task_update | task_done | usage | done | error.
//
// startChat(params, handlers) -> { stop(), get sessionId() }
//   handlers: { onEvent(ev), onError(err), onClose(), onReconnecting(attempt), onEnded(sessionId) }
// resumeActive(handlers, opts) -> attaches to an in-flight turn on page load (or null).
//
// onEnded 是两条通道【共同】的收口：本地流散场时一次终止事件都没见到（缓冲过期 204、
// 连不上、超时放弃），说明这一轮的真实结局只有 transcript 知道。上层必须据此对账，
// 绝不能把半截内容当最终答案——否则界面就永远停在离开时的那一步。

import { authHeaders } from './api.js';
import { apiUrl, noteNetFail } from './server.js';
import { t } from './i18n.js';

const DEFAULT_RECONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const isHeartbeat = (line) => line.charCodeAt(0) === 58; // ':'
const isTerminal = (ev) => ev && (ev.type === 'done' || ev.type === 'interrupted' || ev.type === 'error');

function reconnectTimeout(opts) {
  const n = Number(opts && opts.reconnectTimeoutMs);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RECONNECT_TIMEOUT_MS;
}

function reconnectTimeoutError() {
  return Object.assign(new Error(t('连接超时；任务可能仍在后台运行，请稍后重新打开会话查看结果')), { code: 'RECONNECT_TIMEOUT' });
}

// Abort-aware delay: stop() must release a reconnect loop immediately instead of
// leaving its timer/promise (and the loop's window/document listeners) alive until
// the next backoff tick.
function delay(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer = null;
    const finish = (ok) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Bound one probe/attach handshake by the reconnect deadline as well. A plain
// fetch can otherwise sit below the loop forever and bypass its elapsed-time check.
async function withDeadline(signal, ms, task) {
  if (ms <= 0) throw reconnectTimeoutError();
  const child = new AbortController();
  let timedOut = false;
  const abortChild = () => child.abort();
  if (signal?.aborted) child.abort();
  else signal?.addEventListener('abort', abortChild, { once: true });
  const timer = setTimeout(() => { timedOut = true; child.abort(); }, ms);
  try {
    const value = await task(child.signal);
    if (timedOut) throw reconnectTimeoutError();
    return value;
  } catch (e) {
    if (timedOut) throw reconnectTimeoutError();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortChild);
  }
}

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
// 回前台的阈值必须盖过一个完整心跳周期再留余量（10-21 回归 FR4）：原先 12s 小于当时的 15s 心跳，
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

// ── 「醒着的时限」 ──────────────────────────────────────────────────────────
// 放弃重连的倒计时绝不能用墙钟：手机被冻结/断网的那十几分钟里我们一次都试不了，
// 拿它计入倒计时的后果是——回到前台的第一件事不是重连，而是「已经超过 5 分钟」
// 直接判超时放弃（此时网络其实好好的）。所以回前台/联网/被唤醒就把时钟拨回 0：
// 时限的语义是「醒着且连不上这么久才放弃」。
function wakeClock() {
  let t0 = Date.now();
  const reset = () => { t0 = Date.now(); };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', reset);
    window.addEventListener('pageshow', reset);
    document.addEventListener('visibilitychange', reset);   // 隐藏时也拨回：后台那段本就不该计时
  }
  return {
    since: () => Date.now() - t0,
    release() {
      if (typeof window === 'undefined') return;
      window.removeEventListener('online', reset);
      window.removeEventListener('pageshow', reset);
      document.removeEventListener('visibilitychange', reset);
    },
  };
}

function livePath(scope, leaf) {
  return scope === 'codex' ? `/api/codex/${leaf}` : `/api/${leaf}`;
}

async function fetchActive(signal, scope) {
  try {
    const r = await fetch(apiUrl(livePath(scope, 'active')), { headers: authHeaders(), credentials: 'same-origin', signal });
    return r.ok ? r.json() : null;
  } catch {
    if (!signal?.aborted) noteNetFail();
    return null;
  }   // LAN 失效 → 下次重试自动走隧道
}

// POST /api/attach (POST variant: Cloudflare buffers GET SSE). First event is
// {type:'attach',...}; the rest are the buffered turn events. 204 = nothing live.
// session 参数：多对话并发下点名要挂的那轮（不带=服务端最新一轮，旧行为）。
async function openAttach(signal, scope, session) {
  const qs = session ? '?session=' + encodeURIComponent(session) : '';
  // 用派生 controller 发起：把「只掐这一条」的能力挂在 response 上（__attemptAbort），
  // 交给看门狗——半开的 attach 流必须能被单独撕掉重挂。
  const attempt = linkAbort(signal);
  const res = await fetch(apiUrl(livePath(scope, 'attach') + qs), { method: 'POST', headers: authHeaders(), credentials: 'same-origin', signal: attempt.signal });
  if (res.status === 204) return null;
  if (!res.ok || !res.body) throw Object.assign(new Error('attach HTTP ' + res.status), { status: res.status });
  try { res.__attemptAbort = () => attempt.abort(); } catch { /* 只读 Response：退化成不可单掐 */ }
  return res;
}

// /api/active 多对话并发形态归一：新后端给 runs[]（全部在跑的轮），旧后端只有顶层单轮
// 字段——统一成数组处理（codex scope 也走旧形态）。
function activeRuns(a) {
  if (!a) return [];
  if (Array.isArray(a.runs)) return a.runs;
  return a.active ? [a] : [];
}

// opts.reconnect=false：vertex 这类不进服务端 currentGen 缓冲的流走纯单流——
// 断了就报错，绝不去探 /api/active+/api/attach（那是 Claude 专属通道，恰有 Claude
// 任务在跑时会把 Claude 的事件串进当前气泡、sessionId 也会被污染）。
export function startChat(params, handlers, opts) {
  const allowReconnect = !(opts && opts.reconnect === false);
  const reconnectLimit = reconnectTimeout(opts);
  const scope = opts && opts.scope;
  const ctrl = new AbortController();
  let done = false;
  let gotAny = false;          // 本轮是否收到过任何事件（区分「发送就失败」与「中途断流」）
  let sessionId = params.sessionId || null;

  const emit = (ev) => {
    if (!ev) return;
    gotAny = true;
    if ((ev.type === 'start' || ev.type === 'session') && ev.sessionId) sessionId = ev.sessionId;
    if (isTerminal(ev)) done = true;
    handlers.onEvent && handlers.onEvent(ev);
  };

  async function run() {
    // 本次连接自己的 controller：看门狗判半开时只掐这一条（abort 它 → reader
    // 报错 → 走下面的 recover 重新 attach），而不是掐掉整个 handle（那会连
    // 重连链路一起停掉，正是「卡住不动」的另一种形态）。
    const attempt = linkAbort(ctrl.signal);
    const w = watch(() => attempt.abort());
    try {
      const res = await fetch(apiUrl('/api/chat'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(params),
        credentials: 'same-origin',
        signal: attempt.signal,
      });
      if (res.status === 409) {   // 会话被 Desktop / 终端 CLI 持有：不重连，原因直接报出去
        let msg = '';
        try { msg = (await res.json())?.error || ''; } catch {}
        w.release();
        if (handlers.onError) handlers.onError(Object.assign(new Error(msg || 'chat HTTP 409'), { status: 409 }));
        return;
      }
      if (!res.ok || !res.body) throw Object.assign(new Error('chat HTTP ' + res.status), { status: res.status });
      w.touch();
      const how = await pump(res, emit, ctrl.signal, w.touch);
      w.release();
      if (how === 'aborted') return;
      if (!done) await recover();            // clean end without `done` → recover
    } catch (e) {
      w.release();
      if (ctrl.signal.aborted) return;
      // 明确鉴权失败（401/403）：重连永远不会成功，直接报错让用户重新登录，绝不进重连
      // 循环——否则会一直卡"重连中…"（apk 跨源 user 鉴权失效正是这样被掩盖成假死的）。
      if (e && (e.status === 401 || e.status === 403)) { if (handlers.onError) handlers.onError(e); return; }
      noteNetFail();                         // 发送阶段网络失败：LAN 失效，重试走隧道
      await recover(e);
    } finally {
      if (!ctrl.signal.aborted) {
        // 本地流走完却从未见到终止事件（done/interrupted/error）→ 这一轮的真实结局
        // 我们并不知道（缓冲过期 204、连不上、超时放弃）。交给上层去 transcript 对账，
        // 绝不把半截内容当最终答案静默收工——那正是「回来卡在某一步」的成因。
        if (!done && handlers.onEnded) { try { handlers.onEnded(sessionId); } catch { /* 上层自理 */ } }
        handlers.onClose && handlers.onClose();
      }
    }
  }

  async function recover(lastErr) {
    if (!allowReconnect) {                   // 单流模式：不探不重连，直接报错
      if (!done && handlers.onError) handlers.onError(lastErr || new Error(t('连接中断')));
      return;
    }
    await reconnect(lastErr);
  }

  // The buffered generation survives on the server. Probe /api/active, then attach.
  // 前 8 次按退避快速重试（覆盖隧道日常重连窗口）；之后转入慢速轮询 +
  // 监听 online/visibilitychange 立即再探。连续不可达最多保留 5 分钟本地 watcher，
  // 超时只释放前端资源、不 stop 服务端任务；稍后仍可由 mirror/resume 重新挂回。
  async function reconnect(lastErr) {
    let kick = null;
    let waitTimer = null;
    let waitAbort = null;
    const onWake = () => { if (kick) kick(true); };
    const waitForRetry = (ms) => {
      if (ctrl.signal.aborted) return Promise.resolve(false);
      return new Promise((resolve) => {
        const finish = (ok) => {
          if (!kick) return;
          kick = null;
          if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
          if (waitAbort) { ctrl.signal.removeEventListener('abort', waitAbort); waitAbort = null; }
          resolve(ok);
        };
        kick = finish;
        waitAbort = () => finish(false);
        waitTimer = setTimeout(() => finish(true), Math.max(0, ms));
        ctrl.signal.addEventListener('abort', waitAbort, { once: true });
      });
    };
    const clock = wakeClock();               // 冻结/断网那段不计入放弃倒计时
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', onWake);
    try {
      for (let attempt = 1; !done && !ctrl.signal.aborted; attempt++) {
        handlers.onReconnecting && handlers.onReconnecting(attempt);
        const elapsed = clock.since();
        if (elapsed >= reconnectLimit) {
          if (handlers.onError) handlers.onError(reconnectTimeoutError());
          return;
        }
        const backoff = attempt <= 8 ? Math.min(600 * attempt, 4000) : 10000;
        // 慢速期每 10s 一探；online/回前台可立即唤醒。总时限只释放本地
        // watcher，不会调用服务端 stop，长任务仍可稍后由 mirror/resume 重新挂回。
        if (!(await waitForRetry(Math.min(backoff, reconnectLimit - elapsed)))) return;
        if (ctrl.signal.aborted || done) return;
        let a;
        try {
          a = await withDeadline(ctrl.signal, reconnectLimit - clock.since(), (signal) => fetchActive(signal, scope));
        } catch (e) {
          if (e?.code === 'RECONNECT_TIMEOUT') { if (handlers.onError) handlers.onError(e); return; }
          continue;
        }
        // null = probe unreachable (network still down / tunnel mid-reconnect) — keep
        // backing off; treating it as "finished" used to abandon on the 1st attempt
        // and silently mark a truncated turn as done. Only a definite answer proceeds.
        if (!a) continue;
        const runs = activeRuns(a);
        // 只在自己还没有 sessionId 时（新会话断在 init 前）才认领服务端最新一轮——
        // 多对话并发下无条件覆盖会把本流劫持到别的并行会话上。
        if (!sessionId && runs.length) sessionId = runs[runs.length - 1].sessionId || null;
        const mine = sessionId ? runs.find((r) => r.sessionId === sessionId) : null;
        // Probe reachable → ALWAYS try to attach (targeted at OUR session), regardless
        // of liveness. The server keeps the finished gen buffered for ~60s and
        // /api/attach replays the WHOLE buffer (incl. the final `done`) even after the
        // turn ended. Returning early WITHOUT attaching used to silently mark a turn
        // that finished server-side during a brief disconnect as done at the last byte
        // we'd received — the truncated-answer bug.
        let res;
        try {
          res = await withDeadline(ctrl.signal, reconnectLimit - clock.since(), (signal) => openAttach(signal, scope, sessionId));
        } catch (e) {
          if (e?.code === 'RECONNECT_TIMEOUT') { if (handlers.onError) handlers.onError(e); return; }
          continue;
        } // attach failed transiently — keep retrying
        if (res) {
          // The attach marker is passed through: the chat controller clears this turn's
          // already-rendered content on it, because /api/attach replays the WHOLE buffer
          // from the start (without the clear, text/tools would render twice).
          // 重新挂上的这条同样要看门：手机反复切后台时，卡住的往往正是 attach 流。
          const aw = watch(() => res.__attemptAbort?.());
          aw.touch();
          const how = await pump(res, emit, ctrl.signal, aw.touch);
          aw.release();
          if (how === 'aborted' || done) return;
          continue; // dropped again mid-attach → re-probe and retry
        }
        // 204: nothing buffered on the server for OUR session.
        if (!mine) {
          // Never received anything AND no buffer → the send itself failed
          // (POST never landed / 5xx at startup). Surface an error, don't fake done.
          if (!gotAny && handlers.onError) handlers.onError(lastErr || new Error(t('发送失败，请重试')));
          // 收到过部分输出但缓冲已过期（离线 > ~60s）：这一轮已经落盘，run() 的
          // finally 会统一调 onEnded 让上层读 transcript 补全（不在这里各调各的）。
          return;
        }
        // our run live but attach 204 (race: gen cleared between probe and attach) → retry.
      }
    } finally {
      if (kick) kick(false);
      clock.release();
      window.removeEventListener('online', onWake);
      document.removeEventListener('visibilitychange', onWake);
    }
  }

  run();
  return { stop: () => ctrl.abort(), get sessionId() { return sessionId; } };
}

// On page load, resume an in-flight turn if one exists. Returns a handle like
// startChat (with .stop()) or null if nothing is live.
// opts.session：点名要挂的会话（多对话并发）；不带=服务端最新一轮（旧行为）。
export async function resumeActive(handlers, opts) {
  const scope = opts && opts.scope;
  const want = (opts && opts.session) || null;
  const reconnectLimit = reconnectTimeout(opts);
  const ctrl = new AbortController();
  const ownerSignal = opts && opts.signal;
  const abortFromOwner = () => ctrl.abort();
  if (ownerSignal?.aborted) ctrl.abort();
  else ownerSignal?.addEventListener('abort', abortFromOwner, { once: true });
  let a;
  try {
    a = await withDeadline(ctrl.signal, reconnectLimit, (signal) => fetchActive(signal, scope));
  } catch (e) {
    ownerSignal?.removeEventListener('abort', abortFromOwner);
    if (!ctrl.signal.aborted && handlers.onError) handlers.onError(e);
    return null;
  }
  if (ctrl.signal.aborted) {
    ownerSignal?.removeEventListener('abort', abortFromOwner);
    return null;
  }
  const runs0 = activeRuns(a);
  const target = want ? runs0.find((r) => r.sessionId === want) : runs0[runs0.length - 1];
  if (!target) {
    ownerSignal?.removeEventListener('abort', abortFromOwner);
    return null;
  }
  const session = want || target.sessionId || null;
  let done = false;
  const emit = (ev) => {
    if (!ev) return;
    if (isTerminal(ev)) done = true;
    handlers.onEvent && handlers.onEvent(ev);
  };
  (async () => {
    let clock = null;                        // 断开后才起表；「醒着的时限」，冻结/断网不计入
    try {
      for (let attempt = 1; !done && !ctrl.signal.aborted; attempt++) {
        let res;
        try {
          res = await withDeadline(ctrl.signal, clock ? reconnectLimit - clock.since() : reconnectLimit, (signal) => openAttach(signal, scope, session));
        }
        catch (error) {
          if (error?.status === 401 || error?.status === 403) throw error;
          if (error?.code === 'RECONNECT_TIMEOUT') throw error;
          if (!clock) clock = wakeClock();
          if (clock.since() >= reconnectLimit) throw reconnectTimeoutError();
          handlers.onReconnecting && handlers.onReconnecting(attempt);
          const left = reconnectLimit - clock.since();
          if (!(await delay(Math.min(700 * attempt, 5000, left), ctrl.signal))) return;
          continue;
        }
        // 204：服务端这个会话已经没有缓冲了（跑完 60s 就清）。直接 return 会把半截
        // 内容当成最终答案——真实结局由 finally 的 onEnded 交给上层读 transcript 定。
        if (!res) return;
        if (clock) { clock.release(); clock = null; }
        // 重开会话/镜像挂上来的这条流同样看门：它恰恰是「切后台再回来」最常挂死的一条。
        const rw = watch(() => res.__attemptAbort?.());
        rw.touch();
        const how = await pump(res, (ev) => {
          if (ev.type !== 'attach') emit(ev);
          else handlers.onEvent && handlers.onEvent(ev);
        }, ctrl.signal, rw.touch);
        rw.release();
        if (how === 'aborted' || done) return;

        // A resumed mobile stream can drop again after the page has re-opened.
        // Keep probing/re-attaching just like a newly submitted turn instead of
        // abandoning the server-side generation at the second network break.
        clock = wakeClock();
        handlers.onReconnecting && handlers.onReconnecting(attempt);
        if (!(await delay(Math.min(700 * attempt, 5000), ctrl.signal))) return;
        const active = await withDeadline(ctrl.signal, reconnectLimit - clock.since(), (signal) => fetchActive(signal, scope));
        if (!active) continue;
        // 只看「自己这轮」是否还在跑（多对话并发下别的轮活着不算数）。
        const stillLive = session
          ? activeRuns(active).some((r) => r.sessionId === session)
          : activeRuns(active).length > 0;
        // Even when it ended, one final attach is useful because the server
        // retains the completed event buffer for a short period.
        if (!stillLive) {
          const finalRes = await openAttach(ctrl.signal, scope, session).catch(() => null);
          if (!finalRes) return;
          // 已结束的缓冲重放：正常几十毫秒就完；同样看门，免得半开 socket 把
          // 「补全最后一段答案」这步永久挂住（表现同样是停在思考中）。
          const fw = watch(() => finalRes.__attemptAbort?.());
          fw.touch();
          await pump(finalRes, (ev) => {
            if (ev.type !== 'attach') emit(ev);
            else handlers.onEvent && handlers.onEvent(ev);
          }, ctrl.signal, fw.touch);
          fw.release();
          return;
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted && handlers.onError) handlers.onError(e);
    } finally {
      clock?.release();
      ownerSignal?.removeEventListener('abort', abortFromOwner);
      if (!ctrl.signal.aborted) {
        // 同 startChat：没见到终止事件就散场 = 结局未知（缓冲过期 204 最常见）。
        // 上层据此去 transcript 对账，把半截补成完整的。
        if (!done && handlers.onEnded) { try { handlers.onEnded(session); } catch { /* 上层自理 */ } }
        handlers.onClose && handlers.onClose();
      }
    }
  })();
  return { stop: () => ctrl.abort(), active: a, get sessionId() { return session; } };
}
