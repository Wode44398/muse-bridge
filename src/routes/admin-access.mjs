// 成员自己的「管理员可见性」（开源路线 S2-7 / N13，runtime/admin-access.mjs）：
//   GET  /api/me/admin-access  —— 管理员回 { admin:true }；注册用户回 { consents, log, service }
//   POST /api/me/admin-access  —— { view?, assist?, device? }（布尔）：只能改自己的
// 两套设置外壳（手机 iOS 风 Settings.svelte、桌面 SettingsDesktop）的「账户 › 管理员可见性」用它。
import { readBody } from '../runtime/body.mjs';
import { consentsOf, setConsents, accessLog } from '../runtime/admin-access.mjs';

export function registerAdminAccessRoutes(router, { identify }) {
  const J = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };

  router.on('GET', '/api/me/admin-access', (req, res) => {
    const id = identify(req);
    if (id.kind === 'admin') return J(res, 200, { admin: true });
    if (id.kind !== 'user') return J(res, 401, { error: 'unauthorized' });
    const c = consentsOf(id.user);
    J(res, 200, { consents: { view: c.view, assist: c.assist, device: c.device }, at: c.at, service: c.service, log: accessLog(id.user, 50) });
  });

  router.on('POST', '/api/me/admin-access', async (req, res) => {
    const id = identify(req);
    if (id.kind === 'admin') return J(res, 400, { error: '管理员没有这项设置' });
    if (id.kind !== 'user') return J(res, 401, { error: 'unauthorized' });
    let b = {}; try { b = JSON.parse(await readBody(req)) || {}; } catch {}
    const r = setConsents(id.user, { view: b.view, assist: b.assist, device: b.device });
    if (r.error) return J(res, 400, r);
    const c = r.consents;
    J(res, 200, { ok: true, consents: { view: c.view, assist: c.assist, device: c.device }, at: c.at });
  });
}
