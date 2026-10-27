// 设备通道：bridge ⇄ 设备服务（桌面客户端）。
//
// 设备在 NAT 后面无法被入站直达，所以由它主动对 bridge 开一条持久 SSE 登记「在线」，
// 收到 op 在本机执行，用 POST 回传。bridge 侧的 agent 工具调 dispatch() 推一条 op、按 opId
// 等回传。原先这一层在独立中继进程里（client/host/lib/control.mjs），现在并进 bridge 自己——
// 设备直接连 bridge 的地址，同机部署时就是 localhost，不再多一跳。
//
// 流式 op（终端输出、端口转发的响应体）：设备可以对同一个 opId 多次回传 {partial:true, chunk}，
// 最后一条不带 partial 的才算结束；dispatch 的 onChunk 逐块收到。

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

// deviceId -> Device
//   res       当前挂着的 SSE（同设备最多一条；新连挤掉旧连）
//   pending   已下推、等回传的 op：Map<opId, {resolve,reject,timer,op,onChunk,timeoutMs}>
const devices = new Map();

export const deviceEvents = new EventEmitter();   // 'online' / 'offline' (deviceId, info) —— 给前端推设备状态
deviceEvents.setMaxListeners(0);

// 回传体上限（整屏截图 base64 / 大文件读走这条）。
export const DEVICE_MAX_BYTES = 16 * 1024 * 1024;

// 护栏：防 agent 失控猛发 / 陷死循环。
const RATE_MAX = 240, RATE_WINDOW_MS = 60_000;      // 每设备每分钟 op 上限
const LOOP_MAX = 20;                                  // 同一 (op,args) 连续次数上限
// 天然会重复的不计死循环（终端输入、端口转发、读文件/列目录、浏览器动作）
const LOOP_EXEMPT = new Set(['browser', 'shell', 'fs.read', 'fs.list', 'fs.stat', 'sysinfo', 'pty.write', 'pty.resize', 'http.request', 'state']);
const LOOP_EXEMPT_PREFIX = ['pty.', 'http.'];
// 终端按键与端口转发的请求是人（和浏览器）在用，不是 agent 在猛发：频率护栏整个不算它们，
// 否则打字快一点、或一个 dev server 页面一次拉上百个模块就会被拦。
const RATE_EXEMPT_PREFIX = ['pty.', 'http.'];

function dev(deviceId) {
  let d = devices.get(deviceId);
  if (!d) {
    d = {
      res: null, pending: new Map(), attachedAt: 0, lastBeat: 0, recentTs: [], lastSig: null, lastSigCount: 0,
      info: null, detachedAt: 0, lastOp: '', lastOpAt: 0, ops: 0,
    };
    devices.set(deviceId, d);
  }
  return d;
}

/**
 * 解析设备自报的 X-Bridge-Client 头（base64url JSON）。来自被控端，不可信：只取白名单字段、全部截短。
 * 老客户端只报 remote/desktop/update 几个布尔；新设备服务额外报权限档 tier 与能力清单 caps。
 */
export function parseClientInfo(header) {
  if (!header || typeof header !== 'string' || header.length > 4096) return null;
  let raw;
  try { raw = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const s = (v, n = 80) => (v == null ? '' : String(v).slice(0, n));
  const tier = ['off', 'observe', 'control'].includes(raw.tier) ? raw.tier : '';
  const caps = Array.isArray(raw.caps) ? raw.caps.filter((c) => typeof c === 'string' && /^[a-z][a-z.]{0,30}$/.test(c)).slice(0, 30) : [];
  return {
    version: s(raw.version, 40),
    hostname: s(raw.hostname, 80),
    user: s(raw.user, 60),
    os: s(raw.os, 80),
    arch: s(raw.arch, 20),
    machineId: s(raw.machineId, 80),
    remote: raw.remote === true,
    desktop: raw.desktop === true,
    update: raw.update === true,
    ...(tier ? { tier } : {}),
    ...(caps.length ? { caps } : {}),
    shell: s(raw.shell, 20),          // 'desktop'（桌面客户端设备服务）| ''（老客户端执行器）
  };
}

function guard(d, op, args) {
  const now = Date.now();
  d.recentTs = d.recentTs.filter((t) => now - t < RATE_WINDOW_MS);
  if (d.recentTs.length >= RATE_MAX) return `操作过于频繁（每分钟上限 ${RATE_MAX} 次已触发）——请放慢，先确认上一步是否已生效。`;
  if (RATE_EXEMPT_PREFIX.some((p) => op.startsWith(p))) return null;
  const exempt = LOOP_EXEMPT.has(op) || LOOP_EXEMPT_PREFIX.some((p) => op.startsWith(p));
  const sig = op + ':' + JSON.stringify(args || {});
  if (exempt) { d.lastSig = sig; d.lastSigCount = 1; }
  else {
    if (sig === d.lastSig) d.lastSigCount += 1; else { d.lastSig = sig; d.lastSigCount = 1; }
    if (d.lastSigCount > LOOP_MAX) return `检测到连续重复同一动作（${op}）超过 ${LOOP_MAX} 次，疑似死循环，已拦截——请换个策略。`;
  }
  d.recentTs.push(now);
  return null;
}

// ── SSE 挂载 ────────────────────────────────────────────────────────────────

/** 设备服务挂上来：接管这台设备的 SSE。返回 detach()。同设备旧连一律挤掉。 */
export function attachDevice(deviceId, res, { info = null, onDetach = null } = {}) {
  const d = dev(deviceId);
  if (d.res && d.res !== res) { try { d.res.end(); } catch {} }
  d.res = res;
  d.attachedAt = Date.now();
  d.lastBeat = Date.now();
  if (info) d.info = info;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 告诉 Cloudflare / 任何中间层：这条别攒批，逐事件下发。
    'X-Accel-Buffering': 'no',
  });
  res.write(': attached\n\n');
  deviceEvents.emit('online', deviceId, d.info);

  const beat = setInterval(() => {
    if (d.res !== res) return;
    d.lastBeat = Date.now();
    try { res.write(': hb\n\n'); } catch {}
  }, 15_000);
  beat.unref?.();

  const detach = () => {
    clearInterval(beat);
    // 被同设备的新连接挤掉（d.res 已换成新的）不算掉线；在途 op 留给新连接（回传按 opId 走，与哪条 SSE 无关）。
    // d.res 为 null 不是「被挤掉」：abortDevice（吊销/急停）先置空再等 close 回调，那也是一次真下线。
    if (d.res && d.res !== res) return;
    d.res = null;
    d.detachedAt = Date.now();
    for (const [, p] of d.pending) { try { clearTimeout(p.timer); p.reject(new Error('设备已断开（对方关了客户端、点了急停或网络中断）')); } catch {} }
    d.pending.clear();
    deviceEvents.emit('offline', deviceId, d.info);
    if (onDetach) { try { onDetach(Date.now() - d.attachedAt); } catch {} }
  };
  res.on('close', detach);
  return detach;
}

export function isDeviceOnline(deviceId) {
  const d = devices.get(deviceId);
  return !!(d && d.res);
}

export function onlineDeviceIds() {
  return [...devices.keys()].filter(isDeviceOnline);
}

/** 设备挂载时自报的信息（版本、权限档、能力）。不在线也回最后一次的。 */
export function deviceInfo(deviceId) {
  const d = devices.get(deviceId);
  return d ? d.info : null;
}

// ── 派发 ────────────────────────────────────────────────────────────────────

/**
 * 把一条 op 推给某台在线设备，等回传。
 * @param {object} [o]
 * @param {number} [o.timeoutMs]  整体超时；流式 op 每收到一块就续期。0 = 不限（终端：shell 退出才算完）
 * @param {(chunk:any)=>void} [o.onChunk]  流式 op 的分块回调
 * @param {object} [o.meta]  随 op 下发的说明（谁在操作：{by, session}），设备侧用来点亮「正在被操作」提示
 * @param {AbortSignal} [o.signal]  撤掉这个 op（访问方断开）：立即以「已取消」拒掉并从在途表删除，
 *                                  设备之后对它的回传拿到 404，自己停下（端口转发的长连接靠这个收尾）
 * @returns {Promise<any>} 设备回传的 result（ok=false → reject）
 */
export function dispatch(deviceId, op, args = {}, { timeoutMs = 60_000, onChunk = null, meta = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const d = devices.get(deviceId);
    if (!d || !d.res) { reject(new Error('设备离线（客户端没开，或对方关掉了「允许 agent 操作这台电脑」）')); return; }
    if (signal?.aborted) { reject(new Error('已取消')); return; }
    const blocked = guard(d, op, args);
    if (blocked) { reject(new Error(blocked)); return; }

    const opId = 'op-' + randomBytes(6).toString('hex');
    d.lastOp = op; d.lastOpAt = Date.now(); d.ops += 1;
    let done = false;
    const onAbort = () => { if (!done) { cleanup(); reject(new Error('已取消')); } };
    const cleanup = () => { done = true; clearTimeout(entry.timer); d.pending.delete(opId); signal?.removeEventListener('abort', onAbort); };
    const expire = () => { if (!done) { cleanup(); reject(new Error(`设备未在 ${Math.round(timeoutMs / 1000)}s 内响应（op=${op}）`)); } };
    const arm = () => (timeoutMs > 0 ? setTimeout(expire, timeoutMs) : null);
    const entry = {
      op, onChunk, timeoutMs,
      timer: arm(),
      bump() { if (!entry.timer) return; clearTimeout(entry.timer); entry.timer = arm(); },
      resolve: (r) => { if (!done) { cleanup(); resolve(r); } },
      reject: (e) => { if (!done) { cleanup(); reject(e instanceof Error ? e : new Error(String(e || '失败'))); } },
    };
    d.pending.set(opId, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      d.res.write('data: ' + JSON.stringify({ opId, op, args, ...(meta ? { meta } : {}) }) + '\n\n');
    } catch (e) {
      cleanup();
      reject(new Error('下推失败（连接可能刚断）：' + ((e && e.message) || e)));
    }
  });
}

/**
 * 设备回传一条 op 结果（或流式 op 的一块）。返回 false = 未知 opId（超时后到 / 伪造），静默丢弃。
 * onChunk 返回 Promise 时这里也返回 Promise（路由等它再回 200）：设备逐块串行回传，
 * 晚回这一块就是回压——端口转发的访问方收得慢，设备那边也就慢下来，不在内存里越攒越多。
 */
export function settleResult(deviceId, body) {
  const d = devices.get(deviceId);
  const p = d && d.pending.get(String(body?.opId || ''));
  if (!p) return false;
  if (body.partial === true) {
    p.bump();
    let r = null;
    if (p.onChunk) { try { r = p.onChunk(body.chunk); } catch {} }
    if (r && typeof r.then === 'function') {
      let timer = null;
      const cap = new Promise((resolve) => { timer = setTimeout(resolve, 30_000); timer.unref?.(); });
      return Promise.race([r, cap]).then(() => true, () => true).finally(() => clearTimeout(timer));
    }
    return true;
  }
  if (body.ok === false) p.reject(new Error(String(body.error || '设备执行失败')));
  else p.resolve(body.result === undefined ? null : body.result);
  return true;
}

/** 急停 / 吊销：拒掉某设备全部在途 op 并断开它。 */
export function abortDevice(deviceId, reason = '已中止') {
  const d = devices.get(deviceId);
  if (!d) return;
  for (const [, p] of d.pending) { try { clearTimeout(p.timer); p.reject(new Error(reason)); } catch {} }
  d.pending.clear();
  if (d.res) { try { d.res.end(); } catch {} d.res = null; }
}

export function deviceRuntime(deviceId) {
  const d = devices.get(deviceId);
  return {
    online: isDeviceOnline(deviceId),
    since: d ? d.attachedAt : 0,
    inflight: d ? d.pending.size : 0,
    info: d ? d.info : null,
    detachedAt: d ? d.detachedAt : 0,
    lastOp: d ? d.lastOp : '',
    lastOpAt: d ? d.lastOpAt : 0,
    ops: d ? d.ops : 0,
  };
}
