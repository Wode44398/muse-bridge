// Vertex (Gemini) sidecar endpoints — conversation list / get / delete, scoped to
// the caller's own vertex-history dir. The runChat path lives in agents/vertex.mjs.

import { readBody } from '@bridge/core/runtime/body.mjs';
import * as vertexHist from '../vertex-history.mjs';
import { requireCtx } from '@bridge/core/runtime/identity.mjs';

export function registerVertexHistoryRoutes(router, { authOk, identify }) {
  // Auth + per-identity context resolution is shared in requireCtx (runtime/identity.mjs).

  router.on('GET', '/api/vertex/sessions', (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: vertexHist.listConversations(ctx.vertexHist) }));
  });

  router.on('GET', '/api/vertex/session', (req, res, url) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const data = vertexHist.loadConversation(url.searchParams.get('id') || '', ctx.vertexHist);
    if (!data) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  });

  router.on('POST', '/api/vertex/session/delete', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const ok = vertexHist.removeConversation(String(body.id || ''), ctx.vertexHist);
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
  });
}
