// Claude 会话归档的读侧与自动归档（2026-10-20，对齐官方 Claude Desktop 的 Archive / AutoArchiveEngine）。
// 存储契约在 session-archive.mjs（按身份 claude-session-archive.json），这里只做：
//
//  ① 状态合成 archiveView(ctx)(id, mtime, size)：bridge 显式记录优先（归档过 → 已归档；取消过 → 未归档）；
//     没记过时，「跟随 Claude Desktop 的归档」开着（仅管理员、默认开）且该会话在 Desktop 里 isArchived → 已归档。
//     几处例外：
//       · 自动归档（reason 'inactive'）之后 transcript 又有了新活动（Desktop / CLI 里接着聊，不经 bridge）
//         → 「不活跃」这个前提没了，视为未归档；那条记录由 dropStaleInactive 顺手清掉，之后闲够了还能再自动归档。
//         「新活动」= 文件比归档那一刻变长了（session-activity.mjs 记的大小）；只有 mtime 变了不算（整批 touch）。
//         手动归档、PR 归档不受影响：之后在 Desktop / CLI 里续聊也仍算已归档，只有经 bridge 发消息才取消。
//       · Desktop 的归档：bridge 里在 Desktop 最后一次碰它（lastActivityAt / lastFocusedAt）之后还聊过
//         （session-activity.mjs 的 turns）→ 不跟随。Desktop 看不见 bridge 的续聊，它的「N 天不活跃自动归档」
//         会把手机上昨天还在聊的会话归档掉。
//       · bridge 里取消过归档、之后又在 Desktop 里被人碰过（取消归档再归档、接着聊完再归档：lastActivityAt /
//         lastFocusedAt 晚于 bridge 取消归档的时刻）且 Desktop 现在是已归档 → 重新跟随 Desktop。
//  ② 手动归档 archiveSessions：在跑 / 在等回答的会话不归档（官方同款），其余照写并推总线 {type:'archive'}。
//  ③ 自动归档：autoArchiveDays>0 时每小时扫一遍：N 天无活动（transcript mtime）、不在跑、没有待回答的卡、
//     没有排队消息、没有等着的限额续跑、不是收藏（官方 pinned 豁免）、子会话都不在跑、用户没取消归档过、
//     最近 15 分钟内没有设备开着它（官方 on_screen；前端经 /api/ui/state 上报 claudeOpen）→ 归档
//    （reason 'inactive'）。被挡下的原因不出界面。
//  ④ 真人在一个已归档的会话里接着发消息 → 自动取消归档（官方是把消息扣着、先让人点「取消归档」；
//     bridge 简化成「发了就是要接着用」，见 unarchiveOnTurn）。
import { getArchiveState, setArchived, forgetArchived } from './session-archive.mjs';
import { claudeSetting } from './claude-settings.mjs';
import { lineageFor, onDesktopLineageChange } from './desktop-lineage.mjs';
import { sessionLineage } from './session-lineage.mjs';
import { getLiveGens } from './gen.mjs';
import { sessionQuestions } from './questions.mjs';
import { peerHoldSessions } from './session-peers.mjs';
import { listQueue } from './claude-queue.mjs';
import { getLimitResume } from './limit-resume.mjs';
import { getLibrary } from './session-library.mjs';
import { busPublish } from './bus.mjs';
import { listSessionFiles, listSessionFilesAsync } from './session-list.mjs';
import { getUiState } from './ui-state.mjs';
import { getActivity, noteBridgeTurn, noteArchivedSizes, forgetActivity } from './session-activity.mjs';

// Desktop 血缘后台扫完（冷启动首轮 / Desktop 里归档或取消归档了）：推一帧 archive 让侧栏整表重拉。
// basis = 判定依据变了（不是 bridge 自己的归档记录变了）：前端清掉按旧口径记下的单条判定。
onDesktopLineageChange((ctx, { cold, archivedChanged }) => {
  if (!cold && !(archivedChanged && claudeSetting(ctx, 'followDesktopArchive'))) return;
  busPublish(ctx.key, { type: 'archive', archive: getArchiveState(ctx), basis: true });
});

const DAY = 86_400_000;
// 自动归档之后 transcript 再被写过多少才算「又有活动」：归档那一刻 CLI 收尾时可能还在补写尾部，留一分钟余量
const STALE_SLACK = 60_000;

/**
 * 自动归档的记录是不是已经作废（之后又有了活动）：mtime 晚于归档时刻一分钟以上，且——记过归档那一刻的大小时——
 * 文件大小也变了（只改 mtime 的整批 touch 不算）。没记过大小的老记录退回只看 mtime。
 */
function staleInactive(a, mtime, size, base) {
  if (!a || a.reason !== 'inactive') return false;
  if (!(Number(mtime) > (Number(a.at) || 0) + STALE_SLACK)) return false;
  if (Number.isFinite(base) && size !== undefined && size !== null && Number.isFinite(Number(size))) return Number(size) !== base;
  return true;
}

/**
 * id（, mtime, size）→ null（未归档）| { reason:'manual'|'inactive'|'pr_closed'|'desktop', at }。一次请求内复用。
 * mtime / size = transcript 的修改时间与大小（知道就传：自动归档之后又有活动的视为未归档）。
 */
export function archiveView(ctx) {
  const st = getArchiveState(ctx);
  const follow = !!ctx && ctx.kind === 'admin' && !ctx.snap && claudeSetting(ctx, 'followDesktopArchive') !== false;
  const desk = follow ? lineageFor(ctx).archived : null;
  const act = getActivity(ctx);
  return (id, mtime, size) => {
    const a = st.archived[id];
    if (a) return staleInactive(a, mtime, size, act.sizes[id]) ? null : { reason: a.reason || 'manual', at: Number(a.at) || 0 };
    const un = st.unarchived[id];
    if (desk && desk.has(id)) {
      const touched = typeof desk.get === 'function' ? Number(desk.get(id)) || 0 : 0;
      // bridge 里在 Desktop 最后一次碰它之后还聊过：Desktop 的归档（多半是按它自己看到的活动自动归档的）不跟随
      if ((Number(act.turns[id]) || 0) > touched) return null;
      if (!un || touched > (Number(un) || 0)) return { reason: 'desktop', at: 0 };
    }
    return null;
  };
}

/** 单条会话的归档态（GET /api/session 用，与列表同一口径：在跑 / 在问的一律算活跃）。快照访客不给字段。 */
export function sessionArchiveFlag(ctx, id, mtime, size) {
  if (!ctx || ctx.snap || !ctx.dataDir || !id) return {};
  if (getLiveGens(ctx.key).some((g) => g.sessionId === id) || sessionQuestions.hasFor(id, ctx.key)) return { archived: false };
  const a = archiveView(ctx)(id, mtime, size);
  return a ? { archived: true, archivedReason: a.reason } : { archived: false };
}

/** 这个身份眼下「在工作」的会话：有一轮在跑（含挂着后台任务的 bg_hold）、有提问 / 审批卡在等，或扣着别的会话发来的消息等你确认。 */
export function busySessionIds(ctx) {
  const out = new Set(getLiveGens(ctx.key).map((g) => g.sessionId).filter(Boolean));
  // 按身份取（条目上的字段是 ownerKey——以前读的 q.key 恒为空，等于把全服在问的会话都算成这个身份的）
  for (const sid of sessionQuestions.keysFor(ctx.key)) out.add(sid);
  for (const sid of peerHoldSessions(ctx.key)) out.add(sid);   // 自动归档了，横条跟着藏进已归档，人就看不到有消息在等
  return out;
}

/** 最近 15 分钟内有设备正开着的会话（前端视图上报的 claudeOpen；ui-state 十倍陈旧即清）。 */
export function onScreenIds(ctx) {
  const out = new Set();
  try {
    for (const r of getUiState(ctx.key)) {
      const open = r.state && r.state.claudeOpen;
      if (Array.isArray(open)) for (const id of open) if (typeof id === 'string') out.add(id);
    }
  } catch {}
  return out;
}

/**
 * 手动归档 / 取消归档。on=true 时跳过在工作的会话（返回 skipped）。有变化推总线。
 * → { changed, archive, skipped:[id] }
 */
export function archiveSessions(ctx, ids, on, { reason = 'manual' } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))];
  const busy = on ? busySessionIds(ctx) : new Set();
  const ok = list.filter((id) => !busy.has(id));
  const skipped = list.filter((id) => busy.has(id));
  const r = ok.length ? setArchived(ctx, ok, on, { reason }) : { changed: false, archive: getArchiveState(ctx) };
  if (r.changed) busPublish(ctx.key, { type: 'archive', archive: r.archive });
  return { ...r, skipped };
}

/**
 * 真人经 bridge 在一条会话里开了新一轮（自动续跑 / 派生唤醒不算；claude.mjs 每轮都调）：
 *  · 先无条件记下这一刻（session-activity.mjs 的 turns）——之后 Desktop 再按它自己看到的活动把它自动归档，不跟随；
 *  · 已归档的 → 取消归档。自动归档（不活跃）的只是「又活了」：清掉记录、不记「取消过」，以后再闲够了照样
 *    自动归档；手动归档 / 跟随 Desktop 的才记成取消归档（不然 Desktop 那边一跟随又藏回去）。
 */
export function unarchiveOnTurn(ctx, sid) {
  try {
    if (!ctx || ctx.snap || !ctx.dataDir || !sid) return;
    const a = archiveView(ctx)(sid);
    noteBridgeTurn(ctx, sid);
    if (!a) return;
    if (a.reason === 'inactive') {
      const snap = forgetArchived(ctx, sid);
      forgetActivity(ctx, sid, { turns: false });
      if (snap) busPublish(ctx.key, { type: 'archive', archive: snap });
      return;
    }
    archiveSessions(ctx, [sid], false);
  } catch {}
}

/**
 * 自动归档之后又有了新活动的记录：清掉（不记「取消过」——它只是又活了，以后闲够了照样自动归档）。
 * files = [{ id, mtime, size }]。有清掉的就推总线，返回清掉的 id。
 */
export function dropStaleInactive(ctx, files) {
  if (!ctx || ctx.snap || !ctx.dataDir) return [];
  const st = getArchiveState(ctx);
  const act = getActivity(ctx);
  const stale = [];
  for (const f of files || []) if (staleInactive(st.archived[f.id], f.mtime, f.size, act.sizes[f.id])) stale.push(f.id);
  let snap = null;
  for (const id of stale) { snap = forgetArchived(ctx, id) || snap; forgetActivity(ctx, id, { turns: false }); }
  if (snap) busPublish(ctx.key, { type: 'archive', archive: snap });
  return stale;
}

/** 自动归档的候选（纯判定，不写）。files 可传入（单测 / 复用一次扫盘）。 */
export function autoArchiveCandidates(ctx, { now = Date.now(), files } = {}) {
  const days = Number(claudeSetting(ctx, 'autoArchiveDays')) || 0;
  if (!days || !ctx?.dataDir || ctx.snap) return [];
  const cutoff = now - days * DAY;
  const list = files || listSessionFiles(ctx).files;
  const st = getArchiveState(ctx);
  const view = archiveView(ctx);
  const busy = busySessionIds(ctx);
  const onScreen = onScreenIds(ctx);
  const stars = new Set(getLibrary(ctx).stars || []);
  // 子会话还在工作：它的各级父会话都先不归档（官方 live_children）
  const { parentOf } = sessionLineage(ctx);
  const heldUp = new Set();
  for (const b of busy) {
    let cur = b;
    for (let i = 0; i < 32; i++) {
      const p = parentOf.get(cur);
      if (!p || heldUp.has(p)) break;
      heldUp.add(p); cur = p;
    }
  }
  const out = [];
  for (const f of list) {
    if (!f.mtime || f.mtime > cutoff) continue;
    if (st.unarchived[f.id] || view(f.id, f.mtime, f.size)) continue;
    if (busy.has(f.id) || heldUp.has(f.id) || stars.has(f.id) || onScreen.has(f.id)) continue;
    if (listQueue(ctx.key, f.id).length) continue;
    const lr = getLimitResume(ctx.key, f.id);
    if (lr && lr.armed) continue;
    out.push(f.id);
  }
  return out;
}

/** 扫一个身份：先清掉又活过来的自动归档记录，再把候选批量归档（reason 'inactive'）。返回归档了几条。 */
export function sweepAutoArchive(ctx, opts = {}) {
  const files = opts.files || listSessionFiles(ctx).files;
  dropStaleInactive(ctx, files);
  const ids = autoArchiveCandidates(ctx, { ...opts, files });
  if (!ids.length) return 0;
  const r = archiveSessions(ctx, ids, true, { reason: 'inactive' });
  if (!r.changed) return 0;
  // 记下归档那一刻的大小：之后文件变长了才算「又有活动」（staleInactive）
  const done = new Set(ids.filter((id) => !r.skipped.includes(id)));
  noteArchivedSizes(ctx, files.filter((f) => done.has(f.id)));
  return done.size;
}

// —— 定时器：每小时扫一遍所有身份（管理员 + 账号库里没停用的用户）——
let timer = null;
export function startAutoArchive({ contexts, intervalMs = 3_600_000, firstDelayMs = 90_000 } = {}) {
  if (timer) return;
  const run = async () => {
    let list = [];
    try { list = typeof contexts === 'function' ? await contexts() : []; } catch {}
    for (const ctx of list) {
      try {
        // 扫盘走异步缓存版（session-list.mjs）：整点这一扫别把事件循环占住几百毫秒
        const { files } = await listSessionFilesAsync(ctx);
        const n = sweepAutoArchive(ctx, { files });
        if (n) console.log(`[archive] auto-archived ${n} inactive session(s) for ${ctx.key}`);
      } catch {}
    }
  };
  const first = setTimeout(() => { run(); timer = setInterval(run, intervalMs); timer.unref?.(); }, firstDelayMs);
  first.unref?.();
  timer = first;
}
export function stopAutoArchive() { if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; } }
