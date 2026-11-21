// Claude 分页右侧栏的终端服务：一个工作空间一个 PTY（PowerShell，cwd=工作空间），
// 断开重连不丢现场（SSE 快照重放）。node-pty 经 createRequire 惰性加载——
// 桌面 Electron 的 node 环境编不出原生模块，谁用谁加载。
// 快照来自每个 PTY 常驻的屏幕镜像（term-mirror.mjs：headless xterm 跟着输出与尺寸实时结算），
// 不再是一摞跨越多种尺寸的原始字节；镜像不可用时退回原始字节缓冲。

import path from 'node:path';
import { createRequire } from 'node:module';
import { sseWrite } from './sse.mjs';
import { poolKey, refPath, refOwner, HOST_OWNER } from './principal.mjs';
import { terminalEnv } from './member-boundary.mjs';
import { createMirror, hostPtyCompat } from './term-mirror.mjs';

const require = createRequire(import.meta.url);
let ptyLib = null;
const loadPty = () => (ptyLib ||= require('node-pty'));

const MAX_TERMS = 6;
const BUF_CAP = 400 * 1024;      // 滚回缓冲上限（字节）
const IDLE_MS = 60 * 60 * 1000;  // 无人观看 1 小时后回收

const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const clampC = (n) => Math.max(20, Math.min(320, Math.floor(+n || 100)));
const clampR = (n) => Math.max(5, Math.min(120, Math.floor(+n || 30)));

// 池键 =（属主, 工作空间）（开源路线 C6）：下面每个函数的 ws 参数可以是路径，也可以是
// principal.poolRef(ctx, 路径)。主机身份与只给路径的老调用方仍只按路径（键与以前逐字一致）；
// 其他身份带属主前缀——将来两个人进了同一个共享目录，也接不到对方的 shell（环境变量、历史）。
const keyOf = (ws) => poolKey(ws, fold);
// 池项的属主：主机身份与只给路径的老调用方都记成 'admin'，其余是 owner 键原样（'u:<账号 id>' / 'c:<令牌>'…）。
const ownerOfRef = (ref) => { const o = refOwner(ref); return o && o !== HOST_OWNER ? o : HOST_OWNER; };

const terms = new Map(); // key((属主 +) folded ws) -> term

// ConPTY 兼容信息（Windows 上才有）：镜像用它，hello 里也发给面板（两边的 xterm 设置必须一致）
export const PTY_COMPAT = hostPtyCompat();

function shellSpec() {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  return { file: process.env.SHELL || 'bash', args: [] };
}

// 取或创建该工作空间的终端。已退出的旧壳原地重生（保留同一个入口语义）。
export function ensureTerm(ref, cols, rows) {
  const ws = refPath(ref);
  const key = keyOf(ref);
  let t = terms.get(key);
  if (t && !t.exited) return t;
  if (t) dropTerm(t);   // 已退出的旧壳：连同镜像、还在等快照的面板一起收掉
  // 上限保护：先踢无人观看里最久没动静的。
  if (terms.size >= MAX_TERMS) {
    let oldest = null;
    for (const x of terms.values()) if (!x.subs.size && (!oldest || x.lastUsed < oldest.lastUsed)) oldest = x;
    if (!oldest) throw Object.assign(new Error('终端数量已达上限'), { status: 429 });
    dropTerm(oldest);
  }
  const { file, args } = shellSpec();
  const c = clampC(cols), r = clampR(rows);
  // 成员工作区（属主不是主机身份，或路径在用户根 / 快照桶下）的终端：按名字剔掉凭据与 bridge 内部变量（runtime/member-boundary.mjs）
  const pty = loadPty().spawn(file, args, { name: 'xterm-256color', cols: c, rows: r, cwd: ws, env: terminalEnv(ws, process.env, { owner: refOwner(ref) }) });
  // pending：正在接入的面板（attachTerm 切快照那一刻之后的输出先攒在这里，快照发完再补）
  t = { ws, key, owner: ownerOfRef(ref), pty, mirror: createMirror(c, r, { windowsPty: PTY_COMPAT }), lock: null, chunks: [], bytes: 0, subs: new Set(), taps: new Set(), pending: new Set(), lastUsed: Date.now(), cols: c, rows: r, exited: false, exitCode: null };
  pty.onData((d) => {
    // 有产出也算活着——agent 起的长跑任务（编译/下载）没人订阅也不该被 reaper 半路收走。
    t.lastUsed = Date.now();
    if (t.mirror) t.mirror.write(d);
    else {
      t.chunks.push(d);
      t.bytes += Buffer.byteLength(d);
      // 整块丢弃可能把 ANSI 序列拦腰截断——xterm 对快照开头的少量乱码有容忍，可接受。
      while (t.bytes > BUF_CAP && t.chunks.length > 1) t.bytes -= Buffer.byteLength(t.chunks.shift());
    }
    for (const p of t.pending) p.q.push(d);
    for (const res of t.subs) sseWrite(res, { type: 'data', d });
    for (const fn of t.taps) { try { fn(d); } catch { /* tap 不许拖垮输出泵 */ } }
  });
  pty.onExit(({ exitCode }) => {
    t.exited = true;
    t.exitCode = exitCode;
    for (const res of t.subs) sseWrite(res, { type: 'exit', code: exitCode });
    for (const fn of t.taps) { try { fn(null, exitCode); } catch { /* 同上 */ } }
  });
  terms.set(key, t);
  return t;
}

export function getTerm(ws) {
  return terms.get(keyOf(ws)) || null;
}

export function writeTerm(ws, data) {
  const t = terms.get(keyOf(ws));
  if (!t || t.exited) return false;
  t.lastUsed = Date.now();
  t.pty.write(String(data));
  return true;
}

function applySize(t, cols, rows) {
  t.cols = clampC(cols);
  t.rows = clampR(rows);
  try { t.pty.resize(t.cols, t.rows); } catch { /* 竞态：刚退出 */ }
  t.mirror?.resize(t.cols, t.rows);
}

const broadcast = (t, ev) => { for (const res of t.subs) sseWrite(res, ev); };
const sizeEvent = (t) => ({ type: 'size', cols: t.cols, rows: t.rows, lock: t.lock ? { cols: t.cols, rows: t.rows } : null });

// 尺寸占用：PTY 的行列默认跟着面板走，手机侧栏只有四十来列——agent 驱动 TUI 时整屏被排成窄条，读出来全是碎行。
// agent 可以把尺寸占住：面板发来的 resize 一律不理，面板改为按占用尺寸整体缩放显示。agent 一段时间不碰终端就自动作废，
// 免得它忘了交还、用户的面板一直是缩小的。
const LOCK_IDLE_MS = 15 * 60 * 1000;
function lockLive(t) {
  if (!t.lock) return false;
  if (Date.now() - t.lock.at <= LOCK_IDLE_MS) return true;
  t.lock = null;
  broadcast(t, sizeEvent(t));
  return false;
}

/** 面板改尺寸。尺寸被 agent 占着时不改，返回占用尺寸（面板据此改为缩放显示）。 */
export function resizeTerm(ws, cols, rows) {
  const t = terms.get(keyOf(ws));
  if (!t || t.exited) return false;
  if (lockLive(t)) return { lock: { cols: t.cols, rows: t.rows } };
  applySize(t, cols, rows);
  return true;
}

/** agent 占住尺寸（同时改成这个尺寸）；看着的面板收到 size 事件后改为缩放显示。 */
export function lockTermSize(ws, cols, rows) {
  const t = terms.get(keyOf(ws));
  if (!t || t.exited) return null;
  applySize(t, cols, rows);
  t.lock = { at: Date.now() };
  broadcast(t, sizeEvent(t));
  return t;
}

/** 交还尺寸：面板收到 size 事件后按自己的大小重新适配、再把尺寸发上来。 */
export function unlockTermSize(ws) {
  const t = terms.get(keyOf(ws));
  if (!t || !t.lock) return false;
  t.lock = null;
  broadcast(t, sizeEvent(t));
  return true;
}

/** agent 每次操作终端都续一下占用期。 */
export function touchTermLock(t) { if (t?.lock) t.lock.at = Date.now(); }

/** 当前占用（没有 / 已过期 = null）。hello 与状态读它。 */
export function termLock(t) { return t && lockLive(t) ? { cols: t.cols, rows: t.rows } : null; }

export function killTerm(ws) {
  const t = terms.get(keyOf(ws));
  return t ? dropTerm(t) : false;
}

// 按池里的那一项收掉（回收器 / 上限踢人用：它们手里是 term 本身，不再拿路径反查——带属主前缀的键反查不回来）。
// end:true = 连观众的 SSE 一起断开（账号删除 / 停用：已经打开的直播流不会重新鉴权，不能让他接着看输出）。
// 平时的 kill 不断流：面板收到 exit 自己显示「已退出」，断了 EventSource 会自动重连、又开出一个新壳。
function dropTerm(t, { end = false } = {}) {
  if (terms.get(t.key) === t) terms.delete(t.key);
  try { t.pty.kill(); } catch { /* already gone */ }
  broadcast(t, { type: 'exit', code: -1 });
  // 还在等快照切点的面板：镜像要收了，直接告诉它结束
  for (const p of t.pending) { p.done = true; sseWrite(p.res, { type: 'exit', code: -1 }); if (end) { try { p.res.end(); } catch { /* 已断 */ } } }
  t.pending.clear();
  if (end) {
    for (const res of t.subs) { try { res.end(); } catch { /* 已断 */ } }
    t.subs.clear();
  }
  t.mirror?.dispose();
  return true;
}

// 按属主收掉他名下的全部终端（账号删除 / 停用时调，runtime/account-lifecycle.mjs 按这个名字取）。
// owner = owner 键（'u:<账号 id>' 等）；主机的终端只有显式传 'admin' 才收。返回收掉几个。
export function killTermsOf(owner) {
  const o = String(owner || '');
  if (!o) return 0;
  let n = 0;
  for (const t of [...terms.values()]) if (t.owner === o) { dropTerm(t, { end: true }); n++; }
  return n;
}

// 同步快照（agent 读屏用）：镜像里已结算的部分。镜像解析是异步的，刚到的最后几毫秒输出可能还没算进来——
// 读屏都是等输出安静下来才读，够用；面板接入要求不丢不重，走下面的 attachTerm。
export function snapshotTerm(t) {
  if (t.mirror && !t.mirror.dead) { try { return t.mirror.serialize(); } catch { /* 退回原始缓冲 */ } }
  return t.chunks.join('');
}

// 面板接入：发快照，再订阅实时输出，中间一个字节不丢也不重。
// 镜像在「此刻之前到的输出全部结算完」那一点上切快照（mirror.at）；切点之后到的输出先攒进 pending，
// 快照发完紧接着补发，然后才转成普通订阅。
export function attachTerm(t, res) {
  if (!t.mirror || t.mirror.dead) {
    const snap = t.chunks.join('');
    if (snap) sseWrite(res, { type: 'snapshot', d: snap });
    subscribeTerm(t, res);
    return;
  }
  const p = { q: [], res, done: false };
  t.pending.add(p);
  res.on('close', () => { p.done = true; t.pending.delete(p); });
  t.mirror.at(() => {
    t.pending.delete(p);
    if (p.done || res.destroyed || res.writableEnded) return;
    let snap = '';
    try { snap = t.mirror.serialize(); } catch { snap = ''; }
    if (snap) sseWrite(res, { type: 'snapshot', d: snap });
    for (const d of p.q) sseWrite(res, { type: 'data', d });
    if (t.exited) sseWrite(res, { type: 'exit', code: t.exitCode ?? -1 });
    subscribeTerm(t, res);
  });
}

export function subscribeTerm(t, res) {
  t.subs.add(res);
  t.lastUsed = Date.now();
  res.on('close', () => { t.subs.delete(res); t.lastUsed = Date.now(); });
}

// 回调式旁路订阅（agent 侧收流用；SSE 面板走上面的 subscribeTerm）。
// cb(data) 收输出块；cb(null, exitCode) 表示 shell 退出。返回退订函数。
export function tapTerm(t, cb) {
  t.taps.add(cb);
  return () => t.taps.delete(cb);
}

// 闲置回收：没观众且很久没输入输出活动的壳，杀掉省资源。
const reaper = setInterval(() => {
  const now = Date.now();
  for (const t of [...terms.values()]) {
    if (t.exited || (!t.subs.size && now - t.lastUsed > IDLE_MS)) dropTerm(t);
  }
}, 5 * 60 * 1000);
reaper.unref?.();

for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => { for (const t of [...terms.values()]) { try { t.pty.kill(); } catch { /* orphan guard */ } } });
}
