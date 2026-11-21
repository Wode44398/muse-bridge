// Antigravity 会话全文搜索：按 agy 自己写的文字记录增量建索引。
//
// 正文来源：<agy 数据目录>/brain/<会话 id>/.system_generated/logs/transcript.jsonl（桌面版建的会话在桌面版数据目录）。
// 每行一个 JSON：只收用户说的话（type USER_INPUT，正文在 <USER_REQUEST> 里，后面跟着的 <ADDITIONAL_METADATA> 等系统块剥掉）
// 与助手的回答（type PLANNER_RESPONSE 且带 content；只有 thinking / tool_calls 的是中间步骤）；SYSTEM_MESSAGE、GENERIC 不收。
//
// 索引一个会话一条：{ size, mtime, off, text, marks }，marks 是每条消息的 [起点, 时间戳, 是否用户] 三元组——
// 与 Claude 搜索（runtime/session-search.mjs）同一个形状，所以直接用它的 normQuery / findInEntry 找命中和截片段。
// 文件只追加：变长从 off 接着读，变短整条重建；按 1MB 分块读、块间让出事件循环，超长行（工具输出、图片）跳过。
// 索引落盘 <ctx.agyDir>/search-index.json（防抖写）。查询有时间预算：没建好的这次跳过、后台接着建，
// 返回带 indexing:true，前端过一会儿再问一次就全了。
//
// 索引按身份各一份（内存里的条目、落盘文件、去哪几个数据目录找文字记录都分开）：注册用户有自己的 agy 进程与数据目录，
// 混在一起的话，管理员对话的正文会被写进用户文件夹里的索引文件。

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { normQuery, findInEntry } from '@bridge/core/runtime/session-search.mjs';
import { agyDataDirsOf } from './acp/index.mjs';
import { isAgySessionId } from './purge-files.mjs';
import { listAgySessions } from './sessions.mjs';

const INDEX_V = 1;
const CHUNK = 1 << 20;
const MAX_LINE = 4 << 20;
const MAX_TEXT = 4 << 20;
const SAVE_DELAY = 15_000;
const HEAD_BYTES = 512;

// 一个身份一份：键是它的索引文件路径
const scopes = new Map();
let lastScope = null;          // 最近用到的那份（单测的查看函数用）
const newScope = (file, dirs) => ({
  file, dirs,
  entries: new Map(),          // sessionId -> entry
  inflight: new Map(),         // sessionId -> Promise
  warmQueue: new Map(),
  warming: null,
  loaded: false, loading: null, dirty: false, timer: null,
});
function scopeOf(ctx) {
  const file = ctx?.agyDir ? path.join(ctx.agyDir, 'search-index.json') : '';
  let sc = scopes.get(file);
  if (!sc) { sc = newScope(file, agyDataDirsOf(ctx)); scopes.set(file, sc); }
  lastScope = sc;
  return sc;
}

const newEntry = () => ({ size: 0, mtime: 0, off: 0, text: '', marks: [], trunc: false, lower: null });
const tick = () => new Promise((r) => setImmediate(r));

export function transcriptPaths(sessionId, dirs = []) {
  if (!isAgySessionId(sessionId)) return [];
  const rel = ['brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'];
  return dirs.map((d) => path.join(d, ...rel));
}

// 用户输入里真正是人说的那段：<USER_REQUEST> 里面；没有这个标签就把成对的大写系统块整个剥掉
export function userRequestText(raw) {
  const s = String(raw || '');
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(s);
  if (m) return m[1];
  return s.replace(/<([A-Z][A-Z0-9_]*)>[\s\S]*?<\/\1>/g, '');
}

/** transcript 的一行（已解析）→ { user, text, at } 或 null（不收的行）。 */
export function transcriptMessage(o) {
  if (!o || typeof o !== 'object') return null;
  let text = '';
  let user = false;
  if (o.type === 'USER_INPUT') {
    if (o.source && o.source !== 'USER_EXPLICIT') return null;
    text = userRequestText(o.content);
    user = true;
  } else if (o.type === 'PLANNER_RESPONSE') {
    if (typeof o.content !== 'string') return null;
    text = o.content;
  } else {
    return null;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return { user, text, at: Date.parse(o.created_at) || 0 };
}

export function takeTranscriptLine(e, buf) {
  const head = buf.length > HEAD_BYTES ? buf.subarray(0, HEAD_BYTES) : buf;
  if (head.indexOf('"type":"USER_INPUT"') < 0 && head.indexOf('"type":"PLANNER_RESPONSE"') < 0) return;
  let o;
  try { o = JSON.parse(buf.toString('utf8')); } catch { return; }
  const m = transcriptMessage(o);
  if (!m) return;
  if (e.text.length + m.text.length + 1 > MAX_TEXT) { e.trunc = true; return; }
  if (e.text) e.text += '\n';
  e.marks.push(e.text.length, m.at, m.user ? 1 : 0);
  e.text += m.text;
  e.lower = null;
}

async function indexOne(sc, sid, file, st) {
  let e = sc.entries.get(sid);
  if (e && e.file === file && e.size === st.size && e.mtime === st.mtime) return e;
  if (!e || e.file !== file || st.size < e.off) { e = { ...newEntry(), file }; sc.entries.set(sid, e); }
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = null;
    let skipping = false;
    let pos = e.off;
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (!bytesRead) break;
      const chunkStart = pos;
      pos += bytesRead;
      let chunk = buf.subarray(0, bytesRead);
      let start = 0;
      let base = chunkStart;
      if (skipping) {
        const nl = chunk.indexOf(10);
        if (nl < 0) { e.off = pos; await tick(); continue; }
        skipping = false;
        start = nl + 1;
      } else if (carry) {
        base = chunkStart - carry.length;
        chunk = Buffer.concat([carry, chunk]);
        carry = null;
      }
      let nl;
      while ((nl = chunk.indexOf(10, start)) >= 0) {
        takeTranscriptLine(e, chunk.subarray(start, nl));
        start = nl + 1;
      }
      e.off = base + start;
      const rest = chunk.length - start;
      if (rest > MAX_LINE) { skipping = true; e.off = pos; }
      else if (rest) carry = Buffer.from(chunk.subarray(start));
      await tick();
    }
    e.size = st.size;
    e.mtime = st.mtime;
    sc.dirty = true;
    scheduleSave(sc);
  } catch {
    // 读不了（被删 / 锁）：保留已有部分，下次再试
  } finally {
    try { await fh?.close(); } catch {}
  }
  return e;
}

async function statTranscript(sc, sid) {
  for (const file of transcriptPaths(sid, sc.dirs)) {
    try {
      const st = await fsp.stat(file);
      if (st.isFile()) return { file, size: st.size, mtime: Math.round(st.mtimeMs) };
    } catch {}
  }
  return null;
}

const fresh = (e, f) => !!(e && f && e.file === f.file && e.size === f.size && e.mtime === f.mtime);

function ensureIndexed(sc, sid, f) {
  const e = sc.entries.get(sid);
  if (fresh(e, f)) return Promise.resolve(e);
  if (sc.inflight.has(sid)) return sc.inflight.get(sid);
  const p = indexOne(sc, sid, f.file, f).finally(() => sc.inflight.delete(sid));
  sc.inflight.set(sid, p);
  return p;
}

// —— 后台建：挨个来，不并发，别和前台抢盘 ——
function warmIndex(sc, items) {
  for (const it of items) sc.warmQueue.set(it.sid, it);
  if (sc.warming) return sc.warming;
  sc.warming = (async () => {
    while (sc.warmQueue.size) {
      const [k, it] = sc.warmQueue.entries().next().value;
      sc.warmQueue.delete(k);
      try {
        const f = it.f || await statTranscript(sc, it.sid);
        if (f) await ensureIndexed(sc, it.sid, f);
      } catch {}
    }
  })().finally(() => { sc.warming = null; });
  return sc.warming;
}
/** 等所有身份的后台建索引都告一段落（测试用） */
export const indexWarming = () => Promise.all([...scopes.values()].map((sc) => sc.warming).filter(Boolean));

// —— 落盘 ——
async function loadStore(sc) {
  if (sc.loaded || !sc.file) return;
  if (sc.loading) return sc.loading;
  sc.loading = (async () => {
    try {
      const j = JSON.parse(await fsp.readFile(sc.file, 'utf8'));
      if (j && j.v === INDEX_V && j.sessions && typeof j.sessions === 'object') {
        for (const [sid, d] of Object.entries(j.sessions)) {
          if (sc.entries.has(sid) || !isAgySessionId(sid) || !d || typeof d.text !== 'string') continue;
          sc.entries.set(sid, { ...newEntry(), ...d, marks: Array.isArray(d.marks) ? d.marks : [], lower: null });
        }
      }
    } catch {}
    sc.loaded = true;
  })();
  return sc.loading;
}

function scheduleSave(sc) {
  if (!sc.file || sc.timer) return;
  sc.timer = setTimeout(() => { sc.timer = null; saveScope(sc).catch(() => {}); }, SAVE_DELAY);
  sc.timer.unref?.();
}

async function saveScope(sc) {
  if (!sc.file || !sc.dirty) return;
  sc.dirty = false;
  const sessions = {};
  for (const [sid, e] of sc.entries) {
    sessions[sid] = { file: e.file, size: e.size, mtime: e.mtime, off: e.off, text: e.text, marks: e.marks, trunc: e.trunc || undefined };
  }
  try {
    await fsp.mkdir(path.dirname(sc.file), { recursive: true });
    const tmp = sc.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ v: INDEX_V, sessions }));
    await fsp.rename(tmp, sc.file);
  } catch {}
}

/** 把各身份还没落盘的索引都写下去（测试、退出前用） */
export async function saveAgySearchStore() {
  await Promise.all([...scopes.values()].map((sc) => saveScope(sc)));
}

/** 彻底删除会话时把它的索引条目一并去掉（下次落盘就没了）。ctx = 这个会话归谁。 */
export function forgetAgySearchEntry(ctx, sid) {
  const sc = scopeOf(ctx);
  sc.warmQueue.delete(sid);
  if (sc.entries.delete(sid)) {
    sc.dirty = true;
    scheduleSave(sc);
  }
}

function hitOf(s, match, extra = {}) {
  return {
    sessionId: s.sessionId,
    title: s.title || '',
    cwd: s.cwd || '',
    projectName: s.projectName || '',
    updatedAt: s.updatedAt || '',
    ...(s.hidden ? { hidden: true } : {}),
    match,
    ...extra,
  };
}

/**
 * 在会话列表（已排除已删除；默认也排除已隐藏）里搜：标题命中在前、正文命中在后，各自按最近活动、各自截到 limit。
 * 正文命中带 { snippet, role:'user'|'assistant', at(ISO) }。没建完索引的会话这次不算，indexing:true。
 * sessions 可直接传入（测试 / 已拿到列表的调用方），不传就现取。
 */
export async function searchAgySessions(ctx, query, { limit = 20, includeHidden = false, onlyHidden = false, budgetMs = 1500, sessions = null } = {}) {
  const t0 = Date.now();
  const q = normQuery(query);
  limit = Math.max(1, Math.min(100, Number(limit) || 20));
  const sc = scopeOf(ctx);
  await loadStore(sc);
  let pool = sessions;
  if (!Array.isArray(pool)) {
    const res = await listAgySessions(ctx, { includeHidden: includeHidden || onlyHidden });
    pool = res.sessions || [];
  }
  if (onlyHidden) pool = pool.filter((s) => s.hidden);
  else if (!includeHidden) pool = pool.filter((s) => !s.hidden);
  pool = [...pool].sort((a, b) => (Number(b.updatedMs) || 0) - (Number(a.updatedMs) || 0));
  if (!q) return { q, hits: [], indexing: !!sc.warming, total: pool.length, ms: Date.now() - t0 };

  const titleHits = [];
  const taken = new Set();
  for (const s of pool) {
    if (normQuery(s.title).includes(q)) {
      if (titleHits.length < limit) titleHits.push(hitOf(s, 'title'));
      taken.add(s.sessionId);
    }
  }

  const textHits = [];
  let indexing = false;
  if (q.length >= 2) {
    // budgetMs=0：一个都不现建，全交给后台（测试与「先给已有的」场景）
    const deadline = t0 + Math.max(0, budgetMs);
    const later = [];
    let slice = performance.now();
    for (const s of pool) {
      if (textHits.length >= limit) break;
      if (taken.has(s.sessionId) || !isAgySessionId(s.sessionId)) continue;
      const f = await statTranscript(sc, s.sessionId);
      if (!f) continue;
      let e = sc.entries.get(s.sessionId);
      if (!fresh(e, f)) {
        if (Date.now() >= deadline) { indexing = true; later.push({ sid: s.sessionId, f }); continue; }
        e = await ensureIndexed(sc, s.sessionId, f);
        slice = performance.now();
      } else if (performance.now() - slice > 12) {
        await tick();
        slice = performance.now();
      }
      const m = findInEntry(e, q);
      if (m) {
        textHits.push(hitOf(s, 'text', {
          snippet: m.snippet,
          role: m.role,
          ...(m.matchAt ? { at: new Date(m.matchAt).toISOString() } : {}),
        }));
      }
    }
    if (later.length) warmIndex(sc, later);
  }
  return {
    q,
    hits: [...titleHits, ...textHits],
    indexing: indexing || !!sc.warming,
    total: pool.length,
    ms: Date.now() - t0,
  };
}

// 单测用
export function _resetAgySearch() {
  for (const sc of scopes.values()) { if (sc.timer) clearTimeout(sc.timer); }
  scopes.clear();
  lastScope = null;
}
export const _agySearchEntry = (sid) => lastScope?.entries.get(sid);
