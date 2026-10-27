// 「手机操控」（Phone Control）PC 侧命令通道——独立长轮询，不搭 Claude 对话的 SSE 流。
//
// 为什么不复用 phone-bridge.mjs（档2 文件桥）：那条通道把 phone_cmd 推进【发起对话的
// 活跃 gen 的 SSE 流】，靠 WebView 的 JS 执行。但 Tier 3 操控要把别的 app 切到前台，
// WebView 一退后台 JS 即冻结、后续命令收不到（设计文档 §1.1）。所以操控通道建在一条
// 【独立前台服务 PhoneControlService】上：服务自持一条长轮询到 PC，不依赖 WebView 在前台。
//
// 数据流：
//   Claude 调 mcp__phoneControl__* → resolveDevice 定下【哪一台】→ requestPhoneControl 入该设备队列 →
//   那台手机的 PhoneControlService 正长轮询 GET /api/phone-control/next → 收到 {cmdId,op,args} →
//   分发执行 → POST /api/phone-control/result {cmdId,ok,result} → resolve promise → 返回 Claude。
//
// 【按设备分桶（09-25 v2）】同一账号可以有多台手机同时开着操控。以前只按账号（genKey）分桶：
// 两台手机抢同一条长轮询（后来的顶掉先来的 → 被顶的立刻重连再顶回去 → 每秒一两次空转），
// 命令落到哪台全凭那一刻谁挂着轮询——读屏在 A、点按在 B 都可能发生。现在是 账号 → 设备 两级：
//   · 新 apk 带 ?device=<uuid>（外加 name/model/android/code/r 就绪位）；
//   · 旧 apk 不带 → 用请求 UA 里的机型号（Dalvik/WebView UA 都有 "Android 16; SM-S9370 Build/"）当设备身份，
//     两台不同型号的旧 apk 也能分开；机型号也拿不到才落到共用的 'legacy'。
// 命令只进指定设备的队列，同设备才会互相顶长轮询。cmdId 的 in-flight 表按设备隔离，回传方身份天然校验。

import { readBody } from './body.mjs';
import { contextFor } from './identity.mjs';
import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config/index.mjs';
import { preloadPlaybook } from './phone-playbook.mjs';

// genKey -> Map<deviceId, Device>
//   Device = { id, name, model, android, appCode, legacy, ready, readyAt,
//              queue, waiter, inflight, lastPoll, recentTs, lastSig, lastSigCount }
const accounts = new Map();

const RESULT_MAX_BYTES = 6 * 1024 * 1024;   // result body 上限（观察结果带截图 base64）
const ONLINE_WINDOW_MS = 40_000;            // 最近一次长轮询在此窗口内 = 在线（长轮询挂 ~25s，留余量）
const MAX_WAIT_MS = 30_000;                 // 单次长轮询服务端最长挂起

// 护栏（设计文档 §5）：防 Claude 失控猛点 / 陷死循环。按设备计。
const RATE_MAX = 90, RATE_WINDOW_MS = 60_000;
const LOOP_MAX = 15;
const LOOP_EXEMPT = new Set(['screen', 'wait', 'scroll', 'swipe', 'ping', 'status']);

const AUDIT_FILE = path.join(ROOT, 'phone-control-audit.log');
function clip(s, n = 300) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
function audit(genKey, deviceId, op, args, ok, error, extra) {
  try {
    const entry = { ts: new Date().toISOString(), genKey, device: deviceId, op, args: clip(JSON.stringify(args || {})), ok };
    if (error) entry.error = clip(error, 200);
    if (extra) Object.assign(entry, extra);
    appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', () => {});
  } catch {}
}

// —— 设备身份 ——
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
/** 从 UA 抠机型号：Dalvik「(Linux; U; Android 16; SM-S9370 Build/…)」、WebView「(Linux; Android 16; SM-S9370 Build/…; wv)」。
 *  Chrome 精简 UA 的「Android 10; K」没有 Build/，不算机型（返回 ''）。 */
export function modelFromUA(ua) {
  const m = String(ua || '').match(/Android [\d.]+;\s*([^;)]+?)\s+Build\//);
  return m ? m[1].trim() : '';
}
/** 新 apk 在 WebView UA 末尾挂「BridgeDevice/<id>」、原生请求带 X-Bridge-Device 头。 */
export function deviceTokenFromUA(ua) {
  const m = String(ua || '').match(/\bBridgeDevice\/([A-Za-z0-9_-]{6,64})\b/);
  return m ? m[1] : '';
}
/** 一条来自手机的请求属于哪台设备（长轮询/回传/事件/聊天都用它，保证同一台手机算出同一个 id）。 */
export function deviceIdFromReq(req) {
  let q = null;
  try { q = new URL(req.url, 'http://localhost').searchParams; } catch {}
  const explicit = (q && q.get('device')) || String(req.headers['x-bridge-device'] || '') || deviceTokenFromUA(req.headers['user-agent']);
  if (explicit && ID_RE.test(explicit)) return 'd:' + explicit;
  const model = modelFromUA(req.headers['user-agent']);
  return model ? 'm:' + model : 'legacy';
}

function account(genKey) {
  let a = accounts.get(genKey);
  if (!a) { a = new Map(); accounts.set(genKey, a); }
  return a;
}
function dev(genKey, id) {
  const a = account(genKey);
  let d = a.get(id);
  if (!d) {
    d = {
      id, name: '', model: id.startsWith('m:') ? id.slice(2) : '', android: '', appCode: 0, legacy: !id.startsWith('d:'),
      ready: null, readyAt: 0,
      queue: [], waiter: null, inflight: new Map(), lastPoll: 0, recentTs: [], lastSig: null, lastSigCount: 0,
    };
    a.set(id, d);
  }
  return d;
}
const isOnline = (d) => !!d && (!!d.waiter || (Date.now() - d.lastPoll) < ONLINE_WINDOW_MS);

// 就绪位：手机每次长轮询带 r=a1s1i0d0w1l0o1（a 无障碍已接上 / s 能截图 / i 输入法已启用 / d 输入法是当前默认 /
// w 屏幕亮 / l 锁屏中 / o 悬浮窗权限）。只用于设备清单展示，执行时手机侧还会现查（这份最多旧 25s）。
const READY_KEYS = { a: 'a11y', s: 'screenshot', i: 'imeEnabled', d: 'imeDefault', w: 'screenOn', l: 'locked', o: 'overlay' };
export function parseReady(r) {
  const s = String(r || '');
  if (!s) return null;
  const out = {};
  for (const m of s.matchAll(/([a-z])([01])/g)) if (READY_KEYS[m[1]]) out[READY_KEYS[m[1]]] = m[2] === '1';
  return Object.keys(out).length ? out : null;
}

// 频率 + 死循环护栏。通过返回 null；触发返回错误信息字符串。
function guard(d, op, args) {
  const now = Date.now();
  d.recentTs = d.recentTs.filter((t) => now - t < RATE_WINDOW_MS);
  if (d.recentTs.length >= RATE_MAX) return '操作过于频繁（每分钟上限 ' + RATE_MAX + ' 次已触发）——请放慢，先读屏确认上一步是否已生效，别重复猛点。';
  const sig = op + ':' + JSON.stringify(args || {});
  if (LOOP_EXEMPT.has(op)) { d.lastSig = sig; d.lastSigCount = 1; }
  else {
    if (sig === d.lastSig) d.lastSigCount += 1; else { d.lastSig = sig; d.lastSigCount = 1; }
    if (d.lastSigCount > LOOP_MAX) return '检测到连续重复同一动作（' + op + '）超过 ' + LOOP_MAX + ' 次，疑似死循环，已拦截——请换个策略，或先 phone_screen 看现在屏幕到底什么样。';
  }
  d.recentTs.push(now);
  return null;
}

// —— 设备清单与选择 ——
/** 给人/模型看的设备名：用户起的设备名 > 机型号 > id。 */
export function deviceLabel(d) {
  if (!d) return '?';
  const base = d.name || d.model || d.id;
  const extra = [d.name && d.model ? d.model : '', d.android ? '安卓 ' + d.android : ''].filter(Boolean).join('，');
  return extra ? base + '（' + extra + '）' : base;
}
/** 短句柄：模型传 device 参数时用它（也接受名字/机型的子串）。 */
export function deviceHandle(d) {
  if (d.id.startsWith('d:')) return d.id.slice(2, 8);
  if (d.id.startsWith('m:')) return d.id.slice(2);
  return d.id;
}
export function listDevices(genKey, { includeOffline = false } = {}) {
  const a = accounts.get(genKey);
  if (!a) return [];
  const now = Date.now();
  return [...a.values()]
    .filter((d) => includeOffline || isOnline(d))
    .sort((x, y) => y.lastPoll - x.lastPoll)
    .map((d) => ({
      id: d.id, handle: deviceHandle(d), label: deviceLabel(d), name: d.name, model: d.model, android: d.android,
      appCode: d.appCode, legacy: d.legacy, online: isOnline(d), lastPoll: d.lastPoll,
      ready: d.ready, readyAgoMs: d.readyAt ? now - d.readyAt : null,
    }));
}
function matchDevices(online, want) {
  const w = String(want || '').trim().toLowerCase();
  if (!w) return [];
  const exact = online.filter((d) => d.id.toLowerCase() === w || deviceHandle(d).toLowerCase() === w
    || (d.id.startsWith('d:') && w.length >= 4 && d.id.slice(2).toLowerCase().startsWith(w)));
  if (exact.length) return exact;
  return online.filter((d) => [d.name, d.model].some((s) => s && s.toLowerCase().includes(w)));
}
function describeOnline(online) {
  return online.map((d) => '「' + deviceHandle(d) + '」' + deviceLabel(d)).join('；');
}
/**
 * 定下这次命令发给哪台手机。优先级：显式 want > 本轮已锁定的 sticky > 发起这轮对话的那台 origin >
 * 唯一在线的那台。多台在线又没法判断 → 报错并列出设备，让模型指定（拿不准就问用户）。
 * @returns {{device:object}|{error:string}}
 */
export function resolveDevice(genKey, { want, sticky, origin } = {}) {
  const a = accounts.get(genKey);
  const online = a ? [...a.values()].filter(isOnline) : [];
  if (!online.length) return { error: '手机操控服务未连接——请在手机 app 的设置里开启「手机操控」（读屏/点按还需授予无障碍）。' };
  if (want) {
    const hits = matchDevices(online, want);
    if (hits.length === 1) return { device: hits[0] };
    if (!hits.length) return { error: '没找到在线的设备「' + want + '」。当前在线：' + describeOnline(online) };
    return { error: '「' + want + '」匹配到 ' + hits.length + ' 台，请用句柄指定：' + describeOnline(hits) };
  }
  if (sticky) { const d = a.get(sticky); if (isOnline(d)) return { device: d }; }
  if (origin) { const d = a.get(origin); if (isOnline(d)) return { device: d }; }
  if (online.length === 1) return { device: online[0] };
  return { error: '有 ' + online.length + ' 台手机开着操控：' + describeOnline(online) + '。请用 device 参数指定操作哪一台；不确定用户指的是哪台就先问用户。' };
}

// 设备控制服务是否在线：给了 deviceId 看那一台，否则账号下任一台在线即算。
export function isControlOnline(genKey, deviceId) {
  const a = accounts.get(genKey);
  if (!a) return false;
  if (deviceId) return isOnline(a.get(deviceId));
  for (const d of a.values()) if (isOnline(d)) return true;
  return false;
}
export function controlStatus(genKey) {
  const devices = listDevices(genKey, { includeOffline: true });
  return {
    online: devices.some((d) => d.online),
    lastPoll: devices.reduce((m, d) => Math.max(m, d.lastPoll || 0), 0),
    queued: 0, inflight: 0,
    devices,
  };
}

// 取队首一条命令写给某个 response（标记 in-flight）。写失败（连接断）则放回队首。
function sendNext(d, res) {
  const cmd = d.queue.shift();
  if (!cmd) return;
  d.inflight.set(cmd.cmdId, cmd);
  try {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cmdId: cmd.cmdId, op: cmd.op, args: cmd.args }));
  } catch {
    d.inflight.delete(cmd.cmdId);
    d.queue.unshift(cmd);
  }
}
function deliver(d) {
  if (d.waiter && d.queue.length > 0) {
    const w = d.waiter; d.waiter = null; clearTimeout(w.timer);
    sendNext(d, w.res);
  }
}

/**
 * 向某账号的某台手机下发一条操控命令，等回传。
 * @param {object} o genKey / deviceId（缺省时按 resolveDevice 规则挑：唯一在线那台，多台则报错）/ op / args / timeoutMs
 * @returns {Promise<any>} 手机回传 result（ok=false → reject 带 error）
 */
export function requestPhoneControl({ genKey = 'admin', deviceId, op, args = {}, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let d;
    if (deviceId) {
      d = accounts.get(genKey)?.get(deviceId);
      if (!isOnline(d)) { reject(new Error('那台手机（' + (d ? deviceLabel(d) : deviceId) + '）的操控服务当前不在线——请在它的 app 设置里开启「手机操控」。')); return; }
    } else {
      const r = resolveDevice(genKey, {});
      if (r.error) { reject(new Error(r.error)); return; }
      d = r.device;
    }
    const blocked = guard(d, op, args);
    if (blocked) { audit(genKey, d.id, op, args, false, blocked); reject(new Error(blocked)); return; }
    const cmdId = 'pc-' + randomBytes(6).toString('hex');
    let done = false;
    const t0 = Date.now();
    const cleanup = () => {
      clearTimeout(cmd.timer);
      d.inflight.delete(cmdId);
      const i = d.queue.indexOf(cmd); if (i >= 0) d.queue.splice(i, 1);
    };
    // 审计以【手机回传的结论】为准：输入等动作回读没对上（verified:false）的单独记下，不再一律记成功。
    const verdict = (r) => (r && typeof r === 'object' && r.verified === false ? { verified: false } : null);
    const cmd = {
      cmdId, op, args,
      resolve: (r) => { if (!done) { done = true; cleanup(); audit(genKey, d.id, op, args, true, null, { ms: Date.now() - t0, ...verdict(r) }); resolve(r); } },
      reject: (e) => { if (!done) { done = true; cleanup(); const msg = e instanceof Error ? e.message : String(e || '失败'); audit(genKey, d.id, op, args, false, msg, { ms: Date.now() - t0 }); reject(e instanceof Error ? e : new Error(msg)); } },
      timer: setTimeout(() => { if (!done) { done = true; cleanup(); audit(genKey, d.id, op, args, false, '超时', { ms: Date.now() - t0 }); reject(new Error('手机响应超时（' + op + '）')); } }, timeoutMs),
    };
    d.queue.push(cmd);
    deliver(d);
  });
}

// 急停 / 服务停止：拒掉该设备（缺省=该账号所有设备）所有在途与排队命令。
export function abortAll(genKey, reason = '已中止', deviceId) {
  const a = accounts.get(genKey);
  if (!a) return;
  for (const d of a.values()) {
    if (deviceId && d.id !== deviceId) continue;
    for (const cmd of Array.from(d.inflight.values())) cmd.reject(new Error(reason));
    for (const cmd of d.queue.splice(0)) cmd.reject(new Error(reason));
    d.inflight.clear();
  }
}

function clampWait(req) {
  try {
    const w = parseInt(new URL(req.url, 'http://localhost').searchParams.get('wait') || '25000', 10);
    return Number.isFinite(w) ? Math.max(0, Math.min(w, MAX_WAIT_MS)) : 25000;
  } catch { return 25000; }
}

// 长轮询顺带上报的设备资料（新 apk）：名字/机型/系统版本/apk 版本/就绪位。
function absorbDeviceInfo(d, req) {
  let q;
  try { q = new URL(req.url, 'http://localhost').searchParams; } catch { return; }
  const s = (k, n = 60) => String(q.get(k) || '').trim().slice(0, n);
  if (s('name')) d.name = s('name');
  if (s('model')) d.model = s('model');
  if (s('android', 12)) d.android = s('android', 12);
  const code = parseInt(q.get('code') || '', 10);
  if (Number.isFinite(code) && code > 0) d.appCode = code;
  const ready = parseReady(q.get('r'));
  if (ready) { d.ready = ready; d.readyAt = Date.now(); }
  if (!d.android) { const m = String(req.headers['user-agent'] || '').match(/Android ([\d.]+)/); if (m) d.android = m[1]; }
}

// GET /api/phone-control/next?wait=25000&device=… —— 手机前台服务长轮询取下一条命令。
// 命中返回 200 {cmdId,op,args}；超时返回 204 让手机立即重连。也记心跳。
export async function handleControlNext(req, res, { identify }) {
  const id = identify(req);
  if (!id || (id.kind !== 'admin' && id.kind !== 'user')) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
  const genKey = contextFor(id).key;
  const d = dev(genKey, deviceIdFromReq(req));
  d.lastPoll = Date.now();
  absorbDeviceInfo(d, req);

  // 顶掉【同一台设备】上一个还挂着的长轮询（进程重建/网络重连时的残留）。别的设备各挂各的。
  if (d.waiter) { try { clearTimeout(d.waiter.timer); d.waiter.res.writeHead(204); d.waiter.res.end(); } catch {} d.waiter = null; }

  if (d.queue.length > 0) { sendNext(d, res); return; }

  const timer = setTimeout(() => {
    if (d.waiter && d.waiter.res === res) d.waiter = null;
    try { res.writeHead(204); res.end(); } catch {}
  }, clampWait(req));
  d.waiter = { res, timer };
  req.on('close', () => { if (d.waiter && d.waiter.res === res) { clearTimeout(d.waiter.timer); d.waiter = null; } });
}

// POST /api/phone-control/result —— 手机执行完回传 {cmdId, ok, result?, error?}。
export async function handleControlResult(req, res, { identify }) {
  const id = identify(req);
  if (!id || (id.kind !== 'admin' && id.kind !== 'user')) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
  const genKey = contextFor(id).key;
  let body;
  try { body = JSON.parse(await readBody(req, RESULT_MAX_BYTES + 512 * 1024)); }
  catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }

  const cmdId = String(body.cmdId || '');
  // 先按回传方自己的设备找；找不到再扫同账号其他设备（cmdId 是随机的，只可能在某一台的 in-flight 里）。
  const a = accounts.get(genKey);
  let cmd = a && a.get(deviceIdFromReq(req))?.inflight.get(cmdId);
  if (!cmd && a) for (const d of a.values()) { cmd = d.inflight.get(cmdId); if (cmd) break; }
  if (!cmd) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no pending command'); return; }
  if (body.ok === false) cmd.reject(new Error(String(body.error || '手机端执行失败')));
  else cmd.resolve(body.result === undefined ? null : body.result);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// GET /api/phone-control/status —— 查该账号的设备与在线状态（online/lastPoll 字段保留给旧前端）。
export async function handleControlStatus(req, res, { identify }) {
  const id = identify(req);
  if (!id || (id.kind !== 'admin' && id.kind !== 'user')) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(controlStatus(contextFor(id).key)));
}

// POST /api/phone-control/preheat —— 把 Claude「挂载」进悬浮胶囊时调：只把经验库预读进内存，不起 query。
export async function handleControlPreheat(req, res, { identify }) {
  const id = identify(req);
  if (!id || (id.kind !== 'admin' && id.kind !== 'user')) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
  const genKey = contextFor(id).key;
  let apps = 0;
  try { apps = preloadPlaybook(); } catch {}
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, apps, ...controlStatus(genKey) }));
}

// POST /api/phone-control/event —— 手机推异步事件（急停 → 中止【这台】在途命令；崩溃上报）。
export async function handleControlEvent(req, res, { identify }) {
  const id = identify(req);
  if (!id || (id.kind !== 'admin' && id.kind !== 'user')) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
  const genKey = contextFor(id).key;
  const deviceId = deviceIdFromReq(req);
  let body; try { body = JSON.parse(await readBody(req, 128 * 1024)); } catch { body = {}; }
  if (body && (body.type === 'estop' || body.type === 'stop')) {
    // 认不出是哪台（'legacy'）时宁可全停；认得出只停这一台，另一台上正在做的事不受牵连。
    abortAll(genKey, '用户在手机上点了急停（或关闭了操控）', deviceId === 'legacy' ? undefined : deviceId);
    const d = accounts.get(genKey)?.get(deviceId);
    if (d) { d.lastPoll = 0; if (d.waiter) { try { clearTimeout(d.waiter.timer); d.waiter.res.writeHead(204); d.waiter.res.end(); } catch {} d.waiter = null; } }
  }
  if (body && body.type === 'crash') {
    const stack = clip(String(body.stack || ''), 4000);
    try { appendFile(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), genKey, device: deviceId, op: '__CRASH__', error: stack }) + '\n', () => {}); } catch {}
    console.error('[phone-control] 手机端崩溃（' + genKey + ' / ' + deviceId + '）:\n' + stack);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// 测试钩子：清空所有账号状态（仅单测用）。
export function __resetForTest() {
  for (const a of accounts.values()) for (const d of a.values()) if (d.waiter) { try { clearTimeout(d.waiter.timer); } catch {} }
  accounts.clear();
}
