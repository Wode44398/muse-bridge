// Auth surface. admin = access token (sets bridge_auth). user = username/password
// against the account store (sets bridge_user session cookie). Registration needs a
// single-use invite code. /api/auth reports the caller's identity to the page.

import { readBody } from '../runtime/body.mjs';
import * as users from '../users.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { EDITION, FEATURES } from '../config/index.mjs';
import { enabledAgents } from '../runtime/agent-status.mjs';
import { registrationOpen } from '../runtime/policy.mjs';
import { describeClient } from './pair.mjs';

// In-memory login throttle, resets on restart. 双键：按用户名（6 次/5 分钟，护账号）
// + 按来源 IP（20 次/15 分钟，防换用户名绕过的枚举/撞库——之前只按用户名计数，
// 攻击者每次换个名字就永远不会被锁）。
const fails = new Map(); // key -> { n, until, ts }
const RULES = { u: { max: 6, lock: 5 * 60 * 1000 }, ip: { max: 20, lock: 15 * 60 * 1000 } };
const ruleFor = (k) => (k.startsWith('ip:') ? RULES.ip : RULES.u);
const locked = (k) => { const r = fails.get(k); return !!r && r.until > Date.now(); };
function noteFail(k) {
  const rule = ruleFor(k);
  const r = fails.get(k) || { n: 0, until: 0 };
  r.n++; r.ts = Date.now();
  if (r.n >= rule.max) { r.until = Date.now() + rule.lock; r.n = 0; }
  fails.set(k, r);
  // 防 Map 无界增长（海量随机用户名/IP）：超 500 条时清掉过期 + 半小时无动静的。
  if (fails.size > 500) {
    const cut = Date.now() - 30 * 60 * 1000;
    for (const [key, v] of fails) if (v.until < Date.now() && (v.ts || 0) < cut) fails.delete(key);
  }
}
const clearFail = (k) => fails.delete(k);
// 真实来源 IP：cloudflared 隧道后 remoteAddress 恒为 127.0.0.1，优先取 CF/代理头。
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '');
}

export function registerAuthRoutes(router, { adminCredential, adminGen, identify, getCookie, bearerToken, authCookie, clearAuthCookie, userCookie, clearUserCookie }) {
  // "Who am I?" — the page polls this on load to decide login vs app.
  // 客户端不分版本，全靠这里告诉它：服务器是什么形态（edition）、这个身份能用哪些 agent（agents，
  // 统一 id，已与全局开关与按人授权取过交集）、有哪些功能（features）。没登录也回 edition/features，
  // 登录卡据此决定要不要摆「注册」。allow* 三个旧字段保留给旧前端。
  router.on('GET', '/api/auth', (req, res) => {
    const id = identify(req);
    const ctx = id.kind === 'none' ? null : contextFor(id);
    res.writeHead(id.kind === 'none' ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      kind: id.kind,
      user: id.user || null,
      tier: ctx?.tier || null,
      edition: EDITION,
      // 没登录时给全局已启用的名单：只开了一个 agent 的服务器，访客打开网址就该直接落在那一页的登录框上。
      agents: ctx ? ctx.agents : enabledAgents(),
      features: { multiUser: FEATURES.multiUser, register: registrationOpen(), remoteAdmin: FEATURES.remoteAdmin },
      canSnapshot: !!ctx?.canSnapshot,
      service: !!ctx?.service,
      allowDimensio: !!ctx?.allowDimensio,
    }));
  });

  // admin (token in header -> durable admin cookie) OR user (username/password).
  // 管理员：拿主令牌来登录 → 铸一张管理员会话（cookie + JSON token 都是它，客户端据此把本地存的主令牌
  // 换掉）；已经是管理员会话的（刷新 cookie）→ 原样续上；本机无鉴权控制台照旧。
  router.on('POST', '/api/login', async (req, res) => {
    const adm = adminCredential(req);
    if (adm) {
      if (adm.via === 'noauth') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, kind: 'admin' }));
        return;
      }
      const tok = adm.via === 'session' ? adm.token
        : users.createAdminSession({ gen: adminGen, label: describeClient(req.headers['user-agent']), ip: clientIp(req) });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': authCookie(req, tok) });
      res.end(JSON.stringify({ ok: true, kind: 'admin', token: tok }));
      return;
    }
    let body; try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const username = String(body.username || '').trim();
    const key = 'u:' + users.normName(username);
    const ipKey = 'ip:' + clientIp(req);
    if (locked(key) || locked(ipKey)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '登录尝试过多，请稍后再试' })); return; }
    const r = await users.checkLogin(username, String(body.password || ''));
    // 多用户关着：只有服务账号（程序用的账号）还能登；普通账号当作登录失败，
    // 文案不区分「没这个人」和「不让登」，免得借此探账号。
    if (!r.error && !FEATURES.multiUser && !users.userGrants(users.getUser(r.name)).service) r.error = '这台主机只接受访问令牌登录';
    if (r.error) {
      noteFail(key); noteFail(ipKey);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: r.error }));
      return;
    }
    clearFail(key);
    clearFail(ipKey);
    const tok = users.createSession(r.name);
    // token 一并回前端：网页靠 Set-Cookie，跨源客户端不带 cookie → 存 localStorage 当 Bearer。
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': userCookie(req, tok) });
    res.end(JSON.stringify({ ok: true, kind: 'user', user: r.name, token: tok }));
  });

  // Register with an invite code; auto-login on success.
  router.on('POST', '/api/register', async (req, res) => {
    if (!FEATURES.multiUser) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '这台主机不开放注册' })); return; }
    if (!registrationOpen()) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '注册已关闭，请联系管理员为你开账号' })); return; }
    // 限流：按来源 IP（复用登录的 20 次/15 分钟规则）——堵邀请码爆破（注册端点之前无任何限流）。
    const ipKey = 'ip:' + clientIp(req);
    if (locked(ipKey)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '注册尝试过多，请稍后再试' })); return; }
    let body; try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const password2 = String(body.password2 || '');
    const invite = String(body.invite || '').trim();
    const fail = (msg, code = 400) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };
    if (!users.validName(username)) return fail('用户名只能是 2-32 位的字母/数字/下划线/连字符，且不能以 _ 或 - 开头');
    if (password.length < 8) return fail('密码至少 8 位');
    if (password !== password2) return fail('两次输入的密码不一致');
    if (users.getUser(username)) return fail('该用户名已存在');
    // Consume the invite only after everything else validates, so a bad form
    // doesn't burn a code. createUser 若仍失败（极小概率竞态/校验），回滚邀请码。
    const tier = users.consumeInvite(invite, users.normName(username)); // 'pro' | 'user' | null
    if (!tier) { noteFail(ipKey); return fail('邀请码无效或已被使用'); }
    const c = await users.createUser(username, password, tier);
    if (c.error) { users.revertInvite(invite); return fail(c.error, 500); }
    clearFail(ipKey);
    const tok = users.createSession(c.name);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': userCookie(req, tok) });
    res.end(JSON.stringify({ ok: true, kind: 'user', user: c.name, token: tok }));
  });

  router.on('POST', '/api/logout', (req, res) => {
    // 跨源登出不带 cookie → 也认 Bearer 里的 session token，确保后端真正删除会话。
    const tok = getCookie(req, 'bridge_user') || bearerToken(req);
    if (tok) users.deleteSession(tok);
    // 管理员会话登出 = 吊销这一张（主令牌本身登不出去，也不需要）。
    const adm = adminCredential(req);
    if (adm && adm.via === 'session') users.revokeAdminSessions([users.adminSessionIdOf(adm.token)]);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': [clearAuthCookie(req), clearUserCookie(req)] });
    res.end(JSON.stringify({ ok: true }));
  });
}
