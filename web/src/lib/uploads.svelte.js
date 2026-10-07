// 工作空间上传引擎（「传输」面板里的上传行都从这里来）。
//
// 两条执行通路，同一份行模型：
//   · 手机 App：window.BridgeUpload（MainActivity → UploadService）。原生选文件、原生线程直接读
//     content:// 往电脑传，前台服务保活 + 通知栏进度——退到后台、锁屏、WebView 重载都不打断。
//     这里只负责把原生任务表轮询成行（同 downloads.svelte.js 的做法）。
//   · 网页 / 桌面壳 / 拖拽整个文件夹：本模块的 JS 引擎（XHR）。
//
// JS 引擎和原生共用服务端的「按偏移写」分块协议（src/routes/file-core.mjs writePartAt/commitPart）：
//   8MB 一块、一个文件同时 3 块在途（隧道上单连接吞吐有限，实测并行快 1.6 倍以上）；
//   块重发是幂等的（同样的字节写回同一位置）→ 卡住/断线就整块重发，不会写坏；
//   进度用 XHR upload.onprogress 的字节数（不是「整块完成才跳一格」），速度取近 4 秒的滑动窗口；
//   40 秒没有任何字节进展＝卡死，掐掉重发；断网时等系统报「联网」再续，不白耗重试次数；
//   重试用尽才算失败：行留在面板里显示原因，可点「重试」从已传完的块接着传。
//
// 【Svelte 5 深代理】行对象必须先放进 $state 数组、再从数组里取出代理来改——改原始字面量界面收不到，
// 以前「进度卡 0%、传完整行消失」就是这么来的。

import { apiUrl } from './server.js';
import { authHeaders } from './api.js';
import { t, tr } from './i18n.js';

// bridge 本体的 app 在局域网直连与隧道之间切线路（tunnelAlt / noteNetFail）；Muse 只有一条线路，这两个是空操作。
const noteNetFail = () => {};
const tunnelAlt = () => null;

const CHUNK = 8 * 1024 * 1024;
const PAR = 3;            // 一个文件同时在途的块数
const FILE_SLOTS = 2;     // 同时传几个文件/文件夹任务，其余排队
const TREE_PAR = 3;       // 文件夹任务里同时传几个文件
const STALL_MS = 40000;
// 请求体已经全部交出去之后，等回执的耐心按块大小给：慢线路上（Muse 的隧道约 0.7 MB/s，3 块并行各分到更少）浏览器早把字节
// 交给了本机网络栈 / 代理，进度事件就停了，服务端却还在一点点收——按 40 秒判卡死会把每一块都掐掉重发、永远传不完。
const RESP_MIN_BPS = 32 * 1024;
const MAX_TRIES = 10;     // 每块/每次 commit 最多连续失败几次（断网等待不计）

/** list：JS 引擎的行；native：手机原生任务的行（每次轮询整体替换）。
    行：{ id, name, kind, status:'up'|'done'|'error'|'cancelled', note:''|'queued'|'retry', sent, total, bps, error, at, up:true, native, retry } */
export const uploads = $state({ list: [], native: [] });

function toast(text, kind) { import('./toast.svelte.js').then((m) => m.showToast(text, kind)).catch(() => {}); }

// —— 上传完成的订阅（工作空间据此刷新当前目录）——
const listeners = new Set();
/** cb({ ws, dirs }) —— 有文件传进了 ws 根下的这些目录。返回取消订阅函数。 */
export function onUploaded(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emitUploaded(ws, dirs) { for (const cb of listeners) { try { cb({ ws: ws || '', dirs }); } catch {} } }

const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const enc = encodeURIComponent;
const basePath = (dir, ws, mk) => `/api/files/upload?path=${enc(dir || '')}${mk ? '&mk=1' : ''}${ws ? '&ws=' + enc(ws) : ''}`;

// ============================ JS 引擎 ============================

const jobs = new Map();   // 行 id → job
let slotsBusy = 0;
const slotWaiters = [];
function takeSlot(job) {
  if (slotsBusy < FILE_SLOTS) { slotsBusy++; return Promise.resolve(); }
  job.row.note = 'queued';
  return new Promise((res) => slotWaiters.push(res));
}
function freeSlot() {
  const next = slotWaiters.shift();
  if (next) next(); else slotsBusy = Math.max(0, slotsBusy - 1);
}

const abortedErr = () => Object.assign(new Error('aborted'), { aborted: true });
const retryable = (msg) => Object.assign(new Error(msg), { retry: true });
// 几路并行里先到的那个错误可能只是被连带掐断的 abort：保留真正的原因
const pickErr = (cur, e) => (!cur || (cur.aborted && !e.aborted) ? e : cur);

// 全局在途请求闸：局域网直连是 HTTP/1.1（每主机 6 条连接，还被 SSE 占着一两条），请求排在浏览器
// 队列里时没有任何进度事件，会被误判成「卡死」。所以先在这里排队，拿到名额才开始计卡死时间。
const NET_MAX = 4;
let netBusy = 0;
const netWaiters = [];
function netAcquire() {
  if (netBusy < NET_MAX) { netBusy++; return Promise.resolve(); }
  return new Promise((res) => netWaiters.push(res));
}
function netRelease() {
  const next = netWaiters.shift();
  if (next) next(); else netBusy = Math.max(0, netBusy - 1);
}

/** 发一个请求（块或 commit）。onProg(loaded) 报本请求已发出的字节。fsx：属于哪个文件（文件级失败时只掐它的请求）。 */
async function send(job, fsx, pathq, body, onProg) {
  await netAcquire();
  return new Promise((resolve, reject) => {
    if (job.halt) { netRelease(); return reject(abortedErr()); }
    const xhr = new XMLHttpRequest();
    let lastAct = Date.now(), settled = false;
    const size = body && typeof body.size === 'number' ? body.size : 0;
    let bodyDone = !size;   // 没有请求体（commit / probe）就直接是「等回执」
    const patience = () => (bodyDone ? Math.max(STALL_MS, (size / RESP_MIN_BPS) * 1000) : STALL_MS);
    const finish = (fn, v) => {
      if (settled) return;
      settled = true; clearInterval(dog); job.xhrs.delete(xhr); fsx?.xhrs.delete(xhr); netRelease(); fn(v);
    };
    const dog = setInterval(() => {
      if (Date.now() - lastAct < patience()) return;
      finish(reject, retryable('stalled'));
      try { xhr.abort(); } catch {}
    }, 5000);
    job.xhrs.add(xhr); fsx?.xhrs.add(xhr);
    xhr.open('POST', apiUrl(pathq));
    const h = authHeaders(); for (const k in h) xhr.setRequestHeader(k, h[k]);
    if (xhr.upload) {
      xhr.upload.onprogress = (e) => { lastAct = Date.now(); if (size && e.loaded >= size) bodyDone = true; if (onProg) onProg(e.loaded); };
      xhr.upload.onload = () => { lastAct = Date.now(); bodyDone = true; };
    }
    xhr.onprogress = () => { lastAct = Date.now(); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = xhr.responseText || null; }
      const s = xhr.status;
      if (s >= 200 && s < 300) return finish(resolve, data || {});
      const e = new Error('HTTP ' + s);
      e.status = s; e.body = data;
      e.retry = s === 0 || s >= 500 || s === 408 || s === 429;
      if (s === 0) noteNetFail();
      finish(reject, e);
    };
    xhr.onerror = () => { noteNetFail(); finish(reject, retryable('network')); };
    xhr.onabort = () => finish(reject, abortedErr());
    try { xhr.send(body); } catch (e) { finish(reject, retryable(e?.message || 'send')); }
  });
}

function waitOnline(job) {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { window.removeEventListener('online', done); clearInterval(poll); res(); };
    const poll = setInterval(() => { if (job.halt || navigator.onLine !== false) done(); }, 2000);
    window.addEventListener('online', done);
  });
}

// probe：连接层失败（没拿到状态码）后发一个不带请求体的探针。服务端若早就回了 4xx（没权限、目录没了），
// 大请求体还没发完连接就会被中间层掐断，客户端只看到「重置」——探针能把真正的状态码拿回来，
// 直接判失败，而不是当断网空转十次。
async function withRetry(job, fn, probe) {
  for (let i = 0; ; i++) {
    if (job.halt) throw abortedErr();
    try {
      const r = await fn();
      if (job.row.note === 'retry') job.row.note = '';
      return r;
    } catch (e) {
      if (job.halt || e.aborted) throw abortedErr();
      if (e.retry && !e.status && probe) {
        try { await probe(); } catch (pe) { if (pe.aborted || job.halt) throw abortedErr(); if (!pe.retry) throw pe; }
      }
      if (!e.retry || i + 1 >= MAX_TRIES) throw e;
      job.row.note = 'retry';
      await waitOnline(job);   // 断网：等联网再说（不计次数——手机切网络、过隧道常有几十秒空窗）
      if (job.halt) throw abortedErr();
      await new Promise((res) => setTimeout(res, Math.min(30000, 1000 * 2 ** i)));
    }
  }
}

// 一个文件的状态：acked=已确认写入的块号；inflight=块号→本次已发字节
function fileState(file, dir, name) {
  return { file, dir, name: name || file.name || 'file', id: 'up' + rid().slice(0, 20), acked: new Set(), inflight: new Map(), xhrs: new Set(), ackedBytes: 0, done: false, restarts: 0 };
}

function track(job, fsx, i, loaded) {
  const prev = fsx.inflight.get(i) || 0;
  if (loaded > prev) job.moved += loaded - prev;
  fsx.inflight.set(i, loaded);
}

async function uploadOneFile(job, fsx) {
  const size = fsx.file.size || 0;
  const q = basePath(fsx.dir, job.ws, job.mk) + '&id=' + fsx.id;
  const tail = `&size=${size}&name=${enc(fsx.name)}`;
  const probe = () => send(job, fsx, `${q}&probe=1`, null);
  if (size <= CHUNK) {
    const r = await withRetry(job, () => { fsx.inflight.set(0, 0); return send(job, fsx, `${q}&off=0&len=${size}&fin=1${tail}`, fsx.file, (l) => track(job, fsx, 0, l)); }, probe);
    fsx.inflight.clear(); fsx.ackedBytes = size; fsx.done = true;
    return r?.name || fsx.name;
  }
  const n = Math.ceil(size / CHUNK);
  for (;;) {
    let cursor = 0, failed = null;
    const next = () => { while (cursor < n && fsx.acked.has(cursor)) cursor++; return cursor < n ? cursor++ : -1; };
    const worker = async () => {
      for (let i; !failed && (i = next()) >= 0;) {
        const off = i * CHUNK, len = Math.min(CHUNK, size - off);
        try {
          await withRetry(job, () => { fsx.inflight.set(i, 0); return send(job, fsx, `${q}&off=${off}&len=${len}`, fsx.file.slice(off, off + len), (l) => track(job, fsx, i, l)); }, probe);
        } catch (e) {
          fsx.inflight.delete(i);
          const first = !failed;
          failed = pickErr(failed, e);
          if (first) for (const x of [...fsx.xhrs]) { try { x.abort(); } catch {} }   // 一块失败＝这个文件失败：它别的块也停
          return;
        }
        fsx.inflight.delete(i);
        if (!fsx.acked.has(i)) { fsx.acked.add(i); fsx.ackedBytes += len; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAR, n) }, worker));
    fsx.inflight.clear();
    if (failed) throw failed;
    try {
      const r = await withRetry(job, () => send(job, fsx, `${q}&commit=1${tail}`, null), probe);
      fsx.done = true;
      return r?.name || fsx.name;
    } catch (e) {
      // 服务端说长度对不上 / 半截文件没了（极少见：被人删了、电脑换了盘）——从头再传一遍，只兜一次
      if (e.status === 409 && fsx.restarts++ < 1) { fsx.acked.clear(); fsx.ackedBytes = 0; continue; }
      throw e;
    }
  }
}

function sentOf(job) {
  let s = 0;
  for (const f of job.files) {
    if (f.done) { s += f.file.size || 0; continue; }
    s += f.ackedBytes;
    for (const v of f.inflight.values()) s += v;
  }
  return Math.min(s, job.row.total);
}

// 进度/速度刷新：所有在跑的任务共用一个 500ms 节拍（不随每个 progress 事件改响应式状态）。
let ticker = 0;
function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const now = Date.now();
    let any = false;
    for (const job of jobs.values()) {
      if (!job.running) continue;
      any = true;
      job.samples.push([now, job.moved]);
      while (job.samples.length > 2 && now - job.samples[0][0] > 4000) job.samples.shift();
      const [t0, m0] = job.samples[0];
      job.row.bps = now > t0 ? Math.max(0, ((job.moved - m0) * 1000) / (now - t0)) : 0;
      job.row.sent = sentOf(job);
      if (job.onProgress) { try { job.onProgress(job.row.sent, job.row.total); } catch {} }
    }
    if (!any) { clearInterval(ticker); ticker = 0; }
  }, 500);
}

async function runJob(job) {
  const { row } = job;
  job.halt = false;
  row.status = 'up'; row.error = ''; row.bps = 0;
  await takeSlot(job);
  if (job.halt) { freeSlot(); return; }
  row.note = '';
  job.running = true; job.samples = [[Date.now(), job.moved]];
  ensureTicker();
  let names = [];
  try {
    const todo = job.files.filter((f) => !f.done);
    if (todo.length === 1) names.push(await uploadOneFile(job, todo[0]));
    else {
      let k = 0, failed = null;
      await Promise.all(Array.from({ length: Math.min(TREE_PAR, todo.length) }, async () => {
        while (!failed && k < todo.length) {
          const f = todo[k++];
          try { names.push(await uploadOneFile(job, f)); }
          catch (e) {
            const first = !failed;
            failed = pickErr(failed, e);
            if (first) { job.halt = true; for (const x of [...job.xhrs]) { try { x.abort(); } catch {} } }
          }
        }
      }));
      if (failed) throw failed;
    }
    row.sent = row.total; row.bps = 0; row.status = 'done'; row.note = '';
    job.resolve?.({ name: names[0] || job.files[0]?.name });
    if (!job.headless) {
      toast(job.files.length > 1 ? t('已上传 {name}（{n} 个文件）', { name: row.name, n: job.files.length }) : t('已上传 {name}', { name: names[0] || row.name }));
      emitUploaded(job.ws, job.dirs);
      jobs.delete(row.id);   // 传完不再需要重试素材（File 引用放掉）
    }
  } catch (e) {
    row.bps = 0; row.note = '';
    for (const f of job.files) f.inflight.clear();   // 没确认的块不算已传（重试会从已确认处接着来）
    if (job.cancelled) {
      row.status = 'cancelled';
      job.reject?.(abortedErr());
    } else {
      row.status = 'error';
      row.error = reasonText(e);
      job.reject?.(e);
      if (!job.headless) toast(t('上传失败：{reason}', { reason: row.error || row.name }), 'err');
    }
  } finally {
    job.running = false;
    job.row.sent = sentOf(job);
    freeSlot();
  }
}

function reasonText(e) {
  const s = e?.status;
  const b = e?.body;
  const msg = (b && typeof b === 'object' ? b.error : typeof b === 'string' ? b : '') || '';
  if (s === 401 || s === 403) return msg === 'forbidden' || !msg ? t('没有权限') : tr(msg);
  if (s === 404) return t('目标文件夹不存在');
  if (s === 413) return t('文件太大');
  if (e?.message === 'stalled') return t('网络卡住了');
  if (e?.retry) return t('网络中断');
  return tr(msg) || e?.message || '';
}

function makeJob(rawRow, files, { ws = '', mk = false, dirs, headless = false, onProgress } = {}) {
  let row;
  if (headless) row = rawRow;
  else { uploads.list.unshift(rawRow); row = uploads.list[0]; }   // 取回代理再改（见文件头）
  const job = { row, files, ws, mk, dirs: dirs || [...new Set(files.map((f) => f.dir))], headless, onProgress, xhrs: new Set(), moved: 0, samples: [], halt: false, cancelled: false, running: false };
  jobs.set(row.id, job);
  return job;
}

function newRow(name, total, kind) {
  return { id: 'u' + rid(), name, kind, status: 'up', note: '', sent: 0, total: Math.max(0, total), bps: 0, error: '', at: Date.now(), up: true, native: false, retry: true };
}

/** 上传一个文件到工作空间的 dir（相对 ws 根），面板里一行。 */
export function startUpload(file, { dir = '', ws = '', mk = false } = {}) {
  const job = makeJob(newRow(file.name, file.size || 0), [fileState(file, dir)], { ws, mk });
  runJob(job);
  return job.row.id;
}

/** 整个文件夹作为【一行】任务（几百个文件铺成几百行没法看）。items=[{ file, dir }]（dir 相对 ws 根，服务端按需建）。
    baseDir：拖放的落点目录（传完据此刷新列表）。 */
export function startTreeUpload(rootName, items, { ws = '', baseDir = '' } = {}) {
  const total = items.reduce((a, x) => a + (x.file.size || 0), 0);
  const job = makeJob(newRow(rootName, total, 'dir'), items.map((x) => fileState(x.file, x.dir)), { ws, mk: true, dirs: [baseDir] });
  runJob(job);
  return job.row.id;
}

/** 不进面板的上传（桌面版工作空间自己显示进度）：同一套分块/重试，返回 Promise<{name}>。 */
export function sendFile(file, { dir = '', ws = '', mk = false, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const job = makeJob(newRow(file.name, file.size || 0), [fileState(file, dir)], { ws, mk, headless: true, onProgress });
    job.resolve = (v) => { jobs.delete(job.row.id); resolve(v); };
    job.reject = (e) => { jobs.delete(job.row.id); reject(e); };
    runJob(job);
  });
}

// ============================ 手机原生（UploadService） ============================

const NU = () => (typeof window !== 'undefined' ? window.BridgeUpload : null);
export function hasNativeUpload() { const n = NU(); return !!(n && typeof n.pick === 'function'); }

const nSeen = new Map();   // id → 上次看到的状态（只对变化弹提示/刷新）
let nTimer = 0;
const N_STATUS = { queued: 'up', running: 'up', done: 'done', error: 'error', cancelled: 'cancelled' };

function nativeReason(e) {
  if (/^HTTP 40[13]$/.test(e)) return t('没有权限');
  if (e === 'HTTP 404') return t('目标文件夹不存在');
  if (e === 'HTTP 413') return t('文件太大');
  return tr(e);
}

function syncNative() {
  const n = NU();
  if (!n) return;
  let arr = [];
  try { arr = JSON.parse(n.list()) || []; } catch { arr = []; }
  const rows = [];
  for (const x of arr) {
    const status = N_STATUS[x.status] || 'error';
    const prev = nSeen.get(x.id);
    let ctx = {};
    try { ctx = JSON.parse(x.ctx || '{}') || {}; } catch {}
    if (prev && prev !== status) {
      if (status === 'done') { toast(t('已上传 {name}', { name: x.name })); emitUploaded(ctx.ws, [ctx.dir || '']); }
      else if (status === 'error') toast(t('上传失败：{reason}', { reason: nativeReason(x.error || '') || x.name }), 'err');
    }
    nSeen.set(x.id, status);
    rows.push({
      id: x.id, name: x.name || '', kind: undefined, status, note: x.status === 'queued' ? 'queued' : x.note || '',
      sent: Math.max(0, Number(x.sent) || 0), total: Number(x.total) > 0 ? Number(x.total) : 0, bps: Number(x.bps) || 0,
      error: status === 'error' ? nativeReason(x.error || '') : '', at: Number(x.at) || 0, up: true, native: true, retry: status === 'error',
    });
  }
  uploads.native = rows;
  clearTimeout(nTimer);
  if (rows.some((r) => r.status === 'up')) nTimer = setTimeout(syncNative, 500);
}

/** 手机 App：弹系统文件选择器（可多选），选好的文件由原生直接传进 dir。返回 false＝没有原生桥。 */
export function pickNativeUpload({ dir = '', ws = '' } = {}) {
  const n = NU();
  if (!n) return false;
  let abs;
  try { abs = new URL(apiUrl(basePath(dir, ws, false)), location.href).href; } catch { return false; }
  const urls = [abs];
  const alt = tunnelAlt(abs);   // 正走局域网直连：附上隧道地址当备用线路
  if (alt) urls.push(alt);
  try { n.pick(JSON.stringify({ urls, headers: authHeaders(), ctx: JSON.stringify({ dir, ws }) })); } catch { return false; }
  return true;
}

// ============================ 行操作（两条通路共用） ============================

export function cancelUpload(id) {
  if (uploads.native.some((r) => r.id === id)) { try { NU()?.cancel(id); } catch {} syncNative(); return; }
  const job = jobs.get(id);
  if (!job || job.row.status !== 'up') return;
  job.cancelled = true; job.halt = true;
  job.row.status = 'cancelled'; job.row.bps = 0; job.row.note = '';
  for (const x of [...job.xhrs]) { try { x.abort(); } catch {} }
  // 顺手让服务端删掉半截文件（不等也不管成败）
  for (const f of job.files) if (!f.done && (f.ackedBytes || f.inflight.size)) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl(basePath(f.dir, job.ws, false) + '&id=' + f.id + '&abort=1'));
      const h = authHeaders(); for (const k in h) xhr.setRequestHeader(k, h[k]);
      xhr.send();
    } catch {}
  }
  const rowId = id;
  setTimeout(() => { jobs.delete(rowId); uploads.list = uploads.list.filter((r) => r.id !== rowId); }, 2500);
}

/** 失败的上传接着传（已确认的块不重发）。 */
export function retryUpload(id) {
  if (uploads.native.some((r) => r.id === id)) { try { NU()?.retry(id); } catch {} syncNative(); return true; }
  const job = jobs.get(id);
  if (!job || job.running || job.row.status !== 'error') return false;
  job.cancelled = false;
  runJob(job);
  return true;
}

/** 清掉已结束的上传行。 */
export function clearFinishedUploads() {
  for (const r of uploads.list) if (r.status !== 'up') jobs.delete(r.id);
  uploads.list = uploads.list.filter((r) => r.status === 'up');
  const n = NU();
  if (n) { for (const r of uploads.native) if (r.status !== 'up') { try { n.forget(r.id); } catch {} nSeen.delete(r.id); } syncNative(); }
}

if (typeof window !== 'undefined' && hasNativeUpload()) {
  window.__bridgeUpKick = syncNative;   // 原生在任务开始/结束时叫醒
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNative(); });
  syncNative();
}
