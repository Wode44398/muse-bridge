// Antigravity 多代理与子代理转录 REST 路由：
//   GET  /api/agy/subagents?session=<sid>                       递归子代理树、实时状态与统计
//   GET  /api/agy/subagent-transcript?session=<sid>&agentId=<id>&from=<offset>  子代理增量转录（含提示词与工具调用）
//   POST /api/agy/subagents/sync                                手动立即同步后台唤醒进度（可选触发兜底唤醒）

import { acpFor } from '../acp/index.mjs';
import { isSessionDeleted } from '../sessions.mjs';
import { readSubagentTree, readSubagentTranscript } from '../subagents.mjs';
import { readSwarmSnapshot } from '../swarm.mjs';
import {
  armSubagentMonitor, isMonitorActive, syncSessionSubagents,
} from '../subagent-monitor.mjs';

const ID_RE = /^[0-9a-f-]{8,64}$/i;

export function registerAgySubagentRoutes(router, { agyCtx, parseJsonBody, sendJson }) {
  router.on('GET', '/api/agy/subagents', (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const sid = String(url.searchParams.get('session') || '').trim();
    if (!ID_RE.test(sid)) { sendJson(res, 400, { error: '无效的会话 id' }); return; }
    if (isSessionDeleted(ctx.agyDir, sid)) { sendJson(res, 404, { error: '这个对话已经删除' }); return; }

    const client = acpFor(ctx, sid);
    const tree = readSubagentTree(client.dataDir, sid);
    if (tree.hasActive || tree.hasAliveNonImage) {
      armSubagentMonitor(ctx, client, sid);
    }
    sendJson(res, 200, {
      ...tree,
      monitorActive: isMonitorActive(ctx.key, sid),
    }, { 'Cache-Control': 'no-store' });
  });

  router.on('GET', '/api/agy/swarm', (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const sid = String(url.searchParams.get('session') || '').trim();
    if (!ID_RE.test(sid)) { sendJson(res, 400, { error: '无效的会话 id' }); return; }
    if (isSessionDeleted(ctx.agyDir, sid)) { sendJson(res, 404, { error: '这个对话已经删除' }); return; }

    const client = acpFor(ctx, sid);
    const snap = readSwarmSnapshot(client.dataDir, sid);
    if (!snap.hasSwarm) {
      sendJson(res, 200, { sessionId: sid, hasSwarm: false, etag: '' }, { 'Cache-Control': 'no-store' });
      return;
    }
    if (snap.hasActive || (snap.hasLiveWorkers && !snap.finished)) {
      armSubagentMonitor(ctx, client, sid);
    }
    const wantEtag = String(url.searchParams.get('etag') || '').trim();
    if (wantEtag && wantEtag === snap.etag) {
      sendJson(res, 200, { sessionId: sid, hasSwarm: true, unchanged: true, etag: snap.etag }, { 'Cache-Control': 'no-store' });
      return;
    }
    sendJson(res, 200, snap, { 'Cache-Control': 'no-store' });
  });

  router.on('GET', '/api/agy/subagent-transcript', (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const sid = String(url.searchParams.get('session') || '').trim();
    const agentId = String(url.searchParams.get('agentId') || '').trim();
    if (!ID_RE.test(sid) || !ID_RE.test(agentId)) {
      sendJson(res, 400, { error: '无效的会话或子代理 id' });
      return;
    }
    if (isSessionDeleted(ctx.agyDir, sid)) { sendJson(res, 404, { error: '这个对话已经删除' }); return; }

    const client = acpFor(ctx, sid);
    const from = Number(url.searchParams.get('from') || 0);
    let data = null;
    try {
      data = readSubagentTranscript(client.dataDir, sid, agentId, { from });
    } catch (err) {
      sendJson(res, err?.status === 413 ? 413 : 500, { error: err?.message || '读取子代理转录失败' });
      return;
    }
    if (!data) {
      sendJson(res, 404, { error: '未找到该子代理记录' });
      return;
    }
    sendJson(res, 200, data, { 'Cache-Control': 'no-store' });
  });

  router.on('POST', '/api/agy/subagents/sync', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const sid = String(body.sessionId || body.session || '').trim();
    if (!ID_RE.test(sid)) { sendJson(res, 400, { error: '无效的会话 id' }); return; }
    if (isSessionDeleted(ctx.agyDir, sid)) { sendJson(res, 404, { error: '这个对话已经删除' }); return; }

    const client = acpFor(ctx, sid);
    try {
      const r = await syncSessionSubagents(ctx, client, sid, { wake: body.wake === true });
      sendJson(res, 200, { ok: true, ...r }, { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || '同步子代理进度失败' });
    }
  });
}
