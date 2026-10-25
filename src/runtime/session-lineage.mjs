// Claude 侧栏的会话血缘（2026-10-20，对齐官方 Claude Desktop 的子会话树与「移到顶层」）。
//
// 两路来源并成一张「直接父」表：Desktop 子会话树（desktop-lineage.mjs 的 parentOf）与 bridge 自己派生的
// 子会话（session-family.mjs 的 parentOf），bridge 的优先。再扣掉用户在 bridge 里「移到顶层」过的会话：
// 归档父会话时选「仅归档此会话」，官方把子会话移到顶层（It stops nesting under the session that started it
// and is no longer archived with it）——父会话之后取消归档，它们也不再挂回去。
//
// 「移到顶层」只改侧栏的缩进：bridge 派生关系（汇报、互发消息）不动，Desktop 的元数据也不写。
// 按身份落 claude-session-detached.json：{ v:1, ids: { [会话 id]: at } }；删会话时 forgetDetached 同步清。
//
// rootOf：子 → 顶层祖先（侧栏只缩进一级，全挂在根下）；parentOf：子 → 直接父（会话信息面板 / 归档对话框数子会话用）。
import path from 'node:path';
import { readJson, writeJson, ID_RE } from '../jsonfile.mjs';
import { lineageFor } from './desktop-lineage.mjs';
import { familyMaps } from './session-family.mjs';

const MAX = 20000;
const MAX_DEPTH = 32;
const cache = new Map();
const fileFor = (ctx) => path.join(ctx.dataDir, 'claude-session-detached.json');
const enabled = (ctx) => !!(ctx && ctx.dataDir && !ctx.snap);

function load(ctx) {
  const file = fileFor(ctx);
  if (cache.has(file)) return cache.get(file);
  const raw = readJson(file, {});
  const ids = {};
  if (raw && raw.ids && typeof raw.ids === 'object') for (const [id, at] of Object.entries(raw.ids)) if (ID_RE.test(id)) ids[id] = Number(at) || 0;
  const d = { ids };
  cache.set(file, d);
  return d;
}
const save = (ctx) => writeJson(fileFor(ctx), { v: 1, ids: load(ctx).ids });

/** 用户「移到顶层」过的会话 id。 */
export function detachedSet(ctx) {
  return enabled(ctx) ? new Set(Object.keys(load(ctx).ids)) : new Set();
}

/** 把这些会话移到顶层（不再缩进挂在父会话下、不随父会话归档）。返回是否有变化。 */
export function detachSessions(ctx, ids, at = Date.now()) {
  if (!enabled(ctx)) return false;
  const d = load(ctx);
  let changed = false;
  for (const id of ids || []) {
    if (typeof id !== 'string' || !ID_RE.test(id) || d.ids[id]) continue;
    if (Object.keys(d.ids).length >= MAX) break;
    d.ids[id] = at; changed = true;
  }
  if (changed) save(ctx);
  return changed;
}

export function forgetDetached(ctx, id) {
  if (!enabled(ctx) || !id) return;
  const d = load(ctx);
  if (!(id in d.ids)) return;
  delete d.ids[id];
  save(ctx);
}

/**
 * 合并后的血缘：{ rootOf, parentOf }（只收有父的会话）。desktop / fam 可传入（调用方已算过就复用）。
 * 移到顶层的会话自己成为根，它名下的后代改挂到它身上。环与过深的链照官方上限截断。
 */
export function sessionLineage(ctx, { desktop, fam } = {}) {
  desktop = desktop || lineageFor(ctx);
  fam = fam || familyMaps(ctx);
  const detached = detachedSet(ctx);
  const parentOf = new Map();
  for (const [id, p] of desktop.parentOf || []) if (!detached.has(id)) parentOf.set(id, p);
  // 旧快照（没有 parentOf）退回压平的 rootOf：缩进照旧，只是「移到顶层」认不出中间一层
  if (!desktop.parentOf) for (const [id, r] of desktop.rootOf || []) if (!detached.has(id)) parentOf.set(id, r);
  for (const [id, p] of fam.parentOf) if (!detached.has(id) && p) parentOf.set(id, p);
  const rootOf = new Map();
  for (const id of parentOf.keys()) {
    let top = parentOf.get(id);
    const seen = new Set([id, top]);
    for (let i = 0; i < MAX_DEPTH; i++) {
      const next = parentOf.get(top);
      if (!next || seen.has(next)) break;
      seen.add(next); top = next;
    }
    if (top && top !== id) rootOf.set(id, top);
  }
  return { rootOf, parentOf };
}

/** ids 这几个会话的直接子会话（「仅归档此会话」时要移到顶层的那些）。 */
export function directChildren(ctx, ids, lineage) {
  const want = new Set(ids);
  const { parentOf } = lineage || sessionLineage(ctx);
  const out = [];
  for (const [id, p] of parentOf) if (want.has(p) && !want.has(id)) out.push(id);
  return out;
}

export function _resetDetachCache() { cache.clear(); }
