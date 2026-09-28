// 账号级事件总线客户端：一条常驻 POST-SSE（/api/stream），把「刚发生了什么」推过来。
//
// 在它之前，多端同步全靠两处轮询：会话列表只在进 claude 页时刷一次（于是手机上新建的
// 会话在电脑端根本不冒出来），直播镜像每 4s 探一次 /api/active。现在这两件事都改由服务端
// 推：run.start / run.end / session.touch / question。
//
// 事件（服务端 src/runtime/bus.mjs）：
//   {type:'hello', runs:[{sessionId,userText,startedAt,source}], pending:[sessionId]}
//   {type:'run.start', sessionId, userText, startedAt, source}
//   {type:'run.end', sessionId}
//   {type:'session.touch', sessionId, mtime, live}   live=此刻正由本机一轮在写
//   {type:'question', sessionId, pending}
//   {type:'suggestion', sessionId, text, at}   定局后预测的下一句（输入建议；hello 另带全量 suggestions）
//
// 连接的读法/看门狗直接复用 sse.js：总线是同一种长连接，手机切后台同样会被系统静默
// 掐成半开，必须共用那套「多久没收到任何字节就判死重连」的判据。
//
// 断线不是致命的：调用方（ClaudePage）在 busConnected() 为 false 时保留原来的 4s 轮询兜底，
// 所以总线只是把体验从「最多等 4s / 要手动刷新」提到「即时」，从不制造新的单点。
//
// ── 同源多实例共用一条连接（2026-09-26，分屏 / 拖出独立窗口）──
// 分屏那一格是同源 iframe、拖出去的对话是另一个窗口，各自一整套前端、各自要总线。每份都开一条
// 常驻 POST-SSE 的话，本机直连 127.0.0.1（HTTP/1.1，同主机最多 6 条连接）三四个实例就把连接池
// 占满，其余请求全部排队，看着像应用卡死。所以同源实例【只开一条】：Web Locks 选出一个
// 「领头」实例真正连 /api/stream，收到的事件经 BroadcastChannel 转给其余实例；领头的不要总线了
// （离开 Claude 页 / 关窗）就放锁，排队的下一个自动接班。随后加入的实例问一声（ask），领头的
// 回它连接状态和一份【跟着事件续写过】的 hello（在跑的轮 / 待回答的提问），列表状态点不缺。
// 没有 Web Locks（非安全上下文，如局域网 http://192.168…）就退回各连各的老路。

import { authHeaders } from './api.js';
import { apiUrl } from './server.js';
import { pump, watch, linkAbort } from './sse.js';

const handlers = new Set();
let ctrl = null;          // 当前这轮连接循环的 controller（busStop 掐它）
let running = false;      // 循环是否在跑
let connected = false;    // 当前是否真的连着（决定调用方要不要开兜底轮询）
let refs = 0;             // busStart/busStop 引用计数——多个组件可以各自 start

// —— 同源共享（见文件头）——
const LOCK = 'bridge-bus';
const CHAN = 'bridge-bus';
const canShare = typeof navigator !== 'undefined' && !!navigator.locks && typeof BroadcastChannel !== 'undefined';
let chan = null;          // BroadcastChannel（start 时开、stop 时关）
let leader = false;       // 本实例此刻是不是领头（真连着 /api/stream 的那个）
let peerUp = false;       // 跟随时：领头那边连没连上
let lockWait = null;      // 排队等锁的 AbortController（还没轮到就 stop 了要撤队）
let lockRelease = null;   // 持锁期间：调用它 = 放锁
let lastHello = null;     // 领头维护的 hello 快照（跟着 run.start/run.end/question 续写）

export function busConnected() { return leader || !chan ? connected : peerUp; }

function noteHello(ev) {
  if (ev.type === 'hello') {
    lastHello = { type: 'hello', runs: [...(ev.runs || [])], pending: [...(ev.pending || [])] };
    if (ev.suggestions) lastHello.suggestions = { ...ev.suggestions };   // 老服务端不带就别造一个空表（空表=清掉全部建议）
    return;
  }
  if (!lastHello || !ev.sessionId) return;
  if (ev.type === 'suggestion') {
    if (lastHello.suggestions) lastHello.suggestions[ev.sessionId] = { text: ev.text, at: ev.at };
  } else if (ev.type === 'run.start') {
    if (lastHello.suggestions) delete lastHello.suggestions[ev.sessionId];
    lastHello.runs = lastHello.runs.filter((r) => r.sessionId !== ev.sessionId);
    lastHello.runs.push({ sessionId: ev.sessionId, userText: ev.userText, startedAt: ev.startedAt, source: ev.source });
  } else if (ev.type === 'run.end') {
    lastHello.runs = lastHello.runs.filter((r) => r.sessionId !== ev.sessionId);
    lastHello.pending = lastHello.pending.filter((id) => id !== ev.sessionId);
  } else if (ev.type === 'question') {
    lastHello.pending = lastHello.pending.filter((id) => id !== ev.sessionId);
    if (ev.pending) lastHello.pending.push(ev.sessionId);
  }
}
function post(msg) { try { chan?.postMessage(msg); } catch { /* 通道已关 */ } }
function setConnected(v) {
  connected = v;
  if (leader) post({ __bus: 'state', connected: v });
}
function onChan(m) {
  const d = m && m.data;
  if (!d) return;
  if (d.__bus === 'ask') {
    if (!leader) return;
    // 先补 hello（新来的实例据此对账：列表状态点 + 内核 requestSync），再报连接状态
    if (connected && lastHello) post({ __bus: 'ev', ev: lastHello });
    post({ __bus: 'state', connected });
    return;
  }
  if (leader) return;                       // 领头的只听 ask，事件以自己那条连接为准
  if (d.__bus === 'state') { peerUp = !!d.connected; return; }
  if (d.__bus === 'ev' && d.ev) { noteHello(d.ev); emit(d.ev); }
}

export function busOn(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

function emit(ev) {
  if (!ev || !ev.type) return;
  for (const fn of [...handlers]) { try { fn(ev); } catch { /* 一个订阅者出错不影响别人 */ } }
}
// 领头实例收到服务端事件：本地派发 + 转给同源其余实例
function emitLive(ev) {
  if (!ev || !ev.type) return;
  noteHello(ev);
  emit(ev);
  if (leader) post({ __bus: 'ev', ev });
}

async function openStream(signal) {
  // 派生 controller：看门狗判半开时只掐这一条连接，重连循环继续。
  const attempt = linkAbort(signal);
  const res = await fetch(apiUrl('/api/stream'), {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'same-origin',
    signal: attempt.signal,
  });
  if (res.status === 204) return { unsupported: true };   // 快照桶等不参与同步的身份
  if (!res.ok || !res.body) throw Object.assign(new Error('stream HTTP ' + res.status), { status: res.status });
  try { res.__attemptAbort = () => attempt.abort(); } catch {}
  return { res };
}

async function loop(signal) {
  for (let attempt = 1; !signal.aborted; attempt++) {
    let opened;
    try {
      opened = await openStream(signal);
    } catch (e) {
      if (signal.aborted) return;
      // 鉴权失败重连永远不会成功——安静退出，调用方回落轮询（它自己会撞出 401 提示）。
      if (e && (e.status === 401 || e.status === 403)) return;
      if (!(await backoff(attempt, signal))) return;
      continue;
    }
    if (opened.unsupported) return;        // 服务端明说不支持：不重试
    attempt = 0;                           // 连上了 → 退避计数归零
    setConnected(true);
    const w = watch(() => opened.res.__attemptAbort?.());
    w.touch();
    const how = await pump(opened.res, emitLive, signal, w.touch);
    w.release();
    setConnected(false);
    if (how === 'aborted' || signal.aborted) return;
    if (!(await backoff(1, signal))) return;   // 服务端收了连接（重启/心跳超时）→ 重连
  }
}

// 退避等待，可被 abort 立刻释放。上限 10s：总线断着的期间调用方在跑 4s 兜底轮询，
// 不必为了抢那几秒把重连打得很密。
function backoff(attempt, signal) {
  if (signal.aborted) return Promise.resolve(false);
  const ms = Math.min(600 * attempt, 10_000);
  return new Promise((resolve) => {
    let timer = null;
    const finish = (ok) => {
      if (timer) { clearTimeout(timer); timer = null; }
      signal.removeEventListener('abort', onAbort);
      window.removeEventListener('online', onWake);
      document.removeEventListener('visibilitychange', onWake);
      resolve(ok);
    };
    const onAbort = () => finish(false);
    // 回到前台 / 网络恢复：立刻重试，不等退避走完（手机最常见的恢复路径）。
    const onWake = () => { if (!document.hidden) finish(true); };
    timer = setTimeout(() => finish(true), ms);
    signal.addEventListener('abort', onAbort, { once: true });
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', onWake);
  });
}

function runLoop() {
  running = true;
  ctrl = new AbortController();
  const signal = ctrl.signal;
  return loop(signal).finally(() => {
    if (ctrl && ctrl.signal === signal) { running = false; setConnected(false); }
  });
}

export function busStart() {
  refs++;
  if (running || lockWait) return;
  if (chan) {
    // 领头的循环因鉴权失败退出了（401/403：没登录就开了总线、或令牌过期），锁和通道却还攥着——
    // 此时再 start（多半是刚登录 / 换了身份）就用新凭据重连，否则这一整页再也收不到推送。
    if (leader) runLoop();
    return;
  }
  if (!canShare) { runLoop(); return; }
  chan = new BroadcastChannel(CHAN);
  chan.onmessage = onChan;
  post({ __bus: 'ask' });                  // 已有领头的话，它会回连接状态 + hello 快照
  const wait = new AbortController();
  lockWait = wait;
  navigator.locks.request(LOCK, { signal: wait.signal }, () => new Promise((release) => {
    // 轮到本实例领头（上一个领头的放锁 / 关窗了）：自己连，事件转给大家
    lockWait = null;
    leader = true;
    peerUp = false;
    lockRelease = release;
    runLoop();
  })).catch(() => { /* 排队期间被 stop 撤掉 */ });
}

export function busStop() {
  if (refs > 0) refs--;
  if (refs > 0) return;
  try { ctrl?.abort(); } catch {}
  ctrl = null;
  running = false;
  if (leader) { post({ __bus: 'state', connected: false }); }
  connected = false;
  leader = false;
  peerUp = false;
  try { lockWait?.abort(); } catch {}
  lockWait = null;
  const rel = lockRelease; lockRelease = null;
  try { rel?.(); } catch {}
  try { chan?.close(); } catch {}
  chan = null;
}
