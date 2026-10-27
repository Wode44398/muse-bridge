// 设备终端：在用户自己的电脑上开一个 PTY（经设备通道的 pty.* op），终端面板选「我的电脑」时用。
// 前端协议与服务器上的终端（claude-term.mjs）一致：SSE hello / snapshot / data / exit，外加
// offline / online 两个事件——设备掉线不等于终端结束，重新连上后 shell 还在，补一份快照接着用。
//
// 一台设备一个终端（设备侧 key 'main'），只给设备主人用。服务端留一份滚回缓冲，
// 多个页面同时看、断线重连都从这里重放；设备那边也留一份（服务端重启后再开同一个 key，
// 设备补快照，shell 不重开）。

import { sseWrite } from './sse.mjs';
import { deviceDispatch } from './devices.mjs';
import { deviceEvents, isDeviceOnline } from './device-control.mjs';
import { deviceAudit } from './device-audit.mjs';

const KEY = 'main';
const BUF_CAP = 400 * 1024;      // 滚回缓冲上限（字符）
const IDLE_MS = 60 * 60 * 1000;  // 没人看、也没输入输出 1 小时后收掉

const clampC = (n) => Math.max(20, Math.min(320, Math.floor(+n || 100)));
const clampR = (n) => Math.max(5, Math.min(120, Math.floor(+n || 30)));

// deviceId -> term
//   ctx       开终端的身份（= 设备主人）
//   state     'opening' | 'live' | 'offline' | 'exited'
//   chunks/bytes 滚回缓冲；subs 正在看的 SSE
const terms = new Map();

function broadcast(t, ev) {
  for (const res of t.subs) sseWrite(res, ev);
}

function append(t, d) {
  if (!d) return;
  t.chunks.push(d);
  t.bytes += d.length;
  // 整块丢弃可能把 ANSI 序列拦腰截断——xterm 对快照开头的少量乱码有容忍，同 claude-term.mjs。
  while (t.bytes > BUF_CAP && t.chunks.length > 1) t.bytes -= t.chunks.shift().length;
}

function onChunk(t, c) {
  if (!c || typeof c !== 'object') return;
  t.lastUsed = Date.now();
  if (c.type === 'snapshot') {
    // 设备那边的 shell 还活着（服务端重启过 / 设备掉线后重连）：以设备的缓冲为准
    t.chunks = c.d ? [String(c.d)] : [];
    t.bytes = c.d ? String(c.d).length : 0;
    if (t.state !== 'live') { t.state = 'live'; broadcast(t, { type: 'online' }); }
    broadcast(t, { type: 'snapshot', d: t.chunks.join('') });
    return;
  }
  if (c.type === 'data') {
    const d = String(c.d || '');
    append(t, d);
    if (t.state !== 'live') { t.state = 'live'; broadcast(t, { type: 'online' }); }
    broadcast(t, { type: 'data', d });
  }
}

// 向设备要一个终端（新开，或接上设备那边还活着的那个）。pty.open 是长流：shell 退出才结束。
// 每次开都带一个 AbortController，重开前先撤掉上一条：设备重连时新连接挤掉的若是半开旧连接（隧道 / NAT 吞了 FIN，
// 上 VPS 后更常见），旧连接上发出去的 pty.open 设备根本没收到，又不设超时——不撤就一直挂在在途表里，终端卡在「打开中」。
// 撤掉后 dispatch 把它移出在途表；设备那边对同 key 的新 pty.open 会接管旧流并补快照，最多让屏幕重画一次。
function open(t) {
  t.state = 'opening';
  t.error = '';
  const gen = ++t.gen;
  try { t.ac?.abort(); } catch {}
  const ac = (t.ac = new AbortController());
  deviceDispatch(t.ctx, t.deviceId, 'pty.open', { key: KEY, cols: t.cols, rows: t.rows }, {
    channel: 'terminal', timeoutMs: 0, by: 'user', session: 'terminal', title: '终端', audit: false, signal: ac.signal,
    onChunk: (c) => { if (gen === t.gen) onChunk(t, c); },
  }).then((r) => {
    if (gen !== t.gen) return;
    if (r && r.replaced) return;   // 被同一台设备上更新的一条流接管了（不该发生在单实例上，忽略）
    t.state = 'exited';
    t.exitCode = r && typeof r.exitCode === 'number' ? r.exitCode : null;
    broadcast(t, { type: 'exit', code: t.exitCode });
    if (terms.get(t.deviceId) === t) terms.delete(t.deviceId);
  }, (e) => {
    if (gen !== t.gen) return;
    const msg = String(e?.message || e);
    // 设备掉线：终端多半还活在那台电脑上，等它重连后再接（deviceEvents 'online'）
    if (/已断开|离线/.test(msg) && t.state !== 'exited') {
      t.state = 'offline';
      broadcast(t, { type: 'offline' });
      return;
    }
    t.state = 'exited';
    t.error = msg;
    broadcast(t, { type: 'exit', code: null, error: msg });
    if (terms.get(t.deviceId) === t) terms.delete(t.deviceId);
  });
}

// 设备（重新）挂上来：没结束的终端一律重开——不只是已判掉线的。新连接挤掉旧连接时旧连接不算掉线（device-control.mjs），
// 旧连接要是半开的，终端会一直停在 opening / live 却收不到任何东西。
deviceEvents.on('online', (deviceId) => {
  const t = terms.get(deviceId);
  if (t && t.state !== 'exited') open(t);
});

/** 取或开某台设备的终端。ctx 必须是设备主人（路由层已核过归属）。 */
export function ensureDeviceTerm(ctx, deviceId, { cols, rows } = {}) {
  let t = terms.get(deviceId);
  if (t && t.state !== 'exited') {
    if (t.state === 'offline' && isDeviceOnline(deviceId)) open(t);
    return t;
  }
  t = {
    deviceId, ctx, state: 'opening', gen: 0, error: '', exitCode: null,
    cols: clampC(cols), rows: clampR(rows), chunks: [], bytes: 0, subs: new Set(), lastUsed: Date.now(),
  };
  terms.set(deviceId, t);
  deviceAudit({ ev: 'term_open', device: deviceId, by: ctx.key });
  open(t);
  return t;
}

export function deviceTerm(deviceId) {
  return terms.get(deviceId) || null;
}

export function snapshotDeviceTerm(t) {
  return t.chunks.join('');
}

export function subscribeDeviceTerm(t, res) {
  t.subs.add(res);
  t.lastUsed = Date.now();
  res.on('close', () => { t.subs.delete(res); t.lastUsed = Date.now(); });
}

function quick(t, op, args) {
  return deviceDispatch(t.ctx, t.deviceId, op, { key: KEY, ...args }, {
    channel: 'terminal', timeoutMs: 15_000, by: 'user', session: 'terminal', audit: false,
  });
}

/** 往终端里写。返回 false = 终端不在跑（已结束 / 设备离线）。 */
export function writeDeviceTerm(deviceId, d) {
  const t = terms.get(deviceId);
  if (!t || t.state !== 'live') return false;
  t.lastUsed = Date.now();
  quick(t, 'pty.write', { d: String(d) }).catch(() => {});
  return true;
}

export function resizeDeviceTerm(deviceId, cols, rows) {
  const t = terms.get(deviceId);
  if (!t) return false;
  t.cols = clampC(cols);
  t.rows = clampR(rows);
  if (t.state === 'live') quick(t, 'pty.resize', { cols: t.cols, rows: t.rows }).catch(() => {});
  return true;
}

/** 关掉终端（「重启终端」= 先 kill 再开）。设备离线时只丢掉服务端这份记录。 */
export async function killDeviceTerm(deviceId) {
  const t = terms.get(deviceId);
  if (!t) return false;
  terms.delete(deviceId);
  t.gen++;   // 之后这条流上再来的分块与结束一律不认
  try { t.ac?.abort(); } catch {}   // 在途的 pty.open 一并撤掉（半开连接上的那条不会再有人来收）
  t.state = 'exited';
  broadcast(t, { type: 'exit', code: -1 });
  if (isDeviceOnline(deviceId)) {
    try { await quick(t, 'pty.kill', {}); } catch { /* 设备那边已经没了 */ }
  }
  return true;
}

// 闲置回收：没人看且很久没输入输出的终端，在设备上也收掉。
const reaper = setInterval(() => {
  const now = Date.now();
  for (const t of [...terms.values()]) {
    if (!t.subs.size && now - t.lastUsed > IDLE_MS) killDeviceTerm(t.deviceId).catch(() => {});
  }
}, 5 * 60 * 1000);
reaper.unref?.();

// 测试用
export function _resetDeviceTerms() { terms.clear(); }
