// Claude 会话标题的来源与缓存（2026-10-20，对齐官方 Claude Desktop：标题有 auto / user / tool 三种来源，
// auto 永远不覆盖后两者）。
//
// bridge 侧的优先级（高 → 低）：
//   ① bridge 里用户改的名（session-library titles）——前端 titleFor() 叠加，服务端列表不必带
//   ② jsonl 尾部 custom-title（用户在 Desktop / CLI 里改的；Desktop 也把它的侧栏标题写成这条）
//   ③ bridge 派生会话起的名（session-family links[id].title）/ Desktop local_*.json 的 title（含 spawnedFrom.title）
//   ④ jsonl 的 ai-title（CLI 在 SDK / headless 模式自动生成的短标题，bridge 自己跑的会话也有）
//   ⑤ 首条真用户消息（trimTitle 剥信封与附件注入）
//
// custom-title / ai-title 是 CLI 追加进 transcript 的记录（{"type":"custom-title","customTitle":…}），会话收尾时
// CLI 会把它们重抄到文件尾；改名时另写一份 sidecar <会话目录>/<id>/custom-title.json。所以读尾部 64KB 就够，
// 尾部没有再看 sidecar；ai-title 尾部没有时读一次文件头（它在头一两轮就生成了）。按 size + mtime 缓存：
// jsonl 只追加，文件变长时新尾部没找到的字段沿用旧值，文件变短（被改写）才整条作废。
// 首条用户消息同理：只追加就不会变，读过一次按文件缓存。
import path from 'node:path';
import { promises as fsp } from 'node:fs';

const TAIL = 64 * 1024;
const HEAD = 128 * 1024;
const MAX_ENTRIES = 20000;
const tails = new Map();    // file -> { size, mtime, custom, ai, headDone }
const firsts = new Map();   // file -> { size, title }
// 解析过、整条标题链都是空的文件（没有任何标题来源、也没有一条真用户消息）：列表会把它们滤掉，
// 所以各项目「还有几条」与已归档总数都不该算它们（knownUntitled）。file -> { size, mtime }
const blanks = new Map();

const CT_MARK = '"type":"custom-title"';
const AI_MARK = '"type":"ai-title"';

// 一段 jsonl 文本里最后一条 custom-title / ai-title（必须 JSON.parse，正则遇到转义会翻车）。
// partialHead：文本不是从文件开头读的，第一行可能是半截，丢掉。
export function parseTitleRecords(text, { partialHead = false } = {}) {
  const lines = String(text || '').split('\n');
  if (partialHead) lines.shift();
  let custom, ai;
  for (let i = lines.length - 1; i >= 0 && (custom === undefined || ai === undefined); i--) {
    const l = lines[i];
    const isCt = custom === undefined && l.includes(CT_MARK);
    const isAi = ai === undefined && l.includes(AI_MARK);
    if (!isCt && !isAi) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (isCt && o.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle;
    if (isAi && o.type === 'ai-title' && typeof o.aiTitle === 'string') ai = o.aiTitle;
  }
  return { custom, ai };
}

async function readRange(file, start, len) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; } finally { try { await fh?.close(); } catch {} }
}

async function readSidecar(file) {
  const id = path.basename(file, '.jsonl');
  try {
    const j = JSON.parse(await fsp.readFile(path.join(path.dirname(file), id, 'custom-title.json'), 'utf8'));
    return typeof j?.customTitle === 'string' ? j.customTitle : undefined;
  } catch { return undefined; }
}

const trimCache = (m) => { if (m.size > MAX_ENTRIES) for (const k of [...m.keys()].slice(0, m.size - MAX_ENTRIES)) m.delete(k); };

/** jsonl 里的 { custom, ai } 标题（空串 = 显式清空过）。st = { size, mtime }（调用方已 stat）。 */
export async function transcriptTitles(file, st) {
  const size = Number(st?.size) || 0, mtime = Number(st?.mtime) || 0;
  const c = tails.get(file);
  if (c && c.size === size && c.mtime === mtime) return c;
  const grew = c && size >= c.size;
  const start = Math.max(0, size - TAIL);
  const tail = parseTitleRecords(await readRange(file, start, size - start), { partialHead: start > 0 });
  const next = {
    size, mtime,
    custom: tail.custom !== undefined ? tail.custom : (grew ? c.custom : undefined),
    ai: tail.ai !== undefined ? tail.ai : (grew ? c.ai : undefined),
    headDone: grew ? c.headDone : false,
  };
  if (next.custom === undefined) next.custom = await readSidecar(file);
  if (next.ai === undefined && !next.headDone && start > 0) {
    next.headDone = true;
    const head = parseTitleRecords(await readRange(file, 0, Math.min(HEAD, start)));
    if (head.ai !== undefined) next.ai = head.ai;
    if (next.custom === undefined && head.custom !== undefined) next.custom = head.custom;
  }
  tails.set(file, next);
  trimCache(tails);
  return next;
}

/** 首条真用户消息（原文；readFirst 由调用方给——sessions.mjs 的 readSessionTitle）。只追加：读过就缓存。 */
export async function firstMessage(file, st, readFirst) {
  const size = Number(st?.size) || 0;
  const c = firsts.get(file);
  if (c && size >= c.size && (c.title || size === c.size)) return c.title;
  const title = (await readFirst(file)) || '';
  firsts.set(file, { size, title });
  trimCache(firsts);
  return title;
}

// Desktop 在 worktree 里开的会话，首条用户消息是字符串内容、开头整段 <system-reminder>（「You are operating in a
// git worktree…」）——readSessionTitle 只按内容块跳过注入，字符串开头的这段要在这里剥掉，否则标题就是提醒原文。
const stripReminders = (s) => String(s || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');

/**
 * 按优先级取一条会话的标题（不含 library——前端叠加）。返回 { title, former }：
 * former = 其余标题来源里与最终标题不同的名字（搜索「曾用名」层用），已 trim。
 */
export async function resolveTitle(f, { fam, desktop, readFirst, trim }) {
  const tt = await transcriptTitles(f.file, f);
  const cands = [tt.custom, fam, desktop, tt.ai];
  let title = '';
  for (const c of cands) { const v = c ? trim(c) : ''; if (v) { title = v; break; } }
  if (!title) title = trim(stripReminders(await firstMessage(f.file, f, readFirst)));
  if (title) blanks.delete(f.file);
  else { blanks.set(f.file, { size: Number(f.size) || 0, mtime: Number(f.mtime) || 0 }); trimCache(blanks); }
  // 曾用名只算真正的「标题」来源；首条消息在正文索引里，由全文层负责
  const former = [...new Set(cands.map((c) => (c ? trim(c) : '')).filter((v) => v && v !== title))];
  return { title, former };
}

/**
 * 这个文件确定没有标题（列表会滤掉它）：解析过、之后没再变、眼下也没有派生名 / Desktop 标题。
 * 没解析过的一律当有（宁可多算一条）。同步、只查缓存，列表接口对全集逐条调。
 */
export function knownUntitled(f, { fam, desktop } = {}) {
  if (fam || desktop) return false;
  const b = blanks.get(f.file);
  return !!b && b.size === (Number(f.size) || 0) && b.mtime === (Number(f.mtime) || 0);
}

/** 一批文件并发解析（并发上限防 fd 打满）。fileList 元素 = { id, file, mtime, size }。 */
export async function resolveTitles(fileList, opts, concurrency = 16) {
  const out = new Map();
  for (let i = 0; i < fileList.length; i += concurrency) {
    const part = fileList.slice(i, i + concurrency);
    const got = await Promise.all(part.map((f) => resolveTitle(f, {
      ...opts, fam: opts.famTitles?.get(f.id), desktop: opts.desktopTitles?.get(f.id),
    }).catch(() => ({ title: '', former: [] }))));
    part.forEach((f, k) => out.set(f.id, got[k]));
  }
  return out;
}

// 后台把全集的标题链解析一遍（只为填缓存：knownUntitled 才认得出没标题的文件，计数才准）。
// 列表接口顺手调：同一身份 10 分钟最多一次、延后 20s 开始；4 个一批、批间让出事件循环。
// 已缓存且没变的文件只是几次 Map 查找；冷启动第一遍主要是每个文件读尾部 64KB。
// filesFn 可以返回 Promise（列表接口给的是 session-list.mjs 的异步缓存版，不再另起一次同步扫盘）。
const WARM_EVERY = 10 * 60_000, WARM_DELAY = 20_000;
const warmedAt = new Map();
let warming = null;
export function scheduleTitleWarm(ctx, filesFn, opts) {
  if (!ctx || ctx.snap || !ctx.key) return;
  const now = Date.now();
  if (now - (warmedAt.get(ctx.key) || 0) < WARM_EVERY) return;
  warmedAt.set(ctx.key, now);
  const t = setTimeout(() => {
    if (warming) return;
    warming = (async () => {
      let list = [];
      try { list = (await filesFn()) || []; } catch {}
      const o = typeof opts === 'function' ? opts() : opts;
      for (let i = 0; i < list.length; i += 4) {
        await resolveTitles(list.slice(i, i + 4), o, 4).catch(() => {});
        await new Promise((r) => setImmediate(r));
      }
    })().finally(() => { warming = null; });
  }, WARM_DELAY);
  t.unref?.();
}

export function _resetTitleCache() { tails.clear(); firsts.clear(); blanks.clear(); warmedAt.clear(); }
