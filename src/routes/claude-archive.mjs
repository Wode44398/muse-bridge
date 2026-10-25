// Claude 分页：会话归档与全文搜索的接口（2026-10-20，对齐官方 Claude Desktop 的 Archive / 搜索会话）。
//
//   POST /api/claude/archive { ids:[会话 id], on:true|false, detach?:true }
//        → { ok, archive, skipped:[在工作、没归档的 id], count }；有变化推总线 {type:'archive', archive}
//        在跑 / 在等回答的会话不归档（官方同款）；取消归档的会话以后不再被自动归档。
//        ids 只认这个身份自己的会话（不是自己的、取消归档时本来就没归档的，一律忽略——记录不会被灌大）。
//        detach：「仅归档此会话」——它的直接子会话移到顶层（不再缩进挂在它下面、以后也不随它归档）。
//   POST /api/claude/archive { projectId, on:true }：归档这个项目里的全部活跃会话（官方 Archive all sessions in
//        "{group}"）；收藏的不动（官方 pinned 不受批量归档影响），在工作的跳过。
//        归档了的会话若有停放着的 CLI（续聊热进程，约 320MB、最多停 15 分钟）顺手关掉（官方归档时也停进程）。
//   GET  /api/claude/archive → { ok, archive }：bridge 的归档记录快照。前端发现列表 / hello 带的 archiveRev
//        与手上的对不上（断线期间别处改过）时拉一份。
//   GET  /api/claude/search?q=&limit=&archived=include|exclude|only
//        → { hits:[{ sessionId, title, projectId, project, snippet, matchAt, mtime, match, former?, archived, archivedReason? }],
//            partial, ms, indexed, total }
//        覆盖该身份能看到的所有项目、worktree 与已归档会话；正文只含用户 / 助手说的话（runtime/session-search.mjs）。
// 已归档列表走 GET /api/sessions?view=archived（routes/sessions.mjs，同一套行数据与标题链）。
// 只给登录身份（admin / user）：公开分享与聊天快照访客一律不开放（用不带快照的 identify，访客令牌直接 401）。
import path from 'node:path';
import { readBody } from '../runtime/body.mjs';
import { contextFor, userIdentity } from '../runtime/identity.mjs';
import { listUsers } from '../users.mjs';
import { DATA_ROOT } from '../runtime/paths.mjs';
import { archiveSessions, archiveView, startAutoArchive } from '../runtime/session-archive-auto.mjs';
import { searchSessions, configureSearchStore } from '../runtime/session-search.mjs';
import { listSessionFilesAsync } from '../runtime/session-list.mjs';
import { detachSessions, directChildren } from '../runtime/session-lineage.mjs';
import { getLibrary } from '../runtime/session-library.mjs';
import { readSessionTitle, trimTitle } from './sessions.mjs';
import { getArchiveState } from '../runtime/session-archive.mjs';
import { releaseWarmClaude } from '../agents/claude.mjs';

const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

export function registerClaudeArchiveRoutes(router, { identify }) {
  configureSearchStore(path.join(DATA_ROOT, 'claude-search-index.json'));
  const ctxOf = (req, res) => {
    const who = identify(req);
    if (!who || who.kind === 'none' || who.kind === 'share') { json(res, 401, { error: 'unauthorized' }); return null; }
    const ctx = contextFor(who);
    if (ctx.snap || !ctx.dataDir) { json(res, 403, { error: 'forbidden' }); return null; }
    return ctx;
  };

  router.on('POST', '/api/claude/archive', async (req, res) => {
    const ctx = ctxOf(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req, 256 * 1024)); } catch { return json(res, 400, { error: 'bad json' }); }
    const on = body?.on !== false;
    // 只认这个身份看得见的会话（快照桶那条常驻置顶，不归档）
    // 异步扫盘（不占事件循环）；不吃 2 秒缓存：刚建的会话也要认得（并发的扫盘照样合并）
    const { files, quickFiles } = await listSessionFilesAsync(ctx, { maxAge: 0 });
    const mine = new Map(files.map((f) => [f.id, f]));
    const quick = new Set(quickFiles.map((f) => f.id));
    const view = archiveView(ctx);
    let ids;
    if (on && typeof body?.projectId === 'string' && body.projectId) {
      const stars = new Set(getLibrary(ctx).stars || []);
      ids = files.filter((f) => f.projectId === body.projectId && !stars.has(f.id) && !view(f.id, f.mtime, f.size)).map((f) => f.id);
      if (!ids.length) return json(res, 200, { ok: true, archive: null, skipped: [], count: 0 });
    } else {
      ids = (Array.isArray(body?.ids) ? body.ids : [body?.id]).map((x) => String(x || '')).filter((x) => ID_RE.test(x)).slice(0, 500);
      if (!ids.length) return json(res, 400, { error: '没有要归档的会话' });
      // 取消归档只对眼下确实算已归档的写记录（unarchived 不会被随便灌大）
      ids = ids.filter((id) => (on ? mine.has(id) : (mine.has(id) || quick.has(id)) && !!view(id, mine.get(id)?.mtime, mine.get(id)?.size)));
    }
    try {
      const r = archiveSessions(ctx, ids, on);
      const done = on ? ids.filter((id) => !r.skipped.includes(id)) : [];
      // 「仅归档此会话」：真归档了的那几条，它们的直接子会话移到顶层（列表随 archive 事件整表重拉）
      if (on && body.detach === true && done.length) detachSessions(ctx, directChildren(ctx, done));
      // 停放着的续聊 CLI 关掉（不等它退干净；取消归档后再发消息就冷起，与过了停放期一样）
      for (const id of done) releaseWarmClaude(ctx.key, id).catch(() => {});
      json(res, 200, { ok: true, archive: r.archive, skipped: r.skipped, count: ids.length - r.skipped.length });
    } catch (e) {
      json(res, e?.status || 500, { error: String(e?.message || e) });
    }
  });

  router.on('GET', '/api/claude/archive', (req, res) => {
    const ctx = ctxOf(req, res); if (!ctx) return;
    json(res, 200, { ok: true, archive: getArchiveState(ctx) });
  });

  router.on('GET', '/api/claude/search', async (req, res, url) => {
    const ctx = ctxOf(req, res); if (!ctx) return;
    const q = String(url.searchParams.get('q') || '').slice(0, 200);
    const a = url.searchParams.get('archived');
    const archived = a === 'exclude' || a === 'only' ? a : 'include';
    try {
      const r = await searchSessions(ctx, q, { limit: Number(url.searchParams.get('limit')) || 30, archived, readFirst: readSessionTitle, trim: trimTitle });
      json(res, 200, { ok: true, q, ...r });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
  });
}

// 自动归档定时器（每小时扫所有身份：管理员 + 没停用的用户）。server.mjs 只在正式实例里起
//（测试实例要验时设 BRIDGE_AUTO_ARCHIVE=1，BRIDGE_AUTO_ARCHIVE_DELAY_MS 改首扫延迟）——两个进程写同一份
// claude-session-archive.json 会互相覆盖。
export function startClaudeAutoArchive(opts = {}) {
  startAutoArchive({
    firstDelayMs: Number(process.env.BRIDGE_AUTO_ARCHIVE_DELAY_MS) || undefined,
    ...opts,
    contexts: () => {
      const out = [contextFor({ kind: 'admin' })];
      for (const u of listUsers()) {
        if (u.disabled) continue;
        const id = userIdentity(u.name);
        if (id) out.push(contextFor(id));
      }
      return out;
    },
  });
}
