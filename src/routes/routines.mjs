// Scheduled routine endpoints: list / create / update / delete / run-now — each
// scoped to the CALLER's own routines (admin -> ROOT; user -> their .bridge). The
// runner + scheduler interval live in runtime/routines-runner.mjs.

import { readBody } from '../runtime/body.mjs';
import * as routines from '../routines.mjs';
import { runRoutine, routineRunning } from '../runtime/routines-runner.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { CLAUDE_MODELS, CLAUDE_EFFORTS, ULTRACODE } from '../config/capabilities.mjs';

// Validate the model / effort against the Claude whitelists; unknown values fall
// through to undefined so the routine stores null = "server default".
function engineFields(body) {
  return { agent: 'claude', model: CLAUDE_MODELS.has(body.model) ? body.model : undefined, effort: CLAUDE_EFFORTS.has(body.effort) ? body.effort : undefined, search: false };
}

// Ultracode（xhigh + 常驻动态工作流）不给无人值守的定时路由：Workflow 会派一群子 agent，成本没有上限、
// 也没人在看；保存时就拒绝（runner 侧 claudeEffortOptions 仍兜底翻译旧数据，不会把非法值塞给 SDK）。
const ULTRACODE_MSG = '定时路由不支持 Ultracode（无人值守跑动态工作流，成本不可控）。请改选 Extra 或 Max。';
function rejectUltracode(body, res) {
  if (body.effort !== ULTRACODE) return false;
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: ULTRACODE_MSG }));
  return true;
}

// 定时任务只跑 Claude：它对这个身份开着吗——全局开关 ∩ 按人授权，与聊天同口径。
function rejectAgent(ctx, body, res) {
  const other = body.agent !== undefined && body.agent !== 'claude';
  if (!other && ctx.allowClaude) return false;
  res.writeHead(other ? 400 : 403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: other ? '定时任务只支持 Claude' : 'Claude 未启用，或你的账号没有使用权限' }));
  return true;
}

export function registerRoutineRoutes(router, { authOk, identify }) {
  // Auth + per-identity context resolution is shared in requireCtx (runtime/identity.mjs).

  router.on('GET', '/api/routines', (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ routines: routines.list(ctx.dataDir), running: [...routineRunning] }));
  });

  router.on('POST', '/api/routines', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const prompt = String(body.prompt || '').trim();
    if (!prompt) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'prompt 不能为空' })); return; }
    if (rejectUltracode(body, res)) return;
    if (rejectAgent(ctx, body, res)) return;
    const r = routines.create(ctx.dataDir, { name: String(body.name || '').trim(), prompt, schedule: body.schedule, enabled: body.enabled, ...engineFields(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, routine: r }));
  });

  router.on('POST', '/api/routines/update', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    if (rejectUltracode(body, res)) return;
    if ('agent' in body && rejectAgent(ctx, body, res)) return;
    const patch = {};
    for (const k of ['name', 'prompt', 'schedule', 'enabled']) if (k in body) patch[k] = body[k];
    if ('agent' in body || 'model' in body || 'effort' in body || 'search' in body) Object.assign(patch, engineFields(body));
    const r = routines.update(ctx.dataDir, String(body.id || ''), patch);
    res.writeHead(r ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r ? { ok: true, routine: r } : { ok: false, error: 'not found' }));
  });

  router.on('POST', '/api/routines/delete', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const ok = routines.remove(ctx.dataDir, String(body.id || ''));
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
  });

  router.on('POST', '/api/routines/run', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const id = String(body.id || '');
    if (!routines.get(ctx.dataDir, id)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not found' })); return; }
    if (routineRunning.has(id)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, already: true })); return; }
    runRoutine(ctx, id); // fire-and-forget; progress/status visible via GET /api/routines
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}
