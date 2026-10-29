// 设置 › Agent › Gemini 上「Google 云凭据」下面那几组（管理员）：别的 agent 能不能生成媒体、能生成什么、内容安全过滤。
//
//   GET  /api/vertex/settings   { ok, values, changed }
//   POST /api/vertex/settings   { values: { 键: 值 | null（恢复默认） } } → 同上；任一项不合法整批不改
//
// 注册表 src/config/vertex-settings.mjs，存储与判定 src/runtime/vertex-settings.mjs。改动即时生效：
// Claude 的媒体工具与提示从下一条消息起换新（调用时还会再判一次），agent 接口的 media.* 当场按新值放行。
// 门禁同 /api/vertex/credentials：admin 身份，可远程；写操作受全局 Origin 闸保护。

import { readBody } from '@bridge/core/runtime/body.mjs';
import { vertexSettingsSnapshot, setVertexSettings } from '@bridge/core/runtime/vertex-settings.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

export function registerSettingsRoutes(router, { identify }) {
  const gate = (req, res) => {
    const id = identify(req);
    if (id && id.kind === 'admin') return true;
    json(res, id && id.kind !== 'none' ? 403 : 401, { ok: false, error: 'Vertex 设置仅对管理员开放' });
    return false;
  };

  router.on('GET', '/api/vertex/settings', (req, res) => {
    if (!gate(req, res)) return;
    json(res, 200, { ok: true, ...vertexSettingsSnapshot() });
  });

  router.on('POST', '/api/vertex/settings', async (req, res) => {
    if (!gate(req, res)) return;
    let b = {};
    try { b = JSON.parse(await readBody(req, 16_000)); } catch { return json(res, 400, { ok: false, error: '请求格式不对' }); }
    const r = setVertexSettings(b.values);
    json(res, r.ok ? 200 : 400, r);
  });
}
