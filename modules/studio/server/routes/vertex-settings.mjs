// 旧的 /api/vertex/settings（管理员）：老版设置页 / 老 apk 还在调。2026-11-04 起这几项归 Media Studio
// （src/runtime/studio-settings.mjs，新接口 /api/studio/settings）；这里照旧收发 { values, changed }，读写的是同一份。
//
//   GET  /api/vertex/settings   { ok, values, changed }
//   POST /api/vertex/settings   { values: { 键: 值 | null（恢复默认） } } → 同上；任一项不合法整批不改
//
// 门禁：admin 身份，可远程；写操作受全局 Origin 闸保护。

import { readBody } from '@bridge/core/runtime/body.mjs';
import { vertexSettingsSnapshot, setVertexSettings } from '@bridge/core/runtime/vertex-settings.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

export function registerSettingsRoutes(router, { identify }) {
  const gate = (req, res) => {
    const id = identify(req);
    if (id && id.kind === 'admin') return true;
    json(res, id && id.kind !== 'none' ? 403 : 401, { ok: false, error: '媒体设置仅对管理员开放' });
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
