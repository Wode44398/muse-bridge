// Antigravity 会话管理路由：收藏 / 取消收藏、彻底删除、全文搜索。
// 隐藏（/api/agy/session/delete，可恢复）仍在 routes/agy.mjs；这里的「彻底删除」走 /api/agy/session/purge，不可恢复。

import { setSessionFavorite } from '../sessions.mjs';
import { deleteAgySession } from '../session-purge.mjs';
import { searchAgySessions } from '../transcript-search.mjs';
import { publishAgySessions } from '../presence.mjs';
import { stopSubagentMonitor } from '../subagent-monitor.mjs';

export function registerAgySessionManageRoutes(router, { agyCtx, parseJsonBody, sendJson }) {
  router.on('POST', '/api/agy/session/favorite', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const id = String(body.id || body.sessionId || '').trim();
    if (!id) { sendJson(res, 400, { error: '缺少会话 id' }); return; }
    const favorite = body.favorite !== false;
    const meta = setSessionFavorite(ctx.agyDir, id, favorite);
    if (!meta) { sendJson(res, 404, { error: '这个对话已经删除' }); return; }
    publishAgySessions(ctx, { sessionId: id, why: 'favorite' });
    sendJson(res, 200, { ok: true, favorite: !!meta.favorite });
  });

  router.on('POST', '/api/agy/session/purge', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const id = String(body.id || body.sessionId || '').trim();
    try {
      stopSubagentMonitor(ctx.key, id);
      const r = await deleteAgySession(ctx, id);
      publishAgySessions(ctx, { sessionId: r.sessionId, why: 'delete' });
      sendJson(res, 200, { ok: true, deleted: true, stopped: r.stopped, pendingFiles: r.pending.length });
    } catch (err) {
      sendJson(res, err?.status || 500, { ok: false, error: err?.message || '删除失败' });
    }
  });

  router.on('GET', '/api/agy/search', async (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const q = String(url.searchParams.get('q') || '').slice(0, 200);
    const limit = Number(url.searchParams.get('limit')) || 20;
    try {
      const r = await searchAgySessions(ctx, q, {
        limit,
        includeHidden: url.searchParams.get('includeHidden') === '1',
      });
      sendJson(res, 200, r, { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || '搜索失败' });
    }
  });
}
