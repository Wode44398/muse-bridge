// 本机 Qwen Image 2.1 的部署管理（只有管理员）：/api/vertex/local-image/{status,start,stop,settings}。
// 生成走 Media Studio 的 local 方言（adapters/local.mjs，经任务执行器）；旧的 /api/vertex/image(-chat) 转接也走那儿。
import { requireCtx } from '@bridge/core/runtime/identity.mjs';
import { readBody } from '@bridge/core/runtime/body.mjs';
import { localImageStatus, controlLocalImage } from '../adapters/local-image.mjs';
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

export function registerLocalImageRoutes(router, { identify }) {
  for (const action of ['status', 'start', 'stop', 'settings']) {
    router.on(action === 'status' ? 'GET' : 'POST', `/api/vertex/local-image/${action}`, async (req, res) => {
      const ctx = requireCtx(identify, req, res); if (!ctx) return;
      if (identify(req).kind !== 'admin') return json(res, 403, { error: 'Only the administrator can manage the local image deployment' });
      try {
        const value = action === 'settings' ? JSON.parse(await readBody(req, 4096)) : undefined;
        const result = action === 'status' ? await localImageStatus() : await controlLocalImage(action, value);
        json(res, 200, { ok: true, ...result });
      } catch (error) { json(res, 400, { ok: false, error: error.message }); }
    });
  }
}

