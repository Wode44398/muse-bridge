// 工作区人机协同的两条上行口子（下行都走聊天轮的 gen SSE，见 runtime/ui-state.mjs）：
//   POST /api/ui/state  — 前端防抖上报「用户此刻在看什么」（dock/文件面板/预览状态）
//   POST /api/ui/answer — 前端应答 agent 的 wsx 请求（截图 base64 / 草稿文本）
// 鉴权：requireCtx（share 401；snap 允许——快照页也有工作台，访客视图对快照里的
// Claude 同样有用）。answer 按发起时的身份 key 校验，跨身份答不进来。

import { readBody } from '../runtime/body.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { noteUiState, answerUiRequest } from '../runtime/ui-state.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

export function registerUiStateRoutes(router, { identify }) {
  router.on('POST', '/api/ui/state', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return json(res, 400, { error: 'bad body' }); }
    const clientId = String(body?.clientId || '').slice(0, 64);
    if (!clientId) return json(res, 400, { error: 'clientId required' });
    noteUiState(ctx.key, clientId, String(body?.client || 'web').slice(0, 24), body?.state && typeof body.state === 'object' ? body.state : {});
    json(res, 200, { ok: true });
  });

  // 截图应答带 base64 图片，放宽到 16MB。
  router.on('POST', '/api/ui/answer', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req, 16 * 1024 * 1024)); } catch { return json(res, 400, { error: 'bad body' }); }
    const id = String(body?.id || '');
    if (!id) return json(res, 400, { error: 'id required' });
    const ok = answerUiRequest(ctx.key, id, body?.result && typeof body.result === 'object' ? body.result : {});
    json(res, 200, { ok });   // ok:false = 过期/未知请求（重放的旧事件），前端静默忽略即可
  });
}
