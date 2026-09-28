// 本地聊天缓存（IndexedDB）——连不上服务器时也能浏览历史聊天。
//
// 写入：在线成功拿到会话列表 / 单会话消息 / 一轮对话结束时，把快照写进 IndexedDB。
// 读出：① 离线（fetch 失败）时从缓存取，UI 照常渲染（只读）；
//      ② 在线也【缓存优先】：列表/会话先用本地快照秒出，网络返回有变化再替换
//        （stale-while-revalidate——网络往返不再挡在用户和内容之间）。
// 范围：文本 / 工具 / 思考 / 工作流结构都缓存；离线时图片等附件无法从服务器加载（显示占位），
//   但对话文本与结构完整。
// 存储用 IndexedDB（容量远大于 localStorage 的 ~5MB，适合多会话长对话）。

const DB = 'bridge-chat-cache';
const VER = 1;
const MESSAGE_PREFIXES = ['msg:'];
const MAX_MESSAGE_ENTRIES = 100;
const MAX_MESSAGE_BYTES = 48 * 1024 * 1024; // 每个聊天源约 48 MiB，保留最近写入的正文
let dbp = null;
let trimScheduled = false;
let writeSeq = 0;

function roughBytes(v) {
  try { return JSON.stringify(v).length * 2; } catch { return 0; }
}

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(DB, VER); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function put(k, v) {
  try {
    const db = await open();
    await new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite');
      const ts = Date.now();
      t.objectStore('kv').put({ k, v, ts, order: ts * 1000 + (writeSeq++ % 1000), bytes: roughBytes(v) });
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
    if (MESSAGE_PREFIXES.some((p) => k.startsWith(p))) scheduleMessageTrim();
  } catch {}
}

async function get(k) {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const t = db.transaction('kv', 'readonly');
      const rq = t.objectStore('kv').get(k);
      rq.onsuccess = () => res(rq.result ? rq.result.v : null);
      rq.onerror = () => rej(rq.error);
    });
  } catch { return null; }
}

// 带写入时间的读法：预取器拿 ts 对比服务端 mtime——缓存不旧于服务端就不重拉，省隧道往返。
async function getMeta(k) {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const t = db.transaction('kv', 'readonly');
      const rq = t.objectStore('kv').get(k);
      rq.onsuccess = () => res(rq.result ? { v: rq.result.v, ts: rq.result.ts || 0 } : null);
      rq.onerror = () => rej(rq.error);
    });
  } catch { return null; }
}

async function remove(k) {
  try {
    const db = await open();
    await new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').delete(k);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  } catch {}
}

// 正文缓存按最近写入做双上限淘汰：数量防“小会话海”，字节预算防少数 data URL /
// 超长会话把 WebView 配额吃光。每个前缀至少保留最新一条；只删本地副本，不碰服务端历史。
async function trimMessageCache() {
  try {
    const db = await open();
    await new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite');
      const store = t.objectStore('kv');
      const rows = [];
      const rq = store.openCursor();
      rq.onsuccess = () => {
        const cur = rq.result;
        if (cur) {
          const row = cur.value;
          if (MESSAGE_PREFIXES.some((p) => String(row?.k || '').startsWith(p))) rows.push(row);
          cur.continue();
          return;
        }
        for (const prefix of MESSAGE_PREFIXES) {
          const scoped = rows
            .filter((x) => String(x.k).startsWith(prefix))
            .sort((a, b) => (b.order || b.ts || 0) - (a.order || a.ts || 0));
          let kept = 0;
          let bytes = 0;
          for (const row of scoped) {
            const size = Number(row.bytes) || roughBytes(row.v);
            const keep = kept === 0 || (kept < MAX_MESSAGE_ENTRIES && bytes + size <= MAX_MESSAGE_BYTES);
            if (keep) { kept++; bytes += size; }
            else store.delete(row.k);
          }
        }
      };
      rq.onerror = () => rej(rq.error);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  } catch {}
}

function scheduleMessageTrim() {
  if (trimScheduled) return;
  trimScheduled = true;
  const run = () => { trimScheduled = false; trimMessageCache(); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 15000 });
  else setTimeout(run, 3000);
}

// 深快照：剥离 Svelte 5 的响应式 proxy 与函数，存进 IndexedDB（structured clone 不接受 proxy）。
const snap = (x) => { try { return JSON.parse(JSON.stringify(x)); } catch { return x; } };

// —— 会话列表（Claude）——
export const cacheSessions = (list) => put('sessions', snap(list));
export const getCachedSessions = () => get('sessions');

// —— 单会话消息（Claude，chat.messages 渲染态快照）——
export const cacheMessages = (id, messages) => put('msg:' + id, snap(messages));
export const getCachedMessages = (id) => get('msg:' + id);
export const getCachedMessagesMeta = (id) => getMeta('msg:' + id);
export const removeCachedMessages = (id) => remove('msg:' + id);

// 启动即预热 DB 连接：手机浏览器冷启的 indexedDB.open 可到几百 ms，提前开好，
// 首次「拉抽屉读缓存」不吃这笔开销。模块顶层跑一次，失败静默（open 内部已 try）。
try { open(); } catch {}
scheduleMessageTrim();
