// 用户自助（三端拆分 P4）：看自己的额度与用量、改自己的密码。
//   GET  /api/me/usage     —— 管理员回 { unlimited:true }；注册用户回生效额度、今天 / 最近 7 天用量、累计
//   POST /api/me/password  —— { old, password }：原密码对了才改；改完这个人别的设备全部下线，发起修改的这台保留
import { readBody } from '../runtime/body.mjs';
import * as users from '../users.mjs';
import { quotaState } from '../runtime/quota.mjs';

// 改密码要验原密码：已登录才能打到这里，但会话被人拿到时不能拿它无限次猜原密码——按账号计数，
// 10 分钟内错 5 次锁 10 分钟（内存里，重启清零）。
const wrong = new Map();   // name -> { n, until }
const LOCK_MS = 10 * 60 * 1000;

export function registerMeRoutes(router, { identify, getCookie, bearerToken }) {
  const J = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };

  router.on('GET', '/api/me/usage', (req, res) => {
    const id = identify(req);
    if (id.kind === 'admin') return J(res, 200, { unlimited: true });
    if (id.kind !== 'user') return J(res, 401, { error: 'unauthorized' });
    J(res, 200, { unlimited: false, ...quotaState(id.user), totals: users.getUsage(id.user) });
  });

  router.on('POST', '/api/me/password', async (req, res) => {
    const id = identify(req);
    if (id.kind === 'admin') return J(res, 400, { error: '管理员用访问令牌登录，没有密码可改' });
    if (id.kind !== 'user') return J(res, 401, { error: 'unauthorized' });
    const name = users.normName(id.user);
    const w = wrong.get(name);
    if (w && w.until > Date.now()) return J(res, 429, { error: '原密码错太多次，10 分钟后再试' });
    let b = {}; try { b = JSON.parse(await readBody(req)) || {}; } catch {}
    const pw = String(b.password || '');
    if (pw.length < 8) return J(res, 400, { error: '新密码至少 8 位' });
    const ok = await users.checkLogin(name, String(b.old || ''));
    if (ok.error) {
      let r = wrong.get(name);
      if (!r || (r.until && r.until <= Date.now())) r = { n: 0, until: 0 };   // 没记过 / 上一次锁已过期 → 重新数
      r.n++;
      if (r.n >= 5) { r.until = Date.now() + LOCK_MS; r.n = 0; }
      wrong.set(name, r);
      return J(res, 400, { error: '原密码不对' });
    }
    wrong.delete(name);
    const s = await users.setPassword(name, pw);
    if (s.error) return J(res, 400, s);
    users.deleteUserSessions(name, getCookie(req, 'bridge_user') || bearerToken(req));
    J(res, 200, { ok: true });
  });
}
