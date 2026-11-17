// /api/session 的增量解析缓存（按文件尾部续读、单飞锁、闲置回收）。
import fsp from 'node:fs/promises';
import { lineObj, lineStr, readJsonlLines, readTail } from '../../runtime/session-jsonl.mjs';
import { chainInc, chainTake, makeHistoryParser, newChainState, readSessionMessages } from './history-parse.mjs';

// —— /api/session 的增量解析缓存（2026-10-21）——
// 以前每次请求都把整份 transcript 从头解析两遍（主链扫描 + 重建），80–155MB 的会话一次 1.6–1.8 秒；Desktop / CLI 在跑的
// 会话每个 session.touch 都要来一遍（前端对账、多端各拉一次、列表刷新顺手预取）。jsonl 只追加，所以按（文件, 身份）记住
// 消化到的字节位置、主链状态和重建状态机：文件变长、新内容只是沿主链接着长（最常见），就只读新增的完整行喂给同一个状态机。
// 结果必须与全量 readSessionMessages 一致（session-history-cache.test.mjs 对拍），下面这些一律整份重建：
//   · 变短 / 同长但 mtime 变了 / 已消化部分末尾 64 字节变了（被改写）；
//   · 新内容里有安全栅门撤回（可能撤的是旧帧）；
//   · 主链分叉（回滚后新叶子沿链走不到旧叶子），或新主链经过了旧内容里的条目（旧行的去留会跟着变）；
//   · 收尾时扣着手动 /compact（收尾会把它原位挂上，之后续不上）；
//   · 展开过媒体的后台子 agent 转录后来又长了（全量重建会读到它新出的图）。
// 回滚锚点待生效（视图按锚点截断）的请求不走缓存；小于 1MB 的会话整份解析也就几毫秒，不占缓存。
const HIST_MIN = 1 << 20;
const HIST_MAX = 3;              // 最多记几份（一份状态大约是 transcript 的一成）
const HIST_IDLE = 10 * 60_000;   // 这么久没人看的丢掉
const histCache = new Map();     // file\0身份 → entry；Map 的插入序当 LRU
const histLocks = new Map();
const histStats = { hits: 0, extends: 0, builds: 0 };
export const _historyStats = () => ({ ...histStats });   // 单测 / 基准用

// 同一份缓存的读写串行（状态机不能被两个请求同时喂）；后到的排队，轮到时多半直接命中。
function withHistLock(k, fn) {
  const prev = histLocks.get(k) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  histLocks.set(k, tail);
  tail.then(() => { if (histLocks.get(k) === tail) histLocks.delete(k); });
  return run;
}

// 整份建：主链扫描 + 状态机，都只读到最后一个完整行。mark = 已消化部分的条目数（之后进来的条目序号都 ≥ 它）。
async function buildHistory(file, size, planRecord) {
  const cs = newChainState();
  const off = await readJsonlLines(file, 0, size, (b) => { const o = lineObj(b); if (o) chainTake(cs, o); });
  const inc = chainInc(cs);
  const parser = makeHistoryParser(file, { incSet: inc, retractedSet: cs.retracted, planRecord });
  await readJsonlLines(file, 0, off, (b) => parser.feed(lineStr(b)));
  return { cs, inc, parser, off, mark: cs.count, leaf: cs.leaf ? cs.leaf.uuid : null };
}

// 接着长：只读新增的完整行。返回 false = 不是「沿主链接着长」，调用方整份重建（e 的主链状态已经被喂过新行，丢掉）。
async function extendHistory(file, e, size) {
  const cs = e.cs;
  let retracted = 0;
  const end = await readJsonlLines(file, e.off, size, (b) => { const o = lineObj(b); if (o) retracted += chainTake(cs, o); });
  if (end === e.off) return true;   // 只多了半行
  if (retracted) return false;
  const inc = chainInc(cs);
  if ((inc === null) !== (e.inc === null)) return false;
  if (inc) {
    if (!e.leaf || !inc.has(e.leaf)) return false;
    for (const u of inc) {
      if (e.inc.has(u)) continue;
      const n = cs.byUuid.get(u);
      if (!n || n.first < e.mark) return false;
    }
  }
  e.parser.ctl.incSet = inc;
  e.parser.ctl.retractedSet = cs.retracted;
  await readJsonlLines(file, e.off, end, (b) => e.parser.feed(lineStr(b)));
  e.off = end; e.inc = inc; e.mark = cs.count; e.leaf = cs.leaf ? cs.leaf.uuid : null;
  return true;
}

async function watchedChanged(parser) {
  if (!parser.watched.length) return false;
  const sizes = await Promise.all(parser.watched.map((w) => fsp.stat(w.file).then((s) => s.size, () => -1)));
  return sizes.some((sz, i) => sz !== parser.watched[i].size);
}

/**
 * 与 readSessionMessages 同结果的历史读取，大会话走增量缓存（/api/session 用）。key = 身份（计划卡台账按身份查）。
 * 返回的消息对象与缓存共用：调用方只读、当场序列化，别改。
 */
export async function readSessionHistory(file, { key = '', cutAfterUuid = null, planRecord = null } = {}) {
  if (cutAfterUuid) return readSessionMessages(file, { cutAfterUuid, planRecord });
  const k = file + '\0' + key;
  return withHistLock(k, async () => {
    const now = Date.now();
    for (const [x, c] of histCache) if (now - c.used > HIST_IDLE) histCache.delete(x);
    let e = histCache.get(k) || null;
    histCache.delete(k);
    try {
      const st = await fsp.stat(file);
      if (st.size < HIST_MIN) return readSessionMessages(file, { planRecord });
      if (e && await watchedChanged(e.parser)) e = null;
      if (e && e.size === st.size && e.mtime === st.mtimeMs) { histStats.hits++; e.used = now; histCache.set(k, e); return e.out; }
      if (e && (st.size <= e.size || !(await readTail(file, e.off)).equals(e.tail))) e = null;
      if (e) {
        e.parser.ctl.planRecord = planRecord;
        if (await extendHistory(file, e, st.size)) histStats.extends++;
        else e = null;
      }
      if (!e) { histStats.builds++; e = await buildHistory(file, st.size, planRecord); }
      const holding = e.parser.holding();
      const out = e.parser.finish();
      if (holding) return out;   // 收尾改过状态、续不上：这份不留
      e.size = st.size; e.mtime = st.mtimeMs; e.used = now; e.out = out;
      e.tail = await readTail(file, e.off);
      histCache.set(k, e);
      while (histCache.size > HIST_MAX) histCache.delete(histCache.keys().next().value);
      return out;
    } catch {
      return readSessionMessages(file, { planRecord });
    }
  });
}

/** 会话被删：它的增量缓存一起丢。 */
export function forgetHistory(file) {
  for (const k of [...histCache.keys()]) if (k.startsWith(file + '\0')) histCache.delete(k);
}
