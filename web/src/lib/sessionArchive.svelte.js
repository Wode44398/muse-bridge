// Claude 会话归档（前端，2026-10-20，对齐官方 Claude Desktop 的 Archive / Unarchive）。
// 服务端：POST /api/claude/archive {ids,on,detach?} / {projectId,on}、GET /api/sessions?view=archived（分页）、
// 总线 {type:'archive', archive}。总线订阅放在模块里（全局，同 claudeSettings.svelte.js）：别的设备归档 / 取消归档、
// 自动归档扫过一轮，都即时记进 arch——ClaudePage 收到同一个事件整表刷新侧栏，已归档视图开着就顺手重拉。
//
// 「某条会话现在算不算已归档」（当前会话的横条用），按新鲜程度：
//   ① hidden：本机刚点了归档、服务端列表还没反映的（乐观）；
//   ② known：服务端按完整口径（含跟随 Desktop、自动归档后又活了、在跑的算活跃）判过的——GET /api/session 回的
//      archived、已归档列表 / 搜索结果里见过的、活跃列表里列着的；快照里这条记录一变就作废，退回 ③；
//   ③ 服务端快照里 bridge 自己的记录（ids / un）。
// 快照带 rev：乱序到达的旧快照（总线事件比 POST 响应晚到）不覆盖新的。
//
// 乐观隐藏的收尾：每条 hidden 记下「归档请求落定时的序号」（在途 = Infinity）。整表刷新回来时，
// 只有【请求发出时归档还没落定】的才算「服务端还没反映」继续藏；之后发出的列表里还有它 = 服务端说它是活跃的
//（被跳过、刚被别处取消归档），放出来。取消归档时直接摘掉。
import { api } from './api.js';
import { busOn } from './bus.js';

const PAGE = 30;

export const arch = $state({
  hidden: {},       // 本机刚归档、服务端列表还没回来的 id → 落定序号（在途 Infinity）
  rev: 0,           // 归档态变了（本机或别处）
  count: 0,         // 已归档总数（/api/sessions 的 archivedCount）
  view: false,      // 侧栏正显示「已归档」列表
  rows: [],         // 已归档列表（按归档时间倒序）
  total: 0,
  more: false,
  loading: false,
  ids: {},          // 服务端快照里 bridge 记的已归档 id → { at, reason }
  un: {},           // 服务端快照里取消过归档的 id（盖过跟随 Desktop 的归档）
  known: {},        // 服务端按完整口径判过的：id → true（已归档）/ false（活跃）
});

// 归档态的变化序号（非响应式）：本机请求落定、快照里有记录变了都 +1。列表请求发出前取一次，回来时比对。
let clock = 0;
export const archClock = () => clock;
let srvRev = -1;
let seq = 0;
const touchedAt = new Map();   // id → 快照里它的记录最近一次变化的时刻（迟到的单条加载结果不覆盖它）

const sameRec = (a, b) => (!a && !b) || (!!a && !!b && (a === b || (a.at === b.at && a.reason === b.reason)));
function takeSnapshot(a) {
  if (!a || typeof a !== 'object') return;
  const rev = Number(a.rev);
  // 迟到的旧快照不要（rev 倒退很多 = 服务端记录被重置过，照收）
  if (Number.isFinite(rev) && rev < srvRev && srvRev - rev < 20) return;
  if (Number.isFinite(rev)) srvRev = rev;
  const nextIds = a.archived && typeof a.archived === 'object' ? a.archived : {};
  const nextUn = a.unarchived && typeof a.unarchived === 'object' ? a.unarchived : {};
  const changed = [];
  for (const id of new Set([...Object.keys(arch.ids), ...Object.keys(nextIds)])) if (!sameRec(arch.ids[id], nextIds[id])) changed.push(id);
  for (const id of new Set([...Object.keys(arch.un), ...Object.keys(nextUn)])) if (arch.un[id] !== nextUn[id] && !changed.includes(id)) changed.push(id);
  arch.ids = { ...nextIds };
  arch.un = { ...nextUn };
  if (!changed.length) return;
  clock++;
  const now = Date.now();
  const known = { ...arch.known };
  const hidden = { ...arch.hidden };
  for (const id of changed) {
    touchedAt.set(id, now);
    delete known[id];
    // 已落定的乐观隐藏：更新的快照里它是「取消过、没归档」= 别处取消了归档，放出来
    if (hidden[id] && hidden[id] !== Infinity && nextUn[id] && !nextIds[id]) delete hidden[id];
  }
  arch.known = known;
  arch.hidden = hidden;
  if (touchedAt.size > 2000) for (const k of [...touchedAt.keys()].slice(0, 1000)) touchedAt.delete(k);
}
/**
 * 服务端归档记录的版本（/api/sessions 与总线 hello 带的 archiveRev）比手上的快照新：断线期间别处归档 / 取消归档过，
 * 拉一份快照（GET /api/claude/archive）。返回是否对不上（调用方据此整表重拉列表）。
 */
let syncing = null;
export function noteArchiveRev(rev) {
  rev = Number(rev);
  if (!Number.isFinite(rev) || rev === srvRev || (rev < srvRev && srvRev - rev < 20)) return false;
  if (rev === 0 && srvRev < 0) { srvRev = 0; return false; }   // 服务端从没记过：不必拉
  syncing ||= api.get('/api/claude/archive')
    .then((r) => { takeSnapshot(r?.archive); arch.rev++; })
    .catch(() => {})
    .finally(() => { syncing = null; });
  return true;
}

busOn((ev) => {
  if (ev && ev.type === 'hello') { noteArchiveRev(ev.archiveRev); return; }
  if (!ev || ev.type !== 'archive') return;
  // basis：判定依据变了（切了「跟随 Claude Desktop 的归档」/ Desktop 血缘首轮扫完或那边归档变了）——按旧口径记下的单条判定作废
  if (ev.basis) { arch.known = {}; clock++; }
  takeSnapshot(ev.archive);
  arch.rev++;
  if (arch.view) loadArchived(false, { keep: true });   // 别处改了：按已展开的条数重拉，不缩回第一页
});

/** 这条会话眼下是不是已归档（见文件头的三级口径）。 */
export function isArchivedId(id) {
  if (!id) return false;
  if (arch.hidden[id]) return true;
  if (id in arch.known) return arch.known[id];
  if (arch.ids[id]) return true;
  return false;
}
/** 记下服务端对某条会话的判定（已归档列表 / 搜索结果 / 单条加载）。 */
export function noteArchivedState(id, on) {
  if (!id || arch.known[id] === !!on) return;
  arch.known = { ...arch.known, [id]: !!on };
}
/** 从搜索结果打开一条标着已归档的会话：记下来，横条才认得它。 */
export const markArchivedSeen = (id) => noteArchivedState(id, true);

/**
 * GET /api/session 的结果（chat.svelte.js 的 loadSession 调）：服务端回了 archived 就记下。
 * 快照里这条记录刚变过（5s 内，多半是这次请求在路上时别处改的）就不覆盖——快照更新。
 */
export function noteSessionArchived(id, data) {
  if (!id || !data || typeof data.archived !== 'boolean') return;
  const t = touchedAt.get(id);
  if (t && Date.now() - t < 5000) return;
  noteArchivedState(id, data.archived);
}

/**
 * /api/sessions 回来了：记已归档总数；放下服务端已经反映了的乐观项。
 * since = 发请求前的 archClock()：请求在路上时归档态没再变过，列着的会话就都记成「活跃」。
 */
export function noteSessionList(d, since = clock) {
  if (!d || typeof d !== 'object') return;
  if (Number.isFinite(d.archivedCount)) arch.count = d.archivedCount;
  noteArchiveRev(d.archiveRev);
  const listed = new Set((d.sessions || []).map((s) => s.id));
  const keep = {};
  for (const [id, at] of Object.entries(arch.hidden)) {
    if (at === Infinity) { keep[id] = at; continue; }      // 请求还在路上
    if (listed.has(id) && at > since) keep[id] = at;       // 列表请求先于归档落定：服务端还没反映
  }
  arch.hidden = keep;
  if (since === clock) {
    let known = null;
    for (const id of listed) if (arch.known[id] !== false && !keep[id]) (known ||= { ...arch.known })[id] = false;
    if (known) arch.known = known;
  }
}

export const isHidden = (id) => !!arch.hidden[id];
/**
 * bridge 里手动 / PR 归档的会话：之后在 Desktop / CLI 里接着写也仍算已归档（只有经 bridge 发消息才取消）。
 * 它的 session.touch 不必为「列表里没有它」整表重拉——拉回来也还是没有。自动归档（inactive）的不算：
 * 文件一变长服务端就当它又活了，得重拉才回得来。
 */
export const stickyArchived = (id) => !!id && !!arch.ids[id] && arch.ids[id].reason !== 'inactive' && arch.known[id] !== false;

/**
 * 归档 / 取消归档。乐观：归档的先藏、取消归档的先从已归档列表摘掉；服务端跳过的（在工作）放回来。
 * opts.detach：「仅归档此会话」——它的子会话移到顶层。返回 { skipped }；失败回滚并抛给调用方提示。
 */
export async function setArchivedIds(ids, on, { detach = false } = {}) {
  ids = [...new Set(ids)].filter(Boolean);
  if (!ids.length) return { skipped: [] };
  const prev = { rows: arch.rows, count: arch.count, total: arch.total, known: arch.known };
  const now = Date.now();
  for (const id of ids) touchedAt.set(id, now);
  if (on) {
    arch.hidden = { ...arch.hidden, ...Object.fromEntries(ids.map((id) => [id, Infinity])) };
    arch.count += ids.length;
  } else {
    const h = { ...arch.hidden };
    for (const id of ids) delete h[id];
    arch.hidden = h;
    arch.rows = arch.rows.filter((r) => !ids.includes(r.id));
    arch.count = Math.max(0, arch.count - ids.length);
    arch.total = Math.max(0, arch.total - ids.length);
    arch.known = { ...arch.known, ...Object.fromEntries(ids.map((id) => [id, false])) };
  }
  clock++;
  try {
    const r = await api.post('/api/claude/archive', { ids, on, ...(on && detach ? { detach: true } : {}) });
    const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
    if (on) {
      const done = ++clock;
      const h = { ...arch.hidden };
      for (const id of ids) if (h[id] === Infinity) { if (skipped.includes(id)) delete h[id]; else h[id] = done; }
      arch.hidden = h;
      if (skipped.length) arch.count = Math.max(0, arch.count - skipped.length);
    }
    takeSnapshot(r?.archive);
    arch.rev++;
    return { skipped };
  } catch (e) {
    if (on) {
      const h = { ...arch.hidden };
      for (const id of ids) if (h[id] === Infinity) delete h[id];
      arch.hidden = h;
    }
    arch.rows = prev.rows; arch.count = prev.count; arch.total = prev.total; arch.known = prev.known;
    clock++;
    throw e;
  }
}

/** 归档一个项目里的全部活跃会话（收藏的不动、在工作的跳过）。返回 { count, skipped }。 */
export async function archiveProject(projectId) {
  const r = await api.post('/api/claude/archive', { projectId, on: true });
  takeSnapshot(r?.archive);
  clock++;
  arch.rev++;
  return { count: Number(r?.count) || 0, skipped: Array.isArray(r?.skipped) ? r.skipped : [] };
}

/** 拉已归档列表：more=true 接着往后翻一页；keep=true 从头重拉、条数不少于已展开的。 */
export async function loadArchived(more = false, { keep = false } = {}) {
  const my = ++seq;
  arch.loading = true;
  try {
    const offset = more ? arch.rows.length : 0;
    const limit = keep ? Math.min(200, Math.max(PAGE, arch.rows.length)) : PAGE;
    const d = await api.get(`/api/sessions?view=archived&offset=${offset}&limit=${limit}`);
    if (my !== seq) return;
    const rows = Array.isArray(d?.sessions) ? d.sessions : [];
    arch.rows = more ? [...arch.rows, ...rows.filter((r) => !arch.rows.some((x) => x.id === r.id))] : rows;
    arch.total = Number(d?.total) || arch.rows.length;
    arch.more = !!d?.more;
    arch.count = arch.total;
    takeSnapshot(d?.archive);
    if (rows.length) arch.known = { ...arch.known, ...Object.fromEntries(rows.map((r) => [r.id, true])) };
  } catch {
    // 网络不通：保留已有内容
  } finally { if (my === seq) arch.loading = false; }
}

export function openArchivedView() { arch.view = true; loadArchived(); }
export function closeArchivedView() { arch.view = false; }
/** 删会话后从已归档列表摘掉（本机删的、总线 session.gone 报来别处删的）。 */
export function dropArchivedRow(id) {
  if (id in arch.known) { const known = { ...arch.known }; delete known[id]; arch.known = known; }
  if (arch.hidden[id]) { const h = { ...arch.hidden }; delete h[id]; arch.hidden = h; }
  if (!arch.rows.some((r) => r.id === id)) return;
  arch.rows = arch.rows.filter((r) => r.id !== id);
  arch.total = Math.max(0, arch.total - 1);
  arch.count = Math.max(0, arch.count - 1);
}
/** 换人 / 退出。 */
export function resetArchive() {
  seq++; clock++; srvRev = -1; touchedAt.clear(); syncing = null;
  arch.hidden = {}; arch.count = 0; arch.view = false; arch.rows = []; arch.total = 0; arch.more = false; arch.loading = false;
  arch.ids = {}; arch.un = {}; arch.known = {};
}
