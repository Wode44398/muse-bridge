// Token-based auth (Bearer header OR `bridge_auth` cookie) for the phone-facing
// server, plus the NO_AUTH escape hatch for the loopback-only desktop console.
//
// Cookie auth is the durable "stay logged in" path — iOS Safari (esp. home-
// screen PWA) drops localStorage on refresh, but cookies survive, so the phone
// stops re-prompting on every cold load. Comparisons use timingSafeEqual to
// defeat short-circuit timing leaks.
//
// 管理员凭据有两种（三端拆分 P4）：
//   主令牌   —— config.json 的 token（或只存哈希的 tokenHash）。只在「用访问令牌登录」那一下用；
//   管理员会话 —— 登录 / 扫码确认时铸的随机令牌（users.mjs，sessions.json 里只存哈希），浏览器 cookie
//               与 localStorage 里放的是它而不是主令牌，控制台能逐个吊销。会话绑在主令牌指纹（gen）上，
//               主令牌一换全部作废。
// 老客户端仍拿主令牌当 Bearer 用——照认，行为不变。

import { timingSafeEqual, createHash } from 'node:crypto';

const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');

// createAuth(token, noAuth, { tokenHash, isAdminSession }) returns the small bundle
// of helpers + cookie strings the rest of the server uses.
export function createAuth(token, noAuth, { tokenHash = '', isAdminSession = null } = {}) {
  const expectedHash = token ? sha256hex(token) : String(tokenHash || '').toLowerCase();
  // 主令牌指纹：管理员会话记在它名下，换令牌即失效。只取前 16 位，不足以反推令牌。
  const gen = expectedHash ? expectedHash.slice(0, 16) : '';

  function tokenMatches(candidate) {
    if (typeof candidate !== 'string' || !candidate) return false;
    if (token) {
      const provided = Buffer.from(candidate);
      const expected = Buffer.from(token);
      if (provided.length !== expected.length) return false;
      return timingSafeEqual(provided, expected);
    }
    if (!expectedHash) return false;
    const a = Buffer.from(sha256hex(candidate)), b = Buffer.from(expectedHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const sessionMatches = (candidate) => !!(candidate && isAdminSession && isAdminSession(candidate, gen));

  function getCookie(req, name) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return '';
  }

  // ?token= 只对这些 GET 资源路径生效——<img>/<video>/下载链接加不了 Authorization 头。
  // 全路由都收 ?token= 的话，admin 令牌会随手散进隧道访问日志/浏览器历史/Referer；收敛到真正需要的白名单。
  const QTOKEN_PATHS = ['/api/file', '/api/upload/raw', '/api/claude/artifact'];

  // Raw query token only on the media/download allow-list above. identify()
  // also consumes this for ordinary user sessions; authOk uses it only for the
  // admin credential, so a Pro user's resource URL never becomes admin.
  function queryToken(req) {
    try {
      const u = new URL(req.url, 'http://x');
      // dimensio 的两类 <img>/下载直链：产物文件（artifact）与会话资产（assets/<哈希名>，截图卡用）。
      const isHarnessArtifact = /^\/api\/harness\/api\/sessions\/[^/]+\/(?:artifact|assets\/[^/]+)$/.test(u.pathname);
      if (req.method === 'GET' && (isHarnessArtifact || QTOKEN_PATHS.some((p) => u.pathname === p || u.pathname.startsWith(p + '/')))) {
        return u.searchParams.get('token') || '';
      }
    } catch {}
    return '';
  }

  // 取 Authorization: Bearer 的原始 token（不校验）。admin 用它比对主令牌 / 管理员会话；
  // user 用它去 getSession——跨源客户端不带 cookie，user 会话只能靠这条 Bearer 通道。
  function bearerToken(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
    return m ? m[1].trim() : '';
  }

  // 这个请求凭什么是管理员：'noauth'（本机无鉴权控制台）| 'master'（主令牌）| 'session'（管理员会话）| null。
  // token = 命中的那个凭据原文（登录时据此决定要不要铸会话、登出时据此吊销哪一张）。
  function adminCredential(req) {
    if (noAuth) return { via: 'noauth', token: '' };
    const cands = [bearerToken(req), queryToken(req), getCookie(req, 'bridge_auth')].filter(Boolean);
    for (const c of cands) if (tokenMatches(c)) return { via: 'master', token: c };
    for (const c of cands) if (sessionMatches(c)) return { via: 'session', token: c };
    return null;
  }
  function authOk(req) { return !!adminCredential(req); }

  // Cookie 的 Secure 标志按请求实际协议决定：cloudflared 隧道带 X-Forwarded-Proto:https
  // → Secure；局域网明文 http 直连无此头 → 不带 Secure（否则浏览器拒存 cookie，
  // 普通用户在 LAN 下登录永远卡住——admin 有 localStorage Bearer 兜底，用户没有）。
  const isSecure = (req) => req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);
  const flags = (req) => `Path=/; HttpOnly; ${isSecure(req) ? 'Secure; ' : ''}SameSite=Lax`;
  // 管理员 cookie 里放的是管理员会话令牌（不再是主令牌本身）。
  const authCookie = (req, value) => `bridge_auth=${encodeURIComponent(value)}; Max-Age=31536000; ${flags(req)}`;
  const clearAuthCookie = (req) => `bridge_auth=; Max-Age=0; ${flags(req)}`;
  // Multi-user (Phase 1): the user session cookie holds a random session token
  // (NOT the password), resolved to an account via users.getSession.
  const userCookie = (req, t) => `bridge_user=${encodeURIComponent(t)}; Max-Age=31536000; ${flags(req)}`;
  const clearUserCookie = (req) => `bridge_user=; Max-Age=0; ${flags(req)}`;

  return { gen, tokenMatches, getCookie, bearerToken, queryToken, adminCredential, authOk, authCookie, clearAuthCookie, userCookie, clearUserCookie };
}
