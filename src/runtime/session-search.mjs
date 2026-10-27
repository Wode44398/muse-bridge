// Claude 会话全文搜索（2026-10-20，对齐官方 Claude Desktop 的「搜索会话」）。
//
// 官方是无索引蛮力流式扫（worker 里逐行解析 jsonl、命中即停、最多 200+200 个会话、正文含工具输出）。
// bridge 换成【增量正文索引】：本机实测 transcript 1.9GB 里 user/assistant 正文只占 0.4%（≈8–15MB），
// 带工具输出要 ≈110MB——所以只索引用户 / 助手说的话，不收工具输出、思考、系统注入（system-reminder、
// 任务通知、斜杠命令展开、附件注入段、isMeta / 侧链 / 压缩摘要）。手机上打一个字就能出结果。
//
// 索引按文件：{ size, mtime, off(已消化到的字节), text(正文，消息间 '\n'、消息内空白折叠), marks(每条消息
// [起点, 时间戳, 是否用户] 三元组), ct/at(顺手记下的 custom-title / ai-title) }。jsonl 只追加：文件变长只从
// off 读新增字节；变短（被改写）整条重建。读的时候按 1MB 分块、块间让出事件循环，单条超大行（图片 base64）
// 超过 4MB 直接跳过不拼接。索引落盘 DATA_ROOT/claude-search-index.json（防抖写），重启不必重扫。
//
// 查询（官方三层，各层分开截断、互不挤占）：
//   ① 标题（含 library 自定义名）与曾用名（match 'title' / 'former'）
//   ② 宽松（'loose'）：多个词各自出现在标题 / 项目名 / 分支里；单个词只看分支名——项目名单词命中会把整个项目
//      的会话全拖进来（维护者的项目就叫 bridge build / claude-bridge，搜「bridge」能占满名额）。最多 LOOSE_MAX 条，
//      正文也命中的归正文层（带片段）
//   ③ 正文（'text'）：空白折叠后小写子串，每个会话只取第一处；片段 = 命中前 20 字 + 命中 + 后 80 字，不跨消息。
// 前端按层分组、每层先显示前 5 条（官方面板同款），已归档的另收一组。
// 正文层有时间预算：冷启动没建完的文件这次跳过（partial:true），后台接着建，下一次就全了。
import path from 'node:path';
import { promises as fsp, readFileSync } from 'node:fs';
import { listSessionFilesAsync } from './session-list.mjs';
import { resolveTitles } from './session-titles.mjs';
import { archiveView } from './session-archive-auto.mjs';
import { familyMaps } from './session-family.mjs';
import { lineageFor } from './desktop-lineage.mjs';
import { getLibrary } from './session-library.mjs';

const INDEX_V = 1;
const CHUNK = 1 << 20;
const MAX_LINE = 4 << 20;      // 单行超过这个（多半是图片 base64）不进索引
const MAX_TEXT = 8 << 20;      // 单个会话正文上限（字符）
const SNIP_BEFORE = 20, SNIP_AFTER = 80;
const SAVE_DELAY = 20_000;

const entries = new Map();     // file -> entry
const inflight = new Map();    // file -> Promise（同一文件不并发建）
let store = { file: null, loaded: false, loading: null, dirty: false, timer: null };

// 注入块：与 routes/sessions.mjs 的 INJECTED_TEXT_RE 同一口径（另认 ci-monitor-event）——那份不导出、也不该被这里牵动
const INJECTED_RE = /^\s*<(?:(?:task|agent|bash)-notification|command-name|command-message|command-args|local-command-|system-reminder|ci-monitor-event)/;
const ATT_MARK = '[用户上传了以下附件';
function cleanUser(s) {
  let t = String(s);
  const mi = t.indexOf(ATT_MARK);
  if (mi >= 0) t = t.slice(0, mi);
  return t.replace(/<session-hint>[\s\S]*?<\/session-hint>/g, '')
    .replace(/<side-sessions-event>[\s\S]*?<\/side-sessions-event>/g, '')
    .replace(/<session-message\b[^>]*>([\s\S]*?)<\/session-message>/g, '$1');
}
function contentText(content, user) {
  if (typeof content === 'string') return INJECTED_RE.test(content) ? '' : (user ? cleanUser(content) : content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string' && !INJECTED_RE.test(b.text)) parts.push(user ? cleanUser(b.text) : b.text);
  }
  return parts.join(' ');
}

const newEntry = () => ({ size: 0, mtime: 0, off: 0, text: '', marks: [], ct: undefined, at: undefined, trunc: false, lower: null });

// 一行 jsonl（Buffer，不含换行）→ 写进 entry。只看行首 2KB 按字节预筛，绝大多数行（附件清单、工具调用 /
// 结果、思考签名、图片）不解码不解析：CLI 写的行里 message.role 与第一个内容块的类型都在行首附近
//（assistant 行的顶层 "type" 反而在整段 message 之后，不能拿它筛）；助手每个内容块单独一行。
const HEAD_BYTES = 2048;
const CONTENT_MARK = '"content":[{';
export function takeLine(e, buf) {
  const head = buf.length > HEAD_BYTES ? buf.subarray(0, HEAD_BYTES) : buf;
  const isTitle = head.indexOf('"type":"custom-title"') >= 0 || head.indexOf('"type":"ai-title"') >= 0;
  const asst = !isTitle && head.indexOf('"role":"assistant"') >= 0;
  const user = !isTitle && !asst && head.indexOf('"role":"user"') >= 0;
  if (!isTitle && !asst && !user) return;
  if (!isTitle) {
    const ci = head.indexOf(CONTENT_MARK);
    if (ci >= 0) {
      const first = head.subarray(ci + CONTENT_MARK.length, ci + CONTENT_MARK.length + 24).toString('latin1');
      if (asst && !first.startsWith('"type":"text"')) return;                                         // 思考 / 工具调用
      if (user && (first.startsWith('"tool_use_id"') || first.startsWith('"type":"tool_result"'))) return;   // 工具结果
    }
  }
  let o; try { o = JSON.parse(buf.toString('utf8')); } catch { return; }
  if (!o || typeof o !== 'object') return;
  if (o.type === 'custom-title') { if (typeof o.customTitle === 'string') e.ct = o.customTitle; return; }
  if (o.type === 'ai-title') { if (typeof o.aiTitle === 'string') e.at = o.aiTitle; return; }
  if (o.type !== 'user' && o.type !== 'assistant') return;
  if (o.isMeta || o.isSidechain || o.isCompactSummary || o.isVisibleInTranscriptOnly) return;
  const s = contentText(o.message && o.message.content, o.type === 'user').replace(/\s+/g, ' ').trim();
  if (!s) return;
  if (e.text.length + s.length + 1 > MAX_TEXT) { e.trunc = true; return; }
  if (e.text) e.text += '\n';
  e.marks.push(e.text.length, Date.parse(o.timestamp) || 0, o.type === 'user' ? 1 : 0);
  e.text += s;
  e.lower = null;
}

const tick = () => new Promise((r) => setImmediate(r));

// 把一个文件的新增部分读进索引。st = { size, mtime }。
async function indexOne(file, st) {
  let e = entries.get(file);
  if (e && e.size === st.size && e.mtime === st.mtime) return e;
  if (!e || st.size < e.off) { e = newEntry(); entries.set(file, e); }
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.allocUnsafe(CHUNK);
    let base = e.off;          // carry[0] 的绝对位置
    let carry = null;          // 上一块剩下的半行
    let skipping = false;      // 正在跳过一条超长行（等下一个换行）
    let pos = e.off;
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      let chunk = buf.subarray(0, bytesRead);
      let start = 0;
      if (skipping) {
        const nl = chunk.indexOf(10);
        if (nl < 0) { base = pos; e.off = pos; await tick(); continue; }
        skipping = false; start = nl + 1; base = pos - bytesRead; carry = null;
      } else if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
      let nl;
      while ((nl = chunk.indexOf(10, start)) >= 0) { takeLine(e, chunk.subarray(start, nl)); start = nl + 1; }
      base += start;
      e.off = base;
      const rest = chunk.length - start;
      if (rest > MAX_LINE) { skipping = true; base = pos; e.off = pos; }
      else if (rest) carry = Buffer.from(chunk.subarray(start));
      await tick();
    }
    e.size = st.size; e.mtime = st.mtime;
    store.dirty = true; scheduleSave();
  } catch {
    // 读不了（被删 / 锁）：保留已有部分，下次再试
  } finally { try { await fh?.close(); } catch {} }
  return e;
}

/** 确保某文件的索引跟上（同一文件并发调用共用一次）。 */
export function ensureIndexed(f) {
  const e = entries.get(f.file);
  if (e && e.size === f.size && e.mtime === f.mtime) return Promise.resolve(e);
  if (inflight.has(f.file)) return inflight.get(f.file);
  const p = indexOne(f.file, { size: f.size, mtime: f.mtime }).finally(() => inflight.delete(f.file));
  inflight.set(f.file, p);
  return p;
}

// —— 后台预热：把一批文件挨个建好（不并发，别和前台请求抢盘）——
const warmQueue = new Map();
let warming = null;
export function warmIndex(files) {
  for (const f of files) warmQueue.set(f.file, f);
  if (warming) return warming;
  warming = (async () => {
    await loadStore();
    while (warmQueue.size) {
      const [k, f] = warmQueue.entries().next().value;
      warmQueue.delete(k);
      try { await ensureIndexed(f); } catch {}
    }
  })().finally(() => { warming = null; });
  return warming;
}
export const indexWarming = () => warming || Promise.resolve();

// 列表接口顺手调：同一身份 10 分钟最多一次，延后 15s 再开始（不和打开 Claude 页时的首屏请求抢盘）。
// filesFn 延迟求值，到点时才扫盘拿最新的文件全集（可以返回 Promise）。
const WARM_EVERY = 10 * 60_000, WARM_DELAY = 15_000;
const warmedAt = new Map();
export function scheduleSearchWarm(ctx, filesFn) {
  if (!ctx || ctx.snap || !ctx.key) return;
  const now = Date.now();
  if (now - (warmedAt.get(ctx.key) || 0) < WARM_EVERY) return;
  warmedAt.set(ctx.key, now);
  const t = setTimeout(() => { Promise.resolve().then(filesFn).then((files) => warmIndex(files || [])).catch(() => {}); }, WARM_DELAY);
  t.unref?.();
}

// —— 落盘 ——
export function configureSearchStore(file) {
  if (store.file === file) return;
  store = { file, loaded: false, loading: null, dirty: false, timer: null };
}
async function loadStore() {
  if (store.loaded || !store.file) return;
  if (store.loading) return store.loading;
  store.loading = (async () => {
    try {
      const j = JSON.parse(await fsp.readFile(store.file, 'utf8'));
      if (j && j.v === INDEX_V && j.files && typeof j.files === 'object') {
        for (const [file, d] of Object.entries(j.files)) {
          if (entries.has(file) || !d || typeof d.text !== 'string') continue;
          entries.set(file, { ...newEntry(), ...d, marks: Array.isArray(d.marks) ? d.marks : [], lower: null });
        }
      }
    } catch {}
    store.loaded = true;
  })();
  return store.loading;
}
function scheduleSave() {
  if (!store.file || store.timer) return;
  store.timer = setTimeout(() => { store.timer = null; saveStore().catch(() => {}); }, SAVE_DELAY);
  store.timer.unref?.();
}
// 落盘前剪掉已删的文件。以前逐条同步 existsSync（本机每次 0.3–0.6ms，441 条就是半秒，整段占着主线程）；
// 现在并发 fsp.access，只认「确实不存在」（被锁 / 没权限的不算删了），写盘也走异步。
const PRUNE_CONCURRENCY = 16;
let saving = null;
export async function saveStore() {
  if (!store.file || !store.dirty) return;
  if (saving) { await saving; return saveStore(); }   // 上一次还在写：等它写完再看还脏不脏
  const target = store;
  target.dirty = false;
  saving = (async () => {
    const keys = [...entries.keys()];
    const gone = [];
    let i = 0;
    const worker = async () => {
      while (i < keys.length) {
        const f = keys[i++];
        try { await fsp.access(f); } catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) gone.push(f); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PRUNE_CONCURRENCY, keys.length) }, worker));
    for (const f of gone) entries.delete(f);
    const files = {};
    for (const [file, e] of entries) files[file] = { size: e.size, mtime: e.mtime, off: e.off, text: e.text, marks: e.marks, ct: e.ct, at: e.at, trunc: e.trunc || undefined };
    if (store !== target) return;   // 期间换了存储位置（单测 _resetSearchIndex / configureSearchStore）
    const tmp = target.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ v: INDEX_V, files }));
    await fsp.rename(tmp, target.file);
  })().catch(() => {}).finally(() => { saving = null; });
  return saving;
}

// —— 查询 ——
export const normQuery = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const lowerOf = (e) => (e.lower != null ? e.lower : (e.lower = e.text.toLowerCase()));

/** 在一条索引里找 q（已规范化小写），返回 { snippet, matchAt, role } 或 null。 */
export function findInEntry(e, q) {
  if (!e || !e.text || !q) return null;
  const low = lowerOf(e);
  const idx = low.indexOf(q);
  if (idx < 0) return null;
  const src = low.length === e.text.length ? e.text : low;   // 极少数字符小写后变长：片段退回小写版，位置才对得上
  // 二分找命中所在的那条消息
  const n = e.marks.length / 3;
  let lo = 0, hi = n - 1, k = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (e.marks[mid * 3] <= idx) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  const segStart = n ? e.marks[k * 3] : 0;
  const segEnd = n && k + 1 < n ? e.marks[(k + 1) * 3] - 1 : src.length;
  const a = Math.max(segStart, idx - SNIP_BEFORE);
  const b = Math.min(segEnd, idx + q.length + SNIP_AFTER);
  const snippet = (a > segStart ? '…' : '') + src.slice(a, b).trim() + (b < segEnd ? '…' : '');
  return { snippet, matchAt: n ? e.marks[k * 3 + 1] || 0 : 0, role: n && e.marks[k * 3 + 2] ? 'user' : 'assistant' };
}

const LAYER = { title: 0, former: 0, loose: 1, text: 2 };
const LOOSE_MAX = 10;

/**
 * 搜一个身份能看到的全部会话（所有项目 + worktree + 快照那条，含已归档并标注）。
 * opts：{ limit, archived:'include'|'exclude'|'only', budgetMs, readFirst, trim }（后两者来自 routes/sessions.mjs）
 * → { hits:[{ sessionId, title, projectId, project, snippet, matchAt, mtime, match, former?, archived, archivedReason? }],
 *     partial, ms, indexed, total }
 * hits 按层排（标题 / 曾用名 → 宽松 → 正文），层内按最近活动；limit 是每层上限（宽松层另有 LOOSE_MAX）。
 * 空查询：按最近活动列出。
 */
export async function searchSessions(ctx, query, { limit = 30, archived = 'include', budgetMs = 2500, readFirst, trim } = {}) {
  const t0 = Date.now();
  const q = normQuery(query);
  limit = Math.max(1, Math.min(200, Number(limit) || 30));
  await loadStore();
  const { files, quickFiles, projects } = await listSessionFilesAsync(ctx);
  const all = [...quickFiles, ...files];
  const view = archiveView(ctx);
  const arch = new Map();
  for (const f of all) { const a = view(f.id, f.mtime, f.size); if (a) arch.set(f.id, a); }
  const pool = all.filter((f) => (archived === 'exclude' ? !arch.has(f.id) : archived === 'only' ? arch.has(f.id) : true))
    .sort((a, b) => b.mtime - a.mtime);
  const lib = getLibrary(ctx).titles || {};
  const fam = familyMaps(ctx);
  const titles = await resolveTitles(pool, { famTitles: fam.titles, desktopTitles: lineageFor(ctx).titles, readFirst, trim });
  const projName = (id) => projects.get(id)?.name || '';
  const hit = (f, match, extra = {}) => {
    const a = arch.get(f.id);
    const r = titles.get(f.id) || { title: '' };
    return {
      sessionId: f.id, title: lib[f.id] || r.title || '', projectId: f.projectId, project: projName(f.projectId),
      ...(f.wt ? { branch: f.wt.branch || '' } : {}),
      snippet: '', matchAt: 0, mtime: f.mtime, match, archived: !!a, ...(a ? { archivedReason: a.reason } : {}), ...extra,
    };
  };
  if (!q) {
    const hits = pool.filter((f) => !arch.has(f.id) || archived !== 'include').slice(0, limit).map((f) => hit(f, 'recent'));
    return { hits, partial: false, ms: Date.now() - t0, indexed: 0, total: pool.length };
  }
  const tokens = q.split(' ').filter(Boolean);
  const titled = [];               // 标题 / 曾用名层（pool 已按最近活动排好）
  const loose = new Map();         // 宽松层候选：id → f（正文也命中的改归正文层）
  const taken = new Set();
  for (const f of pool) {
    const r = titles.get(f.id) || { title: '', former: [] };
    const shown = lib[f.id] || r.title || '';
    if (normQuery(shown).includes(q)) { if (titled.length < limit) titled.push(hit(f, 'title')); taken.add(f.id); continue; }
    const formers = lib[f.id] ? [r.title, ...r.former] : r.former;
    const fm = formers.find((x) => x && normQuery(x).includes(q));
    if (fm) { if (titled.length < limit) titled.push(hit(f, 'former', { former: fm })); taken.add(f.id); continue; }
    // 多个词：各自出现在标题 / 项目名 / 分支里；单个词：只看分支名（项目名命中会把整个项目拖进来）
    const hay = tokens.length > 1 ? normQuery([shown, projName(f.projectId), f.wt?.branch || ''].join(' ')) : (q.length >= 2 ? normQuery(f.wt?.branch || '') : '');
    if (hay && tokens.every((tk) => hay.includes(tk))) loose.set(f.id, f);
  }
  // 正文层：最近的先查；没建好的在预算内现建，超预算的留给后台
  let partial = false, indexed = 0;
  const textHits = [];
  if (q.length >= 2) {
    const deadline = t0 + Math.max(200, budgetMs);
    const later = [];
    // 冷启动第一次查询要把每个会话的正文转小写（几百个会话、十几 MB）：攒满 ~12ms 就让一次事件循环
    let slice = performance.now();
    for (const f of pool) {
      if (textHits.length >= limit) break;
      if (taken.has(f.id)) continue;
      let e = entries.get(f.file);
      if (!e || e.size !== f.size || e.mtime !== f.mtime) {
        if (Date.now() > deadline) { partial = true; later.push(f); continue; }
        e = await ensureIndexed(f);
        slice = performance.now();
      } else if (performance.now() - slice > 12) { await tick(); slice = performance.now(); }
      indexed++;
      const m = findInEntry(e, q);
      if (m) { textHits.push(hit(f, 'text', m)); loose.delete(f.id); }
    }
    if (later.length) warmIndex(later);
  }
  const looseHits = [...loose.values()].slice(0, LOOSE_MAX).map((f) => hit(f, 'loose'));
  const hits = [...titled, ...looseHits, ...textHits];
  hits.sort((a, b) => LAYER[a.match] - LAYER[b.match] || b.mtime - a.mtime);
  return { hits, partial, ms: Date.now() - t0, indexed, total: pool.length };
}

// 单测用
export function _resetSearchIndex() { entries.clear(); inflight.clear(); warmQueue.clear(); if (store.timer) clearTimeout(store.timer); store = { file: null, loaded: false, loading: null, dirty: false, timer: null }; }
export const _entryFor = (file) => entries.get(file);
