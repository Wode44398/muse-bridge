// 会话库：收藏 + 自定义标题。2026-10-11 起以服务端为准（POST /api/claude/library，按账号落
// claude-session-library.json），换设备也看得见；本机 localStorage 只是离线/首屏缓存。
// 下行三条路：/api/sessions 的 library 字段、总线 hello 的 library、总线 {type:'library'} 推送。
// 旧版只存本机的 bridge-stars / bridge-titles 在第一次拿到服务端快照时 merge 上云，然后删掉。
import { api } from './api.js';

const LS_CACHE = 'bridge-library';
const LEGACY_STAR = 'bridge-stars';
const LEGACY_TITLE = 'bridge-titles';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

const cached = load(LS_CACHE, null);
export const library = $state({
  stars: Array.isArray(cached?.stars) ? cached.stars : load(LEGACY_STAR, []),    // [sessionId, …]（最近收藏在前）
  titles: cached?.titles && typeof cached.titles === 'object' ? cached.titles : load(LEGACY_TITLE, {}),
});
let rev = Number.isFinite(cached?.rev) ? cached.rev : -1;   // 已采纳的服务端版本；-1 = 还没见过服务端
let inflight = 0;                                           // 进行中的写：期间到的快照可能早于乐观更新，先不采纳
let migrating = false;

const saveCache = () => { try { localStorage.setItem(LS_CACHE, JSON.stringify({ rev, stars: library.stars, titles: library.titles })); } catch {} };

function adopt(lib) {
  library.stars = Array.isArray(lib.stars) ? lib.stars : [];
  library.titles = lib.titles && typeof lib.titles === 'object' ? lib.titles : {};
  rev = Number.isFinite(lib.rev) ? lib.rev : 0;
  saveCache();
}

/** 服务端快照到达（列表接口 / 总线）。旧于已采纳版本、或本机还有写在路上时忽略。 */
export function applyServerLibrary(lib) {
  if (!lib || typeof lib !== 'object') return;
  if (!migrating && migrateLegacy(lib)) return;
  if (inflight || migrating) return;
  if (Number.isFinite(lib.rev) && lib.rev < rev) return;
  adopt(lib);
}

// 旧本机数据一次性上云（并集；服务端已有的标题优先）。成功后删旧键。
function migrateLegacy(lib) {
  const stars = load(LEGACY_STAR, null), titles = load(LEGACY_TITLE, null);
  const hasStars = Array.isArray(stars) && stars.length > 0;
  const hasTitles = !!titles && typeof titles === 'object' && Object.keys(titles).length > 0;
  if (!hasStars && !hasTitles) {
    if (stars != null || titles != null) { try { localStorage.removeItem(LEGACY_STAR); localStorage.removeItem(LEGACY_TITLE); } catch {} }
    return false;
  }
  migrating = true;
  api.claudeLibrary({ op: 'merge', stars: hasStars ? stars : [], titles: hasTitles ? titles : {} })
    .then((r) => {
      try { localStorage.removeItem(LEGACY_STAR); localStorage.removeItem(LEGACY_TITLE); } catch {}
      if (r?.library) adopt(r.library);
    })
    .catch(() => { if (!inflight) adopt(lib); })   // 下次拿到快照再试；本次先按服务端显示
    .finally(() => { migrating = false; });
  return true;
}

/** 换人 / 退出：清掉上一个人的收藏缓存（服务端那份不动）。 */
export function resetLibrary() {
  library.stars = []; library.titles = {}; rev = -1;
  try { localStorage.removeItem(LS_CACHE); } catch {}
}

// 乐观写：先改本地，再落服务端；失败退回原状并把错误抛给调用方提示。
async function write(op, undo) {
  inflight++;
  try {
    const r = await api.claudeLibrary(op);
    if (inflight === 1 && r?.library) adopt(r.library);
    else if (r?.library) rev = Math.max(rev, r.library.rev);
  } catch (e) {
    undo();
    saveCache();
    throw e;
  } finally {
    inflight--;
  }
}

export const isStarred = (id) => library.stars.includes(id);
export function toggleStar(id) {
  const prev = library.stars;
  const on = !prev.includes(id);
  library.stars = on ? [id, ...prev] : prev.filter((x) => x !== id);
  return write({ op: 'star', id, on }, () => { library.stars = prev; });
}

export const titleFor = (id, fallback) => library.titles[id] || fallback;
export function renameSession(id, name) {
  const t = (name || '').trim();
  const prev = library.titles;
  if (t) library.titles = { ...prev, [id]: t };
  else { const next = { ...prev }; delete next[id]; library.titles = next; }   // 留空 = 恢复自动标题
  return write({ op: 'title', id, title: t }, () => { library.titles = prev; });
}

/** 会话被删：本地即刻摘掉（服务端删除接口自己会清那一份）。 */
export function forgetSession(id) {
  if (!library.stars.includes(id) && !(id in library.titles)) return;
  library.stars = library.stars.filter((x) => x !== id);
  const next = { ...library.titles }; delete next[id]; library.titles = next;
  saveCache();
}
