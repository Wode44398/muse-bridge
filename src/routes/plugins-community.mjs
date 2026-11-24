// 社区插件市场的发布接口（只给服务器主机，server.manage）——设置 › 扩展 › 功能扩展 › 插件详情的「发布到社区」：
//   GET  /api/plugins/community/account          现在用哪个 GitHub 账号（gh / 设备码 / 令牌）、能用哪些登录方式
//   POST /api/plugins/community/login/start      设备码登录第一步 → { userCode, verificationUri, interval }
//   POST /api/plugins/community/login/poll       轮询 → { status: pending | ok | expired | denied | error }
//   POST /api/plugins/community/token {token}    粘贴令牌（public_repo）
//   POST /api/plugins/community/logout
//   POST /api/plugins/community/check {id, notes?, nameEn?, descriptionEn?}    本地预检（与市场 CI 同一份规则）
//   POST /api/plugins/community/publish {同上}   提交成拉取请求 → { pr, number, version, report }
//   GET  /api/plugins/community/submission?id=   投稿状态 → { status: none | checking | failed | merged | live | closed | unknown, … }
// 令牌只在服务端用，绝不回给前端。
import { PluginError } from '../plugins/discover.mjs';
import { accountView, startDeviceLogin, pollDeviceLogin, saveToken, logout, precheck, publishToCommunity, submissionStatus } from '../plugins/market/publish.mjs';

export function registerCommunityRoutes(router, { kernel, admin, body, json, fail }) {
  const route = (method, p, fn) => router.on(method, p, async (req, res, url) => {
    if (!admin(req, res)) return;
    try { json(res, 200, await fn(method === 'GET' ? {} : await body(req), url)); }
    catch (e) { if (e?.report) json(res, e.status || 400, { error: String(e.message || e), report: e.report }); else fail(res, e); }
  });
  const opts = (b) => ({ notes: String(b.notes || '').slice(0, 2000), nameEn: String(b.nameEn || '').slice(0, 60), descriptionEn: String(b.descriptionEn || '').slice(0, 500) });
  const idOf = (b) => { const id = String(b.id || ''); if (!id) throw new PluginError(400, '要 id'); return id; };

  route('GET', '/api/plugins/community/account', () => accountView());
  route('POST', '/api/plugins/community/login/start', () => startDeviceLogin());
  route('POST', '/api/plugins/community/login/poll', () => pollDeviceLogin());
  route('POST', '/api/plugins/community/token', (b) => saveToken(b.token));
  route('POST', '/api/plugins/community/logout', () => logout());
  route('POST', '/api/plugins/community/check', async (b) => {
    const r = await precheck(kernel, idOf(b), opts(b));
    return { report: r.report, login: r.login, upstream: r.upstream, files: r.files.length + 1 };
  });
  route('POST', '/api/plugins/community/publish', async (b) => {
    return publishToCommunity(kernel, idOf(b), opts(b));
  });
  route('GET', '/api/plugins/community/submission', (b, url) => submissionStatus(String(url.searchParams.get('id') || '')));
}
