// 媒体本地缓存（IndexedDB blob）—— 像微信缓存视频：同一媒体看过一次后再看直接放本地 blob，
// 秒开、拖进度丝滑、不再过隧道。视频/音频用；图片靠 HTTP immutable 缓存不进这里。
//
// 策略：
//   · 命中缓存 → 返回 objectURL（本地 blob，原生 Range seek 全在内存/磁盘，最丝滑）。
//   · 未命中 → 返回流式 URL 立即可播（不阻塞），后台 Range 探大小，≤ 单文件上限就整段抓下缓存；
//     下次即命中。大文件（超上限）不缓存，永远走流式（B6 本地文件另由原生流式兜底）。
//   · 总量超上限按 LRU（atime）淘汰。两 store 分离：blobs 只存字节、idx 存 {size,atime} 轻量，
//     淘汰只读 idx 不反序列化 blob。
//
// 所有 API 失败都安全降级（返回流式 URL / 静默不缓存），绝不因缓存问题影响播放。

const DB_NAME = 'bridge-media-cache';
const DB_VER = 1;
const S_BLOB = 'blobs';   // key -> Blob
const S_IDX = 'idx';      // key -> { size, atime }
const MAX_FILE = 80 * 1024 * 1024;    // 单文件上限 80MB
const MAX_TOTAL = 600 * 1024 * 1024;  // 总量上限 600MB

let _db = null, _opening = null;
function openDB() {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;
  _opening = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(S_BLOB)) db.createObjectStore(S_BLOB);
      if (!db.objectStoreNames.contains(S_IDX)) db.createObjectStore(S_IDX);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  }).catch((e) => { _opening = null; throw e; });
  return _opening;
}

const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
const reqVal = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// 取缓存 blob（命中则刷新 atime 做 LRU）。任何异常 → null。
export async function getBlob(key) {
  if (!key) return null;
  try {
    const db = await openDB();
    const blob = await reqVal(db.transaction(S_BLOB, 'readonly').objectStore(S_BLOB).get(key));
    if (!blob) return null;
    // 刷新 atime（fire-and-forget，不阻塞返回）
    try {
      const tx = db.transaction(S_IDX, 'readwrite');
      tx.objectStore(S_IDX).put({ size: blob.size, atime: Date.now() }, key);
    } catch {}
    return blob;
  } catch { return null; }
}

export async function hasBlob(key) {
  if (!key) return false;
  try {
    const db = await openDB();
    const v = await reqVal(db.transaction(S_IDX, 'readonly').objectStore(S_IDX).get(key));
    return !!v;
  } catch { return false; }
}

async function evictIfNeeded(db) {
  try {
    const idxStore = db.transaction(S_IDX, 'readonly').objectStore(S_IDX);
    const keys = await reqVal(idxStore.getAllKeys());
    const vals = await reqVal(idxStore.getAll());
    let total = vals.reduce((s, v) => s + (v?.size || 0), 0);
    if (total <= MAX_TOTAL) return;
    const rows = keys.map((k, i) => ({ key: k, size: vals[i]?.size || 0, atime: vals[i]?.atime || 0 }))
      .sort((a, b) => a.atime - b.atime);   // 最旧在前
    const tx = db.transaction([S_BLOB, S_IDX], 'readwrite');
    for (const r of rows) {
      if (total <= MAX_TOTAL) break;
      tx.objectStore(S_BLOB).delete(r.key);
      tx.objectStore(S_IDX).delete(r.key);
      total -= r.size;
    }
    await txDone(tx);
  } catch {}
}

export async function putBlob(key, blob) {
  if (!key || !blob || blob.size > MAX_FILE) return false;
  try {
    const db = await openDB();
    const tx = db.transaction([S_BLOB, S_IDX], 'readwrite');
    tx.objectStore(S_BLOB).put(blob, key);
    tx.objectStore(S_IDX).put({ size: blob.size, atime: Date.now() }, key);
    await txDone(tx);
    evictIfNeeded(db);   // fire-and-forget
    return true;
  } catch { return false; }
}

// 后台缓存：先 Range 探总大小（bytes=0-1 → Content-Range），≤ 上限才整段抓下落库。
// 同一 key 并发去重。fetchInit 让调用方带上鉴权（authHeaders）。
const _inflight = new Set();
export async function cacheInBackground(key, url, fetchInit = {}) {
  if (!key || !url || _inflight.has(key)) return;
  if (await hasBlob(key)) return;
  _inflight.add(key);
  try {
    // 探大小
    let total = 0;
    try {
      const probe = await fetch(url, { ...fetchInit, headers: { ...(fetchInit.headers || {}), Range: 'bytes=0-1' } });
      const cr = probe.headers.get('Content-Range');
      const m = cr && /\/(\d+)\s*$/.exec(cr);
      if (m) total = parseInt(m[1], 10);
      else { const cl = probe.headers.get('Content-Length'); if (cl && !cr) total = parseInt(cl, 10); }
      try { probe.body?.cancel?.(); } catch {}
    } catch {}
    if (total && total > MAX_FILE) return;   // 太大，不缓存
    const res = await fetch(url, fetchInit);
    if (!res.ok && res.status !== 206) return;
    const blob = await res.blob();
    if (blob.size <= MAX_FILE) await putBlob(key, blob);
  } catch {} finally { _inflight.delete(key); }
}

// 播放器一句话拿源：命中→{src:objectURL, revoke, cached:true}；未命中→{src:url, revoke:noop, cached:false}
// 并在未命中时触发后台缓存（下次即命中）。
export async function resolveSrc(key, url, fetchInit = {}) {
  if (key) {
    const blob = await getBlob(key);
    if (blob) {
      const obj = URL.createObjectURL(blob);
      return { src: obj, cached: true, revoke: () => { try { URL.revokeObjectURL(obj); } catch {} } };
    }
    cacheInBackground(key, url, fetchInit);   // fire-and-forget
  }
  return { src: url, cached: false, revoke: () => {} };
}
