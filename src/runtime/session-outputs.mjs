// 会话信息面板「输出内容」卡：这个会话产出的文件（官方 Desktop 2.37337 的 hf/mf 规则照搬）。
// 来源只有三种，Edit 改过的不算：
//   ① Write 成功写出的文件——但排除：Claude 临时目录 / scratchpad、会话文件夹之外、.claude/ 下或
//      CLAUDE.md、git 仓库里且扩展名不是交付类（md/txt/pdf/office/csv/html/图片/音视频/zip）；
//   ② SendUserFile 发给用户的文件；
//   ③ 助手正文里链接到的文件（bridge 的交付链接规则，见 deliverables.mjs collectDeliverables）。
// 最近的在前、最多 50 个、已删除的剔除。
//
// 10-21：以前每次都用 readline 把整份 transcript 从头读一遍（163MB 的会话约 3 秒），会话信息面板在打开、换会话、每轮收尾都要拉。
// jsonl 只追加：按（文件, 会话文件夹, 交付根）记住读到的字节位置与中间状态，文件变长只读新增的完整行（session-jsonl.mjs）；
// 变短 / 已消化部分被改写就整份重来。最后逐个确认文件还在也改成了异步 stat。
// 唯一依赖「当时盘上有没有」的是正文链接（目标不存在就不算）：消化时还不存在的链接另记一份待定，每次请求重判（见 recheckPending）。
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDeliverables, deliverKind, resolveDeliverPath, FILE_EXT_RE, deliverLinkRe, deliverLinkTarget } from './deliverables.mjs';
import { readJsonlLines, lineObj, readTail } from './session-jsonl.mjs';

const MAX = 50;
const PENDING_MAX = 100;   // 每份缓存最多记这么多条「目标还不存在」的正文链接（只留最近的）
const DELIVER_EXT = new Set(['md', 'markdown', 'txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'tsv', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'mp4', 'webm', 'mov', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'zip']);
const fold = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
const inside = (file, root) => { const r = path.relative(root, file); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

function isTempPath(p) {
  const f = fold(path.resolve(p));
  const tmp = fold(path.resolve(os.tmpdir()));
  return f.startsWith(tmp + path.sep) || /[\\/]temp[\\/]claude[\\/]/i.test(f) || /[\\/]scratchpad([\\/]|$)/i.test(f);
}

const gitCache = new Map();
function inGitCheckout(file) {
  let dir = path.dirname(file);
  const seen = [];
  for (let i = 0; i < 40; i++) {
    if (gitCache.has(dir)) { const v = gitCache.get(dir); for (const d of seen) gitCache.set(d, v); return v; }
    seen.push(dir);
    if (existsSync(path.join(dir, '.git'))) { for (const d of seen) gitCache.set(d, true); return true; }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const d of seen) gitCache.set(d, false);
  if (gitCache.size > 5000) gitCache.clear();
  return false;
}

// 「会话文件夹之外」与「git 仓库里的非交付扩展名」两条按官方实际表现收窄（2026-10-14 对照官方面板截图）：
// 本会话在一个仓库里跑、写到另一个仓库的 .mjs，官方照样列进「输出内容」——
// 所以只有落在会话自己文件夹（及其所在 git 仓库）里的源码类文件才算「改代码」不算输出，写到别处的照算。
export function writeCounts(file, roots) {
  const abs = path.resolve(file);
  if (isTempPath(abs)) return false;
  if (/[\\/]\.claude[\\/]/.test(abs) || /^claude\.md$/i.test(path.basename(abs))) return false;
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (roots.some((r) => inside(abs, r)) && inGitCheckout(abs) && !DELIVER_EXT.has(ext)) return false;
  return true;
}

// 正文链接的提取、目标的规整（去 title / 尖括号、跳过 scheme、百分号解码）与扩展名表，都直接用 deliverables.mjs 那一份
// （collectDeliverables 同用）——这里只用来判断「这条链接是不是指向一个还没生成的交付文件」，真正算不算交付仍交给 collectDeliverables。
const LINK_RE = deliverLinkRe();   // 只给 matchAll 用（它会复制正则，不动这个的 lastIndex）
const LINK_EXT_RE = FILE_EXT_RE;
const linkTarget = deliverLinkTarget;

// 一段助手正文里的链接：逐条交给 collectDeliverables（与正文附件卡同一套解析、根守卫、交付扩展名），按正文顺序记；
// 同一段里重复的只记第一次、一段最多 MAX 个——和以前整段交给它一次算完的结果一样。
// 目标此刻在哪个基准下都不存在、扩展名又像交付物的（「图会生成到 [chart.png](chart.png)」，随后才用 Bash 跑出来），
// 记进 st.pending（链接原文 + 当时的 cwd + 序号），每次请求重判：以前每次整份重扫，文件后来生成了自然会列出来，
// 增量缓存要是把「当时不存在」定死，它就再也不出现了。
function takeLinks(st, text, cwd, linkRoots, anywhere, note) {
  const seen = new Set();
  for (const m of text.matchAll(LINK_RE)) {
    if (seen.size >= MAX) break;
    const [d] = collectDeliverables(m[0], { cwd, roots: linkRoots, limit: 1, anywhere });
    if (d) {
      const f = fold(d.path);
      if (seen.has(f)) continue;
      seen.add(f);
      if (d.kind !== 'folder') note(d.path);
      continue;
    }
    const raw = linkTarget(m[1]);
    if (!raw || !LINK_EXT_RE.test(raw) || resolveDeliverPath(raw, cwd, linkRoots)) continue;   // 存在但不算交付（根外 / 扩展名）：定死无妨
    const k = (cwd || '') + '\0' + raw;
    st.pending.delete(k);   // 同一链接后面又提到：按后面那次的位置排
    st.pending.set(k, { link: m[0], raw, cwd, s: ++st.seq });
    if (st.pending.size > PENDING_MAX) st.pending.delete(st.pending.keys().next().value);
  }
}

// 与 resolveDeliverPath 同一组基准（绝对路径原样；相对的先 cwd、再各交付根），只异步 stat 看在不在，不碰同步 IO
async function mayExist(raw, cwd, roots) {
  const bases = path.isAbsolute(raw) ? [''] : [cwd || '.', ...roots.filter(Boolean)];
  for (const base of bases) {
    try { await fsp.stat(base ? path.resolve(base, raw) : raw); return true; } catch {}
  }
  return false;
}

// 待定的正文链接逐条重判（16 条一批）：目标出现了才再走一遍 collectDeliverables，按链接原来的序号补进 latest
// （同一文件之后又被提到 / 写过就留后面那次）——与整份重扫在此刻的结果一致。出现了却不算交付的（文件夹、根外）一并移出待定。
async function recheckPending(e, linkRoots, anywhere) {
  const items = [...e.pending];
  for (let i = 0; i < items.length; i += 16) {
    const part = items.slice(i, i + 16);
    const hit = await Promise.all(part.map(([, p]) => mayExist(p.raw, p.cwd, linkRoots)));
    for (let k = 0; k < part.length; k++) {
      if (!hit[k]) continue;
      const [key, p] = part[k];
      e.pending.delete(key);
      const [d] = collectDeliverables(p.link, { cwd: p.cwd, roots: linkRoots, limit: 1, anywhere });
      if (!d || d.kind === 'folder') continue;
      const abs = path.resolve(d.path);
      const cur = e.latest.get(fold(abs));
      if (!cur || cur.s < p.s) e.latest.set(fold(abs), { abs, s: p.s });
    }
  }
}

// 一行 transcript 记录 → 增量状态 st（latest：fold(abs) → { abs, s }，后出现的覆盖先出现的；writes：tool_use_id → abs；
// pending：目标还不存在的正文链接，见 takeLinks）
function takeRecord(st, o, { cwd, roots, linkRoots, anywhere }) {
  if (!o || o.isSidechain || !o.message) return;
  const note = (abs) => { if (!abs) return; const a = path.resolve(abs); st.latest.set(fold(a), { abs: a, s: ++st.seq }); };
  const content = Array.isArray(o.message.content) ? o.message.content : [];
  const lineCwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : cwd;
  if (o.type === 'assistant') {
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_use' && b.name === 'Write' && b.input && typeof b.input.file_path === 'string') {
        const abs = path.resolve(lineCwd || '', b.input.file_path);
        if (writeCounts(abs, roots)) st.writes.set(b.id, abs);
      } else if (b.type === 'tool_use' && b.name === 'SendUserFile' && b.input && Array.isArray(b.input.files)) {
        for (const f of b.input.files) if (typeof f === 'string' && f) note(path.resolve(lineCwd || '', f));
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('](')) {
        takeLinks(st, b.text, lineCwd, linkRoots, anywhere, note);
      }
    }
  } else if (o.type === 'user') {
    for (const b of content) {
      if (!b || b.type !== 'tool_result' || !st.writes.has(b.tool_use_id)) continue;
      if (!b.is_error) note(st.writes.get(b.tool_use_id));
      st.writes.delete(b.tool_use_id);
    }
  }
}

const cache = new Map();   // file\0cwd\0交付根\0anywhere → { size, mtime, off, tail, latest, writes, pending, seq }（Map 插入序当 LRU）
const CACHE_MAX = 8;
const locks = new Map();   // 同一 key 的读写串行

// 同一份缓存不能被两个请求同时喂：以前读新增行的间隙（await）里缓存是摘下来的，同时到的第二个请求
// （一轮收尾时几台设备的会话信息面板一起拉）看不到它，就整份重建一遍。现在排队，轮到时多半直接命中。
function withLock(k, fn) {
  const prev = locks.get(k) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(k, tail);
  tail.then(() => { if (locks.get(k) === tail) locks.delete(k); });
  return run;
}

// file：transcript；cwd：会话文件夹；linkRoots / anywhere：交付链接的根守卫（同正文附件卡）
export async function sessionOutputs(file, { cwd, linkRoots = [], anywhere = false } = {}) {
  const roots = [cwd].filter(Boolean).map((r) => path.resolve(r));
  const key = [file, cwd || '', JSON.stringify(linkRoots || []), anywhere ? 1 : 0].join('\0');
  const cands = await withLock(key, async () => {
    const fst = await fsp.stat(file);   // 文件不在就抛（调用方当没有输出）
    let e = cache.get(key) || null;
    cache.delete(key);
    const same = e && e.size === fst.size && e.mtime === fst.mtimeMs;
    if (e && !same && (fst.size <= e.size || !(await readTail(file, e.off)).equals(e.tail))) e = null;
    if (!e) e = { size: -1, mtime: 0, off: 0, tail: Buffer.alloc(0), latest: new Map(), writes: new Map(), pending: new Map(), seq: 0 };
    if (!same) {
      const opts = { cwd, roots, linkRoots, anywhere };
      e.off = await readJsonlLines(file, e.off, fst.size, (b) => takeRecord(e, lineObj(b), opts));
      e.size = fst.size; e.mtime = fst.mtimeMs;
      e.tail = await readTail(file, e.off);
    }
    // transcript 没变也要重判：正文链接指向的文件可能是之后才生成的
    if (e.pending.size) await recheckPending(e, linkRoots, anywhere);
    cache.set(key, e);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return [...e.latest.values()].sort((a, b) => b.s - a.s);
  });
  // 最近的在前，逐个确认还在（异步，16 个一批，凑够 MAX 个就停）
  const out = [];
  for (let i = 0; i < cands.length && out.length < MAX; i += 16) {
    const part = cands.slice(i, i + 16);
    const sts = await Promise.all(part.map((c) => fsp.stat(c.abs).catch(() => null)));
    for (let k = 0; k < part.length && out.length < MAX; k++) {
      const st = sts[k];
      if (!st || !st.isFile()) continue;
      const abs = part[k].abs;
      out.push({ name: path.basename(abs), path: abs, kind: deliverKind(abs), size: st.size });
    }
  }
  return out;
}
